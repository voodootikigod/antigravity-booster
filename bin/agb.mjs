#!/usr/bin/env node
// agb — Antigravity Booster orchestrator.
// agb — Antigravity Booster orchestrator.

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
import { runDoctor } from '../lib/doctor.mjs';

const rawArgs = process.argv.slice(2);
let project;
const filteredArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--project') {
    project = rawArgs[++i];
  } else {
    filteredArgs.push(rawArgs[i]);
  }
}
const [cmd, ...rest] = filteredArgs;

const COMMANDS = {
  run: { args: '<plan.json>', desc: 'execute a ticket DAG (build → gate → prosecute → merge)' },
  sweep: { args: '<sweep.json>', desc: 'same operation × many targets, then run' },
  review: { args: '[repo] [ref]', desc: 'read-only lens fleet over a diff, loop-until-dry' },
  plan: {
    args: '<id | spec.md> <repo>',
    desc: 'compile an Antigravity brain plan or spec file into plan.json',
    extended: 'convert → validate → overlap/coldstart/parallax gates with feedback loop → advisory premortem',
    flags: '--out <file> --force --no-coldstart --no-parallax --no-premortem'
  },
  preflight: { args: '<plan.json>', desc: 'plan-time gates: scope overlap + coldstart' },
  doctor: { args: '', desc: 'verify your environment and tools' },
  brains: { args: '', desc: 'list Antigravity plan artifacts (GUI + agy sessions)' },
  'import-brain': { args: '<id> <repo>', desc: 'DEPRECATED: raw one-shot conversion (use agb plan)' },
  status: { args: '[repo]', desc: "render the live dashboard for a repo's current run", flags: '--watch [--interval <ms>]' },
  sidecar: { args: '[repo]', desc: 'launch the HTTP server for the Antigravity Sidecar UI', flags: '--unsafe-open [--port <port>]' },
  probe: { args: '[widths]', desc: 'measure pool concurrency/latency, print JSON lines' },
  validate: { args: '<plan>', desc: 'validate a plan file without running anything' },
  bootstrap: { args: '', desc: 'wire ADLC skills into ~/.gemini/skills (aliases: setup, install)' },
  tui: { args: '', desc: 'Removed. Use agb sidecar instead.' }
};

function printUsage() {
  console.log('agb — Antigravity Booster orchestrator.\\n');
  for (const [name, c] of Object.entries(COMMANDS)) {
    const cmdStr = `  agb ${name} ${c.args}`.padEnd(45);
    console.log(`${cmdStr} ${c.desc}`);
    if (c.extended) console.log(`                                              ${c.extended}`);
    if (c.flags) console.log(`                                              (flags: ${c.flags})`);
  }
  console.log('\\nExit codes: 0 = pass, 2 = gate failure / findings, 1 = usage or internal error.');
}

function printCmdUsage(name) {
  const c = COMMANDS[name];
  console.log(`agb ${name} ${c.args}`);
  console.log(`  ${c.desc}`);
  if (c.extended) console.log(`  ${c.extended}`);
  if (c.flags) console.log(`  Flags: ${c.flags}`);
}

// Read from the manifest rather than a second hardcoded copy that can drift
// out of step with the published version.
if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  const target = rest[0];
  if (cmd === 'help' && target && COMMANDS[target]) {
    printCmdUsage(target);
  } else {
    printUsage();
  }
  process.exit(0);
}

if (rest.includes('--help') || rest.includes('-h')) {
  const name = (cmd === 'setup' || cmd === 'install' || cmd === 'skills') ? 'bootstrap' : cmd;
  if (COMMANDS[name]) {
    printCmdUsage(name);
    process.exit(0);
  }
}

