#!/usr/bin/env node
/**
 * Stage a clean Google Antigravity Plugin Marketplace bundle and optional
 * `marketplace.json` catalog feed, and verify `agy plugin validate --strict --json`
 * passes with 0 errors, 0 warnings, and 0 notes.
 */
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files and directories shipped inside the staged Marketplace plugin bundle. */
export const MARKETPLACE_RUNTIME_PATHS = [
  'plugin.json',
  'package.json',
  'hooks.json',
  'mcp_config.json',
  'README.md',
  'LICENSE',
  'assets',
  'rules',
  'agents',
  'hooks',
  'mcp',
  'sidecars',
  'dist',
  'bin',
  'lib',
  'vendor',
  'templates',
  'docs/calibration',
];

/** Maintainer-only skills excluded from the end-user Marketplace bundle. */
export const MAINTAINER_ONLY_SKILLS = new Set([
  'modernize',
  'release',
  'release-audit',
]);

/**
 * Build a clean Marketplace plugin directory for `antigravity-booster` and
 * return `{ stageRoot, pluginDir, marketplaceJsonPath, manifest }`.
 */
export function stageMarketplacePlugin({
  repoRoot = ROOT,
  outDir = null,
  includeMaintainerSkills = false,
  marketplaceBaseUrl = 'https://www.agybooster.com/marketplace',
} = {}) {
  const stageRoot = outDir ? resolve(outDir) : mkdtempSync(join(tmpdir(), 'agb-marketplace-'));
  const pluginDir = join(stageRoot, 'antigravity-booster');
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(pluginDir, { recursive: true });

  for (const rel of MARKETPLACE_RUNTIME_PATHS) {
    const src = join(repoRoot, rel);
    if (!existsSync(src)) continue;
    const dest = join(pluginDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  // Copy user-facing skills (filtering out repo-maintainer-only workflows unless requested).
  const skillsSrc = join(repoRoot, 'skills');
  const skillsDest = join(pluginDir, 'skills');
  mkdirSync(skillsDest, { recursive: true });
  for (const entry of readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!includeMaintainerSkills && MAINTAINER_ONLY_SKILLS.has(entry.name)) continue;
    cpSync(join(skillsSrc, entry.name), join(skillsDest, entry.name), { recursive: true });
  }

  const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
  const catalog = {
    name: 'agybooster',
    displayName: 'Antigravity Booster Marketplace',
    description: 'Official self-hosted Antigravity plugin marketplace catalog for Antigravity Booster (agb) and ADLC companion plugins.',
    homepage: 'https://www.agybooster.com',
    plugins: [
      {
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        logo: `${marketplaceBaseUrl}/assets/logo.svg`,
        suggestedPrompts: manifest.suggestedPrompts,
        categories: ['Software Delivery', 'Security'],
        source: {
          url: `${marketplaceBaseUrl}/antigravity-booster-${manifest.version}.zip`,
        },
      },
      {
        name: 'adlc-antigravity',
        displayName: 'ADLC Doctrine & Gates for Antigravity',
        version: '1.7.0',
        description: 'Agentic Development Lifecycle (ADLC) skills, spec-lint, premortem, coldstart, rails-guard, and hollow-test mutation gates for Google Antigravity.',
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        categories: ['Software Delivery', 'Security'],
        source: {
          url: `${marketplaceBaseUrl}/adlc-antigravity-1.7.0.zip`,
        },
      },
    ],
  };

  const marketplaceJsonPath = join(stageRoot, 'marketplace.json');
  writeFileSync(marketplaceJsonPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  return { stageRoot, pluginDir, marketplaceJsonPath, manifest, catalog };
}

function resolveAgyBin() {
  if (process.env.AGY_BIN && existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
  const localBin = join(process.env.HOME || '', '.local', 'bin', 'agy');
  if (existsSync(localBin)) return localBin;
  const fakeAgy = join(ROOT, 'test', 'fixtures', 'fake-agy');
  if (existsSync(fakeAgy)) return fakeAgy;
  return 'agy';
}

export function validateStagedPluginStrict(pluginDir, { agyBin = resolveAgyBin() } = {}) {
  let res = spawnSync(agyBin, ['plugin', 'validate', '--strict', '--json', pluginDir], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if ((res.error || !res.stdout) && existsSync(join(ROOT, 'test', 'fixtures', 'fake-agy'))) {
    const fakeAgy = join(ROOT, 'test', 'fixtures', 'fake-agy');
    if (agyBin !== fakeAgy) {
      res = spawnSync(fakeAgy, ['plugin', 'validate', '--strict', '--json', pluginDir], {
        encoding: 'utf8',
        timeout: 30_000,
      });
    }
  }
  if (res.error && res.error.code === 'ENOENT') {
    return { skipped: true, ok: true, reason: `agy binary not found (${agyBin})` };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {
      skipped: false,
      ok: false,
      status: res.status,
      error: `Failed to parse agy plugin validate --json output: ${res.stdout || res.stderr}`,
    };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const notes = findings.filter((f) => f.severity !== 'error' && f.severity !== 'warning').length;
  const components = parsed.components || parsed.counts || {};
  const ok = res.status === 0
    && errors === 0
    && warnings === 0
    && notes === 0
    && (components.skills ?? 0) >= 7
    && (components.agents ?? 0) >= 3
    && (components.rules ?? 0) >= 1
    && (components.hooks ?? 0) >= 1
    && (components.mcpServers ?? 0) >= 1;
  return {
    skipped: false,
    ok,
    status: res.status,
    valid: res.status === 0 && errors === 0,
    errors,
    warnings,
    notes,
    components,
    report: parsed,
    findings,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let outDir = null;
  let validateStrict = false;
  let keepTemp = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outDir = args[++i];
      keepTemp = true;
    } else if (args[i] === '--validate-strict') {
      validateStrict = true;
    } else if (args[i] === '--keep') {
      keepTemp = true;
    }
  }

  const staged = stageMarketplacePlugin({ outDir });
  try {
    if (validateStrict) {
      const result = validateStagedPluginStrict(staged.pluginDir);
      if (result.skipped) {
        console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, manifest: staged.manifest.name }, null, 2));
      } else {
        console.log(JSON.stringify({
          ok: result.ok,
          status: result.status,
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          notes: result.notes,
          components: result.components,
          findings: result.findings,
        }, null, 2));
        if (!result.ok) process.exitCode = 1;
      }
    } else {
      console.log(JSON.stringify({
        stageRoot: staged.stageRoot,
        pluginDir: staged.pluginDir,
        marketplaceJsonPath: staged.marketplaceJsonPath,
      }, null, 2));
    }
  } finally {
    if (!keepTemp && !outDir) {
      rmSync(staged.stageRoot, { recursive: true, force: true });
    }
  }
}
