import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlan, planEdges, compilePlan, premortemPlan, parallaxEdges, PARALLAX_READER_SCHEMA, PARALLAX_JUDGE_SCHEMA, PREMORTEM_SCHEMA } from '../lib/plan.mjs';
import { coldstartTickets, COLDSTART_SCHEMA } from '../lib/preflight.mjs';
import { readBrain } from '../lib/brain.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_plan_test.json');

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
