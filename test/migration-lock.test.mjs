// T-PLUGIN-04: lib/migration-lock.mjs — the user-global migration lock
// (§4.6, Appendix A.4 items 21/23/25). Every case uses a temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import {
  parseProcStatStartTime, getProcessStartTime, isAlive, acquireMigrationLock, assertMigrationLockHeld,
  releaseMigrationLock, adoptMigrationLock, invalidateMigrationLockToken, breakMigrationLock,
  migrationLockDir, readLockMeta, readMigrationState, writeMigrationState, finishUninstall,
  MigrationLockError, boosterDataDir,
} from '../lib/migration-lock.mjs';

const LOCK_URL = new URL('../lib/migration-lock.mjs', import.meta.url).href;

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'agb-miglock-'));
}

function plantLock(home, meta) {
  const dir = migrationLockDir(home);
  mkdirSync(dir, { recursive: true });
  if (meta !== undefined) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

const esrch = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };

// ---------------------------------------------------------------------------
// /proc/<pid>/stat parsing and liveness
// ---------------------------------------------------------------------------

test('proc stat field 22 is read after the LAST ")" even when comm has spaces and parens', () => {
  const after = ['S', '1', '12345', '12345', '0', '-1', '4194560', '100', '0', '0', '0', '5', '3', '0', '0', '20', '0', '1', '0', '2910384', '1000'];
  const line = `12345 (bash (subshell)) ${after.join(' ')}`;
  assert.equal(parseProcStatStartTime(line), '2910384');
  assert.equal(parseProcStatStartTime('12345 (a) b) S 1'), null, 'too few fields → null');
  assert.equal(parseProcStatStartTime('no paren here'), null);
  assert.equal(parseProcStatStartTime(`1 (x) ${after.slice(0, 19).join(' ')} notanumber`), null);
  assert.equal(parseProcStatStartTime(undefined), null);
});

test('getProcessStartTime: linux reads /proc, darwin parses ps lstart, others and errors → null', () => {
  const stat = `7 (x) ${Array.from({ length: 19 }, () => '0').join(' ')} 4242 9`;
  assert.equal(getProcessStartTime(7, { platform: 'linux', readFile: (p) => { assert.equal(p, '/proc/7/stat'); return stat; } }), '4242');
  const lstart = 'Wed Oct  7 12:00:00 2026';
  assert.equal(getProcessStartTime(7, { platform: 'darwin', exec: (c, a) => { assert.deepEqual([c, a], ['ps', ['-p', '7', '-o', 'lstart=']]); return `${lstart}\n`; } }), Math.floor(Date.parse(lstart)));
  assert.equal(getProcessStartTime(7, { platform: 'darwin', exec: () => 'garbage' }), null);
  assert.equal(getProcessStartTime(7, { platform: 'win32' }), null);
  assert.equal(getProcessStartTime(7, { platform: 'linux', readFile: () => { throw new Error('EACCES'); } }), null);
  if (process.platform === 'linux') assert.match(String(getProcessStartTime(process.pid)), /^\d+$/);
});

test('isAlive: ESRCH dead; EPERM alive; unreadable start time alive; start-time mismatch (PID reuse) dead', () => {
  const linux = (start, kill = () => {}) => ({ platform: 'linux', kill, readFile: () => `1 (x) ${Array.from({ length: 19 }, () => '0').join(' ')} ${start} 0` });
  assert.equal(isAlive({ pid: 1, startTime: '5' }, linux('5', esrch)), false);
  assert.equal(isAlive({ pid: 1, startTime: '5' }, linux('5', () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; })), true);
  assert.equal(isAlive({ pid: 1, startTime: '5' }, linux('5')), true, 'same process');
  assert.equal(isAlive({ pid: 1, startTime: '5' }, linux('6')), false, 'PID recycled');
  assert.equal(isAlive({ pid: 1, startTime: '5' }, { platform: 'linux', kill: () => {}, readFile: () => { throw new Error('x'); } }), true, 'unreadable → alive');
  assert.equal(isAlive({ pid: 1 }, linux('6')), true, 'no recorded startTime → alive');
  assert.equal(isAlive({ pid: 1, startTime: null }, linux('6')), true);
  for (const bad of [null, {}, { pid: '1' }, { pid: 0 }, { pid: -3 }, { pid: 1.5 }]) assert.equal(isAlive(bad, linux('5')), false);
});

