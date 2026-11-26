// Single source of truth for model slugs, aliases, tiers, prosecutors, and role defaults.
import { AsyncLocalStorage } from 'node:async_hooks';

// Live catalog as of agy 1.5.13 (`agy models`). `agb doctor` reports drift.
export const MODELS = {
  'gemini-flash': ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
  'gemini-pro': [
    'gemini-4-argon-low',
    'gemini-4-argon-medium',
    'gemini-4-argon-high',
    'gemini-4-carbon-low',
    'gemini-4-carbon-medium',
    'gemini-4-carbon-high',
    'gemini-4-hydrogen-low',
    'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-xhigh',
    'gemini-4-neon-low',
    'gemini-4-neon-medium',
    'gemini-4-neon-high',
    'gemini-4-neon-xhigh',
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'gemini-pro-orchestrator-neon',
  ],
  claude: [
    'claude-sonnet-5-5-low',
    'claude-sonnet-5-5-medium',
    'claude-sonnet-5-5-high',
    'claude-opus-5-5-low',
    'claude-opus-5-5-medium',
    'claude-opus-5-5-high',
  ],
  'gpt-oss': ['gpt-oss-120b-medium'],
};

export const ALL_MODELS = Object.freeze(Object.values(MODELS).flat());

export const MODEL_ALIASES = {
  'gemini 3.8 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.8 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.8 flash (high)': 'gemini-3.8-flash-high',
  'gemini 4 argon (low)': 'gemini-4-argon-low',
  'gemini 4 argon (medium)': 'gemini-4-argon-medium',
  'gemini 4 argon (high)': 'gemini-4-argon-high',
  'gemini 4 carbon (low)': 'gemini-4-carbon-low',
  'gemini 4 carbon (medium)': 'gemini-4-carbon-medium',
  'gemini 4 carbon (high)': 'gemini-4-carbon-high',
  'gemini 4 hydrogen (low)': 'gemini-4-hydrogen-low',
  'gemini 4 hydrogen (medium)': 'gemini-4-hydrogen-medium',
  'gemini 4 hydrogen (high)': 'gemini-4-hydrogen-high',
  'gemini 4 hydrogen (xhigh)': 'gemini-4-hydrogen-xhigh',
  'gemini 4 neon (low)': 'gemini-4-neon-low',
  'gemini 4 neon (medium)': 'gemini-4-neon-medium',
  'gemini 4 neon (high)': 'gemini-4-neon-high',
  'gemini 4 neon (xhigh)': 'gemini-4-neon-xhigh',
  'orchestrator (carbon)': 'gemini-pro-orchestrator',
  'orchestrator (argon)': 'gemini-pro-orchestrator-argon',
  'orchestrator (neon)': 'gemini-pro-orchestrator-neon',
  'claude sonnet 5.5 (low)': 'claude-sonnet-5-5-low',
  'claude sonnet 5.5 (medium)': 'claude-sonnet-5-5-medium',
  'claude sonnet 5.5 (high)': 'claude-sonnet-5-5-high',
  'claude opus 5.5 (low)': 'claude-opus-5-5-low',
  'claude opus 5.5 (medium)': 'claude-opus-5-5-medium',
  'claude opus 5.5 (high)': 'claude-opus-5-5-high',
  'gpt-oss 120b (medium)': 'gpt-oss-120b-medium',
};

// Retired upstream -> live replacement (like-for-like effort and family).
// Keys are the lowercase slug and display-name spellings; resolveModelSlug
// warns when it remaps one.
const RETIRED_FLASH_GENERATIONS = ['3.5', '3.6', '3.7'];
const EFFORTS = ['low', 'medium', 'high'];
const retiredEntries = [
  ...RETIRED_FLASH_GENERATIONS.flatMap((gen) =>
    EFFORTS.flatMap((e) => [
      [`gemini-${gen}-flash-${e}`, `gemini-3.8-flash-${e}`],
      [`gemini ${gen} flash (${e})`, `gemini-3.8-flash-${e}`],
    ]),
  ),
  ...['low', 'high'].flatMap((e) => [
    [`gemini-3.1-pro-${e}`, `gemini-4-argon-${e}`],
    [`gemini 3.1 pro (${e})`, `gemini-4-argon-${e}`],
  ]),
  ['claude-sonnet-4-6', 'claude-sonnet-5-5-medium'],
  ['claude sonnet 4.6 (thinking)', 'claude-sonnet-5-5-medium'],
  ['claude-opus-4-6-thinking', 'claude-opus-5-5-high'],
  ['claude opus 4.6 (thinking)', 'claude-opus-5-5-high'],
];
export const RETIRED_MODEL_MAP = Object.freeze(Object.fromEntries(retiredEntries));

