// Repository-level run lock (adversarial-review): two concurrent
// `agb run`/`agb sweep` on the same repo would interleave merges and
// `git reset --hard` reverts, corrupting state.
//
// Mechanism: an atomic mkdir as the lock primitive. mkdir either creates the
// directory or fails with EEXIST — there is no read-then-act window and no
// path where one process deletes another's lock by content guess. The dir
// holds a meta file with our pid + an unguessable token, and post-acquire we
// re-confirm our token owns the meta.
//
// Stale-lock reclaim (issue #54, fixed): a lock whose holder pid is dead is
// reclaimed under a SEPARATE atomic mutex, mkdir of `run.lock.d.reclaim`.
// Only the process that creates that mutex may delete the canonical lock dir,
// and it first re-reads the meta while holding the mutex: it deletes only if
// the token is still the dead snapshot it read and that pid is still dead.
// The canonical dir is never moved aside, so it disappears only after a
// holder confirmed dead under the mutex is deleted; a reclaimer whose read of
// the stale holder was late sees the new token on re-read and aborts. The
// mutex is removed in a finally. A caller that finds the mutex present (EEXIST)
// fails with "being reclaimed" rather than waiting or stealing it.
//
// Liveness caveat: a reclaimer killed while holding the mutex (between its
// mkdir and the finally) leaves `run.lock.d.reclaim` behind. Every later
// reclaim then fails safe with the "being reclaimed ... remove <dir>" error
// until an operator removes that dir. Mutual exclusion is never lost; only
// automatic reclaim stops.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// Residual note: this is a best-effort file-based lock with no lease or
// heartbeat. Callers should still call release.assertStillHeld() immediately
// before anything destructive, so a lock removed out from under a run (e.g. an
// operator deleting it by hand) turns into a failed run rather than a
// corrupted checkout.

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
    // holder.pid is positively dead. Reclaim under a separate atomic mutex
    // (mkdir of run.lock.d.reclaim) and re-verify the snapshot while holding
    // it. The canonical lock dir is never moved, so it only disappears after a
    // holder confirmed dead under the mutex is deleted; a reclaimer that read
    // the stale holder late sees the new token and aborts (issue #54).
    const reclaimDir = `${lockDir}.reclaim`;
    try { mkdirSync(reclaimDir); } catch (err) {
      if (err.code === 'EEXIST') {
        throw new Error(`lock on ${repo} is being reclaimed by another run — retry ` +
          `(remove ${reclaimDir} if no reclaim is in progress)`);
      }
      throw err;
    }
    try {
      const again = readMeta(metaPath);
      if (!again || again.token !== holder.token || isAlive(again.pid)) {
        throw new Error(`lock on ${repo} was reclaimed by another run — retry`);
      }
      rmSync(lockDir, { recursive: true, force: true });
    } finally {
      rmSync(reclaimDir, { recursive: true, force: true });
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

  // The confirmation above is a point-in-time read, not a standing claim: if
  // the lock is removed or replaced afterwards (manual removal of a lock
  // believed stale, a pid-reuse misjudgement) we would never notice. Call this
  // immediately before anything destructive so a robbed run aborts loudly
  // instead of reverting a repo it no longer owns.
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
