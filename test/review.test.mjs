import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reviewFleet,
  reviewDiff,
  loadPriorFindings,
  savePriorFindings,
} from '../lib/review.mjs';
import { FactoryLedger } from '../lib/factory-ledger.mjs';

// Keep offline unit tests isolated from host GEMINI_API_KEY auto-detection;
// tests that explicitly pass a mock decisionEngine still exercise System-1 paths.
process.env.AGB_DECISION_ENGINE = '0';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

test('reviewDiff: rejects ref values starting with a dash to prevent git flag injection', () => {
  assert.throws(() => reviewDiff(process.cwd(), '--output=/tmp/pwn'), /Invalid git ref/);
  assert.throws(() => reviewDiff(process.cwd(), '-p'), /Invalid git ref/);
});

test('reviewFleet: passes project option to runAgy', async () => {
  const state = mkdtempSync(join(tmpdir(), 'agb-review-test-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevState = process.env.FAKE_STATE_DIR;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_STATE_DIR = state;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  try {
    await reviewFleet({
      diff: 'diff --git a/x b/x\n+code',
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      project: 'test-review-proj',
    });
    const argvSeen = readFileSync(join(state, 'agy-argv-seen'), 'utf8');
    const matches = argvSeen.match(/--project/g) || [];
    assert.equal(matches.length, 1, 'reviewFleet should invoke agy with the project flag exactly once');
    assert.match(argvSeen, /--project test-review-proj/);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
    rmSync(state, { recursive: true, force: true });
  }
});

test('reviewFleet: captures quota admission errors per lens without crashing or throwing', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  const pools = {
    quota: { raw: {}, models: {} },
    refreshQuota: async () => ({ ok: true }),
    acquire: async (model, opts) => {
      if (model.includes('argon')) {
        throw new Error('pro quota exhausted');
      }
      return () => {};
    },
  };
  try {
    const res = await reviewFleet({
      diff: 'diff --git a/x b/x\n+code',
      lenses: ['correctness', 'performance'],
      dryRounds: 1,
      maxRounds: 1,
      pools,
    });
    assert.equal(res.converged, false);
    assert.ok(res.errors.length > 0, 'errors must capture failed lens');
    assert.ok(res.errors.some((e) => e.error.includes('pro quota exhausted')), 'must record quota error');
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
  }
});

test('reviewFleet: handles >128 KiB diffs via stdin piping without E2BIG and converges cleanly', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  try {
    const hugeDiff = 'diff --git a/big.mjs b/big.mjs\n+' + 'a'.repeat(145_000);
    const res = await reviewFleet({
      diff: hugeDiff,
      lenses: ['correctness', 'security'],
      dryRounds: 1,
      maxRounds: 2,
    });
    assert.equal(res.converged, true, JSON.stringify(res.errors));
    assert.deepEqual(res.errors, []);

    const execErrRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      context: Symbol('unstringifiable-context'),
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
    });
    assert.equal(execErrRes.converged, false);
    assert.equal(execErrRes.errors.length, 1);
    assert.match(execErrRes.errors[0].error, /^execution failed:/);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
  }
});

test('reviewFleet: fails over across PROSECUTOR_CANDIDATES on quota_depleted unless models are pinned', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  try {
    // Cross-pool failover when default Gemini pool throws kind='quota_depleted'
    const seenModels = [];
    const depletedGeminiPools = {
      quota: { raw: {}, models: {} },
      refreshQuota: async () => ({ ok: true }),
      acquire: async (m) => {
        if (m.startsWith('gemini-')) {
          const err = new Error('gemini pool depleted');
          err.kind = 'quota_depleted';
          throw err;
        }
        seenModels.push(m);
        return () => {};
      },
    };
    const failoverRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: depletedGeminiPools,
    });
    assert.equal(failoverRes.converged, true);
    assert.deepEqual(seenModels, ['gpt-oss-120b-medium']);

    // Passing models: [] also uses default alternates and triggers quota_depleted fallback
    seenModels.length = 0;
    const emptyModelsRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      models: [],
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: depletedGeminiPools,
    });
    assert.equal(emptyModelsRes.converged, true);
    assert.deepEqual(seenModels, ['gpt-oss-120b-medium']);

    // When first fallback (gpt-oss) is ALSO depleted, advances to second fallback (claude)
    const secondFallbackModels = [];
    const secondFallbackPools = {
      quota: { raw: {}, models: {} },
      refreshQuota: async () => ({ ok: true }),
      acquire: async (m) => {
        if (m.startsWith('gemini-') || m.startsWith('gpt-oss-')) {
          const err = new Error(`${m} pool depleted`);
          err.kind = 'quota_depleted';
          throw err;
        }
        secondFallbackModels.push(m);
        return () => {};
      },
    };
    const secondRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: secondFallbackPools,
    });
    assert.equal(secondRes.converged, true);
    assert.deepEqual(secondFallbackModels, ['claude-sonnet-5-5-medium']);

    // Explicit caller `models` must NOT silently swap to another model on quota_depleted
    const pinnedRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      models: ['gemini-4-argon-high'],
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: depletedGeminiPools,
    });
    assert.equal(pinnedRes.converged, false);
    assert.match(pinnedRes.errors[0].error, /quota admission failed: gemini pool depleted/);

    // When all fallback pools are ALSO depleted, reports quota admission failed
    const allDepletedPools = {
      quota: { raw: {}, models: {} },
      refreshQuota: async () => ({ ok: true }),
      acquire: async () => {
        const err = new Error('all pools depleted');
        err.kind = 'quota_depleted';
        throw err;
      },
    };
    const allDepRes = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+1',
      lenses: ['correctness'],
      dryRounds: 1,
      maxRounds: 1,
      pools: allDepletedPools,
    });
    assert.equal(allDepRes.converged, false);
    assert.match(allDepRes.errors[0].error, /quota admission failed: all pools depleted/);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
  }
});

