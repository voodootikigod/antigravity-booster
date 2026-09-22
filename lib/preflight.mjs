// Plan-time gates (ADLC P2), run before any build token is spent:
//
//   1. merge-forecast-lite — pairwise declared-scope overlap (hard veto:
//      overlapping parallel tickets were never parallel, they were a merge
//      conflict scheduled in advance). Deterministic, free.
//   2. coldstart — each ticket goes to a cheap model in a fresh context:
//      "list everything missing to execute this without asking a question."
//      Non-empty list = the ticket is underspecified for the mid model that
//      will actually run it. Pennies; catches the #1 cause of build flail.
//
// Returns { ok, overlaps, gaps }; exit-code policy belongs to the caller.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { scopesOverlap, topoSort } from '@adlc/core/tickets';
import { extractJson } from '@adlc/core/llm';
import { runAgy } from './agy.mjs';
import { resolveAdlcBinary } from './adlc-bridge.mjs';

const execFileP = promisify(execFile);
const MERGE_FORECAST_TIMEOUT_MS = 30_000;

/**
 * Run `adlc merge-forecast` against the projected .adlc/tickets.json and
 * annotate plan.concurrencyCap with its recommended fan-out width (ADLC D2).
 *
 * Complementary to forecastOverlaps() above, not redundant: forecastOverlaps
 * is a hard-veto pairwise declared-scope check with no notion of width;
 * merge-forecast additionally estimates dependency pressure and merge
 * backpressure across the whole DAG and recommends how many tickets can run
 * concurrently. Annotates, does not gate — an unavailable/failing forecast
 * (adlc missing, timeout, unparseable, or the tool's own hard-veto gate
 * failure) leaves plan.concurrencyCap unset and returns { ok: false } rather
 * than blocking an otherwise-successful compile.
 */
export async function applyMergeForecast(plan, ticketsPath, { adlcBin, repo, graphCoupling } = {}) {
  let bin = adlcBin;
  if (!bin) {
    const resolved = resolveAdlcBinary({ repo });
    bin = resolved.ok ? resolved.binary : (process.env.AGB_ADLC_BIN ?? 'adlc');
  }
  const graphCouplingPath = graphCoupling ?? (repo ? join(repo, '.adlc', 'graph-coupling.json') : join('.adlc', 'graph-coupling.json'));
  const args = ['merge-forecast', '--tickets', ticketsPath, '--json', '--graph-coupling', graphCouplingPath];
  let stdout;
  try {
    const res = await execFileP(bin, args, { cwd: repo, timeout: MERGE_FORECAST_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    stdout = res.stdout;
  } catch (err) {
    // merge-forecast gate-fails (exit 2) on --width overrun or a vetoed pair
    // scheduled concurrently — the forecast itself is still valid JSON on
    // stdout even then; only a genuinely unparseable/absent stdout is an
    // operational error.
    stdout = err.stdout;
    if (!stdout) return { ok: false, error: err.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `unparseable merge-forecast output: ${err.message}` };
  }
  plan.concurrencyCap = parsed.recommendedWidth ?? parsed.certifiedWidth ?? null;
  return {
    ok: true,
    certifiedWidth: parsed.certifiedWidth,
    recommendedWidth: parsed.recommendedWidth,
    backpressureWidth: parsed.backpressureWidth,
    gateFailures: Array.isArray(parsed.gateFailures) ? parsed.gateFailures : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

const COLDSTART_MODEL = 'gemini-3.8-flash-low';

function coldstartPrompt(ticket, gate) {
  return `You are doing a cold-start check on a work ticket. You know NOTHING
about the project except what the ticket says. A fresh agent must be able to
execute it from this text alone.

## Ticket ${ticket.id}: ${ticket.title}

${ticket.body}

Declared file scope: ${(ticket.scope ?? []).join(', ') || '(none)'}
Gate commands: ${JSON.stringify(gate ?? {})}

List everything genuinely MISSING to execute this without asking a single
question — undefined file paths, unnamed acceptance criteria, references to
things the ticket doesn't define, ambiguous behavior with multiple defensible
readings (state the readings). Do NOT list things the ticket adequately
covers, general best practices, or nice-to-haves.

Respond with ONLY: {"gaps": ["...", "..."]}  (empty array if executable as-is)`;
}

/**
 * Reachability (transitive closure) of the edge DAG: reach[x] = every ticket
 * that runs strictly after x. Two tickets where one transitively precedes the
 * other are serialized and can never collide — even without a direct edge.
 */
function reachability(tickets) {
  const succ = Object.fromEntries(tickets.map((t) => [t.id, (t.edges ?? []).map((e) => e.to)]));
  const reach = {};
  const visit = (id, acc) => {
    for (const n of succ[id] ?? []) {
      if (!acc.has(n)) { acc.add(n); visit(n, acc); }
    }
    return acc;
  };
  for (const t of tickets) reach[t.id] = visit(t.id, new Set());
  return reach;
}

/** Deterministic half: pairwise scope overlap between *concurrent* tickets. */
export function forecastOverlaps(tickets) {
  const reach = reachability(tickets);
  const serialized = (a, b) => reach[a]?.has(b) || reach[b]?.has(a);
  const overlaps = [];
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const a = tickets[i], b = tickets[j];
      // A transitive ordering (T1→T2→T3) means T1 and T3 never run together.
      if (serialized(a.id, b.id)) continue;
      if (scopesOverlap(a, b)) overlaps.push({ a: a.id, b: b.id, scopes: [a.scope, b.scope] });
    }
  }
  return overlaps;
}

/** LLM half: coldstart every ticket on the cheap tier, in parallel. */
export async function coldstartTickets(tickets, gate, { pools, model = COLDSTART_MODEL, project } = {}) {
  const results = await Promise.all(
    tickets.map(async (t) => {
      const release = pools ? await pools.acquire(model) : () => {};
      try {
        const res = await runAgy({ model, prompt: coldstartPrompt(t, gate), timeout: '4m', project });
        if (!res.ok) return { id: t.id, error: res.error, gaps: [] };
        try {
          const parsed = extractJson(res.output);
          return { id: t.id, gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter(Boolean) : [] };
        } catch {
          return { id: t.id, error: 'unparseable coldstart output', gaps: [] };
        }
      } finally {
        release();
      }
    })
  );
  return results;
}

/** Full preflight. ok = no cycle, no overlaps, no gaps, no errors. */
export async function preflight(plan, opts = {}) {
  const finalProject = opts.project ?? `agb-preflight-${Date.now()}`;
  const { cycle } = topoSort(plan.tickets);
  const overlaps = forecastOverlaps(plan.tickets);
  const coldOpts = { ...opts, project: finalProject };
  const cold = opts.skipColdstart ? [] : await coldstartTickets(plan.tickets, plan.gate, coldOpts);
  const gaps = cold.filter((c) => c.gaps.length || c.error);
  return {
    ok: !cycle && overlaps.length === 0 && gaps.length === 0,
    cycle,
    overlaps,
    gaps,
  };
}
