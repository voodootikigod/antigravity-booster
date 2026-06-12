import { existsSync, mkdirSync, readdirSync, lstatSync, symlinkSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const SKILLS_DST = join(homedir(), '.gemini', 'skills');

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

export function bootstrap({ force = false, destination = SKILLS_DST } = {}) {
  // 1. Verify agy CLI is present
  try {
    execSync('command -v agy', { stdio: 'ignore' });
  } catch (err) {
    console.error('error: agy CLI not found on PATH — install Antigravity CLI first');
    console.error('  curl -fsSL https://antigravity.google/cli/install.sh | bash');
    process.exit(1);
  }

  // 2. Locate internal skills
  const skillsSrc = fileURLToPath(new URL('../skills', import.meta.url));
  if (!existsSync(skillsSrc)) {
    console.error(`error: internal skills directory not found at ${skillsSrc}`);
    process.exit(1);
  }

  // 3. Create destination directory
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
