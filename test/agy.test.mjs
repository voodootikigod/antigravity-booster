import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runAgy,
  stageBuilderGeminiHome,
  resolveUserHome,
  isAllowedEnvVar,
  buildSpawnEnv,
  WIN32_ENV_ALLOWLIST,
} from '../lib/agy.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

function withTempState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy-test-'));
  const savedState = process.env.FAKE_STATE_DIR;
  const savedConv = process.env.FAKE_CONVERSATION_ID;
  process.env.FAKE_STATE_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (savedState === undefined) delete process.env.FAKE_STATE_DIR;
      else process.env.FAKE_STATE_DIR = savedState;
      if (savedConv === undefined) delete process.env.FAKE_CONVERSATION_ID;
      else process.env.FAKE_CONVERSATION_ID = savedConv;
      rmSync(dir, { recursive: true, force: true });
    });
}

function makeMockScript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agb-mock-agy-'));
  const scriptPath = join(dir, 'mock-agy.sh');
  const content = '#!/usr/bin/env bash\n' + lines.join('\n') + '\n';
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return {
    bin: scriptPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('runAgy: passes --conversation <id> when conversation option is provided', async () => {
  await withTempState(async (stateDir) => {
    const res = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe',
      conversation: 'my-custom-conv-42',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res.ok, res.error);
    const seenArgv = readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8');
    assert.match(seenArgv, /--conversation my-custom-conv-42/);
  });
});

test('runAgy: omits --conversation when conversation option is absent or empty', async () => {
  await withTempState(async (stateDir) => {
    const res1 = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe 1',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res1.ok, res1.error);

    const res2 = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe 2',
      conversation: '',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res2.ok, res2.error);

    const res3 = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe 3',
      conversation: '   ',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res3.ok, res3.error);

    const seenArgv = readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8');
    assert.doesNotMatch(seenArgv, /--conversation/);
  });
});

test('runAgy: extracts result.conversationId from outputFormat json', async () => {
  await withTempState(async () => {
    // Default fake-agy conversation_id
    const res1 = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res1.ok, res1.error);
    assert.equal(res1.conversationId, 'fake-conv-123');

    // Overridden conversation_id
    process.env.FAKE_CONVERSATION_ID = 'override-uuid-987';
    const res2 = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res2.ok, res2.error);
    assert.equal(res2.conversationId, 'override-uuid-987');

    // Missing conversation_id
    process.env.FAKE_CONVERSATION_ID = 'none';
    const res3 = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe',
      outputFormat: 'json',
      sandbox: false,
    });
    assert.ok(res3.ok, res3.error);
    assert.equal(res3.conversationId, null);
  });
});

test('runAgy: extracts result.conversationId from stream-json events', async () => {
  await withTempState(async () => {
    const res = await runAgy({
      bin: FAKE_AGY,
      model: 'gemini-3-pro',
      prompt: 'hello probe',
      outputFormat: 'stream-json',
      sandbox: false,
    });
    assert.ok(res.ok, res.error);
    assert.equal(res.conversationId, 'fake-conv-123');
  });
});

