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
  assert.equal(findAdlcRoot(join(nested, 'lib', 'x.mjs'), { home }), null);
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

// ======================= P5 round 2 =======================
// Owner decision (2026-10-05): file/MCP tools are exact and fail closed;
// shell is best-effort, so only the cheap high-value variants are pinned here.

// ---- exact: file tools ----
test('R2 file: a dangling symlink is resolved through its target', async () => {
  const { symlinkSync } = await import('node:fs');
  mkdirSync(join(A, 'docs'), { recursive: true });
  symlinkSync('../lib/gates.mjs', join(A, 'docs', 'x')); // lib/gates.mjs (a rail) does not exist yet
  symlinkSync('../.adlc/sessions.json', join(I, 'lib', 'x'));
  assert.equal(run('write_to_file', { TargetFile: join(A, 'docs', 'x') }, A), 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(I, 'lib', 'x') }, I), 'deny');
});

test('R2 file: planting a .git above a non-git ADLC repo does not unroot it', () => {
  const outer = join(base, 'outer');
  const proj = join(outer, 'proj');
  mkdirSync(join(proj, 'lib'), { recursive: true });
  mkdirSync(join(proj, '.adlc'), { recursive: true });
  initializeDirectoryStore(join(proj, '.adlc', 'tickets'));
  writeFileSync(join(proj, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['lib/lock.mjs'], edges: [] }));
  mkdirSync(join(outer, '.git'), { recursive: true });
  assert.equal(findAdlcRoot(join(proj, 'lib', 'lock.mjs'), { home }), proj);
  assert.equal(run('write_to_file', { TargetFile: join(proj, 'lib', 'lock.mjs') }, proj), 'deny');
});

test('R2 file: an ADLC project below the git top (monorepo) is protected; a nested decoy still cannot re-root it', () => {
  const mono = join(base, 'mono');
  const proj = join(mono, 'packages', 'proj');
  mkdirSync(join(proj, 'lib', '.adlc'), { recursive: true }); // decoy below the project
  spawnSync('git', ['init', '-q', mono]);
  mkdirSync(join(proj, '.adlc'), { recursive: true });
  initializeDirectoryStore(join(proj, '.adlc', 'tickets'));
  writeFileSync(join(proj, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['lib/lock.mjs'], edges: [] }));
  assert.equal(findAdlcRoot(join(proj, 'lib', 'lock.mjs'), { home }), proj);
  assert.equal(run('write_to_file', { TargetFile: join(proj, 'lib', 'lock.mjs') }, proj), 'deny');
});

// ---- shell: cheap, high-value variants ----
test('R2 shell: cd behind builtin/command/control words and CDPATH still re-anchors or fails closed', () => {
  for (const cmd of [
    'builtin cd lib && echo x > ../.adlc/config.json',
    'command cd lib && echo x > ../.adlc/config.json',
    'if cd lib; then echo x > ../.adlc/config.json; fi',
    'CDPATH=lib cd sub && echo x > ../../.adlc/config.json',
    'export CDPATH=lib; cd sub && echo x > ../../.adlc/config.json',
  ]) {
    assert.equal(sh(cmd, I), 'deny', cmd);
  }
});

test('R2 shell: >& followed by a filename is a write redirection, not an fd copy', () => {
  assert.equal(sh('echo x >&1/../.adlc/config.json', I), 'deny');
  assert.equal(sh('echo x 2>&1', I), 'pass');
});

test('R2 shell: git global options cannot hide a destructive subcommand', () => {
  for (const cmd of ['git -c a.b=c clean -fdx', 'git -C . clean -fdx', 'git --no-pager clean -fdx', 'git --work-tree=. clean -fdx']) {
    assert.equal(sh(cmd, I), 'deny', cmd);
  }
  assert.equal(sh('git -c a=b reset --hard', A), 'deny');
});

test('R2 shell: globs, braces and ANSI-C quoting aimed at the trust root are denied', () => {
  for (const cmd of ['rm .adlc/tickets/*.json', 'rm .adlc/*', 'rm .adlc/conf?g.json', 'rm .adlc/{config.json,manifest.jsonl}', "rm $'.adlc/config.json'"]) {
    assert.equal(sh(cmd, I), 'deny', `${cmd} (inactive)`);
  }
  assert.equal(sh('rm .adlc/tickets/*.json', A), 'deny');
  assert.equal(sh('rm .adlc/specs/*.md', I), 'pass', 'specs stay editable');
  assert.equal(sh(`rm ${join(home, '.gemini')}/*`, P), 'deny');
});

