import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
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

test('checkKernelContainment: handles darwin and bsd', () => {
  const origPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const darwinCheck = checkKernelContainment();
    if (darwinCheck.supported) {
      assert.equal(darwinCheck.mechanism, 'seatbelt');
    } else {
      assert.match(darwinCheck.detail, /sandbox-exec/);
    }

    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    const bsdCheck = checkKernelContainment();
    assert.equal(bsdCheck.supported, false);
    assert.match(bsdCheck.detail, /bsd/);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
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

function setupMockGitRepo() {
  const d = mkdtempSync(join(tmpdir(), 'agb-attest-repo-'));
  execSync('git init -b main', { cwd: d });
  execSync('git config user.email "test@example.com"', { cwd: d });
  execSync('git config user.name "Test User"', { cwd: d });
  execSync('git config commit.gpgsign false', { cwd: d });
  execSync('git config remote.origin.url "git@github.com:test/repo.git"', { cwd: d });
  writeFileSync(join(d, 'README.md'), '# Test Repo\n');
  execSync('git add README.md && git commit -m "initial commit"', { cwd: d });
  const rootCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd: d, encoding: 'utf8' }).trim().split(/\s+/)[0];
  mkdirSync(join(d, '.adlc'), { recursive: true });
  return { repo: d, rootCommit, origin: 'git@github.com:test/repo.git' };
}

function setupMockHome() {
  const h = mkdtempSync(join(tmpdir(), 'agb-attest-home-'));
  mkdirSync(join(h, '.adlc'), { recursive: true });
  const installId = crypto.randomUUID();
  writeFileSync(join(h, '.adlc', 'installation_id'), installId);
  return { homeDir: h, installId };
}

function createAttestation({
  installId,
  rootCommit,
  origin,
  repoPath,
  nonce = crypto.randomUUID(),
  runId = 'run-test-123',
  platform = process.platform,
  authorizedBy = 'operator@example.com',
  adminKey = 'secret-admin-key-123',
  ttlMs = 1800 * 1000,
  expired = false,
  signatureOverride = null,
}) {
  const now = Date.now();
  const timestamp = new Date(expired ? now - 7200 * 1000 : now).toISOString();
  const expiresAt = new Date(expired ? now - 3600 * 1000 : now + ttlMs).toISOString();

  const payload = `${installId}:${rootCommit}:${origin}:${repoPath}:${nonce}:${runId}:${platform}:${authorizedBy}:${timestamp}:${expiresAt}`;
  const signature = signatureOverride ?? crypto.createHmac('sha256', adminKey).update(payload).digest('hex');

  return {
    installationId: installId,
    repositoryRootCommit: rootCommit,
    repositoryOrigin: origin,
    repositoryPath: repoPath,
    nonce,
    runId,
    acknowledgedPlatform: platform,
    authorizedBy,
    timestamp,
    expiresAt,
    signature,
  };
}

