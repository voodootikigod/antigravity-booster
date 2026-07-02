import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planToAdlcTickets, writeAdlcTickets } from '../lib/adlc-bridge.mjs';
import { compilePlan } from '../lib/plan.mjs';

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

// --- writeAdlcTickets: filesystem write ---

test('writeAdlcTickets: writes {tickets:[...]} to <repo>/.adlc/tickets.json', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    const tickets = [{ id: 'T1', title: 'x', body: 'y', scope: ['a'], rails: [], edges: [] }];
    const path = writeAdlcTickets(repo, tickets);
    assert.equal(path, join(repo, '.adlc', 'tickets.json'));
    assert.ok(existsSync(path));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(written, { tickets });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('writeAdlcTickets: creates .adlc/ if it does not exist yet', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-bridge-repo-'));
  try {
    assert.ok(!existsSync(join(repo, '.adlc')));
    writeAdlcTickets(repo, []);
    assert.ok(existsSync(join(repo, '.adlc', 'tickets.json')));
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

      const adlcPath = join(repo, '.adlc', 'tickets.json');
      assert.ok(existsSync(adlcPath), 'compilePlan writes .adlc/tickets.json into the target repo on success');

      const written = JSON.parse(readFileSync(adlcPath, 'utf8'));
      const planIds = r.plan.tickets.map((t) => t.id).sort();
      const projectedIds = written.tickets.map((t) => t.id).sort();
      assert.deepEqual(projectedIds, planIds, 'plan.json and .adlc/tickets.json ticket id sets match');

      // adlc coldstart must not error (schema/structural rejection) on a
      // well-formed projection. --prompt-only is keyless — no LLM provider
      // is required in CI — and is exactly what's being asserted here: the
      // projection is well-formed enough for coldstart to accept, not that
      // an actual LLM audit ran. --tickets resolves relative to cwd, so run
      // adlc from inside the target repo.
      const out = execFileSync('adlc', ['coldstart', '--all', '--tickets', 'tickets.json', '--prompt-only'], {
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
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