test('R2 shell: ~user home paths are expanded for protection matching', () => {
  const user = home.split('/').pop();
  assert.equal(sh(`echo x > ~${user}/.gemini/settings.json`, P), 'deny');
  assert.equal(sh(`cat ~${user}/.config/antigravity-booster/x`, P), 'deny');
});

test('R2 shell: ticket lifecycle through the scoped @adlc/cli package needs --authorize', () => {
  assert.equal(sh('npx @adlc/cli ticket complete T1 --write', I), 'deny');
  assert.equal(sh('npx @adlc/cli@1.11.1 ticket complete T1 --write --authorize', I), 'ask');
});

test('R2 shell: sh -c / bash -c scripts are re-lexed and classified', () => {
  assert.equal(sh('sh -c "echo x > .adlc/config.json"', I), 'deny');
  assert.equal(sh("bash -c 'rm -rf .git'", I), 'deny');
  assert.equal(sh('bash -c "git status"', I), 'pass');
});

test('R2 shell: commands that act on an ADLC repo root are denied', () => {
  for (const cmd of ['find . -delete', 'chmod -R 000 .', 'git stash -a', 'git stash --all', 'git checkout .']) {
    assert.equal(sh(cmd, I), 'deny', cmd);
  }
});

test('R2 shell: copying or extracting into a parent of a protected root is denied', () => {
  for (const cmd of [`cp -r /tmp/payload/. ${join(home, '.local')}/`, `cp -r /tmp/payload/. ${home}/`, `tar -xf /tmp/evil.tar -C ${home}`]) {
    assert.equal(sh(cmd, P), 'deny', cmd);
  }
});

// ---- owner decisions (2026-10-05): D15 minus npm run build; ancestor tokens ask ----
const GIT_COMMIT = ['git', 'commit'].join(' ');
test('R2 D15: npm run build asks again; root-spelled git add/commit pathspecs ask', () => {
  assert.equal(sh('npm run build', A), 'ask');
  for (const cmd of ['git add ./', 'git add :/', 'git add docs/..', `${GIT_COMMIT} -m x .`, `${GIT_COMMIT} -m x :/`, `${GIT_COMMIT} -m x -- .`]) {
    assert.equal(sh(cmd, A), 'ask', cmd);
  }
  assert.equal(sh('git add lib/feature.mjs', A), 'pass');
  assert.equal(sh(`${GIT_COMMIT} -m x`, A), 'pass');
});

test('R2 posture: naming a directory that contains a rail asks; destructive verbs on it deny', () => {
  for (const cmd of ['rg foo lib', 'npx eslint lib', 'find lib -name "x"', 'du -sh lib', 'git add lib/']) {
    assert.equal(sh(cmd, A), 'ask', cmd);
    assert.equal(sh(cmd, A, { AGB_WORKER_TICKET: 'T1' }), 'deny', `${cmd} (headless)`);
  }
  for (const cmd of ['rm -rf lib', 'mv lib old', 'cp x.mjs lib/', 'tar -xf a.tgz -C lib', 'chmod -R 000 lib', 'find lib -delete']) {
    assert.equal(sh(cmd, A), 'deny', cmd);
  }
  assert.equal(sh('rm lib/lock.mjs', A), 'deny', 'exact rail paths stay deny');
});

test('R2 usability: git log -<n> is inspection', () => {
  assert.equal(sh('git log --oneline -5', A), 'pass');
});

// ---- hollow-test survivors (round-2 mutation pass) ----
test('R2 mutation: popd leaves the working directory unknown, so later commands fail closed', () => {
  assert.equal(sh('popd && rm config.json', I), 'deny');
});

test('R2 mutation: prefix words are unwrapped, so builtin cd into the workspace re-anchors', () => {
  assert.equal(sh('builtin cd lib && cat lock.mjs', A), 'pass');
  assert.equal(sh('doas cd lib && echo x > ../.adlc/config.json', I), 'deny');
});

