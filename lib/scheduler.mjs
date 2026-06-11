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

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topoSort, globMatch } from '@aidlc/core/tickets';
import { runAgy } from './agy.mjs';
import { PoolSet } from './pools.mjs';
import { builderAgentsMd, builderPrompt, fixPrompt, regenPrompt } from './charters.mjs';
import { runGates } from './gates.mjs';
import { prosecute, blockingFindings } from './prosecute.mjs';
import {
  ensureGitignore, createWorktree, removeWorktree, pruneWorktrees,
  branchDiff, commitAll, mergeWorktree, changedFiles, abortAnyMerge,
} from './worktrees.mjs';
import { RunStatus } from './status.mjs';
import { acquireRepoLock } from './lock.mjs';

// agy enforces a ~5m ceiling on print-mode responses regardless of the
// flag value (calibration addendum) — size tickets to fit one ≤5m
// generation; a timeout consumes a strike like any other failure.
const BUILD_TIMEOUT = process.env.AGB_BUILD_TIMEOUT ?? '5m';

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

  // Serialize orchestrator runs per repo — concurrent merges + reverts on
  // one checkout corrupt state. Released in the finally below.
  const releaseLock = acquireRepoLock(repo, { runId });

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
    // Scratch cwd: prosecutors have tool access and will sometimes
    // materialize the diff to inspect it — never let that touch the repo.
    const scratch = mkdtempSync(join(tmpdir(), 'agb-prosecute-'));
    try {
      return await prosecute({
        ticket: t, diff: branchDiff(worktree, base), model, cwd: scratch,
        logFile: join(logDir, `${t.id}.prosecution.log`),
      });
    } finally {
      release();
      status.pools(pools.snapshot());
      rmSync(scratch, { recursive: true, force: true });
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
            // Sandbox worktree gates: the script being run lives in the
            // (untrusted) worktree and could have been rewritten by the
            // builder. The post-merge gate below runs on trusted main.
            const gates = runGates(gate, worktree, { sandbox: true });
            if (!gates.ok) {
              const g = gates.results.at(-1);
              lastFailure = `gate ${g.name} failed:\n${g.output}`;
            } else {
              // Loop-until-dry (ADLC F6): a single clean pass is a model
              // prior, not a coverage certificate. plan.prosecution.dryPasses
              // (default 1) sets how many consecutive fresh-context clean
              // passes are required before merge.
              const dryNeeded = plan.prosecution?.dryPasses ?? 1;
              let dry = 0;
              let verdict;
              while (dry < dryNeeded) {
                status.ticket(t.id, { phase: 'prosecuting', detail: `dry ${dry}/${dryNeeded}` });
                verdict = await prosecuteBranch(t, worktree, model);
                if (verdict.verdict !== 'ship') break;
                dry += 1;
              }
              if (dry >= dryNeeded) {
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
        prompt = regenPrompt(t, lastFailure);
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
      const headBefore = currentHead(repo);
      let gatePassed = false;
      try {
        mergeWorktree(repo, worktree, t.id, base);
        // Post-merge gate runs the just-merged (untrusted) test script, so it
        // is sandboxed too — merging does not launder a malicious gate script
        // into host execution. The sandbox allows writes to the repo itself.
        const post = runGates(gate, repo, { sandbox: true });
        if (!post.ok) {
          const g = post.results.at(-1);
          throw new Error(`post-merge gate ${g.name} failed:\n${g.output.slice(0, 300)}`);
        }
        gatePassed = true;
      } catch (err) {
        // Restore main to exactly where it was, whatever failed and however
        // far the merge got: abort an in-progress merge, then if a merge
        // commit landed (gate threw OR returned !ok) reset back to headBefore.
        // Keyed on "HEAD moved + gate not passed", NOT isMidMerge — a
        // completed merge whose gate *threw* is not mid-merge but must revert.
        try { abortAnyMerge(repo); } catch { /* nothing to abort */ }
        if (!gatePassed && currentHead(repo) !== headBefore) {
          try { resetHard(repo, headBefore); } catch { /* best effort */ }
        }
        throw err;
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

  try {
    dispatch();
    // Drain: new work is appended to `running` by dispatch() inside finally.
    let settled = 0;
    while (settled < running.length) {
      const batch = running.slice(settled);
      settled += batch.length;
      await Promise.allSettled(batch);
    }
  } finally {
    releaseLock();
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

function currentHead(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function resetHard(repo, sha) {
  execFileSync('git', ['reset', '--hard', sha], { cwd: repo });
}
