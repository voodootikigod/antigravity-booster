// Cross-model prosecution of a ticket branch (ADLC P5, phase-1 cut:
// one refute pass + structural verification of the verdict; loop-until-dry
// arrives in phase 2).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractJson } from '@adlc/core/llm';
import { runAgy } from './agy.mjs';
import { prosecutionPrompt } from './charters.mjs';

const execFileP = promisify(execFile);
const MAX_DIFF_CHARS = 120_000;
const HOLLOW_TEST_TIMEOUT_MS = 180_000;

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
export async function runHollowTest({ worktree, testCmd, base = 'main', adlcBin } = {}) {
  const bin = adlcBin ?? process.env.AGB_ADLC_BIN ?? 'adlc';
  if (!testCmd) return { ok: false, error: 'no gate test command configured — hollow-test skipped' };
  const parseResult = (stdout) => {
    const parsed = JSON.parse(stdout);
    const survivors = (parsed.mutants ?? []).filter((m) => m.status === 'survived');
    return {
      ok: true,
      total: parsed.summary?.total ?? 0,
      killed: parsed.summary?.killed ?? 0,
      survived: survivors.length,
      mutants: survivors,
    };
  };
  try {
    const { stdout } = await execFileP(bin, [
      'hollow-test', '--test-cmd', testCmd, '--base', base, '--json',
    ], { cwd: worktree, timeout: HOLLOW_TEST_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return parseResult(stdout);
  } catch (err) {
    // hollow-test exits 2 (gate fail) when mutants survive — execFile
    // rejects on any non-zero exit, but the real JSON result is still on
    // stdout, attached to the error. Recover it; only a genuinely
    // unparseable/empty stdout (operational error, exit 1) falls through.
    if (err.stdout) {
      try {
        return parseResult(err.stdout);
      } catch { /* fall through */ }
    }
    return { ok: false, error: err.message };
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
export async function prosecute({ ticket, diff, model, cwd, logFile, worktree, testCmd, base, project }) {
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
  const hollowTest = worktree ? await runHollowTest({ worktree, testCmd, base }) : null;

  const res = await runAgy({
    model,
    prompt: prosecutionPrompt(ticket, diff, undefined, hollowTest),
    cwd,
    timeout: '8m',
    logFile,
    project: finalProject,
  });
  if (!res.ok) return { verdict: 'error', model, findings: [], error: res.error, hollowTest };
  let parsed;
  try {
    parsed = extractJson(res.output);
  } catch {
    return { verdict: 'error', model, findings: [], error: 'unparseable prosecution output', raw: res.output.slice(-500), hollowTest };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings.filter((f) => f && f.claim) : [];
  const modelBlocking = findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  const hollowBlocking = !!(hollowTest?.ok && hollowTest.survived > 0);
  if (hollowBlocking) {
    findings.push({
      severity: 'critical', charge: 'tests',
      claim: `adlc hollow-test: ${hollowTest.survived}/${hollowTest.total} mutant(s) survived — the test suite does not actually constrain the changed lines`,
      evidence: JSON.stringify(hollowTest.mutants),
    });
  }
  const blocking = modelBlocking || hollowBlocking;
  const verdict = blocking ? 'block' : parsed.verdict === 'block' ? 'block' : 'ship';
  return { verdict, model, findings, hollowTest };
}

/** Findings that gate the merge (forwarded to the fix round). */
export function blockingFindings(findings) {
  return findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
}
