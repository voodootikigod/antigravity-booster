import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { poolOf, familyOf, runAgy, resolveModelSlug } from '../lib/agy.mjs';
import { PoolSet, tierCandidates } from '../lib/pools.mjs';
import { builderAgentsMd, prosecutionPrompt } from '../lib/charters.mjs';
import { runGate, runGates } from '../lib/gates.mjs';
import { prosecute } from '../lib/prosecute.mjs';
import { RunStatus, renderStatus } from '../lib/status.mjs';
import { reviewFleet } from '../lib/review.mjs';
import { compilePlan } from '../lib/plan.mjs';
import { runPlan } from '../lib/scheduler.mjs';
import {
  ensureGitignore, createWorktree, commitAll, branchDiff, mergeWorktree, changedFiles,
  isMidMerge, abortAnyMerge,
} from '../lib/worktrees.mjs';
import { bootstrap, resolvePluginPath } from '../lib/bootstrap.mjs';

delete process.env.AGB_PROVIDER;
process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_unit_test.json');


const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

// --- agb validate (plan-shape gate) ---

test('agb validate: rejects duplicate ids, unknown edges, missing body, empty scope, unroutable tier/hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-validate-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({
      repo: dir,
      gate: { test: 'npm test' },
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
      gate: { test: 'npm test' },
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
  assert.equal(poolOf('gemini-3.8-flash-low'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.8-flash-medium'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.8-flash-high'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.7-flash-low'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.7-flash-medium'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.7-flash-high'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.6-flash-low'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.6-flash-medium'), 'gemini-flash');
  assert.equal(poolOf('gemini-3.6-flash-high'), 'gemini-flash');
  assert.equal(familyOf('gemini-3.8-flash-high'), 'gemini');
  assert.equal(familyOf('gemini-3.7-flash-low'), 'gemini');
  assert.equal(familyOf('gemini-3.6-flash-medium'), 'gemini');
  assert.equal(familyOf('claude-sonnet-4-6'), 'claude');
  assert.equal(familyOf('gpt-oss-120b-medium'), 'gpt-oss');
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

test('resolveModelSlug: maps 3.5 legacy models to 3.8 and resolves display aliases', () => {
  assert.equal(resolveModelSlug('gemini-3.5-flash-low'), 'gemini-3.8-flash-low');
  assert.equal(resolveModelSlug('gemini-3.5-flash-medium'), 'gemini-3.8-flash-medium');
  assert.equal(resolveModelSlug('gemini-3.5-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(resolveModelSlug('Gemini 3.5 Flash (Low)'), 'gemini-3.8-flash-low');
  assert.equal(resolveModelSlug('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash-high');
  assert.equal(resolveModelSlug('Gemini 3.7 Flash (Medium)'), 'gemini-3.7-flash-medium');
  assert.equal(resolveModelSlug('Gemini 3.6 Flash (Low)'), 'gemini-3.6-flash-low');
  assert.equal(resolveModelSlug('Claude Sonnet 4.6 (Thinking)'), 'claude-sonnet-4-6');
});

test('tierCandidates: filters by pool_hint including claude-gpt alias', () => {
  const cheapGemini = tierCandidates('cheap', 'gemini');
  assert.ok(cheapGemini.includes('gemini-3.8-flash-low'));
  assert.ok(cheapGemini.includes('gemini-3.7-flash-low'));
  assert.ok(cheapGemini.includes('gemini-3.6-flash-low'));

  const frontierClaude = tierCandidates('frontier', 'claude');
  assert.ok(frontierClaude.includes('claude-sonnet-4-6'));
  assert.ok(!frontierClaude.includes('gemini-3.1-pro-high'));

  const frontierClaudeGpt = tierCandidates('frontier', 'claude-gpt');
  assert.ok(frontierClaudeGpt.includes('claude-sonnet-4-6'));
  assert.ok(!frontierClaudeGpt.includes('gemini-3.1-pro-high'));
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
  assert.equal(r.kind, 'timeout');
});

test('runAgy: classifies and logs failures correctly', async () => {
  const logFile = join(tmpdir(), `agb-test-agy-log-${Date.now()}.jsonl`);
  try {
    const parseLogBlocks = (content) => {
      return content.trim().split('\n').filter(Boolean).map(line => {
        try {
          const o = JSON.parse(line);
          return { header: o, prompt: o.prompt, output: o.output };
        } catch { return null; }
      }).filter(Boolean);
    };

    // 1. Timeout
    writeFileSync(logFile, '');
    const rTimeout = await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'multi\nFAKE:TIMEOUT\nmulti', bin: FAKE_AGY, logFile, env: { FAKE_AGY_MODE: 'timeout' } });
    assert.equal(rTimeout.ok, false);
    assert.equal(rTimeout.kind, 'timeout');
    let logs = parseLogBlocks(readFileSync(logFile, 'utf8'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].header.kind, 'timeout');
    assert.equal(logs[0].prompt, 'multi\nFAKE:TIMEOUT\nmulti');
    assert.match(logs[0].output, /timed out/);

    // 2. Empty
    writeFileSync(logFile, '');
    const rEmpty = await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'multi\nprompt', bin: FAKE_AGY, logFile, env: { FAKE_AGY_MODE: 'empty' } });
    assert.equal(rEmpty.ok, false);
    assert.equal(rEmpty.kind, 'empty');
    logs = parseLogBlocks(readFileSync(logFile, 'utf8'));
    assert.equal(logs[0].header.kind, 'empty');
    assert.equal(logs[0].output, '');

    // 3. Server
    writeFileSync(logFile, '');
    const rServer = await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'multi\nprompt', bin: FAKE_AGY, logFile, env: { FAKE_AGY_MODE: 'server' } });
    assert.equal(rServer.ok, false);
    assert.equal(rServer.kind, 'server');
    logs = parseLogBlocks(readFileSync(logFile, 'utf8'));
    assert.equal(logs[0].header.kind, 'server');
    assert.match(logs[0].header.error, /exit 1/);

    // 4. Spawn
    writeFileSync(logFile, '');
    const rSpawn = await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'multi\nprompt', bin: '/does-not-exist/non-existent-binary', logFile });
    assert.equal(rSpawn.ok, false);
    assert.equal(rSpawn.kind, 'spawn');
    logs = parseLogBlocks(readFileSync(logFile, 'utf8'));
    assert.equal(logs[0].header.kind, 'spawn');
    assert.match(logs[0].header.error, /ENOENT/);
  } finally {
    try { rmSync(logFile); } catch {}
  }
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