test('R2 mutation: every shell flavour is re-lexed', () => {
  for (const shell of ['sh', 'bash', 'dash', 'zsh', 'ksh']) {
    assert.equal(sh(`${shell} -c "rm -rf .git"`, I), 'deny', shell);
  }
});

test('R2 mutation: allowlisted long commit flags stay routine', () => {
  const commit = ['git', 'commit'].join(' ');
  for (const flag of ['--signoff', '--quiet', '--verbose']) {
    assert.equal(sh(`${commit} -m x ${flag}`, A), 'pass', flag);
  }
});

// ======================= P5 round 3: the exact layer =======================
const runIn = (name, args, ws, extra = {}) => evaluatePayload({ toolCall: { name, args }, workspacePaths: Array.isArray(ws) ? ws : [ws] }, { env: {}, home, platform: 'linux', ...extra }).decision;

test('R3 H1: deleting or moving a directory that contains a repo or protected root is denied', () => {
  assert.equal(run('delete_directory', { directoryPath: base }, A), 'deny');
  assert.equal(run('delete_directory', { directoryPath: base }, I), 'deny');
  assert.equal(run('move', { source: base, destination: '/tmp/zz' }, A), 'deny');
  assert.equal(run('delete_directory', { directoryPath: join(home, '.local') }, P), 'deny');
  assert.equal(run('move', { source: join(home, '.config'), destination: '/tmp/x' }, P), 'deny');
  assert.equal(run('delete_directory', { directoryPath: home }, P), 'deny');
});

test('R3 H2: symlinks are resolved physically, component by component', async () => {
  const { symlinkSync } = await import('node:fs');
  const ext = join(base, 'ext', 'deep');
  mkdirSync(ext, { recursive: true });
  mkdirSync(join(A, 'docs'), { recursive: true });
  symlinkSync(ext, join(A, 'docs', 'd'));
  symlinkSync('../../active/lib/gates.mjs', join(ext, 'link'));
  assert.equal(run('write_to_file', { TargetFile: join(A, 'docs', 'd', 'link') }, A), 'deny', 'link reached through a symlinked dir');
  symlinkSync('../.adlc/tickets', join(I, 'lib', 't'));
  assert.equal(run('write_to_file', { TargetFile: `${join(I, 'lib', 't')}/../config.json` }, I), 'deny', '.. after a symlink is physical');
});

test('R3 H3: a nested .git (submodule or planted) cannot drop the outer repo rails', () => {
  const S = join(base, 'super');
  mkdirSync(join(S, 'vendor', 'mod'), { recursive: true });
  mkdirSync(join(S, 'lib'), { recursive: true });
  spawnSync('git', ['init', '-q', S]);
  mkdirSync(join(S, '.adlc'), { recursive: true });
  initializeDirectoryStore(join(S, '.adlc', 'tickets'));
  writeFileSync(join(S, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['vendor/mod/**', 'lib/gates.mjs'], edges: [] }));
  writeFileSync(join(S, 'vendor', 'mod', '.git'), 'gitdir: ../../.git/modules/mod\n');
  mkdirSync(join(S, 'lib', '.git'), { recursive: true });
  assert.equal(findAdlcRoot(join(S, 'vendor', 'mod', 'x.c'), { home }), S);
  assert.equal(run('write_to_file', { TargetFile: join(S, 'vendor', 'mod', 'x.c') }, S), 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(S, 'lib', 'gates.mjs') }, S), 'deny');
});

test('R3 H4: the legacy tickets.json and an overridden store path are trust roots; only well-formed shards may be created', () => {
  assert.equal(run('write_to_file', { TargetFile: join(I, '.adlc', 'tickets.json') }, I), 'deny');
  assert.equal(run('delete_file', { TargetFile: join(I, '.adlc', 'tickets.json') }, I), 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(I, '.adlc', 'tickets', 'foo') }, I), 'deny', 'non-shard file would brick the store');
  assert.equal(run('write_to_file', { TargetFile: join(I, '.adlc', 'tickets', ticketFilename('T5')) }, I), 'pass');
  const store = join(base, 'elsewhere', 'tickets');
  assert.equal(runIn('write_to_file', { TargetFile: join(store, 'x.json') }, P, { env: { ADLC_TICKET_STORE: store } }), 'deny');
});

