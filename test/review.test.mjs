import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewFleet } from '../lib/review.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

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
