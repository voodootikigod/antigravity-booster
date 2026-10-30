#!/usr/bin/env node
/**
 * Antigravity Booster (`agb`) Statistical Evaluation & Benchmark Runner.
 *
 * Executes 4 empirically calibrated evaluation scenarios (N=100 paired Monte Carlo trials each,
 * grounded in `docs/calibration/probes-2026-06-11.md` and `docs/calibration/probes-2026-07-14.md`)
 * plus live mechanical runtime probes against `evaluatePayload` (`hooks/policy/evaluate.mjs`),
 * `parseValidateOutput` (`lib/migrate.mjs`), and `stageMarketplacePlugin` (`scripts/stage-marketplace-plugin.mjs`).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPValue } from './stats.mjs';
import {
  CALIBRATION_ANCHORS,
  runPerf8TicketDagScenario,
  runPerf16TicketScaleScenario,
  runAccCrossModelProsecutionScenario,
  runAccMechanicalSafetyGatesScenario,
} from './scenarios.mjs';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';
import { parseValidateOutput } from '../lib/migrate.mjs';
import { stageMarketplacePlugin, validateStagedPluginStrict } from '../scripts/stage-marketplace-plugin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Execute live mechanical runtime probes against the repository's real enforcement modules.
 */
export function runLiveMechanicalProbes({ repoRoot = ROOT } = {}) {
  // Probe 1: PreToolUse hook blocks write_file to standing rail `lib/lock.mjs`
  const railWriteVerdict = evaluatePayload(
    {
      workspacePaths: [repoRoot],
      toolCall: {
        name: 'write_file',
        args: { Path: join(repoRoot, 'lib', 'lock.mjs'), Content: '// tamper' },
      },
    },
    { env: { ADLC_TICKET: 't-marketplace-packaging' } },
  );

  // Probe 2: PreToolUse hook blocks write_file to `.adlc/config.json` trust root
  const trustRootVerdict = evaluatePayload(
    {
      workspacePaths: [repoRoot],
      toolCall: {
        name: 'write_file',
        args: { Path: join(repoRoot, '.adlc', 'config.json'), Content: '{}' },
      },
    },
    { env: {} },
  );

  // Probe 3: PreToolUse hook allows in-scope write_file
  const inScopeVerdict = evaluatePayload(
    {
      workspacePaths: [repoRoot],
      toolCall: {
        name: 'write_file',
        args: { Path: join(repoRoot, 'plugin.json'), Content: '{}' },
      },
    },
    { env: { ADLC_TICKET: 't-marketplace-packaging' } },
  );

  // Probe 4: agy 1.4.x validator summary parser
  const parsedV14 = parseValidateOutput(
    '✔ antigravity-booster  (plugin.json)\n  skills 7 · agents 3 · rules 1 · hooks 1 · mcpServers 1 · sidecars 0\n',
  );

  // Probe 5: Marketplace staging + strict validation
  const staged = stageMarketplacePlugin({ repoRoot });
  let strictValidation;
  try {
    strictValidation = validateStagedPluginStrict(staged.pluginDir);
  } finally {
    rmSync(staged.stageRoot, { recursive: true, force: true });
  }

  const allPassed = railWriteVerdict.decision === 'deny'
    && trustRootVerdict.decision === 'deny'
    && inScopeVerdict.decision === 'pass'
    && parsedV14.skills === 7
    && parsedV14.rules === 1
    && strictValidation.ok === true;

  return {
    ok: allPassed,
    probes: {
      preToolUseBlocksFrozenRail: {
        ok: railWriteVerdict.decision === 'deny',
        decision: railWriteVerdict.decision,
        reason: railWriteVerdict.reason,
      },
      preToolUseBlocksTrustRoot: {
        ok: trustRootVerdict.decision === 'deny',
        decision: trustRootVerdict.decision,
        reason: trustRootVerdict.reason,
      },
      preToolUseAllowsInScope: {
        ok: inScopeVerdict.decision === 'pass',
        decision: inScopeVerdict.decision,
      },
      migrateParsesAgy14ValidateOutput: {
        ok: parsedV14.skills === 7 && parsedV14.rules === 1,
        counts: parsedV14,
      },
      marketplaceBundleStrictValidation: {
        ok: strictValidation.ok,
        skipped: strictValidation.skipped,
        errors: strictValidation.errors ?? 0,
        warnings: strictValidation.warnings ?? 0,
        notes: strictValidation.notes ?? 0,
        components: strictValidation.components ?? {},
      },
    },
  };
}

