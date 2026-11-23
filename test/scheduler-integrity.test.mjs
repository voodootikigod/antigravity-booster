// T-PLUGIN-02 / Appendix A.6 item 14: post-run integrity verification. A
// worker that plants a git hook or edits a staged plugin marks the run
// compromised and blocks merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runPlan,
  snapshotRootGit,
  verifyRootGitIntegrity,
  setupAttemptGitDatabase,
  hostMediatedFetch,
} from '../lib/scheduler.mjs';
import { createWorktree, ensureGitignore } from '../lib/worktrees.mjs';
import { sanitizedGitEnv, snapshotRunIntegrity, diffRunIntegrity, verifyRunIntegrity, ABSENT } from '../lib/run-integrity.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_integrity_test_${process.pid}.json`);

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const quiet = { log: () => {} };

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-integrity-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'agb-integrity-home-'));
  for (const name of ['antigravity-booster', 'adlc-antigravity']) {
    const dir = join(home, '.gemini', 'config', 'plugins', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  return home;
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

async function runWith(mode) {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-integrity-state-'));
  try {
    const report = await withEnv({
      HOME: home, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_BUILDER_MODE: mode, FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo, gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));
    return report;
  } finally {
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
}

test('a clean worker passes the integrity check and merges', async () => {
  const report = await runWith('good');
  assert.deepEqual(report.merged, ['T1']);
  assert.equal(report.compromised ?? null, null);
});


test('a worker that re-enables hooks in its own worktree compromises the run', async () => {
  const report = await runWith('tamper-worktree-hooks');
  assert.equal(report.merged.length, 0);
  assert.match(report.failed.T1, /run compromised: .*worktree core\.hooksPath changed/);
  assert.match(report.compromised, /worktree core\.hooksPath changed/);
});

// Host-side tampers (a planted host hook, an edited staged plugin) cannot be
// reached by a fake worker: builder containment already blocks those writes.
// The check exists for weaker sandboxes and escapes, so its detection is
// proven directly against the host; the wiring above proves a detection
// compromises the run.
function hostFixture() {
  const repo = makeRepo();
  const home = makeHome();
  const base = snapshotRunIntegrity({ cwd: repo, home });
  assert.equal(base.ok, true, base.error);
  return { repo, home, base: base.snapshot, done: () => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

test('verifyRunIntegrity: an untouched host verifies ok', () => {
  const f = hostFixture();
  try {
    assert.deepEqual(verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home }), { ok: true });
  } finally { f.done(); }
});

test('verifyRunIntegrity: a planted host git hook is detected', () => {
  const f = hostFixture();
  try {
    writeFileSync(join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(), /git hooks dir .* changed/);
  } finally { f.done(); }
});

test('verifyRunIntegrity: a host core.hooksPath redirect is detected', () => {
  const f = hostFixture();
  try {
    git(f.repo, 'config', 'core.hooksPath', join(f.repo, 'evil-hooks'));
    const r = verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home });
    assert.match(r.reasons.join(), /git hooks dir redirected/);
  } finally { f.done(); }
});

for (const name of ['antigravity-booster', 'adlc-antigravity']) {
  test(`verifyRunIntegrity: an edit to staged plugin ${name} is detected`, () => {
    const f = hostFixture();
    try {
      writeFileSync(join(f.home, '.gemini', 'config', 'plugins', name, 'planted.txt'), 'pwned');
      const r = verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home });
      assert.deepEqual(r.reasons, [`staged plugin ${name} changed`]);
    } finally { f.done(); }
  });
}

