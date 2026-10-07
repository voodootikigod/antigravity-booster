// T-PLUGIN-03: the §4.4 Normative Bootstrap & Doctor Decision Table, evaluated
// in the Unified Evaluation Order (validity -> older -> pinned digest ->
// newer contract), with Appendix A.4 items 16-17. One case per table row; the
// bootstrap and doctor columns come from the same evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateStagedAdlcPlugin, checkPlugin } from '../lib/doctor.mjs';
import { VENDORED_ADLC_ANTIGRAVITY_TARBALL } from '../lib/plugin-paths.mjs';
import { computeDirectoryDigest } from '../lib/digest.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const pluginDir = (home) => join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity');

function stageManifest(home, manifest) {
  const dir = pluginDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
}

// A real pristine staged 1.7.0 tree (extracted vendored tarball).
function stagePristine(home) {
  const dir = pluginDir(home);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', VENDORED_ADLC_ANTIGRAVITY_TARBALL, '-C', dir, '--strip-components=1']);
  return dir;
}

function withHome(fn) {
  const home = tmp('agb-contract-home-');
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

const pick = (r) => ({
  report: r.report, doctorExit: r.doctorExit, bootstrapAction: r.bootstrapAction, bootstrapExit: r.bootstrapExit, railsTrusted: r.railsTrusted,
});

test('row: absent / not installed', () => withHome((home) => {
  assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
    report: 'not-installed', doctorExit: 1, bootstrapAction: 'install', bootstrapExit: 0, railsTrusted: false,
  });
  mkdirSync(pluginDir(home), { recursive: true }); // dir present, plugin.json absent
  assert.equal(evaluateStagedAdlcPlugin({ home }).report, 'not-installed');
}));

test('row: corrupt JSON / no semver → corrupt-manifest, bootstrap fails closed', () => withHome((home) => {
  const expected = { report: 'corrupt-manifest', doctorExit: 1, bootstrapAction: 'fail', bootstrapExit: 1, railsTrusted: false };
  for (const m of ['{not json', '[1]', { name: 'adlc-antigravity' }, { version: '1.7' }, { version: 'v1.7.0' }, { version: '1.07.0' }]) {
    stageManifest(home, m);
    assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), expected, JSON.stringify(m));
  }
}));

test('row: present but unreadable plugin.json → corrupt-manifest (never not-installed)', { skip: process.getuid?.() === 0 && 'root reads everything' }, () => withHome((home) => {
  const dir = stageManifest(home, { version: '1.7.0', adlcContract: 1 });
  chmodSync(join(dir, 'plugin.json'), 0o000);
  try {
    assert.equal(evaluateStagedAdlcPlugin({ home }).report, 'corrupt-manifest');
  } finally { chmodSync(join(dir, 'plugin.json'), 0o644); }
}));

test('row: older (< 1.7.0) without contract (1.3.0) → outdated-plugin, auto-upgrade', () => withHome((home) => {
  stageManifest(home, { name: 'adlc-antigravity', version: '1.3.0' });
  assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
    report: 'outdated-plugin', doctorExit: 1, bootstrapAction: 'install', bootstrapExit: 0, railsTrusted: false,
  });
}));

test('row: older (< 1.7.0) with contract 1 (1.6.0) → outdated-plugin; a 1.7.0 prerelease is older too', () => withHome((home) => {
  for (const version of ['1.6.0', '1.7.0-rc.1']) {
    stageManifest(home, { name: 'adlc-antigravity', version, adlcContract: 1 });
    const r = evaluateStagedAdlcPlugin({ home });
    assert.equal(r.report, 'outdated-plugin', version);
    assert.equal(r.bootstrapAction, 'install');
  }
}));

test('row: pinned 1.7.0, contract 1, digest matches → compatible, railsTrusted', () => withHome((home) => {
  stagePristine(home);
  assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
    report: 'compatible', doctorExit: 0, bootstrapAction: 'preserve', bootstrapExit: 0, railsTrusted: true,
  });
}));

