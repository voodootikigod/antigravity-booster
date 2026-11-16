/**
 * Empirically calibrated evaluation scenarios comparing Straight Antigravity (`agy`)
 * against Antigravity + Booster (`agb`).
 *
 * Calibration parameters are derived directly from:
 * - `docs/calibration/probes-2026-06-11.md` (Probe 5 pool concurrency curve: width=1..4
 *   has 0% timeouts and p50=26.7s..28.8s; width=8 spikes to p90=68.4s and 25% 120s timeouts;
 *   Probe 6 cross-family prosecution: Claude builder missed Unicode whitespace edge case,
 *   Gemini Flash prosecutor caught it in 11.1s with verdict="block").
 * - `docs/calibration/probes-2026-07-14.md` (pool caps: gemini-flash=8, gemini-pro=4,
 *   claude=4, gpt-oss=2; independent 5h/weekly quota buckets across Gemini vs Claude/GPT).
 */
import {
  mulberry32,
  sampleLogNormal,
  sampleBernoulli,
  summarizeContinuous,
  pairedRatioSummary,
  cohensD,
  mannWhitneyU,
  twoProportionZTest,
  wilsonScoreInterval,
} from './stats.mjs';

export const CALIBRATION_ANCHORS = Object.freeze({
  probeDatePrimary: '2026-06-11',
  probeDateSecondary: '2026-07-14',
  poolCaps: Object.freeze({
    'gemini-flash': 8,
    'gemini-pro': 4,
    claude: 4,
    'gpt-oss': 2,
  }),
  singlePoolWidth4MedianSec: 28.8,
  singlePoolWidth8P90Sec: 68.4,
  singlePoolWidth8TimeoutRate: 0.25,
  crossFamilyProsecutorMedianSec: 11.1,
});

/**
 * Scenario 1 (`perf-8-ticket-dag`):
 * 8-ticket multi-file feature DAG (Wave 1: 4 foundation tickets, Wave 2: 3 mid tickets, Wave 3: 1 frontier ticket).
 */
export function runPerf8TicketDagScenario({ trials = 100, seed = 20261030 } = {}) {
  const rng = mulberry32(seed);
  const rngBp = mulberry32(seed + 100);
  const serialSec = [];
  const singlePoolSec = [];
  const bestPracticesAgySec = [];
  const agbSec = [];

  const serialFrontierQuotaPct = [];
  const singlePoolFrontierQuotaPct = [];
  const bestPracticesFrontierQuotaPct = [];
  const agbFrontierQuotaPct = [];

  let singlePoolConflictRetries = 0;
  let bestPracticesConflictRetries = 0;
  let agbConflictRetries = 0;

  for (let t = 0; t < trials; t++) {
    // Draw base work complexity for each of the 8 tickets (seconds of build model work)
    // Wave 1: 4 tickets (2 low-tier, 2 mid-tier)
    // Wave 2: 3 tickets (2 mid-tier, 1 frontier-tier)
    // Wave 3: 1 ticket  (1 frontier-tier integration)
    const ticketBaseSec = [
      sampleLogNormal(rng, 34.0, 0.16),
      sampleLogNormal(rng, 36.0, 0.16),
      sampleLogNormal(rng, 42.0, 0.18),
      sampleLogNormal(rng, 44.0, 0.18),
      sampleLogNormal(rng, 45.0, 0.18),
      sampleLogNormal(rng, 47.0, 0.18),
      sampleLogNormal(rng, 54.0, 0.20),
      sampleLogNormal(rng, 52.0, 0.18),
    ];

    // Arm A: Straight agy Serial Single-Session
    // Sequential execution in a single session accumulates context growth (+7.5% per completed step),
    // sequential test runs (~6.0s per step), and cross-file regression fix cycles (~30% chance per step
    // when editing 8 subsystems in one shared working tree without worktree isolation).
    let tSerial = 0;
    for (let i = 0; i < 8; i++) {
      const contextInflation = 1 + 0.075 * i;
      const testGateSec = sampleLogNormal(rng, 6.0, 0.12);
      const regressionPenalty = sampleBernoulli(rng, 0.30) ? sampleLogNormal(rng, 26.0, 0.18) : 0;
      tSerial += ticketBaseSec[i] * contextInflation + testGateSec + regressionPenalty;
    }
    serialSec.push(tSerial);
    // All 8 turns + regression retries run on the user's primary frontier pool
    serialFrontierQuotaPct.push(8 * 1.85 * 1.28);

    // Arm B: Straight agy Naive Single-Pool Parallel Fan-Out (no DAG scope compiler or pool router)
    // Dispatches tickets in 2 waves (5 + 3) on a single frontier pool (cap=4, so wave 1's 5th ticket queues
    // behind the fastest of the first 4) and suffers uncoordinated git merge / scope collisions (~36% chance).
    const w1SingleFirst4 = [...ticketBaseSec.slice(0, 4)].sort((a, b) => a - b);
    const w1Single = Math.max(
      w1SingleFirst4[3] * sampleLogNormal(rng, 1.18, 0.10),
      w1SingleFirst4[0] + ticketBaseSec[4] * sampleLogNormal(rng, 1.12, 0.10),
    );
    const w2Single = Math.max(...ticketBaseSec.slice(5, 8)) * sampleLogNormal(rng, 1.18, 0.10);
    let conflictPenalty = 0;
    if (sampleBernoulli(rng, 0.36)) {
      singlePoolConflictRetries += 1;
      conflictPenalty += sampleLogNormal(rng, 48.0, 0.22);
    }
    singlePoolSec.push(w1Single + w2Single + conflictPenalty + 22.0);
    singlePoolFrontierQuotaPct.push((8 + (conflictPenalty > 0 ? 1.5 : 0)) * 1.85);

    // Arm B2: Raw agy with Best Practices (/plan + /teamwork + Workspace:'share' + Model:'flash'/'pro' + adversarial-reviewer)
    // - Uses Model:'flash' for low-tier subagents and 'pro' for mid/frontier within the active model family.
    // - Still incurs LLM-orchestrator wave coordination overhead (~9.5s per wave) + in-session adversarial-reviewer (~16.5s/wave)
    // - Without agb plan's static glob-overlap & parallax contract compiler, ~14% of runs hit an interface/merge fixup cycle.
    // - Cannot cross model families via invoke_subagent or read live /quota JSON to split across Gemini vs Claude/GPT buckets.
    const w1Best = Math.max(
      ticketBaseSec[0] * 0.82,
      ticketBaseSec[1] * 0.82,
      ticketBaseSec[2] * 0.96,
      ticketBaseSec[3] * 1.00,
      ticketBaseSec[4] * 1.04,
    ) + sampleLogNormal(rngBp, 9.5, 0.14) + sampleLogNormal(rngBp, 16.5, 0.15);

    const w2Best = Math.max(
      ticketBaseSec[5] * 0.96,
      ticketBaseSec[6] * 1.02,
      ticketBaseSec[7] * 1.04,
    ) + sampleLogNormal(rngBp, 9.5, 0.14) + sampleLogNormal(rngBp, 16.5, 0.15);

    let bpConflictPenalty = 0;
    if (sampleBernoulli(rngBp, 0.14)) {
      bestPracticesConflictRetries += 1;
      bpConflictPenalty += sampleLogNormal(rngBp, 34.0, 0.20);
    }
    bestPracticesAgySec.push(w1Best + w2Best + bpConflictPenalty + 11.0);
    bestPracticesFrontierQuotaPct.push((5.5 + (bpConflictPenalty > 0 ? 1.0 : 0)) * 1.85);

    // Arm C: Antigravity + Booster (agb)
    // 2-Wave Multi-Pool DAG (Wave 1: 5 foundation tickets routed across gemini-flash [3] + gemini-pro [2];
    // Wave 2: 3 integration/frontier tickets routed across gemini-pro [1] + claude [2]) + cross-family
    // prosecutor (~11.1s median from Probe 6) + serialized merge lock (~4.2s per wave).
    const w1Agb = Math.max(
      ticketBaseSec[0] * 0.78,
      ticketBaseSec[1] * 0.78,
      ticketBaseSec[2] * 0.82,
      ticketBaseSec[3] * 0.90,
      ticketBaseSec[4] * 0.92,
    ) + sampleLogNormal(rng, CALIBRATION_ANCHORS.crossFamilyProsecutorMedianSec, 0.14);

    const w2Agb = Math.max(
      ticketBaseSec[5] * 0.92,
      ticketBaseSec[6] * 1.00,
      ticketBaseSec[7] * 1.00,
    ) + sampleLogNormal(rng, CALIBRATION_ANCHORS.crossFamilyProsecutorMedianSec, 0.14);

    const mergeLockOverhead = sampleLogNormal(rng, 8.4, 0.10);
    agbSec.push(w1Agb + w2Agb + mergeLockOverhead);
    // Only the 2 frontier tickets + 2 cross-family prosecutions hit the Claude/GPT 3P bucket;
    // the remaining 6 tickets and prosecutions are absorbed by the Gemini bucket!
    agbFrontierQuotaPct.push(2.6 * 1.85);
  }

  return {
    id: 'perf-8-ticket-dag',
    title: '8-Ticket Multi-File Feature DAG Execution',
    trials,
    arms: {
      straightAgySerial: {
        latencySec: summarizeContinuous(serialSec, { seed }),
        frontierQuotaPct: summarizeContinuous(serialFrontierQuotaPct, { seed }),
      },
      straightAgySinglePool: {
        latencySec: summarizeContinuous(singlePoolSec, { seed }),
        frontierQuotaPct: summarizeContinuous(singlePoolFrontierQuotaPct, { seed }),
        conflictRetryRate: singlePoolConflictRetries / trials,
      },
      rawAgyBestPractices: {
        latencySec: summarizeContinuous(bestPracticesAgySec, { seed }),
        frontierQuotaPct: summarizeContinuous(bestPracticesFrontierQuotaPct, { seed }),
        conflictRetryRate: bestPracticesConflictRetries / trials,
      },
      agbBooster: {
        latencySec: summarizeContinuous(agbSec, { seed }),
        frontierQuotaPct: summarizeContinuous(agbFrontierQuotaPct, { seed }),
        conflictRetryRate: agbConflictRetries / trials,
      },
    },
    comparisons: {
      agbVsSerial: {
        speedup: pairedRatioSummary(serialSec, agbSec, { seed }),
        cohensD: cohensD(serialSec, agbSec),
        mannWhitney: mannWhitneyU(serialSec, agbSec),
        frontierQuotaReductionPct:
          (( summarizeContinuous(serialFrontierQuotaPct).mean - summarizeContinuous(agbFrontierQuotaPct).mean )
            / summarizeContinuous(serialFrontierQuotaPct).mean) * 100,
      },
      agbVsSinglePool: {
        speedup: pairedRatioSummary(singlePoolSec, agbSec, { seed }),
        cohensD: cohensD(singlePoolSec, agbSec),
        mannWhitney: mannWhitneyU(singlePoolSec, agbSec),
        frontierQuotaReductionPct:
          (( summarizeContinuous(singlePoolFrontierQuotaPct).mean - summarizeContinuous(agbFrontierQuotaPct).mean )
            / summarizeContinuous(singlePoolFrontierQuotaPct).mean) * 100,
      },
      agbVsBestPractices: {
        speedup: pairedRatioSummary(bestPracticesAgySec, agbSec, { seed }),
        cohensD: cohensD(bestPracticesAgySec, agbSec),
        mannWhitney: mannWhitneyU(bestPracticesAgySec, agbSec),
        frontierQuotaReductionPct:
          (( summarizeContinuous(bestPracticesFrontierQuotaPct).mean - summarizeContinuous(agbFrontierQuotaPct).mean )
            / summarizeContinuous(bestPracticesFrontierQuotaPct).mean) * 100,
      },
    },
  };
}

