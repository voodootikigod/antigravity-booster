#!/usr/bin/env node
// sync-skills — mirror the canonical skills/ tree into the per-harness discovery dirs.
//
// WHY. One skill, three harnesses, three discovery paths:
//   Claude Code  -> .claude/skills/<name>/SKILL.md
//   Codex CLI    -> .agents/skills/<name>/SKILL.md   (repo scope)
//   agy          -> .agents/skills/<name>/SKILL.md   (workspace scope)
// skills/<name>/ is the only place a skill is edited (it is also what ships in the
// npm package and the agy plugin). The mirrors are byte-for-byte copies, never
// symlinks: Windows checkouts break on them and lib/migrate.mjs rejects skill links.
//
// Only skills this script has written (recorded in each mirror's .agb-synced.json)
// or that exist in skills/ are managed. A foreign skill sitting in a mirror dir is
// never read, overwritten or deleted.
//
// Usage:
//   node scripts/sync-skills.mjs          # write the mirrors
//   node scripts/sync-skills.mjs --check  # exit 1 on any drift, write nothing

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const SOURCE_DIR = 'skills';
export const MIRRORS = ['.claude/skills', '.agents/skills'];
export const MANIFEST = '.agb-synced.json';

/** Sorted repo-relative file list under dir. Symlinks are refused, not followed. */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink in a skill tree: ${full}`);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/** Skill names under skills/: directories that carry a SKILL.md. */
export function canonicalSkills(root = ROOT) {
  const src = join(root, SOURCE_DIR);
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(src, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

function readManifest(mirrorDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(mirrorDir, MANIFEST), 'utf8'));
    return Array.isArray(parsed.managed) ? parsed.managed.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

/** Differences between one canonical skill and its mirror copy. */
function diffSkill(srcDir, dstDir) {
  const want = listFiles(srcDir);
  if (!existsSync(dstDir)) return ['missing'];
  const problems = [];
  const have = listFiles(dstDir);
  for (const f of want) {
    if (!have.includes(f)) problems.push(`missing file ${f}`);
    else if (!readFileSync(join(srcDir, f)).equals(readFileSync(join(dstDir, f)))) problems.push(`differs ${f}`);
  }
  for (const f of have) if (!want.includes(f)) problems.push(`extra file ${f}`);
  return problems;
}

/**
 * Sync (or, with check:true, only verify) every mirror.
 * Returns { ok, problems: string[], written: string[] } and never throws on drift.
 */
export function syncSkills({ root = ROOT, check = false, mirrors = MIRRORS } = {}) {
  const names = canonicalSkills(root);
  const problems = [];
  const written = [];

  for (const mirror of mirrors) {
    const mirrorDir = join(root, mirror);
    const previouslyManaged = readManifest(mirrorDir);
    const stale = previouslyManaged.filter((n) => !names.includes(n));

    for (const name of names) {
      const src = join(root, SOURCE_DIR, name);
      const dst = join(mirrorDir, name);
      const drift = diffSkill(src, dst);
      if (drift.length === 0) continue;
      if (check) {
        for (const d of drift) problems.push(`${mirror}/${name}: ${d}`);
        continue;
      }
      mkdirSync(mirrorDir, { recursive: true });
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true, dereference: false });
      written.push(`${mirror}/${name}`);
    }

    for (const name of stale) {
      const dst = join(mirrorDir, name);
      if (!existsSync(dst)) continue;
      if (check) {
        problems.push(`${mirror}/${name}: removed from skills/ but still mirrored`);
      } else {
        rmSync(dst, { recursive: true, force: true });
        written.push(`${mirror}/${name} (removed)`);
      }
    }

    const manifest = `${JSON.stringify({ managed: names }, null, 2)}\n`;
    const manifestPath = join(mirrorDir, MANIFEST);
    const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
    if (current !== manifest) {
      if (check) {
        if (names.length > 0) problems.push(`${mirror}/${MANIFEST}: out of date`);
      } else if (names.length > 0) {
        mkdirSync(mirrorDir, { recursive: true });
        writeFileSync(manifestPath, manifest);
        written.push(`${mirror}/${MANIFEST}`);
      }
    }
  }

  return { ok: problems.length === 0, problems, written };
}

export function syncMain(argv = process.argv.slice(2), { log = console.log, err = console.error, root = ROOT } = {}) {
  const check = argv.includes('--check');
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    err(`usage: sync-skills [--check]  (unknown: ${unknown.join(' ')})`);
    return 1;
  }
  let result;
  try {
    result = syncSkills({ root, check });
  } catch (e) {
    err(`sync-skills: ${e.message}`);
    return 1;
  }
  if (check) {
    if (result.ok) {
      log(`skills mirrors in sync (${canonicalSkills(root).length} skills x ${MIRRORS.length} harness dirs)`);
      return 0;
    }
    err('skills mirrors have drifted from skills/ — run: npm run skills:sync');
    for (const p of result.problems) err(`  ${p}`);
    return 1;
  }
  log(result.written.length === 0 ? 'skills mirrors already in sync' : `synced:\n  ${result.written.join('\n  ')}`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(syncMain());
