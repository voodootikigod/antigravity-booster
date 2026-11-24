import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseAgyStatusPayload,
  extractQuotaFromStatusPayload,
  renderCliStatusLine,
  renderCliWindowTitle,
  installCliStatusLineSettings,
  uninstallCliStatusLineSettings,
} from '../lib/cli-statusline.mjs';
import { readFreshStatusLineQuotaCache } from '../lib/pools.mjs';

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function futureUtc(nowMs, sec = 3600) {
  return new Date(nowMs + sec * 1000).toISOString();
}

test('cli-statusline module: zero child_process imports and synchronous exports', () => {
  const src = readFileSync(new URL('../lib/cli-statusline.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /child_process/);
  assert.equal(typeof parseAgyStatusPayload, 'function');
  assert.equal(typeof extractQuotaFromStatusPayload, 'function');
  assert.equal(typeof renderCliStatusLine, 'function');
  assert.equal(typeof renderCliWindowTitle, 'function');
  assert.equal(typeof installCliStatusLineSettings, 'function');
  assert.equal(typeof uninstallCliStatusLineSettings, 'function');
});

test('parseAgyStatusPayload: accepts only plain JSON objects and rejects arrays, primitives, and malformed input', () => {
  assert.deepEqual(parseAgyStatusPayload('{"cwd":"/tmp/repo"}'), { cwd: '/tmp/repo' });
  assert.deepEqual(parseAgyStatusPayload(Buffer.from('{"ok":true}')), { ok: true });
  assert.equal(parseAgyStatusPayload(''), null);
  assert.equal(parseAgyStatusPayload('   '), null);
  assert.equal(parseAgyStatusPayload(null), null);
  assert.equal(parseAgyStatusPayload(undefined), null);
  assert.equal(parseAgyStatusPayload('null'), null);
  assert.equal(parseAgyStatusPayload('[1,2,3]'), null);
  assert.equal(parseAgyStatusPayload('"string"'), null);
  assert.equal(parseAgyStatusPayload('42'), null);
  assert.equal(parseAgyStatusPayload('{unclosed'), null);
});

test('extractQuotaFromStatusPayload: maps all gemini-*/3p-*/claude-* aliases across keyed object, buckets[], and groups[].buckets[]', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-sl-extract-'));
  const savedCache = process.env.AGB_STATUSLINE_QUOTA_FILE;
  try {
    const cacheFile = join(tmp, 'quota_cache.json');
    process.env.AGB_STATUSLINE_QUOTA_FILE = cacheFile;
    const now = Date.now();
    const r5h = futureUtc(now, 3600);
    const rWeekly = futureUtc(now, 86400 * 5);

    // 1. Keyed object with 3p-* and gemini_* aliases -> populates fullNormalized and writes cache
    const keyed = extractQuotaFromStatusPayload(
      {
        quota: {
          gemini_5h: { remaining_fraction: 0.724, reset_time: r5h },
          'gemini-weekly': { remaining_percentage: 88, resetTime: rWeekly },
          '3p-five-hour': { remainingPercent: 41.2, reset_time: r5h },
          '3p-weekly': { remaining_fraction: 0.246, reset_time: rWeekly },
        },
      },
      now
    );
    assert.equal(keyed.display.geminiPct, 72);
    assert.equal(keyed.display.claudePct, 25); // round(24.6) == 25
    assert.ok(keyed.fullNormalized);
    assert.ok(Math.abs(keyed.fullNormalized.gemini.fiveHourRemainingPercent - 72.4) < 1e-9);
    assert.ok(Math.abs(keyed.fullNormalized.claude_gpt.weeklyRemainingPercent - 24.6) < 1e-9);
    assert.equal(keyed.fullNormalized['claude-gpt'].fiveHourRemainingPercent, 41.2);
    assert.ok(existsSync(cacheFile), '4-window valid payload must write statusline quota cache');
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: now + 100 }).updatedAt, now);

    // 2. buckets[] array with claude-gpt-* and gemini-five-hour aliases (20s later so throttle permits write)
    const bucketsRes = extractQuotaFromStatusPayload(
      {
        quota: {
          buckets: [
            { name: 'gemini-five-hour', remaining_percentage: 64, reset_time: r5h },
            { id: 'gemini_weekly', remaining_fraction: 0.51, reset_time: rWeekly },
            { window: 'claude-gpt-5h', remainingPercent: 19, resetTime: r5h },
            { id: 'claude_gpt-weekly', remaining_fraction: 0.8, reset_time: rWeekly },
          ],
        },
      },
      now + 20_000
    );
    assert.equal(bucketsRes.display.geminiPct, 51);
    assert.equal(bucketsRes.display.claudePct, 19);
    assert.ok(bucketsRes.fullNormalized);
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: now + 20_100 }).quota.claude_gpt.fiveHourRemainingPercent, 19);

    // 3. Nested groups[].buckets[] shape
    const groupsRes = extractQuotaFromStatusPayload(
      {
        quota: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-5h', window: '5h', remaining_fraction: 0.95, reset_time: r5h },
                { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: rWeekly },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                { id: 'claude-5h', window: '5h', remaining_fraction: 0.35, reset_time: r5h },
                { id: 'claude-weekly', window: 'weekly', remaining_fraction: 0.6, reset_time: rWeekly },
              ],
            },
          ],
        },
      },
      now + 40_000
    );
    assert.equal(groupsRes.display.geminiPct, 90);
    assert.equal(groupsRes.display.claudePct, 35);
    assert.ok(groupsRes.fullNormalized);
  } finally {
    if (savedCache === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    else process.env.AGB_STATUSLINE_QUOTA_FILE = savedCache;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractQuotaFromStatusPayload: partial 2-window payload renders display gauges without poisoning quota cache', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-sl-partial-'));
  const savedCache = process.env.AGB_STATUSLINE_QUOTA_FILE;
  try {
    const cacheFile = join(tmp, 'partial_cache.json');
    process.env.AGB_STATUSLINE_QUOTA_FILE = cacheFile;
    const now = Date.now();

    const partial = extractQuotaFromStatusPayload(
      {
        quota: {
          buckets: [
            { id: 'gemini-5h', remaining_fraction: 0.62 },
            { id: '3p-5h', remaining_fraction: 0.14 },
          ],
        },
      },
      now
    );

    assert.deepEqual(partial.display, { geminiPct: 62, claudePct: 14 });
    assert.equal(partial.fullNormalized, null);
    assert.equal(existsSync(cacheFile), false, 'partial 2-window payload must NEVER create or poison cache file');
  } finally {
    if (savedCache === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    else process.env.AGB_STATUSLINE_QUOTA_FILE = savedCache;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderCliStatusLine: formats active tickets, unique rails, color-coded quota gauges, !ROT warning, and active run under 15ms', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-sl-render-'));
  const savedCache = process.env.AGB_STATUSLINE_QUOTA_FILE;
  try {
    process.env.AGB_STATUSLINE_QUOTA_FILE = join(tmp, 'sl_quota.json');
    const home = join(tmp, 'home');
    const repo = join(home, 'projects', 'demo-repo');
    const subDir = join(repo, 'src', 'nested');
    mkdirSync(subDir, { recursive: true });
    mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
    mkdirSync(join(repo, '.booster'), { recursive: true });

    // .store.json and completed/archived shards must be ignored; active shards sorted lexicographically
    writeFileSync(join(repo, '.adlc', 'tickets', '.store.json'), JSON.stringify({ backend: 'directory', rails: ['ignored'] }));
    writeFileSync(
      join(repo, '.adlc', 'tickets', 'T-DONE.json'),
      JSON.stringify({ id: 'T-DONE', status: 'completed', rails: ['lib/old.mjs'] })
    );
    writeFileSync(
      join(repo, '.adlc', 'tickets', 'T-ARCH.json'),
      JSON.stringify({ id: 'T-ARCH', status: 'archived', rails: ['lib/archived.mjs'] })
    );
    writeFileSync(
      join(repo, '.adlc', 'tickets', 'T-B.json'),
      JSON.stringify({ id: 'T-B\n\x1b[31m', status: 'in_progress', rails: ['lib/lock.mjs', 'lib/gates.mjs'] })
    );
    writeFileSync(
      join(repo, '.adlc', 'tickets', 'T-A.json'),
      JSON.stringify({ id: 'T-A', status: 'pending', rails: ['lib/lock.mjs', 'scripts/rails-guard-ci.mjs'] })
    );

    // Active booster run: 2 merged of 3 total
    writeFileSync(
      join(repo, '.booster', 'run.json'),
      JSON.stringify({
        done: false,
        tickets: {
          'T-0': { phase: 'merged' },
          'T-A': { phase: 'merged' },
          'T-B': { phase: 'building' },
        },
      })
    );

    const payload = {
      workspace: { current_dir: subDir },
      quota: {
        'gemini-5h': { remaining_percentage: 75 }, // green (\x1b[32m)
        '3p-5h': { remaining_percentage: 30 }, // yellow (\x1b[33m)
      },
      context_window: {
        used_percentage: 82.4,
        exceeds_200k_tokens: false,
      },
    };

    const t0 = performance.now();
    const out = renderCliStatusLine(payload, { home });
    const elapsed = performance.now() - t0;

    assert.ok(elapsed < 50, `statusline render should be fast (<50ms in test harness, took ${elapsed.toFixed(2)}ms)`);
    assert.ok(out.endsWith('\x1b[0m'), 'must end with ANSI reset');
    assert.ok(!out.includes('\n') && !out.includes('\r'), 'must be single-line');
    assert.match(out, /\x1b\[32mG:75%\x1b\[0m/);
    assert.match(out, /\x1b\[33mC:30%\x1b\[0m/);
    assert.match(out, /ctx:82%\x1b\[91m\x1b\[1m !ROT\x1b\[0m/);

    assert.equal(
      stripAnsi(out),
      '[AGB] T-A (+1) | 🔒3 rails | G:75% C:30% | ctx:82% !ROT | ⚡2/3'
    );

    // Red gauge (<25%), null gauge (--), context <80% without !ROT, and exceeds_200k_tokens: true with low %
    const lowOut = renderCliStatusLine(
      {
        cwd: repo,
        quota: { 'gemini-5h': { remaining_percentage: 12 } },
        context_window: { used_percentage: 45, exceeds_200k_tokens: false },
      },
      { home }
    );
    assert.match(lowOut, /\x1b\[31mG:12%\x1b\[0m C:--/);
    assert.doesNotMatch(lowOut, /!ROT/);

    const rotBy200k = renderCliStatusLine(
      {
        cwd: repo,
        context_window: { used_percentage: 45, exceeds_200k_tokens: true },
      },
      { home }
    );
    assert.match(rotBy200k, /ctx:45%\x1b\[91m\x1b\[1m !ROT\x1b\[0m/);

    // Returns '' when payload === null and no .adlc root exists (stopping before resolvedHome)
    mkdirSync(join(home, '.adlc'), { recursive: true }); // stray ~/.adlc at home boundary must NOT be picked up
    const nonAdlcDir = join(home, 'scratch');
    mkdirSync(nonAdlcDir, { recursive: true });
    assert.equal(renderCliStatusLine(null, { home, cwd: nonAdlcDir }), '');
  } finally {
    if (savedCache === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    else process.env.AGB_STATUSLINE_QUOTA_FILE = savedCache;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderCliWindowTitle: strips all ANSI escapes and ASCII control characters from untrusted repo names and ticket IDs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-sl-title-'));
  try {
    const home = join(tmp, 'home');
    // Repo dir name with embedded ANSI CSI; ticket ID with OSC escape + ASCII control chars
    const evilRepo = join(home, 'my-\x1b[31mrepo\x1b[0m');
    mkdirSync(join(evilRepo, '.adlc', 'tickets'), { recursive: true });
    mkdirSync(join(evilRepo, '.booster'), { recursive: true });

    writeFileSync(
      join(evilRepo, '.adlc', 'tickets', 'T-1.json'),
      JSON.stringify({
        id: 'T-1\x1b]0;PWNED\x07\r\n\t\x00\x1f\x7f',
        status: 'in_progress',
        rails: [],
      })
    );
    writeFileSync(
      join(evilRepo, '.booster', 'run.json'),
      JSON.stringify({
        done: false,
        tickets: { 'T-1': { phase: 'merged' }, 'T-2': { phase: 'pending' } },
      })
    );

    const title = renderCliWindowTitle({ cwd: evilRepo }, { home });
    assert.equal(title, 'AGB · my-repo · T-1 · ⚡1/2');
    assert.doesNotMatch(title, /[\x00-\x1f\x7f]/);
    assert.doesNotMatch(title, /\x1b/);

    // Completed run (done: true) and completed ticket -> idle without run suffix
    writeFileSync(
      join(evilRepo, '.adlc', 'tickets', 'T-1.json'),
      JSON.stringify({ id: 'T-1', status: 'completed', rails: [] })
    );
    writeFileSync(
      join(evilRepo, '.booster', 'run.json'),
      JSON.stringify({ done: true, tickets: { 'T-1': { phase: 'merged' } } })
    );
    assert.equal(renderCliWindowTitle({ cwd: evilRepo }, { home }), 'AGB · my-repo · idle');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installCliStatusLineSettings & uninstallCliStatusLineSettings: non-clobbering partial/full install, force override, malformed JSON safety, symlink rejection, and bundled AGB_HOME_DIR ignore', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-sl-settings-'));
  const savedHomeEnv = process.env.AGB_HOME_DIR;
  const prevBundled = globalThis.__AGB_BUNDLED__;
  try {
    const home1 = join(tmp, 'home1');

    // 1. Fresh install creates 0o600 settings.json with statusLine + title
    const res1 = installCliStatusLineSettings({ home: home1 });
    assert.equal(res1.ok, true);
    assert.equal(res1.changed, true);
    assert.equal(res1.skipped, false);
    if (process.platform !== 'win32') {
      assert.equal(statSync(res1.settingsPath).mode & 0o777, 0o600);
    }
    const parsed1 = JSON.parse(readFileSync(res1.settingsPath, 'utf8'));
    assert.deepEqual(parsed1, {
      statusLine: {
        type: 'command',
        command: '~/.local/bin/agb statusline render',
        stack_with_default: true,
      },
      title: {
        type: 'command',
        command: '~/.local/bin/agb statusline title',
      },
    });

    // Idempotent second call
    const res1Again = installCliStatusLineSettings({ home: home1 });
    assert.deepEqual(res1Again, {
      ok: true,
      changed: false,
      skipped: false,
      settingsPath: res1.settingsPath,
    });

    // 2. Partial non-clobbering install: custom statusLine is preserved while missing title is installed
    const home2 = join(tmp, 'home2');
    const cliDir2 = join(home2, '.gemini', 'antigravity-cli');
    mkdirSync(cliDir2, { recursive: true });
    const settingsPath2 = join(cliDir2, 'settings.json');
    writeFileSync(
      settingsPath2,
      JSON.stringify({
        theme: 'solarized',
        statusLine: { type: 'command', command: '/usr/local/bin/starship-bar' },
      }),
      'utf8'
    );

    const partialRes = installCliStatusLineSettings({ home: home2 });
    assert.equal(partialRes.ok, true);
    assert.equal(partialRes.changed, true);
    assert.equal(partialRes.skipped, true);

    const afterPartial = JSON.parse(readFileSync(settingsPath2, 'utf8'));
    assert.equal(afterPartial.theme, 'solarized');
    assert.deepEqual(afterPartial.statusLine, { type: 'command', command: '/usr/local/bin/starship-bar' });
    assert.deepEqual(afterPartial.title, {
      type: 'command',
      command: '~/.local/bin/agb statusline title',
    });

    // Uninstall removes ONLY booster's title, leaving user's custom statusLine and theme intact!
    const unPartial = uninstallCliStatusLineSettings({ home: home2 });
    assert.equal(unPartial.ok, true);
    assert.equal(unPartial.changed, true);
    const afterUnPartial = JSON.parse(readFileSync(settingsPath2, 'utf8'));
    assert.equal(afterUnPartial.theme, 'solarized');
    assert.deepEqual(afterUnPartial.statusLine, { type: 'command', command: '/usr/local/bin/starship-bar' });
    assert.equal(afterUnPartial.title, undefined);

    // Force install overwrites custom statusLine
    const forced = installCliStatusLineSettings({ home: home2, agbCommand: '/opt/agb', force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.changed, true);
    assert.equal(forced.skipped, false);
    const afterForce = JSON.parse(readFileSync(settingsPath2, 'utf8'));
    assert.equal(afterForce.statusLine.command, '/opt/agb statusline render');
    assert.equal(afterForce.title.command, '/opt/agb statusline title');

    // Full uninstall removes both booster entries
    const unFull = uninstallCliStatusLineSettings({ home: home2 });
    assert.equal(unFull.ok, true);
    assert.equal(unFull.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath2, 'utf8')), { theme: 'solarized' });

    // 3. Malformed JSON in settings.json is NEVER modified or clobbered
    const homeBad = join(tmp, 'home-bad');
    const cliDirBad = join(homeBad, '.gemini', 'antigravity-cli');
    mkdirSync(cliDirBad, { recursive: true });
    const badPath = join(cliDirBad, 'settings.json');
    const rawCorrupt = '{ "theme": "dark", trailing-garbage';
    writeFileSync(badPath, rawCorrupt, 'utf8');

    const badRes = installCliStatusLineSettings({ home: homeBad, force: true });
    assert.deepEqual(badRes, {
      ok: false,
      changed: false,
      skipped: true,
      settingsPath: badPath,
      warning: 'settings.json is not valid JSON; skipping statusLine install',
    });
    assert.equal(readFileSync(badPath, 'utf8'), rawCorrupt, 'corrupt settings.json bytes must remain untouched');

    // 4. Symlinked settings.json or parent directory is rejected
    const homeSym = join(tmp, 'home-sym');
    mkdirSync(homeSym, { recursive: true });
    const extTarget = join(tmp, 'ext-target');
    mkdirSync(extTarget, { recursive: true });
    symlinkSync(extTarget, join(homeSym, '.gemini'), 'dir');

    const symRes = installCliStatusLineSettings({ home: homeSym });
    assert.equal(symRes.ok, false);
    assert.equal(symRes.changed, false);
    assert.equal(symRes.skipped, true);

    // 5. Bundled runtime ignores AGB_HOME_DIR env override
    const spoofHome = join(tmp, 'spoof-home');
    const childUnderSpoof = join(spoofHome, 'nested-dir');
    mkdirSync(childUnderSpoof, { recursive: true });
    mkdirSync(join(spoofHome, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(
      join(spoofHome, '.adlc', 'tickets', 'T-SPOOF.json'),
      JSON.stringify({ id: 'T-SPOOF', status: 'in_progress', rails: [] })
    );
    process.env.AGB_HOME_DIR = spoofHome;

    // Unbundled honors AGB_HOME_DIR -> stops walk before spoofHome
    globalThis.__AGB_BUNDLED__ = false;
    assert.equal(renderCliWindowTitle({ cwd: childUnderSpoof }), 'AGB · nested-dir · idle');

    // Bundled ignores AGB_HOME_DIR -> does not treat spoofHome as home boundary
    globalThis.__AGB_BUNDLED__ = true;
    assert.equal(renderCliWindowTitle({ cwd: childUnderSpoof }), 'AGB · spoof-home · T-SPOOF');
  } finally {
    if (prevBundled === undefined) delete globalThis.__AGB_BUNDLED__;
    else globalThis.__AGB_BUNDLED__ = prevBundled;
    if (savedHomeEnv === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeEnv;
    rmSync(tmp, { recursive: true, force: true });
  }
});
