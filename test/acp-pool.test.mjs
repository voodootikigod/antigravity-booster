import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AcpReviewPool, createAcpReviewPool, isAcpPoolEnabled } from '../lib/acp-pool.mjs';

const FAKE_ACP = fileURLToPath(new URL('./fixtures/fake-agy-acp', import.meta.url));
chmodSync(FAKE_ACP, 0o755);

test('isAcpPoolEnabled respects AGB_ACP_POOL=0/false/off and defaults to enabled', () => {
  assert.equal(isAcpPoolEnabled({}), true);
  assert.equal(isAcpPoolEnabled({ AGB_ACP_POOL: '1' }), true);
  assert.equal(isAcpPoolEnabled({ AGB_ACP_POOL: '0' }), false);
  assert.equal(isAcpPoolEnabled({ AGB_ACP_POOL: 'false' }), false);
  assert.equal(isAcpPoolEnabled({ AGB_ACP_POOL: 'OFF' }), false);
});

test('AcpReviewPool reuses warm workers, switches model/effort, bounds concurrency, respawns crashes, handles timeouts, and degrades when disabled', async () => {
  // 1. Default pool config & disabled pool degrade cleanly without spawning
  const defaultPool = createAcpReviewPool({ agyBin: FAKE_ACP });
  assert.equal(defaultPool.maxWorkers, 2);
  assert.equal(defaultPool.initTimeoutMs, 10_000);

  const disabledPool = createAcpReviewPool({ agyBin: FAKE_ACP, env: { AGB_ACP_POOL: '0' } });
  const disRes = await disabledPool.prompt({ prompt: 'hello' });
  assert.equal(disRes.ok, false);
  assert.equal(disRes.fallback, true);
  assert.match(disRes.error, /disabled/i);

  // 2. Warm worker reuse + model/effort switching + concurrent queue bounding
  const pool = new AcpReviewPool({
    agyBin: FAKE_ACP,
    maxWorkers: 2,
    initTimeoutMs: 5000,
    promptTimeoutMs: 5000,
  });

  try {
    const r1 = await pool.prompt({ prompt: 'lens-1', model: 'gemini-4-neon-high', effort: 'high' });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const p1 = JSON.parse(r1.output);
    assert.equal(p1.count, 1);
    assert.equal(p1.model, 'gemini-4-neon-high');
    assert.equal(p1.effort, 'high');

    // Second sequential prompt reuses the SAME warm worker process (same pid, count === 2)
    const r2 = await pool.prompt({ prompt: 'lens-2', model: 'claude-sonnet-5-5-high', effort: 'xhigh' });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const p2 = JSON.parse(r2.output);
    assert.equal(p2.pid, p1.pid, 'sequential prompt must reuse the warm ACP worker');
    assert.equal(p2.count, 2);
    assert.equal(p2.model, 'claude-sonnet-5-5-high');
    assert.equal(p2.effort, 'xhigh');

    // Parallel fan-out of 4 prompts across maxWorkers=2 succeeds cleanly
    const fanout = await Promise.all([
      pool.prompt({ prompt: 'p-1', model: 'gemini-4-neon-high' }),
      pool.prompt({ prompt: 'p-2', model: 'gemini-4-neon-high' }),
      pool.prompt({ prompt: 'p-3', model: 'gemini-4-neon-high' }),
      pool.prompt({ prompt: 'p-4', model: 'gemini-4-neon-high' }),
    ]);
    assert.equal(fanout.every((r) => r.ok), true);
    assert.equal(pool.stats().activeWorkers <= 2, true);
    assert.equal(pool.stats().busyWorkers, 0);

    // 3. Worker crash degrades cleanly and respawns a fresh healthy worker on the next call
    const crashRes = await pool.prompt({ prompt: 'CRASH_NOW' });
    assert.equal(crashRes.ok, false);
    assert.equal(crashRes.fallback, true);
    assert.match(crashRes.error, /exited/i);

    const afterCrash = await pool.prompt({ prompt: 'recovered' });
    assert.equal(afterCrash.ok, true, JSON.stringify(afterCrash));
    assert.equal(JSON.parse(afterCrash.output).echo, 'recovered');

    // 4. Timeout degrades cleanly with fallback: true
    const hangRes = await pool.prompt({ prompt: 'HANG_NOW', timeoutMs: 120 });
    assert.equal(hangRes.ok, false);
    assert.equal(hangRes.fallback, true);
    assert.match(hangRes.error, /timed out/i);
  } finally {
    await pool.shutdown();
  }

  // After shutdown, prompts degrade cleanly and activeWorkers is 0
  assert.equal(pool.stats().activeWorkers, 0);
  const postShutdown = await pool.prompt({ prompt: 'after' });
  assert.equal(postShutdown.ok, false);
  assert.equal(postShutdown.fallback, true);

  // 5. Init error degrades cleanly
  const badInitPool = new AcpReviewPool({
    agyBin: FAKE_ACP,
    env: { ...process.env, FAKE_ACP_FAIL_INIT: '1' },
    initTimeoutMs: 3000,
  });
  try {
    const badRes = await badInitPool.prompt({ prompt: 'hi' });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.fallback, true);
    assert.match(badRes.error, /ACP init refused/);
  } finally {
    await badInitPool.shutdown();
  }
});
