# antigravity-booster — Specification

Make Antigravity 2.0 (`agy` CLI + GUI) effective for large parallel
build-outs by implementing the ADLC (../aidlc/ADLC.md) on top of it:
deterministic orchestrator, quota-pool-aware scheduling, cross-model
prosecution, gate-shaped lifecycle from ideation to validation.

## Premise corrections (from research — see docs/research/)

1. Tokens are NOT infinite: weekly request quotas, separate per-model pools,
   7-day lockouts. The harness is **quota-aware by design**.
2. agy parallelizes fine up to ~6-8 per pool; **cross-pool routing is the
   real concurrency multiplier** (verified: 4 Gemini + 4 Claude concurrent,
   no mutual interference).
3. Worker context delivery is solved natively: AGENTS.md per worktree +
   global skills in ~/.gemini/skills.

## Architecture (all four, layered)

| Layer | What | Phase |
|---|---|---|
| L1 Config | Skills, charters, AGENTS.md templates installed into ~/.gemini — improves any agy/GUI session standalone | 1 |
| L2 Engine | `agb` orchestrator: deterministic Node ESM scheduler spawning `agy --print` workers in worktrees | 1 |
| L3 Recursive | Skill instructing a top-level agy session to drive `agb` itself (self-orchestration) | 2 |
| L4 Hybrid | GUI brain-artifact ingestion (plan made in GUI → tickets.json → fleet) | 3 |

## Decision record

- Doctrine: ADLC P0–P7; orchestrator is code, judgment is models (D0).
- Models tiered by role: cheap=Gemini 3.5 Flash, mid=Claude Sonnet 4.6 /
  Gemini 3.1 Pro, frontier=Claude Opus 4.6 / Gemini 3.1 Pro (High).
- Cross-model prosecution: Gemini-built code prosecuted by Claude and vice
  versa (fresh context + refute charter are primary; cross-model is bonus).
- Validation gate: build + tests green, mechanical.
- Builders: `--sandbox` in isolated worktrees (probed safe for git/npm/node).
  Prosecutors/readers: read-only charters.
- aidlc gets an `agy` subprocess provider (AIDLC_PROVIDER=agy) so parallax,
  coldstart, premortem, consensus-fix, etc. run on Antigravity quota.
- Zero-dep Node ESM, node:test, deterministic exit codes (0 pass / 2 gate
  fail), npx-runnable.

## Phase 1 acceptance criteria (each names its verification)

| # | Criterion | Verification |
|---|---|---|
| A1 | aidlc `agy` provider completes a real prompt through every tier | `AIDLC_PROVIDER=agy node --test` in aidlc/packages/core (live test, opt-in env) |
| A2 | `agb probe` measures pool latency/width and writes docs/calibration | run it; file exists with table |
| A3 | `agb run <tickets.json>` executes a DAG of tickets across ≥3 parallel workers in worktrees, per-pool concurrency caps enforced | live smoke run on sample repo |
| A4 | Every worker's diff is prosecuted by a different model family; verified findings block merge | smoke run log shows prosecutor model ≠ builder model; injected-bug ticket gets blocked |
| A5 | Merge gate: typecheck/tests green before sequential merge; failed gate → ticket marked failed, no merge | smoke run shows a red ticket not merged |
| A6 | `agb status` renders live run state from .booster/run.json | run during smoke; shows workers, phases, models, request counts |
| A7 | Request accounting: run report totals agy calls per pool | .booster/report.json after smoke run |
| A8 | All lib code covered by node:test (no live agy in default test run) | `npm test` green offline on any platform (sandbox-specific tests are darwin-gated; scheduler tests run gates unsandboxed) |
| A9 | install.sh wires skills into ~/.gemini/skills idempotently | run twice, second run no-ops |

## Known design tradeoffs

