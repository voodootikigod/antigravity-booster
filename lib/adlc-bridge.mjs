// Bridges booster's plan.json ticket format to the repo's ADLC ticket store,
// the contract the adlc-antigravity plugin's rails-guard hook and the adlc
// CLI's 20 tools operate on. The canonical backend is the DIRECTORY store
// (.adlc/tickets/ with a .store.json manifest, one canonical-JSON shard per
// ticket); the single-file .adlc/tickets.json remains recognized as the 1.x
// legacy bridge on repos that still carry one.
//
// plan.json remains booster's execution artifact — it carries fields
// (tier, pool_hint) the @adlc/core ticket schema doesn't have.
// The projected store is a generated PROJECTION consumed by the plugin/CLI,
// not a second source of truth a human edits. See docs/guidelines.md
// ("The Plan Phase").

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// Lazy-loaded so importing this module (e.g. bootstrap's handshake path)
// never requires @adlc/tickets to be resolvable — only the projection
// writer needs it. require(esm) is native on the Node >=22.19 floor.
let ticketsApi;
function ticketsLib() {
  ticketsApi ??= createRequire(import.meta.url)('@adlc/tickets');
  return ticketsApi;
}

/**
 * The plugin-contract version this booster projects and can interoperate with.
 * The booster OWNS the projected .adlc/tickets.json schema + hook payload shape,
 * so it declares the contract here; the installed adlc-antigravity plugin
 * advertises the contract it speaks via `adlcContract` in its plugin.json. An
 * integer (not semver): the contract is a discrete on-the-wire agreement, bumped
 * only on a breaking schema/hook change, so exact-integer equality is the
 * compatibility test.
 */
export const SUPPORTED_PLUGIN_CONTRACT = 1;

/**
 * Base directory of the INSTALLED adlc-antigravity plugin (the dir holding its
 * plugin.json). Overridable via AGB_PLUGIN_DIR — consistent with the other AGB_*
 * knobs — so the offline suite can point the handshake at a fixture instead of
 * the real ~/.gemini install. Distinct from ADLC_ANTIGRAVITY_PLUGIN_PATH, which
 * names the SOURCE checkout `agy plugin install` reads FROM; this is where the
 * installed manifest lands.
 */
export function pluginManifestDir() {
  return process.env.AGB_PLUGIN_DIR ?? join(homedir(), '.gemini', 'config', 'plugins', 'adlc-antigravity');
}

/**
 * Read the installed adlc-antigravity plugin manifest and classify its
 * `adlcContract` against SUPPORTED_PLUGIN_CONTRACT. Pure + total: NEVER throws
 * (matches 'CLI integrations degrade, never crash'). Returns exactly one of:
 *   { status: 'compatible', contract }   — adlcContract === supported: enforce
 *   { status: 'incompatible', contract } — present integer !== supported: the
 *                                          caller aborts LOUDLY (version skew)
 *   { status: 'missing-field' }          — manifest read but no/garbled
 *                                          adlcContract (older plugin): degrade
 *   { status: 'unreadable', error }      — absent/unparseable manifest: degrade
 *
 * `dir` overrides the base dir (bootstrap passes the plugin it just installed);
 * default resolves via pluginManifestDir().
 */
