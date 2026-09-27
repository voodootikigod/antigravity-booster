// Per-pool concurrency control + tier routing + quota coordination.
//
// Antigravity quota pools are independent (verified: 4 Gemini + 4 Claude
// concurrent with no mutual interference). The scheduler holds semaphores per pool,
// and routing spreads load across pools rather than queueing on one.
//
// Under ADLC P3/P4, this module coordinates dynamic scaling from upstream /quota
// telemetry, durable v2 lease state, parent-mediated heartbeats, PID reuse defense,
// bi-directional v0.7/v0.8 handoff, and coordinated pool draining.

import { MODELS, poolOf, familyOf } from './agy.mjs';
export { poolOf };
import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  rmSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileP = promisify(execFile);

export class LegacyFleetActiveError extends Error {
  constructor(
    message = "Active legacy (v0.7) fleet detected in agb_pools_shared.json. Concurrent execution of v0.7 and v0.8 coordinators is strictly prohibited. Wait for legacy workers to complete or run 'agb pool drain' before launching v0.8."
  ) {
    super(message);
    this.name = 'LegacyFleetActiveError';
    this.code = 'ERR_LEGACY_FLEET_ACTIVE';
  }
}

export class ActiveV2LeasesPresentError extends Error {
  constructor(
    message = "Cannot run older binary while v2 leases are active. Run 'agb pool drain' or wait for workers to complete."
  ) {
    super(message);
    this.name = 'ActiveV2LeasesPresentError';
    this.code = 'ERR_ACTIVE_V2_LEASES_PRESENT';
  }
}

export const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const LEASE_TTL_MS = 45_000;

export const BASE_CAPS = {
  gemini: 12,
  claude_gpt: 4,
  'claude-gpt': 4,
};

// Probed ceilings (docs/calibration/probe-2026-07-14.md). Gemini Flash
// can sustain 8 concurrent requests. GPT-OSS throttles above 2.
export const DEFAULT_CAPS = {
  'gemini-flash': 8,
  'gemini-pro': 4,
  claude: 4,
  'gpt-oss': 2,
};

// Role → tier → candidate models, cheapest-listed first. Cross-pool
// candidates let the router pick the least-loaded pool.
export const TIER_CANDIDATES = {
  cheap: [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
  ],
  mid: [
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-high',
    'gemini-3.1-pro-low',
  ],
  frontier: [
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
  ],
};

// Prosecutor must come from a different family than the builder (ADLC P5:
// fresh context + refute charter are primary, cross-model is the bonus).
export const PROSECUTORS = {
  gemini: 'gpt-oss-120b-medium',
  claude: 'gemini-3.1-pro-high',
  'gpt-oss': 'gemini-3.1-pro-high',
};

export function getStateFile() {
  if (process.env.AGB_QUOTA_STATE) return process.env.AGB_QUOTA_STATE;
  if (process.env.AGB_POOLS_DIR) return join(process.env.AGB_POOLS_DIR, 'agb_pools_shared.json');
  return join(tmpdir(), 'agb_pools_shared.json');
}

export function getV2StateFile() {
  if (process.env.AGB_POOLS_V2) return process.env.AGB_POOLS_V2;
  if (process.env.AGB_POOLS_DIR) return join(process.env.AGB_POOLS_DIR, 'agb_pools_v2.json');
  if (process.env.AGB_QUOTA_STATE) return process.env.AGB_QUOTA_STATE.replace(/\.json$/, '_v2.json');
  return join(tmpdir(), 'agb_pools_v2.json');
}

export function getLockFile() {
  if (process.env.AGB_POOLS_LOCK) return process.env.AGB_POOLS_LOCK;
  if (process.env.AGB_POOLS_DIR) return join(process.env.AGB_POOLS_DIR, 'agb_pools_shared.lock');
  if (process.env.AGB_QUOTA_STATE) return process.env.AGB_QUOTA_STATE.replace(/\.json$/, '.lock');
  return join(tmpdir(), 'agb_pools_shared.lock');
}

export function isProcessAlive(pid, expectedStartTime = null) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (expectedStartTime) {
    const curStart = getProcessStartTime(pid);
    if (!curStart || curStart !== expectedStartTime) {
      return false;
    }
  }
  return true;
}

export function getProcessStartTime(pid) {
  if (!pid || typeof pid !== 'number') return null;
  try {
    if (process.platform === 'linux') {
      const content = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = content.lastIndexOf(')');
      if (closeParen !== -1) {
        const rest = content.slice(closeParen + 2).trim().split(/\s+/);
        return rest[19] ?? null;
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || null;
    } else if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || null;
    }
  } catch {}
  return null;
}

export async function withLock(lockFile = getLockFile(), fn, { timeoutMs = 10000, retryMs = 25 } = {}) {
  const dir = dirname(lockFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const lockToken = `${process.pid}:${randomUUID()}`;
  const myStartTime = getProcessStartTime(process.pid);

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startTime: myStartTime, token: lockToken, ts: Date.now() }), 'utf8');
      closeSync(fd);
      try {
        return await fn();
      } finally {
        try {
          if (existsSync(lockFile)) {
            const raw = readFileSync(lockFile, 'utf8');
            const data = JSON.parse(raw);
            if (data.token === lockToken) {
              unlinkSync(lockFile);
            }
          }
        } catch {}
      }
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Inspect lock for dead holder or recycled PID
        try {
          const raw = readFileSync(lockFile, 'utf8');
          const data = JSON.parse(raw);
          const ownerAlive = typeof data?.pid === 'number' && data.pid > 0 && isProcessAlive(data.pid, data.startTime ?? null);
          if (!ownerAlive) {
            try { unlinkSync(lockFile); } catch {}
            continue;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, retryMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Timeout acquiring lock on ${lockFile} after ${timeoutMs}ms`);
}

export function withLockSync(lockFile = getLockFile(), fn, { timeoutMs = 5000, retryMs = 10 } = {}) {
  const dir = dirname(lockFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const lockToken = `${process.pid}:${randomUUID()}`;
  const myStartTime = getProcessStartTime(process.pid);

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startTime: myStartTime, token: lockToken, ts: Date.now() }), 'utf8');
      closeSync(fd);
      try {
        return fn();
      } finally {
        try {
          if (existsSync(lockFile)) {
            const raw = readFileSync(lockFile, 'utf8');
            const data = JSON.parse(raw);
            if (data.token === lockToken) {
              unlinkSync(lockFile);
            }
          }
        } catch {}
      }
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const raw = readFileSync(lockFile, 'utf8');
          const data = JSON.parse(raw);
          const ownerAlive = typeof data?.pid === 'number' && data.pid > 0 && isProcessAlive(data.pid, data.startTime ?? null);
          if (!ownerAlive) {
            try { unlinkSync(lockFile); } catch {}
            continue;
          }
        } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Timeout acquiring lock on ${lockFile} after ${timeoutMs}ms`);
}

function durableWriteJson(targetPath, data) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    try { fsyncSync(fd); } catch {}
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } catch {}
    closeSync(dirFd);
  } catch {}
}

export function readSharedState() {
  try {
    const file = getStateFile();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }
  } catch {}
  return {};
}