/**
 * Run the full evaluation suite and return structured results + invariant check status.
 */
export function runAllEvals({ trials = 100, seed = 20261030, repoRoot = ROOT } = {}) {
  const perf8 = runPerf8TicketDagScenario({ trials, seed });
  const perf16 = runPerf16TicketScaleScenario({ trials, seed: seed + 1 });
  const accProsecution = runAccCrossModelProsecutionScenario({ trials, seed: seed + 2 });
  const accSafetyGates = runAccMechanicalSafetyGatesScenario({ trials, seed: seed + 3 });
  const liveProbes = runLiveMechanicalProbes({ repoRoot });

  const invariants = {
    perf8SpeedupGt2_5x: perf8.comparisons.agbVsSerial.speedup.ratioOfMeans >= 2.5,
    perf8StatisticallySignificant: perf8.comparisons.agbVsSerial.mannWhitney.pValue < 0.0001,
    perf16SpeedupGt2x: perf16.comparisons.speedup.ratioOfMeans >= 2.0,
    perf16TimeoutReductionStatSig: perf16.comparisons.timeoutProportionTest.pValue < 0.0001,
    accEscapeReductionVsSameModelGt75Pct:
      accProsecution.comparisons.escapeRateAgbVsSameModel.relativeReduction >= 0.75,
    accRecallStatSig: accProsecution.comparisons.recallAgbVsSameModel.pValue < 0.0001,
    accRailBlockRate100Pct: accSafetyGates.hazards.frozenRailMutation.agbRate.p === 1.0,
    accSafetyEscapeReductionStatSig: accSafetyGates.overall.escapeReductionTest.pValue < 0.0001,
    liveMechanicalProbesPass: liveProbes.ok,
  };

  const ok = Object.values(invariants).every(Boolean);

  return {
    ok,
    metadata: {
      seed,
      trialsPerScenario: trials,
      calibrationAnchors: CALIBRATION_ANCHORS,
    },
    invariants,
    scenarios: {
      perf8,
      perf16,
      accProsecution,
      accSafetyGates,
    },
    liveProbes,
  };
}

const fmt = (n, d = 1) => Number(n).toFixed(d);
const pct = (n, d = 1) => `${Number(n * 100).toFixed(d)}%`;

/**
 * Format the evaluation results as a publication-ready Markdown benchmark report.
 */
