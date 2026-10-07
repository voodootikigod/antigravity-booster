// T-PLUGIN-02: vendored adlc as the exclusive tier in bundled mode, digest
// pinning, and fail-closed tamper handling (spec §4.2, Appendix A D12, A.6 12–13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveAdlcBinary, KNOWN_VENDORED_ADLC, STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS } from '../lib/adlc-bridge.mjs';
import { computeDirectoryDigest } from '../lib/digest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-bundled-')));
test.after(() => rmSync(base, { recursive: true, force: true }));

function fakePluginRoot(name, { vendor = true } = {}) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'antigravity-booster', version: '0.8.0' }));
  if (vendor) cpSync(join(ROOT, 'vendor', 'adlc'), join(root, 'vendor', 'adlc'), { recursive: true });
  return root;
}

test('importing the bridge unbundled does not throw (no ReferenceError on __AGB_BUNDLED__)', async () => {
  await assert.doesNotReject(import('../lib/adlc-bridge.mjs'));
});

test('KNOWN_VENDORED_ADLC pins the committed vendor/adlc exactly', () => {
  assert.equal(KNOWN_VENDORED_ADLC.version, '1.11.1');
  assert.equal(computeDirectoryDigest(join(ROOT, 'vendor', 'adlc')), KNOWN_VENDORED_ADLC.treeDigest);
});

test('Tier 1: a pristine vendored adlc resolves with source "vendored"', () => {
  const root = fakePluginRoot('pristine');
  const r = resolveAdlcBinary({ repo: base, env: {}, pluginRoot: root });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, 'vendored');
  assert.equal(r.version, '1.11.1');
  assert.equal(r.binary, join(root, 'vendor', 'adlc', 'bin', 'adlc.mjs'));
});

test('Tier 1: a tampered vendored bundle fails closed without falling through', () => {
  const root = fakePluginRoot('tampered');
  appendFileSync(join(root, 'vendor', 'adlc', 'dist', 'adlc.bundle.mjs'), '\n// tampered\n');
  const r = resolveAdlcBinary({ repo: ROOT, env: {}, pluginRoot: root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vendored-adlc-tampered');
});

test('Tier 1: a missing required vendored file fails closed', () => {
  const root = fakePluginRoot('partial');
  rmSync(join(root, 'vendor', 'adlc', 'bin', 'adlc.mjs'));
  const r = resolveAdlcBinary({ repo: ROOT, env: {}, pluginRoot: root });
  assert.deepEqual([r.ok, r.error], [false, 'vendored-adlc-tampered']);
});

test('bundled mode: every override is ignored and only the vendored tier is consulted', () => {
  const root = fakePluginRoot('bundled');
  const env = {
    ADLC_CLI_PATH: '/usr/bin/true', AGB_ADLC_BIN: '/usr/bin/true', AGB_ALLOW_CUSTOM_ADLC_CLI: '1', AGB_ALLOW_SYSTEM_ADLC: '1', AGB_DEV_MODE: '1',
  };
  const r = resolveAdlcBinary({ repo: ROOT, env, pluginRoot: root, bundled: true });
  assert.equal(r.source, 'vendored');
  const empty = fakePluginRoot('bundled-no-vendor', { vendor: false });
  const none = resolveAdlcBinary({ repo: ROOT, env, pluginRoot: empty, bundled: true });
  assert.equal(none.ok, false, 'no vendor/adlc in bundled mode halts instead of falling through');
  assert.match(none.error, /vendored adlc missing/);
});

test('bundled mode ignores a caller-supplied pluginRoot override path via env', () => {
  const root = fakePluginRoot('env-root');
  const r = resolveAdlcBinary({ repo: ROOT, env: { AGB_PLUGIN_DIR: '/tmp/evil' }, pluginRoot: root, bundled: true });
  assert.equal(r.source, 'vendored');
});

test('system PATH is never used unless AGB_ALLOW_SYSTEM_ADLC=1 (unbundled, no vendor)', () => {
  const root = fakePluginRoot('dev-no-vendor', { vendor: false });
  const r = resolveAdlcBinary({ repo: base, env: { PATH: process.env.PATH }, pluginRoot: root });
  assert.notEqual(r.source, 'system');
});

test('STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS records the 1.7.0 extracted-tarball digest for T3', () => {
  assert.match(STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS['1.7.0'], /^[0-9a-f]{64}$/);
});

test('pluginManifestDir: AGB_PLUGIN_DIR is honoured unbundled and ignored bundled', async () => {
  const { pluginManifestDir } = await import('../lib/adlc-bridge.mjs');
  assert.equal(pluginManifestDir({ env: { AGB_PLUGIN_DIR: '/x' }, bundled: false }), '/x');
  assert.match(pluginManifestDir({ env: { AGB_PLUGIN_DIR: '/x' }, bundled: true }), /\.gemini\/config\/plugins\/adlc-antigravity$/);
});

test('bundled mode ignores the AGB_PLUGIN_ROOT dev override', () => {
  const noVendor = fakePluginRoot('override-target', { vendor: false });
  const dev = resolveAdlcBinary({ repo: ROOT, env: { AGB_PLUGIN_ROOT: noVendor } });
  assert.notEqual(dev.source, 'vendored', 'unbundled honours the override (no vendor/adlc there)');
  const bundled = resolveAdlcBinary({ repo: ROOT, env: { AGB_PLUGIN_ROOT: noVendor }, bundled: true });
  assert.equal(bundled.source, 'vendored', 'bundled ignores it and uses the real plugin root');
});
