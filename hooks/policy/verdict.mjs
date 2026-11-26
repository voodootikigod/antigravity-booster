// Verdict helpers. `pass` means neutral pass-through (empty stdout, exit 0);
// booster never emits `allow` (Appendix A D7).
export const PASS = Object.freeze({ decision: 'pass' });

export const deny = (reason) => ({ decision: 'deny', reason });
export const ask = (reason) => ({ decision: 'ask', reason });

export const forceAsk = (reason) => ({ decision: 'force_ask', reason });
export const isInteractivePrompt = (v) => v?.decision === 'ask' || v?.decision === 'force_ask';

const RANK = { pass: 0, ask: 1, force_ask: 2, deny: 3 };

/** Most restrictive verdict wins: deny > ask > pass (A.4 item 5, A.6 item 8). */
export function mostRestrictive(verdicts) {
  let best = PASS;
  for (const v of verdicts) if (RANK[v.decision] > RANK[best.decision]) best = v;
  return best;
}
