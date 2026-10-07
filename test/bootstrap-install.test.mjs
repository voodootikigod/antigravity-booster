// T-PLUGIN-03: `agb bootstrap` acts on the §4.4 decision table (shared with
// doctor), --force-reinstall always reinstalls, installs are verified
// afterwards, and the env plugin override needs an unbundled dev opt-in.
// Every run uses a temp HOME and test/fixtures/fake-agy, never the real agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

import { STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS } from '../lib/adlc-bridge.mjs';
import { computeDirectoryDigest } from '../lib/digest.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const BOOTSTRAP_URL = new URL('../lib/bootstrap.mjs', import.meta.url).href;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agb-bootinstall-'));
  const ctx = { root };
  for (const d of ['home', 'skills', 'state', 'tmp']) { ctx[d] = join(root, d); mkdirSync(ctx[d]); }
  ctx.cleanup = () => rmSync(root, { recursive: true, force: true });
  return ctx;
}

function runBootstrap(ctx, opts = {}, env = {}) {
  const args = JSON.stringify({ destination: ctx.skills, home: ctx.home, agyBin: FAKE_AGY, ...opts });
  const childEnv = { ...process.env, HOME: ctx.home, FAKE_STATE_DIR: ctx.state, TMPDIR: ctx.tmp, ...env };
  for (const k of ['ADLC_ANTIGRAVITY_PLUGIN_PATH', 'AGB_DEV_ALLOW_UNVERIFIED_PLUGIN', 'AGB_PROVIDER']) if (!(k in env)) delete childEnv[k];
  const r = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    `import('${BOOTSTRAP_URL}').then(({ bootstrap }) => bootstrap(${args}))`,
  ], { encoding: 'utf8', env: childEnv });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const staged = (ctx) => join(ctx.home, '.gemini', 'config', 'plugins', 'adlc-antigravity');
const manifest = (ctx) => JSON.parse(readFileSync(join(staged(ctx), 'plugin.json'), 'utf8'));
const adlcInstalls = (ctx) => {
  const f = join(ctx.state, 'plugin-installs');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter((p) => p.endsWith('/adlc-antigravity')) : [];
};
const isPristine = (ctx) => computeDirectoryDigest(staged(ctx)) === STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS['1.7.0'];

function stage(ctx, m) {
  mkdirSync(staged(ctx), { recursive: true });
  writeFileSync(join(staged(ctx), 'plugin.json'), typeof m === 'string' ? m : JSON.stringify(m));
}

test('not-installed: installs the pristine bundled plugin, exit 0, staging cleaned up', () => {
  const ctx = setup();
  try {
    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(adlcInstalls(ctx).length, 1);
    assert.ok(isPristine(ctx), 'staged tree equals the pinned pristine digest');
    assert.equal(manifest(ctx).name, 'adlc-antigravity', 'staged under its own name, not truncated or misnamed');
    assert.match(r.stdout, /adlc-antigravity: compatible/);
    assert.deepEqual(readdirSync(ctx.tmp).filter((n) => n.startsWith('agy-adlc-staging-')), [], 'temp staging removed');
  } finally { ctx.cleanup(); }
});

test('outdated-plugin (1.3.0, no contract; 1.6.0, contract 1): auto-upgrades, exit 0', () => {
  for (const m of [{ name: 'adlc-antigravity', version: '1.3.0' }, { name: 'adlc-antigravity', version: '1.6.0', adlcContract: 1 }]) {
    const ctx = setup();
    try {
      stage(ctx, m);
      const r = runBootstrap(ctx);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`upgrading adlc-antigravity ${m.version.replace(/\./g, '\\.')} -> 1\\.7\\.0`));
      assert.ok(isPristine(ctx));
    } finally { ctx.cleanup(); }
  }
});

test('corrupt-manifest: fails closed (exit 1), leaves the plugin untouched, advises --force-reinstall', () => {
  const ctx = setup();
  try {
    stage(ctx, '{not json');
    const r = runBootstrap(ctx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /corrupt-manifest.*--force-reinstall/s);
    assert.equal(adlcInstalls(ctx).length, 0);
    assert.equal(readFileSync(join(staged(ctx), 'plugin.json'), 'utf8'), '{not json');
  } finally { ctx.cleanup(); }
});

test('corrupt-tree (pinned 1.7.0, tampered): reinstalls the pristine tree, exit 0', () => {
  const ctx = setup();
  try {
    assert.equal(runBootstrap(ctx).status, 0);
    appendFileSync(join(staged(ctx), 'README.md'), '\ntampered\n');
    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /reinstalling adlc-antigravity: corrupt-tree/);
    assert.ok(isPristine(ctx));
    assert.equal(adlcInstalls(ctx).length, 2);
  } finally { ctx.cleanup(); }
});

test('compatible (pinned, pristine): preserved without reinstalling, exit 0', () => {
  const ctx = setup();
  try {
    assert.equal(runBootstrap(ctx).status, 0);
    const r = runBootstrap(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /adlc-antigravity 1\.7\.0 verified \(compatible\)/);
    assert.equal(adlcInstalls(ctx).length, 1, 'no second install');
  } finally { ctx.cleanup(); }
});

test('newer unpinned with contract 1, or tolerant: preserved with notice/warning, exit 0', () => {
  for (const [m, re, stream] of [
    [{ name: 'adlc-antigravity', version: '1.9.0', adlcContract: 1 }, /notice: .*compatible \(newer-unpinned: v1\.9\.0\)/, 'stdout'],
    [{ name: 'adlc-antigravity', version: '2.0.0' }, /warning: .*tolerant \(unconfirmed-contract\)/, 'stderr'],
  ]) {
    const ctx = setup();
    try {
      stage(ctx, m);
      const r = runBootstrap(ctx);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r[stream], re);
      assert.equal(adlcInstalls(ctx).length, 0);
      assert.equal(manifest(ctx).version, m.version);
    } finally { ctx.cleanup(); }
  }
});