test('runAgy: --project is passed when project is provided; omitted by default', async () => {
  const state = mkdtempSync(join(tmpdir(), 'agb-agy-argv-'));
  const prevState = process.env.FAKE_STATE_DIR;
  process.env.FAKE_STATE_DIR = state;
  try {
    await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'x', bin: FAKE_AGY });
    await runAgy({ model: 'Gemini 3.5 Flash (Low)', prompt: 'x', bin: FAKE_AGY, project: 'test-proj' });
    const [defaultCall, projectCall] = readFileSync(join(state, 'agy-argv-seen'), 'utf8').trim().split('\n');
    assert.ok(!defaultCall.includes('--project'), 'project option omitted by default — no --project flag');
    assert.ok(projectCall.includes('--project test-proj'), 'project: "test-proj" passes --project test-proj');
  } finally {
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
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
  // First mid ticket -> gemini-3.8-flash-high
  assert.equal(pools.route('mid'), 'gemini-3.8-flash-high');
  // Second mid ticket (no slot acquired yet — the bug case) must NOT pick
  // claude again; reservation pushes it to the idle gemini-pro pool.
  assert.equal(pools.route('mid'), 'gemini-3.1-pro-low');
  // pool_hint still constrains family (but both are gemini now, so it falls back to load ratio: 1/8 < 1/4)
  assert.equal(pools.route('mid', 'gemini'), 'gemini-3.8-flash-high');
  // unroute frees the assignment so the pool rebalances.
  pools.unroute('gemini-3.1-pro-low');
  pools.unroute('gemini-3.1-pro-low');
  assert.equal(pools.reserved['gemini-pro'], 0);
});

