import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_MODELS,
  MODELS,
  MODEL_ALIASES,
  RETIRED_MODEL_MAP,
  RETIRED_35_MAP,
  TIER_CANDIDATES,
  PROSECUTORS,
  PROSECUTOR_CANDIDATES,
  ROLE_MODELS,
  resolveModelSlug,
  poolOf,
  familyOf,
  tierCandidates,
} from '../lib/models.mjs';

// Snapshot of `agy models` (agy 1.4.7). Update together with lib/models.mjs;
// `agb doctor` (t-doctor-catalog-drift) reports drift against the live CLI.
const LIVE_CATALOG = [
  'gemini-4-argon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
];

const RETIRED_SLUGS = [
  'gemini-3.5-flash-low', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-high',
  'gemini-3.7-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-high',
  'gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high',
  'gemini-3.1-pro-low', 'gemini-3.1-pro-high',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking',
];

describe('models-live-catalog: MODELS matches agy 1.4.7', () => {
  it('ALL_MODELS equals the live catalog exactly', () => {
    assert.deepEqual([...ALL_MODELS].sort(), [...LIVE_CATALOG].sort());
  });

  it('buckets the new models into the right pools and families', () => {
    assert.equal(poolOf('gemini-4-argon-high'), 'gemini-pro');
    assert.equal(familyOf('gemini-4-argon-low'), 'gemini');
    assert.equal(poolOf('claude-opus-5-5-high'), 'claude');
    assert.equal(poolOf('claude-sonnet-5-5-medium'), 'claude');
    assert.equal(poolOf('gemini-3.8-flash-high'), 'gemini-flash');
  });
});

describe('models-live-catalog: no default points at a dead slug', () => {
  const live = new Set(LIVE_CATALOG);

  it('every tier candidate is live', () => {
    for (const [tier, list] of Object.entries(TIER_CANDIDATES)) {
      for (const m of list) assert.ok(live.has(m), `${tier} tier lists dead slug ${m}`);
    }
  });

  it('every prosecutor default and candidate is live', () => {
    for (const [fam, m] of Object.entries(PROSECUTORS)) assert.ok(live.has(m), `PROSECUTORS.${fam} -> ${m}`);
    for (const [fam, list] of Object.entries(PROSECUTOR_CANDIDATES)) {
      for (const m of list) assert.ok(live.has(m), `PROSECUTOR_CANDIDATES.${fam} lists ${m}`);
    }
  });

  it('every role model resolves to a live slug', () => {
    for (const [role, value] of Object.entries(ROLE_MODELS)) {
      for (const m of [value].flat()) {
        assert.ok(live.has(resolveModelSlug(m)), `ROLE_MODELS.${role} -> ${m}`);
      }
    }
  });

  it('prosecutors never share a family with the builder they cover', () => {
    for (const [fam, m] of Object.entries(PROSECUTORS)) assert.notEqual(familyOf(m), fam);
    for (const [fam, list] of Object.entries(PROSECUTOR_CANDIDATES)) {
      for (const m of list) assert.notEqual(familyOf(m), fam, `${m} covers its own family ${fam}`);
    }
  });

  it('Opus 5.5 is frontier-only; cheap stays Gemini-only', () => {
    assert.ok(TIER_CANDIDATES.frontier.some((m) => m.startsWith('claude-opus-5-5')));
    for (const tier of ['cheap', 'mid']) {
      assert.ok(!TIER_CANDIDATES[tier].some((m) => m.includes('opus')), `${tier} must not include Opus`);
    }
    assert.deepEqual(tierCandidates('cheap', 'claude-gpt'), []);
  });
});

