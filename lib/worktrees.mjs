// Git worktree lifecycle per ~/.claude/rules/common/worktrees.md:
// worktrees live in .worktrees/ inside the repo, one branch per ticket,
// .worktrees/ must be gitignored, sequential merges with rebase-first.

import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, appendFileSync, writeFileSync, openSync, closeSync,
  writeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, readdirSync, rmSync,
  symlinkSync, cpSync, lstatSync, realpathSync
} from 'node:fs';
import { join, basename } from 'node:path';
import crypto from 'node:crypto';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ensure .worktrees/ and .booster/ are gitignored, committed (append once). */
export function ensureGitignore(repo) {
  const path = join(repo, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = current.split('\n');
  // .adlc/* (except the tracked ticket contract — the directory store's
  // shards, the archive, specs, and the legacy tickets.json bridge, per the
  // canonical stanza `adlc ticket store migrate` and the plugin's adlc-init
  // both write) covers gate-manifest's append-only evidence file
  // (lib/scheduler.mjs's recordGate) and any other runtime ADLC state —
  // without this, writing gate evidence into an arbitrary target repo
  // mid-run would make isDirty(repo) see it as uncommitted, tripping the
  // dirty-tree guard on a run that otherwise succeeded (this repo's own
  // .gitignore already does the same).
  const missing = [
    '.worktrees/', '.booster/', '.adlc/*',
    '!.adlc/tickets.json', '!.adlc/tickets/', '!.adlc/tickets/**',
    '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**',
    '!.adlc/specs/', '!.adlc/config.json',
  ].filter((l) => !lines.includes(l));
  if (missing.length) {
    appendFileSync(path, (current.endsWith('\n') || current === '' ? '' : '\n') + missing.join('\n') + '\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '--no-gpg-sign', '-q', '-m', 'chore: gitignore agb working dirs', '--', '.gitignore');
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
  const attemptGitDir = join(repo, '.worktrees', '.attempt_git', name);
  if (existsSync(attemptGitDir)) {
    try { rmSync(attemptGitDir, { recursive: true, force: true }); } catch {}
  }
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
  const attemptGitDir = join(repo, '.worktrees', '.attempt_git', basename(path));
  if (existsSync(attemptGitDir)) {
    try { rmSync(attemptGitDir, { recursive: true, force: true }); } catch {}
  }
}

export function pruneWorktrees(repo) {
  git(repo, 'worktree', 'prune');
}

/** Diff of the worktree's branch against base (committed work only). */
export function branchDiff(worktree, base = 'main') {
  return git(worktree, 'diff', `${base}...HEAD`);
}

/**
 * Commit everything in the worktree except orchestrator-authored files:
 * AGENTS.md (the per-ticket charter — committing it would conflict on every
 * merge) and the ADLC ticket-store projection (.adlc/tickets.json or
 * .adlc/tickets/ shards, materialized by the scheduler for the plugin's
 * rail hook). Committing the projection would (a) flag it out-of-scope and
 * burn a strike on the orchestrator's own artifact, and (b) delete it on
 * resetToBase, leaving the next strike without live rail enforcement —
 * left untracked, it survives the reset instead.
 * Returns true if a commit was made.
 */
export function commitAll(worktree, message) {
  git(worktree, 'add', '-A', '--',
    ':(exclude)AGENTS.md', ':(exclude).adlc/tickets.json', ':(exclude).adlc/tickets');
  const staged = git(worktree, 'diff', '--cached', '--name-only');
  if (!staged.trim()) return false;
  git(worktree, 'commit', '--no-gpg-sign', '-q', '-m', message);
  return true;
}

/**
 * Discard the orchestrator-authored ticket-store projection in a worktree.
 * In a repo whose store is COMMITTED, the single-ticket rail projection
 * rewrites tracked shards (and deletes sibling ones); commitAll excludes
 * those paths, so they'd sit as unstaged tracked changes — and `git rebase`
 * refuses to run on a worktree with unstaged tracked changes, failing the
 * integration of an otherwise-green ticket. Restoring the paths from HEAD
 * before the rebase clears that; purely-untracked projections (repos with
 * no committed store) don't block a rebase and need no cleanup.
 */
export function discardProjection(worktree) {
  for (const p of ['AGENTS.md', '.adlc/tickets', '.adlc/tickets.json']) {
    try { git(worktree, 'checkout', 'HEAD', '--', p); } catch { /* not tracked in this repo */ }
  }
}

/**
 * Sequential integration: rebase the ticket branch on base, then merge
 * --no-ff into base from the main repo. Throws on conflict (caller marks
 * ticket failed-integration; per conventions, conflicts escalate).
 */
export function mergeWorktree(repo, worktree, ticketId, base = 'main') {
  discardProjection(worktree);
  try {
    git(worktree, 'rebase', base);
  } catch (err) {
    git(worktree, 'rebase', '--abort');
    throw new Error(`rebase conflict for ${ticketId}: ${String(err.stderr ?? err.message).slice(-300)}`);
  }
  git(repo, 'merge', '--no-ff', '-m', `merge: ${ticketId} (agb)`, `agb/${ticketId.toLowerCase()}`);
}

/**
 * Hard-reset a worktree branch back to base. Used after a rail/scope strike:
 * the violating commit must not persist into the next strike, or the
 * cumulative diff still names the rail file and strike 2 auto-fails before
 * its own work is evaluated (a paid builder call provably wasted).
 */
export function resetToBase(worktree, base = 'main') {
  git(worktree, 'reset', '--hard', base);
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

export const JOURNAL_PHASES = {
  PREPARED: 'PREPARED',
  GATES_PASSED: 'GATES_PASSED',
  REF_ADVANCED: 'REF_ADVANCED',
  FINALIZED: 'FINALIZED',
};

/**
 * Creates a dedicated disposable integration worktree.
 * Path: .worktrees/agb-integration-${token.slice(0, 8)}
 */
export function createIntegrationWorktree(repo, token, base = 'main') {
  const name = `agb-integration-${token.slice(0, 8)}`;
  const path = join(repo, '.worktrees', name);
  try { git(repo, 'worktree', 'remove', '--force', path); } catch { /* ignore */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(repo, '.worktrees'), { recursive: true });
  try {
    git(repo, 'clone', '--shared', '--no-tags', '-b', base, repo, path);
  } catch {
    git(repo, 'worktree', 'add', '--detach', path, base);
  }
  try {
    git(path, 'config', 'commit.gpgsign', 'false');
    git(path, 'config', 'user.name', 'agb-integrator');
    git(path, 'config', 'user.email', 'agb@local');
  } catch {}
  const repoModules = join(repo, 'node_modules');
  const targetModules = join(path, 'node_modules');
  if (existsSync(repoModules) && !existsSync(targetModules)) {
    try {
      symlinkSync(repoModules, targetModules, 'junction');
    } catch {
      try {
        cpSync(repoModules, targetModules, { recursive: true });
      } catch {}
    }
  }
  return path;
}

/**
 * Remove any orphaned .worktrees/agb-integration-* worktrees.
 */
export function reapIntegrationWorktrees(repo) {
  const dir = join(repo, '.worktrees');
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name.startsWith('agb-integration-')) {
        const full = join(dir, ent.name);
        try { git(repo, 'worktree', 'remove', '--force', full); } catch {}
        try { rmSync(full, { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
  const attemptGitBase = join(dir, '.attempt_git');
  if (existsSync(attemptGitBase)) {
    try {
      const attemptEntries = readdirSync(attemptGitBase, { withFileTypes: true });
      for (const ent of attemptEntries) {
        const correspondingWt = join(dir, ent.name);
        if (!existsSync(correspondingWt)) {
          try { rmSync(join(attemptGitBase, ent.name), { recursive: true, force: true }); } catch {}
        }
      }
      if (readdirSync(attemptGitBase).length === 0) {
        try { rmSync(attemptGitBase, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  }
}

/**
 * Validate that .adlc is a genuine directory within repo, rejecting symlinks and escape attempts.
 */
export function assertSafeAdlcDir(repo) {
  const dir = join(repo, '.adlc');
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`Security error: .adlc directory in ${repo} is a symbolic link`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Invalid .adlc directory in ${repo}: not a directory`);
    }
    const realRepo = realpathSync(repo);
    const realDir = realpathSync(dir);
    if (realDir !== join(realRepo, '.adlc')) {
      throw new Error(`Security error: .adlc directory in ${repo} resolves outside repository`);
    }
    return dir;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return dir;
    }
    throw err;
  }
}

/**
 * Write integration journal using the crash-atomic write protocol:
 * 1. Write to unique temp file with O_WRONLY | O_CREAT | O_EXCL, mode 0o600
 * 2. Write loop with fsyncSync
 * 3. Validate JSON read-back
 * 4. Atomic renameSync to .adlc/integration_journal.json
 * 5. Parent directory fsyncSync on POSIX
 */
export function writeIntegrationJournal(repo, data) {
  const dir = assertSafeAdlcDir(repo);
  mkdirSync(dir, { recursive: true });
  const postSt = lstatSync(dir);
  if (postSt.isSymbolicLink() || !postSt.isDirectory()) {
    throw new Error(`Security error: .adlc directory in ${repo} must be a regular directory`);
  }
  const journalPath = join(dir, 'integration_journal.json');
  if (existsSync(journalPath) && lstatSync(journalPath).isSymbolicLink()) {
    throw new Error(`Security error: journal file in ${repo} is a symbolic link`);
  }

  const payload = JSON.stringify(data, null, 2) + '\n';
  const buf = Buffer.from(payload, 'utf8');

  let fd;
  let tempPath;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tempName = `integration_journal_tmp_${data.ticketId || 't'}_${data.phase || 'p'}_${Date.now()}_${process.pid}_${crypto.randomBytes(6).toString('hex')}.json`;
    tempPath = join(dir, tempName);
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      break;
    } catch (err) {
      if (err.code === 'EEXIST' && attempt < 4) continue;
      throw err;
    }
  }

  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    // Validate read-back before committing
    const verifyContent = readFileSync(tempPath, 'utf8');
    JSON.parse(verifyContent);

    renameSync(tempPath, journalPath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch {}
    throw err;
  }

  // fsync parent directory on POSIX
  if (process.platform !== 'win32') {
    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {}
  }
}

/**
 * Read the active integration journal if present.
 * Returns { ok: true, exists: true, journal } or { ok: false, exists: boolean, corrupted?: boolean, error?: string }.
 */
export function readIntegrationJournal(repo) {
  assertSafeAdlcDir(repo);
  const journalPath = join(repo, '.adlc', 'integration_journal.json');
  if (!existsSync(journalPath)) return { ok: false, exists: false };
  const st = lstatSync(journalPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, exists: true, corrupted: true, error: 'journal file is a symbolic link or not a regular file' };
  }
  try {
    const content = readFileSync(journalPath, 'utf8');
    if (!content.trim()) {
      return { ok: false, exists: true, corrupted: true, error: 'empty journal file' };
    }
    const journal = JSON.parse(content);
    if (!journal.phase || !journal.ticketId || !journal.transactionToken) {
      return { ok: false, exists: true, corrupted: true, error: 'malformed journal schema' };
    }
    return { ok: true, exists: true, journal };
  } catch (err) {
    return { ok: false, exists: true, corrupted: true, error: err.message };
  }
}

/**
 * Quarantine corrupted or conflicting integration journal.
 */
export function quarantineIntegrationJournal(repo, label = 'corrupt') {
  assertSafeAdlcDir(repo);
  const journalPath = join(repo, '.adlc', 'integration_journal.json');
  if (!existsSync(journalPath)) return null;
  const st = lstatSync(journalPath);
  if (st.isSymbolicLink()) {
    try { unlinkSync(journalPath); } catch {}
    return null;
  }
  const targetName = label === 'conflict'
    ? `journal_conflict_${Date.now()}.json`
    : `integration_journal_corrupt_${Date.now()}.json`;
  const targetPath = join(repo, '.adlc', targetName);
  try {
    renameSync(journalPath, targetPath);
    return targetPath;
  } catch {
    return null;
  }
}

/**
 * Unlink active integration journal.
 */
export function unlinkIntegrationJournal(repo) {
  assertSafeAdlcDir(repo);
  const journalPath = join(repo, '.adlc', 'integration_journal.json');
  try {
    const st = lstatSync(journalPath);
    if (!st.isSymbolicLink()) {
      unlinkSync(journalPath);
    }
  } catch {}
}