- **Rebase without re-prosecution** (adversarial-review, accepted): when a
  ticket branch is rebased onto an advanced base before merge, the combined
  diff is verified by the deterministic post-merge gate (build + tests) but
  is NOT re-run through cross-model prosecution. Full re-prosecution per merge
  would roughly double prosecution quota; the post-merge gate catches
  behavioral regressions, and clean-but-semantically-drifted rebases are the
  same residual risk any merge queue carries. Raise `prosecution.dryPasses`
  or add a dedicated re-prosecute step if a project needs it.
- **File-based repo lock** is best-effort zero-dep (atomic mkdir + atomic
  rename reclaim); a flock(2) OS lock would be strictly stronger but needs a
  native binding.
- **Untracked-file window during post-merge gates** (adversarial-review,
  accepted): the dirty-repo check is point-in-time (re-checked under the
  merge lock), but a post-merge gate can run for minutes; an untracked file
  the user creates in the main checkout *during* that window is deleted by
  the revert path's `git clean -fd` if the gate fails. Don't hand-edit the
  checkout while a run is live (the run lock signals this); a pre-merge
  untracked-file snapshot would close the window at the cost of extra git
  calls per merge.

## Non-goals (phase 1)

GUI automation, Linux sandbox, omagy interop, model-router float math
(static tier map first), lesson-foundry/skill-rot integration (phase 2+).

## Components

```
bin/agb.mjs          CLI: run | sweep | review | preflight | brains |
                     import-brain | status | probe | validate
lib/agy.mjs          spawn wrapper: model, sandbox, timeout, sentinel check,
                     request ledger
lib/pools.mjs        pool map (model → quota pool), per-pool semaphores,
                     tier routing
lib/scheduler.mjs    DAG ready-set dispatch + builder lifecycle: AGENTS.md
                     authoring, spawn, two-strike regeneration, scope/rails
                     enforcement, sequential merge
lib/worktrees.mjs    create/init/remove per ~/.claude/rules worktrees.md
lib/prosecute.mjs    cross-model refute pass + verifier, verdict JSON
lib/gates.mjs        build/test gate runner (sandboxed), deterministic exit codes
lib/charters.mjs     builder/prosecutor charter rendering (AGENTS.md, prompts)
lib/status.mjs       run.json writer + terminal dashboard
lib/lock.mjs         per-repo run lock (atomic mkdir + rename reclaim)
lib/sweep.mjs        sweep.json → plan (same op × many targets)
lib/preflight.mjs    plan-time gates: scope overlap + coldstart
lib/review.mjs       read-only lens fleet over a diff, loop-until-dry
lib/brain.mjs        Antigravity GUI plan artifact → plan.json (L4)
skills/              adlc-doctrine (builder+integrator charters),
                     adlc-prosecutor, adlc-self-orchestrate (L3)
templates/           plan.example.json (schema by example)
install.sh           symlink skills → ~/.gemini/skills, check agy present
```

## plan.json schema (v1 — the aidlc ticket schema + tier/pool_hint)

```json
{
  "repo": "/abs/path",
  "base": "main",
  "gate": { "build": "npm run typecheck", "test": "npm test" },
  "tickets": [
    {
      "id": "T1",
      "title": "...",
      "body": "full self-contained instruction text (required, non-empty)",
      "scope": ["src/foo/**"],
      "rails": ["src/contracts/**"],
      "edges": [{ "to": "T3" }],
      "tier": "cheap|mid|frontier",
      "pool_hint": "gemini|claude|auto"
    }
  ]
}
```

Field notes: `body` (not `spec`) carries the instruction text and is
required — `agb validate` rejects a missing/empty body because the builder
charter would render an empty specification. Dependencies are `edges`
(`{to}` objects, this-ticket-blocks-`to`), not a `deps` list. `scope` must
be a non-empty glob list (empty scope would disable the out-of-scope
check); `rails` are read-only globs enforced mechanically after every
strike, independent of scope. `tier`+`pool_hint` must be routable (e.g.
`cheap`+`claude` is rejected at validate time — the cheap tier has no
Claude-family candidate).

Builder model chosen by tier within the least-loaded allowed pool;
prosecutor model chosen from the *other* family, mid tier by default.
