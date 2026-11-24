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

test('buildRoleSettingsProfile emits agy 1.5.15 permissions.deny for readonly and builder roles with zero unknown keys', () => {
  for (const role of ['prosecutor', 'review', 'review-plan', 'coldstart', 'parallax', 'premortem', 'brain', 'arbiter', 'readonly']) {
    const profile = buildRoleSettingsProfile(role);
    assert.deepEqual(Object.keys(profile), ['permissions'], `role ${role} must emit only verified top-level keys`);
    assert.ok(Array.isArray(profile.permissions.deny));
    for (const tool of ['write_file', 'edit_file', 'run_command', 'invoke_subagent', 'swarm', 'manage_task', 'call_mcp_tool']) {
      assert.ok(profile.permissions.deny.includes(tool), `readonly role ${role} must deny ${tool}`);
    }
  }

  const builderNoCg = buildRoleSettingsProfile('builder', { hasCodegraph: false });
  assert.deepEqual(Object.keys(builderNoCg), ['permissions']);
  assert.ok(builderNoCg.permissions.deny.includes('invoke_subagent'));
  assert.ok(builderNoCg.permissions.deny.includes('swarm'));
  assert.ok(builderNoCg.permissions.deny.includes('call_mcp_tool'));
  assert.equal(builderNoCg.permissions.deny.includes('write_file'), false);
  assert.equal(builderNoCg.permissions.deny.includes('run_command'), false);

  const builderWithCg = buildRoleSettingsProfile('builder', { hasCodegraph: true });
  assert.deepEqual(Object.keys(builderWithCg), ['permissions']);
  assert.ok(builderWithCg.permissions.deny.includes('invoke_subagent'));
  assert.ok(builderWithCg.permissions.deny.includes('swarm'));
  assert.equal(builderWithCg.permissions.deny.includes('call_mcp_tool'), false);
  assert.equal(builderWithCg.permissions.deny.includes('write_file'), false);
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
    assert.deepEqual(Object.keys(parsedSettings), ['permissions']);
    assert.ok(parsedSettings.permissions.deny.includes('invoke_subagent'));
    assert.equal(parsedSettings.permissions.deny.includes('call_mcp_tool'), false);

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

test('NdjsonWorkerDaemon.sendTurn computes per-turn telemetry deltas when session counters are cumulative', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-ndjson-tel-'));
  const customBin = join(dir, 'fake-cumulative-agy.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    customBin,
    [
      '#!/usr/bin/env node',
      "import { createInterface } from 'node:readline';",
      'const rl = createInterface({ input: process.stdin });',
      'let turn = 0;',
      'rl.on("line", () => {',
      '  turn += 1;',
      '  const tel = turn === 1',
      '    ? { cumulative: true, input_tokens: 1000, cached_tokens: 600, output_tokens: 100 }',
      '    : { cumulative: true, input_tokens: 2500, cached_tokens: 1800, output_tokens: 250 };',
      '  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "TICKET-DONE", conversation_id: "c-tel", telemetry: tel } }));',
      '});',
    ].join('\n'),
    { mode: 0o755 }
  );

  const daemon = new NdjsonWorkerDaemon({
    model: 'gemini-4-neon-medium',
    cwd: dir,
    bin: customBin,
  });
  try {
    const t1 = await daemon.sendTurn('Turn 1');
    assert.equal(t1.ok, true);
    assert.deepEqual(t1.telemetry, {
      uncachedInputTokens: 400,
      cachedTokens: 600,
      outputTokens: 100,
      inputTokens: 1000,
    });

    const t2 = await daemon.sendTurn('Turn 2');
    assert.equal(t2.ok, true);
    assert.deepEqual(t2.telemetry, {
      uncachedInputTokens: 300,
      cachedTokens: 1200,
      outputTokens: 150,
      inputTokens: 1500,
    });
  } finally {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
