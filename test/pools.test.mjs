import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuotaProbeOutput,
  computeEffectivePercent,
  computeScaledCap,
  computeQuotaResumption,
  acquireLease,
  registerLeaseWorkerPid,
  renewLease,
  releaseLease,
  reconcileLeases,
  drainPools,
  isLeaseActive,
  readV2State,
  writeV2State,
  assertNoActiveLegacyFleet,
  LegacyFleetActiveError,
  ActiveV2LeasesPresentError,
  PoolSet,
  BASE_CAPS,
  writeSharedState,
  readSharedState,
} from '../lib/pools.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function futureIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

test('parseQuotaProbeOutput: parses valid upstream fixture with exact cardinality', () => {
  const t5h = futureIso(3600);
  const tWeekly = futureIso(86400 * 7);
  const fixture = JSON.stringify({
    pools: [
      {
        name: 'Gemini Models',
        fiveHour: { remainingPercent: 85.0, resetTime: t5h },
        weekly: { remainingPercent: 92.5, resetTime: tWeekly },
      },
      {
        name: 'Claude and GPT models',
        fiveHour: { remainingPercent: '40.0', resetTime: t5h },
        weekly: { remainingPercent: 65.0, resetTime: tWeekly },
      },
    ],
  });

  const parsed = parseQuotaProbeOutput(fixture);
  assert.equal(parsed.gemini.fiveHourRemainingPercent, 85.0);
  assert.equal(parsed.gemini.fiveHourResetTime, t5h);
  assert.equal(parsed.gemini.weeklyRemainingPercent, 92.5);
  assert.equal(parsed.gemini.weeklyResetTime, tWeekly);

  assert.equal(parsed.claude_gpt.fiveHourRemainingPercent, 40.0);
  assert.equal(parsed.claude_gpt.weeklyRemainingPercent, 65.0);
  assert.equal(parsed['claude-gpt'].fiveHourRemainingPercent, 40.0);
});

test('parseQuotaProbeOutput: rejects unparseable or empty output (quota_parse_failure)', () => {
  assert.throws(() => parseQuotaProbeOutput(''), (err) => err.kind === 'quota_parse_failure');
  assert.throws(() => parseQuotaProbeOutput('not json'), (err) => err.kind === 'quota_parse_failure');
  assert.throws(() => parseQuotaProbeOutput('[]'), (err) => err.kind === 'quota_parse_failure');
  assert.throws(() => parseQuotaProbeOutput('{}'), (err) => err.kind === 'quota_parse_failure');
});

test('parseQuotaProbeOutput: rejects wrong cardinality or unrecognized pools (ambiguous_quota_pools)', () => {
  const t5h = futureIso(3600);
  const tWeekly = futureIso(86400 * 7);

  // 1 pool
  const onePool = JSON.stringify({
    pools: [{ name: 'Gemini Models', fiveHour: { remainingPercent: 50, resetTime: t5h }, weekly: { remainingPercent: 50, resetTime: tWeekly } }],
  });
  assert.throws(() => parseQuotaProbeOutput(onePool), (err) => err.kind === 'ambiguous_quota_pools');

  // Unknown pool
  const wrongPool = JSON.stringify({
    pools: [
      { name: 'Gemini Models', fiveHour: { remainingPercent: 50, resetTime: t5h }, weekly: { remainingPercent: 50, resetTime: tWeekly } },
      { name: 'Unknown Pool', fiveHour: { remainingPercent: 50, resetTime: t5h }, weekly: { remainingPercent: 50, resetTime: tWeekly } },
    ],
  });
  assert.throws(() => parseQuotaProbeOutput(wrongPool), (err) => err.kind === 'ambiguous_quota_pools');

  // Duplicate pool
  const duplicatePool = JSON.stringify({
    pools: [
      { name: 'Gemini Models', fiveHour: { remainingPercent: 50, resetTime: t5h }, weekly: { remainingPercent: 50, resetTime: tWeekly } },
      { name: 'Gemini Models', fiveHour: { remainingPercent: 50, resetTime: t5h }, weekly: { remainingPercent: 50, resetTime: tWeekly } },
    ],
  });
  assert.throws(() => parseQuotaProbeOutput(duplicatePool), (err) => err.kind === 'ambiguous_quota_pools');
});

