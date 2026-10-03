import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync, lstatSync, chmodSync, realpathSync, cpSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadTickets } from '@adlc/core/tickets';
import { ticketFilename } from '@adlc/tickets';

import { planToAdlcTickets, planTicketToRailTicket, writeAdlcTickets, authenticateAdlcPackage, resolveAdlcBinary, revalidateAdlcBinary, execFileAuthenticatedAdlc, resolveExecutionCommand, semverGte, parseSemver, KNOWN_ADLC_DIGESTS, isTemporaryOrWorldWritablePath, preventExecutableReplacement, recoverStaleExecutableLocks, pinExecutable } from '../lib/adlc-bridge.mjs';
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

test('writeAdlcTickets: refuses a symlinked .adlc directory', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'agb-bridge-elsewhere-'));
  try {
    writeFileSync(join(elsewhere, 'tickets.json'), '{"tickets":[]}\n');
    symlinkSync(elsewhere, join(repo, '.adlc'));
    assert.throws(
      () => writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]),
      /refusing to project tickets through a symlink/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: a symlink planted AT the shard name is unlinked, not written through', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  const victimDir = mkdtempSync(join(tmpdir(), 'agb-bridge-victim-'));
  try {
    // Shard names are deterministic per ticket id, so a crafted repo can
    // pre-commit a symlink where the projection will write. writeFileSync
    // follows symlinks — the write must unlink the shard first.
    const victim = join(victimDir, 'victim.conf');
    writeFileSync(victim, 'precious\n');
    const storeDir = join(repo, '.adlc', 'tickets');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');
    symlinkSync(victim, join(storeDir, ticketFilename('T1')));
    writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]);
    assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'symlink target untouched');
    assert.ok(!lstatSync(join(storeDir, ticketFilename('T1'))).isSymbolicLink(), 'shard is a regular file now');
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, []);
    assert.deepEqual(loaded.map((t) => t.id), ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: a symlinked legacy tickets.json is unlinked, not written through', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  const victimDir = mkdtempSync(join(tmpdir(), 'agb-bridge-victim-'));
  try {
    const victim = join(victimDir, 'victim.conf');
    writeFileSync(victim, 'precious\n');
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    symlinkSync(victim, join(repo, '.adlc', 'tickets.json'));
    const path = writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]);
    assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'symlink target untouched');
    assert.ok(!lstatSync(path).isSymbolicLink(), 'legacy file is a regular file now');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tickets.map((t) => t.id), ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: recovers an orphaned store dir (created, manifest never landed)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    // Simulate an interrupted first projection: the dir exists, .store.json
    // does not. initializeDirectoryStore would throw STORE_EXISTS forever.
    mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
    const path = writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]);
    assert.ok(existsSync(join(path, '.store.json')), 'manifest recovered');
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, []);
    assert.deepEqual(loaded.map((t) => t.id), ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: unlinks dangling symlinked .store.json during recovery and does not write through it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  const victimDir = mkdtempSync(join(tmpdir(), 'agb-bridge-victim-'));
  try {
    const victim = join(victimDir, 'escaped.json');
    const storeDir = join(repo, '.adlc', 'tickets');
    mkdirSync(storeDir, { recursive: true });
    // Plant dangling symlink at .store.json pointing outside repo
    symlinkSync(victim, join(storeDir, '.store.json'));

    const path = writeAdlcTickets(repo, [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }]);
    assert.equal(existsSync(victim), false, 'dangling symlink target must not be created outside repository');
    const manifestPath = join(path, '.store.json');
    assert.equal(lstatSync(manifestPath).isSymbolicLink(), false, 'manifest must be a regular file, not a symlink');
    const { tickets: loaded, errors } = loadTickets(join(repo, '.adlc', 'tickets.json'));
    assert.deepEqual(errors, []);
    assert.deepEqual(loaded.map((t) => t.id), ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
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

test('authenticateAdlcPackage: rejects sibling package directory escape and bin mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-auth-test-'));
  try {
    const legitimatePkg = join(root, 'node_modules', '@adlc', 'cli');
    const evilPkg = join(root, 'node_modules', '@adlc', 'cli-evil');
    mkdirSync(legitimatePkg, { recursive: true });
    mkdirSync(evilPkg, { recursive: true });

    writeFileSync(join(legitimatePkg, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: { adlc: './bin/adlc.js' },
    }));
    mkdirSync(join(legitimatePkg, 'bin'), { recursive: true });
    writeFileSync(join(legitimatePkg, 'bin', 'adlc.js'), '#!/usr/bin/env node\n');

    writeFileSync(join(evilPkg, 'evil.js'), '#!/usr/bin/env node\n');

    // Test sibling path escape: evil.js startsWith legitimatePkg as substring if no separator, but relative() starts with '..'
    const escapeCheck = authenticateAdlcPackage(legitimatePkg, join(evilPkg, 'evil.js'));
    assert.equal(escapeCheck.ok, false);
    assert.match(escapeCheck.error, /escapes package directory/);

    // Test mismatched bin target inside package: legitimate package has bin/other.js not declared in manifest
    writeFileSync(join(legitimatePkg, 'bin', 'other.js'), '#!/usr/bin/env node\n');
    const mismatchCheck = authenticateAdlcPackage(legitimatePkg, join(legitimatePkg, 'bin', 'other.js'));
    assert.equal(mismatchCheck.ok, false);
    assert.match(mismatchCheck.error, /does not match manifest bin target/);

    // Legitimate target passes
    const validCheck = authenticateAdlcPackage(legitimatePkg, join(legitimatePkg, 'bin', 'adlc.js'));
    assert.equal(validCheck.ok, true);
    assert.equal(validCheck.version, '1.11.1');

    // Test unresolvable / missing manifest bin target fails closed
    writeFileSync(join(legitimatePkg, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: { adlc: './bin/nonexistent.js' },
    }));
    const unresolvableCheck = authenticateAdlcPackage(legitimatePkg, join(legitimatePkg, 'bin', 'adlc.js'));
    assert.equal(unresolvableCheck.ok, false);
    assert.match(unresolvableCheck.error, /cannot be resolved/);

    // Test invalid non-string manifest bin target fails closed
    writeFileSync(join(legitimatePkg, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: { adlc: 12345 },
    }));
    const invalidTargetCheck = authenticateAdlcPackage(legitimatePkg, join(legitimatePkg, 'bin', 'adlc.js'));
    assert.equal(invalidTargetCheck.ok, false);
    assert.match(invalidTargetCheck.error, /invalid bin target/);

    // Test manifest.bin object lacking explicit 'adlc' key fails closed (no arbitrary fallback)
    writeFileSync(join(legitimatePkg, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: { other: './bin/other.js' },
    }));
    const missingAdlcKeyCheck = authenticateAdlcPackage(legitimatePkg, join(legitimatePkg, 'bin', 'adlc.js'));
    assert.equal(missingAdlcKeyCheck.ok, false);
    assert.match(missingAdlcKeyCheck.error, /invalid bin target/);

    // Test manifest.bin string passes when pointing to adlc.js
    writeFileSync(join(legitimatePkg, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: './bin/adlc.js',
    }));
    const stringBinCheck = authenticateAdlcPackage(legitimatePkg, join(legitimatePkg, 'bin', 'adlc.js'));
    assert.equal(stringBinCheck.ok, true);
    assert.equal(stringBinCheck.version, '1.11.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semverGte: compares prerelease identifiers following SemVer precedence', () => {
  assert.equal(semverGte('1.11.1', '1.11.0'), true);
  assert.equal(semverGte('1.11.0', '1.11.1'), false);
  assert.equal(semverGte('1.11.1', '1.11.1-rc.1'), true);
  assert.equal(semverGte('1.11.1-rc.1', '1.11.1'), false);
  assert.equal(semverGte('1.11.1-rc.2', '1.11.1-rc.1'), true);
  assert.equal(semverGte('1.11.1-rc.1', '1.11.1-rc.2'), false);
  assert.equal(semverGte('1.11.1-alpha', '1.11.1-beta'), false);
  assert.equal(semverGte('1.11.1-beta', '1.11.1-alpha'), true);
  assert.equal(semverGte('1.11.1-rc.1', '1.11.1-rc.1'), true);
});