test('verifyRunIntegrity: a staged plugin that appears mid-run is detected', () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), 'agb-integrity-empty-home-'));
  try {
    const base = snapshotRunIntegrity({ cwd: repo, home }).snapshot;
    assert.equal(base.plugins['adlc-antigravity'], ABSENT);
    assert.equal(base.plugins['adlc-gemini'], ABSENT);
    mkdirSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity', 'plugin.json'), '{}');
    assert.deepEqual(verifyRunIntegrity(base, { cwd: repo, home }).reasons, ['staged plugin adlc-antigravity changed']);

    rmSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity'), { recursive: true, force: true });
    mkdirSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini', 'plugin.json'), '{}');
    assert.deepEqual(verifyRunIntegrity(base, { cwd: repo, home }).reasons, ['staged plugin adlc-gemini changed']);

    // sanitizedGitEnv strips uppercase and Windows mixed/lowercase git_* keys while preserving unrelated keys
    assert.deepEqual(
      sanitizedGitEnv({
        PATH: '/usr/bin',
        GIT_DIR: '/x',
        git_index_file: 'C:\\spoof',
        Git_Config_Count: '1',
        GITHUB_STEP_SUMMARY: '/keep',
      }),
      { PATH: '/usr/bin', GITHUB_STEP_SUMMARY: '/keep' },
    );
    // and ambient GIT_* variables (GIT_DIR, GIT_CONFIG_COUNT/KEY/VALUE/PARAMETERS) cannot redirect hooksDirFor or configuredHooksPath
    const otherGitRepo = makeRepo();
    const savedGitEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    try {
      process.env.GIT_DIR = join(otherGitRepo, '.git');
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
      process.env.GIT_CONFIG_VALUE_0 = '/tmp/evil-hooks';
      const viaEnvBase = snapshotRunIntegrity({ cwd: repo, env: { AGB_HOME_DIR: home } }).snapshot;
      assert.notEqual(viaEnvBase.plugins['adlc-gemini'], ABSENT);
      assert.equal(viaEnvBase.hooks.path, join(repo, '.git', 'hooks'));
      writeFileSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini', 'tamper.txt'), 'x');
      assert.deepEqual(
        verifyRunIntegrity(viaEnvBase, { cwd: repo, env: { AGB_HOME_DIR: home } }).reasons,
        ['staged plugin adlc-gemini changed'],
      );
    } finally {
      for (const [k, v] of Object.entries(savedGitEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(otherGitRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyRunIntegrity: worktree hooksPath must still equal the expected null path', () => {
  const f = hostFixture();
  const wt = makeRepo();
  try {
    git(wt, 'config', 'core.hooksPath', '/dev/null');
    assert.deepEqual(verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home, worktree: wt, worktreeHooksPath: '/dev/null' }), { ok: true });
    git(wt, 'config', '--unset', 'core.hooksPath');
    assert.match(verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home, worktree: wt, worktreeHooksPath: '/dev/null' }).reasons.join(), /found unset/);
  } finally { f.done(); rmSync(wt, { recursive: true, force: true }); }
});

test('diffRunIntegrity: a core.hooksPath redirect is reported even when the new dir is empty', () => {
  const before = { plugins: { a: 'x' }, hooks: { path: '/r/.git/hooks', digest: ABSENT } };
  const after = { plugins: { a: 'x' }, hooks: { path: '/elsewhere', digest: ABSENT } };
  assert.deepEqual(diffRunIntegrity(before, after), ['git hooks dir redirected (/r/.git/hooks -> /elsewhere)']);
  assert.deepEqual(diffRunIntegrity(before, before), []);
});

test('verifyRunIntegrity: an unverifiable state (not a git dir) is compromised, never silently ok', () => {
  const home = makeHome();
  const notGit = mkdtempSync(join(tmpdir(), 'agb-not-git-'));
  try {
    const repo = makeRepo();
    const base = snapshotRunIntegrity({ cwd: repo, home });
    assert.equal(base.ok, true, base.error);
    const r = verifyRunIntegrity(base.snapshot, { cwd: notGit, home });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /integrity snapshot failed/);
    rmSync(repo, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(notGit, { recursive: true, force: true });
  }
});