test('parseQuotaProbeOutput: rejects non-UTC, offset, or space-separated timestamps (invalid_quota_timestamp)', () => {
  const makePayload = (resetTime) =>
    JSON.stringify({
      pools: [
        {
          name: 'Gemini Models',
          fiveHour: { remainingPercent: 80, resetTime },
          weekly: { remainingPercent: 80, resetTime: futureIso(3600) },
        },
        {
          name: 'Claude and GPT models',
          fiveHour: { remainingPercent: 80, resetTime: futureIso(3600) },
          weekly: { remainingPercent: 80, resetTime: futureIso(3600) },
        },
      ],
    });

  // Non-UTC offset (+02:00)
  assert.throws(() => parseQuotaProbeOutput(makePayload('2026-09-22T17:00:00+02:00')), (err) => err.kind === 'invalid_quota_timestamp');
  // Space delimiter
  assert.throws(() => parseQuotaProbeOutput(makePayload('2026-09-22 17:00:00Z')), (err) => err.kind === 'invalid_quota_timestamp');
  // Missing Z
  assert.throws(() => parseQuotaProbeOutput(makePayload('2026-09-22T17:00:00')), (err) => err.kind === 'invalid_quota_timestamp');
  // Timestamp > 10s in past
  assert.throws(() => parseQuotaProbeOutput(makePayload('2020-01-01T00:00:00Z')), (err) => err.kind === 'invalid_quota_timestamp');
});

test('parseQuotaProbeOutput: rejects invalid remainingPercent (invalid_quota_percentage)', () => {
  const t = futureIso(3600);
  const makePayload = (percent) =>
    JSON.stringify({
      pools: [
        {
          name: 'Gemini Models',
          fiveHour: { remainingPercent: percent, resetTime: t },
          weekly: { remainingPercent: 80, resetTime: t },
        },
        {
          name: 'Claude and GPT models',
          fiveHour: { remainingPercent: 80, resetTime: t },
          weekly: { remainingPercent: 80, resetTime: t },
        },
      ],
    });

  assert.throws(() => parseQuotaProbeOutput(makePayload(null)), (err) => err.kind === 'invalid_quota_percentage');
  assert.throws(() => parseQuotaProbeOutput(makePayload(true)), (err) => err.kind === 'invalid_quota_percentage');
  assert.throws(() => parseQuotaProbeOutput(makePayload('')), (err) => err.kind === 'invalid_quota_percentage');
  assert.throws(() => parseQuotaProbeOutput(makePayload('abc')), (err) => err.kind === 'invalid_quota_percentage');
  assert.throws(() => parseQuotaProbeOutput(makePayload(-5)), (err) => err.kind === 'invalid_quota_percentage');
  assert.throws(() => parseQuotaProbeOutput(makePayload(105)), (err) => err.kind === 'invalid_quota_percentage');
});

test('computeEffectivePercent & computeScaledCap: verifies capacity tiers', () => {
  assert.equal(computeEffectivePercent(80, 60), 60);
  assert.equal(computeEffectivePercent(20, 70), 20);

  // Gemini: base 12
  assert.equal(computeScaledCap('gemini', 50), 12);
  assert.equal(computeScaledCap('gemini', 100), 12);
  assert.equal(computeScaledCap('gemini', 49.9), 6);
  assert.equal(computeScaledCap('gemini', 25), 6);
  assert.equal(computeScaledCap('gemini', 24.9), 1);
  assert.equal(computeScaledCap('gemini', 10), 1);
  assert.equal(computeScaledCap('gemini', 9.9), 0);
  assert.equal(computeScaledCap('gemini', 0), 0);

  // Claude / GPT: base 4
  assert.equal(computeScaledCap('claude_gpt', 50), 4);
  assert.equal(computeScaledCap('claude_gpt', 25), 2);
  assert.equal(computeScaledCap('claude_gpt', 15), 1);
  assert.equal(computeScaledCap('claude_gpt', 5), 0);
});

