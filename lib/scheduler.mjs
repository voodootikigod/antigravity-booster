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

import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topoSort, globMatch } from '@adlc/core/tickets';
import { runAgy } from './agy.mjs';
import { PoolSet } from './pools.mjs';
import { builderAgentsMd, builderPrompt, fixPrompt, regenPrompt } from './charters.mjs';
import { runGates } from './gates.mjs';
import { prosecute, blockingFindings } from './prosecute.mjs';
import { planTicketToAdlcTicket, writeAdlcTickets } from './adlc-bridge.mjs';
import {
  ensureGitignore, createWorktree, removeWorktree, pruneWorktrees,
  branchDiff, commitAll, mergeWorktree, changedFiles, abortAnyMerge,
  isDirty, deleteBranch, currentBranch, resetToBase,
} from './worktrees.mjs';
import { RunStatus } from './status.mjs';
import { acquireRepoLock } from './lock.mjs';

// agy enforces a ~5m ceiling on print-mode responses regardless of the
// flag value (calibration addendum) — size tickets to fit one ≤5m
// generation; a timeout consumes a strike like any other failure.
const BUILD_TIMEOUT = process.env.AGB_BUILD_TIMEOUT ?? '5m';
const execFileP = promisify(execFile);
const RAILS_GUARD_TIMEOUT_MS = 30_000;
const PLUGIN_CHECK_TIMEOUT_MS = 15_000;

/**
 * Post-hoc rail check (ADLC C5), the fast-fail confirmation behind the
 * plugin's live in-session hook. Calls the SAME rails-guard engine the
 * plugin uses (via --rails flags derived straight from the ticket, so this
 * works even against a target repo that isn't ADLC-initialized) instead of
 * a bespoke glob comparison, so booster and the plugin share one
 * enforcement engine. Fails closed: an operational error (adlc missing,
 * timeout, unparseable output) is treated as a violation, never as
 * silent success.
 */
async function checkRailsGuard({ worktree, base, rails, adlcBin }) {
  const bin = adlcBin ?? process.env.AGB_ADLC_BIN ?? 'adlc';
  const args = ['rails-guard', '--base', base, '--json'];
  for (const r of rails) args.push('--rails', r);
  try {
    await execFileP(bin, args, { cwd: worktree, timeout: RAILS_GUARD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return { violations: [] }; // exit 0 — no violations
  } catch (err) {
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout);
        return { violations: (parsed.violations ?? []).map((v) => v.file ?? JSON.stringify(v)) };
      } catch { /* fall through to the operational-error path below */ }
    }
    return { violations: [`adlc rails-guard operational error: ${err.message}`] };
  }
}

/**
 * Live in-session rail enforcement (ADLC P3) needs the target repo to be
 * ADLC-initialized AND the adlc-antigravity plugin installed. Checked once
 * per run, not per ticket. When unavailable, booster fails CLOSED on the
 * live layer and says so — it does not silently degrade to prompt-only
 * discipline; the post-hoc adlc rails-guard check above remains active
 * regardless (it has no such dependency).
 */
