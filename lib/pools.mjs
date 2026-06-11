// Per-pool concurrency control + tier routing.
//
// Antigravity quota pools are independent (verified: 4 Gemini + 4 Claude
// concurrent with no mutual interference). The scheduler therefore holds one
// semaphore per pool, and routing spreads load across pools rather than
// queueing on one.

import { MODELS, poolOf, familyOf } from './agy.mjs';

// Probed ceilings (docs/calibration/probes-2026-06-11.md). Gemini Flash
// degrades hard past 8; others unprobed at width — conservative.
export const DEFAULT_CAPS = {
  'gemini-flash': 6,
  'gemini-pro': 4,
  claude: 4,
  'gpt-oss': 2,
};

// Role → tier → candidate models, cheapest-listed first. Cross-pool
// candidates let the router pick the least-loaded pool.
export const TIER_CANDIDATES = {
  cheap: ['Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Low)'],
  mid: ['Claude Sonnet 4.6 (Thinking)', 'Gemini 3.1 Pro (Low)'],
  frontier: ['Claude Opus 4.6 (Thinking)', 'Gemini 3.1 Pro (High)'],
};

// Prosecutor must come from a different family than the builder (ADLC P5:
// fresh context + refute charter are primary, cross-model is the bonus).
export const PROSECUTORS = {
  gemini: 'Claude Sonnet 4.6 (Thinking)',
  claude: 'Gemini 3.1 Pro (High)',
  'gpt-oss': 'Claude Sonnet 4.6 (Thinking)',
};

export class PoolSet {
  constructor(caps = DEFAULT_CAPS) {
    this.caps = { ...DEFAULT_CAPS, ...caps };
    this.inFlight = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    this.requests = Object.fromEntries(Object.keys(MODELS).map((p) => [p, 0]));
    // Per-pool FIFO waiter queues. A waiter is woken by directly handing it
    // a reserved slot (inFlight already incremented), so a synchronous
    // acquire() cannot steal the slot during the microtask gap.
    this.waiters = Object.fromEntries(Object.keys(MODELS).map((p) => [p, []]));
  }

  hasCapacity(model) {
    const pool = poolOf(model);
    return this.inFlight[pool] < this.caps[pool];
  }

  /** Acquire a slot for `model`, waiting (FIFO) if its pool is saturated. */
  async acquire(model) {
    const pool = poolOf(model);
    if (this.inFlight[pool] < this.caps[pool]) {
      this.inFlight[pool] += 1;
      this.requests[pool] += 1;
      return this.#releaser(pool);
    }
    // Saturated: queue and wait to be handed a reserved slot.
    await new Promise((resolve) => this.waiters[pool].push(resolve));
    this.requests[pool] += 1; // slot already reserved on our behalf in #releaser
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
        this.inFlight[pool] -= 1;
      }
    };
  }

  /**
   * Pick a model for a tier: first candidate whose pool has free capacity,
   * else the candidate with the lowest in-flight/cap ratio (will queue).
   * pool_hint ('gemini'|'claude') filters candidates by family.
   */
  route(tier, poolHint) {
    const candidates = (TIER_CANDIDATES[tier] ?? TIER_CANDIDATES.mid).filter(
      (m) => !poolHint || poolHint === 'auto' || familyOf(m) === poolHint
    );
    if (candidates.length === 0) throw new Error(`no candidates for tier=${tier} hint=${poolHint}`);
    for (const m of candidates) if (this.hasCapacity(m)) return m;
    return candidates
      .map((m) => ({ m, load: this.inFlight[poolOf(m)] / this.caps[poolOf(m)] }))
      .sort((a, b) => a.load - b.load)[0].m;
  }

  /** Cross-family prosecutor for a builder model. */
  prosecutorFor(builderModel) {
    return PROSECUTORS[familyOf(builderModel)];
  }

  snapshot() {
    return { inFlight: { ...this.inFlight }, requests: { ...this.requests }, caps: { ...this.caps } };
  }
}