if (!COMMANDS[cmd] && cmd !== 'setup' && cmd !== 'install' && cmd !== 'skills') {
  console.error(`agb: unknown command '${cmd}'\\n`);
  console.error(`Usage: agb <command> ...`);
  console.error(`Run 'agb --help' for a list of commands.`);
  process.exit(1);
}

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
    const report = await runPlan(plan, { project });
    console.log(JSON.stringify(report, null, 2));
    process.exit(Object.keys(report.failed).length ? 2 : 0);
  } else if (cmd === 'sweep') {
    const spec = JSON.parse(readFileSync(rest[0] ?? 'sweep.json', 'utf8'));
    if (spec.repo) spec.repo = resolve(spec.repo);
    const plan = sweepToPlan(spec, { project });
    const errors = plan.tickets.flatMap(validateTicket);
    if (!plan.gate || (!plan.gate.build && !plan.gate.test)) errors.push('sweep.gate must declare build/test');
    if (errors.length) {
      console.error('sweep invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    console.error(`sweep: ${plan.tickets.length} targets`);
    const report = await runPlan(plan, { project });
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
    const result = await reviewFleet({ diff, pools: new PoolSet(), log: (m) => console.error(m), project });
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
    const result = await preflight(plan, { pools: new PoolSet(), skipColdstart: rest.includes('--no-coldstart'), project });
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
      project,
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
    const plan = await brainToPlan(id, { repo: resolve(repo), project });
    console.log(JSON.stringify(plan, null, 2));
    console.error(`${plan.tickets.length} tickets — review, then: agb preflight && agb run`);
  } else if (cmd === 'status') {
    const isWatch = rest.includes('--watch');
    let intervalMs = 1000;
    const iIdx = rest.indexOf('--interval');
    if (iIdx !== -1 && rest[iIdx + 1]) intervalMs = parseInt(rest[iIdx + 1], 10);
    const positional = rest.filter((r, i) => !r.startsWith('--') && rest[i - 1] !== '--interval');
    
    if (rest.includes('--ui')) {
      console.error('The --ui TUI flag has been removed. Use the native sidecar dashboard instead (`agb sidecar`).');
      process.exit(1);
    }
    
    if (isWatch) {
      const { watchStatus } = await import('../lib/status.mjs');
      const code = await watchStatus(resolve(positional[0] ?? '.'), intervalMs);
      process.exitCode = code;
    } else {
      console.log(renderStatus(resolve(positional[0] ?? '.')));
    }
  } else if (cmd === 'tui') {
    console.error('The TUI has been removed. Use the native sidecar dashboard instead (`agb sidecar`).');
    process.exit(1);
  } else if (cmd === 'doctor') {
    process.exitCode = await runDoctor();
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
  } else if (cmd === 'sidecar') {
    let portStr = process.env.AGB_SIDECAR_PORT;
    let unsafeOpen = false;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--port') {
        if (i + 1 >= rest.length || rest[i+1].startsWith('--')) {
          console.error('agb: missing value for --port');
          process.exit(1);
        }
        portStr = rest[++i];
      } else if (rest[i] === '--unsafe-open') {
        unsafeOpen = true;
      } else if (rest[i].startsWith('--')) {
        console.error(`agb: unknown flag '${rest[i]}' for sidecar`);
        process.exit(1);
      } else {
        positional.push(rest[i]);
      }
    }
    const port = portStr ? Number(portStr) : 3333;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`agb: invalid port '${portStr}'`);
      process.exit(1);
    }
    if (!unsafeOpen) {
      console.error('agb: The sidecar exposes private run logs (including model error payloads with local paths/secrets) over unauthenticated HTTP.');
      console.error('You must pass --unsafe-open to acknowledge this risk and start the server.');
      process.exit(1);
    }
    const { serveSidecar } = await import('../sidecars/server.mjs');
    const { randomBytes } = await import('node:crypto');
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const token = randomBytes(16).toString('hex');
    const server = await serveSidecar(resolve(positional[0] ?? '.'), port, token);
    
    const actualPort = server.address().port;
    
    let pluginDir;
    let createdDir = false;
    let wroteManifests = false;
    try {
      pluginDir = process.env.AGB_PLUGIN_DIR || join(homedir(), '.gemini', `agb-sidecar-plugin-${process.pid}-${actualPort}`);
      if (!existsSync(pluginDir)) {
        mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
        createdDir = true;
      } else if (existsSync(join(pluginDir, 'plugin.json')) || existsSync(join(pluginDir, 'sidecars', 'agb.json'))) {
        throw new Error(`AGB_PLUGIN_DIR (${pluginDir}) already contains plugin.json or sidecars/agb.json. To prevent data loss, agb will not overwrite an existing plugin manifest. Clear the directory or unset AGB_PLUGIN_DIR.`);
      }
      if (!existsSync(join(pluginDir, 'sidecars'))) {
        mkdirSync(join(pluginDir, 'sidecars'), { recursive: true, mode: 0o700 });
      }
      
      const manifest = {
        id: 'agb-dashboard',
        name: 'AGB Dashboard',
        url: `http://127.0.0.1:${actualPort}/?token=${token}`,
        icon: 'activity',
        description: 'Visualizes parallel build-outs orchestrated by Antigravity Booster.'
      };
      
      writeFileSync(join(pluginDir, 'sidecars', 'agb.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
        id: `agb-sidecar-dynamic-${process.pid}-${actualPort}`,
        name: 'AGB Dynamic Sidecar',
        version: '1.0.0',
        sidecars: ['sidecars/agb.json']
      }, null, 2) + '\n', { mode: 0o600 });
      wroteManifests = true;
      
      const agyBin = process.env.AGB_AGY_BIN || 'agy';
      execFileSync(agyBin, ['plugin', 'install', pluginDir], { stdio: 'inherit' });
      console.log('Successfully registered the dynamic sidecar plugin with Antigravity.');
    } catch (e) {
      console.warn(`Warning: Could not automatically register the sidecar plugin with agy: ${e.message}`);
      console.warn(`The dashboard will not appear. To register it manually, add this manifest to your Antigravity plugins: ${pluginDir}`);
    }
    
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        server.close();
        if (pluginDir) {
          if (createdDir) {
            rmSync(pluginDir, { recursive: true, force: true });
          } else if (wroteManifests) {
            rmSync(join(pluginDir, 'sidecars', 'agb.json'), { force: true });
            rmSync(join(pluginDir, 'plugin.json'), { force: true });
          }
        }
      } catch (e) {}
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', () => {
      if (!cleaned) {
        try {
          if (pluginDir) {
            if (createdDir) rmSync(pluginDir, { recursive: true, force: true });
            else if (wroteManifests) {
              rmSync(join(pluginDir, 'sidecars', 'agb.json'), { force: true });
              rmSync(join(pluginDir, 'plugin.json'), { force: true });
            }
          }
        } catch(e) {}
      }
    });
  } else {
    console.error(`agb: unknown command '${cmd}'\\n`);
    console.error(`Usage: agb <command> ...`);
    console.error(`Run 'agb --help' for a list of commands.`);
    process.exit(1);
  }
} catch (err) {
  console.error(`agb: ${err.message}`);
  process.exit(1);
}
