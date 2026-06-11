// Cross-model prosecution of a ticket branch (ADLC P5, phase-1 cut:
// one refute pass + structural verification of the verdict; loop-until-dry
// arrives in phase 2).

import { extractJson } from '@aidlc/core/llm';
import { runAgy } from './agy.mjs';
import { prosecutionPrompt } from './charters.mjs';

const MAX_DIFF_CHARS = 120_000;

/**
 * Prosecute a diff with a model from a different family than the builder.
 * Returns { verdict: 'ship'|'block'|'error', findings, model, raw }.
 * Severity gate: any critical/high finding forces 'block' regardless of the
 * model's own verdict field (the JSON contract, not the model, decides).
 */
export async function prosecute({ ticket, diff, model, cwd, logFile }) {
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
  const res = await runAgy({
    model,
    prompt: prosecutionPrompt(ticket, diff),
    cwd,
    timeout: '8m',
    logFile,
  });
  if (!res.ok) return { verdict: 'error', model, findings: [], error: res.error };
  let parsed;
  try {
    parsed = extractJson(res.output);
  } catch {
    return { verdict: 'error', model, findings: [], error: 'unparseable prosecution output', raw: res.output.slice(-500) };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings.filter((f) => f && f.claim) : [];
  const blocking = findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  const verdict = blocking ? 'block' : parsed.verdict === 'block' ? 'block' : 'ship';
  return { verdict, model, findings };
}

/** Findings that gate the merge (forwarded to the fix round). */
export function blockingFindings(findings) {
  return findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
}
