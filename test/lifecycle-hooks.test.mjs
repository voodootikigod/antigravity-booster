import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { evaluateLifecycleEvent } from '../hooks/lifecycle.mjs';
import { stageHooksOnlyBoosterPlugin } from '../lib/agy.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('hooks/lifecycle.mjs contains zero decision: "allow" literals and fast-exits {} in headless worker mode', () => {
  const src = readFileSync(join(REPO_ROOT, 'hooks', 'lifecycle.mjs'), 'utf8');
  assert.equal(/decision\s*:\s*['"]allow['"]/.test(src), false, 'hooks must never emit decision: allow');

  const outWorker = evaluateLifecycleEvent(
    {
      hookEventName: 'Stop',
      conversationId: 'conv-worker-123456',
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
    },
    { env: { AGB_WORKER_TICKET: 'T-1' } }
  );
  assert.deepEqual(outWorker, {});

  const outReadonly = evaluateLifecycleEvent(
    {
      hookEventName: 'PreInvocation',
      conversationId: 'conv-ro-123456',
    },
    { env: { AGB_WORKER_MODE: 'readonly' } }
  );
  assert.deepEqual(outReadonly, {});
});

test('evaluateLifecycleEvent emits 0-token PreInvocation badges, tracks PostToolUse dirty state, and enforces active-ticket-scoped Stop guard without infinite loops', () => {
  const base = mkdtempSync(join(tmpdir(), 'agb-lifecycle-'));
  const dataDir = join(base, 'plugin-data');
  const adlcRepo = join(base, 'adlc-repo');
  const plainRepo = join(base, 'plain-repo');

  try {
    mkdirSync(join(adlcRepo, '.adlc'), { recursive: true });
    mkdirSync(join(adlcRepo, 'lib'), { recursive: true });
    initializeDirectoryStore(join(adlcRepo, '.adlc', 'tickets'));
    writeFileSync(
      join(adlcRepo, '.adlc', 'tickets', ticketFilename('T-401')),
      JSON.stringify({
        id: 'T-401',
        title: 'Dark factory gate',
        body: 'Spec',
        scope: ['lib/**'],
        rails: ['lib/lock.mjs', 'lib/gates.mjs'],
        edges: [],
      }) + '\n'
    );
    mkdirSync(plainRepo, { recursive: true });

    const convId = '0c15c0be-72fa-4edb-998a-ef83a826e69c';

    // 1. Non-ADLC plain repo: PreInvocation & Stop emit {} even after edits
    assert.deepEqual(
      evaluateLifecycleEvent(
        { hookEventName: 'PreInvocation', conversationId: 'conv-plain-123456', cwd: plainRepo },
        { pluginDataDir: dataDir, env: {} }
      ),
      {}
    );
    evaluateLifecycleEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: 'conv-plain-123456',
        cwd: plainRepo,
        toolCall: { name: 'edit_file', args: { Path: join(plainRepo, 'index.js') } },
      },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.deepEqual(
      evaluateLifecycleEvent(
        {
          hookEventName: 'Stop',
          conversationId: 'conv-plain-123456',
          cwd: plainRepo,
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: false,
          fullyIdle: true,
        },
        { pluginDataDir: dataDir, env: {} }
      ),
      {},
      'plain non-ADLC repo must never block Stop'
    );

    // 2. Active-ticket ADLC repo: first PreInvocation emits 0-token user_markdown readiness card once
    const pre1 = evaluateLifecycleEvent(
      { hookEventName: 'PreInvocation', conversationId: convId, cwd: adlcRepo },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.equal(pre1.injectSteps?.length, 1);
    assert.equal(pre1.injectSteps[0].systemMessage.systemMessage, '');
    assert.match(pre1.injectSteps[0].systemMessage.metadata.user_markdown, /T-401/);

    const pre2 = evaluateLifecycleEvent(
      { hookEventName: 'PreInvocation', conversationId: convId, cwd: adlcRepo },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.deepEqual(pre2, {}, 'second PreInvocation must be silent');

    // 3. PostToolUse on mutating edit marks dirtySinceGate
    const postEdit = evaluateLifecycleEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: convId,
        cwd: adlcRepo,
        toolCall: { name: 'edit_file', args: { Path: join(adlcRepo, 'lib', 'widget.mjs') } },
      },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.deepEqual(postEdit, {});

    // 4. Stop while background subagents are active (`fullyIdle: false`) MUST NOT interrupt reactive wakeup!
    assert.deepEqual(
      evaluateLifecycleEvent(
        {
          hookEventName: 'Stop',
          conversationId: convId,
          cwd: adlcRepo,
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: false,
          fullyIdle: false,
        },
        { pluginDataDir: dataDir, env: {} }
      ),
      {}
    );

    // 5. Stop when idle & dirty fires decision: "continue" ONCE
    const stop1 = evaluateLifecycleEvent(
      {
        hookEventName: 'Stop',
        conversationId: convId,
        cwd: adlcRepo,
        terminationReason: 'NO_TOOL_CALL',
        continuationActive: false,
        fullyIdle: true,
      },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.equal(stop1.decision, 'continue');
    assert.match(stop1.reason, /T-401/);
    assert.match(stop1.reason, /widget\.mjs/);

    // 6. Anti-loop: continuationActive=true OR repeated Stop without new edit returns {}
    assert.deepEqual(
      evaluateLifecycleEvent(
        {
          hookEventName: 'Stop',
          conversationId: convId,
          cwd: adlcRepo,
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: true,
          fullyIdle: true,
        },
        { pluginDataDir: dataDir, env: {} }
      ),
      {}
    );
    assert.deepEqual(
      evaluateLifecycleEvent(
        {
          hookEventName: 'Stop',
          conversationId: convId,
          cwd: adlcRepo,
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: false,
          fullyIdle: true,
        },
        { pluginDataDir: dataDir, env: {} }
      ),
      {},
      'stopContinuationCount cap prevents repeated Stop continuation on the same edit batch'
    );

    // 7. Failing test run (error present) MUST keep dirtySinceGate === true; passing test clears it
    evaluateLifecycleEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: convId,
        cwd: adlcRepo,
        toolCall: { name: 'edit_file', args: { Path: join(adlcRepo, 'lib', 'widget.mjs') } },
      },
      { pluginDataDir: dataDir, env: {} }
    );
    evaluateLifecycleEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: convId,
        cwd: adlcRepo,
        error: 'exit status 1',
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      },
      { pluginDataDir: dataDir, env: {} }
    );
    const stopAfterFailedTest = evaluateLifecycleEvent(
      {
        hookEventName: 'Stop',
        conversationId: convId,
        cwd: adlcRepo,
        terminationReason: 'NO_TOOL_CALL',
        continuationActive: false,
        fullyIdle: true,
      },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.equal(stopAfterFailedTest.decision, 'continue', 'failed npm test must NOT clear dirtySinceGate');

    // Re-dirty and verify passing npm test clears dirtySinceGate
    evaluateLifecycleEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: convId,
        cwd: adlcRepo,
        toolCall: { name: 'edit_file', args: { Path: join(adlcRepo, 'lib', 'widget.mjs') } },
      },
      { pluginDataDir: dataDir, env: {} }
    );
    evaluateLifecycleEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: convId,
        cwd: adlcRepo,
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      },
      { pluginDataDir: dataDir, env: {} }
    );
    assert.deepEqual(
      evaluateLifecycleEvent(
        {
          hookEventName: 'Stop',
          conversationId: convId,
          cwd: adlcRepo,
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: false,
          fullyIdle: true,
        },
        { pluginDataDir: dataDir, env: {} }
      ),
      {},
      'passing npm test must clear dirtySinceGate'
    );

    // 7b. Turn-25 context-rot badge fires once at turn 25 and is silent on turn 26
    let turn25Out = null;
    for (let t = 3; t <= 25; t++) {
      turn25Out = evaluateLifecycleEvent(
        { hookEventName: 'PreInvocation', conversationId: convId, cwd: adlcRepo },
        { pluginDataDir: dataDir, env: {} }
      );
    }
    assert.equal(turn25Out.injectSteps?.length, 1);
    assert.equal(turn25Out.injectSteps[0].systemMessage.systemMessage, '');
    assert.match(turn25Out.injectSteps[0].systemMessage.metadata.user_markdown, /\/compact/);
    assert.deepEqual(
      evaluateLifecycleEvent(
        { hookEventName: 'PreInvocation', conversationId: convId, cwd: adlcRepo },
        { pluginDataDir: dataDir, env: {} }
      ),
      {}
    );

    // 7c. Read-only session-state directory on Stop fails open to {} instead of looping
    if (process.getuid?.() !== 0) {
      evaluateLifecycleEvent(
        {
          hookEventName: 'PostToolUse',
          conversationId: convId,
          cwd: adlcRepo,
          toolCall: { name: 'edit_file', args: { Path: join(adlcRepo, 'lib', 'widget.mjs') } },
        },
        { pluginDataDir: dataDir, env: {} }
      );
      const stateDir = join(dataDir, 'session-state');
      chmodSync(stateDir, 0o500);
      try {
        const roStop = evaluateLifecycleEvent(
          {
            hookEventName: 'Stop',
            conversationId: convId,
            cwd: adlcRepo,
            terminationReason: 'NO_TOOL_CALL',
            continuationActive: false,
            fullyIdle: true,
          },
          { pluginDataDir: dataDir, env: {} }
        );
        assert.deepEqual(roStop, {}, 'read-only state dir must fail open to {} to prevent Stop loop');
      } finally {
        chmodSync(stateDir, 0o700);
      }
    }

    // 8. Symlinked session-state directory degrades safely to {} without writing through link
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    const symData = join(base, 'sym-data');
    symlinkSync(outside, symData);
    assert.deepEqual(
      evaluateLifecycleEvent(
        { hookEventName: 'PreInvocation', conversationId: convId, cwd: adlcRepo },
        { pluginDataDir: symData, env: {} }
      ),
      {}
    );
    assert.equal(existsSync(join(outside, 'session-state')), false);

    // 9. Cumulative totalStopContinuations cap (<= 2) stops edit->Stop->edit->Stop->edit->Stop loops
    const loopConv = 'conv-loop-cap-99999999';
    for (let round = 1; round <= 3; round++) {
      evaluateLifecycleEvent(
        {
          hookEventName: 'PostToolUse',
          conversationId: loopConv,
          cwd: adlcRepo,
          toolCall: { name: 'edit_file', args: { Path: join(adlcRepo, 'lib', 'widget.mjs') } },
        },
        { pluginDataDir: dataDir, env: {} }
      );
      const stopRes = evaluateLifecycleEvent(
        {
          hookEventName: 'Stop',
          conversationId: loopConv,
          cwd: adlcRepo,
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: false,
          fullyIdle: true,
        },
        { pluginDataDir: dataDir, env: {} }
      );
      if (round <= 2) {
        assert.equal(stopRes.decision, 'continue', `round ${round} should continue`);
      } else {
        assert.deepEqual(stopRes, {}, '3rd cumulative Stop without user turn must cap at {}');
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('node-launcher executes hooks/lifecycle.mjs over stdin/stdout and stageHooksOnlyBoosterPlugin stages hooks/lifecycle.mjs', () => {
  const base = mkdtempSync(join(tmpdir(), 'agb-lifecycle-cli-'));
  try {
    const res = spawnSync(
      '/bin/sh',
      ['bin/node-launcher.sh', 'hooks/lifecycle.mjs', 'PostInvocation'],
      {
        cwd: REPO_ROOT,
        input: JSON.stringify({ conversationId: 'conv-subprocess-123456', hookEventName: 'PostInvocation' }),
        env: { ...process.env, PLUGIN_DATA: join(base, 'pdata') },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout.trim()), {});

    const dstPlugin = join(base, 'staged-booster');
    assert.equal(stageHooksOnlyBoosterPlugin(REPO_ROOT, dstPlugin), true);
    assert.equal(existsSync(join(dstPlugin, 'hooks', 'session-start.mjs')), true);
    assert.equal(existsSync(join(dstPlugin, 'hooks', 'lifecycle.mjs')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
