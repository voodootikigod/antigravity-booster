// scripts/update-adlc-digests.mjs: the pinned block it renders round-trips
// with what lib/adlc-bridge.mjs exports, and offline verify detects drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVendoredDigests, renderBlock } from '../scripts/update-adlc-digests.mjs';
import { KNOWN_VENDORED_ADLC } from '../lib/adlc-bridge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('computeVendoredDigests matches the committed KNOWN_VENDORED_ADLC', () => {
  assert.deepEqual(computeVendoredDigests(), { ...KNOWN_VENDORED_ADLC });
});

test('renderBlock reproduces the exact block committed in lib/adlc-bridge.mjs', () => {
  const source = readFileSync(join(ROOT, 'lib', 'adlc-bridge.mjs'), 'utf8');
  assert.ok(source.includes(renderBlock(KNOWN_VENDORED_ADLC)));
});

test('verify mode (offline) exits 0 when the pins are current', () => {
  const r = spawnSync(process.execPath, ['scripts/update-adlc-digests.mjs', '--skip-registry'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is current/);
});

test('renderBlock output changes when any digest changes (drift is detectable)', () => {
  const drifted = { ...KNOWN_VENDORED_ADLC, vendoredBundleSha256: '0'.repeat(64) };
  assert.notEqual(renderBlock(drifted), renderBlock(KNOWN_VENDORED_ADLC));
});

test('verifyAgainstLockfile: a package with no lockfile integrity is refused (never re-pinned)', async () => {
  const { verifyAgainstLockfile } = await import('../scripts/update-adlc-digests.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'agb-lock-'));
  try {
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@adlc/x': { version: '1.0.0' } } }));
    assert.deepEqual(verifyAgainstLockfile('@adlc/x', { root }), { ok: false, error: '@adlc/x: no lockfile integrity' });
    assert.equal(verifyAgainstLockfile('@adlc/absent', { root }).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('computeVendoredDigests throws when vendor/adlc/package.json is missing a string version', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'agb-digest-ver-'));
  try {
    const vendorDir = join(root, 'vendor', 'adlc');
    mkdirSync(join(vendorDir, 'dist'), { recursive: true });
    writeFileSync(join(vendorDir, 'package.json'), JSON.stringify({ name: '@adlc/cli' }));
    writeFileSync(join(vendorDir, 'dist', 'adlc.bundle.mjs'), '// bundle\n');
    assert.throws(() => computeVendoredDigests(vendorDir), /Invalid or missing version in vendored ADLC manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyAgainstLockfile: detects manifest field mismatch between installed package.json and lockfile entry', async () => {
  const { verifyAgainstLockfile } = await import('../scripts/update-adlc-digests.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'agb-lock-mismatch-'));
  try {
    mkdirSync(join(root, 'node_modules', '@adlc', 'x'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@adlc', 'x', 'package.json'), JSON.stringify({
      name: '@adlc/x',
      version: '1.0.0',
      dependencies: { evil: '1.0.0' }
    }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      packages: {
        'node_modules/@adlc/x': {
          version: '1.0.0',
          integrity: 'sha512-abc==',
          dependencies: {}
        }
      }
    }));
    const res = verifyAgainstLockfile('@adlc/x', { root });
    assert.equal(res.ok, false);
    assert.match(res.error, /manifest field 'dependencies' mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Combining --write and --skip-registry is rejected with exit 1', () => {
  const r = spawnSync(process.execPath, ['scripts/update-adlc-digests.mjs', '--write', '--skip-registry'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--write cannot be combined with --skip-registry/);
});

test('verifyAgainstLockfile: normalizes leading ./ and key order on bin field between package.json and package-lock.json', async () => {
  const { verifyAgainstLockfile } = await import('../scripts/update-adlc-digests.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'agb-lock-bin-norm-'));
  try {
    mkdirSync(join(root, 'node_modules', '@adlc', 'nonexistent-test-pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@adlc', 'nonexistent-test-pkg', 'package.json'), JSON.stringify({
      name: '@adlc/nonexistent-test-pkg',
      version: '1.0.0',
      bin: { 'z-cmd': './bin/z.mjs', 'a-cmd': './bin/a.mjs' }
    }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      packages: {
        'node_modules/@adlc/nonexistent-test-pkg': {
          version: '1.0.0',
          integrity: 'sha512-abc==',
          bin: { 'a-cmd': 'bin/a.mjs', 'z-cmd': 'bin/z.mjs' }
        }
      }
    }));
    const res = verifyAgainstLockfile('@adlc/nonexistent-test-pkg', { root });
    assert.equal(res.ok, false);
    assert.doesNotMatch(res.error, /manifest field 'bin' mismatch against lockfile/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createIntegrationWorktree: accepts a 40-char commit SHA base without mutating parent repo .git/config', async () => {
  const { createIntegrationWorktree, reapIntegrationWorktrees } = await import('../lib/worktrees.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const repo = mkdtempSync(join(tmpdir(), 'agb-int-wt-sha-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test Owner'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'owner@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const wt = createIntegrationWorktree(repo, '12345678-aaaa', sha);
    const parentName = execFileSync('git', ['config', '--local', '--get', 'user.name'], { cwd: repo, encoding: 'utf8' }).trim();
    const wtName = execFileSync('git', ['config', '--local', '--get', 'user.name'], { cwd: wt, encoding: 'utf8' }).trim();
    assert.equal(parentName, 'Test Owner');
    assert.equal(wtName, 'agb-integrator');
    reapIntegrationWorktrees(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});


