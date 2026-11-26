#!/usr/bin/env node
// agb — Antigravity Booster orchestrator.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runPlan } from '../lib/scheduler.mjs';
import { renderStatus } from '../lib/status.mjs';
import { runAgy } from '../lib/agy.mjs';
import { sweepToPlan } from '../lib/sweep.mjs';
import { reviewFleet, reviewDiff, reviewPlan, loadPriorFindings, savePriorFindings } from '../lib/review.mjs';
import { DECISION_PROVIDERS } from '../lib/decision-engine.mjs';
import { preflight } from '../lib/preflight.mjs';
import { listBrains, brainToPlan } from '../lib/brain.mjs';
import { validatePlan, compilePlan, compilePlanToWorkflow } from '../lib/plan.mjs';
import { distillRunDefenses } from '../lib/distill.mjs';
import {
  resolveHoldoutDir,
  listHoldoutScenarios,
  cleanHoldoutScenarios,
  runHoldoutScenarios,
} from '../lib/holdout.mjs';
import { PoolSet, drainPools } from '../lib/pools.mjs';
import { bootstrap } from '../lib/bootstrap.mjs';
import { runDoctor, runInit } from '../lib/doctor.mjs';
import { resolveAgyBinary } from '../lib/plugin-paths.mjs';
import { ROLE_MODELS } from '../lib/models.mjs';
import { runShapeCli } from '../lib/shape.mjs';
import { extractPositionalArgs, sanitizeRemoteUrl } from '../lib/plan-integrity.mjs';
import {
  parseAgyStatusPayload,
  renderCliStatusLine,
  renderCliWindowTitle,
  installCliStatusLineSettings,
  uninstallCliStatusLineSettings,
} from '../lib/cli-statusline.mjs';
import {
  buildAcceptanceDossier,
  formatAcceptanceDossierMarkdown,
  writeAcceptDossierFile,
} from '../lib/accept.mjs';
import { runInteractiveAcceptTui } from '../lib/accept-tui.mjs';
import { normalizeMuxName } from '../lib/mux.mjs';

const rawArgs = process.argv.slice(2);
let project;
const filteredArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--project') {
    if (i + 1 >= rawArgs.length || rawArgs[i + 1].startsWith('--')) {
      console.error('agb: missing value for --project');
      process.exit(1);
    }
    project = rawArgs[++i];
  } else if (rawArgs[i].startsWith('--project=')) {
    const val = rawArgs[i].slice('--project='.length);
    if (!val) {
      console.error('agb: missing value for --project');
      process.exit(1);
    }
    project = val;
  } else {
    filteredArgs.push(rawArgs[i]);
  }
}
const [cmd, ...rest] = filteredArgs;

