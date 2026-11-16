// agy 1.5.9 zero-ask 5-column policy matrix for send_command_input, manage_task, and subagent tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { buildContext, evaluatePayload, evaluateSendCommandInput } from '../hooks/policy/evaluate.mjs';
import { STDIN_TOOLS, SUBAGENT_PROSE_KEYS, SUBAGENT_TOOLS } from '../hooks/policy/constants.mjs';
import { boosterDataRoots, protectedRoots } from '../hooks/policy/paths.mjs';

const INIT_TOOLS_FIXTURE = fileURLToPath(new URL('./fixtures/agy-1.5.9-init-tools.json', import.meta.url));

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-stdin-sub-')));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });
test.after(() => rmSync(base, { recursive: true, force: true }));

function makeRepo(name, mode) {
  const root = join(base, name);
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'lock.mjs'), '// frozen rail\n');
  writeFileSync(join(root, 'lib', 'safe.mjs'), '// safe\n');
  symlinkSync(join(root, 'lib', 'safe.mjs'), join(root, 'lib', 'safe-link.mjs'));
  if (mode) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
    initializeDirectoryStore(join(root, '.adlc', 'tickets'));
    if (mode === 'corrupt') {
      writeFileSync(join(root, '.adlc', 'tickets', 'bad.json'), '{corrupt');
    } else {
      const t = {
        id: 'T1',
        title: 't',
        body: 'b',
        scope: ['lib/safe.mjs'],
        rails: mode === 'active' ? ['lib/lock.mjs'] : [],
        edges: [],
      };
      writeFileSync(join(root, '.adlc', 'tickets', ticketFilename(t.id)), JSON.stringify(t, null, 2) + '\n');
    }
  }
  symlinkSync(join(root, 'lib', 'safe.mjs'), join(root, mode ? '.adlc/sessions.json' : 'plain-link.txt'));
  return root;
}

const active = makeRepo('active', 'active');
const inactive = makeRepo('inactive', 'inactive');
const corrupt = makeRepo('corrupt', 'corrupt');
const plain = makeRepo('plain', null);

const COLS = {
  col1: { env: { AGB_WORKER_MODE: 'readonly' }, ws: active },
  col2: { env: { AGB_WORKER_TICKET: 'T1' }, ws: active },
  col3: { env: {}, ws: active },
  col4: { env: {}, ws: inactive },
  col5: { env: {}, ws: plain },
};

function run(name, args, col) {
  const v = evaluatePayload({ toolCall: { name, args }, workspacePaths: col.ws ? [col.ws] : [] }, { env: col.env, home, platform: 'linux' });
  assert.notEqual(v.decision, 'ask', `${name} must never emit ask; got ${JSON.stringify(v)}`);
  return v;
}

