import test from 'node:test';
import assert from 'node:assert';
import { checkNodeVersion, checkAgyBinary, checkAgyAuth, checkAdlcBinary, checkSandbox, checkBrainDir, checkPlugin, checkTicketStore, runDoctor } from '../lib/doctor.mjs';
import { resolveAdlcBinary, MIN_ADLC_CLI_VERSION } from '../lib/adlc-bridge.mjs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, chmodSync, rmSync, mkdirSync, mkdtempSync } from 'fs';

test('checkNodeVersion: passes on v18+', async () => {
  const res = await checkNodeVersion();
  // Assume tests run on v18+
  assert.equal(res.level, 'pass');
});

test('checkAgyBinary: passes when fake-agy is provided', async () => {
  const FAKE_AGY = join(process.cwd(), 'test/fixtures/fake-agy');
  const res = await checkAgyBinary({ env: { AGB_AGY_BIN: FAKE_AGY } });
  assert.equal(res.level, 'pass');
  assert.match(res.detail, /^vagy version/);
});

test('checkAgyBinary: fails when not found', async () => {
  const res = await checkAgyBinary({ env: { AGB_AGY_BIN: '/does/not/exist' } });
  assert.equal(res.level, 'fail');
});

test('checkAgyAuth: fails when FAKE_AGY_MODE=empty', async () => {
  const FAKE_AGY = join(process.cwd(), 'test/fixtures/fake-agy');
  const res = await checkAgyAuth({ env: { AGB_AGY_BIN: FAKE_AGY, FAKE_AGY_MODE: 'empty' } });
  assert.equal(res.level, 'fail');
});

test('checkAdlcBinary: warns when missing', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-missing-adlc-'));
  try {
    const res = await checkAdlcBinary({ cwd: d, env: {} });
    assert.equal(res.level, 'warn');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkSandbox: bypassed via env', async () => {
  const res = await checkSandbox({ env: { AGB_SANDBOX_GATES: '0' }, platform: 'linux' });
  assert.equal(res.level, 'pass');
});

test('checkSandbox: fails on unsupported platform without bypass', async () => {
  const res = await checkSandbox({ env: {}, platform: 'win32' });
  assert.equal(res.level, 'fail');
});

test('checkSandbox: linux passes if bwrap is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bwrap-test-'));
  try {
    writeFileSync(join(dir, 'which'), '#!/bin/sh\nexit 0');
    chmodSync(join(dir, 'which'), 0o755);
    writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\nexit 0');
    chmodSync(join(dir, 'bwrap'), 0o755);
    const res = await checkSandbox({ env: { PATH: dir }, platform: 'linux' });
    assert.equal(res.level, 'pass');
    assert.equal(res.detail, 'bwrap available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkSandbox: linux fails if bwrap is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-nobwrap-test-'));
  try {
    writeFileSync(join(dir, 'which'), '#!/bin/sh\nif [ "$1" = "bwrap" ]; then exit 1; fi\nexit 0');
    chmodSync(join(dir, 'which'), 0o755);
    const res = await checkSandbox({ env: { PATH: dir }, platform: 'linux' });
    assert.equal(res.level, 'fail');
    assert.ok(res.detail.includes('bwrap missing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkSandbox: linux fails if bwrap is present but fails usability probe (namespaces restricted)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-unusable-bwrap-test-'));
  try {
    writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\nexit 1');
    chmodSync(join(dir, 'bwrap'), 0o755);
    const res = await checkSandbox({ env: { PATH: dir }, platform: 'linux' });
    assert.equal(res.level, 'fail');
    assert.ok(res.detail.includes('bwrap unusable'));
    assert.ok(res.fix.includes('user namespaces'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBrainDir: passes when dir exists', async () => {
  const d = join(tmpdir(), 'agb-test-brain');
  mkdirSync(d, { recursive: true });
  try {
    const res = await checkBrainDir({ env: { AGB_BRAIN_DIR: d } });
    assert.equal(res.level, 'pass');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkPlugin: warns when legacy version (missing-field)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-plugin-legacy-'));
  const orig = process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  try {
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ version: "1.0.0" }));
    process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = d;
    const res = await checkPlugin({ env: process.env });
    assert.equal(res.level, 'warn');
    assert.equal(res.detail, 'installed (legacy version)');
  } finally {
    if (orig !== undefined) process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = orig;
    else delete process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkPlugin: passes when compatible', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-plugin-compatible-'));
  const orig = process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  try {
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ adlcContract: 1 }));
    process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = d;
    const res = await checkPlugin({ env: process.env });
    assert.equal(res.level, 'pass');
  } finally {
    if (orig !== undefined) process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = orig;
    else delete process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkPlugin: fails when incompatible', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-plugin-incompat-'));
  const orig = process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
  try {
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ adlcContract: 999 }));
    process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = d;
    const res = await checkPlugin({ env: process.env });
    assert.equal(res.level, 'fail');
    assert.ok(res.detail.includes('unsupported contract'));
  } finally {
    if (orig !== undefined) process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH = orig;
    else delete process.env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
    rmSync(d, { recursive: true, force: true });
  }
});

