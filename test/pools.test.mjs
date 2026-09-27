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
  isProcessAlive,
  getProcessStartTime,
  withLock,
  withLockSync,
} from '../lib/pools.mjs';
import { spawn } from 'node:child_process';
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

test('drainPools: terminates owning orchestrator process when active lease has no workerPid', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-drain-orch-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  // Spawn a dummy process to simulate a separate orchestrator
  const dummyOrch = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    const v2 = {
      generation: 1,
      status: 'ACTIVE',
      pools: {
        gemini: { baseCap: 12, scaledCap: 12, inFlight: 1, reserved: 0 },
        claude_gpt: { baseCap: 4, scaledCap: 4, inFlight: 0, reserved: 0 },
      },
      leases: {
        'lease-orch-1': {
          leaseId: 'lease-orch-1',
          ownerToken: 'tok-1',
          repo: tmp,
          orchestratorPid: dummyOrch.pid,
          orchestratorStartTime: getProcessStartTime(dummyOrch.pid),
          workerPid: null,
          workerStartTime: null,
          ticketId: 't-orch-1',
          pool: 'gemini',
          modelPool: 'gemini-flash',
          createdAtMs: Date.now(),
          heartbeatMs: Date.now(),
          leaseExpiryMs: Date.now() + 60000,
          state: 'ACTIVE',
        },
      },
    };
    writeV2State(v2);

    assert.equal(isProcessAlive(dummyOrch.pid), true);

    const res = await drainPools(tmp, { gracePeriodMs: 50 });
    assert.ok(res.ok);

    // Wait a brief moment for SIGTERM/SIGKILL delivery
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(isProcessAlive(dummyOrch.pid), false, 'dummy orchestrator process must be terminated by drainPools');

    const afterV2 = readV2State();
    assert.equal(afterV2.leases['lease-orch-1'].state, 'TERMINATED');
  } finally {
    try { dummyOrch.kill('SIGKILL'); } catch {}
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

test('v2 lease mirror: does not throw LegacyFleetActiveError when active leases are v2Mirror', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-v2-mirror-'));
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
          v2Mirror: true,
        },
      })
    );
    assert.doesNotThrow(() => assertNoActiveLegacyFleet());
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

