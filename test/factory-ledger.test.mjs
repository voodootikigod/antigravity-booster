import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryLedger,
  computeRunEconomics,
  defaultFactoryLedgerPath,
} from '../lib/factory-ledger.mjs';

test('FactoryLedger atomically records bounded run summaries under lock, computes aggregates, and rejects symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-factory-ledger-'));
  try {
    const ledgerFile = join(dir, 'ledger', 'factory_ledger.jsonl');
    const ledger = new FactoryLedger({ ledgerFile, maxEntries: 10 });

    const emptySummary = ledger.summarizeEconomics();
    assert.equal(emptySummary.runs, 0);
    assert.equal(emptySummary.avgStrike0YieldPct, 0);
    assert.equal(emptySummary.avgCacheHitPct, 0);

    for (let i = 1; i <= 12; i++) {
      const res = ledger.appendRunSummary({
        runId: `run-${i}`,
        repo: '/tmp/sample-repo',
        totalTickets: 4,
        mergedCount: 4,
        failedCount: 0,
        strike0MergedCount: i % 2 === 0 ? 4 : 3,
        autofixAppliedCount: 1,
        uncachedInputTokens: 20_000,
        cachedTokens: 80_000,
        outputTokens: 5_000,
        requestsByPool: { gemini: 4, claude: 4 },
        durationMs: 12_500,
      });
      assert.equal(res.ok, true);
    }

    const runs = ledger.readRuns();
    assert.equal(runs.length, 10, 'ledger must bound history to maxEntries');
    assert.equal(runs[0].runId, 'run-3');
    assert.equal(runs[9].runId, 'run-12');
    assert.equal(runs[9].cacheHitPct, 80);
    // billable = 20000 + 0.1*80000 + 3*5000 = 43000
    assert.equal(runs[9].billableTokens, 43_000);

    const summary = ledger.summarizeEconomics({ recentLimit: 3 });
    assert.equal(summary.runs, 10);
    assert.equal(summary.recentRuns.length, 3);
    assert.equal(summary.avgStrike0YieldPct, 87.5);
    assert.equal(summary.avgCacheHitPct, 80);
    assert.equal(summary.totalAutofixSaves, 10);
    assert.equal(summary.totalBillableTokens, 430_000);

    // Rejects symlinked ledger file
    const victim = join(dir, 'victim.jsonl');
    writeFileSync(victim, '');
    const symPath = join(dir, 'sym-ledger.jsonl');
    symlinkSync(victim, symPath);
    const symLedger = new FactoryLedger({ ledgerFile: symPath });
    assert.throws(() => symLedger.readRuns(), /symbolic link not allowed/i);
    assert.throws(() => symLedger.appendRunSummary({ runId: 'evil' }), /symbolic link not allowed/i);

    // Rejects symlinked parent directory
    const realSub = join(dir, 'real-sub');
    mkdirSync(realSub, { recursive: true });
    const symDir = join(dir, 'sym-dir');
    symlinkSync(realSub, symDir, 'dir');
    const symDirLedger = new FactoryLedger({ ledgerFile: join(symDir, 'factory_ledger.jsonl') });
    assert.throws(() => symDirLedger.appendRunSummary({ runId: 'evil2' }), /symbolic link not allowed/i);

    // computeRunEconomics handles zero-ticket / zero-token inputs cleanly
    const zero = computeRunEconomics({ runId: 'r0' });
    assert.equal(zero.strike0YieldPct, 0);
    assert.equal(zero.cacheHitPct, 0);
    assert.equal(zero.billableTokens, 0);

    // defaultFactoryLedgerPath honors NODE_TEST_CONTEXT repo isolation when env vars unset
    const savedOverride = process.env.AGB_FACTORY_LEDGER_FILE;
    const savedHome = process.env.AGB_HOME_DIR;
    try {
      delete process.env.AGB_FACTORY_LEDGER_FILE;
      delete process.env.AGB_HOME_DIR;
      assert.equal(
        defaultFactoryLedgerPath({ repo: dir }),
        join(dir, '.booster', 'factory_ledger.jsonl')
      );
    } finally {
      if (savedOverride !== undefined) process.env.AGB_FACTORY_LEDGER_FILE = savedOverride;
      if (savedHome !== undefined) process.env.AGB_HOME_DIR = savedHome;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeRunEconomics and FactoryLedger track split build/prosecution/review tokens, system1Calls, hollowShortCircuits, and review-only entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-factory-ledger-split-'));
  try {
    const ledgerFile = join(dir, 'factory_ledger.jsonl');
    const ledger = new FactoryLedger({ ledgerFile });

    // 1. Explicit split fields without raw token breakdown fall back cleanly to sum for billableTokens
    const splitOnly = computeRunEconomics({
      runId: 'run-split-1',
      repo: '/tmp/sample-repo',
      totalTickets: 2,
      mergedCount: 2,
      strike0MergedCount: 1,
      buildTokens: 1200,
      prosecutionTokens: 450,
      reviewTokens: 150,
      system1Calls: 3,
      hollowShortCircuits: 1,
      skippedLenses: ['simplicity', 'anti_slop', 'simplicity'],
    });
    assert.equal(splitOnly.kind, 'run');
    assert.equal(splitOnly.buildTokens, 1200);
    assert.equal(splitOnly.prosecutionTokens, 450);
    assert.equal(splitOnly.reviewTokens, 150);
    assert.equal(splitOnly.billableTokens, 1800);
    assert.equal(splitOnly.system1Calls, 3);
    assert.equal(splitOnly.hollowShortCircuits, 1);
    assert.deepEqual(splitOnly.skippedLenses, ['simplicity', 'anti_slop']);

    // 2. Append a fleet run entry with raw + split telemetry
    const fleetRes = ledger.appendRunSummary({
      runId: 'run-fleet-1',
      repo: '/tmp/sample-repo',
      totalTickets: 2,
      mergedCount: 2,
      failedCount: 0,
      strike0MergedCount: 2,
      autofixAppliedCount: 1,
      uncachedInputTokens: 700,
      cachedTokens: 800,
      outputTokens: 200,
      buildTokens: 560,
      prosecutionTokens: 820,
      reviewTokens: 0,
      system1Calls: 1,
      hollowShortCircuits: 1,
      requestsByPool: { 'gemini-flash': 2, 'gpt-oss': 1 },
      durationMs: 4000,
    });
    assert.equal(fleetRes.ok, true);
    assert.equal(fleetRes.entry.kind, 'run');
    assert.equal(fleetRes.entry.billableTokens, 1380);
    assert.equal(fleetRes.entry.buildTokens, 560);
    assert.equal(fleetRes.entry.prosecutionTokens, 820);
    assert.equal(fleetRes.entry.reviewTokens, 0);

    // 3. Append a review-only entry matching reviewFleet's recordReviewTelemetryToLedger() shape
    const reviewRes = ledger.appendRunSummary({
      runId: 'agb-review-999',
      repo: '/tmp/sample-repo',
      uncachedInputTokens: 1200,
      cachedTokens: 800,
      outputTokens: 200,
      system1Calls: 2,
      skippedLenses: ['simplicity'],
      requestsByPool: { 'gemini-flash': 2 },
      durationMs: 900,
    });
    assert.equal(reviewRes.ok, true);
    assert.equal(reviewRes.entry.kind, 'review');
    assert.equal(reviewRes.entry.billableTokens, 1880);
    assert.equal(reviewRes.entry.reviewTokens, 1880);
    assert.equal(reviewRes.entry.buildTokens, 0);
    assert.equal(reviewRes.entry.prosecutionTokens, 0);
    assert.equal(reviewRes.entry.system1Calls, 2);
    assert.deepEqual(reviewRes.entry.skippedLenses, ['simplicity']);

    // 4. Summarize across both fleet and review-only entries without diluting Strike-0 yield
    const summary = ledger.summarizeEconomics();
    assert.equal(summary.runs, 2);
    assert.equal(summary.totalTickets, 2);
    assert.equal(summary.avgStrike0YieldPct, 100);
    assert.equal(summary.totalBuildTokens, 560);
    assert.equal(summary.totalProsecutionTokens, 820);
    assert.equal(summary.totalReviewTokens, 1880);
    assert.equal(summary.totalBillableTokens, 3260);
    assert.equal(summary.totalSystem1Calls, 3);
    assert.equal(summary.totalHollowShortCircuits, 1);
    assert.equal(summary.totalSkippedLenses, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