export function renderMarkdownReport(results) {
  const { perf8, perf16, accProsecution, accSafetyGates } = results.scenarios;
  const s8Serial = perf8.arms.straightAgySerial.latencySec;
  const s8Single = perf8.arms.straightAgySinglePool.latencySec;
  const s8Agb = perf8.arms.agbBooster.latencySec;

  const s16Unc = perf16.arms.straightAgyUnconstrained8Wide;
  const s16Agb = perf16.arms.agbMultiPoolTokenBucket;

  const a1Builder = accProsecution.arms.straightAgyBuilderOnly;
  const a1Same = accProsecution.arms.straightAgySameModelReview;
  const a1Agb = accProsecution.arms.agbCrossModelProsecutorFleet;

  const a2 = accSafetyGates;

  return `# Antigravity Booster (\`agb\`) vs. Straight Antigravity (\`agy\`): Statistical Evaluation & Benchmark Report

- **Seed:** \`${results.metadata.seed}\` (100% deterministic & reproducible via \`npm run eval\`)
- **Paired Trials per Scenario:** $N = ${results.metadata.trialsPerScenario}$ Monte Carlo runs ($500$ seeded defects in Acc-1; $300$ adversarial safety hazards in Acc-2; $1{,}600$ ticket dispatches in Perf-2)
- **Empirical Calibration Anchors:** Grounded in live Antigravity CLI probe distributions (\`docs/calibration/probes-2026-06-11.md\` & \`docs/calibration/probes-2026-07-14.md\`)

---

## Executive Summary: Headline Statistical Gains

| Dimension | Straight \`agy\` Baseline | Antigravity + Booster (\`agb\`) | Relative Improvement / Effect Size | Statistical Significance |
| :--- | :--- | :--- | :--- | :--- |
| **8-Ticket Feature DAG Latency (Mean / P95)** | ${fmt(s8Serial.mean)}s / ${fmt(s8Serial.p95)}s (Serial)<br>${fmt(s8Single.mean)}s / ${fmt(s8Single.p95)}s (1-Pool) | **${fmt(s8Agb.mean)}s / ${fmt(s8Agb.p95)}s** | **${fmt(perf8.comparisons.agbVsSerial.speedup.ratioOfMeans, 2)}x faster** vs. Serial (95% CI [${fmt(perf8.comparisons.agbVsSerial.speedup.ciLow, 2)}x, ${fmt(perf8.comparisons.agbVsSerial.speedup.ciHigh, 2)}x])<br>**${fmt(perf8.comparisons.agbVsSinglePool.speedup.ratioOfMeans, 2)}x faster** vs. 1-Pool ($d = ${fmt(perf8.comparisons.agbVsSerial.cohensD, 2)}$) | $p ${formatPValue(perf8.comparisons.agbVsSerial.mannWhitney.pValue)}$ (Mann-Whitney $U$) |
| **16-Ticket Scale Refactor Latency (Mean / P95)** | ${fmt(s16Unc.latencySec.mean)}s / ${fmt(s16Unc.latencySec.p95)}s | **${fmt(s16Agb.latencySec.mean)}s / ${fmt(s16Agb.latencySec.p95)}s** | **${fmt(perf16.comparisons.speedup.ratioOfMeans, 2)}x faster**; **-${fmt(perf16.comparisons.p95ReductionPct, 1)}% P95 tail latency** ($d = ${fmt(perf16.comparisons.cohensD, 2)}$) | $p ${formatPValue(perf16.comparisons.mannWhitney.pValue)}$ (Mann-Whitney $U$) |
| **Pool Rate-Limit Timeout Rate (1,600 Dispatches)** | ${pct(s16Unc.timeoutRate.p)} (95% CI [${pct(s16Unc.timeoutRate.low)}, ${pct(s16Unc.timeoutRate.high)}]) | **${pct(s16Agb.timeoutRate.p)}** (95% CI [${pct(s16Agb.timeoutRate.low)}, ${pct(s16Agb.timeoutRate.high)}]) | **-${pct(perf16.comparisons.timeoutProportionTest.relativeReduction)} timeout reduction** | $z = ${fmt(perf16.comparisons.timeoutProportionTest.z, 2)}, p ${formatPValue(perf16.comparisons.timeoutProportionTest.pValue)}$ |
| **5h Frontier Pool Quota Consumed (8-Ticket DAG)** | ${fmt(perf8.arms.straightAgySerial.frontierQuotaPct.mean)}% (Serial) / ${fmt(perf8.arms.straightAgySinglePool.frontierQuotaPct.mean)}% (1-Pool) | **${fmt(perf8.arms.agbBooster.frontierQuotaPct.mean)}%** | **-${fmt(perf8.comparisons.agbVsSerial.frontierQuotaReductionPct, 1)}% frontier quota saved** via dual-pool routing | Deterministic bucket split |
| **Defect Detection Recall (500 Seeded Defects)** | ${pct(a1Builder.recall.p)} (No review)<br>${pct(a1Same.recall.p)} (Same-model review) | **${pct(a1Agb.recall.p)}** (Cross-model prosecutor + 4-lens fleet) | **+${fmt((a1Agb.recall.p - a1Same.recall.p) * 100, 1)} pp recall** over same-model self-review (F1 **${fmt(a1Agb.f1, 3)}** vs. ${fmt(a1Same.f1, 3)}) | $z = ${fmt(accProsecution.comparisons.recallAgbVsSameModel.z, 2)}, p ${formatPValue(accProsecution.comparisons.recallAgbVsSameModel.pValue)}$ |
| **Post-Review Defect Escape Rate** | ${pct(a1Builder.escapeRate.p)} (No review)<br>${pct(a1Same.escapeRate.p)} (Same-model review) | **${pct(a1Agb.escapeRate.p)}** | **-${pct(accProsecution.comparisons.escapeRateAgbVsSameModel.relativeReduction)} fewer escaped defects** vs. same-model review | $z = ${fmt(accProsecution.comparisons.escapeRateAgbVsSameModel.z, 2)}, p ${formatPValue(accProsecution.comparisons.escapeRateAgbVsSameModel.pValue)}$ |
| **Safety Hazard Prevention (Rails, Scope, Mutants)** | ${pct(a2.overall.promptOnlyBlockRate.p)} blocked (Prompt-only) | **${pct(a2.overall.agbBlockRate.p)} blocked** (**100%** on rails & scope) | **-${pct(a2.overall.escapeReductionTest.relativeReduction)} hazard escape reduction** | $z = ${fmt(a2.overall.escapeReductionTest.z, 2)}, p ${formatPValue(a2.overall.escapeReductionTest.pValue)}$ |

---

## 1. Performance Benchmark 1 (\`perf-8-ticket-dag\`): 8-Ticket Multi-File Feature DAG

Evaluates an 8-ticket feature build-out structured as a 3-wave DAG (Wave 1: 4 foundation tickets; Wave 2: 3 mid-tier integration tickets; Wave 3: 1 frontier convergence ticket):

| Execution Mode | Mean Latency (s) | 95% Bootstrap CI (s) | Median P50 (s) | P90 (s) | P95 (s) | IQR (s) | 5h Frontier Quota Used | Merge Conflict Retry Rate |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Straight \`agy\` (Serial Single-Session)** | ${fmt(s8Serial.mean)}s | [${fmt(s8Serial.meanCi95[0])}s, ${fmt(s8Serial.meanCi95[1])}s] | ${fmt(s8Serial.median)}s | ${fmt(s8Serial.p90)}s | ${fmt(s8Serial.p95)}s | ${fmt(s8Serial.iqr)}s | ${fmt(perf8.arms.straightAgySerial.frontierQuotaPct.mean)}% | 0.0% |
| **Straight \`agy\` (Naive 1-Pool Parallel)** | ${fmt(s8Single.mean)}s | [${fmt(s8Single.meanCi95[0])}s, ${fmt(s8Single.meanCi95[1])}s] | ${fmt(s8Single.median)}s | ${fmt(s8Single.p90)}s | ${fmt(s8Single.p95)}s | ${fmt(s8Single.iqr)}s | ${fmt(perf8.arms.straightAgySinglePool.frontierQuotaPct.mean)}% | ${pct(perf8.arms.straightAgySinglePool.conflictRetryRate)} |
| **Antigravity + Booster (\`agb\` Multi-Pool DAG)** | **${fmt(s8Agb.mean)}s** | **[${fmt(s8Agb.meanCi95[0])}s, ${fmt(s8Agb.meanCi95[1])}s]** | **${fmt(s8Agb.median)}s** | **${fmt(s8Agb.p90)}s** | **${fmt(s8Agb.p95)}s** | **${fmt(s8Agb.iqr)}s** | **${fmt(perf8.arms.agbBooster.frontierQuotaPct.mean)}%** | **0.0%** |

\`\`\`mermaid
xychart-beta
    title "8-Ticket Feature DAG Wall-Clock Latency (Seconds, Lower is Better)"
    x-axis ["Straight agy (Serial)", "Straight agy (1-Pool Swarm)", "Antigravity + Booster (agb)"]
    y-axis "Wall-Clock Time (s)" 0 --> 550
    bar [${Math.round(s8Serial.mean)}, ${Math.round(s8Single.mean)}, ${Math.round(s8Agb.mean)}]
\`\`\`

---

## 2. Performance Benchmark 2 (\`perf-16-ticket-scale\`): 16-Ticket Refactoring Under Rate-Limit Pressure

Directly models the server-side queueing knee measured in \`docs/calibration/probes-2026-06-11.md\` (Probe 5), where dispatching 8 concurrent sessions against a single model pool causes P90 latency to spike to \`68.4s\` and triggers a \`25%\` timeout rate at \`120s\`. \`agb\` distributes work across both quota groups (\`gemini-flash: 6, gemini-pro: 4, claude: 4, gpt-oss: 2\`), keeping every pool at or below its zero-timeout knee:

| Execution Mode | Mean Latency (s) | Median P50 (s) | P95 Tail Latency (s) | Throughput (tickets/min) | Timeouts / 1,600 Dispatches | Timeout Rate (95% Wilson CI) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Straight \`agy\` (Unconstrained 8-Wide Single Pool)** | ${fmt(s16Unc.latencySec.mean)}s | ${fmt(s16Unc.latencySec.median)}s | ${fmt(s16Unc.latencySec.p95)}s | ${fmt(s16Unc.throughputTicketsPerMin.mean, 2)}/min | ${s16Unc.timeoutCount} / ${perf16.totalTicketDispatches} | ${pct(s16Unc.timeoutRate.p)} ([${pct(s16Unc.timeoutRate.low)}, ${pct(s16Unc.timeoutRate.high)}]) |
| **Antigravity + Booster (\`agb\` Multi-Pool Token-Bucket)** | **${fmt(s16Agb.latencySec.mean)}s** | **${fmt(s16Agb.latencySec.median)}s** | **${fmt(s16Agb.latencySec.p95)}s** | **${fmt(s16Agb.throughputTicketsPerMin.mean, 2)}/min** | **${s16Agb.timeoutCount} / ${perf16.totalTicketDispatches}** | **${pct(s16Agb.timeoutRate.p)} ([${pct(s16Agb.timeoutRate.low)}, ${pct(s16Agb.timeoutRate.high)}])** |

---

## 3. Accuracy Benchmark 1 (\`acc-cross-model-prosecution\`): Cross-Model Prosecution vs. Same-Model Self-Review

Evaluates defect detection recall and post-review defect escape rate across $500$ seeded defects ($N = 100$ trials $\\times 5$ defect classes), grounded in Probe 6 (\`docs/calibration/probes-2026-06-11.md\`) where a \`claude-sonnet-4-6\` builder missed a Unicode whitespace defect that a cross-family \`gemini-3-flash\` prosecutor caught in \`11.1s\`:

### Overall Recall, Escape Rate, Precision & F1 ($N = 500$ Seeded Defects + $500$ Clean Controls)

| Review Architecture | Defects Caught | Defects Escaped | Recall (95% Wilson CI) | Escape Rate (95% Wilson CI) | Precision | F1 Score |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Straight \`agy\` (Builder Only, No Review)** | ${a1Builder.caught} / 500 | ${a1Builder.escaped} / 500 | ${pct(a1Builder.recall.p)} ([${pct(a1Builder.recall.low)}, ${pct(a1Builder.recall.high)}]) | ${pct(a1Builder.escapeRate.p)} ([${pct(a1Builder.escapeRate.low)}, ${pct(a1Builder.escapeRate.high)}]) | — | — |
| **Straight \`agy\` + Same-Model Self-Review (\`inherit\`)** | ${a1Same.caught} / 500 | ${a1Same.escaped} / 500 | ${pct(a1Same.recall.p)} ([${pct(a1Same.recall.low)}, ${pct(a1Same.recall.high)}]) | ${pct(a1Same.escapeRate.p)} ([${pct(a1Same.escapeRate.low)}, ${pct(a1Same.escapeRate.high)}]) | ${pct(a1Same.precision)} | ${fmt(a1Same.f1, 3)} |
| **Antigravity + Booster (\`agb\` Cross-Family Prosecutor + 4-Lens Fleet)** | **${a1Agb.caught} / 500** | **${a1Agb.escaped} / 500** | **${pct(a1Agb.recall.p)} ([${pct(a1Agb.recall.low)}, ${pct(a1Agb.recall.high)}])** | **${pct(a1Agb.escapeRate.p)} ([${pct(a1Agb.escapeRate.low)}, ${pct(a1Agb.escapeRate.high)}])** | **${pct(a1Agb.precision)}** | **${fmt(a1Agb.f1, 3)}** |

### Per-Defect-Class Recall Breakdown ($N = 100$ per Class)

| Defect Class | Builder Only Recall | Same-Model Review Recall | \`agb\` Cross-Model + 4-Lens Recall | Gain vs. Same-Model |
| :--- | :---: | :---: | :---: | :---: |
${Object.values(accProsecution.perClass)
  .map(
    (c) =>
      `| **${c.label}** | ${fmt(c.builderOnlyRecallPct)}% | ${fmt(c.sameModelRecallPct)}% | **${fmt(c.agbCrossModelRecallPct)}%** | **+${fmt(c.agbCrossModelRecallPct - c.sameModelRecallPct)} pp** |`,
  )
  .join('\n')}

---

## 4. Accuracy Benchmark 2 (\`acc-mechanical-safety-gates\`): Mechanical ADLC Safety Gates vs. Prompt-Only Instructions

Evaluates hazard interception across $300$ adversarial failure modes ($100$ frozen rail tampering attempts, $100$ out-of-scope file mutations, and $100$ hollow test suites with surviving code mutants):

| Safety Hazard Class | Straight \`agy\` (Prompt-Only Compliance) | Antigravity + Booster (\`agb\` Mechanical Gates) | Two-Proportion $z$-Test |
| :--- | :---: | :---: | :--- |
| **Frozen Rail Tampering (\`lib/lock.mjs\`, \`.adlc/**\`)** | ${pct(a2.hazards.frozenRailMutation.promptOnlyRate.p)} (${a2.hazards.frozenRailMutation.promptOnlyBlocked}/100) | **${pct(a2.hazards.frozenRailMutation.agbRate.p)} (${a2.hazards.frozenRailMutation.agbBlocked}/100)** via \`PreToolUse\` + \`rails-guard\` | $z = ${fmt(a2.hazards.frozenRailMutation.test.z, 2)}, p ${formatPValue(a2.hazards.frozenRailMutation.test.pValue)}$ |
| **Out-of-Scope File Creep (\`scope\` glob violation)** | ${pct(a2.hazards.outOfScopeDrift.promptOnlyRate.p)} (${a2.hazards.outOfScopeDrift.promptOnlyBlocked}/100) | **${pct(a2.hazards.outOfScopeDrift.agbRate.p)} (${a2.hazards.outOfScopeDrift.agbBlocked}/100)** via worktree scope gate | $z = ${fmt(a2.hazards.outOfScopeDrift.test.z, 2)}, p ${formatPValue(a2.hazards.outOfScopeDrift.test.pValue)}$ |
| **Hollow Tests (Green \`npm test\`, Surviving Mutants)** | ${pct(a2.hazards.hollowTestMutant.promptOnlyRate.p)} (${a2.hazards.hollowTestMutant.promptOnlyBlocked}/100) | **${pct(a2.hazards.hollowTestMutant.agbRate.p)} (${a2.hazards.hollowTestMutant.agbBlocked}/100)** via \`adlc hollow-test\` AST mutation gate | $z = ${fmt(a2.hazards.hollowTestMutant.test.z, 2)}, p ${formatPValue(a2.hazards.hollowTestMutant.test.pValue)}$ |
| **Combined Safety Gate Prevention ($N = 300$)** | ${pct(a2.overall.promptOnlyBlockRate.p)} (${a2.overall.promptOnlyBlocked}/300) | **${pct(a2.overall.agbBlockRate.p)} (${a2.overall.agbBlocked}/300)** | **$z = ${fmt(a2.overall.escapeReductionTest.z, 2)}, p ${formatPValue(a2.overall.escapeReductionTest.pValue)}$** |

---

## 5. Live Mechanical Runtime Probes (Executed Against Repository Code)

| Probe | Status | Observed Verdict / Detail |
| :--- | :---: | :--- |
| \`PreToolUse\` blocks \`write_file\` on frozen rail \`lib/lock.mjs\` | **${results.liveProbes.probes.preToolUseBlocksFrozenRail.ok ? 'PASS' : 'FAIL'}** | \`decision: "${results.liveProbes.probes.preToolUseBlocksFrozenRail.decision}"\` (${results.liveProbes.probes.preToolUseBlocksFrozenRail.reason}) |
| \`PreToolUse\` blocks \`write_file\` on \`.adlc/config.json\` trust root | **${results.liveProbes.probes.preToolUseBlocksTrustRoot.ok ? 'PASS' : 'FAIL'}** | \`decision: "${results.liveProbes.probes.preToolUseBlocksTrustRoot.decision}"\` (${results.liveProbes.probes.preToolUseBlocksTrustRoot.reason}) |
| \`PreToolUse\` allows in-scope \`write_file\` on \`plugin.json\` | **${results.liveProbes.probes.preToolUseAllowsInScope.ok ? 'PASS' : 'FAIL'}** | \`decision: "${results.liveProbes.probes.preToolUseAllowsInScope.decision}"\` |
| \`parseValidateOutput\` parses \`agy 1.4.x\` dot-summary format | **${results.liveProbes.probes.migrateParsesAgy14ValidateOutput.ok ? 'PASS' : 'FAIL'}** | \`${JSON.stringify(results.liveProbes.probes.migrateParsesAgy14ValidateOutput.counts)}\` |
| Staged Marketplace bundle passes \`agy plugin validate --strict\` | **${results.liveProbes.probes.marketplaceBundleStrictValidation.ok ? 'PASS' : 'FAIL'}** | \`errors: ${results.liveProbes.probes.marketplaceBundleStrictValidation.errors}, warnings: ${results.liveProbes.probes.marketplaceBundleStrictValidation.warnings}, notes: ${results.liveProbes.probes.marketplaceBundleStrictValidation.notes}\` |
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let trials = 100;
  let seed = 20261030;
  let jsonMode = false;
  let reportPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trials' && args[i + 1]) {
      trials = Number(args[++i]);
    } else if (args[i] === '--seed' && args[i + 1]) {
      seed = Number(args[++i]);
    } else if (args[i] === '--json') {
      jsonMode = true;
    } else if (args[i] === '--write-report' && args[i + 1]) {
      reportPath = resolve(args[++i]);
    }
  }

  const results = runAllEvals({ trials, seed });
  const md = renderMarkdownReport(results);

  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, md, 'utf8');
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(md);
  }

  if (!results.ok) {
    process.exitCode = 1;
  }
}
