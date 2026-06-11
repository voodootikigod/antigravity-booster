// Sweep mode: the same operation fanned across many targets — migrations,
// refactors, audits, test backfills. Embarrassingly parallel: each target
// becomes one generated ticket with a disjoint scope, then the normal
// run pipeline (build → gate → prosecute → merge) applies.
//
// sweep.json:
// {
//   "repo": "/abs/path",
//   "base": "main",
//   "gate": { "test": "npm test" },
//   "tier": "cheap",                   // sweeps default cheap — rails are dense
//   "pool_hint": "auto",
//   "operation": "Add JSDoc to every exported function in {target}. ...",
//   "targets": ["src/a.mjs", "src/b.mjs"],   // or use targetGlob
//   "targetGlob": "src/**/*.mjs",            // expanded against the repo
//   "scopePerTarget": ["{target}"]           // scope globs, {target} substituted
// }

import { execFileSync } from 'node:child_process';

/** Expand a glob against tracked files in the repo (git ls-files). */
export function expandTargets(repo, glob) {
  const out = execFileSync('git', ['ls-files', '--', glob], { cwd: repo, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/** Substitute {target} (and {i}) into a template string. */
function fill(template, target, i) {
  return template.replaceAll('{target}', target).replaceAll('{i}', String(i));
}

/**
 * Convert a sweep spec into a normal plan consumable by runPlan.
 * Throws on invalid spec.
 */
export function sweepToPlan(spec, { targets } = {}) {
  if (!spec.repo) throw new Error('sweep.repo is required');
  if (!spec.operation || !spec.operation.includes('{target}')) {
    throw new Error('sweep.operation must be a template containing {target}');
  }
  const resolved = targets ?? spec.targets ?? (spec.targetGlob ? expandTargets(spec.repo, spec.targetGlob) : null);
  if (!resolved?.length) throw new Error('sweep has no targets (set targets[] or targetGlob)');
  const scopeTemplates = spec.scopePerTarget ?? ['{target}'];
  const tickets = resolved.map((target, i) => ({
    id: `S${i + 1}`,
    title: `sweep: ${target}`,
    body: fill(spec.operation, target, i + 1) +
      `\n\nThis is one item of a ${resolved.length}-target sweep. Touch only your target; identical work is happening on other targets in parallel.`,
    scope: scopeTemplates.map((s) => fill(s, target, i + 1)),
    tier: spec.tier ?? 'cheap',
    pool_hint: spec.pool_hint ?? 'auto',
  }));
  return {
    repo: spec.repo,
    base: spec.base ?? 'main',
    gate: spec.gate,
    caps: spec.caps,
    prosecution: spec.prosecution,
    tickets,
  };
}