test('a tamper after the builder check but before merge (here: a gate script) still blocks merge', async () => {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-integrity-state-'));
  try {
    const hook = join(repo, '.git', 'hooks', 'post-merge');
    const report = await withEnv({
      HOME: home, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo, gate: { test: `printf '#!/bin/sh\\n' > '${hook}'` },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));
    assert.equal(report.merged.length, 0, 'the merge-time re-check caught the late tamper');
    assert.match(report.failed.T1, /run compromised: .*git hooks dir/);
  } finally {
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
});

test('a tamper that no per-ticket check observes is still reported as compromised', async () => {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-integrity-state-'));
  try {
    const plugin = join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity', 'late.txt');
    // The gate always fails (no merge, so integrate never re-checks) and edits a
    // staged plugin only on its final run, after every per-attempt check.
    const counter = join(state, 'gate-runs');
    const report = await withEnv({
      HOME: home, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo, gate: { test: `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; [ "$n" -ge 2 ] && echo x > '${plugin}'; exit 1` },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));
    assert.equal(report.merged.length, 0);
    assert.match(report.compromised, /staged plugin adlc-antigravity changed/);
    assert.doesNotMatch(report.failed.T1, /run compromised/, 'only the final check could have seen it');
  } finally {
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
});

test('verifyRootGitIntegrity: accepts quarantine refs for hyphenated ticket IDs and rejects unknown or unrelated ones', () => {
  const repo = makeRepo();
  try {
    const wt = createWorktree(repo, 'T-V14-1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');
    const baseSha = git(repo, 'rev-parse', 'HEAD').trim();

    // Plant a pre-existing quarantine ref for an unrelated hyphenated ticket T-V14-2
    git(repo, 'update-ref', 'refs/quarantine/agb-t-v14-2-failed-conflict', baseSha);
    const pre = snapshotRootGit(repo);

    writeFileSync(join(wt, 'T-V14-1.txt'), 'candidate\n');
    git(wt, 'add', 'T-V14-1.txt');
    git(wt, 'commit', '-qm', 'candidate');
    const slug = 'attempts/T-V14-1/1/tok12345';
    const candidateSha = hostMediatedFetch(repo, wt, slug);
    const opts = {
      ticketId: 'T-V14-1',
      attemptNamespace: slug,
      activeAttemptNamespaces: new Set([slug]),
      candidateSha,
      knownTickets: [{ id: 'T-V14-1' }, { id: 'T-V14-2' }],
    };

    // 1. Newly created quarantine refs for known hyphenated ticket IDs pass across all suffixes
    for (const suffix of ['failed-conflict', 'failed-merge', 'failed-post-merge', 'failed-integration', 'failed-crash', 'unsupported-phase']) {
      const ref = `refs/quarantine/agb-t-v14-1-${suffix}`;
      git(repo, 'update-ref', ref, candidateSha);
      const res = verifyRootGitIntegrity(repo, pre, opts);
      assert.equal(res.ok, true, `${ref} must be accepted for hyphenated ticket T-V14-1: ${res.error}`);
      git(repo, 'update-ref', '-d', ref);
    }

    // 2. Quarantine ref for an UNKNOWN hyphenated ticket ID fails (does not truncate to 't')
    const unknownRef = 'refs/quarantine/agb-t-v14-99-failed-conflict';
    git(repo, 'update-ref', unknownRef, candidateSha);
    const unknownRes = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(unknownRes.ok, false);
    assert.match(unknownRes.error, /Unauthorized scheduler ref created for unknown ticket/);
    git(repo, 'update-ref', '-d', unknownRef);

    // 3. Mutating an unrelated hyphenated ticket's pre-existing quarantine ref fails naming the full ID
    git(repo, 'update-ref', 'refs/quarantine/agb-t-v14-2-failed-conflict', candidateSha);
    const mutateRes = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(mutateRes.ok, false);
    assert.match(mutateRes.error, /belonging to unrelated ticket 't-v14-2'/);
    git(repo, 'update-ref', 'refs/quarantine/agb-t-v14-2-failed-conflict', baseSha);

    // 4. Deleting an unmerged unrelated hyphenated ticket's quarantine ref fails naming the full ID
    git(repo, 'update-ref', '-d', 'refs/quarantine/agb-t-v14-2-failed-conflict');
    const delRes = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(delRes.ok, false);
    assert.match(delRes.error, /belonging to unmerged ticket 't-v14-2'/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyRootGitIntegrity: detects newly dirtied/untracked root paths under AGB_ALLOW_DIRTY=1 even when headMovedByMerge', () => {
  const repo = makeRepo();
  try {
    ensureGitignore(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n');
    writeFileSync(join(repo, 'clean.txt'), 'clean\n');
    git(repo, 'add', 'tracked.txt', 'clean.txt');
    git(repo, 'commit', '-qm', 'add tracked files');

    // Simulate AGB_ALLOW_DIRTY=1 pre-existing dirty root state
    writeFileSync(join(repo, 'README.md'), 'user uncommitted edit\n');
    writeFileSync(join(repo, 'user-notes.txt'), 'user untracked note\n');
    const pre = snapshotRootGit(repo);

    // Simulate a concurrent merge in an isolated worktree that adds T1.txt and updates tracked.txt
    const mergeWt = createWorktree(repo, 'T1', 'main');
    writeFileSync(join(mergeWt, 'T1.txt'), 'merged file\n');
    writeFileSync(join(mergeWt, 'tracked.txt'), 'v2\n');
    git(mergeWt, 'add', 'T1.txt', 'tracked.txt');
    git(mergeWt, 'commit', '-qm', 'concurrent merge T1');
    const mergedSha = git(mergeWt, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-ref', 'refs/heads/main', mergedSha);

    const opts = {
      ticketId: 'T2',
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
      mergedTickets: new Set(['T1']),
      mergedShas: new Set([mergedSha]),
      base: 'main',
    };

    // 1. Pre-existing dirty files + index-vs-HEAD diffs from merged commit pass
    const cleanConcurrent = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(cleanConcurrent.ok, true, `concurrent merge on dirty root must pass: ${cleanConcurrent.error}`);

    // 2. Newly untracked root file introduced during worker execution fails
    writeFileSync(join(repo, 'stray-worker.txt'), 'escaped\n');
    const untrackedFail = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(untrackedFail.ok, false);
    assert.match(untrackedFail.error, /Porcelain status altered in root repository/);
    rmSync(join(repo, 'stray-worker.txt'));

    // 3. Newly dirtied previously-clean tracked file fails
    writeFileSync(join(repo, 'clean.txt'), 'dirtied by worker\n');
    const dirtyTrackedFail = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(dirtyTrackedFail.ok, false);
    assert.match(dirtyTrackedFail.error, /Porcelain status altered in root repository/);
    writeFileSync(join(repo, 'clean.txt'), 'clean\n');

    // 4. Worker planting an untracked copy of a merged-in path (T1.txt) fails
    writeFileSync(join(repo, 'T1.txt'), 'planted in root\n');
    const plantedMergedFail = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(plantedMergedFail.ok, false);
    assert.match(plantedMergedFail.error, /Porcelain status altered in root repository/);
    rmSync(join(repo, 'T1.txt'));

    // 5. Worker modifying a merged-in tracked path in root worktree (MM tracked.txt) fails
    writeFileSync(join(repo, 'tracked.txt'), 'worker root tamper\n');
    const modifiedMergedFail = verifyRootGitIntegrity(repo, pre, opts);
    assert.equal(modifiedMergedFail.ok, false);
    assert.match(modifiedMergedFail.error, /Porcelain status altered in root repository/);
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n');

    // 6. Concurrent merge that ALSO modifies pre-existing dirty README.md (MM README.md) passes
    writeFileSync(join(mergeWt, 'README.md'), 'merged readme update\n');
    git(mergeWt, 'add', 'README.md');
    git(mergeWt, 'commit', '-qm', 'concurrent merge updating README.md');
    const mergedSha2 = git(mergeWt, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-ref', 'refs/heads/main', mergedSha2);
    const readmeMergeOk = verifyRootGitIntegrity(repo, pre, {
      ...opts,
      mergedShas: new Set([mergedSha, mergedSha2]),
    });
    assert.equal(readmeMergeOk.ok, true, `concurrent merge touching pre-existing dirty file must pass: ${readmeMergeOk.error}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: root Git integrity violation marks report.compromised truthy', async () => {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-root-compromise-state-'));
  let poller;
  try {
    let tampered = false;
    poller = setInterval(() => {
      if (!tampered && existsSync(join(repo, '.worktrees'))) {
        writeFileSync(join(repo, 'stray-root-file.txt'), 'tampered root\n');
        tampered = true;
      }
    }, 1);

    const report = await withEnv({
      HOME: home,
      AGB_AGY_BIN: FAKE_AGY,
      AGB_ADLC_BIN: FAKE_ADLC,
      AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_STATE_DIR: state,
      AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo,
      gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));

    assert.ok(tampered, 'precondition: root working tree was dirtied mid-run');
    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /root integrity violation: Porcelain status altered/);
    assert.ok(report.compromised, 'report.compromised must be truthy on root integrity violation');
    assert.match(String(report.compromised), /root integrity violation: Porcelain status altered/);
  } finally {
    clearInterval(poller);
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
});
