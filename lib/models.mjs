// Single source of truth for model slugs, aliases, tiers, prosecutors, and role defaults.
import { AsyncLocalStorage } from 'node:async_hooks';

// Live catalog post-November 30, 2026 (`agy models`; Argon, 3.8 Flash, GPT-OSS-120b, and Claude 4.6 retired).
export const MODELS = {
  'gemini-flash': [
    'gemini-4-hydrogen-low',
    'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-xhigh',
  ],
  'gemini-pro': [
    'gemini-4-neon-low',
    'gemini-4-neon-medium',
    'gemini-4-neon-high',
    'gemini-4-neon-xhigh',
    'gemini-4-carbon-low',
    'gemini-4-carbon-medium',
    'gemini-4-carbon-high',
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator',
  ],
  claude: [
    'claude-sonnet-5-5-low',
    'claude-sonnet-5-5-medium',
    'claude-sonnet-5-5-high',
    'claude-opus-5-5-low',
    'claude-opus-5-5-medium',
    'claude-opus-5-5-high',
  ],
  'gpt-oss': [],
};

export const ALL_MODELS = Object.freeze(Object.values(MODELS).flat());

export const MODEL_ALIASES = {
  'gemini 4 hydrogen (low)': 'gemini-4-hydrogen-low',
  'gemini 4 hydrogen (medium)': 'gemini-4-hydrogen-medium',
  'gemini 4 hydrogen (high)': 'gemini-4-hydrogen-high',
  'gemini 4 hydrogen (xhigh)': 'gemini-4-hydrogen-xhigh',
  'gemini 4 neon (low)': 'gemini-4-neon-low',
  'gemini 4 neon (medium)': 'gemini-4-neon-medium',
  'gemini 4 neon (high)': 'gemini-4-neon-high',
  'gemini 4 neon (xhigh)': 'gemini-4-neon-xhigh',
  'gemini 4 carbon (low)': 'gemini-4-carbon-low',
  'gemini 4 carbon (medium)': 'gemini-4-carbon-medium',
  'gemini 4 carbon (high)': 'gemini-4-carbon-high',
  'orchestrator (neon)': 'gemini-pro-orchestrator-neon',
  'orchestrator (carbon)': 'gemini-pro-orchestrator',
  'claude sonnet 5.5 (low)': 'claude-sonnet-5-5-low',
  'claude sonnet 5.5 (medium)': 'claude-sonnet-5-5-medium',
  'claude sonnet 5.5 (high)': 'claude-sonnet-5-5-high',
  'claude opus 5.5 (low)': 'claude-opus-5-5-low',
  'claude opus 5.5 (medium)': 'claude-opus-5-5-medium',
  'claude opus 5.5 (high)': 'claude-opus-5-5-high',
};

// Gemini Enterprise accounts continue to expose 3.7 Flash, 3.6 Flash, and 3.1 Pro
// (`https://antigravity.google/docs/models/`). Normalize display names and case
// cleanly without emitting a retirement warning or polluting standard ALL_MODELS.
const EFFORTS = ['low', 'medium', 'high'];
export const ENTERPRISE_MODEL_ALIASES = Object.freeze(
  Object.fromEntries([
    ...['3.6', '3.7'].flatMap((gen) =>
      EFFORTS.flatMap((e) => [
        [`gemini-${gen}-flash-${e}`, `gemini-${gen}-flash-${e}`],
        [`gemini ${gen} flash (${e})`, `gemini-${gen}-flash-${e}`],
      ]),
    ),
    ...['low', 'high'].flatMap((e) => [
      [`gemini-3.1-pro-${e}`, `gemini-3.1-pro-${e}`],
      [`gemini 3.1 pro (${e})`, `gemini-3.1-pro-${e}`],
    ]),
  ]),
);

