// Table-driven tests for the unified PreToolUse policy guard
// (spec .adlc/specs/native-plugin-installation.md §4.5.1 + Appendix A).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { evaluatePayload, extractProbedPaths, isBoosterMcpTool } from '../hooks/policy/evaluate.mjs';
import { lexCommandLine } from '../hooks/policy/shell-lexer.mjs';

const ENTRY = new URL('../hooks/pre-tool-use.mjs', import.meta.url).pathname;

function makeFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-ptu-')));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const mk = (name, { tickets = null } = {}) => {
    const root = join(base, name);
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'lock.mjs'), '// rail\n');
    writeFileSync(join(root, 'lib', 'feature.mjs'), '// feature\n');
    if (tickets) {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
      initializeDirectoryStore(join(root, '.adlc', 'tickets'));
      for (const t of tickets) {
        writeFileSync(
          join(root, '.adlc', 'tickets', ticketFilename(t.id)),
          JSON.stringify({ title: 't', body: 'b', scope: [], rails: [], edges: [], ...t }, null, 2) + '\n',
        );
      }
    }
    return root;
  };
  return {
    base,
    home,
    active: mk('active', { tickets: [{ id: 'T1', rails: ['lib/lock.mjs', 'lib/gates.mjs'], scope: ['lib/feature.mjs', 'test/**'] }] }),
    inactive: mk('inactive', { tickets: [{ id: 'T9', rails: [], scope: ['lib/**'] }] }),
    plain: mk('plain'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const fx = makeFixture();
test.after(() => fx.cleanup());

function payload(name, args, ws) {
  return { toolCall: { name, args }, workspacePaths: [ws] };
}

function run(name, args, ws, env = {}) {
  return evaluatePayload(payload(name, args, ws), { env, home: fx.home, platform: 'linux' });
}

function shell(cmd, ws, env = {}, cwd = ws) {
  return run('run_command', { CommandLine: cmd, Cwd: cwd }, ws, env);
}

const INTERACTIVE = {};
const WORKER = { AGB_WORKER_TICKET: 'T1' };
const READONLY = { AGB_WORKER_MODE: 'readonly' };

// ---------- Step 1: protected roots ----------

test('Step 1: reading booster plugin data is denied in every repo, even via read-only tools', () => {
  const p = join(fx.home, '.gemini/antigravity-cli/plugin_data/antigravity-booster/rails-guard-health.json');
  for (const ws of [fx.plain, fx.active]) {
    assert.equal(run('view_file', { AbsolutePath: p }, ws).decision, 'deny');
    assert.equal(run('list_directory', { DirAbsolutePath: join(fx.home, '.config/antigravity-booster') }, ws).decision, 'deny');
    assert.equal(run('grep_search', { SearchPath: p }, ws).decision, 'deny');
  }
});

test('Step 1: ancestor searches of $HOME are permitted', () => {
  assert.equal(run('grep_search', { SearchPath: fx.home }, fx.plain).decision, 'pass');
  assert.equal(run('list_directory', { DirAbsolutePath: join(fx.home, '.gemini') }, fx.plain).decision, 'pass');
});

test('Step 1: file mutations into protected roots are denied even in non-ADLC repos', () => {
  for (const target of [
    join(fx.home, '.gemini/config/plugins/antigravity-booster/hooks.json'),
    join(fx.home, '.local/bin/agb'),
    join(fx.home, '.nvm/versions/node/v22/bin/node'),
    '/usr/local/bin/node',
  ]) {
    const v = run('write_to_file', { TargetFile: target, CodeContent: 'x' }, fx.plain);
    assert.equal(v.decision, 'deny', target);
    assert.match(v.reason, /platform configuration/);
  }
});

test('Step 1: ~ and $HOME prefixes are expanded for protection matching', () => {
  assert.equal(shell('cat ~/.gemini/antigravity-cli/plugin_data/antigravity-booster/hooks.log', fx.plain).decision, 'deny');
  assert.equal(shell('echo x > $HOME/.local/bin/agb', fx.plain).decision, 'deny');
});

// ---------- Step 2: fast path ----------

test('Step 2: read-only and orchestration tools pass, including reads of frozen rails', () => {
  for (const name of ['view_file', 'grep_search', 'code_search', 'list_directory', 'command_status', 'ask_question']) {
    assert.equal(run(name, { AbsolutePath: join(fx.active, 'lib/lock.mjs') }, fx.active).decision, 'pass', name);
  }
  for (const name of ['invoke_subagent', 'define_subagent', 'manage_subagents', 'schedule', 'send_message']) {
    assert.equal(run(name, {}, fx.active).decision, 'pass', name);
  }
});

// ---------- Gate 1: file tools ----------

test('Gate 1: every file-mutating tool targeting a declared rail is denied with the exact reason', () => {
  const tools = ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'create_file', 'save_file', 'delete_file'];
  for (const name of tools) {
    const v = run(name, { TargetFile: join(fx.active, 'lib/lock.mjs') }, fx.active);
    assert.equal(v.decision, 'deny', name);
    assert.equal(v.reason, 'Target path matches frozen rail: lib/lock.mjs', name);
  }
});

test('Gate 1: relative targets anchor on Cwd/workspace, and non-rail edits pass', () => {
  assert.equal(run('write_to_file', { TargetFile: 'lib/lock.mjs' }, fx.active).decision, 'deny');
  assert.equal(run('write_to_file', { TargetFile: 'lib/feature.mjs' }, fx.active).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: 'lib/newdir/deep/mod.mjs' }, fx.active).decision, 'pass', 'non-existent parent dirs do not crash');
});

