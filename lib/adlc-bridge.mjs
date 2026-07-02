// Bridges booster's plan.json ticket format to .adlc/tickets.json, the
// contract the adlc-antigravity plugin's rails-guard hook and the adlc
// CLI's 20 tools operate on.
//
// plan.json remains booster's execution artifact — it carries fields
// (tier, pool_hint) the @adlc/core ticket schema doesn't have.
// .adlc/tickets.json is a generated PROJECTION consumed by the plugin/CLI,
// not a second source of truth a human edits. See docs/guidelines.md
// ("The Plan Phase").

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project one plan ticket into the @adlc/core ticket shape (id, title,
 * body, scope, rails, edges, duration). Pure — does not invent fields the
 * plan ticket doesn't already carry. Used both for the whole-plan
 * projection below and to materialize a single active ticket (e.g.
 * .adlc/current-ticket.json for a builder's worktree).
 */
export function planTicketToAdlcTicket(t) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    scope: t.scope ?? [],
    rails: t.rails ?? [],
    edges: (t.edges ?? []).map((e) => ({
      to: e.to,
      ...(e.contract ? { contract: e.contract } : {}),
    })),
    ...(t.duration !== undefined ? { duration: t.duration } : {}),
  };
}

/**
 * Project a compiled booster plan's tickets into the @adlc/core ticket
 * shape. Pure — does not invent fields the plan ticket doesn't already
 * carry.
 */
export function planToAdlcTickets(plan) {
  return (plan.tickets ?? []).map(planTicketToAdlcTicket);
}

/**
 * Write the projected tickets to <repo>/.adlc/tickets.json (the plugin/CLI
 * convention: { "tickets": [...] }). Returns the written path.
 */
export function writeAdlcTickets(repo, tickets) {
  const dir = join(repo, '.adlc');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'tickets.json');
  writeFileSync(path, JSON.stringify({ tickets }, null, 2) + '\n');
  return path;
}
