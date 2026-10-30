import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  mean,
  sd,
  median,
  p90,
  p95,
  iqr,
  bootstrapCI,
  pairedRatioSummary,
  cohensD,
  mannWhitneyU,
  wilsonScoreInterval,
  twoProportionZTest,
} from '../evals/stats.mjs';
import {
  runPerf8TicketDagScenario,
  runPerf16TicketScaleScenario,
  runAccCrossModelProsecutionScenario,
  runAccMechanicalSafetyGatesScenario,
} from '../evals/scenarios.mjs';
import { runAllEvals, renderMarkdownReport } from '../evals/runner.mjs';

test('stats: mulberry32 PRNG is deterministic across identical seeds', () => {
  const r1 = mulberry32(20261030);
  const r2 = mulberry32(20261030);
  for (let i = 0; i < 20; i++) {
    assert.equal(r1(), r2());
  }
});

test('stats: descriptive and inferential primitives compute expected values', () => {
  const xs = [10, 20, 30, 40, 50];
  const ys = [2, 4, 6, 8, 10];
  assert.equal(mean(xs), 30);
  assert.equal(median(xs), 30);
  assert.ok(sd(xs) > 15.8 && sd(xs) < 15.9);
  assert.ok(p90(xs) >= 40);
  assert.ok(p95(xs) >= 45);
  assert.equal(iqr(xs), 20);

  const ci = bootstrapCI(xs, { resamples: 500, seed: 42 });
  assert.equal(ci.point, 30);
  assert.ok(ci.low >= 10 && ci.low <= 30);
  assert.ok(ci.high >= 30 && ci.high <= 50);

  const ratio = pairedRatioSummary(xs, ys, { resamples: 500, seed: 42 });
  assert.equal(ratio.ratioOfMeans, 5);
  assert.equal(ratio.medianPairwiseRatio, 5);

  const d = cohensD(xs, ys);
  assert.ok(d > 2.0);

  const mwu = mannWhitneyU([100, 110, 120, 130, 140], [10, 20, 30, 40, 50]);
  assert.equal(mwu.u, 0);
  assert.ok(mwu.pValue < 0.02);

  const wilson = wilsonScoreInterval(90, 100);
  assert.equal(wilson.p, 0.9);
  assert.ok(wilson.low > 0.82 && wilson.high < 0.95);

  const zTest = twoProportionZTest(95, 100, 40, 100);
  assert.ok(zTest.z > 8.0);
  assert.ok(zTest.pValue < 0.0001);
});

test('scenarios: all 4 statistical scenarios are deterministic and satisfy significance & effect-size bounds', () => {
  const s1a = runPerf8TicketDagScenario({ trials: 100, seed: 20261030 });
  const s1b = runPerf8TicketDagScenario({ trials: 100, seed: 20261030 });
  assert.deepEqual(s1a, s1b, 'Perf-1 scenario must be 100% deterministic for fixed seed');
  assert.ok(s1a.comparisons.agbVsSerial.speedup.ratioOfMeans >= 2.5, 'Perf-1 speedup vs serial >= 2.5x');
  assert.ok(s1a.comparisons.agbVsSinglePool.speedup.ratioOfMeans >= 1.25, 'Perf-1 speedup vs single-pool >= 1.25x');
  assert.ok(s1a.comparisons.agbVsSerial.mannWhitney.pValue < 0.0001);

  const s2 = runPerf16TicketScaleScenario({ trials: 100, seed: 20261031 });
  assert.ok(s2.comparisons.speedup.ratioOfMeans >= 2.0, 'Perf-2 speedup >= 2.0x');
  assert.ok(s2.comparisons.p95ReductionPct >= 45, 'Perf-2 P95 tail latency reduction >= 45%');
  assert.ok(s2.comparisons.timeoutProportionTest.pValue < 0.0001);

  const s3 = runAccCrossModelProsecutionScenario({ trials: 100, seed: 20261101 });
  assert.ok(s3.arms.agbCrossModelProsecutorFleet.recall.p >= 0.88, 'Acc-1 recall >= 88%');
  assert.ok(s3.comparisons.escapeRateAgbVsSameModel.relativeReduction >= 0.75, 'Acc-1 escape reduction >= 75%');
  assert.ok(s3.comparisons.recallAgbVsSameModel.pValue < 0.0001);

  const s4 = runAccMechanicalSafetyGatesScenario({ trials: 100, seed: 20261102 });
  assert.equal(s4.hazards.frozenRailMutation.agbRate.p, 1.0, 'PreToolUse + rails-guard blocks 100% of rail mutations');
  assert.equal(s4.hazards.outOfScopeDrift.agbRate.p, 1.0, 'Worktree scope gate blocks 100% of scope violations');
  assert.ok(s4.overall.escapeReductionTest.pValue < 0.0001);
});

test('runner: runAllEvals verifies all invariants, runs live mechanical probes, and renders markdown report', () => {
  const results = runAllEvals({ trials: 100, seed: 20261030 });
  assert.equal(results.ok, true, JSON.stringify(results.invariants));
  assert.equal(results.liveProbes.ok, true, JSON.stringify(results.liveProbes));
  const md = renderMarkdownReport(results);
  assert.match(md, /## Executive Summary: Headline Statistical Gains/);
  assert.match(md, /xychart-beta/);
  assert.match(md, /Live Mechanical Runtime Probes/);
});
