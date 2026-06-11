// Git worktree lifecycle per ~/.claude/rules/common/worktrees.md:
// worktrees live in .worktrees/ inside the repo, one branch per ticket,
// .worktrees/ must be gitignored, sequential merges with rebase-first.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ensure .worktrees/ is gitignored (append once). */
export function ensureGitignore(repo) {
  const path = join(repo, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!current.split('\n').includes('.worktrees/')) {
    appendFileSync(path, (current.endsWith('\n') || current === '' ? '' : '\n') + '.worktrees/\n');
  }
}

/** Create a worktree + branch for a ticket. Returns its absolute path. */
export function createWorktree(repo, ticketId, base = 'main') {
  const name = `agb-${ticketId.toLowerCase()}`;
  const path = join(repo, '.worktrees', name);
  git(repo, 'worktree', 'add', path, '-b', `agb/${ticketId.toLowerCase()}`, base);
  return path;
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