test('Gate 1: rail names inside content or instruction keys never cause false denials', () => {
  const v = run('replace_file_content', {
    TargetFile: join(fx.active, 'lib/feature.mjs'),
    ReplacementContent: "import x from './lock.mjs' // lib/lock.mjs",
    Instruction: 'edit lib/lock.mjs references',
    toolAction: 'Editing lib/feature.mjs',
    toolSummary: 'touches lib/lock.mjs import',
  }, fx.active);
  assert.equal(v.decision, 'pass');
});

test('Gate 1: move checks both source and destination; directory ops containing a rail are denied', () => {
  assert.equal(run('move', { source: join(fx.active, 'lib/lock.mjs'), destination: join(fx.active, 'x.mjs') }, fx.active).decision, 'deny');
  assert.equal(run('move', { source: join(fx.active, 'lib/feature.mjs'), destination: join(fx.active, 'lib/lock.mjs') }, fx.active).decision, 'deny');
  assert.equal(run('delete_directory', { directoryPath: join(fx.active, 'lib') }, fx.active).decision, 'deny');
  assert.equal(run('delete_directory', { directoryPath: fx.active }, fx.active).decision, 'deny', 'repo root');
});

test('Gate 1: schema violations and unknown mutating keys deny in active-rail repos', () => {
  assert.equal(run('move', { source: join(fx.active, 'lib/feature.mjs') }, fx.active).decision, 'deny');
  const v = run('write_to_file', { TargetFile: join(fx.active, 'lib/feature.mjs'), Sneaky: 'lib/lock.mjs' }, fx.active);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /Unexpected path parameter/);
  assert.equal(run('move', { source: join(fx.plain, 'a') }, fx.plain).decision, 'pass', 'non-ADLC repo yields');
});

test('Gate 1 / D1: trust-root implicit rails are denied even with no active rails; specs stay editable', () => {
  for (const rel of ['.adlc/config.json', '.adlc/manifest.jsonl', '.adlc/sessions.json', '.adlc/ticket-archive/x.json', '.adlc/leases/l', '.git/config', '.git/hooks/pre-commit']) {
    assert.equal(run('write_to_file', { TargetFile: join(fx.inactive, rel) }, fx.inactive).decision, 'deny', rel);
  }
  assert.equal(run('write_to_file', { TargetFile: join(fx.inactive, '.adlc/specs/new.md') }, fx.inactive).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: join(fx.inactive, '.adlc/lessons/x.md') }, fx.inactive).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: join(fx.plain, '.git/config') }, fx.plain).decision, 'pass', '.git is policed only in ADLC repos');
});

