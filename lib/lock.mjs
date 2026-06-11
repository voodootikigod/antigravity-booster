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
    // Stale lock from a dead process — reclaim, but only if the on-disk
    // content STILL matches the dead snapshot we read. Otherwise another
    // process already reclaimed it (its fresh lock would be deleted by a
    // blind unlink — the TOCTOU the reviewer flagged).
    reclaimIfStale(lockPath, holder);
  }

  let fd;
  try {
    // O_EXCL: only one creator wins even under concurrent reclaim.
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      const holder = readLock(lockPath);
      throw new Error(`another agb run acquired the lock on ${repo} (pid ${holder?.pid ?? '?'})`);
    }
    throw err;
  }
  const token = `${pid}:${runId}:${process.hrtime.bigint()}`;
  writeSync(fd, JSON.stringify({ pid, runId, token, startedAt: new Date().toISOString() }));
  closeSync(fd);

  // Confirm we still own it (defence-in-depth against any residual race).
  const confirmed = readLock(lockPath);
  if (confirmed?.token !== token) {
    throw new Error(`lost a lock race on ${repo} — another run holds it (pid ${confirmed?.pid ?? '?'})`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const holder = readLock(lockPath);
      if (holder?.token === token) unlinkSync(lockPath); // only remove OUR lock
    } catch { /* already gone */ }
  };
}

function readLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

/**
 * Remove a stale lock only if its current on-disk identity still equals the
 * dead `snapshot` we read. If another process already replaced it (different
 * pid/startedAt), do nothing — its fresh lock must not be deleted.
 */
function reclaimIfStale(lockPath, snapshot) {
  if (!snapshot) return;
  const current = readLock(lockPath);
  if (!current) return; // already gone
  const sameHolder = current.pid === snapshot.pid && current.startedAt === snapshot.startedAt
    && current.token === snapshot.token;
  if (sameHolder && !isAlive(current.pid)) {
    try { unlinkSync(lockPath); } catch { /* someone else won the unlink — fine */ }
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
