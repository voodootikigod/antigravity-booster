import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildRoleSettingsProfile,
  NdjsonWorkerDaemon,
  killDaemonProcessTree,
  MAX_BYPASS_RESPAWNS,
} from '../lib/ndjson-worker.mjs';
import { runLiveV14HyperHarnessBenchmark } from '../evals/runner.mjs';
import { StreamWatchdog } from '../lib/stream-watchdog.mjs';

const FAKE_AGY = join(process.cwd(), 'test', 'fixtures', 'fake-agy');

const PURE = { containment: false, sandbox: false };

function writeDumpAgy(dir, name = 'dump-agy.mjs') {
  const dumpFile = join(dir, `${name}.dump.json`);
  const script = join(dir, name);
  writeFileSync(
    script,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
readline.createInterface({ input: process.stdin }).on('line', () => {
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }));
});
`,
    { mode: 0o755 }
  );
  return { script, read: () => JSON.parse(readFileSync(dumpFile, 'utf8')) };
}

function writeExitAgy(dir) {
  const script = join(dir, 'exit-agy.mjs');
  writeFileSync(script, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  return script;
}

function makeSpy(dir, bin, { gate = null, bypass = { valid: true } } = {}) {
  const calls = [];
  const cleanups = [];
  const prepareContainment = async (opts) => {
    calls.push(opts);
    if (gate) await gate;
    return {
      ok: true,
      launchBin: bin,
      launchArgs: opts.args,
      stagedBuilderHome: null,
      verifiedBypass: bypass,
      cleanup: () => cleanups.push(calls.length),
    };
  };
  return { calls, cleanups, prepareContainment };
}

async function killChild(daemon) {
  const exit = daemon._exitPromise;
  killDaemonProcessTree(daemon.child);
  await exit;
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agb-ndjson-'));
}

test('buildRoleSettingsProfile re-export emits action(target) permission rules', () => {
  const ro = buildRoleSettingsProfile('prosecutor');
  assert.equal(ro.allowNonWorkspaceAccess, false);
  for (const rule of ['write_file(*)', 'command(*)', 'mcp(*)']) {
    assert.ok(ro.permissions.deny.includes(rule));
  }
  const builderNoCg = buildRoleSettingsProfile('builder', { hasCodegraph: false });
  assert.ok(builderNoCg.permissions.deny.includes('mcp(*)'));
  const builderCg = buildRoleSettingsProfile('builder', { hasCodegraph: true });
  assert.equal(builderCg.permissions.deny.includes('mcp(*)'), false);
});

test('runLiveV14HyperHarnessBenchmark reports roleSettingsReadonly true', () => {
  assert.equal(runLiveV14HyperHarnessBenchmark().checks.roleSettingsReadonly, true);
});

test('NdjsonWorkerDaemon defaults: settings derived from role profile, useRoleSettings false omits --settings, string settings not double-encoded', async () => {
  assert.equal(MAX_BYPASS_RESPAWNS, 2);
  const dir = tmpDir();
  try {
    const a = writeDumpAgy(dir, 'a.mjs');
    const d1 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, ...PURE });
    assert.equal(d1.useRoleSettings, true);
    assert.equal(d1.hasCodegraph, false);
    assert.equal(d1.sanitizeEnv, false);
    assert.equal(d1.agyVersion, '1.5.17');
    assert.equal((await d1.sendTurn('hi')).ok, true);
    await d1.close();
    const argv1 = a.read().argv;
    const parsed = JSON.parse(argv1[argv1.indexOf('--settings') + 1]);
    assert.ok(parsed.permissions.deny.includes('mcp(*)'));
    assert.equal(parsed.permissions.deny.includes('mcp(agb/*)'), false);

    const b = writeDumpAgy(dir, 'b.mjs');
    const d2 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: b.script, useRoleSettings: false, ...PURE });
    assert.equal((await d2.sendTurn('hi')).ok, true);
    await d2.close();
    assert.equal(b.read().argv.includes('--settings'), false);

    const c = writeDumpAgy(dir, 'c.mjs');
    const d3 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: c.script, settings: '{"x":1}', ...PURE });
    assert.equal((await d3.sendTurn('hi')).ok, true);
    await d3.close();
    const argv3 = c.read().argv;
    assert.equal(argv3[argv3.indexOf('--settings') + 1], '{"x":1}');

    const e = writeDumpAgy(dir, 'e.mjs');
    const d4 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: e.script, hasCodegraph: true, ...PURE });
    assert.equal((await d4.sendTurn('hi')).ok, true);
    await d4.close();
    const argv4 = e.read().argv;
    const p4 = JSON.parse(argv4[argv4.indexOf('--settings') + 1]);
    assert.equal(p4.permissions.deny.includes('mcp(*)'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon sanitizeEnv defaults to false and strips unlisted env when true', async () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  process.env.UNLISTED_SECRET_TOKEN_FOR_TEST = 'leak';
  try {
    const a = writeDumpAgy(dir, 'plain.mjs');
    const d1 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, role: 'readonly', env: { AGB_HOME_DIR: home } });
    assert.equal(d1.sandbox, false);
    assert.equal(d1.containment, false);
    assert.equal((await d1.sendTurn('hi')).ok, true);
    await d1.close();
    assert.equal(a.read().env.UNLISTED_SECRET_TOKEN_FOR_TEST, 'leak');

    const b = writeDumpAgy(dir, 'clean.mjs');
    const d2 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: b.script, role: 'readonly', sanitizeEnv: true, env: { AGB_HOME_DIR: home } });
    assert.equal((await d2.sendTurn('hi')).ok, true);
    await d2.close();
    assert.equal(b.read().env.UNLISTED_SECRET_TOKEN_FOR_TEST, undefined);
  } finally {
    delete process.env.UNLISTED_SECRET_TOKEN_FOR_TEST;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon builder containment defaults, allowCodegraph forwarding, and either flag forces containment', async () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    const a = writeDumpAgy(dir, 'a.mjs');
    const spy = makeSpy(dir, a.script);
    const d1 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, prepareContainment: spy.prepareContainment });
    assert.equal(d1.sandbox, true);
    assert.equal(d1.containment, true);
    assert.equal((await d1.sendTurn('hi')).ok, true);
    await d1.close();
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].allowCodegraph, false);
    assert.equal(spy.calls[0].sandbox, true);
    assert.equal(spy.calls[0].containment, true);
    assert.equal(spy.calls[0].repo, dir);
    assert.equal(spy.calls[0].agyBin, a.script);
    assert.equal(spy.calls[0].userHome, home);
    assert.equal(spy.calls[0].platform, process.platform);
    assert.deepEqual(spy.cleanups, [1]);

    const spy2 = makeSpy(dir, a.script);
    const d2 = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, hasCodegraph: true, repo: dir, prepareContainment: spy2.prepareContainment });
    assert.equal((await d2.sendTurn('hi')).ok, true);
    await d2.close();
    assert.equal(spy2.calls[0].allowCodegraph, true);

    for (const flags of [{ containment: false, sandbox: true }, { containment: true, sandbox: false }]) {
      const s = makeSpy(dir, a.script);
      const d = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, ...flags, prepareContainment: s.prepareContainment });
      assert.equal((await d.sendTurn('hi')).ok, true);
      await d.close();
      assert.equal(s.calls.length, 1);
    }

    const s3 = makeSpy(dir, a.script);
    const dRo = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, role: 'readonly', containment: true, sandbox: true, prepareContainment: s3.prepareContainment });
    assert.equal((await dRo.sendTurn('hi')).ok, true);
    await dRo.close();
    assert.equal(s3.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon dedupes concurrent sendTurn spawns via _spawnPromise', async () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    const a = writeDumpAgy(dir);
    const spy = makeSpy(dir, a.script);
    const d = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, prepareContainment: spy.prepareContainment });
    const [r1, r2] = await Promise.all([d.sendTurn('one'), d.sendTurn('two')]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(spy.calls.length, 1);
    assert.equal(d._spawnPromise, null);
    await d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon respawns clean up containment and clear verifiedBypass after MAX_BYPASS_RESPAWNS', async () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    const a = writeDumpAgy(dir);
    const bypass = { valid: true, tag: 'attested' };
    const spy = makeSpy(dir, a.script, { bypass });
    const seen = [];
    const wrapped = async (opts) => {
      seen.push(opts.verifiedBypass);
      return spy.prepareContainment(opts);
    };
    const d = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, prepareContainment: wrapped });
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await d.sendTurn(`turn ${i}`)).ok, true);
      assert.equal(spy.cleanups.length, i);
      if (i < 3) await killChild(d);
    }
    assert.equal(seen.length, 4);
    assert.equal(seen[0], null);
    assert.equal(seen[1], bypass);
    assert.equal(seen[2], bypass);
    assert.equal(seen[3], null);
    assert.equal(d._respawnCount, 3);
    await d.close();
    assert.equal(spy.cleanups.length, 4);
    assert.equal(d._containmentCleanup, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon.close() during in-flight prepareContainment cleans up and spawns no child', async () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    const a = writeDumpAgy(dir);
    let release;
    const gate = new Promise((r) => { release = r; });
    const spy = makeSpy(dir, a.script, { gate });
    const d = new NdjsonWorkerDaemon({ model: 'gemini-4-neon-medium', cwd: dir, bin: a.script, env: { AGB_HOME_DIR: home }, prepareContainment: spy.prepareContainment });
    const turn = d.sendTurn('hi');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(spy.calls.length, 1);
    const closing = d.close();
    release();
    await closing;
    const res = await turn;
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'daemon_closed');
    assert.equal(d.child, null);
    assert.equal(spy.cleanups.length, 1);
    assert.equal(existsSync(a.script + '.dump.json'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NdjsonWorkerDaemon contained builder fails closed and never uses single-shot fallback', async () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    const fbCalls = [];
    const singleShotFallback = async () => {
      fbCalls.push(1);
      return { ok: true, fallback: true, output: 'uncontained' };
    };
    const base = { model: 'gemini-4-neon-medium', cwd: dir, env: { AGB_HOME_DIR: home }, singleShotFallback };

    const failing = new NdjsonWorkerDaemon({
      ...base,
      prepareContainment: async () => ({ ok: false, kind: 'kernel_unavailable', error: 'nope' }),
    });
    const r1 = await failing.sendTurn('x');
    assert.deepEqual({ ok: r1.ok, kind: r1.kind, error: r1.error }, { ok: false, kind: 'kernel_unavailable', error: 'nope' });

    const noKind = new NdjsonWorkerDaemon({ ...base, prepareContainment: async () => ({ ok: false, error: 'bad' }) });
    const r1b = await noKind.sendTurn('x');
    assert.equal(r1b.kind, 'containment_unavailable');
    assert.equal(r1b.error, 'bad');

    const throwing = new NdjsonWorkerDaemon({ ...base, prepareContainment: async () => { throw new Error('boom'); } });
    const r2 = await throwing.sendTurn('x');
    assert.equal(r2.ok, false);
    assert.equal(r2.kind, 'containment_unavailable');
    assert.equal(r2.error, 'boom');

    const nonPersistent = new NdjsonWorkerDaemon({ ...base, persistentWorkers: false });
    const r3 = await nonPersistent.sendTurn('x');
    assert.equal(r3.kind, 'containment_unavailable');
    assert.match(r3.error, /uncontained single-shot fallback is forbidden/);

    const exiting = writeExitAgy(dir);
    const spy = makeSpy(dir, exiting);
    const eof = new NdjsonWorkerDaemon({ ...base, bin: exiting, prepareContainment: spy.prepareContainment });
    const r4 = await eof.sendTurn('x');
    assert.equal(r4.ok, false);
    assert.equal(r4.kind, 'containment_unavailable');
    assert.equal(fbCalls.length, 0);

    const spy2 = makeSpy(dir, exiting);
    const allowed = new NdjsonWorkerDaemon({ ...base, bin: exiting, singleShotFallbackIsContained: true, prepareContainment: spy2.prepareContainment });
    const r5 = await allowed.sendTurn('x');
    assert.equal(r5.fallback, true);
    assert.equal(fbCalls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    ...PURE,
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
    assert.deepEqual(Object.keys(parsedSettings).sort(), ['allowNonWorkspaceAccess', 'permissions']);
    assert.ok(parsedSettings.permissions.deny.includes('write_file(.git/)'));
    assert.equal(parsedSettings.permissions.deny.includes('mcp(*)'), false);

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

test('NdjsonWorkerDaemon falls back to singleShotFallback when persistentWorkers is false or stdin closes', async () => {
  const fallbackCalls = [];
  const daemonOld = new NdjsonWorkerDaemon({
    model: 'gemini-4-argon-high',
    bin: FAKE_AGY,
    persistentWorkers: false,
    ...PURE,
    singleShotFallback: async (prompt, meta) => {
      fallbackCalls.push({ prompt, meta });
      return { ok: true, fallback: true, output: 'fallback-ok' };
    },
  });
  assert.equal(daemonOld.supportsPersistentNdjson(), false);
  assert.equal(new NdjsonWorkerDaemon({ model: 'gemini-4-argon-high', agyVersion: '1.0.0' }).supportsPersistentNdjson(), true);

  const resOld = await daemonOld.sendTurn('Prompt without persistence');
  assert.equal(resOld.ok, true);
  assert.equal(resOld.fallback, true);
  assert.equal(fallbackCalls.length, 1);

  // Also test EOF / non-daemon process exit fallback
  const daemonEof = new NdjsonWorkerDaemon({
    model: 'gemini-4-argon-high',
    bin: FAKE_AGY,
    env: { FAKE_AGY_MODE: 'fail' },
    ...PURE,
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
