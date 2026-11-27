import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';

import {
  runPlan,
  safeWriteWorktreeFile,
  terminateProcessTree,
  snapshotRootGit,
  verifyRootGitIntegrity,
  prepareTicketContextAndTdd,
  resolveTicketGateConfig,
  BanditModelRouter,
} from '../lib/scheduler.mjs';
import { FactoryLedger } from '../lib/factory-ledger.mjs';
import { runAgy, isChildUnreaped } from '../lib/agy.mjs';
import {
  reapIntegrationWorktrees, resetToBase, cleanEmptyNodeModules, isDirty, createWorktree, removeWorktree,
  JOURNAL_PHASES, writeIntegrationJournal, readIntegrationJournal,
} from '../lib/worktrees.mjs';
import { PoolSet } from '../lib/pools.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_scheduler_test_${process.pid}.json`);

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
    // A plugin root with no vendor/adlc makes "unavailable" explicit (the
    // checkout's own vendored adlc would otherwise authenticate and run).
    const noVendor = mkdtempSync(join(tmpdir(), 'agb-no-vendor-'));
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'mod-test', AGB_SANDBOX_GATES: '0', AGB_PLUGIN_ROOT: noVendor },
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
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
          tickets: [
            { id: 'T1', title: 'a', body: 'x', scope: ['a.txt'] },
            { id: 't1', title: 'b', body: 'y', scope: ['b.txt'] },
          ],
        }, quiet)),
      /ticket id 't1' collides with 'T1'/
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

test('runPlan: invalid ticket id syntax is rejected before touching the repo', async () => {
  const repo = makeRepo();
  try {
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await assert.rejects(
      withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
        runPlan({
          repo, gate: { test: 'true' },
          tickets: [
            { id: 'foo/../../../../tmp', title: 'a', body: 'x', scope: ['a.txt'] },
          ],
        }, quiet)),
      /invalid ticket id 'foo\/\.\.\/\.\.\/\.\.\/\.\.\/tmp'/
    );
    await assert.rejects(
      withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
        runPlan({
          repo, gate: { test: 'true' },
          tickets: [
            { id: '..', title: 'a', body: 'x', scope: ['a.txt'] },
          ],
        }, quiet)),
      /invalid ticket id '\.\.'/
    );
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'repo untouched');
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
      /is on 'feature-x', not the plan's base 'main'.*agb advances main by ref update/
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
      /uncommitted changes — commit or stash first.*left untouched.*not part of the run's base.*Set AGB_ALLOW_DIRTY=1 to override/
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
    const warning = logs.find((l) => l.includes('WARNING') && l.includes('AGB_ALLOW_DIRTY=1'));
    assert.ok(warning, 'warning should be printed');
    // T-CODE-FIXES-AUDIT item 7: merges/rollbacks run in worktrees and the base
    // advances by CAS update-ref, so the main checkout is never reset.
    assert.match(warning, /left untouched/);
    assert.match(warning, /not part of the run's base/);
    assert.doesNotMatch(warning, /reset --hard|permanently discard/);
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'uncommitted edit\n', 'uncommitted edit must survive the run');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: accepts clean repository with untracked projected ticket store without AGB_ALLOW_DIRTY=1', async () => {
  const repo = makeRepo();
  try {
    // A real (valid) projected store, untracked: the dirty-tree check must ignore
    // it, and the §4.2 gate reads it cleanly (an invalid store fails closed).
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
    writeFileSync(join(repo, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'a', body: 'b', scope: [], rails: [], edges: [] }));
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
      runPlan({ repo, gate: { test: 'true' }, tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['T1.txt'] }] }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
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

