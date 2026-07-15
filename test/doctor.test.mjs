import test from 'node:test';
import assert from 'node:assert';
import { checkNodeVersion, checkAgyBinary, checkAgyAuth, checkAdlcBinary, checkSandbox, checkBrainDir, checkPlugin } from '../lib/doctor.mjs';
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
  const res = await checkAdlcBinary({ env: { AGB_ADLC_BIN: '/does/not/exist' } });
  assert.equal(res.level, 'warn');
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