export function readPluginContract({ dir } = {}) {
  const path = join(dir ?? pluginManifestDir(), 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { status: 'unreadable', error: `plugin manifest at ${path}: ${err.code ?? err.message}` };
  }
  const contract = manifest?.adlcContract;
  // A present-but-non-integer contract is a garbled/older manifest, not a known
  // incompatibility — degrade rather than abort on something we can't parse.
  if (!Number.isInteger(contract)) return { status: 'missing-field' };
  if (contract === SUPPORTED_PLUGIN_CONTRACT) return { status: 'compatible', contract };
  return { status: 'incompatible', contract };
}

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
 * Project ONE plan ticket into the single-ticket, rail-enforcement-only shape
 * written into each builder's worktree at <worktree>/.adlc/tickets.json.
 *
 * DISTINCT from planTicketToAdlcTicket on purpose: this file contains exactly
 * one ticket, so it MUST NOT carry `edges`. An outgoing edge names a target
 * ticket that is — by construction — absent from a single-ticket file; the
 * adlc-antigravity plugin's loadTickets reports that as a dangling-edge error,
 * and its railPreconditions fails CLOSED on ANY validation error, denying
 * EVERY structured write for the whole build (not just rail paths). Only leaf
 * tickets (no outgoing edges) enforce correctly otherwise, which is why the bug
 * was invisible (B11 / adlc repo #142: the plugin stays fail-closed on dangling
 * edges, the booster projects edge-free single-ticket files).
 *
 * Two separate named functions rather than an option flag so the whole-plan and
 * single-ticket call sites cannot silently swap. Keeps only what rail resolution
 * and the plugin validator need: id + title (validateTicket requires a string
 * title) + rails, plus scope. Drops edges (the bug), and body/duration (not part
 * of rail resolution; the builder's charter comes from its worktree AGENTS.md).
 */
export function planTicketToRailTicket(t) {
  return {
    id: t.id,
    title: t.title,
    scope: t.scope ?? [],
    rails: t.rails ?? [],
  };
}

/**
 * Classify the repo's ADLC ticket store backend without loading it.
 * Returns 'directory' | 'legacy' | 'both' | 'none'. 'both' is a fail-closed
 * state for the adlc-antigravity plugin's reader (it refuses to pick one).
 */
export function detectTicketStoreBackend(repo) {
  const hasDirectory = existsSync(join(repo, '.adlc', 'tickets', '.store.json'));
  const hasLegacy = existsSync(join(repo, '.adlc', 'tickets.json'));
  if (hasDirectory && hasLegacy) return 'both';
  if (hasDirectory) return 'directory';
  if (hasLegacy) return 'legacy';
  return 'none';
}

/**
 * Write the projected tickets to the repo's ADLC ticket store, IN KIND:
 *
 *   - directory store present (or no store at all): rewrite the directory
 *     store — every shard is projection-owned, so stale shards from a prior
 *     projection are removed and each ticket lands as .adlc/tickets/
 *     <ticketFilename(id)> in canonical JSON. A repo with NO store gets a
 *     fresh directory store (the canonical backend), never a new tickets.json.
 *   - legacy tickets.json ONLY: keep writing the single file (1.x bridge for
 *     repos that haven't run `adlc ticket store migrate`).
 *   - both present: the directory store wins and the legacy projection
 *     artifact is deleted — the plugin's reader fails CLOSED on the
 *     both-stores state, which would deny every builder write mid-run.
 *
 * Returns the written path (the store directory, or the legacy file).
 */
export function writeAdlcTickets(repo, tickets) {
  const dir = join(repo, '.adlc');
  mkdirSync(dir, { recursive: true });
  const backend = detectTicketStoreBackend(repo);
  if (backend === 'legacy') {
    const path = join(dir, 'tickets.json');
    writeFileSync(path, JSON.stringify({ tickets }, null, 2) + '\n');
    return path;
  }
  const { initializeDirectoryStore, ticketFilename, prettyCanonicalJson } = ticketsLib();
  const storeDir = join(dir, 'tickets');
  // Refuse to write through a symlinked .adlc or store dir: a crafted target
  // repo could commit .adlc/tickets as a symlink and redirect the stale-shard
  // cleanup below at files outside the store (the plugin's own reader rejects
  // symlinked store paths for the same reason).
  for (const p of [dir, storeDir]) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
      throw new Error(`refusing to project tickets through a symlink: ${p}`);
    }
  }
  if (backend === 'none') initializeDirectoryStore(storeDir);
  if (backend === 'both') rmSync(join(dir, 'tickets.json'), { force: true });
  // Write first, prune second: shard names are deterministic per id, so the
  // new projection lands (overwriting same-id shards) before any stale shard
  // is removed — a crash mid-projection leaves a superset, never a hole.
  const keep = new Set(['.store.json']);
  for (const t of tickets) {
    const shard = ticketFilename(t.id);
    keep.add(shard);
    // prettyCanonicalJson already ends with a newline.
    writeFileSync(join(storeDir, shard), prettyCanonicalJson(t));
  }
  for (const entry of readdirSync(storeDir)) {
    if (!keep.has(entry) && entry.endsWith('.json')) rmSync(join(storeDir, entry), { force: true });
  }
  return storeDir;
}
