#!/usr/bin/env node
/**
 * Operator trust-anchor helper for the /modernize audit (Stage 5).
 *
 * Computes the release digests Stage 5 expects and, only with --write, signs
 * them into ~/.adlc/trusted_packages.json (HMAC-SHA256 keyed by
 * ADLC_ADMIN_KEY). This is an ATTESTATION: run it yourself after reading the
 * release notes it prints, never from an unattended agent.
 *
 * Usage:
 *   node skills/modernize/scripts/trust-anchor.mjs --agy-version 1.4.7 --adlc-version 1.12.0 \
 *     [--agy-notes <path|url>] [--adlc-changelog <path|url>] [--tarball <path>] [--write [--yes]]
 *
 * Dry-run by default: prints digests and sources, writes nothing.
 * The same --agy-notes / --adlc-changelog values must be passed to audit.mjs
 * afterwards via AGY_RELEASE_URL / ADLC_CHANGELOG_URL, or Stage 5 will hash
 * different bytes than the ones you attested.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import cp from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const STORE_PATH = path.join(os.homedir(), '.adlc', 'trusted_packages.json');

// RFC 8785 subset; must stay byte-identical to canonicalJson in audit.mjs.
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function signPayload(payload, key) {
  return crypto.createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Mirrors extractAgySection in audit.mjs.
export function extractAgySection(raw, ver) {
  const escaped = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const html = raw.match(new RegExp(`<section[^>]*id=["']v?${escaped}["'][\\s\\S]*?<\\/section>`, 'i'));
  if (html) return html[0].trim();
  const start = raw.match(new RegExp(`(^|\\n)##\\s*\\[?v?${escaped}(?![0-9A-Za-z]|\\.\\d)\\]?`, 'i'));
  if (!start) return null;
  const rest = raw.slice(start.index + (start[1] ? 1 : 0));
  const next = rest.slice(start[0].length).match(/(^|\n)##\s*\[?v?\d/);
  return next ? rest.slice(0, start[0].length + next.index).trim() : rest.trim();
}

// Mirrors unpackTgz in audit.mjs (pure JS, no external tar).
export function unpackTgz(tgzBuf, outDir) {
  const tar = zlib.gunzipSync(tgzBuf);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const typeflag = String.fromCharCode(header[156]);
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim().replace(/\0.*$/, ''), 8) || 0;
    const blocks = Math.ceil(size / 512) * 512;
    let nameEnd = header.indexOf(0);
    if (nameEnd < 0 || nameEnd > 100) nameEnd = 100;
    let name = header.subarray(0, nameEnd).toString('utf8').replace(/\0+$/, '');
    if (!name) {
      offset += blocks;
      continue;
    }
    if (header.subarray(257, 262).toString('utf8') === 'ustar') {
      let prefixEnd = header.indexOf(0, 345);
      if (prefixEnd < 0 || prefixEnd > 500) prefixEnd = 500;
      const prefix = header.subarray(345, prefixEnd).toString('utf8').replace(/\0+$/, '');
      if (prefix) name = prefix + '/' + name;
    }
    const dest = path.join(outDir, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
    if (typeflag === '5' || name.endsWith('/')) {
      fs.mkdirSync(dest, { recursive: true });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, tar.subarray(offset, offset + size));
    }
    offset += blocks;
  }
}

// Mirrors computeDirectoryTreeSha in audit.mjs.
export function computeDirectoryTreeSha(dir) {
  const files = [];
  const scan = (d, rel = '') => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink rejected in package tree: ${subRel}`);
      if (entry.isDirectory()) scan(full, subRel);
      else if (entry.isFile()) files.push(`${subRel}:${crypto.createHash('sha512').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  scan(dir);
  files.sort();
  return crypto.createHash('sha512').update(files.join('\n')).digest('hex');
}

async function fetchText(src) {
  if (src.startsWith('file://')) return fs.readFileSync(fileURLToPath(src), 'utf8');
  if (fs.existsSync(src)) return fs.readFileSync(src, 'utf8');
  const res = await fetch(src, { headers: { 'User-Agent': 'agb-trust-anchor/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${src}`);
  return res.text();
}

function loadTarball(adlcVersion, tarballPath) {
  if (tarballPath) return fs.readFileSync(tarballPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-trust-pack-'));
  try {
    cp.execFileSync('npm', ['pack', `@adlc/cli@${adlcVersion}`], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no .tgz');
    return fs.readFileSync(path.join(tmp, tgz));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function digestTarball(tgzBuf) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-trust-ref-'));
  try {
    unpackTgz(tgzBuf, tmp);
    const pkg = path.join(tmp, 'package');
    return {
      adlcTarballSri: 'sha512-' + crypto.createHash('sha512').update(tgzBuf).digest('base64'),
      packageTreeSha512: computeDirectoryTreeSha(fs.existsSync(pkg) ? pkg : tmp),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Read and authenticate an existing store; returns its payload (or an empty one). */