test('row: pinned 1.7.0, digest mismatch → corrupt-tree (checked before contract), reinstall', () => withHome((home) => {
  const dir = stagePristine(home);
  appendFileSync(join(dir, 'README.md'), '\ntampered\n');
  assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
    report: 'corrupt-tree', doctorExit: 1, bootstrapAction: 'reinstall', bootstrapExit: 0, railsTrusted: false,
  });
  // A contract edit also changes the digest (plugin.json is covered), so it is corrupt-tree, not incompatible.
  const m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...m, adlcContract: 2 }));
  assert.equal(evaluateStagedAdlcPlugin({ home }).report, 'corrupt-tree');
}));

test('pinned family includes build metadata: 1.7.0+x is digest-checked, not treated as newer-unpinned', () => withHome((home) => {
  const dir = stagePristine(home);
  const m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...m, version: '1.7.0+local' }));
  assert.equal(evaluateStagedAdlcPlugin({ home }).report, 'corrupt-tree');
}));

test('row: pinned 1.7.0, digest matches, contract !== 1 or absent → incompatible-contract, reinstall (injected map)', () => withHome((home) => {
  for (const manifest of [{ name: 'adlc-antigravity', version: '1.7.0', adlcContract: 2 }, { name: 'adlc-antigravity', version: '1.7.0' }]) {
    const dir = stageManifest(home, manifest);
    const stagedDigests = { '1.7.0': computeDirectoryDigest(dir) };
    assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home, stagedDigests })), {
      report: 'incompatible-contract', doctorExit: 1, bootstrapAction: 'reinstall', bootstrapExit: 0, railsTrusted: false,
    }, JSON.stringify(manifest));
  }
}));

test('row: newer unpinned, contract 1 → compatible (newer-unpinned: vX), preserved, not trusted', () => withHome((home) => {
  stageManifest(home, { name: 'adlc-antigravity', version: '1.8.2', adlcContract: 1 });
  assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
    report: 'compatible (newer-unpinned: v1.8.2)', doctorExit: 0, bootstrapAction: 'preserve', bootstrapExit: 0, railsTrusted: false,
  });
}));

test('row: newer unpinned, contract absent → tolerant (unconfirmed-contract), preserved', () => withHome((home) => {
  stageManifest(home, { name: 'adlc-antigravity', version: '2.0.0' });
  assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
    report: 'tolerant (unconfirmed-contract)', doctorExit: 0, bootstrapAction: 'preserve', bootstrapExit: 0, railsTrusted: false,
  });
}));

test('row: newer unpinned, contract !== 1 → incompatible-contract, bootstrap fails closed', () => withHome((home) => {
  for (const adlcContract of [2, 0, '1']) {
    stageManifest(home, { name: 'adlc-antigravity', version: '1.9.0', adlcContract });
    assert.deepEqual(pick(evaluateStagedAdlcPlugin({ home })), {
      report: 'incompatible-contract', doctorExit: 1, bootstrapAction: 'fail', bootstrapExit: 1, railsTrusted: false,
    }, String(adlcContract));
  }
}));

test('checkPlugin reports the evaluator row: fail for exit-1 rows, pass/warn for exit-0 rows', async () => {
  const cases = [
    [(home) => {}, 'fail', /not-installed/],
    [(home) => stageManifest(home, { version: '1.3.0' }), 'fail', /outdated-plugin/],
    [(home) => stagePristine(home), 'pass', /^compatible$/],
    [(home) => stageManifest(home, { version: '1.8.0', adlcContract: 1 }), 'pass', /newer-unpinned: v1\.8\.0/],
    [(home) => stageManifest(home, { version: '2.0.0' }), 'warn', /tolerant \(unconfirmed-contract\)/],
  ];
  for (const [stage, level, detail] of cases) {
    const home = tmp('agb-checkplugin-');
    try {
      stage(home);
      const c = await checkPlugin({ home });
      assert.equal(c.level, level, `${detail}`);
      assert.match(c.detail, detail);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});
