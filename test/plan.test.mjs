import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlan, planEdges, compilePlan, premortemPlan, parallaxEdges, PARALLAX_READER_SCHEMA, PARALLAX_JUDGE_SCHEMA, PREMORTEM_SCHEMA } from '../lib/plan.mjs';
import { coldstartTickets, COLDSTART_SCHEMA, preflight, hashTicketColdstart } from '../lib/preflight.mjs';
import { DecisionEngine } from '../lib/decision-engine.mjs';
import { readBrain } from '../lib/brain.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_plan_test_${process.pid}.json`);

const FAKE_ENV_KEYS = [
  'AGB_AGY_BIN', 'FAKE_STATE_DIR', 'FAKE_BRAIN_MODE',
  'FAKE_COLDSTART_MODE', 'FAKE_PARALLAX_VERDICT', 'FAKE_PREMORTEM_MODE',
  'FAKE_AGY_MODE',
];

/** Brain fixture: one conversation with a plan artifact. Returns its dir. */
function makeBrainDir() {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-plan-'));
  const conv = join(brainDir, 'aaaa-bbbb');
  mkdirSync(conv, { recursive: true });
  writeFileSync(join(conv, 'implementation_plan.md'), '# Build the widget\n\n- step 1\n- step 2\n');
  return brainDir;
}

function withFakeAgy(env, fn) {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of FAKE_ENV_KEYS) delete process.env[k]; });
}

// --- validatePlan (moved from bin/agb.mjs; the CLI tests in unit.test.mjs
// cover the file-loading path, these cover the shared object validator) ---

test('validatePlan: catches missing repo/gate, dup ids, bad edges, cycles, unroutable tiers', () => {
  const errs = validatePlan({
    tickets: [
      { id: 'T1', title: 'a', body: 'x', scope: ['a'], edges: [{ to: 'T2' }], tier: 'cheap', pool_hint: 'claude' },
      { id: 'T1', title: 'dup', body: 'x', scope: ['b'] },
      { id: 'T2', title: 'b', body: 'x', scope: ['c'], edges: [{ to: 'T1' }, { to: 'NOPE' }] },
    ],
  });
  assert.ok(errs.some((e) => /repo is required/.test(e)));
  assert.ok(errs.some((e) => /gate must declare/.test(e)));
  assert.ok(errs.some((e) => /duplicate ticket id: T1/.test(e)));
  assert.ok(errs.some((e) => /unknown ticket 'NOPE'/.test(e)));
  assert.ok(errs.some((e) => /cycle in ticket DAG/.test(e)));
  assert.ok(errs.some((e) => /no model candidates for tier 'cheap' with pool_hint 'claude'/.test(e)));
});

test('validatePlan: handles malformed edge entries gracefully without throwing', () => {
  const errs = validatePlan({
    repo: '/r',
    gate: { test: 'npm test' },
    tickets: [
      { id: 'T1', title: 'a', body: 'x', scope: ['a/**'], edges: [null, { to: 123 }, { invalid: true }] },
      { id: 'T2', title: 'b', body: 'x', scope: ['b/**'] },
    ],
  });
  assert.ok(errs.length > 0);
  assert.ok(errs.some((e) => /edge must declare a valid 'to' field/.test(e)));

  // Test planEdges with null / malformed edges
  const edges = planEdges([
    { id: 'T1', edges: [null, undefined, { to: null }, { to: 'T2' }] },
    { id: 'T2' },
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from.id, 'T1');
  assert.equal(edges[0].to.id, 'T2');
});

test('validatePlan: rejects invalid scope and rail pathspecs', () => {
  const badScope = validatePlan({
    repo: '/r', gate: { test: 'npm test' },
    tickets: [
      { id: 'T1', title: 'a', body: 'x', scope: ['*'] },
    ],
  });
  assert.ok(badScope.some((e) => e === "T1: invalid scope pathspec '*'"));

  const badRail = validatePlan({
    repo: '/r', gate: { test: 'npm test' },
    tickets: [
      { id: 'T2', title: 'b', body: 'x', scope: ['src/**'], rails: ['lib/./gates.mjs'] },
    ],
  });
  assert.ok(badRail.some((e) => e === "T2: invalid rail pathspec 'lib/./gates.mjs'"));
});

test('validatePlan: rejects plan.adlcBin injection', () => {
  const errs = validatePlan({
    repo: '/r', gate: { test: 'npm test' },
    adlcBin: '/evil/adlc',
    tickets: [
      { id: 'T1', title: 'a', body: 'x', scope: ['a/**'] },
    ],
  });
  assert.ok(errs.some((e) => /plan\.adlcBin is prohibited/.test(e)));
});

test('validatePlan: accepts a well-formed plan; planEdges resolves pairs', () => {
  const plan = {
    repo: '/r', gate: { test: 'npm test' },
    tickets: [
      { id: 'T1', title: 'a', body: 'x', scope: ['a/**'], edges: [{ to: 'T2' }] },
      { id: 'T2', title: 'b', body: 'x', scope: ['b/**'] },
    ],
  };
  assert.deepEqual(validatePlan(plan), []);
  const edges = planEdges(plan.tickets);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from.id, 'T1');
  assert.equal(edges[0].to.id, 'T2');
});

