// Repository-level run lock (adversarial-review MEDIUM): two concurrent
// `agb run`/`agb sweep` on the same repo would interleave merges and
// `git reset --hard` reverts, corrupting state. An exclusive lock file
// serializes orchestrator runs per repo.

import { openSync, closeSync, writeSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Acquire an exclusive lock for `repo`. Throws if another live run holds it.
 * Returns a release function. Stale locks (dead PID) are reclaimed.
 */
export function acquireRepoLock(repo, { runId, pid = process.pid } = {}) {
  const lockPath = join(repo, '.booster', 'run.lock');
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    const holder = readLock(lockPath);
    if (holder && isAlive(holder.pid)) {
      throw new Error(`another agb run holds the lock on ${repo} (pid ${holder.pid}, run ${holder.runId}). ` +
        `Wait for it to finish, or remove ${lockPath} if it is stale.`);
    }
    // Stale lock from a dead process — reclaim.
    try { unlinkSync(lockPath); } catch { /* race: someone else reclaimed */ }
  }

  let fd;
  try {
    // O_EXCL: fail if the file appeared between our check and now (TOCTOU-safe).
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      const holder = readLock(lockPath);
      throw new Error(`another agb run acquired the lock on ${repo} (pid ${holder?.pid ?? '?'})`);
    }
    throw err;
  }
  writeSync(fd, JSON.stringify({ pid, runId, startedAt: new Date().toISOString() }));
  closeSync(fd);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const holder = readLock(lockPath);
      if (holder?.pid === pid) unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
}

function readLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