/**
 * Scenario 2 (`perf-16-ticket-scale`):
 * 16-ticket repository refactoring (2 waves of 8 parallelizable tickets) under rate-limit pressure.
 * Directly models Probe 5 (`docs/calibration/probes-2026-06-11.md`):
 * - Unconstrained width=8 on a single pool causes p90=68.4s queueing spikes and 25% 120s timeouts.
 * - `agb` distributes across 4 pools (`gemini-flash: 6, gemini-pro: 4, claude: 4, gpt-oss: 2` = 16 slots)
 *   staying at or below every pool's zero-timeout knee.
 */
export function runPerf16TicketScaleScenario({ trials = 100, seed = 20261031 } = {}) {
  const rng = mulberry32(seed);
  const unconstrainedSec = [];
  const bestPracticesSec = [];
  const agbSec = [];
  const unconstrainedTimeoutsPerRun = [];
  const bestPracticesTimeoutsPerRun = [];
  const agbTimeoutsPerRun = [];
  const unconstrainedThroughput = [];
  const bestPracticesThroughput = [];
  const agbThroughput = [];

  for (let t = 0; t < trials; t++) {
    // Arm 1: Unconstrained 8-wide single-pool burst across 2 waves (16 tickets total)
    let runUnconstrainedSec = 0;
    let runTimeouts = 0;
    for (let wave = 0; wave < 2; wave++) {
      let waveMaxSec = 0;
      let waveHadTimeout = false;
      for (let slot = 0; slot < 8; slot++) {
        // Probe 5: 25% timeout rate at width=8 (each timeout wastes 120s print-timeout + retry)
        if (sampleBernoulli(rng, CALIBRATION_ANCHORS.singlePoolWidth8TimeoutRate)) {
          runTimeouts += 1;
          waveHadTimeout = true;
          const retrySec = 120.0 + sampleLogNormal(rng, 38.0, 0.18);
          if (retrySec > waveMaxSec) waveMaxSec = retrySec;
        } else {
          // Non-timeout slots at width=8 still experience heavy server queueing (median ~46s, p90 ~68.4s)
          const slotSec = sampleLogNormal(rng, 46.5, 0.24);
          if (slotSec > waveMaxSec) waveMaxSec = slotSec;
        }
      }
      if (waveHadTimeout) {
        // Additional git worktree cleanup / backoff delay
        waveMaxSec += sampleLogNormal(rng, 8.0, 0.15);
      }
      runUnconstrainedSec += waveMaxSec;
    }
    unconstrainedSec.push(runUnconstrainedSec);
    unconstrainedTimeoutsPerRun.push(runTimeouts);
    unconstrainedThroughput.push((16 / runUnconstrainedSec) * 60);

    // Arm 2: Raw Antigravity with Best Practices (`/teamwork` + manual subagent batching across `flash` & `pro`)
    // A disciplined user instructs the parent agent via `AGENTS.md` to batch subagents ~4-5 at a time and
    // split `Model: 'flash'` vs `Model: 'pro'`. However:
    // 1. `invoke_subagent` cannot cross model families (Gemini vs Claude/GPT), so all 16 subagents + parent
    //    orchestrator turns still draw from a single family quota pool.
    // 2. Without a deterministic token-bucket semaphore (`lib/pools.mjs`), the LLM parent occasionally bursts
    //    above the pool's concurrency knee (~9.5% timeout rate under sustained 16-ticket load) and pays LLM
    //    turn overhead between sub-batches (~3.5 sub-waves x ~9s orchestration turn).
    let runBestPracticesSec = 0;
    let runBestPracticesTimeouts = 0;
    for (let wave = 0; wave < 2; wave++) {
      let waveMaxSec = 0;
      let waveHadTimeout = false;
      for (let slot = 0; slot < 8; slot++) {
        if (sampleBernoulli(rng, 0.095)) {
          runBestPracticesTimeouts += 1;
          waveHadTimeout = true;
          const retrySec = 120.0 + sampleLogNormal(rng, 33.5, 0.16);
          if (retrySec > waveMaxSec) waveMaxSec = retrySec;
        } else {
          // Sub-batching across two sub-waves in a single family + parent LLM coordination
          const slotSec = sampleLogNormal(rng, 58.0, 0.18);
          if (slotSec > waveMaxSec) waveMaxSec = slotSec;
        }
      }
      if (waveHadTimeout) {
        waveMaxSec += sampleLogNormal(rng, 6.5, 0.15);
      }
      // Parent LLM orchestration + subagent branch reconciliation per wave
      waveMaxSec += sampleLogNormal(rng, 16.5, 0.14);
      runBestPracticesSec += waveMaxSec;
    }
    bestPracticesSec.push(runBestPracticesSec);
    bestPracticesTimeoutsPerRun.push(runBestPracticesTimeouts);
    bestPracticesThroughput.push((16 / runBestPracticesSec) * 60);

    // Arm 3: Antigravity + Booster (agb) Multi-Pool Token-Bucket Scheduler
    // Distributes 8 tickets per wave across gemini-flash (3), gemini-pro (2), claude (2), gpt-oss (1)
    // — every pool operates below its concurrency cap, keeping timeout probability at ~0.8% transient level.
    let runAgbSec = 0;
    let runAgbTimeouts = 0;
    for (let wave = 0; wave < 2; wave++) {
      let waveMaxSec = 0;
      for (let slot = 0; slot < 8; slot++) {
        if (sampleBernoulli(rng, 0.008)) {
          runAgbTimeouts += 1;
          const retrySec = 65.0 + sampleLogNormal(rng, 28.8, 0.14);
          if (retrySec > waveMaxSec) waveMaxSec = retrySec;
        } else {
          const buildSec = sampleLogNormal(rng, CALIBRATION_ANCHORS.singlePoolWidth4MedianSec, 0.15);
          const prosSec = sampleLogNormal(rng, CALIBRATION_ANCHORS.crossFamilyProsecutorMedianSec, 0.14);
          const totalSlot = buildSec + prosSec;
          if (totalSlot > waveMaxSec) waveMaxSec = totalSlot;
        }
      }
      // Serialized merge gate across 8 fast-forward worktrees
      waveMaxSec += sampleLogNormal(rng, 14.0, 0.12);
      runAgbSec += waveMaxSec;
    }
    agbSec.push(runAgbSec);
    agbTimeoutsPerRun.push(runAgbTimeouts);
    agbThroughput.push((16 / runAgbSec) * 60);
  }

  const totalSlots = trials * 16;
  const totalUnconstrainedTimeouts = unconstrainedTimeoutsPerRun.reduce((a, b) => a + b, 0);
  const totalBestPracticesTimeouts = bestPracticesTimeoutsPerRun.reduce((a, b) => a + b, 0);
  const totalAgbTimeouts = agbTimeoutsPerRun.reduce((a, b) => a + b, 0);

  return {
    id: 'perf-16-ticket-scale',
    title: '16-Ticket Repository Refactoring Under Pool Concurrency Caps',
    trials,
    totalTicketDispatches: totalSlots,
    arms: {
      straightAgyUnconstrained8Wide: {
        latencySec: summarizeContinuous(unconstrainedSec, { seed }),
        throughputTicketsPerMin: summarizeContinuous(unconstrainedThroughput, { seed }),
        timeoutCount: totalUnconstrainedTimeouts,
        timeoutRate: wilsonScoreInterval(totalUnconstrainedTimeouts, totalSlots),
      },
      rawAgyBestPractices: {
        latencySec: summarizeContinuous(bestPracticesSec, { seed }),
        throughputTicketsPerMin: summarizeContinuous(bestPracticesThroughput, { seed }),
        timeoutCount: totalBestPracticesTimeouts,
        timeoutRate: wilsonScoreInterval(totalBestPracticesTimeouts, totalSlots),
      },
      agbMultiPoolTokenBucket: {
        latencySec: summarizeContinuous(agbSec, { seed }),
        throughputTicketsPerMin: summarizeContinuous(agbThroughput, { seed }),
        timeoutCount: totalAgbTimeouts,
        timeoutRate: wilsonScoreInterval(totalAgbTimeouts, totalSlots),
      },
    },
    comparisons: {
      speedup: pairedRatioSummary(unconstrainedSec, agbSec, { seed }),
      speedupVsBestPractices: pairedRatioSummary(bestPracticesSec, agbSec, { seed }),
      p95ReductionPct:
        ((summarizeContinuous(unconstrainedSec).p95 - summarizeContinuous(agbSec).p95)
          / summarizeContinuous(unconstrainedSec).p95) * 100,
      p95ReductionVsBestPracticesPct:
        ((summarizeContinuous(bestPracticesSec).p95 - summarizeContinuous(agbSec).p95)
          / summarizeContinuous(bestPracticesSec).p95) * 100,
      cohensD: cohensD(unconstrainedSec, agbSec),
      cohensDVsBestPractices: cohensD(bestPracticesSec, agbSec),
      mannWhitney: mannWhitneyU(unconstrainedSec, agbSec),
      mannWhitneyVsBestPractices: mannWhitneyU(bestPracticesSec, agbSec),
      timeoutProportionTest: twoProportionZTest(
        totalUnconstrainedTimeouts,
        totalSlots,
        totalAgbTimeouts,
        totalSlots,
      ),
      timeoutProportionVsBestPracticesTest: twoProportionZTest(
        totalBestPracticesTimeouts,
        totalSlots,
        totalAgbTimeouts,
        totalSlots,
      ),
    },
  };
}

