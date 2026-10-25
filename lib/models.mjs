// Single source of truth for model slugs, aliases, tiers, prosecutors, and role defaults.

// Live catalog as of agy 1.4.7 (`agy models`). `agb doctor` reports drift.
export const MODELS = {
  'gemini-flash': ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
  'gemini-pro': ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high'],
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
// candidates let the router pick the least-loaded pool. Opus is frontier-only.
export const TIER_CANDIDATES = {
  cheap: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium'],
  mid: ['gemini-3.8-flash-high', 'gemini-4-argon-low', 'claude-sonnet-5-5-medium'],
  frontier: ['gemini-4-argon-high', 'claude-sonnet-5-5-high', 'claude-opus-5-5-high'],
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
  claude: ['gemini-4-argon-high', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium'],
  'gpt-oss': ['gemini-4-argon-high', 'gemini-3.8-flash-high', 'claude-sonnet-5-5-medium'],
};

export const ROLE_MODELS = {
  coldstart: 'gemini-3.8-flash-low',
  premortem: 'gemini-4-argon-high',
  parallaxReader: 'gemini-3.8-flash-medium',
  parallaxJudge: 'gemini-4-argon-high',
  brainConvert: 'gemini-4-argon-high',
  probeDefault: 'Gemini 3.8 Flash (Low)',
  reviewFleetAlternates: ['gemini-3.8-flash-high', 'gemini-4-argon-high'],
};

export function modelFor(role) {
  if (ROLE_MODELS[role] === undefined) {
    throw new Error('Unknown model role: ' + role);
  }
  return ROLE_MODELS[role];
}

export function resolveModelSlug(model) {
  if (typeof model !== 'string') return model;
  const normalized = model.trim().toLowerCase();
  if (RETIRED_MODEL_MAP[normalized]) {
    const resolved = RETIRED_MODEL_MAP[normalized];
    console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    return resolved;
  }
  if (MODEL_ALIASES[normalized]) return MODEL_ALIASES[normalized];
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