test('Gate 1: existing ticket shards are immutable; creating a new shard is permitted (P0)', () => {
  const existing = join(fx.active, '.adlc/tickets', ticketFilename('T1'));
  assert.equal(run('write_to_file', { TargetFile: existing }, fx.active).decision, 'deny');
  assert.equal(run('delete_file', { TargetFile: existing }, fx.active).decision, 'deny');
  assert.equal(run('delete_directory', { directoryPath: join(fx.active, '.adlc/tickets') }, fx.active).decision, 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, '.adlc/tickets', ticketFilename('T5')) }, fx.active).decision, 'pass');
});

test('Gate 1: non-ADLC repos and inactive repos pass ordinary edits', () => {
  assert.equal(run('write_to_file', { TargetFile: join(fx.plain, 'lib/lock.mjs') }, fx.plain).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: join(fx.inactive, 'lib/lock.mjs') }, fx.inactive).decision, 'pass');
});

test('Gate 1: a corrupt ticket store fails closed', () => {
  const root = join(fx.base, 'corrupt');
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, '.adlc'), { recursive: true });
  initializeDirectoryStore(join(root, '.adlc', 'tickets'));
  writeFileSync(join(root, '.adlc', 'tickets', ticketFilename('T1')), '{nope');
  const v = run('write_to_file', { TargetFile: join(root, 'lib/feature.mjs') }, root);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /corrupt or unreadable/);
});

// ---------- MCP ----------

test('MCP: booster tools require server qualification and pass; bare names are not booster tools', () => {
  assert.equal(isBoosterMcpTool('mcp__agb__agb_status', {}), true);
  assert.equal(isBoosterMcpTool('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_status' }), true);
  assert.equal(isBoosterMcpTool('agb_status', {}), false);
  assert.equal(isBoosterMcpTool('call_mcp_tool', { ServerName: 'evil', ToolName: 'agb_status' }), false);
  assert.equal(isBoosterMcpTool('mcp__evil__agb_run', {}), false);
  assert.equal(run('mcp__agb__agb_status', { repo: fx.active }, fx.active).decision, 'pass');
  assert.equal(run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_plan', Arguments: { repo: fx.active } }, fx.active).decision, 'pass');
});

test('MCP: any MCP tool whose args reference a rail is denied, booster or third-party', () => {
  assert.equal(run('mcp__agb__agb_status', { path: join(fx.active, 'lib/lock.mjs') }, fx.active).decision, 'deny');
  assert.equal(run('mcp__fs__write_file', { path: join(fx.active, 'lib/lock.mjs'), content: 'x' }, fx.active).decision, 'deny');
  assert.equal(run('call_mcp_tool', { ServerName: 'fs', ToolName: 'write', Arguments: { nested: { target: join(fx.active, '.adlc/config.json') } } }, fx.active).decision, 'deny');
});

