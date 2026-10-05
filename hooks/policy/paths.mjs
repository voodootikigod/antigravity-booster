// Path resolution and matching for the PreToolUse policy guard.
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { IMPLICIT_RAIL_DIRS, IMPLICIT_RAIL_FILES, TICKET_STORE_DIR } from './constants.mjs';

const HOME_PREFIX = /^(~[A-Za-z0-9._-]*|\$HOME|\$\{HOME\})(?=\/|$)/;

/**
 * Expand a leading `~`, `~user`, `$HOME` or `${HOME}` (protection matching
 * only, A.4 item 3). `~user` maps to a sibling of the home directory, which
 * is exact for the current user (P5 round 2) and conservative for others.
 */
export function expandHome(token, home) {
  return token.replace(HOME_PREFIX, (m) => (m.startsWith('~') && m.length > 1 ? join(dirname(home), m.slice(1)) : home));
}

export function hasHomePrefix(token) {
  return HOME_PREFIX.test(token);
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Canonicalise a path that may not exist yet (spec §4.5.1 resolveSafeTarget):
 * find the deepest ancestor that exists *as a directory entry* (lstat, so a
 * dangling symlink counts), follow it if it is a symlink — relative to the
 * link's own directory — and repeat; then realpath the existing ancestor and
 * re-append the missing segments. A dangling link therefore resolves to the
 * file it would create (P5 round 2). A symlink loop returns the lexical path.
 */
export function resolveSafeTarget(absPath) {
  let curr = resolve(absPath);
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let probe = curr;
    const missing = [];
    let st = lstatOrNull(probe);
    while (!st) {
      const parent = dirname(probe);
      if (parent === probe) break;
      missing.unshift(basename(probe));
      probe = parent;
      st = lstatOrNull(probe);
    }
    if (st?.isSymbolicLink()) {
      const target = resolve(dirname(probe), readlinkSync(probe));
      curr = missing.length > 0 ? join(target, ...missing) : target;
      continue;
    }
    let real = probe;
    try {
      real = realpathSync(probe);
    } catch {
      // Unreadable ancestor: fall back to the lexical path.
    }
    return missing.length > 0 ? join(real, ...missing) : real;
  }
  return resolve(absPath);
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
  // A nested .adlc/ or .git below the root would re-root the repository for
  // every later evaluation (P5 prosecution C1): never let one be created.
  if (rel.split('/').slice(1).some((seg) => ['.adlc', '.git'].includes(fold(seg, platform)))) {
    return 'nested .adlc/ or .git/ inside an ADLC repository';
  }
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

const GLOB_SEGMENT = /[*?[\]{}!]/;

/** Leading glob-free segments of a rail pattern (`bin/**` -> `bin`). */
export function railStaticPrefix(rail) {
  const kept = [];
  for (const seg of rail.split('/')) {
    if (GLOB_SEGMENT.test(seg)) break;
    kept.push(seg);
  }
  return kept.join('/');
}

/**
 * First declared rail matching `rel` in either direction (§4.5.1 Gate 1):
 * the path is inside the rail, matches its glob, or is a directory that
 * contains it. Only ticket-declared rails are ever used as glob patterns;
 * the agent-controlled path never is (P5 prosecution H5: a 64 KB path used
 * as a pattern crashed the evaluator).
 */
export function matchDeclaredRail(rel, rails, platform) {
  const nocase = platform === 'darwin';
  for (const rail of rails) {
    const prefix = railStaticPrefix(rail);
    if (
      covers(rel, rail, platform) ||
      (prefix !== '' && (fold(rel, platform) === fold(prefix, platform) || isAncestor(rel, prefix, platform))) ||
      minimatch(rel, rail, { dot: true, nocase })
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

/**
 * For a path already matched by matchImplicitRail / matchDeclaredRail: is it
 * only an ANCESTOR directory of the protected path (the protected path lies
 * beneath it) rather than the protected path itself? Shell commands that
 * merely name such a directory ask; destructive ones deny (owner decision
 * 2026-10-05).
 */
export function isImplicitAncestorOnly(rel, platform) {
  if (rel.split('/').slice(1).some((seg) => ['.adlc', '.git'].includes(fold(seg, platform)))) return false;
  return ![...IMPLICIT_RAIL_DIRS, ...IMPLICIT_RAIL_FILES, TICKET_STORE_DIR].some((t) => covers(rel, t, platform));
}

export function isRailAncestorOnly(rel, rail, platform) {
  return !covers(rel, rail, platform) && !minimatch(rel, rail, { dot: true, nocase: platform === 'darwin' });
}