/** @deprecated Alias of RETIRED_MODEL_MAP, kept for lib/agy.mjs's re-export contract. */
export const RETIRED_35_MAP = RETIRED_MODEL_MAP;

// Role -> tier -> candidate models, cheapest-listed first. Cross-pool
// candidates let the router pick the least-loaded pool. Opus is frontier-only;
// Orchestrator slugs sit on the frontier builder tier (agy >= 1.5.9) and are
// excluded from cheap/mid builder tiers and all prosecutor/role tables.
export const ORCHESTRATOR_MODELS = new Set([
  'gemini-pro-orchestrator',
  'gemini-pro-orchestrator-argon',
  'gemini-pro-orchestrator-neon',
]);

export const FRONTIER_NO_ORCHESTRATOR = Object.freeze([
  'gemini-4-argon-high',
  'claude-sonnet-5-5-high',
  'gemini-4-carbon-high',
  'gemini-4-neon-high',
  'claude-opus-5-5-high',
]);

export const TIER_CANDIDATES = {
  cheap: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium'],
  mid: [
    'gemini-3.8-flash-high',
    'gemini-4-argon-low',
    'gemini-4-carbon-medium',
    'gemini-4-hydrogen-medium',
    'gemini-4-neon-medium',
    'claude-sonnet-5-5-medium',
  ],
  frontier: Object.freeze([
    'gemini-pro-orchestrator',
    'claude-sonnet-5-5-high',
    'gemini-pro-orchestrator-argon',
    'gemini-pro-orchestrator-neon',
    'gemini-4-argon-high',
    'gemini-4-carbon-high',
    'gemini-4-neon-high',
    'claude-opus-5-5-high',
  ]),
};

// Prosecutor must come from a different family than the builder (ADLC P5:
// fresh context + refute charter are primary, cross-model is the bonus).
export const PROSECUTORS = {
  gemini: 'gpt-oss-120b-medium',
  claude: 'gemini-4-argon-high',
  'gpt-oss': 'gemini-4-argon-high',
};