test('MCP: third-party tools ask in active-rail interactive, deny headless, pass elsewhere', () => {
  const args = { path: join(fx.active, 'lib/feature.mjs') };
  assert.equal(run('mcp__fs__write_file', args, fx.active).decision, 'ask');
  assert.equal(run('mcp__fs__write_file', args, fx.active, WORKER).decision, 'deny');
  assert.equal(run('mcp__fs__write_file', args, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__fs__write_file', { path: join(fx.plain, 'x') }, fx.plain).decision, 'pass');
  assert.equal(run('mcp__fs__write_file', { path: join(fx.inactive, 'x') }, fx.inactive).decision, 'pass');
});

test('MCP: read-only workers may not start agb runs', () => {
  assert.equal(run('mcp__agb__agb_run', {}, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_status', {}, fx.active, READONLY).decision, 'pass');
});

// ---------- Unknown tools ----------

test('Unknown tools deny in active-rail repos and for workers, pass in non-ADLC/inactive repos', () => {
  assert.equal(run('future_mutator', { x: 1 }, fx.active).decision, 'deny');
  assert.equal(run('future_mutator', { x: 1 }, fx.inactive).decision, 'pass');
  assert.equal(run('future_mutator', { x: 1 }, fx.inactive, WORKER).decision, 'deny');
  assert.equal(run('future_mutator', { x: 1 }, fx.plain).decision, 'pass');
  assert.equal(run('future_mutator', { x: 1 }, fx.plain, READONLY).decision, 'deny');
  assert.equal(run('file_search', { SearchPath: join(fx.home, '.config/antigravity-booster') }, fx.plain).decision, 'deny', 'Step 1 still applies');
});

test('Malformed payload without a tool name is denied', () => {
  assert.equal(evaluatePayload({}, { env: {}, home: fx.home }).decision, 'deny');
});

// ---------- Shell: decision table (§4.5.1) ----------

const SHELL_TABLE = [
  // [command, active-interactive, active-worker, plain]
  ['git status', 'pass', 'pass', 'pass'],
  ['git log -n 5 --oneline', 'pass', 'pass', 'pass'],
  ['git diff --stat lib/lock.mjs', 'pass', 'pass', 'pass'],
  ['cat lib/lock.mjs', 'pass', 'pass', 'pass'],
  ['ls -la lib', 'pass', 'pass', 'pass'],
  ['adlc ticket create --input t.json --write', 'pass', 'pass', 'pass'],
  [`git add .adlc/tickets/${ticketFilename('T5')}`, 'pass', 'pass', 'pass'],
  ['rm lib/lock.mjs', 'deny', 'deny', 'pass'],
  ['echo x > lib/lock.mjs', 'deny', 'deny', 'pass'],
  ['git checkout -- lib/lock.mjs', 'deny', 'deny', 'pass'],
  ['rm .adlc/config.json', 'deny', 'deny', 'pass'],
  ['rm -rf .', 'deny', 'deny', 'pass'],
  ['git clean -fd', 'deny', 'deny', 'pass'],
  ['node -e "require(1)"', 'ask', 'deny', 'pass'],
  ['python -c "print(1)"', 'ask', 'deny', 'pass'],
  ['echo $FOO', 'ask', 'deny', 'pass'],
  ['rm lib/*.mjs', 'ask', 'deny', 'pass'],
  ['patch -p1 < fix.diff', 'ask', 'deny', 'pass'],
  ['git apply fix.diff', 'ask', 'deny', 'pass'],
  ['git rebase main', 'ask', 'deny', 'pass'],
  ['git switch other', 'ask', 'deny', 'pass'],
  ['npm test', 'ask', 'pass', 'pass'],
  ['node --test test/a.test.mjs', 'ask', 'pass', 'pass'],
  ['tar -xf a.tgz', 'ask', 'deny', 'pass'],
  ['make', 'ask', 'deny', 'pass'],
  ['cd lib', 'ask', 'deny', 'pass'],
  ['git add lib/feature.mjs', 'pass', 'deny', 'pass'],
  ['git commit -m "msg"', 'pass', 'deny', 'pass'],
  ['git commit --amend -m x', 'ask', 'deny', 'pass'],
  ['git commit -am x', 'ask', 'deny', 'pass'],
  ['git add .', 'ask', 'deny', 'pass'],
  ['npm run build', 'pass', 'deny', 'pass'],
];

for (const [cmd, interactive, worker, plain] of SHELL_TABLE) {
  test(`Shell table: ${cmd}`, () => {
    assert.equal(shell(cmd, fx.active, INTERACTIVE).decision, interactive, 'active-rail interactive');
    assert.equal(shell(cmd, fx.active, WORKER).decision, worker, 'active-rail headless worker');
    assert.equal(shell(cmd, fx.plain, INTERACTIVE).decision, plain, 'non-ADLC');
  });
}

test('Shell: inactive ADLC repo (no declared rails) passes unlisted commands but keeps implicit rails', () => {
  assert.equal(shell('npm test', fx.inactive).decision, 'pass');
  assert.equal(shell('make', fx.inactive).decision, 'pass');
  assert.equal(shell('rm .adlc/manifest.jsonl', fx.inactive).decision, 'deny');
  assert.equal(shell('echo x >> .git/config', fx.inactive).decision, 'deny');
});

test('Shell: rail deny reason is exact', () => {
  assert.equal(shell('rm lib/lock.mjs', fx.active).reason, 'Target path matches frozen rail: lib/lock.mjs');
});

test('Shell: compound commands take the most restrictive verdict', () => {
  assert.equal(shell('git status && rm lib/lock.mjs', fx.active).decision, 'deny');
  assert.equal(shell('git status; npm test', fx.active).decision, 'ask');
  assert.equal(shell('git status | grep foo', fx.active).decision, 'pass');
});

test('Shell: cd into the workspace re-anchors later subcommands', () => {
  assert.equal(shell('cd lib && rm lock.mjs', fx.active).decision, 'deny');
  assert.equal(shell('cd lib && cat lock.mjs', fx.active).decision, 'pass');
});

test('Shell: Cwd outside the workspace is denied in ADLC repos and ignored elsewhere', () => {
  assert.equal(shell('ls', fx.active, INTERACTIVE, '/tmp').decision, 'deny');
  assert.equal(shell('ls', fx.active, INTERACTIVE, 'lib').decision, 'deny', 'relative Cwd');
  assert.equal(shell('ls', fx.plain, INTERACTIVE, '/tmp').decision, 'pass');
});

test('Shell: Cwd=/tmp targeting an ADLC rail by absolute path is denied', () => {
  const v = run('run_command', { CommandLine: `rm ${join(fx.active, 'lib/lock.mjs')}`, Cwd: '/tmp' }, fx.plain);
  assert.equal(v.decision, 'deny');
});

test('Shell: ticket lifecycle needs --authorize and asks only interactively', () => {
  assert.equal(shell('adlc ticket complete T1 --write', fx.active).decision, 'deny');
  assert.equal(shell('adlc ticket archive T1 --write --authorize', fx.active).decision, 'ask');
  assert.equal(shell('adlc ticket archive T1 --write --authorize', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('adlc ticket complete T9 --write', fx.inactive).decision, 'deny', 'applies in every ADLC repo');
  assert.equal(shell('adlc ticket complete T1 --write', fx.plain).decision, 'pass');
});

test('Shell: destructive store operations are denied', () => {
  assert.equal(shell(`rm .adlc/tickets/${ticketFilename('T1')}`, fx.active).decision, 'deny');
  assert.equal(shell('rm -rf .adlc/tickets', fx.active).decision, 'deny');
  assert.equal(shell(`mv .adlc/tickets/${ticketFilename('T1')} /tmp/x`, fx.active).decision, 'deny');
});

test('Shell D3: the agb shim is executable (not a protected-root mutation) and follows Stage 5', () => {
  assert.equal(shell('~/.local/bin/agb doctor', fx.plain).decision, 'pass');
  assert.equal(shell('~/.local/bin/agb run plan.json', fx.active).decision, 'ask');
  assert.equal(shell(`${join(fx.home, '.local/bin/agb')} status`, fx.plain).decision, 'pass');
  const launcher = '/bin/sh ~/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh dist/agb.mjs doctor';
  assert.equal(shell(launcher, fx.plain).decision, 'pass');
  assert.equal(shell('~/.local/bin/agb doctor', fx.active, WORKER).decision, 'deny', 'workers never run the shim');
  assert.equal(shell('cp evil ~/.local/bin/agb', fx.plain).decision, 'deny', 'overwriting the shim is a protected-root mutation');
  assert.equal(shell('/bin/sh ~/.gemini/config/plugins/evil/bin/node-launcher.sh dist/agb.mjs', fx.plain).decision, 'deny', 'only the booster launcher qualifies');
});

test('Shell: read-only worker mode permits only inspection', () => {
  assert.equal(shell('git status', fx.plain, READONLY).decision, 'pass');
  assert.equal(shell('cat lib/lock.mjs', fx.active, READONLY).decision, 'pass');
  assert.equal(shell('npm test', fx.plain, READONLY).decision, 'deny');
  assert.equal(shell('git commit -m x', fx.plain, READONLY).decision, 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(fx.plain, 'x.mjs') }, fx.plain, READONLY).decision, 'deny');
});

test('Shell: unlisted git flags and global options route to Stage 5', () => {
  assert.equal(shell('git -C lib status', fx.active).decision, 'deny', '-C names a directory containing a rail (A.6 item 5)');
  assert.equal(shell('git -C test status', fx.active).decision, 'ask');
  assert.equal(shell('git -c core.pager=evil log', fx.active).decision, 'ask');
  assert.equal(shell('FOO=1 git status', fx.active).decision, 'ask');
  assert.equal(shell('git diff --output=out.txt', fx.active).decision, 'ask');
  assert.equal(shell('git diff --output=lib/lock.mjs', fx.active).decision, 'deny');
});

test('Shell: unbalanced quoting is treated as dynamic', () => {
  assert.equal(shell('echo "unterminated', fx.active).decision, 'ask');
  assert.equal(shell('echo "unterminated', fx.plain).decision, 'pass');
});

// ---------- Headless worker envelope (§4.5.2) ----------

test('Worker: in-scope mutations pass; out-of-scope and rail mutations deny', () => {
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, 'lib/feature.mjs') }, fx.active, WORKER).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, 'test/new.test.mjs') }, fx.active, WORKER).decision, 'pass');
  const out = run('write_to_file', { TargetFile: join(fx.active, 'README.md') }, fx.active, WORKER);
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /outside declared ticket scope: README.md/);
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, 'lib/lock.mjs') }, fx.active, WORKER).decision, 'deny');
});

