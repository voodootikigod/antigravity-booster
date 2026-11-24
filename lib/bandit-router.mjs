// Closed-Loop Empirical Model Router (v1.4 Pillar 7a / v2.0 Billable-Token Efficiency).
//
// Persists per-model, per-role outcome records in `<plugin_data>/model_stats.jsonl`
// protected by `withLockSync` and ranks same-tier candidates via deterministic
// seeded Beta-Bernoulli / EWMA scoring weighted by normalized per-worker token efficiency.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withLockSync } from './pools.mjs';
import { upstreamPoolOf } from './models.mjs';

export const MAX_STATS_ENTRIES = 2000;

export function defaultStatsFilePath(home = process.env.AGB_HOME_DIR || homedir()) {
  if (process.env.AGB_MODEL_STATS_FILE) return process.env.AGB_MODEL_STATS_FILE;
  return join(
    home,
    '.gemini',
    'antigravity-cli',
    'plugin_data',
    'antigravity-booster',
    'model_stats.jsonl'
  );
}

function deterministicUnitNoise(seed, model, idx) {
  if (seed === null || seed === undefined || seed === '') return 0;
  const digest = createHash('sha256')
    .update(`${seed}:${model}:${idx}`)
    .digest();
  const uint32 = digest.readUInt32BE(0);
  return (uint32 / 0xffffffff) * 0.05;
}

function toNonNegInt(v) {
  return Number.isFinite(v) && v > 0 ? Math.round(Number(v)) : 0;
}

export function computeBillableTokenCostFactor(rec = {}) {
  const cached = toNonNegInt(rec.cachedTokens);
  const output = toNonNegInt(rec.outputTokens);
  const explicitUncached = Number.isFinite(rec.uncachedInputTokens)
    ? toNonNegInt(rec.uncachedInputTokens)
    : null;
  const totalInput = toNonNegInt(rec.inputTokens);
  const uncached =
    explicitUncached !== null
      ? explicitUncached
      : totalInput >= cached
      ? totalInput - cached
      : totalInput;

  const billableTokens = uncached + 0.1 * cached + 3 * output;
  if (!(billableTokens > 0)) return 1.0;
  // Bounded strictly in [1 / 1.35 (~0.7407), 1.0]
  return 1 / (1 + Math.min(0.35, billableTokens / 250_000));
}

export class BanditModelRouter {
  constructor({ statsFile = defaultStatsFilePath(), maxEntries = MAX_STATS_ENTRIES } = {}) {
    this.statsFile = statsFile;
    this.lockFile = `${statsFile}.lock`;
    this.maxEntries = Math.max(10, maxEntries);
  }

