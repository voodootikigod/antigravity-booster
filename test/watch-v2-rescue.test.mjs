import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgy } from '../lib/agy.mjs';
import { runPlan, snapshotRootGit, verifyRootGitIntegrity } from '../lib/scheduler.mjs';
import { sendControlCommand } from '../lib/control-ipc.mjs';
import {
  writeRescueWorktreeLock,
  hasProtectedRescueWorktree,
  saveRescueSnapshot,
} from '../lib/rescue.mjs';
import { watchStatus, RunStatus } from '../lib/status.mjs';
import { stripAnsi } from '../lib/tui.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_watch_v2_test_${process.pid}.json`);

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-v2-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  writeFileSync(
    join(dir, '.gitignore'),
    [
      '.worktrees/',
      '.booster/',
      '.adlc/*',
      '!.adlc/tickets/',
      '!.adlc/tickets/**',
      '!.adlc/ticket-archive/',
      '!.adlc/ticket-archive/**',
      '!.adlc/specs/',
      '!.adlc/config.json',
      '',
    ].join('\n')
  );
  g('add', '-A');
  g('commit', '-qm', 'init');
  return dir;
}

function withEnv(env, fn) {
  const mergedEnv = { AGB_ALLOW_CUSTOM_ADLC_CLI: '1', ...env };
  const saved = {};
  for (const [k, v] of Object.entries(mergedEnv)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

const quiet = { log: () => {} };

test('runAgy onStep: taps both live agy 1.5.14 step_update envelopes and synthetic step_update / step envelopes', async () => {
  const mockDir = mkdtempSync(join(tmpdir(), 'agb-onstep-mock-'));
  try {
    const script = join(mockDir, 'mock-stream-agy.sh');
    const longMsg = 'Run   test   suite   ' + 'x'.repeat(280);
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        `echo '{"event":"init","conversation_id":"conv-step-tap"}'`,
        `echo '{"event":"step_update","step_update":{"tool_info":{"name":"run_command","parameters":{"toolSummary":"${longMsg}","CommandLine":"npm test"}}}}'`,
        `echo '{"event":"step_update","step_update":{"tool_name":"edit_file","summary":"Update   lib/scheduler.mjs"}}'`,
        `echo '{"type":"step_update","step":1,"action":"working","tool_name":"write_file","tool_summary":"Write test file"}'`,
        `echo '{"step":{"name":"read_file","message":"Read   lib/tui.mjs"}}'`,
        `echo '{"event":"result","result":{"status":"SUCCESS","exit_code":0}}'`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const steps = [];
    let callCount = 0;
    const res = await runAgy({
      bin: script,
      model: 'gemini-4-neon-high',
      prompt: 'test onStep callback',
      outputFormat: 'stream-json',
      sandbox: false,
      onStep: (step) => {
        callCount += 1;
        steps.push(step);
        if (callCount === 2) {
          throw new Error('user callback error must be swallowed');
        }
      },
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(steps.length, 4);

    assert.equal(steps[0].toolName, 'run_command');
    assert.equal(steps[0].summary.length, 240);
    assert.match(steps[0].summary, /^Run test suite x+/);
    assert.equal(typeof steps[0].ts, 'string');
    assert.equal(steps[0].raw.event, 'step_update');

    assert.equal(steps[1].toolName, 'edit_file');
    assert.equal(steps[1].summary, 'Update lib/scheduler.mjs');

    assert.equal(steps[2].toolName, 'write_file');
    assert.equal(steps[2].summary, 'Write test file');

    assert.equal(steps[3].toolName, 'read_file');
    assert.equal(steps[3].summary, 'Read lib/tui.mjs');
  } finally {
    rmSync(mockDir, { recursive: true, force: true });
  }
});

test('runPlan: both normal runPlan and resume: true refuse to clobber protected rescue worktrees unless resetRescue: true', async () => {
  const repo = makeRepo();
  try {
    const wtDir = join(repo, '.worktrees', 'agb-t1');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, 'human-work.txt'), 'precious rescue edits\n');
    writeRescueWorktreeLock(repo, 'T1', { state: 'preserved', runId: 'run-prev' });
    assert.equal(hasProtectedRescueWorktree(repo, 'T1'), true);

    const plan = {
      repo,
      gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'one', body: 'write T1.txt', scope: ['T1.txt'] }],
    };

    // 1. Normal runPlan must refuse
    await assert.rejects(
      () =>
        withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
          runPlan(plan, quiet)
        ),
      /Refusing to clobber active or preserved rescue worktree \.worktrees\/agb-t1; complete 'agb rescue T1' or pass '--reset-rescue' first/
    );
    assert.equal(readFileSync(join(wtDir, 'human-work.txt'), 'utf8'), 'precious rescue edits\n');
    assert.equal(hasProtectedRescueWorktree(repo, 'T1'), true);

    // 2. Resume runPlan must ALSO refuse
    await assert.rejects(
      () =>
        withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
          runPlan(plan, { ...quiet, resume: true })
        ),
      /Refusing to clobber active or preserved rescue worktree \.worktrees\/agb-t1; complete 'agb rescue T1' or pass '--reset-rescue' first/
    );
    assert.equal(readFileSync(join(wtDir, 'human-work.txt'), 'utf8'), 'precious rescue edits\n');
    assert.equal(hasProtectedRescueWorktree(repo, 'T1'), true);

    // 3. resetRescue: true clears lock, cleans stale worktree, and merges T1
    const report = await withEnv({ AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' }, () =>
      runPlan(plan, { ...quiet, resetRescue: true })
    );
    assert.deepEqual(report.merged, ['T1']);
    assert.deepEqual(report.failed, {});
    assert.equal(hasProtectedRescueWorktree(repo, 'T1'), false);
    assert.equal(existsSync(join(repo, 'T1.txt')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runPlan: saves pure-FS rescue snapshot on failure with root git integrity intact, and resume: true skips verified merged upstream tickets', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-resume-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-resume-bin-'));
  try {
    const plan = {
      repo,
      gate: {
        // T1 writes "did the work" -> passes; T2 under custom script writes "broken-t2" on run 1 -> fails gate!
        test: 'test ! -f T2.txt || grep -q "fixed-t2" T2.txt',
      },
      tickets: [
        { id: 'T1', title: 'upstream', body: 'write T1.txt', scope: ['T1.txt'], edges: [{ to: 'T2' }] },
        { id: 'T2', title: 'downstream', body: 'write T2.txt', scope: ['T2.txt'] },
      ],
    };

    // Separate binDir from FAKE_STATE_DIR so bwrap's --ro-bind on dirname(agyBin) never makes stateDir read-only
    const customBin = join(binDir, 'custom-agy.sh');
    writeFileSync(
      customBin,
      [
        '#!/usr/bin/env bash',
        'all_args="$*"',
        'if [[ "$all_args" == *"ticket T1"* ]] && [[ "$all_args" == *"TICKET-DONE or TICKET-BLOCKED"* ]]; then',
        `  echo "T1" >> "${stateDir}/built-tickets.log"`,
        '  echo "did the work" > T1.txt',
        '  echo \'{"type":"step_update","step":1,"action":"built-t1"}\'',
        '  echo \'{"type":"result","status":"SUCCESS","exit_code":0,"conversation_id":"c-t1"}\'',
        '  exit 0',
        'fi',
        'if [[ "$all_args" == *"ticket T2"* ]] && [[ "$all_args" == *"TICKET-DONE or TICKET-BLOCKED"* ]]; then',
        `  echo "T2" >> "${stateDir}/built-tickets.log"`,
        `  if [ "\${FAKE_T2_FIX:-0}" = "1" ]; then`,
        '    echo "fixed-t2" > T2.txt',
        '  else',
        '    echo "broken-t2-attempt" > T2.txt',
        '    echo "poison" > AGENTS.md',
        '  fi',
        '  echo \'{"type":"step_update","step":1,"action":"built-t2"}\'',
        '  echo \'{"type":"result","status":"SUCCESS","exit_code":0,"conversation_id":"c-t2"}\'',
        '  exit 0',
        'fi',
        `exec "${FAKE_AGY}" "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const preRoot = snapshotRootGit(repo);

    // Run 1: T1 merges, T2 fails both strikes
    const report1 = await withEnv({ AGB_AGY_BIN: customBin, AGB_SANDBOX_GATES: '0', FAKE_STATE_DIR: stateDir }, () =>
      runPlan(plan, quiet)
    );
    assert.deepEqual(report1.merged, ['T1']);
    assert.ok(report1.failed.T2, 'T2 must fail on run 1');
    assert.equal(report1.compromised, null, 'run 1 must not compromise root git integrity');
    assert.equal(
      execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' }),
      '',
      'root working tree and index must remain completely clean after failed T2 snapshot'
    );

    // Verify rescue snapshot captured T2.txt before worktree removal and stripped AGENTS.md
    const latestSnapPath = join(repo, '.booster', 'rescue-latest', 't2.json');
    assert.equal(existsSync(latestSnapPath), true, 'rescue-latest/t2.json must exist');
    const snap = JSON.parse(readFileSync(latestSnapPath, 'utf8'));
    assert.equal(snap.ticketId, 'T2');
    assert.deepEqual(
      snap.files.map((f) => f.path),
      ['T2.txt']
    );
    assert.equal(
      Buffer.from(snap.files[0].contentBase64, 'base64').toString('utf8'),
      'broken-t2-attempt\n'
    );
    assert.match(snap.diff, /\+broken-t2-attempt/);

    // Reset build log before Run 2 with resume: true
    writeFileSync(join(stateDir, 'built-tickets.log'), '');

    // Run 2: resume: true must verify T1 on main, skip building T1, and build + merge only T2!
    const report2 = await withEnv(
      { AGB_AGY_BIN: customBin, AGB_SANDBOX_GATES: '0', FAKE_STATE_DIR: stateDir, FAKE_T2_FIX: '1' },
      () => runPlan(plan, { ...quiet, resume: true })
    );
    assert.deepEqual(report2.failed, {});
    assert.deepEqual(new Set(report2.merged), new Set(['T1', 'T2']));
    const builtInResume = readFileSync(join(stateDir, 'built-tickets.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(builtInResume, ['T2'], 'resume: true must not rebuild verified merged T1');
    assert.equal(readFileSync(join(repo, 'T2.txt'), 'utf8'), 'fixed-t2\n');

    const runJsonAfter = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
    assert.equal(runJsonAfter.tickets.T1.phase, 'merged');
    assert.equal(runJsonAfter.tickets.T1.detail, 'resumed (already merged)');

    // Also verify unverified report.json claim is NOT trusted if commit is absent from base & manifest
    writeFileSync(
      join(repo, '.booster', 'report.json'),
      JSON.stringify({ runId: 'tampered', merged: ['T1', 'T2', 'T3'], failed: {} })
    );
    const planWithT3 = {
      ...plan,
      tickets: [
        ...plan.tickets,
        { id: 'T3', title: 'unmerged', body: 'write T3.txt', scope: ['T3.txt'] },
      ],
    };
    const report3 = await withEnv(
      { AGB_AGY_BIN: FAKE_AGY, AGB_SANDBOX_GATES: '0' },
      () => runPlan(planWithT3, { ...quiet, resume: true })
    );
    assert.equal(existsSync(join(repo, 'T3.txt')), true, 'unverified T3 must execute rather than being skipped');
    assert.deepEqual(new Set(report3.merged), new Set(['T1', 'T2', 'T3']));

    // Also verify reusing ticket ID T1 in a NEW plan with a different scope rebuilds T1 instead of skipping!
    writeFileSync(join(stateDir, 'built-tickets.log'), '');
    const customBinV2 = join(binDir, 'custom-agy-v2.sh');
    writeFileSync(
      customBinV2,
      [
        '#!/usr/bin/env bash',
        'all_args="$*"',
        'if [[ "$all_args" == *"ticket T1"* ]] && [[ "$all_args" == *"TICKET-DONE or TICKET-BLOCKED"* ]]; then',
        `  echo "T1-rebuilt" >> "${stateDir}/built-tickets.log"`,
        '  echo "v2" > T1-v2.txt',
        '  echo \'{"type":"result","status":"SUCCESS","exit_code":0,"conversation_id":"c-t1-v2"}\'',
        '  exit 0',
        'fi',
        `exec "${FAKE_AGY}" "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    const newPlanReusingT1 = {
      repo,
      gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'new plan T1', body: 'write T1-v2.txt', scope: ['T1-v2.txt'] }],
    };
    const report4 = await withEnv(
      { AGB_AGY_BIN: customBinV2, AGB_SANDBOX_GATES: '0', FAKE_STATE_DIR: stateDir },
      () => runPlan(newPlanReusingT1, { ...quiet, resume: true })
    );
    assert.deepEqual(report4.merged, ['T1']);
    assert.equal(
      readFileSync(join(stateDir, 'built-tickets.log'), 'utf8').trim(),
      'T1-rebuilt',
      'Reusing ticket ID T1 with a new scope must rebuild T1 rather than skipping from stale run.json'
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('runPlan live Control IPC: pause, resume, status, stream, diff, and abort (single-strike immediate abort + snapshot)', async () => {
  const repo = makeRepo();
  const ctrlDir = mkdtempSync(join(tmpdir(), 'agb-ipc-live-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-ipc-bin-'));
  try {
    const customBin = join(binDir, 'controlled-agy.sh');
    writeFileSync(
      customBin,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const { spawnSync } = require("node:child_process");',
        `const ctrlDir = ${JSON.stringify(ctrlDir)};`,
        `const fakeAgy = ${JSON.stringify(FAKE_AGY)};`,
        'const args = process.argv.slice(2);',
        'const pIdx = args.indexOf("--print") !== -1 ? args.indexOf("--print") : args.indexOf("-p");',
        'const prompt = pIdx !== -1 ? (args[pIdx + 1] || "") : "";',
        'if (prompt.includes("TICKET-DONE or TICKET-BLOCKED") && /ticket T1\\b/i.test(prompt)) {',
        '  fs.writeFileSync("T1.txt", "live-t1-content\\n");',
        '  console.log(JSON.stringify({ event: "init", conversation_id: "c-ipc-1" }));',
        '  console.log(JSON.stringify({ event: "step_update", step_update: { tool_name: "write_file", summary: "Created T1.txt" } }));',
        '  fs.writeFileSync(path.join(ctrlDir, "t1-ready"), "1");',
        '  const releaseFile = path.join(ctrlDir, "t1-release");',
        '  const deadline = Date.now() + 10000;',
        '  while (!fs.existsSync(releaseFile) && Date.now() < deadline) {',
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);',
        '  }',
        '  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", exit_code: 0 } }));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("TICKET-DONE or TICKET-BLOCKED") && /ticket T2\\b/i.test(prompt)) {',
        '  const cntFile = path.join(ctrlDir, "t2-spawns");',
        '  const prev = fs.existsSync(cntFile) ? Number(fs.readFileSync(cntFile, "utf8")) : 0;',
        '  fs.writeFileSync(cntFile, String(prev + 1));',
        '  fs.writeFileSync("T2.txt", "partial-t2-before-abort\\n");',
        '  console.log(JSON.stringify({ event: "init", conversation_id: "c-ipc-2" }));',
        '  console.log(JSON.stringify({ event: "step_update", step_update: { tool_name: "edit_file", summary: "Editing T2.txt" } }));',
        '  fs.writeFileSync(path.join(ctrlDir, "t2-ready"), "1");',
        '  const deadline = Date.now() + 15000;',
        '  while (Date.now() < deadline) {',
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);',
        '  }',
        '  process.exit(1);',
        '}',
        'const r = spawnSync(fakeAgy, args, { stdio: "inherit", env: process.env });',
        'process.exit(r.status ?? 0);',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const plan = {
      repo,
      gate: { test: 'true' },
      tickets: [
        { id: 'T1', title: 'first', body: 'write T1.txt', scope: ['T1.txt'], edges: [{ to: 'T2' }] },
        { id: 'T2', title: 'second', body: 'write T2.txt', scope: ['T2.txt'] },
      ],
    };

    const runPromise = withEnv(
      { AGB_AGY_BIN: customBin, AGB_SANDBOX_GATES: '0', FAKE_STATE_DIR: ctrlDir },
      () => runPlan(plan, quiet)
    );

    try {
      await waitFor(() => existsSync(join(ctrlDir, 't1-ready')), { label: 'T1 builder ready' });

      // 1. status IPC
      const st1 = await sendControlCommand(repo, { action: 'status' });
      assert.equal(st1.ok, true);
      assert.equal(st1.paused, false);
      assert.ok(st1.activeTickets.includes('T1'));

      // 2. stream IPC
      const streamRes = await waitFor(async () => {
        const r = await sendControlCommand(repo, { action: 'stream', ticketId: 'T1' });
        return r.ok && r.lines.length > 0 ? r : null;
      }, { label: 'T1 stream lines' });
      assert.match(streamRes.lines[0], /^\[\d{2}:\d{2}:\d{2}\] write_file: Created T1\.txt$/);

      // 3. diff IPC while T1 worktree is live
      const diffRes = await sendControlCommand(repo, { action: 'diff', ticketId: 'T1' });
      assert.equal(diffRes.ok, true);
      assert.match(diffRes.diff, /\+live-t1-content/);

      // 4. pause IPC before releasing T1 -> T1 finishes & merges, T2 must NOT start while paused!
      const pauseRes = await sendControlCommand(repo, { action: 'pause' });
      assert.equal(pauseRes.ok, true);
      assert.equal(pauseRes.paused, true);

      writeFileSync(join(ctrlDir, 't1-release'), '1');

      await waitFor(() => {
        try {
          const rj = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
          return rj.tickets?.T1?.phase === 'merged';
        } catch {
          return false;
        }
      }, { label: 'T1 merged while paused' });

      await new Promise((r) => setTimeout(r, 120));
      assert.equal(existsSync(join(ctrlDir, 't2-ready')), false, 'T2 must remain suspended while schedulerPaused is true');

      // Aborting already-merged T1 must fail with ticket is not active
      const inactiveAbort = await sendControlCommand(repo, { action: 'abort', ticketId: 'T1' });
      assert.equal(inactiveAbort.ok, false);
      assert.equal(inactiveAbort.aborted, false);
      assert.equal(inactiveAbort.error, 'ticket is not active');

      // 5. resume IPC -> T2 dispatches!
      const resumeRes = await sendControlCommand(repo, { action: 'resume' });
      assert.equal(resumeRes.ok, true);
      assert.equal(resumeRes.paused, false);

      await waitFor(() => existsSync(join(ctrlDir, 't2-ready')), { label: 'T2 builder started after resume' });

      // 6. abort IPC on active T2 -> terminates immediately on strike 1 and saves rescue snapshot
      const abortRes = await sendControlCommand(repo, { action: 'abort', ticketId: 'T2' });
      assert.equal(abortRes.ok, true);
      assert.equal(abortRes.ticketId, 'T2');
      assert.equal(abortRes.aborted, true);

      const report = await runPromise;
      assert.deepEqual(report.merged, ['T1']);
      assert.equal(report.failed.T2, 'aborted via control IPC');
      assert.equal(Number(readFileSync(join(ctrlDir, 't2-spawns'), 'utf8')), 1, 'abort must not burn a second strike');

      // Rescue snapshot saved for aborted T2
      const t2Snap = JSON.parse(readFileSync(join(repo, '.booster', 'rescue-latest', 't2.json'), 'utf8'));
      assert.equal(t2Snap.ticketId, 'T2');
      assert.match(t2Snap.diff, /\+partial-t2-before-abort/);

      // Control socket and control.json cleaned up in finally
      assert.equal(existsSync(join(repo, '.booster', 'control.json')), false);
      assert.equal(existsSync(join(repo, '.booster', 'control.sock')), false);
    } finally {
      writeFileSync(join(ctrlDir, 't1-release'), '1');
      await runPromise.catch(() => {});
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(ctrlDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('watchStatus v2 interactive keys: j/k, 1-4 tabs, / filter, p pause/resume, x abort, queued Enter while !done, and immediate Enter when done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-keys-'));
  try {
    // Prepare a rescue snapshot so offline diff fallback is also verified
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.js'), 'const a = 1;\n');
    const wtFake = mkdtempSync(join(tmpdir(), 'agb-wt-snap-'));
    try {
      mkdirSync(join(wtFake, 'src'), { recursive: true });
      writeFileSync(join(wtFake, 'src', 'a.js'), 'const a = 2;\n');
      saveRescueSnapshot(dir, { id: 'T1', scope: ['src/**'] }, wtFake, {
        runId: 'run-w1',
        baselineRoot: dir,
      });
    } finally {
      rmSync(wtFake, { recursive: true, force: true });
    }

    const status = new RunStatus(dir, 'run-w1');
    status.ticket('T1', { phase: 'failed', model: 'claude-sonnet-5-5-high', error: 'Gate failed', strikes: 2 });
    status.ticket('T2', { phase: 'building', model: 'gemini-4-neon-high', strikes: 1 });
    await status.flushEvents();

    let out = '';
    const fakeStdout = {
      write: (chunk) => {
        out += String(chunk);
      },
      columns: 110,
      rows: 35,
    };
    const fakeStdin = new PassThrough();

    const ipcCalls = [];
    let pausedState = false;
    const mockSendCommand = async (_repo, cmd) => {
      ipcCalls.push(cmd);
      if (cmd.action === 'stream') {
        return { ok: true, ticketId: cmd.ticketId, lines: ['[10:15:00] run_command: npm test'] };
      }
      if (cmd.action === 'diff') {
        if (cmd.ticketId === 'T1') {
          return { ok: false, offline: true, error: 'offline' };
        }
        return { ok: true, ticketId: cmd.ticketId, diff: '+live diff for T2' };
      }
      if (cmd.action === 'pause') {
        pausedState = true;
        return { ok: true, paused: true };
      }
      if (cmd.action === 'resume') {
        pausedState = false;
        return { ok: true, paused: false };
      }
      if (cmd.action === 'abort') {
        return { ok: true, ticketId: cmd.ticketId, aborted: true };
      }
      return { ok: true };
    };

    const rescuedCalls = [];
    const watchPromise = watchStatus(dir, {
      intervalMs: 40,
      interactive: true,
      stdout: fakeStdout,
      stdin: fakeStdin,
      sendCommandFn: mockSendCommand,
      onRescue: async (ticketId, targetRepo) => {
        rescuedCalls.push({ ticketId, targetRepo, altBufferLeftBeforeRescue: out.includes('\x1b[?1049l') });
        return { ok: true, merged: true };
      },
    });

    try {
      await waitFor(() => stripAnsi(out).includes('ANTIGRAVITY BOOSTER'), { label: 'initial render' });

      // Select T1 ('j'), view offline diff fallback ('3'), then select T2 ('j'), view stream ('2'), abort T2 ('x'), pause ('p'), resume ('p')
      fakeStdin.write('j3');
      await waitFor(() => stripAnsi(out).includes('+const a = 2;'), { label: 'offline diff fallback for T1' });

      fakeStdin.write('j2');
      await waitFor(() => stripAnsi(out).includes('[10:15:00] run_command: npm test'), { label: 'live stream for T2' });

      fakeStdin.write('x');
      await waitFor(() => stripAnsi(out).includes('Aborted ticket T2'), { label: 'abort notice for T2' });

      fakeStdin.write('p');
      await waitFor(() => pausedState === true && stripAnsi(out).includes('Scheduler paused'), { label: 'pause notice' });

      fakeStdin.write('p');
      await waitFor(() => pausedState === false && stripAnsi(out).includes('Scheduler resumed'), { label: 'resume notice' });

      // Filter mode: '/T1\r' filters to T1, then '/\x1b' clears filter
      fakeStdin.write('/T1\r');
      await waitFor(() => stripAnsi(out).includes('[/T1]'), { label: 'filter T1 committed' });
      out = '';
      fakeStdin.write('/\x1b');
      await waitFor(() => stripAnsi(out).includes('ANTIGRAVITY BOOSTER') && !stripAnsi(out).includes('[/T1]'), { label: 'filter cleared on Escape' });

      // Select T1 ('k') and press Enter while !state.done -> queues rescue!
      fakeStdin.write('k\r');
      await waitFor(
        () => stripAnsi(out).includes('Queued rescue for T1 — waiting for active fleet run to finish...'),
        { label: 'queued rescue notice' }
      );
      assert.equal(rescuedCalls.length, 0, 'onRescue must not fire while fleet run is still active');

      // Complete the fleet run -> tick() must automatically tear down TUI and invoke onRescue('T1', dir)!
      status.ticket('T2', { phase: 'merged' });
      status.report({ merged: ['T2'], failed: { T1: 'Gate failed' }, requests: {} });
      await status.flushEvents();

      const exitCode = await watchPromise;
      assert.equal(exitCode, 0);
      assert.equal(rescuedCalls.length, 1);
      assert.equal(rescuedCalls[0].ticketId, 'T1');
      assert.equal(rescuedCalls[0].targetRepo, dir);
      assert.equal(rescuedCalls[0].altBufferLeftBeforeRescue, true, 'cleanup() must restore terminal before invoking onRescue');
      assert.ok(ipcCalls.some((c) => c.action === 'abort' && c.ticketId === 'T2'));
    } finally {
      fakeStdin.end();
      await watchPromise.catch(() => {});
    }

    // Immediate Enter when state.done === true and onRescue returns { ok: false } -> exits with code 2
    let out2 = '';
    const fakeStdout2 = { write: (c) => { out2 += String(c); }, columns: 100, rows: 30 };
    const fakeStdin2 = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    });
    let immediateRescued = null;
    const watchDonePromise = watchStatus(dir, {
      intervalMs: 50,
      interactive: true,
      stdout: fakeStdout2,
      stdin: fakeStdin2,
      onRescue: async (tid) => {
        immediateRescued = tid;
        return { ok: false };
      },
    });
    await waitFor(() => stripAnsi(out2).includes('FAILED'), { label: 'done dashboard render' });
    fakeStdin2.emit('data', 'j\r');
    const code2 = await watchDonePromise;
    assert.equal(immediateRescued, 'T1');
    assert.equal(code2, 2, 'failed onRescue ({ ok: false }) must resolve exit code 2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