test('constants export STDIN_TOOLS, SUBAGENT_TOOLS, and SUBAGENT_PROSE_KEYS', () => {
  assert.deepEqual([...STDIN_TOOLS], ['send_command_input']);
  assert.deepEqual([...SUBAGENT_TOOLS].sort(), ['define_subagent', 'invoke_subagent', 'manage_subagents']);
  for (const k of ['Prompt', 'prompt', 'SystemPrompt', 'systemprompt', 'Description', 'description', 'Role', 'role', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary']) {
    assert.ok(SUBAGENT_PROSE_KEYS.has(k), k);
  }
});

test('send_command_input: 5-column matrix for Terminate vs stdin writes, ask->deny conversion, and argument validation', () => {
  // Terminate === true with empty/omitted Input
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true }, COLS.col1).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true }, COLS.col2).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true }, COLS.col3).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true, Input: '' }, COLS.col3).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true }, COLS.col4).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true, WaitMs: 100, WaitMsBeforeAsync: 200, toolAction: 'a', toolSummary: 's' }, COLS.col5).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true }, { env: {}, ws: corrupt }).decision, 'deny');

  // Non-empty Input or Terminate !== true
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'ls\n' }, COLS.col1).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'ls\n' }, COLS.col2).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'ls\n' }, COLS.col3).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: true, Input: 'ls\n' }, COLS.col3).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Terminate: false }, COLS.col3).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'ls\n' }, { env: {}, ws: corrupt }).decision, 'deny');

  // Col 4 & Col 5 evaluate Input through classifyRunCommand (pass -> pass; deny/ask -> deny!)
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'git status' }, COLS.col4).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'rm .adlc/config.json' }, COLS.col4).decision, 'deny');
  // adlc ticket complete without --authorize or with --authorize (which normally returns 'ask' interactively) must become 'deny'!
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'adlc ticket complete T1 --write --authorize' }, COLS.col4).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'git status' }, COLS.col5).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: `rm ${protectedRoots(home)[0]}/x` }, COLS.col5).decision, 'deny');
  // REPL non-shell syntax inside Input referencing implicit rails, protected roots, or booster data is also denied!
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: 'open(".adlc/config.json", "w")' }, COLS.col4).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: `shutil.rmtree("${protectedRoots(home)[0]}/x")` }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'cmd-1', Input: `read("${boosterDataRoots(home)[0]}/hooks.log")` }, COLS.col5).decision, 'deny');

  // stepOne skips Input so protected-root strings inside safe echo Input do not fail before shell classification in Col 5,
  // while non-Input path fields (CommandId) ARE scanned against boosterDataRoots, protectedRoots, rails, symlinks, and unanchored paths!
  const inactiveRootLink = join(plain, 'inactive-root-link');
  symlinkSync(inactive, inactiveRootLink);
  assert.equal(run('send_command_input', { CommandId: join(plain, 'lib/safe-link.mjs'), Input: 'git status' }, COLS.col5).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: inactive, Terminate: true, toolsummary: join(boosterDataRoots(home)[0], 'y') }, COLS.col4).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: inactiveRootLink, Terminate: true }, COLS.col4).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: join(boosterDataRoots(home)[0], 'secret'), Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: join(protectedRoots(home)[0], 'cfg'), Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: join(inactive, '.adlc/config.json'), Terminate: true }, COLS.col4).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: join(inactive, '.adlc/sessions.json'), Terminate: true }, COLS.col4).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 'rel/path', Terminate: true }, { env: {}, ws: null }).decision, 'deny');

  // Closed schema and scalar validation
  assert.equal(evaluateSendCommandInput(null, buildContext({ toolCall: { name: 'send_command_input', args: null }, workspacePaths: [plain] }, { home })).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: undefined, Terminate: true }, COLS.col5).decision, 'pass');
  assert.equal(run('send_command_input', { CommandId: '   ', Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { CommandId: 42, Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { Terminate: 'true' }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { Input: 42 }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { toolAction: 42, Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { toolSummary: 42, Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { WaitMs: Infinity, Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { WaitMs: '10', Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { WaitMsBeforeAsync: NaN, Terminate: true }, COLS.col5).decision, 'deny');
  assert.equal(run('send_command_input', { ExtraKey: 1, Terminate: true }, COLS.col5).decision, 'deny');
});

test('manage_task: 5-column matrix across list, status, kill, send_input, and unknown/missing Action', () => {
  // list & status pass across all 5 columns (unless targeting boosterDataRoots in stepOne)
  for (const action of ['list', 'status']) {
    for (const col of Object.values(COLS)) {
      assert.equal(run('manage_task', { Action: action }, col).decision, 'pass', `${action}`);
    }
    assert.equal(run('manage_task', { Action: action, TaskId: join(boosterDataRoots(home)[0], 'x') }, COLS.col5).decision, 'deny');
  }

  // kill: denies in Col 1 & Col 2 and on corrupt store; passes in Cols 3, 4, 5
  assert.equal(run('manage_task', { Action: 'kill', TaskId: 't1' }, COLS.col1).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'kill', TaskId: 't1' }, COLS.col2).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'kill', TaskId: 't1' }, COLS.col3).decision, 'pass');
  assert.equal(run('manage_task', { Action: 'kill', TaskId: 't1' }, COLS.col4).decision, 'pass');
  assert.equal(run('manage_task', { Action: 'kill', TaskId: 't1' }, COLS.col5).decision, 'pass');
  assert.equal(run('manage_task', { Action: 'kill', TaskId: 't1' }, { env: {}, ws: corrupt }).decision, 'deny');

  // send_input: denies in Cols 1, 2, 3 & corrupt store; inspects Input & non-Input paths in Cols 4 & 5
  for (const col of [COLS.col1, COLS.col2, COLS.col3, { env: {}, ws: corrupt }]) {
    assert.equal(run('manage_task', { Action: 'send_input', TaskId: 't1', Input: 'git status' }, col).decision, 'deny');
  }
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: 't1', Input: 'git status' }, COLS.col4).decision, 'pass');
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: 't1', Input: 'adlc ticket complete T1 --write --authorize' }, COLS.col4).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: 't1', Input: 'rm .adlc/config.json' }, COLS.col4).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: join(boosterDataRoots(home)[1], 'x'), Input: 'git status' }, COLS.col5).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: join(protectedRoots(home)[0], 'x'), Input: 'git status' }, COLS.col5).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: 't1', Input: 123 }, COLS.col5).decision, 'deny');
  assert.equal(run('manage_task', { Action: 'send_input', TaskId: 't1' }, COLS.col5).decision, 'deny');

  // Missing or unknown Action denies across all 5 columns
  for (const bad of [{}, { Action: 'pause' }, { Action: '' }, { Action: 123 }]) {
    for (const col of Object.values(COLS)) {
      assert.equal(run('manage_task', bad, col).decision, 'deny');
    }
  }
});

