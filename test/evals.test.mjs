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
  formatPValue,
} from '../evals/stats.mjs';
import {
  CALIBRATION_ANCHORS,
  runPerf8TicketDagScenario,
  runPerf16TicketScaleScenario,
  runAccCrossModelProsecutionScenario,
  runAccMechanicalSafetyGatesScenario,
} from '../evals/scenarios.mjs';
import {
  runLivePolicyCorpusBenchmark,
  runLiveHookLatencyBenchmark,
  runLiveOrchestratorOverheadBenchmark,
} from '../evals/live-bench.mjs';
import {
  runLivePlanCompilerBenchmark,
  runLiveProsecutorAndReviewBenchmark,
  runLiveSchedulerDagBenchmark,
  runLivePolicyFuzzerBenchmark,
} from '../evals/subsystem-bench.mjs';
import {
  runAllEvals,
  renderMarkdownReport,
  loadBaseline,
  compareAgainstBaseline,
} from '../evals/runner.mjs';

test('stats: mulberry32 PRNG is deterministic across identical seeds and default seed', () => {
  const rDefault = mulberry32();
  const r1 = mulberry32(20261030);
  const r2 = mulberry32(20261030);
  const firstVal = rDefault();
  assert.equal(firstVal, 0.8795690659899265);
  assert.equal(r1(), firstVal);
  assert.equal(r2(), firstVal);
  assert.equal(mulberry32(1)(), 0.6270739405881613);
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
  assert.equal(formatPValue(0.00001), '< 0.0001');
  assert.equal(formatPValue(0.0006), '= 0.0006');
});

test('scenarios: all 4 statistical scenarios are deterministic and satisfy significance & effect-size bounds', () => {
  assert.equal(CALIBRATION_ANCHORS.probeDatePrimary, '2026-06-11');
  assert.equal(CALIBRATION_ANCHORS.probeDateSecondary, '2026-07-14');
  assert.equal(CALIBRATION_ANCHORS.poolCaps['gemini-flash'], 8);
  assert.equal(CALIBRATION_ANCHORS.poolCaps['gemini-pro'], 4);
  assert.equal(CALIBRATION_ANCHORS.poolCaps.claude, 4);
  assert.equal(CALIBRATION_ANCHORS.poolCaps['gpt-oss'], 2);

  const s1a = runPerf8TicketDagScenario({ trials: 100, seed: 20261030 });
  const s1b = runPerf8TicketDagScenario({ trials: 100, seed: 20261030 });
  assert.deepEqual(s1a, s1b, 'Perf-1 scenario must be 100% deterministic for fixed seed');
  assert.ok(s1a.comparisons.agbVsSerial.speedup.ratioOfMeans >= 2.5, 'Perf-1 speedup vs serial >= 2.5x');
  assert.ok(s1a.comparisons.agbVsSinglePool.speedup.ratioOfMeans >= 1.25, 'Perf-1 speedup vs single-pool >= 1.25x');
  assert.ok(s1a.comparisons.agbVsBestPractices.speedup.ratioOfMeans >= 1.2, 'Perf-1 speedup vs best-practices >= 1.2x');
  assert.ok(s1a.comparisons.agbVsSerial.mannWhitney.pValue < 0.0001);
  assert.ok(s1a.comparisons.agbVsBestPractices.mannWhitney.pValue < 0.0001);

  const s2 = runPerf16TicketScaleScenario({ trials: 100, seed: 20261031 });
  assert.ok(s2.comparisons.speedup.ratioOfMeans >= 2.0, 'Perf-2 speedup >= 2.0x');
  assert.ok(s2.comparisons.speedupVsBestPractices.ratioOfMeans >= 1.3, 'Perf-2 speedup vs best-practices >= 1.3x');
  assert.ok(s2.comparisons.p95ReductionPct >= 45, 'Perf-2 P95 tail latency reduction >= 45%');
  assert.ok(s2.comparisons.timeoutProportionTest.pValue < 0.0001);
  assert.ok(s2.comparisons.timeoutProportionVsBestPracticesTest.pValue < 0.0001);

  const s3 = runAccCrossModelProsecutionScenario({ trials: 100, seed: 20261101 });
  assert.ok(s3.arms.agbCrossModelProsecutorFleet.recall.p >= 0.88, 'Acc-1 recall >= 88%');
  assert.ok(s3.arms.rawAgyBestPractices.recall.p > s3.arms.straightAgySameModelReview.recall.p);
  assert.ok(s3.comparisons.escapeRateAgbVsSameModel.relativeReduction >= 0.75, 'Acc-1 escape reduction >= 75%');
  assert.ok(s3.comparisons.escapeRateAgbVsBestPractices.relativeReduction >= 0.50, 'Acc-1 escape reduction vs best-practices >= 50%');
  assert.ok(s3.comparisons.recallAgbVsSameModel.pValue < 0.0001);
  assert.ok(s3.comparisons.recallAgbVsBestPractices.pValue < 0.0001);

  const s4 = runAccMechanicalSafetyGatesScenario({ trials: 100, seed: 20261102 });
  assert.equal(s4.hazards.frozenRailMutation.agbRate.p, 1.0, 'PreToolUse + rails-guard blocks 100% of rail mutations');
  assert.equal(s4.hazards.outOfScopeDrift.agbRate.p, 1.0, 'Worktree scope gate blocks 100% of scope violations');
  assert.ok(s4.overall.escapeReductionTest.pValue < 0.0001);
  assert.ok(s4.overall.escapeReductionVsBestPracticesTest.pValue < 0.0001);
});

