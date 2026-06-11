// The orchestrator loop (ADLC D0: control flow is code, judgment is models).
//
// Ticket lifecycle:
//   pending → building (agy in worktree) → gating (build+test) →
//   prosecuting (cross-model refute) → [fixing → gating → prosecuting]¹ →
//   merging (sequential, rebase-first) → merged | failed
//
// Dispatch is event-driven: a ticket becomes ready the moment its edge
// predecessors merge (no wave barriers). Two-strike rule: one regeneration
// with failure context appended, then the ticket fails (the ticket is
// wrong, not the agent — ADLC P4).

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { topoSort, globMatch } from '@aidlc/core/tickets';
import { runAgy } from './agy.mjs';
import { PoolSet } from './pools.mjs';
import { builderAgentsMd, builderPrompt, fixPrompt } from './charters.mjs';
import { runGates } from './gates.mjs';
import { prosecute, blockingFindings } from './prosecute.mjs';
import {
  ensureGitignore, createWorktree, removeWorktree, pruneWorktrees,
  branchDiff, commitAll, mergeWorktree, changedFiles,
} from './worktrees.mjs';
import { RunStatus } from './status.mjs';

const BUILD_TIMEOUT = process.env.AGB_BUILD_TIMEOUT ?? '15m';

/**
 * Run a full plan. plan = { repo, base?, gate, caps?, tickets } where
 * tickets use the aidlc schema (+ tier, pool_hint extensions).
 * Returns the final report; exit-code policy belongs to the caller.
 */
