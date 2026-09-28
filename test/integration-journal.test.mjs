import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  JOURNAL_PHASES,
  createIntegrationWorktree,
  reapIntegrationWorktrees,
  writeIntegrationJournal,
  readIntegrationJournal,
  quarantineIntegrationJournal,
  unlinkIntegrationJournal,
  createWorktree,
  commitAll,
  ensureGitignore,
} from '../lib/worktrees.mjs';
import {
  reconcileIntegrationJournal,
  runPlan,
} from '../lib/scheduler.mjs';

const FAKE_AGY = join(import.meta.dirname, 'fixtures', 'fake-agy');
const PLUGIN_COMPATIBLE = join(import.meta.dirname, 'fixtures', 'fake-adlc-antigravity-plugin-compatible');

process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_journal_test.json');

function makeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-journal-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@test.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'initial root content\n');
  g('add', '-A');
  g('commit', '-qm', 'initial commit');
  ensureGitignore(dir);
  return dir;
}

function withEnv(vars, fn) {
  const prior = {};
  for (const k of Object.keys(vars)) {
    prior[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    });
}

const quiet = { log: () => {} };

test('Integration Journal: crash-atomic write, readback, and corruption quarantine', () => {
  const repo = makeTestRepo();
  try {
    const data = {
      ticketId: 'T1',
      transactionToken: 'token-1234',
      preMergeSha: 'abc1234',
      candidateSha: 'def5678',
      phase: JOURNAL_PHASES.PREPARED,
      timestamp: Date.now(),
    };

    // 1. Crash-atomic write protocol
    writeIntegrationJournal(repo, data);
    const read = readIntegrationJournal(repo);
    assert.equal(read.ok, true);
    assert.equal(read.exists, true);
    assert.deepEqual(read.journal, data);

    // 2. Corrupt journal quarantine
    writeFileSync(join(repo, '.adlc', 'integration_journal.json'), '{ malformed json truncated...');
    const corruptRead = readIntegrationJournal(repo);
    assert.equal(corruptRead.ok, false);
    assert.equal(corruptRead.corrupted, true);

    const quarantined = quarantineIntegrationJournal(repo, 'corrupt');
    assert.ok(quarantined && existsSync(quarantined));
    assert.match(quarantined, /integration_journal_corrupt_\d+\.json/);
    assert.equal(existsSync(join(repo, '.adlc', 'integration_journal.json')), false);

    // 3. Unlink journal
    writeIntegrationJournal(repo, data);
    assert.equal(readIntegrationJournal(repo).exists, true);
    unlinkIntegrationJournal(repo);
    assert.equal(readIntegrationJournal(repo).exists, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Integration Worktree: creation, isolation, and reaping', () => {
  const repo = makeTestRepo();
  try {
    // Seed node_modules in repo and verify provisioning
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dummy.txt'), 'dummy module\n');
    const token = crypto.randomUUID();
    const intPath = createIntegrationWorktree(repo, token, 'main');

    assert.ok(existsSync(intPath), 'integration worktree directory exists');
    assert.match(intPath, new RegExp(`agb-integration-${token.slice(0, 8)}`));
    assert.ok(existsSync(join(intPath, 'node_modules', 'dummy.txt')), 'node_modules provisioned in integration worktree');

    // Can commit inside integration worktree without mutating root
    writeFileSync(join(intPath, 'scratch.txt'), 'scratch\n');
    execFileSync('git', ['add', 'scratch.txt'], { cwd: intPath });
    execFileSync('git', ['commit', '-qm', 'integration commit'], { cwd: intPath });

    assert.equal(existsSync(join(repo, 'scratch.txt')), false, 'root repo does not have scratch.txt');

    // Reap integration worktrees
    reapIntegrationWorktrees(repo);
    assert.equal(existsSync(intPath), false, 'reap removes disposable integration worktree');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Integration Journal: startup crash recovery across all 4 phases', async () => {
  const repo = makeTestRepo();
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const baseSha = g('rev-parse', 'refs/heads/main');

  // Create candidate commit
  const wt = createWorktree(repo, 't-test', 'main');
  writeFileSync(join(wt, 'test.txt'), 'test candidate\n');
  execFileSync('git', ['add', 'test.txt'], { cwd: wt });
  execFileSync('git', ['commit', '-qm', 'candidate commit'], { cwd: wt });
  const candSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();

  try {
    // Subtest 1: PREPARED - clean rollback when base has not diverged
    writeIntegrationJournal(repo, {
      ticketId: 't-test',
      transactionToken: 'tok-1',
      preMergeSha: baseSha,
      candidateSha: candSha,
      phase: JOURNAL_PHASES.PREPARED,
      timestamp: Date.now(),
    });
    const res1 = await reconcileIntegrationJournal(repo, 'main');
    assert.equal(res1.ok, true);
    assert.equal(res1.status, 'rolled_back');
    assert.equal(res1.phase, JOURNAL_PHASES.PREPARED);
    assert.equal(readIntegrationJournal(repo).exists, false);
    assert.equal(g('rev-parse', 'refs/heads/main'), baseSha);

    // Subtest 2: PREPARED - external ref divergence halts cleanly without rolling back baseRef
    const extCommit = (() => {
      writeFileSync(join(repo, 'ext.txt'), 'ext\n');
      g('add', 'ext.txt');
      g('commit', '-qm', 'external commit');
      return g('rev-parse', 'refs/heads/main');
    })();
    assert.notEqual(extCommit, baseSha);

    writeIntegrationJournal(repo, {
      ticketId: 't-test',
      transactionToken: 'tok-2',
      preMergeSha: baseSha, // Old base before external commit
      candidateSha: candSha,
      phase: JOURNAL_PHASES.PREPARED,
      timestamp: Date.now(),
    });

    await assert.rejects(
      async () => reconcileIntegrationJournal(repo, 'main'),
      (err) => err.kind === 'external_ref_divergence'
    );
    // Base ref was protected and NOT rolled back
    assert.equal(g('rev-parse', 'refs/heads/main'), extCommit);
    // Journal was archived to conflict
    const adlcFiles = readdirSync(join(repo, '.adlc'));
    assert.ok(adlcFiles.some((f) => f.startsWith('journal_conflict_')));

    // Reset base back for remaining tests
    g('update-ref', 'refs/heads/main', baseSha);

    // Subtest 3: GATES_PASSED with provenance marker -> applies CAS advance
    const markerRef = 'refs/transactions/t-test/tok-3';
    g('update-ref', markerRef, candSha);
    writeIntegrationJournal(repo, {
      ticketId: 't-test',
      transactionToken: 'tok-3',
      preMergeSha: baseSha,
      candidateSha: candSha,
      phase: JOURNAL_PHASES.GATES_PASSED,
      timestamp: Date.now(),
    });
    const res3 = await reconcileIntegrationJournal(repo, 'main');
    assert.equal(res3.ok, true);
    assert.equal(res3.status, 'reconciled');
    assert.equal(res3.action, 'advanced_and_finalized');
    assert.equal(g('rev-parse', 'refs/heads/main'), candSha);
    assert.equal(readIntegrationJournal(repo).exists, false);

    // Subtest 4: REF_ADVANCED - marker resilience (marker already deleted before journal unlinked)
    writeIntegrationJournal(repo, {
      ticketId: 't-test',
      transactionToken: 'tok-4',
      preMergeSha: baseSha,
      candidateSha: candSha,
      phase: JOURNAL_PHASES.REF_ADVANCED,
      timestamp: Date.now(),
    });
    const res4 = await reconcileIntegrationJournal(repo, 'main');
    assert.equal(res4.ok, true);
    assert.equal(res4.status, 'reconciled');
    assert.equal(res4.action, 'finalized_from_ref_advanced');
    assert.equal(readIntegrationJournal(repo).exists, false);

    // Subtest 5: FINALIZED - clean idempotent cleanup
    writeIntegrationJournal(repo, {
      ticketId: 't-test',
      transactionToken: 'tok-5',
      preMergeSha: baseSha,
      candidateSha: candSha,
      phase: JOURNAL_PHASES.FINALIZED,
      timestamp: Date.now(),
    });
    const res5 = await reconcileIntegrationJournal(repo, 'main');
    assert.equal(res5.ok, true);
    assert.equal(res5.status, 'clean');
    assert.equal(res5.phase, JOURNAL_PHASES.FINALIZED);
    assert.equal(readIntegrationJournal(repo).exists, false);

    // Verify all transaction marker refs were cleaned up
    const lingering = g('for-each-ref', '--format=%(refname)', 'refs/transactions');
    assert.equal(lingering, '', 'no transaction marker refs should linger');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Integration Journal: Trusted Baseline Test Oracle Protocol (Pass 1 regression check)', async () => {
  const repo = makeTestRepo();
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  // Create baseline with test/math.test.mjs asserting add(1, 1) === 2
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'src', 'math.js'), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(join(repo, 'test', 'math.test.js'), `
    import assert from 'node:assert';
    import { add } from '../src/math.js';
    assert.equal(add(1, 1), 2);
  `);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'test-pkg',
    scripts: { test: 'node test/math.test.js' },
    type: 'module'
  }, null, 2));
  g('add', '-A');
  g('commit', '-qm', 'add baseline code and tests');
  const headBefore = g('rev-parse', 'HEAD');

  try {
    // Ticket modifies src/math.js to break addition (returns 42) and modifies test/math.test.js
    // to expect 42 (masking the regression in candidate tests).
    // Pass 1 must evaluate baseline test suite (expecting 2) against candidate's broken math.js,
    // catching the regression and failing post-merge gating before mask can succeed!
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0', FAKE_BUILDER_MODE: 'sabotage-math' },
      () => runPlan({
        repo,
        gate: { test: 'npm test' },
        tickets: [{
          id: 'T1',
          title: 'break math and tamper test',
          body: 'tamper math',
          scope: ['src/math.js', 'test/math.test.js'],
        }],
      }, quiet)
    );

    assert.equal(report.merged.length, 0, 'tampered ticket did not merge');
    assert.match(report.failed.T1, /Pass 1 \(baseline regression\) failed|post-merge gate.*failed/);

    // Root checkout is 100% clean and untouched
    assert.equal(g('rev-parse', 'HEAD'), headBefore);
    assert.equal(g('status', '--porcelain').trim(), '');
    assert.equal(readFileSync(join(repo, 'src', 'math.js'), 'utf8'), 'export function add(a, b) { return a + b; }\n');

    // Quarantine ref was created
    let quarantine = null;
    try { quarantine = g('rev-parse', '--verify', 'refs/quarantine/agb-t1-failed-post-merge'); } catch {}
    assert.ok(quarantine, 'candidate quarantined');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Integration Journal: rebase conflict quarantine preserves candidate without modifying root checkout', async () => {
  const repo = makeTestRepo();
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  writeFileSync(join(repo, 'shared.txt'), 'baseline line 1\n');
  g('add', 'shared.txt');
  g('commit', '-qm', 'add shared.txt');
  const headBefore = g('rev-parse', 'HEAD');

  try {
    // Run plan where T0 and T1 both touch shared.txt in parallel, causing rebase conflict for T1
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0', FAKE_BUILDER_MODE: 'conflict' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T0', title: 'zero', body: 'write T0', scope: ['shared.txt'] },
          { id: 'T1', title: 'one', body: 'write T1', scope: ['shared.txt'], edges: [{ to: 'T2' }] },
          { id: 'T2', title: 'two', body: 'write T2', scope: ['T2.txt'] },
        ],
      }, quiet)
    );

    // T0 merges, T1 fails with conflict, downstream T2 is blocked
    assert.ok(report.merged.includes('T0'), 'T0 merged');
    assert.ok(report.failed.T1, 'T1 failed');
    assert.match(report.failed.T1, /rebase conflict for T1/);
    assert.match(report.failed.T2, /blocked by failed predecessor/);

    // Quarantine ref was created for T1
    let quarantine = null;
    try { quarantine = g('rev-parse', '--verify', 'refs/quarantine/agb-t1-failed-conflict'); } catch {}
    assert.ok(quarantine, 'conflict candidate quarantined');
    assert.equal(report.merged.length, 1);

    // Root checkout is untouched at headBefore
    assert.equal(g('status', '--porcelain').trim(), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Integration Journal: anti-no-op baseline diff check rejects zero-change commits', async () => {
  const repo = makeTestRepo();
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const headBefore = g('rev-parse', 'HEAD');

  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0', FAKE_BUILDER_MODE: 'noop' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'noop ticket', body: 'do nothing', scope: ['noop.txt'] }],
      }, quiet)
    );

    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /anti-no-op gate failed/);
    assert.equal(g('rev-parse', 'HEAD'), headBefore);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Integration Journal: rejects symlinked .adlc directory during journaling and reconciliation', async () => {
  const repo = makeTestRepo();
  const evilTarget = mkdtempSync(join(tmpdir(), 'agb-evil-target-'));
  try {
    rmSync(join(repo, '.adlc'), { recursive: true, force: true });
    symlinkSync(evilTarget, join(repo, '.adlc'));

    const data = {
      ticketId: 'T1',
      transactionToken: 'token-1234',
      preMergeSha: 'abc1234',
      candidateSha: 'def5678',
      phase: JOURNAL_PHASES.PREPARED,
      timestamp: Date.now(),
    };

    assert.throws(
      () => writeIntegrationJournal(repo, data),
      /Security error: .adlc directory in .* is a symbolic link/
    );

    assert.throws(
      () => readIntegrationJournal(repo),
      /Security error: .adlc directory in .* is a symbolic link/
    );

    assert.throws(
      () => quarantineIntegrationJournal(repo),
      /Security error: .adlc directory in .* is a symbolic link/
    );

    assert.throws(
      () => unlinkIntegrationJournal(repo),
      /Security error: .adlc directory in .* is a symbolic link/
    );

    await assert.rejects(
      () => reconcileIntegrationJournal(repo, 'main'),
      /Security error: .adlc directory in .* is a symbolic link/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(evilTarget, { recursive: true, force: true });
  }
});

