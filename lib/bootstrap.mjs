import { existsSync, mkdirSync, readdirSync, lstatSync, symlinkSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readPluginContract, SUPPORTED_PLUGIN_CONTRACT } from './adlc-bridge.mjs';

const require = createRequire(import.meta.url);

const SKILLS_DST = join(homedir(), '.gemini', 'skills');
const DEFAULT_PLUGIN_RELATIVE = '../adlc/plugins/adlc-antigravity';

function isNpxTemp() {
  const filePath = fileURLToPath(import.meta.url);
  // Under npx, the path is typically inside the npm cache, e.g., ~/.npm/_npx/ or temp dirs
  return filePath.includes('_npx') || filePath.includes('.npm/_npx') || filePath.includes('/tmp/') || filePath.includes('/var/folders/');
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
function installPlugin(pluginPath, agyBin, agyCheckFailed) {
  if (agyCheckFailed) {
    console.error('warning: skipping plugin install because agy CLI is not found');
    return false;
  }

  if (!existsSync(pluginPath)) {
    console.error(`error: adlc-antigravity plugin not found at ${pluginPath}`);
    console.error('  (a) git clone git@github.com:voodootikigod/adlc.git somewhere and set ADLC_ANTIGRAVITY_PLUGIN_PATH');
    console.error('  (b) run from a source checkout with the sibling present');
    console.error('  (c) install @adlc/antigravity via npm');
    return false;
  }

  try {
    execFileSync(agyBin, ['plugin', 'install', pluginPath], { stdio: 'inherit' });
  } catch (err) {
    console.error(`error: '${agyBin} plugin install' failed: ${err.message}`);
    console.error('  your agy CLI may be too old to support plugin install — upgrade it and retry');
    return false;
  }

  // Contract handshake (B12): confirm the plugin we just installed speaks the
  // tickets/hook contract this booster projects, reading `adlcContract` from the
  // manifest we installed FROM (== the installed manifest right after install).
  // Replaces the old bare name-substring confirmation on `agy plugin list`,
  // which proved a plugin was *named* but never that its schema *matched*.
  //   incompatible integer contract → abort LOUDLY (upgrade one side or other)
  //   missing field / unreadable manifest (older plugin) → warn + degrade:
  //     enforcement will run in tolerant mode, so don't block install.
  const contract = readPluginContract({ dir: pluginPath });
  const installedLine = 'installed adlc-antigravity plugin (doctrine, prosecutor, self-orchestrate skills; rails-guard hook)';
  switch (contract.status) {
    case 'compatible':
      console.log(`${installedLine} — plugin contract ${contract.contract}`);
      break;
    case 'incompatible':
      console.error(`error: installed adlc-antigravity plugin declares adlcContract ${contract.contract}, but this antigravity-booster projects contract ${SUPPORTED_PLUGIN_CONTRACT}`);
      console.error(contract.contract > SUPPORTED_PLUGIN_CONTRACT
        ? '  upgrade antigravity-booster so it speaks the newer plugin contract'
        : '  upgrade the adlc-antigravity plugin so it speaks the contract this booster projects');
      return false;
    case 'missing-field':
      console.warn(`warning: installed adlc-antigravity plugin manifest declares no adlcContract field (older plugin) — cannot confirm it speaks booster contract ${SUPPORTED_PLUGIN_CONTRACT}; live rail enforcement will run in tolerant/degraded mode. Upgrade the plugin to enable the version handshake.`);
      console.log(installedLine);
      break;
    case 'unreadable':
    default:
      console.warn(`warning: could not read the installed adlc-antigravity plugin manifest (${contract.error}) — proceeding, but the contract handshake could not be verified`);
      console.log(installedLine);
      break;
  }
  return true;
}

export function bootstrap({ force = false, destination = SKILLS_DST, pluginPath, agyBin } = {}) {
  const resolvedAgyBin = agyBin ?? process.env.AGB_AGY_BIN ?? 'agy';

  let hasErrors = false;

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

    const tempRun = isNpxTemp();
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
  const pluginInstallSuccess = installPlugin(pluginPath ?? resolvePluginPath(), resolvedAgyBin, agyCheckFailed);
  if (!pluginInstallSuccess) {
    hasErrors = true;
  }

  console.log('\nbootstrap complete!');
  console.log('@adlc tools on Antigravity quota: export ADLC_PROVIDER=agy');
  
  if (hasErrors) {
    process.exitCode = 1;
  }
}
