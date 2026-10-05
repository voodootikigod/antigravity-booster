// Path resolution and matching for the PreToolUse policy guard.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { IMPLICIT_RAIL_DIRS, IMPLICIT_RAIL_FILES, TICKET_STORE_DIR } from './constants.mjs';

const HOME_PREFIX = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** Expand a leading `~`, `$HOME` or `${HOME}` (protection matching only, A.4 item 3). */
export function expandHome(token, home) {
  return token.replace(HOME_PREFIX, home);
}

export function hasHomePrefix(token) {
  return HOME_PREFIX.test(token);
}

/**
 * Canonicalise a path that may not exist yet: realpath the deepest existing
 * ancestor and re-append the missing segments (spec §4.5.1 resolveSafeTarget).
 */
export function resolveSafeTarget(absPath) {
  let curr = resolve(absPath);
  const missing = [];
  while (!existsSync(curr)) {
    const parent = dirname(curr);
    if (parent === curr) break;
    missing.unshift(basename(curr));
    curr = parent;
  }
  let real = curr;
  try {
    real = realpathSync(curr);
  } catch {
    // Unreadable ancestor: fall back to the lexical path.
  }
  return missing.length > 0 ? join(real, ...missing) : real;
}

/** Resolve a candidate token against `base`, returning both lexical and real forms. */
export function resolveCandidate(token, base, home) {
  const expanded = expandHome(token, home);
  const lexical = isAbsolute(expanded) ? resolve(expanded) : resolve(base ?? '/', expanded);
  return { lexical, real: resolveSafeTarget(lexical) };
}

function fold(p, platform) {
  return platform === 'darwin' ? p.toLowerCase() : p;
}

/** True when `child` equals `parent` or sits beneath it. */
export function isWithin(child, parent, platform = process.platform) {
  const c = fold(child, platform);
  const p = fold(parent, platform);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function protectedRoots(home) {
  return [
    join(home, '.gemini'),
    join(home, '.config', 'antigravity-booster'),
    join(home, '.local', 'bin', 'agb'),
    join(home, '.local', 'share', 'fnm'),
    join(home, '.local', 'share', 'mise'),
    join(home, '.asdf'),
    join(home, '.volta'),
    join(home, '.nodenv'),
    join(home, '.nvm'),
    join(home, 'n'),
    '/opt/homebrew',
    '/usr/local',
  ];
}

export function boosterDataRoots(home) {
  return [
    join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster'),
    join(home, '.config', 'antigravity-booster'),
  ];
}

/** First root (from `roots`) that contains either form of the resolved path. */
export function matchRoot(resolved, roots, platform) {
  for (const root of roots) {
    if (isWithin(resolved.lexical, root, platform) || isWithin(resolved.real, root, platform)) return root;
  }
  return null;
}

/** Repo-relative POSIX path, or null when `abs` is outside `repoRoot`. */
export function repoRelative(abs, repoRoot) {
  let realRepo = repoRoot;
  try {
    realRepo = realpathSync(repoRoot);
  } catch {
    // keep lexical
  }
  const rel = relative(realRepo, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function covers(rel, target, platform) {
  const r = fold(rel, platform);
  const t = fold(target, platform);
  return r === t || r.startsWith(t + '/');
}

function isAncestor(rel, target, platform) {
  const r = fold(rel, platform);
  const t = fold(target, platform);
  return r === '' || t.startsWith(r + '/');
}

/**
 * Appendix A D1 trust-root set. Returns a reason string when `rel` is inside
 * (or is an ancestor of) an implicit rail, or an existing ticket shard.
 */
export function matchImplicitRail(rel, repoRoot, platform) {
  for (const dir of IMPLICIT_RAIL_DIRS) {
    if (covers(rel, dir, platform) || isAncestor(rel, dir, platform)) return `${dir}/**`;
  }
  for (const file of IMPLICIT_RAIL_FILES) {
    if (covers(rel, file, platform) || isAncestor(rel, file, platform)) return file;
  }
  if (isAncestor(rel, TICKET_STORE_DIR, platform) || fold(rel, platform) === fold(TICKET_STORE_DIR, platform)) {
    return `${TICKET_STORE_DIR}/`;
  }
  if (covers(rel, TICKET_STORE_DIR, platform)) {
    // A path inside the store: only creating a NEW shard file is permitted (P0).
    if (existsSync(join(repoRoot, rel))) return 'existing ticket shard';
    if (rel.slice(TICKET_STORE_DIR.length + 1).includes('/')) return `${TICKET_STORE_DIR}/`;
  }
  return null;
}

/** First declared rail matching `rel` in either direction (§4.5.1 Gate 1). */
export function matchDeclaredRail(rel, rails, platform) {
  const nocase = platform === 'darwin';
  if (rel === '' && rails.length > 0) return rails[0];
  for (const rail of rails) {
    if (
      covers(rel, rail, platform) ||
      isAncestor(rel, rail, platform) ||
      minimatch(rel, rail, { dot: true, nocase }) ||
      minimatch(rail, `${rel}/**`, { dot: true, nocase })
    ) {
      return rail;
    }
  }
  return null;
}

/** Appendix A.4 item 8: scope entries are globs; a plain directory entry also covers descendants. */
export function matchesScope(rel, scope, platform) {
  const nocase = platform === 'darwin';
  return scope.some(
    (entry) =>
      typeof entry === 'string' &&
      entry.length > 0 &&
      (minimatch(rel, entry, { dot: true, nocase }) || covers(rel, entry.replace(/\/+$/, ''), platform)),
  );
}
