// Table-driven tests for the unified PreToolUse policy guard
// (spec .adlc/specs/native-plugin-installation.md §4.5.1 + Appendix A).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
    active: mk('active', { tickets: [{ id: 'T1', rails: ['lib/lock.mjs', 'lib/gates.mjs', 'CODEOWNERS'], scope: ['lib/feature.mjs', 'test/**'] }] }),
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
  for (const rel of ['.adlc/config.json', '.adlc/manifest.jsonl', '.adlc/sessions.json', '.adlc/learned-checks.json', '.adlc/ticket-archive/x.json', '.adlc/leases/l', '.git/config', '.git/hooks/pre-commit']) {
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
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, '.adlc/tickets', ticketFilename('T5')), CodeContent: JSON.stringify({ id: 'T5', title: 't', body: 'b', scope: [], rails: [], edges: [] }) }, fx.active).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: join(fx.active, '.adlc/tickets', ticketFilename('T5')), CodeContent: JSON.stringify({ id: 'T6', title: 't', body: 'b', scope: [], rails: [], edges: [] }) }, fx.active).decision, 'deny', 'content id must match the filename');
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
  assert.equal(run('mcp__fs__write_file', args, fx.active).decision, 'force_ask');
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
  ['rm lib/*.mjs', 'deny', 'deny', 'pass'], // the glob can expand to a rail (P5 round 2)
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
  ['npm run build', 'ask', 'deny', 'pass'], // D15 amended 2026-10-05: runs package.json code
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
  assert.equal(shell('adlc ticket archive T1 --write --authorize', fx.active).decision, 'force_ask');
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
  assert.equal(shell('git -C lib status', fx.active).decision, 'ask', '-C names a directory containing a rail: ask (owner decision 2026-10-05)');
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

test('Worker: a retired legacy tickets.json never authorises a worker mutation scope', () => {
  const root = join(fx.base, 'legacy');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'feature.mjs'), '// feature\n');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
  writeFileSync(join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 't', body: 'b', scope: ['**'], rails: [], edges: [] }] }) + '\n');
  const v = run('write_to_file', { TargetFile: join(root, 'lib/feature.mjs') }, root, WORKER);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /LEGACY_TICKET_STORE/);
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

test('entry: force_ask and ask are printed as one JSON line; headless converts to deny; pass is empty', () => {
  const cli = (name, args) => entry(JSON.stringify(payload(name, args, fx.active)));
  const fa = cli('run_workflow', { Script: 'print(1)' });
  assert.equal(fa.status, 0);
  assert.equal(fa.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(fa.stdout.trim()).decision, 'force_ask');
  const a = cli('run_command', { CommandLine: 'npm test', Cwd: fx.active });
  assert.equal(a.status, 0);
  assert.equal(a.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(a.stdout.trim()).decision, 'ask');
  const hw = entry(JSON.stringify(payload('run_workflow', { Script: 'print(1)' }, fx.active)), { AGB_WORKER_TICKET: 'T1' });
  assert.equal(JSON.parse(hw.stdout.trim()).decision, 'deny');
  const p = cli('view_file', { AbsolutePath: join(fx.active, 'lib/feature.mjs') });
  assert.equal(p.status, 0);
  assert.equal(p.stdout, '');
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

// ---------- agy control steps (T-POLICY-GUARD-AGY-FINISH) ----------
// agy 1.3.1 returns a --json-schema answer through its terminal `finish` step;
// denying it made every structured read-only call loop and return nothing.

test('finish passes for read-only workers, headless builders and active-rail sessions', () => {
  const args = { gaps: [], toolAction: 'Reporting gaps', toolSummary: 'Report gaps' };
  for (const [ws, env] of [[fx.active, READONLY], [fx.plain, READONLY], [fx.active, WORKER], [fx.active, INTERACTIVE], [fx.inactive, READONLY]]) {
    assert.equal(run('finish', args, ws, env).decision, 'pass', `${ws} ${JSON.stringify(env)}`);
  }
});

test('finish answer text naming protected paths is not path-scanned', () => {
  const gaps = ['lib/lock.mjs is a frozen rail', `${fx.active}/.adlc/config.json`, join(fx.home, '.gemini/config/plugins/x'),
    join(fx.home, '.gemini/antigravity-cli/plugin_data/antigravity-booster/rails-guard-health.json')];
  for (const env of [READONLY, WORKER, INTERACTIVE]) {
    assert.equal(run('finish', { gaps, toolSummary: 'Report gaps' }, fx.active, env).decision, 'pass', JSON.stringify(env));
  }
});

test('finish lookalikes are still unknown tools and denied in read-only sessions', () => {
  for (const name of ['finish_task', 'Finish', 'FINISH', ' finish', 'mcp__x__finish']) {
    assert.equal(run(name, { gaps: [] }, fx.plain, READONLY).decision, 'deny', name);
  }
});

test('entry: a read-only worker finish step prints nothing (pass), a lookalike is denied', () => {
  const ok = entry(JSON.stringify(payload('finish', { gaps: ['lib/lock.mjs'], toolSummary: 'Report gaps' }, fx.active)), READONLY);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
  const bad = entry(JSON.stringify(payload('finish_task', { gaps: [] }, fx.active)), READONLY);
  assert.equal(JSON.parse(bad.stdout.trim()).decision, 'deny');
});

test('symlinked workspacePaths and physical Cwd resolve to the same physical workspace', () => {
  const symWs = join(dirname(fx.active), 'sym-active-ws');
  symlinkSync(fx.active, symWs);
  try {
    // Physical Cwd with symlinked workspacePaths
    assert.equal(run('run_command', { CommandLine: 'git status', Cwd: fx.active }, symWs).decision, 'pass');
    // Symlinked Cwd with physical workspacePaths
    assert.equal(run('run_command', { CommandLine: 'git status', Cwd: symWs }, fx.active).decision, 'pass');
    // Compound cd into physical subdir when workspacePaths is symlinked
    assert.equal(run('run_command', { CommandLine: `cd ${join(fx.active, 'lib')} && git status`, Cwd: symWs }, symWs).decision, 'pass');
  } finally {
    rmSync(symWs, { force: true });
  }
});

test('Wave 2 hardening: npm test -- flag validation, empty-argv redirects/wrappers, compound cd redirects, and file_search', () => {
  // file_search is in READ_ONLY_TOOLS and allowed in read-only mode
  assert.equal(run('file_search', { SearchPath: fx.active }, fx.active, READONLY).decision, 'pass');
  assert.equal(run('file_search', { SearchPath: join(fx.home, '.gemini/antigravity-cli/plugin_data/antigravity-booster') }, fx.active, READONLY).decision, 'deny');

  // npm test -- with valid TEST_FLAG_OK flag passes in worker mode, but --test-reporter-destination=lib/lock.mjs is denied
  assert.equal(shell('npm test -- --test-name-pattern=foo', fx.active, WORKER).decision, 'pass');
  assert.equal(shell('npm test -- --test-reporter-destination=lib/lock.mjs', fx.active, WORKER).decision, 'deny');

  // Redirection without command (> lib/lock.mjs) and bare wrapper (env -S / exec > lib/lock.mjs)
  assert.equal(shell('> lib/lock.mjs', fx.active, INTERACTIVE).decision, 'deny');
  assert.equal(shell('exec > lib/lock.mjs', fx.active, INTERACTIVE).decision, 'deny');
  assert.equal(shell('env -S "rm -f lib/lock.mjs"', fx.active, WORKER).decision, 'deny');

  // Compound cd into workspace with redirection onto a rail must be denied
  assert.equal(shell('cd lib > lib/lock.mjs && git status', fx.active, INTERACTIVE).decision, 'deny');
});

// ---------- agy 1.5.5 swarm & agy 1.5.9 run_workflow (t-policy-guard-agy-1-5-tools) ----------

test('swarm: passes interactively (ignoring prose paths in brief/title/tasks) and denies in headless workers', () => {
  const swarmArgs = {
    action: 'add',
    name: 'helper',
    workspace: 'share',
    model: 'gemini-4-carbon-high',
    title: 'Audit lib/lock.mjs and ~/.local/bin/agb',
    brief: `Inspect ${join(fx.active, 'lib/lock.mjs')}, ${join(fx.active, '.adlc/config.json')}, and ${join(fx.home, '.gemini/antigravity-cli/plugin_data/antigravity-booster/hooks.log')}`,
    tasks: ['Check lib/lock.mjs', 'Check ~/.local/bin/agb'],
    toolSummary: 'Spawn swarm helper for lib/lock.mjs',
  };
  for (const ws of [fx.active, fx.inactive, fx.plain]) {
    assert.equal(run('swarm', swarmArgs, ws, INTERACTIVE).decision, 'pass', `interactive ${ws}`);
    for (const env of [WORKER, READONLY]) {
      const v = run('swarm', swarmArgs, ws, env);
      assert.equal(v.decision, 'deny', `headless ${ws}`);
      assert.match(v.reason, /Headless agb worker session cannot invoke native swarm/);
    }
  }
});

test('swarm: non-prose path parameters and non-string task payloads are still scanned against rails and protected roots', () => {
  assert.equal(run('swarm', { action: 'add', sneaky: join(fx.active, 'lib/lock.mjs') }, fx.active).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', sneaky: join(fx.active, '.adlc/config.json') }, fx.inactive).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', sneaky: join(fx.home, '.local/bin/agb') }, fx.plain).decision, 'deny');
  // Non-string items in tasks are NOT treated as prose
  assert.equal(run('swarm', { action: 'add', tasks: [{ target: join(fx.active, 'lib/lock.mjs') }] }, fx.active).decision, 'deny');
  // Non-string brief is NOT treated as prose
  assert.equal(run('swarm', { action: 'add', brief: { target: join(fx.active, 'lib/lock.mjs') } }, fx.active).decision, 'deny');
});