test('PoolSet.prosecutorFor: always a different family', () => {
  const pools = new PoolSet();
  assert.equal(familyOf(pools.prosecutorFor('Gemini 3.5 Flash (Low)')), 'gpt-oss');
  assert.equal(familyOf(pools.prosecutorFor('GPT-OSS 120B (Medium)')), 'gemini');
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
    const v = await prosecute({ ticket: { id: 'T1', body: 'spec' }, diff: 'real diff', model: 'Gemini 3.5 Flash (High)' });
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
    const v = await prosecute({ ticket: { id: 'T1', body: 'spec' }, diff: 'real diff', model: 'Gemini 3.5 Flash (High)' });
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

// The test below renders the dashboard and matches /T1/, but s.report() also
// carries 'T1', so that assertion passes even when the ticket table is empty —
// RunStatus.ticket() could record nothing at all and the suite stayed green.
// These pin the recording itself: state, and the phase transition in the event
// log the TUI reads.
test('RunStatus.ticket: records ticket state and emits phase transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-status-rec-'));
  try {
    const s = new RunStatus(dir, 'run-rec');
    s.ticket('T1', { phase: 'building', model: 'Gemini 3.5 Flash (High)', detail: 'first' });
    s.ticket('T1', { phase: 'merged' });
    await s.writePromise;

    const run = JSON.parse(readFileSync(join(dir, '.booster', 'run.json'), 'utf8'));
    assert.deepEqual(Object.keys(run.tickets), ['T1'], 'the ticket must be recorded in run state');
    assert.equal(run.tickets.T1.phase, 'merged', 'the latest phase wins');
    assert.equal(run.tickets.T1.model, 'Gemini 3.5 Flash (High)', 'earlier fields survive a later patch');

    const events = readFileSync(join(dir, '.booster', 'logs', 'run-rec', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const phases = events.filter((e) => e.type === 'phase');
    assert.equal(phases.length, 2, 'one phase event per ticket() call');
    assert.equal(phases[0].to, 'building');
    assert.equal(phases[0].from, undefined, 'no from on the first transition');
    assert.equal(phases[1].from, 'building', 'the transition records where it came from');
    assert.equal(phases[1].to, 'merged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RunStatus.ticket: __proto__/constructor ids cannot corrupt the ticket map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-status-proto-'));
  try {
    const s = new RunStatus(dir, 'run-proto');
    s.ticket('__proto__', { phase: 'pwned' });
    s.ticket('constructor', { phase: 'pwned' });
    s.ticket('T1', { phase: 'building' });
    await s.writePromise;

    assert.equal({}.phase, undefined, 'Object.prototype must not be reachable for pollution');
    assert.equal(Object.getPrototypeOf(s.state.tickets), Object.prototype, 'the ticket map prototype must be intact');
    assert.deepEqual(Object.keys(s.state.tickets), ['T1'], 'poisoned ids are dropped, real ones still land');

    const events = readFileSync(join(dir, '.booster', 'logs', 'run-proto', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.type === 'phase').map((e) => e.ticket), ['T1'],
      'a rejected id must not reach the event log either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RunStatus: atomic write + dashboard render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-status-'));
  try {
    const s = new RunStatus(dir, 'run-test');
    s.ticket('T1', { phase: 'building', model: 'Gemini 3.5 Flash (High)' });
    s.report({ merged: ['T1'], failed: {}, requests: { claude: 2 } });
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

const CANONICAL_STANZA = ['.worktrees/', '.booster/', '.adlc/*',
  '!.adlc/tickets.json', '!.adlc/tickets/', '!.adlc/tickets/**',
  '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/config.json'];

test('ensureGitignore: an already-complete .gitignore is left byte-identical (no commit)', () => {
  const { dir, g } = makeRepo();
  try {
    const complete = CANONICAL_STANZA.join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), complete);
    g('add', '-A'); g('commit', '-qm', 'seed complete gitignore');
    const headBefore = g('rev-parse', 'HEAD').trim();

    ensureGitignore(dir);

    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), complete, 'byte-identical — nothing appended');
    assert.equal(g('rev-parse', 'HEAD').trim(), headBefore, 'no new commit for an already-complete stanza');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGitignore: a legacy-only partial stanza gains EXACTLY the missing directory-store negations (no extras, no dupes)', () => {
  const { dir, g } = makeRepo();
  try {
    // Includes an unrelated pre-existing user rule to verify append-only
    // preservation of content ensureGitignore doesn't own.
    const legacyOnly = '*.log\n.worktrees/\n.booster/\n.adlc/*\n!.adlc/tickets.json\n';
    writeFileSync(join(dir, '.gitignore'), legacyOnly);
    g('add', '-A'); g('commit', '-qm', 'seed legacy-only gitignore');

    ensureGitignore(dir);

    // Exact output, not just "contains": a regression that appends an extra
    // over-broad pattern (e.g. '.adlc/**' after the negations, which would
    // re-ignore the ticket store) or duplicates a line must fail this.
    const gained = ['!.adlc/tickets/', '!.adlc/tickets/**', '!.adlc/ticket-archive/',
      '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/config.json'];
    const expected = legacyOnly + gained.join('\n') + '\n';
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktrees: create → edit → commit → diff → merge lifecycle', () => {
  const { dir, g } = makeRepo();
  try {
    ensureGitignore(dir);
    ensureGitignore(dir); // idempotent — second call must not commit again
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.equal(gi.match(/\.worktrees\//g).length, 1);
    // Full canonical ADLC stanza: the directory ticket store, its archive, and
    // specs must all be un-ignored, matching `adlc ticket store migrate` and
    // the adlc-antigravity plugin's adlc-init.
    for (const line of ['.adlc/*', '!.adlc/tickets.json', '!.adlc/tickets/', '!.adlc/tickets/**',
      '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/config.json']) {
      assert.ok(gi.split('\n').includes(line), `canonical stanza line present: ${line}`);
    }
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

// Two tickets touching one file is the expected case in a parallel orchestrator,
// not an exotic one. The guard has two jobs: escalate (throw), and leave the
// worktree usable (rebase --abort). A worktree stranded mid-rebase would let the
// next operation commit conflict markers into base, so both are asserted.
test('mergeWorktree: a rebase conflict throws and leaves no rebase in progress', () => {
  const { dir, g } = makeRepo();
  try {
    writeFileSync(join(dir, 'shared.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'add shared');

    // Ticket branches off, edits the shared file.
    const wt = createWorktree(dir, 'T7', 'main');
    writeFileSync(join(wt, 'shared.txt'), 'ticket side\n');
    assert.equal(commitAll(wt, 'T7: edit shared'), true);

    // main moves underneath it, editing the same line differently.
    writeFileSync(join(dir, 'shared.txt'), 'main side\n');
    g('add', '-A'); g('commit', '-qm', 'main edits shared');

    assert.throws(
      () => mergeWorktree(dir, wt, 'T7', 'main'),
      /rebase conflict for T7/,
      'a conflict must escalate, not merge silently'
    );

    // rebase --abort ran: git reports no rebase in progress and the worktree is
    // back on its own branch with its own content, not a half-applied state.
    const rebaseDir = execFileSync('git', ['rev-parse', '--git-path', 'rebase-merge'], { cwd: wt, encoding: 'utf8' }).trim();
    const rebaseApply = execFileSync('git', ['rev-parse', '--git-path', 'rebase-apply'], { cwd: wt, encoding: 'utf8' }).trim();
    assert.equal(existsSync(join(wt, rebaseDir)) || existsSync(join(wt, rebaseApply)), false, 'worktree left mid-rebase');
    assert.equal(readFileSync(join(wt, 'shared.txt'), 'utf8'), 'ticket side\n', 'worktree content restored');

    // base is untouched — the conflicting ticket did not land.
    assert.equal(readFileSync(join(dir, 'shared.txt'), 'utf8'), 'main side\n');
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
    const norm = (p) => p.replace(/^\/private/, '');
    assert.equal(norm(out), norm(expected), 'unresolvable npm package falls back to the sibling checkout');
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
    const linked = readdirSync(destDir);
    assert.ok(linked.length > 0, 'at least one skill should be linked');
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
    const installs = readFileSync(join(stateDir, 'plugin-installs'), 'utf8').trim().split('\n');
    assert.equal(installs[0], '.', 'agy plugin install received "." for adlc');
    assert.equal(installs[1], '.', 'also installed booster plugin itself via "."');

  } finally {
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
    rmSync(destDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});


test('bootstrap: fails loudly (non-zero exit) when the plugin path does not exist, but skill linking still performed', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  const missingPluginPath = join(destDir, 'does-not-exist');
  try {
    let out = '';
    assert.throws(() => {
      out = execFileSync(process.execPath, [
        '-e',
        `import('${new URL('../lib/bootstrap.mjs', import.meta.url)}').then(({ bootstrap }) => ` +
          `bootstrap({ destination: '${destDir}', pluginPath: '${missingPluginPath}', agyBin: '${FAKE_AGY}' }))`,
      ], { stdio: 'pipe' }).toString();
    }, /Command failed/, 'process.exit(1) surfaces as a non-zero exit, not a silent no-op');
    
    // We expect the error text to be printed to stderr, so it might be on err.stderr
    // But since assert.throws swallows the error object, we can catch it instead to inspect stderr.
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test('bootstrap: fails loudly with clone URL when the plugin path does not exist, but skill linking still performed', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-bootstrap-test-'));
  const missingPluginPath = join(destDir, 'does-not-exist');
  try {
    try {
      execFileSync(process.execPath, [
        '-e',
        `import('${new URL('../lib/bootstrap.mjs', import.meta.url)}').then(({ bootstrap }) => ` +
          `bootstrap({ destination: '${destDir}', pluginPath: '${missingPluginPath}', agyBin: '${FAKE_AGY}' }))`,
      ], { stdio: 'pipe' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Command failed'));
      const stderr = err.stderr.toString();
      assert.ok(stderr.includes('git clone git@github.com:voodootikigod/adlc.git'));
      assert.ok(stderr.includes('ADLC_ANTIGRAVITY_PLUGIN_PATH'));
    }
    
    const linked = readdirSync(destDir);
    assert.ok(linked.length > 0, 'at least one skill should be linked even on plugin failure');
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


test('prosecute and reviewFleet: pass project option through to runAgy', async () => {
  const state = join(tmpdir(), `agb-test-proj-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  process.env.FAKE_STATE_DIR = state;
  process.env.AGB_AGY_BIN = FAKE_AGY;

  await prosecute({ ticket: {id:'T1'}, diff: 'a', model: 'x', project: 'proj-prosecute' });
  let argv = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
  assert.ok(argv.includes('--project proj-prosecute'), 'prosecute passes project');
  rmSync(join(state, 'agy-argv-seen'));

  await reviewFleet({ diff: 'a', context: '', project: 'proj-review' });
  argv = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
  assert.ok(argv.includes('--project proj-review'), 'reviewFleet passes project');
  rmSync(join(state, 'agy-argv-seen'));
});

test('compilePlan and runPlan: pass project option through to runAgy', async () => {
  const state = join(tmpdir(), `agb-test-proj-plan-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  process.env.FAKE_STATE_DIR = state;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_BRAIN_MODE = 'edges';
  process.env.AGB_ALLOW_DIRTY = '1';
  const repo = join(tmpdir(), `agb-test-plan-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc/config.json'), JSON.stringify({}));
  execSync('git init -b main', { cwd: repo });
  execSync('git config commit.gpgsign false', { cwd: repo });
  execSync('git config user.name "Test User"', { cwd: repo });
  execSync('git config user.email "test@example.com"', { cwd: repo });
  execSync('git add .', { cwd: repo });
  execSync('git commit --allow-empty -m "initial"', { cwd: repo });

  const specFile = join(tmpdir(), `agb-test-spec-${Date.now()}.json`);
  writeFileSync(specFile, JSON.stringify({ tickets: [] }));
  await compilePlan(specFile, { repo, coldstart: true, parallax: true, premortem: true, project: 'proj-compile' });
  let argv = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
  assert.ok(argv.includes('--project proj-compile'), 'compilePlan passes project');
  rmSync(join(state, 'agy-argv-seen'));

  const plan = { repo, base: 'main', gate: { test: 'true' }, tickets: [{id:'T1', title:'a', body:'a', scope:[], edges:[]}] };
  await runPlan(plan, { project: 'proj-run' });
  argv = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
  assert.ok(argv.includes('--project proj-run'), 'runPlan passes project');
  rmSync(join(state, 'agy-argv-seen'));
});

test('plugin.json version matches package.json', () => {
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const plugin = JSON.parse(readFileSync(new URL('plugin.json', root), 'utf8'));
  assert.equal(plugin.version, pkg.version, 'plugin.json version must stay in sync with package.json for Antigravity plugin manifest');
});


test('bootstrap: isNpxTemp recognizes actual npx cache and ignores temp substrings in normal paths', async () => {
  const { isNpxTemp } = await import('../lib/bootstrap.mjs');
  
  assert.equal(isNpxTemp('/home/user/.npm/_npx/12345/node_modules/antigravity-booster', {}), true);
  assert.equal(isNpxTemp('/home/user/.npm/_npx/12345/node_modules/antigravity-booster', { npm_config_cache: '/home/user/.npm' }), true);
  assert.equal(isNpxTemp('/Users/x/tmp/repo/node_modules/antigravity-booster', {}), false);
  
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.equal(isNpxTemp(join(tmpdir(), 'agb-test', 'file.mjs'), {}), true);
  assert.equal(isNpxTemp('/tmp/npm-cache/agb/lib/bootstrap.mjs', { npm_config_cache: '/tmp/npm-cache' }), true, 'Matches npm_config_cache');
  assert.equal(isNpxTemp('/var/folders/something/agb/lib/bootstrap.mjs', {}), true, 'macOS /var/folders is treated as temp');
  assert.equal(isNpxTemp('/private/var/folders/something/agb/lib/bootstrap.mjs', {}), true, 'macOS /private/var/folders is treated as temp');
});

test('sidecar: workspace manifests conform to specification and contain portable paths', () => {
  const manifestPaths = [
    new URL('../.agents/sidecars/agb-dashboard/sidecar.json', import.meta.url),
    new URL('../.agents/plugins/agb/sidecars/dashboard/sidecar.json', import.meta.url),
    new URL('../.agents/plugins/agb-dashboard/sidecars/agb-dashboard/sidecar.json', import.meta.url),
  ];

  for (const manifestPath of manifestPaths) {
    if (!existsSync(manifestPath)) continue;
    const manifestContent = readFileSync(manifestPath, 'utf8');
    assert.ok(!manifestContent.includes('/Users/voodootikigod/'), `Manifest at ${manifestPath.pathname} must not contain hardcoded developer paths`);
    assert.ok(!manifestContent.includes('/Users/'), `Manifest at ${manifestPath.pathname} must not contain hardcoded user home paths`);

    const manifest = JSON.parse(manifestContent);
    assert.equal(manifest.has_web_ui, true, 'has_web_ui must be true');
    assert.ok(manifest.ui_config, 'ui_config must be present');
    assert.ok(Array.isArray(manifest.ui_config.views), 'ui_config.views must be an array');

    if (Array.isArray(manifest.args)) {
      for (const arg of manifest.args) {
        assert.ok(!arg.startsWith('/Users/'), `arg '${arg}' must not be a hardcoded user path`);
      }
    }
  }
});

test('agy: parseTimeoutMs handles formatted string and numeric inputs', async () => {
  const { parseTimeoutMs } = await import('../lib/agy.mjs');
  assert.equal(parseTimeoutMs('30s'), 30000);
  assert.equal(parseTimeoutMs('5m'), 300000);
  assert.equal(parseTimeoutMs('1h'), 3600000);
  assert.equal(parseTimeoutMs(60000), 60000);
  assert.equal(parseTimeoutMs(null), 600000);
});

test('brain: getActiveSessionId reads ANTIGRAVITY_CONVERSATION_ID', async () => {
  const { getActiveSessionId } = await import('../lib/brain.mjs');
  const prev = process.env.ANTIGRAVITY_CONVERSATION_ID;
  try {
    process.env.ANTIGRAVITY_CONVERSATION_ID = 'test-session-123';
    assert.equal(getActiveSessionId(), 'test-session-123');
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_CONVERSATION_ID; else process.env.ANTIGRAVITY_CONVERSATION_ID = prev;
  }
});

test('plugins: .agents/plugins/agb/plugin.json matches root plugin.json specification', () => {
  const rootManifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
  const agentManifestPath = new URL('../.agents/plugins/agb/plugin.json', import.meta.url);
  assert.ok(existsSync(agentManifestPath), '.agents/plugins/agb/plugin.json must exist');
  const agentManifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
  assert.equal(agentManifest.id, rootManifest.id, 'Plugin ID must match root manifest');
  assert.equal(agentManifest.version, rootManifest.version, 'Plugin version must match root manifest');
});

test('agents: declarative agent manifests exist under .agents/agents/', () => {
  const roles = ['prosecutor', 'spec-linter', 'fleet-scheduler'];
  for (const role of roles) {
    const agentJson = new URL(`../.agents/agents/${role}/agent.json`, import.meta.url);
    const configYaml = new URL(`../.agents/agents/${role}/config.yaml`, import.meta.url);
    assert.ok(existsSync(agentJson), `.agents/agents/${role}/agent.json must exist`);
    assert.ok(existsSync(configYaml), `.agents/agents/${role}/config.yaml must exist`);
  }
});

test('standalone commands: reviewFleet, preflight, compilePlan, and brainToPlan require successful quota refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-quota-check-'));
  const origBin = process.env.AGB_AGY_BIN;
  const origQuotaMode = process.env.FAKE_AGY_QUOTA_MODE;
  const origQuotaState = process.env.AGB_QUOTA_STATE;
  const origPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_AGY_BIN = FAKE_AGY;
    process.env.FAKE_AGY_QUOTA_MODE = 'fail';
    process.env.AGB_QUOTA_STATE = join(dir, 'agb_pools_quota_check.json');
    process.env.AGB_POOLS_DIR = dir;

    const pools = new PoolSet(undefined, { repo: dir });

    // 1. reviewFleet rejects when quota telemetry unavailable
    await assert.rejects(
      async () => {
        await reviewFleet({ diff: 'some diff', pools, repo: dir });
      },
      /quota telemetry unavailable/
    );

    // 2. preflight rejects when quota telemetry unavailable
    const { preflight } = await import('../lib/preflight.mjs');
    await assert.rejects(
      async () => {
        await preflight({ tickets: [] }, { pools, repo: dir });
      },
      /quota telemetry unavailable/
    );

    // 3. compilePlan rejects when quota telemetry unavailable
    await assert.rejects(
      async () => {
        await compilePlan('nonexistent', { pools, repo: dir });
      },
      /quota telemetry unavailable/
    );

    // 4. brainToPlan rejects when quota telemetry unavailable
    const { brainToPlan } = await import('../lib/brain.mjs');
    await assert.rejects(
      async () => {
        await brainToPlan('nonexistent', { pools, repo: dir });
      },
      /quota telemetry unavailable/
    );
  } finally {
    if (origBin === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = origBin;
    if (origQuotaMode === undefined) delete process.env.FAKE_AGY_QUOTA_MODE; else process.env.FAKE_AGY_QUOTA_MODE = origQuotaMode;
    if (origQuotaState === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuotaState;
    if (origPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = origPoolsDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
