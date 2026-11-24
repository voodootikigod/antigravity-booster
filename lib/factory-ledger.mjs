// Append-Only Factory Economics Ledger (`<plugin_data>/factory_ledger.jsonl`).
//
// Records per-run Strike-0 first-pass yield, KV-cache hit rate, deterministic
// `gate.autofix` saves, and normalized billable-token burn under `withLockSync`
// so Mission Control and `agb watch` surface multi-run factory efficiency.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLockSync } from './pools.mjs';

export const MAX_FACTORY_LEDGER_ENTRIES = 1000;

function toNonNegInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

function assertNotSymlinkPath(targetPath) {
  let st;
  try {
    st = lstatSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Security violation: symbolic link not allowed on factory ledger path: ${targetPath}`);
  }
}

export function defaultFactoryLedgerPath({
  repo = null,
  home = process.env.AGB_HOME_DIR || homedir(),
} = {}) {
  if (process.env.AGB_FACTORY_LEDGER_FILE) {
    return resolve(process.env.AGB_FACTORY_LEDGER_FILE);
  }
  if (!process.env.AGB_HOME_DIR && process.env.NODE_TEST_CONTEXT && repo) {
    return join(resolve(repo), '.booster', 'factory_ledger.jsonl');
  }
  return join(
    resolve(home),
    '.gemini',
    'antigravity-cli',
    'plugin_data',
    'antigravity-booster',
    'factory_ledger.jsonl'
  );
}

/**
 * Compute normalized factory economics metrics for a single fleet run.
 */
export function computeRunEconomics({
  runId = null,
  repo = null,
  totalTickets = 0,
  mergedCount = 0,
  failedCount = 0,
  strike0MergedCount = 0,
  autofixAppliedCount = 0,
  uncachedInputTokens = 0,
  cachedTokens = 0,
  outputTokens = 0,
  requestsByPool = {},
  durationMs = 0,
  compromised = null,
  ts = new Date().toISOString(),
} = {}) {
  const normTotal = toNonNegInt(totalTickets);
  const normMerged = toNonNegInt(mergedCount);
  const normFailed = toNonNegInt(failedCount);
  const normStrike0 = Math.min(normMerged, toNonNegInt(strike0MergedCount));
  const normAutofix = toNonNegInt(autofixAppliedCount);
  const normUncached = toNonNegInt(uncachedInputTokens);
  const normCached = toNonNegInt(cachedTokens);
  const normOutput = toNonNegInt(outputTokens);
  const totalInputTokens = normUncached + normCached;
  const billableTokens = Math.round(normUncached + 0.1 * normCached + 3 * normOutput);

  const strike0YieldPct = normTotal > 0 ? round1((normStrike0 / normTotal) * 100) : 0;
  const mergeRatePct = normTotal > 0 ? round1((normMerged / normTotal) * 100) : 0;
  const cacheHitPct = totalInputTokens > 0 ? round1((normCached / totalInputTokens) * 100) : 0;

  const cleanRequests = {};
  if (requestsByPool && typeof requestsByPool === 'object' && !Array.isArray(requestsByPool)) {
    for (const [k, v] of Object.entries(requestsByPool)) {
      if (k === '__proto__' || k === 'constructor') continue;
      cleanRequests[k] = toNonNegInt(v);
    }
  }

  return {
    ts: typeof ts === 'string' && ts ? ts : new Date().toISOString(),
    runId: typeof runId === 'string' && runId ? runId : 'run-unknown',
    repoName: typeof repo === 'string' && repo ? basename(resolve(repo)) : 'workspace',
    totalTickets: normTotal,
    mergedCount: normMerged,
    failedCount: normFailed,
    strike0MergedCount: normStrike0,
    strike0YieldPct,
    mergeRatePct,
    autofixAppliedCount: normAutofix,
    uncachedInputTokens: normUncached,
    cachedTokens: normCached,
    outputTokens: normOutput,
    inputTokens: totalInputTokens,
    cacheHitPct,
    billableTokens,
    durationMs: toNonNegInt(durationMs),
    requestsByPool: cleanRequests,
    compromised: Boolean(compromised),
  };
}

export class FactoryLedger {
  constructor({
    ledgerFile = null,
    repo = null,
    home,
    maxEntries = MAX_FACTORY_LEDGER_ENTRIES,
  } = {}) {
    this.ledgerFile = ledgerFile
      ? resolve(ledgerFile)
      : defaultFactoryLedgerPath({ repo, ...(home ? { home } : {}) });
    this.lockFile = `${this.ledgerFile}.lock`;
    this.maxEntries = Math.max(10, toNonNegInt(maxEntries) || MAX_FACTORY_LEDGER_ENTRIES);
  }

  readRuns({ limit = null } = {}) {
    const dir = dirname(this.ledgerFile);
    assertNotSymlinkPath(dir);
    assertNotSymlinkPath(this.ledgerFile);
    if (!existsSync(this.ledgerFile)) return [];
    try {
      const raw = readFileSync(this.ledgerFile, 'utf8');
      const entries = [];
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.runId === 'string') {
            entries.push(parsed);
          }
        } catch {}
      }
      if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && entries.length > limit) {
        return entries.slice(-Math.floor(limit));
      }
      return entries;
    } catch {
      return [];
    }
  }

  appendRunSummary(input = {}) {
    const entry = computeRunEconomics(input);
    const dir = dirname(this.ledgerFile);
    assertNotSymlinkPath(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertNotSymlinkPath(dir);
    assertNotSymlinkPath(this.ledgerFile);

    return withLockSync(this.lockFile, () => {
      assertNotSymlinkPath(this.ledgerFile);
      const existing = this.readRuns();
      existing.push(entry);
      const bounded =
        existing.length > this.maxEntries
          ? existing.slice(existing.length - this.maxEntries)
          : existing;
      const tmpPath = `${this.ledgerFile}.tmp-${process.pid}-${randomUUID()}`;
      try {
        writeFileSync(
          tmpPath,
          bounded.map((r) => JSON.stringify(r)).join('\n') + '\n',
          { mode: 0o600, flag: 'wx' }
        );
        if (process.platform !== 'win32') {
          try { chmodSync(tmpPath, 0o600); } catch {}
        }
        renameSync(tmpPath, this.ledgerFile);
      } catch (err) {
        try { rmSync(tmpPath, { force: true }); } catch {}
        throw err;
      }
      return { ok: true, count: bounded.length, entry };
    });
  }

  summarizeEconomics({ recentLimit = 20 } = {}) {
    const allRuns = this.readRuns();
    const recentRuns =
      recentLimit && allRuns.length > recentLimit
        ? allRuns.slice(-recentLimit)
        : allRuns;

    let totalTickets = 0;
    let totalMerged = 0;
    let totalFailed = 0;
    let totalStrike0Merged = 0;
    let totalAutofixSaves = 0;
    let totalUncached = 0;
    let totalCached = 0;
    let totalOutput = 0;
    let totalBillableTokens = 0;

    for (const r of allRuns) {
      totalTickets += toNonNegInt(r.totalTickets);
      totalMerged += toNonNegInt(r.mergedCount);
      totalFailed += toNonNegInt(r.failedCount);
      totalStrike0Merged += toNonNegInt(r.strike0MergedCount);
      totalAutofixSaves += toNonNegInt(r.autofixAppliedCount);
      totalUncached += toNonNegInt(r.uncachedInputTokens);
      totalCached += toNonNegInt(r.cachedTokens);
      totalOutput += toNonNegInt(r.outputTokens);
      totalBillableTokens += toNonNegInt(r.billableTokens);
    }

    const totalInput = totalUncached + totalCached;
    const avgStrike0YieldPct =
      totalTickets > 0 ? round1((totalStrike0Merged / totalTickets) * 100) : 0;
    const avgCacheHitPct =
      totalInput > 0 ? round1((totalCached / totalInput) * 100) : 0;

    return {
      ok: true,
      runs: allRuns.length,
      avgStrike0YieldPct,
      avgCacheHitPct,
      totalTickets,
      totalMerged,
      totalFailed,
      totalStrike0Merged,
      totalAutofixSaves,
      totalBillableTokens,
      recentRuns,
    };
  }
}
