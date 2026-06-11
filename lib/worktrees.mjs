// Git worktree lifecycle per ~/.claude/rules/common/worktrees.md:
// worktrees live in .worktrees/ inside the repo, one branch per ticket,
// .worktrees/ must be gitignored, sequential merges with rebase-first.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ensure .worktrees/ and .booster/ are gitignored, committed (append once). */
export function ensureGitignore(repo) {
  const path = join(repo, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = current.split('\n');
  const missing = ['.worktrees/', '.booster/'].filter((l) => !lines.includes(l));
  if (missing.length) {
    appendFileSync(path, (current.endsWith('\n') || current === '' ? '' : '\n') + missing.join('\n') + '\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'chore: gitignore agb working dirs', '--', '.gitignore');
  }
}

/** True if the repo has uncommitted changes (tracked or staged). */
export function isDirty(repo) {
  return git(repo, 'status', '--porcelain').trim().length > 0;
}

/** The currently checked-out branch name (or '' in detached HEAD). */
export function currentBranch(repo) {
  return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
}

/**
 * Create a worktree + branch for a ticket. Returns its absolute path.
 * A leftover `agb/<id>` branch from a prior run is removed first so re-runs
 * (and repeated ticket ids) don't crash on "branch already exists".
 */
export function createWorktree(repo, ticketId, base = 'main') {
  const name = `agb-${ticketId.toLowerCase()}`;
  const branch = `agb/${ticketId.toLowerCase()}`;
  const path = join(repo, '.worktrees', name);
  // Drop any dangling worktree + branch from an earlier run with this id.
  try { git(repo, 'worktree', 'remove', '--force', path); } catch { /* none */ }
  try { git(repo, 'branch', '-D', branch); } catch { /* none */ }
  git(repo, 'worktree', 'add', path, '-b', branch, base);
  return path;
}

/** Delete a ticket branch (after merge/cleanup). Best-effort. */
export function deleteBranch(repo, ticketId) {
  try { git(repo, 'branch', '-D', `agb/${ticketId.toLowerCase()}`); } catch { /* gone */ }
}

export function removeWorktree(repo, path, { force = false } = {}) {
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  git(repo, ...args);
}

export function pruneWorktrees(repo) {
  git(repo, 'worktree', 'prune');
}

/** Diff of the worktree's branch against base (committed work only). */
export function branchDiff(worktree, base = 'main') {
  return git(worktree, 'diff', `${base}...HEAD`);
}

/**
 * Commit everything in the worktree except AGENTS.md (the orchestrator's
 * per-ticket charter — committing it would conflict on every merge).
 * Returns true if a commit was made.
 */
export function commitAll(worktree, message) {
  git(worktree, 'add', '-A', '--', ':(exclude)AGENTS.md');
  const staged = git(worktree, 'diff', '--cached', '--name-only');
  if (!staged.trim()) return false;
  git(worktree, 'commit', '-q', '-m', message);
  return true;
}

/**
 * Sequential integration: rebase the ticket branch on base, then merge
 * --no-ff into base from the main repo. Throws on conflict (caller marks
 * ticket failed-integration; per conventions, conflicts escalate).
 */
export function mergeWorktree(repo, worktree, ticketId, base = 'main') {
  try {
    git(worktree, 'rebase', base);
  } catch (err) {
    git(worktree, 'rebase', '--abort');
    throw new Error(`rebase conflict for ${ticketId}: ${String(err.stderr ?? err.message).slice(-300)}`);
  }
  git(repo, 'merge', '--no-ff', '-m', `merge: ${ticketId} (agb)`, `agb/${ticketId.toLowerCase()}`);
}

/** List files changed on the branch vs base. */
export function changedFiles(worktree, base = 'main') {
  return git(worktree, 'diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
}

/** True if the repo is mid-merge (MERGE_HEAD exists). */
export function isMidMerge(repo) {
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD');
    return true;
  } catch {
    return false;
  }
}

/** Abort an in-progress merge if one exists; no-op otherwise. */
export function abortAnyMerge(repo) {
  if (isMidMerge(repo)) git(repo, 'merge', '--abort');
}
