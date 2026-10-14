import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
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

  // Test 3: { event: 'step_update', step_update: { conversation_id: 'conv-step-789' } }
  const mock3 = makeMockScript([
    `echo '{"event":"step_update","step_update":{"conversation_id":"conv-step-789"}}'`,
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
  } finally {
    mock3.cleanup();
  }
});