// Retired upstream -> live replacement (like-for-like effort and family).
// Keys are the lowercase slug and display-name spellings; resolveModelSlug
// warns when it remaps one.
const RETIRED_FLASH_GENERATIONS = ['3.5', '3.8'];
const retiredEntries = [
  ...RETIRED_FLASH_GENERATIONS.flatMap((gen) =>
    EFFORTS.flatMap((e) => [
      [`gemini-${gen}-flash-${e}`, `gemini-4-hydrogen-${e}`],
      [`gemini ${gen} flash (${e})`, `gemini-4-hydrogen-${e}`],
    ]),
  ),
  ...EFFORTS.flatMap((e) => [
    [`gemini-4-argon-${e}`, `gemini-4-neon-${e}`],
    [`gemini 4 argon (${e})`, `gemini-4-neon-${e}`],
  ]),
  ['gemini-pro-orchestrator-argon', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (argon)', 'gemini-pro-orchestrator-neon'],
  ['gpt-oss-120b-medium', 'claude-sonnet-5-5-medium'],
  ['gpt-oss 120b (medium)', 'claude-sonnet-5-5-medium'],
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
  'gemini-pro-orchestrator-neon',
  'gemini-pro-orchestrator',
]);

export const FRONTIER_NO_ORCHESTRATOR = Object.freeze([
  'gemini-4-neon-high',
  'claude-sonnet-5-5-high',
  'gemini-4-carbon-high',
  'claude-opus-5-5-high',
]);

export const TIER_CANDIDATES = {
  cheap: ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium'],
  mid: [
    'gemini-4-hydrogen-high',
    'gemini-4-neon-low',
    'gemini-4-neon-medium',
    'gemini-4-carbon-medium',
    'claude-sonnet-5-5-medium',
  ],
  frontier: Object.freeze([
    'gemini-pro-orchestrator-neon',
    'claude-sonnet-5-5-high',
    'gemini-pro-orchestrator',
    'gemini-4-neon-high',
    'gemini-4-carbon-high',
    'claude-opus-5-5-high',
  ]),
};

// Prosecutor must come from a different family than the builder when cross-family
// quota is available (ADLC P5: fresh context + refute charter are primary, cross-model is the bonus).
export const PROSECUTORS = {
  gemini: 'claude-sonnet-5-5-high',
  claude: 'gemini-4-neon-high',
  'gpt-oss': 'gemini-4-neon-high',
};

export const PROSECUTOR_CANDIDATES = {
  gemini: ['claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'claude-opus-5-5-high'],
  claude: ['gemini-4-neon-high', 'gemini-4-carbon-high', 'gemini-4-hydrogen-high'],
  'gpt-oss': ['gemini-4-neon-high', 'gemini-4-carbon-high', 'gemini-4-hydrogen-high', 'claude-sonnet-5-5-medium'],
};

/**
 * Distinct fresh-context same-family prosecutor fallbacks used when the opposite
 * upstream quota pool has 0 capacity (e.g. Free/Plus/Pro-Trial Gemini-only tiers
 * or an exhausted Claude 5-hour window). Never returns Orchestrator or the
 * exact model variant that built the ticket.
 */
export function sameFamilyProsecutorsFor(builderModel) {
  const slug = resolveModelSlug(builderModel);
  const fam = familyOf(slug);
  const norm = String(slug ?? '').toLowerCase();
  if (fam === 'gemini') {
    if (norm.includes('neon')) {
      return ['gemini-4-carbon-high', 'gemini-4-hydrogen-high'];
    }
    if (norm.includes('hydrogen')) {
      return ['gemini-4-neon-high', 'gemini-4-carbon-high'];
    }
    return ['gemini-4-neon-high', 'gemini-4-hydrogen-high'];
  }
  if (fam === 'claude') {
    return norm.includes('opus') ? ['claude-sonnet-5-5-high'] : ['claude-opus-5-5-high'];
  }
  return [];
}

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
  correctness_redteam: { primary: 'claude-opus-5-5-high', fallback: 'gemini-4-neon-high' },
  security: { primary: 'gemini-4-neon-high', fallback: 'claude-opus-5-5-high' },
  simplicity: { primary: 'claude-sonnet-5-5-medium', fallback: 'gemini-4-hydrogen-medium' },
  evidence_runner: { primary: 'gemini-4-hydrogen-medium', fallback: 'claude-sonnet-5-5-medium' },
  anti_slop: { primary: 'claude-sonnet-5-5-high', fallback: 'gemini-4-hydrogen-high' },
  devils_advocate: { primary: 'claude-opus-5-5-high', fallback: 'gemini-4-neon-high' },
  requirements_fidelity: { primary: 'gemini-4-neon-medium', fallback: 'claude-sonnet-5-5-high' },
  evidence_strategy: { primary: 'gemini-4-hydrogen-medium', fallback: 'claude-sonnet-5-5-medium' },
  dag_topology: { primary: 'gemini-4-neon-high', fallback: 'claude-opus-5-5-high' },
  arbiter: { primary: 'gemini-4-neon-high', fallback: 'claude-opus-5-5-high' },
});

