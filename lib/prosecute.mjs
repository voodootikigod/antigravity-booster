// Cross-model prosecution of a ticket branch (ADLC P5, phase-1 cut:
// one refute pass + structural verification of the verdict; loop-until-dry
// arrives in phase 2).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJson } from '@adlc/core/llm';
import { runAgy, PROSECUTION_VERDICT_SCHEMA, validateJsonSchema } from './agy.mjs';
import { deriveDeterministicFenceTag, prosecutionPrompt } from './charters.mjs';
import { runAdlcTool } from './adlc-tool.mjs';
import { wrapConsensusGateCommand } from './scheduler-verify.mjs';
import { deriveImpactedTests } from './test-impact.mjs';
import { buildReviewContextPack, computeDiffBlastRadius } from './context-slice.mjs';
import { DecisionEngine, resolveDecisionConfig, screenTicketFastShip } from './decision-engine.mjs';

const MAX_DIFF_CHARS = 120_000;
const HOLLOW_TEST_TIMEOUT_MS = 180_000;

function toNonNegInt(val) {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? Math.round(val) : 0;
}

function zeroTelemetry(system1Calls = 0) {
  return {
    uncachedInputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    inputTokens: 0,
    system1Calls: toNonNegInt(system1Calls),
  };
}

function aggregateTelemetry(agyTelemetry, precheckTelemetry) {
  const agy = agyTelemetry && typeof agyTelemetry === 'object' ? agyTelemetry : {};
  const pre = precheckTelemetry && typeof precheckTelemetry === 'object' ? precheckTelemetry : {};
  return {
    uncachedInputTokens: toNonNegInt(agy.uncachedInputTokens) + toNonNegInt(pre.uncachedInputTokens),
    cachedTokens: toNonNegInt(agy.cachedTokens) + toNonNegInt(pre.cachedTokens),
    outputTokens: toNonNegInt(agy.outputTokens) + toNonNegInt(pre.outputTokens),
    inputTokens: toNonNegInt(agy.inputTokens) + toNonNegInt(pre.inputTokens),
    system1Calls: toNonNegInt(agy.system1Calls) + toNonNegInt(pre.system1Calls),
  };
}

function buildHollowSurvivorFinding(hollowTest) {
  return {
    severity: 'critical',
    charge: 'tests',
    claim: `adlc hollow-test: ${hollowTest.survived}/${hollowTest.total} mutant(s) survived — the test suite does not actually constrain the changed lines`,
    evidence: JSON.stringify(hollowTest.mutants),
  };
}

function resolvePrecheckDecisionEngine(decisionEngine, repo) {
  if (decisionEngine === false || decisionEngine === null) return null;
  if (decisionEngine && typeof decisionEngine.evaluate === 'function') {
    return decisionEngine;
  }
  try {
    if (decisionEngine && typeof decisionEngine === 'object') {
      if (decisionEngine.enabled === false) return null;
      if (decisionEngine.provider) {
        return DecisionEngine.fromConfig({ enabled: true, ...decisionEngine });
      }
      const cfg = resolveDecisionConfig({
        repo,
        enabled: typeof decisionEngine.enabled === 'boolean' ? decisionEngine.enabled : undefined,
      });
      return DecisionEngine.fromConfig(cfg);
    }
    const cfg = resolveDecisionConfig({
      repo,
      enabled: decisionEngine === true ? true : undefined,
    });
    return DecisionEngine.fromConfig(cfg);
  } catch {
    return null;
  }
}