const COMMANDS = {
  run: {
    args: '<plan.json>',
    desc: 'execute a ticket DAG (build → gate → prosecute → merge)',
    flags: '[-c <n> (cap concurrent workers)] [--resume (skip already-merged tickets)] [--reset-rescue (clear rescue locks)]'
  },
  rescue: {
    args: '<ticket-id> [repo]',
    desc: 'launch an interactive clean-host agy rescue session for a failed ticket and verify/merge on exit',
    flags: '[--continue (reuse preserved worktree)] [--plan <plan.json> (explicit plan path)]'
  },
  accept: {
    args: '[repo]',
    desc: 'inspect candidate hunks, external-caller blast radius, and gate evidence for ADLC P6 sign-off',
    flags: '[--base <ref> (git base ref)] [--json (emit JSON)] [--markdown <file> (write PR dossier)]'
  },
  statusline: {
    args: '[render|title|install|uninstall]',
    desc: 'render or configure the ambient agy CLI statusLine and terminal title HUD',
    flags: '[--force (overwrite custom statusLine/title commands)]'
  },
  sweep: { args: '<sweep.json>', desc: 'same operation × many targets, then run' },
  review: {
    args: '[repo] [ref]',
    desc: 'read-only lens fleet over a diff or plan spec (single-pass by default)',
    flags: '[--plan <spec.md> (run 5-lens Plan ARL)] [--loop (iterative Plan ARL up to 3 rounds)] [--five-lens (use 5-lens Code ARL)] [--no-arbiter (skip neutral arbiter)] [--thorough (enable multi-dry convergence)] [--dry-rounds <n> (consecutive dry rounds required)] [--seams-only (review cross-ticket seams only)] [--plan-file <plan.json> (load ticketScopes for --seams-only)] [--delta <base-ref> (review only fix delta since ref)] [--prior-findings <path> (path to persisted prior findings JSON)] [--no-codegraph (disable CodeGraph context slicing)] [--no-decision-engine (disable System-1 decision engine)]'
  },
  shape: {
    args: '<spec.md | id> [repo]',
    desc: 'deterministically pre-analyze a structured spec or brain plan for DAG validity, scope overlaps, and import coupling before agb plan',
    flags: '[--analyze (pre-analyze spec)] [--json (emit JSON)] [--sync-brain (sync to brain and .booster)] [--max-ticket-scope <n> (warn above n files)] [--strict (fail on warnings)]'
  },
  plan: {
    args: '<id | spec.md> [repo]',
    desc: 'compile an Antigravity brain plan or spec file into plan.json',
    extended: 'convert → validate → overlap/coldstart/parallax gates with feedback loop → advisory premortem',
    flags: '[--estimate (forecast quota burn without writing files)] [--json (emit JSON)] [--out <file> (output plan path)] [--emit-workflow <file.py> (emit native run_workflow script)] [--force (overwrite existing)] [--decompose (split wide tickets)] [--max-ticket-scope <n> (max files per ticket)] [--no-fast-path (force LLM conversion)] [--no-coldstart (skip coldstart)] [--no-parallax (skip parallax)] [--no-premortem (skip premortem)]'
  },
  distill: {
    args: '[repo]',
    desc: 'scan run/review findings for recurring patterns and stage or apply learned ADLC defenses',
    flags: '[--apply (write compacted rules to .gemini/rules/adlc-learned.md)] [--compile-checks (emit .adlc/learned-checks.json invariants)] [--json (emit JSON)]'
  },
  holdout: {
    args: '<list|run|clean> [repo]',
    desc: 'inspect metadata, execute sanitized P5 checks, or clean sealed Dark-Factory holdout scenarios',
    flags: '[--ticket <id> (scope to ticket)] [--run-id <id> (scope to run)] [--json (emit JSON)]'
  },
  preflight: {
    args: '<plan.json>',
    desc: 'plan-time gates: scope overlap + coldstart',
    flags: '--no-coldstart (skip coldstart plan gate), --force-coldstart (ignore cached coldstart hashes)'
  },
  doctor: { args: '[repo]', desc: 'verify your environment and tools', flags: '[--fix (auto-repair setup)]' },
  brains: { args: '', desc: 'list Antigravity plan artifacts (GUI + agy sessions)' },
  'import-brain': { args: '<id> <repo>', desc: 'DEPRECATED: raw one-shot conversion (use agb plan)' },
  status: {
    args: '[repo]',
    desc: "render the live dashboard for a repo's current run",
    flags: '[--watch (watch mode)] [-w (watch mode)] [--interval <ms> (poll interval)] [--tui (render TUI snapshot)] [--follow (keep watching after run completion)] [--compact (compact rows)]'
  },
  watch: {
    args: '[repo]',
    desc: 'launch the interactive live terminal TUI dashboard',
    flags: '[--interval <ms> (refresh interval)] [--follow (keep watching after run completion)] [--compact (compact rows)] [--mux (open split pane in tmux/cmux/herdr)] [--mux=<tmux|cmux|herdr> (explicit mux)] [--no-alerts (disable OSC 9 attention alerts)]'
  },
  init: {
    args: '[repo]',
    desc: 'initialize a target repository for ADLC and agb (.adlc/config.json, specs/feature-template.md, .gitignore)',
    flags: '[--with-codegraph (add .codegraph/ to .gitignore, run codegraph init, enable in config)] [--decision-provider <jev|gemini-decisions|kev> (configure System-1 decision engine provider)]'
  },
  'sync-models': {
    args: '',
    desc: 'audit live agy models output against lib/models.mjs',
    flags: '[--check (exit 1 on drift)] [--offline (skip live CLI probe)] [--json (emit JSON)] [--write (update references/models.json)]'
  },
  sidecar: { args: '[repo]', desc: 'launch the HTTP server for the Antigravity Sidecar UI', flags: '[--port <port>]' },
  probe: { args: '[widths] [model]', desc: 'measure pool concurrency/latency, print JSON lines; appends results to $AGB_CALIBRATION_DIR or ./docs/calibration/probes-<day>.md' },
  validate: { args: '<plan>', desc: 'validate a plan file without running anything' },
  bootstrap: { args: '[--force] [--force-reinstall]', desc: 'install adlc-antigravity, ~/.local/bin/agb shim, booster skills, and CLI statusLine/title settings (aliases: setup, install)' },
  migrate: {
    args: '[--rollback]',
    desc: 'move an npm-global/checkout install onto the native agy plugin, or roll it back',
    flags: '--force (re-run after MIGRATED) --rollback --force-rollback --break-lock [--force]'
  },
  pool: { args: 'drain [repo]', desc: 'safely drain active leases and reset coordinator' },
  tui: { args: '', desc: 'Removed. Use agb sidecar or agb watch instead.' }
};

function printUsage() {
  console.log('agb — Antigravity Booster orchestrator.\n');
  for (const [name, c] of Object.entries(COMMANDS)) {
    const cmdStr = `  agb ${name} ${c.args}`.padEnd(45);
    console.log(`${cmdStr} ${c.desc}`);
    if (c.extended) console.log(`                                              ${c.extended}`);
    if (c.flags) console.log(`                                              (flags: ${c.flags})`);
  }
  console.log('\nExit codes: 0 = pass, 2 = gate failure / findings, 1 = usage or internal error.');
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
  const repoCwd = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(repoCwd, 'package.json'), 'utf8'));
  if (rest.includes('--verbose') || rest.includes('-v') || rest.includes('--provenance')) {
    let commit = null;
    let date = null;
    let remote = null;
    try {
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoCwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
      date = execFileSync('git', ['log', '-1', '--format=%cd', '--date=short'], { cwd: repoCwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
      remote = sanitizeRemoteUrl(
        execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoCwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
      );
    } catch {}
    if (commit && date) {
      console.log(`antigravity-booster v${pkg.version} (${commit} ${date})${remote ? ` [remote: ${remote}]` : ''}`);
    } else {
      console.log(`antigravity-booster v${pkg.version}`);
    }
  } else {
    console.log(pkg.version);
  }
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
  console.error(`agb: unknown command '${cmd}'\n`);
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

function rejectUnknownFlags(cmdName, tokens, allowedBoolFlags, allowedValueFlags = new Set()) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (allowedValueFlags.has(token)) {
      if (i + 1 >= tokens.length || tokens[i + 1].startsWith('--')) {
        console.error(`agb: missing value for ${token}`);
        process.exit(1);
      }
      i += 1;
      continue;
    }
    if (allowedBoolFlags.has(token)) continue;
    if (token.startsWith('-') && token !== '-') {
      console.error(`agb: unknown flag '${token}' for ${cmdName}`);
      process.exit(1);
    }
  }
}

