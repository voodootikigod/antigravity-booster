// Git worktree lifecycle per ~/.claude/rules/common/worktrees.md:
// worktrees live in .worktrees/ inside the repo, one branch per ticket,
// .worktrees/ must be gitignored, sequential merges with rebase-first.

import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, appendFileSync, writeFileSync, openSync, closeSync,
  writeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, chmodSync, readdirSync, rmSync, rmdirSync,
  symlinkSync, readlinkSync, cpSync, lstatSync, realpathSync
} from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import crypto from 'node:crypto';
import { sanitizedGitEnv } from './run-integrity.mjs';

function getProcessStartTime(pid) {
  if (!pid || typeof pid !== 'number') return null;
  try {
    if (process.platform === 'linux') {
      const content = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = content.lastIndexOf(')');
      if (closeParen !== -1) {
        const rest = content.slice(closeParen + 2).trim().split(/\s+/);
        return rest[19] ?? null;
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
    } else if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      return out || null;
    }
  } catch {}
  return null;
}

function isProcessAlive(pid, expectedStartTime = null) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (expectedStartTime) {
    const curStart = getProcessStartTime(pid);
    if (!curStart || curStart !== expectedStartTime) {
      return false;
    }
  }
  return true;
}

const NULL_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

function git(repo, ...args) {
  return execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedGitEnv() });
}

/** Ensure .worktrees/ and .booster/ are gitignored, committed (append once). Returns true if modified. */
export function ensureGitignore(repo) {
  const path = join(repo, '.gitignore');
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Security violation: .gitignore is a symbolic link: ${path}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = current.split('\n');
  // .adlc/* (except the tracked ticket contract — the directory store's
  // shards, the archive, and specs, per the
  // canonical stanza `adlc ticket store migrate` and the plugin's adlc-init
  // both write) covers gate-manifest's append-only evidence file
  // (lib/scheduler.mjs's recordGate) and any other runtime ADLC state —
  // without this, writing gate evidence into an arbitrary target repo
  // mid-run would make isDirty(repo) see it as uncommitted, tripping the
  // dirty-tree guard on a run that otherwise succeeded (this repo's own
  // .gitignore already does the same).
  const missing = [
    '.worktrees/', '.booster/', '.adlc/*',
    '!.adlc/tickets/', '!.adlc/tickets/**',
    '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**',
    '!.adlc/specs/', '!.adlc/config.json',
  ].filter((l) => !lines.includes(l));
  if (!missing.length) return false;
  appendFileSync(path, (current.endsWith('\n') || current === '' ? '' : '\n') + missing.join('\n') + '\n');
  git(repo, 'add', '.gitignore');
  try {
    git(repo, 'commit', '--no-gpg-sign', '-q', '-m', 'chore: gitignore agb working dirs', '--', '.gitignore');
  } catch {
    git(
      repo,
      '-c', 'user.name=agb',
      '-c', 'user.email=agb@local',
      'commit', '--no-gpg-sign', '-q', '-m', 'chore: gitignore agb working dirs', '--', '.gitignore'
    );
  }
  return true;
}

/** True if the repo has uncommitted changes (tracked, staged, or untracked), excluding generated ticket store projections. */
export function isDirty(repo) {
  const status = git(repo, '--no-optional-locks', 'status', '--porcelain', '-u');
  if (!status.trim()) return false;
  const lines = status.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1);
    }
    // Ignore orchestrator-authored ticket store projections
    if (file === '.adlc/tickets' || file.startsWith('.adlc/tickets/')) {
      continue;
    }
    // Ignore CodeGraph index metadata (e.g., untracked .codegraph/.gitignore from `codegraph init`)
    if (file === '.codegraph' || file.startsWith('.codegraph/')) {
      continue;
    }
    return true;
  }
  return false;
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
const SAFE_TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Validate that the repository's .worktrees directory is not a symlink and resides strictly
 * inside the repository root, preventing external directory deletion or traversal.
 */
export function validateWorktreeRoot(repo) {
  let canonicalRepo;
  try {
    canonicalRepo = realpathSync(repo);
  } catch {
    canonicalRepo = resolve(repo);
  }
  const worktreeDir = join(repo, '.worktrees');
  if (existsSync(worktreeDir)) {
    const st = lstatSync(worktreeDir);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: .worktrees directory is a symbolic link: ${worktreeDir}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Security violation: .worktrees is not a directory: ${worktreeDir}`);
    }
    let realWorktreeDir;
    try {
      realWorktreeDir = realpathSync(worktreeDir);
    } catch {
      realWorktreeDir = worktreeDir;
    }
    const rel = relative(canonicalRepo, realWorktreeDir);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Security violation: .worktrees directory escapes repository root: ${worktreeDir}`);
    }
    return realWorktreeDir;
  }
  return worktreeDir;
}

