import test from 'node:test';
import assert from 'node:assert';
import { checkNodeVersion, checkAgyBinary, checkAgyAuth, checkAdlcBinary, checkSandbox, checkBrainDir } from '../lib/doctor.mjs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, chmodSync, rmSync, mkdirSync } from 'fs';

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
  const res = await checkSandbox({ env: {}, platform: 'linux' });
  assert.equal(res.level, 'fail');
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
