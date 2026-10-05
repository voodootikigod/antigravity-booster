// Fail-closed reader for the ADLC ticket store's active rails.
//
// Shared by the in-session PreToolUse policy guard (hooks/pre-tool-use.mjs)
// and the scheduler's enforcement gate (spec .adlc/specs/native-plugin-
// installation.md §4.2/§4.3, Appendix A E1). Every function here returns a
// result object and never throws: a store that cannot be read is reported as
// { ok: false, railsPresent: true } so the CALLER fails closed.
import { existsSync, statSync } from 'node:fs';
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
 * yet (new files).
 *
 * Inside a git repository the root is the git top level, and the repository
 * is ADLC only when that top level holds `.adlc/`: a decoy `.adlc/` planted
 * deeper in the tree can never re-root the rails (P5 prosecution C1). Outside
 * git, the nearest `.adlc/` ancestor counts, except the home directory and
 * the filesystem root, which hold global ADLC state (~/.adlc), not a repo.
 */
export function findAdlcRoot(targetPath, { home = homedir() } = {}) {
  const gitTop = findGitTop(targetPath);
  if (gitTop) return isDirectory(join(gitTop, '.adlc')) ? gitTop : null;
  const homeDir = resolve(home);
  return walkUp(targetPath, (dir) => dir !== homeDir && dir !== '/' && isDirectory(join(dir, '.adlc')));
}

function loadSnapshot(repoRoot) {
  try {
    return { ok: true, snapshot: ticketsApi.loadTicketSnapshot({ root: repoRoot }) };
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
  if (!existsSync(join(repoRoot, '.adlc'))) {
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
