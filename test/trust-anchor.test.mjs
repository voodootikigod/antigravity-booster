import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  signPayload,
  extractAgySection,
  computeDirectoryTreeSha,
  digestTarball,
  readExistingPayload,
  writeStore,
} from '../skills/modernize/scripts/trust-anchor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(here, '..', 'skills', 'modernize', 'scripts', 'trust-anchor.mjs');
const AUDIT_SRC = fs.readFileSync(path.join(here, '..', 'skills', 'modernize', 'scripts', 'audit.mjs'), 'utf8');
const KEY = 'test-admin-key';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agb-trust-test-'));
}

/** Pull a top-level function out of audit.mjs (which runs main() on import) so parity is checked against the real source. */
function auditFn(name) {
  const start = AUDIT_SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `audit.mjs defines ${name}`);
  const end = AUDIT_SRC.indexOf('\n}\n', start);
  const ctx = { fs, path, crypto, zlib, console };
  vm.createContext(ctx);
  vm.runInContext(`${AUDIT_SRC.slice(start, end + 2)}\nthis.fn = ${name};`, ctx);
  return ctx.fn;
}

function tarEntry(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('0', 156);
  header.write('        ', 148);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([header, data, pad]);
}

function makeTgz(files) {
  const body = Object.entries(files).map(([n, d]) => tarEntry(n, Buffer.from(d)));
  return zlib.gzipSync(Buffer.concat([...body, Buffer.alloc(1024)]));
}

describe('trust-anchor: parity with audit.mjs', () => {
  it('canonicalJson matches audit.mjs', () => {
    const sample = { b: [1, { z: null, a: 'x' }], a: true, c: { y: 2, x: 1 } };
    assert.equal(canonicalJson(sample), auditFn('canonicalJson')(sample));
  });

  it('extractAgySection matches audit.mjs for heading and html layouts', () => {
    const md = '# Log\n\n## 1.4.7\nnew\n\n## 1.4.6\nold\n';
    const html = '<main><section id="v1.4.7"><p>x</p></section><section id="v1.4.6">y</section></main>';
    const auditFnRef = auditFn('extractAgySection');
    for (const raw of [md, html, '## 9.9.9\nnope']) {
      assert.equal(extractAgySection(raw, '1.4.7'), auditFnRef(raw, '1.4.7'));
    }
    assert.equal(extractAgySection(md, '1.4.7'), '## 1.4.7\nnew');
  });

  it('extractAgySection requires an exact version token, in both copies', () => {
    const auditFnRef = auditFn('extractAgySection');
    const longer = '# Log\n\n## 1.4.70\nwrong\n\n## 1.4.7.1\nalso wrong\n\n## 1.4.6\nold\n';
    const bracketed = '# Log\n\n## [v1.4.7] - 2026-10-01\nright\n\n## 1.4.70\nwrong\n';
    for (const fn of [extractAgySection, auditFnRef]) {
      assert.equal(fn(longer, '1.4.7'), null, 'a 1.4.70 or 1.4.7.1 heading is not 1.4.7');
      assert.equal(fn(bracketed, '1.4.7'), '## [v1.4.7] - 2026-10-01\nright');
      assert.equal(fn('<section id="v1.4.70">x</section>', '1.4.7'), null);
    }
  });

  it('computeDirectoryTreeSha matches audit.mjs and rejects symlinks', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'a');
    assert.equal(computeDirectoryTreeSha(dir), auditFn('computeDirectoryTreeSha')(dir));
    fs.symlinkSync('/etc/hostname', path.join(dir, 'link'));
    assert.throws(() => computeDirectoryTreeSha(dir), /Symlink rejected/);
  });

  it('digestTarball reproduces the unpacked-tree digest and the SRI', () => {
    const tgz = makeTgz({ 'package/package.json': '{"name":"@adlc/cli"}', 'package/lib/x.js': 'x' });
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"@adlc/cli"}');
    fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'x');
    const d = digestTarball(tgz);
    assert.equal(d.packageTreeSha512, computeDirectoryTreeSha(dir));
    assert.equal(d.adlcTarballSri, 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64'));
  });
});

describe('trust-anchor: tarball identity', () => {
  const tgzOf = (name, version) => makeTgz({ 'package/package.json': JSON.stringify({ name, version }) });

  it('digestTarball refuses a tarball of another version or package when a version is requested', () => {
    assert.throws(() => digestTarball(tgzOf('@adlc/cli', '1.11.1'), '1.12.0'), /not @adlc\/cli@1\.12\.0/);
    assert.throws(() => digestTarball(tgzOf('@adlc/core', '1.12.0'), '1.12.0'), /not @adlc\/cli@1\.12\.0/);
    assert.ok(digestTarball(tgzOf('@adlc/cli', '1.12.0'), '1.12.0').adlcTarballSri);
  });

  it('audit.mjs enforces the same identity check on the unpacked archive', () => {
    const check = auditFn('assertCliTarballIdentity');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"@adlc/cli","version":"1.11.1"}');
    assert.throws(() => check(dir, '1.12.0'), /not @adlc\/cli@1\.12\.0/);
    assert.doesNotThrow(() => check(dir, '1.11.1'));
    fs.rmSync(path.join(dir, 'package.json'));
    assert.throws(() => check(dir, '1.12.0'), /no readable package\.json/);
  });
});