test('runAgy: supports real agy 1.3.5 stream-json event envelopes and extracts conversationId', async () => {
  // Test 1: { event: 'init', conversation_id: 'conv-init-123' } + { event: 'result', result: { status: 'SUCCESS' } }
  const mock1 = makeMockScript([
    `echo '{"event":"init","conversation_id":"conv-init-123"}'`,
    `echo '{"event":"step_update","step":1,"action":"testing"}'`,
    `echo '{"event":"result","result":{"status":"SUCCESS","exit_code":0}}'`,
  ]);
  try {
    const res = await runAgy({
      bin: mock1.bin,
      model: 'gemini-3-pro',
      prompt: 'run stream test',
      outputFormat: 'stream-json',
      sandbox: false,
    });
    assert.ok(res.ok, res.error);
    assert.equal(res.conversationId, 'conv-init-123');
    assert.equal(res.terminalResult?.status, 'SUCCESS');
    assert.equal(res.terminalResult?.type, 'result');
    assert.equal(res.terminalResult?.exit_code, 0);
    assert.equal(res.events.length, 3);
  } finally {
    mock1.cleanup();
  }

  // Test 2: { event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-result-456' } }
  const mock2 = makeMockScript([
    `echo '{"event":"step_update","step":1}'`,
    `echo '{"event":"result","result":{"status":"SUCCESS","conversation_id":"conv-result-456"}}'`,
  ]);
  try {
    const res = await runAgy({
      bin: mock2.bin,
      model: 'gemini-3-pro',
      prompt: 'run stream test 2',
      outputFormat: 'stream-json',
      sandbox: false,
    });
    assert.ok(res.ok, res.error);
    assert.equal(res.conversationId, 'conv-result-456');
    assert.equal(res.terminalResult?.status, 'SUCCESS');
    assert.equal(res.terminalResult?.exit_code, 0);
  } finally {
    mock2.cleanup();
  }

  // Test 3: { event: 'step_update', step_update: { conversation_id: 'conv-step-789', action: 'blocked', step: 2 } }
  const mock3 = makeMockScript([
    `echo '{"event":"step_update","step_update":{"conversation_id":"conv-step-789","action":"blocked","step":2}}'`,
    `echo '{"event":"result","result":{"status":"SUCCESS","exit_code":0}}'`,
  ]);
  try {
    const res = await runAgy({
      bin: mock3.bin,
      model: 'gemini-3-pro',
      prompt: 'run stream test 3',
      outputFormat: 'stream-json',
      sandbox: false,
    });
    assert.ok(res.ok, res.error);
    assert.equal(res.conversationId, 'conv-step-789');
    assert.equal(res.events[0].type, 'step_update');
    assert.equal(res.events[0].action, 'blocked');
    assert.equal(res.events[0].step, 2);
  } finally {
    mock3.cleanup();
  }
});

