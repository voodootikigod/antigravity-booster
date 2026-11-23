import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runAgy,
  NdjsonWorkerDaemon,
  buildRoleSettingsProfile,
  StreamWatchdog,
  resolveDynamicEffort,
} from '../lib/agy.mjs';
import {
  runSymbolScopeVerification,
  prepareTicketContextAndTdd,
  resolveTicketGateConfig,
  executeSpeculativeMergeBatch,
  BanditModelRouter,
  syncOverviewPaneState,
} from '../lib/scheduler.mjs';
import { compilePlanToWorkflow } from '../lib/plan.mjs';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';
import { writeAdlcTickets } from '../lib/adlc-bridge.mjs';
import { arbiterPrompt } from '../lib/review.mjs';

const FAKE_AGY = join(process.cwd(), 'test', 'fixtures', 'fake-agy');
const AGB_BIN = join(process.cwd(), 'bin', 'agb.mjs');

test('v1.4 integration: runAgy supports --settings and --effort and re-exports NdjsonWorkerDaemon & StreamWatchdog', async () => {
  assert.equal(typeof NdjsonWorkerDaemon, 'function');
  assert.equal(typeof buildRoleSettingsProfile, 'function');
  assert.equal(typeof StreamWatchdog, 'function');
  assert.equal(typeof resolveDynamicEffort, 'function');

  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-agy-'));
  const settingsOut = join(dir, 'settings.json');
  try {
    const res = await runAgy({
      model: 'gemini-4-neon-medium',
      prompt: 'Reply OK',
      cwd: dir,
      bin: FAKE_AGY,
      useRoleSettings: true,
      role: 'prosecutor',
      effort: 'high',
      worker: { mode: 'readonly' },
      env: { FAKE_SETTINGS_FILE: settingsOut },
    });
    assert.equal(res.ok, true);
    assert.ok(existsSync(settingsOut));
    const parsed = JSON.parse(readFileSync(settingsOut, 'utf8'));
    assert.deepEqual(Object.keys(parsed), ['permissions']);
    assert.ok(Array.isArray(parsed.permissions.deny));
    assert.ok(parsed.permissions.deny.includes('write_file'));
    assert.ok(parsed.permissions.deny.includes('run_command'));
    assert.ok(parsed.permissions.deny.includes('call_mcp_tool'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4 integration: scheduler-verify delegation wrappers orchestrate context slicing, TDD split, symbol verification, delta gates, and speculative merge bisection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-sched-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(
      join(dir, 'lib', 'calc.mjs'),
      'export function add(a, b) {\n  return a + b;\n}\n\nexport function frozenMul(a, b) {\n  return a * b;\n}\n'
    );
    writeFileSync(
      join(dir, 'test', 'calc.test.mjs'),
      'import { add } from "../lib/calc.mjs";\n'
    );

    const ticket = {
      id: 'T-FRONT-1',
      title: 'Enhance calculator',
      tier: 'frontier',
      pool_hint: 'gemini',
      scope: ['lib/calc.mjs', 'test/calc.test.mjs'],
      rails: ['lib/lock.mjs'],
      symbol_scope: ['lib/calc.mjs#add'],
      symbol_rails: ['lib/calc.mjs#frozenMul'],
      body: 'Update add(a, b).',
    };

    const prep = prepareTicketContextAndTdd(ticket, {}, {
      repo: dir,
      builderModel: 'gemini-4-neon-high',
    });
    assert.equal(prep.contextSlice.ok, true);
    assert.equal(prep.tddEnabled, true);
    assert.equal(prep.tddPartition.specPoolHint, 'claude-gpt');
    assert.deepEqual(prep.tddPartition.testScope, ['test/calc.test.mjs']);

    const symPass = runSymbolScopeVerification(
      ticket,
      '--- a/lib/calc.mjs\n+++ b/lib/calc.mjs\n@@ -2,1 +2,1 @@\n-  return a + b;\n+  return Number(a) + Number(b);\n',
      { repo: dir }
    );
    assert.equal(symPass.ok, true);

    const strikeGate = resolveTicketGateConfig(
      { test: 'npm test' },
      ['lib/calc.mjs'],
      { repo: dir, phase: 'strike0' }
    );
    assert.equal(strikeGate.fast, true);
    assert.equal(strikeGate.test, 'node --test test/calc.test.mjs');

    const mergeGate = resolveTicketGateConfig(
      { test: 'npm test' },
      ['lib/calc.mjs'],
      { repo: dir, phase: 'merge' }
    );
    assert.equal(mergeGate.fast, false);
    assert.equal(mergeGate.test, 'npm test');

    // Speculative merge batch with 1 poison ticket ("T-BAD") isolated via bisection
    const ready = [
      { id: 'T-OK1', scope: ['lib/a.mjs'], changedFiles: ['lib/a.mjs'] },
      { id: 'T-BAD', scope: ['lib/b.mjs'], changedFiles: ['lib/b.mjs'] },
      { id: 'T-OK2', scope: ['lib/c.mjs'], changedFiles: ['lib/c.mjs'] },
    ];
    const batchRes = await executeSpeculativeMergeBatch(
      ready,
      async (batch) => {
        const hasBad = batch.some((t) => t.id === 'T-BAD');
        return hasBad ? { ok: false, error: 'T-BAD failed gate' } : { ok: true };
      },
      { repo: null, maxBatchSize: 4 }
    );
    assert.deepEqual(batchRes.merged.sort(), ['T-OK1', 'T-OK2']);
    assert.equal(batchRes.failed.length, 1);
    assert.equal(batchRes.failed[0].id, 'T-BAD');

    const ov = syncOverviewPaneState(
      { runId: 'run-1', tickets: { 'T-OK1': { phase: 'merged' } } },
      { repo: dir }
    );
    assert.equal(ov.ok, true);

    const router = new BanditModelRouter({ statsFile: join(dir, 'stats.jsonl') });
    router.recordOutcome({ model: 'gemini-4-neon-high', strike0Pass: true });
    assert.equal(router.readRecords().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4 integration: CLI `agb distill --json` and `compilePlanToWorkflow` execute cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-cli-'));
  try {
    mkdirSync(join(dir, '.booster'), { recursive: true });
    writeFileSync(
      join(dir, '.booster', 'review.json'),
      JSON.stringify({
        findings: [
          { lens: 'security', severity: 'high', claim: 'Missing boundary check at line 10' },
          { lens: 'security', severity: 'high', claim: 'Missing boundary check at line 95' },
        ],
      })
    );

    const out = execFileSync(process.execPath, [AGB_BIN, 'distill', dir, '--apply', '--json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.recurringCount, 1);
    assert.equal(parsed.applied, true);
    assert.ok(existsSync(join(dir, '.gemini', 'rules', 'adlc-learned.md')));

    const wfPath = join(dir, 'wf.py');
    const wf = compilePlanToWorkflow(
      {
        repo: dir,
        base: 'main',
        gate: { test: 'npm test' },
        tickets: [
          {
            id: 'T-1',
            title: 'First ticket',
            body: 'Do work',
            scope: ['lib/a.mjs'],
            rails: ['lib/lock.mjs'],
            edges: [],
          },
        ],
      },
      { outPath: wfPath }
    );
    assert.equal(wf.ok, true);
    assert.ok(existsSync(wfPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4 integration: PreToolUse hook enforces CodeGraph explore and agb_distill policies, and arbiterPrompt compacts oversized payloads', () => {
  const ws = mkdtempSync(join(tmpdir(), 'agb-v14-hook-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'agb-v14-outside-'));
  try {
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeAdlcTickets(ws, [
      { id: 'T-V14-1', title: 'Test ticket', body: 'Test', scope: ['lib/**'], rails: ['lib/lock.mjs'] },
    ]);
    for (const toolName of [
      'codegraph_explore',
      'mcp_codegraph_codegraph_explore',
      'mcp__codegraph__codegraph_explore',
    ]) {
      // Interactive session allows in-workspace queries
      const interactiveAllowed = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: {} }
      );
      assert.equal(interactiveAllowed.decision, 'pass', `${toolName} inside workspace must be allowed interactively`);

      // Headless/readonly sessions deny by default
      const workerDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: { AGB_WORKER_TICKET: 'T-V14-1' } }
      );
      assert.equal(workerDenied.decision, 'deny', `${toolName} must be denied in headless worker by default`);

      const readonlyDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: { AGB_WORKER_MODE: 'readonly' } }
      );
      assert.equal(readonlyDenied.decision, 'deny', `${toolName} must be denied in readonly worker by default`);

      // Headless session with explicit AGB_ALLOW_CODEGRAPH_MCP=1 allows in-workspace queries
      const optInAllowed = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: { AGB_WORKER_TICKET: 'T-V14-1', AGB_ALLOW_CODEGRAPH_MCP: '1' } }
      );
      assert.equal(optInAllowed.decision, 'pass', `${toolName} inside workspace must be allowed with AGB_ALLOW_CODEGRAPH_MCP=1`);

      // Out-of-workspace path is denied both interactively and with AGB_ALLOW_CODEGRAPH_MCP=1
      const outsideInteractive = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: outsideDir, query: 'secret' },
          },
        },
        { env: {} }
      );
      assert.equal(outsideInteractive.decision, 'deny', `${toolName} outside workspace must be denied interactively`);

      const outsideOptIn = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: outsideDir, query: 'secret' },
          },
        },
        { env: { AGB_WORKER_TICKET: 'T-V14-1', AGB_ALLOW_CODEGRAPH_MCP: '1' } }
      );
      assert.equal(outsideOptIn.decision, 'deny', `${toolName} outside workspace must be denied even with AGB_ALLOW_CODEGRAPH_MCP=1`);

      // Protected boosterDataRoots is denied both interactively and with AGB_ALLOW_CODEGRAPH_MCP=1
      const denied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: {
              projectPath: join(ws, '.config', 'antigravity-booster'),
              query: 'secret',
            },
          },
        },
        { home: ws, env: { AGB_WORKER_TICKET: 'T-V14-1', AGB_ALLOW_CODEGRAPH_MCP: '1' } }
      );
      assert.equal(denied.decision, 'deny', `${toolName} on protected booster data root must be denied`);
    }

    // agb_distill: allowed interactively, denied in readonly and headless worker modes
    const distillRes = evaluatePayload(
      {
        workspacePaths: [ws],
        toolCall: {
          name: 'mcp__agb__agb_distill',
          args: { repo: ws },
        },
      },
      { env: {} }
    );
    assert.equal(distillRes.decision, 'pass');

    for (const env of [{ AGB_WORKER_MODE: 'readonly' }, { AGB_WORKER_TICKET: 'T-V14-1' }]) {
      const directDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: 'mcp__agb__agb_distill',
            args: { repo: ws, apply: false },
          },
        },
        { env }
      );
      assert.equal(directDenied.decision, 'deny', `mcp__agb__agb_distill must be denied under ${JSON.stringify(env)}`);

      const callMcpDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'agb', ToolName: 'agb_distill', Arguments: { repo: ws } },
          },
        },
        { env }
      );
      assert.equal(callMcpDenied.decision, 'deny', `call_mcp_tool(agb, agb_distill) must be denied under ${JSON.stringify(env)}`);
    }

    const hugeContext = 'A'.repeat(25000);
    const hugeFindings = Array.from({ length: 70 }, (_, i) => ({
      id: `fp-${i}`,
      lens: 'correctness',
      severity: 'high',
      file: 'lib/a.mjs',
      line: i + 1,
      claim: 'C'.repeat(800),
      evidence: 'E'.repeat(800),
    }));
    const prompt = arbiterPrompt(hugeFindings, { targetType: 'plan', context: hugeContext });
    assert.ok(prompt.includes('...(truncated)'), 'oversized context must be compacted');
    assert.ok(!prompt.includes('fp-65'), 'findings list must be capped at 60 items');
    assert.ok(prompt.length < 90000, `compacted prompt length (${prompt.length}) must stay bounded`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