test('computeQuotaResumption: exact resumption timestamp with 30s clock-skew buffer', () => {
  const t5h = '2026-09-22T17:00:00.000Z';
  const tWeekly = '2026-09-29T00:00:00.000Z';
  const t5hExpected = new Date(Date.parse(t5h) + 30000).toISOString();
  const tWeeklyExpected = new Date(Date.parse(tWeekly) + 30000).toISOString();

  // Case 1: 5-hour depletion (<10% and weekly >= 10%)
  const case1 = computeQuotaResumption(8.0, t5h, 50.0, tWeekly);
  assert.ok(case1.paused);
  assert.equal(case1.depletionCause, 'five_hour_depletion');
  assert.equal(case1.resumesAt, t5hExpected);

  // Case 2: Weekly depletion (<10% and 5-hour >= 10%)
  const case2 = computeQuotaResumption(50.0, t5h, 5.0, tWeekly);
  assert.ok(case2.paused);
  assert.equal(case2.depletionCause, 'weekly_depletion');
  assert.equal(case2.resumesAt, tWeeklyExpected);

  // Case 3: Dual depletion (<10% for both) -> max(t5h, tWeekly) + 30s
  const case3 = computeQuotaResumption(4.0, t5h, 2.0, tWeekly);
  assert.ok(case3.paused);
  assert.equal(case3.depletionCause, 'dual_depletion');
  assert.equal(case3.resumesAt, tWeeklyExpected);

  // Case 4: Not depleted
  const case4 = computeQuotaResumption(15.0, t5h, 20.0, tWeekly);
  assert.equal(case4, null);
});

