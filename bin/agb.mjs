#!/usr/bin/env node
// agb — Antigravity Booster orchestrator.
//
//   agb run <plan.json>     execute a ticket DAG (build → gate → prosecute → merge)
//   agb status [repo]       render the live dashboard for a repo's current run
//   agb probe [widths]      measure pool concurrency/latency, print JSON lines
//   agb validate <plan>     validate a plan file without running anything
//
// Exit codes: 0 = success / all merged, 2 = gate failure (some tickets
// failed), 1 = usage or internal error.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateTicket, topoSort } from '@aidlc/core/tickets';
import { runPlan } from '../lib/scheduler.mjs';
import { renderStatus } from '../lib/status.mjs';
import { runAgy } from '../lib/agy.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function loadPlan(path) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const errors = [];
  if (!plan.repo) errors.push('plan.repo is required (absolute path to target repo)');
  if (!plan.gate || (!plan.gate.build && !plan.gate.test)) {
    errors.push('plan.gate must declare at least one of build/test commands');
  }
  for (const t of plan.tickets ?? []) errors.push(...validateTicket(t));
  if (!plan.tickets?.length) errors.push('plan.tickets is empty');
  const { cycle } = topoSort(plan.tickets ?? []);
  if (cycle) errors.push(`cycle in ticket DAG: ${cycle.join(', ')}`);
  if (plan.repo) plan.repo = resolve(plan.repo);
  return { plan, errors };
}

try {
  if (cmd === 'run') {
    const { plan, errors } = loadPlan(rest[0] ?? 'plan.json');
    if (errors.length) {
      console.error('plan invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    const report = await runPlan(plan);
    console.log(JSON.stringify(report, null, 2));
    process.exit(Object.keys(report.failed).length ? 2 : 0);
  } else if (cmd === 'status') {
    console.log(renderStatus(resolve(rest[0] ?? '.')));
  } else if (cmd === 'validate') {
    const { errors } = loadPlan(rest[0] ?? 'plan.json');
    if (errors.length) {
      console.error('plan invalid:\n  ' + errors.join('\n  '));
      process.exit(2);
    }
    console.log('plan valid');
  } else if (cmd === 'probe') {
    const widths = (rest[0] ?? '2,4,8').split(',').map(Number);
    const model = rest[1] ?? 'Gemini 3.5 Flash (Low)';
    for (const n of widths) {
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          runAgy({ model, prompt: `Reply with exactly: PONG-${i}`, timeout: '120s' }).then((r) => ({
            ...r, ok: r.ok && r.output.includes(`PONG-${i}`),
          }))
        )
      );
      const lats = results.map((r) => r.ms).sort((a, b) => a - b);
      console.log(JSON.stringify({
        model, width: n, ok: results.filter((r) => r.ok).length,
        wall_ms: Date.now() - t0, median_ms: lats[Math.floor(lats.length / 2)], max_ms: lats.at(-1),
      }));
    }
  } else {
    console.error('usage: agb run <plan.json> | agb status [repo] | agb validate <plan.json> | agb probe [widths] [model]');
    process.exit(1);
  }
} catch (err) {
  console.error(`agb: ${err.message}`);
  process.exit(1);
}
