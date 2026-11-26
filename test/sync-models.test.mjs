import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHED_MODELS_OUTPUT,
  parseAgyModelsOutput,
  auditModels,
  syncModels,
} from '../scripts/sync-models.mjs';
import { parseAgyModels, compareModelCatalog, checkModelCatalog } from '../lib/doctor-models.mjs';
import { ALL_MODELS } from '../lib/models.mjs';

test('parseAgyModels and parseAgyModelsOutput parse cached agy models table cleanly', () => {
  const slugs = parseAgyModels(CACHED_MODELS_OUTPUT);
  assert.equal(slugs.length, ALL_MODELS.length);
  const parsed = parseAgyModelsOutput(CACHED_MODELS_OUTPUT);
  assert.equal(parsed.length, ALL_MODELS.length);
  assert.ok(parsed.some((m) => m.slug === 'gemini-4-neon-high' && m.displayName === 'Gemini 4 Neon (High)'));
});

test('auditModels and compareModelCatalog report zero unmapped models on current catalog', () => {
  const live = parseAgyModelsOutput(CACHED_MODELS_OUTPUT);
  const audit = auditModels(live);
  assert.equal(audit.unmappedCount, 0);
  assert.deepEqual(audit.unmapped, []);

  const diff = compareModelCatalog(
    live.map((m) => m.slug),
    ALL_MODELS
  );
  assert.deepEqual(diff.retired, []);
  assert.deepEqual(diff.unrecognized, []);
});

test('syncModels --offline --write writes skills/adversarial-review/references/models.json in pure Node', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agb-sync-models-'));
  try {
    const res = syncModels({
      offline: true,
      check: true,
      write: true,
      rootDir: tmpRoot,
    });
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    const outPath = join(tmpRoot, 'skills', 'adversarial-review', 'references', 'models.json');
    assert.ok(existsSync(outPath));
    const data = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(data.schema_version, '1.0');
    assert.equal(data.catalog.length, ALL_MODELS.length);
    assert.ok(data.code_lenses.correctness_redteam);
    assert.ok(data.plan_lenses.devils_advocate);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('checkModelCatalog honors AGB_SYNC_MODELS_OFFLINE=1 with explicit offline/info diagnostic', async () => {
  const res = await checkModelCatalog({
    env: { ...process.env, AGB_SYNC_MODELS_OFFLINE: '1' },
  });
  assert.equal(res.level, 'info');
  assert.match(res.detail, /offline/i);
  assert.match(res.detail, /skipped/i);
  assert.doesNotMatch(res.detail, /models match/);
  assert.match(res.fix, /AGB_SYNC_MODELS_OFFLINE/);

  // Also honors AGB_SYNC_MODELS_OFFLINE=1 even when a modelsPromise is supplied.
  const withPromise = await checkModelCatalog({
    env: { ...process.env, AGB_SYNC_MODELS_OFFLINE: '1' },
    modelsPromise: Promise.resolve('gemini-9-unknown-high\tGemini 9 Unknown (High)\n'),
  });
  assert.equal(withPromise.level, 'info');
  assert.match(withPromise.detail, /offline/i);
  assert.doesNotMatch(withPromise.detail, /models match/);
});
