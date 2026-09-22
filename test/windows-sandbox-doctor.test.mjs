import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

import {
  checkSandbox,
  verifyWindowsSandboxAttestation,
  verifyWindowsSandboxActive,
} from '../lib/doctor.mjs';
import { runSandboxProbe } from '../lib/sandbox-probe-helper.mjs';

function setupMockGitRepo() {
  const d = mkdtempSync(join(tmpdir(), 'agb-win-doctor-repo-'));
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
  const h = mkdtempSync(join(tmpdir(), 'agb-win-doctor-home-'));
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
  platform = 'win32',
  authorizedBy = 'operator@example.com',
  adminKey = 'secret-admin-key-123',
  ttlMs = 1800 * 1000,
  expired = false,
}) {
  const now = Date.now();
  const timestamp = new Date(expired ? now - 7200 * 1000 : now).toISOString();
  const expiresAt = new Date(expired ? now - 3600 * 1000 : now + ttlMs).toISOString();

  const payload = `${installId}:${rootCommit}:${origin}:${repoPath}:${nonce}:${runId}:${platform}:${authorizedBy}:${timestamp}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', adminKey).update(payload).digest('hex');

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

// --- Multi-Factor Replay-Defended Attestation Tests ---

test('verifyWindowsSandboxAttestation: passes with valid multi-factor attestation', () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  try {
    const adminKey = 'test-key-345';
    const att = createAttestation({
      installId,
      rootCommit,
      origin,
      repoPath: repo,
      adminKey,
    });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: att }));

    const res = verifyWindowsSandboxAttestation({
      repo,
      env: { ADLC_ADMIN_KEY: adminKey },
      platform: 'win32',
      homeDir,
    });

    assert.equal(res.valid, true);
    // Verifies nonce was recorded in both repo and host ledgers
    const repoLedger = readFileSync(join(repo, '.adlc', 'consumed_attestations.jsonl'), 'utf8');
    const hostLedger = readFileSync(join(homeDir, '.adlc', 'consumed_attestations.jsonl'), 'utf8');
    assert.match(repoLedger, new RegExp(att.nonce));
    assert.match(hostLedger, new RegExp(att.nonce));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxAttestation: fails closed on replayed nonce', () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  try {
    const adminKey = 'test-key-replay';
    const att = createAttestation({
      installId,
      rootCommit,
      origin,
      repoPath: repo,
      adminKey,
    });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: att }));

    // First verification consumes the nonce
    const res1 = verifyWindowsSandboxAttestation({
      repo,
      env: { ADLC_ADMIN_KEY: adminKey },
      platform: 'win32',
      homeDir,
    });
    assert.equal(res1.valid, true);

    // Second verification must fail closed with replayed_attestation_rejected
    const res2 = verifyWindowsSandboxAttestation({
      repo,
      env: { ADLC_ADMIN_KEY: adminKey },
      platform: 'win32',
      homeDir,
    });
    assert.equal(res2.valid, false);
    assert.equal(res2.reason, 'replayed_attestation_rejected');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxAttestation: fails closed on cross-repository path', () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  try {
    const adminKey = 'test-key-cross-repo';
    const att = createAttestation({
      installId,
      rootCommit,
      origin,
      repoPath: '/different/repo/path',
      adminKey,
    });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: att }));

    const res = verifyWindowsSandboxAttestation({
      repo,
      env: { ADLC_ADMIN_KEY: adminKey },
      platform: 'win32',
      homeDir,
    });
    assert.equal(res.valid, false);
    assert.match(res.reason, /cross_repository_attestation_rejected/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxAttestation: fails closed on installation_id mismatch', () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir } = setupMockHome();
  try {
    const adminKey = 'test-key-install';
    const att = createAttestation({
      installId: 'foreign-host-token-xyz',
      rootCommit,
      origin,
      repoPath: repo,
      adminKey,
    });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: att }));

    const res = verifyWindowsSandboxAttestation({
      repo,
      env: { ADLC_ADMIN_KEY: adminKey },
      platform: 'win32',
      homeDir,
    });
    assert.equal(res.valid, false);
    assert.match(res.reason, /installationId mismatch/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxAttestation: fails closed on expired attestation', () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  try {
    const adminKey = 'test-key-exp';
    const att = createAttestation({
      installId,
      rootCommit,
      origin,
      repoPath: repo,
      adminKey,
      expired: true,
    });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: att }));

    const res = verifyWindowsSandboxAttestation({
      repo,
      env: { ADLC_ADMIN_KEY: adminKey },
      platform: 'win32',
      homeDir,
    });
    assert.equal(res.valid, false);
    assert.match(res.reason, /attestation expired/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// --- Active Differential Sandbox Probe Tests ---

test('sandbox-probe-helper: runSandboxProbe exercises file, net, and nonce actions', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-probe-helper-test-'));
  try {
    const canary = join(d, 'canary.tmp');
    const worktreeCanary = join(d, 'worktree-nonce.tmp');
    const nonce = 'probe-nonce-123';

    // File action writes canary when unwatched
    const res = await runSandboxProbe({
      canaryPath: canary,
      worktreeCanary,
      nonce,
    });

    assert.equal(res.file.ok, true);
    assert.equal(res.nonceWritten, true);
    assert.equal(readFileSync(worktreeCanary, 'utf8'), nonce);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxActive: passes when probe reports EACCES file denial, WSAEACCES net denial, and valid nonce', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-active-pass-'));
  try {
    // Create a mock probe runner that simulates Windows AppContainer syscall codes
    const mockProbeRunner = join(repo, 'mock-probe.js');
    writeFileSync(mockProbeRunner, `
      import { parseArgs } from 'node:util';
      import { writeFileSync } from 'node:fs';

      const options = {
        canary: { type: 'string' },
        port: { type: 'string' },
        'worktree-canary': { type: 'string' },
        nonce: { type: 'string' },
      };
      const { values } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });

      // Simulate AppContainer behavior:
      // 1. File write fails with Win32 ERROR_ACCESS_DENIED (5) / EACCES
      // 2. Loopback connect fails with WSAEACCES (10013)
      // 3. Worktree write succeeds
      if (values['worktree-canary'] && values.nonce) {
        writeFileSync(values['worktree-canary'], values.nonce, 'utf8');
      }

      const result = {
        file: { ok: false, code: 'EACCES', errno: 5, syscall: 'open' },
        net: { ok: false, code: 'WSAEACCES', errno: 10013 },
        nonceWritten: true
      };
      console.log('[sandbox] active AppContainer policy');
      console.log(JSON.stringify(result));
    `);

    const res = await verifyWindowsSandboxActive({
      cwd: repo,
      env: {
        ...process.env,
        AGB_SANDBOX_PROBE_CMD: process.execPath,
        AGB_SANDBOX_PROBE_HELPER: mockProbeRunner,
        AGB_REQUIRE_DRIVER_SIGNATURE: '1',
      },
    });

    assert.equal(res.level, 'pass');
    assert.match(res.detail, /Windows AppContainer verified/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxActive: fails if child writes outside worktree (containment breach)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-active-fail-file-'));
  try {
    const mockProbeRunner = join(repo, 'mock-breach-file.js');
    writeFileSync(mockProbeRunner, `
      import { parseArgs } from 'node:util';
      import { writeFileSync } from 'node:fs';
      const options = {
        canary: { type: 'string' },
        port: { type: 'string' },
        'worktree-canary': { type: 'string' },
        nonce: { type: 'string' },
      };
      const { values } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
      if (values.canary) writeFileSync(values.canary, 'breached');
      if (values['worktree-canary'] && values.nonce) writeFileSync(values['worktree-canary'], values.nonce, 'utf8');
      console.log(JSON.stringify({ file: { ok: true, written: true }, net: { ok: false, code: 'WSAEACCES' }, nonceWritten: true }));
    `);

    const res = await verifyWindowsSandboxActive({
      cwd: repo,
      env: {
        ...process.env,
        AGB_SANDBOX_PROBE_CMD: process.execPath,
        AGB_SANDBOX_PROBE_HELPER: mockProbeRunner,
      },
    });

    assert.equal(res.level, 'fail');
    assert.match(res.detail, /file containment breach/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyWindowsSandboxActive: fails if child connects to loopback (network isolation breach)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-active-fail-net-'));
  try {
    const mockProbeRunner = join(repo, 'mock-breach-net.js');
    writeFileSync(mockProbeRunner, `
      import { parseArgs } from 'node:util';
      import { writeFileSync } from 'node:fs';
      import net from 'node:net';

      const options = {
        canary: { type: 'string' },
        port: { type: 'string' },
        'worktree-canary': { type: 'string' },
        nonce: { type: 'string' },
      };
      const { values } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
      if (values['worktree-canary'] && values.nonce) writeFileSync(values['worktree-canary'], values.nonce, 'utf8');

      // Connect to loopback server
      const client = net.connect({ host: '127.0.0.1', port: Number(values.port) }, () => {
        client.destroy();
        console.log(JSON.stringify({
          file: { ok: false, code: 'EACCES', errno: 5 },
          net: { ok: true, connected: true },
          nonceWritten: true
        }));
      });
    `);

    const res = await verifyWindowsSandboxActive({
      cwd: repo,
      env: {
        ...process.env,
        AGB_SANDBOX_PROBE_CMD: process.execPath,
        AGB_SANDBOX_PROBE_HELPER: mockProbeRunner,
      },
    });

    assert.equal(res.level, 'fail');
    assert.match(res.detail, /network isolation breach/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkSandbox: integrates multi-factor attestation bypass on win32', async () => {
  const { repo, rootCommit, origin } = setupMockGitRepo();
  const { homeDir, installId } = setupMockHome();
  try {
    const adminKey = 'test-key-checkSandbox';
    const att = createAttestation({
      installId,
      rootCommit,
      origin,
      repoPath: repo,
      adminKey,
    });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: att }));

    const res = await checkSandbox({
      cwd: repo,
      platform: 'win32',
      env: { ADLC_ADMIN_KEY: adminKey, AGB_HOME_DIR: homeDir },
    });

    assert.equal(res.level, 'pass');
    assert.match(res.detail, /bypassed via verified HMAC attestation/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
