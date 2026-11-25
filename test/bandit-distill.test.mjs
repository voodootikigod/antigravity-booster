import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BanditModelRouter, computeBillableTokenCostFactor } from '../lib/bandit-router.mjs';
import {
  distillRunDefenses,
  isSafeRegexPattern,
  validateLearnedChecksSpec,
  runLearnedChecks,
} from '../lib/distill.mjs';

test('BanditModelRouter records empirical outcomes under lock and ranks candidates deterministically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bandit-'));
  const statsFile = join(dir, 'model_stats.jsonl');
  const router = new BanditModelRouter({ statsFile, maxEntries: 50 });

  try {
    const candidates = ['gemini-4-argon-high', 'gemini-4-carbon-high', 'gemini-4-neon-high'];

    // With no history, order is preserved
    assert.deepEqual(router.rankCandidates(candidates, { staticMode: false }), candidates);

    // Record repeated failures for gemini-4-argon-high and repeated 1-shot successes for gemini-4-neon-high
    for (let i = 0; i < 6; i++) {
      router.recordOutcome({
        model: 'gemini-4-argon-high',
        role: 'builder',
        tier: 'frontier',
        strike0Pass: false,
        hollowTestKilled: false,
        prosecutorPrecision: 0.2,
      });
      router.recordOutcome({
        model: 'gemini-4-neon-high',
        role: 'builder',
        tier: 'frontier',
        strike0Pass: true,
        hollowTestKilled: true,
        prosecutorPrecision: 1.0,
      });
    }

    assert.equal(router.readRecords().length, 12);

    const ranked1 = router.rankCandidates(candidates, {
      role: 'builder',
      tier: 'frontier',
      seed: 'seed-123',
      staticMode: false,
    });
    const ranked2 = router.rankCandidates(candidates, {
      role: 'builder',
      tier: 'frontier',
      seed: 'seed-123',
      staticMode: false,
    });
    assert.deepEqual(ranked1, ranked2, 'same seed must produce identical order');
    assert.equal(ranked1[0], 'gemini-4-neon-high', 'empirically strongest model promoted to lead');
    assert.equal(ranked1[ranked1.length - 1], 'gemini-4-argon-high');

    // staticMode (AGB_ROUTER_STATIC=1) preserves original order
    assert.deepEqual(
      router.rankCandidates(candidates, {
        role: 'builder',
        tier: 'frontier',
        staticMode: true,
      }),
      candidates
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('distillRunDefenses clusters recurring findings, stages proposal, and compacts rule under maxRuleBytes on --apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-distill-'));
  try {
    const findings = [
      {
        lens: 'security',
        severity: 'high',
        claim: 'Unquoted path argument at line 42 in commit a1b2c3d4 allows traversal',
      },
      {
        lens: 'security',
        severity: 'high',
        claim: 'Unquoted path argument at line 108 in commit f0e1d2c3 allows traversal',
      },
      {
        lens: 'correctness',
        severity: 'medium',
        claim: 'Single occurrence finding that should not be distilled',
      },
    ];

    // 1. Staged-only (apply: false)
    const staged = distillRunDefenses({
      repo: dir,
      apply: false,
      extraFindings: findings,
    });
    assert.equal(staged.ok, true);
    assert.equal(staged.recurringCount, 1);
    assert.equal(staged.applied, false);
    assert.ok(staged.stagedPath && existsSync(staged.stagedPath));
    assert.match(readFileSync(staged.stagedPath, 'utf8'), /Unquoted path argument/);
    assert.equal(existsSync(join(dir, '.gemini', 'rules', 'adlc-learned.md')), false);

    // 2. Apply mode with strict byte budget compaction
    const applied = distillRunDefenses({
      repo: dir,
      apply: true,
      maxRuleBytes: 500,
      extraFindings: findings,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.applied, true);
    assert.ok(applied.appliedPath && existsSync(applied.appliedPath));
    assert.ok(applied.ruleBytes <= 500);
    assert.match(readFileSync(applied.appliedPath, 'utf8'), /Learned ADLC Repository Defenses/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BanditModelRouter bounds billable-token costFactor in [0.74, 1.0] across Claude/Gemini cache envelopes and promotes frugal equal-pass models', () => {
  assert.equal(computeBillableTokenCostFactor({}), 1.0);
  const claudeCacheFactor = computeBillableTokenCostFactor({
    uncachedInputTokens: 2000,
    cachedTokens: 100_000,
    outputTokens: 1000,
  });
  assert.ok(claudeCacheFactor < 1.0 && claudeCacheFactor > 0.9);

  const extremeFactor = computeBillableTokenCostFactor({
    uncachedInputTokens: 5_000_000,
    cachedTokens: 5_000_000,
    outputTokens: 1_000_000,
  });
  assert.ok(extremeFactor >= 0.74 && extremeFactor <= 0.742);

  const dir = mkdtempSync(join(tmpdir(), 'agb-bandit-cost-'));
  const router = new BanditModelRouter({ statsFile: join(dir, 'stats.jsonl') });
  try {
    const candidates = ['gemini-4-argon-high', 'gemini-4-neon-high'];
    for (let i = 0; i < 6; i++) {
      router.recordOutcome({
        model: 'gemini-4-argon-high',
        role: 'builder',
        tier: 'frontier',
        strike0Pass: true,
        hollowTestKilled: true,
        prosecutorPrecision: 1.0,
        uncachedInputTokens: 300_000,
        cachedTokens: 0,
        outputTokens: 40_000,
      });
      router.recordOutcome({
        model: 'gemini-4-neon-high',
        role: 'builder',
        tier: 'frontier',
        strike0Pass: true,
        hollowTestKilled: true,
        prosecutorPrecision: 1.0,
        uncachedInputTokens: 5_000,
        cachedTokens: 80_000,
        outputTokens: 2_000,
        quotaDeltaPct: 1.8,
      });
    }
    const ranked = router.rankCandidates(candidates, { role: 'builder', tier: 'frontier', staticMode: false });
    assert.equal(ranked[0], 'gemini-4-neon-high', 'frugal high-cache model outranks token-heavy peer at equal pass rate');
    const saved = router.readRecords();
    assert.equal(saved[saved.length - 1].pool, 'gemini');
    assert.equal(saved[saved.length - 1].quotaDeltaPct, 1.8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('distillRunDefenses --compile-checks emits ReDoS-safe .adlc/learned-checks.json, rejects symlinks, and runLearnedChecks evaluates changedFiles', () => {
  assert.equal(isSafeRegexPattern('decision\\s*:\\s*[\'"]allow[\'"]'), true);
  assert.equal(isSafeRegexPattern('(a+)+'), false, 'nested quantifier ReDoS must be rejected');
  assert.equal(isSafeRegexPattern('([a-z]*)*'), false, 'nested star quantifier ReDoS must be rejected');
  assert.equal(isSafeRegexPattern('(foo|bar)+'), false, 'quantified alternation group must be rejected');

  assert.ok(
    validateLearnedChecksSpec({
      version: 1,
      checks: [{ id: 'DEF-bad', glob: 'lib/**', forbidRegex: '(a+)+' }],
    }).length > 0
  );

  const dir = mkdtempSync(join(tmpdir(), 'agb-learned-checks-'));
  try {
    // Missing learned-checks.json degrades cleanly
    const emptyRes = runLearnedChecks(dir);
    assert.equal(emptyRes.ok, true);
    assert.equal(emptyRes.exists, false);

    const findings = [
      {
        lens: 'security',
        severity: 'high',
        claim: 'Hook emitted decision: "allow" on line 14',
      },
      {
        lens: 'security',
        severity: 'high',
        claim: 'Hook emitted decision: "allow" on line 52',
      },
      {
        lens: 'correctness',
        severity: 'high',
        claim: 'Unsafe console.debug left in src module at line 9',
        check: {
          glob: 'src/**',
          forbidLiteral: 'console.debug(',
          description: 'Remove debug logging before merge',
        },
      },
      {
        lens: 'correctness',
        severity: 'high',
        claim: 'Unsafe console.debug left in src module at line 33',
      },
    ];

    const compiled = distillRunDefenses({
      repo: dir,
      compileChecks: true,
      extraFindings: findings,
    });
    assert.equal(compiled.ok, true);
    assert.equal(compiled.compiledChecks, true);
    assert.equal(compiled.compiledChecksCount, 2);
    assert.ok(existsSync(join(dir, '.adlc', 'learned-checks.json')));

    mkdirSync(join(dir, 'hooks'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'bad.mjs'), 'export const out = { decision: "allow" };\n');
    writeFileSync(join(dir, 'src', 'clean.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'src', 'noisy.mjs'), 'console.debug("oops");\n');

    const cleanOnly = runLearnedChecks(dir, { changedFiles: ['src/clean.mjs'] });
    assert.equal(cleanOnly.ok, true);
    assert.equal(cleanOnly.violations.length, 0);

    const fullRun = runLearnedChecks(dir, { changedFiles: ['hooks/bad.mjs', 'src/noisy.mjs'] });
    assert.equal(fullRun.ok, false);
    assert.equal(fullRun.violations.length, 2);
    assert.equal(fullRun.violations[0].line, 1);

    // Symlinked learned-checks.json fails closed
    const outside = mkdtempSync(join(tmpdir(), 'agb-outside-'));
    const realJson = join(outside, 'evil.json');
    writeFileSync(realJson, '{"version":1,"checks":[]}\n');
    rmSync(join(dir, '.adlc', 'learned-checks.json'));
    symlinkSync(realJson, join(dir, '.adlc', 'learned-checks.json'));
    const symRun = runLearnedChecks(dir);
    assert.equal(symRun.ok, false);
    assert.match(symRun.error, /symlink/i);
    assert.throws(
      () => distillRunDefenses({ repo: dir, compileChecks: true, extraFindings: findings }),
      (err) => err.code === 'ESYMLINK'
    );
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
