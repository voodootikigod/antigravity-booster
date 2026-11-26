import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveControlEndpoint,
  sendControlCommand,
  startControlServer,
} from '../lib/control-ipc.mjs';
import { acquireRepoLock } from '../lib/lock.mjs';
import * as worktreesMod from '../lib/worktrees.mjs';
import * as rescueMod from '../lib/rescue.mjs';

const {
  createWorktree,
  writeRescueWorktreeLock,
  hasProtectedRescueWorktree,
  clearRescueWorktreeLock,
} = worktreesMod;

const {
  FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES,
  isForbiddenRescuePath,
  saveRescueSnapshot,
  buildRescueBrief,
  runInteractiveRescue,
} = rescueMod;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeGitRepo(prefix = 'agb-ctrl-ipc-') {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@local');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n'
  );
  mkdirSync(join(repo, 'lib'), { recursive: true });
  writeFileSync(join(repo, 'lib', 'feature.mjs'), 'export const v = 1;\n');
  writeFileSync(join(repo, 'lib', 'obsolete.mjs'), 'export const old = true;\n');
  writeFileSync(join(repo, 'lib', 'lock.mjs'), 'export const frozen = true;\n');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n.booster/\nnode_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial commit');
  return repo;
}

function listGitObjects(repo) {
  const objectsDir = join(repo, '.git', 'objects');
  const found = [];
  const walk = (dir, rel = '') => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full, nextRel);
      else if (ent.isFile()) found.push(nextRel);
    }
  };
  walk(objectsDir);
  return found.sort();
}