test('v0.7 / v0.8 Handoff: throws LegacyFleetActiveError when v0.7 fleet is active', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-handoff-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    // Write active legacy v0.7 payload
    writeFileSync(
      process.env.AGB_QUOTA_STATE,
      JSON.stringify({
        99999: {
          ts: Date.now(),
          inFlight: { 'gemini-flash': 2 },
        },
      })
    );

    assert.throws(() => assertNoActiveLegacyFleet(), LegacyFleetActiveError);
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Lease durability: acquire, renew, reconcile, and idempotent release', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-lease-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    // 1. Acquire lease
    const { leaseId, ownerToken, lease } = await acquireLease(tmp, {
      pool: 'gemini',
      ticketId: 't-test-1',
      workerPid: process.pid,
      workerStartTime: '12345',
    });

    assert.ok(leaseId);
    assert.ok(ownerToken);
    assert.equal(lease.state, 'ACTIVE');

    // Heartbeat file created
    const hbPath = join(tmp, '.adlc', 'leases', `${leaseId}.heartbeat`);
    assert.ok(existsSync(hbPath));

    // Verify v2 state inFlight
    let v2 = readV2State();
    assert.equal(v2.pools.gemini.inFlight, 1);

    // 2. Renew lease
    const renewed = await renewLease(tmp, leaseId, ownerToken);
    assert.equal(renewed, true);

    // 3. Idempotent release
    const released1 = await releaseLease(tmp, leaseId, ownerToken);
    assert.equal(released1, true);

    v2 = readV2State();
    assert.equal(v2.pools.gemini.inFlight, 0);
    assert.equal(v2.leases[leaseId].state, 'TERMINATED');

    // Second release is a no-op
    const released2 = await releaseLease(tmp, leaseId, ownerToken);
    assert.equal(released2, false);

    v2 = readV2State();
    assert.equal(v2.pools.gemini.inFlight, 0); // No counter underflow!
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Lease reconciliation: PID reuse detection marks lease RECLAIMED', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-pidreuse-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    // Register a lease with deliberately mismatched workerStartTime
    const { leaseId } = await acquireLease(tmp, {
      pool: 'gemini',
      ticketId: 't-reuse-1',
      workerPid: process.pid,
      workerStartTime: '99999999_mismatched',
    });

    let v2 = readV2State();
    assert.equal(v2.pools.gemini.inFlight, 1);
    assert.equal(v2.leases[leaseId].state, 'ACTIVE');

    // Only on platforms with /proc (Linux) will PID reuse check trigger
    if (process.platform === 'linux') {
      const reconciled = await reconcileLeases(tmp);
      assert.equal(reconciled, 1);

      v2 = readV2State();
      assert.equal(v2.leases[leaseId].state, 'RECLAIMED');
      assert.equal(v2.pools.gemini.inFlight, 0);
    }
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPools: safely drains active leases and emits clean downgrade tombstone', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-drain-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    await acquireLease(tmp, {
      pool: 'claude_gpt',
      ticketId: 't-drain-1',
      workerPid: process.pid,
      workerStartTime: '54321',
    });

    const res = await drainPools(tmp);
    assert.ok(res.ok);

    const shared = JSON.parse(readFileSync(process.env.AGB_QUOTA_STATE, 'utf8'));
    assert.equal(shared.activeSchemaVersion, 1);
    assert.equal(shared.v2ActiveLeaseCount, 0);

    const v2 = readV2State();
    assert.equal(v2.pools.claude_gpt.inFlight, 0);
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPools: terminates unsettled active leases and registerLeaseWorkerPid returns false during DRAINING', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-drain-unsettled-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    // Acquire an unsettled lease (no workerPid registered yet)
    const { leaseId, ownerToken } = await acquireLease(tmp, {
      pool: 'claude_gpt',
      ticketId: 't-unsettled-1',
    });

    assert.equal(isLeaseActive(tmp, leaseId, ownerToken), true);

    // Set status to DRAINING manually to test registerLeaseWorkerPid rejection
    const v2 = readV2State();
    v2.status = 'DRAINING';
    writeV2State(v2);

    assert.equal(isLeaseActive(tmp, leaseId, ownerToken), false);

    // Attempting to register workerPid while draining must fail
    const regResult = await registerLeaseWorkerPid(tmp, leaseId, ownerToken, process.pid);
    assert.equal(regResult, false);

    // Now call drainPools (which handles DRAINING status and terminates remaining leases)
    const res = await drainPools(tmp, { gracePeriodMs: 50 });
    assert.ok(res.ok);

    const afterV2 = readV2State();
    assert.equal(afterV2.status, 'ACTIVE');
    assert.equal(afterV2.leases[leaseId].state, 'TERMINATED');
    assert.equal(afterV2.pools.claude_gpt.inFlight, 0);
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPools and reconcileLeases: cleans up fallback heartbeat files under /tmp/agb_fallback_leases', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-fallback-drain-'));
  const fallbackDir = join(tmpdir(), 'agb_fallback_leases');
  mkdirSync(fallbackDir, { recursive: true });

  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    const { leaseId, ownerToken } = await acquireLease(tmp, {
      pool: 'claude_gpt',
      ticketId: 't-fallback-1',
    });

    // Plant a fallback heartbeat file
    const fallbackFile = join(fallbackDir, `${leaseId}.heartbeat`);
    writeFileSync(fallbackFile, JSON.stringify({ ownerToken, timestamp: Date.now() }));
    assert.ok(existsSync(fallbackFile));

    // Call drainPools
    await drainPools(tmp, { gracePeriodMs: 50 });

    // The fallback heartbeat file must have been cleaned up!
    assert.equal(existsSync(fallbackFile), false, 'fallback heartbeat file must be unlinked during drainPools');
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
    try { rmSync(fallbackDir, { recursive: true, force: true }); } catch {}
  }
});

test('PoolSet: updates dynamic capacity from quota and trips circuit breaker on failure', () => {
  const pools = new PoolSet();
  const t5h = futureIso(3600);
  const tWeekly = futureIso(86400 * 7);

  const quota = {
    gemini: {
      fiveHourRemainingPercent: 45.0, // < 50% -> scaled cap 6
      fiveHourResetTime: t5h,
      weeklyRemainingPercent: 80.0,
      weeklyResetTime: tWeekly,
    },
    claude_gpt: {
      fiveHourRemainingPercent: 20.0, // < 25% -> scaled cap 1
      fiveHourResetTime: t5h,
      weeklyRemainingPercent: 60.0,
      weeklyResetTime: tWeekly,
    },
  };

  pools.updateFromQuota(quota);
  assert.equal(pools.caps['gemini-flash'], 6);
  assert.equal(pools.caps['claude'], 1);
  assert.equal(pools.quota.paused, false);

  // Circuit breaker test: trips immediately on quota failure to prevent stale admissions
  assert.equal(pools.circuitBreakerTripped, false);
  pools.recordQuotaFailure();
  assert.equal(pools.circuitBreakerTripped, true);

  // Admission frozen while circuit breaker is tripped
  assert.equal(pools.hasCapacity('gemini-3.8-flash-low'), false);

  // Recovery
  pools.updateFromQuota(quota);
  assert.equal(pools.circuitBreakerTripped, false);
  assert.equal(pools.hasCapacity('gemini-3.8-flash-low'), true);
});