function parseIntervalFlag(tokens, defaultMs) {
  let intervalMs = defaultMs;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--interval') {
      const val = tokens[i + 1];
      if (val === undefined || val.startsWith('--')) {
        console.error('agb: missing value for --interval');
        process.exit(1);
      }
      if (!/^\d+$/.test(val) || Number(val) < 1) {
        console.error(`agb: invalid --interval '${val}' (expected positive integer milliseconds >= 1)`);
        process.exit(1);
      }
      intervalMs = Number(val);
      i += 1;
    }
  }
  return intervalMs;
}

try {
  if (cmd === 'run') {
    let concurrency;
    let planPath = 'plan.json';
    let resume = false;
    let resetRescue = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-c') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for -c');
          process.exit(1);
        }
        concurrency = parseInt(rest[++i], 10);
        if (!Number.isInteger(concurrency) || concurrency <= 0) {
          console.error(`agb: invalid concurrency '${rest[i]}'`);
          process.exit(1);
        }
      } else if (rest[i] === '--resume') {
        resume = true;
      } else if (rest[i] === '--reset-rescue') {
        resetRescue = true;
      } else if (rest[i].startsWith('-')) {
        console.error(`agb: unknown flag '${rest[i]}' for run`);
        process.exit(1);
      } else if (planPath === 'plan.json') {
        planPath = rest[i];
      }
    }
    const { plan, errors } = loadPlan(planPath);
    if (errors.length) {
      console.error('plan invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    const report = await runPlan(plan, { project, concurrency, resume, resetRescue });
    console.log(JSON.stringify(report, null, 2));
    process.exit((Object.keys(report.failed).length > 0 || Boolean(report.compromised)) ? 2 : 0);
  } else if (cmd === 'rescue') {
    rejectUnknownFlags('rescue', rest, new Set(['--continue']), new Set(['--plan']));
    let planPath;
    const pIdx = rest.indexOf('--plan');
    if (pIdx !== -1) {
      if (pIdx + 1 >= rest.length || rest[pIdx + 1].startsWith('-')) {
        console.error('agb: missing value for --plan');
        process.exit(1);
      }
      planPath = rest[pIdx + 1];
    }
    const positional = extractPositionalArgs(rest, new Set(['--plan']));
    const ticketId = positional[0];
    const repoArg = positional[1] ?? '.';
    if (!ticketId) {
      console.error('usage: agb rescue <ticket-id> [repo] [--continue] [--plan <plan.json>]');
      process.exit(1);
    }
    const { runInteractiveRescue } = await import('../lib/rescue.mjs');
    const res = await runInteractiveRescue(resolve(repoArg), ticketId, {
      continueExisting: rest.includes('--continue'),
      ...(planPath ? { planPath } : {}),
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok || res.merged !== true) {
      if (res.error) console.error(`rescue: ${res.error}`);
      process.exit(2);
    }
    process.exit(0);
  } else if (cmd === 'statusline') {
    rejectUnknownFlags('statusline', rest, new Set(['--force']));
    const positional = extractPositionalArgs(rest);
    const sub = positional[0] ?? 'render';
    if (!['render', 'title', 'install', 'uninstall'].includes(sub)) {
      console.error(`agb: unknown statusline action '${sub}'. Expected render, title, install, or uninstall.`);
      process.exit(1);
    }
    if (sub === 'render' || sub === 'title') {
      let raw = '';
      if (!process.stdin.isTTY) {
        try {
          raw = readFileSync(0, 'utf8');
        } catch {}
      }
      const payload = parseAgyStatusPayload(raw);
      const out = sub === 'render' ? renderCliStatusLine(payload) : renderCliWindowTitle(payload);
      if (out) process.stdout.write(`${out}\n`);
      process.exit(0);
    }
    if (sub === 'install') {
      const res = installCliStatusLineSettings({ force: rest.includes('--force') });
      if (!res.ok) {
        console.error(`agb statusline: ${res.warning || 'failed to update settings.json'}`);
        process.exit(1);
      }
      console.log(`configured statusLine and title in ${res.settingsPath}${res.skipped ? ' (preserved custom command; pass --force to overwrite)' : ''}`);
      process.exit(0);
    }
    const res = uninstallCliStatusLineSettings({});
    if (!res.ok && res.warning) {
      console.error(`agb statusline: ${res.warning}`);
      process.exit(1);
    }
    console.log(`uninstalled statusLine and title from ${res.settingsPath}`);
    process.exit(0);
  } else if (cmd === 'sweep') {
    rejectUnknownFlags('sweep', rest, new Set());
    const spec = JSON.parse(readFileSync(rest[0] ?? 'sweep.json', 'utf8'));
    if (spec.repo) spec.repo = resolve(spec.repo);
    const plan = sweepToPlan(spec, { project });
    const errors = validatePlan(plan);
    if (errors.length) {
      console.error('sweep invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    console.error(`sweep: ${plan.tickets.length} targets`);
    const report = await runPlan(plan, { project });
    console.log(JSON.stringify(report, null, 2));
    process.exit((Object.keys(report.failed).length > 0 || Boolean(report.compromised)) ? 2 : 0);
  } else if (cmd === 'review') {
    const REVIEW_BOOL_FLAGS = new Set([
      '--loop',
      '--five-lens',
      '--5-lens',
      '--no-arbiter',
      '--thorough',
      '--seams-only',
      '--no-codegraph',
      '--no-decision-engine',
    ]);
    const REVIEW_VALUE_FLAGS = new Set([
      '--plan',
      '--dry-rounds',
      '--plan-file',
      '--delta',
      '--prior-findings',
    ]);
    rejectUnknownFlags('review', rest, REVIEW_BOOL_FLAGS, REVIEW_VALUE_FLAGS);
    let planSpec = null;
    let dryRounds;
    let planFileArg = null;
    let deltaRef = null;
    let priorFindingsPath = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--plan') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --plan');
          process.exit(1);
        }
        planSpec = rest[++i];
      } else if (rest[i] === '--dry-rounds') {
        const val = rest[i + 1];
        if (val === undefined || val.startsWith('-')) {
          console.error('agb: missing value for --dry-rounds');
          process.exit(1);
        }
        if (!/^\d+$/.test(val) || Number(val) < 1) {
          console.error(`agb: invalid --dry-rounds '${val}' (expected positive integer >= 1)`);
          process.exit(1);
        }
        dryRounds = Number(val);
        i += 1;
      } else if (rest[i] === '--plan-file') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --plan-file');
          process.exit(1);
        }
        planFileArg = rest[++i];
      } else if (rest[i] === '--delta') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --delta');
          process.exit(1);
        }
        deltaRef = rest[++i];
      } else if (rest[i] === '--prior-findings') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --prior-findings');
          process.exit(1);
        }
        priorFindingsPath = rest[++i];
      }
    }
    const isLoop = rest.includes('--loop');
    const isFiveLens = rest.includes('--five-lens') || rest.includes('--5-lens');
    const noArbiter = rest.includes('--no-arbiter');
    const isThorough = rest.includes('--thorough');
    const seamsOnly = rest.includes('--seams-only');
    const noCodegraph = rest.includes('--no-codegraph');
    const noDecisionEngine = rest.includes('--no-decision-engine');
    const positional = extractPositionalArgs(rest, REVIEW_VALUE_FLAGS);
    const repo = resolve(positional[0] ?? '.');

    let ticketScopes = null;
    if (planFileArg) {
      const resolvedPlanFile = existsSync(resolve(planFileArg)) ? resolve(planFileArg) : resolve(repo, planFileArg);
      let parsedPlan;
      try {
        parsedPlan = JSON.parse(readFileSync(resolvedPlanFile, 'utf8'));
      } catch (err) {
        console.error(`agb: failed to read --plan-file '${planFileArg}': ${err.message}`);
        process.exit(1);
      }
      if (!parsedPlan || typeof parsedPlan !== 'object' || !Array.isArray(parsedPlan.tickets)) {
        console.error(`agb: invalid --plan-file '${planFileArg}' (missing tickets array)`);
        process.exit(1);
      }
      ticketScopes = parsedPlan.tickets
        .filter((t) => t && typeof t.id === 'string' && Array.isArray(t.scope) && t.scope.length > 0)
        .map((t) => ({ id: t.id, scope: t.scope.filter((s) => typeof s === 'string' && s.trim()) }));
    }

    const pools = new PoolSet(undefined, { repo });
    const quotaRes = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || 'agy', {
      allowStatusCache: !process.env.AGB_AGY_BIN,
    });
    if (!quotaRes.ok) {
      console.error(`review: quota telemetry unavailable from agy: ${quotaRes.error}`);
      process.exit(1);
    }

    if (planSpec) {
      const result = await reviewPlan({
        specPath: resolve(repo, planSpec),
        repo,
        pools,
        loop: isLoop,
        maxRounds: isLoop ? 3 : 1,
        arbiter: !noArbiter,
        ...(noDecisionEngine ? { decisionEngine: false } : {}),
        log: (m) => console.error(m),
        project,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 2);
    }

    const ref = positional[1]; // e.g. main...HEAD, a SHA range; default: uncommitted vs HEAD
    let diff = '';
    let deltaDiff;
    let priorFindings;
    if (deltaRef) {
      deltaDiff = reviewDiff(repo, deltaRef);
      priorFindings = loadPriorFindings(repo, priorFindingsPath ?? undefined);
    } else {
      diff = reviewDiff(repo, ref);
      if (!diff.trim()) {
        console.error('review: empty diff — nothing to prosecute');
        process.exit(0);
      }
    }
    const result = await reviewFleet({
      diff,
      repo,
      ref,
      pools,
      fiveLens: isFiveLens,
      arbiter: !noArbiter,
      thorough: isThorough,
      ...(dryRounds !== undefined ? { dryRounds } : {}),
      seamsOnly,
      ...(ticketScopes ? { ticketScopes } : {}),
      ...(deltaRef ? { deltaDiff, priorFindings } : {}),
      ...(priorFindingsPath ? { priorFindingsPath } : {}),
      ...(noCodegraph ? { codegraph: false } : {}),
      ...(noDecisionEngine ? { decisionEngine: false } : {}),
      log: (m) => console.error(m),
      project,
    });
    if ((result.findings.length > 0 || Boolean(deltaRef)) && (result.errors?.length ?? 0) === 0 && !result.truncated) {
      savePriorFindings(repo, result.findings, priorFindingsPath ?? undefined);
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.converged) console.error('review: did NOT converge — diff too large or contested; split it');
    const blocking = result.findings.filter(
      (f) => f.severity === 'critical' || f.severity === 'high' || Boolean(f.blast_radius) || f.verdict === 'escalate'
    );
    process.exit(result.gateVerdict !== 'SHIP' || blocking.length || !result.converged ? 2 : 0);
  } else if (cmd === 'shape') {
    const code = runShapeCli(rest, { repo: process.cwd() });
    process.exit(code);
  } else if (cmd === 'preflight') {
    rejectUnknownFlags('preflight', rest, new Set(['--no-coldstart', '--force-coldstart']));
    const planPath = rest.find((arg) => !arg.startsWith('--')) ?? 'plan.json';
    const { plan, errors } = loadPlan(planPath);
    if (errors.length) {
      console.error('plan invalid:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    const targetRepo = resolve(plan.repo ?? '.');
    const skipColdstart = rest.includes('--no-coldstart');
    const forceColdstart = rest.includes('--force-coldstart');
    const pools = new PoolSet(undefined, { repo: targetRepo });
    if (!skipColdstart) {
      const quotaRes = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || 'agy', {
        allowStatusCache: !process.env.AGB_AGY_BIN,
      });
      if (!quotaRes.ok) {
        console.error(`preflight: quota telemetry unavailable from agy: ${quotaRes.error}`);
        process.exit(1);
      }
    }
    const result = await preflight(plan, { pools, repo: targetRepo, skipColdstart, forceColdstart, project });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  } else if (cmd === 'plan') {
    rejectUnknownFlags(
      'plan',
      rest,
      new Set(['--estimate', '--json', '--force', '--decompose', '--no-fast-path', '--no-coldstart', '--no-parallax', '--no-premortem']),
      new Set(['--out', '--max-ticket-scope', '--emit-workflow'])
    );
    // The plan itself is authored in Antigravity (GUI plan mode or an agy
    // planning session) — this command only compiles that artifact.
    let out = 'plan.json';
    let emitWorkflow = null;
    let maxTicketScope;
    const estimate = rest.includes('--estimate');
    const jsonOut = rest.includes('--json');
    const decompose = rest.includes('--decompose');
    const noFastPath = rest.includes('--no-fast-path');
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--out') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --out');
          process.exit(1);
        }
        out = rest[++i];
      } else if (rest[i] === '--emit-workflow') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --emit-workflow');
          process.exit(1);
        }
        emitWorkflow = rest[++i];
      } else if (rest[i] === '--max-ticket-scope') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --max-ticket-scope');
          process.exit(1);
        }
        const parsedScope = Number(rest[++i]);
        if (!Number.isInteger(parsedScope) || parsedScope <= 0) {
          console.error(`agb: invalid --max-ticket-scope '${rest[i]}'`);
          process.exit(1);
        }
        maxTicketScope = parsedScope;
      }
    }
    const positional = extractPositionalArgs(rest, new Set(['--out', '--max-ticket-scope', '--emit-workflow']));
    const id = positional[0];
    const repo = positional[1] ?? '.';
    if (!id || !out) {
      console.error('usage: agb plan <brain-id-or-prefix | spec.md> [repo-path] [--estimate] [--json] [--out plan.json] [--emit-workflow <file.py>] [--force] [--decompose] [--max-ticket-scope <n>] [--no-fast-path] [--no-coldstart] [--no-parallax] [--no-premortem]');
      process.exit(1);
    }
    const force = rest.includes('--force');
    const targetRepo = resolve(repo);
    const resolvedWorkflowPath = emitWorkflow ? resolve(targetRepo, emitWorkflow) : null;
    if (estimate) {
      const result = await compilePlan(id, {
        repo: targetRepo,
        pools: null,
        estimateOnly: true,
        log: (m) => { if (!jsonOut) console.error(m); },
        fastPath: !noFastPath,
        decompose,
        maxTicketScope,
        coldstart: false,
        parallax: false,
        premortem: false,
        project,
      });
      if (jsonOut) {
        console.log(JSON.stringify({
          ok: result.ok,
          quotaEstimate: result.quotaEstimate,
          report: result.report,
          tickets: result.plan?.tickets ?? [],
        }, null, 2));
      } else if (!result.ok) {
        console.error(`plan --estimate: structural validation failed (${result.report.blocking.length} finding(s)):`);
        for (const b of result.report.blocking) console.error(`  - ${b}`);
      } else {
        const qe = result.quotaEstimate;
        console.log(`Quota Runway Forecast — ${result.brain.title} (${result.plan.tickets.length} ticket(s), ${qe.waves.length} wave(s))`);
        for (const w of qe.waves) {
          console.log(`  Wave ${w.wave} [${w.tickets.join(', ')}]: Gemini +${w.geminiPct}% (cum ${w.cumulativeGeminiPct}%) | Claude/GPT +${w.claudeGptPct}% (cum ${w.cumulativeClaudeGptPct}%)`);
        }
        const remGem = qe.remaining.gemini !== null ? `${qe.remaining.gemini}%` : 'unknown';
        const remCl = qe.remaining.claude_gpt !== null ? `${qe.remaining.claude_gpt}%` : 'unknown';
        console.log(`  Totals: Gemini ${qe.totals.gemini}% (rem: ${remGem}) | Claude/GPT ${qe.totals.claude_gpt}% (rem: ${remCl})`);
        if (qe.willExhaust && qe.recommendation) {
          console.log(`  !RUNWAY WARNING: ${qe.recommendation}`);
        }
      }
      process.exit(result.ok ? 0 : 2);
    }
    if (existsSync(out) && !force) {
      console.error(`plan: ${out} already exists — pass --force to overwrite ` +
        `(compiled plans are disposable, hand-written ones may not be)`);
      process.exit(1);
    }
    if (resolvedWorkflowPath && existsSync(resolvedWorkflowPath) && !force) {
      console.error(`plan: workflow ${resolvedWorkflowPath} already exists — pass --force to overwrite`);
      process.exit(1);
    }
    const pools = new PoolSet(undefined, { repo: targetRepo });
    const quotaRes = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || 'agy', {
      allowStatusCache: !process.env.AGB_AGY_BIN,
    });
    if (!quotaRes.ok) {
      console.error(`plan: quota telemetry unavailable from agy: ${quotaRes.error}`);
      process.exit(1);
    }
    const result = await compilePlan(id, {
      repo: targetRepo,
      pools,
      log: (m) => console.error(m),
      fastPath: !noFastPath,
      decompose,
      maxTicketScope,
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
    if (resolvedWorkflowPath) {
      const wfRes = compilePlanToWorkflow(result.plan, { outPath: resolvedWorkflowPath });
      console.error(`plan: emitted workflow (${wfRes.waves.length} wave(s)) → ${wfRes.outPath}`);
    }
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
  } else if (cmd === 'distill') {
    rejectUnknownFlags('distill', rest, new Set(['--apply', '--compile-checks', '--json']));
    const apply = rest.includes('--apply');
    const compileChecks = rest.includes('--compile-checks');
    const json = rest.includes('--json');
    const positional = extractPositionalArgs(rest);
    const repo = resolve(positional[0] ?? '.');
    const res = distillRunDefenses({ repo, apply, compileChecks });
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(
        `distill: scanned=${res.scannedCount} recurring=${res.recurringCount} staged=${res.stagedPath || 'none'}${res.applied ? ` applied=${res.appliedPath} (${res.ruleBytes}B)` : ''}${res.compiledChecks ? ` checks=${res.compiledChecksPath} (${res.compiledChecksCount})` : ''}`
      );
    }
    process.exit(0);
  } else if (cmd === 'holdout') {
    rejectUnknownFlags(
      'holdout',
      rest,
      new Set(['--json']),
      new Set(['--ticket', '--run-id'])
    );
    let ticketId = null;
    let runId = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--ticket') {
        ticketId = rest[++i];
      } else if (rest[i] === '--run-id') {
        runId = rest[++i];
      }
    }
    const jsonOut = rest.includes('--json');
    const positional = extractPositionalArgs(rest, new Set(['--ticket', '--run-id']));
    const sub = positional[0];
    const targetRepo = resolve(positional[1] ?? '.');
    if (sub !== 'list' && sub !== 'run' && sub !== 'clean') {
      console.error('usage: agb holdout <list|run|clean> [repo] [--ticket <id>] [--run-id <id>] [--json]');
      process.exit(1);
    }
    try {
      if (sub === 'list') {
        const listed = listHoldoutScenarios({ repo: targetRepo, runId, ticketId });
        if (jsonOut) {
          console.log(JSON.stringify(listed, null, 2));
        } else {
          console.log(`holdout: suites=${listed.suites.length} files=${listed.totalFiles}`);
          for (const s of listed.suites) {
            console.log(`  ${s.runId}/${s.ticketId}: ${s.count} scenario file(s)`);
          }
        }
        process.exit(0);
      }
      if (sub === 'clean') {
        const cleaned = cleanHoldoutScenarios({ repo: targetRepo, runId, ticketId });
        if (jsonOut) {
          console.log(JSON.stringify(cleaned, null, 2));
        } else {
          console.log(`holdout: cleaned=${cleaned.removed} (${cleaned.targetDir})`);
        }
        process.exit(0);
      }
      // sub === 'run': collect sealed files and run against targetRepo (emitting sanitized symptoms ONLY)
      const listed = listHoldoutScenarios({ repo: targetRepo, runId, ticketId });
      const allFiles = [];
      for (const suite of listed.suites) {
        const sDir = resolveHoldoutDir({ repo: targetRepo, runId: suite.runId, ticketId: suite.ticketId });
        for (const f of suite.files) allFiles.push(join(sDir, f.filename));
      }
      const execRes = await runHoldoutScenarios(allFiles, {
        candidateWorktree: targetRepo,
        sandbox: true,
      });
      if (jsonOut) {
        console.log(JSON.stringify(execRes, null, 2));
      } else {
        console.log(execRes.summary);
      }
      process.exit(execRes.ok ? 0 : 2);
    } catch (err) {
      if (jsonOut) {
        console.log(
          JSON.stringify(
            { ok: false, tampered: err?.code === 'ESYMLINK', error: err.message },
            null,
            2
          )
        );
      } else {
        console.error(`agb holdout: ${err.message}`);
      }
      process.exit(2);
    }
  } else if (cmd === 'brains') {
    rejectUnknownFlags('brains', rest, new Set());
    for (const b of listBrains()) console.log(`${b.id}  ${new Date(b.mtime).toISOString().slice(0, 10)}  ${b.title}`);
  } else if (cmd === 'import-brain') {
    rejectUnknownFlags('import-brain', rest, new Set());
    const [id, repo] = rest;
    if (!id || !repo) {
      console.error('usage: agb import-brain <conversation-id-or-prefix> <repo-path>');
      process.exit(1);
    }
    console.error('import-brain is deprecated — use `agb plan <id> <repo>` (adds plan gates, feedback loop, and provenance)');
    const targetRepo = resolve(repo);
    const pools = new PoolSet(undefined, { repo: targetRepo });
    const quotaRes = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || 'agy', {
      allowStatusCache: !process.env.AGB_AGY_BIN,
    });
    if (!quotaRes.ok) {
      console.error(`import-brain: quota telemetry unavailable from agy: ${quotaRes.error}`);
      process.exit(1);
    }
    const plan = await brainToPlan(id, { repo: targetRepo, project, pools });
    console.log(JSON.stringify(plan, null, 2));
    console.error(`${plan.tickets.length} tickets — review, then: agb preflight && agb run`);
  } else if (cmd === 'status') {
    if (rest.includes('--ui')) {
      console.error('The --ui TUI flag has been removed. Use agb sidecar or agb watch instead.');
      process.exit(1);
    }
    rejectUnknownFlags(
      'status',
      rest,
      new Set(['--watch', '-w', '--tui', '--follow', '--compact']),
      new Set(['--interval'])
    );
    const isWatch = rest.includes('--watch') || rest.includes('-w');
    const wantsTui = rest.includes('--tui');
    const follow = rest.includes('--follow');
    const compact = rest.includes('--compact');
    const intervalMs = parseIntervalFlag(rest, isWatch ? 200 : 1000);
    const positional = extractPositionalArgs(rest, new Set(['--interval']));
    const targetRepo = resolve(positional[0] ?? '.');

    if (isWatch) {
      const { watchStatus } = await import('../lib/status.mjs');
      const { runInteractiveRescue } = await import('../lib/rescue.mjs');
      const code = await watchStatus(targetRepo, {
        intervalMs,
        interactive: Boolean(process.stdout.isTTY && !process.env.CI),
        follow,
        compact,
        onRescue: (ticketId, repoDir) => runInteractiveRescue(repoDir, ticketId, { continueExisting: true }),
      });
      process.exitCode = code;
    } else {
      console.log(renderStatus(targetRepo, { tui: wantsTui, compact }));
    }
  } else if (cmd === 'watch') {
    let mux = null;
    const watchRest = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok.startsWith('--mux=')) {
        const rawVal = tok.slice('--mux='.length);
        if (!rawVal) {
          console.error('agb: missing value for --mux=');
          process.exit(1);
        }
        mux = normalizeMuxName(rawVal);
      } else if (tok === '--mux') {
        mux = 'auto';
      } else {
        watchRest.push(tok);
      }
    }
    rejectUnknownFlags(
      'watch',
      watchRest,
      new Set(['--follow', '--compact', '--no-alerts']),
      new Set(['--interval'])
    );
    const follow = watchRest.includes('--follow');
    const compact = watchRest.includes('--compact');
    const noAlerts = watchRest.includes('--no-alerts');
    const intervalMs = parseIntervalFlag(watchRest, 200);
    const positional = extractPositionalArgs(watchRest, new Set(['--interval']));
    const targetRepo = resolve(positional[0] ?? '.');
    const { watchStatus } = await import('../lib/status.mjs');
    const { runInteractiveRescue } = await import('../lib/rescue.mjs');
    const code = await watchStatus(targetRepo, {
      intervalMs,
      interactive: Boolean(process.stdout.isTTY && !process.env.CI),
      follow,
      compact,
      ...(mux ? { mux } : {}),
      alerts: !noAlerts,
      onRescue: (ticketId, repoDir) => runInteractiveRescue(repoDir, ticketId, { continueExisting: true }),
    });
    process.exitCode = code;
  } else if (cmd === 'accept') {
    rejectUnknownFlags(
      'accept',
      rest,
      new Set(['--json']),
      new Set(['--base', '--markdown'])
    );
    let base = 'HEAD';
    let markdownOut = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--base') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --base');
          process.exit(1);
        }
        base = rest[++i];
      } else if (rest[i] === '--markdown') {
        if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
          console.error('agb: missing value for --markdown');
          process.exit(1);
        }
        markdownOut = rest[++i];
      }
    }
    const jsonOut = rest.includes('--json');
    const positional = extractPositionalArgs(rest, new Set(['--base', '--markdown']));
    const targetRepo = resolve(positional[0] ?? '.');
    const dossier = buildAcceptanceDossier({ repo: targetRepo, base });
    if (markdownOut) {
      const mdText = formatAcceptanceDossierMarkdown(dossier);
      const writtenPath = writeAcceptDossierFile(targetRepo, mdText, markdownOut);
      if (!jsonOut) {
        console.error(`accept: wrote P6 sign-off dossier → ${writtenPath}`);
      }
    }
    if (jsonOut) {
      console.log(JSON.stringify(dossier, null, 2));
      process.exit(0);
    }
    if (markdownOut || !process.stdout.isTTY || !process.stdin.isTTY || process.env.CI) {
      if (!markdownOut) {
        process.stdout.write(formatAcceptanceDossierMarkdown(dossier));
      }
      process.exit(0);
    }
    const tuiRes = await runInteractiveAcceptTui(dossier, { repo: targetRepo });
    process.exit(tuiRes.ok ? 0 : 1);
  } else if (cmd === 'init') {
    const INIT_BOOL_FLAGS = new Set(['--with-codegraph']);
    const INIT_VALUE_FLAGS = new Set(['--decision-provider']);
    rejectUnknownFlags('init', rest, INIT_BOOL_FLAGS, INIT_VALUE_FLAGS);
    const withCodegraph = rest.includes('--with-codegraph');
    let decisionProvider = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--decision-provider') {
        const val = rest[i + 1];
        if (val === undefined || val.startsWith('-')) {
          console.error('agb: missing value for --decision-provider');
          process.exit(1);
        }
        if (!DECISION_PROVIDERS.includes(val)) {
          console.error(`agb: invalid --decision-provider '${val}' (expected one of: ${DECISION_PROVIDERS.join(', ')})`);
          process.exit(1);
        }
        decisionProvider = val;
        i += 1;
      }
    }
    const positional = extractPositionalArgs(rest, INIT_VALUE_FLAGS);
    const targetRepo = resolve(positional[0] ?? '.');
    const res = runInit({ repo: targetRepo, withCodegraph, decisionProvider });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'sync-models') {
    rejectUnknownFlags('sync-models', rest, new Set(['--check', '--offline', '--json', '--write']));
    const { syncModels, isBoosterRepoCheckout } = await import('../scripts/sync-models.mjs');
    const isJson = rest.includes('--json');
    const isWrite = rest.includes('--write');
    if (isWrite && !isBoosterRepoCheckout(process.cwd())) {
      const error = '--write only updates skills/adversarial-review/references/models.json inside an antigravity-booster repository checkout.';
      if (isJson) {
        console.log(JSON.stringify({ ok: false, exitCode: 1, error }, null, 2));
      } else {
        console.error(`ERROR: ${error}`);
      }
      process.exit(1);
    }
    const res = syncModels({
      check: rest.includes('--check'),
      offline: rest.includes('--offline'),
      json: isJson,
      write: isWrite,
      rootDir: process.cwd(),
      requireBoosterCheckout: true,
    });
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.error) {
      console.error(`ERROR: ${res.error}`);
    } else {
      console.log(`Total live models: ${res.totalLive} | Missing: ${res.unmappedCount}`);
    }
    process.exit(res.exitCode);
  } else if (cmd === 'tui') {
    console.error('The TUI has been removed. Use agb sidecar or agb watch instead.');
    process.exit(1);
  } else if (cmd === 'doctor') {
    rejectUnknownFlags('doctor', rest, new Set(['--fix']));
    const repoArg = extractPositionalArgs(rest)[0];
    const fix = rest.includes('--fix');
    process.exitCode = await runDoctor({
      ...(repoArg ? { cwd: resolve(repoArg) } : {}),
      fix,
    });
  } else if (cmd === 'validate') {
    rejectUnknownFlags('validate', rest, new Set());
    const { errors } = loadPlan(rest[0] ?? 'plan.json');
    if (errors.length) {
      console.error('plan invalid:\n  ' + errors.join('\n  '));
      process.exit(2);
    }
    console.log('plan valid');
  } else if (cmd === 'bootstrap' || cmd === 'setup' || cmd === 'install' || (cmd === 'skills' && ['install', 'setup', 'bootstrap'].includes(rest[0]))) {
    rejectUnknownFlags('bootstrap', rest, new Set(['--force', '-f', '--force-reinstall']));
    const force = rest.includes('--force') || rest.includes('-f');
    const forceReinstall = rest.includes('--force-reinstall');
    bootstrap({ force, forceReinstall });
  } else if (cmd === 'migrate') {
    const MIGRATE_BOOL_FLAGS = new Set(['--force', '--rollback', '--force-rollback', '--break-lock', '--finish-uninstall']);
    const MIGRATE_VALUE_FLAGS = new Set(['--token', '--uninstaller-dir', '--agy-bin', '--baseline']);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (MIGRATE_BOOL_FLAGS.has(token)) continue;
      if (MIGRATE_VALUE_FLAGS.has(token)) {
        if (i + 1 >= rest.length || typeof rest[i + 1] !== 'string' || rest[i + 1].startsWith('--')) {
          console.error(`Missing value for ${token}`);
          process.exit(1);
        }
        i += 1;
        continue;
      }
      console.error(`Unknown flag for agb migrate: ${token}`);
      process.exit(1);
    }
    const { migrate, breakLock, finishUninstallCommand } = await import('../lib/migrate.mjs');
    const flagValue = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
    const force = rest.includes('--force');
    if (rest.includes('--finish-uninstall')) {
      process.exitCode = finishUninstallCommand({
        token: flagValue('--token'), uninstallerDir: flagValue('--uninstaller-dir'), agyBin: flagValue('--agy-bin'),
        baseline: flagValue('--baseline'),
      });
    } else if (rest.includes('--break-lock')) {
      const confirm = async (question) => {
        if (!process.stdin.isTTY) return false;
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
      };
      process.exitCode = await breakLock({ force, confirm });
    } else {
      process.exitCode = await migrate({
        force, rollback: rest.includes('--rollback'), forceRollback: rest.includes('--force-rollback'),
      });
    }
  } else if (cmd === 'probe') {
    rejectUnknownFlags('probe', rest, new Set());
    const widths = (rest[0] ?? '2,4,8').split(',').map(Number);
    const model = rest[1] ?? ROLE_MODELS.probeDefault;
    const rows = [];
    for (const n of widths) {
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          runAgy({
            model,
            prompt: `Reply with exactly: PONG-${i}`,
            timeout: '120s',
            role: 'readonly',
            useRoleSettings: true,
            worker: { mode: 'readonly' },
          }).then((r) => ({
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
    if (rows.some((r) => r.ok > 0)) {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const calDir = process.env.AGB_CALIBRATION_DIR || join(process.cwd(), 'docs', 'calibration');
        const calFile = join(calDir, `probes-${day}.md`);
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
    rejectUnknownFlags('sidecar', rest, new Set(), new Set(['--port']));
    let portStr = process.env.AGB_SIDECAR_PORT;
    const pIdx = rest.indexOf('--port');
    if (pIdx !== -1) {
      portStr = rest[pIdx + 1];
    }
    const positional = extractPositionalArgs(rest, new Set(['--port']));
    const { serveSidecar } = await import('../sidecars/server.mjs');
    const { randomBytes } = await import('node:crypto');
    const port = portStr ? Number(portStr) : 3333;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`agb: invalid port '${portStr}'`);
      process.exit(1);
    }
    const token = randomBytes(16).toString('hex');
    const server = await serveSidecar(resolve(positional[0] ?? '.'), port, token);
    const actualPort = server.address().port;
    console.log(`AGB Sidecar Dashboard URL: http://127.0.0.1:${actualPort}/?token=${token}`);

    let cleaned = false;
    const cleanup = (code) => {
      if (cleaned) return;
      cleaned = true;
      server.close(() => process.exit(code));
      setTimeout(() => process.exit(code), 250).unref();
    };
    process.on('SIGINT', () => cleanup(130));
    process.on('SIGTERM', () => cleanup(143));
  } else if (cmd === 'pool') {
    rejectUnknownFlags('pool', rest, new Set());
    const sub = rest[0];
    if (sub === 'drain') {
      const repo = resolve(rest[1] ?? '.');
      const res = await drainPools(repo);
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    } else {
      console.error("agb: unknown pool subcommand. Usage: agb pool drain [repo]");
      process.exit(1);
    }
  } else {
    console.error(`agb: unknown command '${cmd}'\n`);
    console.error(`Usage: agb <command> ...`);
    console.error(`Run 'agb --help' for a list of commands.`);
    process.exit(1);
  }
} catch (err) {
  console.error(`agb: ${err.message}`);
  process.exit(1);
}
