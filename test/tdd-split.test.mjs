import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeRedPhaseEnv,
  shouldRunTddSplit,
  selectOppositePoolHint,
  partitionTddScopes,
  promoteTestsToBuilderRails,
  verifyRedPhaseTests,
} from '../lib/tdd-split.mjs';

const NOSBX = { ...process.env, AGB_SANDBOX_GATES: '0' };
const RED = 'import { test } from "node:test";\ntest("red", () => { throw new Error("x"); });\n';
const TAP_RED = { status: 1, stdout: 'TAP version 13\nnot ok 1 - red\n', stderr: '' };
const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-tdd-'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test', 'a.test.mjs'), RED);
  return dir;
};
const fakeSpawn = (calls, result = TAP_RED, onRun = () => {}) => (cmd, args, opts) => {
  if (args[0] === '--check') return { status: 0 };
  calls.push({ cmd, args, opts });
  onRun();
  return result;
};

test('shouldRunTddSplit activates on frontier tickets with test+impl scope and honors tdd_split overrides', () => {
  assert.equal(
    shouldRunTddSplit({
      id: 'T1',
      tier: 'frontier',
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    true
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T2',
      tier: 'mid',
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    false
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T3',
      tier: 'mid',
      tdd_split: true,
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    true
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T4',
      tier: 'frontier',
      tdd_split: false,
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    false
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T5',
      tier: 'frontier',
      scope: ['lib/foo.mjs'],
    }),
    false,
    'must not split when no test path is in scope'
  );
});

test('selectOppositePoolHint and partitionTddScopes isolate Spec-Test Author on opposite pool and freeze impl paths', () => {
  assert.equal(selectOppositePoolHint('gemini', 'gemini-4-neon-high'), 'claude-gpt');
  assert.equal(selectOppositePoolHint('claude-gpt', 'claude-opus-5-5-high'), 'gemini');

  const ticket = {
    id: 'T-FRONT',
    title: 'Add widget engine',
    tier: 'frontier',
    pool_hint: 'gemini',
    scope: ['lib/widget.mjs', 'test/widget.test.mjs'],
    rails: ['lib/lock.mjs'],
    body: 'Implement createWidget().',
  };

  const part = partitionTddScopes(ticket, { builderModel: 'gemini-4-neon-high' });
  assert.deepEqual(part.testScope, ['test/widget.test.mjs']);
  assert.deepEqual(part.implScope, ['lib/widget.mjs']);
  assert.equal(part.specPoolHint, 'claude-gpt');
  assert.deepEqual(part.specAuthorSubTicket.scope, ['test/widget.test.mjs']);
  assert.ok(part.specAuthorSubTicket.rails.includes('lib/widget.mjs'));
  assert.ok(part.specAuthorSubTicket.rails.includes('lib/lock.mjs'));

  const promoted = promoteTestsToBuilderRails(ticket, ['test/widget.test.mjs']);
  assert.ok(promoted.rails.includes('test/widget.test.mjs'));
  assert.ok(promoted.rails.includes('lib/lock.mjs'));
});

