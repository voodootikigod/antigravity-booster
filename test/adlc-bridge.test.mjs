import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTickets } from '@adlc/core/tickets';
import { ticketFilename } from '@adlc/tickets';

import { planToAdlcTickets, planTicketToRailTicket, writeAdlcTickets } from '../lib/adlc-bridge.mjs';
import { compilePlan } from '../lib/plan.mjs';

// Local port of the adlc-antigravity plugin's tickets validation rules
// (plugins/adlc-antigravity/core-inline.mjs loadTickets) — replicated, NOT
// imported, so the suite stays fully offline (AGENTS.md: no sibling-checkout
// dependency). The B11-relevant rule is the dangling-edge check: an edge whose
// target id is absent from the file is an error, and the plugin's
// railPreconditions fails CLOSED on ANY error — denying every write.
function pluginValidationErrors(data) {
  const tickets = data.tickets ?? [];
  const errors = [];
  const seen = new Set();
  for (const t of tickets) {
    if (!t.id || typeof t.id !== 'string') errors.push('missing string id');
    else {
      if (seen.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
      seen.add(t.id);
    }
    if (!t.title || typeof t.title !== 'string') errors.push(`${t.id ?? '?'}: missing string title`);
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (e.to && !seen.has(e.to)) errors.push(`${t.id}: edge to unknown ticket ${e.to}`);
    }
  }
  return errors;
}

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

const FAKE_ENV_KEYS = [
  'AGB_AGY_BIN', 'FAKE_STATE_DIR', 'FAKE_BRAIN_MODE',
  'FAKE_COLDSTART_MODE', 'FAKE_PARALLAX_VERDICT', 'FAKE_PREMORTEM_MODE',
  'FAKE_AGY_MODE',
];

function withFakeAgy(env, fn) {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of FAKE_ENV_KEYS) delete process.env[k]; });
}

function makeBrainDir() {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-bridge-brain-'));
  const conv = join(brainDir, 'aaaa-bbbb');
  mkdirSync(conv, { recursive: true });
  writeFileSync(join(conv, 'implementation_plan.md'), '# Build the widget\n\n- step 1\n- step 2\n');
  return brainDir;
}

// --- planToAdlcTickets: pure projection ---

test('planToAdlcTickets: projects id/title/body/scope/rails/edges, invents no new fields', () => {
  const plan = {
    repo: '/r',
    tickets: [
      {
        id: 'T1', title: 'Widget', body: 'do the widget', scope: ['src/widget/**'],
        rails: ['src/widget/schema.json'],
        edges: [{ to: 'T2', contract: 'exports buildWidget(spec)' }],
        tier: 'mid', pool_hint: 'auto', duration: 2,
      },
      { id: 'T2', title: 'UI', body: 'wire the ui', scope: ['src/ui/**'] },
    ],
  };
  const projected = planToAdlcTickets(plan);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[0], {
    id: 'T1', title: 'Widget', body: 'do the widget', scope: ['src/widget/**'],
    rails: ['src/widget/schema.json'],
    edges: [{ to: 'T2', contract: 'exports buildWidget(spec)' }],
    duration: 2,
  });
  // T2 has no rails/edges/duration declared — projection defaults, doesn't invent.
  assert.deepEqual(projected[1], {
    id: 'T2', title: 'UI', body: 'wire the ui', scope: ['src/ui/**'], rails: [], edges: [],
  });
  // Booster-only fields (tier, pool_hint) are NOT carried into the projection —
  // they aren't part of the @adlc/core ticket schema.
  assert.ok(!('tier' in projected[0]));
  assert.ok(!('pool_hint' in projected[0]));
});

test('planToAdlcTickets: empty ticket list projects to an empty array', () => {
  assert.deepEqual(planToAdlcTickets({ tickets: [] }), []);
  assert.deepEqual(planToAdlcTickets({}), []);
});

// --- planTicketToRailTicket: single-ticket rail-enforcement projection (B11) ---

test('planTicketToRailTicket: strips edges so a single-ticket file has none dangling (B11)', () => {
  const foundational = {
    id: 'T1', title: 'Widget', body: 'do the widget', scope: ['src/widget/**'],
    rails: ['src/widget/schema.json'],
    edges: [{ to: 'T2', contract: 'exports buildWidget(spec)' }],
    tier: 'mid', pool_hint: 'auto', duration: 2,
  };
  const rail = planTicketToRailTicket(foundational);
  // Keeps exactly what rail resolution + the plugin validator need: id, title,
  // scope, rails. Drops edges (the bug), body/duration, and booster-only fields.
  assert.deepEqual(rail, {
    id: 'T1', title: 'Widget', scope: ['src/widget/**'], rails: ['src/widget/schema.json'],
  });
  // The written single-ticket file passes the plugin's own validation — the
  // dangling-edge error that would fail railPreconditions CLOSED is gone.
  assert.deepEqual(pluginValidationErrors({ tickets: [rail] }), []);
});