test('run_workflow: asks in active-rail interactive sessions, passes in inactive/plain repos, denies in headless workers', () => {
  const longScript = `#!/usr/bin/env python3\n# Mentions lib/lock.mjs and ~/.local/bin/agb\nx = 10 / 2\n${'# padding / comment\n'.repeat(300)}`;
  const wfArgs = {
    Script: longScript,
    Description: 'Orchestrate review touching lib/lock.mjs prose',
    Cwd: fx.active,
    Args: { repo: fx.active, target: join(fx.active, 'lib/feature.mjs') },
    WaitMsBeforeAsync: 5000,
    toolSummary: 'Run workflow on lib/lock.mjs prose',
  };

  const activeVerdict = run('run_workflow', wfArgs, fx.active, INTERACTIVE);
  assert.equal(activeVerdict.decision, 'force_ask');
  assert.match(activeVerdict.reason, /run_workflow executes Python outside PreToolUse/);

  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: fx.inactive, Args: { repo: fx.inactive } }, fx.inactive, INTERACTIVE).decision, 'pass');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: fx.plain }, fx.plain, INTERACTIVE).decision, 'pass');

  for (const ws of [fx.active, fx.inactive, fx.plain]) {
    const wv = run('run_workflow', { Script: 'print(1)' }, ws, WORKER);
    assert.equal(wv.decision, 'deny');
    assert.match(wv.reason, /Headless agb worker session cannot execute run_workflow/);

    const rv = run('run_workflow', { Script: 'print(1)' }, ws, READONLY);
    assert.equal(rv.decision, 'deny');
    assert.match(rv.reason, /Read-only agb worker session cannot execute run_workflow/);
  }
});

test('run_workflow: enforces ScriptPath, Cwd, and nested Args against rails, trust roots, and protected roots', () => {
  // ScriptPath hitting rail, implicit rail, repo root, protected root, or booster data root -> deny
  assert.equal(run('run_workflow', { ScriptPath: join(fx.active, 'lib/lock.mjs') }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: join(fx.active, 'alias/gates.mjs') }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: join(fx.inactive, '.adlc/config.json') }, fx.inactive).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: fx.active }, fx.active).decision, 'deny', 'repo root is not a valid ScriptPath');
  assert.equal(run('run_workflow', { ScriptPath: join(fx.home, '.local/bin/agb') }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: join(fx.home, '.config/antigravity-booster/w.py') }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: '' }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: 123 }, fx.active).decision, 'deny');

  // Valid non-rail ScriptPath in active repo -> ask; in plain repo -> pass
  assert.equal(run('run_workflow', { ScriptPath: join(fx.active, 'lib/feature.mjs') }, fx.active).decision, 'force_ask');
  assert.equal(run('run_workflow', { ScriptPath: join(fx.plain, 'lib/feature.mjs') }, fx.plain).decision, 'pass');

  // Nested Args keys named `Script` or `Description` (depth >= 1) are NOT skipped as top-level prose!
  assert.equal(run('run_workflow', { Script: 'print(1)', Args: { Script: join(fx.active, 'lib/lock.mjs') } }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Args: { Description: join(fx.inactive, '.adlc/config.json') } }, fx.inactive).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Args: { bin: join(fx.home, '.local/bin/agb') } }, fx.plain).decision, 'deny');

  // Cwd validation in ADLC repos matches run_command
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: '/tmp' }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: 'lib' }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: '' }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: '' }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: 123 }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: '/tmp' }, fx.plain).decision, 'pass');

  // Missing workspacePaths with omitted Cwd fails closed instead of falling back to '/'
  assert.equal(
    evaluatePayload({ toolCall: { name: 'run_workflow', args: { Script: 'print(1)' } }, workspacePaths: [] }, { env: INTERACTIVE, home: fx.home, platform: 'linux' }).decision,
    'deny',
  );

  // Plain workspace referencing an active-rail ADLC repo via Args -> deny on rail, ask on non-rail
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: '/tmp', Args: { f: join(fx.active, 'lib/lock.mjs') } }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: '/tmp', Args: { repo: fx.active } }, fx.plain).decision, 'force_ask');
});

