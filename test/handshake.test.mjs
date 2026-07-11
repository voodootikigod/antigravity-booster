import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPluginContract, SUPPORTED_PLUGIN_CONTRACT } from '../lib/adlc-bridge.mjs';
import { runPlan } from '../lib/scheduler.mjs';
import { bootstrap } from '../lib/bootstrap.mjs';

// B12: the booster verifies the INSTALLED adlc-antigravity plugin speaks the
// same tickets/hook contract it projects, via the plugin manifest's
// `adlcContract` integer — replacing the old stdout.includes('adlc-antigravity')
// substring match that proved a plugin was *named* but never that its schema
// *matched*. Contract handling (from lib/adlc-bridge.mjs / lib/scheduler.mjs):
//   compatible (adlcContract === supported) → live enforcement available
//   incompatible (present integer !== supported) → abort the run LOUDLY before
//     any repo mutation (upgrade one side or the other)
//   missing field (older plugin) → warn + degrade to enforcement-unavailable
//   unreadable/absent manifest → warn + degrade (never crash)

const FIX = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const FAKE_AGY = FIX('fake-agy');
const PLUGIN_COMPATIBLE = FIX('plugin-compatible');
const PLUGIN_INCOMPATIBLE = FIX('plugin-incompatible');
const PLUGIN_MISSING_FIELD = FIX('plugin-missing-field');
const PLUGIN_MALFORMED = FIX('plugin-malformed');

function makeAdlcRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-handshake-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  // Throwaway repos must not depend on the developer's commit-signing setup.
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  // ADLC-initialized so runPlan reaches the plugin contract handshake (a
  // non-.adlc/ target returns 'not ADLC-initialized' before the manifest read).
  mkdirSync(join(dir, '.adlc'));
  return dir;
}

function headOf(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

const quiet = { log: () => {} };
const oneTicket = [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }];

// --- readPluginContract: the pure classifier (lib/adlc-bridge.mjs) ---

test('readPluginContract: adlcContract === supported → compatible', () => {
  assert.deepEqual(
    readPluginContract({ dir: PLUGIN_COMPATIBLE }),
    { status: 'compatible', contract: SUPPORTED_PLUGIN_CONTRACT },
  );
});

test('readPluginContract: present integer != supported → incompatible (loud-abort signal)', () => {
  const r = readPluginContract({ dir: PLUGIN_INCOMPATIBLE });
  assert.equal(r.status, 'incompatible');
  assert.equal(Number.isInteger(r.contract), true);
  assert.notEqual(r.contract, SUPPORTED_PLUGIN_CONTRACT);
});

test('readPluginContract: no adlcContract field (older plugin) → missing-field (degrade)', () => {
  assert.equal(readPluginContract({ dir: PLUGIN_MISSING_FIELD }).status, 'missing-field');
});

test('readPluginContract: absent manifest → unreadable (degrade), never throws', () => {
  const r = readPluginContract({ dir: join(PLUGIN_COMPATIBLE, 'does-not-exist') });
  assert.equal(r.status, 'unreadable');
  assert.ok(r.error, 'carries an error string for the warn message');
});

test('readPluginContract: malformed JSON manifest → unreadable (degrade), never throws', () => {
  assert.equal(readPluginContract({ dir: PLUGIN_MALFORMED }).status, 'unreadable');
});

test('readPluginContract: AGB_PLUGIN_DIR overrides the default base dir', () =>
  withEnv({ AGB_PLUGIN_DIR: PLUGIN_INCOMPATIBLE }, async () => {
    assert.equal(readPluginContract().status, 'incompatible');
  }));

// --- runPlan: compatible plugin → live enforcement available, run proceeds ---

