import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { poolOf, familyOf, runAgy } from '../lib/agy.mjs';
import { PoolSet } from '../lib/pools.mjs';
import { builderAgentsMd, prosecutionPrompt } from '../lib/charters.mjs';
import { runGate, runGates } from '../lib/gates.mjs';
import { prosecute } from '../lib/prosecute.mjs';
import { RunStatus, renderStatus } from '../lib/status.mjs';
import {
  ensureGitignore, createWorktree, commitAll, branchDiff, mergeWorktree, changedFiles,
  isMidMerge, abortAnyMerge,
} from '../lib/worktrees.mjs';
import { bootstrap, resolvePluginPath } from '../lib/bootstrap.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

// --- agb validate (plan-shape gate) ---

test('agb validate: rejects duplicate ids, unknown edges, missing body, empty scope, unroutable tier/hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-validate-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({
      repo: dir,
      gate: { test: 'true' },
      tickets: [
        { id: 'T1', title: 'a', body: 'x', scope: ['a.txt'], edges: [{ to: 'T9' }] },
        { id: 'T1', title: 'dup', body: 'y', scope: ['b.txt'] },
        { id: 'T2', title: 'no body', scope: ['c.txt'] },
        { id: 'T3', title: 'no scope', body: 'z', scope: [] },
        { id: 'T4', title: 'unroutable', body: 'w', scope: ['d.txt'], tier: 'cheap', pool_hint: 'claude' },
        { id: 'T5', title: 'bad tier', body: 'v', scope: ['e.txt'], tier: 'mega' },
      ],
    }));
    let out = '';
    try {
      execFileSync(process.execPath, [AGB_BIN, 'validate', bad], { encoding: 'utf8', stdio: 'pipe' });
      assert.fail('validate must exit non-zero');
    } catch (err) {
      assert.equal(err.status, 2);
      out = String(err.stderr);
    }
    assert.match(out, /duplicate ticket id: T1/);
    assert.match(out, /edge to unknown ticket 'T9'/);
    assert.match(out, /T2: body .* is required/);
    assert.match(out, /T3: scope must be a non-empty array/);
    assert.match(out, /T4: no model candidates for tier 'cheap' with pool_hint 'claude'/);
    assert.match(out, /T5: unknown tier 'mega'/);

    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({
      repo: dir,
      gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'a', body: 'do the thing', scope: ['a.txt'], tier: 'mid', pool_hint: 'auto' }],
    }));
    const ok = execFileSync(process.execPath, [AGB_BIN, 'validate', good], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(ok, /plan valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- agy wrapper ---

test('poolOf/familyOf: every model maps; prosecutor families oppose', () => {
  assert.equal(poolOf('Gemini 3.5 Flash (Low)'), 'gemini-flash');
  assert.equal(poolOf('Claude Opus 4.6 (Thinking)'), 'claude');
  assert.equal(familyOf('Gemini 3.1 Pro (High)'), 'gemini');
  // test fuzzy/prefix fallback matching
  assert.equal(poolOf('gemini-1.5-flash-custom'), 'gemini-flash');
  assert.equal(poolOf('custom-gemini-model'), 'gemini-pro');
  assert.equal(poolOf('claude-3-7-sonnet'), 'claude');
  assert.equal(poolOf('claude-custom'), 'claude');
  assert.equal(poolOf('custom-sonnet'), 'claude');
  assert.equal(poolOf('custom-opus'), 'claude');
  assert.equal(poolOf('GPT-9'), 'gpt-oss');
  assert.throws(() => poolOf('unknown-custom-model'));
  assert.throws(() => poolOf(undefined), /unknown model: undefined/);
  assert.throws(() => poolOf(null), /unknown model: null/);
  assert.throws(() => poolOf(123), /unknown model: 123/);
});

test('runAgy: success round-trip via fake binary', async () => {
  const r = await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'Reply with exactly: PONG-x', bin: FAKE_AGY });
  assert.equal(r.ok, true);
  assert.match(r.output, /PONG-x/);
});

test('runAgy: detects exit-0 print-timeout as failure', async () => {
  const r = await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'FAKE:TIMEOUT', bin: FAKE_AGY });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'print-timeout');
});