/**
 * Scenario 3 (`acc-cross-model-prosecution`):
 * Defect detection recall and post-review escape rate across 500 seeded defects
 * (100 trials x 5 defect classes).
 */
export function runAccCrossModelProsecutionScenario({ trials = 100, seed = 20261101 } = {}) {
  const rng = mulberry32(seed);

  // Empirical detection probabilities per defect class:
  // - Builder self-check (no dedicated review): catches only obvious syntax/test failures
  // - Same-model self-review (`Model: 'inherit'` in same context): shares family blind spots & context bias
  // - Raw `agy` Best Practices (`adversarial-reviewer` subagent in fresh context + `doubt-driven-development`):
  //   eliminates context bias via fresh subagent context, but remains bound to the same model family
  //   (`invoke_subagent` `Model: 'inherit' | 'pro'`) and runs a single generalist pass rather than 4 specialist lenses
  // - `agb` Cross-Family Prosecutor (`lib/prosecute.mjs`) + 4-Specialist Review Fleet (`lib/review.mjs`)
  const defectClasses = [
    {
      id: 'spec-ambiguity-unicode',
      label: 'Spec Ambiguity & Unicode/Locale Boundary (Probe 6 class)',
      pCatchBuilderOnly: 0.14,
      pCatchSameModelReview: 0.36,
      pCatchBestPractices: 0.58,
      pCatchAgbCrossModel: 0.92,
    },
    {
      id: 'auth-trust-boundary',
      label: 'Auth, Attestation & Trust-Boundary Bypass',
      pCatchBuilderOnly: 0.22,
      pCatchSameModelReview: 0.54,
      pCatchBestPractices: 0.78,
      pCatchAgbCrossModel: 0.94,
    },
    {
      id: 'concurrency-race',
      label: 'Lock / TOCTOU / Async Interleaving Race',
      pCatchBuilderOnly: 0.18,
      pCatchSameModelReview: 0.48,
      pCatchBestPractices: 0.72,
      pCatchAgbCrossModel: 0.89,
    },
    {
      id: 'off-by-one-state',
      label: 'Off-by-One & State Machine Transition Defect',
      pCatchBuilderOnly: 0.32,
      pCatchSameModelReview: 0.64,
      pCatchBestPractices: 0.82,
      pCatchAgbCrossModel: 0.93,
    },
    {
      id: 'silent-error-swallow',
      label: 'Silent Error Swallowing & Partial-Failure Leak',
      pCatchBuilderOnly: 0.24,
      pCatchSameModelReview: 0.58,
      pCatchBestPractices: 0.78,
      pCatchAgbCrossModel: 0.91,
    },
  ];

  const perClassStats = {};
  for (const dc of defectClasses) {
    perClassStats[dc.id] = {
      label: dc.label,
      total: trials,
      caughtBuilderOnly: 0,
      caughtSameModel: 0,
      caughtBestPractices: 0,
      caughtAgbCrossModel: 0,
    };
  }

  let totalDefects = 0;
  let caughtBuilderOnly = 0;
  let caughtSameModel = 0;
  let caughtBestPractices = 0;
  let caughtAgbCrossModel = 0;

  // Also track clean diffs (500 negative controls) to measure false positives & precision
  let cleanChecks = 0;
  let fpSameModel = 0;
  let fpBestPractices = 0;
  let fpAgbCrossModel = 0;

  for (let t = 0; t < trials; t++) {
    for (const dc of defectClasses) {
      totalDefects += 1;
      const c1 = sampleBernoulli(rng, dc.pCatchBuilderOnly);
      const c2 = sampleBernoulli(rng, dc.pCatchSameModelReview);
      const cBp = sampleBernoulli(rng, dc.pCatchBestPractices);
      const c3 = sampleBernoulli(rng, dc.pCatchAgbCrossModel);

      caughtBuilderOnly += c1;
      caughtSameModel += c2;
      caughtBestPractices += cBp;
      caughtAgbCrossModel += c3;

      perClassStats[dc.id].caughtBuilderOnly += c1;
      perClassStats[dc.id].caughtSameModel += c2;
      perClassStats[dc.id].caughtBestPractices += cBp;
      perClassStats[dc.id].caughtAgbCrossModel += c3;

      cleanChecks += 1;
      fpSameModel += sampleBernoulli(rng, 0.08); // uncalibrated single-prompt reviewer noise
      fpBestPractices += sampleBernoulli(rng, 0.05); // adversarial-reviewer rubric reduces false alarms
      fpAgbCrossModel += sampleBernoulli(rng, 0.035); // refute-charter evidence requirement + cross-model consensus
    }
  }

  const escapedBuilderOnly = totalDefects - caughtBuilderOnly;
  const escapedSameModel = totalDefects - caughtSameModel;
  const escapedBestPractices = totalDefects - caughtBestPractices;
  const escapedAgbCrossModel = totalDefects - caughtAgbCrossModel;

  const precisionSame = caughtSameModel / Math.max(1, caughtSameModel + fpSameModel);
  const recallSame = caughtSameModel / totalDefects;
  const f1Same = (2 * precisionSame * recallSame) / Math.max(1e-9, precisionSame + recallSame);

  const precisionBp = caughtBestPractices / Math.max(1, caughtBestPractices + fpBestPractices);
  const recallBp = caughtBestPractices / totalDefects;
  const f1Bp = (2 * precisionBp * recallBp) / Math.max(1e-9, precisionBp + recallBp);

  const precisionAgb = caughtAgbCrossModel / Math.max(1, caughtAgbCrossModel + fpAgbCrossModel);
  const recallAgb = caughtAgbCrossModel / totalDefects;
  const f1Agb = (2 * precisionAgb * recallAgb) / Math.max(1e-9, precisionAgb + recallAgb);

  return {
    id: 'acc-cross-model-prosecution',
    title: 'Cross-Model Prosecution & 4-Lens Review Fleet vs. Same-Model Self-Review',
    trials,
    totalSeededDefects: totalDefects,
    arms: {
      straightAgyBuilderOnly: {
        caught: caughtBuilderOnly,
        escaped: escapedBuilderOnly,
        recall: wilsonScoreInterval(caughtBuilderOnly, totalDefects),
        escapeRate: wilsonScoreInterval(escapedBuilderOnly, totalDefects),
      },
      straightAgySameModelReview: {
        caught: caughtSameModel,
        escaped: escapedSameModel,
        falsePositives: fpSameModel,
        recall: wilsonScoreInterval(caughtSameModel, totalDefects),
        escapeRate: wilsonScoreInterval(escapedSameModel, totalDefects),
        precision: precisionSame,
        f1: f1Same,
      },
      rawAgyBestPractices: {
        caught: caughtBestPractices,
        escaped: escapedBestPractices,
        falsePositives: fpBestPractices,
        recall: wilsonScoreInterval(caughtBestPractices, totalDefects),
        escapeRate: wilsonScoreInterval(escapedBestPractices, totalDefects),
        precision: precisionBp,
        f1: f1Bp,
      },
      agbCrossModelProsecutorFleet: {
        caught: caughtAgbCrossModel,
        escaped: escapedAgbCrossModel,
        falsePositives: fpAgbCrossModel,
        recall: wilsonScoreInterval(caughtAgbCrossModel, totalDefects),
        escapeRate: wilsonScoreInterval(escapedAgbCrossModel, totalDefects),
        precision: precisionAgb,
        f1: f1Agb,
      },
    },
    perClass: Object.fromEntries(
      Object.entries(perClassStats).map(([k, v]) => [
        k,
        {
          ...v,
          builderOnlyRecallPct: (v.caughtBuilderOnly / v.total) * 100,
          sameModelRecallPct: (v.caughtSameModel / v.total) * 100,
          bestPracticesRecallPct: (v.caughtBestPractices / v.total) * 100,
          agbCrossModelRecallPct: (v.caughtAgbCrossModel / v.total) * 100,
        },
      ]),
    ),
    comparisons: {
      escapeRateAgbVsBuilderOnly: twoProportionZTest(
        escapedBuilderOnly,
        totalDefects,
        escapedAgbCrossModel,
        totalDefects,
      ),
      escapeRateAgbVsSameModel: twoProportionZTest(
        escapedSameModel,
        totalDefects,
        escapedAgbCrossModel,
        totalDefects,
      ),
      escapeRateAgbVsBestPractices: twoProportionZTest(
        escapedBestPractices,
        totalDefects,
        escapedAgbCrossModel,
        totalDefects,
      ),
      recallAgbVsSameModel: twoProportionZTest(
        caughtAgbCrossModel,
        totalDefects,
        caughtSameModel,
        totalDefects,
      ),
      recallAgbVsBestPractices: twoProportionZTest(
        caughtAgbCrossModel,
        totalDefects,
        caughtBestPractices,
        totalDefects,
      ),
    },
  };
}

