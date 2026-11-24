import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePlanQuotaRunway } from '../lib/pools.mjs';

test('estimatePlanQuotaRunway computes topological wave burn with priors, empirical overrides, and exhaustion warnings', () => {
  const plan = {
    tickets: [
      { id: 'T1', tier: 'mid', pool_hint: 'gemini', edges: [{ to: 'T3' }] },
      { id: 'T2', tier: 'mid', pool_hint: 'claude-gpt', edges: [{ to: 'T3' }] },
      { id: 'T3', tier: 'frontier', pool_hint: 'claude-gpt', edges: [] },
    ],
  };

  // 1. Offline / null quota mode: computes waves cleanly without exhaustion warning
  const offline = estimatePlanQuotaRunway(plan, { quota: null, records: [] });
  assert.equal(offline.ok, true);
  assert.equal(offline.waves.length, 2);
  assert.deepEqual(offline.waves[0].tickets, ['T1', 'T2']);
  assert.deepEqual(offline.waves[1].tickets, ['T3']);
  assert.equal(offline.willExhaust, false);
  assert.equal(offline.remaining.gemini, null);

  // 2. Tight Claude/GPT 5h window: flags Wave 2 exhaustion on claude_gpt
  const tightQuota = {
    gemini: { fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90 },
    claude_gpt: { fiveHourRemainingPercent: 8, weeklyRemainingPercent: 50 },
  };
  const warn = estimatePlanQuotaRunway(plan, { quota: tightQuota, records: [] });
  assert.equal(warn.willExhaust, true);
  assert.equal(warn.bottleneckPool, 'claude_gpt');
  assert.equal(warn.exhaustingWave, 2);
  assert.match(warn.recommendation, /Wave 2 is projected to exceed claude_gpt/);

  // 3. Empirical override (>= 3 matching (tier, pool) records)
  const empiricalRecords = [
    { model: 'claude-sonnet-5-5-high', pool: 'claude_gpt', tier: 'frontier', quotaDeltaPct: 2.0 },
    { model: 'claude-sonnet-5-5-high', pool: 'claude_gpt', tier: 'frontier', quotaDeltaPct: 2.0 },
    { model: 'claude-opus-5-5-high', pool: 'claude_gpt', tier: 'frontier', quotaDeltaPct: 2.0 },
  ];
  const emp = estimatePlanQuotaRunway(plan, { quota: tightQuota, records: empiricalRecords });
  assert.ok(emp.totals.claude_gpt < warn.totals.claude_gpt, 'empirical 2.0% frontier burn replaces 7.5% prior');
});
