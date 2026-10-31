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
  modelFor,
  resolveModelSlug,
  poolOf,
  familyOf,
  upstreamPoolOf,
  tierCandidates,
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
    assert.equal(resolveModelSlug('gemini-3.8-flash-low'), 'gemini-3.8-flash-low');
    assert.equal(resolveModelSlug('  GEMINI-3.8-FLASH-LOW  '), 'gemini-3.8-flash-low');

    // Retired mappings
    assert.equal(resolveModelSlug('gemini-3.5-flash-low'), 'gemini-3.8-flash-low');
    assert.equal(resolveModelSlug('gemini 3.5 flash (high)'), 'gemini-3.8-flash-high');

    // Model aliases
    assert.equal(resolveModelSlug('gemini 3.8 flash (low)'), 'gemini-3.8-flash-low');
    assert.equal(resolveModelSlug('claude sonnet 5.5 (medium)'), 'claude-sonnet-5-5-medium');
    assert.equal(resolveModelSlug('gpt-oss 120b (medium)'), 'gpt-oss-120b-medium');

    // Unknown string
    assert.equal(resolveModelSlug('custom-fine-tuned-model'), 'custom-fine-tuned-model');
  });

  it('poolOf resolves pools and prefix fallbacks or throws on unknown', () => {
    assert.equal(poolOf('gemini-3.8-flash-low'), 'gemini-flash');
    assert.equal(poolOf('gemini-4-argon-high'), 'gemini-pro');
    assert.equal(poolOf('claude-sonnet-5-5-medium'), 'claude');
    assert.equal(poolOf('gpt-oss-120b-medium'), 'gpt-oss');

    // Fallback prefixes
    assert.equal(poolOf('custom-flash-experimental'), 'gemini-flash');
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
    assert.equal(familyOf('gemini-3.8-flash-low'), 'gemini');
    assert.equal(familyOf('gemini-4-argon-high'), 'gemini');
    assert.equal(familyOf('claude-sonnet-5-5-medium'), 'claude');
    assert.equal(familyOf('gpt-oss-120b-medium'), 'gpt-oss');

    assert.equal(upstreamPoolOf('gemini-3.8-flash-low'), 'gemini');
    assert.equal(upstreamPoolOf('gemini-4-argon-high'), 'gemini');
    assert.equal(upstreamPoolOf('claude-sonnet-5-5-medium'), 'claude_gpt');
    assert.equal(upstreamPoolOf('gpt-oss-120b-medium'), 'claude_gpt');
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
    assert.deepEqual(pools.prosecutorsFor('gemini-3.8-flash-low'), [
      'gpt-oss-120b-medium',
      'claude-sonnet-5-5-medium',
    ]);
    assert.deepEqual(pools.prosecutorsFor('claude-sonnet-5-5-medium'), [
      'gemini-4-argon-high',
      'gemini-3.8-flash-high',
      'gpt-oss-120b-medium',
    ]);
    assert.deepEqual(pools.prosecutorsFor('gpt-oss-120b-medium'), [
      'gemini-4-argon-high',
      'gemini-3.8-flash-high',
      'claude-sonnet-5-5-medium',
    ]);

    const saved = PROSECUTOR_CANDIDATES.gemini;
    try {
      delete PROSECUTOR_CANDIDATES.gemini;
      assert.deepEqual(pools.prosecutorsFor('gemini-3.8-flash-low'), [PROSECUTORS.gemini]);
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
    const regex = /['"](?:gemini-3\.[0-9][^'"]*|claude-(?:sonnet|opus)-[0-9][^'"]*|gpt-oss-[0-9][^'"]*)['"]/g;
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
});

