// Regression tests for policy-guard bypasses reproduced by the P5 prosecution
// of T-PLUGIN-01-CORE. Each test is one reported payload; all must stay denied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';
import { findAdlcRoot } from '../lib/active-rails.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-bypass-')));
test.after(() => rmSync(base, { recursive: true, force: true }));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });

function repo(name, { rails = null, git = true } = {}) {
  const root = join(base, name);
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'lock.mjs'), '// rail\n');
  writeFileSync(join(root, 'lib', 'feature.mjs'), '// feature\n');
  if (git) spawnSync('git', ['init', '-q', root]);
  if (rails) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
    initializeDirectoryStore(join(root, '.adlc', 'tickets'));
    writeFileSync(join(root, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: ['lib/feature.mjs'], rails: rails.list, edges: [] }));
  }
  return root;
}

const A = repo('active', { rails: { list: ['lib/lock.mjs', 'lib/gates.mjs'] } });
const I = repo('inactive', { rails: { list: [] } });
const P = repo('plain');
const SHARD = (root) => join(root, '.adlc', 'tickets', ticketFilename('T1'));

const run = (name, args, ws, env = {}) => evaluatePayload({ toolCall: { name, args }, workspacePaths: [ws] }, { env, home, platform: 'linux' }).decision;
const sh = (cmd, ws, env = {}) => run('run_command', { CommandLine: cmd, Cwd: ws }, ws, env);

// C1 — decoy .adlc re-rooting
test('C1: repo root is the git top level; a nested decoy .adlc cannot re-root rails', () => {
  mkdirSync(join(A, 'lib', '.adlc'), { recursive: true });
  mkdirSync(join(A, '.adlc', '.adlc'), { recursive: true });
  try {
    assert.equal(findAdlcRoot(join(A, 'lib', 'lock.mjs')), A);
    assert.equal(run('write_to_file', { TargetFile: join(A, 'lib', 'lock.mjs') }, A), 'deny');
    assert.equal(run('write_to_file', { TargetFile: SHARD(A) }, A), 'deny');
    assert.equal(run('write_to_file', { TargetFile: join(A, '.adlc', 'config.json') }, A), 'deny');
    assert.equal(run('delete_file', { TargetFile: join(A, '.adlc', 'manifest.jsonl') }, A), 'deny');
  } finally {
    rmSync(join(A, 'lib', '.adlc'), { recursive: true, force: true });
    rmSync(join(A, '.adlc', '.adlc'), { recursive: true, force: true });
  }
});

test('C1: creating a nested .adlc or .git inside an ADLC repo is denied', () => {
  for (const ws of [A, I]) {
    assert.equal(run('write_to_file', { TargetFile: join(ws, 'lib', '.adlc', 'x') }, ws), 'deny');
    assert.equal(run('write_to_file', { TargetFile: join(ws, '.adlc', '.adlc', 'x') }, ws), 'deny');
    assert.equal(run('write_to_file', { TargetFile: join(ws, 'lib', '.git', 'HEAD') }, ws), 'deny');
    assert.equal(sh('mkdir -p lib/.adlc', ws), 'deny');
  }
});

test('C1: a global ~/.adlc state dir does not make plain repos ADLC repos', () => {
  mkdirSync(join(home, '.adlc'), { recursive: true });
  const nested = join(home, 'code', 'plain');
  mkdirSync(join(nested, 'lib'), { recursive: true });
  spawnSync('git', ['init', '-q', nested]);
  assert.equal(findAdlcRoot(join(nested, 'lib', 'x.mjs')), null);
  assert.equal(run('write_to_file', { TargetFile: join(nested, 'lib', 'x.mjs') }, nested), 'pass');
});

// C2 — >| noclobber override
test('C2: >| redirection targets are checked', () => {
  assert.equal(sh(`echo x >| ${join(home, '.gemini', 'settings.json')}`, P), 'deny');
  assert.equal(sh(`echo {} >| ${join(home, '.local', 'bin', 'agb')}`, P), 'deny');
  assert.equal(sh('echo x >| .adlc/config.json', I), 'deny');
  assert.equal(sh('echo x >| lib/lock.mjs', A), 'deny');
});