function isCompatibleNodeTestCmd(testCmd) {
  if (typeof testCmd !== 'string') return false;
  const trimmed = testCmd.trim();
  if (!trimmed || /[;&|`$()<>]/.test(trimmed)) return false;
  return /^npm\s+test$/.test(trimmed) || /^node\s+--test(?:\s+.*)?$/.test(trimmed);
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
export async function runHollowTest({
  worktree,
  rootRepo = null,
  testCmd,
  base = 'main',
  adlcBin,
  changedFiles = null,
  fastHollowTest = true,
  codegraph = true,
} = {}) {
  if (!testCmd) return { ok: false, error: 'no gate test command configured — hollow-test skipped' };
  let effectiveTestCmd = testCmd;
  if (
    fastHollowTest !== false &&
    worktree &&
    Array.isArray(changedFiles) &&
    changedFiles.length > 0 &&
    isCompatibleNodeTestCmd(testCmd)
  ) {
    const impact = deriveImpactedTests(changedFiles, {
      repo: worktree,
      rootRepo: rootRepo ?? worktree,
      fallbackTestCmd: testCmd,
      enabled: codegraph,
    });
    if (impact.fast && Array.isArray(impact.testFiles) && impact.testFiles.length > 0 && impact.testCmd) {
      effectiveTestCmd = impact.testCmd;
    }
  }
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
    const res = await runAdlcTool({
      tool: 'hollow-test',
      args: ['--test-cmd', hollowTestCmd, '--base', base, '--json'],
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
 * Run zero-LLM pre-prosecution checks (hollow-test mutation gate, diff blast-radius
 * scoring, bounded context pack, and opt-in System-1 fast-ship screening) before
 * acquiring a System-2 quota pool lease or spawning `agy`.
 */
export async function prepareProsecutionPrecheck({
  ticket,
  diff = '',
  worktree,
  rootRepo,
  testCmd,
  base,
  adlcBin,
  changedFiles = null,
  decisionEngine,
  shortCircuitHollowTest = true,
  codegraph = true,
  seed,
  hollowTest: hollowTestOpt,
} = {}) {
  const diffText = typeof diff === 'string' ? diff : String(diff ?? '');
  const hollowTest = hollowTestOpt !== undefined
    ? hollowTestOpt
    : (worktree
        ? await runHollowTest({ worktree, rootRepo, testCmd, base, adlcBin, changedFiles, codegraph })
        : null);

  const hasTargetRepo = Boolean(worktree || rootRepo);
  let emptyFallbackDir = null;
  let blastRadius;
  let contextPack;
  try {
    const effectiveWorktree = hasTargetRepo
      ? (worktree ?? rootRepo)
      : (emptyFallbackDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-norepo-')));
    const effectiveRootRepo = hasTargetRepo ? (rootRepo ?? worktree) : effectiveWorktree;
    const scope = Array.isArray(ticket?.scope) ? ticket.scope : [];
    const contextTag = seed ? deriveDeterministicFenceTag(seed, `callers:${diffText}`) : undefined;

    blastRadius = computeDiffBlastRadius(diffText, {
      repo: effectiveWorktree,
      rootRepo: effectiveRootRepo,
      worktree: effectiveWorktree,
      scope,
      enabled: codegraph,
    });
    contextPack = buildReviewContextPack(diffText, {
      repo: effectiveWorktree,
      rootRepo: effectiveRootRepo,
      worktree: effectiveWorktree,
      scope,
      ...(contextTag ? { tag: contextTag } : {}),
      enabled: codegraph,
    });
  } finally {
    if (emptyFallbackDir) {
      try { rmSync(emptyFallbackDir, { recursive: true, force: true }); } catch {}
    }
  }

  let shortCircuited = null;
  let fastShipped = null;
  let decisionRes = null;
  let system1Calls = 0;

  if (shortCircuitHollowTest !== false && hollowTest?.ok && hollowTest.survived > 0) {
    shortCircuited = 'hollow-test';
  } else if (decisionEngine !== false) {
    const engine = resolvePrecheckDecisionEngine(decisionEngine, rootRepo ?? worktree);
    if (engine) {
      const trackedEngine = {
        evaluate: (primitive, queries) => {
          system1Calls += 1;
          return engine.evaluate(primitive, queries);
        },
        noul: (queries) => {
          system1Calls += 1;
          return typeof engine.noul === 'function'
            ? engine.noul(queries)
            : engine.evaluate('noul', queries);
        },
      };
      decisionRes = await screenTicketFastShip(trackedEngine, {
        ticket,
        diff: diffText,
        blastRadius,
        hollowTest,
      });
      if (decisionRes?.fastShip === true) {
        fastShipped = 'system1';
      }
    }
  }

  return {
    hollowTest,
    blastRadius,
    contextPack,
    shortCircuited,
    fastShipped,
    decisionRes,
    telemetry: zeroTelemetry(system1Calls),
  };
}

/**
 * Prosecute a diff with a model from a different family than the builder.
 * Returns { verdict: 'ship'|'block'|'error', findings, model, hollowTest, blastRadius, telemetry }.
 * Severity gate: any critical/high finding forces 'block' regardless of the
 * model's own verdict field (the JSON contract, not the model, decides).
 * Evidence gate (ADLC P5): when `worktree`+`testCmd` are supplied, a
 * mutation-testing survivor from adlc hollow-test is ALSO an automatic
 * 'block' — short-circuiting with 0 LLM spawns by default unless
 * `shortCircuitHollowTest: false` is passed.
 */
export async function prosecute({
  ticket,
  diff,
  model,
  cwd,
  logFile,
  worktree,
  rootRepo,
  testCmd,
  base,
  project,
  onSpawn,
  adlcBin,
  seed,
  changedFiles = null,
  precheck,
  decisionEngine,
  shortCircuitHollowTest = true,
  codegraph = true,
  hollowTest: hollowTestOpt,
} = {}) {
  const diffText = typeof diff === 'string' ? diff : String(diff ?? '');
  if (!diffText.trim()) {
    return {
      verdict: 'block',
      model,
      findings: [{ severity: 'critical', charge: 'spec', claim: 'empty diff — ticket produced no committed change' }],
      telemetry: zeroTelemetry(),
    };
  }
  // Never prosecute a partial view: silently truncating let a builder pad an
  // early-sorting file with ~120k of boilerplate and hide a change in a later
  // file the prosecutor never sees, then collect a 'ship' on what it did see
  // (adversarial-review MEDIUM). An over-limit diff is itself the finding.
  if (diffText.length > MAX_DIFF_CHARS) {
    return {
      verdict: 'block', model,
      findings: [{
        severity: 'critical', charge: 'scope',
        claim: `diff too large to prosecute (${diffText.length} chars > ${MAX_DIFF_CHARS}) — ` +
          `a partial review cannot certify the unseen remainder; split the ticket or shrink the change`,
      }],
      telemetry: zeroTelemetry(),
    };
  }

  const resolvedPrecheck = precheck ?? await prepareProsecutionPrecheck({
    ticket,
    diff: diffText,
    worktree,
    rootRepo,
    testCmd,
    base,
    adlcBin,
    changedFiles,
    decisionEngine,
    shortCircuitHollowTest,
    codegraph,
    seed,
    hollowTest: hollowTestOpt,
  });

  const hollowTest = resolvedPrecheck?.hollowTest ?? null;
  const blastRadius = resolvedPrecheck?.blastRadius ?? null;
  const contextPack = resolvedPrecheck?.contextPack ?? null;
  const decisionRes = resolvedPrecheck?.decisionRes ?? null;
  const precheckTelemetry = aggregateTelemetry(
    null,
    resolvedPrecheck?.telemetry ?? (resolvedPrecheck?.fastShipped === 'system1' ? zeroTelemetry(1) : zeroTelemetry(0))
  );

  const hollowBlocking = !!(hollowTest?.ok && hollowTest.survived > 0);
  if (shortCircuitHollowTest !== false && (resolvedPrecheck?.shortCircuited === 'hollow-test' || hollowBlocking)) {
    return {
      verdict: 'block',
      model,
      shortCircuited: 'hollow-test',
      findings: [
        hollowBlocking
          ? buildHollowSurvivorFinding(hollowTest)
          : {
              severity: 'critical',
              charge: 'tests',
              claim: 'adlc hollow-test short-circuit triggered — mutant survivors detected',
              evidence: JSON.stringify(hollowTest?.mutants ?? []),
            },
      ],
      hollowTest,
      blastRadius,
      telemetry: precheckTelemetry,
    };
  }

  if (resolvedPrecheck?.fastShipped === 'system1' && !hollowBlocking) {
    return {
      verdict: 'ship',
      model: decisionRes?.model ?? model,
      fastShipped: 'system1',
      findings: [],
      hollowTest,
      blastRadius,
      telemetry: precheckTelemetry,
    };
  }

  const finalProject = project ?? `agb-prosecute-${Date.now()}`;
  const basePrompt = prosecutionPrompt(ticket, diffText, undefined, hollowTest, { seed });
  const contextBlock = typeof contextPack?.contextBlock === 'string' && contextPack.contextBlock.trim()
    ? contextPack.contextBlock
    : '';
  const fullPrompt = contextBlock ? `${basePrompt}\n\n${contextBlock}` : basePrompt;

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
    allowReadTools: Boolean(contextPack?.truncatedContext),
    outputFormat: 'json',
    jsonSchema: PROSECUTION_VERDICT_SCHEMA,
    worker: { mode: 'readonly' },
    onSpawn,
  });
  const telemetry = aggregateTelemetry(res.telemetry, precheckTelemetry);
  let parsed = res.ok ? res.data : tryRecoverMixedCaseSeverity(res);
  if (!res.ok && !parsed) {
    return { verdict: 'error', model, findings: [], error: res.error, hollowTest, blastRadius, kind: res.kind, telemetry };
  }
  if (!parsed) {
    try {
      parsed = extractJson(res.output);
    } catch {
      return { verdict: 'error', model, findings: [], error: 'unparseable prosecution output', raw: res.output.slice(-500), hollowTest, blastRadius, telemetry };
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
  if (hollowBlocking) {
    findings.push(buildHollowSurvivorFinding(hollowTest));
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
      blastRadius,
      telemetry,
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
      blastRadius,
      telemetry,
    };
  }

  // Verdict Invariant 1 (Strict Severity Gate): Critical or high finding forces block regardless of model verdict.
  const blocking = modelBlocking || hollowBlocking;
  const verdict = blocking ? 'block' : 'ship';
  return { verdict, model, findings, hollowTest, blastRadius, telemetry };
}

/** Findings that gate the merge (forwarded to the fix round). */
export function blockingFindings(findings) {
  return (Array.isArray(findings) ? findings : []).filter((f) => {
    const sev = normalizeFindingSeverity(f);
    return sev === 'critical' || sev === 'high';
  });
}
