// Cross-model prosecution of a ticket branch (ADLC P5, phase-1 cut:
// one refute pass + structural verification of the verdict; loop-until-dry
// arrives in phase 2).

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractJson } from '@adlc/core/llm';
import { runAgy, PROSECUTION_VERDICT_SCHEMA, validateJsonSchema } from './agy.mjs';
import { prosecutionPrompt } from './charters.mjs';
import { runAdlcTool } from './adlc-tool.mjs';
import { wrapConsensusGateCommand } from './scheduler-verify.mjs';
import { deriveImpactedTests } from './test-impact.mjs';
import { discoverExternalCallers } from './context-slice.mjs';

const execFileP = promisify(execFile);
const MAX_DIFF_CHARS = 120_000;
const HOLLOW_TEST_TIMEOUT_MS = 300_000;
const SLOW_HOLLOW_TESTS = new Set([
  'test/evals.test.mjs',
  'test/hook-runner.test.mjs',
  'test/orchestrator-routing.test.mjs',
]);

function isCompatibleNodeTestCmd(testCmd) {
  if (typeof testCmd !== 'string') return false;
  const trimmed = testCmd.trim();
  if (!trimmed || /[;&|`$()<>]/.test(trimmed)) return false;
  return /^npm\s+test$/.test(trimmed) || /^node\s+--test(?:\s+.*)?$/.test(trimmed);
}

export function resolveHollowTestCommand(changedFiles, { repo, fallbackTestCmd }) {
  if (
    !repo ||
    !Array.isArray(changedFiles) ||
    changedFiles.length === 0 ||
    !isCompatibleNodeTestCmd(fallbackTestCmd)
  ) {
    return fallbackTestCmd;
  }
  const nonFixture = changedFiles.filter(
    (p) => typeof p === 'string' && !/^test\/fixtures\//.test(p) && !/^dist\//.test(p),
  );
  const targetFiles = nonFixture.length > 0 ? nonFixture : changedFiles;
  const impact = deriveImpactedTests(targetFiles, { repo, fallbackTestCmd });
  if (impact.fast && Array.isArray(impact.testFiles) && impact.testFiles.length > 0 && impact.testCmd) {
    const kept = new Set(impact.testFiles.filter((tf) => !SLOW_HOLLOW_TESTS.has(tf)));
    if (kept.size > 0) {
      const mutableChanged = targetFiles.filter(
        (p) => !p.startsWith('test/') && /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/i.test(p) && !/\.d\.[mc]?ts$/i.test(p),
      );
      for (const f of mutableChanged) {
        const single = deriveImpactedTests([f], { repo, fallbackTestCmd, maxSliceFiles: 12 });
        if (
          single.fast &&
          Array.isArray(single.testFiles) &&
          single.testFiles.length > 0 &&
          single.testFiles.every((tf) => SLOW_HOLLOW_TESTS.has(tf))
        ) {
          for (const tf of single.testFiles) kept.add(tf);
        }
      }
      return `node --test ${[...kept].sort().join(' ')}`;
    }
    return impact.testCmd;
  }
  const directTests = targetFiles.filter((p) => /^test\/[A-Za-z0-9_./-]+\.test\.mjs$/.test(p));
  const scoped = new Set(directTests.filter((p) => !SLOW_HOLLOW_TESTS.has(p)));
  const scopedSources = [...scoped].map((tf) => {
    try {
      const full = join(repo, tf);
      return existsSync(full) ? readFileSync(full, 'utf8') : '';
    } catch {
      return '';
    }
  });
  for (const f of targetFiles) {
    if (f.startsWith('test/')) continue;
    const alreadyDirectTested = scopedSources.some((src) => src.includes(f));
    if (alreadyDirectTested) continue;
    const single = deriveImpactedTests([f], { repo, fallbackTestCmd, maxSliceFiles: 5 });
    if (single.fast && Array.isArray(single.testFiles)) {
      for (const tf of single.testFiles) {
        if (!SLOW_HOLLOW_TESTS.has(tf) || scoped.size === 0) scoped.add(tf);
      }
    }
  }
  if (scoped.size > 0) {
    return `node --test ${[...scoped].sort().join(' ')}`;
  }
  if (directTests.length > 0) {
    return `node --test ${[...new Set(directTests)].sort().join(' ')}`;
  }
  return fallbackTestCmd;
}

function normalizeFindingSeverity(finding) {
  return String(finding?.severity || '').trim().toLowerCase();
}

function tryRecoverMixedCaseSeverity(res) {
  if (res?.kind !== 'schema_violation' || typeof res.output !== 'string' || !res.output.trim()) return null;
  try {
    const raw = JSON.parse(res.output);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    let structured = raw.structured_output !== undefined ? raw.structured_output : raw;
    if (typeof structured === 'string') structured = JSON.parse(structured);
    if (!structured || typeof structured !== 'object' || !Array.isArray(structured.findings)) return null;
    const normalized = {
      ...structured,
      findings: structured.findings.map((f) =>
        f && typeof f === 'object' && typeof f.severity === 'string'
          ? { ...f, severity: f.severity.trim().toLowerCase() }
          : f
      ),
    };
    if (validateJsonSchema(normalized, PROSECUTION_VERDICT_SCHEMA).valid) {
      return normalized;
    }
  } catch {
    // Not recoverable as a case-only severity schema violation
  }
  return null;
}

/**
 * Run `adlc hollow-test` against a ticket's already-committed worktree —
 * mutates the changed lines and confirms the gate command actually catches
 * every mutant. Evidence-backed prosecution (ADLC P5): this is machine-
 * checked, not a model's self-report, and its survivors are an automatic
 * prosecution hit the model cannot overrule (see prosecute() below).
 *
 * Never throws: an operational failure (adlc missing, dirty tree, timeout)
 * degrades to { ok: false, error } — evidence is surfaced as UNAVAILABLE in
 * the prompt, never hidden, but does not itself block the cross-model pass.
 */
export async function runHollowTest({ worktree, testCmd, base = 'main', adlcBin, changedFiles = null, fastHollowTest = true } = {}) {
  if (!testCmd) return { ok: false, error: 'no gate test command configured — hollow-test skipped' };
  const effectiveTestCmd =
    fastHollowTest !== false && worktree
      ? resolveHollowTestCommand(changedFiles, { repo: worktree, fallbackTestCmd: testCmd })
      : testCmd;
  const useSandbox = process.env.AGB_SANDBOX_GATES !== '0';
  const hollowSandboxDir = useSandbox ? mkdtempSync(join(tmpdir(), 'agb-prosecute-ht-sbx-')) : null;
  try {
    let hollowTestCmd = effectiveTestCmd;
    if (useSandbox) {
      if (!worktree) {
        return {
          ok: false,
          error: 'hollow-test skipped: gate sandbox requires a worktree path (set AGB_SANDBOX_GATES=0 to bypass)',
        };
      }
      const wrapped = wrapConsensusGateCommand(effectiveTestCmd, worktree, { sandboxTmpDir: hollowSandboxDir });
      if (!wrapped.ok) {
        return {
          ok: false,
          error: `hollow-test skipped: gate sandbox unavailable (${wrapped.error ?? 'OS sandbox required unless AGB_SANDBOX_GATES=0'})`,
        };
      }
      hollowTestCmd = wrapped.cmd;
    }
    // In @adlc/hollow-test (lib/targets.mjs:105), --test-glob adds globs to the
    // non-mutable exclusion list so generated esbuild dist/** bundles are excluded
    // from AST mutation while changed source files (lib/**, hooks/**, etc.) remain mutated.
    const res = await runAdlcTool({
      tool: 'hollow-test',
      args: ['--test-cmd', hollowTestCmd, '--base', base, '--test-glob', 'dist/**', '--json'],
      cwd: worktree,
      timeoutMs: HOLLOW_TEST_TIMEOUT_MS,
      adlcBin,
      repo: worktree,
    });
    if (!res.ok || (res.exitCode !== 0 && res.exitCode !== 2)) {
      return { ok: false, error: res.error || `hollow-test exited with code ${res.exitCode}` };
    }
    const parsed = res.parsed;
    const survivors = (parsed.mutants ?? []).filter((m) => m.status === 'survived');
    return {
      ok: true,
      total: parsed.summary?.total ?? 0,
      killed: parsed.summary?.killed ?? 0,
      survived: survivors.length,
      mutants: survivors,
    };
  } finally {
    if (hollowSandboxDir) {
      try { rmSync(hollowSandboxDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Prosecute a diff with a model from a different family than the builder.
 * Returns { verdict: 'ship'|'block'|'error', findings, model, raw, hollowTest }.
 * Severity gate: any critical/high finding forces 'block' regardless of the
 * model's own verdict field (the JSON contract, not the model, decides).
 * Evidence gate (ADLC P5): when `worktree`+`testCmd` are supplied, a
 * mutation-testing survivor from adlc hollow-test is ALSO an automatic
 * 'block' — the model cannot overrule a hard, machine-checked signal that
 * the tests don't actually constrain the changed lines.
 */
export async function prosecute({ ticket, diff, model, cwd, logFile, worktree, testCmd, base, project, onSpawn, adlcBin }) {
  if (!diff.trim()) {
    return { verdict: 'block', model, findings: [{ severity: 'critical', charge: 'spec', claim: 'empty diff — ticket produced no committed change' }] };
  }
  // Never prosecute a partial view: silently truncating let a builder pad an
  // early-sorting file with ~120k of boilerplate and hide a change in a later
  // file the prosecutor never sees, then collect a 'ship' on what it did see
  // (adversarial-review MEDIUM). An over-limit diff is itself the finding.
  if (diff.length > MAX_DIFF_CHARS) {
    return {
      verdict: 'block', model,
      findings: [{
        severity: 'critical', charge: 'scope',
        claim: `diff too large to prosecute (${diff.length} chars > ${MAX_DIFF_CHARS}) — ` +
          `a partial review cannot certify the unseen remainder; split the ticket or shrink the change`,
      }],
    };
  }

  const finalProject = project ?? `agb-prosecute-${Date.now()}`;
  const diffPaths = [...new Set([...diff.matchAll(/^\+\+\+ b\/([^\r\n]+)$/gm)].map((m) => m[1]))]
    .filter((p) => !/^test\/fixtures\//.test(p));
  const hollowTest = worktree
    ? await runHollowTest({
        worktree,
        testCmd,
        base,
        adlcBin,
        changedFiles: diffPaths.length > 0 ? diffPaths : null,
      })
    : null;
  const externalCallers = worktree
    ? discoverExternalCallers(diff, { repo: worktree, scope: ticket?.scope ?? [] })
    : null;
  const basePrompt = prosecutionPrompt(ticket, diff, undefined, hollowTest);
  const fullPrompt = externalCallers?.promptBlock
    ? `${basePrompt}\n\n${externalCallers.promptBlock}`
    : basePrompt;

  const res = await runAgy({
    model,
    prompt: fullPrompt,
    cwd,
    repo: worktree,
    timeout: '8m',
    logFile,
    project: finalProject,
    strike: 0,
    role: 'prosecutor',
    useRoleSettings: true,
    outputFormat: 'json',
    jsonSchema: PROSECUTION_VERDICT_SCHEMA,
    worker: { mode: 'readonly' },
    onSpawn,
  });
  let parsed = res.ok ? res.data : tryRecoverMixedCaseSeverity(res);
  if (!res.ok && !parsed) {
    return {
      verdict: 'error',
      model,
      findings: [],
      error: res.error,
      hollowTest,
      kind: res.kind,
      rateLimited: Boolean(res.rateLimited),
    };
  }
  if (!parsed) {
    try {
      parsed = extractJson(res.output);
    } catch {
      return { verdict: 'error', model, findings: [], error: 'unparseable prosecution output', raw: res.output.slice(-500), hollowTest };
    }
  }
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
        .filter((f) => f && f.claim)
        .map((f) => ({ ...f, severity: normalizeFindingSeverity(f) }))
    : [];
  const modelBlocking = findings.some((f) => {
    const sev = normalizeFindingSeverity(f);
    return sev === 'critical' || sev === 'high';
  });
  const hollowBlocking = !!(hollowTest?.ok && hollowTest.survived > 0);
  if (hollowBlocking) {
    findings.push({
      severity: 'critical', charge: 'tests',
      claim: `adlc hollow-test: ${hollowTest.survived}/${hollowTest.total} mutant(s) survived — the test suite does not actually constrain the changed lines`,
      evidence: JSON.stringify(hollowTest.mutants),
    });
  }

  // Verdict Invariant 2 (Block Justification): If verdict === 'block', findings must be non-empty.
  if (parsed.verdict === 'block' && findings.length === 0) {
    return {
      verdict: 'error',
      model,
      findings: [],
      error: 'Verdict block issued with empty findings array',
      kind: 'schema_violation',
      hollowTest,
    };
  }

  // Verdict Invariant 3 (Verdict Integrity): Must be explicitly 'ship' or 'block'.
  if (parsed.verdict !== 'ship' && parsed.verdict !== 'block') {
    return {
      verdict: 'error',
      model,
      findings: [],
      error: `invalid or missing prosecution verdict: ${parsed.verdict}`,
      kind: 'schema_violation',
      hollowTest,
    };
  }

  // Verdict Invariant 1 (Strict Severity Gate): Critical or high finding forces block regardless of model verdict.
  const blocking = modelBlocking || hollowBlocking;
  const verdict = blocking ? 'block' : 'ship';
  return { verdict, model, findings, hollowTest };
}

/** Findings that gate the merge (forwarded to the fix round). */
export function blockingFindings(findings) {
  return (Array.isArray(findings) ? findings : []).filter((f) => {
    const sev = normalizeFindingSeverity(f);
    return sev === 'critical' || sev === 'high';
  });
}
