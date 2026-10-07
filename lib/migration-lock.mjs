// User-global migration lock and state primitives for `agb migrate`
// (spec .adlc/specs/native-plugin-installation.md §4.6, Appendix A.4 items
// 21/23/25). Deliberately separate from lib/lock.mjs, which is a frozen rail
// and only handles repository-scoped locks.
//
// The lock is an atomic mkdir of
//   ~/.gemini/antigravity-cli/plugin_data/antigravity-booster/.migration.lock.d/
// holding meta.json { pid, startTime, token, startedAt }. A holder is only
// reclaimed when it is positively dead (ESRCH, or its PID was recycled). A
// live or unverifiable holder is never stolen, and reclaim never removes a
// directory whose token is not the one it inspected (ABA safety).
//
// Error contract: lock operations throw MigrationLockError; callers in
// lib/migrate.mjs turn that into exit 1. Nothing here writes to stdout.
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const MIGRATION_LOCK_DIRNAME = '.migration.lock.d';
export const MIGRATION_STATE_FILENAME = 'migration-state.json';
const DARWIN_START_TOLERANCE_MS = 1000;

export class MigrationLockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MigrationLockError';
    this.code = code;
  }
}

export function boosterDataDir(home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
}

export function migrationLockDir(home = homedir()) {
  return join(boosterDataDir(home), MIGRATION_LOCK_DIRNAME);
}

export function migrationStatePath(home = homedir()) {
  return join(boosterDataDir(home), MIGRATION_STATE_FILENAME);
}

const defaultDeps = () => ({
  platform: process.platform,
  readFile: (p) => readFileSync(p, 'utf8'),
  exec: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  kill: (pid, sig) => process.kill(pid, sig),
});

/**
 * Field 22 (starttime, clock ticks since boot) of a /proc/<pid>/stat line.
 * The comm field (2) may contain spaces and parentheses, so fields are
 * counted from after the LAST ')'. Returns a digit string or null.
 */
