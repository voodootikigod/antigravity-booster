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
    assert.equal(parsed.mode, 'readonly');
    assert.equal(parsed.mcpServersDisabled, true);
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
