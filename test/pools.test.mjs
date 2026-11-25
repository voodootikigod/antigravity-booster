import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuotaProbeOutput,
  probeQuota,
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
  getStateFile,
  getV2StateFile,
  getLockFile,
  getStatusLineQuotaFile,
  writeStatusLineQuotaCache,
  readFreshStatusLineQuotaCache,
  durableWriteJson,
  terminateWorkerTree,
  withLock,
  withLockSync,
  safeWriteHeartbeatFile,
  LEASE_TTL_MS,
} from '../lib/pools.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync, statSync, openSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_test_${process.pid}.json`);

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

test('renewLease: rejects expired lease, stale heartbeat, or draining pool state', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-test-renew-expiry-'));
  const origQuota = process.env.AGB_QUOTA_STATE;
  const origV2 = process.env.AGB_POOLS_V2;
  const origLock = process.env.AGB_POOLS_LOCK;

  try {
    process.env.AGB_QUOTA_STATE = join(tmp, 'agb_pools_shared.json');
    process.env.AGB_POOLS_V2 = join(tmp, 'agb_pools_v2.json');
    process.env.AGB_POOLS_LOCK = join(tmp, 'agb_pools_shared.lock');

    const { leaseId, ownerToken } = await acquireLease(tmp, {
      pool: 'gemini',
      ticketId: 't-renew-exp-1',
    });

    // 1. Draining pool state rejects renewal
    let v2 = readV2State();
    v2.status = 'DRAINING';
    writeV2State(v2);

    assert.equal(await renewLease(tmp, leaseId, ownerToken), false);

    // Reset status to ACTIVE
    v2 = readV2State({ allowLegacy: true });
    v2.status = 'ACTIVE';
    writeV2State(v2);

    // 2. Expired leaseExpiryMs rejects renewal
    v2 = readV2State();
    v2.leases[leaseId].leaseExpiryMs = Date.now() - 1000;
    writeV2State(v2);

    assert.equal(await renewLease(tmp, leaseId, ownerToken), false);

    // 3. Stale heartbeat (now - heartbeatMs >= LEASE_TTL_MS) rejects renewal
    v2 = readV2State();
    v2.leases[leaseId].leaseExpiryMs = Date.now() + 60000;
    v2.leases[leaseId].heartbeatMs = Date.now() - LEASE_TTL_MS - 1000;
    writeV2State(v2);

    assert.equal(await renewLease(tmp, leaseId, ownerToken), false);

    // 4. Valid active lease renews successfully
    v2 = readV2State();
    v2.leases[leaseId].heartbeatMs = Date.now();
    writeV2State(v2);

    assert.equal(await renewLease(tmp, leaseId, ownerToken), true);
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
    const proPromise = pools.acquire('gemini-4-argon-high', { repo }).then((rel) => {
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
  // frontier tier interleaves gemini-pro-orchestrator and claude-sonnet-5-5-high
  const picked = pools.route('frontier');
  assert.equal(picked, 'claude-sonnet-5-5-high', 'route should avoid 0-capacity gemini-pro and pick claude-sonnet-5-5-high');
  pools.unroute(picked);
});

test('PoolSet: prosecutorFor() prefers models with positive capacity when primary is depleted', () => {
  const pools = new PoolSet({ 'gpt-oss': 0, claude: 4 });
  // for gemini builder, primary prosecutor is gpt-oss-120b-medium, alternate is claude-sonnet-5-5-medium
  const pros = pools.prosecutorFor('gemini-3.8-flash-low');
  assert.equal(pros, 'claude-sonnet-5-5-medium', 'prosecutorFor should avoid 0-capacity gpt-oss and pick claude-sonnet-5-5-medium');
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

    // Case 3: A symlink planted at a heartbeat path cannot overwrite an external file
    unlinkSync(join(repo, '.adlc', 'leases'));
    mkdirSync(join(repo, '.adlc', 'leases'), { recursive: true });
    const victim = join(targetDir, 'victim.txt');
    writeFileSync(victim, 'important-content');
    const victimLink = join(repo, '.adlc', 'leases', 'planted.heartbeat');
    symlinkSync(victim, victimLink);
    assert.throws(
      () => {
        safeWriteHeartbeatFile(victimLink, { ownerToken: 'evil', timestamp: Date.now() });
      },
      /refusing to write lease heartbeat|ELOOP/
    );
    assert.equal(readFileSync(victim, 'utf8'), 'important-content', 'victim content must remain unmolested');
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

test('Quota state overrides: extensionless AGB_QUOTA_STATE produces distinct state, v2, and lock files', () => {
  const savedState = process.env.AGB_QUOTA_STATE;
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;

  try {
    delete process.env.AGB_POOLS_V2;
    delete process.env.AGB_POOLS_LOCK;
    process.env.AGB_QUOTA_STATE = '/tmp/quota_override_noext';

    const state = getStateFile();
    const v2 = getV2StateFile();
    const lock = getLockFile();

    assert.equal(state, '/tmp/quota_override_noext');
    assert.equal(v2, '/tmp/quota_override_noext_v2.json');
    assert.equal(lock, '/tmp/quota_override_noext.lock');
    assert.notEqual(state, v2);
    assert.notEqual(state, lock);
    assert.notEqual(v2, lock);
  } finally {
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = savedState;
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
  }
});

test('terminateWorkerTree: terminates active worker process when dead orchestrator lease is reclaimed in reconcileLeases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-worker-term-'));
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;

  let worker = null;
  try {
    process.env.AGB_POOLS_V2 = join(dir, 'v2.json');
    process.env.AGB_POOLS_LOCK = join(dir, 'shared.lock');

    worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    worker.unref();

    const workerPid = worker.pid;
    const workerStartTime = getProcessStartTime(workerPid);
    assert.ok(isProcessAlive(workerPid, workerStartTime), 'worker process must be alive initially');

    const deadOrchPid = 9999999;
    const v2 = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      pools: {
        gemini: { baseCap: 4, scaledCap: 4, inFlight: 1, reserved: 0 },
      },
      leases: {
        'lease-worker-test': {
          leaseId: 'lease-worker-test',
          pool: 'gemini',
          ticketId: 'T-WORKER',
          ownerToken: 'token-worker',
          orchestratorPid: deadOrchPid,
          orchestratorStartTime: 'dead_orch_start_time',
          workerPid: workerPid,
          workerStartTime: workerStartTime,
          leaseExpiryMs: Date.now() + 60000,
          heartbeatMs: Date.now(),
          state: 'ACTIVE',
        },
      },
    };
    writeV2State(v2);

    await reconcileLeases(dir);

    let alive = true;
    for (let i = 0; i < 20; i++) {
      if (!isProcessAlive(workerPid)) {
        alive = false;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(alive, false, 'worker process must be terminated when dead orchestrator lease is reclaimed');

    const v2After = readV2State();
    assert.equal(v2After.leases['lease-worker-test'].state, 'RECLAIMED');
    assert.equal(v2After.pools.gemini.inFlight, 0);
  } finally {
    if (worker && isProcessAlive(worker.pid)) {
      try { process.kill(worker.pid, 'SIGKILL'); } catch {}
    }
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('terminateWorkerTree: terminates active worker when dead orchestrator lease is encountered during acquireLease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-worker-acq-'));
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;

  let worker = null;
  try {
    process.env.AGB_POOLS_V2 = join(dir, 'v2.json');
    process.env.AGB_POOLS_LOCK = join(dir, 'shared.lock');

    worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    worker.unref();

    const workerPid = worker.pid;
    const workerStartTime = getProcessStartTime(workerPid);
    assert.ok(isProcessAlive(workerPid, workerStartTime));

    const deadOrchPid = 9999999;
    const v2 = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      pools: {
        gemini: { baseCap: 1, scaledCap: 1, inFlight: 1, reserved: 0 },
      },
      leases: {
        'lease-dead-orch': {
          leaseId: 'lease-dead-orch',
          pool: 'gemini',
          ticketId: 'T-DEAD',
          ownerToken: 'tok-dead',
          orchestratorPid: deadOrchPid,
          orchestratorStartTime: 'dead_orch_start',
          workerPid: workerPid,
          workerStartTime: workerStartTime,
          leaseExpiryMs: Date.now() + 60000,
          heartbeatMs: Date.now(),
          state: 'ACTIVE',
        },
      },
    };
    writeV2State(v2);

    const newLease = await acquireLease(dir, { pool: 'gemini-flash', ticketId: 'T-NEW' });
    assert.ok(newLease?.leaseId);

    let alive = true;
    for (let i = 0; i < 20; i++) {
      if (!isProcessAlive(workerPid)) {
        alive = false;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(alive, false, 'worker process must be killed during acquireLease dead-lease reclamation');
  } finally {
    if (worker && isProcessAlive(worker.pid)) {
      try { process.kill(worker.pid, 'SIGKILL'); } catch {}
    }
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('terminateWorkerTree and reconcileLeases: do not terminate worker process when workerStartTime is absent or unverifiable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-worker-unverified-'));
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;

  let worker = null;
  try {
    process.env.AGB_POOLS_V2 = join(dir, 'v2.json');
    process.env.AGB_POOLS_LOCK = join(dir, 'shared.lock');

    worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    worker.unref();

    const workerPid = worker.pid;
    const workerStartTime = getProcessStartTime(workerPid);
    assert.ok(isProcessAlive(workerPid, workerStartTime));

    // 1. Direct call to terminateWorkerTree without expectedStartTime must be a no-op
    terminateWorkerTree(workerPid, null);
    assert.ok(isProcessAlive(workerPid, workerStartTime), 'worker must remain alive when terminateWorkerTree is called with null expectedStartTime');
    terminateWorkerTree(workerPid, undefined);
    assert.ok(isProcessAlive(workerPid, workerStartTime), 'worker must remain alive when terminateWorkerTree is called with undefined expectedStartTime');

    // 2. Lease in v2 state has workerPid but workerStartTime is null (e.g. recycled PID or legacy persisted state)
    const deadOrchPid = 9999999;
    const v2 = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      pools: {
        gemini: { baseCap: 1, scaledCap: 1, inFlight: 1, reserved: 0 },
      },
      leases: {
        'lease-unverified-worker': {
          leaseId: 'lease-unverified-worker',
          pool: 'gemini',
          ticketId: 'T-UNVERIFIED',
          ownerToken: 'tok-unverified',
          orchestratorPid: deadOrchPid,
          orchestratorStartTime: 'dead_orch_start',
          workerPid: workerPid,
          workerStartTime: null, // missing start time
          leaseExpiryMs: Date.now() + 60000,
          heartbeatMs: Date.now(),
          state: 'ACTIVE',
        },
      },
    };
    writeV2State(v2);

    // Reconcile leases: lease must be marked RECLAIMED, but worker must NOT be killed
    await reconcileLeases(dir);

    const v2After = readV2State();
    assert.equal(v2After.leases['lease-unverified-worker'].state, 'RECLAIMED');
    assert.equal(v2After.pools.gemini.inFlight, 0);

    // Worker must still be alive!
    assert.ok(isProcessAlive(workerPid, workerStartTime), 'worker process must not be killed when workerStartTime is absent');
  } finally {
    if (worker && isProcessAlive(worker.pid)) {
      try { process.kill(worker.pid, 'SIGKILL'); } catch {}
    }
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock: atomic stale lock reclamation does not delete live lock acquired by concurrent reclaimer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stale-reclaim-race-'));
  const lockFile = join(dir, 'test.lock');

  try {
    // 1. Write dead lock
    writeFileSync(lockFile, JSON.stringify({ pid: 9999999, token: 'dead-lock-token', ts: Date.now() - 60000 }), 'utf8');

    // 2. Process A reclaims and holds a new live lock
    let lockAHeld = false;
    let lockAFinished = false;
    const holdLockPromise = withLock(lockFile, async () => {
      lockAHeld = true;
      while (!lockAFinished) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return 'holder_a_done';
    });

    // Wait until Process A acquired lock
    while (!lockAHeld) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Lock file is now held by Process A (our current process).
    // Attempting to acquire the lock from another concurrent caller must timeout and NOT delete Process A's live lock.
    await assert.rejects(
      async () => withLock(lockFile, async () => 'should_fail', { timeoutMs: 100, retryMs: 20 }),
      /Timeout acquiring lock/
    );

    // Verify Process A's lock is still intact and holding
    assert.ok(existsSync(lockFile), 'lockFile must still exist');
    const cur = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.equal(cur.pid, process.pid);

    lockAFinished = true;
    const resA = await holdLockPromise;
    assert.equal(resA, 'holder_a_done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainPools: clears active legacy fleet state and successfully sets DRAINING without throwing LegacyFleetActiveError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-drain-legacy-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;
  try {
    process.env.AGB_QUOTA_STATE = join(dir, 'test_quota.json');
    const legacyFile = getStateFile();
    // Seed active legacy fleet in flight
    writeFileSync(legacyFile, JSON.stringify({
      activeSchemaVersion: 1,
      inFlight: { gemini: 2, claude_gpt: 1 },
      12345: { inFlight: { gemini: 2 }, ts: Date.now() },
    }), 'utf8');

    // Before drainPools, readV2State() throws LegacyFleetActiveError
    assert.throws(() => readV2State(), /LegacyFleetActiveError/);

    // drainPools must bypass assertNoActiveLegacyFleet, clear legacy file, and succeed
    const res = await drainPools(dir, { gracePeriodMs: 50 });
    assert.equal(res.ok, true);

    // After drainPools, legacy file is tombstoned and readV2State does not throw
    const v2 = readV2State();
    assert.equal(v2.status, 'ACTIVE');
    assert.equal(v2.pools.gemini.inFlight, 0);

    const legacyState = JSON.parse(readFileSync(legacyFile, 'utf8'));
    assert.equal(legacyState.inFlight.gemini, 0);
    assert.equal(legacyState.inFlight.claude_gpt, 0);
  } finally {
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = savedState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainPools: terminates active legacy processes and blocks coordinators with draining marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-drain-live-legacy-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;

  const dummyLegacy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    process.env.AGB_QUOTA_STATE = join(dir, 'test_quota.json');
    const legacyFile = getStateFile();

    // 1. Draining marker alone blocks admission even if inFlight is 0
    writeFileSync(legacyFile, JSON.stringify({
      activeSchemaVersion: 1,
      status: 'DRAINING',
      draining: true,
      inFlight: { gemini: 0, claude_gpt: 0 },
    }), 'utf8');
    assert.throws(() => assertNoActiveLegacyFleet(), /Fleet is currently DRAINING/i);

    // 2. Seed active legacy process with alive PID and verified startTime
    writeFileSync(legacyFile, JSON.stringify({
      activeSchemaVersion: 1,
      inFlight: { gemini: 1, claude_gpt: 0 },
      [dummyLegacy.pid]: { inFlight: { gemini: 1 }, ts: Date.now(), startTime: getProcessStartTime(dummyLegacy.pid) },
    }), 'utf8');

    assert.equal(isProcessAlive(dummyLegacy.pid), true);
    assert.throws(() => readV2State(), /LegacyFleetActiveError/);

    // 3. drainPools terminates the legacy process and tombstones cleanly
    const res = await drainPools(dir, { gracePeriodMs: 100 });
    assert.equal(res.ok, true);

    // Dummy process is now dead
    assert.equal(isProcessAlive(dummyLegacy.pid), false);

    // After drain, admission is restored and state is clean
    const v2 = readV2State();
    assert.equal(v2.status, 'ACTIVE');

    const legacyState = JSON.parse(readFileSync(legacyFile, 'utf8'));
    assert.equal(legacyState.status, undefined);
    assert.equal(legacyState.inFlight.gemini, 0);
  } finally {
    try { dummyLegacy.kill('SIGKILL'); } catch {}
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = savedState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertNoActiveLegacyFleet: live legacy worker remains blocked even if timestamp is older than 60s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-legacy-ttl-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;

  const dummyLegacy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    process.env.AGB_QUOTA_STATE = join(dir, 'test_quota.json');
    const legacyFile = getStateFile();

    // Timestamp is older than 60s, but process is still alive and has inFlight > 0
    writeFileSync(legacyFile, JSON.stringify({
      activeSchemaVersion: 1,
      inFlight: { gemini: 1 },
      [dummyLegacy.pid]: { inFlight: { gemini: 1 }, ts: Date.now() - 120000, startTime: getProcessStartTime(dummyLegacy.pid) },
    }), 'utf8');

    assert.equal(isProcessAlive(dummyLegacy.pid), true);
    assert.throws(() => assertNoActiveLegacyFleet(), /LegacyFleetActiveError/);
  } finally {
    try { dummyLegacy.kill('SIGKILL'); } catch {}
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = savedState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeV2State: clears stale v2Mirror entries when leases terminate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v2mirror-cleanup-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;
  try {
    process.env.AGB_QUOTA_STATE = join(dir, 'test_quota.json');
    const legacyFile = getStateFile();

    // Pre-populate shared legacy file with a stale v2Mirror from a previous lease run
    writeFileSync(legacyFile, JSON.stringify({
      activeSchemaVersion: 1,
      '99999': { ts: Date.now(), inFlight: { 'gemini-flash': 2 }, v2Mirror: true },
      '88888': { ts: Date.now(), inFlight: { gemini: 1 } }, // real legacy entry
    }), 'utf8');

    // Call writeV2State with no active leases for 99999
    const v2 = {
      schemaVersion: 2,
      generation: 1,
      status: 'ACTIVE',
      pools: { gemini: { inFlight: 0, reserved: 0 }, claude_gpt: { inFlight: 0, reserved: 0 } },
      leases: {},
    };
    writeV2State(v2);

    const updated = JSON.parse(readFileSync(legacyFile, 'utf8'));
    // Stale v2Mirror 99999 must have been stripped
    assert.equal(updated['99999'], undefined, 'stale v2Mirror entry must be removed');
    // Real legacy entry 88888 must be preserved
    assert.ok(updated['88888'], 'non-mirror legacy entry must be preserved');
  } finally {
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = savedState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainPools: rechecks PID identity and does not signal target if PID exited before signal loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-drain-pid-reuse-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;
  const savedV2 = process.env.AGB_POOLS_V2;

  try {
    process.env.AGB_QUOTA_STATE = join(dir, 'test_quota.json');
    process.env.AGB_POOLS_V2 = join(dir, 'test_quota_v2.json');

    // Dummy process that exits immediately
    const shortLived = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((r) => shortLived.on('exit', r));

    // Seed v2 state with this dead PID as an active lease orchestrator
    const v2State = {
      schemaVersion: 2,
      generation: 1,
      status: 'ACTIVE',
      pools: { gemini: { inFlight: 1, reserved: 0 }, claude_gpt: { inFlight: 0, reserved: 0 } },
      leases: {
        'lease-dead': {
          id: 'lease-dead',
          state: 'ACTIVE',
          pool: 'gemini',
          modelPool: 'gemini-flash',
          orchestratorPid: shortLived.pid,
          orchestratorStartTime: 12345678, // stale start time
          leaseExpiryMs: Date.now() + 60000,
        },
      },
    };
    writeFileSync(process.env.AGB_POOLS_V2, JSON.stringify(v2State), 'utf8');

    // drainPools should handle this cleanly without throwing or crashing
    const res = await drainPools(dir, { gracePeriodMs: 50 });
    assert.equal(res.ok, true);
    const finalV2 = readV2State();
    assert.equal(finalV2.leases['lease-dead'].state, 'RECLAIMED');
  } finally {
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = savedState;
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2;
    else process.env.AGB_POOLS_V2 = savedV2;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainPools: does not signal legacy PID when record lacks startTime identity (fails closed against PID reuse)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-drain-no-identity-test-'));
  const savedState = process.env.AGB_QUOTA_STATE;

  const dummyLegacy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    process.env.AGB_QUOTA_STATE = join(dir, 'test_quota.json');
    const legacyFile = getStateFile();

    // Legacy record exists for dummyLegacy.pid, but has NO startTime recorded
    writeFileSync(legacyFile, JSON.stringify({
      activeSchemaVersion: 1,
      inFlight: { gemini: 1, claude_gpt: 0 },
      [dummyLegacy.pid]: { inFlight: { gemini: 1 }, ts: Date.now() },
    }), 'utf8');

    assert.equal(isProcessAlive(dummyLegacy.pid), true);

    // drainPools must fail closed and NOT terminate dummyLegacy
    const res = await drainPools(dir, { gracePeriodMs: 50 });
    assert.equal(res.ok, true);

    // Dummy process must still be alive!
    assert.equal(isProcessAlive(dummyLegacy.pid), true, 'process without recorded startTime must NOT be killed');
  } finally {
    try { dummyLegacy.kill('SIGKILL'); } catch {}
    if (savedState === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = savedState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLockSync and withLock: do not retry callback errors with code EEXIST as lock contention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-lock-cb-err-'));
  const lockFile = join(dir, 'test.lock');

  try {
    let syncCalls = 0;
    assert.throws(
      () => withLockSync(lockFile, () => {
        syncCalls++;
        const err = new Error('simulated callback EEXIST');
        err.code = 'EEXIST';
        throw err;
      }, { timeoutMs: 50, retryMs: 2 }),
      (err) => err.message === 'simulated callback EEXIST' && err.code === 'EEXIST'
    );
    assert.equal(syncCalls, 1, 'withLockSync must invoke callback exactly once without retrying on EEXIST');

    let asyncCalls = 0;
    await assert.rejects(
      async () => await withLock(lockFile, async () => {
        asyncCalls++;
        const err = new Error('simulated async callback EEXIST');
        err.code = 'EEXIST';
        throw err;
      }, { timeoutMs: 50, retryMs: 2 }),
      (err) => err.message === 'simulated async callback EEXIST' && err.code === 'EEXIST'
    );
    assert.equal(asyncCalls, 1, 'withLock must invoke callback exactly once without retrying on EEXIST');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});



// --- T-QUOTA-PROBE-AGY-JSON: the real agy 1.3.1 `/quota --output-format json` envelope ---
const QUOTA_FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const iso = (s) => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Shape captured from agy 1.3.1 (descriptions trimmed).
function envelope({ gemini = {}, claude = {}, status = 'SUCCESS' } = {}) {
  const bucket = (id, window, fraction, reset) => ({ id, name: `${window} limit`, window, remaining_fraction: fraction, reset_time: reset });
  return {
    conversation_id: '', status, response: 'Gemini Models\tWeekly Limit Remaining\t98%\t...\n',
    command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: gemini.buckets ?? [bucket('gemini-weekly', 'weekly', 0.9814785122871399, iso(86400 * 4)), bucket('gemini-5h', '5h', 1, iso(3600))] },
      { name: 'Claude and GPT models', buckets: claude.buckets ?? [bucket('3p-weekly', 'weekly', 0.5, iso(86400 * 7)), bucket('3p-5h', '5h', 0.25, iso(3600))] },
    ] } },
  };
}
const parse = (o) => parseQuotaProbeOutput(JSON.stringify(o));

test('agy envelope: maps groups/buckets onto the pool windows, fraction -> percent', () => {
  const q = parse(envelope());
  assert.equal(q.gemini.weeklyRemainingPercent, 98.14785122871399);
  assert.equal(q.gemini.fiveHourRemainingPercent, 100);
  assert.equal(q.claude_gpt.weeklyRemainingPercent, 50);
  assert.equal(q.claude_gpt.fiveHourRemainingPercent, 25);
  assert.match(q.gemini.fiveHourResetTime, /Z$/);
  assert.equal(q['claude-gpt'], q.claude_gpt);
});

test('agy envelope: the 1.3.1 plain-text table is rejected, not guessed at', () => {
  const tsv = 'Gemini Models\tWeekly Limit Remaining\t98%\t2026-10-11T20:22:21Z\n';
  assert.throws(() => parseQuotaProbeOutput(tsv), (e) => e.kind === 'quota_parse_failure');
});

test('agy envelope: a non-SUCCESS status or missing groups fails closed', () => {
  assert.throws(() => parse(envelope({ status: 'ERROR' })), (e) => e.kind === 'quota_parse_failure' && /status/.test(e.message));
  const noGroups = envelope();
  noGroups.command.data = {};
  assert.throws(() => parse(noGroups), (e) => e.kind === 'quota_parse_failure' && /groups/.test(e.message));
});

test('agy envelope: group cardinality and names keep the ambiguous_quota_pools rule', () => {
  const one = envelope();
  one.command.data.groups.pop();
  assert.throws(() => parse(one), (e) => e.kind === 'ambiguous_quota_pools');
  const renamed = envelope();
  renamed.command.data.groups[1].name = 'Other';
  assert.throws(() => parse(renamed), (e) => e.kind === 'ambiguous_quota_pools');
});

test('agy envelope: a missing or duplicated window fails closed', () => {
  const b = (window) => ({ window, remaining_fraction: 1, reset_time: iso(3600) });
  assert.throws(() => parse(envelope({ gemini: { buckets: [b('weekly')] } })), (e) => e.kind === 'quota_parse_failure' && /5h/.test(e.message));
  assert.throws(() => parse(envelope({ gemini: { buckets: [b('weekly'), b('5h'), b('5h')] } })), (e) => e.kind === 'quota_parse_failure' && /5h/.test(e.message));
  assert.throws(() => parse(envelope({ claude: { buckets: 'nope' } })), (e) => e.kind === 'quota_parse_failure');
});

test('agy envelope: remaining_fraction must be a finite number in [0, 1]', () => {
  for (const bad of [1.01, -0.01, '0.5', null, Number.NaN]) {
    const buckets = [{ window: 'weekly', remaining_fraction: 1, reset_time: iso(86400) }, { window: '5h', remaining_fraction: bad, reset_time: iso(3600) }];
    assert.throws(() => parse(envelope({ gemini: { buckets } })), (e) => e.kind === 'invalid_quota_percentage', String(bad));
  }
  const edge = [{ window: 'weekly', remaining_fraction: 0, reset_time: iso(86400) }, { window: '5h', remaining_fraction: 1, reset_time: iso(3600) }];
  assert.equal(parse(envelope({ gemini: { buckets: edge } })).gemini.weeklyRemainingPercent, 0);
});

test('agy envelope: reset_time goes through the strict RFC 3339 UTC + future check', () => {
  const buckets = [{ window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-11T20:22:21+02:00' }, { window: '5h', remaining_fraction: 1, reset_time: iso(3600) }];
  assert.throws(() => parse(envelope({ gemini: { buckets } })), (e) => e.kind === 'invalid_quota_timestamp');
  const past = [{ window: 'weekly', remaining_fraction: 1, reset_time: '2020-01-01T00:00:00Z' }, { window: '5h', remaining_fraction: 1, reset_time: iso(3600) }];
  assert.throws(() => parse(envelope({ gemini: { buckets: past } })), (e) => e.kind === 'invalid_quota_timestamp');
});

test('probeQuota asks agy for --output-format json (fake-agy prints the real text table otherwise)', async () => {
  const q = await probeQuota(QUOTA_FAKE_AGY);
  assert.equal(q.gemini.fiveHourRemainingPercent, 100);
  assert.equal(typeof q.claude_gpt.weeklyRemainingPercent, 'number');
});

test('agy envelope: a half-envelope (status only, or command only) is judged as an envelope', () => {
  assert.throws(() => parseQuotaProbeOutput(JSON.stringify({ status: 'SUCCESS' })), (e) => e.kind === 'quota_parse_failure' && /command\.data\.groups/.test(e.message));
  const { status, ...noStatus } = envelope();
  assert.throws(() => parse(noStatus), (e) => e.kind === 'quota_parse_failure' && /status is not SUCCESS/.test(e.message));
});

test('agy envelope: a null bucket or an unmodelled window fails closed', () => {
  const ok = [{ window: 'weekly', remaining_fraction: 1, reset_time: iso(86400) }, { window: '5h', remaining_fraction: 1, reset_time: iso(3600) }];
  assert.throws(() => parse(envelope({ gemini: { buckets: [...ok, null] } })), (e) => e.kind === 'quota_parse_failure' && /unrecognized bucket window/.test(e.message));
  assert.throws(() => parse(envelope({ claude: { buckets: [...ok, { window: 'daily', remaining_fraction: 0, reset_time: iso(60) }] } })), (e) => e.kind === 'quota_parse_failure' && /"daily"/.test(e.message));
});

test('probeQuota: a hung agy is killed at the timeout and reported as a probe failure', async () => {
  const saved = process.env.FAKE_AGY_QUOTA_MODE;
  process.env.FAKE_AGY_QUOTA_MODE = 'hang';
  try {
    const started = Date.now();
    await assert.rejects(probeQuota(QUOTA_FAKE_AGY, { timeoutMs: 300 }), (e) => e.kind === 'quota_probe_failure');
    assert.ok(Date.now() - started < 4000, 'the probe must not wait for the hung agy to finish');
  } finally {
    if (saved === undefined) delete process.env.FAKE_AGY_QUOTA_MODE; else process.env.FAKE_AGY_QUOTA_MODE = saved;
  }
});

test('probeQuota: with no binary argument it uses AGB_AGY_BIN', async () => {
  const saved = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = QUOTA_FAKE_AGY;
  try {
    assert.equal((await probeQuota()).gemini.weeklyRemainingPercent, 100);
  } finally {
    if (saved === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = saved;
  }
});

test('withLockSync and withLock: timeout measures lock waiting only, not the start-time lookup (T-MACOS-TIMING-FIXES)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-lock-slow-start-'));
  const lockFile = join(dir, 'test.lock');
  // Simulates darwin's ps shell-out being slower than the whole lock budget.
  const slowLookup = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    return 'slow-start';
  };
  try {
    let sawStart = null;
    const syncResult = withLockSync(lockFile, () => {
      sawStart = JSON.parse(readFileSync(lockFile, 'utf8')).startTime;
      return 'sync-ok';
    }, { timeoutMs: 50, retryMs: 2, startTimeLookup: slowLookup });
    assert.equal(syncResult, 'sync-ok');
    assert.equal(sawStart, 'slow-start');

    const asyncResult = await withLock(lockFile, async () => 'async-ok', { timeoutMs: 50, retryMs: 2, startTimeLookup: slowLookup });
    assert.equal(asyncResult, 'async-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeQuota and refreshQuota default to defaultAgyBin() via resolveAgyBinary()', () => {
  const src = readFileSync(new URL('../lib/pools.mjs', import.meta.url), 'utf8');
  assert.match(src, /function defaultAgyBin\(\)/);
  assert.match(src, /resolveAgyBinary\(\)/);
  assert.match(src, /probeQuota\(agyBin = defaultAgyBin\(\)/);
  assert.match(src, /refreshQuota\(agyBin = defaultAgyBin\(\)/);
});

test('withLock + withLockSync: synchronous withLock callback releases lock in the same tick without self-deadlocking concurrent withLockSync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-lock-same-tick-'));
  const lockFile = join(dir, 'shared.lock');
  try {
    const t0 = Date.now();
    const results = await Promise.all([
      withLock(lockFile, () => 'lease-1', { timeoutMs: 250 }),
      Promise.resolve().then(() => withLockSync(lockFile, () => 'sync-state', { timeoutMs: 250 })),
      withLock(lockFile, () => 'lease-2', { timeoutMs: 250 }),
    ]);
    assert.deepEqual(results, ['lease-1', 'sync-state', 'lease-2']);
    assert.ok(Date.now() - t0 < 200, 'must not block event loop in Atomics.wait');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeQuota: isolates child in ephemeral readonly .agb_home with empty mcpServers and cleans up after success and failure', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agb-quota-iso-'));
  const fakeUserHome = join(workDir, 'user-home');
  const captureFile = join(workDir, 'capture.json');
  const stubBin = join(workDir, 'quota-stub.mjs');
  const savedEnv = {
    AGB_HOME_DIR: process.env.AGB_HOME_DIR,
    AGB_ALLOW_CODEGRAPH_MCP: process.env.AGB_ALLOW_CODEGRAPH_MCP,
    AGB_WORKER_TICKET: process.env.AGB_WORKER_TICKET,
    FAKE_QUOTA_FAIL: process.env.FAKE_QUOTA_FAIL,
  };
  try {
    // Seed a host ~/.gemini with canary MCP servers that must never leak into probeQuota
    mkdirSync(join(fakeUserHome, '.gemini', 'config'), { recursive: true });
    const hostMcp = JSON.stringify({
      mcpServers: {
        codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
        canary: { command: 'canary-mcp', args: [] },
      },
    });
    writeFileSync(join(fakeUserHome, '.gemini', 'mcp_config.json'), hostMcp);
    writeFileSync(join(fakeUserHome, '.gemini', 'config', 'mcp_config.json'), hostMcp);

    const reset5h = futureIso(3600);
    const resetWk = futureIso(86400 * 7);
    writeFileSync(
      stubBin,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const geminiMcp = JSON.parse(readFileSync(join(home, '.gemini', 'mcp_config.json'), 'utf8'));
const configMcp = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  HOME: home,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AGB_USER_HOME: process.env.AGB_USER_HOME,
  AGB_WORKER_MODE: process.env.AGB_WORKER_MODE,
  AGB_WORKER_TICKET: process.env.AGB_WORKER_TICKET ?? null,
  geminiMcp,
  configMcp,
}));
if (process.env.FAKE_QUOTA_FAIL === '1') {
  process.exit(1);
}
console.log(JSON.stringify({
  pools: [
    { name: 'Gemini Models', fiveHour: { remainingPercent: 90, resetTime: ${JSON.stringify(reset5h)} }, weekly: { remainingPercent: 95, resetTime: ${JSON.stringify(resetWk)} } },
    { name: 'Claude and GPT models', fiveHour: { remainingPercent: 80, resetTime: ${JSON.stringify(reset5h)} }, weekly: { remainingPercent: 85, resetTime: ${JSON.stringify(resetWk)} } },
  ],
}));
`,
      { mode: 0o755 }
    );

    process.env.AGB_HOME_DIR = fakeUserHome;
    process.env.AGB_ALLOW_CODEGRAPH_MCP = '1';
    process.env.AGB_WORKER_TICKET = 'STALE-TICKET';
    delete process.env.FAKE_QUOTA_FAIL;

    const q = await probeQuota(stubBin);
    assert.equal(q.gemini.fiveHourRemainingPercent, 90);
    assert.equal(q.claude_gpt.fiveHourRemainingPercent, 80);

    const seen = JSON.parse(readFileSync(captureFile, 'utf8'));
    assert.notEqual(seen.HOME, fakeUserHome, 'probeQuota must not inherit host HOME');
    assert.match(seen.HOME, /agb-ro-[^/\\]+[/\\]\.agb_home$/, 'probeQuota must stage ephemeral agb-ro-* .agb_home');
    assert.equal(seen.XDG_CONFIG_HOME, join(seen.HOME, '.config'));
    assert.equal(seen.AGB_USER_HOME, fakeUserHome);
    assert.equal(seen.AGB_WORKER_MODE, 'readonly');
    assert.equal(seen.AGB_WORKER_TICKET, null, 'probeQuota must scrub inherited AGB_WORKER_TICKET');
    assert.deepEqual(seen.geminiMcp, { mcpServers: {} });
    assert.deepEqual(seen.configMcp, { mcpServers: {} });
    assert.equal(existsSync(seen.HOME), false, 'ephemeral .agb_home must be cleaned up after success');

    // Also verify cleanup happens when the agy binary fails
    process.env.FAKE_QUOTA_FAIL = '1';
    await assert.rejects(probeQuota(stubBin), (e) => e.kind === 'quota_probe_failure');
    const seenFail = JSON.parse(readFileSync(captureFile, 'utf8'));
    assert.notEqual(seenFail.HOME, seen.HOME, 'each probeQuota invocation must use a fresh ephemeral dir');
    assert.equal(existsSync(seenFail.HOME), false, 'ephemeral .agb_home must be cleaned up after failure');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(workDir, { recursive: true, force: true });
  }
});

// --- T-NG-2: Lock-Free Live StatusLine Quota Cache & PoolSet.refreshQuota ---

function sampleNormalizedQuota({
  g5h = 80,
  gWeekly = 90,
  c5h = 60,
  cWeekly = 75,
  resetOffsetSec = 3600,
  baseNowMs = Date.now(),
} = {}) {
  const reset = new Date(baseNowMs + resetOffsetSec * 1000).toISOString();
  const claude = {
    fiveHourRemainingPercent: c5h,
    fiveHourResetTime: reset,
    weeklyRemainingPercent: cWeekly,
    weeklyResetTime: reset,
  };
  return {
    gemini: {
      fiveHourRemainingPercent: g5h,
      fiveHourResetTime: reset,
      weeklyRemainingPercent: gWeekly,
      weeklyResetTime: reset,
    },
    claude_gpt: claude,
    'claude-gpt': { ...claude },
  };
}

test('writeStatusLineQuotaCache & readFreshStatusLineQuotaCache: atomic 0o600 write, 15s / <2% throttling, and validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sl-quota-'));
  const savedFile = process.env.AGB_STATUSLINE_QUOTA_FILE;
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  try {
    process.env.AGB_POOLS_DIR = dir;
    const cachePath = join(dir, 'custom_statusline_quota.json');
    process.env.AGB_STATUSLINE_QUOTA_FILE = cachePath;
    assert.equal(getStatusLineQuotaFile(), cachePath);

    const t0 = Date.now();
    const q1 = sampleNormalizedQuota({ g5h: 80, gWeekly: 90, c5h: 60, cWeekly: 75, baseNowMs: t0 });

    // 1. Initial write succeeds with 0o600 permissions and zero lock file creation
    assert.equal(writeStatusLineQuotaCache(q1, { nowMs: t0 }), true);
    assert.equal(existsSync(cachePath), true);
    assert.equal(existsSync(getLockFile()), false, 'writeStatusLineQuotaCache must never touch getLockFile()');
    if (process.platform !== 'win32') {
      assert.equal(statSync(cachePath).mode & 0o777, 0o600);
    }

    // 2. Within 15s and all 4 deltas < 2.0 -> throttled (returns false, updatedAt unchanged)
    const qSmallDelta = sampleNormalizedQuota({
      g5h: 78.5,
      gWeekly: 88.2,
      c5h: 61.9,
      cWeekly: 73.1,
      baseNowMs: t0 + 5_000,
    });
    assert.equal(writeStatusLineQuotaCache(qSmallDelta, { nowMs: t0 + 5_000 }), false);
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: t0 + 5_000 }).updatedAt, t0);

    // 3. Within 15s but one window changes by >= 2.0 -> writes immediately
    const qBigDelta = sampleNormalizedQuota({
      g5h: 80,
      gWeekly: 90,
      c5h: 58.0, // delta == 2.0
      cWeekly: 75,
      baseNowMs: t0 + 7_000,
    });
    assert.equal(writeStatusLineQuotaCache(qBigDelta, { nowMs: t0 + 7_000 }), true);
    const readBack = readFreshStatusLineQuotaCache({ nowMs: t0 + 8_000 });
    assert.equal(readBack.updatedAt, t0 + 7_000);
    assert.equal(readBack.quota.claude_gpt.fiveHourRemainingPercent, 58.0);
    assert.equal(readBack.quota['claude-gpt'].fiveHourRemainingPercent, 58.0);

    // 4. After >= 15s even with 0% delta -> writes fresh timestamp
    assert.equal(writeStatusLineQuotaCache(qBigDelta, { nowMs: t0 + 22_000 }), true);
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: t0 + 22_500 }).updatedAt, t0 + 22_000);

    // 5. Stale (> maxAgeMs) and future-skewed (> nowMs + 10_000) return null
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: t0 + 22_000 + 60_001, maxAgeMs: 60_000 }), null);
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: t0 + 22_000 - 15_000, maxAgeMs: 60_000 }), null);

    // 6. Rejects out-of-range percentages and expired/non-UTC reset timestamps
    const badPct = sampleNormalizedQuota({ g5h: 105, baseNowMs: t0 });
    assert.equal(writeStatusLineQuotaCache(badPct, { nowMs: t0 + 40_000 }), false);
    const badTs = sampleNormalizedQuota({ baseNowMs: t0 });
    badTs.gemini.fiveHourResetTime = new Date(t0 - 20_000).toISOString();
    assert.equal(writeStatusLineQuotaCache(badTs, { nowMs: t0 }), false);
  } finally {
    if (savedFile === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    else process.env.AGB_STATUSLINE_QUOTA_FILE = savedFile;
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR;
    else process.env.AGB_POOLS_DIR = savedPoolsDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStatusLineQuotaCache & readFreshStatusLineQuotaCache: rejects symlinks and honors __AGB_BUNDLED__ env ignore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sl-symlink-'));
  const extDir = mkdtempSync(join(tmpdir(), 'agb-sl-ext-'));
  const savedFile = process.env.AGB_STATUSLINE_QUOTA_FILE;
  const savedV2 = process.env.AGB_POOLS_V2;
  const prevBundled = globalThis.__AGB_BUNDLED__;
  try {
    const v2Path = join(dir, 'agb_pools_v2.json');
    process.env.AGB_POOLS_V2 = v2Path;

    // 1. Bundled mode ignores AGB_STATUSLINE_QUOTA_FILE and pool state env overrides
    process.env.AGB_STATUSLINE_QUOTA_FILE = join(extDir, 'spoofed.json');
    globalThis.__AGB_BUNDLED__ = true;
    assert.equal(getStatusLineQuotaFile(), join(tmpdir(), 'agb_statusline_quota.json'));
    assert.equal(getV2StateFile(), join(tmpdir(), 'agb_pools_v2.json'));
    globalThis.__AGB_BUNDLED__ = false;
    assert.equal(getStatusLineQuotaFile(), join(extDir, 'spoofed.json'));
    assert.equal(getV2StateFile(), v2Path);

    // 2. Symlinked target file rejected on both write and read
    const victim = join(extDir, 'victim.json');
    writeFileSync(victim, '{"untouched":true}', 'utf8');
    const symFile = join(dir, 'sym_quota.json');
    symlinkSync(victim, symFile);
    process.env.AGB_STATUSLINE_QUOTA_FILE = symFile;

    const q = sampleNormalizedQuota();
    assert.equal(writeStatusLineQuotaCache(q), false);
    assert.equal(readFreshStatusLineQuotaCache(), null);
    assert.equal(readFileSync(victim, 'utf8'), '{"untouched":true}');

    // 3. Symlinked parent directory rejected
    const symDir = join(dir, 'sym_parent');
    symlinkSync(extDir, symDir, 'dir');
    process.env.AGB_STATUSLINE_QUOTA_FILE = join(symDir, 'nested_quota.json');
    assert.equal(writeStatusLineQuotaCache(q), false);
    assert.equal(readFreshStatusLineQuotaCache(), null);
  } finally {
    if (prevBundled === undefined) delete globalThis.__AGB_BUNDLED__;
    else globalThis.__AGB_BUNDLED__ = prevBundled;
    if (savedFile === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    else process.env.AGB_STATUSLINE_QUOTA_FILE = savedFile;
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2;
    else process.env.AGB_POOLS_V2 = savedV2;
    rmSync(dir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  }
});

test('PoolSet.refreshQuota({ allowStatusCache: true }): lock-free cache hit succeeds even when agb_pools_shared.lock is held by another live PID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sl-lockfree-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  const savedQuota = process.env.AGB_QUOTA_STATE;
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;
  const savedSlFile = process.env.AGB_STATUSLINE_QUOTA_FILE;
  const savedIgnore = process.env.AGB_IGNORE_STATUS_QUOTA_CACHE;

  const lockHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    delete process.env.AGB_QUOTA_STATE;
    delete process.env.AGB_POOLS_V2;
    delete process.env.AGB_POOLS_LOCK;
    delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    delete process.env.AGB_IGNORE_STATUS_QUOTA_CACHE;
    process.env.AGB_POOLS_DIR = dir;

    // Hold agb_pools_shared.lock via live external process PID + verified startTime
    const lockFile = getLockFile();
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: lockHolder.pid,
        startTime: getProcessStartTime(lockHolder.pid),
        token: 'foreign-live-holder',
        ts: Date.now(),
      }),
      'utf8'
    );

    // Prove the lock is genuinely contested
    assert.throws(
      () => withLockSync(lockFile, () => 'unreachable', { timeoutMs: 40, retryMs: 10 }),
      /Timeout acquiring lock/
    );

    // Populate statusline quota cache while lock is held (zero lock contention!)
    const q = sampleNormalizedQuota({ g5h: 30, gWeekly: 80, c5h: 5, cWeekly: 60 });
    assert.equal(writeStatusLineQuotaCache(q), true);

    const pools = new PoolSet({ 'gemini-flash': 8, claude: 4 }, { repo: dir });
    // Queue a waiter on claude (which will drop to cap 0 because c5h == 5%)
    let abortedErr = null;
    pools.waiters.claude.push({
      resolve: () => {},
      reject: (e) => { abortedErr = e; },
    });

    const t0 = Date.now();
    const res = await pools.refreshQuota('/nonexistent/agy-must-not-run', { allowStatusCache: true });
    const elapsedMs = Date.now() - t0;

    assert.equal(res.ok, true);
    assert.equal(res.fromStatusCache, true);
    assert.ok(elapsedMs < 200, `refreshQuota from status cache must not wait on lock (took ${elapsedMs}ms)`);
    assert.equal(pools.caps['gemini-flash'], 6); // 30% -> 50% of base 12 = 6
    assert.equal(pools.caps.claude, 0); // 5% -> depleted -> 0
    assert.equal(pools.quota.paused, true);
    assert.equal(pools.quota.depletionCause, 'five_hour_depletion');
    assert.ok(abortedErr && abortedErr.kind === 'quota_depleted', 'waiter must be aborted when cap drops to 0');
    assert.equal(existsSync(getV2StateFile()), false, 'cache hit must not call writeV2State()');
  } finally {
    try { lockHolder.kill('SIGKILL'); } catch {}
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    if (savedQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = savedQuota;
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    if (savedSlFile === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE; else process.env.AGB_STATUSLINE_QUOTA_FILE = savedSlFile;
    if (savedIgnore === undefined) delete process.env.AGB_IGNORE_STATUS_QUOTA_CACHE; else process.env.AGB_IGNORE_STATUS_QUOTA_CACHE = savedIgnore;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PoolSet.refreshQuota({ allowStatusCache: true }): bypasses statusline cache on circuit breaker, quotaRefreshFailures > 0, stale cache, or AGB_IGNORE_STATUS_QUOTA_CACHE=1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sl-bypass-'));
  const savedPoolsDir = process.env.AGB_POOLS_DIR;
  const savedQuota = process.env.AGB_QUOTA_STATE;
  const savedV2 = process.env.AGB_POOLS_V2;
  const savedLock = process.env.AGB_POOLS_LOCK;
  const savedSlFile = process.env.AGB_STATUSLINE_QUOTA_FILE;
  const savedIgnore = process.env.AGB_IGNORE_STATUS_QUOTA_CACHE;

  try {
    delete process.env.AGB_QUOTA_STATE;
    delete process.env.AGB_POOLS_V2;
    delete process.env.AGB_POOLS_LOCK;
    delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    delete process.env.AGB_IGNORE_STATUS_QUOTA_CACHE;
    process.env.AGB_POOLS_DIR = dir;

    // Seed fresh statusline cache with distinct 40% gemini
    const qCached = sampleNormalizedQuota({ g5h: 40, gWeekly: 40, c5h: 80, cWeekly: 80 });
    assert.equal(writeStatusLineQuotaCache(qCached), true);

    // 1. In-memory circuitBreakerTripped bypasses cache and runs probe (failing probe keeps breaker tripped!)
    const pMemCb = new PoolSet(undefined, { repo: dir });
    pMemCb.circuitBreakerTripped = true;
    const rMemCb = await pMemCb.refreshQuota('/nonexistent/failing-agy', { allowStatusCache: true });
    assert.equal(rMemCb.ok, false);
    assert.equal(pMemCb.circuitBreakerTripped, true);

    // 2. On-disk v2.quotaState.circuitBreakerTripped === true bypasses cache even on fresh PoolSet
    const pDiskCb = new PoolSet(undefined, { repo: dir });
    const rDiskCb = await pDiskCb.refreshQuota(QUOTA_FAKE_AGY, { allowStatusCache: true });
    assert.equal(rDiskCb.ok, true);
    assert.equal(rDiskCb.fromStatusCache, undefined, 'must probe QUOTA_FAKE_AGY instead of using status cache');
    assert.equal(pDiskCb.quota.gemini.fiveHourRemainingPercent, 100); // QUOTA_FAKE_AGY reports 100%, not cached 40%

    // 3. On-disk v2.quotaState.quotaRefreshFailures > 0 (even if circuitBreakerTripped is false) bypasses cache
    const v2 = readV2State();
    v2.quotaState = { circuitBreakerTripped: false, quotaRefreshFailures: 1, updatedAt: Date.now() };
    writeV2State(v2);

    const pDiskFail = new PoolSet(undefined, { repo: dir });
    const rDiskFail = await pDiskFail.refreshQuota(QUOTA_FAKE_AGY, { allowStatusCache: true });
    assert.equal(rDiskFail.ok, true);
    assert.equal(rDiskFail.fromStatusCache, undefined);
    assert.equal(pDiskFail.quota.gemini.fiveHourRemainingPercent, 100);

    // Now V2 state is clean again -> allowStatusCache hits cache (40%)
    const pHealthy = new PoolSet(undefined, { repo: dir });
    const rHit = await pHealthy.refreshQuota(QUOTA_FAKE_AGY, { allowStatusCache: true });
    assert.equal(rHit.ok, true);
    assert.equal(rHit.fromStatusCache, true);
    assert.equal(pHealthy.quota.gemini.fiveHourRemainingPercent, 40);

    // 4. AGB_IGNORE_STATUS_QUOTA_CACHE=1 forces live probe
    process.env.AGB_IGNORE_STATUS_QUOTA_CACHE = '1';
    const rIgnored = await pHealthy.refreshQuota(QUOTA_FAKE_AGY, { allowStatusCache: true });
    assert.equal(rIgnored.ok, true);
    assert.equal(rIgnored.fromStatusCache, undefined);
    assert.equal(pHealthy.quota.gemini.fiveHourRemainingPercent, 100);
    delete process.env.AGB_IGNORE_STATUS_QUOTA_CACHE;

    // 5. Stale cache (> 60s old) falls through to probeQuota
    const staleNow = Date.now() - 65_000;
    writeFileSync(
      getStatusLineQuotaFile(),
      JSON.stringify({ updatedAt: staleNow, quota: qCached }),
      'utf8'
    );
    const rStale = await pHealthy.refreshQuota(QUOTA_FAKE_AGY, { allowStatusCache: true });
    assert.equal(rStale.ok, true);
    assert.equal(rStale.fromStatusCache, undefined);
  } finally {
    if (savedPoolsDir === undefined) delete process.env.AGB_POOLS_DIR; else process.env.AGB_POOLS_DIR = savedPoolsDir;
    if (savedQuota === undefined) delete process.env.AGB_QUOTA_STATE; else process.env.AGB_QUOTA_STATE = savedQuota;
    if (savedV2 === undefined) delete process.env.AGB_POOLS_V2; else process.env.AGB_POOLS_V2 = savedV2;
    if (savedLock === undefined) delete process.env.AGB_POOLS_LOCK; else process.env.AGB_POOLS_LOCK = savedLock;
    if (savedSlFile === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE; else process.env.AGB_STATUSLINE_QUOTA_FILE = savedSlFile;
    if (savedIgnore === undefined) delete process.env.AGB_IGNORE_STATUS_QUOTA_CACHE; else process.env.AGB_IGNORE_STATUS_QUOTA_CACHE = savedIgnore;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durableWriteJson: rejects symlinks, uses O_EXCL/O_NOFOLLOW + UUID temp paths, and cleans up on error (#168)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-durable-write-'));
  try {
    const victim = join(dir, 'victim.json');
    writeFileSync(victim, '{"untouched":true}', 'utf8');
    const symTarget = join(dir, 'sym.json');
    symlinkSync(victim, symTarget);
    assert.throws(() => durableWriteJson(symTarget, { pwned: true }), /symlink/i);
    assert.equal(readFileSync(victim, 'utf8'), '{"untouched":true}');

    const symDir = join(dir, 'symdir');
    symlinkSync(dir, symDir, 'dir');
    assert.throws(() => durableWriteJson(join(symDir, 'nested.json'), { pwned: true }), /symlink/i);

    // Captures O_EXCL | O_NOFOLLOW flags and UUID temp filename cleanly
    const seenFlags = [];
    const seenTemps = [];
    const realTarget = join(dir, 'captured.json');
    durableWriteJson(realTarget, { ok: 1 }, {
      openSyncFn: (p, flags, mode) => {
        if (String(p).includes('.tmp')) {
          seenTemps.push(p);
          seenFlags.push(flags);
        }
        return openSync(p, flags, mode);
      },
      fsyncSyncFn: () => {},
      closeSyncFn: () => {},
      writeFileSyncFn: () => {},
      renameSyncFn: () => {},
    });
    assert.equal(seenFlags[0], constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0));
    assert.match(seenTemps[0], /\.[0-9a-f-]{36}\.tmp$/);

    // writeFileSync failure unlinks temp file cleanly
    const writeFailTarget = join(dir, 'writefail.json');
    assert.throws(
      () =>
        durableWriteJson(writeFailTarget, { a: 1 }, {
          writeFileSyncFn: () => {
            throw new Error('simulated disk full');
          },
        }),
      /simulated disk full/,
    );
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('writefail.json.') && f.endsWith('.tmp')), []);

    // postDirStat TOCTOU symlink rejection
    let callCount = 0;
    assert.throws(
      () =>
        durableWriteJson(join(dir, 'toctou.json'), { a: 1 }, {
          lstatSyncFn: (p) => {
            const st = statSync(p);
            callCount += 1;
            const isSymDir = p === dir && callCount >= 2;
            return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
              isSymbolicLink: () => isSymDir,
              isDirectory: () => p === dir && !isSymDir,
              isFile: () => false,
            });
          },
        }),
      /symlink/i,
    );

    const failTarget = join(dir, 'fail.json');
    assert.throws(
      () =>
        durableWriteJson(failTarget, { a: 1 }, {
          renameSyncFn: () => {
            throw new Error('simulated rename failure');
          },
        }),
      /simulated rename failure/,
    );
    const leftoverTemps = readdirSync(dir).filter((f) => f.includes('fail.json.') && f.endsWith('.tmp'));
    assert.deepEqual(leftoverTemps, [], 'temp file must be unlinked on rename failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statusLine quota cache enforces POSIX uid and sticky-dir ownership on read and write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sl-uid-'));
  const savedSl = process.env.AGB_STATUSLINE_QUOTA_FILE;
  try {
    const file = join(dir, 'quota.json');
    process.env.AGB_STATUSLINE_QUOTA_FILE = file;
    const now = Date.now();
    const q = sampleNormalizedQuota();
    assert.equal(writeStatusLineQuotaCache(q, { nowMs: now }), true);
    assert.notEqual(readFreshStatusLineQuotaCache({ nowMs: now + 100 }), null);

    // 1. Sticky /tmp-like directory (uid 0, mode 0o1777) with user-owned cache file (uid 1000) PASSES for non-root uid 1000
    const stickyRootLstat = (p) => {
      const real = statSync(p);
      const isDir = p === dir;
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        uid: isDir ? 0 : 1000,
        mode: isDir ? 0o41777 : 0o100600,
        isSymbolicLink: () => false,
        isFile: () => p === file,
        isDirectory: () => isDir,
      });
    };
    assert.notEqual(readFreshStatusLineQuotaCache({ nowMs: now + 100, lstatSyncFn: stickyRootLstat, getuidFn: () => 1000 }), null);
    assert.equal(writeStatusLineQuotaCache(q, { nowMs: now + 20_000, lstatSyncFn: stickyRootLstat, getuidFn: () => 1000 }), true);

    // 2. Non-sticky foreign directory (uid 0, mode 0o755) is rejected even if file.uid === 1000
    const nonStickyLstat = (p) => {
      const real = statSync(p);
      const isDir = p === dir;
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        uid: isDir ? 0 : 1000,
        mode: isDir ? 0o40755 : 0o100600,
        isSymbolicLink: () => false,
        isFile: () => p === file,
        isDirectory: () => isDir,
      });
    };
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: now + 100, lstatSyncFn: nonStickyLstat, getuidFn: () => 1000 }), null);
    assert.equal(writeStatusLineQuotaCache(q, { nowMs: now + 20_000, lstatSyncFn: nonStickyLstat, getuidFn: () => 1000 }), false);

    // 3. Foreign-UID cache file in sticky dir rejects both read and overwrite
    const foreignLstat = (p) => {
      const real = statSync(p);
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        uid: 99999,
        mode: p === dir ? 0o41777 : 0o100600,
        isSymbolicLink: () => false,
        isFile: () => p === file,
        isDirectory: () => p === dir,
      });
    };
    assert.equal(readFreshStatusLineQuotaCache({ nowMs: now + 100, lstatSyncFn: foreignLstat, getuidFn: () => 1000 }), null);
    assert.equal(writeStatusLineQuotaCache(q, { nowMs: now + 20_000, lstatSyncFn: foreignLstat, getuidFn: () => 1000 }), false);
  } finally {
    if (savedSl === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE; else process.env.AGB_STATUSLINE_QUOTA_FILE = savedSl;
    rmSync(dir, { recursive: true, force: true });
  }
});

