#!/usr/bin/env node
// agb — Antigravity Booster orchestrator.
//
//   agb run <plan.json>          execute a ticket DAG (build → gate → prosecute → merge)
//   agb sweep <sweep.json>       same operation × many targets, then run
//   agb review [repo] [ref]      read-only lens fleet over a diff, loop-until-dry
//   agb preflight <plan.json>    plan-time gates: scope overlap + coldstart
//   agb brains                   list Antigravity GUI plan artifacts
//   agb import-brain <id> <repo> convert a GUI plan into plan.json (stdout)
//   agb status [repo]            render the live dashboard for a repo's current run
//   agb probe [widths]           measure pool concurrency/latency, print JSON lines
//   agb validate <plan>          validate a plan file without running anything
//
// Exit codes: 0 = pass, 2 = gate failure / findings, 1 = usage or internal
// error.

import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTicket, topoSort } from '@aidlc/core/tickets';
import { tierCandidates, TIER_CANDIDATES } from '../lib/pools.mjs';
import { runPlan } from '../lib/scheduler.mjs';
import { renderStatus } from '../lib/status.mjs';
import { runAgy } from '../lib/agy.mjs';
import { sweepToPlan } from '../lib/sweep.mjs';
import { reviewFleet, reviewDiff } from '../lib/review.mjs';
import { preflight } from '../lib/preflight.mjs';
import { listBrains, brainToPlan } from '../lib/brain.mjs';
import { PoolSet } from '../lib/pools.mjs';

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
  // Cross-ticket + routability checks validateTicket cannot do alone.
  // Without them `agb validate` blesses plans that crash or corrupt
  // `agb run`: duplicate ids share a worktree/branch, an edge to an unknown
  // id throws mid-run, and an unroutable tier/pool_hint combination (e.g.
  // cheap+claude) used to make the ticket silently vanish from the report.
  const ids = new Set();
  for (const t of plan.tickets ?? []) {
    if (!t.id) continue; // validateTicket already reported the missing id
    if (ids.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of plan.tickets ?? []) {
    for (const e of t.edges ?? []) {
      if (!ids.has(e.to)) errors.push(`${t.id}: edge to unknown ticket '${e.to}'`);
    }
    if (typeof t.body !== 'string' || !t.body.trim()) {
      errors.push(`${t.id}: body (full self-contained spec text) is required — ` +
        `without it the builder charter renders an empty specification`);
    }
    if (!Array.isArray(t.scope) || !t.scope.length) {
      errors.push(`${t.id}: scope must be a non-empty array of globs — ` +
        `an empty scope disables the out-of-scope check entirely`);
    }
    if (t.tier !== undefined && !TIER_CANDIDATES[t.tier]) {
      errors.push(`${t.id}: unknown tier '${t.tier}' (cheap|mid|frontier)`);
    }
    if (t.pool_hint !== undefined && !['gemini', 'claude', 'auto'].includes(t.pool_hint)) {
      errors.push(`${t.id}: unknown pool_hint '${t.pool_hint}' (gemini|claude|auto)`);
    } else if (!tierCandidates(t.tier ?? 'mid', t.pool_hint).length) {
      errors.push(`${t.id}: no model candidates for tier '${t.tier ?? 'mid'}' with pool_hint '${t.pool_hint}'`);
    }
  }
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
  } else if (cmd === 'sweep') {
    const spec = JSON.parse(readFileSync(rest[0] ?? 'sweep.json', 'utf8'));
    if (spec.repo) spec.repo = resolve(spec.repo);
    const plan = sweepToPlan(spec);
    const errors = plan.tickets.flatMap(validateTicket);
    if (!plan.gate || (!plan.gate.build && !plan.gate.test)) errors.push('sweep.gate must declare build/test');
    if (errors.length) {
      console.error('sweep invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    console.error(`sweep: ${plan.tickets.length} targets`);
    const report = await runPlan(plan);
    console.log(JSON.stringify(report, null, 2));
    process.exit(Object.keys(report.failed).length ? 2 : 0);
  } else if (cmd === 'review') {
    const repo = resolve(rest[0] ?? '.');
    const ref = rest[1]; // e.g. main...HEAD, a SHA range; default: uncommitted vs HEAD
    const diff = reviewDiff(repo, ref);
    if (!diff.trim()) {
      console.error('review: empty diff — nothing to prosecute');
      process.exit(0);
    }
    const result = await reviewFleet({ diff, pools: new PoolSet(), log: (m) => console.error(m) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.converged) console.error('review: did NOT converge — diff too large or contested; split it');
    const blocking = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    process.exit(blocking.length || !result.converged ? 2 : 0);
  } else if (cmd === 'preflight') {
    const { plan, errors } = loadPlan(rest[0] ?? 'plan.json');
    if (errors.length) {
      console.error('plan invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    const result = await preflight(plan, { pools: new PoolSet(), skipColdstart: rest.includes('--no-coldstart') });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  } else if (cmd === 'brains') {
    for (const b of listBrains()) console.log(`${b.id}  ${new Date(b.mtime).toISOString().slice(0, 10)}  ${b.title}`);
  } else if (cmd === 'import-brain') {
    const [id, repo] = rest;
    if (!id || !repo) {
      console.error('usage: agb import-brain <conversation-id-or-prefix> <repo-path>');
      process.exit(1);
    }
    const plan = await brainToPlan(id, { repo: resolve(repo) });
    console.log(JSON.stringify(plan, null, 2));
    console.error(`${plan.tickets.length} tickets — review, then: agb preflight && agb run`);
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
    const rows = [];
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
      const row = {
        model, width: n, ok: results.filter((r) => r.ok).length,
        wall_ms: Date.now() - t0, median_ms: lats[Math.floor(lats.length / 2)], max_ms: lats.at(-1),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    // SPEC A2: probe WRITES the calibration artifact (previously stdout-only
    // and the docs were hand-transcribed — adversarial-review LOW). The write
    // is best-effort: a read-only install prefix or full-garbage run must not
    // turn a successful measurement into exit 1. AGB_CALIBRATION_DIR
    // overrides the default (this checkout's docs/calibration/).
    if (rows.some((r) => r.ok > 0)) {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const calDir = process.env.AGB_CALIBRATION_DIR ??
          fileURLToPath(new URL('../docs/calibration/', import.meta.url));
        const calFile = join(calDir, `probe-${day}.md`);
        const table = [
          `## ${model} — probed ${new Date().toISOString()}`,
          '',
          '| width | ok | wall ms | median ms | max ms |',
          '|---|---|---|---|---|',
          ...rows.map((r) => `| ${r.width} | ${r.ok}/${r.width} | ${r.wall_ms} | ${r.median_ms} | ${r.max_ms} |`),
          '',
        ].join('\n');
        mkdirSync(calDir, { recursive: true });
        appendFileSync(calFile, (existsSync(calFile) ? '\n' : `# Pool probe — ${day}\n\n`) + table);
        console.error(`probe: appended ${rows.length} row(s) to ${calFile}`);
      } catch (err) {
        console.error(`probe: could not write calibration artifact (${err.message}) — rows above are still valid`);
      }
    } else {
      console.error('probe: all requests failed — not recording garbage latencies as calibration data');
    }
  } else {
    console.error('usage: agb run|sweep|review|preflight|brains|import-brain|status|validate|probe — see header of bin/agb.mjs');
    process.exit(1);
  }
} catch (err) {
  console.error(`agb: ${err.message}`);
  process.exit(1);
}
