import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  computeTopologicalWaves,
  compilePlanToWorkflow,
} from '../lib/workflow-emit.mjs';
import { syncOverviewPaneState } from '../lib/overview-pane.mjs';

test('compilePlanToWorkflow generates topological waves, resists quote/command injection, and passes python3 execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-wf-'));
  try {
    const plan = {
      repo: dir,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [
        {
          id: 'T-1',
          title: 'Wave 1 ticket with tricky quotes """ \' $(whoami) `id`',
          body: 'Implement feature A\nLine 2 with \\backslash and "quotes"',
          scope: ['lib/a.mjs'],
          rails: ['lib/lock.mjs'],
          edges: [{ to: 'T-3' }],
          tier: 'mid',
          pool_hint: 'gemini',
        },
        {
          id: 'T-2',
          title: 'Wave 1 parallel ticket',
          body: 'Implement feature B',
          scope: ['lib/b.mjs'],
          rails: ['lib/lock.mjs'],
          edges: [{ to: 'T-3' }],
          tier: 'mid',
          pool_hint: 'claude-gpt',
        },
        {
          id: 'T-3',
          title: 'Wave 2 join ticket',
          body: 'Combine A and B',
          scope: ['lib/c.mjs'],
          rails: ['lib/lock.mjs'],
          edges: [],
          tier: 'frontier',
          pool_hint: 'auto',
        },
      ],
    };

    const waves = computeTopologicalWaves(plan.tickets);
    assert.deepEqual(
      waves.map((w) => w.map((t) => t.id)),
      [['T-1', 'T-2'], ['T-3']]
    );

    const outPy = join(dir, 'workflow.py');
    const res = compilePlanToWorkflow(plan, { outPath: outPy });
    assert.equal(res.ok, true);
    assert.ok(existsSync(outPy));
    assert.deepEqual(res.waves, [['T-1', 'T-2'], ['T-3']]);

    // Execute generated workflow script with python3 to verify valid JSON output & zero injection
    const pyOut = execFileSync('python3', [outPy], { encoding: 'utf8' }).trim();
    const parsed = JSON.parse(pyOut);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.waves, 2);
    assert.deepEqual(parsed.results[0].tickets, ['T-1', 'T-2']);
    assert.deepEqual(parsed.results[1].tickets, ['T-3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncOverviewPaneState writes overview_pane.json and overview_pane.md atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-ov-'));
  try {
    const res = syncOverviewPaneState(
      {
        runId: 'run-v14-test',
        base: 'main',
        tickets: {
          'T-1': { phase: 'merged', model: 'gemini-4-neon-high', strikes: 0, verdict: 'ship' },
          'T-2': { phase: 'building', model: 'claude-sonnet-5-5-medium', strikes: 1 },
        },
      },
      { repo: dir }
    );
    assert.equal(res.ok, true);
    assert.ok(existsSync(res.jsonPath));
    assert.ok(existsSync(res.markdownPath));
    assert.equal(res.payload.mergedCount, 1);
    assert.equal(res.payload.totalTickets, 2);
    assert.match(readFileSync(res.markdownPath, 'utf8'), /T-1/);
    assert.match(readFileSync(res.markdownPath, 'utf8'), /gemini-4-neon-high/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