export const ROLE_MODELS = {
  coldstart: 'gemini-4-hydrogen-low',
  premortem: 'gemini-4-neon-high',
  parallaxReader: 'gemini-4-hydrogen-medium',
  parallaxJudge: 'gemini-4-neon-high',
  brainConvert: 'gemini-4-neon-high',
  brainRepair: 'gemini-4-neon-high',
  arbiter: 'gemini-4-neon-high',
  probeDefault: 'Gemini 4 Hydrogen (Low)',
  reviewFleetAlternates: ['gemini-4-hydrogen-high', 'gemini-4-neon-high'],
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
  if (Object.hasOwn(ENTERPRISE_MODEL_ALIASES, normalized)) return ENTERPRISE_MODEL_ALIASES[normalized];
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
  if (normalized.includes('flash') || normalized.includes('hydrogen')) return 'gemini-flash';
  if (normalized.includes('gemini')) return 'gemini-pro';
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

export const DYNAMIC_EFFORT_BASE_MODELS = new Set([
  'gemini-4-neon',
  'gemini-4-hydrogen',
  'gemini-4-carbon',
]);

/**
 * Compute an explicit CLI `--effort` flag ONLY when warranted:
 *   1. `ORCHESTRATOR_MODELS` always return `null` (Orchestrator in the CLI uses a
 *      fixed reasoning budget; `--effort` and `/effort` do not apply per `docs/models/`).
 *   2. `explicitEffort` (`ticket.effort`) in `VALID_EFFORTS` wins on non-Orchestrator models.
 *   3. On Strike 0, `defaultEffort` (`AGB_DEFAULT_EFFORT`) in `VALID_EFFORTS` wins.
 *   4. Unsuffixed dynamic-effort base slugs (`gemini-4-neon`, `gemini-4-hydrogen`, `gemini-4-carbon`)
 *      receive tier-appropriate effort (`'low'|'medium'|'high'`) on Strike 0 and `'xhigh'|'max'` on Strike >= 1.
 *   5. All fixed-effort catalog slugs (`-low`/`-medium`/`-high`/`-xhigh`) return `null`
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
  const slug = resolveModelSlug(model);
  if (typeof slug === 'string' && ORCHESTRATOR_MODELS.has(slug)) {
    return null;
  }

  const normExplicit = typeof explicitEffort === 'string' ? explicitEffort.trim().toLowerCase() : '';
  if (VALID_EFFORTS.includes(normExplicit)) return normExplicit;

  const normDefault = typeof defaultEffort === 'string' ? defaultEffort.trim().toLowerCase() : '';
  if (strike === 0 && VALID_EFFORTS.includes(normDefault)) return normDefault;

  if (typeof slug === 'string' && DYNAMIC_EFFORT_BASE_MODELS.has(slug.trim().toLowerCase())) {
    if (strike <= 0) {
      if (tier === 'frontier') return 'high';
      if (tier === 'cheap') return 'low';
      return 'medium';
    }
    return allowMax ? 'max' : 'xhigh';
  }
  return null;
}