function assertSafeRescueLocksDir(repo, { create = false } = {}) {
  const rawResolved = resolve(repo);
  const rawBooster = join(rawResolved, '.booster');
  const rawLocks = join(rawBooster, 'rescue-locks');
  for (const p of [rawBooster, rawLocks]) {
    try {
      if (lstatSync(p).isSymbolicLink()) {
        throw new Error(`Security violation: symbolic link in rescue-locks path: ${p}`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
  }

  let canonicalRepo;
  try {
    canonicalRepo = realpathSync(rawResolved);
  } catch {
    canonicalRepo = rawResolved;
  }

  const boosterDir = join(canonicalRepo, '.booster');
  if (existsSync(boosterDir)) {
    const bSt = lstatSync(boosterDir);
    if (bSt.isSymbolicLink()) {
      throw new Error(`Security violation: .booster directory is a symbolic link: ${boosterDir}`);
    }
    if (!bSt.isDirectory()) {
      throw new Error(`Security violation: .booster is not a directory: ${boosterDir}`);
    }
  } else if (!create) {
    return { canonicalRepo, locksDir: join(boosterDir, 'rescue-locks'), exists: false };
  } else {
    mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
  }

  if (create && process.platform !== 'win32') {
    try { chmodSync(boosterDir, 0o700); } catch {}
  }

  const locksDir = join(boosterDir, 'rescue-locks');
  if (existsSync(locksDir)) {
    const lSt = lstatSync(locksDir);
    if (lSt.isSymbolicLink()) {
      throw new Error(`Security violation: .booster/rescue-locks is a symbolic link: ${locksDir}`);
    }
    if (!lSt.isDirectory()) {
      throw new Error(`Security violation: .booster/rescue-locks is not a directory: ${locksDir}`);
    }
  } else if (!create) {
    return { canonicalRepo, locksDir, exists: false };
  } else {
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  }

  if (create && process.platform !== 'win32') {
    try { chmodSync(locksDir, 0o700); } catch {}
  }

  const postSt = lstatSync(locksDir);
  if (postSt.isSymbolicLink() || !postSt.isDirectory()) {
    throw new Error(`Security violation: .booster/rescue-locks must be a regular directory: ${locksDir}`);
  }
  const realLocks = realpathSync(locksDir);
  const rel = relative(canonicalRepo, realLocks);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Security violation: .booster/rescue-locks escapes repository root: ${locksDir}`);
  }

  return { canonicalRepo, locksDir, exists: true };
}

export function writeRescueWorktreeLock(repo, ticketId, { state = 'active', runId = null } = {}) {
  if (!ticketId || typeof ticketId !== 'string' || !SAFE_TICKET_ID_RE.test(ticketId)) {
    throw new Error(`invalid ticket id '${ticketId}' — must match ${SAFE_TICKET_ID_RE}`);
  }
  const { locksDir } = assertSafeRescueLocksDir(repo, { create: true });
  const lockPath = join(locksDir, `${ticketId.toLowerCase()}.json`);
  try {
    if (lstatSync(lockPath).isSymbolicLink()) {
      throw new Error(`Security violation: rescue lock file is a symbolic link: ${lockPath}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const payload = JSON.stringify(
    {
      ticketId,
      state,
      pid: process.pid,
      startTime: getProcessStartTime(process.pid),
      runId,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n';

  const tmpPath = `${lockPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmpPath, payload, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      try { chmodSync(tmpPath, 0o600); } catch {}
    }
    renameSync(tmpPath, lockPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  }
  return lockPath;
}

export function hasProtectedRescueWorktree(repo, ticketId) {
  if (!ticketId || typeof ticketId !== 'string' || !SAFE_TICKET_ID_RE.test(ticketId)) {
    throw new Error(`invalid ticket id '${ticketId}' — must match ${SAFE_TICKET_ID_RE}`);
  }
  const { locksDir, exists } = assertSafeRescueLocksDir(repo, { create: false });
  if (!exists) return false;

  const lockPath = join(locksDir, `${ticketId.toLowerCase()}.json`);
  let st;
  try {
    st = lstatSync(lockPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Security violation: rescue lock file is a symbolic link: ${lockPath}`);
  }
  if (!st.isFile()) return true;

  let data;
  try {
    data = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return true;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return true;
  }

  if (data.state === 'preserved') return true;
  if (isProcessAlive(data.pid, data.startTime ?? null)) return true;
  if (existsSync(join(repo, '.worktrees', `agb-${ticketId.toLowerCase()}`))) return true;
  return false;
}

export function clearRescueWorktreeLock(repo, ticketId) {
  if (!ticketId || typeof ticketId !== 'string' || !SAFE_TICKET_ID_RE.test(ticketId)) {
    throw new Error(`invalid ticket id '${ticketId}' — must match ${SAFE_TICKET_ID_RE}`);
  }
  const { locksDir, exists } = assertSafeRescueLocksDir(repo, { create: false });
  if (!exists) return false;

  const lockPath = join(locksDir, `${ticketId.toLowerCase()}.json`);
  try {
    const st = lstatSync(lockPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: rescue lock file is a symbolic link: ${lockPath}`);
    }
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export function createWorktree(repo, ticketId, base = 'main', { allowResetRescue = false } = {}) {
  if (!ticketId || typeof ticketId !== 'string' || !SAFE_TICKET_ID_RE.test(ticketId)) {
    throw new Error(`invalid ticket id '${ticketId}' — must match ${SAFE_TICKET_ID_RE}`);
  }
  validateWorktreeRoot(repo);
  if (!allowResetRescue && hasProtectedRescueWorktree(repo, ticketId)) {
    throw new Error(`Refusing to clobber active or preserved rescue worktree for ticket ${ticketId}`);
  }
  const name = `agb-${ticketId.toLowerCase()}`;
  const branch = `agb/${ticketId.toLowerCase()}`;
  const path = join(repo, '.worktrees', name);
  // Drop any dangling worktree + branch from an earlier run with this id.
  try { git(repo, 'worktree', 'remove', '--force', path); } catch { /* none */ }
  try { rmSync(path, { recursive: true, force: true }); } catch {}
  try { git(repo, 'worktree', 'prune'); } catch {}
  try { git(repo, 'branch', '-D', branch); } catch { /* none */ }
  const attemptGitDir = join(repo, '.worktrees', '.attempt_git', name);
  if (existsSync(attemptGitDir)) {
    let canonicalRepo;
    try { canonicalRepo = realpathSync(repo); } catch { canonicalRepo = resolve(repo); }
    let realAttempt;
    try { realAttempt = realpathSync(attemptGitDir); } catch { realAttempt = attemptGitDir; }
    const rel = relative(canonicalRepo, realAttempt);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Security violation: attempt gitdir escapes repository root: ${attemptGitDir}`);
    }
    const st = lstatSync(attemptGitDir);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: attempt gitdir is a symbolic link: ${attemptGitDir}`);
    }
    try { rmSync(attemptGitDir, { recursive: true, force: true }); } catch {}
  }
  git(repo, 'worktree', 'add', path, '-b', branch, base);
  return path;
}

/** Delete a ticket branch (after merge/cleanup). Best-effort. */
export function deleteBranch(repo, ticketId) {
  if (!ticketId || typeof ticketId !== 'string' || !SAFE_TICKET_ID_RE.test(ticketId)) return;
  try { git(repo, 'branch', '-D', `agb/${ticketId.toLowerCase()}`); } catch { /* gone */ }
}

export function removeWorktree(repo, path, { force = false } = {}) {
  validateWorktreeRoot(repo);
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  git(repo, ...args);
  const attemptGitDir = join(repo, '.worktrees', '.attempt_git', basename(path));
  if (existsSync(attemptGitDir)) {
    let canonicalRepo;
    try { canonicalRepo = realpathSync(repo); } catch { canonicalRepo = resolve(repo); }
    let realAttempt;
    try { realAttempt = realpathSync(attemptGitDir); } catch { realAttempt = attemptGitDir; }
    const rel = relative(canonicalRepo, realAttempt);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Security violation: attempt gitdir escapes repository root: ${attemptGitDir}`);
    }
    const st = lstatSync(attemptGitDir);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: attempt gitdir is a symbolic link: ${attemptGitDir}`);
    }
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
 * merge) and the ADLC ticket-store projection (.adlc/tickets/
 * shards, materialized by the scheduler for the plugin's
 * rail hook). Committing the projection would (a) flag it out-of-scope and
 * burn a strike on the orchestrator's own artifact, and (b) delete it on
 * resetToBase, leaving the next strike without live rail enforcement —
 * left untracked, it survives the reset instead.
 * Returns true if a commit was made.
 */
export function commitAll(worktree, message) {
  git(worktree, 'add', '-A', '--',
    ':(exclude)AGENTS.md', ':(exclude).adlc/tickets',
    ':(exclude).agb_home', ':(exclude).agb_home/**');
  const staged = git(worktree, 'diff', '--cached', '--name-only');
  if (!staged.trim()) return false;
  git(worktree, 'commit', '--no-verify', '--no-gpg-sign', '-q', '-m', message);
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
export function discardProjection(worktree, base = 'HEAD') {
  for (const p of ['AGENTS.md', '.adlc/tickets']) {
    try { git(worktree, 'checkout', base, '--', p); } catch {
      try { git(worktree, 'checkout', 'HEAD', '--', p); } catch { /* not tracked in this repo */ }
    }
    try { git(worktree, 'clean', '-fd', '--', p); } catch {}
  }
  try { rmSync(join(worktree, '.agb_home'), { recursive: true, force: true }); } catch {}
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
/**
 * Remove an empty `node_modules` directory left behind by Linux `bwrap` bind-mount
 * creation (`runGates` mounts host `node_modules` onto `<worktree>/node_modules`).
 * `git clean -fd` skips gitignored directories unless `-x` is passed, and an empty
 * directory can shadow parent `node_modules` resolution or cause `!existsSync` checks
 * to skip symlink creation.
 */
export function cleanEmptyNodeModules(worktree) {
  const nm = join(worktree, 'node_modules');
  try {
    const st = lstatSync(nm);
    if (st.isDirectory() && !st.isSymbolicLink() && readdirSync(nm).length === 0) {
      rmdirSync(nm);
    }
  } catch {}
}

/**
 * Materialize `<worktreePath>/node_modules` from `<sourceNodeModules>` while preserving
 * relative workspace symlinks (e.g. `node_modules/@scope/pkg -> ../../packages/pkg` and
 * `node_modules/.bin/*`) so Node's ESM/CJS realpath resolution imports packages from
 * `<worktreePath>/packages/*` rather than escaping back to the parent repository.
 * Returns true when `<worktreePath>/node_modules` was created by this call.
 */
export function materializeWorktreeNodeModules(worktreePath, sourceNodeModules) {
  if (!worktreePath || !sourceNodeModules || !existsSync(sourceNodeModules)) return false;
  cleanEmptyNodeModules(worktreePath);
  const targetModules = join(worktreePath, 'node_modules');
  try {
    lstatSync(targetModules);
    return false;
  } catch {}
  let realSource;
  try {
    realSource = realpathSync(sourceNodeModules);
  } catch {
    return false;
  }
  const sourceRepoRoot = dirname(realSource);
  const linkItem = (srcItem, dstItem) => {
    const st = lstatSync(srcItem);
    if (st.isSymbolicLink()) {
      const rawLink = readlinkSync(srcItem);
      if (!isAbsolute(rawLink)) {
        const resolvedInSource = resolve(dirname(srcItem), rawLink);
        if (resolvedInSource.startsWith(realSource + sep)) {
          symlinkSync(rawLink, dstItem);
          return;
        }
        if (resolvedInSource.startsWith(sourceRepoRoot + sep) && existsSync(resolve(dirname(dstItem), rawLink))) {
          symlinkSync(rawLink, dstItem);
          return;
        }
        symlinkSync(resolvedInSource, dstItem, 'junction');
        return;
      }
      symlinkSync(rawLink, dstItem);
      return;
    }
    symlinkSync(srcItem, dstItem, st.isDirectory() ? 'junction' : 'file');
  };
  try {
    mkdirSync(targetModules, { recursive: true });
    writeFileSync(join(targetModules, '.agb-materialized'), '');
    for (const name of readdirSync(realSource)) {
      if (name === '.agb-materialized') continue;
      const srcEntry = join(realSource, name);
      const dstEntry = join(targetModules, name);
      const st = lstatSync(srcEntry);
      if ((name === '.bin' || name.startsWith('@')) && st.isDirectory() && !st.isSymbolicLink()) {
        mkdirSync(dstEntry, { recursive: true });
        for (const sub of readdirSync(srcEntry)) {
          linkItem(join(srcEntry, sub), join(dstEntry, sub));
        }
      } else {
        linkItem(srcEntry, dstEntry);
      }
    }
    return true;
  } catch {
    try { rmSync(targetModules, { recursive: true, force: true }); } catch {}
    return false;
  }
}

/**
 * Remove `<worktreePath>/node_modules` only if it carries the `.agb-materialized` sentinel.
 */
export function removeMaterializedNodeModules(worktreePath) {
  if (!worktreePath) return;
  const nm = join(worktreePath, 'node_modules');
  try {
    const st = lstatSync(nm);
    if (st.isDirectory() && !st.isSymbolicLink() && existsSync(join(nm, '.agb-materialized'))) {
      rmSync(nm, { recursive: true, force: true });
    }
  } catch {}
}

export function resetToBase(worktree, base = 'main') {
  git(worktree, 'reset', '--hard', base);
  try {
    git(worktree, 'clean', '-fd', '-e', '.git', '-e', 'AGENTS.md', '-e', '.adlc', '-e', '.adlc/**', '-e', '.agb_home', '-e', '.agb_home/**');
  } catch {}
  cleanEmptyNodeModules(worktree);
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
  validateWorktreeRoot(repo);
  const name = `agb-integration-${token.slice(0, 8)}`;
  const path = join(repo, '.worktrees', name);
  try { git(repo, 'worktree', 'remove', '--force', path); } catch { /* ignore */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(repo, '.worktrees'), { recursive: true });
  validateWorktreeRoot(repo);
  try {
    const baseSha = git(repo, 'rev-parse', '--verify', `${base}^{commit}`).trim();
    git(repo, 'clone', '--shared', '--no-tags', '--no-checkout', repo, path);
    git(path, 'checkout', '--detach', baseSha);
  } catch {
    git(repo, 'worktree', 'add', '--detach', path, base);
  }
  try {
    const dotGit = join(path, '.git');
    if (existsSync(dotGit) && lstatSync(dotGit).isDirectory()) {
      git(path, 'config', 'commit.gpgsign', 'false');
      git(path, 'config', 'core.hooksPath', NULL_HOOKS_PATH);
      git(path, 'config', 'user.name', 'agb-integrator');
      git(path, 'config', 'user.email', 'agb@local');
    }
  } catch {}
  const repoModules = join(repo, 'node_modules');
  const targetModules = join(path, 'node_modules');
  if (existsSync(repoModules) && !existsSync(targetModules)) {
    if (!materializeWorktreeNodeModules(path, repoModules)) {
      try {
        symlinkSync(repoModules, targetModules, 'junction');
      } catch {
        try {
          cpSync(repoModules, targetModules, { recursive: true });
        } catch {}
      }
    }
  }
  return path;
}

/**
 * Remove any orphaned .worktrees/agb-integration-* worktrees.
 */
export function reapIntegrationWorktrees(repo) {
  validateWorktreeRoot(repo);
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

/**
 * Incrementally sync the repository's `.codegraph` index when present.
 * Degrades cleanly to `{ ok: false, skipped?, error }` without ever throwing.
 */
export function syncCodegraphIndex(
  rootRepo,
  { codegraphBin = 'codegraph', timeoutMs = 15_000, enabled } = {}
) {
  if (enabled === false || process.env.AGB_CODEGRAPH === '0') {
    return { ok: false, skipped: true, error: 'codegraph disabled' };
  }
  if (!rootRepo || typeof rootRepo !== 'string') {
    return { ok: false, skipped: true, error: 'invalid rootRepo' };
  }
  const resolvedRoot = resolve(rootRepo);
  const cgDir = join(resolvedRoot, '.codegraph');
  try {
    if (!existsSync(cgDir)) {
      return { ok: false, skipped: true, error: 'no .codegraph index' };
    }
    const st = lstatSync(cgDir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, skipped: true, error: '.codegraph is not a regular directory' };
    }
  } catch (err) {
    return { ok: false, skipped: true, error: err?.message || String(err) };
  }

  try {
    const stdout = execFileSync(codegraphBin, ['sync', resolvedRoot], {
      cwd: resolvedRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, skipped: false, stdout: String(stdout || '').trim() };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    return {
      ok: false,
      skipped: false,
      error: stderr || err?.message || String(err),
    };
  }
}