test('live-bench: 40-vector policy corpus, hook latency breakdown, and orchestrator overhead satisfy all invariants', () => {
  const corpus = runLivePolicyCorpusBenchmark();
  assert.equal(corpus.ok, true, JSON.stringify(corpus));
  assert.equal(corpus.adversarialTotal, 20);
  assert.equal(corpus.adversarialBlocked, 20);
  assert.equal(corpus.adversarialRecall, 1.0);
  assert.equal(corpus.benignTotal, 20);
  assert.equal(corpus.benignPassed, 20);
  assert.equal(corpus.benignFalsePositiveRate, 0.0);

  const latency = runLiveHookLatencyBenchmark({ iterations: 3 });
  assert.equal(latency.ok, true, JSON.stringify(latency));
  assert.equal(latency.subprocessAllExitedZero, true);
  assert.ok(latency.tiers.inProcessEvaluatePayloadMs.p50 < 25);
  assert.ok(latency.tiers.hookRunnerEndToEndMs.p50 < 500);

  const orch = runLiveOrchestratorOverheadBenchmark({ cycles: 16 });
  assert.equal(orch.ok, true, JSON.stringify(orch));
  assert.ok(orch.totalOverheadMs < 500);
  assert.ok(orch.shareOf8TicketBuildPct < 0.5);
});

test('subsystem-bench: plan compiler, prosecutor/review fleet, scheduler DAG replay, and policy fuzzer satisfy all invariants', async () => {
  const planBench = runLivePlanCompilerBenchmark();
  assert.equal(planBench.ok, true, JSON.stringify(planBench));
  assert.equal(planBench.overlapRecall, 1.0);
  assert.equal(planBench.serialFalsePositiveRate, 0.0);
  assert.equal(planBench.gateTamperBlockRate, 1.0);

  const prosBench = await runLiveProsecutorAndReviewBenchmark();
  assert.equal(prosBench.ok, true, JSON.stringify(prosBench));
  assert.equal(prosBench.passedChecks, 10);
  assert.equal(prosBench.passRate, 1.0);

  const schedBench = await runLiveSchedulerDagBenchmark();
  assert.equal(schedBench.ok, true, JSON.stringify(schedBench));
  assert.equal(schedBench.scenarios.diamondDagReverseOrder.mergedCount, 4);
  assert.equal(schedBench.scenarios.diamondDagReverseOrder.leakedLeases, 0);
  assert.equal(schedBench.scenarios.prosecutorBlockThenFixRecovery.ok, true);
  assert.equal(schedBench.scenarios.strikeOneGateFailThenStrikeTwoRegenRecovery.ok, true);

  const fuzzBench = runLivePolicyFuzzerBenchmark({ seed: 20261030 });
  assert.equal(fuzzBench.ok, true, JSON.stringify(fuzzBench));
  assert.equal(fuzzBench.totalFuzzCases, 120);
  assert.equal(fuzzBench.adversarialBlockRate, 1.0);
  assert.equal(fuzzBench.benignPassRate, 1.0);
  assert.ok(fuzzBench.p95EvaluateMs < 5.0);
});

test('runner: runAllEvals verifies all invariants, checks baseline ratchet, and renders markdown report', async () => {
  const results = await runAllEvals({ trials: 100, seed: 20261030 });
  assert.equal(results.ok, true, JSON.stringify(results.invariants));
  assert.equal(results.liveProbes.ok, true, JSON.stringify(results.liveProbes));
  assert.equal(results.liveProbes.probes.preToolUseBlocksOutOfScope.ok, true);
  assert.equal(results.liveBenchmarks.policyCorpus.ok, true);
  assert.equal(results.liveBenchmarks.hookLatency.ok, true);
  assert.equal(results.liveBenchmarks.orchestratorOverhead.ok, true);
  assert.equal(results.liveBenchmarks.planCompiler.ok, true);
  assert.equal(results.liveBenchmarks.prosecutorAndReview.ok, true);
  assert.equal(results.liveBenchmarks.schedulerDag.ok, true);
  assert.equal(results.liveBenchmarks.policyFuzzer.ok, true);
  assert.equal(results.baselineRatchet.ok, true, JSON.stringify(results.baselineRatchet));

  // Verify synthetic regression detection in compareAgainstBaseline
  const baseline = loadBaseline();
  const regressed = structuredClone(results);
  regressed.liveBenchmarks.policyFuzzer.adversarialBlockRate = 0.99;
  regressed.liveBenchmarks.planCompiler.serialFalsePositiveRate = 0.1;
  const regCheck = compareAgainstBaseline(regressed, baseline);
  assert.equal(regCheck.ok, false);
  assert.ok(regCheck.failedChecks.includes('policyFuzzerBlockRate'));
  assert.ok(regCheck.failedChecks.includes('planCompilerSerialFalsePositives'));

  const md = renderMarkdownReport(results);
  assert.match(md, /## Executive Summary: Headline Statistical Gains/);
  assert.match(md, /xychart-beta/);
  assert.match(md, /Live Mechanical Runtime Probes/);
  assert.match(md, /6d\. Plan Compiler, Scope-Overlap & Gate-Integrity Golden Corpus/);
  assert.match(md, /6e\. Prosecutor & Review Fleet Mechanical Contract Benchmark/);
  assert.match(md, /6f\. Live Hermetic Scheduler DAG & Strike-Recovery Replay/);
  assert.match(md, /6g\. Seeded Metamorphic Policy Fuzzer/);
  assert.match(md, /6h\. Committed Baseline Regression Ratchet/);
  await assert.rejects(() => runAllEvals({ trials: 0 }), /positive integer/);
  await assert.rejects(() => runAllEvals({ trials: -5 }), /positive integer/);
  await assert.rejects(() => runAllEvals({ trials: 10, seed: Number.NaN }), /finite integer/);
});