test('Worker: unresolvable ticket denies every mutation in an ADLC repo', () => {
  const v = run('write_to_file', { TargetFile: join(fx.active, 'lib/feature.mjs') }, fx.active, { AGB_WORKER_TICKET: 'NOPE' });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /cannot be resolved/);
});

test('Worker: non-ADLC targets follow normal non-ADLC policy (A.6 item 3)', () => {
  assert.equal(run('write_to_file', { TargetFile: join(fx.plain, 'x.mjs') }, fx.plain, WORKER).decision, 'pass');
  assert.equal(shell('make', fx.plain, WORKER).decision, 'pass');
});

// ---------- probed path extraction ----------

test('extractProbedPaths: unknown tool -> null, missing key -> error, ok -> paths', () => {
  assert.equal(extractProbedPaths('nope', {}), null);
  assert.deepEqual(extractProbedPaths('move', { source: 'a' }), { error: 'Missing required path parameter: destination' });
  assert.deepEqual(extractProbedPaths('move', { source: 'a', destination: 'b' }), { paths: ['a', 'b'] });
});

// ---------- lexer ----------

test('lexer: splits operators, honours quotes, records redirects, flags dynamics', () => {
  const r = lexCommandLine(`git commit -m "a; b" && echo 'x > y' > out.txt 2>&1 | cat`);
  assert.equal(r.ok, true);
  assert.equal(r.subcommands.length, 3);
  assert.deepEqual(r.subcommands[0].argv, ['git', 'commit', '-m', 'a; b']);
  assert.deepEqual(r.subcommands[1].argv, ['echo', 'x > y']);
  assert.deepEqual(r.subcommands[1].redirects.map((x) => x.target), ['out.txt']);
  assert.equal(lexCommandLine('echo $(id)').subcommands[0].dynamic, true);
  assert.equal(lexCommandLine('echo `id`').subcommands[0].dynamic, true);
  assert.equal(lexCommandLine("echo '$HOME'").subcommands[0].dynamic, false, 'single quotes suppress expansion');
  assert.equal(lexCommandLine('cat <(ls)').subcommands[0].dynamic, true);
  assert.equal(lexCommandLine('ls # rm -rf /').subcommands[0].dynamic, true);
  assert.equal(lexCommandLine('echo "x').ok, false);
});

