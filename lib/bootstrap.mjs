import { existsSync, mkdirSync, readdirSync, lstatSync, symlinkSync, copyFileSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readPluginContract, SUPPORTED_PLUGIN_CONTRACT } from './adlc-bridge.mjs';

const require = createRequire(import.meta.url);

const SKILLS_DST = join(homedir(), '.gemini', 'skills');
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
function installPlugin(pluginPath, agyBin, agyCheckFailed, pluginName = 'adlc-antigravity') {
  const isJetskiMode = process.env.AGB_PROVIDER === 'jetski' || agyCheckFailed;
  let runnerBin = agyBin;
  let useJetski = false;

  if (isJetskiMode) {
    try {
      execSync('command -v jetski', { stdio: 'ignore' });
      runnerBin = 'jetski';
      useJetski = true;
    } catch {
      // Keep agyBin fallback
    }
  }

  if (!useJetski && agyCheckFailed) {
    console.error(`warning: skipping ${pluginName} install because neither agy nor jetski CLI is found`);
    return false;
  }

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
    // Contract handshake (B12)
    const contract = readPluginContract({ dir: pluginPath });
    const installedLine = `installed ${pluginName} plugin`;
    switch (contract.status) {
      case 'compatible':
        console.log(`${installedLine} — plugin contract ${contract.contract}`);
        break;
      case 'incompatible':
        console.error(`error: installed ${pluginName} plugin declares adlcContract ${contract.contract}, but this antigravity-booster projects contract ${SUPPORTED_PLUGIN_CONTRACT}`);
        return false;
      case 'missing-field':
        console.warn(`warning: installed ${pluginName} plugin manifest declares no adlcContract field (older plugin) — cannot confirm it speaks booster contract ${SUPPORTED_PLUGIN_CONTRACT}; live rail enforcement will run in tolerant/degraded mode. Upgrade the plugin to enable the version handshake.`);
        console.log(installedLine);
        break;
      case 'unreadable':
      default:
        console.warn(`warning: could not read the installed ${pluginName} plugin manifest (${contract.error}) — proceeding, but the contract handshake could not be verified`);
        console.log(installedLine);
        break;
    }
  } else {
    console.log(`installed ${pluginName} plugin`);
  }

  return true;
}

export function resolveBoosterPluginPath() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const localAgbPlugin = resolve(repoRoot, '.agents/plugins/agb');
  if (existsSync(localAgbPlugin)) {
    return localAgbPlugin;
  }
  return resolve(repoRoot);
}


export function bootstrap({ force = false, destination = SKILLS_DST, pluginPath, agyBin } = {}) {
  const resolvedAgyBin = agyBin ?? process.env.AGB_AGY_BIN ?? 'agy';

  let hasErrors = false;
  const tempRun = isNpxTemp();

  // 1. Verify agy CLI is present
  let agyCheckFailed = false;
  try {
    execSync(`command -v ${resolvedAgyBin}`, { stdio: 'ignore' });
  } catch (err) {
    console.error('error: agy CLI not found on PATH — install Antigravity CLI first');
    console.error('  curl -fsSL https://antigravity.google/cli/install.sh | bash');
    agyCheckFailed = true;
    hasErrors = true;
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

  // 2. Install the adlc-antigravity plugin
  const pluginInstallSuccess = installPlugin(pluginPath ?? resolvePluginPath(), resolvedAgyBin, agyCheckFailed, 'adlc-antigravity');
  if (!pluginInstallSuccess) {
    hasErrors = true;
  }

  // 2.5 Install the antigravity-booster plugin itself
  const boosterPluginPath = resolveBoosterPluginPath();
  const boosterInstallSuccess = installPlugin(boosterPluginPath, resolvedAgyBin, agyCheckFailed, 'antigravity-booster');
  if (!boosterInstallSuccess) {
    hasErrors = true;
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
