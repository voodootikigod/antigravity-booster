import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAcceptanceDossier,
  computeHunkFingerprint,
  formatAcceptanceDossierMarkdown,
  parseUnifiedDiffHunks,
  saveAcceptVerdicts,
} from '../lib/accept.mjs';
import { renderAcceptTuiFrame, runInteractiveAcceptTui } from '../lib/accept-tui.mjs';
import { stripOscAndAnsi } from '../lib/terminal-osc.mjs';

function makeAcceptRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-accept-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');

  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'src', 'caller.mjs'), 'import { add } from "./math.mjs";\nexport const sum = add(1, 2);\n');
  writeFileSync(
    join(dir, '.adlc', 'manifest.jsonl'),
    JSON.stringify({ seq: 1, gate: 'build', ticket: 'T1', ts: '2026-11-24T00:00:00Z', sig: 'abc' }) + '\n'
  );
  g('add', '-A');
  g('commit', '-qm', 'base');
  const baseSha = g('rev-parse', 'HEAD');

  // Candidate modifies exported add() in src/math.mjs
  writeFileSync(
    join(dir, 'src', 'math.mjs'),
    'export function add(a, b) {\n  return Number(a) + Number(b);\n}\n'
  );
  g('add', 'src/math.mjs');
  g('commit', '-qm', 'candidate');
  const candSha = g('rev-parse', 'HEAD');
  return { dir, g, baseSha, candSha };
}

