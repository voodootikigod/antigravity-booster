import { existsSync, mkdirSync, readdirSync, lstatSync, symlinkSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

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

function resolvePluginPath() {
  if (process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH) {
    return resolve(process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH);
  }
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  return resolve(repoRoot, DEFAULT_PLUGIN_RELATIVE);
}

// Installs the adlc-antigravity plugin (doctrine/prosecutor/self-orchestrate
// skills, the prosecutor agent, the rails-guard hook) via `agy plugin
// install`. This repo no longer vendors copies of those skills — the plugin
// is the single source, matching how package.json already resolves
// @adlc/core via the same ../adlc sibling-checkout convention.
function installPlugin(pluginPath, agyBin) {
  if (!existsSync(pluginPath)) {
    console.error(`error: adlc-antigravity plugin not found at ${pluginPath}`);
    console.error('  set ADLC_ANTIGRAVITY_PLUGIN_PATH to its location, or check out ../adlc as a sibling of this repo');
    process.exit(1);
  }

  try {
    execFileSync(agyBin, ['plugin', 'install', pluginPath], { stdio: 'inherit' });
  } catch (err) {
    console.error(`error: '${agyBin} plugin install' failed: ${err.message}`);
    console.error('  your agy CLI may be too old to support plugin install — upgrade it and retry');
    process.exit(1);
  }

  let listOutput;
  try {
    listOutput = execFileSync(agyBin, ['plugin', 'list'], { encoding: 'utf8' });
  } catch (err) {
    console.error(`error: '${agyBin} plugin list' failed: ${err.message}`);
    process.exit(1);
  }
  if (!listOutput.includes('adlc-antigravity')) {
    console.error('error: adlc-antigravity does not appear in `agy plugin list` after install — install did not take effect');
    process.exit(1);
  }

  console.log('installed adlc-antigravity plugin (doctrine, prosecutor, self-orchestrate skills; rails-guard hook)');
}

export function bootstrap({ force = false, destination = SKILLS_DST, pluginPath, agyBin } = {}) {
  const resolvedAgyBin = agyBin ?? process.env.AGB_AGY_BIN ?? 'agy';

  // 1. Verify agy CLI is present
  try {
    execSync(`command -v ${resolvedAgyBin}`, { stdio: 'ignore' });
  } catch (err) {
    console.error('error: agy CLI not found on PATH — install Antigravity CLI first');
    console.error('  curl -fsSL https://antigravity.google/cli/install.sh | bash');
    process.exit(1);
  }

  // 2. Install the adlc-antigravity plugin — the source of doctrine/
  // prosecutor/self-orchestrate skills and the rails-guard hook.
  installPlugin(pluginPath ?? resolvePluginPath(), resolvedAgyBin);

  // 3. Locate booster's own (non-ADLC-doctrine) skills, e.g. skills/release/
  const skillsSrc = fileURLToPath(new URL('../skills', import.meta.url));
  if (!existsSync(skillsSrc)) {
    console.error(`error: internal skills directory not found at ${skillsSrc}`);
    process.exit(1);
  }

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

  console.log('\nbootstrap complete!');
  console.log('@adlc tools on Antigravity quota: export ADLC_PROVIDER=agy');
}
