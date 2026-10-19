#!/usr/bin/env node
// Verify and (with --write) refresh the digests pinned in lib/adlc-bridge.mjs
// for the booster-owned vendored adlc (spec Appendix A D12, A.6 item 13).
//
//   node scripts/update-adlc-digests.mjs           # verify only; exit 1 on drift
//   node scripts/update-adlc-digests.mjs --write   # rewrite KNOWN_VENDORED_ADLC
//
// Order of trust: every bundled @adlc/* package in node_modules must first
// match its package-lock.json integrity (the registry's published hash, so a
// locally modified dependency can never be pinned); only then are the vendored
// bundle's digests recomputed.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { computeDirectoryDigest } from '../lib/digest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(ROOT, 'lib', 'adlc-bridge.mjs');
export const VENDORED_PACKAGES = [
  '@adlc/core', '@adlc/rails-guard', '@adlc/gate-manifest', '@adlc/flail-detector', '@adlc/hollow-test',
  '@adlc/consensus-fix', '@adlc/model-router', '@adlc/merge-forecast', '@adlc/tickets',
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sri512 = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/** Re-pack the installed package and compare to the lockfile's registry integrity and local node_modules tree. */
export function verifyAgainstLockfile(pkg, { root = ROOT } = {}) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.[`node_modules/${pkg}`];
  if (!entry?.integrity || !entry?.version) return { ok: false, error: `${pkg}: no lockfile integrity` };
  const localDir = join(root, 'node_modules', pkg);
  if (!existsSync(localDir)) return { ok: false, error: `${pkg}: missing from node_modules` };
  const localManifest = JSON.parse(readFileSync(join(localDir, 'package.json'), 'utf8'));
  for (const field of ['version', 'dependencies', 'optionalDependencies', 'bin']) {
    if (entry[field] !== undefined && JSON.stringify(localManifest[field] ?? {}) !== JSON.stringify(entry[field])) {
      return { ok: false, error: `${pkg}@${entry.version}: manifest field '${field}' mismatch against lockfile` };
    }
  }
  const out = mkdtempSync(join(tmpdir(), 'agb-digest-'));
  try {
    // npm pack of the exact registry version reproduces the published tarball.
    const isWin = process.platform === 'win32';
    const name = execFileSync(isWin ? 'npm.cmd' : 'npm', ['pack', `${pkg}@${entry.version}`, '--pack-destination', out, '--silent'], { cwd: out, encoding: 'utf8', shell: isWin }).trim().split('\n').pop();
    const tarballPath = join(out, name);
    const actual = sri512(readFileSync(tarballPath));
    if (actual !== entry.integrity) {
      return { ok: false, error: `${pkg}@${entry.version}: registry tarball ${actual} != lockfile ${entry.integrity}` };
    }
    execFileSync('tar', ['-xzf', tarballPath, '-C', out], { stdio: 'ignore' });
    const unpackedPkgDir = join(out, 'package');
    const registryTreeDigest = computeDirectoryDigest(unpackedPkgDir, { exclude: ['package.json', 'node_modules'] });
    const localTreeDigest = computeDirectoryDigest(localDir, { exclude: ['package.json', 'node_modules'] });
    if (registryTreeDigest !== localTreeDigest) {
      return { ok: false, error: `${pkg}@${entry.version}: local node_modules/${pkg} tree digest (${localTreeDigest}) != registry tarball (${registryTreeDigest})` };
    }
    const unpackedManifest = JSON.parse(readFileSync(join(unpackedPkgDir, 'package.json'), 'utf8'));
    const manifestFields = ['name', 'version', 'main', 'bin', 'exports', 'dependencies'];
    for (const field of manifestFields) {
      if (JSON.stringify(unpackedManifest[field]) !== JSON.stringify(localManifest[field])) {
        return { ok: false, error: `${pkg}@${entry.version}: package.json manifest field '${field}' mismatch` };
      }
    }
    return { ok: true, version: entry.version };
  } catch (err) {
    return { ok: false, error: `${pkg}: ${err.message}` };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function computeVendoredDigests(vendorDir = join(ROOT, 'vendor', 'adlc')) {
  const manifest = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    throw new Error(`Invalid or missing version in vendored ADLC manifest: ${join(vendorDir, 'package.json')}`);
  }
  return {
    version: manifest.version,
    binarySha256: sha256(join(vendorDir, 'bin', 'adlc.mjs')),
    vendoredBundleSha256: sha256(join(vendorDir, 'dist', 'adlc.bundle.mjs')),
    treeDigest: computeDirectoryDigest(vendorDir),
  };
}

const BLOCK = /export const KNOWN_VENDORED_ADLC = Object\.freeze\(\{[\s\S]*?\}\);/;

export function renderBlock(d) {
  return `export const KNOWN_VENDORED_ADLC = Object.freeze({\n  version: '${d.version}',\n  binarySha256: '${d.binarySha256}',\n  vendoredBundleSha256: '${d.vendoredBundleSha256}',\n  treeDigest: '${d.treeDigest}',\n});`;
}

function main(argv) {
  const write = argv.includes('--write');
  const offline = argv.includes('--skip-registry');
  if (!existsSync(join(ROOT, 'vendor', 'adlc'))) {
    process.stderr.write('update-adlc-digests: vendor/adlc is missing; run npm run vendor:bundle first\n');
    return 1;
  }
  if (!offline) {
    for (const pkg of VENDORED_PACKAGES) {
      const r = verifyAgainstLockfile(pkg);
      if (!r.ok) {
        process.stderr.write(`update-adlc-digests: refusing — ${r.error}\n`);
        return 1;
      }
      process.stdout.write(`verified ${pkg}@${r.version} against package-lock integrity\n`);
    }
  }
  const digests = computeVendoredDigests();
  const lockfilePath = join(ROOT, 'package-lock.json');
  if (existsSync(lockfilePath)) {
    const lock = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    const coreVersion = lock.packages?.['node_modules/@adlc/core']?.version ?? lock.dependencies?.['@adlc/core']?.version;
    if (coreVersion && digests.version !== coreVersion) {
      process.stderr.write(`update-adlc-digests: vendored version (${digests.version}) does not match package-lock @adlc/core version (${coreVersion})\n`);
      return 1;
    }
  }
  const source = readFileSync(BRIDGE, 'utf8');
  if (!BLOCK.test(source)) {
    process.stderr.write('update-adlc-digests: KNOWN_VENDORED_ADLC block not found in lib/adlc-bridge.mjs\n');
    return 1;
  }
  const next = source.replace(BLOCK, () => renderBlock(digests));
  if (next === source) {
    process.stdout.write('KNOWN_VENDORED_ADLC is current\n');
    return 0;
  }
  if (!write) {
    process.stderr.write('update-adlc-digests: KNOWN_VENDORED_ADLC is stale; re-run with --write\n');
    return 1;
  }
  writeFileSync(BRIDGE, next);
  process.stdout.write('KNOWN_VENDORED_ADLC updated\n');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