test('buildAcceptanceDossier, SHA-256 fingerprint invalidation, external callers, interactive TUI, and symlink rejection', async () => {
  const fx = makeAcceptRepo();
  try {
    // 1. Fingerprint survives pure line-number shifts when hunk content & heading match
    const fp1 = computeHunkFingerprint('src/math.mjs', 'export function add', ['-  return a + b;', '+  return Number(a) + Number(b);']);
    const fp2 = computeHunkFingerprint('src/math.mjs', 'export function add', ['-  return a + b;', '+  return Number(a) + Number(b);']);
    const fpModified = computeHunkFingerprint('src/math.mjs', 'export function add', ['-  return a + b;', '+  return Number(a) + Number(b) + 0;']);
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fpModified);
    assert.equal(parseUnifiedDiffHunks('').length, 0);

    // 1b. parseUnifiedDiffHunks handles newline-terminated diffs without trailing '' and treats '+++ b/...' inside hunks as added lines
    const trickyDiff = [
      'diff --git a/src/a.js b/src/a.js',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      '+++ b/spoofed.js',
      ' export default x;',
      '',
    ].join('\n');
    const trickyHunks = parseUnifiedDiffHunks(trickyDiff);
    assert.equal(trickyHunks.length, 1);
    assert.equal(trickyHunks[0].file, 'src/a.js');
    assert.equal(trickyHunks[0].addedCount, 1);
    assert.equal(trickyHunks[0].lines.includes('+++ b/spoofed.js'), true);
    assert.equal(trickyHunks[0].lines.at(-1), ' export default x;');

    // 1c. renderAcceptTuiFrame strips raw ESC/OSC injection sequences inside diff lines
    const oscFrame = renderAcceptTuiFrame({
      base: 'main\x1b]9;BAD\x07',
      counts: { filesChanged: 1, totalHunks: 1, acceptedHunks: 0, flaggedHunks: 0, pendingHunks: 1 },
      hunks: [{ id: 'H-001', file: 'src/a.js', newStart: 1, addedCount: 1, removedCount: 0, header: '@@ -1 +1 @@', lines: ['+safe\x1b]9;PWNED\x07line'] }],
    }).join('\n');
    assert.doesNotMatch(oscFrame, /PWNED|BAD/);
    assert.match(stripOscAndAnsi(oscFrame), /\+safeline/);

    // 2. Build initial dossier: 1 pending hunk, detects external caller in src/caller.mjs, reads manifest.jsonl
    const d1 = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    assert.equal(d1.ok, true);
    assert.equal(d1.readyForSignOff, false);
    assert.equal(d1.counts.totalHunks, 1);
    assert.equal(d1.counts.pendingHunks, 1);
    assert.equal(d1.externalCallers.callers.some((c) => c.file === 'src/caller.mjs'), true);
    assert.equal(d1.gateManifest.totalEntries, 1);

    // 3. Interactive TUI multi-hunk navigation ('j'/'k'), flagging ('f' blocks sign-off), and accepting ('a' + 'd' + 'q')
    writeFileSync(join(fx.dir, 'src', 'extra.mjs'), 'export const extra = 99;\n');
    const dMulti = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    // Note: git diff against committed baseSha sees tracked src/math.mjs; add a second tracked file edit so we have 2 hunks!
    fx.g('add', 'src/extra.mjs');
    const dTwo = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    assert.equal(dTwo.counts.totalHunks, 2);

    let rendered = '';
    const fakeStdout = {
      isTTY: true,
      columns: 100,
      write: (s) => {
        rendered += s;
      },
    };
    const fakeStdin1 = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    });

    // Session A: accept hunk 1 ('a' auto-advances to hunk 2), flag hunk 2 ('f'), quit ('q') -> readyForSignOff MUST be false!
    const flagPromise = runInteractiveAcceptTui(dTwo, {
      repo: fx.dir,
      stdin: fakeStdin1,
      stdout: fakeStdout,
      osc8: true,
    });
    setTimeout(() => {
      fakeStdin1.emit('data', 'afq');
    }, 15);
    const flagRes = await flagPromise;
    assert.equal(flagRes.readyForSignOff, false, 'flagged hunk must block P6 sign-off');
    assert.equal(flagRes.counts.acceptedHunks, 1);
    assert.equal(flagRes.counts.flaggedHunks, 1);

    // Session B: navigate 'j' to hunk 2, 'k' back to hunk 1, 'j' to hunk 2, accept hunk 2 ('a'), export ('d'), quit ('q')
    const dReloaded = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    const fakeStdin2 = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    });
    const tuiPromise = runInteractiveAcceptTui(dReloaded, {
      repo: fx.dir,
      stdin: fakeStdin2,
      stdout: fakeStdout,
      osc8: true,
    });
    setTimeout(() => {
      fakeStdin2.emit('data', 'jkjadq');
    }, 15);
    const tuiRes = await tuiPromise;
    assert.equal(tuiRes.ok, true);
    assert.equal(tuiRes.readyForSignOff, true);
    assert.equal(tuiRes.counts.acceptedHunks, 2);
    assert.equal(tuiRes.counts.flaggedHunks, 0);
    assert.ok(tuiRes.dossierPath && existsSync(tuiRes.dossierPath));
    assert.match(rendered, /\x1b\]8;;file:\/\//, 'expected OSC 8 clickable file link in TTY frame');
    assert.match(stripOscAndAnsi(rendered), /P6 SIGN-OFF READY/);
    assert.equal(fx.g('rev-parse', 'HEAD'), fx.candSha, 'git HEAD must never be mutated by agb accept');
    fx.g('reset', '-q', 'HEAD', '--', 'src/extra.mjs');
    rmSync(join(fx.dir, 'src', 'extra.mjs'), { force: true });

    const md = formatAcceptanceDossierMarkdown(dReloaded);
    assert.match(md, /READY FOR P6 MERGE SIGN-OFF/);
    assert.match(md, /src\/caller\.mjs/);

    // 4. Modifying hunk content auto-invalidates prior SHA-256 fingerprint verdict back to 'pending'
    writeFileSync(
      join(fx.dir, 'src', 'math.mjs'),
      'export function add(a, b) {\n  return Number(a ?? 0) + Number(b ?? 0);\n}\n'
    );
    const dAfterEdit = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    assert.equal(dAfterEdit.counts.acceptedHunks, 0);
    assert.equal(dAfterEdit.counts.pendingHunks, 1);
    assert.equal(dAfterEdit.readyForSignOff, false);

    // 5. Rejects invalid git ref starting with '-' and symlinked .booster
    assert.throws(() => buildAcceptanceDossier({ repo: fx.dir, base: '--output=/tmp/pwn' }), /Invalid git base ref/);
    rmSync(join(fx.dir, '.booster'), { recursive: true, force: true });
    const outside = mkdtempSync(join(tmpdir(), 'agb-accept-outside-'));
    try {
      symlinkSync(outside, join(fx.dir, '.booster'), 'dir');
      assert.throws(() => saveAcceptVerdicts(fx.dir, {}), /symbolic link not allowed/i);
      assert.throws(() => buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha }), /symbolic link not allowed/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