test('swarm & run_workflow: symlink escapes, bare-filename rails, workspace enum, and prose-key exemptions', () => {
  const protectedBin = join(fx.home, '.local/bin/agb');
  const boosterSecret = join(fx.home, '.gemini/antigravity-cli/plugin_data/antigravity-booster/secret.json');

  // Every SWARM_PROSE_KEYS string/array field carrying an exact protected path passes Step 1
  for (const ws of ['inherit', 'share', 'branch']) {
    assert.equal(
      run('swarm', {
        action: 'CODEOWNERS',
        workspace: ws,
        model: 'CODEOWNERS',
        name: 'CODEOWNERS',
        fork: 'CODEOWNERS',
        brief: protectedBin,
        title: protectedBin,
        tasks: [protectedBin],
        toolAction: protectedBin,
        toolSummary: protectedBin,
      }, fx.active).decision,
      'pass',
    );
  }
  // Also verify SWARM_META_KEYS 'workspace' exemption when a rail shares a valid mode name ('share')
  const wsRailRepo = join(fx.base, 'ws-rail-repo');
  mkdirSync(join(wsRailRepo, '.adlc'), { recursive: true });
  writeFileSync(join(wsRailRepo, '.adlc', 'config.json'), '{}\n');
  initializeDirectoryStore(join(wsRailRepo, '.adlc', 'tickets'));
  writeFileSync(
    join(wsRailRepo, '.adlc', 'tickets', ticketFilename('TW')),
    JSON.stringify({ id: 'TW', title: 't', body: 'b', scope: [], rails: ['share'], edges: [] }, null, 2) + '\n',
  );
  assert.equal(run('swarm', { action: 'add', workspace: 'share' }, wsRailRepo).decision, 'pass');

  // Invalid swarm workspace mode (arbitrary path or non-enum) fails closed
  assert.equal(run('swarm', { action: 'add', workspace: '/tmp/outside' }, fx.plain).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', workspace: 'custom' }, fx.plain).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', workspace: 42 }, fx.plain).decision, 'deny');

  // Relative path in swarm with no workspacePaths fails closed
  assert.equal(
    evaluatePayload({ toolCall: { name: 'swarm', args: { action: 'add', target: 'lib/feature.mjs' } }, workspacePaths: [] }, { env: INTERACTIVE, home: fx.home, platform: 'linux' }).decision,
    'deny',
  );

  // Bare root-level rail token ('CODEOWNERS') is caught in non-meta swarm args and run_workflow Args
  assert.equal(run('swarm', { action: 'add', target: 'CODEOWNERS' }, fx.active).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Args: { file: 'CODEOWNERS' } }, fx.active).decision, 'deny');

  // Bare-filename symlinks in plain/inactive workspaces pointing to protected roots or booster data are denied in Step 1
  const wfBinLink = join(fx.plain, 'wf-bin.py');
  const wfDataLink = join(fx.plain, 'wf-data.py');
  const inactCfgLink = join(fx.inactive, 'cfg-link');
  symlinkSync(protectedBin, wfBinLink);
  symlinkSync(boosterSecret, wfDataLink);
  symlinkSync(join(fx.inactive, '.adlc', 'config.json'), inactCfgLink);

  assert.equal(run('run_workflow', { ScriptPath: 'wf-bin.py' }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { ScriptPath: 'wf-data.py' }, fx.plain).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Args: { ref: 'wf-bin.py' } }, fx.plain).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', target: 'wf-bin.py' }, fx.plain).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', target: 'cfg-link' }, fx.inactive).decision, 'deny');
  assert.equal(run('run_workflow', { Script: 'print(1)', Args: { ref: 'cfg-link' } }, fx.inactive).decision, 'deny');

  // Cwd symlink/.. traversal escaping an ADLC workspace and Cwd symlink loop both fail closed
  const outsideDir = join(fx.base, 'outside-target');
  mkdirSync(join(outsideDir, 'sub'), { recursive: true });
  const escapeLink = join(fx.active, 'escape-sub');
  symlinkSync(join(outsideDir, 'sub'), escapeLink);
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: `${escapeLink}/..` }, fx.active).decision, 'deny');

  const loopLink = join(fx.plain, 'cwd-loop');
  symlinkSync(loopLink, loopLink);
  assert.equal(run('run_workflow', { Script: 'print(1)', Cwd: loopLink }, fx.plain).decision, 'deny');

  // Every WORKFLOW_PROSE_KEYS string field carrying an exact protected path passes Step 1
  assert.equal(
    run('run_workflow', {
      Script: protectedBin,
      Description: protectedBin,
      toolAction: protectedBin,
      toolSummary: protectedBin,
      WaitMsBeforeAsync: 5000,
    }, fx.plain).decision,
    'pass',
  );
  // Hostile path string in WaitMsBeforeAsync is NOT treated as prose -> denied in Step 1
  assert.equal(run('run_workflow', { Script: 'print(1)', WaitMsBeforeAsync: protectedBin }, fx.plain).decision, 'deny');
});

test('Booster MCP policy guard: agb_shape and agb_init enforced across interactive, readonly, and worker modes', () => {
  // Interactive mode allows Booster MCP tools
  assert.equal(run('mcp__agb__agb_shape', { spec: 'specs/foo.md' }, fx.active, INTERACTIVE).decision, 'pass');
  assert.equal(run('mcp__agb__agb_init', { repo: fx.active }, fx.active, INTERACTIVE).decision, 'pass');

  // Read-only mode allows pure inspection MCP tools (agb_shape without syncBrain, agb_doctor without fix, agb_status, agb_preflight, agb_review)
  assert.equal(run('mcp__agb__agb_shape', { spec: 'specs/foo.md' }, fx.active, READONLY).decision, 'pass');
  assert.equal(run('mcp__agb__agb_doctor', {}, fx.active, READONLY).decision, 'pass');
  // Read-only mode denies mutating Booster MCP calls
  assert.equal(run('mcp__agb__agb_shape', { spec: 'specs/foo.md', syncBrain: true }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_doctor', { fix: true }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_init', { repo: fx.active }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_run', { plan: 'plan.json' }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_plan', { spec: 'specs/foo.md', repo: fx.active }, fx.active, READONLY).decision, 'deny');

  // Worker mode denies recursive Booster MCP orchestration
  assert.equal(run('mcp__agb__agb_shape', { spec: 'specs/foo.md' }, fx.active, WORKER).decision, 'deny');
  assert.equal(run('mcp__agb__agb_init', { repo: fx.active }, fx.active, WORKER).decision, 'deny');
  assert.equal(run('mcp__agb__agb_run', { plan: 'plan.json' }, fx.active, WORKER).decision, 'deny');
});