test('PoolSet: await release() ensures durable lease state is TERMINATED before resolving', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-poolset-durable-release-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = repo;
    const pools = new PoolSet({ 'gemini-flash': 2 }, { repo });
    const release = await pools.acquire('gemini-3.8-flash-low', { repo, ticketId: 'T-DURABLE-1' });

    assert.equal(release.isActive(), true);

    await release();

    assert.equal(release.isActive(), false);
    const v2Path = join(repo, 'agb_pools_v2.json');
    if (existsSync(v2Path)) {
      const v2 = JSON.parse(readFileSync(v2Path, 'utf8'));
      const lease = v2.leases?.[release.leaseId] || v2.activeLeases?.[release.leaseId];
      assert.equal(lease?.state, 'TERMINATED');
    }
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('PoolSet: circuit breaker trips and immediately aborts queued requests in saturated pools', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-cb-waiters-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;

  try {
    process.env.AGB_POOLS_DIR = repo;
    const pools = new PoolSet({ 'gemini-flash': 1 }, { repo });

    const rel1 = await pools.acquire('gemini-3.8-flash-low', { repo });
    assert.equal(pools.inFlight['gemini-flash'], 1);

    let secondAcquired = false;
    let secondError = null;
    const secondPromise = pools.acquire('gemini-3.8-flash-low', { repo })
      .then(() => { secondAcquired = true; })
      .catch((err) => { secondError = err; });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pools.waiters['gemini-flash'].length, 1);
    assert.equal(secondAcquired, false);

    pools.recordQuotaFailure();
    assert.equal(pools.circuitBreakerTripped, true);

    await secondPromise;
    assert.equal(secondAcquired, false);
    assert.ok(secondError, 'queued request must be rejected');
    assert.equal(secondError.kind, 'circuit_breaker_tripped');
    assert.match(secondError.message, /Quota circuit breaker is tripped/);
    assert.equal(pools.waiters['gemini-flash'].length, 0);

    await rel1();
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('withLockSync: does not reclaim active lock solely due to age when owner PID is alive, but reclaims when dead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-lock-reclaim-test-'));
  const lockFile = join(dir, 'test.lock');

  try {
    // 1. Write lock with alive PID (current process) but timestamp 60s ago
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'alive-token', ts: Date.now() - 60000 }), 'utf8');

    // Trying to acquire lock with short timeout should fail because owner is still alive
    assert.throws(
      () => withLockSync(lockFile, () => 'should_not_run', { timeoutMs: 100, retryMs: 20 }),
      /Timeout acquiring lock/
    );

    // 2. Write lock with dead PID (9999999) and timestamp 60s ago
    writeFileSync(lockFile, JSON.stringify({ pid: 9999999, token: 'dead-token', ts: Date.now() - 60000 }), 'utf8');

    // Should succeed because owner PID is dead and lock is reclaimed
    const result = withLockSync(lockFile, () => 'reclaimed_success', { timeoutMs: 200, retryMs: 20 });
    assert.equal(result, 'reclaimed_success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock (async): does not reclaim active lock solely due to age when owner PID is alive, but reclaims when dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-async-lock-test-'));
  const lockFile = join(dir, 'test.lock');

  try {
    const myStart = getProcessStartTime(process.pid);
    // 1. Write lock with alive PID and matching start time, but ts 60s ago
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startTime: myStart, token: 'alive-token', ts: Date.now() - 60000 }), 'utf8');

    // Async acquisition must fail/timeout because owner is still alive
    await assert.rejects(
      async () => withLock(lockFile, async () => 'should_not_run', { timeoutMs: 100, retryMs: 20 }),
      /Timeout acquiring lock/
    );

    // 2. Write lock with dead PID
    writeFileSync(lockFile, JSON.stringify({ pid: 9999999, token: 'dead-token', ts: Date.now() - 60000 }), 'utf8');

    const result = await withLock(lockFile, async () => 'async_reclaimed_success', { timeoutMs: 200, retryMs: 20 });
    assert.equal(result, 'async_reclaimed_success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock and withLockSync: reclaims orphaned lock when PID was reused with mismatched start time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-pid-reuse-lock-test-'));
  const lockFile = join(dir, 'test.lock');

  try {
    // Write lock with current PID but fake ancient start time representing prior dead process
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startTime: 'bogus_old_start_time_99999', token: 'reused-token', ts: Date.now() - 1000 }), 'utf8');

    // withLockSync should detect start time mismatch, consider owner dead, and reclaim lock
    const syncRes = withLockSync(lockFile, () => 'sync_reused_reclaimed', { timeoutMs: 200, retryMs: 20 });
    assert.equal(syncRes, 'sync_reused_reclaimed');

    // Write lock again with current PID and bogus start time
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startTime: 'bogus_old_start_time_88888', token: 'reused-token-2', ts: Date.now() - 1000 }), 'utf8');

    // withLock (async) should also detect start time mismatch and reclaim
    const asyncRes = await withLock(lockFile, async () => 'async_reused_reclaimed', { timeoutMs: 200, retryMs: 20 });
    assert.equal(asyncRes, 'async_reused_reclaimed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncSharedState & writeSharedState: preserves v2Mirror marker so concurrent v2 coordinator does not throw LegacyFleetActiveError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v2mirror-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;

  try {
    const sharedFile = join(dir, 'shared.json');
    const v2File = join(dir, 'v2.json');
    const lockFile = join(dir, 'shared.lock');
    process.env.AGB_QUOTA_STATE = sharedFile;
    process.env.AGB_POOLS_V2 = v2File;
    process.env.AGB_POOLS_LOCK = lockFile;

    // Simulate coordinator 1 (PID 11111) with inFlight work and v2Mirror
    writeFileSync(sharedFile, JSON.stringify({
      '11111': { ts: Date.now(), inFlight: { 'gemini-flash': 2, 'gemini-pro': 0, claude: 0, 'gpt-oss': 0 }, v2Mirror: true },
    }), 'utf8');

    // Current coordinator calls syncSharedState via PoolSet
    const pools = new PoolSet({ 'gemini-flash': 4 });
    pools.inFlight['gemini-flash'] = 1;
    pools.syncSharedState();

    // Verify shared state preserves v2Mirror for current process
    const shared = readSharedState();
    assert.equal(shared[process.pid]?.v2Mirror, true, 'syncSharedState must set v2Mirror: true');

    // Simulate writeSharedState update without stripping v2Mirror
    writeSharedState({ ts: Date.now(), inFlight: pools.inFlight, requests: 5 });
    const sharedAfter = readSharedState();
    assert.equal(sharedAfter[process.pid]?.v2Mirror, true, 'writeSharedState must preserve v2Mirror: true');

    // Calling assertNoActiveLegacyFleet should pass without throwing LegacyFleetActiveError
    assert.doesNotThrow(() => assertNoActiveLegacyFleet());
  } finally {
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = savedState;
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Lease liveness: detects orchestrator PID reuse with mismatched start time across isLeaseActive and reconcileLeases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-orch-pid-reuse-'));
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_POOLS_V2 = join(dir, 'v2.json');
    process.env.AGB_POOLS_LOCK = join(dir, 'shared.lock');

    // Acquire a lease with current orchestrator
    const lease = await acquireLease(dir, { pool: 'gemini-flash', ticketId: 'T1' });

    // Mutate the lease in v2 state to have a bogus orchestrator start time (simulating PID reuse)
    const v2 = readV2State();
    v2.leases[lease.leaseId].orchestratorStartTime = 'ancient_bogus_orch_start_12345';
    writeV2State(v2);

    // 1. isLeaseActive must return false because orchestrator start time does not match current process
    const active = isLeaseActive(dir, lease.leaseId, lease.ownerToken);
    assert.equal(active, false, 'isLeaseActive must reject recycled orchestrator PID');

    // 2. reconcileLeases must reclaim the lease
    await reconcileLeases(dir);
    const v2After = readV2State();
    assert.equal(v2After.leases[lease.leaseId].state, 'RECLAIMED', 'reconcileLeases must reclaim recycled orchestrator lease');
  } finally {
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    rmSync(dir, { recursive: true, force: true });
  }
});