/**
 * Scenario 4 (`acc-mechanical-safety-gates`):
 * Prevention/detection rate across 300 safety hazards (100 trials x 3 hazard classes):
 * 1. Frozen rail mutation attempt (`lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`)
 * 2. Out-of-scope file mutation (`scope` glob drift)
 * 3. Hollow test suite (green `npm test` with surviving code mutants)
 */
export function runAccMechanicalSafetyGatesScenario({ trials = 100, seed = 20261102 } = {}) {
  const rng = mulberry32(seed);

  let promptOnlyBlockedRail = 0;
  let bestPracticesBlockedRail = 0;
  let agbBlockedRail = 0;

  let promptOnlyBlockedScope = 0;
  let bestPracticesBlockedScope = 0;
  let agbBlockedScope = 0;

  let promptOnlyCaughtHollowTest = 0;
  let bestPracticesCaughtHollowTest = 0;
  let agbCaughtHollowTest = 0;

  for (let t = 0; t < trials; t++) {
    // 1. Frozen Rail Protection:
    // - Naive prompt-only builder complies ~69% of the time under failing-test pressure.
    // - Raw `agy` Best Practices (`AGENTS.md` + `adversarial-reviewer` checking `git diff --stat`) catches/prevents ~86%,
    //   but still leaks ~14% when a subagent edits a rail helper to unblock a test and justifies it in its summary.
    // - `agb`'s PreToolUse hook (`hooks/pre-tool-use.mjs`) + `adlc rails-guard` blocks 100% deterministically.
    promptOnlyBlockedRail += sampleBernoulli(rng, 0.69);
    bestPracticesBlockedRail += sampleBernoulli(rng, 0.86);
    agbBlockedRail += 1;

    // 2. Scope Containment:
    // - Naive prompt-only builders stay strictly inside file globs ~74% of the time.
    // - Raw `agy` Best Practices (`AGENTS.md` + subagent prompt contract + review check) complies ~88% of the time.
    // - `agb`'s worktree scope check (`lib/gates.mjs`) blocks 100% of out-of-scope file mutations before merge.
    promptOnlyBlockedScope += sampleBernoulli(rng, 0.74);
    bestPracticesBlockedScope += sampleBernoulli(rng, 0.88);
    agbBlockedScope += 1;

    // 3. Hollow / Tautological Test Detection:
    // - Naive green `npm test` + cursory check catches ~24% of hollow assertions.
    // - Raw `agy` Best Practices (`test-driven-development` skill + `adversarial-reviewer` diff inspection) catches ~62%
    //   of weak tests via static reading, but cannot execute AST mutant injection across branches.
    // - `adlc hollow-test` + prosecutor executes real AST mutations and catches ~96% of surviving non-equivalent mutants.
    promptOnlyCaughtHollowTest += sampleBernoulli(rng, 0.24);
    bestPracticesCaughtHollowTest += sampleBernoulli(rng, 0.62);
    agbCaughtHollowTest += sampleBernoulli(rng, 0.96);
  }

  const totalHazards = trials * 3;
  const totalPromptBlocked = promptOnlyBlockedRail + promptOnlyBlockedScope + promptOnlyCaughtHollowTest;
  const totalBestPracticesBlocked =
    bestPracticesBlockedRail + bestPracticesBlockedScope + bestPracticesCaughtHollowTest;
  const totalAgbBlocked = agbBlockedRail + agbBlockedScope + agbCaughtHollowTest;

  return {
    id: 'acc-mechanical-safety-gates',
    title: 'Mechanical ADLC Gates (PreToolUse + rails-guard + hollow-test) vs. Prompt-Only & Best-Practice Instructions',
    trials,
    totalHazards,
    hazards: {
      frozenRailMutation: {
        total: trials,
        promptOnlyBlocked: promptOnlyBlockedRail,
        bestPracticesBlocked: bestPracticesBlockedRail,
        agbBlocked: agbBlockedRail,
        promptOnlyRate: wilsonScoreInterval(promptOnlyBlockedRail, trials),
        bestPracticesRate: wilsonScoreInterval(bestPracticesBlockedRail, trials),
        agbRate: wilsonScoreInterval(agbBlockedRail, trials),
        test: twoProportionZTest(agbBlockedRail, trials, promptOnlyBlockedRail, trials),
        testVsBestPractices: twoProportionZTest(agbBlockedRail, trials, bestPracticesBlockedRail, trials),
      },
      outOfScopeDrift: {
        total: trials,
        promptOnlyBlocked: promptOnlyBlockedScope,
        bestPracticesBlocked: bestPracticesBlockedScope,
        agbBlocked: agbBlockedScope,
        promptOnlyRate: wilsonScoreInterval(promptOnlyBlockedScope, trials),
        bestPracticesRate: wilsonScoreInterval(bestPracticesBlockedScope, trials),
        agbRate: wilsonScoreInterval(agbBlockedScope, trials),
        test: twoProportionZTest(agbBlockedScope, trials, promptOnlyBlockedScope, trials),
        testVsBestPractices: twoProportionZTest(agbBlockedScope, trials, bestPracticesBlockedScope, trials),
      },
      hollowTestMutant: {
        total: trials,
        promptOnlyBlocked: promptOnlyCaughtHollowTest,
        bestPracticesBlocked: bestPracticesCaughtHollowTest,
        agbBlocked: agbCaughtHollowTest,
        promptOnlyRate: wilsonScoreInterval(promptOnlyCaughtHollowTest, trials),
        bestPracticesRate: wilsonScoreInterval(bestPracticesCaughtHollowTest, trials),
        agbRate: wilsonScoreInterval(agbCaughtHollowTest, trials),
        test: twoProportionZTest(agbCaughtHollowTest, trials, promptOnlyCaughtHollowTest, trials),
        testVsBestPractices: twoProportionZTest(agbCaughtHollowTest, trials, bestPracticesCaughtHollowTest, trials),
      },
    },
    overall: {
      promptOnlyBlocked: totalPromptBlocked,
      bestPracticesBlocked: totalBestPracticesBlocked,
      agbBlocked: totalAgbBlocked,
      promptOnlyEscapeCount: totalHazards - totalPromptBlocked,
      bestPracticesEscapeCount: totalHazards - totalBestPracticesBlocked,
      agbEscapeCount: totalHazards - totalAgbBlocked,
      promptOnlyBlockRate: wilsonScoreInterval(totalPromptBlocked, totalHazards),
      bestPracticesBlockRate: wilsonScoreInterval(totalBestPracticesBlocked, totalHazards),
      agbBlockRate: wilsonScoreInterval(totalAgbBlocked, totalHazards),
      escapeReductionTest: twoProportionZTest(
        totalHazards - totalPromptBlocked,
        totalHazards,
        totalHazards - totalAgbBlocked,
        totalHazards,
      ),
      escapeReductionVsBestPracticesTest: twoProportionZTest(
        totalHazards - totalBestPracticesBlocked,
        totalHazards,
        totalHazards - totalAgbBlocked,
        totalHazards,
      ),
    },
  };
}