test('parseSemver: rejects trailing data and malformed semver strings', () => {
  assert.equal(parseSemver('1.11.1.attacker'), null);
  assert.equal(parseSemver('1.11.1junk'), null);
  assert.equal(parseSemver('1.11'), null);
  assert.deepEqual(parseSemver('1.11.1-alpha.1'), { major: 1, minor: 11, patch: 1, prerelease: 'alpha.1', build: null });
  assert.deepEqual(parseSemver('1.11.1+build.123'), { major: 1, minor: 11, patch: 1, prerelease: null, build: 'build.123' });
  assert.deepEqual(parseSemver('1.11.1-rc.1+sha.abc'), { major: 1, minor: 11, patch: 1, prerelease: 'rc.1', build: 'sha.abc' });
  assert.equal(semverGte('1.11.1.attacker', '1.11.1'), false);
  assert.equal(semverGte('1.11.1junk', '1.11.1'), false);
});

test('authenticateAdlcPackage: validates lockfile entry, integrity, and version match', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-auth-lock-test-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: { adlc: './bin/adlc.js' },
    }));
    writeFileSync(join(pkgDir, 'bin', 'adlc.js'), '#!/usr/bin/env node\n');

    const lockPath = join(root, 'package-lock.json');

    // 1. Lockfile exists but lacks @adlc/cli entry -> fails closed
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {},
    }));
    const missingEntry = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), lockPath);
    assert.equal(missingEntry.ok, false);
    assert.match(missingEntry.error, /contains no matching entry for @adlc\/cli/);

    // 2. Lockfile entry lacks integrity -> fails closed
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/@adlc/cli': {
          version: '1.11.1',
        },
      },
    }));
    const missingIntegrity = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), lockPath);
    assert.equal(missingIntegrity.ok, false);
    assert.match(missingIntegrity.error, /lacks mandatory integrity field/);

    // 3. Lockfile version mismatch -> fails closed
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/@adlc/cli': {
          version: '1.10.0',
          integrity: 'sha512-test',
        },
      },
    }));
    const mismatch = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), lockPath);
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /version mismatch/);

    // 4. Valid lockfile entry -> succeeds
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/@adlc/cli': {
          version: '1.11.1',
          integrity: 'sha512-validintegrity',
        },
      },
    }));
    const valid = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), lockPath);
    assert.equal(valid.ok, true);
    assert.equal(valid.version, '1.11.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticateAdlcPackage: enforceKnownDigest validates lockfile, binarySha256, and treeDigest against KNOWN_ADLC_DIGESTS', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-auth-known-digest-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '1.11.1',
      bin: { adlc: './bin/adlc.js' },
    }));
    writeFileSync(join(pkgDir, 'bin', 'adlc.js'), '#!/usr/bin/env node\n');

    const lockPath = join(root, 'package-lock.json');
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/@adlc/cli': {
          version: '1.11.1',
          integrity: 'sha512-wrong-integrity',
        },
      },
    }));

    // 1. Lockfile integrity mismatch with enforceKnownDigest
    const badIntegrity = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), {
      lockfilePath: lockPath,
      enforceKnownDigest: true,
    });
    assert.equal(badIntegrity.ok, false);
    assert.match(badIntegrity.error, /integrity mismatch for @adlc\/cli/);

    // Update lockfile to correct known integrity
    const known = KNOWN_ADLC_DIGESTS['1.11.1'];
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/@adlc/cli': {
          version: '1.11.1',
          integrity: known.integrity,
        },
      },
    }));

    // 2. Binary sha256 mismatch with enforceKnownDigest
    const badBin = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), {
      lockfilePath: lockPath,
      enforceKnownDigest: true,
    });
    assert.equal(badBin.ok, false);
    assert.match(badBin.error, /binary candidate digest mismatch/);

    // 3. Tree digest mismatch with enforceKnownDigest (when binary digest matches via override)
    const badTree = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), {
      lockfilePath: lockPath,
      expectedDigest: crypto.createHash('sha256').update(readFileSync(join(pkgDir, 'bin', 'adlc.js'))).digest('hex'),
      enforceKnownDigest: true,
    });
    assert.equal(badTree.ok, false);
    assert.match(badTree.error, /package tree digest mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticateAdlcPackage: enforceKnownDigest fails closed when version is missing from KNOWN_ADLC_DIGESTS', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-auth-unknown-version-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@adlc/cli',
      version: '9.9.9',
      bin: { adlc: './bin/adlc.js' },
    }));
    writeFileSync(join(pkgDir, 'bin', 'adlc.js'), '#!/usr/bin/env node\n');

    const lockPath = join(root, 'package-lock.json');
    writeFileSync(lockPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/@adlc/cli': {
          version: '9.9.9',
          integrity: 'sha512-placeholder',
        },
      },
    }));

    const res = authenticateAdlcPackage(pkgDir, join(pkgDir, 'bin', 'adlc.js'), {
      lockfilePath: lockPath,
      enforceKnownDigest: true,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /no trusted lockfile integrity recorded in KNOWN_ADLC_DIGESTS for @adlc\/cli version 9\.9\.9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: does not return modified shim pointing outside authenticated target', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-shim-test-'));
  try {
    const nodeModules = join(root, 'node_modules');
    const binDir = join(nodeModules, '.bin');
    const adlcScopeDir = join(nodeModules, '@adlc');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(adlcScopeDir, { recursive: true });

    // Copy real @adlc/cli and link package-lock.json from current repo
    cpSync(join(process.cwd(), 'node_modules', '@adlc', 'cli'), join(adlcScopeDir, 'cli'), { recursive: true });
    symlinkSync(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));

    const expectedTarget = join(adlcScopeDir, 'cli', 'bin', 'adlc.mjs');

    // Create a modified shim in .bin/adlc that points to an untrusted file
    const shimPath = join(binDir, 'adlc');
    writeFileSync(shimPath, '#!/usr/bin/env node\n// evil modified shim\n');
    chmodSync(shimPath, 0o755);

    const res = resolveAdlcBinary({ repo: root });
    assert.equal(res.ok, true);
    // Must return the authenticated target directly, NOT the modified shimPath
    assert.equal(res.binary, expectedTarget);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: custom override rejects temporary directory on all platforms', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agb-temp-custom-test-'));
  try {
    const pkg = join(tmp, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.11.1', bin: { adlc: './adlc' } }));
    const bin = join(pkg, 'adlc');
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, 0o755);

    const res = resolveAdlcBinary({ env: { AGB_ADLC_BIN: bin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /violates path security constraints: resides in temporary directory/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: custom override rejects world-writable path', () => {
  if (process.platform === 'win32') return;
  const safeBase = mkdtempSync(join(process.cwd(), '.test-ww-'));
  try {
    const pkg = join(safeBase, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.11.1', bin: { adlc: './adlc' } }));
    const bin = join(pkg, 'adlc');
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, 0o777); // World-writable!

    const res = resolveAdlcBinary({ env: { AGB_ADLC_BIN: bin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /violates path security constraints: path component is world-writable/);
  } finally {
    rmSync(safeBase, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: rejects binary if any ancestor directory is world-writable', () => {
  if (process.platform === 'win32') return;
  const safeBase = mkdtempSync(join(process.cwd(), '.test-ww-ancestor-'));
  try {
    const subDir = join(safeBase, 'nested', 'deep');
    mkdirSync(subDir, { recursive: true });
    const pkg = join(subDir, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.11.1', bin: { adlc: './adlc' } }));
    const bin = join(pkg, 'adlc');
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, 0o755); // File itself is not world-writable!
    chmodSync(join(safeBase, 'nested'), 0o777); // Ancestor is world-writable!

    const res = resolveAdlcBinary({ env: { AGB_ADLC_BIN: bin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /violates path security constraints: path component is world-writable/);
  } finally {
    try { chmodSync(join(safeBase, 'nested'), 0o755); } catch {}
    rmSync(safeBase, { recursive: true, force: true });
  }
});

test('revalidateAdlcBinary: succeeds on authentic binary and fails closed if tampered before execution', () => {
  const root = mkdtempSync(join(process.cwd(), '.test-revalidate-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });

    // Copy actual package files from node_modules/@adlc/cli to create a valid fixture
    const realCliDir = join(process.cwd(), 'node_modules', '@adlc', 'cli');
    cpSync(realCliDir, pkgDir, { recursive: true });

    const initial = resolveAdlcBinary({ repo: root });
    assert.equal(initial.ok, true);

    // Initial revalidation passes
    const reval1 = revalidateAdlcBinary(initial.binary, { repo: root });
    assert.equal(reval1.ok, true);
    assert.equal(reval1.binary, initial.binary);

    // Now simulate an attacker modifying the executable in the gap before spawn
    chmodSync(initial.binary, 0o755);
    writeFileSync(initial.binary, '#!/usr/bin/env node\n// injected malicious payload\n');

    const reval2 = revalidateAdlcBinary(initial.binary, { repo: root });
    assert.equal(reval2.ok, false);
    assert.match(reval2.error, /digest mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revalidateAdlcBinary: detects .cmd and .bin shims, resolves package target JS, and authenticates', () => {
  const root = mkdtempSync(join(process.cwd(), '.test-revalidate-shim-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });

    const realCliDir = join(process.cwd(), 'node_modules', '@adlc', 'cli');
    cpSync(realCliDir, pkgDir, { recursive: true });

    // Create a .cmd shim in node_modules/.bin/adlc.cmd
    const binDir = join(root, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const cmdShim = join(binDir, 'adlc.cmd');
    writeFileSync(cmdShim, '@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe"  "%~dp0\\..\\@adlc\\cli\\bin\\adlc.mjs" %*\n) ELSE (\n  node  "%~dp0\\..\\@adlc\\cli\\bin\\adlc.mjs" %*\n)\n');

    const res = revalidateAdlcBinary(cmdShim, { repo: root });
    assert.equal(res.ok, true);
    assert.equal(res.binary, cmdShim);
    assert.ok(res.version);

    // If underlying JS binary in @adlc/cli is tampered with:
    const targetJs = join(pkgDir, 'bin', 'adlc.mjs');
    chmodSync(targetJs, 0o755);
    writeFileSync(targetJs, '// tampered\n');

    const resTampered = revalidateAdlcBinary(cmdShim, { repo: root });
    assert.equal(resTampered.ok, false);
    assert.match(resTampered.error, /digest mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execFileAuthenticatedAdlc: revalidates binary at execution boundary and rejects unauthentic binary', async () => {
  const root = mkdtempSync(join(process.cwd(), '.test-execfile-auth-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });

    const realCliDir = join(process.cwd(), 'node_modules', '@adlc', 'cli');
    cpSync(realCliDir, pkgDir, { recursive: true });

    const initial = resolveAdlcBinary({ repo: root });
    assert.equal(initial.ok, true);

    // Normal execution succeeds
    const res = await execFileAuthenticatedAdlc(initial.binary, ['--version'], {}, { repo: root });
    assert.ok(res.stdout);

    // Tamper with binary
    chmodSync(initial.binary, 0o755);
    writeFileSync(initial.binary, '#!/usr/bin/env node\n// tampered\n');

    // ExecFile rejects before running
    await assert.rejects(
      async () => {
        await execFileAuthenticatedAdlc(initial.binary, ['--version'], {}, { repo: root });
      },
      /Authenticated ADLC binary verification failed/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveExecutionCommand: avoids shell: true and invokes Node entrypoint directly', () => {
  // 1. JavaScript entrypoint invokes process.execPath with shell: false
  const jsCmd = resolveExecutionCommand({ target: '/repo/node_modules/@adlc/cli/bin/adlc.mjs' }, ['--version']);
  assert.equal(jsCmd.command, process.execPath);
  assert.deepEqual(jsCmd.args, ['/repo/node_modules/@adlc/cli/bin/adlc.mjs', '--version']);
  assert.equal(jsCmd.options.shell, false);

  // 2. Windows batch file with control characters fails closed
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    assert.throws(
      () => resolveExecutionCommand({ target: 'C:\\bin\\adlc.cmd' }, ['hello\nworld']),
      /Security violation: command argument contains control characters/
    );
    assert.throws(
      () => resolveExecutionCommand({ target: 'C:\\bin\\adlc.cmd' }, ['hello\rworld']),
      /Security violation: command argument contains control characters/
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('revalidateAdlcBinary: rejects custom binary in temporary directory even when custom is allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-reval-tmp-'));
  try {
    const fakeBin = join(root, 'adlc');
    writeFileSync(fakeBin, '#!/usr/bin/env node\n');
    chmodSync(fakeBin, 0o755);

    const res = revalidateAdlcBinary(fakeBin, {
      env: { AGB_ALLOW_CUSTOM_ADLC_CLI: '1', AGB_ADLC_BIN: fakeBin },
      allowCustom: true,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /violates path security constraints/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isTemporaryOrWorldWritablePath: allows non-writable ancestors owned by untrusted UIDs', () => {
  // Safe path in workspace
  const safePath = fileURLToPath(import.meta.url);
  const res = isTemporaryOrWorldWritablePath(safePath);
  assert.equal(res.restricted, false);
});

test('preventExecutableReplacement: locks executable fd, verifies integrity, and detects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-repl-test-'));
  try {
    const fakeBin = join(root, 'adlc.mjs');
    writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("hello");\n');
    chmodSync(fakeBin, 0o755);

    const seal = preventExecutableReplacement(fakeBin);
    try {
      assert.ok(seal.fd !== null, 'seal must hold an open file descriptor');

      // Integrity verification succeeds when untouched
      assert.doesNotThrow(() => seal.verifyUnchanged());

      // If tampered with, verifyUnchanged must throw
      try { chmodSync(fakeBin, 0o755); } catch {}
      writeFileSync(fakeBin, '#!/usr/bin/env node\n// tampered!\n');
      assert.throws(() => seal.verifyUnchanged(), /tampered with|unlocked|Security violation/);
    } finally {
      seal.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preventExecutableReplacement: detects directory replacement during execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-dir-repl-test-'));
  const sub = join(root, 'bin');
  mkdirSync(sub);
  try {
    const fakeBin = join(sub, 'adlc.mjs');
    writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("hello");\n');
    chmodSync(fakeBin, 0o755);

    const seal = preventExecutableReplacement(fakeBin);
    try {
      assert.doesNotThrow(() => seal.verifyUnchanged());

      // If directory is unlocked and replaced with another inode, verifyUnchanged must throw
      chmodSync(root, 0o755);
      const sub2 = join(root, 'bin2');
      mkdirSync(sub2);
      renameSync(sub, join(root, 'bin_old'));
      renameSync(sub2, sub);
      const newBin = join(sub, 'adlc.mjs');
      writeFileSync(newBin, '#!/usr/bin/env node\nconsole.log("swapped");\n');

      assert.throws(() => seal.verifyUnchanged(), /tampered with|replaced|unlocked|Security violation/);
    } finally {
      seal.release();
    }
  } finally {
    try { chmodSync(root, 0o755); } catch {}
    try { chmodSync(sub, 0o755); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('preventExecutableReplacement: does not mutate persistent permissions and provides crash-safe recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-crashsafe-test-'));
  const sub = join(root, 'node_modules', '@adlc', 'cli', 'bin');
  mkdirSync(sub, { recursive: true });
  try {
    const fakeBin = join(sub, 'adlc.mjs');
    writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("hello");\n');
    chmodSync(fakeBin, 0o755);

    // Simulate an ancestor directory left without write bits by an earlier crash
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    writeFileSync(join(pkgDir, 'package.json'), '{"name":"@adlc/cli","version":"1.11.1"}');
    chmodSync(pkgDir, 0o555); // write bit stripped

    // preventExecutableReplacement must recover write bits and not strip permissions from sub/root
    const seal = preventExecutableReplacement(fakeBin);
    try {
      assert.doesNotThrow(() => seal.verifyUnchanged());

      // Check that pkgDir had its write bit restored (crash-safe recovery)
      const pkgStat = statSync(pkgDir);
      assert.equal((pkgStat.mode & 0o200) !== 0, true, 'pkgDir write bit must be restored');

      // Check that bin directory and fakeBin remained writable (no persistent mutation)
      const subStat = statSync(sub);
      assert.equal((subStat.mode & 0o200) !== 0, true, 'sub directory write bit must not be stripped');
      const binStat = statSync(fakeBin);
      assert.equal((binStat.mode & 0o200) !== 0, true, 'fakeBin write bit must not be stripped');

      // Pinned copy is write-locked (0o500)
      if (seal.pinnedPath) {
        const pinnedStat = statSync(seal.pinnedPath);
        assert.equal((pinnedStat.mode & 0o222) === 0, true, 'pinned binary must be write-locked');
      }
    } finally {
      seal.release();
    }

    // After release, permissions must be restored (crash-safe and install-ready)
    const pkgStatAfter = statSync(pkgDir);
    assert.equal((pkgStatAfter.mode & 0o200) !== 0, true, 'pkgDir write bit must be restored after release');
    const subStatAfter = statSync(sub);
    assert.equal((subStatAfter.mode & 0o200) !== 0, true, 'sub directory write bit must be restored after release');

    // Test stale lock recovery from an ungraceful crash (dead PID)
    const locksDir = join(tmpdir(), 'agb_adlc_locks');
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    chmodSync(pkgDir, 0o555); // simulate left read-only by crash
    const fakeLockFile = join(locksDir, `9999999_testlock.json`);
    writeFileSync(fakeLockFile, JSON.stringify({
      pid: 9999999, // dead PID
      startTime: 'dead-start-time',
      ts: Date.now() - 1000,
      paths: [{ path: pkgDir, origMode: 0o755 }],
    }));

    const recovered = recoverStaleExecutableLocks(locksDir);
    assert.ok(recovered >= 1, 'stale lock must be recovered');
    assert.equal(existsSync(fakeLockFile), false, 'stale lock file must be removed');
    const pkgStatRecovered = statSync(pkgDir);
    assert.equal((pkgStatRecovered.mode & 0o200) !== 0, true, 'pkgDir write bit must be recovered from stale lock');
  } finally {
    try { chmodSync(root, 0o755); } catch {}
    try { chmodSync(sub, 0o755); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('resolveAdlcBinary: custom override resolves shims in .bin to @adlc/cli package target', () => {
  const root = mkdtempSync(join(process.cwd(), '.test-custom-shim-'));
  try {
    const binDir = join(root, 'node_modules', '.bin');
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    const pkgBinDir = join(pkgDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(pkgBinDir, { recursive: true });

    const pkgJson = {
      name: '@adlc/cli',
      version: '1.11.1',
      bin: './bin/adlc.js',
    };
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
    const targetScript = join(pkgBinDir, 'adlc.js');
    writeFileSync(targetScript, '#!/usr/bin/env node\nconsole.log("adlc 1.11.1");\n');
    chmodSync(targetScript, 0o755);

    const shimCmd = join(binDir, 'adlc.cmd');
    writeFileSync(shimCmd, '@ECHO off\r\nnode "%~dp0\\..\\@adlc\\cli\\bin\\adlc.js" %*\r\n');
    chmodSync(shimCmd, 0o755);

    const res = resolveAdlcBinary({
      repo: root,
      env: {
        AGB_ADLC_BIN: shimCmd,
        AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
      },
      allowCustom: true,
    });
    assert.equal(res.ok, true, `must resolve custom shim: ${res.error}`);
    assert.equal(res.source, 'custom-override');
    assert.equal(res.version, '1.11.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revalidateAdlcBinary: seals executable when binaryPath is omitted', () => {
  const root = mkdtempSync(join(process.cwd(), '.test-reval-seal-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    const realCliDir = join(process.cwd(), 'node_modules', '@adlc', 'cli');
    cpSync(realCliDir, pkgDir, { recursive: true });

    const verified = revalidateAdlcBinary(undefined, {
      repo: root,
      lockExecutable: true,
      allowCustom: false,
    });

    try {
      assert.equal(verified.ok, true, `revalidate must succeed: ${verified.error}`);
      assert.ok(verified.seal !== null, 'seal must be instantiated when binaryPath is omitted');
      assert.doesNotThrow(() => verified.seal.verifyUnchanged());
    } finally {
      verified.seal?.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preventExecutableReplacement: pins standalone binary executables and resolveExecutionCommand executes pinned path', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-pinned-bin-test-'));
  try {
    const fakeBin = join(root, 'adlc-native');
    writeFileSync(fakeBin, '#!/bin/sh\necho "native adlc"\n');
    chmodSync(fakeBin, 0o755);

    const seal = preventExecutableReplacement(fakeBin);
    try {
      assert.ok(seal.pinnedPath !== null, 'seal must create a pinned binary path for standalone binaries');
      assert.ok(existsSync(seal.pinnedPath), 'pinned binary file must exist');
      const pinnedStat = statSync(seal.pinnedPath);
      assert.equal((pinnedStat.mode & 0o222) === 0, true, 'pinned binary must be read-only (immutable)');

      const cmd = resolveExecutionCommand({ seal, target: fakeBin, binary: fakeBin }, ['--version']);
      assert.equal(cmd.command, seal.pinnedPath, 'resolveExecutionCommand must execute the pinned path');
    } finally {
      seal.release();
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('writeAdlcTickets: replaces symlinked .store.json even when backend is already directory', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-manifest-symlink-test-'));
  const victimDir = mkdtempSync(join(tmpdir(), 'agb-manifest-victim-'));
  try {
    const storeDir = join(repo, '.adlc', 'tickets');
    mkdirSync(storeDir, { recursive: true });
    const victim = join(victimDir, 'target.json');
    writeFileSync(victim, JSON.stringify({ victim: true }));
    symlinkSync(victim, join(storeDir, '.store.json'));

    // Write a dummy ticket shard so store appears to be directory store
    writeFileSync(join(storeDir, 't1.json'), JSON.stringify({ id: 't1' }));

    const written = writeAdlcTickets(repo, [{ id: 't1', title: 't1', body: 'b', scope: [], rails: [], edges: [] }]);
    const manifestPath = join(written, '.store.json');
    assert.equal(lstatSync(manifestPath).isSymbolicLink(), false, '.store.json must not remain a symlink');
    assert.equal(lstatSync(manifestPath).isFile(), true, '.store.json must be a regular file');
    const victimContent = readFileSync(victim, 'utf8');
    assert.ok(victimContent.includes('"victim":true'), 'victim file must not be overwritten through symlink');
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(victimDir, { recursive: true, force: true }); } catch {}
  }
});

test('preventExecutableReplacement: copies entire dependency closure without symlinks and keeps active tree alive during recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-closure-pin-test-'));
  const locksDir = mkdtempSync(join(tmpdir(), 'agb-test-locks-'));
  const origExecLocks = process.env.AGB_EXEC_LOCKS_DIR;
  process.env.AGB_EXEC_LOCKS_DIR = locksDir;

  try {
    const cliDir = join(root, 'node_modules', '@adlc', 'cli');
    const coreDir = join(root, 'node_modules', '@adlc', 'core');
    mkdirSync(join(cliDir, 'bin'), { recursive: true });
    mkdirSync(coreDir, { recursive: true });

    writeFileSync(join(cliDir, 'package.json'), '{"name":"@adlc/cli","version":"1.11.1"}');
    const fakeBin = join(cliDir, 'bin', 'adlc.mjs');
    writeFileSync(fakeBin, '#!/usr/bin/env node\nimport "@adlc/core";\n');
    chmodSync(fakeBin, 0o755);

    writeFileSync(join(coreDir, 'package.json'), '{"name":"@adlc/core","version":"1.11.1"}');
    writeFileSync(join(coreDir, 'index.js'), 'export const core = true;\n');

    const seal = preventExecutableReplacement(fakeBin);
    try {
      let pinnedDir = dirname(seal.pinnedPath);
      while (pinnedDir && !basename(pinnedDir).startsWith('agb-pinned-adlc-')) {
        pinnedDir = dirname(pinnedDir);
      }
      const pinnedCore = join(pinnedDir, 'node_modules', '@adlc', 'core');
      assert.ok(existsSync(pinnedCore), 'pinned copy must include dependency closure (@adlc/core)');
      assert.equal(lstatSync(pinnedCore).isSymbolicLink(), false, 'dependency closure must be a real copy, not a symlink');

      // Run recovery during active execution — must keep active pinned tree alive
      recoverStaleExecutableLocks(locksDir);
      assert.ok(existsSync(pinnedDir), 'active pinned tree must NOT be pruned by recovery while process is alive');
    } finally {
      seal.release();
    }
  } finally {
    process.env.AGB_EXEC_LOCKS_DIR = origExecLocks;
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { rmSync(locksDir, { recursive: true, force: true }); } catch {}
  }
});

test('pinExecutable and preventExecutableReplacement: fails closed when executable pinning cannot be completed', () => {
  // 1. Non-existent path throws in pinExecutable
  assert.throws(
    () => pinExecutable('/nonexistent/binary/path', null),
    /Failed to pin ADLC executable for authenticated execution/
  );

  // 2. resolveExecutionCommand rejects seal with missing or null pinnedPath
  assert.throws(
    () => resolveExecutionCommand({ seal: { pinnedPath: null }, binary: '/some/path' }, []),
    /Authenticated execution requires a verified pinned executable/
  );
});

test('preventExecutableReplacement: rejects symlinks in copied dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-dep-symlink-test-'));
  try {
    const cliDir = join(root, 'node_modules', '@adlc', 'cli');
    const coreDir = join(root, 'node_modules', '@adlc', 'core');
    mkdirSync(join(cliDir, 'bin'), { recursive: true });
    mkdirSync(coreDir, { recursive: true });

    writeFileSync(join(cliDir, 'package.json'), '{"name":"@adlc/cli","version":"1.11.1"}');
    const fakeBin = join(cliDir, 'bin', 'adlc.mjs');
    writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log(1);\n');
    chmodSync(fakeBin, 0o755);

    writeFileSync(join(coreDir, 'package.json'), '{"name":"@adlc/core","version":"1.11.1"}');
    // Plant an internal symlink inside dependency
    const outsideTarget = join(tmpdir(), `agb-sym-target-${crypto.randomUUID()}`);
    writeFileSync(outsideTarget, 'malicious');
    try {
      symlinkSync(outsideTarget, join(coreDir, 'sym.js'));
    } catch {}

    assert.throws(
      () => preventExecutableReplacement(fakeBin),
      /Security violation/
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('revalidateAdlcBinary: authenticates pinned bytes and fails closed on source-versus-pinned TOCTOU', () => {
  const root = mkdtempSync(join(process.cwd(), '.test-reval-toctou-'));
  try {
    const pkgDir = join(root, 'node_modules', '@adlc', 'cli');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });

    const realCliDir = join(process.cwd(), 'node_modules', '@adlc', 'cli');
    cpSync(realCliDir, pkgDir, { recursive: true });

    const targetBin = join(pkgDir, 'bin', 'adlc.mjs');

    // Simulate an attacker modifying the file so pinned copy gets bad bytes
    writeFileSync(targetBin, '#!/usr/bin/env node\n// malicious injected code\n');

    // Even if source was modified before and could be restored, revalidateAdlcBinary authenticates the pinned tree
    const res = revalidateAdlcBinary(targetBin, { repo: root });
    assert.equal(res.ok, false);
    assert.match(res.error, /digest mismatch/);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('preventExecutableReplacement: verifies transitive dependency tree digests and fails closed when dependency is tampered', () => {
  const root = mkdtempSync(join(process.cwd(), '.test-dep-tamper-'));
  try {
    const cliDir = join(root, 'node_modules', '@adlc', 'cli');
    const coreDir = join(root, 'node_modules', '@adlc', 'core');
    mkdirSync(join(cliDir, 'bin'), { recursive: true });
    mkdirSync(coreDir, { recursive: true });

    // Copy genuine cli package
    const realCliDir = join(process.cwd(), 'node_modules', '@adlc', 'cli');
    cpSync(realCliDir, cliDir, { recursive: true });

    // Copy genuine core package then tamper with it
    const realCoreDir = join(process.cwd(), 'node_modules', '@adlc', 'core');
    cpSync(realCoreDir, coreDir, { recursive: true });

    // Inject malicious modification into transitive dependency
    writeFileSync(join(coreDir, 'malicious.js'), '// injected backdoor\n');

    const targetBin = join(cliDir, 'bin', 'adlc.mjs');

    assert.throws(
      () => preventExecutableReplacement(targetBin, {
        pkgDir: cliDir,
        enforceKnownDigest: true,
      }),
      /Security violation: package tree digest mismatch for dependency @adlc\/core/
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});





