#!/usr/bin/env node

/**
 * sync-models.mjs
 *
 * Pure-Node live Antigravity model catalog auditor and synchronizer.
 * Reuses `agyModelsStdoutSync`, `parseAgyModelRows`, and `compareModelCatalog`
 * from `lib/doctor-models.mjs`, verifies mapping in `lib/models.mjs`, and
 * optionally writes `skills/adversarial-review/references/models.json`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_BUNDLED } from '../lib/adlc-bridge.mjs';
import {
  ALL_MODELS,
  ARL_LENS_MODELS,
  CODE_ARL_LENSES,
  MODELS,
  MODEL_ALIASES,
  PLAN_ARL_LENSES,
  ROLE_MODELS,
  familyOf,
  poolOf,
  resolveModelSlug,
} from '../lib/models.mjs';
import {
  agyModelsStdoutSync,
  compareModelCatalog,
  parseAgyModelRows,
} from '../lib/doctor-models.mjs';

const DISPLAY_BY_SLUG = new Map(
  Object.entries(MODEL_ALIASES).map(([alias, slug]) => [
    slug,
    alias
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/^Gpt-Oss\b/, 'GPT-OSS')
      .replace(/\b(\d+)b\b/, (_, n) => `${n}B`),
  ])
);

export const CACHED_MODELS_OUTPUT = [
  'Fetching available models...',
  ...ALL_MODELS.map((slug) => `${slug}\t${DISPLAY_BY_SLUG.get(slug) ?? slug}`),
].join('\n');

export function parseAgyModelsOutput(rawOutput) {
  return parseAgyModelRows(rawOutput);
}

export function auditModels(liveModels) {
  const report = [];
  const unmapped = [];
  let unmappedCount = 0;

  const liveSlugs = liveModels.map((m) => (typeof m === 'string' ? m : m.slug));
  const comparison = compareModelCatalog(
    liveSlugs,
    ALL_MODELS,
    Object.keys(MODEL_ALIASES)
  );

  for (const item of liveModels) {
    const slug = typeof item === 'string' ? item : item.slug;
    const displayName = typeof item === 'string' ? item : (item.displayName ?? slug);
    const isMapped = Object.values(MODELS).some((list) => list.includes(slug) || list.includes(displayName));
    const resolvedSlug = resolveModelSlug(slug);
    const hasAlias = Boolean(
      Object.hasOwn(MODEL_ALIASES, slug.toLowerCase()) ||
      Object.hasOwn(MODEL_ALIASES, displayName.toLowerCase())
    );

    let pool = 'unassigned';
    let family = 'unassigned';
    try {
      pool = poolOf(slug);
      family = familyOf(slug);
    } catch {
      // unassigned
    }

    const status = isMapped ? 'MAPPED' : (hasAlias ? 'ALIAS' : 'MISSING');
    const entry = {
      slug,
      displayName,
      resolved: resolvedSlug,
      pool,
      family,
      status,
    };
    if (status === 'MISSING') {
      unmappedCount++;
      unmapped.push(entry);
    }
    report.push(entry);
  }

  return {
    report,
    unmappedCount,
    unmapped,
    retired: comparison.retired,
    unrecognized: comparison.unrecognized,
    totalLive: liveModels.length,
  };
}

export function buildModelsReferencePayload(liveModels = parseAgyModelsOutput(CACHED_MODELS_OUTPUT)) {
  const audit = auditModels(liveModels);
  return {
    schema_version: '1.0',
    catalog: audit.report.map((r) => ({
      slug: r.slug,
      display_name: r.displayName,
      pool: r.pool,
      family: r.family,
      status: r.status,
    })),
    code_lenses: Object.fromEntries(
      CODE_ARL_LENSES.map((lens) => [lens, ARL_LENS_MODELS[lens]])
    ),
    plan_lenses: Object.fromEntries(
      PLAN_ARL_LENSES.map((lens) => [lens, ARL_LENS_MODELS[lens]])
    ),
    arbiter: ARL_LENS_MODELS.arbiter,
    roles: ROLE_MODELS,
  };
}

export function isBoosterRepoCheckout(dir) {
  if (!dir) return false;
  try {
    if (!existsSync(join(dir, 'lib', 'models.mjs'))) return false;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.name === 'antigravity-booster';
  } catch {
    return false;
  }
}

function resolveDefaultRootDir() {
  if (IS_BUNDLED) return process.cwd();
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function syncModels({
  check = false,
  write = false,
  offline = false,
  json = false,
  inputPath = null,
  rootDir,
  requireBoosterCheckout = false,
  env = process.env,
} = {}) {
  const explicitRootDir = rootDir !== undefined;
  const effectiveRootDir = explicitRootDir ? rootDir : resolveDefaultRootDir();
  if (write && (requireBoosterCheckout || !explicitRootDir) && !isBoosterRepoCheckout(effectiveRootDir)) {
    return {
      ok: false,
      exitCode: 1,
      error: '--write only updates skills/adversarial-review/references/models.json inside an antigravity-booster repository checkout.',
      source: 'error',
      degradedFallback: false,
      totalLive: 0,
      unmappedCount: 0,
      unmapped: [],
      retired: [],
      report: [],
      writtenPaths: [],
      json,
    };
  }
  const useOffline = offline || env.AGB_SYNC_MODELS_OFFLINE === '1';
  let rawOutput = '';
  let source = 'live';
  let degradedFallback = false;
  let fallbackError = null;

  if (inputPath) {
    rawOutput = readFileSync(inputPath, 'utf8');
    source = 'input';
  } else if (useOffline) {
    rawOutput = CACHED_MODELS_OUTPUT;
    source = 'cached';
  } else {
    try {
      rawOutput = agyModelsStdoutSync({ env });
      source = 'live';
    } catch (err) {
      if (check) {
        return {
          ok: false,
          exitCode: 1,
          error: `agy models failed: ${err.message}`,
          source: 'error',
          degradedFallback: false,
          totalLive: 0,
          unmappedCount: 0,
          unmapped: [],
          retired: [],
          report: [],
        };
      }
      rawOutput = CACHED_MODELS_OUTPUT;
      source = 'cached';
      degradedFallback = true;
      fallbackError = err.message;
      if (!json) {
        console.warn(`[agb] Warning: live 'agy models' probe failed (${err.message}); falling back to static catalog.`);
      }
    }
  }

  const liveModels = parseAgyModelsOutput(rawOutput);
  const { report, unmappedCount, unmapped, retired, totalLive } = auditModels(liveModels);

  const writtenPaths = [];
  if (write) {
    const payload = buildModelsReferencePayload(liveModels);
    const refDir = join(effectiveRootDir, 'skills', 'adversarial-review', 'references');
    mkdirSync(refDir, { recursive: true });
    const refPath = join(refDir, 'models.json');
    writeFileSync(refPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    writtenPaths.push(refPath);
  }

  const ok = unmappedCount === 0;
  const exitCode = check && !ok ? 1 : 0;
  return {
    ok,
    exitCode,
    source,
    degradedFallback,
    ...(fallbackError ? { warning: fallbackError } : {}),
    totalLive,
    unmappedCount,
    unmapped,
    retired,
    report,
    writtenPaths,
    json,
  };
}

function isStandaloneSyncModelsEntry() {
  if (IS_BUNDLED || !process.argv[1]) return false;
  try {
    const selfPath = fileURLToPath(import.meta.url);
    if (basename(selfPath) !== 'sync-models.mjs') return false;
    return realpathSync(process.argv[1]) === realpathSync(selfPath);
  } catch {
    return false;
  }
}

if (isStandaloneSyncModelsEntry()) {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const isWrite = args.includes('--write');
  const isJson = args.includes('--json');
  const isOffline = args.includes('--offline') || process.env.AGB_SYNC_MODELS_OFFLINE === '1';
  const inputIdx = args.indexOf('--input');
  const inputPath = inputIdx !== -1 && args[inputIdx + 1] ? args[inputIdx + 1] : null;

  const res = syncModels({
    check: isCheck,
    write: isWrite,
    offline: isOffline,
    json: isJson,
    inputPath,
  });

  if (isJson) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.error) {
    console.error(`ERROR: ${res.error}`);
  } else {
    console.log('\nAntigravity Live Model Audit:\n');
    console.log('Slug'.padEnd(30) + 'Display Name'.padEnd(30) + 'Pool'.padEnd(16) + 'Status');
    console.log('-'.repeat(85));
    for (const r of res.report) {
      console.log(r.slug.padEnd(30) + r.displayName.padEnd(30) + r.pool.padEnd(16) + r.status);
    }
    console.log('-'.repeat(85));
    console.log(`Total live models: ${res.totalLive} | Missing: ${res.unmappedCount}\n`);
    if (res.exitCode !== 0) {
      console.error(`ERROR: ${res.unmappedCount} live model(s) are missing from lib/models.mjs.`);
    }
  }
  process.exit(res.exitCode);
}