test('runPlan: a repo with a COMMITTED legacy tickets.json fails closed before any mutation', async () => {
  const repo = makeRepo();
  try {
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    const legacy = JSON.stringify({ tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: [], edges: [] }] }, null, 2) + '\n';
    writeFileSync(join(repo, '.adlc', 'tickets.json'), legacy);
    g('add', '-f', '-A'); g('commit', '-qm', 'commit legacy ticket store');
    const head = g('rev-parse', 'HEAD');

    await assert.rejects(
      withEnv(
        { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, AGB_SANDBOX_GATES: '0' },
        () => runPlan({
          repo,
          gate: { test: 'true' },
          tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
        }, quiet)
      ),
      (e) => e.code === 'LEGACY_TICKET_STORE' && /adlc ticket store migrate/.test(e.message),
    );
    assert.equal(g('rev-parse', 'HEAD'), head, 'base ref not advanced');
    assert.equal(readFileSync(join(repo, '.adlc', 'tickets.json'), 'utf8'), legacy, 'legacy file untouched');
    assert.equal(g('status', '--porcelain').trim(), '', 'main tree clean');
    assert.ok(!existsSync(join(repo, '.worktrees')), 'no worktree created');
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

test('resetToBase: cleans untracked builder artifacts while preserving AGENTS.md and .adlc', () => {
  const repo = makeRepo();
  let worktreePath = null;
  try {
    worktreePath = createWorktree(repo, 'T1', 'main');
    writeFileSync(join(worktreePath, 'AGENTS.md'), '# Charter\n');
    mkdirSync(join(worktreePath, '.adlc'), { recursive: true });
    writeFileSync(join(worktreePath, '.adlc', 'tickets.json'), '{"tickets":[]}\n');

    writeFileSync(join(worktreePath, 'stale_builder_artifact.txt'), 'abandoned content\n');
    mkdirSync(join(worktreePath, 'stale_dir'), { recursive: true });
    writeFileSync(join(worktreePath, 'stale_dir', 'scratch.o'), 'binary\n');

    resetToBase(worktreePath, 'main');

    assert.ok(existsSync(join(worktreePath, 'AGENTS.md')), 'AGENTS.md must be preserved');
    assert.ok(existsSync(join(worktreePath, '.adlc', 'tickets.json')), '.adlc must be preserved');
    assert.equal(existsSync(join(worktreePath, 'stale_builder_artifact.txt')), false, 'untracked artifact must be cleaned');
    assert.equal(existsSync(join(worktreePath, 'stale_dir')), false, 'untracked directory must be cleaned');
  } finally {
    if (worktreePath) {
      try { removeWorktree(repo, worktreePath, { force: true }); } catch {}
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: reclassifies post-dispatch quota failures without consuming a strike', async () => {
  const repo = makeRepo();
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = repo;
    const pools = new PoolSet({ 'gemini-flash': 2 }, { repo });

    let refreshCount = 0;
    pools.refreshQuota = async () => {
      refreshCount++;
      if (refreshCount === 1) {
        // Startup refresh: healthy
        return { ok: true, quota: { paused: false } };
      }
      // Post-dispatch refresh: quota depleted and circuit breaker tripped
      pools.recordQuotaFailure();
      return { ok: false, error: 'simulated 429 quota exhaustion', tripped: true };
    };

    // When builder fails and quota is depleted, the ticket is paused rather than failing
    // Use AGB_QUOTA_TIMEOUT_MS to prevent hanging on resumption pause
    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'missing-result', AGB_SANDBOX_GATES: '0', AGB_QUOTA_TIMEOUT_MS: '100' },
      async () => {
        const report = await runPlan({
          repo,
          gate: { test: 'true' },
          tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], tier: 'cheap' }],
          pools,
        }, quiet);

        assert.equal(report.merged.length, 0);
        // Quota reclassification happened before strike accounting
        assert.ok(refreshCount >= 2, 'post-dispatch refreshQuota was called');
      }
    );
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: does not bypass strike accounting when unrelated pool is paused but active pool has capacity', async () => {
  const repo = makeRepo();
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = repo;
    const pools = new PoolSet({ 'gemini-flash': 2, 'claude': 0 }, { repo });

    // Simulate quota where Claude is paused, making pools.quota.paused true globally,
    // but Gemini has full capacity.
    pools.quota = {
      gemini: { scaledCap: 4, effectivePercent: 100 },
      claude_gpt: { scaledCap: 0, effectivePercent: 0 },
      paused: true,
      depletionCause: 'claude_exhausted',
      resumesAt: '2029-01-01T00:00:00Z',
    };
    pools.caps['gemini-flash'] = 2;
    pools.caps['claude'] = 0;

    pools.refreshQuota = async () => ({
      ok: true,
      quota: pools.quota,
    });

    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'flail-then-good', AGB_SANDBOX_GATES: '0' },
      async () => {
        const report = await runPlan({
          repo,
          gate: { test: 'true' },
          tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], tier: 'cheap' }],
          pools,
        }, quiet);

        // Flail detection or strike accounting must take effect; ticket must fail rather than infinite-looping on quota pause
        assert.equal(report.merged.length, 0);
        assert.ok('T1' in report.failed, 'ticket must fail via strike/flail accounting');
      }
    );
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('safeWriteWorktreeFile: unlinks symlink and does not write through to target host file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-safewrite-test-'));
  try {
    const sensitiveFile = join(dir, 'sensitive-host-file.txt');
    writeFileSync(sensitiveFile, 'PROTECTED CONTENT');

    const symlinkPath = join(dir, '.git');
    symlinkSync(sensitiveFile, symlinkPath);

    // Call safeWriteWorktreeFile to overwrite .git
    safeWriteWorktreeFile(symlinkPath, 'gitdir: /new/path\n');

    // Verify sensitive file was NOT modified
    const sensitiveContent = readFileSync(sensitiveFile, 'utf8');
    assert.equal(sensitiveContent, 'PROTECTED CONTENT', 'target of symlink must not be overwritten');

    // Verify symlink was replaced with a regular file
    const st = lstatSync(symlinkPath);
    assert.equal(st.isSymbolicLink(), false, '.git must no longer be a symlink');
    assert.equal(st.isFile(), true, '.git must be a regular file');
    assert.equal(readFileSync(symlinkPath, 'utf8'), 'gitdir: /new/path\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPlan: aborts fleet on root integrity violation, marks remaining tickets failed and terminates work', async () => {
  const repo = makeRepo();
  let poller;
  try {
    let tampered = false;
    const configPath = join(repo, '.git', 'config');
    poller = setInterval(() => {
      if (!tampered && existsSync(join(repo, '.worktrees'))) {
        writeFileSync(configPath, readFileSync(configPath, 'utf8') + '# tampered\n');
        tampered = true;
      }
    }, 1);

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_SANDBOX_GATES: '0',
      },
      () =>
        runPlan({
          repo,
          gate: { test: 'true' },
          tickets: [
            { id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], edges: [{ to: 'T2' }] },
            { id: 'T2', title: 'two', body: 'write T2.txt', scope: ['T2.txt'] },
          ],
        }, quiet)
    );

    assert.ok(tampered, 'precondition: root git config was tampered mid-run');
    assert.equal(report.merged.length, 0, 'no tickets should merge after root integrity violation');
    assert.ok(report.failed.T1, 'T1 must fail');
    assert.match(report.failed.T1, /root integrity violation: Root Git config altered/);
    assert.ok(report.failed.T2, 'T2 must fail due to fleet abort');
    assert.match(report.failed.T2, /fleet aborted: root integrity violation: Root Git config altered/);
    assert.ok(report.compromised, 'root integrity violation must mark report.compromised');
    assert.match(String(report.compromised), /root integrity violation: Root Git config altered/);
  } finally {
    clearInterval(poller);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('terminateProcessTree: kills child and all descendant processes in process group', async () => {
  // Spawn a detached leader that spawns a sleep subprocess
  const leader = spawn(
    process.execPath,
    ['-e', 'const { spawn } = require("child_process"); const sub = spawn("sleep", ["60"], { stdio: "ignore" }); sub.unref(); setTimeout(() => {}, 60000);'],
    { detached: process.platform !== 'win32', stdio: 'ignore' }
  );
  assert.ok(leader.pid);
  // Wait brief moment for leader to start
  await new Promise((r) => setTimeout(r, 100));

  terminateProcessTree(leader, 'SIGKILL');

  // Verify leader is dead
  await new Promise((r) => setTimeout(r, 150));
  let leaderAlive = false;
  try {
    process.kill(leader.pid, 0);
    leaderAlive = true;
  } catch {}
  assert.equal(leaderAlive, false, 'leader process must be terminated');
});

test('terminateProcessTree & runAgy: isChildUnreaped prevents signaling recycled PIDs after child exit or signal', async () => {
  assert.equal(isChildUnreaped(null), false);
  assert.equal(isChildUnreaped(undefined), false);
  assert.equal(isChildUnreaped({ exitCode: null, signalCode: null }), true);
  assert.equal(isChildUnreaped({ exitCode: 0, signalCode: null }), false);
  assert.equal(isChildUnreaped({ exitCode: 1, signalCode: null }), false);
  assert.equal(isChildUnreaped({ exitCode: null, signalCode: 'SIGTERM' }), false);

  // 1. terminateProcessTree must not signal a live innocent process that recycled a reaped child's PID.
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000);'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  try {
    assert.ok(victim.pid > 0);
    terminateProcessTree(null, 'SIGKILL');
    let killInvocations = 0;
    terminateProcessTree(
      { pid: victim.pid, exitCode: 0, signalCode: null, kill() { killInvocations += 1; } },
      'SIGKILL'
    );
    terminateProcessTree(
      { pid: victim.pid, exitCode: null, signalCode: 'SIGKILL', kill() { killInvocations += 1; } },
      'SIGKILL'
    );
    assert.equal(killInvocations, 0);
    process.kill(victim.pid, 0); // victim must still be alive
  } finally {
    terminateProcessTree(victim, 'SIGKILL');
  }

  // 2. runAgy killProcessTree kills a live hung child on timeout, AND skips killing once child is reaped.
  const tmpBinDir = mkdtempSync(join(tmpdir(), 'agb-reaped-agy-'));
  try {
    const hangBin = join(tmpBinDir, 'hang-agy');
    writeFileSync(hangBin, `#!/usr/bin/env node\nsetInterval(() => {}, 10000);\n`, { mode: 0o755 });
    const hangRes = await runAgy({
      prompt: 'hi',
      model: 'gemini-4-neon-high',
      cwd: tmpBinDir,
      bin: hangBin,
      role: 'prosecutor',
      sandbox: false,
      containment: false,
      maxTimeout: 40,
    });
    assert.equal(hangRes.ok, false);
    assert.equal(hangRes.kind, 'timeout');

    // Outer child exits immediately (reaped: exitCode === 0) while a detached helper keeps
    // inherited stdout open past maxTimeout so terminateTree() fires after `p` was reaped.
    const earlyExitBin = join(tmpBinDir, 'early-exit-agy');
    writeFileSync(
      earlyExitBin,
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', 'setTimeout(() => {}, 260)'], { stdio: 'inherit' }).unref();\nprocess.exit(0);\n`,
      { mode: 0o755 }
    );
    let postReapKills = 0;
    const earlyRes = await runAgy({
      prompt: 'hi',
      model: 'gemini-4-neon-high',
      cwd: tmpBinDir,
      bin: earlyExitBin,
      role: 'prosecutor',
      sandbox: false,
      containment: false,
      maxTimeout: 120,
      onSpawn(child) {
        const origKill = child.kill.bind(child);
        child.kill = (sig) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            postReapKills += 1;
          }
          return origKill(sig);
        };
      },
    });
    assert.equal(earlyRes.ok, false);
    assert.equal(earlyRes.kind, 'timeout');
    assert.equal(postReapKills, 0, 'killProcessTree must not invoke p.kill after child has been reaped');
  } finally {
    rmSync(tmpBinDir, { recursive: true, force: true });
  }
});