test('planTicketToRailTicket: the UNSTRIPPED whole-plan projection of the same ticket WOULD dangle (characterizes the bug)', () => {
  const foundational = {
    id: 'T1', title: 'Widget', body: 'x', scope: ['a'], rails: ['r'],
    edges: [{ to: 'T2', contract: 'shared lane' }],
  };
  // planTicketToAdlcTicket (whole-plan projection) keeps the edge — as a lone
  // ticket it dangles and the plugin fails closed. This is precisely why the
  // single-ticket path must NOT reuse it.
  const wholePlanProjection = planToAdlcTickets({ tickets: [foundational] });
  assert.deepEqual(
    pluginValidationErrors({ tickets: wholePlanProjection }),
    ['T1: edge to unknown ticket T2'],
  );
  // ...and the rail projection of the same ticket is clean.
  assert.deepEqual(pluginValidationErrors({ tickets: [planTicketToRailTicket(foundational)] }), []);
});

test('planTicketToRailTicket: defaults absent scope/rails to [] and never invents fields', () => {
  assert.deepEqual(
    planTicketToRailTicket({ id: 'T9', title: 'bare', body: 'b' }),
    { id: 'T9', title: 'bare', scope: [], rails: [] },
  );
});

// --- planToAdlcTickets: whole-plan projection STILL carries edges (AC2) ---

test('planToAdlcTickets: whole-plan projection keeps edges (full DAG for the adlc CLI) — unchanged by B11', () => {
  const plan = {
    tickets: [
      { id: 'T1', title: 'a', body: 'x', scope: ['a'], edges: [{ to: 'T2', contract: 'c' }] },
      { id: 'T2', title: 'b', body: 'y', scope: ['b'] },
    ],
  };
  const projected = planToAdlcTickets(plan);
  assert.deepEqual(projected[0].edges, [{ to: 'T2', contract: 'c' }], 'edges preserved in the full-set projection');
  // The full set is internally consistent — every edge target present — so it
  // validates as a whole even though a single-ticket slice of it would not.
  assert.deepEqual(pluginValidationErrors({ tickets: projected }), []);
});

// --- writeAdlcTickets: store-aware filesystem write ---
//
// The ADLC's canonical ticket backend is the directory store (.adlc/tickets/
// with a .store.json manifest, one shard per ticket, shard name derived from
// the ticket id). The single-file .adlc/tickets.json is the 1.x legacy bridge.
// The projection must write IN KIND: directory store on new/migrated repos,
// legacy file only where one already exists — and never leave both, because
// the adlc-antigravity plugin's reader fails closed when both are present.