test('runAgy: builder mode stages writable .agb_home/.gemini/antigravity-cli/plugin_data/antigravity-booster/logs and links read-only auth entries', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-fake-home-'));
  const fakeWorktree = mkdtempSync(join(tmpdir(), 'agb-fake-wt-'));
  const savedHomeDir = process.env.AGB_HOME_DIR;
  process.env.AGB_HOME_DIR = fakeHome;
  try {
    const realGemini = join(fakeHome, '.gemini');
    mkdirSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'bin'), { recursive: true });
    mkdirSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'dist', 'hooks'), { recursive: true });
    mkdirSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'skills'), { recursive: true });
    writeFileSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'plugin.json'), '{"name":"antigravity-booster"}');
    writeFileSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'hooks.json'), '{}');
    writeFileSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'mcp_config.json'), '{"mcpServers":{"agb":{}}}');
    writeFileSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'dist', 'mcp-server.mjs'), '// excluded');
    mkdirSync(join(realGemini, 'antigravity-cli', 'plugin_data'), { recursive: true });
    mkdirSync(join(realGemini, 'antigravity-cli', 'builtin'), { recursive: true });
    writeFileSync(join(realGemini, 'oauth_creds.json'), '{"token":"secret"}');
    writeFileSync(join(realGemini, 'antigravity-cli', 'antigravity-oauth-token'), 'oauth-token-123');

    const mock = makeMockScript([
      `echo '{"event":"result","result":{"status":"SUCCESS","exit_code":0}}'`,
    ]);
    try {
      const res = await runAgy({
        bin: mock.bin,
        model: 'gemini-3-pro',
        prompt: 'builder test',
        cwd: fakeWorktree,
        role: 'builder',
        sandbox: true,
        outputFormat: 'stream-json',
        worker: { ticket: 't-1' },
      });
      assert.ok(res.ok, res.error);

      const stagedGemini = join(fakeWorktree, '.agb_home', '.gemini');
      assert.equal(lstatSync(stagedGemini).isSymbolicLink(), false, '.agb_home/.gemini must be a real writable directory, not a symlink');
      const logsDir = join(stagedGemini, 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs');
      assert.equal(existsSync(logsDir), true, 'plugin_data logs directory must exist inside .agb_home/.gemini');
      writeFileSync(join(logsDir, 'hooks.log'), 'probe\n');
      assert.equal(readFileSync(join(logsDir, 'hooks.log'), 'utf8'), 'probe\n');
      assert.equal(lstatSync(join(stagedGemini, 'oauth_creds.json')).isSymbolicLink(), true, 'oauth_creds.json should be symlinked on POSIX');
      assert.equal(lstatSync(join(stagedGemini, 'config')).isSymbolicLink(), false, 'config dir must be a real directory so config/projects is writable');
      assert.equal(lstatSync(join(stagedGemini, 'config', 'plugins')).isSymbolicLink(), false, 'config/plugins must be a real directory with hooks-only antigravity-booster');
      const stagedBooster = join(stagedGemini, 'config', 'plugins', 'antigravity-booster');
      assert.equal(lstatSync(stagedBooster).isSymbolicLink(), false, 'antigravity-booster plugin projection must be a real directory');
      assert.equal(existsSync(join(stagedBooster, 'plugin.json')), true);
      assert.equal(existsSync(join(stagedBooster, 'hooks.json')), true);
      assert.equal(lstatSync(join(stagedBooster, 'bin')).isSymbolicLink(), true, 'antigravity-booster/bin should be symlinked on POSIX');
      assert.equal(lstatSync(join(stagedBooster, 'dist')).isSymbolicLink(), false, 'antigravity-booster/dist must be a real directory');
      assert.equal(lstatSync(join(stagedBooster, 'dist', 'hooks')).isSymbolicLink(), true, 'antigravity-booster/dist/hooks should be symlinked on POSIX');
      assert.equal(existsSync(join(stagedBooster, 'mcp_config.json')), false, 'antigravity-booster/mcp_config.json must be excluded');
      assert.equal(existsSync(join(stagedBooster, 'dist', 'mcp-server.mjs')), false, 'antigravity-booster/dist/mcp-server.mjs must be excluded');
      assert.equal(existsSync(join(stagedBooster, 'skills')), false, 'antigravity-booster/skills must be excluded');
      assert.equal(lstatSync(join(stagedGemini, 'config', 'projects')).isSymbolicLink(), false, 'config/projects must be a real writable directory');
      assert.equal(lstatSync(join(stagedGemini, 'antigravity-cli', 'antigravity-oauth-token')).isSymbolicLink(), true, 'antigravity-oauth-token should be symlinked inside antigravity-cli');
      assert.equal(lstatSync(join(stagedGemini, 'antigravity-cli', 'brain')).isSymbolicLink(), false, 'antigravity-cli/brain must be a real writable directory');
    } finally {
      mock.cleanup();
    }
  } finally {
    if (savedHomeDir === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeDir;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeWorktree, { recursive: true, force: true });
  }
});

test('stageBuilderGeminiHome: on win32 copies directory entries (e.g. config/plugins, antigravity-cli/builtin) without symlinks/junctions', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-win32-home-'));
  const fakeWorktree = mkdtempSync(join(tmpdir(), 'agb-win32-wt-'));
  try {
    const realGemini = join(fakeHome, '.gemini');
    mkdirSync(join(realGemini, 'config', 'plugins', 'antigravity-booster'), { recursive: true });
    mkdirSync(join(realGemini, 'antigravity-cli', 'builtin', 'skills'), { recursive: true });
    writeFileSync(join(realGemini, 'oauth_creds.json'), '{"token":"win32-secret"}');
    writeFileSync(join(realGemini, 'config', 'plugins', 'antigravity-booster', 'plugin.json'), '{"name":"antigravity-booster"}');
    writeFileSync(join(realGemini, 'antigravity-cli', 'builtin', 'skills', 'SKILL.md'), '# skill');

    const agbHome = stageBuilderGeminiHome(fakeWorktree, fakeHome, 'win32');
    const stagedGemini = join(agbHome, '.gemini');
    assert.equal(lstatSync(stagedGemini).isSymbolicLink(), false);
    assert.equal(lstatSync(join(stagedGemini, 'oauth_creds.json')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(stagedGemini, 'oauth_creds.json'), 'utf8'), '{"token":"win32-secret"}');
    assert.equal(lstatSync(join(stagedGemini, 'config', 'plugins')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(stagedGemini, 'config', 'plugins', 'antigravity-booster', 'plugin.json'), 'utf8'), '{"name":"antigravity-booster"}');
    assert.equal(lstatSync(join(stagedGemini, 'antigravity-cli', 'builtin')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(stagedGemini, 'antigravity-cli', 'builtin', 'skills', 'SKILL.md'), 'utf8'), '# skill');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeWorktree, { recursive: true, force: true });
  }
});

