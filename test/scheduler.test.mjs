import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'; // eslint-disable-line
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ticketFilename } from '@adlc/tickets';

import { runPlan } from '../lib/scheduler.mjs';
import { reapIntegrationWorktrees } from '../lib/worktrees.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_scheduler_test.json');

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
// B12: the live-enforcement check now handshakes the installed plugin manifest's
// adlcContract instead of matching a name in `agy plugin list`. Tests that create
// .adlc/ and expect enforcement AVAILABLE must point AGB_PLUGIN_DIR at a
// contract-compatible fixture; the absent-manifest fixture drives the degraded
// path deterministically (never reading the dev machine's real ~/.gemini install).
const PLUGIN_COMPATIBLE = fileURLToPath(new URL('./fixtures/plugin-compatible', import.meta.url));
const PLUGIN_ABSENT = fileURLToPath(new URL('./fixtures/plugin-does-not-exist', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sched-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  // Throwaway test repos must not depend on the developer's own commit-signing
  // setup (GPG/SSH agent) — disable it locally, never touch global config.
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return dir;
}

function withEnv(env, fn) {
  const mergedEnv = { AGB_ALLOW_CUSTOM_ADLC_CLI: '1', ...env };
  const saved = {};
  for (const [k, v] of Object.entries(mergedEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

const quiet = { log: () => {} };

// Local port of the adlc-antigravity plugin's tickets validation rules
// (plugins/adlc-antigravity/core-inline.mjs loadTickets) — replicated here, NOT
// imported, so the suite stays fully offline with no sibling-checkout dependency
// (AGENTS.md). The load-bearing rule for B11 is the dangling-edge check: an edge
// whose target id is absent from the file is an error, and the plugin's
// railPreconditions fails CLOSED on ANY such error — denying every structured
// write for the whole build, not just rail paths. Returns the plugin's error list.
function pluginValidationErrors(data) {
  if (!Array.isArray(data?.tickets)) return ['Root must be { tickets: [] }'];
  if (data.tickets.length !== 1) return ['Tickets array must have exactly one element'];
  const t = data.tickets[0];
  if (!t.id || typeof t.id !== 'string') return ['Ticket missing string id'];
  if (!t.title || typeof t.title !== 'string') return ['Ticket missing string title'];
  const errors = [];
  for (const e of t.edges ?? []) {
    if (!data.tickets.some((x) => x.id === e.to)) errors.push(`Dangling edge to ${e.to}`);
  }
  return errors;
}

test('runPlan: 3-ticket DAG builds in parallel, prosecutes, merges all', async () => {
  const repo = makeRepo();
  try {
    // AGB_SANDBOX_GATES=0: gate sandboxing is darwin-only and fails closed
    // elsewhere; its behavior is covered by the security suite. Without this
    // the scheduler suite is red on Linux (SPEC A8: npm test green offline).
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
      runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], edges: [{ to: 'T3' }] },
          { id: 'T2', title: 'two', body: 'write T2.txt', scope: ['T2.txt'] },
          { id: 'T3', title: 'three', body: 'write T3.txt', scope: ['T3.txt'] },
        ],
      }, quiet)
    );
    assert.deepEqual(Object.keys(report.failed), []);
    assert.equal(report.merged.length, 3);
    for (const f of ['T1.txt', 'T2.txt', 'T3.txt']) {
      assert.ok(existsSync(join(repo, f)), `${f} on main`);
    }
    // T3 depends on T1: T1 must merge first.
    assert.ok(report.merged.indexOf('T1') < report.merged.indexOf('T3'));
    // Requests metered: 3 builders + 3 prosecutors across pools.
    const total = Object.values(report.requests).reduce((a, b) => a + b, 0);
    assert.equal(total, 6);
    // Status artifacts exist.
    assert.ok(existsSync(join(repo, '.booster', 'report.json')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The DAG's whole promise is that declaration order does not decide execution
// order — dependencies do. dispatch() iterates the tickets array, so a plan whose
// array order already matches the dependency order is satisfied by the iteration
// alone and proves nothing. Here the array is declared in the *wrong* order
// (dependent first), so array order and the DAG disagree: only a working
// predecessor gate can produce the asserted result.
test('runPlan: a dependent declared first still merges after its predecessor', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
      runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          // LAST in dependency order, FIRST in the array.
          { id: 'DEPENDENT', title: 'dependent', body: 'write DEPENDENT.txt', scope: ['DEPENDENT.txt'] },
          // BLOCKER blocks DEPENDENT, so BLOCKER must merge first despite being second.
          { id: 'BLOCKER', title: 'blocker', body: 'write BLOCKER.txt', scope: ['BLOCKER.txt'], edges: [{ to: 'DEPENDENT' }] },
        ],
      }, quiet)
    );
    assert.deepEqual(Object.keys(report.failed), [], 'both tickets should merge');
    assert.equal(report.merged.length, 2);
    assert.ok(
      report.merged.indexOf('BLOCKER') < report.merged.indexOf('DEPENDENT'),
      `predecessor must merge first regardless of array order — got ${JSON.stringify(report.merged)}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: red gate → two strikes → ticket failed, nothing merged', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'bad', AGB_SANDBOX_GATES: '0' }, () =>
      runPlan({
        repo,
        gate: { test: 'grep -q "did the work" T1.txt' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /gate test failed/);
    assert.equal(existsSync(join(repo, 'T1.txt')), false, 'no merge to main');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: prosecution block triggers fix round, then ships (A4)', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_PROSECUTOR_VERDICT: 'block-then-ship', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () =>
        runPlan({
          repo,
          gate: { test: 'true' },
          tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
        }, quiet)
    );
    assert.equal(report.merged.length, 1);
    const prosecutions = Number(readFileSync(join(state, 'prosecutions'), 'utf8'));
    assert.equal(prosecutions, 2, 'blocked once, re-prosecuted after fix');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: post-merge gate failure reverts main to the pre-run SHA (data-loss guard)', async () => {
  const repo = makeRepo();
  try {
    // Pre-seed the entries ensureGitignore would otherwise commit at run
    // start, so the pre-run SHA is exactly what the revert must restore.
    writeFileSync(join(repo, '.gitignore'),
      '.worktrees/\n.booster/\n.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n' +
      '!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n!.adlc/config.json\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'gitignore'], { cwd: repo });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    // `.git` is a FILE inside a linked worktree but a DIRECTORY on main, so
    // this gate passes in the builder worktree and fails on main once the
    // sabotage builder's SABOTAGE marker merges — genuinely exercising the
    // revert path (the previous version of this test admitted it never did).
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'sabotage', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'test ! -d .git || test ! -f SABOTAGE' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt', 'SABOTAGE'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 0, 'nothing merged');
    assert.match(report.failed.T1, /post-merge gate/);
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'HEAD restored to exactly the pre-run SHA');
    assert.equal(existsSync(join(repo, 'SABOTAGE')), false, 'sabotage payload not on main');
    assert.equal(existsSync(join(repo, 'T1.txt')), false, 'no partial merge remnants');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(status.trim(), '', 'working tree clean after revert');
    assert.throws(() => execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repo, stdio: 'ignore' }), 'no merge in progress');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: fails closed when hollow-test binary is unavailable for modified tests', async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, '.gitignore'),
      '.worktrees/\n.booster/\n.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n' +
      '!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n!.adlc/config.json\n');
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'sample.test.js'), 'console.log("ok");\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init with tests'], { cwd: repo });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    // The builder will modify test/sample.test.js under FAKE_BUILDER_MODE=mod-test.
    // Without an authenticated adlc binary available, hollow-test cannot run.
    // The integration MUST fail closed with post_merge_gate_failure.
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'mod-test', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'node test/sample.test.js' },
        tickets: [{ id: 'T1', title: 'mod test', body: 'modify test', scope: ['test/sample.test.js'] }],
      }, quiet)
    );

    assert.equal(report.merged.length, 0, 'ticket modifying tests must not merge when adlc is unavailable');
    assert.match(report.failed.T1, /hollow-test mutation verification failed: authenticated adlc binary is unavailable/);
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'HEAD restored to pre-run SHA');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: editing a rail inside the declared scope fails the ticket', async () => {
  const repo = makeRepo();
  try {
    // Seed the rail file on main so the builder's write is an edit.
    writeFileSync(join(repo, 'RAIL.txt'), 'frozen contract\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add rail'], { cwd: repo });
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_BUILDER_MODE: 'rail', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        // Rail sits INSIDE scope: the scope check alone would pass this.
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt', 'RAIL.txt'], rails: ['RAIL.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /rail violation/);
    assert.equal(readFileSync(join(repo, 'RAIL.txt'), 'utf8'), 'frozen contract\n', 'rail untouched on main');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: rail strike resets the worktree — strike 2 is judged on its own diff', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-rail-state-'));
  try {
    writeFileSync(join(repo, 'RAIL.txt'), 'frozen contract\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add rail'], { cwd: repo });
    // Strike 1 edits the rail (strike fails, worktree reset to base);
    // strike 2 does clean in-scope work. Without the reset, the cumulative
    // diff would still name RAIL.txt and strike 2 would auto-fail.
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_BUILDER_MODE: 'rail-then-good', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt', 'RAIL.txt'], rails: ['RAIL.txt'] }],
      }, quiet)
    );
    assert.deepEqual(Object.keys(report.failed), [], 'strike 2 merges clean');
    assert.deepEqual(report.merged, ['T1']);
    assert.equal(readFileSync(join(repo, 'RAIL.txt'), 'utf8'), 'frozen contract\n', 'rail untouched on main');
    assert.ok(existsSync(join(repo, 'T1.txt')), 'strike-2 work merged');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: unroutable tier/pool_hint fails the ticket — never a silent drop with exit 0', async () => {
  const repo = makeRepo();
  try {
    // cheap tier has no Claude-family candidate: route() throws. The ticket
    // must land in `failed` (and block dependents) rather than vanish from
    // the report entirely.
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
      runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], tier: 'cheap', pool_hint: 'claude', edges: [{ to: 'T2' }] },
          { id: 'T2', title: 'two', body: 'y', scope: ['T2.txt'] },
        ],
      }, quiet)
    );
    assert.match(report.failed.T1, /no candidates/);
    assert.match(report.failed.T2, /blocked by failed predecessor/);
    assert.equal(report.merged.length, 0);
    const accounted = [...report.merged, ...Object.keys(report.failed)].sort();
    assert.deepEqual(accounted, ['T1', 'T2'], 'every ticket appears in merged ∪ failed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: duplicate ids and unknown edge targets are rejected before touching the repo', async () => {
  const repo = makeRepo();
  try {
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await assert.rejects(
      withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
        runPlan({
          repo, gate: { test: 'true' },
          tickets: [
            { id: 'T1', title: 'a', body: 'x', scope: ['a.txt'] },
            { id: 'T1', title: 'b', body: 'y', scope: ['b.txt'] },
          ],
        }, quiet)),
      /duplicate ticket id: T1/
    );
    await assert.rejects(
      withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
        runPlan({
          repo, gate: { test: 'true' },
          tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a.txt'], edges: [{ to: 'T9' }] }],
        }, quiet)),
      /edge to unknown ticket 'T9'/
    );
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'repo untouched (no gitignore commit, no lock side effects)');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: refuses to run when the repo is on a non-base branch', async () => {
  const repo = makeRepo();
  try {
    execFileSync('git', ['checkout', '-qb', 'feature-x'], { cwd: repo });
    await assert.rejects(
      withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
        runPlan({ repo, base: 'main', gate: { test: 'true' }, tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['T1.txt'] }] }, quiet)),
      /is on 'feature-x', not the plan's base 'main'/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: refuses a dirty repo (data-loss guard) unless AGB_ALLOW_DIRTY=1', async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, 'README.md'), 'uncommitted edit\n'); // dirty tracked file
    await assert.rejects(
      withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
        runPlan({ repo, gate: { test: 'true' }, tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['T1.txt'] }] }, quiet)),
      /uncommitted changes — commit or stash first.*Set AGB_ALLOW_DIRTY=1 to override/
    );
    // the uncommitted edit is untouched
    assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), /uncommitted edit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: warns if dirty repo and AGB_ALLOW_DIRTY=1', async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, 'README.md'), 'uncommitted edit\n'); // dirty tracked file
    const logs = [];
    const captureLogger = { log: (msg) => logs.push(msg) };
    await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_ALLOW_DIRTY: '1' }, () =>
      runPlan({ repo, gate: { test: 'true' }, tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['T1.txt'] }] }, captureLogger)
    );
    assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('AGB_ALLOW_DIRTY=1') && l.includes('git reset --hard')), 'warning should be printed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: failed predecessor blocks dependents', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'blocked' }, () =>
      runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], edges: [{ to: 'T2' }] },
          { id: 'T2', title: 'two', body: 'y', scope: ['T2.txt'] },
        ],
      }, quiet)
    );
    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /agent blocked/);
    assert.match(report.failed.T2, /blocked by failed predecessor/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- Live rail enforcement (T-B): .adlc/-initialized target + plugin present ---

test('runPlan: AC3 — a non-ADLC-initialized target repo produces a clear, non-silent warning in the run report', async () => {
  const repo = makeRepo(); // makeRepo() never creates .adlc/
  try {
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
      runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 1, 'the build still succeeds — enforcement-unavailable degrades, it does not block the run');
    assert.equal(report.enforcementAvailable, false);
    assert.match(report.enforcementReason, /not ADLC-initialized/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: AC1 (mechanical) — an ADLC-initialized target with the plugin present sets ADLC_P4_ENFORCEMENT/ADLC_TICKET on the builder spawn and materializes the ticket store into the worktree', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.adlc'));
  const state = mkdtempSync(join(tmpdir(), 'agb-enforce-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, FAKE_BUILDER_MODE: 'echo-adlc', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 1);
    assert.equal(report.enforcementAvailable, true, report.enforcementReason);

    const envSeen = readFileSync(join(state, 'agy-env-seen'), 'utf8');
    assert.match(envSeen, /ADLC_P4_ENFORCEMENT=1 ADLC_TICKET=T1/, 'the builder spawn received the live-enforcement env, scoped to this ticket');

    const materialized = JSON.parse(readFileSync(join(state, 'adlc-tickets-seen.json'), 'utf8'));
    assert.equal(materialized.tickets.length, 1);
    assert.equal(materialized.tickets[0].id, 'T1');
    assert.deepEqual(materialized.tickets[0].rails, ['RAIL.txt'], 'the worktree\'s .adlc/tickets.json carries this ticket\'s declared rails, projected — not invented');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: a repo with a COMMITTED directory store still integrates (projection discarded before rebase)', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-committed-store-'));
  try {
    // Commit a whole-plan directory store (the canonical migrated-repo state):
    // T1 + T2 shards beside the manifest, un-ignored by the canonical stanza.
    // The worktree rail projection rewrites these TRACKED files (deleting T2's
    // shard); commitAll excludes them, so without the pre-rebase discard they
    // sit as unstaged tracked changes and `git rebase` refuses to run.
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    writeFileSync(join(repo, '.gitignore'),
      '.worktrees/\n.booster/\n.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n' +
      '!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n!.adlc/config.json\n');
    const storeDir = join(repo, '.adlc', 'tickets');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, '.store.json'), '{\n  "format": "adlc-ticket-directory",\n  "version": 1\n}\n');
    writeFileSync(join(storeDir, ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: [], edges: [] }, null, 2) + '\n');
    writeFileSync(join(storeDir, ticketFilename('T2')), JSON.stringify({ id: 'T2', title: 'two', body: 'y', scope: ['T2.txt'], rails: [], edges: [] }, null, 2) + '\n');
    g('add', '-A'); g('commit', '-qm', 'commit ticket store');

    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(Object.keys(report.failed), [], `nothing failed — ${JSON.stringify(report.failed)}`);
    assert.equal(report.merged.length, 1);
    // Main's committed store is untouched by the worktree's rail projection.
    assert.ok(existsSync(join(storeDir, ticketFilename('T2'))), 'sibling shard survives on main');
    assert.equal(g('status', '--porcelain').trim(), '', 'main tree clean after the run');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: a repo with a COMMITTED legacy tickets.json still integrates (projection discarded before rebase)', async () => {
  const repo = makeRepo();
  try {
    // Same failure mode as the committed directory store, legacy backend: the
    // worktree rail projection overwrites the TRACKED tickets.json (written in
    // kind on legacy repos); commitAll excludes it, so without the pre-rebase
    // discard it sits as an unstaged tracked change and `git rebase` refuses.
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    writeFileSync(join(repo, '.gitignore'),
      '.worktrees/\n.booster/\n.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n' +
      '!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n!.adlc/config.json\n');
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify({
      tickets: [
        { id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: [], edges: [] },
        { id: 'T2', title: 'two', body: 'y', scope: ['T2.txt'], rails: [], edges: [] },
      ],
    }, null, 2) + '\n');
    g('add', '-A'); g('commit', '-qm', 'commit legacy ticket store');

    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(Object.keys(report.failed), [], `nothing failed — ${JSON.stringify(report.failed)}`);
    assert.equal(report.merged.length, 1);
    const committed = JSON.parse(readFileSync(join(repo, '.adlc', 'tickets.json'), 'utf8'));
    assert.equal(committed.tickets.length, 2, 'committed legacy store untouched on main');
    assert.equal(g('status', '--porcelain').trim(), '', 'main tree clean after the run');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: the materialized ticket-store projection never enters commits or burns a strike', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.adlc'));
  const state = mkdtempSync(join(tmpdir(), 'agb-strike-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, FAKE_BUILDER_MODE: 'echo-adlc', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 1);
    assert.equal(report.enforcementAvailable, true, report.enforcementReason);
    const log = execFileSync('git', ['log', '--name-only', '--format=COMMIT %s'], { cwd: repo, encoding: 'utf8' });
    // The projection is orchestrator-authored: had it been committed, the
    // scope check would flag it out-of-scope, charge the builder a strike for
    // the orchestrator's own artifact, and resetToBase would delete it —
    // leaving the retry without live rail enforcement. One strike, no .adlc
    // paths in history.
    assert.match(log, /T1: one \(strike 1\)/, 'merged on the first strike');
    assert.doesNotMatch(log, /strike 2/, 'no strike was burned on the projection');
    assert.doesNotMatch(log, /\.adlc\//, 'projection files never enter commits');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: B11 — a foundational ticket WITH an outgoing edge materializes an edge-free single-ticket store the plugin validator accepts', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.adlc'));
  const state = mkdtempSync(join(tmpdir(), 'agb-b11-state-'));
  try {
    // T1 is foundational — it has an OUTGOING edge to T2 (T2 depends on it).
    // Its per-worktree single-ticket projection MUST NOT carry that edge: T2 is
    // absent from a single-ticket file, so a preserved edge dangles and the
    // plugin denies EVERY write for the whole build (B11). T2 is unroutable so
    // it fails at route() before its builder runs — leaving T1's projection as
    // the captured adlc-tickets-seen.json (echo-adlc writes to a shared path).
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, FAKE_BUILDER_MODE: 'echo-adlc', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'], edges: [{ to: 'T2', contract: 'shared lane' }] },
          { id: 'T2', title: 'two', body: 'y', scope: ['T2.txt'], tier: 'cheap', pool_hint: 'claude' },
        ],
      }, quiet)
    );
    assert.ok(report.merged.includes('T1'), `T1 should build and merge — ${report.enforcementReason ?? ''} ${JSON.stringify(report.failed)}`);
    assert.equal(report.enforcementAvailable, true, report.enforcementReason);

    const materialized = JSON.parse(readFileSync(join(state, 'adlc-tickets-seen.json'), 'utf8'));
    // The single-ticket projection carries exactly the active ticket and its
    // declared rails (rail resolution still works)...
    assert.equal(materialized.tickets.length, 1);
    assert.equal(materialized.tickets[0].id, 'T1');
    assert.deepEqual(materialized.tickets[0].rails, ['RAIL.txt'], 'rails still projected — rail resolution intact');
    // ...but NO edges, so nothing dangles.
    assert.deepEqual(materialized.tickets[0].edges ?? [], [], 'single-ticket projection strips outgoing edges');
    // The plugin's own validation rules accept it — railPreconditions would NOT
    // fail closed, so live enforcement gates rails instead of denying everything.
    assert.deepEqual(pluginValidationErrors(materialized), [], 'plugin validator accepts the edge-free single-ticket projection');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: AC1 (mechanical) — enforcement stays unavailable when .adlc/ exists but the plugin manifest is absent (not installed)', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.adlc'));
  try {
    // No installed plugin manifest at AGB_PLUGIN_DIR → B12 treats it as an
    // absent/older plugin and degrades (warn), rather than aborting.
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_ABSENT, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 1, 'the build still succeeds — degrades, does not block');
    assert.equal(report.enforcementAvailable, false);
    assert.match(report.enforcementReason, /manifest unreadable|not installed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: AC2 — the post-hoc rail check invokes adlc rails-guard with the correct base ref and rail globs', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-railsguard-state-'));
  try {
    writeFileSync(join(repo, 'RAIL.txt'), 'frozen contract\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add rail'], { cwd: repo });
    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'] }],
      }, quiet)
    );
    const invocations = readFileSync(join(state, 'rails-guard-invocations'), 'utf8');
    assert.match(invocations, /base=main/, 'invoked with the plan\'s base ref');
    assert.match(invocations, /RAIL\.txt/, 'invoked with the ticket\'s declared rail glob');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: passes the run project flag to builders and prosecutors', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-sched-state-'));
  try {
    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    const argvSeen = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
    const matches = argvSeen.match(/--project/g) || [];
    assert.equal(matches.length, 2, 'should invoke agy with project flag twice (builder + prosecutor)');
    assert.match(argvSeen, /--project agb-run-[a-z0-9]+/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});


// The unit tests in security.test.mjs prove assertStillHeld() works; this proves
// the scheduler actually CALLS it. Without this test the call site is
// unguarded — deleting the line leaves the whole suite green, which is exactly
// the decorative-test failure CONTRIBUTING warns about.
test('runPlan: a stolen lock aborts the merge instead of resetting a repo we no longer own (#54)', async () => {
  const repo = makeRepo();
  let poller;
  try {
    const metaPath = join(repo, '.booster', 'run.lock.d', 'meta.json');
    // Steal the lock the instant it appears — i.e. after acquire, while the
    // build phase is still running and well before integrate() merges. This is
    // the observable end state of the #54 double-acquire: another run's meta is
    // on disk while we are still going.
    let stolen = false;
    poller = setInterval(() => {
      if (!stolen && existsSync(metaPath)) {
        writeFileSync(metaPath, JSON.stringify({
          pid: 4242, runId: 'OTHER-RUN', token: 'stolen-by-another-run', startedAt: 'x',
        }));
        stolen = true;
      }
    }, 1);

    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
      runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
      }, quiet)
    );

    assert.ok(stolen, 'precondition: the lock must have been stolen during the run');
    assert.deepEqual(report.merged, [], 'nothing may merge once the lock is lost');
    assert.match(
      String(report.failed.T1 ?? ''),
      /no longer hold the lock/,
      `T1 should fail with a lock-ownership abort — got: ${report.failed.T1}`
    );
    // The point of aborting: main must be untouched by a run that lost the lock.
    assert.ok(!existsSync(join(repo, 'T1.txt')), 'a run that lost the lock must not land work on main');
  } finally {
    clearInterval(poller);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: reroutes to viable alternate model when primary pool capacity is zero', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-reroute-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'echo-adlc', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], tier: 'frontier' }],
        caps: { 'gemini-pro': 0, claude: 4 },
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: preserves generated ticket charter when base repo tracks AGENTS.md', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-charter-state-'));
  try {
    // Base repo tracks a root AGENTS.md
    writeFileSync(join(repo, 'AGENTS.md'), '# Base Repository Root Charter\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'track base AGENTS.md'], { cwd: repo });

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        FAKE_BUILDER_MODE: 'echo-charter',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{
          id: 'T1',
          title: 'charter test',
          body: 'ensure charter is preserved',
          scope: ['T1.txt'],
          tier: 'mid',
        }],
      }, quiet)
    );

    assert.deepEqual(report.merged, ['T1']);
    const seenCharter = readFileSync(join(state, 'seen-agents.md'), 'utf8');
    assert.match(seenCharter, /# Ticket T1: charter test/);
    assert.match(seenCharter, /ensure charter is preserved/);
    assert.ok(!seenCharter.includes('# Base Repository Root Charter'), 'builder must not see clobbered base AGENTS.md');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: releases rerouted pool reservation when lease acquisition fails', async () => {
  const repo = makeRepo();
  const v2Dir = mkdtempSync(join(tmpdir(), 'agb-sched-v2-'));
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;
  try {
    process.env.AGB_POOLS_V2 = join(v2Dir, 'v2.json');
    process.env.AGB_POOLS_LOCK = join(v2Dir, 'v2.lock');
    // Pre-seed v2 state in DRAINING status so acquisition fails
    writeFileSync(process.env.AGB_POOLS_V2, JSON.stringify({
      generation: 1,
      status: 'DRAINING',
      pools: {
        gemini: { baseCap: 12, scaledCap: 12, inFlight: 0, reserved: 0 },
        claude_gpt: { baseCap: 4, scaledCap: 4, inFlight: 0, reserved: 0 },
      },
      leases: {},
    }));

    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], tier: 'frontier' }],
      }, quiet)
    );

    assert.ok(report.failed.T1);
    assert.match(String(report.failed.T1), /DRAINING/);
    for (const [pool, resCount] of Object.entries(report.pools?.reserved ?? {})) {
      assert.equal(resCount, 0, `pool ${pool} must not leak reservations`);
    }
  } finally {
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(repo, { recursive: true, force: true });
    rmSync(v2Dir, { recursive: true, force: true });
  }
});

test('runPlan: fails closed when candidate deletes package.json while baseline requires it', async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'node -e "process.exit(0)"' } }));
    execFileSync('git', ['add', 'package.json'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add package.json'], { cwd: repo });

    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'delete-pkg', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'npm test' },
        tickets: [{ id: 'T1', title: 'delete manifest', body: 'remove package.json', scope: ['package.json'], tier: 'cheap' }],
      }, quiet)
    );

    assert.ok(report.failed.T1);
    assert.match(String(report.failed.T1), /gate script tampering: candidate deleted package\.json/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: cleans up per-attempt Git databases on ticket completion', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], tier: 'cheap' }],
      }, quiet)
    );

    assert.equal(report.merged.length, 1);
    const attemptGitDir = join(repo, '.worktrees', '.attempt_git', 'agb-t1');
    assert.equal(existsSync(attemptGitDir), false, 'per-attempt git directory must be cleaned up on merge');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reapIntegrationWorktrees: removes orphaned per-attempt Git databases', () => {
  const repo = makeRepo();
  try {
    const orphanedAttemptDir = join(repo, '.worktrees', '.attempt_git', 'agb-dangling');
    mkdirSync(orphanedAttemptDir, { recursive: true });
    assert.ok(existsSync(orphanedAttemptDir));

    reapIntegrationWorktrees(repo);

    assert.equal(existsSync(orphanedAttemptDir), false, 'orphaned attempt_git directory must be reaped');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});



