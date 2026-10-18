// Fail-closed reader for the ADLC ticket store's active rails.
//
// Shared by the in-session PreToolUse policy guard (hooks/pre-tool-use.mjs)
// and the scheduler's enforcement gate (spec .adlc/specs/native-plugin-
// installation.md §4.2/§4.3, Appendix A E1). Every function here returns a
// result object and never throws: a store that cannot be read is reported as
// { ok: false, railsPresent: true } so the CALLER fails closed.
import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as ticketsApi from '@adlc/tickets';

const INACTIVE_STATUSES = new Set(['completed', 'closed', 'archived']);

/**
 * A ticket is active unless it is explicitly retired: the store's own
 * completion flag (`completed: true`) or a terminal `status`. Anything else —
 * a missing status, an unknown in-flight status, a malformed ticket — counts
 * as active, so it keeps contributing rails (fail closed).
 */
export function isActiveTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return true;
  if (ticket.completed === true) return false;
  return !INACTIVE_STATUSES.has(ticket.status);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlinkOrDirectory(path) {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() || st.isDirectory();
  } catch {
    return false;
  }
}

function walkUp(start, predicate) {
  let curr = resolve(start);
  for (;;) {
    if (predicate(curr)) return curr;
    const parent = dirname(curr);
    if (parent === curr) return null;
    curr = parent;
  }
}

/** Nearest ancestor (inclusive) containing a `.git` directory or worktree file. */
export function findGitTop(targetPath) {
  return walkUp(targetPath, (dir) => existsSync(join(dir, '.git')));
}

/**
 * ADLC repository root for `targetPath`, or null. The target need not exist
 * yet (new files). Walking up from the target:
 *
 * 1. The first git top (`.git` directory or worktree file) that also holds
 *    `.adlc/` is the root: a worktree of an ADLC repo is its own root.
 * 2. A git top WITHOUT `.adlc/` (a submodule, or a `.git` planted inside
 *    the repo) does not stop the walk, so it can never hide the outer
 *    repository's rails (P5 round 3 H3).
 * 3. With no such git top, the OUTERMOST `.adlc/` ancestor wins: an ADLC
 *    project inside a monorepo, or a non-git project under a planted parent
 *    `.git`, stays protected, and a decoy `.adlc/` deeper in the tree can
 *    never re-root it (P5 C1).
 * The home directory and `/` are skipped: they hold global state (~/.adlc).
 */
export function findAdlcRoot(targetPath, { home = homedir() } = {}) {
  const homeDir = resolve(home);
  let outermost = null;
  let curr = resolve(targetPath);
  for (;;) {
    const isRoot = curr === '/' || curr === dirname(curr);
    const hasAdlc = curr !== homeDir && !isRoot && isSymlinkOrDirectory(join(curr, '.adlc'));
    if (hasAdlc) {
      if (existsSync(join(curr, '.git'))) return curr;
      outermost = curr;
    }
    const parent = dirname(curr);
    if (parent === curr) return outermost;
    curr = parent;
  }
}

function hasSymlinkStorePath(repoRoot) {
  for (const rel of ['.adlc', join('.adlc', 'tickets'), join('.adlc', 'tickets.json')]) {
    try {
      const st = lstatSync(join(repoRoot, rel), { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function loadSnapshot(repoRoot) {
  if (hasSymlinkStorePath(repoRoot)) {
    return { ok: false, error: 'UNSAFE_STORE_PATH: symlinked ADLC ticket store path' };
  }
  try {
    return { ok: true, snapshot: ticketsApi.loadTicketSnapshot({ root: repoRoot, env: {} }) };
  } catch (err) {
    if (err?.code === 'STORE_NOT_FOUND') return { ok: true, snapshot: null };
    return { ok: false, error: `${err?.code ?? 'ERROR'}: ${err?.message ?? String(err)}` };
  }
}

/**
 * Union of `rails` across every active ticket in `repoRoot`'s store.
 *   { ok: true, adlc, hasActiveTickets, rails }   rails sorted and de-duplicated
 *   { ok: false, error, railsPresent: true }       store unreadable or corrupt
 */
export function unionActiveRails(repoRoot) {
  const adlcSt = lstatSync(join(repoRoot, '.adlc'), { throwIfNoEntry: false });
  if (!adlcSt) {
    return { ok: true, adlc: false, hasActiveTickets: false, rails: [] };
  }
  const loaded = loadSnapshot(repoRoot);
  if (!loaded.ok) return { ok: false, error: loaded.error, railsPresent: true };
  const active = (loaded.snapshot?.tickets ?? []).filter(isActiveTicket);
  const rails = new Set();
  for (const ticket of active) {
    for (const rail of ticket.rails ?? []) {
      if (typeof rail === 'string' && rail.length > 0) rails.add(rail);
    }
  }
  return { ok: true, adlc: true, hasActiveTickets: active.length > 0, rails: [...rails].sort() };
}

/** Look a ticket up by its `id` field (shards are `<id>--<hash>.json`). */
export function resolveTicket(repoRoot, id) {
  const loaded = loadSnapshot(repoRoot);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const ticket = loaded.snapshot?.get(id);
  if (!ticket) return { ok: false, error: `ticket not found: ${id}` };
  return { ok: true, ticket };
}

export const loadActiveRails = unionActiveRails;