// ---------- entry point (stdin -> stdout) ----------

function entry(input, env = {}) {
  return spawnSync(process.execPath, [ENTRY], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fx.home, ...env },
    timeout: 10000,
  });
}

test('entry: deny prints exactly one JSON line; pass prints nothing; never allow', () => {
  const denyRun = entry(JSON.stringify(payload('write_to_file', { TargetFile: join(fx.active, 'lib/lock.mjs') }, fx.active)));
  assert.equal(denyRun.status, 0);
  const lines = denyRun.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { decision: 'deny', reason: 'Target path matches frozen rail: lib/lock.mjs' });

  const passRun = entry(JSON.stringify(payload('write_to_file', { TargetFile: join(fx.active, 'lib/feature.mjs') }, fx.active)));
  assert.equal(passRun.status, 0);
  assert.equal(passRun.stdout, '');
  assert.doesNotMatch(denyRun.stdout + passRun.stdout, /"allow"/);
});

test('entry: invalid JSON is denied', () => {
  const r = entry('{nope');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.trim()).decision, 'deny');
});

test('entry: worker env from the parent process is honoured', () => {
  const r = entry(JSON.stringify(payload('run_command', { CommandLine: 'make', Cwd: fx.active }, fx.active)), WORKER);
  assert.equal(JSON.parse(r.stdout.trim()).decision, 'deny');
});

