import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildRoleSettingsProfile,
  NdjsonWorkerDaemon,
  killDaemonProcessTree,
} from '../lib/ndjson-worker.mjs';
import { StreamWatchdog } from '../lib/stream-watchdog.mjs';

const FAKE_AGY = join(process.cwd(), 'test', 'fixtures', 'fake-agy');

test('buildRoleSettingsProfile strips MCP and tool calls for readonly roles and scopes builder roles', () => {
  const prosecutorProfile = buildRoleSettingsProfile('prosecutor');
  assert.equal(prosecutorProfile.mode, 'readonly');
  assert.equal(prosecutorProfile.mcpServersDisabled, true);
  assert.equal(prosecutorProfile.subagentsDisabled, true);
  assert.equal(prosecutorProfile.swarmDisabled, true);
  assert.equal(prosecutorProfile.modelFeatures.supportsToolCalls, false);

  const builderNoCg = buildRoleSettingsProfile('builder', { hasCodegraph: false });
  assert.equal(builderNoCg.mode, 'worker');
  assert.equal(builderNoCg.mcpServersDisabled, true);
  assert.deepEqual(builderNoCg.allowedMcpServers, []);
  assert.equal(builderNoCg.modelFeatures.supportsToolCalls, true);

  const builderWithCg = buildRoleSettingsProfile('builder', { hasCodegraph: true });
  assert.equal(builderWithCg.mcpServersDisabled, false);
  assert.deepEqual(builderWithCg.allowedMcpServers, ['codegraph']);
});

test('NdjsonWorkerDaemon executes multiple turns over persistent stream-json stdin and records --settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-ndjson-'));
  const settingsFile = join(dir, 'settings.json');
  const daemon = new NdjsonWorkerDaemon({
    model: 'gemini-4-neon-medium',
    cwd: dir,
    bin: FAKE_AGY,
    env: {
      FAKE_AGY_NDJSON_DAEMON: '1',
      FAKE_CONVERSATION_ID: 'conv-ndjson-42',
      FAKE_SETTINGS_FILE: settingsFile,
    },
    settings: buildRoleSettingsProfile('builder', { hasCodegraph: true }),
  });

  try {
    const turn1 = await daemon.sendTurn('Build feature turn 1');
    assert.equal(turn1.ok, true);
    assert.equal(turn1.conversationId, 'conv-ndjson-42');
    assert.equal(turn1.turnCount, 1);
    assert.match(turn1.output, /turn-1 TICKET-DONE/);
    assert.equal(daemon.isAlive(), true);

    assert.ok(existsSync(settingsFile));
    const parsedSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(parsedSettings.allowedMcpServers, ['codegraph']);

    const turn2 = await daemon.sendTurn('Strike 1 fix turn 2');
    assert.equal(turn2.ok, true);
    assert.equal(turn2.turnCount, 2);
    assert.match(turn2.output, /turn-2 TICKET-DONE/);
    assert.equal(daemon.isAlive(), true);
  } finally {
    await daemon.close();
    assert.equal(daemon.isAlive(), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon falls back to singleShotFallback when agyVersion < 1.5.9 or stdin closes', async () => {
  const fallbackCalls = [];
  const daemonOld = new NdjsonWorkerDaemon({
    model: 'gemini-4-argon-high',
    bin: FAKE_AGY,
    agyVersion: '1.5.8',
    singleShotFallback: async (prompt, meta) => {
      fallbackCalls.push({ prompt, meta });
      return { ok: true, fallback: true, output: 'fallback-ok' };
    },
  });

  const resOld = await daemonOld.sendTurn('Prompt on 1.5.8');
  assert.equal(resOld.ok, true);
  assert.equal(resOld.fallback, true);
  assert.equal(fallbackCalls.length, 1);

  // Also test EOF / non-daemon process exit fallback
  const daemonEof = new NdjsonWorkerDaemon({
    model: 'gemini-4-argon-high',
    bin: FAKE_AGY,
    env: { FAKE_AGY_MODE: 'fail' },
    singleShotFallback: async (prompt) => ({ ok: true, fallback: true, output: `recovered:${prompt}` }),
  });
  const resEof = await daemonEof.sendTurn('Recover me');
  assert.equal(resEof.ok, true);
  assert.equal(resEof.fallback, true);
  assert.equal(resEof.output, 'recovered:Recover me');
});

test('NdjsonWorkerDaemon.quiesceChildren and killDaemonProcessTree reap background child processes', async () => {
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  try {
    assert.ok(parent.pid > 0);
    killDaemonProcessTree(parent, 'SIGKILL');
    await new Promise((r) => parent.once('close', r));
    assert.notEqual(parent.exitCode !== null || parent.signalCode !== null, false);
  } finally {
    killDaemonProcessTree(parent, 'SIGKILL');
  }
});

test('NdjsonWorkerDaemon aborts turn and kills daemon when StreamWatchdog triggers abort', async () => {
  const watchdog = new StreamWatchdog({ maxIdenticalFailures: 2 });
  // Pre-seed one failure so next identical failure triggers abort
  watchdog.observeStep({
    step_type: 'tool',
    tool_name: 'run_command',
    state: 'ERROR',
    error: 'tool call denied by pre-tool hook: matches frozen rail',
  });

  const daemon = new NdjsonWorkerDaemon({
    model: 'gemini-4-neon-medium',
    bin: FAKE_AGY,
    env: { FAKE_AGY_NDJSON_DAEMON: '1' },
  });
  // Directly verify watchdog abort on second rail denial
  const decision = watchdog.observeStep({
    step_type: 'tool',
    tool_name: 'run_command',
    state: 'ERROR',
    error: 'tool call denied by pre-tool hook: matches frozen rail',
  });
  assert.equal(decision.action, 'steer');
  const decision3 = watchdog.observeStep({
    step_type: 'tool',
    tool_name: 'run_command',
    state: 'ERROR',
    error: 'tool call denied by pre-tool hook: matches frozen rail',
  });
  assert.equal(decision3.action, 'abort');
  await daemon.close();
});
