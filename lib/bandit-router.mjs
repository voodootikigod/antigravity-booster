// Closed-Loop Empirical Model Router (v1.4 Pillar 7a).
//
// Persists per-model, per-role outcome records in `<plugin_data>/model_stats.jsonl`
// protected by `withLockSync` and ranks same-tier candidates via deterministic
// seeded Beta-Bernoulli / EWMA scoring (bypassed when `AGB_ROUTER_STATIC=1` or no history exists).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withLockSync } from './pools.mjs';

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
    ts = Date.now(),
  } = {}) {
    if (!model || typeof model !== 'string') return { ok: false, error: 'model is required' };
    const entry = {
      ts,
      model,
      role: String(role || 'builder'),
      tier: String(tier || 'mid'),
      strike0Pass: Boolean(strike0Pass),
      hollowTestKilled: Boolean(hollowTestKilled),
      prosecutorPrecision: Number.isFinite(prosecutorPrecision)
        ? Math.max(0, Math.min(1, Number(prosecutorPrecision)))
        : 1.0,
      latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(Number(latencyMs))) : 0,
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
   * Rank same-tier candidate models using empirical EWMA / Beta-Bernoulli posterior mean.
   * Preserves original candidate order when `staticMode` (`AGB_ROUTER_STATIC=1`) is enabled
   * or when no empirical records match the candidates.
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
      // Uninformative Beta(2, 1) prior favoring default order until evidence accumulates
      statsByModel.set(m, { alpha: 2.0, beta: 1.0, samples: 0 });
    }

    for (const rec of records) {
      const st = statsByModel.get(rec.model);
      if (!st) continue;
      st.alpha *= decay;
      st.beta *= decay;
      const reward =
        (rec.strike0Pass ? 0.65 : 0.0) +
        (rec.hollowTestKilled ? 0.25 : 0.0) +
        0.1 * (rec.prosecutorPrecision ?? 1.0);
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
