import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BanditModelRouter, computeBillableTokenCostFactor, defaultStatsFilePath } from '../lib/bandit-router.mjs';
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
  assert.equal(isSafeRegexPattern('(a)\\1'), false, 'backreference must be rejected');
  assert.equal(isSafeRegexPattern('(?<=a)b'), false, 'lookbehind must be rejected');
  assert.equal(isSafeRegexPattern('.*foo.*'), false, 'adjacent unbounded wildcards must be rejected');

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

    // Test requireLiteral pass/fail and .booster/runs/ discovery + corrupt JSON fail-closed
    writeFileSync(
      join(dir, '.adlc', 'learned-checks.json'),
      JSON.stringify({
        version: 1,
        checks: [{ id: 'DEF-req-header', glob: 'src/**', requireLiteral: '// COPYRIGHT' }],
      }) + '\n'
    );
    assert.equal(runLearnedChecks(dir, { changedFiles: ['src/clean.mjs'] }).ok, false);
    writeFileSync(join(dir, 'src', 'clean.mjs'), '// COPYRIGHT\nexport const x = 1;\n');
    assert.equal(runLearnedChecks(dir, { changedFiles: ['src/clean.mjs'] }).ok, true);

    writeFileSync(join(dir, '.adlc', 'learned-checks.json'), '{not-valid-json');
    const corruptRes = runLearnedChecks(dir, { changedFiles: ['src/clean.mjs'] });
    assert.equal(corruptRes.ok, false);
    assert.match(corruptRes.error, /Malformed JSON/);

    mkdirSync(join(dir, '.booster', 'runs'), { recursive: true });
    writeFileSync(
      join(dir, '.booster', 'runs', 'run-1-prosecution-t1.json'),
      JSON.stringify({ findings: [{ lens: 'sec', claim: 'eval( used in lib at line 1' }, { lens: 'sec', claim: 'eval( used in lib at line 9' }] })
    );
    rmSync(join(dir, '.adlc', 'learned-checks.json'), { force: true });
    writeFileSync(join(dir, '.adlc', 'learned-checks.json'), '{"version":1,"checks":[]}\n');
    const nestedDistill = distillRunDefenses({ repo: dir, compileChecks: true });
    assert.equal(nestedDistill.compiledChecksCount, 1);

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

    // Nested alternation ((a|a))+ and lookahead (?=a) and repeated quantified classes \w+\w+ and \k<name> rejected (SEC-W4-06, SEC-W4-R2-04)
    assert.equal(isSafeRegexPattern('((a|a))+'), false);
    assert.equal(isSafeRegexPattern('(?=foo)bar'), false);
    assert.equal(isSafeRegexPattern('\\w+\\w+'), false);
    assert.equal(isSafeRegexPattern('[a-z]+[a-z]+'), false);
    assert.equal(isSafeRegexPattern('(?<a>foo)\\k<a>'), false);

    // .review/round-1/triaged.json non-dropped findings discovered (MEDIUM-1)
    mkdirSync(join(dir, '.review', 'main', 'round-1'), { recursive: true });
    writeFileSync(
      join(dir, '.review', 'main', 'round-1', 'triaged.json'),
      JSON.stringify({
        triaged: [
          { action: 'fix', lens: 'security', claim: 'process.exit( used in library module at line 4' },
          { action: 'fix', lens: 'security', claim: 'process.exit( used in library module at line 19' },
          { action: 'drop', lens: 'security', claim: 'dropped finding should be ignored' },
        ],
      })
    );
    rmSync(join(dir, '.adlc', 'learned-checks.json'), { force: true });
    writeFileSync(join(dir, '.adlc', 'learned-checks.json'), '{"version":1,"checks":[]}\n');
    const reviewDistill = distillRunDefenses({ repo: dir, compileChecks: true });
    assert.equal(reviewDistill.recurringCount >= 2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BanditModelRouter ignores AGB_HOME_DIR/AGB_MODEL_STATS_FILE when bundled and rejects symlinked statsFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bandit-sec-'));
  const prevHome = process.env.AGB_HOME_DIR;
  const prevStats = process.env.AGB_MODEL_STATS_FILE;
  try {
    const evilHome = join(dir, 'evil-home');
    const evilStats = join(dir, 'evil-stats.jsonl');
    process.env.AGB_HOME_DIR = evilHome;
    process.env.AGB_MODEL_STATS_FILE = evilStats;

    assert.equal(defaultStatsFilePath(undefined, { bundled: false }), evilStats);
    const bundledPath = defaultStatsFilePath(undefined, { bundled: true });
    assert.notEqual(bundledPath, evilStats);
    assert.ok(!bundledPath.startsWith(evilHome));
    const bundledRouter = new BanditModelRouter({ bundled: true });
    assert.equal(bundledRouter.statsFile, bundledPath);

    // Symlinked parent directory is rejected on recordOutcome and readRecords
    const realParent = join(dir, 'real-parent');
    mkdirSync(realParent, { recursive: true });
    const symParent = join(dir, 'sym-parent');
    symlinkSync(realParent, symParent, 'dir');
    const symParentRouter = new BanditModelRouter({ statsFile: join(symParent, 'model_stats.jsonl') });
    assert.deepEqual(symParentRouter.readRecords(), []);
    assert.equal(symParentRouter.recordOutcome({ model: 'gemini-4-neon-high' }).ok, false);

    const victim = join(dir, 'victim.jsonl');
    writeFileSync(victim, '{"model":"orig"}\n');
    const symStats = join(dir, 'sym-stats.jsonl');
    symlinkSync(victim, symStats);
    const router = new BanditModelRouter({ statsFile: symStats });
    assert.deepEqual(router.readRecords(), []);
    const res = router.recordOutcome({ model: 'gemini-4-neon-high' });
    assert.equal(res.ok, false);
    assert.equal(readFileSync(victim, 'utf8'), '{"model":"orig"}\n');
  } finally {
    if (prevHome === undefined) delete process.env.AGB_HOME_DIR; else process.env.AGB_HOME_DIR = prevHome;
    if (prevStats === undefined) delete process.env.AGB_MODEL_STATS_FILE; else process.env.AGB_MODEL_STATS_FILE = prevStats;
    rmSync(dir, { recursive: true, force: true });
  }
});