function sendRawLine(endpoint, rawLine) {
  return new Promise((resolveRes, rejectRes) => {
    const sock = net.createConnection(endpoint);
    let out = '';
    sock.on('connect', () => {
      sock.write(rawLine);
    });
    sock.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    sock.on('end', () => {
      resolveRes(out.trim());
    });
    sock.on('close', () => {
      resolveRes(out.trim());
    });
    sock.on('error', (err) => {
      if (out.trim()) resolveRes(out.trim());
      else rejectRes(err);
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Authenticated Control IPC (`lib/control-ipc.mjs`)
// ---------------------------------------------------------------------------

test('control-ipc: 256-bit timingSafeEqual auth, one-shot handlers, stream cap, and close() cleanup', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'c-ipc-'));
  let srv = null;
  try {
    let paused = false;
    srv = await startControlServer(
      repo,
      {
        status: async () => ({ paused, activeTickets: ['T1'] }),
        pause: async () => {
          paused = true;
          return { paused: true };
        },
        resume: async () => {
          paused = false;
          return { paused: false };
        },
        stream: async (req) => ({
          ticketId: req.ticketId,
          lines: Array.from({ length: 60 }, (_, i) => `line-${i + 1}`),
        }),
        diff: async () => {
          throw new Error('synthetic diff failure');
        },
        abort: async () => ({ ok: false, error: 'ticket not active' }),
      },
      { runId: 'run-test-1' }
    );

    assert.equal(srv.token.length, 64);
    assert.match(srv.token, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(srv.controlFile), true);
    if (process.platform !== 'win32') {
      assert.equal(existsSync(srv.endpoint), true);
      assert.equal(statSync(srv.endpoint).mode & 0o777, 0o600);
      assert.equal(statSync(srv.controlFile).mode & 0o777, 0o600);
      assert.equal(statSync(join(repo, '.booster')).mode & 0o777, 0o700);
    }

    // Built-in ping
    const pingRes = await sendControlCommand(repo, { action: 'ping' });
    assert.equal(pingRes.ok, true);
    assert.equal(pingRes.pid, process.pid);
    assert.equal(pingRes.runId, 'run-test-1');

    // Custom handlers
    const pauseRes = await sendControlCommand(repo, { action: 'pause' });
    assert.deepEqual(pauseRes, { ok: true, paused: true });

    const statusRes = await sendControlCommand(repo, { action: 'status' });
    assert.deepEqual(statusRes, { ok: true, paused: true, activeTickets: ['T1'] });

    // One-shot stream action (default 40 lines, and custom lines cap)
    const streamDefault = await sendControlCommand(repo, { action: 'stream', ticketId: 'T1' });
    assert.equal(streamDefault.ok, true);
    assert.equal(streamDefault.ticketId, 'T1');
    assert.equal(streamDefault.lines.length, 40);
    assert.equal(streamDefault.lines[0], 'line-21');
    assert.equal(streamDefault.lines[39], 'line-60');

    const streamTen = await sendControlCommand(repo, { action: 'stream', ticketId: 'T1', lines: 10 });
    assert.equal(streamTen.lines.length, 10);
    assert.equal(streamTen.lines[0], 'line-51');

    // Handler throwing -> { ok: false, error }
    const diffErr = await sendControlCommand(repo, { action: 'diff', ticketId: 'T1' });
    assert.deepEqual(diffErr, { ok: false, error: 'synthetic diff failure' });

    // Handler returning { ok: false } preserved
    const abortRes = await sendControlCommand(repo, { action: 'abort', ticketId: 'T9' });
    assert.deepEqual(abortRes, { ok: false, error: 'ticket not active' });

    // Unauthorized: wrong same-length token, short token, missing token
    const wrongSameLen = srv.token[0] === 'a' ? `b${srv.token.slice(1)}` : `a${srv.token.slice(1)}`;
    const unauthSameLen = JSON.parse(
      await sendRawLine(srv.endpoint, JSON.stringify({ token: wrongSameLen, action: 'ping' }) + '\n')
    );
    assert.deepEqual(unauthSameLen, { ok: false, error: 'unauthorized' });

    const unauthShort = JSON.parse(
      await sendRawLine(srv.endpoint, JSON.stringify({ token: 'short', action: 'ping' }) + '\n')
    );
    assert.deepEqual(unauthShort, { ok: false, error: 'unauthorized' });

    const unauthMissing = JSON.parse(
      await sendRawLine(srv.endpoint, JSON.stringify({ action: 'ping' }) + '\n')
    );
    assert.deepEqual(unauthMissing, { ok: false, error: 'unauthorized' });

    // Prototype method & unsupported action rejection
    const protoAction = JSON.parse(
      await sendRawLine(srv.endpoint, JSON.stringify({ token: srv.token, action: 'toString' }) + '\n')
    );
    assert.equal(protoAction.ok, false);
    assert.match(protoAction.error, /unsupported action/);

    // Close cleans up control.json and socket
    await srv.close();
    const closedEndpoint = srv.endpoint;
    const closedControl = srv.controlFile;
    srv = null;

    assert.equal(existsSync(closedControl), false);
    if (process.platform !== 'win32') {
      assert.equal(existsSync(closedEndpoint), false);
    }

    const afterClose = await sendControlCommand(repo, { action: 'ping' });
    assert.equal(afterClose.ok, false);
    assert.equal(afterClose.offline, true);
  } finally {
    if (srv) await srv.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('control-ipc: >96-byte POSIX socket path falls back to tmpdir, rejects >64 KiB lines, and detects dead PIDs', async () => {
  const baseTmp = mkdtempSync(join(tmpdir(), 'c-long-'));
  const deepRepo = join(
    baseTmp,
    'very_long_nested_directory_segment_alpha_0123456789',
    'very_long_nested_directory_segment_beta_0123456789'
  );
  mkdirSync(deepRepo, { recursive: true });
  let srv = null;
  try {
    const endpoint = resolveControlEndpoint(deepRepo);
    if (process.platform !== 'win32') {
      const primary = join(deepRepo, '.booster', 'control.sock');
      assert.ok(Buffer.byteLength(primary, 'utf8') > 96);
      assert.ok(endpoint.includes('agb-ctrl-'), `expected tmpdir fallback, got ${endpoint}`);
      assert.ok(Buffer.byteLength(endpoint, 'utf8') <= 104);
    }

    srv = await startControlServer(deepRepo, {}, { runId: 'run-long' });
    const ping = await sendControlCommand(deepRepo, { action: 'ping' });
    assert.equal(ping.ok, true);
    assert.equal(ping.runId, 'run-long');

    // Oversized line (> 64 KiB) rejected with payload too large
    const hugeLine = JSON.stringify({
      token: srv.token,
      action: 'ping',
      pad: 'x'.repeat(70 * 1024),
    }) + '\n';
    const rawOversized = await sendRawLine(srv.endpoint, hugeLine);
    assert.deepEqual(JSON.parse(rawOversized), { ok: false, error: 'payload too large' });

    await srv.close();
    srv = null;

    // Dead PID in control.json -> offline: true, and stale socket is reclaimed on next start
    const fakeSock = resolveControlEndpoint(deepRepo);
    if (process.platform !== 'win32') {
      writeFileSync(fakeSock, '');
    }
    writeFileSync(
      join(deepRepo, '.booster', 'control.json'),
      JSON.stringify({
        endpoint: fakeSock,
        token: 'deadbeef'.repeat(8),
        pid: 99999999,
        startTime: 'stale-start',
        runId: 'dead-run',
      }),
      { mode: 0o600 }
    );
    const deadRes = await sendControlCommand(deepRepo, { action: 'status' });
    assert.deepEqual(deadRes, {
      ok: false,
      offline: true,
      error: 'no active run control server',
    });

    // Re-starting unlinks the stale socket file and binds cleanly
    srv = await startControlServer(deepRepo, {}, { runId: 'reclaimed-run' });
    const liveAgain = await sendControlCommand(deepRepo, { action: 'ping' });
    assert.equal(liveAgain.ok, true);
    assert.equal(liveAgain.runId, 'reclaimed-run');
  } finally {
    if (srv) await srv.close();
    rmSync(baseTmp, { recursive: true, force: true });
  }
});

test('control-ipc: rejects symlinked .booster and control.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c-sym-'));
  const target = mkdtempSync(join(tmpdir(), 'c-sym-target-'));
  try {
    symlinkSync(target, join(root, '.booster'));
    await assert.rejects(() => startControlServer(root, {}), /symbolic link/i);
    const res = await sendControlCommand(root, { action: 'ping' });
    assert.equal(res.ok, false);
    assert.equal(res.offline, true);
    assert.match(res.error, /symbolic link/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. All-Runs Rescue Lock Helpers (`lib/worktrees.mjs` + `lib/rescue.mjs`)
// ---------------------------------------------------------------------------

test('worktrees rescue-locks: createWorktree refuses to clobber active or preserved rescue worktrees unless allowResetRescue: true', () => {
  assert.equal(rescueMod.writeRescueWorktreeLock, worktreesMod.writeRescueWorktreeLock);
  assert.equal(rescueMod.hasProtectedRescueWorktree, worktreesMod.hasProtectedRescueWorktree);
  assert.equal(rescueMod.clearRescueWorktreeLock, worktreesMod.clearRescueWorktreeLock);

  const repo = makeGitRepo('agb-wt-guard-');
  try {
    assert.equal(hasProtectedRescueWorktree(repo, 'T-1'), false);
    const wt = createWorktree(repo, 'T-1', 'main');
    const sentinelFile = join(wt, 'lib', 'human-work.mjs');
    writeFileSync(sentinelFile, 'export const rescued = 42;\n');

    // Active lock protects worktree
    const lockPath = writeRescueWorktreeLock(repo, 'T-1', { state: 'active', runId: 'run-1' });
    assert.equal(existsSync(lockPath), true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(lockPath).mode & 0o777, 0o600);
    }
    assert.equal(hasProtectedRescueWorktree(repo, 'T-1'), true);

    assert.throws(
      () => createWorktree(repo, 'T-1', 'main'),
      /Refusing to clobber active or preserved rescue worktree for ticket T-1/
    );
    assert.equal(existsSync(sentinelFile), true, 'human worktree edit must remain untouched');

    // Preserved lock with dead PID also protects worktree
    writeFileSync(
      lockPath,
      JSON.stringify({ ticketId: 'T-1', state: 'preserved', pid: 99999999, startTime: 'dead' }),
      { mode: 0o600 }
    );
    assert.equal(hasProtectedRescueWorktree(repo, 'T-1'), true);
    assert.throws(
      () => createWorktree(repo, 'T-1', 'main'),
      /Refusing to clobber active or preserved rescue worktree for ticket T-1/
    );
    assert.equal(existsSync(sentinelFile), true);

    // Corrupt lock file fails closed
    writeFileSync(lockPath, '{not-valid-json', { mode: 0o600 });
    assert.equal(hasProtectedRescueWorktree(repo, 'T-1'), true);
    assert.throws(() => createWorktree(repo, 'T-1', 'main'), /Refusing to clobber/);

    // Explicit allowResetRescue: true permits recreation
    const recreated = createWorktree(repo, 'T-1', 'main', { allowResetRescue: true });
    assert.equal(recreated, wt);
    assert.equal(existsSync(sentinelFile), false);

    // clearRescueWorktreeLock unlinks cleanly and returns boolean
    assert.equal(clearRescueWorktreeLock(repo, 'T-1'), true);
    assert.equal(clearRescueWorktreeLock(repo, 'T-1'), false);
    assert.equal(hasProtectedRescueWorktree(repo, 'T-1'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Pure-FS Zero-Git-Object Snapshot (`saveRescueSnapshot`)
// ---------------------------------------------------------------------------

test('saveRescueSnapshot: writes zero loose objects to .git/objects, captures A/M/D in-scope files, and strips customization vectors', () => {
  assert.ok(FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES.includes('AGENTS.md'));
  assert.ok(FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES.includes('GEMINI.md'));
  assert.ok(FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES.includes('.agents'));
  assert.ok(FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES.includes('.gemini'));

  assert.equal(isForbiddenRescuePath(''), true);
  assert.equal(isForbiddenRescuePath('/etc/passwd'), true);
  assert.equal(isForbiddenRescuePath('../escape.mjs'), true);
  assert.equal(isForbiddenRescuePath('AGENTS.md'), true);
  assert.equal(isForbiddenRescuePath('nested/GEMINI.md'), true);
  assert.equal(isForbiddenRescuePath('.agents/skills/evil/SKILL.md'), true);
  assert.equal(isForbiddenRescuePath('.gemini/settings.json'), true);
  assert.equal(isForbiddenRescuePath('lib/feature.mjs'), false);

  const repo = makeGitRepo('agb-pure-snap-');
  try {
    const wt = createWorktree(repo, 'T-SNAP', 'main');

    // Modify tracked in-scope file + mode
    writeFileSync(join(wt, 'lib', 'feature.mjs'), 'export const v = 2;\n');
    chmodSync(join(wt, 'lib', 'feature.mjs'), 0o755);

    // Create untracked in-scope file
    writeFileSync(join(wt, 'lib', 'brand-new.mjs'), 'export const added = true;\n');

    // Delete tracked in-scope file
    unlinkSync(join(wt, 'lib', 'obsolete.mjs'));

    // Plant out-of-scope, rail, symlink, and forbidden customization files
    writeFileSync(join(wt, 'README-out-of-scope.md'), 'ignore me\n');
    writeFileSync(join(wt, 'lib', 'lock.mjs'), 'tampered rail\n');
    writeFileSync(join(wt, 'AGENTS.md'), '# poisoned charter\n');
    writeFileSync(join(wt, 'GEMINI.md'), '# poisoned gemini\n');
    writeFileSync(join(wt, 'lib', 'CLAUDE.md'), '# nested claude\n');
    mkdirSync(join(wt, '.agents', 'rules'), { recursive: true });
    writeFileSync(join(wt, '.agents', 'rules', 'inject.md'), 'evil\n');
    mkdirSync(join(wt, '.gemini'), { recursive: true });
    writeFileSync(join(wt, '.gemini', 'config.json'), '{}\n');
    symlinkSync(join(repo, 'package.json'), join(wt, 'lib', ' sneaky-link.mjs'));

    const objectsBefore = listGitObjects(repo);

    const snapRes = saveRescueSnapshot(
      repo,
      {
        id: 'T-SNAP',
        scope: ['lib/**', 'AGENTS.md', 'GEMINI.md', '.agents/**', '.gemini/**'],
        rails: ['lib/lock.mjs'],
      },
      wt,
      { runId: 'run-snap-1', baselineRoot: repo }
    );

    const objectsAfter = listGitObjects(repo);
    assert.deepEqual(
      objectsAfter,
      objectsBefore,
      'saveRescueSnapshot must write ZERO loose or packed objects to .git/objects'
    );

    assert.equal(snapRes.ok, true);
    assert.equal(snapRes.truncated, false);
    assert.equal(snapRes.fileCount, 2);
    assert.equal(snapRes.deletedCount, 1);
    assert.equal(existsSync(snapRes.snapshotPath), true);
    assert.equal(existsSync(snapRes.latestPath), true);

    const saved = JSON.parse(readFileSync(snapRes.latestPath, 'utf8'));
    assert.deepEqual(
      saved.files.map((f) => f.path),
      ['lib/brand-new.mjs', 'lib/feature.mjs']
    );
    const featureEntry = saved.files.find((f) => f.path === 'lib/feature.mjs');
    assert.equal(
      Buffer.from(featureEntry.contentBase64, 'base64').toString('utf8'),
      'export const v = 2;\n'
    );
    if (process.platform !== 'win32') {
      assert.equal(featureEntry.mode, 0o755);
    }
    assert.deepEqual(saved.deletedPaths, ['lib/obsolete.mjs']);
    assert.match(saved.diff, /lib\/feature\.mjs/);
    assert.match(saved.diff, /lib\/obsolete\.mjs/);
    assert.ok(!saved.diff.includes('poisoned'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Two-Phase Locking & P3/P5 Oracle (`runInteractiveRescue`)
// ---------------------------------------------------------------------------

test('runInteractiveRescue: releases repo lock during spawnInteractive, preserves worktree on gate/prosecutor failure, and merges + clears lock on pass', async () => {
  const repo = makeGitRepo('agb-rescue-flow-');
  try {
    const ticket = {
      id: 'T-RES-1',
      title: 'Fix feature value',
      body: 'Update lib/feature.mjs to v = 99 and remove lib/obsolete.mjs.',
      scope: ['lib/**'],
      rails: ['lib/lock.mjs'],
    };
    const gate = { test: 'npm test' };

    const brief = buildRescueBrief(ticket, { lastError: 'assertion failed', gate });
    assert.match(brief, /# AGB Surgical Rescue: T-RES-1 — Fix feature value/);
    assert.match(brief, /Prior Failure: assertion failed/);
    assert.match(brief, /Frozen Rails \(DO NOT EDIT\): lib\/lock\.mjs/);

    // Pre-seed a rescue snapshot (including a poisoned GEMINI.md entry that restore must strip)
    const seedWt = createWorktree(repo, 'T-RES-1', 'main');
    writeFileSync(join(seedWt, 'lib', 'feature.mjs'), 'export const v = 50;\n');
    unlinkSync(join(seedWt, 'lib', 'obsolete.mjs'));
    const seededSnap = saveRescueSnapshot(repo, ticket, seedWt, {
      runId: 'seed-run',
      baselineRoot: repo,
    });
    const tamperedSnap = JSON.parse(readFileSync(seededSnap.latestPath, 'utf8'));
    tamperedSnap.files.push({
      path: 'GEMINI.md',
      mode: 0o644,
      contentBase64: Buffer.from('evil instructions').toString('base64'),
    });
    writeFileSync(seededSnap.latestPath, JSON.stringify(tamperedSnap, null, 2), { mode: 0o600 });

    // Attempt 1: verify repo lock is NOT held during spawnInteractive, then fail prosecution -> preserve worktree
    let lockFreeDuringInteractive = false;
    let protectedDuringInteractive = false;
    let restoredFeatureSeen = '';
    let obsoleteDeletedOnRestore = false;
    let poisonedGeminiRestored = true;

    const failRes = await runInteractiveRescue(repo, 'T-RES-1', {
      ticket,
      gate,
      runId: 'rescue-1',
      spawnInteractive: async ({ worktreePath }) => {
        // Prove repo lock is NOT held during interactive session:
        const probeLock = acquireRepoLock(repo, { runId: 'concurrent-probe' });
        probeLock.assertStillHeld();
        probeLock();
        lockFreeDuringInteractive = true;

        // While rescue worktree lock IS active:
        protectedDuringInteractive = hasProtectedRescueWorktree(repo, 'T-RES-1');

        // Verify snapshot restore applied valid in-scope edits and stripped GEMINI.md:
        restoredFeatureSeen = readFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'utf8');
        obsoleteDeletedOnRestore = !existsSync(join(worktreePath, 'lib', 'obsolete.mjs'));
        poisonedGeminiRestored = existsSync(join(worktreePath, 'GEMINI.md'));

        // Plant orchestrator AGENTS.md projection to verify discardProjection runs before railsGuardFn
        writeFileSync(join(worktreePath, 'AGENTS.md'), '# temporary charter\n');
        writeFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'export const v = 99;\n');
        return 0;
      },
      railsGuardFn: async ({ worktree }) => {
        assert.equal(
          existsSync(join(worktree, 'AGENTS.md')),
          false,
          'discardProjection must remove AGENTS.md before railsGuardFn runs'
        );
        return { violations: [] };
      },
      runGatesFn: async () => ({ ok: true, results: [{ name: 'test', ok: true, output: 'ok' }] }),
      runHollowTestFn: async () => ({ ok: true, total: 2, killed: 2, survived: 0, mutants: [] }),
      prosecuteFn: async () => ({
        verdict: 'block',
        findings: [{ severity: 'high', charge: 'correctness', claim: 'missing edge case' }],
      }),
      recordGateFn: async () => ({ ok: true }),
    });

    assert.equal(lockFreeDuringInteractive, true);
    assert.equal(protectedDuringInteractive, true);
    assert.equal(restoredFeatureSeen, 'export const v = 50;\n');
    assert.equal(obsoleteDeletedOnRestore, true);
    assert.equal(poisonedGeminiRestored, false);

    assert.equal(failRes.ok, false);
    assert.equal(failRes.merged, false);
    assert.match(failRes.error, /prosecution blocked merge/);
    assert.equal(existsSync(failRes.preservedWorktree), true, 'worktree must be preserved on Phase B failure');
    assert.equal(hasProtectedRescueWorktree(repo, 'T-RES-1'), true, 'rescue lock must remain preserved');

    // Attempt 2: continue existing preserved worktree, pass all P3/P5 gates -> merge & clear lock
    let hollowCalled = false;
    let prosecuteArgs = null;
    let recordedRescueGate = null;
    const passRes = await runInteractiveRescue(repo, 'T-RES-1', {
      ticket,
      gate,
      continueExisting: true,
      runId: 'rescue-2',
      spawnInteractive: async ({ worktreePath }) => {
        // Confirm preserved worktree state survived Attempt 1
        assert.equal(
          readFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'utf8'),
          'export const v = 99;\n'
        );
        writeFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'export const v = 100;\n');
        return 0;
      },
      railsGuardFn: async () => ({ violations: [] }),
      runGatesFn: async () => ({ ok: true, results: [{ name: 'test', ok: true, output: 'ok' }] }),
      runHollowTestFn: async () => {
        hollowCalled = true;
        return { ok: true, total: 3, killed: 3, survived: 0, mutants: [] };
      },
      prosecuteFn: async (args) => {
        prosecuteArgs = args;
        return { verdict: 'ship', model: args.model, prosecutionMode: 'same-family-fallback', findings: [] };
      },
      recordGateFn: async (args) => {
        recordedRescueGate = args;
        return { ok: true };
      },
    });

    const { tierCandidates } = await import('../lib/models.mjs');
    assert.equal(hollowCalled, true, 'hollow-test must run when lib/ files changed');
    assert.equal(
      prosecuteArgs?.builderModel,
      tierCandidates(ticket.tier ?? 'mid', ticket.pool_hint)[0],
      'runInteractiveRescue must pass primary tier candidate as builderModel',
    );
    assert.ok(prosecuteArgs?.model, 'runInteractiveRescue must pass a non-empty prosecutor model');
    assert.equal(recordedRescueGate?.data?.ok, true);
    assert.equal(recordedRescueGate?.data?.prosecutorModel, prosecuteArgs.model);
    assert.equal(recordedRescueGate?.data?.prosecutionMode, 'same-family-fallback');
    assert.deepEqual(passRes, { ok: true, merged: true, ticketId: 'T-RES-1' });
    assert.equal(hasProtectedRescueWorktree(repo, 'T-RES-1'), false, 'rescue lock must be cleared on merge');
    assert.equal(
      existsSync(join(repo, '.worktrees', 'agb-t-res-1')),
      false,
      'rescue worktree must be removed after merge'
    );
    assert.equal(
      readFileSync(join(repo, 'lib', 'feature.mjs'), 'utf8'),
      'export const v = 100;\n',
      'merged commit must advance baseBranch and sync clean root working tree'
    );
    assert.equal(existsSync(join(repo, 'lib', 'obsolete.mjs')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('control-ipc, worktrees & rescue: timeout, invalid JSON, dead active lock without worktree, size truncation, and P3/P5 gate/hollow/script failures', async () => {
  const repo = makeGitRepo('agb-rescue-edges-');
  let stalledSrv = null;
  let customPingSrv = null;
  try {
    // 1. Custom ping override + invalid JSON request + idempotent close()
    customPingSrv = await startControlServer(
      repo,
      { ping: async () => ({ customPong: true }) },
      { runId: 'custom-ping' }
    );
    const customPing = await sendControlCommand(repo, { action: 'ping' });
    assert.deepEqual(customPing, { ok: true, customPong: true });

    const badJson = JSON.parse(await sendRawLine(customPingSrv.endpoint, '{bad-json\n'));
    assert.deepEqual(badJson, { ok: false, error: 'invalid JSON' });

    await customPingSrv.close();
    await customPingSrv.close();
    customPingSrv = null;

    // 2. Timeout handling in sendControlCommand
    const sockPath = resolveControlEndpoint(repo);
    const stalledSockets = new Set();
    stalledSrv = net.createServer((sock) => {
      stalledSockets.add(sock);
      sock.on('close', () => stalledSockets.delete(sock));
      sock.on('error', () => {});
      // Intentionally never respond
    });
    await new Promise((r) => stalledSrv.listen(sockPath, r));
    writeFileSync(
      join(repo, '.booster', 'control.json'),
      JSON.stringify({
        endpoint: sockPath,
        token: 'a'.repeat(64),
        pid: process.pid,
        startTime: null,
        runId: 'stalled',
      }),
      { mode: 0o600 }
    );
    const timedOut = await sendControlCommand(repo, { action: 'status' }, { timeoutMs: 120 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.offline, true);
    assert.match(timedOut.error, /timed out/);
    for (const s of stalledSockets) s.destroy();
    await new Promise((r) => stalledSrv.close(r));
    stalledSrv = null;
    try { unlinkSync(sockPath); } catch {}
    try { unlinkSync(join(repo, '.booster', 'control.json')); } catch {}

    // 3. Dead active lock without .worktrees/agb-<id> returns false; invalid ticketId throws; symlink lock throws
    assert.throws(() => writeRescueWorktreeLock(repo, '../evil'), /invalid ticket id/);
    assert.throws(() => hasProtectedRescueWorktree(repo, '../evil'), /invalid ticket id/);
    assert.throws(() => clearRescueWorktreeLock(repo, '../evil'), /invalid ticket id/);

    const deadLockPath = writeRescueWorktreeLock(repo, 'T-GHOST', { state: 'active' });
    writeFileSync(
      deadLockPath,
      JSON.stringify({ ticketId: 'T-GHOST', state: 'active', pid: 99999999, startTime: 'gone' }),
      { mode: 0o600 }
    );
    assert.equal(
      hasProtectedRescueWorktree(repo, 'T-GHOST'),
      false,
      'dead active lock with no worktree directory on disk should not block'
    );
    clearRescueWorktreeLock(repo, 'T-GHOST');

    const symTarget = join(repo, 'package.json');
    symlinkSync(symTarget, join(repo, '.booster', 'rescue-locks', 't-sym.json'));
    assert.throws(() => hasProtectedRescueWorktree(repo, 'T-SYM'), /symbolic link/i);
    assert.throws(() => clearRescueWorktreeLock(repo, 'T-SYM'), /symbolic link/i);
    unlinkSync(join(repo, '.booster', 'rescue-locks', 't-sym.json'));

    // 4. saveRescueSnapshot > 2 MiB truncation + > 64 KiB diffPreview truncation
    const wtBig = createWorktree(repo, 'T-BIG', 'main');
    writeFileSync(join(wtBig, 'lib', 'huge.bin'), Buffer.alloc(2 * 1024 * 1024 + 64, 0x61));
    writeFileSync(join(wtBig, 'lib', 'feature.mjs'), 'export const v = 7;\n');
    const bigSnap = saveRescueSnapshot(
      repo,
      { id: 'T-BIG', scope: ['lib/**'], rails: [] },
      wtBig,
      { runId: 'big-run', baselineRoot: repo, diffPreview: 'd'.repeat(80 * 1024) }
    );
    assert.equal(bigSnap.ok, true);
    assert.equal(bigSnap.truncated, true);
    assert.equal(bigSnap.fileCount, 1);
    const bigSaved = JSON.parse(readFileSync(bigSnap.latestPath, 'utf8'));
    assert.equal(Buffer.byteLength(bigSaved.diff, 'utf8'), 64 * 1024);

    // 5. runInteractiveRescue: resolves ticket from .booster/plan.json, handles non-zero exit, gate script tampering, gate failure, and hollow-test survivor
    writeFileSync(
      join(repo, '.booster', 'plan.json'),
      JSON.stringify({
        repo,
        base: 'main',
        gate: { test: 'npm test' },
        tickets: [
          {
            id: 'T-PLAN',
            title: 'From plan.json',
            body: 'Edit lib/feature.mjs',
            scope: ['lib/**', 'package.json'],
            rails: ['lib/lock.mjs'],
          },
        ],
      })
    );

    // 5a. Non-zero interactive exit preserves worktree
    const nonZero = await runInteractiveRescue(repo, 'T-PLAN', {
      spawnInteractive: async ({ worktreePath }) => {
        writeFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'export const v = 3;\n');
        return { exitCode: 2 };
      },
    });
    assert.equal(nonZero.ok, false);
    assert.equal(nonZero.merged, false);
    assert.match(nonZero.error, /exited with code 2/);
    assert.equal(hasProtectedRescueWorktree(repo, 'T-PLAN'), true);

    // 5b. Gate script tampering in package.json rejected
    const scriptTamper = await runInteractiveRescue(repo, 'T-PLAN', {
      continueExisting: true,
      spawnInteractive: async ({ worktreePath }) => {
        writeFileSync(
          join(worktreePath, 'package.json'),
          JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'echo pwned' } }) + '\n'
        );
        return 0;
      },
    });
    assert.equal(scriptTamper.ok, false);
    assert.match(scriptTamper.error, /Gate script 'test' command string modified/);

    // 5c. Restore clean package.json, verify hollow-test survivor blocks merge and preserves worktree
    const baselinePkg = readFileSync(join(repo, 'package.json'), 'utf8');
    const hollowBlock = await runInteractiveRescue(repo, 'T-PLAN', {
      continueExisting: true,
      spawnInteractive: async ({ worktreePath }) => {
        writeFileSync(join(worktreePath, 'package.json'), baselinePkg);
        writeFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'export const v = 4;\n');
        return 0;
      },
      railsGuardFn: async () => ({ violations: [] }),
      runGatesFn: async () => ({ ok: true, results: [{ name: 'test', ok: true, output: 'ok' }] }),
      runHollowTestFn: async () => ({
        ok: true,
        total: 4,
        killed: 3,
        survived: 1,
        mutants: [{ id: 1, status: 'survived' }],
      }),
      prosecuteFn: async () => ({ verdict: 'ship', findings: [] }),
    });
    assert.equal(hollowBlock.ok, false);
    assert.equal(hollowBlock.merged, false);
    assert.match(hollowBlock.error, /hollow-test: 1\/4 mutant\(s\) survived/);
    assert.equal(existsSync(hollowBlock.preservedWorktree), true);

    // 5d. Hollow-test execution error ({ ok: false }) fails closed AND sees materialized node_modules
    mkdirSync(join(repo, 'node_modules', 'dummy-dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dummy-dep', 'index.js'), 'export default 1;\n');
    let sawNodeModulesInHollow = false;
    const hollowExecErr = await runInteractiveRescue(repo, 'T-PLAN', {
      continueExisting: true,
      spawnInteractive: async ({ worktreePath }) => {
        writeFileSync(join(worktreePath, 'lib', 'feature.mjs'), 'export const v = 5;\n');
        return 0;
      },
      railsGuardFn: async () => ({ violations: [] }),
      runGatesFn: async () => ({ ok: true, results: [{ name: 'test', ok: true, output: 'ok' }] }),
      runHollowTestFn: async ({ worktree }) => {
        sawNodeModulesInHollow = existsSync(join(worktree, 'node_modules', 'dummy-dep', 'index.js'));
        return { ok: false, error: 'hollow-test binary crashed' };
      },
      prosecuteFn: async () => ({ verdict: 'ship', findings: [] }),
    });
    assert.equal(sawNodeModulesInHollow, true, 'hollow-test must run before materialized node_modules is removed');
    assert.equal(hollowExecErr.ok, false, 'hollow-test ok: false must fail closed');
    assert.match(hollowExecErr.error, /adlc hollow-test failed: hollow-test binary crashed/);

    // 5e. Concurrent live rescue session refuses to clobber active worktree
    const sleeper = execFileSync; // spawn a short background node sleeper to simulate live rescue pid
    const { spawn: spawnChild } = await import('node:child_process');
    const liveHolder = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      writeFileSync(
        join(repo, '.booster', 'rescue-locks', 't-plan.json'),
        JSON.stringify({ ticketId: 'T-PLAN', state: 'active', pid: liveHolder.pid, startTime: null }),
        { mode: 0o600 }
      );
      const concurrentRefused = await runInteractiveRescue(repo, 'T-PLAN', {
        spawnInteractive: async () => 0,
      });
      assert.equal(concurrentRefused.ok, false);
      assert.match(concurrentRefused.error, /another interactive rescue session .* is already active/);
      const lockStillActive = JSON.parse(readFileSync(join(repo, '.booster', 'rescue-locks', 't-plan.json'), 'utf8'));
      assert.equal(lockStillActive.state, 'active');
      assert.equal(lockStillActive.pid, liveHolder.pid);
    } finally {
      liveHolder.kill('SIGKILL');
    }

    // 5f. Tampered .git pointer inside rescue worktree is rejected in Phase B
    writeFileSync(
      join(repo, '.booster', 'rescue-locks', 't-plan.json'),
      JSON.stringify({ ticketId: 'T-PLAN', state: 'preserved', pid: process.pid, startTime: null }),
      { mode: 0o600 }
    );
    const gitTamperRes = await runInteractiveRescue(repo, 'T-PLAN', {
      continueExisting: true,
      spawnInteractive: async ({ worktreePath }) => {
        const origGit = readFileSync(join(worktreePath, '.git'), 'utf8');
        writeFileSync(join(worktreePath, '.orig-git-backup'), origGit);
        writeFileSync(join(worktreePath, '.git'), 'gitdir: /tmp\n');
        return 0;
      },
    });
    assert.equal(gitTamperRes.ok, false);
    assert.match(gitTamperRes.error, /Security violation: rescue worktree \.git/);
    // Restore valid .git pointer for clean teardown
    const wtPlan = join(repo, '.worktrees', 'agb-t-plan');
    if (existsSync(join(wtPlan, '.orig-git-backup'))) {
      writeFileSync(join(wtPlan, '.git'), readFileSync(join(wtPlan, '.orig-git-backup'), 'utf8'));
      unlinkSync(join(wtPlan, '.orig-git-backup'));
    }

    // 5g. Snapshot baseSha restore + 3-way rebase preserves newer upstream edits on main AND updates run.json/report.json
    clearRescueWorktreeLock(repo, 'T-PLAN');
    writeFileSync(join(repo, 'lib', 'shared.mjs'), 'export const top = 1;\nexport const mid = 2;\nexport const bot = 3;\n');
    execFileSync('git', ['-C', repo, 'add', 'lib/shared.mjs']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'add shared']);

    const snapWt = createWorktree(repo, 'T-BASE-SNAP', 'main');
    writeFileSync(join(snapWt, 'lib', 'shared.mjs'), 'export const top = 1;\nexport const mid = 2;\nexport const bot = 999;\n');
    const baseTicket = { id: 'T-BASE-SNAP', title: 'Update bot', scope: ['lib/**'], rails: [] };
    saveRescueSnapshot(repo, baseTicket, snapWt, { runId: 'r-snap', baselineRoot: repo });
    rmSync(snapWt, { recursive: true, force: true });
    execFileSync('git', ['-C', repo, 'worktree', 'prune']);

    // Advance main upstream on a different line of lib/shared.mjs AFTER snapshot was taken!
    writeFileSync(join(repo, 'lib', 'shared.mjs'), 'export const top = 111;\nexport const mid = 2;\nexport const bot = 3;\n');
    execFileSync('git', ['-C', repo, 'add', 'lib/shared.mjs']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'upstream edit top']);

    writeFileSync(
      join(repo, '.booster', 'run.json'),
      JSON.stringify({ runId: 'r-snap', done: true, tickets: { 'T-BASE-SNAP': { phase: 'failed' } } })
    );
    writeFileSync(
      join(repo, '.booster', 'report.json'),
      JSON.stringify({ runId: 'r-snap', merged: [], failed: { 'T-BASE-SNAP': 'failed' } })
    );

    const rebasedRescue = await runInteractiveRescue(repo, 'T-BASE-SNAP', {
      ticket: baseTicket,
      gate: { test: 'npm test' },
      spawnInteractive: async () => 0,
      railsGuardFn: async () => ({ violations: [] }),
      runGatesFn: async () => ({ ok: true, results: [] }),
      runHollowTestFn: async () => ({ ok: true, total: 1, killed: 1, survived: 0, mutants: [] }),
      prosecuteFn: async () => ({ verdict: 'ship', findings: [] }),
      recordGateFn: async () => ({ ok: true }),
    });
    assert.equal(rebasedRescue.ok, true, rebasedRescue.error);
    assert.equal(
      readFileSync(join(repo, 'lib', 'shared.mjs'), 'utf8'),
      'export const top = 111;\nexport const mid = 2;\nexport const bot = 999;\n',
      '3-way rebase from snap.baseSha must preserve upstream top=111 AND rescued bot=999'
    );
    const updatedReport = JSON.parse(readFileSync(join(repo, '.booster', 'report.json'), 'utf8'));
    assert.ok(updatedReport.merged.includes('T-BASE-SNAP'));
    assert.equal(updatedReport.failed['T-BASE-SNAP'], undefined);
  } finally {
    if (customPingSrv) await customPingSrv.close();
    if (stalledSrv) await new Promise((r) => stalledSrv.close(r));
    rmSync(repo, { recursive: true, force: true });
  }
});