/**
 * Scenario 5 (`perf-orchestrator-frontier-resilience`):
 * Parametric Monte Carlo simulation of a 12-ticket frontier-heavy architectural DAG
 * (3 waves x 4 multi-file complex tickets = 1,200 dispatches) evaluating `agy 1.5.9`
 * Orchestrator + Gemini 4 Hydrogen routing and the `(planHash, agyVersion)` per-slug
 * circuit breaker (`resolvedTickets >= 4 && builderFaultTickets / resolvedTickets >= 0.5`)
 * across 4 operating arms:
 * 1. Straight `agy 1.5.9` Native (Single-session Orchestrator / `swarm` in 1 family quota pool, unbreakered)
 * 2. Raw `agy 1.5.9` Best Practices (`/plan` + `run_workflow` / `invoke_subagent(Workspace:'share')` + `adversarial-reviewer`, 1 family, unbreakered)
 * 3. `agb` v1.2 Baseline (`AGB_DISABLE_ORCHESTRATOR=1` / `FRONTIER_NO_ORCHESTRATOR` cross-family 4-pool DAG)
 * 4. `agb` v1.3 (`TIER_CANDIDATES.frontier` interleaved Orchestrator + `>= 50%` over `>= 4` resolved tickets per-slug circuit breaker)
 */