test('PoolSet: caps restore to configured values when depleted quota recovers', () => {
  const pools = new PoolSet({ 'gemini-flash': 8, 'claude': 4 });
  assert.equal(pools.caps['gemini-flash'], 8);

  // Severe depletion: 5% remaining -> scaled cap is 0
  const depleted = {
    gemini: {
      fiveHourRemainingPercent: 5.0,
      weeklyRemainingPercent: 5.0,
      fiveHourResetTime: '2026-09-22T20:00:00Z',
      weeklyResetTime: '2026-09-28T00:00:00Z',
    },
    claude_gpt: {
      fiveHourRemainingPercent: 5.0,
      weeklyRemainingPercent: 5.0,
      fiveHourResetTime: '2026-09-22T20:00:00Z',
      weeklyResetTime: '2026-09-28T00:00:00Z',
    },
  };
  pools.updateFromQuota(depleted);
  assert.equal(pools.caps['gemini-flash'], 0);
  assert.equal(pools.caps['claude'], 0);
  assert.equal(pools.quota.paused, true);

  // Recovery: quota refreshed to 100%
  const healthy = {
    gemini: {
      fiveHourRemainingPercent: 100.0,
      weeklyRemainingPercent: 100.0,
      fiveHourResetTime: '2026-09-22T23:00:00Z',
      weeklyResetTime: '2026-09-28T00:00:00Z',
    },
    claude_gpt: {
      fiveHourRemainingPercent: 100.0,
      weeklyRemainingPercent: 100.0,
      fiveHourResetTime: '2026-09-22T23:00:00Z',
      weeklyResetTime: '2026-09-28T00:00:00Z',
    },
  };
  pools.updateFromQuota(healthy);
  assert.equal(pools.caps['gemini-flash'], 8, 'gemini-flash cap must restore to configured value');
  assert.equal(pools.caps['claude'], 4, 'claude cap must restore to configured value');
  assert.equal(pools.quota.paused, false);
});

test('withLockSync and writeSharedState: serializes updates across calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sync-lock-'));
  const saved = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = dir;
    writeSharedState({ test: 1 });
    const s1 = readSharedState();
    assert.deepEqual(s1[process.pid], { test: 1 });
  } finally {
    if (saved === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PoolSet: zero-capacity pool rejects immediately without queuing forever', async () => {
  const pools = new PoolSet({ 'gemini-flash': 0 });
  await assert.rejects(
    () => pools.acquire('gemini-3.8-flash-low'),
    (err) => {
      assert.equal(err.kind, 'quota_depleted');
      assert.match(err.message, /zero capacity due to quota depletion/);
      return true;
    }
  );
});

test('PoolSet: queued waiters are aborted if quota reduces capacity to 0', async () => {
  const pools = new PoolSet({ 'gemini-flash': 1 });
  const r1 = await pools.acquire('gemini-3.8-flash-low');

  let waiterRejected = null;
  const waiterPromise = pools.acquire('gemini-3.8-flash-low').catch((err) => {
    waiterRejected = err;
  });

  // Deplete quota to 0%
  pools.updateFromQuota({
    gemini: {
      fiveHourRemainingPercent: 0.0,
      weeklyRemainingPercent: 0.0,
      fiveHourResetTime: '2026-09-22T20:00:00Z',
      weeklyResetTime: '2026-09-28T00:00:00Z',
    },
    claude_gpt: {
      fiveHourRemainingPercent: 50.0,
      weeklyRemainingPercent: 50.0,
      fiveHourResetTime: '2026-09-22T20:00:00Z',
      weeklyResetTime: '2026-09-28T00:00:00Z',
    },
  });

  await waiterPromise;
  assert.ok(waiterRejected, 'waiter must be rejected on quota drop');
  assert.equal(waiterRejected.kind, 'quota_depleted');
  r1();

  // Restore quota to healthy so subsequent tests have positive capacity
  pools.updateFromQuota({
    gemini: { fiveHourRemainingPercent: 100.0, weeklyRemainingPercent: 100.0, fiveHourResetTime: '2026-09-22T20:00:00Z', weeklyResetTime: '2026-09-28T00:00:00Z' },
    claude_gpt: { fiveHourRemainingPercent: 100.0, weeklyRemainingPercent: 100.0, fiveHourResetTime: '2026-09-22T20:00:00Z', weeklyResetTime: '2026-09-28T00:00:00Z' },
  });
});

