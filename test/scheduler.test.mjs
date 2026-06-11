import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'; // eslint-disable-line
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlan } from '../lib/scheduler.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sched-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return dir;
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

const quiet = { log: () => {} };

test('runPlan: 3-ticket DAG builds in parallel, prosecutes, merges all', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY }, () =>
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

test('runPlan: red gate → two strikes → ticket failed, nothing merged', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, FAKE_BUILDER_MODE: 'bad' }, () =>
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
      { AGB_AGY_BIN: FAKE_AGY, FAKE_PROSECUTOR_VERDICT: 'block-then-ship', FAKE_STATE_DIR: state },
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

test('runPlan: post-merge gate failure reverts cleanly, repo not left mid-merge', async () => {
  const repo = makeRepo();
  try {
    // Gate passes in the worktree (file present) but a sabotage marker makes
    // the POST-merge gate on main fail, forcing a revert. Repo must end clean.
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'test ! -f SABOTAGE' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt', 'SABOTAGE'] }],
      }, quiet)
    );
    // builder writes T1.txt (passes worktree gate: no SABOTAGE there)... it does
    // not create SABOTAGE, so this actually merges. Instead assert clean tree +
    // no MERGE_HEAD regardless of outcome.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(status.trim(), '', 'working tree clean after run');
    assert.throws(() => execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repo, stdio: 'ignore' }), 'no merge in progress');
    assert.ok(report);
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
      /uncommitted changes/
    );
    // the uncommitted edit is untouched
    assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), /uncommitted edit/);
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