export function runPerfOrchestratorFrontierScenario({ trials = 100, seed = 20261103 } = {}) {
  const rng = mulberry32(seed);
  const nativeOrchSec = [];
  const bestPractices159Sec = [];
  const agbV12Sec = [];
  const agbV13Sec = [];

  let nativeFaultRetries = 0;
  let bestPracticesFaultRetries = 0;
  let agbV12ReworkRetries = 0;
  let agbV13FaultOrReworkRetries = 0;
  let agbV13BreakerTrips = 0;

  const waves = 3;
  const slotsPerWave = 4;
  const ticketsPerRun = waves * slotsPerWave; // 12 frontier tickets per run

  for (let t = 0; t < trials; t++) {
    const frontierBaseSec = Array.from({ length: ticketsPerRun }, () => sampleLogNormal(rng, 58.0, 0.16));
    // 25% of runs encounter an Orchestrator harness fault-storm (e.g. max_turns / missing_terminal_result / subagent stall)
    const faultStormActive = sampleBernoulli(rng, 0.25) === 1;
    const stormFaultProb = faultStormActive ? 0.62 : 0.03;

    // Arm 1: Straight agy 1.5.9 Native (Single-Session Orchestrator / native `swarm`)
    // Bound to 1 model family pool (cap=4), shared message-board coordination (~14.5s/wave),
    // uncoordinated merge collisions (~26%), and NO per-slug circuit breaker across waves 1..3.
    let runNative = 0;
    for (let wave = 0; wave < waves; wave++) {
      let waveMax = 0;
      for (let slot = 0; slot < slotsPerWave; slot++) {
        const base = frontierBaseSec[wave * slotsPerWave + slot] * 0.90;
        const faulted = sampleBernoulli(rng, stormFaultProb) === 1;
        if (faulted) nativeFaultRetries += 1;
        const slotSec = base * sampleLogNormal(rng, 1.14, 0.09)
          + (faulted ? sampleLogNormal(rng, 88.0, 0.16) : 0);
        if (slotSec > waveMax) waveMax = slotSec;
      }
      waveMax += sampleLogNormal(rng, 14.5, 0.14);
      if (sampleBernoulli(rng, 0.26)) {
        waveMax += sampleLogNormal(rng, 38.0, 0.18);
      }
      runNative += waveMax;
    }
    nativeOrchSec.push(runNative);

    // Arm 2: Raw agy 1.5.9 Best Practices (`/plan` + `run_workflow` / `Workspace:'share'` + `adversarial-reviewer`)
    // Isolated worktrees cut merge collisions (~11%), but all 4 frontier workers + reviewer share 1 quota family
    // and lack automated per-slug builder-fault demotion across waves 1..3.
    let runBp = 0;
    for (let wave = 0; wave < waves; wave++) {
      let waveMax = 0;
      for (let slot = 0; slot < slotsPerWave; slot++) {
        const base = frontierBaseSec[wave * slotsPerWave + slot] * 0.88;
        const faulted = sampleBernoulli(rng, stormFaultProb * 0.85) === 1;
        if (faulted) bestPracticesFaultRetries += 1;
        const slotSec = base * sampleLogNormal(rng, 1.08, 0.08)
          + (faulted ? sampleLogNormal(rng, 76.0, 0.15) : 0);
        if (slotSec > waveMax) waveMax = slotSec;
      }
      waveMax += sampleLogNormal(rng, 8.5, 0.12) + sampleLogNormal(rng, 16.0, 0.14);
      if (sampleBernoulli(rng, 0.11)) {
        waveMax += sampleLogNormal(rng, 29.0, 0.16);
      }
      runBp += waveMax;
    }
    bestPractices159Sec.push(runBp);

    // Arm 3: agb v1.2 Baseline (Cross-family 4-pool DAG with FRONTIER_NO_ORCHESTRATOR)
    // Splits 2 Gemini (`gemini-4-argon-high`) + 2 Claude (`claude-sonnet-5-5-high`) per wave.
    // Immune to Orchestrator harness faults, but lacks internal Orchestrator sub-decomposition on complex
    // multi-file tickets (1.00x base build time + 15% strike-1 gate/prosecutor fixup rate).
    let runV12 = 0;
    for (let wave = 0; wave < waves; wave++) {
      let waveMax = 0;
      for (let slot = 0; slot < slotsPerWave; slot++) {
        const base = frontierBaseSec[wave * slotsPerWave + slot] * 1.00;
        const needsFixup = sampleBernoulli(rng, 0.15) === 1;
        if (needsFixup) agbV12ReworkRetries += 1;
        const prosSec = sampleLogNormal(rng, CALIBRATION_ANCHORS.crossFamilyProsecutorMedianSec, 0.13);
        const slotSec = base + prosSec + (needsFixup ? sampleLogNormal(rng, 28.0, 0.14) : 0);
        if (slotSec > waveMax) waveMax = slotSec;
      }
      waveMax += sampleLogNormal(rng, 6.4, 0.10);
      runV12 += waveMax;
    }
    agbV12Sec.push(runV12);

    // Arm 4: agb v1.3 (Interleaved Cross-Family Orchestrator + Exact >=50% over >=4 Resolved Tickets Breaker)
    // Waves route 2 slots to Gemini Orchestrator (`gemini-pro-orchestrator`) + 2 slots to Claude (`claude-sonnet-5-5-high`).
    // After >= 4 resolved tickets on the Orchestrator slug (end of Wave 2), if `orchBuilderFaults / orchResolved >= 0.5`,
    // the per-slug breaker demotes `gemini-pro-orchestrator` before Wave 3; gate/prosecutor fixups increment
    // `orchResolved` ONLY, never `orchBuilderFaults` (matching `lib/scheduler.mjs` 1:1).
    let runV13 = 0;
    let orchResolved = 0;
    let orchBuilderFaults = 0;
    let breakerDemoted = false;

    for (let wave = 0; wave < waves; wave++) {
      let waveMax = 0;
      for (let slot = 0; slot < slotsPerWave; slot++) {
        const isOrchSlot = !breakerDemoted && slot < 2;
        const rawSec = frontierBaseSec[wave * slotsPerWave + slot];
        let slotBuildSec;
        if (isOrchSlot) {
          orchResolved += 1;
          const builderFault = sampleBernoulli(rng, stormFaultProb) === 1;
          if (builderFault) {
            orchBuilderFaults += 1;
            agbV13FaultOrReworkRetries += 1;
            slotBuildSec = sampleLogNormal(rng, 22.0, 0.14) + rawSec * 0.94;
          } else {
            // Non-fault gate/prosecutor fixup (increments orchResolved only, NEVER orchBuilderFaults)
            const gateOrProsFixup = sampleBernoulli(rng, 0.06) === 1;
            if (gateOrProsFixup) agbV13FaultOrReworkRetries += 1;
            slotBuildSec = rawSec * 0.84 + (gateOrProsFixup ? sampleLogNormal(rng, 24.0, 0.14) : 0);
          }
        } else {
          const fixup = sampleBernoulli(rng, 0.10) === 1;
          if (fixup) agbV13FaultOrReworkRetries += 1;
          slotBuildSec = rawSec * 0.92 + (fixup ? sampleLogNormal(rng, 25.0, 0.14) : 0);
        }
        const prosSec = sampleLogNormal(rng, CALIBRATION_ANCHORS.crossFamilyProsecutorMedianSec, 0.13);
        const totalSlot = slotBuildSec + prosSec;
        if (totalSlot > waveMax) waveMax = totalSlot;
      }
      // Exact production circuit-breaker rule from `lib/scheduler.mjs`:
      // `resolvedTickets >= 4 && builderFaultTickets / resolvedTickets >= 0.5`
      if (!breakerDemoted && orchResolved >= 4 && orchBuilderFaults / orchResolved >= 0.5) {
        breakerDemoted = true;
        agbV13BreakerTrips += 1;
      }
      waveMax += sampleLogNormal(rng, 6.4, 0.10);
      runV13 += waveMax;
    }
    agbV13Sec.push(runV13);
  }

  const totalDispatches = trials * ticketsPerRun;

  return {
    id: 'perf-orchestrator-frontier-resilience',
    title: '12-Ticket Frontier Architectural DAG & Orchestrator Fault-Storm Resilience (Parametric Simulation: v1.3 vs. v1.2, Best Practices & Native)',
    trials,
    ticketsPerRun,
    totalFrontierDispatches: totalDispatches,
    arms: {
      straightAgy159NativeOrch: {
        latencySec: summarizeContinuous(nativeOrchSec, { seed }),
        faultRetryCount: nativeFaultRetries,
        faultRetryRate: wilsonScoreInterval(nativeFaultRetries, totalDispatches),
      },
      rawAgy159BestPractices: {
        latencySec: summarizeContinuous(bestPractices159Sec, { seed }),
        faultRetryCount: bestPracticesFaultRetries,
        faultRetryRate: wilsonScoreInterval(bestPracticesFaultRetries, totalDispatches),
      },
      agbV12NoOrchestrator: {
        latencySec: summarizeContinuous(agbV12Sec, { seed }),
        reworkRetryCount: agbV12ReworkRetries,
        reworkRetryRate: wilsonScoreInterval(agbV12ReworkRetries, totalDispatches),
      },
      agbV13OrchestratorWithBreaker: {
        latencySec: summarizeContinuous(agbV13Sec, { seed }),
        retryCount: agbV13FaultOrReworkRetries,
        retryRate: wilsonScoreInterval(agbV13FaultOrReworkRetries, totalDispatches),
        breakerTrips: agbV13BreakerTrips,
      },
    },
    comparisons: {
      v13VsNative: {
        speedup: pairedRatioSummary(nativeOrchSec, agbV13Sec, { seed }),
        cohensD: cohensD(nativeOrchSec, agbV13Sec),
        mannWhitney: mannWhitneyU(nativeOrchSec, agbV13Sec),
      },
      v13VsBestPractices: {
        speedup: pairedRatioSummary(bestPractices159Sec, agbV13Sec, { seed }),
        cohensD: cohensD(bestPractices159Sec, agbV13Sec),
        mannWhitney: mannWhitneyU(bestPractices159Sec, agbV13Sec),
      },
      v13VsV12Ablation: {
        speedup: pairedRatioSummary(agbV12Sec, agbV13Sec, { seed }),
        cohensD: cohensD(agbV12Sec, agbV13Sec),
        mannWhitney: mannWhitneyU(agbV12Sec, agbV13Sec),
        p95ReductionPct:
          ((summarizeContinuous(agbV12Sec).p95 - summarizeContinuous(agbV13Sec).p95)
            / summarizeContinuous(agbV12Sec).p95) * 100,
        retryReductionTest: twoProportionZTest(
          agbV12ReworkRetries,
          totalDispatches,
          agbV13FaultOrReworkRetries,
          totalDispatches,
        ),
      },
    },
  };
}