// --- checkTicketStore: the repo's ADLC ticket backend ---
// The directory store (.adlc/tickets/ + .store.json) is canonical; the single
// tickets.json is the 1.x legacy bridge. Both present at once is a fail-closed
// state for the adlc-antigravity plugin's reader, so doctor must FAIL on it.

test('checkTicketStore: no store is a pass (created on first projection)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-none-'));
  try {
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /none/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: reports the directory backend', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-dir-'));
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /directory/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: reports the legacy backend', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-legacy-'));
  try {
    mkdirSync(join(d, '.adlc'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /legacy/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: FAILS when both stores exist (plugin fails closed on this)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-both-'));
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');
    writeFileSync(join(d, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'fail');
    assert.ok(res.fix, 'both-stores failure carries fix text');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: warns on an orphaned directory store (dir without .store.json)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-orphan-'));
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'warn');
    assert.match(res.detail, /orphaned/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: resolves project-local @adlc/cli and validates version floor', () => {
  const res = resolveAdlcBinary({ repo: process.cwd() });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'project-local');
  assert.match(res.version, /^1\.11\./);
});

test('resolveAdlcBinary: fails closed when local dependency is missing', () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-no-adlc-'));
  try {
    const res = resolveAdlcBinary({ repo: d });
    assert.equal(res.ok, false);
    assert.match(res.error, /missing or unverified/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: fails when package version is below floor', () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-old-adlc-'));
  try {
    const pkgDir = join(d, 'node_modules', '@adlc', 'cli');
    const binDir = join(d, 'node_modules', '.bin');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.6.0', bin: { adlc: './bin.js' } }));
    writeFileSync(join(pkgDir, 'bin.js'), '#!/usr/bin/env node\n');
    chmodSync(join(pkgDir, 'bin.js'), 0o755);
    writeFileSync(join(binDir, 'adlc'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'adlc'), 0o755);

    const res = resolveAdlcBinary({ repo: d });
    assert.equal(res.ok, false);
    assert.match(res.error, /does not meet floor/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: passes on current repo with local @adlc/cli', async () => {
  const res = await checkAdlcBinary({ cwd: process.cwd() });
  assert.equal(res.level, 'pass');
  assert.match(res.detail, /^v1\.11\./);
});

test('checkAdlcBinary: fails when local @adlc/cli fails package manifest authentication', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-auth-fail-'));
  try {
    const pkgDir = join(d, 'node_modules', '@adlc', 'cli');
    const binDir = join(d, 'node_modules', '.bin');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // Invalid version < 1.11.1
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.6.0', bin: { adlc: './bin.js' } }));
    writeFileSync(join(pkgDir, 'bin.js'), '#!/usr/bin/env node\n');
    chmodSync(join(pkgDir, 'bin.js'), 0o755);
    writeFileSync(join(binDir, 'adlc'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'adlc'), 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: {} });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /package manifest authentication failed/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: fails when custom adlc binary resides in temporary directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-temp-bin-'));
  try {
    const fakeBin = join(d, 'fake-adlc');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.11.1', bin: { adlc: './fake-adlc' } }));
    writeFileSync(fakeBin, '#!/bin/sh\necho "1.11.1"\n');
    chmodSync(fakeBin, 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: { AGB_ADLC_BIN: fakeBin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /temporary directory/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: fails when adlc version is below floor', async () => {
  const d = mkdtempSync(join(process.cwd(), '.test-adlc-old-ver-'));
  try {
    const fakeBin = join(d, 'fake-old-adlc');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.11.1', bin: { adlc: './fake-old-adlc' } }));
    writeFileSync(fakeBin, '#!/bin/sh\necho "1.6.0"\n');
    chmodSync(fakeBin, 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: { AGB_ADLC_BIN: fakeBin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /required >= v1\.11\.1/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: fails when authenticated binary fails to execute', async () => {
  const d = mkdtempSync(join(process.cwd(), '.test-adlc-exec-fail-'));
  try {
    const fakeBin = join(d, 'fake-broken-adlc');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.11.1', bin: { adlc: './fake-broken-adlc' } }));
    writeFileSync(fakeBin, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeBin, 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: { AGB_ADLC_BIN: fakeBin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /execution failed/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: reports store corruption when adlc ticket doctor exits non-zero', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-corrupt-store-'));
  const FAKE_ADLC = join(process.cwd(), 'test/fixtures/fake-adlc');
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');

    const res = await checkTicketStore({ cwd: d, env: { AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1', FAKE_TICKET_DOCTOR_MODE: 'fail' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /store corruption/);
    assert.match(res.detail, /orphan shard detected/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: passes when adlc ticket doctor exits zero', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-pass-store-'));
  const FAKE_ADLC = join(process.cwd(), 'test/fixtures/fake-adlc');
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');

    const res = await checkTicketStore({ cwd: d, env: { AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1', FAKE_TICKET_DOCTOR_MODE: 'pass' } });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /directory backend/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: runs cleanly on current repo with project-local @adlc/cli', async () => {
  const res = await checkTicketStore({ cwd: process.cwd() });
  assert.equal(res.level, 'pass');
  assert.match(res.detail, /directory backend/);
});

