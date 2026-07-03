import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlan } from '../lib/scheduler.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-gm-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
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

// --- AC1: each gate outcome in a scheduler run is recorded via
// adlc gate-manifest record, with the correct gate name and evidence ---

test('runPlan: AC1 — a clean ship records build, prosecution, and post-merge-build gates', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-gm-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
    const invocations = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8');
    assert.match(invocations, /gate=build ticket=T1 data=\{"ok":true/);
    assert.match(invocations, /gate=prosecution ticket=T1 data=\{"verdict":"ship"/);
    assert.match(invocations, /gate=post-merge-build ticket=T1 data=\{"ok":true\}/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: a failed build gate is recorded with ok:false', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-gm-state-'));
  try {
    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state, FAKE_BUILDER_MODE: 'bad', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'test -f nonexistent-should-fail' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    const invocations = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8');
    assert.match(invocations, /gate=build ticket=T1 data=\{"ok":false/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: a post-merge rollback records the rollback gate with a reason', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-gm-state-'));
  try {
    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state, FAKE_BUILDER_MODE: 'sabotage', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'test ! -d .git || test ! -f SABOTAGE' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt', 'SABOTAGE'] }],
      }, quiet)
    );
    const invocations = readFileSync(join(state, 'gate-manifest-invocations'), 'utf8');
    assert.match(invocations, /gate=post-merge-build ticket=T1 data=\{"ok":false\}/);
    assert.match(invocations, /gate=rollback ticket=T1 data=\{"reason":/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: a gate-manifest recording failure does not itself fail an otherwise-successful run', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_GATE_MANIFEST_MODE: 'fail', AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1'], 'a broken audit trail must not itself fail a build/merge that otherwise succeeded');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
