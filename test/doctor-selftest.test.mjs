// T-PLUGIN-03 / Appendix A E10: doctor runs the EXACT hooks.json command under
// PATH=/usr/bin:/bin against a fixture repo whose active ticket rails
// lib/lock.mjs: the rail payload must be denied with the exact reason, the
// non-rail payload must produce empty stdout and exit 0. rails-guard-health.json
// is an informational log only. Plus D10 / D15 / P4 doctor notices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import {
  checkPolicyGuard, checkSecondaryInstall, checkKillswitchUsage, checkProbePlugins, healthLogPath,
} from '../lib/doctor.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-selftest-')));
test.after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

// A booster plugin root with the real hook-runner, hooks.json and bundle; the
// launcher is a stub that execs this test's Node (a temp HOME has no node
// manager for the real launcher to find — that path is covered by the live suite).
function pluginRoot({ bundle } = {}) {
  const root = join(base, `plugin-${n++}`);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist', 'hooks'), { recursive: true });
  cpSync(join(REPO, 'hooks.json'), join(root, 'hooks.json'));
  cpSync(join(REPO, 'bin', 'hook-runner.sh'), join(root, 'bin', 'hook-runner.sh'));
  if (bundle) writeFileSync(join(root, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'), bundle);
  else cpSync(join(REPO, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'), join(root, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'));
  writeFileSync(join(root, 'bin', 'node-launcher.sh'),
    `#!/bin/sh\nROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)"\nS="$1"; shift\nexec "${process.execPath}" "$ROOT/$S" "$@"\n`);
  chmodSync(join(root, 'bin', 'node-launcher.sh'), 0o755);
  return root;
}

const freshHome = () => { const h = join(base, `home-${n++}`); mkdirSync(h, { recursive: true }); return h; };

test('policy guard self-test passes on the real bundle and records an informational health log', () => {
  const home = freshHome();
  const r = checkPolicyGuard({ pluginRoot: pluginRoot(), home });
  assert.equal(r.level, 'pass', r.detail);
  const health = JSON.parse(readFileSync(healthLogPath(home), 'utf8'));
  for (const k of ['nodeSha256', 'bundleSha256', 'hooksSha256']) assert.match(health[k], /^[0-9a-f]{64}$/, k);
  assert.equal(typeof health.railsTrusted, 'boolean');
  assert.ok(!Number.isNaN(Date.parse(health.timestamp)));
});

test('policy guard self-test fails when the guard lets a rail write through', () => {
  const r = checkPolicyGuard({ pluginRoot: pluginRoot({ bundle: 'process.exit(0);\n' }), home: freshHome() });
  assert.equal(r.level, 'fail');
  assert.match(r.detail, /rail payload/);
});

test('policy guard self-test fails on a deny with the wrong reason', () => {
  const bundle = `process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'something else' }) + '\\n');\n`;
  const r = checkPolicyGuard({ pluginRoot: pluginRoot({ bundle }), home: freshHome() });
  assert.equal(r.level, 'fail');
  assert.match(r.detail, /Target path matches frozen rail: lib\/lock\.mjs/);
});

test('policy guard self-test fails when the non-rail payload is not a silent pass-through (ask counts as failure)', () => {
  const bundle = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const p = JSON.parse(s); const t = JSON.stringify(p.toolCall.args);
    if (t.includes('lock.mjs')) process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Target path matches frozen rail: lib/lock.mjs' }) + '\\n');
    else process.stdout.write(JSON.stringify({ decision: 'ask', reason: 'confirm' }) + '\\n');
  });\n`;
  const r = checkPolicyGuard({ pluginRoot: pluginRoot({ bundle }), home: freshHome() });
  assert.equal(r.level, 'fail');
  assert.match(r.detail, /non-rail payload/);
});

test('policy guard self-test runs the exact hooks.json command string', () => {
  const root = pluginRoot();
  const hooks = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
  hooks['agb-policy-guard'].PreToolUse[0].hooks[0].command = '/bin/sh bin/does-not-exist.sh';
  writeFileSync(join(root, 'hooks.json'), JSON.stringify(hooks));
  const r = checkPolicyGuard({ pluginRoot: root, home: freshHome() });
  assert.equal(r.level, 'fail', 'a broken hooks.json command is not masked by a hard-coded invocation');
});

// --- rails-guard-health.json is a log, never an input to a hook decision ---

function fixtureRepo() {
  const repo = join(base, `repo-${n++}`);
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
  writeFileSync(join(repo, '.adlc', 'tickets', ticketFilename('T1')),
    JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['lib/lock.mjs'], edges: [] }));
  return repo;
}

function hookDecision(root, home, repo, file) {
  const payload = { toolCall: { name: 'write_to_file', args: { TargetFile: join(repo, file) } }, workspacePaths: [repo] };
  const r = spawnSync('/bin/sh', ['bin/hook-runner.sh', '--timeout', '9', 'dist/hooks/pre-tool-use.bundle.mjs'], {
    cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 15000,
  });
  return `${r.status}|${r.stdout.trim()}`;
}

test('deleting, corrupting or forging rails-guard-health.json changes no hook decision', () => {
  const root = pluginRoot();
  const home = freshHome();
  const repo = fixtureRepo();
  assert.equal(checkPolicyGuard({ pluginRoot: root, home }).level, 'pass');
  const baseline = ['lib/lock.mjs', 'lib/foo.mjs'].map((f) => hookDecision(root, home, repo, f));
  assert.match(baseline[0], /"decision":"deny"/);
  assert.equal(baseline[1], '0|');
  const health = healthLogPath(home);
  for (const mutate of [
    () => rmSync(health, { force: true }),
    () => writeFileSync(health, '{corrupt'),
    () => writeFileSync(health, JSON.stringify({ railsTrusted: false, bypass: true, allow: ['lib/lock.mjs'] })),
  ]) {
    mutate();
    assert.deepEqual(['lib/lock.mjs', 'lib/foo.mjs'].map((f) => hookDecision(root, home, repo, f)), baseline);
  }
});

test('no hook or bundle source reads rails-guard-health.json', () => {
  const sources = [join(REPO, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'), join(REPO, 'bin', 'hook-runner.sh'), join(REPO, 'bin', 'node-launcher.sh')];
  for (const dir of [join(REPO, 'hooks'), join(REPO, 'hooks', 'policy')]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.mjs')) sources.push(join(dir, f));
  }
  for (const f of sources) assert.doesNotMatch(readFileSync(f, 'utf8'), /rails-guard-health/, f);
});

// --- D10 / D15 / P4 ---

test('D10: an npm-global agb on PATH is a warning; only ~/.local/bin/agb is a pass', () => {
  const home = freshHome();
  const shimDir = join(home, '.local', 'bin');
  const npmBin = join(base, `npm-global-${n++}`, 'bin');
  for (const d of [shimDir, npmBin]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'agb'), '#!/bin/sh\n'); chmodSync(join(d, 'agb'), 0o755); }
  const only = checkSecondaryInstall({ home, env: { PATH: `${shimDir}:/usr/bin:/bin` } });
  assert.equal(only.level, 'pass');
  const both = checkSecondaryInstall({ home, env: { PATH: `${npmBin}:${shimDir}:/usr/bin` } });
  assert.equal(both.level, 'warn');
  assert.match(both.detail, /secondary install detected/);
  assert.match(both.fix, /prefer ~\/\.local\/bin\/agb/);
  // A symlink to the shim is the shim, not a secondary install.
  const linkDir = join(base, `link-${n++}`);
  mkdirSync(linkDir);
  symlinkSync(join(shimDir, 'agb'), join(linkDir, 'agb'));
  assert.equal(checkSecondaryInstall({ home, env: { PATH: `${linkDir}:${shimDir}` } }).level, 'pass');
});

test('D15: killswitch notices in hooks.log are counted and reported', () => {
  const home = freshHome();
  assert.equal(checkKillswitchUsage({ home }).level, 'pass');
  const log = join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs', 'hooks.log');
  mkdirSync(join(log, '..'), { recursive: true });
  const notice = 'Tue Oct  7 10:00:00 UTC 2026: [CRITICAL NOTICE] AGB_HOOK_DISABLE is active; PreToolUse rails guard bypassed by operator request.\n';
  writeFileSync(log, `${notice}other line\n${notice}`);
  const r = checkKillswitchUsage({ home });
  assert.equal(r.level, 'warn');
  assert.match(r.detail, /2 AGB_HOOK_DISABLE/);
});

test('P4: an installed probe-* plugin is a warning', () => {
  const home = freshHome();
  assert.equal(checkProbePlugins({ home }).level, 'pass');
  mkdirSync(join(home, '.gemini', 'config', 'plugins', 'probe-deny'), { recursive: true });
  const r = checkProbePlugins({ home });
  assert.equal(r.level, 'warn');
  assert.match(r.detail, /probe-deny/);
});

test('policy guard self-test names a missing or non-string hooks.json command precisely', () => {
  for (const command of [undefined, '', 42]) {
    const root = pluginRoot();
    const hooks = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
    hooks['agb-policy-guard'].PreToolUse[0].hooks[0].command = command;
    writeFileSync(join(root, 'hooks.json'), JSON.stringify(hooks));
    const r = checkPolicyGuard({ pluginRoot: root, home: freshHome() });
    assert.equal(r.level, 'fail');
    assert.match(r.detail, /hooks\.json declares no agb-policy-guard PreToolUse command/, String(command));
  }
});

// A plugin root whose hooks.json command runs a stub script DIRECTLY (no
// hook-runner normalisation), so doctor's own output checks are exercised.
function directRoot(script) {
  const root = pluginRoot();
  writeFileSync(join(root, 'bin', 'stub.sh'), script);
  const hooks = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
  hooks['agb-policy-guard'].PreToolUse[0].hooks[0].command = '/bin/sh bin/stub.sh';
  writeFileSync(join(root, 'hooks.json'), JSON.stringify(hooks));
  return root;
}
const DENY = `{"decision":"deny","reason":"Target path matches frozen rail: lib/lock.mjs"}`;
// Deny the rail payload correctly; behave per $NONRAIL for anything else.
const stub = ({ rail = `echo '${DENY}'`, nonrail = 'exit 0' } = {}) =>
  `#!/bin/sh\ninput=$(cat)\ncase "$input" in *lock.mjs*) ${rail} ;; *) ${nonrail} ;; esac\n`;

test('self-test passes a correct direct guard (baseline for the cases below)', () => {
  assert.equal(checkPolicyGuard({ pluginRoot: directRoot(stub()), home: freshHome() }).level, 'pass');
});

test('self-test runs the hook with PATH exactly /usr/bin:/bin', () => {
  const root = directRoot(stub({ rail: `[ "$PATH" = /usr/bin:/bin ] && echo '${DENY}'` }));
  assert.equal(checkPolicyGuard({ pluginRoot: root, home: freshHome() }).level, 'pass');
  const saved = process.env.PATH;
  try {
    // An inherited PATH must not leak in: the stub only denies under the minimal PATH.
    process.env.PATH = `/opt/elsewhere:${saved}`;
    assert.equal(checkPolicyGuard({ pluginRoot: root, home: freshHome() }).level, 'pass');
  } finally { process.env.PATH = saved; }
});

for (const [label, rail] of [
  ['a correct deny line but a non-zero exit (agy fails open)', `echo '${DENY}'; exit 1`],
  ['a correct deny line followed by a second line', `echo '${DENY}'; echo extra`],
  ['allow carrying the exact rail reason', `echo '{"decision":"allow","reason":"Target path matches frozen rail: lib/lock.mjs"}'`],
]) {
  test(`self-test fails on ${label}`, () => {
    const r = checkPolicyGuard({ pluginRoot: directRoot(stub({ rail })), home: freshHome() });
    assert.equal(r.level, 'fail');
    assert.match(r.detail, /rail payload/);
  });
}

test('self-test fails when the non-rail payload exits non-zero with empty output', () => {
  const r = checkPolicyGuard({ pluginRoot: directRoot(stub({ nonrail: 'exit 1' })), home: freshHome() });
  assert.equal(r.level, 'fail');
  assert.match(r.detail, /non-rail payload/);
});

test('self-test leaves no temp fixture repo behind, on pass and on fail', () => {
  const tmp = join(base, `tmpdir-${n++}`);
  mkdirSync(tmp);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    checkPolicyGuard({ pluginRoot: pluginRoot(), home: freshHome() });
    checkPolicyGuard({ pluginRoot: directRoot(stub({ rail: 'exit 1' })), home: freshHome() });
    assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('agb-doctor-selftest-')), []);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});

test('D15/P4 matchers are exact: unrelated log lines and *probe* names that are not probe-* do not count', () => {
  const home = freshHome();
  const log = join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs', 'hooks.log');
  mkdirSync(join(log, '..'), { recursive: true });
  writeFileSync(log, 'note: AGB_HOOK_DISABLE was unset by the operator\nAGB_HOOK_DISABLE mentioned in a fallback reason\n');
  assert.equal(checkKillswitchUsage({ home }).level, 'pass');
  for (const name of ['my-probe', 'probe', 'antigravity-probe-x']) {
    mkdirSync(join(home, '.gemini', 'config', 'plugins', name), { recursive: true });
  }
  assert.equal(checkProbePlugins({ home }).level, 'pass');
});