test('PoolSet: integrates durable lease acquisition and release with repo path', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-poolset-lease-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = repo;
    const pools = new PoolSet({ 'gemini-flash': 2 }, { repo });
    const release = await pools.acquire('gemini-3.8-flash-low', { repo, ticketId: 'T-LEASE-1' });

    const leasesDir = join(repo, '.adlc', 'leases');
    assert.ok(existsSync(leasesDir), '.adlc/leases directory must exist');
    const heartbeats = readdirSync(leasesDir).filter((f) => f.endsWith('.heartbeat'));
    assert.equal(heartbeats.length, 1, 'active lease heartbeat must exist');

    release();
    // After release, heartbeat should be unlinked
    const remaining = readdirSync(leasesDir).filter((f) => f.endsWith('.heartbeat'));
    assert.equal(remaining.length, 0, 'heartbeat must be removed after release');
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('PoolSet: releasing a slot in one subpool wakes waiters in another subpool of the same family', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-poolset-family-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = repo;
    const pools = new PoolSet({ 'gemini-flash': 2, 'gemini-pro': 2 }, { repo });
    // Override familyCap for test to 2
    pools.familyCap = () => 2;

    const rFlash1 = await pools.acquire('gemini-3.8-flash-low', { repo });
    const rFlash2 = await pools.acquire('gemini-3.8-flash-low', { repo });
    assert.equal(pools.familyInFlight('gemini'), 2);

    let proWoken = false;
    const proPromise = pools.acquire('gemini-3.1-pro-high', { repo }).then((rel) => {
      proWoken = true;
      return rel;
    });

    // Wait a tick to ensure pro is queued as waiter
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(proWoken, false, 'gemini-pro should be waiting because family capacity (2) is full');
    assert.equal(pools.waiters['gemini-pro'].length, 1);

    // Release flash slot: flash has no waiters, so family capacity opens up and pro waiter wakes
    rFlash1();
    const rPro = await proPromise;
    assert.equal(proWoken, true, 'gemini-pro should be woken up when flash releases slot');
    assert.equal(pools.totalInFlight('gemini-pro'), 1);
    assert.equal(pools.totalInFlight('gemini-flash'), 1);

    rFlash2();
    rPro();
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('PoolSet: route() prefers models with positive capacity when some candidate pools are depleted', () => {
  const pools = new PoolSet({ 'gemini-pro': 0, claude: 4 });
  // frontier tier has gemini-3.1-pro-high and claude-sonnet-4-6
  const picked = pools.route('frontier');
  assert.equal(picked, 'claude-sonnet-4-6', 'route should avoid 0-capacity gemini-pro and pick claude-sonnet-4-6');
  pools.unroute(picked);
});

test('PoolSet: prosecutorFor() prefers models with positive capacity when primary is depleted', () => {
  const pools = new PoolSet({ 'gpt-oss': 0, claude: 4 });
  // for gemini builder, primary prosecutor is gpt-oss-120b-medium, alternate is claude-sonnet-4-6
  const pros = pools.prosecutorFor('gemini-3.8-flash-low');
  assert.equal(pros, 'claude-sonnet-4-6', 'prosecutorFor should avoid 0-capacity gpt-oss and pick claude-sonnet-4-6');
});

test('registerLeaseWorkerPid: fails closed when process start time cannot be verified', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-pools-pid-test-'));
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;
  try {
    process.env.AGB_POOLS_V2 = join(repo, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(repo, 'agb_pools_shared.lock');

    const lease = await acquireLease(repo, { pool: 'gemini-flash', ticketId: 'T1' });
    const registered = await registerLeaseWorkerPid(repo, lease.leaseId, lease.ownerToken, 999999999);
    assert.equal(registered, false, 'must reject worker registration without verified start time');

    const v2 = readV2State();
    assert.equal(v2.leases[lease.leaseId].workerPid, null);
    assert.equal(v2.leases[lease.leaseId].workerStartTime, null);

    await releaseLease(repo, lease.leaseId, lease.ownerToken);
  } finally {
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('acquireLease: fails closed when workerPid has unverifiable start time', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-pools-acq-test-'));
  try {
    await assert.rejects(
      async () => {
        await acquireLease(repo, { pool: 'gemini-flash', ticketId: 'T1', workerPid: 999999999 });
      },
      /cannot verify worker process start time/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeLeaseHeartbeat: refuses to write through symlinked .adlc or .adlc/leases directory', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-pools-symlink-test-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'agb-pools-target-'));
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_POOLS_V2 = join(repo, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(repo, 'agb_pools_shared.lock');

    // Case 1: .adlc is a symlink
    symlinkSync(targetDir, join(repo, '.adlc'), 'dir');
    await assert.rejects(
      async () => {
        await acquireLease(repo, { pool: 'gemini-flash', ticketId: 'T1' });
      },
      /refusing to write lease heartbeat through symlinked \.adlc/
    );

    // Remove symlink
    unlinkSync(join(repo, '.adlc'));

    // Case 2: .adlc/leases is a symlink
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    symlinkSync(targetDir, join(repo, '.adlc', 'leases'), 'dir');
    await assert.rejects(
      async () => {
        await acquireLease(repo, { pool: 'gemini-flash', ticketId: 'T1' });
      },
      /refusing to write lease heartbeat through symlinked leases directory/
    );
  } finally {
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(repo, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('v0.7 / v0.8 Handoff: throws LegacyFleetActiveError even when activeSchemaVersion: 2 marker is present', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-handoff-v2-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    writeFileSync(
      process.env.AGB_QUOTA_STATE,
      JSON.stringify({
        activeSchemaVersion: 2,
        99999: {
          ts: Date.now(),
          inFlight: { 'gemini-flash': 2 },
        },
      })
    );
    assert.throws(() => assertNoActiveLegacyFleet(), LegacyFleetActiveError);
  } finally {
    if (origQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = origQuota;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('isLeaseActive: validates expiry, heartbeat ownership, and worker identity', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-pools-active-test-'));
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_POOLS_V2 = join(repo, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(repo, 'agb_pools_shared.lock');

    const { leaseId, ownerToken } = await acquireLease(repo, { pool: 'gemini-flash', ticketId: 'T1' });
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), true);

    // 1. Expired lease
    const v2 = readV2State();
    v2.leases[leaseId].leaseExpiryMs = Date.now() - 1000;
    writeV2State(v2);
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), false);

    // Reset expiry
    v2.leases[leaseId].leaseExpiryMs = Date.now() + 60000;
    writeV2State(v2);
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), true);

    // 2. Tampered / wrong ownerToken in heartbeat file
    const hbPath = join(repo, '.adlc', 'leases', `${leaseId}.heartbeat`);
    writeFileSync(hbPath, JSON.stringify({ ownerToken: 'wrong-token', timestamp: Date.now() }));
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), false);

    // Restore heartbeat file
    writeFileSync(hbPath, JSON.stringify({ ownerToken, timestamp: Date.now() }));
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), true);

    // 3. Worker PID identity mismatch (PID reuse)
    await registerLeaseWorkerPid(repo, leaseId, ownerToken, process.pid);
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), true);

    const v2Worker = readV2State();
    v2Worker.leases[leaseId].workerStartTime = 'fake-nonexistent-start-time';
    writeV2State(v2Worker);
    assert.equal(isLeaseActive(repo, leaseId, ownerToken), false);

    await releaseLease(repo, leaseId, ownerToken);
  } finally {
    if (origV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = origV2;
    if (origLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = origLock;
    rmSync(repo, { recursive: true, force: true });
  }
});
