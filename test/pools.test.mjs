import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuotaProbeOutput,
  computeEffectivePercent,
  computeScaledCap,
  computeQuotaResumption,
  acquireLease,
  renewLease,
  releaseLease,
  reconcileLeases,
  drainPools,
  readV2State,
  writeV2State,
  assertNoActiveLegacyFleet,
  LegacyFleetActiveError,
  ActiveV2LeasesPresentError,
  PoolSet,
  BASE_CAPS,
} from '../lib/pools.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
    process.env.AGB_QUOTA_STATE = origQuota;
    process.env.AGB_POOLS_V2 = origV2;
    process.env.AGB_POOLS_LOCK = origLock;
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
    process.env.AGB_QUOTA_STATE = origQuota;
    process.env.AGB_POOLS_V2 = origV2;
    process.env.AGB_POOLS_LOCK = origLock;
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
    process.env.AGB_QUOTA_STATE = origQuota;
    process.env.AGB_POOLS_V2 = origV2;
    process.env.AGB_POOLS_LOCK = origLock;
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
    process.env.AGB_QUOTA_STATE = origQuota;
    process.env.AGB_POOLS_V2 = origV2;
    process.env.AGB_POOLS_LOCK = origLock;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('PoolSet: updates dynamic capacity from quota and trips circuit breaker on 3 failures', () => {
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

  // Circuit breaker test
  assert.equal(pools.circuitBreakerTripped, false);
  pools.recordQuotaFailure();
  assert.equal(pools.circuitBreakerTripped, false);
  pools.recordQuotaFailure();
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