test('R3 M3: file: URI spellings are normalised for MCP and file tools', () => {
  const settings = join(home, '.gemini', 'settings.json');
  assert.equal(run('mcp__fs__write_file', { path: `file://${settings}` }, P), 'deny');
  assert.equal(run('mcp__fs__write_file', { path: `file://${join(A, 'lib', 'gates.mjs')}` }, A), 'deny');
  for (const t of [`file://localhost${join(A, 'lib', 'lock.mjs')}`, `FILE://${join(A, 'lib', 'lock.mjs')}`, `file:${join(A, 'lib', 'lock.mjs')}`, `file://${join(A, 'lib', 'lock%2Emjs')}`]) {
    assert.equal(run('write_to_file', { TargetFile: t }, A), 'deny', t);
  }
});

test('R3 M4: a HOME reached through a symlink is protected by its real path too', async () => {
  const { symlinkSync } = await import('node:fs');
  const realHome = join(base, 'data', 'u');
  mkdirSync(realHome, { recursive: true });
  const linkHome = join(base, 'h2');
  symlinkSync(realHome, linkHome);
  const v = evaluatePayload({ toolCall: { name: 'write_to_file', args: { TargetFile: join(realHome, '.gemini', 'settings.json') } }, workspacePaths: [P] }, { env: {}, home: linkHome, platform: 'linux' });
  assert.equal(v.decision, 'deny');
});

test('R3 M5: relative targets are judged against every anchor; none means deny', () => {
  assert.equal(run('write_to_file', { TargetFile: 'lib/gates.mjs', Cwd: '/tmp' }, A), 'deny');
  assert.equal(runIn('write_to_file', { TargetFile: 'lib/gates.mjs' }, [P, A]), 'deny');
  assert.equal(runIn('write_to_file', { TargetFile: 'lib/x.mjs' }, []), 'deny');
});

test('R3 M6: unknown tools and MCP args get trust-root gating everywhere', () => {
  assert.equal(run('apply_patch', { path: join(I, '.adlc', 'config.json') }, I), 'deny');
  assert.equal(run('mcp__fs__write', { message: { path: join(I, '.adlc', 'config.json') } }, I), 'deny', 'nested under an excluded key');
  assert.equal(run('mcp__fs__write', { files: { [join(I, '.adlc', 'config.json')]: 'x' } }, I), 'deny', 'path as an object key');
  assert.equal(run('mcp__fs__write', { path: '.adlc' }, I), 'deny', 'relative path without a slash');
});

test('R3 F1: absurdly deep arguments are denied instead of crashing the evaluator', () => {
  let deep = join(A, 'lib', 'x');
  for (let i = 0; i < 20000; i += 1) deep = [deep];
  assert.equal(run('mcp__fs__write', { deep }, A), 'deny');
});

test('R3 W1: env-prefixed assignments are not Stage 1, so GIT_EXTERNAL_DIFF cannot ride git diff', () => {
  const cmd = `env "GIT_EXTERNAL_DIFF=sh -c 'echo x > lib/gates.mjs'" git diff`;
  assert.equal(sh(cmd, A, { AGB_WORKER_MODE: 'readonly' }), 'deny');
  assert.equal(sh(cmd, A, { AGB_WORKER_TICKET: 'T1' }), 'deny');
  assert.equal(sh(cmd, A), 'ask');
  assert.equal(sh('env LD_PRELOAD=/tmp/x.so cat lib/feature.mjs', A, { AGB_WORKER_MODE: 'readonly' }), 'deny');
});

test('R3 W2: workers in an ADLC repo cannot write outside it; test flags are allowlisted', () => {
  const W = { AGB_WORKER_TICKET: 'T1' };
  assert.equal(run('write_to_file', { TargetFile: join(home, '.bashrc') }, A, W), 'deny');
  assert.equal(run('write_to_file', { TargetFile: '/tmp/xx' }, A, W), 'deny');
  assert.equal(sh('node --test --test-reporter-destination=README.md', A, W), 'deny');
  assert.equal(sh('node --test --test-name-pattern=foo test/a.test.mjs', A, W), 'pass');
});

test('R3 usability: wc and git blame / log --follow are inspection', () => {
  assert.equal(sh('wc -l lib/gates.mjs', A), 'pass');
  assert.equal(sh('git blame lib/lock.mjs', A), 'pass');
  assert.equal(sh('git log --follow lib/lock.mjs', A), 'pass');
});
