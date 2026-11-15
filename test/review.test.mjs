import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewFleet, reviewDiff } from '../lib/review.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

test('reviewDiff: rejects ref values starting with a dash to prevent git flag injection', () => {
  assert.throws(() => reviewDiff(process.cwd(), '--output=/tmp/pwn'), /Invalid git ref/);
  assert.throws(() => reviewDiff(process.cwd(), '-p'), /Invalid git ref/);
});

test('reviewFleet: passes project option to runAgy', async () => {
  const state = mkdtempSync(join(tmpdir(), 'agb-review-test-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevState = process.env.FAKE_STATE_DIR;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_STATE_DIR = state;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  try {
    await reviewFleet({
      diff: 'diff --git a/x b/x\n+code',
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      project: 'test-review-proj',
    });
    const argvSeen = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
    const matches = argvSeen.match(/--project/g) || [];
    assert.equal(matches.length, 1, 'reviewFleet should invoke agy with the project flag exactly once');
    assert.match(argvSeen, /--project test-review-proj/);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
    rmSync(state, { recursive: true, force: true });
  }
});

test('reviewFleet: captures quota admission errors per lens without crashing or throwing', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  const pools = {
    quota: { raw: {}, models: {} },
    refreshQuota: async () => ({ ok: true }),
    acquire: async (model, opts) => {
      if (model.includes('argon')) {
        throw new Error('pro quota exhausted');
      }
      return () => {};
    },
  };
  try {
    const res = await reviewFleet({
      diff: 'diff --git a/x b/x\n+code',
      lenses: ['correctness', 'performance'],
      dryRounds: 1,
      maxRounds: 1,
      pools,
    });
    assert.equal(res.converged, false);
    assert.ok(res.errors.length > 0, 'errors must capture failed lens');
    assert.ok(res.errors.some((e) => e.error.includes('pro quota exhausted')), 'must record quota error');
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
  }
});

test('reviewFleet: handles >128 KiB diffs via stdin piping without E2BIG and converges cleanly', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  try {
    const hugeDiff = 'diff --git a/big.mjs b/big.mjs\n+' + 'a'.repeat(145_000);
    const res = await reviewFleet({
      diff: hugeDiff,
      lenses: ['correctness', 'security'],
      dryRounds: 1,
      maxRounds: 2,
    });
    assert.equal(res.converged, true, JSON.stringify(res.errors));
    assert.deepEqual(res.errors, []);

    const execErrRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      context: Symbol('unstringifiable-context'),
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
    });
    assert.equal(execErrRes.converged, false);
    assert.equal(execErrRes.errors.length, 1);
    assert.match(execErrRes.errors[0].error, /^execution failed:/);

    // Cross-pool failover when default Gemini pool throws kind='quota_depleted'
    const seenModels = [];
    const depletedGeminiPools = {
      quota: { raw: {}, models: {} },
      refreshQuota: async () => ({ ok: true }),
      acquire: async (m) => {
        if (m.startsWith('gemini-')) {
          const err = new Error('gemini pool depleted');
          err.kind = 'quota_depleted';
          throw err;
        }
        seenModels.push(m);
        return () => {};
      },
    };
    const failoverRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      lenses: ['correctness', 'security'],
      dryRounds: 1,
      maxRounds: 1,
      pools: depletedGeminiPools,
    });
    assert.equal(failoverRes.converged, true);
    assert.deepEqual(seenModels.sort(), ['claude-sonnet-5-5-medium', 'gpt-oss-120b-medium']);

    // Explicit caller `models` must NOT silently swap to another model on quota_depleted
    const pinnedRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      models: ['gemini-4-argon-high'],
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: depletedGeminiPools,
    });
    assert.equal(pinnedRes.converged, false);
    assert.match(pinnedRes.errors[0].error, /quota admission failed: gemini pool depleted/);

    // When all fallback pools are ALSO depleted, reports quota admission failed
    const allDepletedPools = {
      quota: { raw: {}, models: {} },
      refreshQuota: async () => ({ ok: true }),
      acquire: async () => {
        const err = new Error('all pools depleted');
        err.kind = 'quota_depleted';
        throw err;
      },
    };
    const allDepRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: allDepletedPools,
    });
    assert.equal(allDepRes.converged, false);
    assert.match(allDepRes.errors[0].error, /quota admission failed: all pools depleted/);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
  }
});

