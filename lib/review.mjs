// Review fleet: parallel refute-chartered lenses over a diff, fresh
// contexts, loop until K consecutive dry rounds (ADLC P5 standalone — the
// highest-leverage adoption entry point: review without workflow change).
//
// No mutation, no worktrees. Each lens is one quota request per round.

import { execFileSync } from 'node:child_process';
import { extractJson } from '@aidlc/core/llm';
import { runAgy, familyOf } from './agy.mjs';

export const LENSES = {
  correctness: 'bugs, broken edge cases, error swallowing, race conditions, wrong logic',
  security: 'injection, secrets in code, unsafe input handling, authz/authn holes, SSRF',
  tests: 'deleted or skipped tests, vacuous assertions, mocked reality, coverage theater',
  contracts: 'breaking changes to exported APIs, schemas, types, or wire formats',
};

function lensPrompt(lensName, lensDesc, diff, context) {
  return `You are a prosecutor reviewing a code change through exactly one lens:
**${lensName}** — ${lensDesc}.

Charter: REFUTE the change — find concrete, checkable problems in your lens
ONLY. Findings outside your lens are someone else's job; omit them. If your
lens is clean, an empty findings array is the correct, complete answer.
Work from the diff text alone; do not create or run files.
${context ? `\n## Context\n\n${context}\n` : ''}
## Diff

\`\`\`diff
${diff}
\`\`\`

Respond with ONLY:
{"findings": [{"severity": "critical|high|medium|low", "file": "path",
  "line": "approx", "claim": "specific checkable claim", "evidence": "diff lines or reasoning"}]}`;
}

/** Get the diff for a branch/range/working tree in a repo. */
export function reviewDiff(repo, ref) {
  const args = ref ? ['diff', ref] : ['diff', 'HEAD'];
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const key = (f) => `${f.file}|${(f.claim ?? '').slice(0, 80).toLowerCase()}`;

/**
 * Run the fleet: each round fans all lenses in parallel (fresh contexts by
 * construction — every agy --print call is stateless), dedupes against
 * everything seen, and exits after `dryRounds` consecutive rounds with no
 * new findings, or at maxRounds (divergence = the diff is too big or the
 * context is wrong — escalate, don't iterate).
 *
 * Returns { findings, rounds, requests, converged }.
 */
export async function reviewFleet({
  diff, context, models, lenses = Object.keys(LENSES),
  dryRounds = 2, maxRounds = 5, pools, log = () => {},
}) {
  if (!diff?.trim()) return { findings: [], rounds: 0, requests: 0, converged: true };
  const seen = new Map();
  let dry = 0;
  let rounds = 0;
  let requests = 0;

  while (dry < dryRounds && rounds < maxRounds) {
    rounds += 1;
    const results = await Promise.all(
      lenses.map(async (lens, i) => {
        // Alternate model families across lenses for blind-spot diversity.
        const model = models?.[i % (models?.length ?? 1)] ??
          (i % 2 === 0 ? 'Claude Sonnet 4.6 (Thinking)' : 'Gemini 3.1 Pro (High)');
        const release = pools ? await pools.acquire(model) : () => {};
        try {
          requests += 1;
          const res = await runAgy({ model, prompt: lensPrompt(lens, LENSES[lens], diff, context), timeout: '5m' });
          if (!res.ok) return { lens, model, error: res.error, findings: [] };
          try {
            const parsed = extractJson(res.output);
            const findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
              .filter((f) => f && f.claim)
              .map((f) => ({ ...f, lens, model, family: familyOf(model) }));
            return { lens, model, findings };
          } catch {
            return { lens, model, error: 'unparseable', findings: [] };
          }
        } finally {
          release();
        }
      })
    );
    const fresh = results.flatMap((r) => r.findings).filter((f) => !seen.has(key(f)));
    for (const f of fresh) seen.set(key(f), f);
    log(`round ${rounds}: ${fresh.length} new finding(s), ${seen.size} total`);
    dry = fresh.length === 0 ? dry + 1 : 0;
  }

  return {
    findings: [...seen.values()],
    rounds,
    requests,
    converged: dry >= dryRounds,
  };
}
