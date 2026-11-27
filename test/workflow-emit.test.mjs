import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  computeTopologicalWaves,
  compilePlanToWorkflow,
} from '../lib/workflow-emit.mjs';
import { syncOverviewPaneState } from '../lib/overview-pane.mjs';

test('compilePlanToWorkflow generates async /run-workflow waves, defaults to workspace="inherit", resists injection, and executes under python3', () => {
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
          tier: 'cheap',
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
    assert.equal(res.workspaceMode, 'inherit');
    assert.equal(res.syntaxVerified, true);
    assert.ok(existsSync(outPy));
    assert.deepEqual(res.waves, [['T-1', 'T-2'], ['T-3']]);
    assert.match(res.script, /TICKET_RESULT_SCHEMA/);
    assert.match(res.script, /WORKSPACE_MODE = "inherit"/);

    // 1. Standalone dry-run execution via python3
    const pyOut = execFileSync('python3', [outPy], { encoding: 'utf8' }).trim();
    const parsed = JSON.parse(pyOut);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.workspace, 'inherit');
    assert.equal(parsed.waves, 2);
    assert.deepEqual(parsed.results[0].tickets, ['T-1', 'T-2']);
    assert.deepEqual(parsed.results[1].tickets, ['T-3']);
    assert.equal(parsed.results[0].outcomes[0].model, 'gemini-4-hydrogen-medium');
    assert.equal(parsed.results[0].outcomes[1].model, 'claude-sonnet-5-5-medium');
    assert.equal(parsed.results[1].outcomes[0].model, 'gemini-4-neon-high');

    // 2. Simulated Antigravity /run-workflow execution with async parallel(items, fn) & async agent(..., schema=...)
    const harnessDriver = join(dir, 'run_harness_sim.py');
    writeFileSync(
      harnessDriver,
      [
        'import asyncio, importlib.util, json, sys',
        `spec = importlib.util.spec_from_file_location("wf", ${JSON.stringify(outPy)})`,
        'wf = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(wf)',
        'calls = []',
        'phases = []',
        'async def fake_phase(label):',
        '    phases.append(label)',
        'async def fake_parallel(items, fn):',
        '    return await asyncio.gather(*(fn(x) for x in items))',
        'async def fake_agent(*, prompt, schema, role, type_name, workspace, model):',
        '    calls.append({"role": role, "type_name": type_name, "workspace": workspace, "model": model, "schema_req": schema.get("required")})',
        '    return {"ticket_id": role.split()[-1], "status": "DONE", "summary": "ok"}',
        'out = asyncio.run(wf.execute_workflow_async(agent_fn=fake_agent, parallel_fn=fake_parallel, phase_fn=fake_phase))',
        'print(json.dumps({"out": out, "calls": calls, "phases": phases}))',
      ].join('\n'),
      'utf8'
    );
    const simOut = JSON.parse(execFileSync('python3', [harnessDriver], { encoding: 'utf8' }).trim());
    assert.equal(simOut.out.ok, true);
    assert.deepEqual(simOut.phases, ['Wave 1', 'Wave 2']);
    assert.equal(simOut.calls.length, 3);
    for (const c of simOut.calls) {
      assert.equal(c.workspace, 'inherit');
      assert.equal(c.type_name, 'self');
      assert.deepEqual(c.schema_req, ['ticket_id', 'status', 'summary']);
    }

    // 3. Supports 'share' and 'branch' workspace modes, mid-tier Gemini default, and rejects invalid workspaceMode and cycles
    assert.match(
      compilePlanToWorkflow({ repo: dir, gate: { test: 'npm test' }, tickets: [{ id: 'T-MID', title: 'm', body: 'b', scope: ['lib/m.mjs'] }] }).script,
      /gemini-4-neon-medium/
    );
    assert.equal(compilePlanToWorkflow(plan, { workspaceMode: 'share' }).workspaceMode, 'share');
    assert.equal(compilePlanToWorkflow(plan, { workspaceMode: 'branch' }).workspaceMode, 'branch');
    assert.throws(
      () => compilePlanToWorkflow(plan, { workspaceMode: 'invalid-mode' }),
      /Invalid workflow workspaceMode/
    );
    assert.throws(
      () =>
        computeTopologicalWaves([
          { id: 'A', edges: [{ to: 'B' }] },
          { id: 'B', edges: [{ to: 'A' }] },
        ]),
      /cycle detected/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compilePlanToWorkflow manage_worktrees provisions git worktree and invokes agb gate-ticket', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-wf-git-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'init\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const fakeAgb = join(repo, 'fake-agb.sh');
    writeFileSync(fakeAgb, '#!/bin/sh\nprintf \'{"ok":true,"args":"%s"}\\n\' "$*"\n', { mode: 0o755 });

    const plan = {
      repo,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [
        {
          id: 'T-WT1',
          title: 'Worktree test',
          body: 'Write a.txt',
          scope: ['a.txt'],
          rails: [],
          edges: [],
          tier: 'frontier',
          pool_hint: 'claude',
        },
      ],
    };

    const outPy = join(repo, 'wf-wt.py');
    compilePlanToWorkflow(plan, { outPath: outPy, agbBin: fakeAgb, workspaceMode: 'share' });
    const driver = join(repo, 'drive_wt.py');
    writeFileSync(
      driver,
      [
        'import importlib.util, json',
        `spec = importlib.util.spec_from_file_location("wf", ${JSON.stringify(outPy)})`,
        'wf = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(wf)',
        'def sync_agent(**kwargs):',
        '    return {"ticket_id": "T-WT1", "status": "DONE", "summary": kwargs["prompt"][:40]}',
        'res = wf.execute_workflow(agent_fn=sync_agent, manage_worktrees=True)',
        'outcome = res["results"][0]["outcomes"][0]',
        'wf.remove_ticket_worktree(outcome["worktree"])',
        'print(json.dumps(res))',
      ].join('\n'),
      'utf8'
    );
    const parsed = JSON.parse(execFileSync('python3', [driver], { encoding: 'utf8' }).trim());
    assert.equal(parsed.workspace, 'share');
    const outcome = parsed.results[0].outcomes[0];
    assert.equal(outcome.model, 'claude-sonnet-5-5-high');
    assert.equal(outcome.gate.ok, true);
    assert.match(outcome.gate.stdout, /gate-ticket T-WT1 --worktree/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
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