describe('trust-anchor: store read/write', () => {
  it('writes mode 0600, round-trips, and verifies the signature', () => {
    const store = path.join(tmpDir(), 'sub', 'trusted_packages.json');
    const payload = { releases: { '1.0.0': { agyChangelogSha256: 'ab' } } };
    writeStore(store, payload, KEY);
    assert.equal(fs.statSync(store).mode & 0o777, 0o600);
    assert.deepEqual(readExistingPayload(store, KEY), payload);
    assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).signature, signPayload(payload, KEY));
  });

  it('refuses a tampered store, a wrong key, and a symlink', () => {
    const dir = tmpDir();
    const store = path.join(dir, 'trusted_packages.json');
    writeStore(store, { releases: { '1.0.0': { agyChangelogSha256: 'ab' } } }, KEY);
    assert.throws(() => readExistingPayload(store, 'other-key'), /fails HMAC/);
    const tampered = JSON.parse(fs.readFileSync(store, 'utf8'));
    tampered.payload.releases['1.0.0'].agyChangelogSha256 = 'ff';
    fs.writeFileSync(store, JSON.stringify(tampered));
    assert.throws(() => readExistingPayload(store, KEY), /fails HMAC/);
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(store, link);
    assert.throws(() => readExistingPayload(link, KEY), /symlink/);
  });

  it('returns an empty payload when no store exists', () => {
    assert.deepEqual(readExistingPayload(path.join(tmpDir(), 'none.json'), KEY), { releases: {} });
  });
});

describe('trust-anchor: CLI', () => {
  function setup() {
    const home = tmpDir();
    const work = tmpDir();
    const agy = path.join(work, 'agy.md');
    const adlc = path.join(work, 'adlc.md');
    const tgz = path.join(work, 'cli.tgz');
    fs.writeFileSync(agy, '## 1.4.7\nnotes\n\n## 1.4.6\nold\n');
    fs.writeFileSync(adlc, '# adlc changelog\n');
    fs.writeFileSync(tgz, makeTgz({ 'package/package.json': '{"name":"@adlc/cli","version":"1.12.0"}' }));
    const args = ['--agy-version', '1.4.7', '--adlc-version', '1.12.0', '--agy-notes', agy, '--adlc-changelog', adlc, '--tarball', tgz];
    const run = (extra, env = {}) =>
      execFileSync(process.execPath, [HELPER, ...args, ...extra], {
        env: { PATH: process.env.PATH, HOME: home, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    return { home, tgz, run, store: path.join(home, '.adlc', 'trusted_packages.json') };
  }

  it('dry run prints digests and writes nothing', () => {
    const { run, store } = setup();
    const out = run([]);
    assert.match(out, /sha256 [0-9a-f]{64}/);
    assert.match(out, /Dry run: nothing written/);
    assert.equal(fs.existsSync(store), false);
  });

  it('refuses to attest a tarball that is not the requested ADLC version, and writes nothing', () => {
    const { run, store, tgz } = setup();
    fs.writeFileSync(tgz, makeTgz({ 'package/package.json': '{"name":"@adlc/cli","version":"1.11.1"}' }));
    assert.throws(() => run(['--write', '--yes'], { ADLC_ADMIN_KEY: KEY }), /not @adlc\/cli@1\.12\.0/);
    assert.equal(fs.existsSync(store), false);
  });

  it('--write --yes signs both releases and preserves existing releases', () => {
    const { run, store } = setup();
    writeStore(store, { releases: { '1.11.1': { adlcTarballSri: 'keep' } } }, KEY);
    run(['--write', '--yes'], { ADLC_ADMIN_KEY: KEY });
    const payload = readExistingPayload(store, KEY);
    assert.equal(payload.releases['1.11.1'].adlcTarballSri, 'keep');
    assert.match(payload.releases['1.4.7'].agyChangelogSha256, /^[0-9a-f]{64}$/);
    assert.match(payload.releases['1.12.0'].adlcTarballSri, /^sha512-/);
    assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  });

  it('--write fails closed without ADLC_ADMIN_KEY and without a TTY or --yes', () => {
    const { run, store } = setup();
    assert.throws(() => run(['--write', '--yes']), /ADLC_ADMIN_KEY is not set/);
    assert.throws(() => run(['--write'], { ADLC_ADMIN_KEY: KEY }), /interactive terminal or --yes/);
    assert.equal(fs.existsSync(store), false);
  });

  it('requires --adlc-changelog', () => {
    assert.throws(
      () => execFileSync(process.execPath, [HELPER, '--agy-version', '1.4.7', '--adlc-version', '1.12.0'], { encoding: 'utf8', stdio: 'pipe' }),
      /adlc-changelog/,
    );
  });
});
