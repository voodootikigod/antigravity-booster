import { existsSync, mkdirSync, readdirSync, lstatSync, symlinkSync, copyFileSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readPluginContract, SUPPORTED_PLUGIN_CONTRACT, IS_BUNDLED } from './adlc-bridge.mjs';
import { evaluateStagedAdlcPlugin } from './doctor.mjs';
import {
  installAdlcAntigravityFromVendor,
  installTerminalShim,
  pluginsDirFor,
  resolvePluginRoot,
  safePluginInstall,
  BUNDLED_ADLC_ANTIGRAVITY_VERSION,
  ADLC_ANTIGRAVITY_PLUGIN_NAME,
} from './plugin-paths.mjs';

const require = createRequire(import.meta.url);

const DEFAULT_PLUGIN_RELATIVE = '../adlc/plugins/adlc-antigravity';

export function isNpxTemp(filePath = fileURLToPath(import.meta.url), env = process.env) {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const segments = filePath.split(path.sep);
  
  const inNpxDir = segments.includes('_npx');
  const inNpmCache = !!(env.npm_config_cache && filePath.startsWith(env.npm_config_cache));
  const inMacOSTmp = filePath.startsWith('/var/folders/') || filePath.startsWith('/private/var/folders/');
  
  let inOsTmp = false;
  try {
    const realTmp = fs.realpathSync(os.tmpdir());
    const realFile = fs.realpathSync(filePath);
    const rel = path.relative(realTmp, realFile);
    inOsTmp = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (e) {
    inOsTmp = filePath.startsWith(os.tmpdir());
  }
  
  return inNpxDir || inNpmCache || inMacOSTmp || inOsTmp;
}

function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

export function resolvePluginPath() {
  if (process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH) {
    return resolve(process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH);
  }
  
  try {
    try {
      const packageJsonPath = require.resolve('@adlc/antigravity/package.json');
      return dirname(packageJsonPath);
    } catch {
      // Fallback if the package uses modern "exports" that omit "./package.json"
      const mainPath = require.resolve('@adlc/antigravity');
      const pkgName = '@adlc/antigravity';
      const lastIndex = mainPath.lastIndexOf(pkgName);
      if (lastIndex === -1) {
        throw new Error('Aliased package not supported without package.json export');
      }
      return mainPath.substring(0, lastIndex + pkgName.length);
    }
  } catch (err) {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    return resolve(repoRoot, DEFAULT_PLUGIN_RELATIVE);
  }
}

// Installs the adlc-antigravity plugin (doctrine/prosecutor/self-orchestrate
// skills, the prosecutor agent, the rails-guard hook) via `agy plugin
// install`. This repo no longer vendors copies of those skills — the plugin
// is the single source, matching how package.json already resolves
// @adlc/core via the same ../adlc sibling-checkout convention.
function resolvePluginRunner(agyBin, agyCheckFailed) {
  const isJetskiMode = process.env.AGB_PROVIDER === 'jetski' || agyCheckFailed;
  if (isJetskiMode) {
    try {
      execSync('command -v jetski', { stdio: 'ignore' });
      return { runnerBin: 'jetski', useJetski: true };
    } catch {
      // Keep agyBin fallback
    }
  }
  if (agyCheckFailed) return null;
  return { runnerBin: agyBin, useJetski: false };
}

// Contract handshake (B12) for an installed adlc-antigravity plugin dir.
// Returns false only on a declared-incompatible contract.
function reportAdlcContract(pluginName, dir) {
  const contract = readPluginContract({ dir });
  const installedLine = `installed ${pluginName} plugin`;
  switch (contract.status) {
    case 'compatible':
      console.log(`${installedLine} — plugin contract ${contract.contract}`);
      return true;
    case 'incompatible':
      console.error(`error: installed ${pluginName} plugin declares adlcContract ${contract.contract}, but this antigravity-booster projects contract ${SUPPORTED_PLUGIN_CONTRACT}`);
      return false;
    case 'tolerant':
      console.warn(`warning: installed ${pluginName} plugin manifest declares no adlcContract field (older plugin) — cannot confirm it speaks booster contract ${SUPPORTED_PLUGIN_CONTRACT}; live rail enforcement will run in tolerant/degraded mode. Upgrade the plugin to enable the version handshake.`);
      console.log(installedLine);
      return true;
    case 'unreadable':
    case 'corrupt':
    default:
      console.warn(`warning: could not read the installed ${pluginName} plugin manifest (${contract.error}) — proceeding, but the contract handshake could not be verified`);
      console.log(installedLine);
      return true;
  }
}

function installPlugin(pluginPath, agyBin, agyCheckFailed, pluginName = 'adlc-antigravity') {
  const runner = resolvePluginRunner(agyBin, agyCheckFailed);
  if (!runner) {
    console.error(`warning: skipping ${pluginName} install because neither agy nor jetski CLI is found`);
    return false;
  }
  const { runnerBin, useJetski } = runner;

  if (!existsSync(pluginPath)) {
    console.error(`error: ${pluginName} plugin not found at ${pluginPath}`);
    if (pluginName === 'adlc-antigravity') {
      console.error('  (a) git clone git@github.com:voodootikigod/adlc.git somewhere and set ADLC_ANTIGRAVITY_PLUGIN_PATH');
      console.error('  (b) run from a source checkout with the sibling present');
      console.error('  (c) install @adlc/antigravity via npm');
    }
    return false;
  }

  console.log(`installing plugin ${pluginName} from ${pluginPath} using ${runnerBin}...`);
  try {
    if (useJetski) {
      execFileSync(runnerBin, ['plugin', 'install', pluginPath], { stdio: 'inherit' });
    } else {
      execFileSync(runnerBin, ['plugin', 'install', '.'], { cwd: pluginPath, stdio: 'inherit' });
    }
  } catch (err) {
    console.error(`error: '${runnerBin} plugin install' failed: ${err.message}`);
    return false;
  }

  if (pluginName === 'adlc-antigravity') {
    return reportAdlcContract(pluginName, pluginPath);
  }
  console.log(`installed ${pluginName} plugin`);
  return true;
}

/**
 * Stage booster itself through safePluginInstall (Appendix A.4 item 19,
 * A.6 item 16): always from a copy that excludes node_modules/, .worktrees/
 * and .git/, under the canonical name regardless of the source basename.
 * jetski keeps its native install path (safePluginInstall drives agy).
 */
function installBoosterPlugin({ home, agyBin, agyCheckFailed }) {
  const runner = resolvePluginRunner(agyBin, agyCheckFailed);
  if (!runner) {
    console.error('warning: skipping antigravity-booster install because neither agy nor jetski CLI is found');
    return false;
  }
  const source = resolveBoosterPluginPath();
  if (runner.useJetski) return installPlugin(source, agyBin, agyCheckFailed, 'antigravity-booster');
  console.log(`installing plugin antigravity-booster from ${source} using ${runner.runnerBin}...`);
  const res = safePluginInstall(source, 'antigravity-booster', { home, agyBin: runner.runnerBin });
  if (!res.ok) {
    console.error(`error: failed to install antigravity-booster: ${res.error}`);
    return false;
  }
  return true;
}

// Why bootstrap (re)installs the companion plugin, per decision-table row.
function installReason(r, forceReinstall) {
  if (forceReinstall) return `reinstalling ${r.dir.split('/').pop()}: --force-reinstall`;
  if (r.report === 'not-installed') return `installing bundled adlc-antigravity ${BUNDLED_ADLC_ANTIGRAVITY_VERSION}`;
  if (r.report === 'outdated-plugin') return `upgrading adlc-antigravity ${r.version} -> ${BUNDLED_ADLC_ANTIGRAVITY_VERSION}`;
  return `reinstalling adlc-antigravity: ${r.report}`;
}

/**
 * Stage the companion plugin per the §4.4 Normative Bootstrap & Doctor
 * Decision Table (evaluateStagedAdlcPlugin, shared with doctor). Installs only
 * the pinned vendored release tarball (Decision 1), never rewrites the staged
 * plugin's files, and re-evaluates afterwards: the install must land on a
 * doctor-exit-0 row. --force-reinstall always reinstalls.
 */
function installVendoredAdlcAntigravity({ home, forceReinstall, agyBin, agyCheckFailed }) {
  const pluginName = ADLC_ANTIGRAVITY_PLUGIN_NAME;
  const before = evaluateStagedAdlcPlugin({ home });
  const action = forceReinstall ? 'reinstall' : before.bootstrapAction;
  if (action === 'fail') {
    console.error(`error: staged ${pluginName} at ${before.dir} is ${before.report}${before.detail ? ` (${before.detail})` : ''} — leaving it untouched; run \`agb bootstrap --force-reinstall\` to replace it with the bundled ${BUNDLED_ADLC_ANTIGRAVITY_VERSION}`);
    return false;
  }
  if (action === 'preserve') {
    if (before.report === 'compatible') {
      console.log(`ok      ${pluginName} ${before.version} verified (compatible)`);
    } else if (before.report.startsWith('tolerant')) {
      console.warn(`warning: keeping ${pluginName} ${before.version}: ${before.report} — it declares no adlcContract, so live rail enforcement runs in tolerant mode`);
    } else {
      console.log(`notice: keeping ${pluginName} ${before.version}: ${before.report} (newer than the bundled ${BUNDLED_ADLC_ANTIGRAVITY_VERSION}; not digest-pinned)`);
    }
    return true;
  }
  const runner = resolvePluginRunner(agyBin, agyCheckFailed);
  if (!runner) {
    console.error(`warning: skipping ${pluginName} install because neither agy nor jetski CLI is found`);
    return false;
  }
  console.log(`${installReason(before, forceReinstall)} from the vendored release tarball using ${runner.runnerBin}...`);
  const res = installAdlcAntigravityFromVendor({ home, agyBin: runner.runnerBin });
  if (!res.ok) {
    console.error(`error: failed to install ${pluginName}: ${res.error}`);
    return false;
  }
  const after = evaluateStagedAdlcPlugin({ home });
  if (after.doctorExit !== 0) {
    console.error(`error: ${pluginName} is ${after.report} after install — the staged plugin does not verify`);
    return false;
  }
  console.log(`installed ${pluginName}: ${after.report}`);
  return true;
}

// Explicit companion-plugin source: the programmatic `pluginPath` option, or
// ADLC_ANTIGRAVITY_PLUGIN_PATH in unbundled source runs only (spec §4.4
// Decision 2 — the bundled build ignores every override).
function explicitAdlcPluginPath(pluginPath) {
  if (pluginPath) return pluginPath;
  // Unbundled AND explicitly opted in: the env override installs an
  // unverified plugin, so it is a developer-only path (ticket T3 item 1).
  if (!IS_BUNDLED && process.env.AGB_DEV_ALLOW_UNVERIFIED_PLUGIN === '1' && process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH) {
    return resolve(process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH);
  }
  return undefined;
}

// The booster plugin root is the directory whose plugin.json names
// antigravity-booster (A.4 item 18) — never .agents/plugins/agb, which is now
// the hookless agb-legacy-shim.
export function resolveBoosterPluginPath() {
  try {
    return resolvePluginRoot();
  } catch {
    return resolve(fileURLToPath(new URL('..', import.meta.url)));
  }
}


export function bootstrap({
  force = false,
  forceReinstall = false,
  home = homedir(),
  destination = join(home, '.gemini', 'skills'),
  pluginPath,
  agyBin,
} = {}) {
  const resolvedAgyBin = agyBin ?? process.env.AGB_AGY_BIN ?? 'agy';

  let hasErrors = false;
  const tempRun = isNpxTemp();

  // 1. Verify agy CLI is present
  let agyCheckFailed = false;
  try {
    execFileSync('which', [resolvedAgyBin], { stdio: 'ignore' });
  } catch (err) {

    console.log(`info: agy CLI not found on PATH; bootstrap will attempt to fall back to jetski CLI`);
    agyCheckFailed = true;
  }



  // 3. Locate booster's own (non-ADLC-doctrine) skills, e.g. skills/release/
  const skillsSrc = fileURLToPath(new URL('../skills', import.meta.url));
  let skillsFound = true;
  if (!existsSync(skillsSrc)) {
    console.error(`error: internal skills directory not found at ${skillsSrc}`);
    skillsFound = false;
    hasErrors = true;
  }

  if (skillsFound) {
    // 4. Create destination directory
    mkdirSync(destination, { recursive: true });

    console.log(`agb bootstrap: installing skills into ${destination}...`);
    if (tempRun) {
      console.log('npx temp execution detected: copying files (symlinks would break on exit)');
    } else {
      console.log('installation directory is stable: using symlinks for auto-upgrades');
    }

    const skills = readdirSync(skillsSrc, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const name of skills) {
      const src = join(skillsSrc, name);
      const dst = join(destination, name);

      if (existsSync(dst)) {
        const isSymlink = lstatSync(dst).isSymbolicLink();
        if (force) {
          console.log(`overwriting existing skill: ${name}`);
          rmSync(dst, { recursive: true, force: true });
        } else {
          if (isSymlink) {
            console.log(`ok      ${name} (already linked)`);
          } else {
            console.warn(`skip    ${name} (exists and is not a symlink — use --force to overwrite)`);
          }
          continue;
        }
      }

      if (tempRun) {
        try {
          copyDirSync(src, dst);
          console.log(`copied  ${name} -> ${dst}`);
        } catch (err) {
          console.error(`error: failed to copy skill ${name}: ${err.message}`);
        }
      } else {
        try {
          symlinkSync(src, dst);
          console.log(`linked  ${name} -> ${dst}`);
        } catch (err) {
          console.error(`error: failed to symlink skill ${name}: ${err.message}`);
        }
      }
    }
  }

  // 2. Install the adlc-antigravity plugin: an explicit source if one was
  // given, otherwise the integrity-pinned vendored release tarball.
  const explicitPath = explicitAdlcPluginPath(pluginPath);
  const pluginInstallSuccess = explicitPath
    ? installPlugin(explicitPath, resolvedAgyBin, agyCheckFailed, 'adlc-antigravity')
    : installVendoredAdlcAntigravity({ home, forceReinstall, agyBin: resolvedAgyBin, agyCheckFailed });
  if (!pluginInstallSuccess) {
    hasErrors = true;
  }

  // 2.5 Install the antigravity-booster plugin itself
  const boosterInstallSuccess = installBoosterPlugin({ home, agyBin: resolvedAgyBin, agyCheckFailed });
  if (!boosterInstallSuccess) {
    hasErrors = true;
  }

  
  // 2.6 Terminal shim ~/.local/bin/agb (Appendix A D3, A.6 item 15): the
  // entry point slash commands invoke. Foreign content is only replaced
  // with --force-reinstall.
  const shim = installTerminalShim({ home, force: forceReinstall });
  if (!shim.ok) {
    console.error(`error: ${shim.error}`);
    hasErrors = true;
  } else if (shim.action === 'written') {
    console.log(`installed terminal shim ${shim.path}`);
  } else if (shim.action === 'unchanged') {
    console.log(`ok      terminal shim ${shim.path} (already current)`);
  } else {
    console.warn(`skip    terminal shim ${shim.path} (exists with other content — use --force-reinstall to overwrite)`);
  }

  // 3. The sidecar plugin is no longer auto-installed here for security reasons.
  // The user must manually opt-in via `agb sidecar --unsafe-open`.

  console.log('\nbootstrap complete!');
  console.log('@adlc tools on Antigravity quota: export ADLC_PROVIDER=agy');
  
  if (!tempRun) {
    console.log('\nTo start the sidecar dashboard, run:');
    console.log('  agb sidecar <repo-path>');
  }
  
  if (hasErrors) {
    process.exitCode = 1;
  }
}