async function checkEnforcementAvailable(repo, { agyBin } = {}) {
  if (!existsSync(join(repo, '.adlc'))) {
    return { available: false, reason: 'target repo is not ADLC-initialized (no .adlc/ directory) — live rail enforcement disabled, post-hoc adlc rails-guard still runs' };
  }
  const bin = agyBin ?? process.env.AGB_AGY_BIN ?? 'agy';
  try {
    const { stdout } = await execFileP(bin, ['plugin', 'list'], { timeout: PLUGIN_CHECK_TIMEOUT_MS });
    if (!stdout.includes('adlc-antigravity')) {
      return { available: false, reason: 'adlc-antigravity plugin not installed (agy plugin list did not list it) — live rail enforcement disabled, post-hoc adlc rails-guard still runs' };
    }
    return { available: true, reason: null };
  } catch (err) {
    return { available: false, reason: `could not verify adlc-antigravity plugin presence: ${err.message} — live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
  }
}

/**
 * Run a full plan. plan = { repo, base?, gate, caps?, tickets } where
 * tickets use the adlc schema (+ tier, pool_hint extensions).
 * Returns the final report; exit-code policy belongs to the caller.
 */
export async function runPlan(plan, { log = console.error } = {}) {
  const { repo, gate } = plan;
  const base = plan.base ?? 'main';
  const tickets = plan.tickets;
  const { cycle } = topoSort(tickets);
  if (cycle) throw new Error(`cycle in ticket DAG: ${cycle.join(', ')}`);

  // Reject structurally broken plans before the lock is taken or the repo
  // touched: duplicate ids collide on one worktree/branch across concurrent
  // builders, and an edge to an unknown id would TypeError mid-run after
  // ensureGitignore already committed (adversarial-review MEDIUM). Callers
  // that bypass `agb validate` (programmatic runPlan, sweep) get the same
  // guarantee.
  const ticketIds = new Set();
  for (const t of tickets) {
    if (ticketIds.has(t.id)) throw new Error(`duplicate ticket id: ${t.id}`);
    ticketIds.add(t.id);
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (!ticketIds.has(e.to)) throw new Error(`${t.id}: edge to unknown ticket '${e.to}'`);
    }
  }

  // The main repo must be ON the base branch: merges and `git reset --hard`
  // rollbacks act on whatever branch is checked out, so a different branch
  // would be merged into / reset by mistake.
  const onBranch = currentBranch(repo);
  if (onBranch !== base) {
    throw new Error(`repo ${repo} is on '${onBranch}', not the plan's base '${base}'. ` +
      `Checkout ${base} before running (agb merges into and resets the checked-out branch).`);
  }

  // Refuse to run on a dirty repo: integration uses `git reset --hard` to
  // roll back failed merges, which would destroy uncommitted work. Fail
  // before touching anything. Override with AGB_ALLOW_DIRTY=1 at own risk.
  if (process.env.AGB_ALLOW_DIRTY !== '1' && isDirty(repo)) {
    throw new Error(`repo ${repo} has uncommitted changes — commit or stash first ` +
      `(agb uses 'git reset --hard' for merge rollback and would discard them). ` +
      `Set AGB_ALLOW_DIRTY=1 to override.`);
  }

  const pools = new PoolSet(plan.caps);
  const runId = `run-${Date.now().toString(36)}`;
  const status = new RunStatus(repo, runId);
  const logDir = join(repo, '.booster', 'logs', runId);

  // Serialize orchestrator runs per repo — concurrent merges + reverts on
  // one checkout corrupt state. Released in the finally below.
  const releaseLock = acquireRepoLock(repo, { runId });

  ensureGitignore(repo);
  pruneWorktrees(repo);

  // Live rail enforcement availability is a run-level fact, checked once —
  // not re-verified per ticket. A clear, non-silent warning either way
  // (AC3): callers must not have to dig through logs to learn the run had
  // no live in-session protection.
  const enforcement = await checkEnforcementAvailable(repo);
  if (!enforcement.available) {
    log(`⚠ live rail enforcement unavailable: ${enforcement.reason}`);
  }

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
        // Scoped to THIS spawn only (runAgy merges onto process.env, never
        // mutates it) — concurrent tickets building in the same booster
        // process must not see each other's active-ticket signal.
        env: enforcement.available ? { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: t.id } : undefined,
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
    // route() can throw (no candidate for tier+pool_hint) — it must do so
    // INSIDE the try so the ticket lands in `failed` instead of vanishing
    // from the report while the run exits 0 (adversarial-review HIGH).
    let model;
    let worktree;
    try {
      model = pools.route(t.tier ?? 'mid', t.pool_hint);
      worktree = createWorktree(repo, t.id, base);
      writeFileSync(join(worktree, 'AGENTS.md'), builderAgentsMd(t, gate));
      // Materialize this ticket into the plugin's expected shape so its
      // PreToolUse hook (ADLC_P4_ENFORCEMENT + ADLC_TICKET, set on the
      // builder's agy invocation below) can resolve the same rails this
      // scheduler enforces post-hoc. A pure projection (lib/adlc-bridge.mjs) —
      // no fields invented beyond what the ticket already declares.
      if (enforcement.available) {
        writeAdlcTickets(worktree, [planTicketToAdlcTicket(t)]);
      }

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
          // Mechanical change-set checks (adversarial-review MEDIUM: these
          // were charter prose only — adlc-doctrine promises "editing a rail
          // is detected and rejected", so detect and reject here, not in the
          // model's conscience). AGENTS.md is orchestrator-authored and never
          // committed (commitAll excludes it) but stays filtered for safety.
          //
          // Rails are checked INDEPENDENTLY of scope: a rail glob inside a
          // broad scope glob must still fail the strike. Empty scope skips
          // only the scope check (documented: `agb validate` requires a
          // non-empty scope; programmatic callers opting out still get rails).
          const changed = changedFiles(worktree, base).filter((f) => f !== 'AGENTS.md');
          const rails = t.rails ?? [];
          const railCheck = rails.length ? await checkRailsGuard({ worktree, base, rails }) : { violations: [] };
          const outOfScope = !t.scope?.length ? [] : changed.filter(
            (f) => !t.scope.some((g) => globMatch(g, f))
          );
          if (railCheck.violations.length) {
            lastFailure = `rail violation (read-only paths edited, per adlc rails-guard): ${railCheck.violations.join(', ')}`;
            resetToBase(worktree, base); // next strike starts clean, not atop the violation
          } else if (outOfScope.length) {
            lastFailure = `out-of-scope changes: ${outOfScope.join(', ')}`;
            resetToBase(worktree, base);
          } else {
            status.ticket(t.id, { phase: 'gating' });
            // Sandbox worktree gates: the script being run lives in the
            // (untrusted) worktree and could have been rewritten by the
            // builder. The post-merge gate below runs on trusted main.
            const gates = await runGates(gate, worktree, { sandbox: true });
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
      if (model) pools.unroute(model); // release the builder pool assignment for this ticket
      if (worktree && !merged.has(t.id)) {
        try { removeWorktree(repo, worktree, { force: true }); } catch { /* leave for prune */ }
        deleteBranch(repo, t.id); // drop the orphan branch so re-runs don't collide
      }
      dispatch();
    }
  }

  async function integrate(t, worktree) {
    status.ticket(t.id, { phase: 'merging' });
    // Chain on the lock but never store a rejected promise as the lock —
    // one failed merge must not poison every later merge.
    const turn = mergeLock.then(async () => {
      // Re-verify under the lock: the start-of-run branch/clean checks can go
      // stale during a long run if the user switches branches or dirties main.
      // Merging/resetting the wrong branch would destroy their work.
      const onBranch = currentBranch(repo);
      if (onBranch !== base) {
        throw new Error(`repo left base branch mid-run (now on '${onBranch}', expected '${base}') — skipping ${t.id} to avoid merging/resetting the wrong branch`);
      }
      if (process.env.AGB_ALLOW_DIRTY !== '1' && isDirty(repo)) {
        throw new Error(`repo became dirty mid-run — skipping ${t.id} to avoid 'git reset --hard' destroying uncommitted work`);
      }
      const headBefore = currentHead(repo);
      let gatePassed = false;
      try {
        mergeWorktree(repo, worktree, t.id, base);
        // Post-merge gate runs the just-merged (untrusted) test script
        // sandboxed (writes confined to the repo minus .git/node_modules,
        // network denied) — merging does not launder a malicious gate script
        // into host execution.
        const post = await runGates(gate, repo, { sandbox: true });
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
        // Finally clean untracked files the failed gate dropped (build
        // artifacts/payloads); -d only, never -x, so ignored node_modules is
        // preserved and the start-of-run clean check means nothing legit is lost.
        try { abortAnyMerge(repo); } catch { /* nothing to abort */ }
        if (!gatePassed && currentHead(repo) !== headBefore) {
          try { resetHard(repo, headBefore); } catch { /* best effort */ }
          try { cleanUntracked(repo); } catch { /* best effort */ }
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
    enforcementAvailable: enforcement.available,
    enforcementReason: enforcement.reason,
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

// Remove untracked files a failed gate created. -d (dirs) but NOT -x, so
// gitignored deps (node_modules) are left intact. Safe because the run
// refused to start on a dirty tree, so any untracked file here is gate debris.
function cleanUntracked(repo) {
  execFileSync('git', ['clean', '-fd'], { cwd: repo });
}