test('reconcileIntegrationJournal: recovers and finalizes after baseRef advanced even if finalization was interrupted', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-journal-finalization-recovery-'));
  const g = (cmd, ...args) => execFileSync('git', [cmd, ...args], { cwd: repo, encoding: 'utf8' }).trim();

  try {
    g('init', '-b', 'main');
    g('config', 'user.email', 'test@test.local');
    g('config', 'user.name', 'Tester');
    writeFileSync(join(repo, 'init.txt'), 'init\n');
    g('add', 'init.txt');
    g('commit', '-qm', 'initial commit');
    const baseSha = g('rev-parse', 'refs/heads/main');

    writeFileSync(join(repo, 'cand.txt'), 'cand\n');
    g('add', 'cand.txt');
    g('commit', '-qm', 'candidate commit');
    const candSha = g('rev-parse', 'refs/heads/main');

    // Simulate CAS advancing refs/heads/main to candSha while markerRef and journal remain at GATES_PASSED
    const markerRef = 'refs/transactions/t-recovery/tok-rec';
    g('update-ref', markerRef, candSha);
    g('update-ref', 'refs/heads/main', candSha);

    writeIntegrationJournal(repo, {
      ticketId: 't-recovery',
      transactionToken: 'tok-rec',
      preMergeSha: baseSha,
      candidateSha: candSha,
      phase: JOURNAL_PHASES.GATES_PASSED,
      timestamp: Date.now(),
    });

    // Journal and markerRef must still exist
    assert.equal(readIntegrationJournal(repo).exists, true);
    assert.equal(g('rev-parse', markerRef), candSha);

    // Reconcile must recognize base was already advanced, finalize, clean marker, and unlink journal
    const res = await reconcileIntegrationJournal(repo, 'main');
    assert.equal(res.ok, true);
    assert.equal(res.status, 'reconciled');
    assert.equal(res.action, 'finalized_gates_passed');
    assert.equal(readIntegrationJournal(repo).exists, false);

    // Marker ref must have been deleted
    const markers = g('for-each-ref', '--format=%(refname)', 'refs/transactions/t-recovery');
    assert.equal(markers, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