test('verifyRedPhaseTests accepts failing syntactically valid tests and rejects tautological or broken tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-tdd-red-'));
  try {
    mkdirSync(join(dir, 'test'), { recursive: true });

    // 1. Failing red-phase contract test -> ok: true
    writeFileSync(
      join(dir, 'test', 'red.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n'
    );
    const redRes = verifyRedPhaseTests(['test/red.test.mjs'], { worktree: dir, env: NOSBX });
    assert.equal(redRes.ok, true);
    assert.deepEqual(redRes.verifiedFiles, ['test/red.test.mjs']);

    // 2. Tautological test passing on unimplemented base -> ok: false
    writeFileSync(
      join(dir, 'test', 'taut.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("green", () => { assert.equal(1, 1); });\n'
    );
    const tautRes = verifyRedPhaseTests(['test/taut.test.mjs'], { worktree: dir, env: NOSBX });
    assert.equal(tautRes.ok, false);
    assert.match(tautRes.reason, /tautological spec tests/);

    // 3. Syntax error -> ok: false
    writeFileSync(join(dir, 'test', 'syntax.test.mjs'), 'export const = ;\n');
    const synRes = verifyRedPhaseTests(['test/syntax.test.mjs'], { worktree: dir, env: NOSBX });
    assert.equal(synRes.ok, false);
    assert.match(synRes.reason, /syntax error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeRedPhaseEnv keeps only allowlisted keys per platform', () => {
  const env = {
    PATH: 'p', HOME: 'h', USER: 'u', LANG: 'l', TERM: 't', TMPDIR: 'a', TEMP: 'b', TMP: 'c',
    SYSTEMROOT: 's', WINDIR: 'w', COMSPEC: 'c', PATHEXT: 'e', APPDATA: 'ad', LOCALAPPDATA: 'la',
    NODE_TEST_CONTEXT: 'x', NODE_OPTIONS: 'y', LD_PRELOAD: 'z', API_KEY: 'k', GH_TOKEN: 't', MY_SECRET: 's',
  };
  const posix = sanitizeRedPhaseEnv(env, 'linux');
  assert.deepEqual(Object.keys(posix).sort(), ['HOME', 'LANG', 'NODE_ENV', 'PATH', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USER']);
  assert.equal(posix.NODE_ENV, 'test');
  const win = sanitizeRedPhaseEnv(env, 'win32');
  for (const k of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PATH']) {
    assert.equal(win[k], env[k]);
  }
  assert.equal(Object.keys(win).length, 15);
});

test('verifyRedPhaseTests rejects bad worktrees and unsafe paths', () => {
  const dir = mk();
  const outside = mkdtempSync(join(tmpdir(), 'agb-tdd-out-'));
  try {
    writeFileSync(join(outside, 'x.test.mjs'), RED);
    writeFileSync(join(dir, 'plain'), 'x');
    symlinkSync(join(outside, 'x.test.mjs'), join(dir, 'test', 'link.test.mjs'));
    symlinkSync(outside, join(dir, 'test', 'linkdir'));
    const run = (f, worktree = dir) => verifyRedPhaseTests([f], { worktree, env: NOSBX });
    let r = run('test/a.test.mjs', join(dir, 'nope'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a directory/);
    r = run('test/a.test.mjs', join(dir, 'plain'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a directory/);
    for (const bad of ['test/a\0b.test.mjs', 'test/a\nb.test.mjs']) {
      r = run(bad);
      assert.equal(r.ok, false);
      assert.match(r.reason, /control characters/);
    }
    r = run('/etc/x.test.mjs');
    assert.equal(r.ok, false);
    assert.match(r.reason, /absolute/);
    r = run('test/../x.test.mjs');
    assert.equal(r.ok, false);
    assert.match(r.reason, /traversal/);
    r = run('test/link.test.mjs');
    assert.equal(r.ok, false);
    assert.match(r.reason, /symlinked/);
    r = run('test/linkdir/x.test.mjs');
    assert.equal(r.ok, false);
    assert.match(r.reason, /escapes worktree/);
    r = run('test/missing.test.mjs');
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('verifyRedPhaseTests detects worktree mutation in a git repo and restores test bytes', () => {
  const dir = mk();
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const calls = [];
    const r = verifyRedPhaseTests(['test/a.test.mjs'], {
      worktree: dir,
      env: NOSBX,
      spawnFn: fakeSpawn(calls, TAP_RED, () => {
        writeFileSync(join(dir, 'dirty.txt'), 'x');
        writeFileSync(join(dir, 'test', 'a.test.mjs'), 'tampered');
      }),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /mutated worktree/);
    assert.equal(spawnSync('cat', [join(dir, 'test', 'a.test.mjs')], { encoding: 'utf8' }).stdout, RED);
    const r2 = verifyRedPhaseTests(['test/a.test.mjs'], {
      worktree: dir,
      env: NOSBX,
      spawnFn: fakeSpawn([], TAP_RED, () => writeFileSync(join(dir, 'other.txt'), 'y')),
    });
    assert.match(r2.reason, /mutated worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRedPhaseTests darwin uses sandbox-exec; win32 and unavailable sandboxes fail closed', () => {
  const dir = mk();
  try {
    const calls = [];
    const r = verifyRedPhaseTests(['test/a.test.mjs'], {
      worktree: dir, env: {}, platform: 'darwin', sandboxAvailableFn: () => true, spawnFn: fakeSpawn(calls),
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0].cmd, 'sandbox-exec');
    assert.equal(calls[0].args[0], '-f');
    assert.deepEqual(calls[0].args.slice(2), [process.execPath, '--test', '--test-reporter=tap', 'test/a.test.mjs']);
    assert.equal(existsSync(calls[0].args[1]), false, 'profile temp dir removed');
    assert.equal(calls[0].opts.maxBuffer, 8 * 1024 * 1024);

    for (const [platform, avail] of [['win32', true], ['linux', false]]) {
      const c = [];
      const f = verifyRedPhaseTests(['test/a.test.mjs'], {
        worktree: dir, env: {}, platform, sandboxAvailableFn: () => avail, spawnFn: fakeSpawn(c),
      });
      assert.equal(f.ok, false);
      assert.match(f.reason, new RegExp(`sandbox unavailable on ${platform}`));
      assert.equal(c.length, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRedPhaseTests linux bwrap quoting, mountpoint cleanup, EPERM and timeout handling', () => {
  const dir = mk();
  try {
    mkdirSync(join(dir, 'test', "o'brien"));
    writeFileSync(join(dir, 'test', "o'brien", 'q.test.mjs'), RED);
    const opts = { worktree: dir, env: {}, platform: 'linux', sandboxAvailableFn: () => true };
    const calls = [];
    let r = verifyRedPhaseTests(["test/o'brien/q.test.mjs"], {
      ...opts,
      spawnFn: fakeSpawn(calls, TAP_RED, () => {
        mkdirSync(join(dir, '.git'));
        mkdirSync(join(dir, 'node_modules'));
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0].cmd, 'bwrap');
    const cmd = calls[0].args.at(-1);
    assert.ok(cmd.includes("'test/o'\\''brien/q.test.mjs'"));
    assert.ok(cmd.includes("'--test-reporter=tap'"));
    assert.equal(existsSync(join(dir, '.git')), false);
    assert.equal(existsSync(join(dir, 'node_modules')), false);

    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'node_modules'));
    r = verifyRedPhaseTests(['test/a.test.mjs'], { ...opts, spawnFn: fakeSpawn([], TAP_RED) });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(dir, '.git')), true);
    assert.equal(existsSync(join(dir, 'node_modules')), true);

    r = verifyRedPhaseTests(['test/a.test.mjs'], {
      ...opts,
      spawnFn: fakeSpawn([], { status: 1, stdout: '', stderr: 'bwrap: EPERM' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /failed to start/);

    r = verifyRedPhaseTests(['test/a.test.mjs'], {
      ...opts,
      spawnFn: fakeSpawn([], { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /timed out/);

    r = verifyRedPhaseTests(['test/a.test.mjs'], { ...opts, spawnFn: fakeSpawn([], { status: 0, stdout: 'TAP version 13\nok 1\n' }) });
    assert.match(r.reason, /tautological/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const bwrapWorks = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--', 'true']).status === 0;
test('verifyRedPhaseTests runs live under bwrap', { skip: !bwrapWorks }, () => {
  const dir = mk();
  try {
    const r = verifyRedPhaseTests(['test/a.test.mjs'], { worktree: dir, env: { ...process.env, AGB_SANDBOX_GATES: '1' } });
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