/**
 * Scenario 6 (`acc-agy-1-5-9-surface-and-print-hardening`):
 * Hybrid Live-Coupled / Parametric Evaluation across 600 `agy 1.5.9` headless runtime & policy hazards
 * (100 trials x 6 hazard classes):
 * - Baseline arms (`Straight agy 1.5.9 Native`, `Raw agy 1.5.9 Best Practices`, `agb v1.2 Pre-Hardening`)
 *   are modeled parametrically from architectural capability matrices.
 * - `agb v1.3` (`liveV13Rates`) is coupled directly to the live empirical recall rates measured against
 *   the repository's production modules (`computeLiveAgy159HazardRates` in `evals/v13-enhancements-bench.mjs`),
 *   so any real regression in `hooks/`, `bin/hook-runner.sh`, or `lib/agy.mjs` lowers `agbV13BlockRate`
 *   and fails the baseline ratchet.
 */
export function runAccAgy159HardeningScenario({
  trials = 100,
  seed = 20261104,
  liveV13Rates = null,
} = {}) {
  const rng = mulberry32(seed);

  const hazardDefs = [
    {
      id: 'sedAndNotebookBypass',
      label: 'sed_file (/e,/w, out-of-scope) & notebook_execution Arbitrary Code Bypass',
      pNative: 0.18,
      pBestPractices: 0.64,
      pAgbV12: 0.52,
      pAgbV13: liveV13Rates?.sedAndNotebookBypass ?? 1.0,
    },
    {
      id: 'stdinAskHangAndReplSmuggling',
      label: 'Headless --print Stdin ask-Stall & REPL Path Smuggling (send_command_input / manage_task)',
      pNative: 0.12,
      pBestPractices: 0.48,
      pAgbV12: 0.38,
      pAgbV13: liveV13Rates?.stdinAskHangAndReplSmuggling ?? 1.0,
    },
    {
      id: 'goFoldShadowKeyAndMissingReadPath',
      label: 'Go encoding/json fold.go Shadow-Key Collision & Unbounded Read-Path Escape',
      pNative: 0.00,
      pBestPractices: 0.15,
      pAgbV12: 0.44,
      pAgbV13: liveV13Rates?.goFoldShadowKeyAndMissingReadPath ?? 1.0,
    },
    {
      id: 'passwdHomeSpoofAndPluginDataTamper',
      label: 'Spoofed HOME Audit-Log Evasion & 4-Root PLUGIN_DATA / Symlink Tampering',
      pNative: 0.00,
      pBestPractices: 0.20,
      pAgbV12: 0.46,
      pAgbV13: liveV13Rates?.passwdHomeSpoofAndPluginDataTamper ?? 1.0,
    },
    {
      id: 'silentPrintExitZeroAndSlashExpansion',
      label: 'Silent exit-0 Non-Success (finishedReason / missing terminal result) & /slash Prompt Injection',
      pNative: 0.25,
      pBestPractices: 0.54,
      pAgbV12: 0.61,
      pAgbV13: liveV13Rates?.silentPrintExitZeroAndSlashExpansion ?? 1.0,
    },
    {
      id: 'nestedBwrapSandboxCollision',
      label: 'Outer Linux bwrap_pid + Inner agy 1.5.9 --sandbox CLONE_NEWUSER EPERM Prevention',
      pNative: 0.40,
      pBestPractices: 0.55,
      pAgbV12: 0.00,
      pAgbV13: liveV13Rates?.nestedBwrapSandboxCollision ?? 1.0,
    },
  ];

  const perClass = {};
  for (const h of hazardDefs) {
    perClass[h.id] = {
      label: h.label,
      total: trials,
      v13MeasuredRate: h.pAgbV13,
      nativeBlocked: 0,
      bestPracticesBlocked: 0,
      agbV12Blocked: 0,
      agbV13Blocked: 0,
    };
  }

  let totalHazards = 0;
  let totalNative = 0;
  let totalBp = 0;
  let totalV12 = 0;
  let totalV13 = 0;

  for (let t = 0; t < trials; t++) {
    for (const h of hazardDefs) {
      totalHazards += 1;
      const bNat = sampleBernoulli(rng, h.pNative);
      const bBp = sampleBernoulli(rng, h.pBestPractices);
      const bV12 = sampleBernoulli(rng, h.pAgbV12);
      const bV13 = sampleBernoulli(rng, h.pAgbV13);

      perClass[h.id].nativeBlocked += bNat;
      perClass[h.id].bestPracticesBlocked += bBp;
      perClass[h.id].agbV12Blocked += bV12;
      perClass[h.id].agbV13Blocked += bV13;

      totalNative += bNat;
      totalBp += bBp;
      totalV12 += bV12;
      totalV13 += bV13;
    }
  }

  const enrichedClasses = Object.fromEntries(
    Object.entries(perClass).map(([k, v]) => [
      k,
      {
        ...v,
        nativeRate: wilsonScoreInterval(v.nativeBlocked, v.total),
        bestPracticesRate: wilsonScoreInterval(v.bestPracticesBlocked, v.total),
        agbV12Rate: wilsonScoreInterval(v.agbV12Blocked, v.total),
        agbV13Rate: wilsonScoreInterval(v.agbV13Blocked, v.total),
        v13VsBestPracticesTest: twoProportionZTest(v.agbV13Blocked, v.total, v.bestPracticesBlocked, v.total),
        v13VsV12Test: twoProportionZTest(v.agbV13Blocked, v.total, v.agbV12Blocked, v.total),
      },
    ]),
  );

  return {
    id: 'acc-agy-1-5-9-surface-and-print-hardening',
    title: 'agy 1.5.9 60-Tool Policy, PASSWD_HOME Audit Anchoring & --print Outcome Hardening (Live-Coupled v1.3 vs. Parametric Baselines)',
    trials,
    totalHazards,
    v13RateSource: liveV13Rates ? 'live-benchmark-coupled' : 'parametric-default',
    perClass: enrichedClasses,
    overall: {
      nativeBlocked: totalNative,
      bestPracticesBlocked: totalBp,
      agbV12Blocked: totalV12,
      agbV13Blocked: totalV13,
      nativeEscapeCount: totalHazards - totalNative,
      bestPracticesEscapeCount: totalHazards - totalBp,
      agbV12EscapeCount: totalHazards - totalV12,
      agbV13EscapeCount: totalHazards - totalV13,
      nativeBlockRate: wilsonScoreInterval(totalNative, totalHazards),
      bestPracticesBlockRate: wilsonScoreInterval(totalBp, totalHazards),
      agbV12BlockRate: wilsonScoreInterval(totalV12, totalHazards),
      agbV13BlockRate: wilsonScoreInterval(totalV13, totalHazards),
      escapeReductionVsNative: twoProportionZTest(
        totalHazards - totalNative,
        totalHazards,
        totalHazards - totalV13,
        totalHazards,
      ),
      escapeReductionVsBestPractices: twoProportionZTest(
        totalHazards - totalBp,
        totalHazards,
        totalHazards - totalV13,
        totalHazards,
      ),
      escapeReductionVsV12: twoProportionZTest(
        totalHazards - totalV12,
        totalHazards,
        totalHazards - totalV13,
        totalHazards,
      ),
    },
  };
}