test('writeAdlcTickets: a repo with NO store gets a directory store, not tickets.json', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    const tickets = [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }];
    const path = writeAdlcTickets(repo, tickets);
    assert.equal(path, join(repo, '.adlc', 'tickets'));
    assert.ok(existsSync(join(path, '.store.json')), 'store manifest written');
    assert.ok(!existsSync(join(repo, '.adlc', 'tickets.json')), 'no legacy file in a new repo');
    assert.equal(readdirSync(path).length, 2, '.store.json + one shard');
    // The written store round-trips through the shared reader (@adlc/core).
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, []);
    assert.deepEqual(loaded, tickets);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: shard filenames follow the canonical ticketFilename(id) convention', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    const path = writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]);
    assert.ok(existsSync(join(path, ticketFilename('T1'))), 'shard named by canonical convention');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: re-projection removes stale shards from a prior projection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    writeAdlcTickets(repo, [
      { id: 'T1', title: 'a', body: 'x', scope: ['a'], rails: [], edges: [] },
      { id: 'T2', title: 'b', body: 'y', scope: ['b'], rails: [], edges: [] },
    ]);
    const path = writeAdlcTickets(repo, [{ id: 'T3', title: 'c', body: 'z', scope: ['c'], rails: [], edges: [] }]);
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, []);
    assert.deepEqual(loaded.map((t) => t.id), ['T3'], 'only the current projection remains');
    assert.equal(readdirSync(path).length, 2, 'stale T1/T2 shards removed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: a legacy-only repo keeps its legacy tickets.json (1.x bridge)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'tickets.json'), '{ "tickets": [] }\n');
    const tickets = [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }];
    const path = writeAdlcTickets(repo, tickets);
    assert.equal(path, join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { tickets });
    assert.ok(!existsSync(join(repo, '.adlc', 'tickets', '.store.json')), 'no directory store created beside the legacy file');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: when BOTH stores exist, the directory store wins and the legacy projection is removed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    // Simulate the conflicted state the plugin fails closed on.
    writeAdlcTickets(repo, [{ id: 'T1', title: 'a', body: 'x', scope: ['a'], rails: [], edges: [] }]);
    writeFileSync(join(repo, '.adlc', 'tickets.json'), '{ "tickets": [] }\n');
    const path = writeAdlcTickets(repo, [{ id: 'T2', title: 'b', body: 'y', scope: ['b'], rails: [], edges: [] }]);
    assert.equal(path, join(repo, '.adlc', 'tickets'));
    assert.ok(!existsSync(join(repo, '.adlc', 'tickets.json')), 'legacy projection artifact removed — both-stores is a fail-closed state for the plugin');
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, []);
    assert.deepEqual(loaded.map((t) => t.id), ['T2']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: refuses a symlinked store path (redirected cleanup would delete outside the store)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'agb-bridge-elsewhere-'));
  try {
    writeFileSync(join(elsewhere, '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');
    writeFileSync(join(elsewhere, 'victim.json'), '{}\n');
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    symlinkSync(elsewhere, join(repo, '.adlc', 'tickets'));
    assert.throws(
      () => writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]),
      /symlink/,
    );
    assert.ok(existsSync(join(elsewhere, 'victim.json')), 'nothing outside the store was deleted');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: single rail ticket (no body/edges) round-trips through the shared reader', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    const rail = planTicketToRailTicket({ id: 'T1', title: 'Widget', body: 'x', scope: ['src/**'], rails: ['schema.json'], edges: [{ to: 'T2' }] });
    writeAdlcTickets(repo, [rail]);
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, [], 'edge-free single rail ticket is valid in a directory shard');
    assert.deepEqual(loaded, [rail]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- Round-trip: brain → plan.json (compilePlan) → .adlc/tickets.json → adlc coldstart ---

test('round-trip: a successful compilePlan writes a projection adlc coldstart accepts', async () => {
  const brainDir = makeBrainDir();
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-roundtrip-'));
  try {
    await withFakeAgy({}, async () => {
      const r = await compilePlan('aaaa', { repo, brainDir, premortem: false });
      assert.equal(r.ok, true, 'compile should succeed against the fake-agy default fixtures');

      const storeDir = join(repo, '.adlc', 'tickets');
      assert.ok(existsSync(join(storeDir, '.store.json')), 'compilePlan projects into the directory ticket store on success');
      assert.ok(!existsSync(join(repo, '.adlc', 'tickets.json')), 'a fresh target repo gets no legacy tickets.json');

      const { tickets: written, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
      assert.deepEqual(errors, []);
      const planIds = r.plan.tickets.map((t) => t.id).sort();
      const projectedIds = written.map((t) => t.id).sort();
      assert.deepEqual(projectedIds, planIds, 'plan.json and the projected ticket store id sets match');

      // adlc coldstart must not error (schema/structural rejection) on a
      // well-formed projection. --prompt-only is keyless — no LLM provider
      // is required in CI — and is exactly what's being asserted here: the
      // projection is well-formed enough for coldstart to accept, not that
      // an actual LLM audit ran. --tickets resolves relative to cwd, so run
      // adlc from inside the target repo; a non-.json path selects the
      // directory-store reader (adlc >= 1.6.0).
      const out = execFileSync('adlc', ['coldstart', '--all', '--tickets', 'tickets', '--prompt-only'], {
        cwd: join(repo, '.adlc'),
        encoding: 'utf8',
      });
      assert.match(out, /auditing a ticket for executability/, 'coldstart accepted the projection and printed the audit prompt');
      for (const id of projectedIds) {
        assert.match(out, new RegExp(`"id":\\s*"${id}"`), `coldstart's prompt embeds ticket ${id} from the projection`);
      }
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('round-trip: a blocked compile (divergent parallax) does NOT publish .adlc/tickets.json', async () => {
  const brainDir = makeBrainDir();
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-blocked-'));
  try {
    await withFakeAgy({ FAKE_BRAIN_MODE: 'edges', FAKE_PARALLAX_VERDICT: 'divergent' }, async () => {
      const r = await compilePlan('aaaa', { repo, brainDir, premortem: false });
      assert.equal(r.ok, false);
      assert.ok(!existsSync(join(repo, '.adlc', 'tickets.json')), 'a blocked plan is never published as the active ticket set');
      assert.ok(!existsSync(join(repo, '.adlc', 'tickets')), 'a blocked plan publishes no directory store either');
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