export function writeSharedState(state) {
  try {
    withLockSync(getLockFile(), () => {
      const file = getStateFile();
      const cur = readSharedState();
      const existing = cur[process.pid];
      const isV2 = existing?.v2Mirror || existing?.v2 || existing?.schemaVersion === 2 || state?.v2Mirror || state?.v2 || state?.schemaVersion === 2;
      cur[process.pid] = {
        ...existing,
        ...state,
        ...(isV2 ? { v2Mirror: true } : {}),
      };
      durableWriteJson(file, cur);
    });
  } catch {}
}

export function assertNoActiveLegacyFleet() {
  const file = getStateFile();
  if (!existsSync(file)) return;
  let shared;
  try {
    shared = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (!shared || typeof shared !== 'object') return;

  const now = Date.now();
  let legacyActive = false;
  if (shared.activeSchemaVersion !== 2 && shared.inFlight && typeof shared.inFlight === 'object') {
    for (const count of Object.values(shared.inFlight)) {
      if (Number(count) > 0) legacyActive = true;
    }
  }
  for (const [key, val] of Object.entries(shared)) {
    if (/^\d+$/.test(key) && key !== String(process.pid) && val && typeof val === 'object') {
      if (val.v2Mirror || val.v2 || val.schemaVersion === 2) {
        continue;
      }
      if (val.inFlight && typeof val.inFlight === 'object') {
        for (const count of Object.values(val.inFlight)) {
          if (Number(count) > 0 && (now - (val.ts || 0) < 60000)) {
            legacyActive = true;
          }
        }
      }
    }
  }
  if (legacyActive) {
    throw new LegacyFleetActiveError();
  }
}

export function readV2State() {
  assertNoActiveLegacyFleet();
  const v2File = getV2StateFile();
  if (existsSync(v2File)) {
    let data;
    try {
      data = JSON.parse(readFileSync(v2File, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read authoritative v2 state at ${v2File}: ${e.message}`);
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (!data.pools || typeof data.pools !== 'object' || Array.isArray(data.pools)) {
        data.pools = {
          gemini: { baseCap: 12, scaledCap: 12, effectivePercent: 100, inFlight: 0, reserved: 0 },
          claude_gpt: { baseCap: 4, scaledCap: 4, effectivePercent: 100, inFlight: 0, reserved: 0 },
        };
      } else {
        if (!data.pools.gemini) {
          data.pools.gemini = { baseCap: 12, scaledCap: 12, effectivePercent: 100, inFlight: 0, reserved: 0 };
        }
        if (!data.pools.claude_gpt) {
          data.pools.claude_gpt = { baseCap: 4, scaledCap: 4, effectivePercent: 100, inFlight: 0, reserved: 0 };
        }
      }
      if (!data.leases || typeof data.leases !== 'object' || Array.isArray(data.leases)) {
        data.leases = {};
      }
      if (!data.activeTickets || typeof data.activeTickets !== 'object' || Array.isArray(data.activeTickets)) {
        data.activeTickets = {};
      }
      if (!data.quotaState || typeof data.quotaState !== 'object' || Array.isArray(data.quotaState)) {
        data.quotaState = {
          quotaRefreshFailures: 0,
          lastSuccessfulRefresh: null,
          circuitBreakerTripped: false,
        };
      }
      if (typeof data.status !== 'string') {
        data.status = 'ACTIVE';
      }
      return data;
    }
  }
  return {
    generation: 1,
    status: 'ACTIVE',
    pools: {
      gemini: { baseCap: 12, scaledCap: 12, effectivePercent: 100, inFlight: 0, reserved: 0 },
      claude_gpt: { baseCap: 4, scaledCap: 4, effectivePercent: 100, inFlight: 0, reserved: 0 },
    },
    leases: {},
    activeTickets: {},
    quotaState: {
      quotaRefreshFailures: 0,
      lastSuccessfulRefresh: null,
      circuitBreakerTripped: false,
    },
  };
}

export function writeV2State(v2State) {
  v2State.generation = (v2State.generation || 0) + 1;
  durableWriteJson(getV2StateFile(), v2State);

  // Publish derivative read cache to agb_pools_shared.json while preserving per-process entries
  const cur = readSharedState();
  const perProcess = {};
  for (const [key, val] of Object.entries(cur)) {
    if (String(Number(key)) === key && val && typeof val === 'object') {
      perProcess[key] = val;
    }
  }

  // Also reflect active v2 leases into per-orchestrator inFlight counts so cross-process PoolSet instances see remote work
  for (const lease of Object.values(v2State.leases || {})) {
    if (lease.state === 'ACTIVE' && Date.now() <= lease.leaseExpiryMs && lease.orchestratorPid) {
      const pidStr = String(lease.orchestratorPid);
      if (!perProcess[pidStr]) {
        perProcess[pidStr] = { ts: Date.now(), inFlight: { 'gemini-flash': 0, 'gemini-pro': 0, claude: 0, 'gpt-oss': 0 }, v2Mirror: true };
      } else {
        perProcess[pidStr].ts = Date.now();
      }
      perProcess[pidStr].v2Mirror = true;
      const modelPool = lease.modelPool ?? (lease.pool === 'gemini' ? 'gemini-flash' : 'claude');
      if (perProcess[pidStr].inFlight[modelPool] !== undefined) {
        perProcess[pidStr].inFlight[modelPool] = Object.values(v2State.leases || {}).filter(
          (l) => l.state === 'ACTIVE' && Date.now() <= l.leaseExpiryMs && String(l.orchestratorPid) === pidStr && (l.modelPool ?? (l.pool === 'gemini' ? 'gemini-flash' : 'claude')) === modelPool
        ).length;
      }
    }
  }

  const activeCount = Object.values(v2State.leases || {}).filter(
    (l) => l.state === 'ACTIVE' && Date.now() <= l.leaseExpiryMs
  ).length;
  const totalReserved =
    (v2State.pools?.gemini?.reserved || 0) + (v2State.pools?.claude_gpt?.reserved || 0);

  durableWriteJson(getStateFile(), {
    ...perProcess,
    generation: v2State.generation,
    activeSchemaVersion: 2,
    v2ActiveLeaseCount: activeCount,
    totalReserved,
  });
}

/**
 * Parses raw stdout from `agy -p "/quota"`.
 * Fails closed if the probe fails, times out, returns unparseable data, or violates
 * semantic invariants.
 */
export function parseQuotaProbeOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    const err = new Error('Quota probe output is empty or not a string');
    err.kind = 'quota_parse_failure';
    throw err;
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (e) {
    const err = new Error(`Quota probe stdout is unparseable JSON: ${e.message}`);
    err.kind = 'quota_parse_failure';
    throw err;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const err = new Error('Quota probe output lacks an object envelope');
    err.kind = 'quota_parse_failure';
    throw err;
  }
  const pools = data.pools;
  if (!Array.isArray(pools)) {
    const err = new Error('Quota probe output missing pools array');
    err.kind = 'quota_parse_failure';
    throw err;
  }
  if (pools.length !== 2) {
    const err = new Error(`Expected exactly 2 pools in quota telemetry, got ${pools.length}`);
    err.kind = 'ambiguous_quota_pools';
    throw err;
  }

  const foundNames = pools.map((p) => p?.name);
  if (
    !foundNames.includes('Gemini Models') ||
    !foundNames.includes('Claude and GPT models') ||
    foundNames.filter((n) => n === 'Gemini Models').length !== 1 ||
    foundNames.filter((n) => n === 'Claude and GPT models').length !== 1
  ) {
    const err = new Error(
      `Quota pools must contain exactly one 'Gemini Models' and one 'Claude and GPT models', found: ${JSON.stringify(
        foundNames
      )}`
    );
    err.kind = 'ambiguous_quota_pools';
    throw err;
  }

  const parseWindow = (winObj, winName, poolName) => {
    if (!winObj || typeof winObj !== 'object') {
      const err = new Error(`Missing ${winName} window for pool ${poolName}`);
      err.kind = 'quota_parse_failure';
      throw err;
    }
    const rawVal = winObj.remainingPercent;
    if (rawVal === null || rawVal === undefined || typeof rawVal === 'boolean') {
      const err = new Error(`Invalid remainingPercent in ${poolName}.${winName}: ${rawVal}`);
      err.kind = 'invalid_quota_percentage';
      throw err;
    }
    if (typeof rawVal === 'string') {
      if (!/^-?\d+(?:\.\d+)?$/.test(rawVal.trim())) {
        const err = new Error(`Invalid remainingPercent string in ${poolName}.${winName}: ${rawVal}`);
        err.kind = 'invalid_quota_percentage';
        throw err;
      }
    } else if (typeof rawVal !== 'number') {
      const err = new Error(`Invalid remainingPercent type in ${poolName}.${winName}: ${typeof rawVal}`);
      err.kind = 'invalid_quota_percentage';
      throw err;
    }
    const val = typeof rawVal === 'number' ? rawVal : Number(rawVal);
    if (Number.isNaN(val) || !Number.isFinite(val) || val < 0.0 || val > 100.0) {
      const err = new Error(`remainingPercent out of range [0, 100] in ${poolName}.${winName}: ${val}`);
      err.kind = 'invalid_quota_percentage';
      throw err;
    }

    const rawResetTime = winObj.resetTime;
    if (typeof rawResetTime !== 'string' || !RFC3339_UTC_RE.test(rawResetTime)) {
      const err = new Error(
        `resetTime in ${poolName}.${winName} does not match strict RFC 3339 UTC pattern: ${rawResetTime}`
      );
      err.kind = 'invalid_quota_timestamp';
      throw err;
    }
    const resetTimeMs = Date.parse(rawResetTime);
    if (!Number.isFinite(resetTimeMs) || resetTimeMs < Date.now() - 10000) {
      const err = new Error(
        `resetTime in ${poolName}.${winName} violates future ordering / clock skew limit: ${rawResetTime}`
      );
      err.kind = 'invalid_quota_timestamp';
      throw err;
    }

    return { remainingPercent: val, resetTime: rawResetTime, resetTimeMs };
  };

  const geminiRaw = pools.find((p) => p.name === 'Gemini Models');
  const claudeGptRaw = pools.find((p) => p.name === 'Claude and GPT models');

  const gemini5h = parseWindow(geminiRaw.fiveHour, 'fiveHour', 'Gemini Models');
  const geminiWeekly = parseWindow(geminiRaw.weekly, 'weekly', 'Gemini Models');
  const claude5h = parseWindow(claudeGptRaw.fiveHour, 'fiveHour', 'Claude and GPT models');
  const claudeWeekly = parseWindow(claudeGptRaw.weekly, 'weekly', 'Claude and GPT models');

  const res = {
    gemini: {
      fiveHourRemainingPercent: gemini5h.remainingPercent,
      fiveHourResetTime: gemini5h.resetTime,
      weeklyRemainingPercent: geminiWeekly.remainingPercent,
      weeklyResetTime: geminiWeekly.resetTime,
    },
    claude_gpt: {
      fiveHourRemainingPercent: claude5h.remainingPercent,
      fiveHourResetTime: claude5h.resetTime,
      weeklyRemainingPercent: claudeWeekly.remainingPercent,
      weeklyResetTime: claudeWeekly.resetTime,
    },
  };
  res['claude-gpt'] = res.claude_gpt;
  return res;
}

export function computeEffectivePercent(fiveHourPercent, weeklyPercent) {
  return Math.min(fiveHourPercent, weeklyPercent);
}

export function canonicalPoolOf(pool) {
  if (pool === 'claude' || pool === 'gpt-oss' || pool === 'claude-gpt' || pool === 'claude_gpt') {
    return 'claude_gpt';
  }
  return 'gemini';
}

export function computeScaledCap(pool, effectivePercent) {
  const canonical = canonicalPoolOf(pool);
  const base = BASE_CAPS[canonical] ?? 12;
  if (effectivePercent >= 50) return base;
  if (effectivePercent >= 25) return Math.floor(base * 0.5);
  if (effectivePercent >= 10) return 1;
  return 0;
}

export function computeQuotaResumption(fiveHourPercent, fiveHourResetTime, weeklyPercent, weeklyResetTime) {
  if (fiveHourPercent >= 10 && weeklyPercent >= 10) return null;
  const BUFFER_MS = 30_000;
  let depletionCause;
  let resumesAtMs;

  if (fiveHourPercent < 10 && weeklyPercent >= 10) {
    depletionCause = 'five_hour_depletion';
    resumesAtMs = Date.parse(fiveHourResetTime) + BUFFER_MS;
  } else if (weeklyPercent < 10 && fiveHourPercent >= 10) {
    depletionCause = 'weekly_depletion';
    resumesAtMs = Date.parse(weeklyResetTime) + BUFFER_MS;
  } else {
    depletionCause = 'dual_depletion';
    resumesAtMs = Math.max(Date.parse(fiveHourResetTime), Date.parse(weeklyResetTime)) + BUFFER_MS;
  }

  return {
    paused: true,
    depletionCause,
    resumesAt: new Date(resumesAtMs).toISOString(),
    resumesAtMs,
  };
}

export function upstreamPoolOf(model) {
  const fam = familyOf(model);
  if (fam === 'claude' || fam === 'gpt-oss') return 'claude_gpt';
  return 'gemini';
}

function getLeaseHeartbeatPath(repo, leaseId) {
  return join(repo, '.adlc', 'leases', `${leaseId}.heartbeat`);
}

function writeLeaseHeartbeat(repo, leaseId, ownerToken, timestamp) {
  const adlcDir = join(repo, '.adlc');
  if (existsSync(adlcDir) && lstatSync(adlcDir).isSymbolicLink()) {
    throw new Error(`refusing to write lease heartbeat through symlinked .adlc: ${adlcDir}`);
  }
  const leasesDir = join(adlcDir, 'leases');
  if (existsSync(leasesDir) && lstatSync(leasesDir).isSymbolicLink()) {
    throw new Error(`refusing to write lease heartbeat through symlinked leases directory: ${leasesDir}`);
  }
  let realRepo;
  try {
    realRepo = realpathSync(repo);
  } catch {
    realRepo = resolve(repo);
  }
  if (existsSync(leasesDir)) {
    const realLeases = realpathSync(leasesDir);
    const isWin = process.platform === 'win32';
    const sep = isWin ? '\\' : '/';
    if (!realLeases.startsWith(realRepo + sep) && realLeases !== realRepo) {
      throw new Error(`refusing to write lease heartbeat outside repository: ${realLeases}`);
    }
  }

  const primaryPath = getLeaseHeartbeatPath(repo, leaseId);
  try {
    mkdirSync(dirname(primaryPath), { recursive: true, mode: 0o700 });
    if (lstatSync(adlcDir).isSymbolicLink() || lstatSync(leasesDir).isSymbolicLink()) {
      throw new Error(`refusing to write lease heartbeat through symlinked directory`);
    }
    const realLeases = realpathSync(leasesDir);
    const isWin = process.platform === 'win32';
    const sep = isWin ? '\\' : '/';
    if (!realLeases.startsWith(realRepo + sep) && realLeases !== realRepo) {
      throw new Error(`refusing to write lease heartbeat outside repository: ${realLeases}`);
    }
    if (existsSync(primaryPath) && lstatSync(primaryPath).isSymbolicLink()) {
      unlinkSync(primaryPath);
    }
    writeFileSync(primaryPath, JSON.stringify({ ownerToken, timestamp }), { mode: 0o600 });
    return primaryPath;
  } catch (err) {
    if (err.message && err.message.startsWith('refusing to write lease heartbeat')) {
      throw err;
    }
    if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS' || err.code === 'ENOENT') {
      const fallbackDir = join(tmpdir(), 'agb_fallback_leases');
      try {
        mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
        const fallbackPath = join(fallbackDir, `${leaseId}.heartbeat`);
        if (existsSync(fallbackPath) && lstatSync(fallbackPath).isSymbolicLink()) {
          unlinkSync(fallbackPath);
        }
        writeFileSync(fallbackPath, JSON.stringify({ ownerToken, timestamp }), { mode: 0o600 });
        return fallbackPath;
      } catch {}
    }
    throw err;
  }
}

function unlinkLeaseHeartbeat(repo, leaseId) {
  try {
    const adlcDir = join(repo, '.adlc');
    if (!existsSync(adlcDir) || lstatSync(adlcDir).isSymbolicLink()) {
      // refuse to follow symlink
    } else {
      const leasesDir = join(adlcDir, 'leases');
      if (existsSync(leasesDir) && !lstatSync(leasesDir).isSymbolicLink()) {
        const hb = getLeaseHeartbeatPath(repo, leaseId);
        if (existsSync(hb) || lstatSync(hb).isSymbolicLink()) unlinkSync(hb);
      }
    }
  } catch {}
  try {
    const fallback = join(tmpdir(), 'agb_fallback_leases', `${leaseId}.heartbeat`);
    if (existsSync(fallback) || lstatSync(fallback).isSymbolicLink()) unlinkSync(fallback);
  } catch {}
}

export async function acquireLease(
  repo,
  { pool, ticketId, workerPid = null, workerStartTime = null }
) {
  const canonicalPool = canonicalPoolOf(pool);
  const leaseId = randomUUID();
  const ownerToken = randomUUID();
  const startTime = workerStartTime ?? (workerPid ? getProcessStartTime(workerPid) : null);
  if (workerPid && !startTime) {
    throw new Error(`Cannot acquire lease: cannot verify worker process start time for PID ${workerPid}`);
  }
  const now = Date.now();

  return await withLock(getLockFile(), () => {
    const v2 = readV2State();
    if (v2.status === 'DRAINING') {
      throw new Error(`Cannot acquire lease: pool is DRAINING`);
    }
    if (v2.quotaState?.circuitBreakerTripped) {
      throw new Error(`Cannot acquire lease: quota circuit breaker is tripped`);
    }
    if (!v2.pools) v2.pools = {};
    if (!v2.leases) v2.leases = {};

    let poolState = v2.pools[canonicalPool] ?? {
      baseCap: BASE_CAPS[canonicalPool],
      scaledCap: BASE_CAPS[canonicalPool],
      inFlight: 0,
      reserved: 0,
    };
    if ((poolState.inFlight + poolState.reserved) >= poolState.scaledCap) {
      let reclaimed = 0;
      for (const [id, l] of Object.entries(v2.leases || {})) {
        if (l.state !== 'ACTIVE') continue;
        const expired = (now > l.leaseExpiryMs) || ((now - (l.heartbeatMs || 0)) >= LEASE_TTL_MS);
        const dead = l.orchestratorPid && !isProcessAlive(l.orchestratorPid);
        if (expired || dead) {
          l.state = 'RECLAIMED';
          const pState = v2.pools[l.pool];
          if (pState && pState.inFlight > 0) {
            pState.inFlight -= 1;
          }
          unlinkLeaseHeartbeat(l.repo || repo, id);
          reclaimed++;
        }
      }
      poolState = v2.pools[canonicalPool] ?? poolState;
      if ((poolState.inFlight + poolState.reserved) >= poolState.scaledCap) {
        const err = new Error(`Capacity exhausted for pool ${canonicalPool}`);
        err.kind = 'capacity_exhausted';
        throw err;
      }
    }

    writeLeaseHeartbeat(repo, leaseId, ownerToken, now);

    const lease = {
      leaseId,
      ownerToken,
      repo,
      orchestratorPid: process.pid,
      orchestratorStartTime: getProcessStartTime(process.pid),
      workerPid,
      workerStartTime: startTime,
      ticketId,
      pool: canonicalPool,
      modelPool: pool,
      createdAtMs: now,
      heartbeatMs: now,
      leaseExpiryMs: now + LEASE_TTL_MS,
      state: 'ACTIVE',
    };

    v2.leases[leaseId] = lease;
    poolState.inFlight = (poolState.inFlight || 0) + 1;
    v2.pools[canonicalPool] = poolState;
    writeV2State(v2);

    return { leaseId, ownerToken, lease };
  });
}

export async function renewLease(repo, leaseId, ownerToken) {
  return await withLock(getLockFile(), () => {
    const v2 = readV2State();
    const lease = v2.leases[leaseId];
    if (!lease || lease.ownerToken !== ownerToken || lease.state !== 'ACTIVE') {
      return false;
    }
    const now = Date.now();
    const targetRepo = lease.repo || repo;
    writeLeaseHeartbeat(targetRepo, leaseId, ownerToken, now);

    lease.heartbeatMs = now;
    lease.leaseExpiryMs = now + LEASE_TTL_MS;
    writeV2State(v2);
    return true;
  });
}

export async function releaseLease(repo, leaseId, ownerToken) {
  return await withLock(getLockFile(), () => {
    const v2 = readV2State();
    const lease = v2.leases[leaseId];
    if (!lease || lease.ownerToken !== ownerToken) {
      return false;
    }
    if (lease.state === 'TERMINATED' || lease.state === 'RECLAIMED') {
      return false; // Idempotent release prevents double-refund
    }

    lease.state = 'TERMINATED';
    const poolState = v2.pools[lease.pool];
    if (poolState && poolState.inFlight > 0) {
      poolState.inFlight -= 1;
    }

    const targetRepo = lease.repo || repo;
    unlinkLeaseHeartbeat(targetRepo, leaseId);

    writeV2State(v2);
    return true;
  });
}

export function isLeaseActive(repo, leaseId, ownerToken) {
  if (!leaseId || !ownerToken) return false;
  try {
    const v2 = readV2State();
    if (v2.status === 'DRAINING') return false;
    const lease = v2.leases?.[leaseId];
    if (!lease || lease.ownerToken !== ownerToken || lease.state !== 'ACTIVE') {
      return false;
    }
    const now = Date.now();
    if (now > lease.leaseExpiryMs || (now - lease.heartbeatMs) >= LEASE_TTL_MS) {
      return false;
    }
    if (lease.orchestratorPid && !isProcessAlive(lease.orchestratorPid)) {
      return false;
    }
    const leaseRepo = lease.repo || repo;
    const hbPath = getLeaseHeartbeatPath(leaseRepo, leaseId);
    const fallbackHbPath = join(tmpdir(), 'agb_fallback_leases', `${leaseId}.heartbeat`);
    const activePath = existsSync(hbPath) ? hbPath : (existsSync(fallbackHbPath) ? fallbackHbPath : null);
    if (!activePath) {
      return false;
    }
    try {
      const hb = JSON.parse(readFileSync(activePath, 'utf8'));
      if (hb.ownerToken !== lease.ownerToken) {
        return false;
      }
    } catch {
      return false;
    }
    if (lease.workerPid) {
      const curStart = getProcessStartTime(lease.workerPid);
      if (!lease.workerStartTime || !curStart || curStart !== lease.workerStartTime) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function registerLeaseWorkerPid(repo, leaseId, ownerToken, workerPid) {
  if (!leaseId || !ownerToken || !workerPid) return false;
  const startTime = getProcessStartTime(workerPid);
  if (!startTime) return false;
  return await withLock(getLockFile(), () => {
    const v2 = readV2State();
    if (v2.status === 'DRAINING') return false;
    const lease = v2.leases?.[leaseId];
    if (lease && lease.ownerToken === ownerToken && lease.state === 'ACTIVE') {
      lease.workerPid = workerPid;
      lease.workerStartTime = startTime;
      writeV2State(v2);
      return true;
    }
    return false;
  });
}

export async function reconcileLeases(repo) {
  return await withLock(getLockFile(), () => {
    const v2 = readV2State();
    const now = Date.now();
    let reconciledCount = 0;

    for (const [id, lease] of Object.entries(v2.leases || {})) {
      if (lease.state !== 'ACTIVE') continue;

      let isStillActive = true;
      if (now > lease.leaseExpiryMs || (now - lease.heartbeatMs) >= LEASE_TTL_MS) {
        isStillActive = false;
      }
      if (isStillActive && !isProcessAlive(lease.orchestratorPid)) {
        isStillActive = false;
      }

      const leaseRepo = lease.repo || repo;
      const hbPath = getLeaseHeartbeatPath(leaseRepo, id);
      const fallbackHbPath = join(tmpdir(), 'agb_fallback_leases', `${id}.heartbeat`);
      if (isStillActive) {
        try {
          const activePath = existsSync(hbPath) ? hbPath : (existsSync(fallbackHbPath) ? fallbackHbPath : null);
          if (!activePath) {
            isStillActive = false;
          } else {
            const hb = JSON.parse(readFileSync(activePath, 'utf8'));
            if (hb.ownerToken !== lease.ownerToken) {
              isStillActive = false;
            }
          }
        } catch {
          isStillActive = false;
        }
      }

      if (isStillActive && lease.workerPid) {
        const curStart = getProcessStartTime(lease.workerPid);
        if (!lease.workerStartTime || !curStart || curStart !== lease.workerStartTime) {
          isStillActive = false; // PID reuse detected or start time unverified
        }
      }

      if (!isStillActive) {
        lease.state = 'RECLAIMED';
        const poolState = v2.pools[lease.pool];
        if (poolState && poolState.inFlight > 0) {
          poolState.inFlight -= 1;
        }
        unlinkLeaseHeartbeat(leaseRepo, id);
        reconciledCount++;
      }
    }

    if (reconciledCount > 0) {
      writeV2State(v2);
    }
    return reconciledCount;
  });
}

export async function drainPools(repo, { gracePeriodMs = 1000 } = {}) {
  // Step 1: Transition status to DRAINING under lock
  await withLock(getLockFile(), () => {
    const v2 = readV2State();
    v2.status = 'DRAINING';
    writeV2State(v2);
  });

  const deadline = Date.now() + gracePeriodMs;
  const allTargetsSignaled = new Map(); // pid -> startTime

  // Step 2: Loop until all active leases (with or without workerPid) are settled or grace period expires
  while (Date.now() < deadline) {
    let pendingUnsettledCount = 0;
    const newTargets = [];

    await withLock(getLockFile(), () => {
      const v2 = readV2State();
      for (const lease of Object.values(v2.leases || {})) {
        if (lease.state === 'ACTIVE') {
          if (lease.workerPid) {
            const curStart = getProcessStartTime(lease.workerPid);
            if (!lease.workerStartTime || !curStart || curStart !== lease.workerStartTime) {
              lease.state = allTargetsSignaled.has(lease.workerPid) ? 'TERMINATED' : 'RECLAIMED';
            } else if (!allTargetsSignaled.has(lease.workerPid)) {
              allTargetsSignaled.set(lease.workerPid, lease.workerStartTime);
              newTargets.push({ pid: lease.workerPid, startTime: lease.workerStartTime });
            }
          } else {
            // Lease is active but workerPid not yet registered.
            // Check if orchestrator process is still alive. If so, signal it and wait during grace period.
            if (lease.orchestratorPid && isProcessAlive(lease.orchestratorPid, lease.orchestratorStartTime)) {
              if (lease.orchestratorPid !== process.pid) {
                const orchStart = lease.orchestratorStartTime ?? getProcessStartTime(lease.orchestratorPid);
                if (!allTargetsSignaled.has(lease.orchestratorPid)) {
                  allTargetsSignaled.set(lease.orchestratorPid, orchStart);
                  newTargets.push({ pid: lease.orchestratorPid, startTime: orchStart });
                }
              }
              pendingUnsettledCount++;
            } else {
              lease.state = allTargetsSignaled.has(lease.orchestratorPid) ? 'TERMINATED' : 'RECLAIMED';
            }
          }
        }
      }
      writeV2State(v2);
    });

    for (const t of newTargets) {
      try {
        try { process.kill(-t.pid, 'SIGTERM'); } catch { process.kill(t.pid, 'SIGTERM'); }
      } catch {}
    }

    const alive = [...allTargetsSignaled.entries()].some(([pid, startTime]) => isProcessAlive(pid, startTime));
    if (pendingUnsettledCount === 0 && !alive) {
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  // Step 3: Final pass under lock - escalate to SIGKILL, mark all remaining active leases TERMINATED, reset counters, and set status to ACTIVE
  return await withLock(getLockFile(), () => {
    const v2 = readV2State();
    for (const [pid, startTime] of allTargetsSignaled.entries()) {
      if (isProcessAlive(pid, startTime)) {
        const curStart = getProcessStartTime(pid);
        if (curStart === startTime) {
          try {
            try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
          } catch {}
        }
      }
    }

    for (const lease of Object.values(v2.leases || {})) {
      if (lease.state === 'ACTIVE' || allTargetsSignaled.has(lease.workerPid) || allTargetsSignaled.has(lease.orchestratorPid)) {
        lease.state = 'TERMINATED';
        if (lease.orchestratorPid && lease.orchestratorPid !== process.pid) {
          const orchStart = lease.orchestratorStartTime ?? getProcessStartTime(lease.orchestratorPid);
          if (isProcessAlive(lease.orchestratorPid, orchStart)) {
            try {
              try { process.kill(-lease.orchestratorPid, 'SIGKILL'); } catch { process.kill(lease.orchestratorPid, 'SIGKILL'); }
            } catch {}
          }
        }
      }
    }

    // Clean all heartbeat files in .adlc/leases/ and fallback directory
    const leasesDir = join(repo, '.adlc', 'leases');
    try {
      rmSync(leasesDir, { recursive: true, force: true });
    } catch {}

    for (const [id, lease] of Object.entries(v2.leases || {})) {
      unlinkLeaseHeartbeat(lease.repo || repo, id);
    }
    const fallbackDir = join(tmpdir(), 'agb_fallback_leases');
    try {
      rmSync(fallbackDir, { recursive: true, force: true });
    } catch {}

    // Reset pool in-flight counters
    for (const p of Object.values(v2.pools || {})) {
      p.inFlight = 0;
    }
    v2.status = 'ACTIVE';

    writeV2State(v2);

    // Write clean downgrade tombstone to agb_pools_shared.json
    durableWriteJson(getStateFile(), {
      generation: v2.generation,
      activeSchemaVersion: 1,
      v2ActiveLeaseCount: 0,
      inFlight: { gemini: 0, claude_gpt: 0 },
    });

    return { ok: true, drainedLeases: Object.keys(v2.leases).length };
  });
}

/**
 * Candidate models for a tier filtered by pool_hint. Exported so plan
 * validation can reject tier/hint combinations with no candidates (e.g.
 * cheap+claude) before a run starts, instead of route() throwing mid-run.
 */
export function tierCandidates(tier, poolHint) {
  return (TIER_CANDIDATES[tier] ?? TIER_CANDIDATES.mid).filter((m) => {
    if (!poolHint || poolHint === 'auto') return true;
    const fam = familyOf(m);
    if (poolHint === 'claude-gpt') return fam === 'claude' || fam === 'gpt-oss';
    return fam === poolHint;
  });
}

export async function probeQuota(agyBin = process.env.AGB_AGY_BIN || 'agy') {
  try {
    const { stdout } = await execFileP(agyBin, ['-p', '/quota'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseQuotaProbeOutput(stdout);
  } catch (err) {
    const e = new Error(`Quota probe failed: ${err.message}`);
    e.kind = 'quota_probe_failure';
    throw e;
  }
}

export class PoolSet {
  constructor(caps = DEFAULT_CAPS, { repo = process.cwd() } = {}) {
    this.repo = repo;
    this.configuredCaps = { ...DEFAULT_CAPS, ...caps };
    this.caps = { ...this.configuredCaps };
    this.inFlight = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    this.requests = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    this.reserved = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    this.waiters = Object.fromEntries(Object.keys(MODELS).map((p) => [p, []]));
    this.quota = null;
    this.quotaRefreshFailures = 0;
    this.circuitBreakerTripped = false;
    this.#remotePollTimer = null;
  }

  #remotePollTimer = null;

  abortAllWaiters(err = new Error('Quota circuit breaker is tripped; dispatch suspended')) {
    err.kind ??= 'circuit_breaker_tripped';
    for (const pool of Object.keys(this.waiters)) {
      while (this.waiters[pool].length > 0) {
        const waiter = this.waiters[pool].shift();
        if (typeof waiter === 'function') {
          waiter();
        } else if (waiter && typeof waiter.reject === 'function') {
          waiter.reject(err);
        }
      }
    }
    this.#maybeStopRemotePoll();
  }

  drainRemoteWaiters() {
    if (this.isCircuitBreakerTripped()) {
      const err = new Error('Quota circuit breaker is tripped; dispatch suspended');
      err.kind = 'circuit_breaker_tripped';
      this.abortAllWaiters(err);
      return;
    }
    for (const pool of Object.keys(this.waiters)) {
      const upstream = pool.startsWith('gemini') ? 'gemini' : 'claude_gpt';
      while (
        this.waiters[pool].length > 0 &&
        this.totalInFlight(pool) < this.caps[pool] &&
        this.familyInFlight(upstream) < this.familyCap(upstream)
      ) {
        const next = this.waiters[pool].shift();
        this.inFlight[pool] = (this.inFlight[pool] || 0) + 1;
        if (typeof next === 'function') next();
        else next.resolve();
        this.syncSharedState();
      }
    }
  }

  #ensureRemotePoll() {
    if (!this.#remotePollTimer) {
      this.#remotePollTimer = setInterval(() => {
        this.drainRemoteWaiters();
        this.#maybeStopRemotePoll();
      }, 100);
      this.#remotePollTimer.unref?.();
    }
  }

  #maybeStopRemotePoll() {
    const hasWaiters = Object.values(this.waiters).some((w) => w.length > 0);
    if (!hasWaiters && this.#remotePollTimer) {
      clearInterval(this.#remotePollTimer);
      this.#remotePollTimer = null;
    }
  }

  async refreshQuota(agyBin = process.env.AGB_AGY_BIN || 'agy') {
    try {
      const data = await probeQuota(agyBin);
      this.updateFromQuota(data);
      return { ok: true, quota: this.quota };
    } catch (err) {
      this.recordQuotaFailure();
      return { ok: false, error: err.message, tripped: this.circuitBreakerTripped };
    }
  }

  updateFromQuota(quotaData) {
    if (!quotaData || !quotaData.gemini || !quotaData.claude_gpt) return;
    const geminiEff = computeEffectivePercent(
      quotaData.gemini.fiveHourRemainingPercent,
      quotaData.gemini.weeklyRemainingPercent
    );
    const claudeEff = computeEffectivePercent(
      quotaData.claude_gpt.fiveHourRemainingPercent,
      quotaData.claude_gpt.weeklyRemainingPercent
    );

    const geminiScaled = computeScaledCap('gemini', geminiEff);
    const claudeScaled = computeScaledCap('claude_gpt', claudeEff);

    // Update pool caps from configured caps so recovering quota restores capacity
    this.caps['gemini-flash'] = Math.min(this.configuredCaps['gemini-flash'] ?? 8, geminiScaled);
    this.caps['gemini-pro'] = Math.min(this.configuredCaps['gemini-pro'] ?? 4, geminiScaled);
    this.caps['claude'] = Math.min(this.configuredCaps['claude'] ?? 4, claudeScaled);
    this.caps['gpt-oss'] = Math.min(this.configuredCaps['gpt-oss'] ?? 2, claudeScaled);

    // Persist refreshed caps in durable V2 state so other processes coordinate against updated capacity
    try {
      withLockSync(getLockFile(), () => {
        const v2 = readV2State();
        if (v2 && v2.pools) {
          if (v2.pools.gemini) {
            v2.pools.gemini.scaledCap = geminiScaled;
          }
          if (v2.pools.claude_gpt) {
            v2.pools.claude_gpt.scaledCap = claudeScaled;
          }
          v2.quotaState = {
            gemini: { scaledCap: geminiScaled, effectivePercent: geminiEff },
            claude_gpt: { scaledCap: claudeScaled, effectivePercent: claudeEff },
            circuitBreakerTripped: false,
            quotaRefreshFailures: 0,
            updatedAt: Date.now(),
          };
          writeV2State(v2);
        }
      });
    } catch {}

    // If pool cap dropped to 0, abort queued waiters rather than hanging forever
    for (const p of Object.keys(this.caps)) {
      if (this.caps[p] <= 0 && this.waiters[p].length > 0) {
        const err = new Error(`Pool ${p} capacity depleted; queued requests aborted`);
        err.kind = 'quota_depleted';
        while (this.waiters[p].length > 0) {
          const waiter = this.waiters[p].shift();
          if (typeof waiter === 'function') {
            waiter();
          } else {
            waiter.reject(err);
          }
        }
      }
    }

    const geminiPause = computeQuotaResumption(
      quotaData.gemini.fiveHourRemainingPercent,
      quotaData.gemini.fiveHourResetTime,
      quotaData.gemini.weeklyRemainingPercent,
      quotaData.gemini.weeklyResetTime
    );
    const claudePause = computeQuotaResumption(
      quotaData.claude_gpt.fiveHourRemainingPercent,
      quotaData.claude_gpt.fiveHourResetTime,
      quotaData.claude_gpt.weeklyRemainingPercent,
      quotaData.claude_gpt.weeklyResetTime
    );

    this.quota = {
      gemini: { ...quotaData.gemini, effectivePercent: geminiEff, scaledCap: geminiScaled },
      claude_gpt: { ...quotaData.claude_gpt, effectivePercent: claudeEff, scaledCap: claudeScaled },
      paused: Boolean(geminiPause || claudePause),
      depletionCause: geminiPause?.depletionCause ?? claudePause?.depletionCause ?? null,
      resumesAt: geminiPause?.resumesAt ?? claudePause?.resumesAt ?? null,
    };
    this.recordQuotaSuccess();
  }

  recordQuotaFailure() {
    this.quotaRefreshFailures += 1;
    this.circuitBreakerTripped = true;
    try {
      withLockSync(getLockFile(), () => {
        const v2 = readV2State();
        if (v2) {
          v2.quotaState ??= {};
          const currentFailures = Math.max(
            (v2.quotaState.quotaRefreshFailures ?? 0) + 1,
            this.quotaRefreshFailures
          );
          v2.quotaState.quotaRefreshFailures = currentFailures;
          v2.quotaState.circuitBreakerTripped = true;
          v2.quotaState.updatedAt = Date.now();
          writeV2State(v2);
        }
      });
    } catch {}
    console.error('CRITICAL: Quota probe failed; fleet dispatch suspended');
    const err = new Error('Quota circuit breaker is tripped; dispatch suspended');
    err.kind = 'circuit_breaker_tripped';
    this.abortAllWaiters(err);
  }

  recordQuotaSuccess() {
    this.quotaRefreshFailures = 0;
    this.circuitBreakerTripped = false;
    try {
      withLockSync(getLockFile(), () => {
        const v2 = readV2State();
        if (v2?.quotaState) {
          v2.quotaState.circuitBreakerTripped = false;
          v2.quotaState.quotaRefreshFailures = 0;
          v2.quotaState.updatedAt = Date.now();
          writeV2State(v2);
        }
      });
    } catch {}
  }

  isCircuitBreakerTripped() {
    if (this.circuitBreakerTripped) return true;
    try {
      const v2 = readV2State();
      if (v2?.quotaState?.circuitBreakerTripped) {
        this.circuitBreakerTripped = true;
        const err = new Error('Quota circuit breaker is tripped; dispatch suspended');
        err.kind = 'circuit_breaker_tripped';
        this.abortAllWaiters(err);
        return true;
      }
    } catch {}
    return false;
  }

  syncSharedState() {
    writeSharedState({ ts: Date.now(), inFlight: this.inFlight, requests: this.requests, v2Mirror: true });
  }

  totalInFlight(pool) {
    let total = this.inFlight[pool] || 0;
    const shared = readSharedState();
    let remoteTotal = 0;
    const now = Date.now();
    for (const [pidStr, state] of Object.entries(shared)) {
      if (Number(pidStr) !== process.pid && state && state.inFlight && now - (state.ts || 0) < 60000) {
        remoteTotal += Number(state.inFlight[pool]) || 0;
      }
    }
    return total + remoteTotal;
  }

  familyInFlight(upstreamPool) {
    if (upstreamPool === 'gemini') {
      return this.totalInFlight('gemini-flash') + this.totalInFlight('gemini-pro');
    }
    return this.totalInFlight('claude') + this.totalInFlight('gpt-oss');
  }

  familyCap(upstreamPool) {
    if (this.quota && this.quota[upstreamPool] && typeof this.quota[upstreamPool].scaledCap === 'number') {
      return this.quota[upstreamPool].scaledCap;
    }
    return BASE_CAPS[upstreamPool] ?? (upstreamPool === 'gemini' ? 12 : 4);
  }

  hasCapacity(model) {
    if (this.isCircuitBreakerTripped()) return false;
    const pool = poolOf(model);
    const upstream = upstreamPoolOf(model);
    this.syncSharedState();
    if (this.totalInFlight(pool) >= this.caps[pool]) return false;
    if (this.familyInFlight(upstream) >= this.familyCap(upstream)) return false;
    return true;
  }

  /** Acquire a slot for `model`, waiting (FIFO) if its pool is saturated. */
  async acquire(model, options = {}) {
    if (this.isCircuitBreakerTripped()) {
      throw new Error('Quota circuit breaker is tripped; dispatch suspended');
    }
    const pool = poolOf(model);
    const upstream = upstreamPoolOf(model);
    this.syncSharedState();

    if (this.caps[pool] <= 0 || this.familyCap(upstream) <= 0) {
      const pauseMsg = this.quota?.paused && this.quota?.resumesAt
        ? ` until ${this.quota.resumesAt}`
        : '';
      const err = new Error(`Pool ${pool} has zero capacity due to quota depletion; dispatch suspended${pauseMsg}`);
      err.kind = 'quota_depleted';
      err.pool = pool;
      err.resumesAt = this.quota?.resumesAt;
      throw err;
    }

    const repo = options.repo || this.repo || process.cwd();
    const ticketId = options.ticketId || null;
    const workerPid = options.workerPid || null;
    const workerStartTime = options.workerStartTime || null;

    const canAcquireImmediately =
      this.waiters[pool].length === 0 &&
      this.totalInFlight(pool) < this.caps[pool] &&
      this.familyInFlight(upstream) < this.familyCap(upstream);

    if (canAcquireImmediately) {
      this.inFlight[pool] += 1;
      this.requests[pool] += 1;
      this.syncSharedState();
      let lease;
      try {
        lease = await acquireLease(repo, { pool, ticketId, workerPid, workerStartTime });
      } catch (err) {
        this.inFlight[pool] = Math.max(0, this.inFlight[pool] - 1);
        this.syncSharedState();
        if (err.kind !== 'capacity_exhausted' && !/capacity exhausted/i.test(err.message)) {
          throw err;
        }
      }
      if (lease) {
        const leaseInfo = { repo, leaseId: lease.leaseId, ownerToken: lease.ownerToken };
        let heartbeatTimer = null;
        if (leaseInfo?.leaseId && leaseInfo?.ownerToken && leaseInfo?.repo) {
          heartbeatTimer = setInterval(() => {
            renewLease(leaseInfo.repo, leaseInfo.leaseId, leaseInfo.ownerToken).catch(() => {});
          }, HEARTBEAT_INTERVAL_MS);
          heartbeatTimer.unref?.();
        }
        const releaser = this.#releaser(pool, leaseInfo, heartbeatTimer);
        releaser.leaseId = lease.leaseId;
        releaser.ownerToken = lease.ownerToken;
        releaser.registerWorkerPid = (pid) => registerLeaseWorkerPid(repo, lease.leaseId, lease.ownerToken, pid);
        releaser.isActive = () => isLeaseActive(repo, lease.leaseId, lease.ownerToken);
        return releaser;
      }
    }
    // Saturated or lost race: queue in FIFO waiters array
    try {
      await new Promise((resolve, reject) => {
        this.waiters[pool].push({ resolve, reject });
        this.#ensureRemotePoll();
      });
    } finally {
      this.#maybeStopRemotePoll();
    }
    if (this.isCircuitBreakerTripped()) {
      this.inFlight[pool] = Math.max(0, this.inFlight[pool] - 1);
      this.syncSharedState();
      throw new Error('Quota circuit breaker is tripped; dispatch suspended');
    }
    this.requests[pool] += 1;
    this.syncSharedState();
    let lease;
    let attempts = 0;
    while (!lease) {
      try {
        lease = await acquireLease(repo, { pool, ticketId, workerPid, workerStartTime });
      } catch (err) {
        attempts++;
        if ((err.kind === 'capacity_exhausted' || /capacity exhausted/i.test(err.message)) && attempts < 5) {
          await new Promise((r) => setTimeout(r, 50 * attempts));
          continue;
        }
        this.inFlight[pool] = Math.max(0, this.inFlight[pool] - 1);
        this.syncSharedState();
        throw err;
      }
    }
    const leaseInfo = { repo, leaseId: lease.leaseId, ownerToken: lease.ownerToken };
    let heartbeatTimer = null;
    if (leaseInfo?.leaseId && leaseInfo?.ownerToken && leaseInfo?.repo) {
      heartbeatTimer = setInterval(() => {
        renewLease(leaseInfo.repo, leaseInfo.leaseId, leaseInfo.ownerToken).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    }
    const releaser = this.#releaser(pool, leaseInfo, heartbeatTimer);
    releaser.leaseId = lease.leaseId;
    releaser.ownerToken = lease.ownerToken;
    releaser.registerWorkerPid = (pid) => registerLeaseWorkerPid(repo, lease.leaseId, lease.ownerToken, pid);
    releaser.isActive = () => isLeaseActive(repo, lease.leaseId, lease.ownerToken);
    return releaser;
  }

  #releaser(pool, leaseInfo, heartbeatTimer = null) {
    let released = false;
    return () => {
      if (released) return Promise.resolve(); // idempotent — double-release must not free two slots
      released = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      this.#maybeStopRemotePoll();

      const next = this.waiters[pool].shift();
      if (!next) {
        this.inFlight[pool] = Math.max(0, this.inFlight[pool] - 1);
      }
      this.syncSharedState();

      return (async () => {
        // Finish durable release before waking waiters so acquireLease in the woken waiter
        // observes the terminated state and doesn't hit capacity_exhausted.
        if (leaseInfo?.leaseId && leaseInfo?.ownerToken && leaseInfo?.repo) {
          try {
            await releaseLease(leaseInfo.repo, leaseInfo.leaseId, leaseInfo.ownerToken);
          } catch {}
        }
        this.syncSharedState();

        if (next) {
          // Hand the slot directly to the next waiter; inFlight stays at cap.
          if (typeof next === 'function') next();
          else next.resolve();
        } else {
          const upstream = pool.startsWith('gemini') ? 'gemini' : 'claude_gpt';
          const siblings = pool.startsWith('gemini')
            ? ['gemini-flash', 'gemini-pro']
            : ['claude', 'gpt-oss'];
          for (const sibling of siblings) {
            if (sibling === pool) continue;
            while (
              this.waiters[sibling].length > 0 &&
              this.totalInFlight(sibling) < this.caps[sibling] &&
              this.familyInFlight(upstream) < this.familyCap(upstream)
            ) {
              const siblingWaiter = this.waiters[sibling].shift();
              this.inFlight[sibling] += 1;
              if (typeof siblingWaiter === 'function') siblingWaiter();
              else siblingWaiter.resolve();
            }
          }
          this.syncSharedState();
        }
      })();
    };
  }

  /**
   * Pick a model for a tier and RESERVE it: choose the candidate pool with
   * the lowest reserved-assignment ratio so concurrent dispatches spread
   * across pools (the cross-pool throughput multiplier). The caller must
   * call unroute(model) when the ticket reaches a terminal state.
   * pool_hint ('gemini'|'claude'|'claude-gpt') filters candidates by family.
   */
  route(tier, poolHint) {
    const candidates = tierCandidates(tier, poolHint);
    if (candidates.length === 0) throw new Error(`no candidates for tier=${tier} hint=${poolHint}`);

    // Prefer candidates whose pool and family have positive capacity (> 0)
    const withCapacity = candidates.filter((m) => {
      const pool = poolOf(m);
      const upstream = upstreamPoolOf(m);
      return (this.caps[pool] ?? 0) > 0 && this.familyCap(upstream) > 0;
    });

    const poolList = withCapacity.length > 0 ? withCapacity : candidates;
    const pick = poolList
      .map((m) => {
        const cap = this.caps[poolOf(m)] ?? 1;
        const load = cap <= 0 ? Infinity : this.reserved[poolOf(m)] / cap;
        return { m, load };
      })
      .sort((a, b) => a.load - b.load)[0].m;
    this.reserved[poolOf(pick)] += 1;
    return pick;
  }

  /** Release a builder reservation made by route(). */
  unroute(model) {
    const pool = poolOf(model);
    if (this.reserved[pool] > 0) this.reserved[pool] -= 1;
  }

  /** Candidate cross-family prosecutors for a builder model in preference order. */
  prosecutorsFor(builderModel) {
    const fam = familyOf(builderModel);
    if (fam === 'gemini') {
      return ['gpt-oss-120b-medium', 'claude-sonnet-4-6'];
    }
    if (fam === 'claude') {
      return ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium'];
    }
    if (fam === 'gpt-oss') {
      return ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'];
    }
    return [PROSECUTORS[fam] || 'gemini-3.1-pro-high'];
  }

  /** Cross-family prosecutor for a builder model. Prefers candidate with available capacity. */
  prosecutorFor(builderModel) {
    const candidates = this.prosecutorsFor(builderModel);
    for (const m of candidates) {
      const pool = poolOf(m);
      const upstream = upstreamPoolOf(m);
      if ((this.caps[pool] ?? 0) > 0 && this.familyCap(upstream) > 0) {
        return m;
      }
    }
    return candidates[0];
  }

  snapshot() {
    return {
      inFlight: { ...this.inFlight },
      requests: { ...this.requests },
      caps: { ...this.caps },
      quota: this.quota ? JSON.parse(JSON.stringify(this.quota)) : null,
      circuitBreakerTripped: this.circuitBreakerTripped,
    };
  }
}
