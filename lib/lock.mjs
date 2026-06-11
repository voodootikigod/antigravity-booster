// Repository-level run lock (adversarial-review): two concurrent
// `agb run`/`agb sweep` on the same repo would interleave merges and
// `git reset --hard` reverts, corrupting state.
//
// Mechanism: an atomic mkdir as the lock primitive. mkdir either creates the
// directory or fails with EEXIST — there is no read-then-act window and no
// path where one process deletes another's lock by content guess. The dir
// holds a meta file with our pid + an unguessable token. A stale lock (dead
// pid) is reclaimed by removing the whole dir and re-mkdir'ing; the winner is
// decided by mkdir atomicity, and post-acquire we re-confirm our token owns
// the meta, so a lost reclaim race throws instead of double-acquiring.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function acquireRepoLock(repo, { runId, pid = process.pid } = {}) {
  const lockDir = join(repo, '.booster', 'run.lock.d');
  const metaPath = join(lockDir, 'meta.json');
  mkdirSync(join(repo, '.booster'), { recursive: true });
  const token = `${pid}:${runId}:${process.hrtime.bigint()}`;

  const tryCreate = () => {
    try {
      mkdirSync(lockDir); // atomic: throws EEXIST if held
      writeFileSync(metaPath, JSON.stringify({ pid, runId, token, startedAt: new Date().toISOString() }));
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryCreate()) {
    const holder = readMeta(metaPath);
    // Reclaim ONLY when we can positively read a dead pid. An unreadable or
    // missing meta means another process holds the dir and is mid-write
    // (it created the dir but hasn't written meta yet) — deleting it would
    // be the TOCTOU that lets two runs proceed. Treat unknown as live.
    if (!holder || !holder.pid) {
      throw new Error(`the lock on ${repo} is held (meta not yet written by the holder). ` +
        `Retry shortly, or remove ${lockDir} if it is genuinely stale.`);
    }
    if (isAlive(holder.pid)) {
      throw new Error(`another agb run holds the lock on ${repo} (pid ${holder.pid}, run ${holder.runId}). ` +
        `Wait for it to finish, or remove ${lockDir} if it is stale.`);
    }
    // holder.pid is positively dead — reclaim, but only if the dir STILL
    // holds that exact dead snapshot. If a concurrent reclaimer already
    // replaced it (different token), skip the delete so we don't remove its
    // fresh lock; our tryCreate then fails and we throw.
    const current = readMeta(metaPath);
    if (current?.token === holder.token && !isAlive(current.pid)) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced */ }
    }
    if (!tryCreate()) {
      const h = readMeta(metaPath);
      throw new Error(`lost a lock reclaim race on ${repo} (pid ${h?.pid ?? '?'})`);
    }
  }

  // Confirm our token is the one on disk (defence against a reclaim race
  // where another process recreated the dir between our mkdir and write).
  const confirmed = readMeta(metaPath);
  if (confirmed?.token !== token) {
    throw new Error(`lost a lock race on ${repo} — another run holds it (pid ${confirmed?.pid ?? '?'})`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const holder = readMeta(metaPath);
      if (holder?.token === token) rmSync(lockDir, { recursive: true, force: true });
    } catch { /* already gone */ }
  };
}

function readMeta(metaPath) {
  try {
    if (!existsSync(metaPath)) return null;
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
