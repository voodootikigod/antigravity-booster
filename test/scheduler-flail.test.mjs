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
  const dir = mkdtempSync(join(tmpdir(), 'agb-flail-'));
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

// --- AC1: a fixture log with repeated errors makes the flail-detector's
// verdict fire — the scheduler does not attempt a second strike ---

test('runPlan: AC1 — a repeated-error flail pattern on strike 1 skips strike 2 entirely', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-flail-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_BUILDER_MODE: 'flail-then-good', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /flail detected/);
    assert.match(report.failed.T1, /repeated-error/);
    const builds = readFileSync(join(state, 'builds'), 'utf8').trim();
    assert.equal(builds, '1', 'only strike 1 was attempted — the scheduler did not waste a second strike on a builder stuck in the same dead end');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

// --- AC2: a false-trigger fixture (single transient failure, no flail
// pattern) does NOT skip the normal retry ---

test('runPlan: AC2 — a transient one-off failure with no flail pattern still gets its normal retry', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-flail-state-'));
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_BUILDER_MODE: 'transient-then-good', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1'], 'strike 2 ran and shipped — a clean verdict never cuts the normal retry short');
    const builds = readFileSync(join(state, 'builds'), 'utf8').trim();
    assert.equal(builds, '2');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: flail-detector being unavailable (adlc missing) does not itself block the normal retry', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-flail-state-'));
  try {
    // No AGB_ADLC_BIN set — the real 'adlc' binary would be invoked and
    // likely fail against this throwaway log path, or may not be installed
    // at all on other machines; either way checkFlailDetector fails OPEN.
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: '/nonexistent/adlc-binary', FAKE_BUILDER_MODE: 'transient-then-good', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0' },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1'], 'an unavailable flail-detector fails open — the normal two-strike retry still runs');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
