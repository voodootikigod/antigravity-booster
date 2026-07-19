// Repository-level run lock (adversarial-review): two concurrent
// `agb run`/`agb sweep` on the same repo would interleave merges and
// `git reset --hard` reverts, corrupting state.
//
// Mechanism: an atomic mkdir as the lock primitive. mkdir either creates the
// directory or fails with EEXIST — there is no read-then-act window and no
// path where one process deletes another's lock by content guess. The dir
// holds a meta file with our pid + an unguessable token. A stale lock (dead
// pid) is reclaimed by moving the whole dir aside and re-mkdir'ing; the winner
// is decided by mkdir atomicity, and post-acquire we re-confirm our token owns
// the meta.
//
// KNOWN DEFECT (issue #54): that post-acquire confirmation is a point-in-time
// read, not a standing claim, and the reclaim path below moves the lock out of
// its canonical path BEFORE verifying it is still the stale lock it read. While
// it is moved aside the path does not exist, so mkdir exclusion is void and a
// concurrent caller acquires cleanly — two live runs can hold this lock at once.
// Re-verifying immediately before the rename narrows that window but does not
// close it; POSIX has no compare-and-swap on file content, so "move this dir
// only if its meta still says X" is not expressible. Fixing it properly means
// changing the primitive, not patching this path.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
// Residual note: this is a best-effort file-based lock. The two common cases —
// two live runs, and a single reclaimer of a crashed run — are race-free
// (atomic mkdir/EEXIST). Concurrent reclaimers of the same stale lock are NOT;
// see the known defect above. Until the primitive changes, callers must call
// release.assertStillHeld() immediately before anything destructive, which
// turns a stolen lock into a failed run rather than a corrupted checkout.

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
    // holder.pid is positively dead — reclaim via ATOMIC RENAME. renameSync
    // of the lock dir to a unique name is atomic: only one of N concurrent
    // reclaimers succeeds, the rest get ENOENT (someone already moved it).
    // This removes the read-then-delete TOCTOU where two reclaimers could
    // each delete and recreate the dir. The winner deletes the moved-aside
    // dir; everyone then races a fresh mkdir, decided atomically.
    const moved = `${lockDir}.stale.${pid}.${process.hrtime.bigint()}`;
    try {
      renameSync(lockDir, moved);
      // We atomically grabbed *a* dir, but a concurrent reclaimer may have
      // recreated a LIVE lock between our dead-pid read and this rename. Verify
      // what we grabbed is still the dead snapshot; if it is a fresh/live lock,
      // put it back and abort rather than deleting someone else's live lock.
      const grabbed = readMeta(join(moved, 'meta.json'));
      const stillStale = grabbed && grabbed.token === holder.token && !isAlive(grabbed.pid);
      if (!stillStale) {
        try { renameSync(moved, lockDir); } catch { /* the owner may have recreated it; drop ours */ rmSync(moved, { recursive: true, force: true }); }
        throw new Error(`lock on ${repo} was reclaimed by another run — retry`);
      }
      try { rmSync(moved, { recursive: true, force: true }); } catch { /* best effort */ }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // ENOENT: another reclaimer already moved it
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
  const release = () => {
    if (released) return;
    released = true;
    try {
      const holder = readMeta(metaPath);
      if (holder?.token === token) rmSync(lockDir, { recursive: true, force: true });
    } catch { /* already gone */ }
  };

  // The confirmation above is a point-in-time read, not a standing claim: a
  // concurrent reclaim can replace our lock afterwards (issue #54) and we would
  // never notice — the run carries on and reverts a repo it no longer owns.
  // Call this immediately before anything destructive so a robbed run aborts
  // loudly instead. It does not prevent the double-acquire; it bounds the
  // damage to a failed run rather than a corrupted checkout.
  release.assertStillHeld = () => {
    if (released) {
      throw new Error(`no longer hold the lock on ${repo} — it was already released`);
    }
    const current = readMeta(metaPath);
    // An absent lock is lost, never free. Failing open here is precisely what
    // would let a robbed run proceed to `git reset --hard`.
    if (!current) {
      throw new Error(`no longer hold the lock on ${repo} — the lock is gone (removed or reclaimed). ` +
        `Aborting rather than acting on a repo we do not own.`);
    }
    if (current.token !== token) {
      throw new Error(`no longer hold the lock on ${repo} — it is now held by pid ${current.pid ?? '?'} ` +
        `(run ${current.runId ?? '?'}). Aborting rather than acting on a repo we do not own.`);
    }
  };

  return release;
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