test('runAgy sandbox profiles: masks symlinked credentials on Linux bwrap, denies .adlc writes on macOS Seatbelt, and defaults agyBin to resolveAgyBinary(userHome)', async () => {
  const src = readFileSync(new URL('../lib/agy.mjs', import.meta.url), 'utf8');
  assert.match(src, /resolveAgyBinary\(userHome\)/);
  assert.match(src, /const st = lst\.isSymbolicLink\(\) \? statSync\(sFile\) : lst;/);
  assert.match(src, /realpathSync\(sFile\)/);
  assert.match(src, /\(deny file-write\* \(subpath "\$\{escapedAllowedDir\}\/\.adlc"\)\)/);
  assert.match(src, /\(deny file-write\* \(subpath "\$\{escapedRealAllowedDir\}\/\.adlc"\)\)/);
  assert.match(src, /\(allow file-write\* \(subpath "\$\{escapedAllowedDir\}\/\.adlc\/leases"\)\)/);
  assert.match(src, /\(allow file-write\* \(subpath "\$\{escapedRealAllowedDir\}\/\.adlc\/leases"\)\)/);

  // Behavioral test: calling runAgy with both `bin` and `AGB_AGY_BIN` omitted must resolve via userHome without TDZ ReferenceError
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-tdz-home-'));
  const savedHome = process.env.AGB_HOME_DIR;
  const savedAgyBin = process.env.AGB_AGY_BIN;
  process.env.AGB_HOME_DIR = fakeHome;
  delete process.env.AGB_AGY_BIN;
  try {
    const agyDir = join(fakeHome, '.local', 'bin');
    mkdirSync(agyDir, { recursive: true });
    const agyScript = join(agyDir, 'agy');
    writeFileSync(agyScript, '#!/bin/sh\necho "tdz-ok"\n', { mode: 0o755 });
    const res = await runAgy({
      model: 'gemini-3-pro',
      prompt: 'tdz check',
      sandbox: false,
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.output, /tdz-ok/);
  } finally {
    if (savedHome === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHome;
    if (savedAgyBin === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = savedAgyBin;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('runAgy: pipes oversized prompts (> MAX_ARGV_PROMPT_BYTES) via --input-format text on stdin without E2BIG', async () => {
  const mock = makeMockScript([
    'bytes=$(wc -c)',
    'printf "ARGS:%s|BYTES:%s\\n" "$*" "$bytes"',
  ]);
  try {
    const shortRes = await runAgy({
      bin: mock.bin,
      model: 'gemini-4-argon-high',
      prompt: 'short-check',
      sandbox: false,
    });
    assert.equal(shortRes.ok, true, shortRes.error);
    assert.match(shortRes.output, /ARGS:--print short-check --print-timeout \S+ --model gemini-4-argon-high/);

    const bigPrompt = 'DIFF-HEADER\n' + 'x'.repeat(140_000);
    const res = await runAgy({
      bin: mock.bin,
      model: 'gemini-4-argon-high',
      prompt: bigPrompt,
      sandbox: false,
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.output, /ARGS:--input-format text --print-timeout \S+ --model gemini-4-argon-high/);
    assert.doesNotMatch(res.output, /--print DIFF-HEADER/);
    assert.match(res.output, new RegExp(`BYTES:\\s*${Buffer.byteLength(bigPrompt, 'utf8')}`));

    // Also verify end-to-end against test/fixtures/fake-agy (which validates --input-format text|stream-json)
    const fakeAgyPath = new URL('./fixtures/fake-agy', import.meta.url).pathname;
    const fakeRes = await runAgy({
      bin: fakeAgyPath,
      model: 'gemini-4-argon-high',
      prompt: `${bigPrompt}\nPONG-BIGSTDIN99`,
      sandbox: false,
    });
    assert.equal(fakeRes.ok, true, fakeRes.error);
    assert.match(fakeRes.output, /PONG-BIGSTDIN99/);
  } finally {
    mock.cleanup();
  }
});

test('runAgy: synchronous spawn() failure resolves { ok: false, kind: "spawn" } instead of rejecting', async () => {
  // Null byte in binary path triggers a synchronous TypeError/ERR_INVALID_ARG_VALUE inside child_process.spawn
  const res = await runAgy({
    bin: '/invalid/\0/agy',
    model: 'gemini-4-argon-high',
    prompt: 'short prompt',
    sandbox: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'spawn');
  assert.match(res.error, /^spawn:/);
});

test('runAgy builder: omits nested --sandbox inside outer bwrap_pid containment so agy 1.5.9 run_command does not hit nested userns EPERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bwrap-nosandbox-'));
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'agb-bwrap-bin-'));
  const argvLog = join(dir, 'bwrap-argv.json');
  const prevMech = process.env.AGB_MOCK_CONTAINMENT_MECHANISM;
  const prevPath = process.env.PATH;
  try {
    const fakeAgy = join(fakeBinDir, 'agy');
    writeFileSync(fakeAgy, '#!/bin/sh\nprintf \'{"event":"result","result":{"status":"SUCCESS","exit_code":0,"response":"ok"}}\\n\'\n', { mode: 0o755 });
    const fakeBwrap = join(fakeBinDir, 'bwrap');
    writeFileSync(
      fakeBwrap,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('{"event":"result","result":{"status":"SUCCESS","exit_code":0,"response":"ok"}}');\n`,
      { mode: 0o755 },
    );
    process.env.AGB_MOCK_CONTAINMENT_MECHANISM = 'bwrap_pid';
    process.env.PATH = `${fakeBinDir}:${prevPath || ''}`;
    const res = await runAgy({
      bin: fakeAgy,
      model: 'gemini-4-argon-high',
      prompt: 'build check',
      cwd: dir,
      repo: dir,
      role: 'builder',
      sandbox: true,
      outputFormat: 'stream-json',
    });
    assert.equal(res.ok, true, res.error);
    const bwrapArgs = JSON.parse(readFileSync(argvLog, 'utf8'));
    const sepIdx = bwrapArgs.indexOf('--');
    assert.ok(sepIdx !== -1, 'bwrap argv must include -- separator');
    const innerArgv = bwrapArgs.slice(sepIdx + 1);
    assert.equal(innerArgv.includes('--sandbox'), false, `inner agy argv inside bwrap must omit --sandbox, got: ${JSON.stringify(innerArgv)}`);
  } finally {
    if (prevMech === undefined) delete process.env.AGB_MOCK_CONTAINMENT_MECHANISM;
    else process.env.AGB_MOCK_CONTAINMENT_MECHANISM = prevMech;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test('resolveUserHome and runAgy ignore AGB_HOME_DIR when __AGB_BUNDLED__ is true', async () => {
  const spoofHome = mkdtempSync(join(tmpdir(), 'agb-bundled-spoof-home-'));
  const fakeWorktree = mkdtempSync(join(tmpdir(), 'agb-bundled-wt-'));
  const hadBundled = Object.prototype.hasOwnProperty.call(globalThis, '__AGB_BUNDLED__');
  const savedBundled = globalThis.__AGB_BUNDLED__;
  const savedHomeDir = process.env.AGB_HOME_DIR;
  try {
    mkdirSync(join(spoofHome, '.gemini'), { recursive: true });
    writeFileSync(join(spoofHome, '.gemini', 'spoof-only-marker.txt'), 'spoof');

    // Unbundled honors AGB_HOME_DIR
    assert.equal(resolveUserHome({ env: { AGB_HOME_DIR: spoofHome }, bundled: false }), spoofHome);
    // Explicit bundled: true ignores AGB_HOME_DIR
    assert.equal(resolveUserHome({ env: { AGB_HOME_DIR: spoofHome }, bundled: true }), homedir());

    // Global __AGB_BUNDLED__ = true ignores AGB_HOME_DIR in resolveUserHome and runAgy
    globalThis.__AGB_BUNDLED__ = true;
    process.env.AGB_HOME_DIR = spoofHome;
    assert.equal(resolveUserHome({ env: process.env }), homedir());

    const mock = makeMockScript([
      `echo '{"event":"result","result":{"status":"SUCCESS","exit_code":0}}'`,
    ]);
    try {
      const res = await runAgy({
        bin: mock.bin,
        model: 'gemini-3-pro',
        prompt: 'bundled home test',
        cwd: fakeWorktree,
        role: 'builder',
        sandbox: true,
        outputFormat: 'stream-json',
        worker: { ticket: 't-bundled' },
      });
      assert.ok(res.ok, res.error);
      assert.equal(
        existsSync(join(fakeWorktree, '.agb_home', '.gemini', 'spoof-only-marker.txt')),
        false,
        'bundled runAgy must ignore AGB_HOME_DIR and never stage entries from spoofHome',
      );
    } finally {
      mock.cleanup();
    }
  } finally {
    if (hadBundled) globalThis.__AGB_BUNDLED__ = savedBundled;
    else delete globalThis.__AGB_BUNDLED__;
    if (savedHomeDir === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeDir;
    rmSync(spoofHome, { recursive: true, force: true });
    rmSync(fakeWorktree, { recursive: true, force: true });
  }
});

test('isAllowedEnvVar: win32 preserves case-insensitive Path and essential Windows system vars while blocking secrets/USERPROFILE', () => {
  const prodEnv = { NODE_ENV: 'production' };
  // Essential Windows vars allowed case-insensitively on win32
  for (const k of ['Path', 'PATH', 'path', 'PATHEXT', 'PathExt', 'COMSPEC', 'ComSpec', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'APPDATA', 'AppData', 'LOCALAPPDATA', 'LocalAppData', 'TEMP', 'Temp', 'TMP', 'Tmp']) {
    assert.equal(isAllowedEnvVar(k, prodEnv, 'win32'), true, `expected ${k} allowed on win32`);
  }
  assert.deepEqual(
    WIN32_ENV_ALLOWLIST,
    ['PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'],
  );

  // USERPROFILE and secrets / dangerous runtime vars rejected on win32 regardless of case
  for (const blocked of ['USERPROFILE', 'UserProfile', 'userprofile', 'GITHUB_TOKEN', 'github_token', 'NODE_OPTIONS', 'node_options', 'Ld_Preload']) {
    assert.equal(isAllowedEnvVar(blocked, prodEnv, 'win32'), false, `expected ${blocked} rejected on win32`);
  }

  // POSIX remains case-sensitive and does not allow Windows-only vars
  assert.equal(isAllowedEnvVar('PATH', prodEnv, 'linux'), true);
  assert.equal(isAllowedEnvVar('Path', prodEnv, 'linux'), false);
  assert.equal(isAllowedEnvVar('COMSPEC', prodEnv, 'linux'), false);
});

test('buildSpawnEnv: win32 builder normalizes Path/PATH without collision, preserves essential Windows vars, and pins USERPROFILE to agbHome', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-win-env-home-'));
  const fakeWt = mkdtempSync(join(tmpdir(), 'agb-win-env-wt-'));
  try {
    const realWt = realpathSync(fakeWt);
    const expectedAgbHome = join(realWt, '.agb_home');
    const realNodeDir = dirname(realpathSync(process.execPath));

    const winProcessEnv = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
      PATH: 'C:\\Extra\\Bin;C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      APPDATA: 'C:\\Users\\Host\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Host\\AppData\\Local',
      TEMP: 'C:\\Users\\Host\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\Host\\AppData\\Local\\Temp',
      USERPROFILE: 'C:\\Users\\Host',
      UserProfile: 'C:\\Users\\HostMixed',
      HOME: 'C:\\Users\\Host',
      GITHUB_TOKEN: 'ghp_secret',
      NODE_OPTIONS: '--require evil.js',
      GIT_DIR: 'C:\\evil\\.git',
      INIT_CWD: 'C:\\outer',
    };

    const spawnEnv = buildSpawnEnv({
      processEnv: winProcessEnv,
      env: { userprofile: 'C:\\Users\\Smuggled', AGB_CUSTOM: 'ok' },
      cwd: fakeWt,
      repo: fakeWt,
      isBuilder: true,
      sanitizeEnv: true,
      worker: { ticket: 'T-WIN-1' },
      userHome: fakeHome,
      platform: 'win32',
    });

    // No Path/PATH key collision; canonical PATH retains both Path entries + realNodeDir separated by ';'
    const pathKeys = Object.keys(spawnEnv).filter((k) => k.toLowerCase() === 'path');
    assert.deepEqual(pathKeys, ['PATH'], `expected single canonical PATH key, got ${JSON.stringify(pathKeys)}`);
    assert.ok(spawnEnv.PATH.includes('C:\\Windows\\System32'));
    assert.ok(spawnEnv.PATH.includes('C:\\Program Files\\Git\\cmd'));
    assert.ok(spawnEnv.PATH.includes('C:\\Extra\\Bin'));
    assert.ok(spawnEnv.PATH.split(';').includes(realNodeDir), `expected PATH to include node dir ${realNodeDir}: ${spawnEnv.PATH}`);

    // Essential Windows system variables survive sanitization
    assert.equal(spawnEnv.PATHEXT, '.COM;.EXE;.BAT;.CMD');
    assert.equal(spawnEnv.ComSpec, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(spawnEnv.SystemRoot, 'C:\\Windows');
    assert.equal(spawnEnv.windir, 'C:\\Windows');
    assert.equal(spawnEnv.APPDATA, 'C:\\Users\\Host\\AppData\\Roaming');
    assert.equal(spawnEnv.LOCALAPPDATA, 'C:\\Users\\Host\\AppData\\Local');
    assert.equal(spawnEnv.TEMP, 'C:\\Users\\Host\\AppData\\Local\\Temp');
    assert.equal(spawnEnv.TMP, 'C:\\Users\\Host\\AppData\\Local\\Temp');

    // USERPROFILE is pinned to agbHome with all case-variants stripped
    const userProfileKeys = Object.keys(spawnEnv).filter((k) => k.toLowerCase() === 'userprofile');
    assert.deepEqual(userProfileKeys, ['USERPROFILE'], `expected single USERPROFILE key, got ${JSON.stringify(userProfileKeys)}`);
    assert.equal(spawnEnv.USERPROFILE, expectedAgbHome);
    assert.equal(spawnEnv.HOME, expectedAgbHome);
    assert.equal(spawnEnv.GIT_CONFIG_GLOBAL, 'NUL');

    // Secrets, dangerous vars, and smuggled git/init vars stripped
    assert.equal(spawnEnv.GITHUB_TOKEN, undefined);
    assert.equal(spawnEnv.NODE_OPTIONS, undefined);
    assert.equal(spawnEnv.GIT_DIR, undefined);
    assert.equal(spawnEnv.INIT_CWD, undefined);
    assert.equal(spawnEnv.AGB_CUSTOM, 'ok');

    // Per-call env Path override also normalizes cleanly without collision
    const overrideEnv = buildSpawnEnv({
      processEnv: { Path: 'C:\\Windows\\System32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      env: { Path: 'C:\\Override\\Bin', COMSPEC: 'C:\\Override\\cmd.exe' },
      cwd: fakeWt,
      repo: fakeWt,
      isBuilder: true,
      sanitizeEnv: true,
      worker: { ticket: 'T-WIN-2' },
      userHome: fakeHome,
      platform: 'win32',
    });
    assert.deepEqual(Object.keys(overrideEnv).filter((k) => k.toLowerCase() === 'path'), ['PATH']);
    assert.ok(overrideEnv.PATH.startsWith('C:\\Override\\Bin;'));
    assert.deepEqual(Object.keys(overrideEnv).filter((k) => k.toLowerCase() === 'comspec'), ['COMSPEC']);
    assert.equal(overrideEnv.COMSPEC, 'C:\\Override\\cmd.exe');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeWt, { recursive: true, force: true });
  }
});