export function parseProcStatStartTime(content) {
  if (typeof content !== 'string') return null;
  const lastParen = content.lastIndexOf(')');
  if (lastParen === -1) return null;
  const fields = content.slice(lastParen + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 is index 22 - 3 = 19.
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

/** Linux: field-22 tick string. Darwin: epoch ms. Unreadable/other OS: null. */
export function getProcessStartTime(pid, deps = defaultDeps()) {
  try {
    if (deps.platform === 'linux') return parseProcStatStartTime(deps.readFile(`/proc/${pid}/stat`));
    if (deps.platform === 'darwin') {
      const parsed = Date.parse(String(deps.exec('ps', ['-p', String(pid), '-o', 'lstart=']) ?? '').trim());
      return Number.isFinite(parsed) ? Math.floor(parsed) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True unless the holder is positively dead: ESRCH, or the PID now belongs to
 * a different process (start time differs). EPERM, unreadable start times and
 * holders without a recorded startTime all count as alive (never steal).
 */
export function isAlive(holder, deps = defaultDeps()) {
  if (!holder || typeof holder.pid !== 'number' || !Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  try {
    deps.kill(holder.pid, 0);
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
  const current = getProcessStartTime(holder.pid, deps);
  if (current === null || holder.startTime === undefined || holder.startTime === null) return true;
  if (deps.platform === 'linux') return String(current) === String(holder.startTime);
  const recorded = Number(holder.startTime);
  return Number.isFinite(recorded) && Math.abs(Number(current) - recorded) <= DARWIN_START_TOLERANCE_MS;
}

export function readLockMeta(lockDir) {
  try {
    const meta = JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf8'));
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

function writeMetaAtomic(lockDir, meta) {
  const tmp = join(lockDir, `.meta.${process.pid}.${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(tmp, join(lockDir, 'meta.json'));
}

function newToken(pid) {
  return `${pid}:${Date.now()}:${randomBytes(8).toString('hex')}`;
}

function holderMessage(holder) {
  return `another agb migration holds the lock (pid ${holder?.pid ?? 'unknown'}, started ${holder?.startedAt ?? 'unknown'}). ` +
    'Wait for it to finish, or run `agb migrate --break-lock` if it is wedged.';
}

/**
 * Rename a dead holder's lock aside, then remove it only if it is still the
 * exact holder we judged dead. Anything else is put back (or left alone if a
 * new lock already took its place) — never removed.
 */
function reclaimDeadLock(lockDir, holder, deps) {
  const moved = `${lockDir}.stale.${process.pid}.${process.hrtime.bigint()}`;
  try {
    renameSync(lockDir, moved);
  } catch (err) {
    if (err.code === 'ENOENT') return; // someone else reclaimed it; retry mkdir
    throw err;
  }
  const grabbed = readLockMeta(moved);
  if (grabbed && holder && grabbed.token === holder.token && !isAlive(grabbed, deps)) {
    rmSync(moved, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(moved, lockDir);
  } catch {
    // lockDir was recreated by a live process: leave `moved` in place.
  }
  throw new MigrationLockError(holderMessage(grabbed ?? holder), 'LOCK_HELD');
}

/**
 * Acquire the migration lock. Returns { lockDir, token, home }. Throws
 * MigrationLockError('LOCK_HELD') when a live holder exists.
 */
export function acquireMigrationLock({ home = homedir(), deps = defaultDeps(), maxAttempts = 3 } = {}) {
  const lockDir = migrationLockDir(home);
  mkdirSync(boosterDataDir(home), { recursive: true });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      mkdirSync(lockDir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readLockMeta(lockDir);
      if (holder === null) {
        // A holder between mkdir and its meta write looks like this; so does a
        // crashed one. Never steal it: --break-lock is the manual recovery.
        throw new MigrationLockError(holderMessage(null), 'LOCK_HELD');
      }
      if (isAlive(holder, deps)) throw new MigrationLockError(holderMessage(holder), 'LOCK_HELD');
      reclaimDeadLock(lockDir, holder, deps);
      continue;
    }
    const token = newToken(process.pid);
    writeMetaAtomic(lockDir, {
      pid: process.pid,
      startTime: getProcessStartTime(process.pid, deps),
      token,
      startedAt: new Date().toISOString(),
    });
    return { lockDir, token, home };
  }
  throw new MigrationLockError('could not acquire the migration lock after repeated reclaim attempts; retry', 'LOCK_CONTENDED');
}

/** Standing claim check before every destructive step (§4.6). */
export function assertMigrationLockHeld(handle) {
  const meta = handle?.lockDir ? readLockMeta(handle.lockDir) : null;
  if (!meta || !handle.token || meta.token !== handle.token) {
    throw new MigrationLockError('migration lock lost or replaced; halting before any further change', 'LOCK_LOST');
  }
}

/** Remove the lock only if it still carries our token. */
export function releaseMigrationLock(handle) {
  const meta = handle?.lockDir ? readLockMeta(handle.lockDir) : null;
  if (meta && meta.token === handle.token) {
    rmSync(handle.lockDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

/**
 * Lock handover to the detached uninstaller: the child proves it holds the
 * token and records itself as the holder (same token, its own pid/startTime).
 */
export function adoptMigrationLock({ home = homedir(), token, deps = defaultDeps() } = {}) {
  const lockDir = migrationLockDir(home);
  const meta = readLockMeta(lockDir);
  if (!meta || !token || meta.token !== token) {
    throw new MigrationLockError('handover token does not match the migration lock', 'TOKEN_MISMATCH');
  }
  writeMetaAtomic(lockDir, { ...meta, pid: process.pid, startTime: getProcessStartTime(process.pid, deps), adoptedAt: new Date().toISOString() });
  return { lockDir, token, home };
}

/** Parent-side handover timeout: void the token so a late child cannot act. */
export function invalidateMigrationLockToken(handle) {
  const meta = handle?.lockDir ? readLockMeta(handle.lockDir) : null;
  if (!meta || meta.token !== handle.token) return false;
  writeMetaAtomic(handle.lockDir, { ...meta, token: `invalidated:${meta.token}` });
  return true;
}

/**
 * Operator recovery (A.4 item 25). Reports the holder and whether it looks
 * alive; removes the lock directory when `confirmed`. Never runs a migration.
 */
export function breakMigrationLock({ home = homedir(), confirmed = false, expectToken, deps = defaultDeps() } = {}) {
  const lockDir = migrationLockDir(home);
  if (!existsSync(lockDir)) return { present: false, removed: false, holder: null, alive: false };
  const holder = readLockMeta(lockDir);
  const alive = holder ? isAlive(holder, deps) : false;
  if (!confirmed) return { present: true, removed: false, holder, alive };
  // Only remove the holder the operator was shown (undefined = no preview).
  if (expectToken !== undefined && (holder?.token ?? null) !== expectToken) return { present: true, removed: false, holder, alive };
  rmSync(lockDir, { recursive: true, force: true });
  return { present: true, removed: true, holder, alive };
}

// ---------------------------------------------------------------------------
// migration-state.json (single state file, §4.6)
// ---------------------------------------------------------------------------

export function readMigrationState(home = homedir()) {
  const p = migrationStatePath(home);
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || typeof parsed.state !== 'string') {
    throw new MigrationLockError(`${p} is not a valid migration state file`, 'STATE_CORRUPT');
  }
  return parsed;
}

export function writeMigrationState(home, state) {
  const p = migrationStatePath(home);
  mkdirSync(boosterDataDir(home), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
  return state;
}

export function clearMigrationState(home) {
  rmSync(migrationStatePath(home), { force: true });
}

// ---------------------------------------------------------------------------
// Detached uninstaller (A.4 item 23)
// ---------------------------------------------------------------------------

function removeImportEntry(home, name) {
  const p = join(home, '.gemini', 'config', 'import_manifest.json');
  if (!existsSync(p)) return;
  const m = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(m?.imports)) return;
  const kept = m.imports.filter((e) => e?.name !== name);
  if (kept.length === m.imports.length) return;
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...m, imports: kept }, null, 2) + '\n');
  renameSync(tmp, p);
}

/**
 * Body of `agb migrate --finish-uninstall`. Refuses unless the state is
 * ROLLED_BACK_PENDING_UNINSTALL and `token` matches the lock. Adopts the
 * lock, writes handover.ack, uninstalls booster, sets ROLLED_BACK, releases
 * the lock and removes the uninstaller directory.
 *
 * The uninstaller directory is removed only after a successful adoption and
 * only when it is an `agb-uninstall-*` directory; once it is gone the parent
 * knows the handover happened even if it never saw handover.ack.
 *
 * Returns { ok, error? }. `uninstall` is injectable for tests; the default
 * runs `<agyBin> plugin uninstall antigravity-booster`.
 */
export const UNINSTALLER_DIR_PREFIX = 'agb-uninstall-';

// Only ever delete a directory `agb migrate` itself created for the handover.
function removeUninstallerDir(dir) {
  if (dir && basename(dir).startsWith(UNINSTALLER_DIR_PREFIX)) rmSync(dir, { recursive: true, force: true });
}

export function finishUninstall({ home = homedir(), token, uninstallerDir, agyBin, baseline, deps = defaultDeps(), uninstall } = {}) {
  let handle;
  try {
    const state = readMigrationState(home);
    if (state?.state !== 'ROLLED_BACK_PENDING_UNINSTALL') {
      return { ok: false, error: `refusing --finish-uninstall: state is ${state?.state ?? 'INITIAL'}, not ROLLED_BACK_PENDING_UNINSTALL` };
    }
    // A.4 item 23: the parent names the baseline it restored; it must be this state's baseline.
    if (baseline !== undefined && baseline !== join(state.baselineSnapshotDir ?? '', 'pre-migration.baseline.json')) {
      return { ok: false, error: `refusing --finish-uninstall: --baseline ${baseline} is not this migration's baseline` };
    }
    handle = adoptMigrationLock({ home, token, deps });
    if (uninstallerDir) writeFileSync(join(uninstallerDir, 'handover.ack'), `${process.pid}\n`);
    const pluginDir = join(home, '.gemini', 'config', 'plugins', 'antigravity-booster');
    if (existsSync(pluginDir)) {
      assertMigrationLockHeld(handle);
      const run = uninstall ?? (() => execFileSync(agyBin, ['plugin', 'uninstall', 'antigravity-booster'], {
        stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: home }, timeout: 60_000,
      }));
      try {
        run();
      } catch (err) {
        return { ok: false, error: `agy plugin uninstall antigravity-booster failed: ${err.message}` };
      }
      // agy owns its own bookkeeping; make sure nothing of booster lingers.
      rmSync(pluginDir, { recursive: true, force: true });
    }
    // Always, so a retry after a failed manifest write still cleans the entry.
    removeImportEntry(home, 'antigravity-booster');
    assertMigrationLockHeld(handle);
    writeMigrationState(home, { ...state, state: 'ROLLED_BACK', rolledBackAt: new Date().toISOString() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    // A refused child owns nothing: the parent cleans up on its timeout path.
    if (handle) {
      releaseMigrationLock(handle);
      removeUninstallerDir(uninstallerDir);
    }
  }
}