// ---------- hollow-test survivors (P5) ----------

test('Gate 1: a new file written through a symlinked directory resolves to the real rail path', async () => {
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(fx.active, 'lib'), join(fx.active, 'alias'), 'dir');
  // lib/gates.mjs is a declared rail that does not exist yet.
  const v = run('write_to_file', { TargetFile: join(fx.active, 'alias', 'gates.mjs') }, fx.active);
  assert.equal(v.decision, 'deny');
  assert.equal(v.reason, 'Target path matches frozen rail: lib/gates.mjs');
});

test('Shell: bracket globs are dynamic, so an inspection command using one is not Stage 1', () => {
  assert.equal(shell('cat lib/lock.mj[s]', fx.active).decision, 'ask');
});

test('Shell: a pure reader with a write redirection is not Stage 1 inspection', () => {
  assert.equal(shell('cat lib/feature.mjs > lib/copy.mjs', fx.active).decision, 'ask');
  assert.equal(shell('cat lib/feature.mjs < lib/feature.mjs', fx.active).decision, 'pass', 'input redirection stays read-only');
});

test('Shell: a ~ or $HOME token outside protected roots is dynamic (A.6 item 6)', () => {
  assert.equal(shell('cat ~/notes.txt', fx.active).decision, 'ask');
  assert.equal(shell('cat ~/notes.txt', fx.plain).decision, 'pass');
});

test('Step 1: the generic `path` key of read tools is inspected for booster data', () => {
  const p = join(fx.home, '.config/antigravity-booster/secret');
  assert.equal(run('view_file', { path: p }, fx.plain).decision, 'deny');
  assert.equal(run('view_file_outline', { path: p }, fx.plain).decision, 'deny');
});

