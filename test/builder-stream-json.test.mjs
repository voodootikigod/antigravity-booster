import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  runAgy,
  checkKernelContainment,
  verifySandboxBypassAttestation,
  MAX_STREAM_LINE_BYTES,
  MAX_STREAM_TOTAL_BYTES,
  MAX_CONSECUTIVE_GARBAGE_BYTES,
} from '../lib/agy.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

test('checkKernelContainment: recognizes supported platform and respects mock override', () => {
  const check = checkKernelContainment();
  assert.equal(typeof check.supported, 'boolean');

  const saved = process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE;
  try {
    process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE = '1';
    const mockCheck = checkKernelContainment();
    assert.equal(mockCheck.supported, false);
    assert.match(mockCheck.detail, /mocked/);
  } finally {
    if (saved === undefined) delete process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE;
    else process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE = saved;
  }
});

test('runAgy: fails closed with containment_unavailable if containment is unsupported', async () => {
  const saved = process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE;
  const dir = mkdtempSync(join(tmpdir(), 'agb-contain-'));
  try {
    process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE = '1';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'hello',
      cwd: dir,
      bin: FAKE_AGY,
      role: 'builder',
      sandbox: true,
      containment: true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'containment_unavailable');
    assert.match(res.error, /Kernel containment floor unavailable/);
  } finally {
    if (saved === undefined) delete process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE;
    else process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifySandboxBypassAttestation: validates HMAC-SHA256 signature in .adlc/config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-attest-'));
  const adlcDir = join(dir, '.adlc');
  mkdirSync(adlcDir, { recursive: true });

  const adminKey = 'super-secret-admin-key-1234';
  const platform = process.platform;
  const expiresAt = Date.now() + 60_000;
  const signature = crypto.createHmac('sha256', adminKey).update(`${platform}:${expiresAt}`).digest('hex');

  const savedKey = process.env.ADLC_ADMIN_KEY;
  process.env.ADLC_ADMIN_KEY = adminKey;

  try {
    // Valid attestation
    writeFileSync(
      join(adlcDir, 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: { platform, expiresAt, signature } })
    );
    const validCheck = verifySandboxBypassAttestation(dir, platform);
    assert.equal(validCheck.valid, true);

    // Mismatched platform
    const badPlatform = verifySandboxBypassAttestation(dir, 'other_os');
    assert.equal(badPlatform.valid, false);
    assert.match(badPlatform.reason, /platform mismatch/);

    // Expired
    const expiredSig = crypto.createHmac('sha256', adminKey).update(`${platform}:${Date.now() - 1000}`).digest('hex');
    writeFileSync(
      join(adlcDir, 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: { platform, expiresAt: Date.now() - 1000, signature: expiredSig } })
    );
    const expiredCheck = verifySandboxBypassAttestation(dir, platform);
    assert.equal(expiredCheck.valid, false);
    assert.match(expiredCheck.reason, /expired/);

    // Bad signature
    writeFileSync(
      join(adlcDir, 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: { platform, expiresAt, signature: 'deadbeef' } })
    );
    const badSigCheck = verifySandboxBypassAttestation(dir, platform);
    assert.equal(badSigCheck.valid, false);
    assert.match(badSigCheck.reason, /invalid sandboxBypassAttestation HMAC signature/);
  } finally {
    if (savedKey === undefined) delete process.env.ADLC_ADMIN_KEY;
    else process.env.ADLC_ADMIN_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: handles happy-path stream and heartbeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'heartbeat';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, true);
    assert.equal(res.kind, null);
    assert.ok(res.events.length >= 3);
    assert.equal(res.terminalResult.status, 'SUCCESS');
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: classifies missing terminal result as missing_terminal_result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'missing-result';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'missing_terminal_result');
    assert.match(res.error, /without emitting terminal result/);
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: classifies non-zero exit despite SUCCESS as server_shutdown_error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'server-shutdown';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'server_shutdown_error');
    assert.match(res.error, /exited with code 1 despite terminal result SUCCESS/);
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: duplicate terminal result uses first result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'duplicate-result';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, true);
    assert.equal(res.terminalResult.status, 'SUCCESS');
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: aborts on line exceeding MAX_STREAM_LINE_BYTES with stream_overflow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'overflow-line';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'stream_overflow');
    assert.match(res.error, /stream line exceeded 1MB limit/);
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: aborts on total bytes exceeding MAX_STREAM_TOTAL_BYTES with stream_overflow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'overflow-total';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'stream_overflow');
    assert.match(res.error, /total stream size exceeded 50MB limit/);
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy stream-json: aborts on consecutive unparseable bytes exceeding MAX_CONSECUTIVE_GARBAGE_BYTES with stream_corruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  try {
    process.env.FAKE_BUILDER_MODE = 'corruption';
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'stream_corruption');
    assert.match(res.error, /exceeded 5MB consecutive garbage/);
  } finally {
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
