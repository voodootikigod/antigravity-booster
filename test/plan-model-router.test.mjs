import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compilePlan, applyModelRouterTiers } from '../lib/plan.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

const FAKE_ENV_KEYS = ['AGB_AGY_BIN', 'AGB_ADLC_BIN', 'FAKE_STATE_DIR', 'FAKE_MODEL_ROUTER_MODE'];

function withFakes(env, fn) {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.AGB_ADLC_BIN = FAKE_ADLC;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of FAKE_ENV_KEYS) delete process.env[k]; });
}

function makeBrainDir() {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-mr-brain-'));
  const conv = join(brainDir, 'aaaa-bbbb');
  mkdirSync(conv, { recursive: true });
  writeFileSync(join(conv, 'implementation_plan.md'), '# Build the widget\n\n- step 1\n');
  return brainDir;
}

// --- applyModelRouterTiers: direct unit tests ---

test('applyModelRouterTiers: sets each ticket\'s tier from the router\'s assignment', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-mr-repo-'));
  try {
    const ticketsPath = join(repo, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }, { id: 'T2' }] }));
    const plan = { tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a'], tier: 'cheap' }, { id: 'T2', title: 'b', body: 'y', scope: ['b'] }] };
    await withFakes({}, async () => {
      const routed = await applyModelRouterTiers(plan, ticketsPath);
      assert.equal(routed.ok, true);
      // The fake always assigns 'frontier' — a value that could not be T1's
      // pre-existing 'cheap' tier, so this proves the assignment was actually
      // applied, not left as whatever the brain/plan already declared.
      assert.equal(plan.tickets[0].tier, 'frontier');
      assert.equal(plan.tickets[1].tier, 'frontier');
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('applyModelRouterTiers: an operational failure leaves every ticket\'s existing tier untouched', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-mr-repo-'));
  try {
    const ticketsPath = join(repo, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }] }));
    const plan = { tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a'], tier: 'cheap' }] };
    await withFakes({ FAKE_MODEL_ROUTER_MODE: 'fail' }, async () => {
      const routed = await applyModelRouterTiers(plan, ticketsPath);
      assert.equal(routed.ok, false);
      assert.equal(plan.tickets[0].tier, 'cheap', 'tier is unchanged on failure — never silently cleared');
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('applyModelRouterTiers: surfaces p3Findings for the caller to log (advisory, not a block)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-mr-repo-'));
  try {
    const ticketsPath = join(repo, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }] }));
    const plan = { tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a'] }] };
    await withFakes({ FAKE_MODEL_ROUTER_MODE: 'p3' }, async () => {
      const routed = await applyModelRouterTiers(plan, ticketsPath);
      assert.equal(routed.ok, true);
      assert.equal(routed.p3Findings.length, 1);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- AC1: compilePlan's tier-assignment step calls adlc model-router ---

test('compilePlan: AC1 — a successful compile\'s tickets carry the model-router assignment, not the brain\'s own tier', async () => {
  const brainDir = makeBrainDir();
  const repo = mkdtempSync(join(tmpdir(), 'agb-mr-compile-'));
  const state = mkdtempSync(join(tmpdir(), 'agb-mr-state-'));
  try {
    await withFakes({ FAKE_STATE_DIR: state }, async () => {
      const r = await compilePlan('aaaa', { repo, brainDir, premortem: false });
      assert.equal(r.ok, true);
      // The default fake-agy brain conversion declares tier 'mid' for T1
      // (see fixtures/fake-agy). The fake model-router always assigns
      // 'frontier' — proving compilePlan applied the router's output.
      assert.equal(r.plan.tickets[0].tier, 'frontier');
    });
    const invocations = readFileSync(join(state, 'model-router-invocations'), 'utf8');
    assert.match(invocations, /tickets=.*\.adlc[/\\]tickets\.json/, 'model-router was invoked against the projected .adlc/tickets.json');
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('compilePlan: model-router being unavailable does not fail an otherwise-successful compile', async () => {
  const brainDir = makeBrainDir();
  const repo = mkdtempSync(join(tmpdir(), 'agb-mr-compile-fail-'));
  try {
    await withFakes({ FAKE_MODEL_ROUTER_MODE: 'fail' }, async () => {
      const r = await compilePlan('aaaa', { repo, brainDir, premortem: false });
      assert.equal(r.ok, true, 'the compile itself still succeeds — model-router is additive evidence, not a gate');
      assert.equal(r.plan.tickets[0].tier, 'mid', 'keeps the brain-assigned tier when the router is unavailable');
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
