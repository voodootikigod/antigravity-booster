import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compilePlan } from '../lib/plan.mjs';
import { applyMergeForecast } from '../lib/preflight.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

const FAKE_ENV_KEYS = ['AGB_AGY_BIN', 'AGB_ADLC_BIN', 'FAKE_STATE_DIR', 'FAKE_MERGE_FORECAST_MODE'];

function withFakes(env, fn) {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.AGB_ADLC_BIN = FAKE_ADLC;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of FAKE_ENV_KEYS) delete process.env[k]; });
}

function makeBrainDir() {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-mf-brain-'));
  const conv = join(brainDir, 'aaaa-bbbb');
  mkdirSync(conv, { recursive: true });
  writeFileSync(join(conv, 'implementation_plan.md'), '# Build the widget\n\n- step 1\n');
  return brainDir;
}

// --- applyMergeForecast: direct unit tests ---

test('applyMergeForecast: annotates plan.concurrencyCap with the recommended width', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-mf-repo-'));
  try {
    const ticketsPath = join(repo, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }] }));
    const plan = { tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a'] }] };
    await withFakes({}, async () => {
      const forecast = await applyMergeForecast(plan, ticketsPath, { repo });
      assert.equal(forecast.ok, true);
      assert.equal(forecast.recommendedWidth, 3);
      assert.equal(plan.concurrencyCap, 3);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('applyMergeForecast: a scheduling-risk gate failure is surfaced, not swallowed, and still annotates the cap', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-mf-repo-'));
  try {
    const ticketsPath = join(repo, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }, { id: 'T2' }] }));
    const plan = { tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a'] }, { id: 'T2', title: 'b', body: 'y', scope: ['b'] }] };
    await withFakes({ FAKE_MERGE_FORECAST_MODE: 'veto' }, async () => {
      const forecast = await applyMergeForecast(plan, ticketsPath, { repo });
      assert.equal(forecast.ok, true, 'a gate-fail exit code from the tool is not itself an operational error — the forecast JSON is still valid');
      assert.equal(forecast.gateFailures.length, 1);
      assert.equal(plan.concurrencyCap, 3);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('applyMergeForecast: an operational failure leaves plan.concurrencyCap unset', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-mf-repo-'));
  try {
    const ticketsPath = join(repo, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1' }] }));
    const plan = { tickets: [{ id: 'T1', title: 'a', body: 'x', scope: ['a'] }] };
    await withFakes({ FAKE_MERGE_FORECAST_MODE: 'fail' }, async () => {
      const forecast = await applyMergeForecast(plan, ticketsPath, { repo });
      assert.equal(forecast.ok, false);
      assert.equal(plan.concurrencyCap, undefined);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- AC1: agb plan's gate pipeline runs adlc merge-forecast and annotates plan.concurrencyCap ---

test('compilePlan: AC1 — a successful compile\'s plan carries a concurrencyCap from adlc merge-forecast', async () => {
  const brainDir = makeBrainDir();
  const repo = mkdtempSync(join(tmpdir(), 'agb-mf-compile-'));
  const state = mkdtempSync(join(tmpdir(), 'agb-mf-state-'));
  try {
    await withFakes({ FAKE_STATE_DIR: state }, async () => {
      const r = await compilePlan('aaaa', { repo, brainDir, premortem: false });
      assert.equal(r.ok, true);
      assert.equal(r.plan.concurrencyCap, 3);
    });
    const invocations = readFileSync(join(state, 'merge-forecast-invocations'), 'utf8');
    assert.match(invocations, /tickets=.*\.adlc[/\\]tickets\b/, 'merge-forecast was invoked against the projected ticket store');
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('compilePlan: merge-forecast being unavailable does not fail an otherwise-successful compile', async () => {
  const brainDir = makeBrainDir();
  const repo = mkdtempSync(join(tmpdir(), 'agb-mf-compile-fail-'));
  try {
    await withFakes({ FAKE_MERGE_FORECAST_MODE: 'fail' }, async () => {
      const r = await compilePlan('aaaa', { repo, brainDir, premortem: false });
      assert.equal(r.ok, true, 'the compile itself still succeeds — merge-forecast is additive evidence, not a gate');
      assert.equal(r.plan.concurrencyCap, undefined);
    });
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