describe('models-live-catalog: retired slugs migrate to live ones', () => {
  it('every retired slug resolves to a live slug and warns', () => {
    for (const retired of RETIRED_SLUGS) {
      const warnings = [];
      const orig = console.warn;
      console.warn = (msg) => warnings.push(msg);
      let resolved;
      try {
        resolved = resolveModelSlug(retired);
      } finally {
        console.warn = orig;
      }
      assert.ok(LIVE_CATALOG.includes(resolved), `${retired} -> ${resolved} is not live`);
      assert.equal(warnings.length, 1, `${retired} should warn once`);
      assert.match(warnings[0], /retired upstream/);
    }
  });

  it('maps like-for-like effort and family', () => {
    const map = {
      'gemini-3.7-flash-medium': 'gemini-3.8-flash-medium',
      'gemini-3.6-flash-low': 'gemini-3.8-flash-low',
      'gemini-3.1-pro-low': 'gemini-4-argon-low',
      'gemini-3.1-pro-high': 'gemini-4-argon-high',
      'claude-sonnet-4-6': 'claude-sonnet-5-5-medium',
      'claude-opus-4-6-thinking': 'claude-opus-5-5-high',
    };
    for (const [from, to] of Object.entries(map)) {
      const orig = console.warn;
      console.warn = () => {};
      try {
        assert.equal(resolveModelSlug(from), to);
      } finally {
        console.warn = orig;
      }
    }
  });

  it('resolves retired display names case-insensitively', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      assert.equal(resolveModelSlug('Gemini 3.1 Pro (High)'), 'gemini-4-argon-high');
      assert.equal(resolveModelSlug('Claude Opus 4.6 (Thinking)'), 'claude-opus-5-5-high');
      assert.equal(resolveModelSlug('Gemini 3.5 Flash (Low)'), 'gemini-3.8-flash-low');
    } finally {
      console.warn = orig;
    }
  });

  it('resolves live display names without warning', () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      assert.equal(resolveModelSlug('Gemini 4 Argon (High)'), 'gemini-4-argon-high');
      assert.equal(resolveModelSlug('Claude Opus 5.5 (Low)'), 'claude-opus-5-5-low');
      assert.equal(resolveModelSlug('Claude Sonnet 5.5 (Medium)'), 'claude-sonnet-5-5-medium');
      assert.equal(resolveModelSlug('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash-high');
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(warnings, []);
  });

  it('every live slug resolves from its `agy models` display name, silently', () => {
    const display = {
      'gemini-4-argon-low': 'Gemini 4 Argon (Low)',
      'gemini-4-argon-medium': 'Gemini 4 Argon (Medium)',
      'gemini-4-argon-high': 'Gemini 4 Argon (High)',
      'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
      'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
      'claude-opus-5-5-low': 'Claude Opus 5.5 (Low)',
      'claude-opus-5-5-medium': 'Claude Opus 5.5 (Medium)',
      'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
      'claude-sonnet-5-5-low': 'Claude Sonnet 5.5 (Low)',
      'claude-sonnet-5-5-medium': 'Claude Sonnet 5.5 (Medium)',
      'claude-sonnet-5-5-high': 'Claude Sonnet 5.5 (High)',
      'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
    };
    assert.deepEqual(Object.keys(display).sort(), [...LIVE_CATALOG].sort());
    const warnings = [];
    const orig = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      for (const [slug, name] of Object.entries(display)) {
        assert.equal(resolveModelSlug(name), slug, name);
        assert.equal(resolveModelSlug(slug), slug, slug);
      }
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(warnings, []);
  });

  it('retired map targets are live and never retired themselves; maps are frozen', () => {
    for (const [from, to] of Object.entries(RETIRED_MODEL_MAP)) {
      assert.ok(LIVE_CATALOG.includes(to), `${from} -> ${to}`);
      assert.ok(!(to in RETIRED_MODEL_MAP), `${to} must not itself be retired`);
    }
    assert.equal(Object.isFrozen(RETIRED_MODEL_MAP), true);
    assert.equal(RETIRED_35_MAP, RETIRED_MODEL_MAP, 'deprecated alias keeps the exported contract');
  });

  it('no retired name remains a live alias or member', () => {
    for (const retired of RETIRED_SLUGS) {
      assert.ok(!ALL_MODELS.includes(retired));
      assert.ok(!(retired in MODEL_ALIASES));
    }
    assert.ok(Object.keys(MODELS).length > 0);
  });
});