test('Shell: every ticket lifecycle verb needs --authorize', () => {
  for (const verb of ['complete', 'archive', 'update', 'edit', 'discard', 'restore']) {
    assert.equal(shell(`adlc ticket ${verb} T1 --write`, fx.active).decision, 'deny', verb);
  }
});

test('Shell: git status porcelain v1 and v2 are inspection', () => {
  assert.equal(shell('git status --porcelain=v1', fx.active).decision, 'pass');
  assert.equal(shell('git status --porcelain=v2', fx.active).decision, 'pass');
  assert.equal(shell('git status --porcelain=v3', fx.active).decision, 'ask', 'unknown format is not whitelisted');
});

test('Context: a HOME that does not exist still recognises the canonical shim', () => {
  const ghost = join(fx.base, 'no-such-home');
  const v = evaluatePayload(payload('run_command', { CommandLine: `${join(ghost, '.local/bin/agb')} doctor`, Cwd: fx.plain }, fx.plain), { env: {}, home: ghost, platform: 'linux' });
  assert.equal(v.decision, 'pass');
});

test('Step 1: every probed read-tool path key alias is inspected', () => {
  const secret = join(fx.home, '.gemini/antigravity-cli/plugin_data/antigravity-booster/x');
  const cases = [
    ['read_notebook', 'path'], ['read_notebook', 'notebookPath'], ['read_resource', 'uri'], ['read_resource', 'Uri'],
    ['read_browser_page', 'url'], ['read_browser_page', 'Url'], ['read_url_content', 'url'], ['read_url_content', 'Url'],
  ];
  for (const [tool, key] of cases) {
    assert.equal(run(tool, { [key]: secret }, fx.plain).decision, 'deny', `${tool}.${key}`);
    assert.equal(run(tool, { [key]: `file://${secret}` }, fx.plain).decision, 'deny', `${tool}.${key} file:// URL`);
  }
});

// ---------- inactive ADLC repo column (P5 prosecution: SHELL_TABLE lacked it) ----------
// No declared rails: declared-rail denials vanish, the D1 trust root and repo root stay denied.
const INACTIVE_EXPECT = {
  'rm lib/lock.mjs': 'pass', 'echo x > lib/lock.mjs': 'pass', 'git checkout -- lib/lock.mjs': 'pass',
  'rm .adlc/config.json': 'deny', 'rm -rf .': 'deny', 'git clean -fd': 'deny',
  'node -e "require(1)"': 'pass', 'npm test': 'pass', 'git add .': 'pass', 'cd lib': 'pass',
  'git status': 'pass', 'adlc ticket create --input t.json --write': 'pass',
};
for (const [cmd, expected] of Object.entries(INACTIVE_EXPECT)) {
  test(`Shell table (inactive ADLC repo): ${cmd}`, () => {
    assert.equal(shell(cmd, fx.inactive).decision, expected);
  });
}

// ---------- darwin case folding (Appendix A.4 item 26) ----------
const onDarwin = (name, args, ws) => evaluatePayload(payload(name, args, ws), { env: {}, home: fx.home, platform: 'darwin' }).decision;

test('darwin: rail, trust-root and protected-root matching is case-insensitive', () => {
  assert.equal(onDarwin('write_to_file', { TargetFile: join(fx.active, 'LIB', 'LOCK.MJS') }, fx.active), 'deny');
  assert.equal(onDarwin('write_to_file', { TargetFile: join(fx.inactive, '.ADLC', 'Config.json') }, fx.inactive), 'deny');
  assert.equal(onDarwin('write_to_file', { TargetFile: join(fx.home, '.Gemini', 'settings.json') }, fx.plain), 'deny');
  assert.equal(onDarwin('run_command', { CommandLine: 'rm Lib/Lock.mjs', Cwd: fx.active }, fx.active), 'deny');
});

test('linux: the same case-variant paths are distinct files and pass', () => {
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, 'LIB', 'LOCK.MJS') }, fx.active).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: join(fx.home, '.Gemini', 'settings.json') }, fx.plain).decision, 'pass');
});
