import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { bootstrap } from '../lib/bootstrap.mjs';

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
  assert.throws(() => poolOf('GPT-9'));
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
  const fail = await runGates({ a: 'true', b: 'echo nope && false', c: 'true' }, '/tmp');
  assert.equal(fail.ok, false);
  assert.equal(fail.results.length, 2, 'c must not run after b fails');
  assert.match(fail.results[1].output, /nope/);
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
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
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

test('bootstrap: installs skills into custom destination directory', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  try {
    bootstrap({ destination: destDir });
    // Verify that the skills folders are created
    assert.ok(existsSync(join(destDir, 'adlc-doctrine')));
    assert.ok(existsSync(join(destDir, 'adlc-prosecutor')));
    assert.ok(existsSync(join(destDir, 'adlc-self-orchestrate')));
    assert.ok(existsSync(join(destDir, 'release')));
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