test('reviewFleet: defaults to single-pass (dryRounds=1, maxRounds=1), converges on low/dropped Round-1 findings, and supports thorough/multi-dry', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agb-review-single-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  try {
    // 1. Default single pass with low finding (arbiter: false) -> converged: true, SHIP
    process.env.AGB_AGY_BIN = FAKE_AGY;
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship-with-low';
    const lowNoArbiter = await reviewFleet({
      diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n+export const a = 1;\n',
    });
    assert.equal(lowNoArbiter.rounds, 1);
    assert.equal(lowNoArbiter.requests, 4);
    assert.equal(lowNoArbiter.converged, true);
    assert.equal(lowNoArbiter.gateVerdict, 'SHIP');

    // 2. Default single pass with low finding dropped by LLM Arbiter -> converged: true, SHIP
    const dropArbiterAgy = join(tmpDir, 'fake-agy-drop-low.cjs');
    writeFileSync(
      dropArbiterAgy,
      `#!/usr/bin/env node
let buf = ''; process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  const printIdx = process.argv.indexOf('--print');
  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;
  if (prompt.includes('Neutral Arbiter')) {
    console.log(JSON.stringify({
      status: 'ok',
      structured_output: {
        gate_verdict: 'SHIP',
        summary: 'dropped nit',
        triaged: [{ id: 'F-001', severity: 'low', file: 'lib/leaf.mjs', claim: 'minor style nit', verdict: 'drop', resolution_route: 'auto-fix' }]
      }
    }));
  } else {
    console.log(JSON.stringify({
      status: 'ok',
      structured_output: {
        findings: [{ severity: 'low', file: 'lib/leaf.mjs', claim: 'minor style nit', evidence: 'line 1' }]
      }
    }));
  }
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = dropArbiterAgy;
    const lowWithArbiter = await reviewFleet({
      diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n+export const a = 1;\n',
      lenses: ['correctness'],
      arbiter: true,
    });
    assert.equal(lowWithArbiter.rounds, 1);
    assert.equal(lowWithArbiter.converged, true);
    assert.equal(lowWithArbiter.findings.length, 0);
    assert.equal(lowWithArbiter.gateVerdict, 'SHIP');

    // 3. Default single pass with blocking finding -> converged: true, gateVerdict: 'ITERATE'
    process.env.AGB_AGY_BIN = FAKE_AGY;
    process.env.FAKE_PROSECUTOR_VERDICT = 'block';
    const highSingle = await reviewFleet({
      diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n+export const a = 1;\n',
      lenses: ['correctness'],
    });
    assert.equal(highSingle.rounds, 1);
    assert.equal(highSingle.converged, true);
    assert.equal(highSingle.gateVerdict, 'ITERATE');

    // 4. thorough: true runs multi-dry convergence (dryRounds=2, maxRounds=3)
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
    const thoroughClean = await reviewFleet({
      diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n+export const a = 1;\n',
      lenses: ['correctness'],
      thorough: true,
    });
    assert.equal(thoroughClean.rounds, 2);
    assert.equal(thoroughClean.requests, 2);
    assert.equal(thoroughClean.converged, true);

    process.env.FAKE_PROSECUTOR_VERDICT = 'block';
    const thoroughFinding = await reviewFleet({
      diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n+export const a = 1;\n',
      lenses: ['correctness'],
      thorough: true,
    });
    assert.equal(thoroughFinding.rounds, 3);
    assert.equal(thoroughFinding.requests, 3);
    assert.equal(thoroughFinding.converged, true);
    assert.equal(thoroughFinding.gateVerdict, 'ITERATE');

    // 5. Passing dryRounds: 2 without maxRounds allows multi-dry convergence (maxRounds=2)
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
    const dryTwo = await reviewFleet({
      diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n+export const a = 1;\n',
      lenses: ['correctness'],
      dryRounds: 2,
    });
    assert.equal(dryTwo.rounds, 2);
    assert.equal(dryTwo.converged, true);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadPriorFindings & savePriorFindings safely persist, validate, and reject symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-prior-findings-'));
  try {
    assert.deepEqual(loadPriorFindings(dir), []);

    const sample = [
      { id: 'F-1', lens: 'security', severity: 'high', file: 'lib/auth.mjs', claim: 'Missing check' },
    ];
    const saved = savePriorFindings(dir, sample);
    assert.equal(saved.ok, true);
    assert.equal(saved.count, 1);
    assert.equal(saved.path, join(dir, '.review', 'last-findings.json'));
    assert.deepEqual(loadPriorFindings(dir), sample);

    // Custom statePath
    const customPath = join(dir, 'custom', 'prior.json');
    assert.equal(savePriorFindings(dir, sample, customPath).ok, true);
    assert.deepEqual(loadPriorFindings(dir, customPath), sample);

    // Corrupt JSON and non-array shapes return []
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{not valid json');
    assert.deepEqual(loadPriorFindings(dir, badPath), []);
    writeFileSync(badPath, JSON.stringify({ unexpected: true }));
    assert.deepEqual(loadPriorFindings(dir, badPath), []);

    // Symlinked target rejected by both load and save
    const targetFile = join(dir, 'outside.json');
    writeFileSync(targetFile, JSON.stringify(sample));
    const symFile = join(dir, 'sym.json');
    symlinkSync(targetFile, symFile);
    assert.deepEqual(loadPriorFindings(dir, symFile), []);
    const symSave = savePriorFindings(dir, sample, symFile);
    assert.equal(symSave.ok, false);
    assert.match(symSave.error, /symbolic link/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewFleet: deltaDiff + priorFindings reviews delta, embeds prior verification context, and skips untouched clean lenses', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'agb-delta-review-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    mkdirSync(join(repoDir, 'lib'), { recursive: true });
    writeFileSync(join(repoDir, 'lib', 'auth.mjs'), 'export function checkToken(t) {\n  return Boolean(t);\n}\n');
    writeFileSync(join(repoDir, 'lib', 'caller.mjs'), 'import { checkToken } from "./auth.mjs";\nexport const ok = checkToken("x");\n');

    const promptsDir = join(repoDir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    const captureAgy = join(repoDir, 'fake-delta-agy.cjs');
    writeFileSync(
      captureAgy,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let buf = '';
process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  const printIdx = process.argv.indexOf('--print');
  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;
  const m = prompt.match(/Review strictly through exactly one lens:\\s*\\*\\*([^*]+)\\*\\*/);
  const lens = m ? m[1] : 'unknown';
  fs.writeFileSync(path.join(${JSON.stringify(promptsDir)}, lens + '.txt'), prompt);
  console.log(JSON.stringify({ status: 'ok', structured_output: { findings: [] } }));
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = captureAgy;

    // Persist Round-1 finding ONLY on security; fix delta touches ONLY lib/auth.mjs internal body
    savePriorFindings(repoDir, [
      { id: 'SEC-1', lens: 'security', severity: 'high', file: 'lib/auth.mjs', claim: 'Empty token accepted' },
    ]);

    const fullDiff = [
      'diff --git a/lib/unrelated.mjs b/lib/unrelated.mjs',
      '--- a/lib/unrelated.mjs',
      '+++ b/lib/unrelated.mjs',
      '@@ -1 +1 @@',
      '-export const oldThing = 1;',
      '+export const oldThing = 2;',
    ].join('\n');

    const deltaDiff = [
      'diff --git a/lib/auth.mjs b/lib/auth.mjs',
      '--- a/lib/auth.mjs',
      '+++ b/lib/auth.mjs',
      '@@ -1,3 +1,3 @@',
      ' export function checkToken(t) {',
      '-  return true;',
      '+  return Boolean(t);',
      ' }',
    ].join('\n');

    const res = await reviewFleet({
      diff: fullDiff,
      deltaDiff,
      repo: repoDir,
      fiveLens: true,
    });

    assert.equal(res.converged, true);
    assert.equal(res.gateVerdict, 'SHIP');
    // evidence_runner had 0 priorFindings and no test files were touched in deltaDiff
    assert.ok(res.telemetry.skippedLenses.includes('evidence_runner'), `expected evidence_runner skipped, got ${JSON.stringify(res.telemetry.skippedLenses)}`);
    // security had 1 priorFinding and lib/auth.mjs is security-sensitive -> must run
    assert.equal(existsSync(join(promptsDir, 'security.txt')), true);
    assert.equal(existsSync(join(promptsDir, 'evidence_runner.txt')), false);

    const secPrompt = readFileSync(join(promptsDir, 'security.txt'), 'utf8');
    assert.match(secPrompt, /checkToken/);
    assert.match(secPrompt, /UNTRUSTED:PRIOR_FINDINGS:/);
    assert.match(secPrompt, /Empty token accepted/);
    assert.match(secPrompt, /lib\/caller\.mjs/);
    assert.ok(!secPrompt.includes('oldThing'), 'delta review must exclude unrelated static diff chunks');
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('reviewFleet: strips noise files before 180k check, toggles allowReadTools from contextPack.truncatedContext, and aggregates telemetry + FactoryLedger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-review-tel-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'leaf.mjs'), 'export function leafFn(x) {\n  return x + 1;\n}\n');
    const settingsDir = join(dir, 'settings');
    mkdirSync(settingsDir, { recursive: true });

    const telAgy = join(dir, 'fake-tel-agy.cjs');
    const settingsLog = join(settingsDir, 'settings.jsonl');
    writeFileSync(
      telAgy,
      `#!/usr/bin/env node
const fs = require('node:fs');
const sIdx = process.argv.indexOf('--settings');
const settings = sIdx >= 0 ? process.argv[sIdx + 1] : '';
fs.appendFileSync(${JSON.stringify(settingsLog)}, settings + '\\n');
let buf = '';
process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    status: 'ok',
    structured_output: { findings: [] },
    telemetry: { input_tokens: 1000, cached_tokens: 400, output_tokens: 100 }
  }));
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = telAgy;

    // 1. Huge package-lock.json noise (>180k) + tiny lib/leaf.mjs edit -> NOT truncated, allowReadTools: false
    const lockNoise = `diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n+${'z'.repeat(190_000)}\n`;
    const smallSrc = `diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n--- a/lib/leaf.mjs\n+++ b/lib/leaf.mjs\n@@ -1,3 +1,3 @@\n export function leafFn(x) {\n-  return x;\n+  return x + 1;\n }\n`;
    const res = await reviewFleet({
      diff: `${lockNoise}${smallSrc}`,
      repo: dir,
      lenses: ['correctness', 'security'],
      decisionEngine: false,
    });
    assert.equal(res.truncated, false);
    assert.equal(res.converged, true);
    assert.equal(res.gateVerdict, 'SHIP');
    assert.deepEqual(res.telemetry, {
      uncachedInputTokens: 1200,
      cachedTokens: 800,
      outputTokens: 200,
      inputTokens: 2000,
      billableTokens: 1880,
      system1Calls: 0,
      skippedLenses: [],
      arbiterMode: 'none',
    });

    const firstBatch = readFileSync(settingsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(firstBatch.length, 2);
    assert.ok(firstBatch[0].permissions.deny.includes('read_file(*)'), 'allowReadTools=false denies read_file(*)');

    // FactoryLedger persisted best-effort when repo is provided
    const ledgerRuns = new FactoryLedger({ repo: dir }).readRuns();
    assert.equal(ledgerRuns.length, 1);
    assert.equal(ledgerRuns[0].uncachedInputTokens, 1200);
    assert.equal(ledgerRuns[0].cachedTokens, 800);
    assert.equal(ledgerRuns[0].outputTokens, 200);

    // 2. Massive external caller context (>16 KiB) triggers truncatedContext=true -> allowReadTools: true
    writeFileSync(settingsLog, '');
    for (let i = 0; i < 160; i++) {
      writeFileSync(
        join(dir, 'lib', `consumer-${i}.mjs`),
        `import { leafFn } from './leaf.mjs';\nexport const val${i} = leafFn(${i} + ${'0'.repeat(90)});\n`
      );
    }
    const resTruncCtx = await reviewFleet({
      diff: smallSrc,
      repo: dir,
      lenses: ['correctness'],
      recordLedger: false,
    });
    assert.equal(resTruncCtx.converged, true);
    const secondBatch = readFileSync(settingsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(secondBatch.length, 1);
    assert.ok(!secondBatch[0].permissions.deny.includes('read_file(*)'), 'allowReadTools=true retains read_file(*) when contextPack is truncated');
    // recordLedger: false did not append a 2nd entry
    assert.equal(new FactoryLedger({ repo: dir }).readRuns().length, 1);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(dir, { recursive: true, force: true });
  }
});

