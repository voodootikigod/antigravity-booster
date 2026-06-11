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

import { scopesOverlap, topoSort } from '@aidlc/core/tickets';
import { extractJson } from '@aidlc/core/llm';
import { runAgy } from './agy.mjs';

const COLDSTART_MODEL = 'Gemini 3.5 Flash (Medium)';

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

/** Deterministic half: pairwise scope overlap between concurrent tickets. */
export function forecastOverlaps(tickets) {
  // Tickets connected by an edge serialize anyway; only unordered pairs matter.
  const ordered = new Set();
  for (const t of tickets) for (const e of t.edges ?? []) {
    ordered.add(`${t.id}|${e.to}`); ordered.add(`${e.to}|${t.id}`);
  }
  const overlaps = [];
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const a = tickets[i], b = tickets[j];
      if (ordered.has(`${a.id}|${b.id}`)) continue;
      if (scopesOverlap(a, b)) overlaps.push({ a: a.id, b: b.id, scopes: [a.scope, b.scope] });
    }
  }
  return overlaps;
}

/** LLM half: coldstart every ticket on the cheap tier, in parallel. */
export async function coldstartTickets(tickets, gate, { pools, model = COLDSTART_MODEL } = {}) {
  const results = await Promise.all(
    tickets.map(async (t) => {
      const release = pools ? await pools.acquire(model) : () => {};
      try {
        const res = await runAgy({ model, prompt: coldstartPrompt(t, gate), timeout: '4m' });
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
  const { cycle } = topoSort(plan.tickets);
  const overlaps = forecastOverlaps(plan.tickets);
  const cold = opts.skipColdstart ? [] : await coldstartTickets(plan.tickets, plan.gate, opts);
  const gaps = cold.filter((c) => c.gaps.length || c.error);
  return {
    ok: !cycle && overlaps.length === 0 && gaps.length === 0,
    cycle,
    overlaps,
    gaps,
  };
}