// --- compilePlan pipeline ---

test('compilePlan: happy path stamps provenance and runs all gates once', async () => {
  const brainDir = makeBrainDir();
  try {
    await withFakeAgy({}, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir });
      assert.equal(r.ok, true);
      assert.equal(r.report.attempts, 1);
      assert.equal(r.report.gatePasses, 1);
      assert.deepEqual(r.plan.source, { type: 'antigravity-brain', id: 'aaaa-bbbb', title: 'Build the widget' });
      assert.equal(r.plan.repo, '/r');
      assert.deepEqual(r.report.blocking, []);
      // premortem is attached and advisory
      assert.equal(r.report.premortem.causes.length, 1);
      assert.match(r.report.premortem.causes[0].cause, /widget schema/);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('compilePlan: structural defects feed back into a re-conversion', async () => {
  const brainDir = makeBrainDir();
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-state-'));
  try {
    await withFakeAgy({ FAKE_BRAIN_MODE: 'invalid-then-good', FAKE_STATE_DIR: stateDir }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, premortem: false, parallax: false });
      // attempt 1: empty body + scope overlap; attempt 2 carries the
      // compiler feedback block (fake-agy stays broken without it)
      assert.equal(r.ok, true);
      assert.equal(r.report.attempts, 2);
      assert.deepEqual(r.report.structuralErrors, []);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('compilePlan: structural failure after maxAttempts reports errors, never gates', async () => {
  const brainDir = makeBrainDir();
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-state2-'));
  try {
    await withFakeAgy({ FAKE_BRAIN_MODE: 'invalid-then-good', FAKE_STATE_DIR: stateDir }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, maxAttempts: 1 });
      assert.equal(r.ok, false);
      assert.equal(r.report.attempts, 1);
      assert.equal(r.report.gatePasses, 0);
      assert.ok(r.report.structuralErrors.length > 0);
      assert.ok(r.report.blocking.length > 0);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('compilePlan: coldstart gaps trigger one gate-feedback round, then pass', async () => {
  const brainDir = makeBrainDir();
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-state3-'));
  try {
    await withFakeAgy({ FAKE_COLDSTART_MODE: 'gap-once', FAKE_STATE_DIR: stateDir }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, premortem: false });
      assert.equal(r.ok, true);
      assert.equal(r.report.attempts, 2, 'gap must cause one feedback re-conversion');
      assert.equal(r.report.gatePasses, 2);
      assert.deepEqual(r.report.blocking, []);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('compilePlan: persistent coldstart gaps block with remediation findings', async () => {
  const brainDir = makeBrainDir();
  try {
    await withFakeAgy({ FAKE_COLDSTART_MODE: 'gap' }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, premortem: false });
      assert.equal(r.ok, false);
      assert.equal(r.report.gatePasses, 2);
      assert.ok(r.report.blocking.some((b) => /underspecified/.test(b)));
      assert.equal(r.report.gaps[0].gaps[0], 'acceptance criteria undefined');
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('compilePlan: divergent parallax edge blocks; converged edge passes', async () => {
  const brainDir = makeBrainDir();
  try {
    await withFakeAgy({ FAKE_BRAIN_MODE: 'edges', FAKE_PARALLAX_VERDICT: 'divergent' }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, premortem: false });
      assert.equal(r.ok, false);
      assert.equal(r.report.parallax.length, 1);
      assert.equal(r.report.parallax[0].edge, 'T1->T2');
      assert.equal(r.report.parallax[0].divergent, true);
      assert.ok(r.report.blocking.some((b) => /contract ambiguity/.test(b)));
    });
    await withFakeAgy({ FAKE_BRAIN_MODE: 'edges' }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, premortem: false });
      assert.equal(r.ok, true);
      assert.equal(r.report.parallax[0].divergent, false);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('compilePlan: premortem failure is tolerated (advisory, never a veto)', async () => {
  const brainDir = makeBrainDir();
  try {
    await withFakeAgy({ FAKE_PREMORTEM_MODE: 'garbage' }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir });
      assert.equal(r.ok, true);
      assert.equal(r.report.premortem.error, 'unparseable premortem output');
      assert.deepEqual(r.report.premortem.causes, []);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

// --- gate units ---

test('premortemPlan/parallaxEdges: standalone results parse from fake responders', async () => {
  const brainDir = makeBrainDir();
  try {
    await withFakeAgy({}, async () => {
      const brain = readBrain('aaaa', brainDir);
      const plan = {
        repo: '/r', gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'a', body: 'x', scope: ['a/**'], edges: [{ to: 'T2' }] },
          { id: 'T2', title: 'b', body: 'x', scope: ['b/**'] },
        ],
      };
      const pm = await premortemPlan(plan, brain);
      assert.equal(pm.causes.length, 1);
      const lax = await parallaxEdges(plan, { n: 2 });
      assert.equal(lax.length, 1);
      assert.equal(lax[0].divergent, false);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('premortemPlan/parallaxEdges: keep quota admission advisory when pools.acquire rejects', async () => {
  const brainDir = makeBrainDir();
  try {
    const brain = readBrain('aaaa', brainDir);
    const plan = {
      repo: '/r', gate: { test: 'true' },
      tickets: [
        { id: 'T1', title: 'a', body: 'x', scope: ['a/**'], edges: [{ to: 'T2' }] },
        { id: 'T2', title: 'b', body: 'x', scope: ['b/**'] },
      ],
    };
    const failingPools = {
      acquire: async () => {
        throw new Error('Quota circuit breaker is tripped; dispatch suspended');
      },
    };
    const pm = await premortemPlan(plan, brain, { pools: failingPools });
    assert.deepEqual(pm.causes, []);
    assert.match(pm.error, /quota admission failed: Quota circuit breaker is tripped/);

    const lax = await parallaxEdges(plan, { pools: failingPools, n: 1 });
    assert.equal(lax.length, 1);
    assert.match(lax[0].error, /quota admission failed: Quota circuit breaker is tripped/);
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

// --- CLI ---

test('agb plan: compiles a brain into plan.json with provenance, refuses overwrite', async () => {
  const brainDir = makeBrainDir();
  const outDir = mkdtempSync(join(tmpdir(), 'agb-out-'));
  const out = join(outDir, 'plan.json');
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_BRAIN_DIR: brainDir };
  try {
    execFileSync(process.execPath, [AGB_BIN, 'plan', 'aaaa', '/r', '--out', out, '--no-premortem'], {
      encoding: 'utf8', stdio: 'pipe', env,
    });
    assert.ok(existsSync(out));
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(plan.source.id, 'aaaa-bbbb');
    assert.ok(plan.tickets.length >= 1);
    // second run without --force must refuse to clobber
    assert.throws(
      () => execFileSync(process.execPath, [AGB_BIN, 'plan', 'aaaa', '/r', '--out', out], { encoding: 'utf8', stdio: 'pipe', env }),
      (err) => err.status === 1 && /already exists/.test(err.stderr),
    );
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('agb plan: blocking findings exit 2 and point remediation at Antigravity', async () => {
  const brainDir = makeBrainDir();
  const outDir = mkdtempSync(join(tmpdir(), 'agb-out2-'));
  const out = join(outDir, 'plan.json');
  const env = {
    ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_BRAIN_DIR: brainDir,
    FAKE_COLDSTART_MODE: 'gap',
  };
  try {
    assert.throws(
      () => execFileSync(process.execPath, [AGB_BIN, 'plan', 'aaaa', '/r', '--out', out, '--no-premortem'], { encoding: 'utf8', stdio: 'pipe', env }),
      (err) => err.status === 2 && /refine it in Antigravity/.test(err.stderr),
    );
    assert.ok(!existsSync(out), 'a blocked compile must not write a plan file');
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('compilePlan: local spec file path option resolve and source type stamp', async () => {
  const tmpFile = join(tmpdir(), `agb-test-spec-${Date.now()}.md`);
  writeFileSync(tmpFile, '# My Custom Spec\nDescription of task\n');
  try {
    await withFakeAgy({}, async () => {
      const r = await compilePlan(tmpFile, { repo: '/r', premortem: false, parallax: false, coldstart: false });
      assert.equal(r.ok, true);
      assert.equal(r.plan.source.type, 'local-spec');
      assert.equal(r.plan.source.id, resolve(tmpFile));
      assert.equal(r.plan.source.title, 'My Custom Spec');
      assert.equal(r.report.attempts, 1);
    });
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

test('compilePlan: conversion hard-failure (brainToPlan throw) retries and fails gracefully', async () => {
  const brainDir = makeBrainDir();
  try {
    await withFakeAgy({ FAKE_AGY_MODE: 'fail' }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, maxAttempts: 2, premortem: false, parallax: false, coldstart: false });
      assert.equal(r.ok, false);
      assert.equal(r.report.attempts, 2);
      assert.equal(r.report.gatePasses, 0);
      assert.ok(r.report.blocking.some((b) => /conversion error: brain conversion failed/.test(b)));
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('agb plan: compiles local spec path with spec provenance and prints customized spec messages', async () => {
  const tmpFile = join(tmpdir(), `agb-test-cli-spec-${Date.now()}.md`);
  writeFileSync(tmpFile, '# My CLI Spec\nDescription\n');
  const outDir = mkdtempSync(join(tmpdir(), 'agb-cli-out-'));
  const out = join(outDir, 'plan.json');
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY };
  try {
    // 1. Success path: compiled from spec
    const res = spawnSync(process.execPath, [
      AGB_BIN, 'plan', tmpFile, '/r', '--out', out, '--no-premortem', '--no-parallax', '--no-coldstart'
    ], { encoding: 'utf8', env });
    if (res.status !== 0) {
      console.error('SUCCESS PATH FAILED:', res.status);
      console.error('STDOUT:', res.stdout);
      console.error('STDERR:', res.stderr);
    }
    assert.equal(res.status, 0);
    assert.match(res.stderr, /compiled from spec 'My CLI Spec'/);
    assert.ok(existsSync(out));

    // 2. Failure path: edit <path> and re-run
    rmSync(out, { force: true });
    const resFail = spawnSync(process.execPath, [
      AGB_BIN, 'plan', tmpFile, '/r', '--out', out, '--no-premortem', '--no-parallax', '--no-coldstart'
    ], { encoding: 'utf8', env: { ...env, FAKE_AGY_MODE: 'fail' } });
    if (resFail.status !== 2) {
      console.error('FAILURE PATH FAILED:', resFail.status);
      console.error('STDOUT:', resFail.stdout);
      console.error('STDERR:', resFail.stderr);
    }
    assert.equal(resFail.status, 2);
    assert.match(resFail.stderr, /edit .* and re-run/);
    assert.ok(!existsSync(out));
  } finally {
    rmSync(tmpFile, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('coldstartTickets: fails closed with error when model response is garbage or missing required gaps field', async () => {
  const tickets = [{ id: 'T1', title: 'T1', body: 'body', scope: ['src/**'] }];
  await withFakeAgy({ FAKE_COLDSTART_MODE: 'garbage' }, async () => {
    const res = await coldstartTickets(tickets, { test: 'npm test' });
    assert.equal(res.length, 1);
    assert.ok(res[0].error, 'must report error when model output violates schema or is unparseable');
  });
});

test('coldstartTickets: captures quota admission errors per ticket rather than rejecting', async () => {
  const tickets = [
    { id: 'T1', title: 'T1', body: 'body 1', scope: ['src/a'] },
    { id: 'T2', title: 'T2', body: 'body 2', scope: ['src/b'] },
  ];
  const pools = {
    acquire: async (model, opts) => {
      if (opts.ticketId === 'T2') {
        throw new Error('pool capacity exhausted');
      }
      return () => {};
    },
  };
  await withFakeAgy({ FAKE_COLDSTART_MODE: 'clean' }, async () => {
    const res = await coldstartTickets(tickets, { test: 'npm test' }, { pools });
    assert.equal(res.length, 2);
    assert.equal(res[0].id, 'T1');
    assert.equal(res[0].error, undefined);
    assert.equal(res[1].id, 'T2');
    assert.ok(res[1].error.includes('pool capacity exhausted'), 'T2 must capture quota admission error');
  });
});

test('parallaxEdges: fails closed with error when reader or judge verdict fails', async () => {
  const plan = {
    repo: '/r',
    tickets: [
      { id: 'T1', title: 'T1', body: 'body 1', scope: ['src/a'], edges: [{ to: 'T2' }] },
      { id: 'T2', title: 'T2', body: 'body 2', scope: ['src/b'], edges: [] },
    ],
  };
  await withFakeAgy({ FAKE_AGY_MODE: 'fail' }, async () => {
    const results = await parallaxEdges(plan);
    assert.equal(results.length, 1);
    assert.ok(results[0].error, 'must report error when reader/judge fails');
  });
});

test('COLDSTART_SCHEMA, PARALLAX_READER_SCHEMA, PARALLAX_JUDGE_SCHEMA, PREMORTEM_SCHEMA enforce required fields', () => {
  assert.deepEqual(COLDSTART_SCHEMA.required, ['gaps']);
  assert.deepEqual(PARALLAX_READER_SCHEMA.required, ['contract']);
  assert.deepEqual(PARALLAX_JUDGE_SCHEMA.required, ['divergent', 'divergences']);
  assert.deepEqual(PREMORTEM_SCHEMA.required, ['causes']);
});

test('applyModelRouterTiers: ignores router tier assignments that have zero candidates for ticket pool_hint', async () => {
  const { applyModelRouterTiers } = await import('../lib/plan.mjs');
  const fakeAdlc = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'agb-plan-router-'));
  const prevAllow = process.env.AGB_ALLOW_CUSTOM_ADLC_CLI;
  const prevBin = process.env.AGB_ADLC_BIN;
  process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = '1';
  process.env.AGB_ADLC_BIN = fakeAdlc;
  try {
    const ticketsPath = join(tmp, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }, { id: 'T2' }] }));
    const plan = {
      tickets: [
        { id: 'T1', tier: 'mid', pool_hint: 'auto' },
        { id: 'T2', tier: 'mid', pool_hint: 'gpt-oss' }, // 'frontier' has 0 gpt-oss candidates
      ],
    };
    const res = await applyModelRouterTiers(plan, ticketsPath);
    assert.equal(res.ok, true);
    assert.equal(plan.tickets[0].tier, 'frontier', 'valid frontier tier applied when pool_hint has candidates');
    assert.equal(plan.tickets[1].tier, 'mid', 'tier with 0 candidates for pool_hint must not overwrite valid tier');
  } finally {
    if (prevAllow === undefined) delete process.env.AGB_ALLOW_CUSTOM_ADLC_CLI;
    else process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = prevAllow;
    if (prevBin === undefined) delete process.env.AGB_ADLC_BIN;
    else process.env.AGB_ADLC_BIN = prevBin;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('validatePlan accepts valid gate.autofix and ticket.effort, rejects invalid values, and compilePlan({ estimateOnly: true }) performs zero disk writes', async () => {
  const { validatePlan, compilePlan } = await import('../lib/plan.mjs');
  const { STREAM_EVENT_SCHEMA, BRAIN_PLAN_SCHEMA, validateJsonSchema } = await import('../lib/schemas.mjs');
  const { existsSync, readdirSync } = await import('node:fs');

  // STREAM_EVENT_SCHEMA accepts cached_tokens
  assert.equal(
    validateJsonSchema(
      { type: 'result', status: 'SUCCESS', exit_code: 0, telemetry: { input_tokens: 100, cached_tokens: 80, output_tokens: 20 } },
      STREAM_EVENT_SCHEMA
    ).valid,
    true
  );

  const validPlan = {
    repo: '/tmp/repo',
    gate: { autofix: 'npm run lint:fix', test: 'npm test' },
    tickets: [
      { id: 'T1', title: 'One', body: 'Do work', scope: ['lib/a.mjs'], edges: [], tier: 'mid', effort: 'high' },
    ],
  };
  assert.deepEqual(validatePlan(validPlan), []);
  assert.equal(validateJsonSchema(validPlan, BRAIN_PLAN_SCHEMA).valid, true);

  assert.ok(
    validatePlan({
      repo: '/tmp/repo',
      gate: { autofix: 'npm run lint:fix' },
      tickets: [{ id: 'T1', title: 'One', body: 'Do work', scope: ['lib/a.mjs'], edges: [] }],
    }).some((e) => e.includes('at least one of build/test'))
  );
  assert.ok(
    validatePlan({
      repo: '/tmp/repo',
      gate: { autofix: 'rm -rf /', test: 'npm test' },
      tickets: [{ id: 'T1', title: 'One', body: 'Do work', scope: ['lib/a.mjs'], edges: [] }],
    }).some((e) => e.includes('plan.gate.autofix'))
  );
  assert.ok(
    validatePlan({
      repo: '/tmp/repo',
      gate: { test: 'npm test' },
      tickets: [{ id: 'T1', title: 'One', body: 'Do work', scope: ['lib/a.mjs'], edges: [], effort: 'turbo' }],
    }).some((e) => e.includes("unknown effort 'turbo'"))
  );

  // Zero-write estimateOnly check
  const tmpRepo = mkdtempSync(join(tmpdir(), 'agb-est-zero-'));
  try {
    mkdirSync(join(tmpRepo, 'lib'), { recursive: true });
    writeFileSync(join(tmpRepo, 'lib', 'a.mjs'), 'export const a = 1;\n');
    const specFile = join(tmpRepo, 'spec.md');
    writeFileSync(
      specFile,
      [
        '# Est Spec',
        '**Gate:** `{"autofix": "npm run lint:fix", "test": "npm test"}`',
        '### Ticket 1: `T-EST-1` — Alpha',
        '- **Scope**: `lib/a.mjs`',
        '- **Effort**: `medium`',
        '- **Acceptance Criteria**:',
        '  - Works. Verify: `npm test`',
      ].join('\n')
    );

    const est = await compilePlan(specFile, { repo: tmpRepo, estimateOnly: true });
    assert.equal(est.ok, true);
    assert.equal(est.quotaEstimate.ok, true);
    assert.equal(est.quotaEstimate.waves.length, 1);
    assert.equal(existsSync(join(tmpRepo, '.booster')), false, 'estimateOnly must not create .booster/');
    assert.equal(existsSync(join(tmpRepo, '.adlc')), false, 'estimateOnly must not create .adlc/');
    assert.equal(existsSync(join(tmpRepo, '.gitignore')), false, 'estimateOnly must not create .gitignore');
    assert.deepEqual(readdirSync(tmpRepo).sort(), ['lib', 'spec.md']);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// --- T-TE-5b: provenance-cached coldstart hashes & DecisionEngine screening ---

test('hashTicketColdstart: deterministic SHA-256 hex digest sensitive to id, title, body, scope, rails, and gate', () => {
  const baseTicket = {
    id: 'T1',
    title: 'Build widget',
    body: 'Implement lib/widget.mjs',
    scope: ['lib/widget.mjs'],
    rails: ['lib/lock.mjs'],
  };
  const gate = { test: 'npm test' };

  const h1 = hashTicketColdstart(baseTicket, gate);
  const h2 = hashTicketColdstart({ ...baseTicket }, { test: 'npm test' });
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2, 'identical inputs must produce identical hashes');

  assert.notEqual(hashTicketColdstart({ ...baseTicket, id: 'T2' }, gate), h1);
  assert.notEqual(hashTicketColdstart({ ...baseTicket, title: 'Other' }, gate), h1);
  assert.notEqual(hashTicketColdstart({ ...baseTicket, body: 'Changed body' }, gate), h1);
  assert.notEqual(hashTicketColdstart({ ...baseTicket, scope: ['lib/other.mjs'] }, gate), h1);
  assert.notEqual(hashTicketColdstart({ ...baseTicket, rails: ['lib/gates.mjs'] }, gate), h1);
  assert.notEqual(hashTicketColdstart(baseTicket, { build: 'npm run build', test: 'npm test' }), h1);
  assert.notEqual(hashTicketColdstart(baseTicket, null), h1);

  // Missing optional fields normalize to defaults
  assert.equal(
    hashTicketColdstart({ id: 'T1', title: 'X', body: 'Y' }, undefined),
    hashTicketColdstart({ id: 'T1', title: 'X', body: 'Y', scope: [], rails: [] }, null)
  );
});

test('compilePlan stamps gateProvenance.coldstartHashes; preflight skips cached tickets, re-probes changed tickets, and honors forceColdstart', async () => {
  const brainDir = makeBrainDir();
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-coldcache-'));
  try {
    let compiledPlan;
    await withFakeAgy({ FAKE_BRAIN_MODE: 'edges' }, async () => {
      const r = await compilePlan('aaaa', { repo: '/r', brainDir, premortem: false, parallax: false });
      assert.equal(r.ok, true);
      compiledPlan = r.plan;
      assert.ok(compiledPlan.gateProvenance?.coldstartHashes, 'compilePlan must stamp gateProvenance.coldstartHashes');
      assert.equal(
        compiledPlan.gateProvenance.coldstartHashes.T1,
        hashTicketColdstart(compiledPlan.tickets[0], compiledPlan.gate)
      );
      assert.equal(
        compiledPlan.gateProvenance.coldstartHashes.T2,
        hashTicketColdstart(compiledPlan.tickets[1], compiledPlan.gate)
      );
      assert.deepEqual(validatePlan(compiledPlan), []);

      // compilePlan with coldstart: false must NOT stamp coldstartHashes
      const noCold = await compilePlan('aaaa', {
        repo: '/r', brainDir, premortem: false, parallax: false, coldstart: false,
      });
      assert.equal(noCold.ok, true);
      assert.equal(noCold.plan.gateProvenance, undefined);
    });

    const envLog = join(stateDir, 'agy-env-seen');
    const countAgyCalls = () => (existsSync(envLog) ? readFileSync(envLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);

    // 1. Immediate preflight(compiledPlan): 0 LLM calls, pools.refreshQuota not called
    let refreshCalled = false;
    const guardPools = {
      quota: null,
      circuitBreakerTripped: false,
      refreshQuota: async () => {
        refreshCalled = true;
        throw new Error('refreshQuota should not be called when all tickets are cached');
      },
      acquire: async () => {
        throw new Error('acquire should not be called when all tickets are cached');
      },
    };
    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const pf = await preflight(compiledPlan, { pools: guardPools });
      assert.equal(pf.ok, true);
      assert.deepEqual(pf.cachedColdstartIds, ['T1', 'T2']);
      assert.deepEqual(pf.gaps, []);
      assert.equal(refreshCalled, false);
      assert.equal(countAgyCalls(), 0, 'preflight must make 0 duplicate coldstart LLM calls');
    });

    // 2. Mutating T1.body re-probes ONLY T1 (T2 stays cached)
    const bodyChanged = structuredClone(compiledPlan);
    bodyChanged.tickets[0].body = 'updated step 1 specification';
    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const before = countAgyCalls();
      const pf = await preflight(bodyChanged);
      assert.equal(pf.ok, true);
      assert.deepEqual(pf.cachedColdstartIds, ['T2']);
      assert.equal(countAgyCalls() - before, 1, 'only changed ticket T1 should be re-probed');
    });

    // 3. Mutating T2.scope re-probes ONLY T2 (T1 stays cached)
    const scopeChanged = structuredClone(compiledPlan);
    scopeChanged.tickets[1].scope = ['src/widget3/**'];
    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const before = countAgyCalls();
      const pf = await preflight(scopeChanged);
      assert.equal(pf.ok, true);
      assert.deepEqual(pf.cachedColdstartIds, ['T1']);
      assert.equal(countAgyCalls() - before, 1, 'only changed ticket T2 should be re-probed');
    });

    // 4. Mutating plan.gate invalidates all ticket hashes
    const gateChanged = structuredClone(compiledPlan);
    gateChanged.gate = { build: 'npm run build', test: 'npm test' };
    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const before = countAgyCalls();
      const pf = await preflight(gateChanged);
      assert.equal(pf.ok, true);
      assert.deepEqual(pf.cachedColdstartIds, []);
      assert.equal(countAgyCalls() - before, 2, 'changing plan.gate must re-probe all tickets');
    });

    // 5. forceColdstart: true re-probes all tickets even with matching hashes
    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const before = countAgyCalls();
      const pf = await preflight(compiledPlan, { forceColdstart: true });
      assert.equal(pf.ok, true);
      assert.deepEqual(pf.cachedColdstartIds, []);
      assert.equal(countAgyCalls() - before, 2, 'forceColdstart must re-probe all tickets');
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('compilePlan: opt-in DecisionEngine screens clearly executable tickets and escalates uncertain ones to System-2 coldstart', async () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'agb-s1-cold-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-s1-state-'));
  try {
    mkdirSync(join(tmpRepo, 'lib'), { recursive: true });
    writeFileSync(join(tmpRepo, 'lib', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(tmpRepo, 'lib', 'b.mjs'), 'export const b = 2;\n');
    const specFile = join(tmpRepo, 'spec.md');
    writeFileSync(
      specFile,
      [
        '# S1 Coldstart Spec',
        '**Gate:** `{"test": "npm test"}`',
        '### Ticket 1: `T-S1-1` — Clear ticket',
        '- **Scope**: `lib/a.mjs`',
        '- **Acceptance Criteria**:',
        '  - Export a from lib/a.mjs. Verify: `npm test`',
        '### Ticket 2: `T-S1-2` — Uncertain ticket',
        '- **Scope**: `lib/b.mjs`',
        '- **Acceptance Criteria**:',
        '  - Export b from lib/b.mjs. Verify: `npm test`',
      ].join('\n')
    );

    // T-S1-1: high confidence, low gapRisk -> screened by System-1
    // T-S1-2: low confidence -> escalated to System-2 coldstartTickets
    const screeningEngine = new DecisionEngine({
      provider: 'kev',
      baseUrl: 'http://127.0.0.1:18080/decide',
      transport: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.primitive === 'score') {
          return {
            ok: true,
            json: async () => ({
              answers: [
                { score: 0.96, confidence: 0.95 },
                { score: 0.65, confidence: 0.70 },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            answers: [
              { probability: 0.05, confidence: 0.95 },
              { probability: 0.40, confidence: 0.70 },
            ],
          }),
        };
      },
    });

    const envLog = join(stateDir, 'agy-env-seen');
    const countAgyCalls = () => (existsSync(envLog) ? readFileSync(envLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);

    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const r = await compilePlan(specFile, {
        repo: tmpRepo,
        premortem: false,
        parallax: false,
        decisionEngine: screeningEngine,
      });
      assert.equal(r.ok, true);
      assert.equal(countAgyCalls(), 1, 'only the escalated ticket T-S1-2 should invoke System-2 coldstart');
      assert.ok(r.plan.gateProvenance?.coldstartHashes?.['T-S1-1']);
      assert.ok(r.plan.gateProvenance?.coldstartHashes?.['T-S1-2']);
    });

    // Fail-closed: if DecisionEngine transport errors, all tickets must be sent to System-2
    const failingEngine = new DecisionEngine({
      provider: 'kev',
      baseUrl: 'http://127.0.0.1:18080/decide',
      transport: async () => {
        throw new Error('connection refused');
      },
    });
    await withFakeAgy({ FAKE_STATE_DIR: stateDir }, async () => {
      const before = countAgyCalls();
      const r = await compilePlan(specFile, {
        repo: tmpRepo,
        premortem: false,
        parallax: false,
        decisionEngine: failingEngine,
      });
      assert.equal(r.ok, true);
      assert.equal(countAgyCalls() - before, 2, 'DecisionEngine failure must fail closed and probe all tickets');
    });
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('F-009: compilePlan stamps coldstartHashes ONLY for probed/screened tickets with zero gaps/errors', async () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'agb-f009-cold-'));
  try {
    mkdirSync(join(tmpRepo, 'lib'), { recursive: true });
    writeFileSync(join(tmpRepo, 'lib', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(tmpRepo, 'lib', 'b.mjs'), 'export const b = 2;\n');
    writeFileSync(join(tmpRepo, 'lib', 'c.mjs'), 'export const c = 3;\n');
    const specFile = join(tmpRepo, 'spec.md');
    writeFileSync(
      specFile,
      [
        '# F-009 Coldstart Provenance Spec',
        '**Gate:** `{"test": "npm test"}`',
        '### Ticket 1: `T-F9-1` — Screened by System-1',
        '- **Scope**: `lib/a.mjs`',
        '- **Acceptance Criteria**:',
        '  - Export a from lib/a.mjs. Verify: `npm test`',
        '### Ticket 2: `T-F9-2` — Probed by System-2',
        '- **Scope**: `lib/b.mjs`',
        '- **Acceptance Criteria**:',
        '  - Export b from lib/b.mjs. Verify: `npm test`',
        '### Ticket 3: `T-F9-3` — Unprobed ticket',
        '- **Scope**: `lib/c.mjs`',
        '- **Acceptance Criteria**:',
        '  - Export c from lib/c.mjs. Verify: `npm test`',
      ].join('\n')
    );

    // T-F9-1 passes System-1 screening; T-F9-2 and T-F9-3 escalate to System-2.
    const screeningEngine = new DecisionEngine({
      provider: 'kev',
      baseUrl: 'http://127.0.0.1:18080/decide',
      transport: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.primitive === 'score') {
          return {
            ok: true,
            json: async () => ({
              answers: [
                { score: 0.96, confidence: 0.95 },
                { score: 0.60, confidence: 0.70 },
                { score: 0.60, confidence: 0.70 },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            answers: [
              { probability: 0.05, confidence: 0.95 },
              { probability: 0.45, confidence: 0.70 },
              { probability: 0.45, confidence: 0.70 },
            ],
          }),
        };
      },
    });

    // Subtest A: coldstartFn probes only T-F9-2 (omitting T-F9-3) -> T-F9-1 & T-F9-2 stamped, T-F9-3 NOT stamped
    const partialRes = await compilePlan(specFile, {
      repo: tmpRepo,
      premortem: false,
      parallax: false,
      decisionEngine: screeningEngine,
      coldstartFn: async () => [{ id: 'T-F9-2', gaps: [] }],
    });
    assert.equal(partialRes.ok, true);
    assert.ok(partialRes.plan.gateProvenance?.coldstartHashes?.['T-F9-1'], 'System-1 screened ticket must be stamped');
    assert.ok(partialRes.plan.gateProvenance?.coldstartHashes?.['T-F9-2'], 'cleanly probed ticket must be stamped');
    assert.equal(
      partialRes.plan.gateProvenance?.coldstartHashes?.['T-F9-3'],
      undefined,
      'unprobed ticket must NOT be stamped in coldstartHashes'
    );

    // Subtest B: tickets with coldstart gaps or errors must NEVER be stamped
    const gapRes = await compilePlan(specFile, {
      repo: tmpRepo,
      premortem: false,
      parallax: false,
      maxAttempts: 0,
      coldstartFn: async () => [
        { id: 'T-F9-1', gaps: [] },
        { id: 'T-F9-2', gaps: ['missing acceptance criterion'] },
        { id: 'T-F9-3', error: 'coldstart timeout', gaps: [] },
      ],
    });
    assert.equal(gapRes.ok, false);
    assert.equal(gapRes.plan.gateProvenance, undefined, 'failed coldstart must not stamp gateProvenance');
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});


