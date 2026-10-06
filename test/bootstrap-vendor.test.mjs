// T-PLUGIN-01-CORE: `agb bootstrap` installs the integrity-pinned vendored
// @adlc/antigravity (when absent or --force-reinstall) and the D3 terminal
// shim ~/.local/bin/agb. Every run uses a temp HOME + test/fixtures/fake-agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { TERMINAL_SHIM_CONTENT } from '../lib/plugin-paths.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const BOOTSTRAP_URL = new URL('../lib/bootstrap.mjs', import.meta.url).href;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agb-bootvendor-'));
  const home = join(root, 'home');
  const dest = join(root, 'skills');
  const state = join(root, 'state');
  for (const d of [home, dest, state]) mkdirSync(d);
  return { root, home, dest, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runBootstrap({ home, dest, state }, opts = {}, env = {}) {
  const args = JSON.stringify({ destination: dest, home, agyBin: FAKE_AGY, ...opts });
  const childEnv = { ...process.env, FAKE_STATE_DIR: state, ...env };
  delete childEnv.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  delete childEnv.AGB_PROVIDER;
  const r = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    `import('${BOOTSTRAP_URL}').then(({ bootstrap }) => bootstrap(${args}))`,
  ], { encoding: 'utf8', env: childEnv });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const stagedAdlc = (home) => join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity');
const shimPath = (home) => join(home, '.local', 'bin', 'agb');
const installs = (state) => {
  const f = join(state, 'plugin-installs');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
};

test('bootstrap: fresh HOME installs vendored adlc-antigravity 1.7.0 and writes the 0755 shim', () => {
  const ctx = setup();
  try {
    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(readFileSync(join(stagedAdlc(ctx.home), 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, '1.7.0');
    assert.match(r.stdout, /installed adlc-antigravity plugin — plugin contract 1/);
    assert.ok(installs(ctx.state)[0].endsWith('/adlc-antigravity'), 'agy got the staged adlc-antigravity copy');

    assert.equal(readFileSync(shimPath(ctx.home), 'utf8'), TERMINAL_SHIM_CONTENT);
    assert.equal(statSync(shimPath(ctx.home)).mode & 0o777, 0o755);
    assert.match(r.stdout, /installed terminal shim/);
  } finally {
    ctx.cleanup();
  }
});

test('bootstrap: an already-staged adlc-antigravity is left alone (notice) unless --force-reinstall', () => {
  const ctx = setup();
  try {
    mkdirSync(stagedAdlc(ctx.home), { recursive: true });
    writeFileSync(join(stagedAdlc(ctx.home), 'plugin.json'),
      JSON.stringify({ name: 'adlc-antigravity', version: '9.9.9', adlcContract: 1 }));

    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /notice: adlc-antigravity is already installed/);
    assert.ok(!installs(ctx.state).some((p) => p.endsWith('/adlc-antigravity')), 'no adlc reinstall');
    assert.equal(JSON.parse(readFileSync(join(stagedAdlc(ctx.home), 'plugin.json'), 'utf8')).version, '9.9.9');

    const forced = runBootstrap(ctx, { forceReinstall: true });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(readFileSync(join(stagedAdlc(ctx.home), 'plugin.json'), 'utf8')).version, '1.7.0');
  } finally {
    ctx.cleanup();
  }
});

test('bootstrap: a foreign ~/.local/bin/agb is preserved (warned) unless --force-reinstall; identical is a no-op', () => {
  const ctx = setup();
  try {
    mkdirSync(join(ctx.home, '.local', 'bin'), { recursive: true });
    writeFileSync(shimPath(ctx.home), '#!/bin/sh\necho mine\n', { mode: 0o755 });

    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(shimPath(ctx.home), 'utf8'), '#!/bin/sh\necho mine\n');
    assert.match(r.stderr, /exists with different content/);

    const forced = runBootstrap(ctx, { forceReinstall: true });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(readFileSync(shimPath(ctx.home), 'utf8'), TERMINAL_SHIM_CONTENT);

    const again = runBootstrap(ctx);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /terminal shim .* \(already current\)/);
  } finally {
    ctx.cleanup();
  }
});

test('bootstrap: a failing vendored install exits 1 but still writes the shim', () => {
  const ctx = setup();
  try {
    const r = runBootstrap(ctx, {}, { FAKE_AGY_PLUGIN_MODE: 'fail' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /failed to install adlc-antigravity/);
    assert.ok(!existsSync(join(stagedAdlc(ctx.home), 'plugin.json')));
    assert.equal(readFileSync(shimPath(ctx.home), 'utf8'), TERMINAL_SHIM_CONTENT);
  } finally {
    ctx.cleanup();
  }
});

test('bootstrap: an explicit pluginPath bypasses the vendored tarball (source/test seam)', () => {
  const ctx = setup();
  try {
    const plugin = join(ctx.root, 'explicit-plugin');
    mkdirSync(plugin);
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'adlc-antigravity', version: '0.0.1', adlcContract: 1 }));
    const r = runBootstrap(ctx, { pluginPath: plugin });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('vendored release tarball'));
    assert.equal(installs(ctx.state)[0], '.', 'legacy installPlugin path used');
  } finally {
    ctx.cleanup();
  }
});

test('resolveBoosterPluginPath: resolves the antigravity-booster plugin root, never the .agents/plugins/agb legacy shim', async () => {
  const { resolveBoosterPluginPath } = await import('../lib/bootstrap.mjs');
  const { realpathSync } = await import('node:fs');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const got = resolveBoosterPluginPath();
  assert.equal(realpathSync(got), realpathSync(repoRoot));
  assert.ok(!got.includes(join('.agents', 'plugins', 'agb')));
  assert.equal(JSON.parse(readFileSync(join(got, 'plugin.json'), 'utf8')).name, 'antigravity-booster');
});

// Appendix A.4 item 19 / A.6 item 16 (P5 prosecution gap): booster itself is
// staged through safePluginInstall — a copy under the canonical name with no
// node_modules/, .worktrees/ or .git/.
test('bootstrap: booster is staged as antigravity-booster from an excluded copy', () => {
  const ctx = setup();
  try {
    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    const staged = join(ctx.home, '.gemini', 'config', 'plugins', 'antigravity-booster');
    assert.equal(JSON.parse(readFileSync(join(staged, 'plugin.json'), 'utf8')).name, 'antigravity-booster');
    for (const excluded of ['node_modules', '.git', '.worktrees']) {
      assert.equal(existsSync(join(staged, excluded)), false, `${excluded} must not be staged`);
    }
    assert.ok(existsSync(join(staged, 'dist', 'hooks', 'pre-tool-use.bundle.mjs')), 'bundles are staged');
    const boosterInstall = installs(ctx.state).find((l) => l.endsWith('/antigravity-booster'));
    assert.ok(boosterInstall, 'agy was handed the staged copy named antigravity-booster');
    assert.doesNotMatch(boosterInstall, /\.worktrees\/t-plugin-01$/, 'never the live checkout itself');
  } finally {
    ctx.cleanup();
  }
});