test('subagents & send_message: 5-column matrix, prose-key exemptions vs path scanning, and 60-tool init.tools headless audit', () => {
  for (const name of ['invoke_subagent', 'define_subagent', 'manage_subagents']) {
    // Cols 1 & 2 deny
    assert.equal(run(name, {}, COLS.col1).decision, 'deny', `${name} col1`);
    assert.equal(run(name, {}, COLS.col2).decision, 'deny', `${name} col2`);
    assert.equal(run(name, {}, { env: {}, ws: corrupt }).decision, 'deny', `${name} corrupt`);

    // Cols 3, 4, 5 pass with prose mentioning rails and protected paths!
    const proseArgs = {
      Prompt: `Inspect ${join(active, 'lib/lock.mjs')} and ${protectedRoots(home)[0]}/cfg`,
      SystemPrompt: `Never touch ${boosterDataRoots(home)[0]}/hooks.log`,
      Description: 'lib/lock.mjs reviewer',
      Role: 'lib/lock.mjs auditor',
      toolSummary: 'lib/lock.mjs check',
    };
    assert.equal(run(name, proseArgs, COLS.col3).decision, 'pass', `${name} col3 prose`);
    assert.equal(run(name, proseArgs, COLS.col4).decision, 'pass', `${name} col4 prose`);
    assert.equal(run(name, proseArgs, COLS.col5).decision, 'pass', `${name} col5 prose`);

    // Non-prose path arguments are scanned against rails, implicit rails, symlinks, protectedRoots, and unanchored relative paths!
    assert.equal(run(name, { TargetPath: join(active, 'lib/lock.mjs') }, COLS.col3).decision, 'deny');
    assert.equal(run(name, { TargetPath: join(active, 'lib/safe-link.mjs') }, COLS.col3).decision, 'pass');
    assert.equal(run(name, { TargetPath: active }, COLS.col3).decision, 'pass');
    assert.equal(run(name, { TargetPath: join(plain, 'inactive-root-link') }, COLS.col4).decision, 'pass');
    assert.equal(run(name, { TargetPath: join(inactive, '.adlc/sessions.json') }, COLS.col4).decision, 'deny');
    assert.equal(run(name, { TargetPath: join(protectedRoots(home)[0], 'x') }, COLS.col5).decision, 'deny');
    assert.equal(run(name, { TargetPath: join(boosterDataRoots(home)[0], 'x') }, COLS.col5).decision, 'deny');
    assert.equal(run(name, { TargetPath: 'rel/sub' }, { env: {}, ws: null }).decision, 'deny');
  }

  // send_message skips Message/toolsummary prose in stepOne while schedule does NOT skip Message!
  assert.equal(run('send_message', {
    Recipient: 'conv-1',
    Message: `See ${protectedRoots(home)[0]}/x and ${boosterDataRoots(home)[0]}/y`,
    toolsummary: join(boosterDataRoots(home)[0], 'y'),
  }, COLS.col3).decision, 'pass');
  assert.equal(run('send_message', { Recipient: join(boosterDataRoots(home)[0], 'y'), Message: 'hi' }, COLS.col3).decision, 'deny');
  assert.equal(run('schedule', { Prompt: 'ok', Message: join(boosterDataRoots(home)[0], 'y') }, COLS.col3).decision, 'deny');

  // Verify all 60 tools in test/fixtures/agy-1.5.9-init-tools.json never return 'ask' in Col 1 or Col 2
  const initFixture = JSON.parse(readFileSync(INIT_TOOLS_FIXTURE, 'utf8'));
  assert.equal(initFixture.tools.length, 60);
  for (const toolName of initFixture.tools) {
    const v1 = run(toolName, {}, COLS.col1);
    const v2 = run(toolName, {}, COLS.col2);
    assert.ok(v1.decision === 'pass' || v1.decision === 'deny', `${toolName} col1`);
    assert.ok(v2.decision === 'pass' || v2.decision === 'deny', `${toolName} col2`);
  }
});
