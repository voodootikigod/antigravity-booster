import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPluginContract, SUPPORTED_PLUGIN_CONTRACT } from '../lib/adlc-bridge.mjs';
import { runPlan, checkEnforcementAvailable } from '../lib/scheduler.mjs';
import { bootstrap } from '../lib/bootstrap.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_handshake_test_${process.pid}.json`);

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
const PLUGIN_INCOMPATIBLE = FIX('plugin-incompatible'); // adlcContract 2 (> supported)
const PLUGIN_INCOMPATIBLE_OLD = FIX('plugin-incompatible-old'); // adlcContract 0 (< supported)
const PLUGIN_MISSING_FIELD = FIX('plugin-missing-field');
const PLUGIN_MALFORMED = FIX('plugin-malformed');

// Synchronous env swap for the sync checkEnforcementAvailable unit tests.
function withEnvSync(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

function makeMinimalAdlcRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-enforce-'));
  mkdirSync(join(dir, '.adlc'));
  return dir;
}

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
    { status: 'compatible', contract: SUPPORTED_PLUGIN_CONTRACT, version: '1.2.0' },
  );
});

test('readPluginContract: present integer != supported → incompatible (loud-abort signal)', () => {
  const r = readPluginContract({ dir: PLUGIN_INCOMPATIBLE });
  assert.equal(r.status, 'incompatible');
  assert.equal(Number.isInteger(r.contract), true);
  assert.notEqual(r.contract, SUPPORTED_PLUGIN_CONTRACT);
});

test('readPluginContract: no adlcContract field (older plugin) → tolerant (degrade)', () => {
  assert.equal(readPluginContract({ dir: PLUGIN_MISSING_FIELD }).status, 'tolerant');
});

test('readPluginContract: absent manifest → unreadable (degrade), never throws', () => {
  const r = readPluginContract({ dir: join(PLUGIN_COMPATIBLE, 'does-not-exist') });
  assert.equal(r.status, 'unreadable');
  assert.ok(r.error, 'carries an error string for the warn message');
});

test('readPluginContract: malformed JSON manifest → corrupt (degrade), never throws', () => {
  const r = readPluginContract({ dir: PLUGIN_MALFORMED });
  assert.equal(r.status, 'corrupt');
  assert.ok(r.error);
});