test('isDirty: preserves leading space on porcelain output so unstaged edits to .adlc/tickets/ shards are ignored', () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'tickets', 'T1.json'), '{}\n');
    execFileSync('git', ['add', '-f', '.adlc/tickets/T1.json'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add ticket shard'], { cwd: repo });

    // Modify the tracked shard without staging -> porcelain line starts with " M .adlc/tickets/T1.json"
    writeFileSync(join(repo, '.adlc', 'tickets', 'T1.json'), '{"id":"T1"}\n');
    assert.equal(isDirty(repo), false, 'unstaged orchestrator projection edit to a ticket shard must not make repo dirty');

    // Modify tracked README.md -> must be dirty
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    assert.equal(isDirty(repo), true, 'unstaged edit to normal tracked file must be dirty');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('cleanEmptyNodeModules & resetToBase: removes empty node_modules mountpoint directory but preserves non-empty or symlinked node_modules', () => {
  const repo = makeRepo();
  try {
    const wt = createWorktree(repo, 'T-NM', 'main');
    const nm = join(wt, 'node_modules');
    mkdirSync(nm, { recursive: true });
    assert.equal(existsSync(nm), true);

    resetToBase(wt, 'main');
    assert.equal(existsSync(nm), false, 'empty node_modules directory should be removed by resetToBase');

    // Non-empty node_modules is preserved
    mkdirSync(join(nm, 'pkg'), { recursive: true });
    cleanEmptyNodeModules(wt);
    assert.equal(existsSync(nm), true, 'non-empty node_modules must be preserved');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: discards orchestrator AGENTS.md and .adlc/tickets projections before checkRailsGuard()', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-discard-rails-state-'));
  try {
    // Commit tracked AGENTS.md and .adlc/tickets/ store in base repo
    writeFileSync(join(repo, 'AGENTS.md'), '# Repo Agents Policy\n');
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1 }) + '\n');
    initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
    writeFileSync(
      join(repo, '.adlc', 'tickets', ticketFilename('T1')),
      JSON.stringify({ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['AGENTS.md', '.adlc/tickets/**'], edges: [] }) + '\n',
    );
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'track AGENTS.md and .adlc/tickets'], { cwd: repo });

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE,
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{
          id: 'T1',
          title: 'one',
          body: 'write T1.txt',
          scope: ['T1.txt'],
          rails: ['AGENTS.md', '.adlc/tickets/**'],
        }],
      }, quiet),
    );

    assert.deepEqual(report.merged, ['T1'], `orchestrator projections must not trip rails-guard: ${JSON.stringify(report.failed)}`);
    const invocations = readFileSync(join(state, 'rails-guard-invocations'), 'utf8');
    assert.match(invocations, /AGENTS\.md/);
    assert.match(invocations, /\.adlc\/tickets\/\*\*/);
    assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# Repo Agents Policy\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: runs reconcileIntegrationJournal() BEFORE ensureGitignore() commits to base branch (#167)', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-journal-order-state-'));
  try {
    // Commit a partial .gitignore that ignores .adlc/* (so the pending journal is
    // not flagged by isDirty) while still missing .worktrees/ and .booster/ so
    // ensureGitignore(repo) WILL create a commit on main during startup.
    writeFileSync(join(repo, '.gitignore'), '.adlc/*\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'partial gitignore'], { cwd: repo });
    const preMergeSha = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repo, encoding: 'utf8' }).trim();

    // Plant a PREPARED integration journal from a simulated prior crash at preMergeSha.
    // If ensureGitignore() ran first, main would advance past preMergeSha and
    // reconcileIntegrationJournal() would throw external_ref_divergence!
    writeIntegrationJournal(repo, {
      ticketId: 'T-PRIOR',
      transactionToken: 'tok-prior-crash',
      preMergeSha,
      candidateSha: preMergeSha,
      phase: JOURNAL_PHASES.PREPARED,
      timestamp: Date.now(),
    });

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'after recovery', body: 'write T1.txt', scope: ['T1.txt'] }],
      }, quiet),
    );

    assert.deepEqual(report.merged, ['T1']);
    assert.equal(readIntegrationJournal(repo).exists, false, 'PREPARED journal must be rolled back and unlinked');
    const gitLog = execFileSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8' });
    assert.match(gitLog, /chore: gitignore agb working dirs/, 'ensureGitignore still created its commit after reconciliation');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: fails over prosecutor on transient 503 capacity error and cleans gate-dirtied tracked files before rebase', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-prosecute-503-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-503-bin-'));
  try {
    writeFileSync(join(repo, 'bundle.txt'), 'clean-baseline\n');
    execFileSync('git', ['add', 'bundle.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add tracked bundle'], { cwd: repo });

    const localFakeAgy = join(binDir, 'fake-agy');
    writeFileSync(localFakeAgy, readFileSync(FAKE_AGY), { mode: 0o755 });
    const wrapperAgy = join(binDir, 'agy');
    writeFileSync(
      wrapperAgy,
      [
        '#!/bin/sh',
        'for prev in "$@"; do',
        '  if [ "$last" = "--model" ] && [ "$prev" = "claude-sonnet-5-5-low" ]; then',
        `    printf '%s\\n' "claude-sonnet-503" >> ${JSON.stringify(join(state, 'prosecutor-503.log'))}`,
        '    printf \'%s\\n\' \'{"status":"ERROR","response":"UNAVAILABLE (code 503): No capacity available for model claude-sonnet-5-5-medium on the server"}\'',
        '    exit 0',
        '  fi',
        '  last="$prev"',
        'done',
        'exec "$(dirname "$0")/fake-agy" "$@"',
      ].join('\n'),
      { mode: 0o755 },
    );

    const report = await withEnv(
      {
        AGB_AGY_BIN: wrapperAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: {
          build: 'sh -c "echo dirtied-by-gate > bundle.txt"',
          test: 'true',
        },
        tickets: [{
          id: 'T1',
          title: 'gemini build with 503 primary prosecutor and dirtying build gate',
          body: 'write T1.txt',
          scope: ['T1.txt'],
          tier: 'cheap',
          pool_hint: 'gemini',
        }],
      }, quiet),
    );

    assert.deepEqual(report.merged, ['T1'], `expected T1 to merge via prosecutor failover and clean rebase, got: ${JSON.stringify(report.failed)}`);
    const seen503 = readFileSync(join(state, 'prosecutor-503.log'), 'utf8').trim().split('\n');
    assert.deepEqual(seen503, ['claude-sonnet-503'], 'primary prosecutor claude-sonnet-5-5-medium hit 503 once before failing over to claude-sonnet-5-5-high');
    assert.equal(readFileSync(join(repo, 'bundle.txt'), 'utf8'), 'clean-baseline\n', 'gate-dirtied tracked file must not block rebase or leak into commit');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('runPlan: multi-ticket run syncs root working tree across sequential merges when .adlc/tickets has untracked projections', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-advisory-sync-state-'));
  try {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1 }) + '\n');
    writeFileSync(join(repo, '.gitignore'), '.worktrees/\n.booster/\n.adlc/leases/\n.adlc/manifest.jsonl\n.adlc/sessions.json\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'setup adlc config with unignored .adlc/tickets'], { cwd: repo });
    initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
    writeFileSync(
      join(repo, '.adlc', 'tickets', ticketFilename('T1')),
      JSON.stringify({ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], rails: [], edges: [] }) + '\n',
    );
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const staleRebasedSha = execFileSync('git', ['commit-tree', `${headSha}^{tree}`, '-m', 'stale rebased ref'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/namespaces/attempts/t2/rebased', staleRebasedSha], { cwd: repo });

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'first', body: 'write T1.txt', scope: ['T1.txt'] },
          { id: 'T2', title: 'second', body: 'write T2.txt', scope: ['T2.txt'], edges: [{ to: undefined }].filter((e) => e.to) },
        ],
      }, { ...quiet, concurrency: 1 }),
    );

    assert.deepEqual(report.merged.sort(), ['T1', 'T2'], `second ticket must not fail with repo became dirty mid-run: ${JSON.stringify(report.failed)}`);
    assert.equal(existsSync(join(repo, 'T1.txt')), true);
    assert.equal(existsSync(join(repo, 'T2.txt')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: Pass 2 hollow-test permits newly added test + docs commit with zero mutable source files while rejecting modified existing test', async () => {
  const repoAdd = makeRepo();
  const repoMod = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-added-test-only-state-'));
  const customBuilderBin = join(state, 'builder-agy');
  try {
    writeFileSync(
      customBuilderBin,
      `#!/bin/sh
case "$*" in
  *TICKET-DONE\\ or\\ TICKET-BLOCKED*)
    mkdir -p test
    if [ -f test/existing.test.mjs ]; then
      printf 'import test from "node:test"; test("weakened", () => {});\\n' > test/existing.test.mjs
      git add test/existing.test.mjs
      git commit -qm "T1: modify existing test only"
    else
      printf 'import test from "node:test"; import assert from "node:assert/strict"; test("e2e", () => assert.equal(1, 1));\\n' > test/new-e2e.test.mjs
      printf '# updated docs\\n' > README.md
      git add test/new-e2e.test.mjs README.md
      git commit -qm "T1: add new e2e test and docs"
    fi
    echo '{"type":"step_update","step":1,"action":"good"}'
    echo '{"type":"result","status":"SUCCESS","exit_code":0}'
    exit 0 ;;
  *)
    exec "${FAKE_AGY}" "$@" ;;
esac
`,
      { mode: 0o755 },
    );

    const repAdd = await withEnv(
      {
        AGB_AGY_BIN: customBuilderBin,
        AGB_SANDBOX_GATES: '0',
        CUSTOM_TEST_MODE: 'add',
      },
      () =>
        runPlan(
          {
            repo: repoAdd,
            gate: { test: 'node --test test/new-e2e.test.mjs' },
            tickets: [
              {
                id: 'T1',
                title: 'add e2e test and docs',
                body: 'add test/new-e2e.test.mjs and README.md',
                scope: ['README.md', 'test/new-e2e.test.mjs'],
              },
            ],
          },
          quiet,
        ),
    );
    assert.deepEqual(repAdd.merged, ['T1'], `expected T1 to merge cleanly, got failed=${JSON.stringify(repAdd.failed)}`);

    mkdirSync(join(repoMod, 'test'), { recursive: true });
    writeFileSync(join(repoMod, 'test', 'existing.test.mjs'), 'import test from "node:test"; import assert from "node:assert/strict"; test("orig", () => assert.equal(1, 1));\n');
    execFileSync('git', ['add', '-A'], { cwd: repoMod });
    execFileSync('git', ['commit', '-qm', 'seed existing test'], { cwd: repoMod });

    const repMod = await withEnv(
      {
        AGB_AGY_BIN: customBuilderBin,
        AGB_SANDBOX_GATES: '0',
        CUSTOM_TEST_MODE: 'mod',
      },
      () =>
        runPlan(
          {
            repo: repoMod,
            gate: { test: 'node --test test/existing.test.mjs' },
            tickets: [
              {
                id: 'T1',
                title: 'modify existing test',
                body: 'modify test/existing.test.mjs',
                scope: ['test/existing.test.mjs'],
              },
            ],
          },
          quiet,
        ),
    );
    assert.deepEqual(repMod.merged, []);
    assert.match(repMod.failed.T1, /hollow-test mutation verification failed:.*nothing to mutate/);
  } finally {
    rmSync(repoAdd, { recursive: true, force: true });
    rmSync(repoMod, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: hydrates AGENTS.md by default, runs post-guard gate.autofix ONLY on changed files (not in runConfiguredGates or post-merge), and updates pending runway', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-w2-sched-state-'));
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'src', 'untouched.js'), 'export const untouched = "raw";\n');
    writeFileSync(join(repo, 'src', 'target.js'), 'export function calc(x) { return x + 1; }\n');
    writeFileSync(join(repo, 'T1.txt'), 'initial line\n');
    writeFileSync(join(repo, 'test', 'target.test.mjs'), 'import assert from "node:assert/strict";\nimport { calc } from "../src/target.js";\nassert.equal(typeof calc, "function");\n');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        name: 'w2-fixture',
        type: 'module',
        scripts: {
          autofix: 'node -e "const fs = require(\'node:fs\'); if (fs.existsSync(\'AGENTS.md\')) { fs.writeFileSync(\'.autofix-ran\', \'bad\'); } if (fs.existsSync(\'T1.txt\')) { const cur = fs.readFileSync(\'T1.txt\', \'utf8\'); fs.writeFileSync(\'T1.txt\', cur + \'# autofixed\\n\'); fs.writeFileSync(\'src/generated.js\', \'export const gen = 1;\\n\'); } fs.writeFileSync(\'src/untouched.js\', \'export const untouched = \\\"clobbered\\\";\\n\'); fs.writeFileSync(\'.eslintcache\', \'noise\');"',
          test: 'node --test test/target.test.mjs',
        },
      }, null, 2) + '\n'
    );
    // Simulate a local node_modules/.bin tool in root repo so materialized node_modules is exercised
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.bin', 'dummy-fmt'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['add', 'src', 'test', 'T1.txt', 'package.json', '.gitignore'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed w2 repo'], { cwd: repo });

    const statsFile = join(state, 'bandit-stats.jsonl');
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_BUILDER_MODE: 'echo-charter',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
        AGB_MODEL_STATS_FILE: statsFile,
      },
      () =>
        runPlan(
          {
            repo,
            gate: {
              autofix: 'npm run autofix',
              test: 'npm test',
            },
            tickets: [
              {
                id: 'T1',
                title: 'edit T1 and hydrate target.js',
                body: 'write T1.txt',
                scope: ['src/target.js', 'src/generated.js', 'T1.txt'],
                edges: [{ to: 'T2' }],
              },
              {
                id: 'T2',
                title: 'create T2.txt',
                body: 'write T2.txt',
                scope: ['src/target.js', 'T2.txt'],
              },
            ],
          },
          quiet
        )
    );

    assert.deepEqual(report.merged, ['T1', 'T2'], `expected both merged, got: ${JSON.stringify(report.failed)}`);

    // 1. Default-on AGENTS.md hydration included target.js exports & impacted tests
    const capturedAgents = readFileSync(join(state, 'seen-agents.md'), 'utf8');
    assert.match(capturedAgents, /## Pre-Hydrated Repository Context/);
    assert.match(capturedAgents, /src\/target\.js/);
    assert.match(capturedAgents, /test\/target\.test\.mjs/);

    // 2. Autofix formatted builder-changed T1.txt ONCE (not re-run in runConfiguredGates or post-merge!)
    //    and staged newly created in-scope src/generated.js
    const mergedT1 = readFileSync(join(repo, 'T1.txt'), 'utf8');
    const autofixCount = (mergedT1.match(/# autofixed/g) || []).length;
    assert.equal(autofixCount, 1, `expected autofix to apply exactly once on T1, got:\n${mergedT1}`);
    assert.equal(readFileSync(join(repo, 'src', 'generated.js'), 'utf8'), 'export const gen = 1;\n');

    // 3. Untouched tracked file and gitignored/out-of-scope side-effects were NOT staged or leaked
    assert.equal(readFileSync(join(repo, 'src', 'untouched.js'), 'utf8'), 'export const untouched = "raw";\n');
    assert.equal(existsSync(join(repo, '.eslintcache')), false);
    assert.equal(existsSync(join(repo, '.autofix-ran')), false);

    // 4. Final run.json runway over 0 remaining pending tickets has willExhaust === false
    const runJson = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
    assert.equal(runJson.runwayWarning, false);
    assert.deepEqual(runJson.runway.totals, { gemini: 0, claude_gpt: 0 });

    // 5. BanditModelRouter recorded outcomes in statsFile
    assert.ok(existsSync(statsFile));
    const banditLines = readFileSync(statsFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(banditLines.length, 2);

    // 6. Wave 3 Factory Economics attached to report and appended to FactoryLedger
    assert.ok(report.economics && typeof report.economics === 'object');
    assert.equal(report.economics.totalTickets, 2);
    assert.equal(report.economics.mergedCount, 2);
    assert.equal(report.economics.strike0MergedCount, 2);
    assert.equal(report.economics.strike0YieldPct, 100);
    assert.equal(report.economics.autofixAppliedCount, 1);
    assert.ok(existsSync(join(repo, '.booster', 'factory_ledger.jsonl')));
    const ledgerLines = readFileSync(join(repo, '.booster', 'factory_ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledgerLines.length, 1);
    const ledgerEntry = JSON.parse(ledgerLines[0]);
    assert.equal(ledgerEntry.runId, report.runId);
    assert.notEqual(ledgerEntry.repoName, 'workspace', 'persisted FactoryLedger entry must retain actual repoName');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan (Wave 4): executes gate.twins, learned-checks, and sealed holdout scenarios with sanitized Strike-1 symptom feedback and Strike-2 merge', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-w4-sched-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-w4-sched-bin-'));
  const holdoutDir = mkdtempSync(join(tmpdir(), 'agb-w4-holdouts-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-w4-home-'));
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, 'src', 'service.mjs'), 'export function computeDiscount(x) { return x; }\n');
    writeFileSync(
      join(repo, 'test', 'service.test.mjs'),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("gate.twins mock endpoint responds during P5 test gate", async () => {',
        '  const res = await fetch(process.env.PRICING_TWIN_URL + "/v1/rates");',
        '  assert.equal(res.status, 200);',
        '  const body = await res.json();',
        '  assert.equal(body.tier, "gold");',
        '});',
      ].join('\n') + '\n'
    );
    writeFileSync(
      join(repo, '.adlc', 'learned-checks.json'),
      JSON.stringify(
        {
          version: 1,
          checks: [
            {
              id: 'DEF-no-debug',
              glob: 'src/**',
              forbidLiteral: 'FORBIDDEN_DEBUG_TOKEN',
              description: 'Do not leave debug tokens in src/**',
            },
          ],
        },
        null,
        2
      ) + '\n'
    );
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify(
        {
          name: 'w4-dark-factory-fixture',
          type: 'module',
          scripts: {
            test: 'node --test test/service.test.mjs',
          },
        },
        null,
        2
      ) + '\n'
    );
    writeFileSync(join(repo, '.gitignore'), '.adlc/*\n');
    execFileSync('git', ['add', 'src', 'test', 'package.json', '.gitignore'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed w4 repo'], { cwd: repo });

    // Custom builder script: Strike 1 passes unit test + learned-checks, but fails sealed holdout
    // on negative input. Strike 2 receives ONLY sanitized holdout symptom (never magic literal -999)
    // and fixes negative clamping to merge cleanly!
    const strikeCounterFile = join(state, 'builder-strikes.count');
    const seenPrompt2File = join(state, 'strike2-prompt.txt');
    const customAgy = join(binDir, 'w4-agy.mjs');
    writeFileSync(
      customAgy,
      [
        `#!/usr/bin/env node`,
        `import { readFileSync, writeFileSync, existsSync } from 'node:fs';`,
        `import { spawnSync } from 'node:child_process';`,
        `const args = process.argv.slice(2);`,
        `if (process.env.AGB_WORKER_TICKET === 'T-DF-1' || process.env.AGB_WORKER_TICKET === 'T-DF-2') {`,
        `  let promptText = '';`,
        `  const pIdx = args.indexOf('--print');`,
        `  if (pIdx !== -1 && args[pIdx + 1] && !args[pIdx + 1].startsWith('-')) promptText = args[pIdx + 1];`,
        `  else { try { promptText = readFileSync(0, 'utf8'); } catch {} }`,
        `  const n = existsSync(${JSON.stringify(strikeCounterFile)}) ? Number(readFileSync(${JSON.stringify(strikeCounterFile)}, 'utf8')) + 1 : 1;`,
        `  writeFileSync(${JSON.stringify(strikeCounterFile)}, String(n));`,
        `  if (n === 1) {`,
        `    writeFileSync('src/service.mjs', '// FORBIDDEN_DEBUG_TOKEN\\nexport function computeDiscount(x) { return x * 2; }\\n');`,
        `  } else {`,
        `    writeFileSync(${JSON.stringify(seenPrompt2File)}, promptText);`,
        `    writeFileSync('src/service.mjs', 'export function computeDiscount(x) { return x < 0 ? 0 : x * 2; }\\n');`,
        `  }`,
        `  console.log(JSON.stringify({ type: 'init', conversation_id: 'conv-w4-1' }));`,
        `  console.log(JSON.stringify({ type: 'result', status: 'SUCCESS', exit_code: 0, response: 'Implemented service.mjs' }));`,
        `  process.exit(0);`,
        `}`,
        `const res = spawnSync(${JSON.stringify(FAKE_AGY)}, args, { stdio: 'inherit', env: process.env });`,
        `process.exit(res.status ?? 0);`,
      ].join('\n') + '\n',
      { mode: 0o755 }
    );

    const holdoutCode = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { join } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'test("Scenario: negative discount inputs clamp safely to zero", async () => {',
      '  const mod = await import(pathToFileURL(join(process.env.AGB_CANDIDATE_ROOT, "src/service.mjs")).href);',
      '  const secretProbe = -999888777;',
      '  assert.equal(mod.computeDiscount(secretProbe), 0);',
      '  assert.equal(mod.computeDiscount(5), 10);',
      '});',
    ].join('\n');

    const report = await withEnv(
      {
        AGB_AGY_BIN: customAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_HOME_DIR: fakeHome,
        AGB_SANDBOX_GATES: '0',
        AGB_HOLDOUT_DIR: holdoutDir,
        AGB_WARM_STRIKES: '0',
      },
      () =>
        runPlan(
          {
            repo,
            gate: {
              test: 'npm test',
              twins: [
                {
                  name: 'pricing-api',
                  envVar: 'PRICING_TWIN_URL',
                  routes: [
                    { method: 'GET', path: '/v1/rates', status: 200, body: { tier: 'gold' } },
                  ],
                },
              ],
            },
            tickets: [
              {
                id: 'T-DF-1',
                title: 'Implement discount service',
                body: 'Implement computeDiscount(x) in src/service.mjs.',
                scope: ['src/service.mjs'],
                tier: 'frontier',
                holdout_scenarios: [{ name: 'clamp-negatives', code: holdoutCode }],
                edges: [],
              },
            ],
          },
          quiet
        )
    );

    assert.deepEqual(report.merged, ['T-DF-1'], `expected T-DF-1 merged on Strike 2, got: ${JSON.stringify(report.failed)}`);
    assert.equal(Number(readFileSync(strikeCounterFile, 'utf8')), 2);
    const strike2Prompt = readFileSync(seenPrompt2File, 'utf8');
    assert.match(strike2Prompt, /learned-checks gate failed/);
    assert.match(strike2Prompt, /\[DEF-no-debug\] src\/service\.mjs:1/);

    // Now test sealed holdout Strike-1 failure -> sanitized symptom -> Strike-2 merge!
    execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: repo });
    writeFileSync(strikeCounterFile, '0');
    writeFileSync(
      customAgy,
      readFileSync(customAgy, 'utf8').replace('// FORBIDDEN_DEBUG_TOKEN\\n', ''),
      { mode: 0o755 }
    );
    const reportHoldout = await withEnv(
      {
        AGB_AGY_BIN: customAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_HOME_DIR: fakeHome,
        AGB_SANDBOX_GATES: '0',
        AGB_HOLDOUT_DIR: holdoutDir,
        AGB_WARM_STRIKES: '0',
      },
      () =>
        runPlan(
          {
            repo,
            gate: {
              test: 'npm test',
              twins: [
                {
                  name: 'pricing-api',
                  envVar: 'PRICING_TWIN_URL',
                  routes: [
                    { method: 'GET', path: '/v1/rates', status: 200, body: { tier: 'gold' } },
                  ],
                },
              ],
            },
            tickets: [
              {
                id: 'T-DF-2',
                title: 'Implement discount service v2',
                body: 'Implement computeDiscount(x) in src/service.mjs.',
                scope: ['src/service.mjs'],
                tier: 'frontier',
                holdout_scenarios: [
                  {
                    name: 'clamp-negatives-v2',
                    code: holdoutCode,
                  },
                ],
                edges: [],
              },
            ],
          },
          quiet
        )
    );
    assert.deepEqual(reportHoldout.merged, ['T-DF-2'], `expected T-DF-2 merged, got: ${JSON.stringify(reportHoldout.failed)}`);
    const holdoutStrike2Prompt = readFileSync(seenPrompt2File, 'utf8');
    assert.match(holdoutStrike2Prompt, /Scenario: negative discount inputs clamp safely to zero/);
    assert.equal(holdoutStrike2Prompt.includes('-999888777'), false, 'Strike 2 prompt must NEVER leak holdout assertion literals');
    assert.equal(holdoutStrike2Prompt.includes('.holdout.test.mjs'), false, 'Strike 2 prompt must NEVER leak holdout file paths');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(holdoutDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('snapshotRootGit and verifyRootGitIntegrity ignore untracked and modified .codegraph entries while catching real root tampering', () => {
  const repo = makeRepo();
  try {
    // 1. Clean snapshot -> .codegraph created/updated mid-run passes
    const preClean = snapshotRootGit(repo);
    mkdirSync(join(repo, '.codegraph'), { recursive: true });
    writeFileSync(join(repo, '.codegraph', '.gitignore'), '*\n!.gitignore\n');
    writeFileSync(join(repo, '.codegraph', 'codegraph.db'), 'sqlite-v1');
    assert.equal(verifyRootGitIntegrity(repo, preClean).ok, true);

    // 2. Snapshot with existing untracked .codegraph -> mutations inside .codegraph pass
    const preWithCg = snapshotRootGit(repo);
    writeFileSync(join(repo, '.codegraph', 'codegraph.db'), 'sqlite-v2');
    writeFileSync(join(repo, '.codegraph', 'extra.idx'), 'index-bytes');
    assert.equal(verifyRootGitIntegrity(repo, preWithCg).ok, true);

    // 3. Non-.codegraph untracked file still triggers root integrity failure
    writeFileSync(join(repo, 'rogue.txt'), 'tampered');
    const badRes = verifyRootGitIntegrity(repo, preWithCg);
    assert.equal(badRes.ok, false);
    assert.match(badRes.error, /Porcelain status altered in root repository/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('prepareTicketContextAndTdd and resolveTicketGateConfig forward rootRepo to root .codegraph index', () => {
  const rootRepo = mkdtempSync(join(tmpdir(), 'agb-tte6-root-'));
  const worktree = mkdtempSync(join(tmpdir(), 'agb-tte6-wt-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-tte6-bin-'));
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(rootRepo, '.codegraph'), { recursive: true });
    mkdirSync(join(worktree, 'lib'), { recursive: true });
    mkdirSync(join(worktree, 'test'), { recursive: true });
    writeFileSync(join(worktree, 'lib', 'leaf.mjs'), 'export function leafFn() { return 1; }\n');
    writeFileSync(join(worktree, 'test', 'leaf.test.mjs'), 'import { leafFn } from "../lib/leaf.mjs";\n');

    const cgLog = join(rootRepo, 'cg.log');
    writeFileSync(
      join(binDir, 'codegraph'),
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(cgLog)}, process.cwd() + '|' + process.argv.slice(2).join(' ') + '\\n');`,
        'if (process.argv[2] === "affected") console.log(JSON.stringify({ affectedTests: ["test/leaf.test.mjs"] }));',
        'else console.log("symbol: leafFn");',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}:${savedPath}`;

    const ticket = { id: 'T-CG', title: 'leaf', body: 'update leaf', scope: ['lib/leaf.mjs'] };
    const prep = prepareTicketContextAndTdd(ticket, {}, {
      repo: worktree,
      rootRepo,
      writeArtifact: false,
    });
    assert.equal(prep.contextSlice.source, 'codegraph');

    const gateCfg = resolveTicketGateConfig(
      { test: 'npm test' },
      ['lib/leaf.mjs'],
      { repo: worktree, rootRepo, phase: 'strike0' }
    );
    assert.equal(gateCfg.fast, true);
    assert.equal(gateCfg.test, 'node --test test/leaf.test.mjs');

    const logged = readFileSync(cgLog, 'utf8').trim().split('\n');
    assert.equal(logged.length, 2);
    const realRoot = realpathSync(rootRepo);
    assert.ok(logged.every((line) => line.startsWith(`${realRoot}|`)), `expected rootRepo cwd, got: ${logged.join('; ')}`);
  } finally {
    process.env.PATH = savedPath;
    rmSync(rootRepo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('runPlan (T-TE-6): hollow-test survivors short-circuit pre-lease with 0 prosecutor pool requests and emit telemetry', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-tte6-ht-state-'));
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_HOLLOW_TEST_MODE: 'survivors',
        FAKE_CONSENSUS_FIX_MODE: 'no-survivors',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () =>
        runPlan(
          {
            repo,
            gate: { test: 'true' },
            tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'], tier: 'mid', pool_hint: 'gemini' }],
          },
          quiet
        )
    );

    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /hollow-test/);
    assert.equal(report.economics.hollowShortCircuits, 2);
    assert.equal(report.economics.prosecutionTokens, 0);
    assert.equal(report.telemetry.hollowShortCircuits, 2);
    // Only the 2 builder strikes acquired a pool lease; 0 prosecutor leases were acquired!
    assert.equal(report.requests['gpt-oss'] ?? 0, 0);
    assert.equal(report.requests.claude ?? 0, 0);
    const totalReqs = Object.values(report.requests).reduce((a, b) => a + b, 0);
    assert.equal(totalReqs, 2, 'only builder requests must be counted on hollow-test short-circuit');

    const argvSeen = readFileSync(join(state, 'agy-argv-seen'), 'utf8').trim().split('\n');
    assert.equal(
      argvSeen.filter((l) => l.includes('--output-format stream-json')).length,
      2,
      'agy must spawn only for the 2 builder strikes'
    );
    assert.equal(
      argvSeen.filter((l) => l.includes('--output-format json')).length,
      0,
      'agy must NEVER spawn for prosecutor when hollow-test short-circuits pre-lease'
    );
    const htCalls = readFileSync(join(state, 'hollow-test-invocations'), 'utf8').trim().split('\n');
    assert.equal(htCalls.length, 2, 'hollow-test must run once per strike in precheck, never re-run inside prosecute()');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan (T-TE-6): System-1 fast-ship skips prosecutor lease, emits split telemetry events, and marks merge-prosecution fastShipped=true', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-tte6-s1-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-tte6-s1-bin-'));
  let srv = null;
  try {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    mkdirSync(join(repo, 'lib'), { recursive: true });
    writeFileSync(join(repo, 'lib', 'leaf.mjs'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'lib/leaf.mjs'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed leaf'], { cwd: repo });

    // Local loopback Kev System-1 endpoint
    srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const items = parsed.items ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'kev-fast-1',
            inputTokens: 40,
            answers: items.map((item) => ({
              probability: String(item.id || '').startsWith('ac') ? 0.98 : 0.02,
              confidence: 0.95,
            })),
          })
        );
      });
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({
        version: 1,
        accelerators: {
          decision: { enabled: true, provider: 'kev', baseUrl: `http://127.0.0.1:${port}/v1` },
        },
      }) + '\n'
    );
    execFileSync('git', ['add', '.adlc/config.json'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add decision config'], { cwd: repo });

    const customAgy = join(binDir, 's1-agy');
    writeFileSync(
      customAgy,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        `if (args.includes('--print') || args.includes('models') || args[0] === '--version' || args[0] === '--help' || (args[0] === '-p' && args[1] === '/quota')) {`,
        '  if (process.env.AGB_WORKER_TICKET === "T-S1") {',
        `    appendFileSync(${JSON.stringify(join(state, 's1-agy-calls'))}, args.join(' ') + '\\n');`,
        "    writeFileSync('lib/leaf.mjs', 'export const x = 2;\\n');",
        "    console.log(JSON.stringify({ type: 'init', conversation_id: 'c-s1' }));",
        "    console.log(JSON.stringify({ type: 'result', status: 'SUCCESS', exit_code: 0, telemetry: { input_tokens: 500, cached_tokens: 100, output_tokens: 50 } }));",
        '    process.exit(0);',
        '  }',
        `  const r = spawnSync(${JSON.stringify(FAKE_AGY)}, args, { stdio: 'inherit', env: process.env });`,
        '  process.exit(r.status ?? 0);',
        '}',
      ].join('\n') + '\n',
      { mode: 0o755 }
    );

    const statsFile = join(state, 'bandit.jsonl');
    const report = await withEnv(
      {
        AGB_AGY_BIN: customAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_HOLLOW_TEST_MODE: 'clean',
        FAKE_STATE_DIR: state,
        AGB_MODEL_STATS_FILE: statsFile,
        AGB_SANDBOX_GATES: '0',
      },
      () =>
        runPlan(
          {
            repo,
            gate: { test: 'true' },
            tickets: [
              {
                id: 'T-S1',
                title: 'update leaf',
                body: 'set x = 2 in lib/leaf.mjs',
                scope: ['lib/leaf.mjs'],
                tier: 'mid',
                pool_hint: 'gemini',
                extractedACs: ['x is updated to 2'],
              },
            ],
          },
          quiet
        )
    );

    assert.deepEqual(report.merged, ['T-S1']);
    assert.equal(report.economics.buildTokens, 560); // 400 + 0.1*100 + 3*50
    assert.equal(report.economics.prosecutionTokens, 0);
    assert.equal(report.economics.reviewTokens, 0);
    assert.equal(report.economics.system1Calls, 1);
    assert.equal(report.economics.hollowShortCircuits, 0);
    assert.equal(report.economics.billableTokens, 560);

    // Zero prosecutor pool lease acquired and only builder invoked agy
    assert.equal(report.requests['gpt-oss'] ?? 0, 0);
    assert.equal(report.requests.claude ?? 0, 0);
    assert.equal(readFileSync(join(state, 's1-agy-calls'), 'utf8').trim().split('\n').length, 1);
    const s1HtCalls = readFileSync(join(state, 'hollow-test-invocations'), 'utf8').trim().split('\n');
    assert.equal(s1HtCalls.length, 1, 'hollow-test runs once in precheck and is reused on System-1 fast-ship');
    const s1Bandit = new BanditModelRouter({ statsFile }).readRecords();
    assert.equal(s1Bandit.length, 1);
    assert.equal(s1Bandit[0].role, 'builder');
    assert.equal(s1Bandit[0].uncachedInputTokens, 400);
    assert.equal(s1Bandit[0].cachedTokens, 100);
    assert.equal(s1Bandit[0].outputTokens, 50);

    // merge-prosecution manifest entry recorded with fastShipped: true and mergedShas
    const gmLines = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8').trim().split('\n');
    const mergeProsLine = gmLines.find((l) => l.startsWith('gate=merge-prosecution ticket=T-S1'));
    assert.ok(mergeProsLine, `expected merge-prosecution record, got:\n${gmLines.join('\n')}`);
    const mergeData = JSON.parse(mergeProsLine.split(' data=')[1]);
    assert.equal(mergeData.verdict, 'ship');
    assert.equal(mergeData.fastShipped, true);
    assert.deepEqual(mergeData.scope, ['lib/leaf.mjs']);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.ok(mergeData.mergedShas.includes(headSha));

    // RunStatus persisted telemetry + emitted telemetry SSE event in events.jsonl
    const runJson = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
    assert.equal(runJson.telemetry.buildTokens, 560);
    assert.equal(runJson.telemetry.system1Calls, 1);
    const events = readFileSync(join(repo, '.booster', 'logs', report.runId, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const telEvents = events.filter((e) => e.type === 'telemetry');
    assert.ok(telEvents.length >= 2, 'telemetry events emitted during build and prosecution');
    assert.equal(telEvents.at(-1).telemetry.system1Calls, 1);
  } finally {
    if (srv) srv.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('runPlan (T-TE-6): risk-tiered prosecutor pre-lease routing, root .codegraph sync gating, split ledger vs builder-only BanditModelRouter', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-tte6-full-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-tte6-full-bin-'));
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(repo, '.codegraph'), { recursive: true });
    writeFileSync(join(repo, '.codegraph', '.gitignore'), '*\n!.gitignore\n');
    mkdirSync(join(repo, 'lib'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'lib', 'leaf.mjs'), 'export function leafFn() { return 1; }\n');
    writeFileSync(join(repo, 'test', 'leaf.test.mjs'), 'import { leafFn } from "../lib/leaf.mjs";\n');
    execFileSync('git', ['add', 'lib/leaf.mjs', 'test/leaf.test.mjs'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed repo with leaf'], { cwd: repo });

    const cgLog = join(state, 'codegraph-calls.log');
    writeFileSync(
      join(binDir, 'codegraph'),
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        `appendFileSync(${JSON.stringify(cgLog)}, process.cwd() + '|' + process.argv.slice(2).join(' ') + '\\n');`,
        'const cmd = process.argv[2];',
        'if (cmd === "affected") console.log(JSON.stringify({ affectedTests: ["test/leaf.test.mjs"] }));',
        'else if (cmd === "callers") console.log(JSON.stringify({ callers: [] }));',
        'else if (cmd === "callees") console.log(JSON.stringify({ callees: [] }));',
        'else if (cmd === "impact") console.log(JSON.stringify({ fanIn: 0 }));',
        'else if (cmd === "sync") { mkdirSync(join(process.cwd(), ".codegraph"), { recursive: true }); writeFileSync(join(process.cwd(), ".codegraph", "index.db"), "synced"); console.log("ok"); }',
        'else console.log("ok");',
      ].join('\n'),
      { mode: 0o755 }
    );

    const prosModelLog = join(state, 'prosecutor-models.log');
    const customAgy = join(binDir, 'tel-agy');
    writeFileSync(
      customAgy,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        'if (args.includes("--print") || args.includes("--input-format")) {',
        '  const mIdx = args.indexOf("--model");',
        '  const mSlug = mIdx >= 0 ? args[mIdx + 1] : "";',
        '  if (process.env.AGB_WORKER_TICKET) {',
        '    const tid = process.env.AGB_WORKER_TICKET;',
        "    if (tid === 'T1') writeFileSync('lib/leaf.mjs', 'export function leafFn() { return 2; }\\n');",
        "    else writeFileSync('lib/leaf.mjs', 'export function leafFn() { return 3; }\\n');",
        "    console.log(JSON.stringify({ type: 'init', conversation_id: 'conv-' + tid }));",
        "    console.log(JSON.stringify({ type: 'result', status: 'SUCCESS', exit_code: 0, telemetry: { input_tokens: 500, cached_tokens: 100, output_tokens: 50 } }));",
        '    process.exit(0);',
        '  }',
        '  if (process.env.AGB_WORKER_MODE === "readonly") {',
        '    const printIdx = args.indexOf("--print");',
        '    const promptText = printIdx >= 0 ? String(args[printIdx + 1] ?? "") : (args.includes("--input-format") ? readFileSync(0, "utf8") : "");',
        '    if (promptText.includes("You are a prosecutor")) {',
        `      appendFileSync(${JSON.stringify(prosModelLog)}, mSlug + '\\n');`,
        "      console.log(JSON.stringify({ status: 'SUCCESS', structured_output: { verdict: 'ship', findings: [] }, telemetry: { input_tokens: 1000, cached_tokens: 700, output_tokens: 150 } }));",
        '      process.exit(0);',
        '    }',
        '  }',
        '}',
        `const r = spawnSync(${JSON.stringify(FAKE_AGY)}, args, { stdio: 'inherit', env: process.env });`,
        'process.exit(r.status ?? 0);',
      ].join('\n') + '\n',
      { mode: 0o755 }
    );

    process.env.PATH = `${binDir}:${savedPath}`;
    const statsFile = join(state, 'bandit-stats.jsonl');

    // Run 1: Clean root with untracked .codegraph/ -> risk-tiered prosecutor + root sync + split economics
    const report1 = await withEnv(
      {
        AGB_AGY_BIN: customAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_HOLLOW_TEST_MODE: 'clean',
        FAKE_STATE_DIR: state,
        AGB_MODEL_STATS_FILE: statsFile,
        AGB_SANDBOX_GATES: '0',
      },
      () =>
        runPlan(
          {
            repo,
            gate: { test: 'true' },
            tickets: [
              { id: 'T1', title: 'leaf', body: 'update leafFn', scope: ['lib/leaf.mjs'], tier: 'mid', pool_hint: 'gemini' },
            ],
          },
          quiet
        )
    );

    assert.deepEqual(report1.merged, ['T1']);
    assert.equal(report1.economics.buildTokens, 560);
    assert.equal(report1.economics.prosecutionTokens, 820);
    assert.equal(report1.economics.reviewTokens, 0);
    assert.equal(report1.economics.billableTokens, 1380);
    assert.equal(report1.economics.system1Calls, 0);
    assert.equal(report1.economics.hollowShortCircuits, 0);

    const ledgerSummary1 = new FactoryLedger({ repo }).summarizeEconomics();
    assert.equal(ledgerSummary1.runs, 1);
    assert.equal(ledgerSummary1.totalBuildTokens, 560);
    assert.equal(ledgerSummary1.totalProsecutionTokens, 820);
    assert.equal(ledgerSummary1.totalReviewTokens, 0);
    assert.equal(ledgerSummary1.totalSystem1Calls, 0);
    assert.equal(ledgerSummary1.totalHollowShortCircuits, 0);

    // Risk-tiered prosecutor for gemini builder on low blastRadius + mid tier -> gpt-oss-120b-medium
    const prosModels = readFileSync(prosModelLog, 'utf8').trim().split('\n');
    assert.deepEqual(prosModels, ['claude-sonnet-5-5-low']);

    // BanditModelRouter strictly records ONLY builder tokens (never prosecutor tokens)
    const banditRecords = new BanditModelRouter({ statsFile }).readRecords();
    assert.equal(banditRecords.length, 1);
    assert.equal(banditRecords[0].role, 'builder');
    assert.equal(banditRecords[0].uncachedInputTokens, 400);
    assert.equal(banditRecords[0].cachedTokens, 100);
    assert.equal(banditRecords[0].outputTokens, 50);

    // Root CodeGraph was queried from worktree hydration AND synced after root working tree update
    const realRoot = realpathSync(repo);
    const cgCalls1 = readFileSync(cgLog, 'utf8').trim().split('\n');
    assert.ok(cgCalls1.some((l) => l.startsWith(`${realRoot}|explore`)), 'builder hydration queried root .codegraph');
    assert.ok(cgCalls1.some((l) => l.startsWith(`${realRoot}|affected`)), 'impacted tests queried root .codegraph');
    assert.ok(cgCalls1.some((l) => l.startsWith(`${realRoot}|sync `)), 'integrate() synced root .codegraph after working tree update');

    // merge-prosecution manifest entry recorded with fastShipped: false and rebased commit SHA
    const gmLines = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8').trim().split('\n');
    const mergePros = gmLines.find((l) => l.startsWith('gate=merge-prosecution ticket=T1'));
    assert.ok(mergePros, 'merge-prosecution recorded');
    const mergePayload = JSON.parse(mergePros.split(' data=')[1]);
    assert.equal(mergePayload.verdict, 'ship');
    assert.equal(mergePayload.fastShipped, false);
    const head1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.ok(mergePayload.mergedShas.includes(head1));

    // Run 2: Under AGB_ALLOW_DIRTY=1 (dirty root), integrate() must skip syncCodegraphIndex(repo)
    writeFileSync(cgLog, '');
    writeFileSync(join(repo, 'README.md'), 'dirty user edit\n');
    const report2 = await withEnv(
      {
        AGB_AGY_BIN: customAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_HOLLOW_TEST_MODE: 'clean',
        FAKE_STATE_DIR: state,
        AGB_MODEL_STATS_FILE: statsFile,
        AGB_ALLOW_DIRTY: '1',
        AGB_SANDBOX_GATES: '0',
      },
      () =>
        runPlan(
          {
            repo,
            gate: { test: 'true' },
            tickets: [
              { id: 'T2', title: 'leaf2', body: 'update leafFn again', scope: ['lib/leaf.mjs'], tier: 'mid', pool_hint: 'gemini' },
            ],
          },
          quiet
        )
    );
    assert.deepEqual(report2.merged, ['T2']);
    const cgCalls2 = readFileSync(cgLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(
      cgCalls2.some((l) => l.includes('|sync ')),
      false,
      `syncCodegraphIndex must be skipped under AGB_ALLOW_DIRTY=1, got: ${cgCalls2.join('; ')}`
    );
  } finally {
    process.env.PATH = savedPath;
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('runPlan: Gemini-only single-group /quota account falls back across same-family Gemini prosecutors and records same-family-fallback in manifest', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-gemini-only-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-gemini-only-bin-'));
  try {
    const localFakeAgy = join(binDir, 'fake-agy');
    writeFileSync(localFakeAgy, readFileSync(FAKE_AGY), { mode: 0o755 });
    const geminiOnlyAgy = join(binDir, 'agy');
    writeFileSync(
      geminiOnlyAgy,
      [
        '#!/bin/sh',
        'if [ "$1" = "-p" ] && [ "$2" = "/quota" ]; then',
        '  f5=$(date -u -d "+5 hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2029-01-01T00:00:00Z")',
        '  fw=$(date -u -d "+7 days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2029-01-01T00:00:00Z")',
        '  printf \'{"conversation_id":"","status":"SUCCESS","response":"","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"g-w","name":"Weekly","window":"weekly","remaining_fraction":0.9,"reset_time":"%s"},{"id":"g-5","name":"5h","window":"5h","remaining_fraction":0.9,"reset_time":"%s"}]}]}}}\\n\' "$fw" "$f5"',
        '  exit 0',
        'fi',
        'for prev in "$@"; do',
        '  if [ "$last" = "--model" ] && [ "$prev" = "gemini-4-neon-high" ]; then',
        '    printf \'%s\\n\' \'{"status":"ERROR","response":"429 rate limit exceeded"}\'',
        '    exit 0',
        '  fi',
        '  last="$prev"',
        'done',
        'exec "$(dirname "$0")/fake-agy" "$@"',
      ].join('\n'),
      { mode: 0o755 },
    );

    const report = await withEnv(
      {
        AGB_AGY_BIN: geminiOnlyAgy,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
        AGB_QUOTA_TIMEOUT_MS: '100',
      },
      () =>
        runPlan(
          {
            repo,
            gate: { test: 'true' },
            tickets: [
              {
                id: 'T-GEMONLY',
                title: 'Gemini-only account ticket',
                body: 'write T-GEMONLY.txt',
                scope: ['T-GEMONLY.txt'],
                tier: 'cheap',
                pool_hint: 'gemini',
              },
            ],
          },
          quiet,
        ),
    );

    assert.deepEqual(report.merged, ['T-GEMONLY']);
    const manifestCalls = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8');
    assert.match(manifestCalls, /"prosecutionMode":"same-family-fallback"/);
    assert.match(manifestCalls, /"prosecutorModel":"gemini-4-carbon-high"/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('runPlan: mid-run Claude quota depletion reroutes prosecutor acquire to same-family Gemini fallback', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-pros-reroute-state-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = state;
    const pools = new PoolSet({ claude: 1 }, { repo });
    const origAcquire = pools.acquire.bind(pools);
    let depletedOnce = false;
    pools.acquire = async (model, opts) => {
      if (!depletedOnce && String(model).startsWith('claude-')) {
        depletedOnce = true;
        pools.updateFromQuota({
          gemini: {
            fiveHourRemainingPercent: 90,
            weeklyRemainingPercent: 90,
            fiveHourResetTime: '2029-01-01T00:00:00Z',
            weeklyResetTime: '2029-01-01T00:00:00Z',
          },
          claude_gpt: {
            fiveHourRemainingPercent: 0,
            weeklyRemainingPercent: 0,
            fiveHourResetTime: '2029-01-01T00:00:00Z',
            weeklyResetTime: '2029-01-01T00:00:00Z',
            unavailable: true,
          },
        });
      }
      return origAcquire(model, opts);
    };

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
        AGB_QUOTA_TIMEOUT_MS: '100',
      },
      () =>
        runPlan(
          {
            repo,
            pools,
            gate: { test: 'true' },
            tickets: [
              { id: 'T-WAITER', title: 'waiter', body: 'write T-WAITER.txt', scope: ['T-WAITER.txt'], tier: 'cheap', pool_hint: 'gemini' },
            ],
          },
          quiet,
        ),
    );

    assert.deepEqual(report.merged, ['T-WAITER']);
    assert.equal(depletedOnce, true);
    const manifestCalls = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8');
    assert.match(manifestCalls, /ticket=T-WAITER.*"prosecutorModel":"gemini-4-neon-high".*"prosecutionMode":"same-family-fallback"/);
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR;
    else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

