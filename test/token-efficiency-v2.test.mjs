import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTokenEfficiencyBenchmark } from '../evals/subsystem-bench.mjs';

test('v2 token-efficiency A/B benchmark: monotonic request and billable-token reductions with 100% defect and hollow-test recall', async () => {
  const result = await runTokenEfficiencyBenchmark();
  const { legacyV200, tier0Core, tier1CodeGraph, tier2DecisionEngine } = result.configurations;

  assert.equal(result.ok, true, `benchmark failed: ${JSON.stringify(result.summary)}`);

  // 1. 100% recall on planted blocking defects and hollow-test survivors across all 4 tiers
  for (const cfg of [legacyV200, tier0Core, tier1CodeGraph, tier2DecisionEngine]) {
    assert.equal(cfg.recall.hollowTestSurvivorCaught, true, `${cfg.config} must catch hollow-test survivor`);
    assert.equal(cfg.recall.plantedDefectProsecutionCaught, true, `${cfg.config} must catch planted prosecution defect`);
    assert.equal(cfg.recall.plantedDefectReviewCaught, true, `${cfg.config} must catch planted review defect`);
    assert.equal(cfg.recall.allCaught, true, `${cfg.config} must achieve 100% recall`);
  }

  // 2. Tier 0 Zero-Dependency Core invariants (>= 50% review request reduction, 0 duplicate coldstart, hollow-test short-circuit, deterministic arbiter)
  assert.equal(legacyV200.coldstartRequests, 3);
  assert.equal(tier0Core.coldstartRequests, 0, 'Tier 0 provenance cache must eliminate duplicate coldstart calls');
  assert.equal(legacyV200.hollowShortCircuited, false);
  assert.equal(tier0Core.hollowShortCircuited, true, 'Tier 0 must short-circuit hollow-test survivors before LLM spawn');
  assert.equal(legacyV200.defectArbiterMode, 'llm');
  assert.equal(tier0Core.defectArbiterMode, 'deterministic', 'Tier 0 must use deterministic Arbiter fast-path for <= 4 disjoint findings');
  assert.ok(
    result.summary.tier0ReviewRequestReduction >= 0.5,
    `Expected >= 50% review request reduction in Tier 0, got ${(result.summary.tier0ReviewRequestReduction * 100).toFixed(1)}%`,
  );

  // 3. Tier 1 CodeGraph invariants (semantic low blast-radius vs static-ast elevated blast-radius, strictly fewer billable tokens than Tier 0)
  assert.notEqual(tier0Core.leafBlastRadius, 'low', 'static-ast fallback should classify noisy textual matches above low blast radius');
  assert.equal(tier1CodeGraph.leafBlastRadius, 'low', 'CodeGraph semantic index should classify zero-caller leaf edit as low blast radius');
  assert.equal(tier1CodeGraph.defectBlastRadius, 'high', 'security-sensitive path must remain high blast radius even with CodeGraph');
  assert.ok(
    tier1CodeGraph.billableTokens < tier0Core.billableTokens,
    `Expected Tier 1 (${tier1CodeGraph.billableTokens}) < Tier 0 (${tier0Core.billableTokens}) billable tokens`,
  );

  // 4. Tier 2 System-1 DecisionEngine invariants (fast-ship leaf, fail-closed defect, lens gating, typed arbiter, strictly fewer requests & tokens)
  assert.equal(tier2DecisionEngine.leafFastShipped, true, 'Tier 2 should fast-ship clean low-risk leaf ticket');
  assert.equal(tier2DecisionEngine.defectArbiterMode, 'system1', 'Tier 2 should triage findings via System-1 typed Arbiter');
  assert.ok(tier2DecisionEngine.skippedLensesClean.length >= 2, 'Tier 2 lens gating should skip irrelevant lenses on clean leaf diff');
  assert.ok(tier2DecisionEngine.system1Calls > 0, 'Tier 2 should record System-1 calls');
  assert.ok(
    tier2DecisionEngine.system2Requests < tier1CodeGraph.system2Requests,
    `Expected Tier 2 (${tier2DecisionEngine.system2Requests}) < Tier 1 (${tier1CodeGraph.system2Requests}) System-2 requests`,
  );
  assert.ok(
    tier2DecisionEngine.billableTokens < tier1CodeGraph.billableTokens,
    `Expected Tier 2 (${tier2DecisionEngine.billableTokens}) < Tier 1 (${tier1CodeGraph.billableTokens}) billable tokens`,
  );

  // 5. Monotonic reduction assertions across all four configurations
  assert.equal(result.summary.monotonicRequests, true);
  assert.equal(result.summary.monotonicTokens, true);
});