test('readPluginContract: every status is one of PLUGIN_CONTRACT_STATUSES (spec §4.4 flat enum)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { PLUGIN_CONTRACT_STATUSES } = await import('../lib/adlc-bridge.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'agb-contract-'));
  const status = (manifest) => {
    writeFileSync(join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    return readPluginContract({ dir }).status;
  };
  try {
    assert.equal(status({ name: 'a', version: '1.7.0', adlcContract: 1 }), 'compatible');
    assert.equal(status({ name: 'a', version: '1.7.0' }), 'tolerant');
    assert.equal(status({ name: 'a', version: '1.7.0', adlcContract: 2 }), 'incompatible');
    assert.equal(status({ name: 'a', version: '1.7.0', adlcContract: '1' }), 'incompatible', 'present but not === 1');
    assert.equal(status({ name: 'a', adlcContract: 1 }), 'corrupt', 'missing version');
    assert.equal(status({ name: 'a', version: '1.7', adlcContract: 1 }), 'corrupt', 'non-semver version');
    assert.equal(status('[1,2]'), 'corrupt', 'non-object manifest');
    for (const s of ['compatible', 'tolerant', 'incompatible', 'corrupt']) assert.ok(PLUGIN_CONTRACT_STATUSES.includes(s));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no source still uses the retired missing-field status', async () => {
  const { spawnSync } = await import('node:child_process');
  // grep exits 1 when nothing matches: that is the passing case.
  const r = spawnSync('grep', ['-rln', 'missing-field', 'lib', 'bin', 'mcp', 'hooks'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 1, `still referenced in: ${r.stdout}`);
});

test('readPluginContract: AGB_PLUGIN_DIR overrides the default base dir', () =>
  withEnv({ AGB_PLUGIN_DIR: PLUGIN_INCOMPATIBLE }, async () => {
    assert.equal(readPluginContract().status, 'incompatible');
  }));

// --- checkEnforcementAvailable: the run-level decision (lib/scheduler.mjs) ---

test('checkEnforcementAvailable: compatible contract → available:true, no abort', () => {
  const repo = makeMinimalAdlcRepo();
  try {
    const r = withEnvSync({ AGB_PLUGIN_DIR: PLUGIN_COMPATIBLE }, () => checkEnforcementAvailable(repo));
    assert.deepEqual(r, { available: true, reason: null });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkEnforcementAvailable: incompatible NEWER plugin → abort, available:false, "upgrade booster"', () => {
  const repo = makeMinimalAdlcRepo();
  try {
    const r = withEnvSync({ AGB_PLUGIN_DIR: PLUGIN_INCOMPATIBLE }, () => checkEnforcementAvailable(repo));
    assert.equal(r.available, false, 'an incompatible contract is never "available"');
    assert.equal(r.abort, true, 'incompatible signals a loud abort, not a silent degrade');
    assert.match(r.reason, /adlcContract 2/);
    // contract 2 > supported 1 → the booster is behind → tell the user to upgrade IT.
    assert.match(r.reason, /Upgrade antigravity-booster/);
    assert.doesNotMatch(r.reason, /Upgrade the adlc-antigravity plugin/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkEnforcementAvailable: incompatible OLDER plugin → abort, "upgrade the plugin" (opposite remedy)', () => {
  const repo = makeMinimalAdlcRepo();
  try {
    const r = withEnvSync({ AGB_PLUGIN_DIR: PLUGIN_INCOMPATIBLE_OLD }, () => checkEnforcementAvailable(repo));
    assert.equal(r.available, false);
    assert.equal(r.abort, true);
    // contract 0 < supported 1 → the plugin is behind → tell the user to upgrade IT
    // (the comparison direction is load-bearing, not cosmetic).
    assert.match(r.reason, /Upgrade the adlc-antigravity plugin/);
    assert.doesNotMatch(r.reason, /Upgrade antigravity-booster/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkEnforcementAvailable: missing field → degrade (available:false, no abort)', () => {
  const repo = makeMinimalAdlcRepo();
  try {
    const r = withEnvSync({ AGB_PLUGIN_DIR: PLUGIN_MISSING_FIELD }, () => checkEnforcementAvailable(repo));
    assert.equal(r.available, false);
    assert.notEqual(r.abort, true, 'an older plugin degrades, it does not abort');
    assert.match(r.reason, /adlcContract/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkEnforcementAvailable: non-ADLC repo returns before ever reading a manifest', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-noadlc-')); // no .adlc/
  try {
    // Point AGB_PLUGIN_DIR at an INCOMPATIBLE manifest to prove it is never read
    // here — the .adlc/ guard short-circuits first, so no abort.
    const r = withEnvSync({ AGB_PLUGIN_DIR: PLUGIN_INCOMPATIBLE }, () => checkEnforcementAvailable(repo));
    assert.equal(r.available, false);
    assert.notEqual(r.abort, true);
    assert.match(r.reason, /not ADLC-initialized/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

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

test('bootstrap: incompatible installed plugin contract aborts loudly (exit 1)', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-handshake-bootstrap-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'agb-handshake-home-'));
  try {
    let thrown;
    try {
      execFileSync(process.execPath, [
        '-e',
        `import('${new URL('../lib/bootstrap.mjs', import.meta.url)}').then(({ bootstrap }) => ` +
          `bootstrap({ destination: '${destDir}', home: '${homeDir}', pluginPath: '${PLUGIN_INCOMPATIBLE}', agyBin: '${FAKE_AGY}' }))`,
      ], { stdio: 'pipe' });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'an incompatible plugin contract must not install silently');
    // Exit 1 specifically — the booster's actionable-failure code, distinct
    // from an internal crash. Asserting the value (not merely non-zero) keeps
    // the abort's exit code load-bearing.
    assert.equal(thrown.status, 1, 'aborts with exit 1');
  } finally {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('bootstrap: compatible installed plugin contract completes (links booster skills)', () => {
  const destDir = mkdtempSync(join(tmpdir(), 'agb-handshake-bootstrap-ok-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'agb-handshake-home-'));
  try {
    bootstrap({ destination: destDir, home: homeDir, pluginPath: PLUGIN_COMPATIBLE, agyBin: FAKE_AGY, force: true });
    assert.ok(existsSync(join(destDir, 'agb')), 'booster-owned skills still installed');
    assert.equal(existsSync(join(destDir, 'release')), false, 'internal release skill not exposed');
  } finally {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('checkEnforcementAvailable: recognizes adlc-gemini when adlc-antigravity is absent and AGB_PLUGIN_DIR is unset', () => {
  const repo = makeMinimalAdlcRepo();
  const home = mkdtempSync(join(tmpdir(), 'agb-gemini-handshake-'));
  try {
    const geminiDir = join(home, '.gemini', 'config', 'plugins', 'adlc-gemini');
    mkdirSync(geminiDir, { recursive: true });

    // 1. Compatible adlc-gemini (contract 1) -> available: true in unbundled mode;
    //    bundled mode strictly requires the pinned/bundled adlc-antigravity companion and does NOT fall back to unverified adlc-gemini
    writeFileSync(join(geminiDir, 'plugin.json'), JSON.stringify({ name: 'adlc-gemini', version: '1.13.0', adlcContract: 1 }));
    assert.deepEqual(checkEnforcementAvailable(repo, { home, env: {}, bundled: false }), { available: true, reason: null });
    const bundledOnlyGemini = checkEnforcementAvailable(repo, { home, env: { AGB_PLUGIN_DIR: '/ignored' }, bundled: true });
    assert.equal(bundledOnlyGemini.available, false, 'bundled mode must not trust unverified adlc-gemini');
    assert.match(bundledOnlyGemini.reason, /adlc-antigravity plugin manifest unreadable/);

    // 2. Explicit AGB_PLUGIN_DIR in unbundled mode does NOT fall back to adlc-gemini
    const explicitMissing = checkEnforcementAvailable(repo, { home, env: { AGB_PLUGIN_DIR: join(home, 'missing') }, bundled: false });
    assert.equal(explicitMissing.available, false);
    assert.match(explicitMissing.reason, /adlc-antigravity plugin manifest unreadable/);

    // 3. Incompatible adlc-gemini (< supported and > supported) -> loud abort naming adlc-gemini
    writeFileSync(join(geminiDir, 'plugin.json'), JSON.stringify({ name: 'adlc-gemini', version: '1.13.0', adlcContract: 0 }));
    const older = checkEnforcementAvailable(repo, { home, env: {}, bundled: false });
    assert.equal(older.available, false);
    assert.equal(older.abort, true);
    assert.match(older.reason, /Upgrade the adlc-gemini plugin/);

    writeFileSync(join(geminiDir, 'plugin.json'), JSON.stringify({ name: 'adlc-gemini', version: '2.0.0', adlcContract: 2 }));
    const newer = checkEnforcementAvailable(repo, { home, env: {}, bundled: false });
    assert.equal(newer.available, false);
    assert.equal(newer.abort, true);
    assert.match(newer.reason, /Upgrade antigravity-booster/);

    // 4. Tolerant and corrupt adlc-gemini degrade cleanly
    writeFileSync(join(geminiDir, 'plugin.json'), JSON.stringify({ name: 'adlc-gemini', version: '1.13.0' }));
    const tolerant = checkEnforcementAvailable(repo, { home, env: {}, bundled: false });
    assert.equal(tolerant.available, false);
    assert.notEqual(tolerant.abort, true);
    assert.match(tolerant.reason, /installed adlc-gemini plugin manifest declares no adlcContract/);

    writeFileSync(join(geminiDir, 'plugin.json'), '{bad-json');
    const corrupt = checkEnforcementAvailable(repo, { home, env: {}, bundled: false });
    assert.equal(corrupt.available, false);
    assert.match(corrupt.reason, /adlc-gemini plugin manifest unreadable/);

    // 5. When adlc-antigravity IS installed alongside adlc-gemini, adlc-antigravity takes precedence;
    //    if adlc-antigravity/plugin.json is present but unreadable (e.g. EISDIR directory), do NOT mask it by falling back to adlc-gemini!
    writeFileSync(join(geminiDir, 'plugin.json'), JSON.stringify({ name: 'adlc-gemini', version: '1.13.0', adlcContract: 1 }));
    const antigravityDir = join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity');
    mkdirSync(join(antigravityDir, 'plugin.json'), { recursive: true });
    const brokenPrimary = checkEnforcementAvailable(repo, { home, env: {}, bundled: false });
    assert.equal(brokenPrimary.available, false, 'present-but-unreadable primary plugin must not silently fall back to adlc-gemini');
    assert.match(brokenPrimary.reason, /adlc-antigravity plugin manifest unreadable/);

    rmSync(join(antigravityDir, 'plugin.json'), { recursive: true, force: true });
    writeFileSync(join(antigravityDir, 'plugin.json'), JSON.stringify({ name: 'adlc-antigravity', version: '1.7.0', adlcContract: 1 }));
    assert.deepEqual(checkEnforcementAvailable(repo, { home, env: {}, bundled: false }), { available: true, reason: null });

    // 6. Malformed plugins path (regular file causing ENOTDIR) degrades cleanly instead of throwing
    const badHome = mkdtempSync(join(tmpdir(), 'agb-bad-plugins-file-'));
    try {
      mkdirSync(join(badHome, '.gemini', 'config'), { recursive: true });
      writeFileSync(join(badHome, '.gemini', 'config', 'plugins'), 'not-a-directory');
      const degraded = checkEnforcementAvailable(repo, { home: badHome, env: {}, bundled: false });
      assert.equal(degraded.available, false);
      assert.notEqual(degraded.abort, true);
      assert.match(degraded.reason, /adlc-antigravity plugin manifest unreadable/);
    } finally {
      rmSync(badHome, { recursive: true, force: true });
    }

    // 7. AGB_HOME_DIR overrides os.homedir() so handshake matches stageBuilderGeminiHome
    const emptyCustomHome = mkdtempSync(join(tmpdir(), 'agb-empty-custom-home-'));
    try {
      const viaAgbHomeEmpty = checkEnforcementAvailable(repo, { env: { AGB_HOME_DIR: emptyCustomHome }, bundled: false });
      assert.equal(viaAgbHomeEmpty.available, false, 'empty AGB_HOME_DIR must not falsely report enforcement from real HOME');
      const viaAgbHomePresent = checkEnforcementAvailable(repo, { env: { AGB_HOME_DIR: home }, bundled: false });
      assert.deepEqual(viaAgbHomePresent, { available: true, reason: null });
    } finally {
      rmSync(emptyCustomHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