test('newer unpinned with contract !== 1: fails closed (exit 1) until --force-reinstall', () => {
  const ctx = setup();
  try {
    stage(ctx, { name: 'adlc-antigravity', version: '1.9.0', adlcContract: 2 });
    const r = runBootstrap(ctx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /incompatible-contract.*--force-reinstall/s);
    assert.equal(manifest(ctx).version, '1.9.0');

    const forced = runBootstrap(ctx, { forceReinstall: true });
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(isPristine(ctx));
  } finally { ctx.cleanup(); }
});

test('--force-reinstall reinstalls even a pristine compatible plugin', () => {
  const ctx = setup();
  try {
    assert.equal(runBootstrap(ctx).status, 0);
    assert.equal(runBootstrap(ctx, { forceReinstall: true }).status, 0);
    assert.equal(adlcInstalls(ctx).length, 2);
  } finally { ctx.cleanup(); }
});

test('an install that does not verify afterwards fails (exit 1), staging still cleaned up', () => {
  const ctx = setup();
  try {
    // agy reports success but stages a tree that is not the pristine 1.7.0.
    const r = runBootstrap(ctx, {}, { FAKE_AGY_PLUGIN_MODE: 'tamper-stage' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /adlc-antigravity is corrupt-tree after install/);
    assert.deepEqual(readdirSync(ctx.tmp).filter((n) => n.startsWith('agy-adlc-staging-')), []);
  } finally { ctx.cleanup(); }
});

test('a failing agy install exits 1 and removes temp staging', () => {
  const ctx = setup();
  try {
    const r = runBootstrap(ctx, {}, { FAKE_AGY_PLUGIN_MODE: 'fail' });
    assert.equal(r.status, 1);
    assert.deepEqual(readdirSync(ctx.tmp).filter((n) => n.startsWith('agy-adlc-staging-')), []);
  } finally { ctx.cleanup(); }
});

test('ADLC_ANTIGRAVITY_PLUGIN_PATH is ignored without AGB_DEV_ALLOW_UNVERIFIED_PLUGIN=1', () => {
  const ctx = setup();
  try {
    const src = join(ctx.root, 'adlc-antigravity');
    mkdirSync(src);
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ name: 'adlc-antigravity', version: '9.0.0', adlcContract: 1 }));
    const ignored = runBootstrap(ctx, {}, { ADLC_ANTIGRAVITY_PLUGIN_PATH: src });
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.ok(isPristine(ctx), 'vendored pristine plugin installed, override ignored');

    rmSync(staged(ctx), { recursive: true, force: true });
    const honoured = runBootstrap(ctx, {}, { ADLC_ANTIGRAVITY_PLUGIN_PATH: src, AGB_DEV_ALLOW_UNVERIFIED_PLUGIN: '1' });
    assert.equal(honoured.status, 0, honoured.stderr);
    assert.equal(manifest(ctx).version, '9.0.0');
  } finally { ctx.cleanup(); }
});

test('a git ls-files copy with no node_modules installs from the vendor cache; doctor then reports compatible', () => {
  const ctx = setup();
  try {
    const clone = join(ctx.root, 'clone');
    mkdirSync(clone);
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const f of files) {
      if (!existsSync(join(ROOT, f))) continue;
      mkdirSync(join(clone, f, '..'), { recursive: true });
      writeFileSync(join(clone, f), readFileSync(join(ROOT, f)));
    }
    assert.equal(existsSync(join(clone, 'node_modules')), false);
    const env = { ...process.env, HOME: ctx.home, AGB_AGY_BIN: FAKE_AGY, FAKE_STATE_DIR: ctx.state, TMPDIR: ctx.tmp };
    delete env.ADLC_ANTIGRAVITY_PLUGIN_PATH;
    const boot = spawnSync(process.execPath, [join(clone, 'dist', 'agb.mjs'), 'bootstrap'], { cwd: clone, encoding: 'utf8', env });
    assert.equal(boot.status, 0, boot.stderr);
    const doc = spawnSync(process.execPath, [join(clone, 'dist', 'agb.mjs'), 'doctor'], { cwd: clone, encoding: 'utf8', env });
    assert.match(doc.stdout, /adlc-antigravity plugin\s*\|\s*PASS\s*\|\s*compatible/);
    assert.doesNotMatch(doc.stderr, /Error:|at .*\.mjs:\d+/);
  } finally { ctx.cleanup(); }
});

test('fake-agy emulates plugin uninstall under a temp HOME only', () => {
  const ctx = setup();
  try {
    assert.equal(runBootstrap(ctx).status, 0);
    const env = { ...process.env, HOME: ctx.home, FAKE_STATE_DIR: ctx.state };
    const ok = spawnSync(FAKE_AGY, ['plugin', 'uninstall', 'adlc-antigravity'], { encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(existsSync(staged(ctx)), false);
    assert.equal(spawnSync(FAKE_AGY, ['plugin', 'uninstall', 'adlc-antigravity'], { env }).status, 1, 'absent plugin');
    assert.equal(spawnSync(FAKE_AGY, ['plugin', 'uninstall', '../x'], { env }).status, 1, 'path-like name rejected');
  } finally { ctx.cleanup(); }
});
