// T-PLUGIN-01-CORE: lib/plugin-paths.mjs — plugin root anchoring, the shared
// safe plugin installer, the integrity-pinned vendored @adlc/antigravity
// install, and the ~/.local/bin/agb terminal shim. Fully offline: every
// install goes through test/fixtures/fake-agy against a temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  copyFileSync, statSync, rmSync, realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  BUNDLED_ADLC_ANTIGRAVITY_VERSION,
  PINNED_ADLC_ANTIGRAVITY_INTEGRITY,
  TERMINAL_SHIM_CONTENT,
  resolvePluginRoot,
  resolveAssetPath,
  safePluginInstall,
  installPluginTarball,
  installAdlcAntigravityFromVendor,
  installTerminalShim,
} from '../lib/plugin-paths.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const VENDOR_TGZ = join(REPO_ROOT, 'vendor', 'cache', 'adlc-antigravity-1.7.0.tgz');

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const integrityOf = (file) => 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');

// Run fn with process.env knobs set, restoring afterwards.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function makePlugin(dir, name, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '0.0.0', ...extra }));
  return dir;
}

// ---------------------------------------------------------------- constants

test('plugin-paths: pinned version/integrity match the package-lock.json entry', () => {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/@adlc/antigravity'];
  assert.equal(BUNDLED_ADLC_ANTIGRAVITY_VERSION, '1.7.0');
  assert.equal(entry.version, BUNDLED_ADLC_ANTIGRAVITY_VERSION);
  assert.equal(PINNED_ADLC_ANTIGRAVITY_INTEGRITY, entry.integrity);
});

test('plugin-paths: committed vendored tarball hashes to the pinned integrity', () => {
  assert.ok(existsSync(VENDOR_TGZ), 'vendor/cache/adlc-antigravity-1.7.0.tgz must be committed');
  assert.equal(integrityOf(VENDOR_TGZ), PINNED_ADLC_ANTIGRAVITY_INTEGRITY);
});

// ------------------------------------------------------- resolvePluginRoot

test('resolvePluginRoot: anchors to this checkout and resolveAssetPath joins under it', () => {
  const root = resolvePluginRoot();
  assert.equal(realpathSync(root), realpathSync(REPO_ROOT));
  assert.equal(resolveAssetPath('vendor/cache/x.tgz'), join(root, 'vendor/cache/x.tgz'));
});