test('handshake: compatible plugin contract → enforcement available, run succeeds', async () => {
  const repo = makeAdlcRepo();
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE, AGB_SANDBOX_GATES: '0' },
      () => runPlan({ repo, gate: { test: 'true' }, tickets: oneTicket }, quiet),
    );
    assert.equal(report.enforcementAvailable, true, report.enforcementReason);
    assert.deepEqual(report.merged, ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- runPlan: incompatible plugin → abort BEFORE any repo mutation ---

test('handshake: incompatible plugin contract → run aborts loudly before any repo mutation', async () => {
  const repo = makeAdlcRepo();
  try {
    const headBefore = headOf(repo);
    await assert.rejects(
      withEnv(
        { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_INCOMPATIBLE, AGB_SANDBOX_GATES: '0' },
        () => runPlan({ repo, gate: { test: 'true' }, tickets: oneTicket }, quiet),
      ),
      (err) => {
        assert.match(err.message, /adlcContract 2/, 'names the installed contract');
        assert.match(err.message, new RegExp(`contract ${SUPPORTED_PLUGIN_CONTRACT}`), 'names the supported contract');
        assert.match(err.message, /upgrade/i, 'gives an actionable remedy');
        return true;
      },
    );
    // No repo mutation: the abort happens before the lock, the .gitignore
    // commit, and any worktree.
    assert.equal(headOf(repo), headBefore, 'no .gitignore commit (HEAD unchanged)');
    assert.equal(existsSync(join(repo, '.booster')), false, 'no lock dir / .booster mutation');
    assert.equal(existsSync(join(repo, '.worktrees')), false, 'no worktrees created');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- runPlan: older/absent plugin → warn + degrade, run still proceeds ---

test('handshake: missing adlcContract field (older plugin) → degrade to enforcement-unavailable, run succeeds', async () => {
  const repo = makeAdlcRepo();
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_MISSING_FIELD, AGB_SANDBOX_GATES: '0' },
      () => runPlan({ repo, gate: { test: 'true' }, tickets: oneTicket }, quiet),
    );
    assert.equal(report.enforcementAvailable, false);
    assert.match(report.enforcementReason, /adlcContract/, 'reason names the missing contract field');
    assert.deepEqual(report.merged, ['T1'], 'degrades — the build still runs');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('handshake: unreadable/absent manifest → degrade to enforcement-unavailable, run succeeds', async () => {
  const repo = makeAdlcRepo();
  try {
    const report = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: join(PLUGIN_COMPATIBLE, 'nope'), AGB_SANDBOX_GATES: '0' },
      () => runPlan({ repo, gate: { test: 'true' }, tickets: oneTicket }, quiet),
    );
    assert.equal(report.enforcementAvailable, false);
    assert.match(report.enforcementReason, /manifest|not installed/i);
    assert.deepEqual(report.merged, ['T1'], 'degrades — the build still runs');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('handshake: warns (does not silently proceed) when enforcement degrades on a missing contract field', async () => {
  const repo = makeAdlcRepo();
  const logs = [];
  try {
    await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_PLUGIN_DIR: PLUGIN_MISSING_FIELD, AGB_SANDBOX_GATES: '0' },
      () => runPlan({ repo, gate: { test: 'true' }, tickets: oneTicket }, { log: (m) => logs.push(m) }),
    );
    assert.ok(
      logs.some((l) => /enforcement unavailable/i.test(l)),
      'a non-silent warning is emitted so callers need not dig through logs',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- bootstrap: the second call site aborts on incompatible, degrades otherwise ---

test('bootstrap: incompatible installed plugin contract aborts loudly (non-zero exit)', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-handshake-bootstrap-'));
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [
        '-e',
        `import('${new URL('../lib/bootstrap.mjs', import.meta.url)}').then(({ bootstrap }) => ` +
          `bootstrap({ destination: '${destDir}', pluginPath: '${PLUGIN_INCOMPATIBLE}', agyBin: '${FAKE_AGY}' }))`,
      ], { stdio: 'pipe' });
    }, /Command failed/, 'an incompatible plugin contract surfaces as a non-zero exit, not a silent install');
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test('bootstrap: compatible installed plugin contract completes (links booster skills)', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-handshake-bootstrap-ok-'));
  try {
    bootstrap({ destination: destDir, pluginPath: PLUGIN_COMPATIBLE, agyBin: FAKE_AGY, force: true });
    assert.ok(existsSync(join(destDir, 'release')), 'booster-owned skills still installed');
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});
