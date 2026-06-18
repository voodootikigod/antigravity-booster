#!/usr/bin/env node
// agb — Antigravity Booster orchestrator.
//
//   agb run <plan.json>          execute a ticket DAG (build → gate → prosecute → merge)
//   agb sweep <sweep.json>       same operation × many targets, then run
//   agb review [repo] [ref]      read-only lens fleet over a diff, loop-until-dry
//   agb plan <id | spec.md> <repo> compile an Antigravity brain plan or spec file into plan.json
//                                (convert → validate → overlap/coldstart/parallax
//                                gates with feedback loop → advisory premortem;
//                                flags: --out <file> --force --no-coldstart
//                                --no-parallax --no-premortem)
//   agb preflight <plan.json>    plan-time gates: scope overlap + coldstart
//   agb brains                   list Antigravity plan artifacts (GUI + agy sessions)
//   agb import-brain <id> <repo> DEPRECATED: raw one-shot conversion (use agb plan)
//   agb status [repo]            render the live dashboard for a repo's current run
//   agb probe [widths]           measure pool concurrency/latency, print JSON lines
//   agb validate <plan>          validate a plan file without running anything
//   agb bootstrap                wire ADLC skills into ~/.gemini/skills (aliases: setup, install)
//
// Exit codes: 0 = pass, 2 = gate failure / findings, 1 = usage or internal
// error.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTicket } from '@adlc/core/tickets';
import { runPlan } from '../lib/scheduler.mjs';
import { renderStatus } from '../lib/status.mjs';
import { runAgy } from '../lib/agy.mjs';
import { sweepToPlan } from '../lib/sweep.mjs';
import { reviewFleet, reviewDiff } from '../lib/review.mjs';
import { preflight } from '../lib/preflight.mjs';
import { listBrains, brainToPlan } from '../lib/brain.mjs';
import { validatePlan, compilePlan } from '../lib/plan.mjs';
import { PoolSet } from '../lib/pools.mjs';
import { bootstrap } from '../lib/bootstrap.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function loadPlan(path) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  // Cross-ticket + routability checks live in lib/plan.mjs (shared with the
  // plan compiler). Without them `agb validate` blesses plans that crash or
  // corrupt `agb run`.
  const errors = validatePlan(plan);
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
  } else if (cmd === 'plan') {
    // The plan itself is authored in Antigravity (GUI plan mode or an agy
    // planning session) — this command only compiles that artifact.
    const positional = [];
    let out = 'plan.json';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--out') out = rest[++i];
      else if (!rest[i].startsWith('--')) positional.push(rest[i]);
    }
    const [id, repo] = positional;
    if (!id || !repo || !out) {
      console.error('usage: agb plan <brain-id-or-prefix | spec.md> <repo-path> [--out plan.json] [--force] [--no-coldstart] [--no-parallax] [--no-premortem]');
      process.exit(1);
    }
    if (existsSync(out) && !rest.includes('--force')) {
      console.error(`plan: ${out} already exists — pass --force to overwrite ` +
        `(compiled plans are disposable, hand-written ones may not be)`);
      process.exit(1);
    }
    const result = await compilePlan(id, {
      repo: resolve(repo),
      pools: new PoolSet(),
      log: (m) => console.error(m),
      coldstart: !rest.includes('--no-coldstart'),
      parallax: !rest.includes('--no-parallax'),
      premortem: !rest.includes('--no-premortem'),
    });
    console.log(JSON.stringify(result.report, null, 2));
    if (!result.ok) {
      console.error(`plan: NOT compiled — ${result.report.blocking.length} blocking finding(s):`);
      for (const b of result.report.blocking) console.error(`  - ${b}`);
      if (result.brain.sourceType === 'local-spec') {
        console.error(`plan: the fix surface is the plan, not JSON — edit ${result.brain.id} and re-run 'agb plan'`);
      } else {
        console.error(`plan: the fix surface is the plan, not JSON — refine it in Antigravity (brain ${result.brain.id}) and re-run 'agb plan'`);
      }
      process.exit(2);
    }
    writeFileSync(out, JSON.stringify(result.plan, null, 2) + '\n');
    if (result.brain.sourceType === 'local-spec') {
      console.error(`plan: ${result.plan.tickets.length} ticket(s) compiled from spec '${result.brain.title}' → ${out}`);
    } else {
      console.error(`plan: ${result.plan.tickets.length} ticket(s) compiled from brain '${result.brain.title}' → ${out}`);
    }
    const causes = result.report.premortem?.causes ?? [];
    if (causes.length) {
      console.error(`plan: premortem flagged ${causes.length} risk(s) (advisory — full detail in the report above):`);
      for (const c of causes) console.error(`  - [${c.likelihood ?? '?'}] ${c.cause}`);
    }
    console.error(`next: agb run ${out}`);
  } else if (cmd === 'brains') {
    for (const b of listBrains()) console.log(`${b.id}  ${new Date(b.mtime).toISOString().slice(0, 10)}  ${b.title}`);
  } else if (cmd === 'import-brain') {
    const [id, repo] = rest;
    if (!id || !repo) {
      console.error('usage: agb import-brain <conversation-id-or-prefix> <repo-path>');
      process.exit(1);
    }
    console.error('import-brain is deprecated — use `agb plan <id> <repo>` (adds plan gates, feedback loop, and provenance)');
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
  } else if (cmd === 'bootstrap' || cmd === 'setup' || cmd === 'install' || (cmd === 'skills' && ['install', 'setup', 'bootstrap'].includes(rest[0]))) {
    const force = rest.includes('--force') || rest.includes('-f');
    bootstrap({ force });
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
    console.error('usage: agb bootstrap|plan|run|sweep|review|preflight|brains|status|validate|probe — see header of bin/agb.mjs');
    process.exit(1);
  }
} catch (err) {
  console.error(`agb: ${err.message}`);
  process.exit(1);
}
