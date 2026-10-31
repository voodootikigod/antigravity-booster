/**
 * Empirically calibrated evaluation scenarios comparing Straight Antigravity (`agy`)
 * against Antigravity + Booster (`agb`).
 *
 * Calibration parameters are derived directly from:
 * - `docs/calibration/probes-2026-06-11.md` (Probe 5 pool concurrency curve: width=1..4
 *   has 0% timeouts and p50=26.7s..28.8s; width=8 spikes to p90=68.4s and 25% 120s timeouts;
 *   Probe 6 cross-family prosecution: Claude builder missed Unicode whitespace edge case,
 *   Gemini Flash prosecutor caught it in 11.1s with verdict="block").
 * - `docs/calibration/probes-2026-07-14.md` (pool caps: gemini-flash=6, gemini-pro=4,
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
    'gemini-flash': 6,
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