test('resolvePluginRoot: accepts antigravity-booster and antigravity-booster-* names only (A.4 item 18)', () => {
  for (const [name, ok] of [
    ['antigravity-booster', true],
    ['antigravity-booster-fork', true],
    ['antigravity-boosterevil', false],
    ['evil-antigravity-booster', false],
  ]) {
    const base = tmp('agb-root-');
    try {
      const pluginDir = makePlugin(join(base, 'p'), name);
      const start = join(pluginDir, 'lib');
      mkdirSync(start);
      if (ok) {
        assert.equal(resolvePluginRoot(start), pluginDir, name);
      } else {
        assert.throws(() => resolvePluginRoot(start), /Could not resolve/, name);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('resolvePluginRoot: a PLUGIN_ROOT pointing elsewhere is ignored; one equal to the canonical root is honored', () => {
  const base = tmp('agb-root-env-');
  try {
    const pluginDir = makePlugin(join(base, 'p'), 'antigravity-booster');
    const decoy = makePlugin(join(base, 'decoy'), 'antigravity-booster');
    const start = join(pluginDir, 'lib');
    mkdirSync(start);
    withEnv({ PLUGIN_ROOT: decoy }, () => assert.equal(resolvePluginRoot(start), pluginDir));
    withEnv({ PLUGIN_ROOT: pluginDir + '/.' }, () => assert.equal(resolvePluginRoot(start), pluginDir + '/.'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- safePluginInstall

test('safePluginInstall: copy excludes node_modules/.worktrees/.git and the staged name never depends on the source basename', () => {
  const home = tmp('agb-home-');
  const state = tmp('agb-state-');
  const work = tmp('agb-src-');
  try {
    const src = makePlugin(join(work, 'some-random-checkout-name'), 'antigravity-booster');
    writeFileSync(join(src, 'keep.txt'), 'kept');
    for (const d of ['node_modules/pkg', '.worktrees/wt', '.git/objects', 'lib/node_modules/x']) {
      mkdirSync(join(src, d), { recursive: true });
      writeFileSync(join(src, d, 'f'), 'x');
    }
    const res = withEnv({ FAKE_STATE_DIR: state }, () =>
      safePluginInstall(src, 'antigravity-booster', { home, agyBin: FAKE_AGY }));
    assert.deepEqual(res, { ok: true, skipped: false });

    const installArg = readFileSync(join(state, 'plugin-installs'), 'utf8').trim();
    assert.equal(installArg.split('/').pop(), 'antigravity-booster', 'agy receives a copy named after the target');
    assert.ok(!installArg.startsWith(src), 'agy never installs the source dir directly');
    assert.ok(!existsSync(installArg), 'temp copy removed after install');

    const staged = join(home, '.gemini', 'config', 'plugins', 'antigravity-booster');
    assert.ok(existsSync(join(staged, 'plugin.json')));
    assert.equal(readFileSync(join(staged, 'keep.txt'), 'utf8'), 'kept');
    for (const d of ['node_modules', '.worktrees', '.git', 'lib/node_modules']) {
      assert.ok(!existsSync(join(staged, d)), `${d} must be excluded`);
    }
  } finally {
    for (const d of [home, state, work]) rmSync(d, { recursive: true, force: true });
  }
});

test('safePluginInstall: skips self-install when source is the staged directory', () => {
  const home = tmp('agb-home-');
  const state = tmp('agb-state-');
  try {
    const staged = makePlugin(join(home, '.gemini', 'config', 'plugins', 'antigravity-booster'), 'antigravity-booster');
    const res = withEnv({ FAKE_STATE_DIR: state }, () =>
      safePluginInstall(staged, 'antigravity-booster', { home, agyBin: FAKE_AGY }));
    assert.deepEqual(res, { ok: true, skipped: true });
    assert.ok(!existsSync(join(state, 'plugin-installs')), 'agy must not be invoked');
  } finally {
    for (const d of [home, state]) rmSync(d, { recursive: true, force: true });
  }
});

test('safePluginInstall: reinstall from inside the plugins dir (different name) still goes via a temp copy', () => {
  const home = tmp('agb-home-');
  try {
    const src = makePlugin(join(home, '.gemini', 'config', 'plugins', 'antigravity-booster'), 'antigravity-booster');
    writeFileSync(join(src, 'marker'), 'm');
    const res = safePluginInstall(src, 'antigravity-booster-fork', { home, agyBin: FAKE_AGY });
    assert.deepEqual(res, { ok: true, skipped: false });
    assert.ok(existsSync(join(src, 'marker')), 'source survives');
    assert.ok(existsSync(join(home, '.gemini', 'config', 'plugins', 'antigravity-booster-fork', 'marker')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('safePluginInstall: returns {ok:false} (never throws) on missing source, agy failure, and missing staged plugin.json', () => {
  const home = tmp('agb-home-');
  const work = tmp('agb-src-');
  try {
    const missing = safePluginInstall(join(work, 'nope'), 'x', { home, agyBin: FAKE_AGY });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /does not exist/);

    const src = makePlugin(join(work, 'p'), 'antigravity-booster');
    const failed = withEnv({ FAKE_AGY_PLUGIN_MODE: 'fail' }, () =>
      safePluginInstall(src, 'antigravity-booster', { home, agyBin: FAKE_AGY }));
    assert.equal(failed.ok, false);
    assert.equal(typeof failed.error, 'string');

    const unstaged = withEnv({ FAKE_AGY_PLUGIN_MODE: 'no-stage' }, () =>
      safePluginInstall(src, 'antigravity-booster', { home, agyBin: FAKE_AGY }));
    assert.equal(unstaged.ok, false);
    assert.match(unstaged.error, /plugin\.json/);

    const noAgy = safePluginInstall(src, 'antigravity-booster', { home, agyBin: join(work, 'no-such-agy') });
    assert.equal(noAgy.ok, false);
  } finally {
    for (const d of [home, work]) rmSync(d, { recursive: true, force: true });
  }
});

test('safePluginInstall: agy output never reaches stdout (MCP safety)', () => {
  const home = tmp('agb-home-');
  const work = tmp('agb-src-');
  try {
    const src = makePlugin(join(work, 'p'), 'antigravity-booster');
    const script = `import('${new URL('../lib/plugin-paths.mjs', import.meta.url)}').then(m => {
      const r = m.safePluginInstall(${JSON.stringify(src)}, 'antigravity-booster', { home: ${JSON.stringify(home)}, agyBin: ${JSON.stringify(FAKE_AGY)} });
      if (!r.ok) process.exit(3);
    })`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(out, '', 'stdout must stay empty');
  } finally {
    for (const d of [home, work]) rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------- vendored @adlc/antigravity install

test('installAdlcAntigravityFromVendor: installs the pristine tarball into plugins/adlc-antigravity and removes its temp root', () => {
  const home = tmp('agb-home-');
  const state = tmp('agb-state-');
  const tmpParent = tmp('agb-tmpparent-');
  try {
    const res = withEnv({ FAKE_STATE_DIR: state, FAKE_AGY_SNAPSHOT_DIR: tmpParent }, () =>
      installAdlcAntigravityFromVendor({ home, agyBin: FAKE_AGY, tmpParent }));
    assert.deepEqual(res, { ok: true, skipped: false });
    const staged = join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity');
    const manifest = JSON.parse(readFileSync(join(staged, 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'adlc-antigravity');
    assert.equal(manifest.version, '1.7.0');
    assert.ok(!existsSync(join(staged, 'package', 'plugin.json')), 'extracted with --strip-components=1');

    const snapshot = readFileSync(join(state, 'install-snapshot'), 'utf8').split('\n');
    assert.ok(
      snapshot.some((p) => /\/agy-adlc-staging-[^/]+\/adlc-antigravity$/.test(p)),
      'extraction dir is a dedicated adlc-antigravity subdir of a mkdtemp root',
    );
    assert.deepEqual(readdirSync(tmpParent), [], 'all temp roots removed on success');
  } finally {
    for (const d of [home, state, tmpParent]) rmSync(d, { recursive: true, force: true });
  }
});

test('installAdlcAntigravityFromVendor: temp root removed when agy install fails', () => {
  const home = tmp('agb-home-');
  const tmpParent = tmp('agb-tmpparent-');
  try {
    const res = withEnv({ FAKE_AGY_PLUGIN_MODE: 'fail' }, () =>
      installAdlcAntigravityFromVendor({ home, agyBin: FAKE_AGY, tmpParent }));
    assert.equal(res.ok, false);
    assert.deepEqual(readdirSync(tmpParent), [], 'temp roots removed on error');
  } finally {
    for (const d of [home, tmpParent]) rmSync(d, { recursive: true, force: true });
  }
});

test('installAdlcAntigravityFromVendor: a tampered tarball copy is rejected before any extraction', () => {
  const home = tmp('agb-home-');
  const work = tmp('agb-tamper-');
  const tmpParent = tmp('agb-tmpparent-');
  try {
    const tampered = join(work, 'adlc-antigravity-1.7.0.tgz');
    copyFileSync(VENDOR_TGZ, tampered);
    const bytes = readFileSync(tampered);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(tampered, bytes);
    const res = installAdlcAntigravityFromVendor({ home, agyBin: FAKE_AGY, tarballPath: tampered, tmpParent });
    assert.deepEqual(res, { ok: false, error: 'vendored-adlc-antigravity-tampered' });
    assert.deepEqual(readdirSync(tmpParent), []);
    assert.ok(!existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity')));
  } finally {
    for (const d of [home, work, tmpParent]) rmSync(d, { recursive: true, force: true });
  }
});

test('installAdlcAntigravityFromVendor: missing tarball → {ok:false}', () => {
  const res = installAdlcAntigravityFromVendor({ tarballPath: join(tmpdir(), 'definitely-missing-agb.tgz'), agyBin: FAKE_AGY });
  assert.equal(res.ok, false);
  assert.match(res.error, /missing/i);
});

test('installPluginTarball: a tarball with a ../ entry is rejected before extraction', () => {
  const home = tmp('agb-home-');
  const work = tmp('agb-evil-');
  const tmpParent = tmp('agb-tmpparent-');
  try {
    // package/plugin.json plus package/../escape.txt
    makePlugin(join(work, 'package'), 'adlc-antigravity');
    writeFileSync(join(work, 'escape.txt'), 'pwned');
    const evil = join(work, 'evil.tgz');
    execFileSync('tar', ['-P', '-czf', evil, '-C', work, 'package/plugin.json', 'package/../escape.txt']);
    const listing = execFileSync('tar', ['-tzf', evil], { encoding: 'utf8' });
    assert.match(listing, /\.\.\/escape\.txt/, 'fixture really carries a ../ entry');

    const res = installPluginTarball({
      tarballPath: evil, integrity: integrityOf(evil), pluginName: 'adlc-antigravity',
      home, agyBin: FAKE_AGY, tmpParent,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Invalid entry path/);
    assert.deepEqual(readdirSync(tmpParent), [], 'nothing extracted');
  } finally {
    for (const d of [home, work, tmpParent]) rmSync(d, { recursive: true, force: true });
  }
});

test('installPluginTarball: entries outside package/ and integrity mismatches are rejected', () => {
  const work = tmp('agb-evil2-');
  const tmpParent = tmp('agb-tmpparent-');
  try {
    makePlugin(join(work, 'package'), 'adlc-antigravity');
    writeFileSync(join(work, 'other.txt'), 'x');
    const tgz = join(work, 'outside.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', work, 'package/plugin.json', 'other.txt']);
    const res = installPluginTarball({ tarballPath: tgz, integrity: integrityOf(tgz), pluginName: 'adlc-antigravity', agyBin: FAKE_AGY, tmpParent });
    assert.equal(res.ok, false);
    assert.match(res.error, /Invalid entry path in tarball: other\.txt/);

    const wrongIntegrity = installPluginTarball({ tarballPath: tgz, integrity: 'sha512-AAAA', pluginName: 'adlc-antigravity', agyBin: FAKE_AGY, tmpParent });
    assert.equal(wrongIntegrity.ok, false);
    assert.deepEqual(readdirSync(tmpParent), []);
  } finally {
    for (const d of [work, tmpParent]) rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- installTerminalShim

test('installTerminalShim: exact §4.1 content', () => {
  assert.equal(
    TERMINAL_SHIM_CONTENT,
    '#!/bin/sh\nexec /bin/sh "${HOME}/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs "$@"\n',
  );
});

test('installTerminalShim: written (mode 0755, mkdir -p) → unchanged → skipped → force', () => {
  const home = tmp('agb-home-');
  try {
    const shim = join(home, '.local', 'bin', 'agb');

    const first = installTerminalShim({ home });
    assert.deepEqual(first, { ok: true, action: 'written', path: shim });
    assert.equal(readFileSync(shim, 'utf8'), TERMINAL_SHIM_CONTENT);
    assert.equal(statSync(shim).mode & 0o777, 0o755);

    const again = installTerminalShim({ home });
    assert.deepEqual(again, { ok: true, action: 'unchanged', path: shim });

    writeFileSync(shim, '#!/bin/sh\necho user-owned\n');
    const skipped = installTerminalShim({ home });
    assert.deepEqual(skipped, { ok: true, action: 'skipped', path: shim });
    assert.equal(readFileSync(shim, 'utf8'), '#!/bin/sh\necho user-owned\n', 'foreign content untouched');

    const forced = installTerminalShim({ home, force: true });
    assert.deepEqual(forced, { ok: true, action: 'written', path: shim });
    assert.equal(readFileSync(shim, 'utf8'), TERMINAL_SHIM_CONTENT);
    assert.equal(statSync(shim).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(join(home, '.local', 'bin')), ['agb'], 'no temp files left behind');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installTerminalShim: a directory in the way → {ok:false}, never throws', () => {
  const home = tmp('agb-home-');
  try {
    mkdirSync(join(home, '.local', 'bin', 'agb'), { recursive: true });
    const res = installTerminalShim({ home, force: true });
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('copyPluginTree: relative symlinks stay relative, modes survive, exclusions apply at any depth', async () => {
  const { copyPluginTree } = await import('../lib/plugin-paths.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, statSync, existsSync, rmSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'agb-copytree-'));
  try {
    const src = join(root, 'src');
    mkdirSync(join(src, 'bin'), { recursive: true });
    mkdirSync(join(src, 'deep', 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(src, 'deep', '.git'), { recursive: true });
    writeFileSync(join(src, 'bin', 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(src, 'bin', 'run.sh'), 0o755);
    writeFileSync(join(src, 'deep', 'node_modules', 'x', 'i.js'), '');
    symlinkSync('../bin/run.sh', join(src, 'deep', 'link'));
    symlinkSync('missing-target', join(src, 'dangling'));
    const dst = join(root, 'dst');
    copyPluginTree(src, dst);
    assert.equal(readlinkSync(join(dst, 'deep', 'link')), '../bin/run.sh', 'relative target kept verbatim');
    assert.equal(readlinkSync(join(dst, 'dangling')), 'missing-target', 'dangling link copied, not followed');
    assert.equal(statSync(join(dst, 'bin', 'run.sh')).mode & 0o777, 0o755);
    assert.equal(existsSync(join(dst, 'deep', 'node_modules')), false);
    assert.equal(existsSync(join(dst, 'deep', '.git')), false);
    copyPluginTree(join(src, 'vanished-before-copy'), join(root, 'dst2')); // ENOENT source is tolerated
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