export function readExistingPayload(storePath, key) {
  if (!fs.existsSync(storePath)) return { releases: {} };
  const stat = fs.lstatSync(storePath);
  if (stat.isSymbolicLink()) throw new Error('existing trust store is a symlink; refusing to touch it');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  if (signPayload(store.payload, key) !== store.signature) {
    throw new Error('existing trust store fails HMAC verification with ADLC_ADMIN_KEY; refusing to overwrite it');
  }
  return { ...store.payload, releases: { ...(store.payload?.releases ?? {}) } };
}

/** Atomically write the signed store with mode 0600. Returns a new payload; never mutates its input. */
export function writeStore(storePath, payload, key) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmp = `${storePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ payload, signature: signPayload(payload, key) }, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, storePath);
}

function parseArgs(argv) {
  const opts = { write: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--yes') opts.yes = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
      i += 1;
    } else throw new Error(`unexpected argument: ${a}`);
  }
  if (!opts.agyVersion || !opts.adlcVersion) throw new Error('--agy-version and --adlc-version are required');
  return opts;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const agySrc = o.agyNotes ?? `https://antigravity.google/releases/v${o.agyVersion}/changelog.md`;
  const adlcSrc = o.adlcChangelog;
  if (!adlcSrc) {
    throw new Error('--adlc-changelog <path|url> is required: the @adlc/cli tarball ships no CHANGELOG, so name the release notes you reviewed');
  }

  let agyRaw;
  try {
    agyRaw = await fetchText(agySrc);
  } catch (err) {
    if (o.agyNotes) throw err;
    console.warn(`warn: ${err.message}; trying https://antigravity.google/changelog`);
    agyRaw = await fetchText('https://antigravity.google/changelog');
  }
  const agySection = extractAgySection(agyRaw, o.agyVersion);
  const adlcRaw = await fetchText(adlcSrc);
  const tarball = digestTarball(loadTarball(o.adlcVersion, o.tarball));

  const release = {
    agy: { agyChangelogSha256: sha256(agySection ?? agyRaw) },
    adlc: { ...tarball, adlcChangelogSha256: sha256(adlcRaw) },
  };

  console.log(`agy ${o.agyVersion} notes: ${agySrc} (${agySection ? 'section' : 'FULL DOCUMENT; no version section found'}, ${(agySection ?? agyRaw).length} chars)`);
  console.log(`  sha256 ${release.agy.agyChangelogSha256}`);
  console.log(`adlc ${o.adlcVersion} changelog: ${adlcSrc} (${adlcRaw.length} chars)`);
  console.log(`  sha256 ${release.adlc.adlcChangelogSha256}`);
  console.log(`  tarball SRI ${release.adlc.adlcTarballSri}`);
  console.log(`  tree sha512 ${release.adlc.packageTreeSha512}`);

  if (!o.write) {
    console.log('\nDry run: nothing written. Review the sources above, then re-run with --write to sign.');
    return;
  }

  const key = process.env.ADLC_ADMIN_KEY;
  if (!key) throw new Error('ADLC_ADMIN_KEY is not set; cannot sign');
  if (!o.yes) {
    if (!process.stdin.isTTY) throw new Error('--write needs an interactive terminal or --yes');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nType "attest" to sign these digests into ${STORE_PATH}: `);
    rl.close();
    if (answer.trim() !== 'attest') throw new Error('not confirmed; nothing written');
  }

  const existing = readExistingPayload(STORE_PATH, key);
  const payload = {
    ...existing,
    releases: {
      ...existing.releases,
      [o.adlcVersion]: { ...existing.releases[o.adlcVersion], ...release.adlc },
      [o.agyVersion]: { ...existing.releases[o.agyVersion], ...release.agy },
    },
  };
  writeStore(STORE_PATH, payload, key);
  console.log(`\nSigned and wrote ${STORE_PATH} (mode 0600).`);
  console.log(`Now run the audit with the same sources:\n  AGY_RELEASE_URL='${agySrc}' ADLC_CHANGELOG_URL='${adlcSrc}' node skills/modernize/scripts/audit.mjs ${o.adlcVersion} <adlc-ref> ${o.agyVersion} v${o.agyVersion}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
