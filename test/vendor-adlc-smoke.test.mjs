// Smoke test for the committed vendored adlc dispatcher (T-PLUGIN-02, spec
// Appendix A D12): the bundle must run with ZERO node_modules, exactly as a
// git-URL plugin install would see it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'vendor/adlc/dist/adlc.bundle.mjs');
const VERBS = [
  'rails-guard',
  'gate-manifest',
  'flail-detector',
  'hollow-test',
  'consensus-fix',
  'model-router',
  'merge-forecast',
  'ticket',
];
const PINNED = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies['@adlc/cli'];

let dir;

before(() => {
  assert.ok(existsSync(BUNDLE), `committed bundle missing: ${BUNDLE} (run npm run vendor:bundle)`);
  dir = mkdtempSync(join(tmpdir(), 'agb-vendor-adlc-'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !f.startsWith('node_modules/') && existsSync(join(ROOT, f)));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  cpSync(join(ROOT, 'vendor/adlc'), join(dir, 'vendor/adlc'), { recursive: true });
  assert.equal(existsSync(join(dir, 'node_modules')), false);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, ['vendor/adlc/bin/adlc.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    timeout: 30_000,
  });
}

test('vendored package.json pins the @adlc/cli version and is private', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'vendor/adlc/package.json'), 'utf8'));
  assert.equal(pkg.version, PINNED);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin.adlc, 'bin/adlc.mjs');
});

for (const verb of VERBS) {
  test(`${verb} --help runs without node_modules`, () => {
    const r = run([verb, '--help']);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok((r.stdout + r.stderr).trim().length > 0, 'expected non-empty help output');
  });
}

test('unknown verb exits 1 with "verb not vendored"', () => {
  const r = run(['premortem', '--help']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verb not vendored: premortem/);
});

test('--version prints the pinned version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), PINNED);
});
