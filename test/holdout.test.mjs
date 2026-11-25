import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  shouldRunHoldoutScenarios,
  selectOppositeHoldoutPool,
  resolveHoldoutDir,
  buildHoldoutAuthorPrompt,
  extractHoldoutCodeBlock,
  stageHoldoutScenarios,
  listHoldoutScenarios,
  cleanHoldoutScenarios,
  sanitizeHoldoutFailureOutput,
  verifyHoldoutRedPhase,
  runHoldoutScenarios,
} from '../lib/holdout.mjs';

test('shouldRunHoldoutScenarios defaults to true on frontier tickets and respects opt-in / opt-out flags', () => {
  assert.equal(shouldRunHoldoutScenarios({ id: 'T1', tier: 'frontier' }, {}), true);
  assert.equal(shouldRunHoldoutScenarios({ id: 'T2', tier: 'mid' }, {}), false);
  assert.equal(shouldRunHoldoutScenarios({ id: 'T3', tier: 'cheap' }, {}), false);
  assert.equal(shouldRunHoldoutScenarios({ id: 'T4', tier: 'mid', holdout_scenarios: true }, {}), true);
  assert.equal(
    shouldRunHoldoutScenarios({ id: 'T5', tier: 'mid', holdout_scenarios: [{ name: 's1', code: 'x' }] }, {}),
    true
  );
  assert.equal(shouldRunHoldoutScenarios({ id: 'T6', tier: 'frontier', holdout_scenarios: false }, {}), false);
  assert.equal(shouldRunHoldoutScenarios({ id: 'T7', tier: 'frontier' }, { holdouts: false }), false);
  assert.equal(selectOppositeHoldoutPool('gemini', ''), 'claude-gpt');
  assert.equal(selectOppositeHoldoutPool('claude-gpt', ''), 'gemini');
  assert.equal(selectOppositeHoldoutPool('auto', 'gemini-4-argon-high'), 'claude-gpt');
});

