// The plan compiler (ADLC P1/P2 plan-time gates).
//
// Doctrine: planning happens in Antigravity, exactly as it already does —
// the desktop app's plan mode or an agy planning conversation, both of
// which write brain artifacts (implementation_plan.md). agb does NOT
// author, replace, or supplement that phase. This module treats the brain
// plan as SOURCE and plan.json as a COMPILED artifact:
//
//   implementation_plan.md ──convert──▶ ticket DAG ──gates──▶ plan.json
//
// Compile pipeline (compilePlan):
//   Stage A — structural loop: convert, then validate schema/DAG/routability
//     and forecast scope overlaps. Deterministic and free, so every failure
//     feeds straight back into a re-conversion (bounded by maxAttempts).
//   Stage B — LLM plan gates, at most two passes: coldstart (per-ticket
//     underspecification) + parallax (per-edge contract ambiguity, ADLC D3).
//     Blocking findings get ONE feedback re-conversion; what survives is
//     reported with the remediation pointing at the brain plan — the fix
//     surface is the plan in Antigravity, never the compiled JSON.
//   Premortem (ADLC C2) runs once on the surviving plan and is advisory:
//     it stress-tests, it does not veto.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { validateTicket, topoSort } from '@adlc/core/tickets';
import { extractJson } from '@adlc/core/llm';
import { tierCandidates, TIER_CANDIDATES } from './pools.mjs';
import { forecastOverlaps, coldstartTickets, applyMergeForecast } from './preflight.mjs';
import { readBrain, brainToPlan } from './brain.mjs';
import { runAgy } from './agy.mjs';
import { planToAdlcTickets, writeAdlcTickets } from './adlc-bridge.mjs';

const execFileP = promisify(execFile);
const PREMORTEM_MODEL = 'Gemini 3.1 Pro (High)';
const PARALLAX_READER_MODEL = 'Gemini 3.5 Flash (Medium)';

// Conservative by design: every id shipped in this repo's own plans (T1, B11,
// DOC-UPDATE, BOOTSTRAP-AUTO-CLONE, ISSUE-26) satisfies it. Leading dots are
// excluded so an id can never produce '..' or a dotfile worktree.
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PARALLAX_JUDGE_MODEL = 'Gemini 3.1 Pro (High)';
const MODEL_ROUTER_TIMEOUT_MS = 30_000;

/**
 * Cross-check (and set) each ticket's tier via `adlc model-router` — a
 * deterministic, rails/critical-path-float-based assignment (ADLC D1) —
 * instead of relying solely on whatever tier the brain conversion's own
 * free-form model output happened to produce. Runs against the already-
 * written .adlc/tickets.json projection (ticketsPath). Mutates nothing on
 * failure: an operational error (adlc missing, timeout, unparseable output)
 * leaves every ticket's existing tier untouched and returns { ok: false }.
 */
