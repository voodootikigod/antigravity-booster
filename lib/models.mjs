// Single source of truth for model slugs, aliases, tiers, prosecutors, and role defaults.

export const MODELS = {
  'gemini-flash': [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-high',
  ],
  'gemini-pro': ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
  claude: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking'],
  'gpt-oss': ['gpt-oss-120b-medium'],
};

export const ALL_MODELS = Object.freeze(Object.values(MODELS).flat());

export const MODEL_ALIASES = {
  'gemini 3.8 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.8 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.8 flash (high)': 'gemini-3.8-flash-high',
  'gemini 3.7 flash (low)': 'gemini-3.7-flash-low',
  'gemini 3.7 flash (medium)': 'gemini-3.7-flash-medium',
  'gemini 3.7 flash (high)': 'gemini-3.7-flash-high',
  'gemini 3.6 flash (low)': 'gemini-3.6-flash-low',
  'gemini 3.6 flash (medium)': 'gemini-3.6-flash-medium',
  'gemini 3.6 flash (high)': 'gemini-3.6-flash-high',
  'gemini 3.5 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.5 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.5 flash (high)': 'gemini-3.8-flash-high',
  'gemini-3.5-flash-low': 'gemini-3.8-flash-low',
  'gemini-3.5-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-high': 'gemini-3.8-flash-high',
  'gemini 3.1 pro (low)': 'gemini-3.1-pro-low',
  'gemini 3.1 pro (high)': 'gemini-3.1-pro-high',
  'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
  'claude opus 4.6 (thinking)': 'claude-opus-4-6-thinking',
  'gpt-oss 120b (medium)': 'gpt-oss-120b-medium',
};

export const RETIRED_35_MAP = {
  'gemini-3.5-flash-low': 'gemini-3.8-flash-low',
  'gemini-3.5-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-high': 'gemini-3.8-flash-high',
  'gemini 3.5 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.5 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.5 flash (high)': 'gemini-3.8-flash-high',
};

// Role -> tier -> candidate models, cheapest-listed first. Cross-pool
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

export const PROSECUTOR_CANDIDATES = {
  gemini: ['gpt-oss-120b-medium', 'claude-sonnet-4-6'],
  claude: ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium'],
  'gpt-oss': ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'],
};

export const ROLE_MODELS = {
  coldstart: 'gemini-3.8-flash-low',
  premortem: 'gemini-3.1-pro-high',
  parallaxReader: 'gemini-3.8-flash-medium',
  parallaxJudge: 'gemini-3.1-pro-high',
  brainConvert: 'gemini-3.1-pro-high',
  probeDefault: 'Gemini 3.8 Flash (Low)',
  reviewFleetAlternates: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'],
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
  if (RETIRED_35_MAP[normalized]) {
    const resolved = RETIRED_35_MAP[normalized];
    console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    return resolved;
  }
  if (MODEL_ALIASES[normalized]) {
    const resolved = MODEL_ALIASES[normalized];
    if (normalized.includes('3.5')) {
      console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    }
    return resolved;
  }
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

/** Candidate cross-family prosecutors for a builder model in preference order. */
export function prosecutorsFor(builderModel) {
  const fam = familyOf(builderModel);
  if (PROSECUTOR_CANDIDATES[fam]) {
    return [...PROSECUTOR_CANDIDATES[fam]];
  }
  return [PROSECUTORS[fam] || PROSECUTORS.claude];
}