export const PROSECUTOR_CANDIDATES = {
  gemini: ['gpt-oss-120b-medium', 'claude-sonnet-5-5-medium'],
  claude: ['gemini-4-argon-high', 'gemini-4-carbon-high', 'gemini-4-neon-high', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium'],
  'gpt-oss': ['gemini-4-argon-high', 'gemini-4-carbon-high', 'gemini-4-neon-high', 'gemini-3.8-flash-high', 'claude-sonnet-5-5-medium'],
};

export const CODE_ARL_LENSES = Object.freeze([
  'correctness_redteam',
  'security',
  'simplicity',
  'evidence_runner',
  'anti_slop',
]);

export const PLAN_ARL_LENSES = Object.freeze([
  'devils_advocate',
  'requirements_fidelity',
  'simplicity',
  'evidence_strategy',
  'dag_topology',
]);

export const ARL_LENS_MODELS = Object.freeze({
  correctness_redteam: { primary: 'claude-opus-5-5-high', fallback: 'gemini-4-argon-high' },
  security: { primary: 'gemini-4-argon-high', fallback: 'claude-opus-5-5-high' },
  simplicity: { primary: 'claude-sonnet-5-5-medium', fallback: 'gemini-3.8-flash-medium' },
  evidence_runner: { primary: 'gemini-3.8-flash-medium', fallback: 'claude-sonnet-5-5-medium' },
  anti_slop: { primary: 'claude-sonnet-5-5-high', fallback: 'gemini-3.8-flash-high' },
  devils_advocate: { primary: 'claude-opus-5-5-high', fallback: 'gemini-4-argon-high' },
  requirements_fidelity: { primary: 'gemini-4-argon-medium', fallback: 'claude-sonnet-5-5-high' },
  evidence_strategy: { primary: 'gemini-3.8-flash-medium', fallback: 'claude-sonnet-5-5-medium' },
  dag_topology: { primary: 'gemini-4-argon-high', fallback: 'claude-opus-5-5-high' },
  arbiter: { primary: 'gemini-4-argon-high', fallback: 'claude-opus-5-5-high' },
});

export const ROLE_MODELS = {
  coldstart: 'gemini-3.8-flash-low',
  premortem: 'gemini-4-argon-high',
  parallaxReader: 'gemini-3.8-flash-medium',
  parallaxJudge: 'gemini-4-argon-high',
  brainConvert: 'gemini-4-argon-high',
  brainRepair: 'gemini-4-argon-high',
  arbiter: 'gemini-4-argon-high',
  probeDefault: 'Gemini 3.8 Flash (Low)',
  reviewFleetAlternates: ['gemini-3.8-flash-high', 'gemini-4-argon-high'],
};

export function modelFor(role) {
  if (!Object.hasOwn(ROLE_MODELS, role)) {
    throw new Error('Unknown model role: ' + role);
  }
  return ROLE_MODELS[role];
}

export function resolveModelSlug(model) {
  if (typeof model !== 'string') return model;
  const normalized = model.trim().toLowerCase();
  // hasOwn, not truthiness: '__proto__' / 'constructor' / 'toString' are
  // inherited keys on a plain object and must never resolve to a "model".
  if (Object.hasOwn(RETIRED_MODEL_MAP, normalized)) {
    const resolved = RETIRED_MODEL_MAP[normalized];
    console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    return resolved;
  }
  if (Object.hasOwn(MODEL_ALIASES, normalized)) return MODEL_ALIASES[normalized];
  for (const list of Object.values(MODELS)) {
    for (const slug of list) {
      if (slug.toLowerCase() === normalized) return slug;
    }
  }
  return model;
}

/** Quota pool for a model name (pools throttle + meter independently). */
export function poolOf(model) {
  const slug = resolveModelSlug(model);
  for (const [pool, models] of Object.entries(MODELS)) {
    if (models.includes(slug)) return pool;
  }
  // Fallback prefix check
  if (typeof slug !== 'string') throw new Error(`unknown model: ${slug}`);
  const normalized = slug.toLowerCase();
  if (normalized.includes('flash')) return 'gemini-flash';
  if (normalized.includes('gemini') || normalized.includes('hydrogen')) return 'gemini-pro';
  if (normalized.includes('claude') || normalized.includes('sonnet') || normalized.includes('opus')) return 'claude';
  if (normalized.includes('gpt')) return 'gpt-oss';

  throw new Error(`unknown model: ${slug}`);
}

/** Model family for cross-model prosecution ('gemini' | 'claude' | 'gpt-oss'). */
export function familyOf(model) {
  const pool = poolOf(model);
  return pool.startsWith('gemini') ? 'gemini' : pool;
}

export function upstreamPoolOf(model) {
  const pool = poolOf(model);
  return pool.startsWith('gemini') ? 'gemini' : 'claude_gpt';
}

function toModelSet(v) {
  return v instanceof Set ? v : (Array.isArray(v) ? new Set(v) : null);
}

const runtimeState = {
  disableOrchestrator: false,
  disabledModels: null,
};

const routingAls = new AsyncLocalStorage();

export function setOrchestratorRoutingState({ disableOrchestrator = false, disabledModels = null } = {}) {
  runtimeState.disableOrchestrator = Boolean(disableOrchestrator);
  runtimeState.disabledModels = toModelSet(disabledModels);
}

export function resetOrchestratorRoutingState() {
  runtimeState.disableOrchestrator = false;
  runtimeState.disabledModels = null;
}

export function runWithOrchestratorRoutingState({ disableOrchestrator = false, disabledModels = null } = {}, fn) {
  const store = {
    disableOrchestrator: Boolean(disableOrchestrator),
    disabledModels: toModelSet(disabledModels),
  };
  return routingAls.run(store, () => fn(store));
}

/**
 * Candidate models for a tier filtered by pool_hint and active Orchestrator/demotion state.
 * Exported so plan validation can reject tier/hint combinations with no candidates (e.g.
 * cheap+claude) before a run starts, instead of route() throwing mid-run.
 */
export function tierCandidates(tier = 'mid', poolHint, options) {
  const activeState = routingAls.getStore() ?? runtimeState;
  const effectiveTier = TIER_CANDIDATES[tier] ? tier : 'mid';
  const disableOrchestrator =
    Boolean(options?.disableOrchestrator ?? activeState.disableOrchestrator) ||
    process.env.AGB_DISABLE_ORCHESTRATOR === '1';
  const base = effectiveTier === 'frontier' && disableOrchestrator
    ? FRONTIER_NO_ORCHESTRATOR
    : TIER_CANDIDATES[effectiveTier];
  const disabledSet = options?.disabledModels !== undefined
    ? toModelSet(options.disabledModels)
    : activeState.disabledModels;
  return base.filter((m) => {
    if (disabledSet && disabledSet.has(m)) return false;
    if (!poolHint || poolHint === 'auto') return true;
    const fam = familyOf(m);
    if (poolHint === 'claude-gpt') return fam === 'claude' || fam === 'gpt-oss';
    return fam === poolHint;
  });
}

export const VALID_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const SLUG_EFFORT_LADDER = Object.freeze(['low', 'medium', 'high', 'xhigh']);

/**
 * Step a suffixed live-catalog model slug up one effort tier within its exact model base
 * (`-low -> -medium -> -high -> -xhigh`) ONLY when the stepped-up slug exists in `ALL_MODELS`.
 * Leaves orchestrator slugs, ceiling slugs (e.g. `claude-opus-5-5-high`), and non-catalog strings unchanged.
 */
export function escalateModelSlugInFamily(modelSlug) {
  const slug = resolveModelSlug(modelSlug);
  if (typeof slug !== 'string' || !slug || ORCHESTRATOR_MODELS.has(slug)) {
    return slug;
  }
  const m = /^(.+)-(low|medium|high|xhigh)$/.exec(slug);
  if (!m) return slug;
  const [, basePrefix, curEffort] = m;
  const idx = SLUG_EFFORT_LADDER.indexOf(curEffort);
  if (idx < 0 || idx + 1 >= SLUG_EFFORT_LADDER.length) return slug;
  const candidate = `${basePrefix}-${SLUG_EFFORT_LADDER[idx + 1]}`;
  return ALL_MODELS.includes(candidate) ? candidate : slug;
}

/**
 * Compute an explicit CLI `--effort` flag ONLY when warranted:
 *   1. `explicitEffort` (`ticket.effort`) in `VALID_EFFORTS` always wins.
 *   2. On Strike 0, `defaultEffort` (`AGB_DEFAULT_EFFORT`) in `VALID_EFFORTS` wins.
 *   3. `ORCHESTRATOR_MODELS` receive `'high'` on Strike 0 and `'xhigh'`/`'max'` on Strike >= 1.
 *   4. All fixed-effort catalog slugs (`-low`/`-medium`/`-high`/`-xhigh`) return `null`
 *      so `--effort` never contradicts the slug or downgrades `-high` prosecutors/lenses.
 */
export function selectCliEffortFlag({
  model = '',
  tier = 'mid',
  strike = 0,
  explicitEffort = null,
  defaultEffort = process.env.AGB_DEFAULT_EFFORT || null,
  allowMax = false,
} = {}) {
  void tier;
  const normExplicit = typeof explicitEffort === 'string' ? explicitEffort.trim().toLowerCase() : '';
  if (VALID_EFFORTS.includes(normExplicit)) return normExplicit;

  const normDefault = typeof defaultEffort === 'string' ? defaultEffort.trim().toLowerCase() : '';
  if (strike === 0 && VALID_EFFORTS.includes(normDefault)) return normDefault;

  const slug = resolveModelSlug(model);
  if (typeof slug === 'string' && ORCHESTRATOR_MODELS.has(slug)) {
    if (strike <= 0) return 'high';
    return allowMax ? 'max' : 'xhigh';
  }
  return null;
}

function isModelPoolAvailable(model, pools) {
  if (!pools || typeof pools !== 'object') return true;
  let pool;
  let upstream;
  try {
    pool = poolOf(model);
    upstream = upstreamPoolOf(model);
  } catch {
    return false;
  }
  if (pools.caps && typeof pools.caps === 'object') {
    if ((pools.caps[pool] ?? 0) <= 0) return false;
    if (typeof pools.familyCap === 'function' && pools.familyCap(upstream) <= 0) return false;
    return true;
  }
  if (typeof pools.hasCapacity === 'function') {
    try {
      return Boolean(pools.hasCapacity(model));
    } catch {
      return false;
    }
  }
  if (typeof pools.isAvailable === 'function') {
    try {
      return Boolean(pools.isAvailable(model));
    } catch {
      return false;
    }
  }
  return true;
}

const RISK_TIERED_PROSECUTOR_CANDIDATES = Object.freeze({
  low: Object.freeze({
    gemini: Object.freeze(['gpt-oss-120b-medium', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium']),
    claude: Object.freeze(['gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium']),
    'gpt-oss': Object.freeze(['gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'claude-sonnet-5-5-low']),
  }),
  medium: Object.freeze({
    gemini: Object.freeze(['claude-sonnet-5-5-medium', 'gpt-oss-120b-medium', 'claude-sonnet-5-5-low']),
    claude: Object.freeze(['gemini-4-argon-medium', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium']),
    'gpt-oss': Object.freeze(['gemini-4-argon-medium', 'gemini-3.8-flash-high', 'claude-sonnet-5-5-medium']),
  }),
});

/**
 * Select a cross-family prosecutor scaled to ticket risk (`blastRadius` + `ticketTier`).
 * Strictly preserves `familyOf(prosecutor) !== familyOf(builderModel)` and respects
 * pool availability when `pools` is provided.
 */
export function selectRiskTieredProsecutor(
  builderModel,
  { blastRadius = 'high', ticketTier = 'mid', pools } = {}
) {
  const builderFamily = familyOf(builderModel);
  const normRisk = String(blastRadius ?? 'high').trim().toLowerCase();
  const normTier = String(ticketTier ?? 'mid').trim().toLowerCase();

  let rawCandidates;
  if (normRisk === 'low' && normTier !== 'frontier') {
    rawCandidates = RISK_TIERED_PROSECUTOR_CANDIDATES.low[builderFamily];
  } else if (normRisk === 'medium' && normTier !== 'frontier') {
    rawCandidates = RISK_TIERED_PROSECUTOR_CANDIDATES.medium[builderFamily];
  } else {
    rawCandidates = PROSECUTOR_CANDIDATES[builderFamily];
  }

  const baseList =
    Array.isArray(rawCandidates) && rawCandidates.length > 0
      ? rawCandidates
      : [PROSECUTORS[builderFamily] || PROSECUTORS.claude];
  const candidates = baseList.filter((m) => familyOf(m) !== builderFamily);
  if (candidates.length === 0) {
    throw new Error(`No cross-family prosecutor candidates available for builder family '${builderFamily}'`);
  }

  for (const m of candidates) {
    if (isModelPoolAvailable(m, pools)) return m;
  }
  return candidates[0];
}

/**
 * Select a review lens model scaled to `blastRadius` ('low' | 'medium' | 'high'),
 * preserving family diversity across lenses from `ARL_LENS_MODELS` and respecting
 * `fallbackIndex` and `pools` availability.
 */
export function selectRiskTieredLensModel(
  lens,
  { blastRadius = 'high', pools, fallbackIndex = 0 } = {}
) {
  const entry = Object.hasOwn(ARL_LENS_MODELS, lens)
    ? ARL_LENS_MODELS[lens]
    : ARL_LENS_MODELS.arbiter;
  const primaryFamily = familyOf(entry.primary);
  const primaryPool = poolOf(entry.primary);
  const normRisk = String(blastRadius ?? 'high').trim().toLowerCase();

  let candidates;
  if (normRisk === 'low') {
    candidates =
      primaryFamily === 'gemini'
        ? ['gemini-3.8-flash-medium', 'claude-sonnet-5-5-low']
        : ['claude-sonnet-5-5-low', 'gemini-3.8-flash-medium'];
  } else if (normRisk === 'medium') {
    if (primaryFamily === 'gemini') {
      candidates =
        primaryPool === 'gemini-flash'
          ? ['gemini-3.8-flash-high', 'claude-sonnet-5-5-medium', 'gemini-4-argon-medium']
          : ['gemini-4-argon-medium', 'gemini-3.8-flash-high', 'claude-sonnet-5-5-medium'];
    } else {
      candidates = ['claude-sonnet-5-5-medium', 'gemini-4-argon-medium', 'gemini-3.8-flash-high'];
    }
  } else {
    candidates = [entry.primary, entry.fallback].filter(Boolean);
  }

  const idx = Math.max(0, Math.min(candidates.length - 1, Math.floor(Number(fallbackIndex) || 0)));
  const ordered = idx > 0 ? [...candidates.slice(idx), ...candidates.slice(0, idx)] : candidates;

  for (const m of ordered) {
    if (isModelPoolAvailable(m, pools)) return m;
  }
  return ordered[0];
}