test('runAgy: --sandbox is passed only when sandbox:true; omitted by default', async () => {
  const state = mkdtempSync(join(tmpdir(), 'agb-agy-argv-'));
  const prevState = process.env.FAKE_STATE_DIR;
  process.env.FAKE_STATE_DIR = state;
  try {
    await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'x', bin: FAKE_AGY });
    await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'x', bin: FAKE_AGY, sandbox: true });
    const [defaultCall, sandboxedCall] = readFileSync(join(state, 'agy-argv-seen'), 'utf8').trim().split('\n');
    assert.ok(!defaultCall.includes('--sandbox'), 'sandbox defaults to false — no --sandbox flag');
    assert.ok(sandboxedCall.includes('--sandbox'), 'sandbox:true passes --sandbox');
  } finally {
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
    rmSync(state, { recursive: true, force: true });
  }
});

test('runAgy: env option is scoped to this spawn only — process.env is never mutated', async () => {
  const state = mkdtempSync(join(tmpdir(), 'agb-agy-env-'));
  try {
    assert.equal(process.env.ADLC_TICKET, undefined);
    await runAgy({
      model: 'Gemini 3.5 Flash (Low)', prompt: 'x', bin: FAKE_AGY,
      env: { FAKE_STATE_DIR: state, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T9' },
    });
    const envSeen = readFileSync(join(state, 'agy-env-seen'), 'utf8');
    assert.match(envSeen, /ADLC_P4_ENFORCEMENT=1 ADLC_TICKET=T9/, 'the spawned process saw the merged env');
    assert.equal(process.env.ADLC_TICKET, undefined, 'the parent process env is untouched after the call');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

// --- pools ---

test('PoolSet: caps enforced, waiters released, requests counted', async () => {
  const pools = new PoolSet({ 'gemini-flash': 2 });
  const m = 'Gemini 3.5 Flash (Low)';
  const r1 = await pools.acquire(m);
  const r2 = await pools.acquire(m);
  assert.equal(pools.hasCapacity(m), false);
  let third = false;
  const p3 = pools.acquire(m).then((rel) => { third = true; return rel; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, false, 'third acquire must wait');
  r1();
  const r3 = await p3;
  assert.equal(third, true);
  r2(); r3();
  assert.equal(pools.snapshot().requests['gemini-flash'], 3);
});

test('PoolSet.route: reservation spreads concurrent dispatches across pools', () => {
  const pools = new PoolSet();
  // First mid ticket → claude (all reserved 0, claude is first candidate).
  assert.equal(pools.route('mid'), 'Claude Sonnet 4.6 (Thinking)');
  // Second mid ticket (no slot acquired yet — the bug case) must NOT pick
  // claude again; reservation pushes it to the idle gemini-pro pool.
  assert.equal(pools.route('mid'), 'Gemini 3.1 Pro (Low)');
  // pool_hint still constrains family.
  assert.equal(pools.route('mid', 'gemini'), 'Gemini 3.1 Pro (Low)');
  // unroute frees the assignment so the pool rebalances.
  pools.unroute('Gemini 3.1 Pro (Low)');
  pools.unroute('Gemini 3.1 Pro (Low)');
  assert.equal(pools.reserved['gemini-pro'], 0);
});

test('PoolSet.prosecutorFor: always a different family', () => {
  const pools = new PoolSet();
  assert.equal(familyOf(pools.prosecutorFor('Gemini 3.5 Flash (Low)')), 'claude');
  assert.equal(familyOf(pools.prosecutorFor('Claude Sonnet 4.6 (Thinking)')), 'gemini');
});

// --- charters ---

test('builderAgentsMd: carries spec, scope, rails, gates, sentinel protocol', () => {
  const md = builderAgentsMd(
    { id: 'T1', title: 'thing', body: 'BODY-TEXT', scope: ['src/**'], rails: ['test/**'] },
    { build: 'npm run build', test: 'npm test' }
  );
  for (const needle of ['BODY-TEXT', 'src/**', 'test/**', 'npm run build', 'TICKET-DONE', 'TICKET-BLOCKED']) {
    assert.ok(md.includes(needle), `missing ${needle}`);
  }
});

test('prosecutionPrompt: refute charter + JSON contract + diff embedded', () => {
  const p = prosecutionPrompt({ id: 'T1', body: 'spec', scope: ['a/**'] }, 'DIFF-HERE');
  assert.ok(p.includes('REFUTE'));
  assert.ok(p.includes('DIFF-HERE'));
  assert.ok(p.includes('"verdict"'));
});

// --- gates ---

test('runGate: async — does NOT block the event loop (throughput)', async () => {
  // While a ~400ms gate runs, the event loop must stay live so other tickets'
  // agy streams keep progressing. Proof: a timer set just before the gate
  // fires DURING the gate, and two gates overlap rather than summing.
  let timerFiredDuringGate = false;
  const t = setTimeout(() => { timerFiredDuringGate = true; }, 50);
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    runGate('g1', 'sleep 0.4', '/tmp'),
    runGate('g2', 'sleep 0.4', '/tmp'),
  ]);
  const wall = Date.now() - t0;
  clearTimeout(t);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.ok(timerFiredDuringGate, 'a timer fired while a gate ran — event loop not blocked');
  assert.ok(wall < 700, `two 0.4s gates overlapped (${wall}ms < 700ms); execSync would serialize to ~800ms`);
});

test('runGates: ordered, stops at first failure, captures output', async () => {
  const pass = await runGates({ a: 'true', b: 'echo hi' }, '/tmp');
  assert.equal(pass.ok, true);
  assert.equal(pass.results.length, 2);
  assert.equal(pass.results[0].sandboxed, false);
  const fail = await runGates({ a: 'true', b: 'echo nope && false', c: 'true' }, '/tmp');
  assert.equal(fail.ok, false);
  assert.equal(fail.results.length, 2, 'c must not run after b fails');
  assert.match(fail.results[1].output, /nope/);
});

test('runGate / runGates: forwards custom environment variables', async () => {
  const customEnv = { ...process.env, TEST_VAR_ENV: 'custom-val-123' };
  const r = await runGate('test-env', 'echo $TEST_VAR_ENV', '/tmp', { env: customEnv });
  assert.equal(r.ok, true);
  assert.match(r.output, /custom-val-123/);

  const rs = await runGates({ printEnv: 'echo $TEST_VAR_ENV' }, '/tmp', { env: customEnv });
  assert.equal(rs.ok, true);
  assert.match(rs.results[0].output, /custom-val-123/);
});

test('runGate / runGates: merges custom environment variables onto process.env', async () => {
  process.env.TEST_VAR_PROCESS = 'process-val';
  try {
    const customEnv = { TEST_VAR_CUSTOM: 'custom-val' };
    const r = await runGate('test-env-merge', 'echo "P:$TEST_VAR_PROCESS C:$TEST_VAR_CUSTOM"', '/tmp', { env: customEnv });
    assert.equal(r.ok, true);
    assert.match(r.output, /P:process-val C:custom-val/);
  } finally {
    delete process.env.TEST_VAR_PROCESS;
  }
});

// --- prosecution ---

test('prosecute: ship verdict on clean JSON', async () => {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  try {
    const v = await prosecute({ ticket: { id: 'T1', body: 'spec' }, diff: 'real diff', model: 'Claude Sonnet 4.6 (Thinking)' });
    assert.equal(v.verdict, 'ship');
    assert.equal(v.findings.length, 0);
  } finally {
    delete process.env.AGB_AGY_BIN; delete process.env.FAKE_PROSECUTOR_VERDICT;
  }
});

test('prosecute: high finding forces block; empty diff blocks without a model call', async () => {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'block';
  try {
    const v = await prosecute({ ticket: { id: 'T1', body: 'spec' }, diff: 'real diff', model: 'Claude Sonnet 4.6 (Thinking)' });
    assert.equal(v.verdict, 'block');
    assert.equal(v.findings[0].severity, 'high');
    const empty = await prosecute({ ticket: { id: 'T1', body: 's' }, diff: '  ', model: 'x-no-such-model' });
    assert.equal(empty.verdict, 'block');
  } finally {
    delete process.env.AGB_AGY_BIN; delete process.env.FAKE_PROSECUTOR_VERDICT;
  }
});

test('prosecute: oversized diff blocks without a model call — never ship on a partial view', async () => {
  // No AGB_AGY_BIN set: any model call would fail loudly, proving the
  // over-limit branch returns before spawning a prosecutor.
  const v = await prosecute({
    ticket: { id: 'T1', body: 'spec' },
    diff: 'x'.repeat(120_001),
    model: 'x-no-such-model',
  });
  assert.equal(v.verdict, 'block');
  assert.equal(v.findings[0].severity, 'critical');
  assert.match(v.findings[0].claim, /too large to prosecute/);
});

// --- status ---

test('RunStatus: atomic write + dashboard render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-status-'));
  try {
    const s = new RunStatus(dir, 'run-test');
    s.ticket('T1', { phase: 'building', model: 'Claude Sonnet 4.6 (Thinking)' });
    s.finish({ merged: ['T1'], failed: {}, requests: { claude: 2 } });
    assert.ok(existsSync(join(dir, '.booster', 'run.json')));
    assert.ok(existsSync(join(dir, '.booster', 'report.json')));
    const rendered = renderStatus(dir);
    assert.match(rendered, /run-test/);
    assert.match(rendered, /T1/);
    assert.match(rendered, /DONE/);
    assert.match(rendered, /merged 1\s+failed 0/, 'failed count from object keys, not undefined');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- worktrees ---

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  // Throwaway test repos must not depend on the developer's own commit-signing
  // setup (GPG/SSH agent) — disable it locally, never touch global config.
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return { dir, g };
}

test('worktrees: create → edit → commit → diff → merge lifecycle', () => {
  const { dir, g } = makeRepo();
  try {
    ensureGitignore(dir);
    ensureGitignore(dir); // idempotent — second call must not commit again
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.equal(gi.match(/\.worktrees\//g).length, 1);
    assert.match(g('log', '--oneline', '-1'), /gitignore agb working dirs/);

    const wt = createWorktree(dir, 'T9', 'main');
    writeFileSync(join(wt, 'feature.txt'), 'new\n');
    assert.equal(commitAll(wt, 'T9: add feature'), true);
    assert.equal(commitAll(wt, 'T9: nothing'), false);
    assert.deepEqual(changedFiles(wt, 'main'), ['feature.txt']);
    assert.match(branchDiff(wt, 'main'), /\+new/);

    mergeWorktree(dir, wt, 'T9', 'main');
    assert.equal(readFileSync(join(dir, 'feature.txt'), 'utf8'), 'new\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree: reclaims a leftover branch from a prior run (no crash)', () => {
  const { dir, g } = makeRepo();
  try {
    const wt1 = createWorktree(dir, 'T5', 'main');
    writeFileSync(join(wt1, 'a.txt'), '1\n');
    commitAll(wt1, 'T5: a');
    // Simulate a crashed run: worktree dir gone but branch agb/t5 dangling.
    rmSync(wt1, { recursive: true, force: true });
    g('worktree', 'prune');
    assert.match(g('branch', '--list', 'agb/t5'), /agb\/t5/);
    // Re-run must not crash on "branch already exists".
    const wt2 = createWorktree(dir, 'T5', 'main');
    assert.ok(existsSync(wt2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMidMerge/abortAnyMerge: a conflicted merge is detected and cleaned', () => {
  const { dir, g } = makeRepo();
  try {
    writeFileSync(join(dir, 'c.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'other');
    writeFileSync(join(dir, 'c.txt'), 'other\n');
    g('add', '-A'); g('commit', '-qm', 'other side');
    g('checkout', '-q', 'main');
    writeFileSync(join(dir, 'c.txt'), 'main\n');
    g('add', '-A'); g('commit', '-qm', 'main side');
    assert.equal(isMidMerge(dir), false);
    try { g('merge', 'other'); } catch { /* expected conflict */ }
    assert.equal(isMidMerge(dir), true, 'conflict leaves repo mid-merge');
    abortAnyMerge(dir);
    assert.equal(isMidMerge(dir), false, 'abort clears the merge state');
    assert.equal(g('status', '--porcelain').trim(), '', 'tree clean after abort');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FAKE_PLUGIN = fileURLToPath(new URL('./fixtures/fake-adlc-antigravity-plugin', import.meta.url));

test('resolvePluginPath: honors ADLC_ANTIGRAVITY_PLUGIN_PATH when set', () => {
  const prev = process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = '/tmp/some-plugin-checkout';
  try {
    assert.equal(resolvePluginPath(), resolve('/tmp/some-plugin-checkout'));
  } finally {
    if (prev === undefined) delete process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
    else process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = prev;
  }
});

test('resolvePluginPath: resolves the @adlc/antigravity npm package from node_modules when env unset', () => {
  // The published plugin (@adlc/antigravity) is a declared dependency, so with
  // no env override the primary node_modules resolution wins over the sibling
  // fallback. Assert against independent signal (not resolvePluginPath's own
  // resolution expression): the returned dir lives under node_modules/@adlc/
  // antigravity AND holds the plugin manifest agy plugin install consumes.
  const prev = process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  delete process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  try {
    const got = resolvePluginPath();
    assert.ok(got.includes(join('node_modules', '@adlc', 'antigravity')),
      `expected a node_modules path, got ${got}`);
    assert.ok(existsSync(join(got, 'plugin.json')), 'resolved dir holds the plugin manifest');
  } finally {
    if (prev !== undefined) process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = prev;
  }
});

test('resolvePluginPath: falls back to the ../adlc/plugins/adlc-antigravity sibling convention when the npm package is unresolvable', () => {
  // The node_modules resolution above can't exercise the final fallback branch
  // while @adlc/antigravity is installed. Copy bootstrap.mjs + its only local
  // import into an isolated temp dir that has NO node_modules ancestor, so
  // require.resolve('@adlc/antigravity') genuinely throws and the catch returns
  // the sibling default computed from the (copied) module's own location.
  const isoRoot = mkdtempSync(join(tmpdir(), 'agb-resolve-fallback-'));
  const libDir = join(isoRoot, 'lib');
  mkdirSync(libDir);
  const libSrc = fileURLToPath(new URL('../lib', import.meta.url));
  for (const f of ['bootstrap.mjs', 'adlc-bridge.mjs']) {
    writeFileSync(join(libDir, f), readFileSync(join(libSrc, f)));
  }
  // repoRoot inside resolvePluginPath is `new URL('..', import.meta.url)` of the
  // copied bootstrap.mjs, i.e. isoRoot; the fallback resolves the sibling from there.
  const expected = resolve(isoRoot, '../adlc/plugins/adlc-antigravity');
  try {
    const out = execFileSync(process.execPath, [
      '-e',
      `import('${pathToFileURL(join(libDir, 'bootstrap.mjs'))}')` +
        `.then(({ resolvePluginPath }) => { process.stdout.write(resolvePluginPath()); })`,
    ], {
      stdio: 'pipe',
      env: { ...process.env, ADLC_ANTIGRAVITY_PLUGIN_PATH: '', NODE_PATH: '' },
    }).toString().trim();
    assert.equal(out, expected, 'unresolvable npm package falls back to the sibling checkout');
  } finally {
    rmSync(isoRoot, { recursive: true, force: true });
  }
});

test('bootstrap: installs the adlc-antigravity plugin via `agy plugin install`, then links booster-owned skills', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  try {
    bootstrap({ destination: destDir, pluginPath: FAKE_PLUGIN, agyBin: FAKE_AGY, force: true });
    // Vendored ADLC-doctrine skill copies are gone from this repo — bootstrap
    // must not (and now cannot) install skills/adlc-doctrine etc.
    assert.ok(!existsSync(join(process.cwd(), 'skills', 'adlc-doctrine')));
    // Booster-owned skills (not ADLC doctrine) are still linked/copied.
    assert.ok(existsSync(join(destDir, 'release')));
    assert.ok(!existsSync(join(destDir, 'adlc-doctrine')));
    assert.ok(!existsSync(join(destDir, 'adlc-prosecutor')));
    assert.ok(!existsSync(join(destDir, 'adlc-self-orchestrate')));
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test('bootstrap: agy plugin install invoked with the resolved plugin path', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-state-'));
  const prevState = process.env.FAKE_STATE_DIR;
  process.env.FAKE_STATE_DIR = stateDir;
  try {
    bootstrap({ destination: destDir, pluginPath: FAKE_PLUGIN, agyBin: FAKE_AGY, force: true });
    const installs = readFileSync(join(stateDir, 'plugin-installs'), 'utf8').trim();
    assert.equal(installs, FAKE_PLUGIN, 'agy plugin install received the resolved plugin path');
  } finally {
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
    rmSync(destDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bootstrap: fails loudly (non-zero exit) when the plugin path does not exist — no silent no-op', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  const missingPluginPath = join(destDir, 'does-not-exist');
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [
        '-e',
        `import('${new URL('../lib/bootstrap.mjs', import.meta.url)}').then(({ bootstrap }) => ` +
          `bootstrap({ destination: '${destDir}', pluginPath: '${missingPluginPath}', agyBin: '${FAKE_AGY}' }))`,
      ], { stdio: 'pipe' });
    }, /Command failed/, 'process.exit(1) surfaces as a non-zero exit, not a silent no-op');
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test('bootstrap: fails loudly when `agy plugin install` itself fails (e.g. agy too old for plugin install)', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [
        '-e',
        `import('${new URL('../lib/bootstrap.mjs', import.meta.url)}').then(({ bootstrap }) => ` +
          `bootstrap({ destination: '${destDir}', pluginPath: '${FAKE_PLUGIN}', agyBin: '${FAKE_AGY}' }))`,
      ], { stdio: 'pipe', env: { ...process.env, FAKE_AGY_PLUGIN_MODE: 'fail' } });
    }, /Command failed/, 'a failing `agy plugin install` surfaces as a non-zero exit, not a silent no-op');
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