export async function runPlan(plan, { log = console.error } = {}) {
  const { repo, gate } = plan;
  const base = plan.base ?? 'main';
  const tickets = plan.tickets;
  const { cycle } = topoSort(tickets);
  if (cycle) throw new Error(`cycle in ticket DAG: ${cycle.join(', ')}`);

  const pools = new PoolSet(plan.caps);
  const runId = `run-${Date.now().toString(36)}`;
  const status = new RunStatus(repo, runId);
  const logDir = join(repo, '.booster', 'logs', runId);

  ensureGitignore(repo);
  pruneWorktrees(repo);

  const preds = Object.fromEntries(tickets.map((t) => [t.id, []]));
  for (const t of tickets) for (const e of t.edges ?? []) preds[e.to].push(t.id);

  const merged = new Set();
  const failed = new Map(); // id → reason
  const started = new Set();
  const running = [];

  // Merges serialize (integrator lane). A simple promise chain is the lock.
  let mergeLock = Promise.resolve();

  for (const t of tickets) status.ticket(t.id, { phase: 'pending' });

  const isReady = (t) =>
    !started.has(t.id) &&
    preds[t.id].every((p) => merged.has(p)) &&
    preds[t.id].every((p) => !failed.has(p));

  async function buildOnce(t, worktree, model, prompt) {
    const release = await pools.acquire(model);
    status.pools(pools.snapshot());
    try {
      return await runAgy({
        model, prompt, cwd: worktree, sandbox: true, timeout: BUILD_TIMEOUT,
        logFile: join(logDir, `${t.id}.log`),
      });
    } finally {
      release();
      status.pools(pools.snapshot());
    }
  }

  async function prosecuteBranch(t, worktree, builderModel) {
    const model = pools.prosecutorFor(builderModel);
    const release = await pools.acquire(model);
    status.pools(pools.snapshot());
    try {
      return await prosecute({
        ticket: t, diff: branchDiff(worktree, base), model, cwd: repo,
        logFile: join(logDir, `${t.id}.prosecution.log`),
      });
    } finally {
      release();
      status.pools(pools.snapshot());
    }
  }

  async function runTicket(t) {
    started.add(t.id);
    const model = pools.route(t.tier ?? 'mid', t.pool_hint);
    let worktree;
    try {
      worktree = createWorktree(repo, t.id, base);
      writeFileSync(join(worktree, 'AGENTS.md'), builderAgentsMd(t, gate));

      let strikes = 0;
      let prompt = builderPrompt(t);
      let lastFailure = '';

      while (strikes < 2) {
        strikes += 1;
        status.ticket(t.id, { phase: 'building', model, strikes });
        const build = await buildOnce(t, worktree, model, prompt);
        if (!build.ok) {
          lastFailure = `agent error: ${build.error}`;
        } else if (/TICKET-BLOCKED/.test(build.output)) {
          lastFailure = `agent blocked: ${build.output.match(/TICKET-BLOCKED:?\s*(.*)/)?.[1] ?? ''}`;
        } else {
          commitAll(worktree, `${t.id}: ${t.title} (strike ${strikes})`);
          // Scope check: out-of-scope changes are a finding, not a merge.
          const outOfScope = (t.scope?.length ? changedFiles(worktree, base) : []).filter(
            (f) => f !== 'AGENTS.md' && !t.scope.some((g) => globMatch(g, f))
          );
          if (outOfScope.length) {
            lastFailure = `out-of-scope changes: ${outOfScope.join(', ')}`;
          } else {
            status.ticket(t.id, { phase: 'gating' });
            const gates = runGates(gate, worktree);
            if (!gates.ok) {
              const g = gates.results.at(-1);
              lastFailure = `gate ${g.name} failed:\n${g.output}`;
            } else {
              status.ticket(t.id, { phase: 'prosecuting' });
              const verdict = await prosecuteBranch(t, worktree, model);
              if (verdict.verdict === 'ship') {
                await integrate(t, worktree);
                return;
              }
              if (verdict.verdict === 'error') {
                lastFailure = `prosecution error: ${verdict.error}`;
              } else {
                const blocking = blockingFindings(verdict.findings);
                status.ticket(t.id, { phase: 'fixing', detail: `${blocking.length} findings` });
                lastFailure = null;
                prompt = fixPrompt(t, blocking);
                continue; // fix round consumes a strike
              }
            }
          }
        }
        // Regeneration: fresh prompt with known dead-ends appended (never
        // coach a rotted context — each agy --print call is fresh anyway).
        prompt = builderPrompt(t) + `\n\nKnown failed approach from a previous attempt:\n${lastFailure}\nAvoid repeating it.`;
      }
      throw new Error(lastFailure ?? 'two strikes exhausted');
    } catch (err) {
      failed.set(t.id, String(err.message ?? err));
      status.ticket(t.id, { phase: 'failed', detail: String(err.message ?? err).slice(0, 200) });
      log(`✗ ${t.id}: ${err.message}`);
    } finally {
      if (worktree && !merged.has(t.id)) {
        try { removeWorktree(repo, worktree, { force: true }); } catch { /* leave for prune */ }
      }
      dispatch();
    }
  }

  async function integrate(t, worktree) {
    status.ticket(t.id, { phase: 'merging' });
    // Chain on the lock but never store a rejected promise as the lock —
    // one failed merge must not poison every later merge.
    const turn = mergeLock.then(async () => {
      mergeWorktree(repo, worktree, t.id, base);
      // Post-merge gate on base catches cross-ticket integration breaks.
      const post = runGates(gate, repo);
      if (!post.ok) {
        const g = post.results.at(-1);
        revertMerge(repo);
        throw new Error(`post-merge gate ${g.name} failed — merge reverted:\n${g.output.slice(0, 300)}`);
      }
      merged.add(t.id);
      removeWorktree(repo, worktree, { force: true }); // force: AGENTS.md is uncommitted by design
      status.ticket(t.id, { phase: 'merged' });
      log(`✓ ${t.id} merged`);
    });
    mergeLock = turn.catch(() => {});
    await turn;
  }

  function dispatch() {
    for (const t of tickets) {
      if (isReady(t)) running.push(runTicket(t));
    }
    // Tickets whose predecessors failed can never run — fail them through.
    for (const t of tickets) {
      if (!started.has(t.id) && preds[t.id].some((p) => failed.has(p))) {
        started.add(t.id);
        failed.set(t.id, `blocked by failed predecessor`);
        status.ticket(t.id, { phase: 'blocked' });
      }
    }
  }

  dispatch();
  // Drain: new work is appended to `running` by dispatch() inside finally.
  let settled = 0;
  while (settled < running.length) {
    const batch = running.slice(settled);
    settled += batch.length;
    await Promise.allSettled(batch);
  }

  const report = {
    runId,
    merged: [...merged],
    failed: Object.fromEntries(failed),
    requests: pools.snapshot().requests,
  };
  status.finish(report);
  return report;
}

function revertMerge(repo) {
  execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: repo });
}