test('isAlive (darwin): within ±1000ms is the same process, beyond is reuse', () => {
  const at = Date.parse('Wed Oct  7 12:00:00 2026');
  const mac = { platform: 'darwin', kill: () => {}, exec: () => 'Wed Oct  7 12:00:00 2026' };
  assert.equal(isAlive({ pid: 9, startTime: at + 1000 }, mac), true);
  assert.equal(isAlive({ pid: 9, startTime: at - 1000 }, mac), true);
  assert.equal(isAlive({ pid: 9, startTime: at + 1001 }, mac), false);
  assert.equal(isAlive({ pid: 9, startTime: 'nope' }, mac), false);
});

// ---------------------------------------------------------------------------
// Acquire / assert / release
// ---------------------------------------------------------------------------

test('acquire writes meta {pid,startTime,token,startedAt}; assert holds; release removes only our lock', () => {
  const home = freshHome();
  try {
    const h = acquireMigrationLock({ home });
    const meta = readLockMeta(h.lockDir);
    assert.equal(meta.pid, process.pid);
    assert.equal(meta.token, h.token);
    assert.ok(!Number.isNaN(Date.parse(meta.startedAt)));
    if (process.platform === 'linux') assert.equal(meta.startTime, getProcessStartTime(process.pid));
    assert.doesNotThrow(() => assertMigrationLockHeld(h));
    assert.equal(releaseMigrationLock({ ...h, token: 'other' }), false, 'foreign token never releases');
    assert.ok(existsSync(h.lockDir));
    assert.equal(releaseMigrationLock(h), true);
    assert.equal(existsSync(h.lockDir), false);
    assert.equal(releaseMigrationLock(h), false, 'idempotent');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('assertMigrationLockHeld throws LOCK_LOST when the lock is gone or replaced', () => {
  const home = freshHome();
  try {
    const h = acquireMigrationLock({ home });
    writeFileSync(join(h.lockDir, 'meta.json'), JSON.stringify({ ...readLockMeta(h.lockDir), token: 'stolen' }));
    assert.throws(() => assertMigrationLockHeld(h), (e) => e instanceof MigrationLockError && e.code === 'LOCK_LOST');
    rmSync(h.lockDir, { recursive: true });
    assert.throws(() => assertMigrationLockHeld(h), /lost or replaced/);
    assert.throws(() => assertMigrationLockHeld(null), /lost or replaced/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a lock dir with no readable meta is never stolen (holder may be mid-write)', () => {
  const home = freshHome();
  try {
    plantLock(home);
    assert.throws(() => acquireMigrationLock({ home }), (e) => e.code === 'LOCK_HELD');
    writeFileSync(join(migrationLockDir(home), 'meta.json'), '{not json');
    assert.throws(() => acquireMigrationLock({ home }), (e) => e.code === 'LOCK_HELD');
    assert.ok(existsSync(migrationLockDir(home)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('two processes: a live holder is detected and never stolen; the second backs off cleanly', async () => {
  const home = freshHome();
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import('${LOCK_URL}').then(({ acquireMigrationLock }) => { const h = acquireMigrationLock({ home: ${JSON.stringify(home)} }); process.stdout.write(h.token + '\\n'); setTimeout(() => {}, 30000); })`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const token = await new Promise((res, rej) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) res(buf.trim()); });
      child.on('exit', () => rej(new Error('holder exited early')));
    });
    assert.throws(() => acquireMigrationLock({ home }), (e) => e.code === 'LOCK_HELD' && e.message.includes(`pid ${child.pid}`));
    assert.equal(readLockMeta(migrationLockDir(home)).token, token, 'holder lock untouched');
    assert.deepEqual(readdirSync(boosterDataDir(home)).filter((n) => n.includes('.stale.')), [], 'no stale dirs left behind');
  } finally {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});

test('a dead-PID lock is reclaimed immediately by atomic rename, leaving no stale dir', () => {
  const home = freshHome();
  try {
    plantLock(home, { pid: deadPid(), startTime: '1', token: 'dead-token', startedAt: 'then' });
    const h = acquireMigrationLock({ home });
    assert.equal(readLockMeta(h.lockDir).token, h.token);
    assert.notEqual(h.token, 'dead-token');
    assert.deepEqual(readdirSync(boosterDataDir(home)).filter((n) => n.includes('.stale.')), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('PID reuse: a live PID whose startTime differs is a dead holder and is reclaimed', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, () => {
  const home = freshHome();
  try {
    const real = getProcessStartTime(process.pid);
    const altered = process.platform === 'linux' ? String(Number(real) + 1) : real + 5000;
    plantLock(home, { pid: process.pid, startTime: altered, token: 'recycled', startedAt: 'then' });
    const h = acquireMigrationLock({ home });
    assert.notEqual(h.token, 'recycled');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('three processes (ABA): C judged X dead but A took the lock first — C puts A back, never rmSyncs it', () => {
  const home = freshHome();
  try {
    const lockDir = plantLock(home, { pid: 999999, startTime: '1', token: 'X', startedAt: 'then' });
    let raced = false;
    const deps = {
      platform: 'linux',
      readFile: () => `1 (x) ${Array.from({ length: 19 }, () => '0').join(' ')} 1 0`,
      kill: (pid) => {
        if (pid === 999999) {
          if (!raced) {
            // Process A reclaims X and takes a live lock before C renames.
            raced = true;
            rmSync(lockDir, { recursive: true });
            mkdirSync(lockDir);
            writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({ pid: 424242, startTime: '1', token: 'A', startedAt: 'now' }));
          }
          esrch();
        }
        // pid 424242 (A) is alive with a matching start time.
      },
    };
    assert.throws(() => acquireMigrationLock({ home, deps }), (e) => e.code === 'LOCK_HELD' && /pid 424242/.test(e.message));
    assert.equal(readLockMeta(lockDir).token, 'A', "A's live lock is preserved");
    assert.deepEqual(readdirSync(boosterDataDir(home)).filter((n) => n.includes('.stale.')), [], 'moved dir was put back');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Handover, invalidation, break-lock
// ---------------------------------------------------------------------------

test('adopt: the matching token re-homes the lock to the new pid; a wrong token is refused', () => {
  const home = freshHome();
  try {
    const h = acquireMigrationLock({ home });
    assert.throws(() => adoptMigrationLock({ home, token: 'wrong' }), (e) => e.code === 'TOKEN_MISMATCH');
    assert.throws(() => adoptMigrationLock({ home }), (e) => e.code === 'TOKEN_MISMATCH');
    const before = readLockMeta(h.lockDir);
    const adopted = adoptMigrationLock({ home, token: h.token });
    const after = readLockMeta(h.lockDir);
    assert.equal(after.token, h.token);
    assert.equal(after.pid, process.pid);
    assert.equal(after.startedAt, before.startedAt);
    assert.ok(after.adoptedAt);
    assert.doesNotThrow(() => assertMigrationLockHeld(adopted));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('invalidate voids the token: the old holder can no longer assert, adopt or release', () => {
  const home = freshHome();
  try {
    const h = acquireMigrationLock({ home });
    assert.equal(invalidateMigrationLockToken({ ...h, token: 'nope' }), false);
    assert.equal(invalidateMigrationLockToken(h), true);
    assert.throws(() => assertMigrationLockHeld(h), /lost or replaced/);
    assert.throws(() => adoptMigrationLock({ home, token: h.token }), /does not match/);
    assert.equal(releaseMigrationLock(h), false);
    assert.equal(invalidateMigrationLockToken(h), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--break-lock: reports the holder, removes only when confirmed, and allows a fresh acquire', () => {
  const home = freshHome();
  try {
    assert.deepEqual(breakMigrationLock({ home, confirmed: true }), { present: false, removed: false, holder: null, alive: false });
    const h = acquireMigrationLock({ home });
    const preview = breakMigrationLock({ home });
    assert.equal(preview.present, true);
    assert.equal(preview.removed, false);
    assert.equal(preview.holder.token, h.token);
    assert.equal(preview.alive, true, 'warns that a live process holds it');
    assert.ok(existsSync(h.lockDir));
    const done = breakMigrationLock({ home, confirmed: true });
    assert.equal(done.removed, true);
    assert.equal(existsSync(h.lockDir), false);
    assert.doesNotThrow(() => releaseMigrationLock(acquireMigrationLock({ home })));
    plantLock(home);
    assert.equal(breakMigrationLock({ home }).alive, false, 'meta-less lock is reported, not alive');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// State file and finishUninstall
// ---------------------------------------------------------------------------

test('state file: absent → null; written atomically; corrupt or stateless → STATE_CORRUPT', () => {
  const home = freshHome();
  try {
    assert.equal(readMigrationState(home), null);
    writeMigrationState(home, { state: 'SNAPSHOT_CREATED', x: 1 });
    assert.deepEqual(readMigrationState(home), { state: 'SNAPSHOT_CREATED', x: 1 });
    assert.deepEqual(readdirSync(boosterDataDir(home)).filter((n) => n.endsWith('.tmp')), []);
    writeFileSync(join(boosterDataDir(home), 'migration-state.json'), JSON.stringify({ nostate: true }));
    assert.throws(() => readMigrationState(home), (e) => e.code === 'STATE_CORRUPT');
    writeFileSync(join(boosterDataDir(home), 'migration-state.json'), 'null');
    assert.throws(() => readMigrationState(home), (e) => e.code === 'STATE_CORRUPT');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function pendingHome() {
  const home = freshHome();
  const plugin = join(home, '.gemini', 'config', 'plugins', 'antigravity-booster');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'plugin.json'), '{"name":"antigravity-booster"}');
  writeFileSync(join(home, '.gemini', 'config', 'import_manifest.json'), JSON.stringify({
    imports: [{ name: 'antigravity-booster' }, { name: 'third-party' }],
  }));
  writeMigrationState(home, { state: 'ROLLED_BACK_PENDING_UNINSTALL', baselineSnapshotDir: '/b' });
  const uninstallerDir = mkdtempSync(join(tmpdir(), 'agb-uninst-'));
  return { home, plugin, uninstallerDir };
}

test('finishUninstall: refuses outside ROLLED_BACK_PENDING_UNINSTALL or with a wrong token', () => {
  const { home, uninstallerDir } = pendingHome();
  try {
    const h = acquireMigrationLock({ home });
    const wrong = finishUninstall({ home, token: 'bad', uninstallerDir, uninstall: () => assert.fail('must not run') });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /does not match/);
    assert.equal(readMigrationState(home).state, 'ROLLED_BACK_PENDING_UNINSTALL');
    assert.equal(readLockMeta(h.lockDir).token, h.token, 'a refused child never releases the parent lock');
    writeMigrationState(home, { state: 'MIGRATED' });
    const r = finishUninstall({ home, token: h.token, uninstall: () => assert.fail('must not run') });
    assert.equal(r.ok, false);
    assert.match(r.error, /state is MIGRATED/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(uninstallerDir, { recursive: true, force: true }); }
});

test('finishUninstall: adopts the lock, acks, uninstalls booster only, sets ROLLED_BACK, releases, cleans up', () => {
  const { home, plugin, uninstallerDir } = pendingHome();
  try {
    const h = acquireMigrationLock({ home });
    let ackSeenDuringUninstall = false;
    const r = finishUninstall({
      home, token: h.token, uninstallerDir,
      uninstall: () => { ackSeenDuringUninstall = existsSync(join(uninstallerDir, 'handover.ack')); },
    });
    assert.deepEqual(r, { ok: true });
    assert.ok(ackSeenDuringUninstall, 'handover.ack written before the uninstall work');
    assert.equal(readMigrationState(home).state, 'ROLLED_BACK');
    assert.equal(readMigrationState(home).baselineSnapshotDir, '/b', 'other state preserved');
    assert.equal(existsSync(plugin), false);
    const imports = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'import_manifest.json'), 'utf8')).imports;
    assert.deepEqual(imports, [{ name: 'third-party' }], 'third-party entries untouched');
    assert.equal(existsSync(h.lockDir), false, 'lock released');
    assert.equal(existsSync(uninstallerDir), false, 'uninstaller dir removed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('finishUninstall: an uninstall failure leaves PENDING for resume, still releases and cleans up', () => {
  const { home, plugin, uninstallerDir } = pendingHome();
  try {
    const h = acquireMigrationLock({ home });
    const r = finishUninstall({ home, token: h.token, uninstallerDir, uninstall: () => { throw new Error('agy gone'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /agy gone/);
    assert.equal(readMigrationState(home).state, 'ROLLED_BACK_PENDING_UNINSTALL');
    assert.ok(existsSync(plugin));
    assert.equal(existsSync(h.lockDir), false);
    assert.equal(existsSync(uninstallerDir), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('finishUninstall: booster already gone → ROLLED_BACK without running uninstall', () => {
  const { home, plugin, uninstallerDir } = pendingHome();
  try {
    rmSync(plugin, { recursive: true });
    const h = acquireMigrationLock({ home });
    const r = finishUninstall({ home, token: h.token, uninstallerDir, uninstall: () => assert.fail('nothing to uninstall') });
    assert.deepEqual(r, { ok: true });
    assert.equal(readMigrationState(home).state, 'ROLLED_BACK');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