test('Shell: POSIX /dev/null output redirections and pure git rev-parse flags pass without weakening file redirect guards', () => {
  // Stage 1 pure readers and git inspection with /dev/null redirections pass across interactive, worker, and readonly
  for (const cmd of [
    'cat lib/lock.mjs 2>/dev/null',
    'ls -la lib >/dev/null 2>&1',
    'git status --porcelain=v1 2>/dev/null',
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse --verify --quiet HEAD 2>/dev/null',
    'git rev-parse --git-path index',
    'git rev-parse --show-toplevel',
  ]) {
    assert.equal(shell(cmd, fx.active, INTERACTIVE).decision, 'pass', `interactive: ${cmd}`);
    assert.equal(shell(cmd, fx.active, WORKER).decision, 'pass', `worker: ${cmd}`);
    assert.equal(shell(cmd, fx.active, READONLY).decision, 'pass', `readonly: ${cmd}`);
  }

  // Headless worker test commands allow /dev/null stderr/stdout redirections, while interactive active-rail still asks
  assert.equal(shell('node --test test/a.test.mjs 2>/dev/null', fx.active, WORKER).decision, 'pass');
  assert.equal(shell('npm test >/dev/null 2>&1', fx.active, WORKER).decision, 'pass');
  assert.equal(shell('node --test test/a.test.mjs 2>/dev/null', fx.active, INTERACTIVE).decision, 'ask');

  // Non-/dev/null redirects, input redirects on testCmd, dynamic /dev/null targets, win32 platform, and prototype/unlisted git verbs stay guarded
  assert.equal(shell('node --test test/a.test.mjs > out.txt', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('node --test test/a.test.mjs < in.txt', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('cat lib/feature.mjs > /dev/null$FOO', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('cat lib/feature.mjs <> /dev/null', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('git toString', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('git rev-parse --sq-quote foo', fx.active, WORKER).decision, 'deny');
  assert.equal(
    evaluatePayload(payload('run_command', { CommandLine: 'cat lib/feature.mjs 2>/dev/null', Cwd: fx.active }, fx.active), {
      env: WORKER,
      home: fx.home,
      platform: 'win32',
    }).decision,
    'deny',
  );
});

test('Shell: git grep/ls-files inspection, Node v24 test globs, safe test env flags, and AGB_WORKER_BUILD_CMD', () => {
  // Stage 1 git grep & git ls-files pass across interactive, worker, and readonly
  for (const cmd of [
    'git grep -n "lock" lib',
    'git grep --line-number --fixed-strings "foo" -- lib/lock.mjs',
    'git ls-files --stage -- lib/lock.mjs',
  ]) {
    assert.equal(shell(cmd, fx.active, INTERACTIVE).decision, 'pass', `interactive: ${cmd}`);
    assert.equal(shell(cmd, fx.active, WORKER).decision, 'pass', `worker: ${cmd}`);
    assert.equal(shell(cmd, fx.active, READONLY).decision, 'pass', `readonly: ${cmd}`);
  }
  // Pager/file-pattern git grep flags stay excluded from Stage 1
  assert.equal(shell('git grep -Ovi foo', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('git grep -f patterns.txt', fx.active, READONLY).decision, 'deny');

  // Node v24 relative test globs pass in worker mode (including directories containing declared rails), while expansions/traversals deny
  assert.equal(shell('node --test test/*.test.mjs', fx.active, WORKER).decision, 'pass');
  assert.equal(shell('node --test lib/*.mjs', fx.active, WORKER).decision, 'pass');
  assert.equal(shell('node --test ../outside/*.test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('node --test /tmp/*.test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('node --test ~/.gemini/*.test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('node --test $(id).test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('rm lib/*.mjs', fx.active, WORKER).decision, 'deny');

  // Benign test mode env flags pass on test commands; runtime code-injection / secret env vars deny
  assert.equal(shell('AUTOPILOT_GATE_FULL=1 node --test test/a.test.mjs', fx.active, WORKER).decision, 'pass');
  assert.equal(shell('NODE_OPTIONS=--require=/tmp/evil.js node --test test/a.test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('LD_PRELOAD=/tmp/evil.so node --test test/a.test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('ADLC_MANIFEST_KEY=secret node --test test/a.test.mjs', fx.active, WORKER).decision, 'deny');

  // Exact operator-configured plan.gate.build passes only for non-readonly ticket workers matching AGB_WORKER_BUILD_CMD
  const WORKER_WITH_BUILD = { AGB_WORKER_TICKET: 'T1', AGB_WORKER_BUILD_CMD: 'npm run build:cursor-mcp' };
  assert.equal(shell('npm run build:cursor-mcp', fx.active, WORKER_WITH_BUILD).decision, 'pass');
  assert.equal(shell('npm run build', fx.active, WORKER_WITH_BUILD).decision, 'deny');
  assert.equal(shell('FOO=1 npm run build:cursor-mcp', fx.active, WORKER_WITH_BUILD).decision, 'deny');
  assert.equal(shell('npm run build:cursor-mcp', fx.active, { AGB_WORKER_MODE: 'readonly', AGB_WORKER_BUILD_CMD: 'npm run build:cursor-mcp' }).decision, 'deny');
});

// ---------- T-RA-1: Policy Guard Hardening ----------

test('T-RA-1: agb_distill is denied unconditionally in readonly and worker modes, allowed interactively', () => {
  // Interactive allows both direct MCP and call_mcp_tool forms
  assert.equal(run('mcp__agb__agb_distill', { repo: fx.active }, fx.active, INTERACTIVE).decision, 'pass');
  assert.equal(run('mcp__agb__agb_distill', { repo: fx.active, apply: true }, fx.active, INTERACTIVE).decision, 'pass');
  assert.equal(
    run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_distill', Arguments: { repo: fx.active } }, fx.active, INTERACTIVE).decision,
    'pass',
  );

  // Readonly denies unconditionally regardless of apply flag or invocation form
  for (const args of [{ repo: fx.active }, { repo: fx.active, apply: false }, { repo: fx.active, apply: true }]) {
    const direct = run('mcp__agb__agb_distill', args, fx.active, READONLY);
    assert.equal(direct.decision, 'deny');
    assert.match(direct.reason, /agb_distill/);

    const wrapped = run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_distill', Arguments: args }, fx.active, READONLY);
    assert.equal(wrapped.decision, 'deny');
    assert.match(wrapped.reason, /agb_distill/);
  }

  // Headless ticket worker denies both invocation forms
  assert.equal(run('mcp__agb__agb_distill', { repo: fx.active }, fx.active, WORKER).decision, 'deny');
  assert.equal(
    run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_distill', Arguments: { repo: fx.active } }, fx.active, WORKER).decision,
    'deny',
  );
});

test('T-RA-1: CodeGraph tools enforce workspace containment, boosterDataRoots, and headless opt-in', () => {
  const outsideDir = join(fx.base, 'cg-outside');
  mkdirSync(outsideDir, { recursive: true });
  const escapeLink = join(fx.active, 'cg-escape-link');
  symlinkSync(outsideDir, escapeLink);
  try {
    for (const toolName of ['codegraph_explore', 'mcp_codegraph_codegraph_explore', 'mcp__codegraph__codegraph_explore']) {
      // Interactive allows in-workspace paths and pathless symbol queries
      assert.equal(run(toolName, { query: 'BanditModelRouter' }, fx.active, INTERACTIVE).decision, 'pass', `${toolName} pathless interactive`);
      assert.equal(run(toolName, { projectPath: fx.active, query: 'BanditModelRouter' }, fx.active, INTERACTIVE).decision, 'pass', `${toolName} projectPath interactive`);
      assert.equal(run(toolName, { path: join(fx.active, 'lib'), query: 'foo' }, fx.active, INTERACTIVE).decision, 'pass', `${toolName} path interactive`);
      assert.equal(run(toolName, { DirectoryPath: 'lib', query: 'foo' }, fx.active, INTERACTIVE).decision, 'pass', `${toolName} rel DirectoryPath interactive`);

      // Out-of-workspace paths (absolute, traversal, symlink escape, case-folded key, extra path-like string) are denied interactively
      assert.equal(run(toolName, { projectPath: outsideDir, query: 'foo' }, fx.active, INTERACTIVE).decision, 'deny', `${toolName} outside projectPath`);
      assert.equal(run(toolName, { PROJECTPATH: outsideDir, query: 'foo' }, fx.active, INTERACTIVE).decision, 'deny', `${toolName} case-folded outside`);
      assert.equal(run(toolName, { path: '../cg-outside', query: 'foo' }, fx.active, INTERACTIVE).decision, 'deny', `${toolName} traversal`);
      assert.equal(run(toolName, { DirectoryPath: escapeLink, query: 'foo' }, fx.active, INTERACTIVE).decision, 'deny', `${toolName} symlink escape`);
      assert.equal(run(toolName, { query: 'foo', extra: outsideDir }, fx.active, INTERACTIVE).decision, 'deny', `${toolName} extra path-like arg`);
      assert.equal(run(toolName, { projectPath: 123, query: 'foo' }, fx.active, INTERACTIVE).decision, 'deny', `${toolName} non-string projectPath`);

      // boosterDataRoots denied even if workspace === home
      assert.equal(
        evaluatePayload(
          payload(toolName, { projectPath: join(fx.home, '.config', 'antigravity-booster'), query: 'secret' }, fx.home),
          { env: INTERACTIVE, home: fx.home, platform: 'linux' },
        ).decision,
        'deny',
        `${toolName} boosterDataRoots`,
      );

      // Headless and readonly denied by default (and when AGB_ALLOW_CODEGRAPH_MCP !== '1')
      assert.equal(run(toolName, { projectPath: fx.active, query: 'foo' }, fx.active, WORKER).decision, 'deny', `${toolName} worker default deny`);
      assert.equal(run(toolName, { projectPath: fx.active, query: 'foo' }, fx.active, READONLY).decision, 'deny', `${toolName} readonly default deny`);
      assert.equal(run(toolName, { projectPath: fx.active, query: 'foo' }, fx.active, { ...WORKER, AGB_ALLOW_CODEGRAPH_MCP: 'true' }).decision, 'deny', `${toolName} non-1 opt-in deny`);

      // Headless and readonly allowed when AGB_ALLOW_CODEGRAPH_MCP=1 and path is strictly in workspace
      assert.equal(run(toolName, { projectPath: fx.active, query: 'foo' }, fx.active, { ...WORKER, AGB_ALLOW_CODEGRAPH_MCP: '1' }).decision, 'pass', `${toolName} worker opt-in allow`);
      assert.equal(run(toolName, { projectPath: fx.active, query: 'foo' }, fx.active, { ...READONLY, AGB_ALLOW_CODEGRAPH_MCP: '1' }).decision, 'pass', `${toolName} readonly opt-in allow`);

      // Opt-in still enforces workspace containment and boosterDataRoots
      assert.equal(run(toolName, { projectPath: outsideDir, query: 'foo' }, fx.active, { ...WORKER, AGB_ALLOW_CODEGRAPH_MCP: '1' }).decision, 'deny', `${toolName} worker opt-in outside deny`);
      assert.equal(
        evaluatePayload(
          payload(toolName, { projectPath: join(fx.home, '.config', 'antigravity-booster'), query: 'secret' }, fx.home),
          { env: { ...WORKER, AGB_ALLOW_CODEGRAPH_MCP: '1' }, home: fx.home, platform: 'linux' },
        ).decision,
        'deny',
        `${toolName} worker opt-in boosterDataRoots deny`,
      );
    }
  } finally {
    rmSync(escapeLink, { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('T-RA-1: newShardVerdict validates case-folded codecontent and content keys', () => {
  const shardPath = join(fx.active, '.adlc/tickets', ticketFilename('T55'));
  const validTicket = JSON.stringify({ id: 'T55', title: 't', body: 'b', scope: [], rails: [], edges: [] });
  const wrongIdTicket = JSON.stringify({ id: 'T99', title: 't', body: 'b', scope: [], rails: [], edges: [] });

  // Lowercase valid shard passes; lowercase invalid JSON, wrong id, or mixed valid CodeContent + invalid lowercase content denies
  assert.equal(run('write_to_file', { TargetFile: shardPath, codecontent: validTicket }, fx.active).decision, 'pass');
  assert.equal(run('write_file', { Path: shardPath, content: validTicket }, fx.active).decision, 'pass');
  assert.equal(run('write_to_file', { TargetFile: shardPath, codecontent: '{not-json' }, fx.active).decision, 'deny');
  assert.equal(run('write_file', { Path: shardPath, content: wrongIdTicket }, fx.active).decision, 'deny');
  assert.equal(run('write_to_file', { TargetFile: shardPath, CodeContent: validTicket, content: '{broken' }, fx.active).decision, 'deny');
  assert.equal(run('write_to_file', { TargetFile: shardPath, codecontent: 123 }, fx.active).decision, 'deny');
});

test('T-RA-1: evaluateOrchestrationTool denies schedule/send_message in headless mode, case-folds swarm workspace, and denies swarm on corrupt stores', () => {
  // schedule & send_message: pass interactively, deny in WORKER and READONLY
  for (const name of ['schedule', 'send_message']) {
    assert.equal(run(name, {}, fx.active, INTERACTIVE).decision, 'pass', `${name} interactive`);
    assert.equal(run(name, {}, fx.active, WORKER).decision, 'deny', `${name} worker`);
    assert.equal(run(name, {}, fx.active, READONLY).decision, 'deny', `${name} readonly`);
  }

  // swarm: case-folded invalid Workspace / WORKSPACE rejected
  assert.equal(run('swarm', { action: 'add', Workspace: 'custom' }, fx.plain, INTERACTIVE).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', WORKSPACE: '/tmp/outside' }, fx.plain, INTERACTIVE).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', Workspace: 42 }, fx.plain, INTERACTIVE).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', workspace: 'share', Workspace: 'inherit' }, fx.plain, INTERACTIVE).decision, 'deny');
  assert.equal(run('swarm', { action: 'add', Workspace: 'share' }, fx.plain, INTERACTIVE).decision, 'pass');

  // swarm: corrupt ticket store fails closed even for status with no path args
  const corruptRoot = join(fx.base, 'corrupt-swarm');
  mkdirSync(join(corruptRoot, '.adlc'), { recursive: true });
  writeFileSync(join(corruptRoot, '.adlc', 'config.json'), '{}\n');
  initializeDirectoryStore(join(corruptRoot, '.adlc', 'tickets'));
  writeFileSync(join(corruptRoot, '.adlc', 'tickets', ticketFilename('T1')), '{corrupt');
  const v = run('swarm', { action: 'status' }, corruptRoot, INTERACTIVE);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /corrupt or unreadable/);
});

test('T-RA-1: protectedRoots protects default macOS fnm directory (~/Library/Application Support/fnm)', () => {
  const macFnmTarget = join(fx.home, 'Library', 'Application Support', 'fnm', 'node-versions', 'v22.20.0', 'installation', 'bin', 'node');
  const v = run('write_to_file', { TargetFile: macFnmTarget, CodeContent: 'evil' }, fx.plain, INTERACTIVE);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /platform configuration/);
});

// ---------- T-NG-1: Brain Artifact Carve-Out, IPC/Rescue Guards, & 2.0 MCP Tools ----------

test('T-NG-1: interactive brain artifact carve-out permits verified active session brain reads/writes while denying .system_generated, symlinks, mismatches, ancestors, and headless workers', () => {
  const convId = '59f04450-bfa3-4157-a219-ccb1e501844d';
  const otherConvId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const brainApps = ['antigravity', 'antigravity-cli', 'antigravity-ide', 'jetski'];

  const evalBrain = (toolName, args, extraPayload = {}, env = INTERACTIVE, ws = fx.active) =>
    evaluatePayload(
      { toolCall: { name: toolName, args }, workspacePaths: [ws], ...extraPayload },
      { env, home: fx.home, platform: 'linux' },
    );

  // 1. All 4 brain app roots pass interactive reads & writes (including before <convId> dir exists, after creation, nested scratch/, and trailing slash on artifactDirectoryPath)
  for (const app of brainApps) {
    const artifactDir = join(fx.home, '.gemini', app, 'brain', convId);
    const planFile = join(artifactDir, 'implementation_plan.md');
    const scratchFile = join(artifactDir, 'scratch', 'notes.md');
    const validMeta = { conversationId: convId, artifactDirectoryPath: artifactDir };
    const trailingSlashMeta = { conversationId: convId, artifactDirectoryPath: `${artifactDir}/` };

    // Before directory exists on disk (first artifact creation)
    mkdirSync(join(fx.home, '.gemini', app, 'brain'), { recursive: true });
    assert.equal(evalBrain('write_file', { Path: planFile, Content: '# Plan' }, validMeta).decision, 'pass', `${app} pre-mkdir write_file`);
    assert.equal(evalBrain('write_file', { Path: planFile, Content: '# Plan' }, trailingSlashMeta).decision, 'pass', `${app} trailing slash write_file`);

    // Create physical directories and verify reads, edits, list_dir
    mkdirSync(join(artifactDir, 'scratch'), { recursive: true });
    writeFileSync(planFile, '# Plan\n');
    assert.equal(evalBrain('write_to_file', { TargetFile: planFile, CodeContent: '# Plan v2' }, validMeta).decision, 'pass', `${app} write_to_file`);
    assert.equal(evalBrain('edit_file', { Path: planFile, Target: '# Plan', Replacement: '# Updated' }, validMeta).decision, 'pass', `${app} edit_file`);
    assert.equal(evalBrain('sed_file', { target_file: planFile, expressions: ['s/Plan/Spec/g'] }, validMeta).decision, 'pass', `${app} sed_file`);
    assert.equal(evalBrain('write_file', { Path: scratchFile, Content: 'scratch' }, validMeta).decision, 'pass', `${app} nested scratch write`);
    assert.equal(evalBrain('read_file', { Path: planFile }, validMeta).decision, 'pass', `${app} read_file`);
    assert.equal(evalBrain('view_file', { AbsolutePath: planFile }, validMeta).decision, 'pass', `${app} view_file`);
    assert.equal(evalBrain('list_dir', { DirectoryPath: artifactDir }, validMeta).decision, 'pass', `${app} list_dir exact`);
    assert.equal(evalBrain('list_directory', { DirAbsolutePath: `${artifactDir}/` }, validMeta).decision, 'pass', `${app} list_directory exact`);
  }

  const cliBrain = join(fx.home, '.gemini', 'antigravity-cli', 'brain');
  const artifactDir = join(cliBrain, convId);
  const planFile = join(artifactDir, 'implementation_plan.md');
  const validMeta = { conversationId: convId, artifactDirectoryPath: artifactDir };

  // 2. .system_generated and .system_generated/** are strictly denied for interactive writes/deletes while interactive transcript reads remain permitted
  const sysGenDir = join(artifactDir, '.system_generated');
  const sysGenLog = join(sysGenDir, 'logs', 'transcript.jsonl');
  mkdirSync(join(sysGenDir, 'logs'), { recursive: true });
  writeFileSync(sysGenLog, '{}\n');
  assert.equal(evalBrain('write_file', { Path: sysGenLog, Content: 'x' }, validMeta).decision, 'deny');
  assert.equal(evalBrain('edit_file', { Path: sysGenLog, Target: '{}', Replacement: 'x' }, validMeta).decision, 'deny');
  assert.equal(evalBrain('delete_file', { TargetFile: sysGenLog }, validMeta).decision, 'deny');
  assert.equal(evalBrain('delete_directory', { directoryPath: sysGenDir }, validMeta).decision, 'deny');
  assert.equal(evalBrain('read_file', { Path: sysGenLog }, validMeta).decision, 'pass', 'interactive agent can read its own .system_generated transcript');
  assert.equal(evalBrain('read_file', { Path: sysGenLog }, {}).decision, 'pass', 'interactive read passes even if host omits conversationId');

  // 3. Ancestor / exact-root directory deletions and shell mutations remain denied
  assert.equal(evalBrain('delete_directory', { directoryPath: artifactDir }, validMeta).decision, 'deny', 'cannot delete active brain root itself');
  assert.equal(evalBrain('delete_directory', { directoryPath: cliBrain }, validMeta).decision, 'deny', 'cannot delete brain parent');
  assert.equal(evalBrain('delete_directory', { directoryPath: join(fx.home, '.gemini') }, validMeta).decision, 'deny', 'cannot delete .gemini');
  assert.equal(evalBrain('run_command', { CommandLine: `rm -rf ${cliBrain}`, Cwd: fx.active }, validMeta).decision, 'deny');
  assert.equal(evalBrain('run_command', { CommandLine: `rm -f ${planFile}`, Cwd: fx.active }, validMeta).decision, 'deny');

  // 4. Mismatched conversationId and invalid conversationId/artifactDirectoryPath deny both interactive reads and writes
  const otherDir = join(cliBrain, otherConvId);
  mkdirSync(otherDir, { recursive: true });
  const otherPlan = join(otherDir, 'implementation_plan.md');
  writeFileSync(otherPlan, '# Other\n');
  assert.equal(evalBrain('write_file', { Path: otherPlan, Content: 'x' }, validMeta).decision, 'deny', 'target in different convId');
  assert.equal(evalBrain('read_file', { Path: otherPlan }, validMeta).decision, 'deny', 'read in different convId denied when metadata present');
  assert.equal(evalBrain('edit_file', { Path: otherPlan, Target: '# Other', Replacement: 'x' }, validMeta).decision, 'deny');
  assert.equal(evalBrain('write_file', { Path: planFile, Content: 'x' }, { conversationId: otherConvId, artifactDirectoryPath: artifactDir }).decision, 'deny', 'convId != artifactDir leaf');
  assert.equal(evalBrain('read_file', { Path: planFile }, { conversationId: otherConvId, artifactDirectoryPath: artifactDir }).decision, 'deny');

  for (const badMeta of [
    {},
    { conversationId: 'short', artifactDirectoryPath: join(cliBrain, 'short') },
    { conversationId: 'bad/conv/id', artifactDirectoryPath: artifactDir },
    { conversationId: 'a'.repeat(129), artifactDirectoryPath: join(cliBrain, 'a'.repeat(129)) },
    { conversationId: 12345678, artifactDirectoryPath: artifactDir },
    { conversationId: convId },
    { conversationId: convId, artifactDirectoryPath: '.gemini/antigravity-cli/brain/' + convId },
    { conversationId: convId, artifactDirectoryPath: join(fx.plain, 'brain', convId) },
    { conversationId: convId, artifactDirectoryPath: `${artifactDir}/../${convId}` },
  ]) {
    assert.equal(evalBrain('write_file', { Path: planFile, Content: 'x' }, badMeta).decision, 'deny', `write badMeta ${JSON.stringify(badMeta)}`);
  }

  // Traversal out of artifactDir (`<artifactDir>/../...`) is denied
  assert.equal(evalBrain('write_file', { Path: `${artifactDir}/../../../settings.json`, Content: 'x' }, validMeta).decision, 'deny');
  assert.equal(evalBrain('write_file', { Path: `${artifactDir}/sub/../implementation_plan.md`, Content: 'x' }, validMeta).decision, 'deny');

  // 5. Symlink checks: symlinked file inside <convId>, symlinked subdir inside <convId>, workspace symlink into <convId>, and symlinked <convId> / brain dir
  const fileSym = join(artifactDir, 'sym-plan.md');
  const subSym = join(artifactDir, 'sym-sub');
  const wsSym = join(fx.active, 'ws-brain-link.md');
  const symConvId = 'symconv1-1111-2222-3333-444444444444';
  const symConvDir = join(cliBrain, symConvId);
  symlinkSync(planFile, fileSym);
  symlinkSync(join(artifactDir, 'scratch'), subSym);
  symlinkSync(planFile, wsSym);
  symlinkSync(artifactDir, symConvDir);
  try {
    assert.equal(evalBrain('write_file', { Path: fileSym, Content: 'x' }, validMeta).decision, 'deny', 'symlinked file inside brain');
    assert.equal(evalBrain('write_file', { Path: join(subSym, 'a.md'), Content: 'x' }, validMeta).decision, 'deny', 'symlinked subdir inside brain');
    assert.equal(evalBrain('write_file', { Path: wsSym, Content: 'x' }, validMeta).decision, 'deny', 'write workspace symlink pointing into brain');
    assert.equal(
      evalBrain('write_file', { Path: join(symConvDir, 'implementation_plan.md'), Content: 'x' }, { conversationId: symConvId, artifactDirectoryPath: symConvDir }).decision,
      'deny',
      'symlinked <convId> dir',
    );
  } finally {
    rmSync(fileSym, { force: true });
    rmSync(subSym, { force: true });
    rmSync(wsSym, { force: true });
    rmSync(symConvDir, { force: true });
  }

  // Symlinked `brain` component itself in an isolated home
  const symBrainHome = join(fx.base, 'sym-brain-home');
  const externalBrainTarget = join(fx.base, 'ext-brain-target');
  mkdirSync(join(symBrainHome, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(externalBrainTarget, convId), { recursive: true });
  symlinkSync(externalBrainTarget, join(symBrainHome, '.gemini', 'antigravity-cli', 'brain'));
  try {
    const symArtDir = join(symBrainHome, '.gemini', 'antigravity-cli', 'brain', convId);
    const vSymBrain = evaluatePayload(
      {
        toolCall: { name: 'write_file', args: { Path: join(symArtDir, 'implementation_plan.md'), Content: 'x' } },
        workspacePaths: [fx.active],
        conversationId: convId,
        artifactDirectoryPath: symArtDir,
      },
      { env: INTERACTIVE, home: symBrainHome, platform: 'linux' },
    );
    assert.equal(vSymBrain.decision, 'deny', 'symlinked brain directory must be denied');
  } finally {
    rmSync(symBrainHome, { recursive: true, force: true });
    rmSync(externalBrainTarget, { recursive: true, force: true });
  }

  // 6. Headless (AGB_WORKER_TICKET) and Readonly (AGB_WORKER_MODE=readonly) workers are 100% denied even with matching payload metadata
  for (const workerEnv of [WORKER, READONLY]) {
    assert.equal(evalBrain('write_file', { Path: planFile, Content: 'x' }, validMeta, workerEnv).decision, 'deny');
    assert.equal(evalBrain('read_file', { Path: planFile }, validMeta, workerEnv).decision, 'deny');
    assert.equal(evalBrain('view_file', { AbsolutePath: planFile }, validMeta, workerEnv).decision, 'deny');
    assert.equal(evalBrain('list_dir', { DirectoryPath: artifactDir }, validMeta, workerEnv).decision, 'deny');
    assert.equal(evalBrain('run_command', { CommandLine: `cat ${planFile}`, Cwd: fx.active }, validMeta, workerEnv).decision, 'deny');
  }
});

test('T-NG-1: headless and readonly workers are denied on .booster IPC/rescue paths and <tmpdir>/agb-ctrl-* across reads, writes, MCP, and shell', () => {
  const realTmp = realpathSync(tmpdir());
  const tmpCtrlDir = join(tmpdir(), `agb-ctrl-test-${process.pid}`);
  const realTmpCtrlFile = join(realTmp, `agb-ctrl-sock-${process.pid}.sock`);

  for (const repoRoot of [fx.active, fx.plain]) {
    mkdirSync(join(repoRoot, '.booster', 'rescue-locks'), { recursive: true });
    mkdirSync(join(repoRoot, '.booster', 'rescue-latest', 'T1'), { recursive: true });
    writeFileSync(join(repoRoot, '.booster', 'control.json'), '{"token":"secret"}\n');
    writeFileSync(join(repoRoot, '.booster', 'run.json'), '{"status":"running"}\n');
  }

  const protectedTargets = [
    join(fx.active, '.booster', 'control.json'),
    join(fx.active, '.booster', 'control.sock'),
    join(fx.active, '.booster', 'rescue-locks'),
    join(fx.active, '.booster', 'rescue-locks', 'T1.json'),
    join(fx.active, '.booster', 'rescue-latest'),
    join(fx.active, '.booster', 'rescue-latest', 'T1', 'manifest.json'),
    join(tmpCtrlDir, 'control.sock'),
    realTmpCtrlFile,
    '/tmp/agb-ctrl-fixed/control.sock',
    '/private/tmp/agb-ctrl-priv/control.sock',
  ];

  const symControl = join(fx.active, 'lib', 'sneaky-control.json');
  symlinkSync(join(fx.active, '.booster', 'control.json'), symControl);

  try {
    for (const env of [WORKER, READONLY]) {
      for (const target of [...protectedTargets, symControl]) {
        assert.equal(run('read_file', { Path: target }, fx.active, env).decision, 'deny', `read_file ${target}`);
        assert.equal(run('view_file', { AbsolutePath: target }, fx.active, env).decision, 'deny', `view_file ${target}`);
        assert.equal(run('list_dir', { DirectoryPath: target }, fx.active, env).decision, 'deny', `list_dir ${target}`);
        assert.equal(run('grep_search', { SearchPath: target }, fx.active, env).decision, 'deny', `grep_search ${target}`);
        assert.equal(run('write_file', { Path: target, Content: 'x' }, fx.plain, env).decision, 'deny', `write_file ${target}`);
        assert.equal(run('write_to_file', { TargetFile: target, CodeContent: 'x' }, fx.plain, env).decision, 'deny', `write_to_file ${target}`);
        assert.equal(run('edit_file', { Path: target, Target: 'a', Replacement: 'b' }, fx.plain, env).decision, 'deny', `edit_file ${target}`);
        assert.equal(run('delete_file', { TargetFile: target }, fx.plain, env).decision, 'deny', `delete_file ${target}`);
        assert.equal(run('sed_file', { target_file: target, expressions: ['1d'] }, fx.plain, env).decision, 'deny', `sed_file ${target}`);
        assert.equal(run('mcp__agb__agb_status', { path: target }, fx.active, env).decision, 'deny', `mcp scan ${target}`);
        assert.equal(shell(`cat ${target}`, fx.active, env).decision, 'deny', `shell cat ${target}`);
        assert.equal(shell(`ls ${target}`, fx.active, env).decision, 'deny', `shell ls ${target}`);
        assert.equal(shell(`rm -rf ${target}`, fx.plain, env).decision, 'deny', `shell rm ${target}`);
      }

      // Parent .booster directory-level reads, globs, oversized globs, and shell bypasses in headless mode (even in non-ADLC plain repo!)
      assert.equal(run('list_dir', { DirectoryPath: join(fx.plain, '.booster') }, fx.plain, env).decision, 'deny');
      assert.equal(run('grep_search', { SearchPath: join(fx.plain, '.booster') }, fx.plain, env).decision, 'deny');
      assert.equal(run('find_by_name', { SearchPath: join(fx.plain, '.booster') }, fx.plain, env).decision, 'deny');
      assert.equal(run('delete_directory', { directoryPath: join(fx.plain, '.booster') }, fx.plain, env).decision, 'deny');
      assert.equal(shell('ls .booster', fx.plain, env).decision, 'deny');
      assert.equal(shell('tar -cf /dev/null .booster', fx.plain, env).decision, 'deny');
      assert.equal(shell('python3 -c "print(open(\'.booster/control.json\').read())"', fx.plain, env).decision, 'deny');
      assert.equal(shell('rm -rf .booster', fx.plain, env).decision, 'deny');
      assert.equal(shell('cat .booster/*', fx.plain, env).decision, 'deny');
      assert.equal(shell('cat .booste*/control.json', fx.plain, env).decision, 'deny');
      assert.equal(shell('cat .booster/r*/t*.json', fx.plain, env).decision, 'deny');
      assert.equal(shell('cat .booste*/r*/t1.json', fx.plain, env).decision, 'deny');
      assert.equal(shell(`cat ${join(fx.plain, 'a'.repeat(1100), '.booster/control*')}`, fx.plain, env).decision, 'deny');
      assert.equal(shell('cat .booster/control*', fx.plain, env).decision, 'deny');
      assert.equal(shell('cat /tmp/agb-ctrl-*', fx.plain, env).decision, 'deny');
      assert.equal(shell('cat /tmp/agb-ctrl*', fx.plain, env).decision, 'deny');
      assert.equal(shell('echo pwned > .booster/foo.json', fx.plain, env).decision, 'deny');

      // Public telemetry (.booster/run.json) remains readable
      assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'run.json') }, fx.active, env).decision, 'pass');
      assert.equal(shell('cat .booster/run.json', fx.active, env).decision, 'pass');
    }

    // Normal builder globs (`ls src/*`, `cat lib/*.mjs`) in WORKER mode must NOT false-positive as .booster paths
    assert.equal(shell('ls src/*', fx.plain, WORKER).decision, 'pass');
    assert.equal(shell('cat lib/*.mjs', fx.plain, WORKER).decision, 'pass');

    // AGB_RESCUE_TICKET protects .booster/control.json, unparseable shell, and redirects while keeping interactive prompts working
    const RESCUE_ENV = { ...INTERACTIVE, AGB_RESCUE_TICKET: 'T1' };
    assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'control.json') }, fx.active, RESCUE_ENV).decision, 'deny');
    assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'rescue-locks', 'T1.json') }, fx.active, RESCUE_ENV).decision, 'deny');
    assert.equal(shell('cat .booster/control.json', fx.active, RESCUE_ENV).decision, 'deny');
    assert.equal(shell('echo "unterminated', fx.plain, RESCUE_ENV).decision, 'deny');
    assert.equal(shell('cat package.json > .booster/tamper.json', fx.plain, RESCUE_ENV).decision, 'deny');
    assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'run.json') }, fx.active, RESCUE_ENV).decision, 'pass');

    // Interactive sessions are not blocked from .booster/control.json or rescue-locks
    assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'control.json') }, fx.active, INTERACTIVE).decision, 'pass');
    assert.equal(run('write_file', { Path: join(fx.active, '.booster', 'control.json'), Content: '{}' }, fx.active, INTERACTIVE).decision, 'pass');
  } finally {
    rmSync(symControl, { force: true });
  }
});

