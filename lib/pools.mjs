// Per-pool concurrency control + tier routing.
//
// Antigravity quota pools are independent (verified: 4 Gemini + 4 Claude
// concurrent with no mutual interference). The scheduler therefore holds one
// semaphore per pool, and routing spreads load across pools rather than
// queueing on one.

import { MODELS, poolOf, familyOf } from './agy.mjs';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const STATE_FILE = process.env.AGB_QUOTA_STATE ?? join(tmpdir(), 'agb_pools_shared.json');

function readSharedState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function writeSharedState(state) {
  try {
    const cur = readSharedState();
    cur[process.pid] = state;
    const tmpFile = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(cur), { mode: 0o600 });
    renameSync(tmpFile, STATE_FILE);
  } catch {}
}

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
  cheap: ['Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Low)'],
  mid: ['Gemini 3.5 Flash (High)', 'Gemini 3.1 Pro (Low)'],
  frontier: ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (High)'],
};

// Prosecutor must come from a different family than the builder (ADLC P5:
// fresh context + refute charter are primary, cross-model is the bonus).
export const PROSECUTORS = {
  gemini: 'GPT-OSS 120B (Medium)',
  claude: 'Gemini 3.1 Pro (High)',
  'gpt-oss': 'Gemini 3.1 Pro (High)',
};

/**
 * Candidate models for a tier filtered by pool_hint. Exported so plan
 * validation can reject tier/hint combinations with no candidates (e.g.
 * cheap+claude) before a run starts, instead of route() throwing mid-run.
 */
export function tierCandidates(tier, poolHint) {
  return (TIER_CANDIDATES[tier] ?? TIER_CANDIDATES.mid).filter(
    (m) => !poolHint || poolHint === 'auto' || familyOf(m) === poolHint
  );
}

export class PoolSet {
  constructor(caps = DEFAULT_CAPS) {
    this.caps = { ...DEFAULT_CAPS, ...caps };
    this.inFlight = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    this.requests = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    // reserved[pool] = builder tickets ASSIGNED to this pool but not yet
    // finished (route → unroute). Routing balances on this, so many tickets
    // dispatched in the same tick spread across pools instead of all picking
    // the first candidate (whose inFlight is still 0 because slots aren't
    // acquired until the agy call, several awaits later).
    this.reserved = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    // Per-pool FIFO waiter queues. A waiter is woken by directly handing it
    // a reserved slot (inFlight already incremented), so a synchronous
    // acquire() cannot steal the slot during the microtask gap.
    this.waiters = Object.fromEntries(Object.keys(MODELS).map((p) => [p, []]));
  }

  syncSharedState() {
    writeSharedState({ ts: Date.now(), inFlight: this.inFlight, requests: this.requests });
  }

  totalInFlight(pool) {
    let total = this.inFlight[pool] || 0;
    const shared = readSharedState();
    let remoteTotal = 0;
    const now = Date.now();
    for (const [pidStr, state] of Object.entries(shared)) {
      if (Number(pidStr) !== process.pid && state && state.inFlight && (now - (state.ts || 0) < 60000)) {
        remoteTotal += Number(state.inFlight[pool]) || 0;
      }
    }
    return total + remoteTotal;
  }

  hasCapacity(model) {
    const pool = poolOf(model);
    this.syncSharedState();
    return this.totalInFlight(pool) < this.caps[pool];
  }

  /** Acquire a slot for `model`, waiting (FIFO) if its pool is saturated. */
  async acquire(model) {
    const pool = poolOf(model);
    this.syncSharedState();
    if (this.waiters[pool].length === 0 && this.totalInFlight(pool) < this.caps[pool]) {
      this.inFlight[pool] += 1;
      this.requests[pool] += 1;
      this.syncSharedState();
      return this.#releaser(pool);
    }
    // Saturated: queue in FIFO waiters array
    await new Promise((resolve) => this.waiters[pool].push(resolve));
    this.requests[pool] += 1;
    this.syncSharedState();
    return this.#releaser(pool);
  }

  #releaser(pool) {
    let released = false;
    return () => {
      if (released) return; // idempotent — double-release must not free two slots
      released = true;
      const next = this.waiters[pool].shift();
      if (next) {
        // Hand the slot directly to the next waiter; inFlight stays at cap.
        next();
      } else {
        this.inFlight[pool] = Math.max(0, this.inFlight[pool] - 1);
      }
      this.syncSharedState();
    };
  }

  /**
   * Pick a model for a tier and RESERVE it: choose the candidate pool with
   * the lowest reserved-assignment ratio so concurrent dispatches spread
   * across pools (the cross-pool throughput multiplier). The caller must
   * call unroute(model) when the ticket reaches a terminal state.
   * pool_hint ('gemini'|'claude') filters candidates by family.
   */
  route(tier, poolHint) {
    const candidates = tierCandidates(tier, poolHint);
    if (candidates.length === 0) throw new Error(`no candidates for tier=${tier} hint=${poolHint}`);
    const pick = candidates
      .map((m) => ({ m, load: this.reserved[poolOf(m)] / this.caps[poolOf(m)] }))
      .sort((a, b) => a.load - b.load)[0].m;
    this.reserved[poolOf(pick)] += 1;
    return pick;
  }

  /** Release a builder reservation made by route(). */
  unroute(model) {
    const pool = poolOf(model);
    if (this.reserved[pool] > 0) this.reserved[pool] -= 1;
  }

  /** Cross-family prosecutor for a builder model. */
  prosecutorFor(builderModel) {
    return PROSECUTORS[familyOf(builderModel)];
  }

  snapshot() {
    return { inFlight: { ...this.inFlight }, requests: { ...this.requests }, caps: { ...this.caps } };
  }
}