export async function applyModelRouterTiers(plan, ticketsPath, { adlcBin, floor } = {}) {
  const bin = adlcBin ?? process.env.AGB_ADLC_BIN ?? 'adlc';
  const args = ['model-router', '--tickets', ticketsPath, '--json'];
  if (floor !== undefined) args.push('--floor', String(floor));
  let stdout;
  try {
    const res = await execFileP(bin, args, { timeout: MODEL_ROUTER_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    stdout = res.stdout;
  } catch (err) {
    // model-router gate-fails (exit 2) on a ticket too thinly railed to
    // build cheaply — the assignments are still valid and on stdout even
    // when the process exits non-zero; only a genuinely unparseable/absent
    // stdout is an operational error.
    stdout = err.stdout;
    if (!stdout) return { ok: false, error: err.message, assignments: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `unparseable model-router output: ${err.message}`, assignments: [] };
  }
  const assignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];
  const byId = new Map(assignments.map((a) => [a.id, a]));
  for (const t of plan.tickets ?? []) {
    const assignment = byId.get(t.id);
    if (assignment?.tier) t.tier = assignment.tier;
  }
  return { ok: true, assignments, p3Findings: Array.isArray(parsed.p3Findings) ? parsed.p3Findings : [] };
}

/**
 * Full structural validation of a plan object: per-ticket schema, plus the
 * cross-ticket and routability checks validateTicket cannot do alone
 * (duplicate ids share a worktree/branch, an edge to an unknown id throws
 * mid-run, an unroutable tier/pool_hint silently drops the ticket).
 * Returns an array of error strings; empty = valid.
 */
export function validatePlan(plan) {
  const errors = [];
  if (!plan.repo) errors.push('plan.repo is required (absolute path to target repo)');
  if (!plan.gate || (!plan.gate.build && !plan.gate.test)) {
    errors.push('plan.gate must declare at least one of build/test commands');
  }
  for (const t of plan.tickets ?? []) errors.push(...validateTicket(t));
  if (!plan.tickets?.length) errors.push('plan.tickets is empty');
  const ids = new Set();
  // Keyed on the SAME normalization createWorktree applies (lib/worktrees.mjs
  // lowercases the id into both the worktree dir and the branch). An exact-match
  // check would pass T1 and t1 as distinct while they collide on one worktree —
  // and createWorktree force-removes what it finds there, so the second ticket
  // would delete a live sibling's uncommitted work.
  const normalized = new Map();
  for (const t of plan.tickets ?? []) {
    if (!t.id) continue; // validateTicket already reported the missing id
    if (ids.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
    // The id is interpolated into a filesystem path (.worktrees/agb-<id>) and a
    // git ref (agb/<id>). A traversal like ../../x is rejected today only because
    // git refuses '..' in a branch name — an accident of ref-format rules, not a
    // decision here. Constrain the charset so the two naming schemes cannot drift
    // apart and turn that accident into a real escape.
    if (!TICKET_ID_RE.test(t.id)) {
      errors.push(`${t.id}: ticket id must match ${TICKET_ID_RE} — it is used as a ` +
        `worktree directory name and a git branch name`);
    }
    const key = t.id.toLowerCase();
    const clash = normalized.get(key);
    if (clash !== undefined && clash !== t.id) {
      errors.push(`${t.id}: ticket id collides with '${clash}' — both resolve to worktree ` +
        `agb-${key} and branch agb/${key}, and creating the second would destroy the first`);
    }
    normalized.set(key, t.id);
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
  return errors;
}

/** Every declared edge as {from, to} ticket pairs (unknown targets skipped). */
export function planEdges(tickets) {
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const edges = [];
  for (const t of tickets) {
    for (const e of t.edges ?? []) if (byId[e.to]) edges.push({ from: t, to: byId[e.to] });
  }
  return edges;
}

function premortemPrompt(plan, brain) {
  return `It is three months from now and this parallel build-out FAILED —
wrong outputs merged, tickets flailed and burned the weekly quota, or the
result missed the original goal. Write the postmortem. An agent asked "any
problems with this plan?" says no; you are explaining a failure that already
happened, so invent concrete, checkable causes only.

## The original plan (authored in Antigravity)

${brain.implementationPlan ?? brain.task ?? '(none)'}

## The compiled ticket DAG it will execute as

${JSON.stringify(plan.tickets.map(({ id, title, body, scope, edges, tier }) => ({ id, title, body, scope, edges, tier })), null, 2)}

Gate commands: ${JSON.stringify(plan.gate ?? {})}

List 3-6 causes, most likely first. Each must be specific to THIS plan —
no generic risks ("scope creep") that apply to any project.

Respond with ONLY:
{"causes": [{"cause": "...", "likelihood": "high|medium|low", "mitigation": "..."}]}`;
}

/**
 * Premortem stress test (ADLC C2) — fresh frontier context, one charter:
 * the run already failed, explain why. Advisory: returns {causes, error?}
 * and never vetoes the compile.
 */
export async function premortemPlan(plan, brain, { pools, model = PREMORTEM_MODEL, project } = {}) {
  const release = pools ? await pools.acquire(model) : () => {};
  try {
    const res = await runAgy({ model, prompt: premortemPrompt(plan, brain), timeout: '5m', project });
    if (!res.ok) return { causes: [], error: res.error };
    try {
      const parsed = extractJson(res.output);
      return { causes: Array.isArray(parsed.causes) ? parsed.causes.filter(Boolean) : [] };
    } catch {
      return { causes: [], error: 'unparseable premortem output' };
    }
  } finally {
    release();
  }
}

function contractPrompt(from, to, i) {
  return `Two work tickets run in sequence: ticket ${from.id} merges to main
BEFORE ticket ${to.id} starts. Author the contract ${to.id} may rely on from
${from.id} — exact file paths, export names, signatures, and behaviors. This
is reading ${i + 1}: commit to ONE concrete reading of the tickets below; do
not ask questions and do not hedge with alternatives.

## Ticket ${from.id}: ${from.title} (runs first)

${from.body}

Declared scope: ${(from.scope ?? []).join(', ')}

## Ticket ${to.id}: ${to.title} (depends on ${from.id})

${to.body}

Declared scope: ${(to.scope ?? []).join(', ')}

Respond with ONLY: {"contract": "one paragraph stating files, exports, signatures, behaviors"}`;
}

function judgePrompt(from, to, readings) {
  return `Below are ${readings.length} independent readings of the same
inter-ticket contract (what ticket ${to.id} may rely on from ticket
${from.id}). Each was written in a fresh context from the same two tickets.
Where the readings disagree on anything load-bearing — file paths, export
names, signatures, behavior — that disagreement is a MEASURED ambiguity in
the tickets, not a style difference. Ignore wording differences that describe
the same contract.

${readings.map((r, i) => `## Reading ${i + 1}\n\n${r.contract}`).join('\n\n')}

Respond with ONLY:
{"divergent": true|false, "divergences": ["each load-bearing disagreement, stated as the open question it implies"]}`;
}

/**
 * Parallax edge interrogation (ADLC D3, scoped to the compile pipeline):
 * for each DAG edge, N cheap fresh contexts independently author the
 * implied contract; a judge diffs the readings. Divergence is measured
 * contract ambiguity — the precise quantity that poisons parallel merges.
 * Returns [{edge, divergent, divergences} | {edge, error}].
 */
export async function parallaxEdges(plan, {
  pools, n = 3,
  readerModel = PARALLAX_READER_MODEL,
  judgeModel = PARALLAX_JUDGE_MODEL,
  project,
} = {}) {
  const edges = planEdges(plan.tickets ?? []);
  return Promise.all(edges.map(async ({ from, to }) => {
    const edge = `${from.id}->${to.id}`;
    const readings = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const release = pools ? await pools.acquire(readerModel) : () => {};
      try {
        const res = await runAgy({ model: readerModel, prompt: contractPrompt(from, to, i), timeout: '4m', project });
        if (!res.ok) return { error: res.error };
        try {
          const parsed = extractJson(res.output);
          return typeof parsed.contract === 'string' && parsed.contract.trim()
            ? { contract: parsed.contract }
            : { error: 'empty contract reading' };
        } catch {
          return { error: 'unparseable contract reading' };
        }
      } finally {
        release();
      }
    }));
    const failed = readings.filter((r) => r.error);
    // Errors fail closed (an unread edge is not a converged edge), same as
    // coldstart errors surfacing as gaps.
    if (failed.length) return { edge, error: `${failed.length}/${n} contract readings failed: ${failed[0].error}` };
    const release = pools ? await pools.acquire(judgeModel) : () => {};
    try {
      const res = await runAgy({ model: judgeModel, prompt: judgePrompt(from, to, readings), timeout: '4m', project });
      if (!res.ok) return { edge, error: res.error };
      try {
        const parsed = extractJson(res.output);
        return {
          edge,
          divergent: !!parsed.divergent,
          divergences: Array.isArray(parsed.divergences) ? parsed.divergences.filter(Boolean) : [],
        };
      } catch {
        return { edge, error: 'unparseable parallax verdict' };
      }
    } finally {
      release();
    }
  }));
}

/**
 * Compile a brain plan into a gated, provenance-stamped plan object.
 * Returns { ok, plan, report } — report carries attempts, gatePasses,
 * structuralErrors, gaps, parallax, premortem, blocking. Throws only on
 * programmer/environment error (no repo, no matching brain).
 */
export async function compilePlan(idOrPrefix, {
  repo, gate, pools, brainDir, log = () => {},
  maxAttempts = 3,
  coldstart = true, parallax = true, premortem = true,
  parallaxN = 3,
  project,
} = {}) {
  const finalProject = project ?? `agb-plan-${Date.now()}`;
  if (!repo) throw new Error('compilePlan: repo is required');
  const brain = readBrain(idOrPrefix, brainDir);

  let plan = null;
  let attempts = 0;
  let structuralErrors = [];
  let gatePasses = 0;

  const convert = async (feedback) => {
    attempts++;
    log(`plan: converting '${brain.title}' (attempt ${attempts})`);
    try {
      plan = await brainToPlan(idOrPrefix, { repo, gate, brainDir, feedback });
      // Provenance + repo are compiler-owned: never trust the model's copy.
      plan.repo = repo;
      plan.source = { type: brain.sourceType, id: brain.id, title: brain.title };
      structuralErrors = [
        ...validatePlan(plan),
        ...forecastOverlaps(plan.tickets ?? []).map((o) =>
          `tickets ${o.a} and ${o.b} run in parallel but declare overlapping scopes ` +
          `(${JSON.stringify(o.scopes)}) — repartition the files or add an edge`),
      ];
    } catch (err) {
      log(`plan: conversion failed: ${err.message}`);
      plan = null;
      structuralErrors = [`conversion error: ${err.message}`];
    }
  };

  // Stage A: structural loop.
  await convert([]);
  while (structuralErrors.length && attempts < maxAttempts) {
    log(`plan: ${structuralErrors.length} structural defect(s) — feeding back to converter`);
    await convert(structuralErrors);
  }
  const fail = (blocking) => ({
    ok: false, plan, brain: { id: brain.id, title: brain.title, sourceType: brain.sourceType },
    report: { attempts, gatePasses, structuralErrors, gaps: [], parallax: [], premortem: null, blocking },
  });
  if (structuralErrors.length) return fail(structuralErrors);

  // Stage B: LLM plan gates, at most two passes.
  const runGates = async () => {
    const [cold, lax] = await Promise.all([
      coldstart ? coldstartTickets(plan.tickets, plan.gate, { pools, project: finalProject }) : Promise.resolve([]),
      parallax ? parallaxEdges(plan, { pools, n: parallaxN, project: finalProject }) : Promise.resolve([]),
    ]);
    const gaps = cold.filter((c) => c.gaps.length || c.error);
    const blocking = [
      ...gaps.map((g) => g.error
        ? `${g.id}: coldstart error: ${g.error}`
        : `${g.id}: underspecified for a fresh agent — ${g.gaps.join('; ')}`),
      ...lax.filter((e) => e.error || e.divergent).map((e) => e.error
        ? `edge ${e.edge}: parallax error: ${e.error}`
        : `edge ${e.edge}: contract ambiguity — ${e.divergences.join('; ')}`),
    ];
    return { gaps, parallaxResults: lax, blocking };
  };

  gatePasses = 1;
  let gates = await runGates();
  if (gates.blocking.length && attempts < maxAttempts + 1) {
    log(`plan: ${gates.blocking.length} plan-gate finding(s) — feeding back once`);
    await convert(gates.blocking);
    if (structuralErrors.length) return fail(structuralErrors);
    gates = await runGates();
    gatePasses = 2;
  }

  // Premortem is advisory: it stress-tests the surviving plan, never vetoes.
  const pm = premortem ? await premortemPlan(plan, brain, { pools, project: finalProject }) : null;

  const ok = gates.blocking.length === 0;
  // Final pipeline step: project the gated plan into .adlc/tickets.json so
  // the adlc-antigravity plugin's rails-guard hook and the adlc CLI's gate
  // tools can resolve the same active ticket set. plan.json (written by the
  // caller) remains the execution artifact; .adlc/tickets.json is a
  // generated view, not a second source of truth — see docs/guidelines.md
  // ("The Plan Phase"). Only a blocking-free plan is published as active.
  // Best-effort: a write failure (e.g. repo is unwritable) does not
  // invalidate an already-successful compile, but is never swallowed silently.
  if (ok) {
    try {
      const ticketsPath = writeAdlcTickets(repo, planToAdlcTickets(plan));
      // Cross-check/assign tiers via the deterministic, rails/float-based
      // router (ADLC D1) instead of trusting only whatever tier the brain
      // conversion's free-form model output happened to produce.
      const routed = await applyModelRouterTiers(plan, ticketsPath);
      if (!routed.ok) {
        log(`plan: warning — adlc model-router unavailable, keeping brain-assigned tiers: ${routed.error}`);
      } else if (routed.p3Findings.length) {
        log(`plan: model-router flagged ${routed.p3Findings.length} thinly-railed ticket(s) (advisory, not a compile blocker)`);
      }
      // Complementary to the structural-loop scope-overlap veto above:
      // estimates dependency pressure and merge backpressure across the
      // whole DAG and annotates plan.concurrencyCap. Advisory — never
      // blocks an otherwise-successful compile.
      const forecast = await applyMergeForecast(plan, ticketsPath, { repo });
      if (!forecast.ok) {
        log(`plan: warning — adlc merge-forecast unavailable, plan.concurrencyCap left unset: ${forecast.error}`);
      } else if (forecast.gateFailures.length) {
        log(`plan: merge-forecast flagged ${forecast.gateFailures.length} scheduling risk(s) (advisory, not a compile blocker): ${forecast.gateFailures.join('; ')}`);
      }
    } catch (err) {
      log(`plan: warning — could not write .adlc/tickets.json to ${repo}: ${err.message}`);
    }
  }

  return {
    ok,
    plan,
    brain: { id: brain.id, title: brain.title, sourceType: brain.sourceType },
    report: {
      attempts, gatePasses,
      structuralErrors: [],
      gaps: gates.gaps,
      parallax: gates.parallaxResults,
      premortem: pm,
      blocking: gates.blocking,
    },
  };
}
