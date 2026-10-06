// T-PLUGIN-02 / Appendix A.6 item 14: post-run integrity verification. A
// worker that plants a git hook or edits a staged plugin marks the run
// compromised and blocks merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlan } from '../lib/scheduler.mjs';
import { snapshotRunIntegrity, diffRunIntegrity, verifyRunIntegrity, ABSENT } from '../lib/run-integrity.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_integrity_test.json');

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const quiet = { log: () => {} };

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-integrity-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'agb-integrity-home-'));
  for (const name of ['antigravity-booster', 'adlc-antigravity']) {
    const dir = join(home, '.gemini', 'config', 'plugins', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  return home;
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

async function runWith(mode) {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-integrity-state-'));
  try {
    const report = await withEnv({
      HOME: home, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_BUILDER_MODE: mode, FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo, gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));
    return report;
  } finally {
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
}

test('a clean worker passes the integrity check and merges', async () => {
  const report = await runWith('good');
  assert.deepEqual(report.merged, ['T1']);
  assert.equal(report.compromised ?? null, null);
});


test('a worker that re-enables hooks in its own worktree compromises the run', async () => {
  const report = await runWith('tamper-worktree-hooks');
  assert.equal(report.merged.length, 0);
  assert.match(report.failed.T1, /run compromised: .*worktree core\.hooksPath changed/);
  assert.match(report.compromised, /worktree core\.hooksPath changed/);
});

// Host-side tampers (a planted host hook, an edited staged plugin) cannot be
// reached by a fake worker: builder containment already blocks those writes.
// The check exists for weaker sandboxes and escapes, so its detection is
// proven directly against the host; the wiring above proves a detection
// compromises the run.
function hostFixture() {
  const repo = makeRepo();
  const home = makeHome();
  const base = snapshotRunIntegrity({ cwd: repo, home });
  assert.equal(base.ok, true, base.error);
  return { repo, home, base: base.snapshot, done: () => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

test('verifyRunIntegrity: an untouched host verifies ok', () => {
  const f = hostFixture();
  try {
    assert.deepEqual(verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home }), { ok: true });
  } finally { f.done(); }
});

test('verifyRunIntegrity: a planted host git hook is detected', () => {
  const f = hostFixture();
  try {
    writeFileSync(join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(), /git hooks dir .* changed/);
  } finally { f.done(); }
});

test('verifyRunIntegrity: a host core.hooksPath redirect is detected', () => {
  const f = hostFixture();
  try {
    git(f.repo, 'config', 'core.hooksPath', join(f.repo, 'evil-hooks'));
    const r = verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home });
    assert.match(r.reasons.join(), /git hooks dir redirected/);
  } finally { f.done(); }
});

for (const name of ['antigravity-booster', 'adlc-antigravity']) {
  test(`verifyRunIntegrity: an edit to staged plugin ${name} is detected`, () => {
    const f = hostFixture();
    try {
      writeFileSync(join(f.home, '.gemini', 'config', 'plugins', name, 'planted.txt'), 'pwned');
      const r = verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home });
      assert.deepEqual(r.reasons, [`staged plugin ${name} changed`]);
    } finally { f.done(); }
  });
}

test('verifyRunIntegrity: a staged plugin that appears mid-run is detected', () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), 'agb-integrity-empty-home-'));
  try {
    const base = snapshotRunIntegrity({ cwd: repo, home }).snapshot;
    assert.equal(base.plugins['adlc-antigravity'], ABSENT);
    mkdirSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity', 'plugin.json'), '{}');
    assert.deepEqual(verifyRunIntegrity(base, { cwd: repo, home }).reasons, ['staged plugin adlc-antigravity changed']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyRunIntegrity: worktree hooksPath must still equal the expected null path', () => {
  const f = hostFixture();
  const wt = makeRepo();
  try {
    git(wt, 'config', 'core.hooksPath', '/dev/null');
    assert.deepEqual(verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home, worktree: wt, worktreeHooksPath: '/dev/null' }), { ok: true });
    git(wt, 'config', '--unset', 'core.hooksPath');
    assert.match(verifyRunIntegrity(f.base, { cwd: f.repo, home: f.home, worktree: wt, worktreeHooksPath: '/dev/null' }).reasons.join(), /found unset/);
  } finally { f.done(); rmSync(wt, { recursive: true, force: true }); }
});

test('diffRunIntegrity: a core.hooksPath redirect is reported even when the new dir is empty', () => {
  const before = { plugins: { a: 'x' }, hooks: { path: '/r/.git/hooks', digest: ABSENT } };
  const after = { plugins: { a: 'x' }, hooks: { path: '/elsewhere', digest: ABSENT } };
  assert.deepEqual(diffRunIntegrity(before, after), ['git hooks dir redirected (/r/.git/hooks -> /elsewhere)']);
  assert.deepEqual(diffRunIntegrity(before, before), []);
});

test('verifyRunIntegrity: an unverifiable state (not a git dir) is compromised, never silently ok', () => {
  const home = makeHome();
  const notGit = mkdtempSync(join(tmpdir(), 'agb-not-git-'));
  try {
    const repo = makeRepo();
    const base = snapshotRunIntegrity({ cwd: repo, home });
    assert.equal(base.ok, true, base.error);
    const r = verifyRunIntegrity(base.snapshot, { cwd: notGit, home });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /integrity snapshot failed/);
    rmSync(repo, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(notGit, { recursive: true, force: true });
  }
});

test('a tamper after the builder check but before merge (here: a gate script) still blocks merge', async () => {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-integrity-state-'));
  try {
    const hook = join(repo, '.git', 'hooks', 'post-merge');
    const report = await withEnv({
      HOME: home, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo, gate: { test: `printf '#!/bin/sh\\n' > '${hook}'` },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));
    assert.equal(report.merged.length, 0, 'the merge-time re-check caught the late tamper');
    assert.match(report.failed.T1, /run compromised: .*git hooks dir/);
  } finally {
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
});

test('a tamper that no per-ticket check observes is still reported as compromised', async () => {
  const repo = makeRepo();
  const home = makeHome();
  const state = mkdtempSync(join(tmpdir(), 'agb-integrity-state-'));
  try {
    const plugin = join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity', 'late.txt');
    // The gate always fails (no merge, so integrate never re-checks) and edits a
    // staged plugin only on its final run, after every per-attempt check.
    const counter = join(state, 'gate-runs');
    const report = await withEnv({
      HOME: home, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0',
    }, () => runPlan({
      repo, gate: { test: `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; [ "$n" -ge 2 ] && echo x > '${plugin}'; exit 1` },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, quiet));
    assert.equal(report.merged.length, 0);
    assert.match(report.compromised, /staged plugin adlc-antigravity changed/);
    assert.doesNotMatch(report.failed.T1, /run compromised/, 'only the final check could have seen it');
  } finally {
    for (const d of [repo, home, state]) rmSync(d, { recursive: true, force: true });
  }
});