  readRecords() {
    if (!existsSync(this.statsFile)) return [];
    try {
      const raw = readFileSync(this.statsFile, 'utf8');
      const records = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj.model === 'string') records.push(obj);
        } catch {}
      }
      return records;
    } catch {
      return [];
    }
  }

  recordOutcome({
    model,
    role = 'builder',
    tier = 'mid',
    strike0Pass = true,
    hollowTestKilled = true,
    prosecutorPrecision = 1.0,
    latencyMs = 0,
    effort = null,
    uncachedInputTokens = null,
    cachedTokens = 0,
    outputTokens = 0,
    inputTokens = 0,
    quotaDeltaPct = null,
    ts = Date.now(),
  } = {}) {
    if (!model || typeof model !== 'string') return { ok: false, error: 'model is required' };
    let pool = null;
    try {
      pool = upstreamPoolOf(model);
    } catch {}

    const normCached = toNonNegInt(cachedTokens);
    const normOutput = toNonNegInt(outputTokens);
    const normInput = toNonNegInt(inputTokens);
    const normUncached =
      uncachedInputTokens !== null && uncachedInputTokens !== undefined
        ? toNonNegInt(uncachedInputTokens)
        : normInput >= normCached
        ? normInput - normCached
        : normInput;
    const normTotalInput = Math.max(normInput, normUncached + normCached);
    const normQuotaDelta =
      typeof quotaDeltaPct === 'number' && Number.isFinite(quotaDeltaPct) && quotaDeltaPct >= 0
        ? Math.round(quotaDeltaPct * 1000) / 1000
        : null;

    const entry = {
      ts,
      model,
      pool,
      role: String(role || 'builder'),
      tier: String(tier || 'mid'),
      effort: typeof effort === 'string' && effort.trim() ? effort.trim() : null,
      strike0Pass: Boolean(strike0Pass),
      hollowTestKilled: Boolean(hollowTestKilled),
      prosecutorPrecision: Number.isFinite(prosecutorPrecision)
        ? Math.max(0, Math.min(1, Number(prosecutorPrecision)))
        : 1.0,
      latencyMs: toNonNegInt(latencyMs),
      uncachedInputTokens: normUncached,
      cachedTokens: normCached,
      outputTokens: normOutput,
      inputTokens: normTotalInput,
      quotaDeltaPct: normQuotaDelta,
    };

    const dir = dirname(this.statsFile);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    return withLockSync(this.lockFile, () => {
      const existing = this.readRecords();
      existing.push(entry);
      const bounded =
        existing.length > this.maxEntries
          ? existing.slice(existing.length - this.maxEntries)
          : existing;
      const tmpPath = `${this.statsFile}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(
        tmpPath,
        bounded.map((r) => JSON.stringify(r)).join('\n') + '\n',
        { mode: 0o600 }
      );
      renameSync(tmpPath, this.statsFile);
      return { ok: true, count: bounded.length, entry };
    });
  }

  /**
   * Rank same-tier candidate models using empirical EWMA / Beta-Bernoulli posterior mean
   * scaled by normalized per-worker billable-token efficiency.
   */
  rankCandidates(
    candidates = [],
    {
      role = 'builder',
      tier = 'mid',
      seed = null,
      staticMode = process.env.AGB_ROUTER_STATIC === '1',
      decay = 0.85,
    } = {}
  ) {
    if (!Array.isArray(candidates) || candidates.length <= 1) return [...(candidates || [])];
    if (staticMode) return [...candidates];

    const records = this.readRecords().filter(
      (r) =>
        (!role || r.role === role) &&
        (!tier || r.tier === tier) &&
        candidates.includes(r.model)
    );
    if (records.length === 0) return [...candidates];

    const statsByModel = new Map();
    for (const m of candidates) {
      statsByModel.set(m, { alpha: 2.0, beta: 1.0, samples: 0 });
    }

    const cohortHasTelemetry = records.some(
      (r) =>
        toNonNegInt(r.uncachedInputTokens) > 0 ||
        toNonNegInt(r.cachedTokens) > 0 ||
        toNonNegInt(r.outputTokens) > 0 ||
        toNonNegInt(r.inputTokens) > 0
    );
    const MISSING_TELEMETRY_FACTOR = 1 / 1.15;

    for (const rec of records) {
      const st = statsByModel.get(rec.model);
      if (!st) continue;
      st.alpha *= decay;
      st.beta *= decay;
      const rawReward =
        (rec.strike0Pass ? 0.65 : 0.0) +
        (rec.hollowTestKilled ? 0.25 : 0.0) +
        0.1 * (rec.prosecutorPrecision ?? 1.0);
      const recHasTelemetry =
        toNonNegInt(rec.uncachedInputTokens) > 0 ||
        toNonNegInt(rec.cachedTokens) > 0 ||
        toNonNegInt(rec.outputTokens) > 0 ||
        toNonNegInt(rec.inputTokens) > 0;
      const costFactor =
        cohortHasTelemetry && !recHasTelemetry
          ? MISSING_TELEMETRY_FACTOR
          : computeBillableTokenCostFactor(rec);
      const reward = rawReward * costFactor;
      st.alpha += reward;
      st.beta += Math.max(0, 1 - reward);
      st.samples += 1;
    }

    const scored = candidates.map((model, originalIndex) => {
      const st = statsByModel.get(model);
      const posteriorMean = st.alpha / (st.alpha + st.beta);
      const tieBreak = deterministicUnitNoise(seed, model, originalIndex);
      return {
        model,
        originalIndex,
        samples: st.samples,
        score: posteriorMean + tieBreak,
      };
    });

    scored.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
      return a.originalIndex - b.originalIndex;
    });

    return scored.map((s) => s.model);
  }
}