test('stageHoldoutScenarios, listHoldoutScenarios, and cleanHoldoutScenarios validate syntax, reject symlinks, and ignore overrides when bundled', () => {
  const root = mkdtempSync(join(tmpdir(), 'agb-holdout-store-'));
  const repo = mkdtempSync(join(tmpdir(), 'agb-holdout-repo-'));
  try {
    // Bundled mode ignores AGB_HOLDOUT_DIR override
    const bundledDir = resolveHoldoutDir({
      repo,
      runId: 'run-1',
      ticketId: 'T-1',
      env: { AGB_HOLDOUT_DIR: root },
      bundled: true,
    });
    assert.ok(!bundledDir.startsWith(root), 'bundled mode must ignore AGB_HOLDOUT_DIR');

    // Invalid syntax rejected cleanly
    const badSyntax = stageHoldoutScenarios({
      repo,
      runId: 'run-1',
      ticketId: 'T-1',
      scenarios: ['import { test } from "node:test"; function broken( {'],
      holdoutRoot: root,
    });
    assert.equal(badSyntax.ok, false);
    assert.match(badSyntax.error, /syntax check failed/i);

    // Relative parent '../' imports rejected cleanly
    const relImport = stageHoldoutScenarios({
      repo,
      runId: 'run-1',
      ticketId: 'T-1',
      scenarios: ['import { foo } from "../src/foo.mjs";'],
      holdoutRoot: root,
    });
    assert.equal(relImport.ok, false);
    assert.match(relImport.error, /AGB_CANDIDATE_ROOT/);

    // Valid scenario staged, listed (metadata only, no source leakage), and cleaned
    const validCode = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("Scenario: addition handles negative integers", () => { assert.equal(1 + -2, -1); });',
    ].join('\n');
    const staged = stageHoldoutScenarios({
      repo,
      runId: 'run-1',
      ticketId: 'T-1',
      scenarios: [{ name: 'negative-math', code: validCode }],
      holdoutRoot: root,
    });
    assert.equal(staged.ok, true);
    assert.equal(staged.files.length, 1);

    const listed = listHoldoutScenarios({ repo, holdoutRoot: root });
    assert.equal(listed.ok, true);
    assert.equal(listed.totalFiles, 1);
    assert.equal(listed.suites[0].ticketId, 't-1');
    assert.equal(JSON.stringify(listed).includes('assert.equal'), false, 'list must never leak holdout source');

    // Symlink attack inside holdout root is rejected with ESYMLINK
    const evilLink = join(root, 'symlinked');
    symlinkSync(repo, evilLink);
    assert.throws(
      () => resolveHoldoutDir({ repo, runId: 'run-1', ticketId: 'T-1', holdoutRoot: evilLink }),
      (err) => err.code === 'ESYMLINK'
    );

    const cleaned = cleanHoldoutScenarios({ repo, runId: 'run-1', ticketId: 'T-1', holdoutRoot: root });
    assert.equal(cleaned.ok, true);
    assert.equal(cleaned.removed, true);
    assert.equal(listHoldoutScenarios({ repo, holdoutRoot: root }).totalFiles, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('sanitizeHoldoutFailureOutput strips holdout paths, line numbers, stack frames, and expected/actual secret literals', () => {
  const rawTap = [
    'TAP version 13',
    '# Subtest: Scenario: rejects expired bearer tokens with 401',
    'not ok 1 - Scenario: rejects expired bearer tokens with 401',
    '  ---',
    '  duration_ms: 3.41',
    '  location: \'/home/user/.gemini/antigravity-cli/plugin_data/antigravity-booster/holdouts/ab12/run-9/t-1/01-auth.holdout.test.mjs:18:3\'',
    '  failureType: \'testCodeFailure\'',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    + actual - expected',
    '    + 200',
    '    - 401',
    '    secret_magic_literal_998877',
    '  stack: |-',
    '    TestContext.<anonymous> (file:///home/user/.gemini/holdouts/01-auth.holdout.test.mjs:24:12)',
    '  ...',
    'ok 2 - Scenario: accepts valid fresh tokens',
    '1..2',
  ].join('\n');

  const sanitized = sanitizeHoldoutFailureOutput(rawTap);
  assert.equal(sanitized.failedCount, 1);
  assert.equal(sanitized.passedCount, 1);
  assert.equal(sanitized.behavioralSymptoms.length, 1);
  assert.match(sanitized.behavioralSymptoms[0], /Scenario: rejects expired bearer tokens with 401/);
  assert.equal(sanitized.summary.includes('.holdout.test.mjs'), false);
  assert.equal(sanitized.summary.includes('secret_magic_literal_998877'), false);
  assert.equal(sanitized.summary.includes(':24:12'), false);
  assert.equal(sanitized.summary.includes('+ 200'), false);

  // Allowlist defense against candidate-printed fake TAP lines attempting to exfiltrate holdout source
  const injectedTap = [
    'not ok 1 - Scenario: EXFILTRATED_SECRET_SOURCE_999',
    'not ok 2 - Scenario: rejects expired bearer tokens with 401',
  ].join('\n');
  const allowlisted = sanitizeHoldoutFailureOutput(injectedTap, {
    allowedTitles: new Set(['Scenario: rejects expired bearer tokens with 401']),
  });
  assert.equal(allowlisted.summary.includes('EXFILTRATED_SECRET_SOURCE_999'), false);
  assert.match(allowlisted.summary, /Holdout scenario #1/);
  assert.match(allowlisted.summary, /Scenario: rejects expired bearer tokens with 401/);
});

test('verifyHoldoutRedPhase and runHoldoutScenarios enforce anti-tautology, run against AGB_CANDIDATE_ROOT, and clean candidate scratch writes', async () => {
  const holdoutRoot = mkdtempSync(join(tmpdir(), 'agb-holdout-exec-'));
  const baseWt = mkdtempSync(join(tmpdir(), 'agb-holdout-base-'));
  const rootRepo = mkdtempSync(join(tmpdir(), 'agb-holdout-root-'));
  const candParent = mkdtempSync(join(tmpdir(), 'agb-holdout-cand-'));
  const candWt = join(candParent, 'wt');
  try {
    // Initialize rootRepo and create an isolated linked git worktree `candWt` (where `.git` is a file pointer)
    execFileSync('git', ['init', '-q'], { cwd: rootRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: rootRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: rootRepo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: rootRepo });
    mkdirSync(join(rootRepo, 'src'), { recursive: true });
    writeFileSync(
      join(rootRepo, 'src', 'calc.mjs'),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'try { writeFileSync(join(process.cwd(), "smuggled-leak.txt"), "leaked"); } catch {}',
        'export function clampPositive(n) { return Math.max(0, Number(n)); }',
      ].join('\n') + '\n'
    );
    execFileSync('git', ['add', '.'], { cwd: rootRepo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: rootRepo });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'cand-branch', candWt], { cwd: rootRepo });

    mkdirSync(join(baseWt, 'src'), { recursive: true });
    writeFileSync(join(baseWt, 'src', 'calc.mjs'), 'export function clampPositive(n) { return n; }\n');

    const prompt = buildHoldoutAuthorPrompt({
      id: 'T-CALC',
      title: 'Clamp positive numbers',
      scope: ['src/calc.mjs'],
      body: 'clampPositive(-5) must return 0.',
    });
    assert.match(prompt, /AGB_CANDIDATE_ROOT/);

    const extracted = extractHoldoutCodeBlock([
      '```javascript',
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { join } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'test("Scenario: negative inputs clamp to zero", async () => {',
      '  const mod = await import(pathToFileURL(join(process.env.AGB_CANDIDATE_ROOT, "src/calc.mjs")).href);',
      '  assert.equal(mod.clampPositive(-42), 0);',
      '  assert.equal(mod.clampPositive(7), 7);',
      '});',
      '```',
    ].join('\n'));
    assert.ok(extracted.includes('AGB_CANDIDATE_ROOT'));

    const staged = stageHoldoutScenarios({
      repo: candWt,
      runId: 'run-red',
      ticketId: 'T-CALC',
      scenarios: [extracted],
      holdoutRoot,
    });
    assert.equal(staged.ok, true);

    const envUnsandboxedInContainer = { ...process.env, AGB_SANDBOX_GATES: '0' };

    // 1. Red phase against unimplemented baseWt MUST pass (because holdout fails on baseWt)
    const red = await verifyHoldoutRedPhase(staged.files, {
      baseWorktree: baseWt,
      sandbox: false,
      env: envUnsandboxedInContainer,
    });
    assert.equal(red.ok, true);

    // 2. Tautological check: running verifyHoldoutRedPhase against already-passing candWt fails red-phase
    const tautology = await verifyHoldoutRedPhase(staged.files, {
      baseWorktree: candWt,
      sandbox: false,
      env: envUnsandboxedInContainer,
    });
    assert.equal(tautology.ok, false);
    assert.match(tautology.reason, /tautological/i);

    // 3. Green phase against linked worktree candWt (cleanScratch: true) passes AND cleans smuggled-leak.txt!
    const green = await runHoldoutScenarios(staged.files, {
      candidateWorktree: candWt,
      sandbox: false,
      cleanScratch: true,
      env: envUnsandboxedInContainer,
    });
    assert.equal(green.ok, true);
    assert.equal(green.passedCount, 1);
    assert.equal(existsSync(join(candWt, 'smuggled-leak.txt')), false, 'scratch writes during P5 holdout must be wiped');

    // 3b. Root repository safety (CR-W4-01): even if cleanScratch: true is passed on a root git repo (.git dir),
    // uncommitted operator files are NEVER wiped!
    writeFileSync(join(rootRepo, 'operator-wip.txt'), 'keep-me\n');
    const rootRun = await runHoldoutScenarios(staged.files, {
      candidateWorktree: rootRepo,
      sandbox: false,
      cleanScratch: true,
      env: envUnsandboxedInContainer,
    });
    assert.equal(rootRun.ok, true);
    assert.equal(existsSync(join(rootRepo, 'operator-wip.txt')), true, 'root repo uncommitted files must never be wiped');

    // 4. Fail-closed sandbox refusal when sandbox=true, AGB_SANDBOX_GATES is unset, and OS sandbox is unavailable
    if (process.platform === 'linux') {
      const refused = await runHoldoutScenarios(staged.files, {
        candidateWorktree: candWt,
        sandbox: true,
        env: { PATH: '/nonexistent' },
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.sandboxRefused, true);
    }

    // 5. Timeout anti-tautology guard in verifyHoldoutRedPhase
    const hangStaged = stageHoldoutScenarios({
      repo: candWt,
      runId: 'run-hang',
      ticketId: 'T-HANG',
      scenarios: ['import { test } from "node:test"; test("Scenario: hangs", async () => { await new Promise(() => {}); });'],
      holdoutRoot,
    });
    assert.equal(hangStaged.ok, true);
    const hangRed = await verifyHoldoutRedPhase(hangStaged.files, {
      baseWorktree: baseWt,
      timeoutMs: 80,
      sandbox: false,
      env: envUnsandboxedInContainer,
    });
    assert.equal(hangRed.ok, false);
    assert.match(hangRed.reason, /timed out/i);

    // 6. Post-execution SHA-256 tamper detection when an unsandboxed script mutates its own holdout file
    const selfMutateStaged = stageHoldoutScenarios({
      repo: candWt,
      runId: 'run-tamper',
      ticketId: 'T-TAMPER',
      scenarios: [
        [
          'import { test } from "node:test";',
          'import { chmodSync, writeFileSync } from "node:fs";',
          'import { fileURLToPath } from "node:url";',
          'test("Scenario: mutates holdout file", () => {',
          '  const me = fileURLToPath(import.meta.url);',
          '  chmodSync(me, 0o600);',
          '  writeFileSync(me, "// tampered\\n");',
          '});',
        ].join('\n'),
      ],
      holdoutRoot,
    });
    assert.equal(selfMutateStaged.ok, true);
    const tamperRes = await runHoldoutScenarios(selfMutateStaged.files, {
      candidateWorktree: candWt,
      sandbox: false,
      env: envUnsandboxedInContainer,
    });
    assert.equal(tamperRes.ok, false);
    assert.equal(tamperRes.tampered, true);

    // 7. Pass-spoofing via process.exit(0) and node:assert monkey-patching fail closed (SEC-W4-03)
    const exitSpoofStaged = stageHoldoutScenarios({
      repo: candWt,
      runId: 'run-spoof',
      ticketId: 'T-SPOOF',
      scenarios: [
        [
          'import { test } from "node:test";',
          'test("Scenario: candidate calls process.exit(0)", () => {',
          '  process.exit(0);',
          '});',
        ].join('\n'),
      ],
      holdoutRoot,
    });
    assert.equal(exitSpoofStaged.ok, true);
    const spoofRes = await runHoldoutScenarios(exitSpoofStaged.files, {
      candidateWorktree: candWt,
      sandbox: false,
      env: envUnsandboxedInContainer,
    });
    assert.equal(spoofRes.ok, false, 'process.exit(0) mid-scenario must fail closed');

    const assertPatchStaged = stageHoldoutScenarios({
      repo: candWt,
      runId: 'run-assert-freeze',
      ticketId: 'T-FREEZE',
      scenarios: [
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'test("Scenario: candidate attempts to monkey-patch assert.equal", () => {',
          '  assert.equal = () => {};',
          '  assert.equal(1, 2);',
          '});',
        ].join('\n'),
      ],
      holdoutRoot,
    });
    assert.equal(assertPatchStaged.ok, true);
    const patchRes = await runHoldoutScenarios(assertPatchStaged.files, {
      candidateWorktree: candWt,
      sandbox: false,
      env: envUnsandboxedInContainer,
    });
    assert.equal(patchRes.ok, false, 'frozen node:assert must reject monkey-patching');
  } finally {
    rmSync(holdoutRoot, { recursive: true, force: true });
    rmSync(baseWt, { recursive: true, force: true });
    rmSync(candParent, { recursive: true, force: true });
    rmSync(rootRepo, { recursive: true, force: true });
  }
});
