import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlan } from '../lib/scheduler.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_consensus_fix_test_${process.pid}.json`);

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-cf-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
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

// --- AC1: on a failed prosecution, the scheduler invokes adlc consensus-fix
// (fan-out) and applies the winning candidate ---

test('runPlan: AC1 — a converging consensus-fix candidate is applied and ships without a regeneration strike', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-cf-state-'));
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state,
        FAKE_PROSECUTOR_VERDICT: 'block-then-ship', AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
    const invocations = readFileSync(join(state, 'consensus-fix-invocations'), 'utf8');
    assert.match(invocations, /test-cmd=true/, 'invoked with the plan\'s gate test command');
    assert.match(invocations, /files=T1\.txt/, 'invoked with the strike\'s changed files');
    assert.match(invocations, /rails= require-rails=false/, 'no --rails/--require-rails when ticket declares no rails');
    // FAKE_PROSECUTOR_VERDICT=block-then-ship means the SECOND prosecution
    // pass ships — that second pass is consensus-fix's OWN inline
    // re-verification (not a regeneration strike), proving the applied fix
    // path re-prosecutes without spending fixPrompt/regenPrompt at all.
    assert.equal(readFileSync(join(repo, 'T1.txt'), 'utf8'), 'FIXED-BY-CONSENSUS\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

// --- AC2: if consensus-fix itself fails to converge, the scheduler falls
// back to the existing single-attempt path, logged, not a silent hang ---

test('runPlan: AC2 — no converging candidate falls back to the single-attempt fix path (still ships on strike 2)', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-cf-state-'));
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state,
        FAKE_CONSENSUS_FIX_MODE: 'no-survivors', FAKE_PROSECUTOR_VERDICT: 'block-then-ship', AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1'], 'the existing fixPrompt+regenerate fallback still ships on strike 2');
    // T1.txt is NOT "FIXED-BY-CONSENSUS" — no candidate was ever applied,
    // proving the fallback path ran instead, not a silent no-op.
    assert.notEqual(readFileSync(join(repo, 'T1.txt'), 'utf8'), 'FIXED-BY-CONSENSUS\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: AC2 — an all-divergent consensus-fix result also falls back, not a silent hang', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-cf-state-'));
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state,
        FAKE_CONSENSUS_FIX_MODE: 'all-divergent', FAKE_PROSECUTOR_VERDICT: 'block-then-ship', AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: consensus-fix being unavailable (adlc missing) falls back cleanly, not a hang', async () => {
  const repo = makeRepo();
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: '/nonexistent/adlc-binary',
        FAKE_PROSECUTOR_VERDICT: 'block-then-ship', FAKE_STATE_DIR: mkdtempSync(join(tmpdir(), 'agb-cf-state-')),
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: consensus-fix candidate violating rails is discarded and falls back to regeneration', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-cf-state-'));
  try {
    writeFileSync(join(repo, 'RAIL.txt'), 'frozen rail\n');
    execFileSync('git', ['add', 'RAIL.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add rail'], { cwd: repo });

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state,
        FAKE_PROSECUTOR_VERDICT: 'block-then-ship',
        FAKE_CONSENSUS_FIX_MODE: 'rail-violation',
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'] }],
      }, quiet)
    );
    assert.deepEqual(report.merged, ['T1']);
    // Rail must remain untouched after merge
    assert.equal(readFileSync(join(repo, 'RAIL.txt'), 'utf8'), 'frozen rail\n');
    // When rails are declared, consensus-fix receives the validated regression testCmd + --require-rails (never raw path globs)
    const invocations = readFileSync(join(state, 'consensus-fix-invocations'), 'utf8');
    assert.match(invocations, /rails=true require-rails=true/);
    assert.doesNotMatch(invocations, /rails=RAIL\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: consensus-fix passes gate.build as --rails + --require-rails while keeping gate.test as --test-cmd', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-cf-build-state-'));
  try {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'cf-test', version: '0.0.0', scripts: { 'lint-check': 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }, null, 2) + '\n',
    );
    execFileSync('git', ['add', 'package.json'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add package.json'], { cwd: repo });

    const r1 = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, FAKE_STATE_DIR: state,
        FAKE_PROSECUTOR_VERDICT: 'block-then-ship', AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { build: 'npm run lint-check', test: 'npm test' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );
    assert.deepEqual(r1.merged, ['T1']);
    const inv1 = readFileSync(join(state, 'consensus-fix-invocations'), 'utf8');
    assert.match(inv1, /test-cmd=npm test files=T1\.txt rails=npm run lint-check require-rails=true/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