// H1 — directory changes
test('H1: directory changes re-anchor later subcommands wherever they lead', () => {
  assert.equal(sh(`cd && rm -rf .gemini`, P, {}), 'deny');
  assert.equal(sh('cd -P .adlc && rm config.json', I), 'deny');
  assert.equal(sh('pushd .adlc && rm config.json', I), 'deny');
  assert.equal(sh('cd .. && rm inactive/.adlc/config.json', I), 'deny');
  assert.equal(sh('cd -P lib && rm lock.mjs', A), 'deny');
  assert.equal(sh('cd .. && rm active/lib/lock.mjs', A), 'deny');
});

test('H1: an unresolvable directory change fails closed for later subcommands', () => {
  assert.equal(sh('cd - && rm config.json', I), 'deny');
  assert.equal(sh('cd "$X" && rm config.json', P), 'deny');
});

// H2 — attached short-option values
test('H2: values attached to short options are path candidates', () => {
  assert.equal(sh('sort -o.adlc/config.json lib/feature.mjs', I), 'deny');
  assert.equal(sh(`curl -o${join(home, '.gemini', 'settings.json')} http://x`, P), 'deny');
  assert.equal(sh(`cp -t${join(home, '.local', 'bin')} agb`, P), 'deny');
  assert.equal(sh('sort -olib/lock.mjs lib/feature.mjs', A), 'deny');
  assert.equal(sh('git diff -olib/lock.mjs', A), 'deny');
});

// H3 — schema violations judged by the caller-controlled anchor
test('H3: schema violations are judged by the target paths, not the anchor', () => {
  assert.equal(run('write_to_file', { TargetFile: join(A, 'lib', 'lock.mjs'), CodeContent: 'x', Cwd: '/tmp' }, A), 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(I, '.adlc', 'config.json'), Foo: 'a/b' }, I), 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(A, 'lib', 'lock.mjs'), Foo: 'a/b' }, P), 'deny');
});

// H4 — abbreviated git long options
test('H4: D15 git commit rejects abbreviated --amend/--no-verify/--all', () => {
  for (const cmd of ['git commit -m x --amen', 'git commit -m x --no-veri', 'git commit --al -m x', 'git commit -m x --no-v']) {
    assert.equal(sh(cmd, A), 'ask', cmd);
  }
  assert.equal(sh('git commit -m "x" --signoff', A), 'pass');
});

// H5 — crash via attacker-controlled glob pattern
test('H5: an over-long path token does not crash the evaluator', () => {
  const long = 'A'.repeat(70000);
  assert.equal(sh(`echo pwned | tee lib/lock.mjs ${long}`, A), 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(A, 'lib', long) }, A), 'pass');
});

// M1 — root delete in inactive ADLC repos
test('M1: deleting an ADLC repo root is denied even without declared rails', () => {
  assert.equal(sh('rm -rf .', I), 'deny');
  assert.equal(sh('rm -rf ..', join(I, 'lib') && I), 'deny');
  assert.equal(sh('git clean -fdx', I), 'deny');
});

// M2 — ticket lifecycle spelled differently
test('M2: ticket lifecycle and store commands need --authorize however adlc is invoked', () => {
  for (const ws of [A, I]) {
    for (const cmd of [
      'npx adlc ticket complete T1 --write',
      'adlc --json ticket complete T1 --write',
      'command adlc ticket complete T1 --write',
      'adlc ticket store recover --rollback',
      'adlc ticket store migrate --write --yes',
    ]) {
      assert.equal(sh(cmd, ws), 'deny', `${cmd} in ${ws}`);
    }
  }
});

// M3 — file:// targets for file tools
test('M3: file:// targets are normalised for file-mutating tools', () => {
  assert.equal(run('write_to_file', { TargetFile: `file://${join(A, 'lib', 'lock.mjs')}` }, A), 'deny');
  assert.equal(run('write_to_file', { TargetFile: `file://${join(home, '.gemini', 'settings.json')}` }, P), 'deny');
});

// L1 — launcher path traversal spoofing the D3 shim exemption
test('L1: a traversal path cannot impersonate the booster launcher', () => {
  const spoof = `/bin/sh ${join(home, '.gemini/config/plugins/../../../../tmp/antigravity-booster/bin/node-launcher.sh')} dist/agb.mjs ${join(home, '.gemini', 'x')}`;
  assert.equal(sh(spoof, P), 'deny');
});
