import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgy } from '../lib/agy.mjs';

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
    mkdirSync(join(realGemini, 'config', 'plugins'), { recursive: true });
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
      assert.equal(lstatSync(join(stagedGemini, 'config', 'plugins')).isSymbolicLink(), true, 'config/plugins should be symlinked on POSIX');
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