test('T-NG-1: BOOSTER_MCP_TOOLS enforces agb_flight_deck, agb_mission_control, agb_plan_viewer, and agb_control across interactive, readonly, and worker modes', () => {
  const uiTools = ['agb_flight_deck', 'agb_mission_control', 'agb_plan_viewer'];
  for (const tool of [...uiTools, 'agb_control']) {
    assert.equal(isBoosterMcpTool(`mcp__agb__${tool}`, {}), true, `direct agb ${tool}`);
    assert.equal(isBoosterMcpTool(`mcp__antigravity-booster_agb__${tool}`, {}), true, `direct qualified ${tool}`);
    assert.equal(isBoosterMcpTool('call_mcp_tool', { ServerName: 'agb', ToolName: tool }), true, `call_mcp_tool ${tool}`);

    // Ticket worker denies all Booster MCP tools
    assert.equal(run(`mcp__agb__${tool}`, {}, fx.active, WORKER).decision, 'deny', `worker direct ${tool}`);
    assert.equal(
      run('call_mcp_tool', { ServerName: 'agb', ToolName: tool, Arguments: {} }, fx.active, WORKER).decision,
      'deny',
      `worker call_mcp_tool ${tool}`,
    );
  }

  // UI view tools pass in interactive & readonly, unless referencing a frozen rail
  for (const tool of uiTools) {
    assert.equal(run(`mcp__agb__${tool}`, { repo: fx.active }, fx.active, INTERACTIVE).decision, 'pass', `interactive ${tool}`);
    assert.equal(run(`mcp__agb__${tool}`, { repo: fx.active }, fx.active, READONLY).decision, 'pass', `readonly ${tool}`);
    assert.equal(
      run('call_mcp_tool', { ServerName: 'agb', ToolName: tool, Arguments: { repo: fx.active } }, fx.active, READONLY).decision,
      'pass',
      `readonly call_mcp_tool ${tool}`,
    );
    assert.equal(
      run(`mcp__agb__${tool}`, { path: join(fx.active, 'lib', 'lock.mjs') }, fx.active, INTERACTIVE).decision,
      'deny',
      `rail scan ${tool}`,
    );
  }

  // agb_control: interactive allows both read and control actions
  for (const action of ['snapshot', 'diff', 'stream', 'pause', 'resume', 'abort']) {
    assert.equal(run('mcp__agb__agb_control', { action }, fx.active, INTERACTIVE).decision, 'pass', `interactive control ${action}`);
  }

  // agb_control in readonly: allows snapshot, diff, stream (case-folded key & value)
  for (const action of ['snapshot', 'diff', 'stream', 'SNAPSHOT', 'Diff', 'Stream']) {
    assert.equal(run('mcp__agb__agb_control', { action }, fx.active, READONLY).decision, 'pass', `readonly direct ${action}`);
    assert.equal(run('mcp__agb__agb_control', { Action: action }, fx.active, READONLY).decision, 'pass', `readonly direct Action ${action}`);
    assert.equal(
      run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_control', Arguments: { Action: action } }, fx.active, READONLY).decision,
      'pass',
      `readonly call_mcp_tool ${action}`,
    );
  }

  // agb_control in readonly: denies pause, resume, abort, missing, empty, non-string, and unknown actions
  for (const badArgs of [
    { action: 'pause' },
    { action: 'PAUSE' },
    { Action: 'resume' },
    { action: 'abort' },
    { action: '' },
    { action: 'unknown' },
    { action: 123 },
    {},
  ]) {
    const direct = run('mcp__agb__agb_control', badArgs, fx.active, READONLY);
    assert.equal(direct.decision, 'deny', `readonly direct deny ${JSON.stringify(badArgs)}`);
    assert.match(direct.reason, /mutating MCP tool: agb_control/);

    const wrapped = run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_control', Arguments: badArgs }, fx.active, READONLY);
    assert.equal(wrapped.decision, 'deny', `readonly wrapped deny ${JSON.stringify(badArgs)}`);
    assert.match(wrapped.reason, /mutating MCP tool: agb_control/);
  }

  // Wave 3 agb_accept & accept-state.json / accept-dossier.md headless protection
  assert.equal(isBoosterMcpTool('mcp__agb__agb_accept', {}), true);
  assert.equal(run('mcp__agb__agb_accept', { repo: fx.active }, fx.active, WORKER).decision, 'deny');
  assert.equal(
    run(
      'mcp__agb__agb_accept',
      { repo: fx.active, verdicts: { ['f'.repeat(64)]: 'accepted' } },
      fx.active,
      READONLY
    ).decision,
    'pass',
    'readonly session allows non-saving agb_accept with 64-hex verdicts'
  );
  const saveDeny = run(
    'mcp__agb__agb_accept',
    { repo: fx.active, verdicts: { ['f'.repeat(64)]: 'accepted' }, saveVerdicts: true },
    fx.active,
    READONLY
  );
  assert.equal(saveDeny.decision, 'deny');
  assert.match(saveDeny.reason, /mutating MCP tool: agb_accept/);
  assert.equal(
    run(
      'call_mcp_tool',
      { ServerName: 'agb', ToolName: 'agb_accept', Arguments: { SaveVerdicts: true } },
      fx.active,
      READONLY
    ).decision,
    'deny'
  );
  assert.equal(
    run(
      'mcp__agb__agb_accept',
      { repo: fx.active, verdicts: { ['f'.repeat(64)]: 'accepted' }, saveVerdicts: true },
      fx.active,
      INTERACTIVE
    ).decision,
    'pass'
  );
  assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'accept-state.json') }, fx.active, WORKER).decision, 'deny');
  assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'accept-dossier.md') }, fx.active, WORKER).decision, 'deny');
  assert.equal(shell('cat .booster/accept-state.json', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('cat .booster/accept*', fx.active, WORKER).decision, 'deny');

  // Wave 4 agb_holdout, custom AGB_HOLDOUT_DIR, and holdout shell literal protection
  assert.equal(isBoosterMcpTool('mcp__agb__agb_holdout', {}), true);
  assert.equal(run('mcp__agb__agb_holdout', { action: 'list', repo: fx.active }, fx.active, WORKER).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'list', repo: fx.active }, fx.active, READONLY).decision, 'pass');
  assert.equal(run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_holdout', Arguments: { Action: 'LIST', repo: fx.active } }, fx.active, READONLY).decision, 'pass');
  assert.equal(run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_holdout', Arguments: { Action: 'CLEAN', repo: fx.active } }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('call_mcp_tool', { ServerName: 'agb', ToolName: 'agb_holdout', Arguments: { repo: fx.active } }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'clean', repo: fx.active }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'run', repo: fx.active }, fx.active, READONLY).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'run', repo: fx.active }, fx.active, INTERACTIVE).decision, 'pass');

  const customHoldoutDir = join(fx.base, 'custom-holdouts');
  assert.equal(
    run('read_file', { Path: join(customHoldoutDir, '01-secret.holdout.test.mjs') }, fx.active, { ...WORKER, AGB_HOLDOUT_DIR: customHoldoutDir }).decision,
    'deny'
  );
  assert.equal(shell('cat 01-secret.holdout.test.mjs', fx.active, WORKER).decision, 'deny');
  assert.equal(shell('ls twins-runtime', fx.active, WORKER).decision, 'deny');

  // SEC-W4-02, SEC-W4-07 & SEC-W4-R2-02: .booster/logs & .booster/runs blocked in headless/rescue, and rescue cannot clean holdouts via MCP or CLI
  const RESCUE_ENV = { AGB_RESCUE_TICKET: 'T-RESCUE-1' };
  assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'logs', 'run-1', 'T1.jsonl') }, fx.active, WORKER).decision, 'deny');
  assert.equal(run('read_file', { Path: join(fx.active, '.booster', 'runs', 'run-1-prosecution.json') }, fx.active, RESCUE_ENV).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'clean', repo: fx.active }, fx.active, RESCUE_ENV).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'run', repo: fx.active }, fx.active, RESCUE_ENV).decision, 'deny');
  assert.equal(run('mcp__agb__agb_holdout', { action: 'list', repo: fx.active }, fx.active, RESCUE_ENV).decision, 'pass');
  assert.equal(run('mcp__agb__agb_distill', { repo: fx.active, compileChecks: true }, fx.active, RESCUE_ENV).decision, 'deny');
  assert.equal(run('mcp__agb__agb_distill', { repo: fx.active, apply: true }, fx.active, RESCUE_ENV).decision, 'deny');
  assert.equal(shell('agb holdout clean . --ticket T-RESCUE-1', fx.inactive, RESCUE_ENV).decision, 'deny');
  assert.equal(shell('node bin/agb.mjs holdout clean .', fx.inactive, RESCUE_ENV).decision, 'deny');
  assert.equal(shell('agb distill . --compile-checks', fx.inactive, RESCUE_ENV).decision, 'deny');
  assert.equal(shell('agb holdout list .', fx.inactive, RESCUE_ENV).decision, 'pass');
  assert.equal(shell('cat .booster/logs/run-1/T1.jsonl', fx.inactive, RESCUE_ENV).decision, 'deny');
});