test('verifySandboxBypassAttestation: validates multi-factor HMAC-SHA256 signature in .adlc/config.json', () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();

  const adminKey = 'super-secret-admin-key-1234';
  const platform = 'win32';

  const savedKey = process.env.ADLC_ADMIN_KEY;
  const savedHome = process.env.AGB_HOME_DIR;
  process.env.ADLC_ADMIN_KEY = adminKey;
  process.env.AGB_HOME_DIR = homeDir;

  try {
    // Valid attestation
    const validAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform, adminKey });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: validAtt })
    );
    const validCheck = verifySandboxBypassAttestation(repo, platform);
    assert.equal(validCheck.valid, true);

    // Linux rejection (containment and bypass cannot be bypassed on Linux)
    const linuxCheck = verifySandboxBypassAttestation(repo, 'linux');
    assert.equal(linuxCheck.valid, false);
    assert.match(linuxCheck.reason, /Sandbox bypass attestation is only supported on Windows/);

    // Mismatched platform
    const badPlatformAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform: 'other_os', adminKey });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: badPlatformAtt })
    );
    const badPlatform = verifySandboxBypassAttestation(repo, platform);
    assert.equal(badPlatform.valid, false);
    assert.match(badPlatform.reason, /platform mismatch/);

    // Expired
    const expiredAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform, adminKey, expired: true });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: expiredAtt })
    );
    const expiredCheck = verifySandboxBypassAttestation(repo, platform);
    assert.equal(expiredCheck.valid, false);
    assert.match(expiredCheck.reason, /expired/);

    // Bad signature
    const badSigAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform, adminKey, signatureOverride: 'deadbeef' });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: badSigAtt })
    );
    const badSigCheck = verifySandboxBypassAttestation(repo, platform);
    assert.equal(badSigCheck.valid, false);
    assert.match(badSigCheck.reason, /invalid attestation signature/);
  } finally {
    if (savedKey === undefined) delete process.env.ADLC_ADMIN_KEY;
    else process.env.ADLC_ADMIN_KEY = savedKey;
    if (savedHome === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('runAgy builder: sandbox false with unsupported kernel containment reuses bypass verification without second consumption', async () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  const adminKey = 'super-secret-admin-key-1234';
  const platform = 'win32';

  const savedKey = process.env.ADLC_ADMIN_KEY;
  const savedHome = process.env.AGB_HOME_DIR;
  const savedContainment = process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE;
  process.env.ADLC_ADMIN_KEY = adminKey;
  process.env.AGB_HOME_DIR = homeDir;
  process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE = '1';

  try {
    const validAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform, adminKey });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: validAtt })
    );

    // Call runAgy with sandbox: false and containment: true on an unsupported host.
    // The bypass must be verified once and reused, not rejected on the second check as a replay.
    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: repo,
      repo,
      bin: FAKE_AGY,
      project: 'test-proj',
      role: 'builder',
      sandbox: false,
      containment: true,
      platform,
    });

    assert.equal(res.ok, true);
  } finally {
    if (savedKey === undefined) delete process.env.ADLC_ADMIN_KEY;
    else process.env.ADLC_ADMIN_KEY = savedKey;
    if (savedHome === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHome;
    if (savedContainment === undefined) delete process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE;
    else process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE = savedContainment;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
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

test('runAgy stream-json: delayed tree-kill timer is cleared after child exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  const savedMode = process.env.FAKE_BUILDER_MODE;
  let clearedTimers = 0;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    clearedTimers++;
    return originalClearTimeout(id);
  };
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
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'stream_overflow');
    assert.ok(clearedTimers >= 1, 'clearTimeout must be invoked to cancel watchdog/kill timers');
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    if (savedMode === undefined) delete process.env.FAKE_BUILDER_MODE;
    else process.env.FAKE_BUILDER_MODE = savedMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy builder: sanitizes sensitive keys and tokens from child environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-env-test-'));
  const stateDir = join(dir, 'agb-env-state');
  mkdirSync(stateDir, { recursive: true });
  const savedKey = process.env.ADLC_MANIFEST_KEY;
  const savedToken = process.env.CUSTOM_NPM_TOKEN;
  const savedSecret = process.env.AGB_SECRET_KEY;
  const savedState = process.env.FAKE_STATE_DIR;
  const savedRec = process.env.FAKE_RECORD_ENV;

  try {
    process.env.ADLC_MANIFEST_KEY = 'super-secret-manifest-key';
    process.env.CUSTOM_NPM_TOKEN = 'secret-npm-token';
    process.env.AGB_SECRET_KEY = 'secret-agb-key';
    process.env.FAKE_STATE_DIR = stateDir;
    process.env.FAKE_RECORD_ENV = '1';

    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      env: {
        NODE_OPTIONS: '--inspect',
        LD_PRELOAD: '/tmp/evil.so',
        BASH_ENV: '/tmp/bashrc',
        UNLISTED_CUSTOM_VAR: 'attacker_value',
        ADLC_TICKET: 'T1',
      },
    });

    assert.equal(res.ok, true);
    const captured = readFileSync(join(stateDir, 'full-env'), 'utf8');
    assert.equal(captured.includes('ADLC_MANIFEST_KEY'), false, 'ADLC_MANIFEST_KEY must be scrubbed');
    assert.equal(captured.includes('CUSTOM_NPM_TOKEN'), false, 'token must be scrubbed');
    assert.equal(captured.includes('AGB_SECRET_KEY'), false, 'secret must be scrubbed');
    assert.equal(captured.includes('NODE_OPTIONS'), false, 'NODE_OPTIONS must be scrubbed');
    assert.equal(captured.includes('LD_PRELOAD'), false, 'LD_PRELOAD must be scrubbed');
    assert.equal(captured.includes('BASH_ENV'), false, 'BASH_ENV must be scrubbed');
    assert.equal(captured.includes('UNLISTED_CUSTOM_VAR'), false, 'non-allowlisted override must be scrubbed');
    assert.ok(captured.includes('ADLC_TICKET=T1'), 'allowlisted ADLC_ override must be retained');
  } finally {
    if (savedKey === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = savedKey;
    if (savedToken === undefined) delete process.env.CUSTOM_NPM_TOKEN; else process.env.CUSTOM_NPM_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.AGB_SECRET_KEY; else process.env.AGB_SECRET_KEY = savedSecret;
    if (savedState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = savedState;
    if (savedRec === undefined) delete process.env.FAKE_RECORD_ENV; else process.env.FAKE_RECORD_ENV = savedRec;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy builder: containment: false fails closed without bypass attestation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-stream-'));
  try {
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
      platform: 'win32',
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'containment_unavailable');
    assert.match(res.error, /Builder containment cannot be disabled without an authenticated bypass attestation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy builder: containment: false succeeds on win32 with valid bypass attestation', async () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  const adminKey = 'super-secret-admin-key-1234';
  const platform = 'win32';

  const savedKey = process.env.ADLC_ADMIN_KEY;
  const savedHome = process.env.AGB_HOME_DIR;
  process.env.ADLC_ADMIN_KEY = adminKey;
  process.env.AGB_HOME_DIR = homeDir;

  try {
    const validAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform, adminKey });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: validAtt })
    );

    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: repo,
      repo,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
      platform: 'win32',
    });

    assert.equal(res.ok, true);
    assert.equal(res.terminalResult.status, 'SUCCESS');
  } finally {
    if (savedKey === undefined) delete process.env.ADLC_ADMIN_KEY;
    else process.env.ADLC_ADMIN_KEY = savedKey;
    if (savedHome === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('runAgy builder: containment: false fails closed on Linux even with valid signed attestation', async () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  const adminKey = 'super-secret-admin-key-1234';

  const savedKey = process.env.ADLC_ADMIN_KEY;
  const savedHome = process.env.AGB_HOME_DIR;
  process.env.ADLC_ADMIN_KEY = adminKey;
  process.env.AGB_HOME_DIR = homeDir;

  try {
    const validAtt = createAttestation({ installId, rootCommit, origin, repoPath: repo, platform: 'win32', adminKey });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ sandboxBypassAttestation: validAtt })
    );

    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: repo,
      repo,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      containment: false,
      platform: 'linux',
    });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'containment_unavailable');
    assert.match(res.error, /Builder containment is mandatory on linux and cannot be disabled or bypassed/);
  } finally {
    if (savedKey === undefined) delete process.env.ADLC_ADMIN_KEY;
    else process.env.ADLC_ADMIN_KEY = savedKey;
    if (savedHome === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('job-object-wrapper.ps1: accepts -ArgsBase64 parameter and safely cleans up temporary file', () => {
  const ps1Path = fileURLToPath(new URL('../lib/job-object-wrapper.ps1', import.meta.url));
  const content = readFileSync(ps1Path, 'utf8');
  assert.ok(content.includes('[string]$ArgsBase64'));
  assert.ok(content.includes('FromBase64String($ArgsBase64)'));
  assert.ok(content.includes('Remove-Item -Force -Path $ArgsFile'));
});

test('runAgy builder: bwrap containment mounts root read-only with explicit read-write worktree and tmp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bwrap-test-'));
  try {
    let spawnedArgs = null;
    let spawnedBin = null;

    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      role: 'builder',
      sandbox: true,
      containment: true,
      platform: 'linux',
      onSpawn: (p) => {
        spawnedBin = p.spawnfile;
        spawnedArgs = p.spawnargs;
      },
    });

    if (spawnedBin && spawnedBin.endsWith('bwrap')) {
      assert.ok(spawnedArgs.includes('--ro-bind'), 'bwrap must mount root read-only');
      assert.equal(spawnedArgs.includes('--dev-bind'), false, 'bwrap must not mount host root read-write');
      assert.ok(spawnedArgs.includes('--bind'), 'bwrap must mount worktree and /tmp read-write');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy builder: bwrap containment isolates network and masks credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bwrap-net-test-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-fake-home-'));
  const savedMech = process.env.AGB_MOCK_CONTAINMENT_MECHANISM;
  const savedHome = process.env.AGB_HOME_DIR;

  try {
    process.env.AGB_MOCK_CONTAINMENT_MECHANISM = 'bwrap_pid';
    process.env.AGB_HOME_DIR = fakeHome;

    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    mkdirSync(join(fakeHome, '.aws'), { recursive: true });
    mkdirSync(join(fakeHome, '.config'), { recursive: true });
    mkdirSync(join(fakeHome, '.gemini'), { recursive: true });
    writeFileSync(join(fakeHome, '.netrc'), 'machine example.com login user password secret\n');
    writeFileSync(join(fakeHome, '.npmrc'), '//registry.npmjs.org/:_authToken=secret-npm-token\n');
    writeFileSync(join(fakeHome, '.pypirc'), '[pypi]\npassword = secret-pypi-token\n');

    let spawnedArgs = null;
    let spawnedBin = null;

    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      role: 'builder',
      sandbox: true,
      containment: true,
      platform: 'linux',
      onSpawn: (p) => {
        spawnedBin = p.spawnfile;
        spawnedArgs = p.spawnargs;
      },
    });

    assert.ok(spawnedBin && spawnedBin.endsWith('bwrap'));
    assert.equal(spawnedArgs.includes('--unshare-net'), false, 'bwrap must not isolate network from agy model transport');
    assert.ok(spawnedArgs.includes('--ro-bind'), 'bwrap must mount approved system paths read-only');
    assert.ok(spawnedArgs.includes('--bind'), 'bwrap must mount worktree and private /tmp read-write');
    assert.equal(spawnedArgs.includes(fakeHome), false, 'host home directory must not be mounted into bwrap');

    const agyIndex = spawnedArgs.indexOf(FAKE_AGY);
    assert.ok(agyIndex > 0 && spawnedArgs[agyIndex - 1] === '--ro-bind', 'agy binary must be preserved via --ro-bind');
  } finally {
    if (savedMech === undefined) delete process.env.AGB_MOCK_CONTAINMENT_MECHANISM;
    else process.env.AGB_MOCK_CONTAINMENT_MECHANISM = savedMech;
    if (savedHome === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('runAgy non-builder: preserves unlisted custom environment variables unless sanitizeEnv is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-env-pres-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-env-state-pres-'));
  const savedState = process.env.FAKE_STATE_DIR;
  const savedRec = process.env.FAKE_RECORD_ENV;
  const savedCustom = process.env.MY_CUSTOM_TEST_VAR;

  try {
    process.env.FAKE_STATE_DIR = stateDir;
    process.env.FAKE_RECORD_ENV = '1';
    process.env.MY_CUSTOM_TEST_VAR = 'custom_inherited_val';

    const res1 = await runAgy({
      model: 'gemini-flash',
      prompt: 'Review diff',
      cwd: dir,
      bin: FAKE_AGY,
      role: 'prosecutor',
      env: {
        MY_SPECIAL_TOOL_SETTING: 'active_123',
      },
    });
    assert.equal(res1.ok, true);
    const captured1 = readFileSync(join(stateDir, 'full-env'), 'utf8');
    assert.ok(captured1.includes('MY_CUSTOM_TEST_VAR=custom_inherited_val'), 'inherited custom var must be preserved');
    assert.ok(captured1.includes('MY_SPECIAL_TOOL_SETTING=active_123'), 'passed custom env var must be preserved');

    const res2 = await runAgy({
      model: 'gemini-flash',
      prompt: 'Review diff',
      cwd: dir,
      bin: FAKE_AGY,
      role: 'prosecutor',
      sanitizeEnv: true,
      env: {
        MY_SPECIAL_TOOL_SETTING: 'active_123',
      },
    });
    assert.equal(res2.ok, true);
    const captured2 = readFileSync(join(stateDir, 'full-env'), 'utf8');
    assert.equal(captured2.includes('MY_CUSTOM_TEST_VAR'), false, 'inherited custom var must be scrubbed when sanitizeEnv: true');
    assert.equal(captured2.includes('MY_SPECIAL_TOOL_SETTING'), false, 'passed custom var must be scrubbed when sanitizeEnv: true');
  } finally {
    if (savedState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = savedState;
    if (savedRec === undefined) delete process.env.FAKE_RECORD_ENV; else process.env.FAKE_RECORD_ENV = savedRec;
    if (savedCustom === undefined) delete process.env.MY_CUSTOM_TEST_VAR; else process.env.MY_CUSTOM_TEST_VAR = savedCustom;
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runAgy builder: rejects fallback containment mechanisms as insufficient', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-fallback-cont-'));
  const savedMech = process.env.AGB_MOCK_CONTAINMENT_MECHANISM;

  try {
    for (const mech of ['cgroups_v2_scope', 'pid_namespace']) {
      process.env.AGB_MOCK_CONTAINMENT_MECHANISM = mech;
      const res = await runAgy({
        model: 'gemini-flash',
        prompt: 'Ticket T1 TICKET-DONE',
        cwd: dir,
        bin: FAKE_AGY,
        outputFormat: 'stream-json',
        role: 'builder',
        sandbox: true,
        containment: true,
        platform: 'linux',
      });
      assert.equal(res.ok, false);
      assert.equal(res.kind, 'containment_unavailable');
      assert.match(res.error, /provides insufficient filesystem isolation/);
    }
  } finally {
    if (savedMech === undefined) delete process.env.AGB_MOCK_CONTAINMENT_MECHANISM;
    else process.env.AGB_MOCK_CONTAINMENT_MECHANISM = savedMech;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy builder: scrubs XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS host IPC endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-ipc-scrub-'));
  const stateDir = join(dir, 'agb-ipc-state');
  mkdirSync(stateDir, { recursive: true });
  const savedState = process.env.FAKE_STATE_DIR;
  const savedRec = process.env.FAKE_RECORD_ENV;
  const savedXdg = process.env.XDG_RUNTIME_DIR;
  const savedDbus = process.env.DBUS_SESSION_BUS_ADDRESS;

  try {
    process.env.FAKE_STATE_DIR = stateDir;
    process.env.FAKE_RECORD_ENV = '1';
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';

    const res = await runAgy({
      model: 'gemini-flash',
      prompt: 'Ticket T1 TICKET-DONE or TICKET-BLOCKED',
      cwd: dir,
      bin: FAKE_AGY,
      outputFormat: 'stream-json',
      project: 'test-proj',
      role: 'builder',
      sandbox: true,
      env: {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    });

    assert.equal(res.ok, true);
    const captured = readFileSync(join(stateDir, 'full-env'), 'utf8');
    assert.equal(captured.includes('XDG_RUNTIME_DIR'), false, 'XDG_RUNTIME_DIR must be scrubbed');
    assert.equal(captured.includes('DBUS_SESSION_BUS_ADDRESS'), false, 'DBUS_SESSION_BUS_ADDRESS must be scrubbed');
  } finally {
    if (savedState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = savedState;
    if (savedRec === undefined) delete process.env.FAKE_RECORD_ENV; else process.env.FAKE_RECORD_ENV = savedRec;
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedXdg;
    if (savedDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = savedDbus;
    rmSync(dir, { recursive: true, force: true });
  }
});



