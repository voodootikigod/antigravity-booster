import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  MODELS,
  ALL_MODELS,
  MODEL_ALIASES,
  RETIRED_35_MAP,
  TIER_CANDIDATES,
  PROSECUTORS,
  PROSECUTOR_CANDIDATES,
  ROLE_MODELS,
  VALID_EFFORTS,
  modelFor,
  resolveModelSlug,
  poolOf,
  familyOf,
  upstreamPoolOf,
  tierCandidates,
  escalateModelSlugInFamily,
  selectCliEffortFlag,
} from '../lib/models.mjs';

import * as agyExports from '../lib/agy.mjs';
import * as poolsExports from '../lib/pools.mjs';
import { PoolSet } from '../lib/pools.mjs';

describe('models-registry: single source of truth', () => {
  it('ALL_MODELS is frozen and contains all models from MODELS', () => {
    assert.equal(Object.isFrozen(ALL_MODELS), true);
    const expected = Object.values(MODELS).flat();
    assert.deepEqual([...ALL_MODELS], expected);
    assert.ok(ALL_MODELS.length > 0);
  });

  it('all tier candidates are members of ALL_MODELS', () => {
    for (const [tier, candidates] of Object.entries(TIER_CANDIDATES)) {
      assert.ok(Array.isArray(candidates) && candidates.length > 0, `tier ${tier} has candidates`);
      for (const model of candidates) {
        assert.ok(
          ALL_MODELS.includes(model),
          `Candidate '${model}' in tier '${tier}' must be in ALL_MODELS`
        );
      }
    }
  });

  it('all PROSECUTORS and PROSECUTOR_CANDIDATES are members of ALL_MODELS', () => {
    for (const [fam, model] of Object.entries(PROSECUTORS)) {
      assert.ok(
        ALL_MODELS.includes(model),
        `PROSECUTORS[${fam}] '${model}' must be in ALL_MODELS`
      );
    }

    for (const [fam, candidates] of Object.entries(PROSECUTOR_CANDIDATES)) {
      assert.ok(Array.isArray(candidates) && candidates.length > 0);
      for (const model of candidates) {
        assert.ok(
          ALL_MODELS.includes(model),
          `PROSECUTOR_CANDIDATES[${fam}] candidate '${model}' must be in ALL_MODELS`
        );
      }
    }
  });

  it('all ROLE_MODELS resolve to members of ALL_MODELS', () => {
    for (const [role, value] of Object.entries(ROLE_MODELS)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const resolved = resolveModelSlug(item);
          assert.ok(
            ALL_MODELS.includes(resolved),
            `ROLE_MODELS[${role}] item '${item}' (resolved: '${resolved}') must be in ALL_MODELS`
          );
        }
      } else {
        const resolved = resolveModelSlug(value);
        assert.ok(
          ALL_MODELS.includes(resolved),
          `ROLE_MODELS[${role}] '${value}' (resolved: '${resolved}') must be in ALL_MODELS`
        );
      }
    }
  });

  it('all MODEL_ALIASES resolve to members of ALL_MODELS', () => {
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      assert.ok(
        ALL_MODELS.includes(target),
        `MODEL_ALIASES['${alias}'] -> '${target}' must be in ALL_MODELS`
      );
    }
  });

  it('modelFor(role) returns the configured model or throws for unknown role', () => {
    for (const [role, value] of Object.entries(ROLE_MODELS)) {
      assert.deepEqual(modelFor(role), value);
    }
    assert.throws(() => modelFor('bogus'), /Unknown model role: bogus/);
  });

  it('resolveModelSlug resolves aliases, retired mappings, lists, and returns non-strings or unknowns', () => {
    // Non-string inputs
    assert.equal(resolveModelSlug(null), null);
    assert.equal(resolveModelSlug(undefined), undefined);
    assert.equal(resolveModelSlug(123), 123);

    // Exact matches
    assert.equal(resolveModelSlug('gemini-4-hydrogen-low'), 'gemini-4-hydrogen-low');
    assert.equal(resolveModelSlug('  GEMINI-4-HYDROGEN-LOW  '), 'gemini-4-hydrogen-low');

    // Retired mappings
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(resolveModelSlug('gemini-3.5-flash-low'), 'gemini-4-hydrogen-low');
      assert.equal(resolveModelSlug('gemini 3.5 flash (high)'), 'gemini-4-hydrogen-high');
      assert.equal(resolveModelSlug('gemini-3.8-flash-low'), 'gemini-4-hydrogen-low');
      assert.equal(resolveModelSlug('gemini-4-argon-high'), 'gemini-4-neon-high');
      assert.equal(resolveModelSlug('gpt-oss 120b (medium)'), 'claude-sonnet-5-5-medium');
    } finally {
      console.warn = origWarn;
    }

    // Model aliases
    assert.equal(resolveModelSlug('gemini 4 hydrogen (low)'), 'gemini-4-hydrogen-low');
    assert.equal(resolveModelSlug('claude sonnet 5.5 (medium)'), 'claude-sonnet-5-5-medium');

    // Unknown string
    assert.equal(resolveModelSlug('custom-fine-tuned-model'), 'custom-fine-tuned-model');
  });

  it('poolOf resolves pools and prefix fallbacks or throws on unknown', () => {
    assert.equal(poolOf('gemini-4-hydrogen-low'), 'gemini-flash');
    assert.equal(poolOf('gemini-4-neon-high'), 'gemini-pro');
    assert.equal(poolOf('claude-sonnet-5-5-medium'), 'claude');

    // Fallback prefixes
    assert.equal(poolOf('custom-flash-experimental'), 'gemini-flash');
    assert.equal(poolOf('hydrogen-custom'), 'gemini-flash');
    assert.equal(poolOf('custom-gemini-ultra'), 'gemini-pro');
    assert.equal(poolOf('claude-next-gen'), 'claude');
    assert.equal(poolOf('sonnet-future'), 'claude');
    assert.equal(poolOf('opus-future'), 'claude');
    assert.equal(poolOf('gpt-future-oss'), 'gpt-oss');

    // Unknown / non-string errors
    assert.throws(() => poolOf(123), /unknown model: 123/);
    assert.throws(() => poolOf('llama-3-70b'), /unknown model: llama-3-70b/);
  });

  it('familyOf and upstreamPoolOf group pools properly', () => {
    assert.equal(familyOf('gemini-4-hydrogen-low'), 'gemini');
    assert.equal(familyOf('gemini-4-neon-high'), 'gemini');
    assert.equal(familyOf('claude-sonnet-5-5-medium'), 'claude');
    assert.equal(familyOf('gpt-future-oss'), 'gpt-oss');

    assert.equal(upstreamPoolOf('gemini-4-hydrogen-low'), 'gemini');
    assert.equal(upstreamPoolOf('gemini-4-neon-high'), 'gemini');
    assert.equal(upstreamPoolOf('claude-sonnet-5-5-medium'), 'claude_gpt');
    assert.equal(upstreamPoolOf('gpt-future-oss'), 'claude_gpt');
  });

  it('tierCandidates filters models by pool hint', () => {
    // Default tier is mid
    const defaultCandidates = tierCandidates('nonexistent');
    assert.deepEqual(defaultCandidates, TIER_CANDIDATES.mid);

    // auto or falsy hint returns all candidates
    assert.deepEqual(tierCandidates('cheap', 'auto'), TIER_CANDIDATES.cheap);
    assert.deepEqual(tierCandidates('cheap', null), TIER_CANDIDATES.cheap);
    assert.deepEqual(tierCandidates('cheap', ''), TIER_CANDIDATES.cheap);

    // specific family hint
    const cheapGemini = tierCandidates('cheap', 'gemini');
    assert.ok(cheapGemini.length > 0);
    assert.ok(cheapGemini.every((m) => familyOf(m) === 'gemini'));

    // claude-gpt hint
    const frontierClaudeGpt = tierCandidates('frontier', 'claude-gpt');
    assert.ok(frontierClaudeGpt.length > 0);
    assert.ok(frontierClaudeGpt.every((m) => {
      const fam = familyOf(m);
      return fam === 'claude' || fam === 'gpt-oss';
    }));
  });

  it('PoolSet.prosecutorsFor returns candidates in preference order across families and falls back cleanly', () => {
    const pools = new PoolSet();
    assert.deepEqual(pools.prosecutorsFor('gemini-4-hydrogen-low'), [
      'claude-sonnet-5-5-medium',
      'claude-sonnet-5-5-high',
      'claude-opus-5-5-high',
    ]);
    assert.deepEqual(pools.prosecutorsFor('claude-sonnet-5-5-medium'), [
      'gemini-4-neon-high',
      'gemini-4-carbon-high',
      'gemini-4-hydrogen-high',
    ]);
    assert.deepEqual(pools.prosecutorsFor('gpt-future-oss'), [
      'gemini-4-neon-high',
      'gemini-4-carbon-high',
      'gemini-4-hydrogen-high',
      'claude-sonnet-5-5-medium',
    ]);

    const saved = PROSECUTOR_CANDIDATES.gemini;
    try {
      delete PROSECUTOR_CANDIDATES.gemini;
      assert.deepEqual(pools.prosecutorsFor('gemini-4-hydrogen-low'), [PROSECUTORS.gemini]);
    } finally {
      PROSECUTOR_CANDIDATES.gemini = saved;
    }
  });

  it('bin/agb.mjs probe uses ROLE_MODELS.probeDefault by default and rest[1] when specified', () => {
    const fakeAgy = join(process.cwd(), 'test', 'fixtures', 'fake-agy');
    const agbBin = join(process.cwd(), 'bin', 'agb.mjs');
    const tmp = mkdtempSync(join(tmpdir(), 'agb-probe-test-'));
    try {
      const env = { ...process.env, AGB_AGY_BIN: fakeAgy };
      const defaultOut = execFileSync(process.execPath, [agbBin, 'probe', '1'], {
        cwd: tmp,
        env,
        encoding: 'utf8',
      }).trim();
      const defaultRow = JSON.parse(defaultOut);
      assert.equal(defaultRow.model, ROLE_MODELS.probeDefault);
      assert.equal(defaultRow.width, 1);

      const customOut = execFileSync(process.execPath, [agbBin, 'probe', '1', 'claude-sonnet-5-5-medium'], {
        cwd: tmp,
        env,
        encoding: 'utf8',
      }).trim();
      const customRow = JSON.parse(customOut);
      assert.equal(customRow.model, 'claude-sonnet-5-5-medium');
      assert.equal(customRow.width, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('lib/agy.mjs re-exports expected symbols for 100% backward compatibility', () => {
    assert.equal(agyExports.MODELS, MODELS);
    assert.equal(agyExports.ALL_MODELS, ALL_MODELS);
    assert.equal(agyExports.MODEL_ALIASES, MODEL_ALIASES);
    assert.equal(agyExports.RETIRED_35_MAP, RETIRED_35_MAP);
    assert.equal(agyExports.resolveModelSlug, resolveModelSlug);
    assert.equal(agyExports.poolOf, poolOf);
    assert.equal(agyExports.familyOf, familyOf);
    assert.equal(agyExports.upstreamPoolOf, upstreamPoolOf);
  });

  it('lib/pools.mjs re-exports expected symbols for 100% backward compatibility', () => {
    assert.equal(poolsExports.TIER_CANDIDATES, TIER_CANDIDATES);
    assert.equal(poolsExports.PROSECUTORS, PROSECUTORS);
    assert.equal(poolsExports.PROSECUTOR_CANDIDATES, PROSECUTOR_CANDIDATES);
    assert.equal(poolsExports.tierCandidates, tierCandidates);
    assert.equal(poolsExports.poolOf, poolOf);
    assert.equal(poolsExports.upstreamPoolOf, upstreamPoolOf);
  });

  it('no raw model string literals exist in lib/*.mjs outside lib/models.mjs', () => {
    const regex = /['"](?:gemini-(?:3\.[0-9]|4-|pro-orchestrator)[^'"]*|claude-(?:sonnet|opus)-[0-9][^'"]*|gpt-oss-[0-9][^'"]*)['"]/g;
    const libDir = join(process.cwd(), 'lib');
    const files = readdirSync(libDir).filter((f) => f.endsWith('.mjs') && f !== 'models.mjs');

    const violations = [];
    for (const f of files) {
      const code = readFileSync(join(libDir, f), 'utf8');
      // Strip block comments and line comments
      const stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      const matches = stripped.match(regex);
      if (matches) {
        violations.push({ file: f, matches });
      }
    }

    assert.deepEqual(violations, [], `Found raw model strings in lib: ${JSON.stringify(violations)}`);
  });

  it('escalateModelSlugInFamily and selectCliEffortFlag respect catalog ceilings, never pass --effort to Orchestrator, and support dynamic base slugs', async () => {
    const { sameFamilyProsecutorsFor } = await import('../lib/models.mjs');
    assert.deepEqual([...VALID_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(escalateModelSlugInFamily('claude-sonnet-5-5-low'), 'claude-sonnet-5-5-medium');
    assert.equal(escalateModelSlugInFamily('claude-sonnet-5-5-medium'), 'claude-sonnet-5-5-high');
    assert.equal(escalateModelSlugInFamily('claude-opus-5-5-high'), 'claude-opus-5-5-high');
    assert.equal(escalateModelSlugInFamily('gemini-4-neon-high'), 'gemini-4-neon-xhigh');
    assert.equal(escalateModelSlugInFamily('gemini-4-neon-xhigh'), 'gemini-4-neon-xhigh');
    assert.equal(escalateModelSlugInFamily('gemini-4-hydrogen-high'), 'gemini-4-hydrogen-xhigh');
    assert.equal(escalateModelSlugInFamily('gemini-pro-orchestrator-neon'), 'gemini-pro-orchestrator-neon');

    // Fixed-effort catalog slugs return null unless explicitEffort or Strike-0 defaultEffort
    assert.equal(selectCliEffortFlag({ model: 'claude-sonnet-5-5-medium', strike: 0, defaultEffort: null }), null);
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-neon-high', strike: 1, defaultEffort: 'low' }), null);
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-neon-high', strike: 0, explicitEffort: 'xhigh' }), 'xhigh');
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-neon-medium', strike: 0, defaultEffort: 'low' }), 'low');

    // Orchestrator models NEVER emit --effort (fixed reasoning budget in CLI per docs/models/)
    assert.equal(selectCliEffortFlag({ model: 'gemini-pro-orchestrator', strike: 0, defaultEffort: 'high' }), null);
    assert.equal(selectCliEffortFlag({ model: 'gemini-pro-orchestrator-neon', strike: 1, explicitEffort: 'xhigh' }), null);
    assert.equal(selectCliEffortFlag({ model: 'Orchestrator (Neon)', strike: 1, allowMax: true, defaultEffort: null }), null);

    // Unsuffixed dynamic-effort base slugs emit tier-scaled Strike-0 effort and xhigh/max on Strike >= 1
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-neon', tier: 'frontier', strike: 0, defaultEffort: null }), 'high');
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-neon', tier: 'mid', strike: 0, defaultEffort: null }), 'medium');
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-hydrogen', tier: 'cheap', strike: 0, defaultEffort: null }), 'low');
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-neon', tier: 'frontier', strike: 1, defaultEffort: null }), 'xhigh');
    assert.equal(selectCliEffortFlag({ model: 'gemini-4-hydrogen', tier: 'mid', strike: 1, allowMax: true, defaultEffort: null }), 'max');

    // Same-family prosecutor fallbacks
    assert.deepEqual(sameFamilyProsecutorsFor('gemini-4-neon-high'), ['gemini-4-carbon-high', 'gemini-4-hydrogen-high']);
    assert.deepEqual(sameFamilyProsecutorsFor('gemini-pro-orchestrator-neon'), ['gemini-4-carbon-high', 'gemini-4-hydrogen-high']);
    assert.deepEqual(sameFamilyProsecutorsFor('gemini-4-hydrogen-medium'), ['gemini-4-neon-high', 'gemini-4-carbon-high']);
    assert.deepEqual(sameFamilyProsecutorsFor('gemini-4-carbon-high'), ['gemini-4-neon-high', 'gemini-4-hydrogen-high']);
    assert.deepEqual(sameFamilyProsecutorsFor('claude-opus-5-5-high'), ['claude-sonnet-5-5-high']);
    assert.deepEqual(sameFamilyProsecutorsFor('claude-sonnet-5-5-medium'), ['claude-opus-5-5-high']);
    assert.deepEqual(sameFamilyProsecutorsFor('gpt-future-oss'), []);
  });
});

