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
  '@adlc/rails-guard', '@adlc/gate-manifest', '@adlc/flail-detector', '@adlc/hollow-test',
  '@adlc/consensus-fix', '@adlc/model-router', '@adlc/merge-forecast', '@adlc/tickets',
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sri512 = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/** Re-pack the installed package and compare to the lockfile's registry integrity. */
export function verifyAgainstLockfile(pkg, { root = ROOT } = {}) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.[`node_modules/${pkg}`];
  if (!entry?.integrity || !entry?.version) return { ok: false, error: `${pkg}: no lockfile integrity` };
  const out = mkdtempSync(join(tmpdir(), 'agb-digest-'));
  try {
    // npm pack of the exact registry version reproduces the published tarball.
    const name = execFileSync('npm', ['pack', `${pkg}@${entry.version}`, '--pack-destination', out, '--silent'], { cwd: out, encoding: 'utf8' }).trim().split('\n').pop();
    const actual = sri512(readFileSync(join(out, name)));
    return actual === entry.integrity ? { ok: true, version: entry.version } : { ok: false, error: `${pkg}@${entry.version}: registry tarball ${actual} != lockfile ${entry.integrity}` };
  } catch (err) {
    return { ok: false, error: `${pkg}: ${err.message}` };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function computeVendoredDigests(vendorDir = join(ROOT, 'vendor', 'adlc')) {
  const manifest = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8'));
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
