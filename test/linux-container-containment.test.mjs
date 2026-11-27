import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLinuxContainerEnvironment,
  prepareBuilderContainment,
  verifyLinuxContainerAttestation,
} from '../lib/agy.mjs';

function signLinuxAttestation(repoPath, adminKey, overrides = {}) {
  const att = {
    repositoryPath: repoPath,
    acknowledgedPlatform: 'linux',
    authorizedBy: 'ci-operator',
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    nonce: crypto.randomBytes(8).toString('hex'),
    ...overrides,
  };
  const canonical = [
    att.repositoryPath,
    att.acknowledgedPlatform,
    att.authorizedBy,
    att.timestamp,
    att.expiresAt,
    att.nonce,
  ].join('|');
  att.signature = overrides.signature ?? crypto.createHmac('sha256', adminKey).update(canonical).digest('hex');
  return att;
}

test('isLinuxContainerEnvironment and verifyLinuxContainerAttestation enforce strict opt-in, container detection, HMAC signature, expiry, and repo binding', () => {
  assert.equal(isLinuxContainerEnvironment({}, { probeFs: false }), false);
  assert.equal(isLinuxContainerEnvironment({}, { probeFs: false, existsFn: () => true }), false);
  assert.equal(isLinuxContainerEnvironment({}, { existsFn: (p) => p === '/.dockerenv' }), true);
  assert.equal(isLinuxContainerEnvironment({}, { existsFn: (p) => p === '/run/.containerenv' }), true);
  assert.equal(isLinuxContainerEnvironment({}, { existsFn: () => false }), false);
  assert.equal(isLinuxContainerEnvironment({ KUBERNETES_SERVICE_HOST: '10.96.0.1' }, { probeFs: false }), true);
  assert.equal(isLinuxContainerEnvironment({ container: 'docker' }, { probeFs: false }), true);

  const repo = mkdtempSync(join(tmpdir(), 'agb-linux-att-'));
  const other = mkdtempSync(join(tmpdir(), 'agb-linux-att-other-'));
  const adminKey = 'test-linux-container-key';
  try {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    const baseEnv = {
      AGB_LINUX_CONTAINER_ATTESTATION: '1',
      KUBERNETES_SERVICE_HOST: '10.96.0.1',
      ADLC_ADMIN_KEY: adminKey,
    };

    // 1. Missing opt-in env fails closed
    assert.equal(verifyLinuxContainerAttestation(repo, { env: {}, probeFs: false }).valid, false);
    // 2. Outside container runtime fails closed
    assert.equal(
      verifyLinuxContainerAttestation(repo, { env: { AGB_LINUX_CONTAINER_ATTESTATION: '1', ADLC_ADMIN_KEY: adminKey }, probeFs: false }).valid,
      false
    );
    // 3. Valid signed Linux attestation passes
    const validAtt = signLinuxAttestation(repo, adminKey);
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: validAtt }) + '\n');
    const okRes = verifyLinuxContainerAttestation(repo, { env: baseEnv, probeFs: false });
    assert.equal(okRes.valid, true);
    assert.equal(okRes.mechanism, 'linux_container_attestation');

    // 4. Tampered signature, expired timestamp, wrong platform, and cross-repo path all fail closed
    const badSig = signLinuxAttestation(repo, adminKey, { signature: '0'.repeat(64) });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: badSig }) + '\n');
    assert.match(verifyLinuxContainerAttestation(repo, { env: baseEnv, probeFs: false }).reason, /invalid attestation signature/);

    const expired = signLinuxAttestation(repo, adminKey, { expiresAt: new Date(Date.now() - 10_000).toISOString() });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: expired }) + '\n');
    assert.match(verifyLinuxContainerAttestation(repo, { env: baseEnv, probeFs: false }).reason, /expired/);

    const wrongOs = signLinuxAttestation(repo, adminKey, { acknowledgedPlatform: 'win32' });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: wrongOs }) + '\n');
    assert.match(verifyLinuxContainerAttestation(repo, { env: baseEnv, probeFs: false }).reason, /platform mismatch/);

    const crossRepo = signLinuxAttestation(other, adminKey);
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: crossRepo }) + '\n');
    assert.match(verifyLinuxContainerAttestation(repo, { env: baseEnv, probeFs: false }).reason, /cross_repository_attestation_rejected/);

    // 5. Symlinked .adlc/config.json is rejected
    const extCfg = join(other, 'cfg.json');
    writeFileSync(extCfg, JSON.stringify({ sandboxBypassAttestation: validAtt }));
    rmSync(join(repo, '.adlc', 'config.json'));
    symlinkSync(extCfg, join(repo, '.adlc', 'config.json'));
    assert.match(verifyLinuxContainerAttestation(repo, { env: baseEnv, probeFs: false }).reason, /symlinked/i);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('prepareBuilderContainment allows opted-in Linux container attestation when bwrap is unavailable and fails closed without it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-linux-cont-'));
  const adminKey = 'test-containment-key';
  try {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    const validAtt = signLinuxAttestation(repo, adminKey);
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ sandboxBypassAttestation: validAtt }) + '\n');

    // Without AGB_LINUX_CONTAINER_ATTESTATION=1: fails closed with standard message
    const defaultDeny = await prepareBuilderContainment({
      agyBin: '/usr/bin/agy',
      args: ['--print', 'x'],
      cwd: repo,
      repo,
      platform: 'linux',
      env: { AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1' },
    });
    assert.equal(defaultDeny.ok, false);
    assert.equal(defaultDeny.kind, 'containment_unavailable');
    assert.match(defaultDeny.error, /Attestation bypass is restricted to Windows/);

    // With AGB_LINUX_CONTAINER_ATTESTATION=1 + valid signed attestation + container env: succeeds
    const allowed = await prepareBuilderContainment({
      agyBin: '/usr/bin/agy',
      args: ['--print', 'x'],
      cwd: repo,
      repo,
      platform: 'linux',
      env: {
        AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1',
        AGB_LINUX_CONTAINER_ATTESTATION: '1',
        KUBERNETES_SERVICE_HOST: '10.96.0.1',
        ADLC_ADMIN_KEY: adminKey,
      },
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.launchBin, '/usr/bin/agy');
    allowed.cleanup?.();

    // With AGB_LINUX_CONTAINER_ATTESTATION=1 but invalid ADLC_ADMIN_KEY: fails closed
    const badKey = await prepareBuilderContainment({
      agyBin: '/usr/bin/agy',
      args: ['--print', 'x'],
      cwd: repo,
      repo,
      platform: 'linux',
      env: {
        AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1',
        AGB_LINUX_CONTAINER_ATTESTATION: '1',
        KUBERNETES_SERVICE_HOST: '10.96.0.1',
        ADLC_ADMIN_KEY: 'wrong-key',
      },
    });
    assert.equal(badKey.ok, false);
    assert.equal(badKey.kind, 'containment_unavailable');
    assert.match(badKey.error, /Container attestation rejected/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
