import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewCalibration } from '../lib/review.mjs';

const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

const FAKE_ENV_KEYS = ['AGB_ADLC_BIN', 'FAKE_STATE_DIR', 'FAKE_REVIEW_CALIBRATION_MODE'];

function withFakes(env, fn) {
  process.env.AGB_ADLC_BIN = FAKE_ADLC;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of FAKE_ENV_KEYS) delete process.env[k]; });
}

// execFileP's cwd option requires a real, existing directory — use a
// throwaway temp dir as the "repo" for every case here.
function makeRepoDir() {
  return mkdtempSync(join(tmpdir(), 'agb-rc-repo-'));
}

// --- AC1: invokes adlc review-calibration with the review command template
// and surfaces the recall score ---

test('reviewCalibration: AC1 — invokes adlc with the review-cmd template and surfaces recall', async () => {
  const repo = makeRepoDir();
  const state = mkdtempSync(join(tmpdir(), 'agb-rc-state-'));
  try {
    await withFakes({ FAKE_STATE_DIR: state }, async () => {
      const result = await reviewCalibration({
        repo, reviewCmd: `agb review ${repo} {base}`, plants: 8, minRecall: 0.5,
      });
      assert.equal(result.ok, true);
      assert.equal(result.recall, 0.75);
    });
    const invocations = readInvocations(state);
    assert.match(invocations, /review-cmd=agb review .* \{base\}/);
    assert.match(invocations, /plants=8/);
    assert.match(invocations, /min-recall=0\.5/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('reviewCalibration: a below-threshold recall is still surfaced (gate-fail exit code is not an operational error)', async () => {
  const repo = makeRepoDir();
  try {
    await withFakes({ FAKE_REVIEW_CALIBRATION_MODE: 'below-threshold' }, async () => {
      const result = await reviewCalibration({ repo, reviewCmd: `agb review ${repo} {base}` });
      assert.equal(result.ok, true);
      assert.equal(result.recall, 0.2);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reviewCalibration: an operational failure (dirty tree) degrades to ok:false, not a throw', async () => {
  const repo = makeRepoDir();
  try {
    await withFakes({ FAKE_REVIEW_CALIBRATION_MODE: 'fail' }, async () => {
      const result = await reviewCalibration({ repo, reviewCmd: `agb review ${repo} {base}` });
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reviewCalibration: no reviewCmd short-circuits without invoking adlc at all', async () => {
  const repo = makeRepoDir();
  try {
    const result = await reviewCalibration({ repo });
    assert.equal(result.ok, false);
    assert.match(result.error, /no review command configured/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function readInvocations(state) {
  return readFileSync(join(state, 'review-calibration-invocations'), 'utf8');
}
