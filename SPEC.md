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
| A8 | All lib code covered by node:test (no live agy in default test run) | `npm test` green offline |
| A9 | install.sh wires skills into ~/.gemini/skills idempotently | run twice, second run no-ops |

## Non-goals (phase 1)

GUI automation, Linux sandbox, omagy interop, model-router float math
(static tier map first), lesson-foundry/skill-rot integration (phase 2+).

## Components

```
bin/agb.mjs          CLI: run | probe | status | plan (phase 2)
lib/agy.mjs          spawn wrapper: model, sandbox, timeout, sentinel check,
                     request ledger
lib/pools.mjs        pool map (model → quota pool), per-pool semaphores
lib/dag.mjs          tickets.json validation + topological ready-set
lib/worktrees.mjs    create/init/remove per ~/.claude/rules worktrees.md
lib/workers.mjs      builder lifecycle: AGENTS.md authoring, spawn, flail
                     timeout, two-strike regeneration
lib/prosecute.mjs    cross-model refute pass + verifier, verdict JSON
lib/gates.mjs        build/test gate runner, deterministic exit codes
lib/status.mjs       run.json writer + terminal dashboard
skills/              adlc-builder, adlc-prosecutor, adlc-integrator,
                     adlc-self-orchestrate (L3)
templates/           AGENTS.md ticket template, tickets.json schema+example
install.sh           symlink skills → ~/.gemini/skills, check agy present
```

## tickets.json schema (v1)

```json
{
  "repo": "/abs/path",
  "gate": { "build": "npm run typecheck", "test": "npm test" },
  "tickets": [
    {
      "id": "T1",
      "title": "...",
      "spec": "full self-contained instruction text",
      "scope": ["src/foo/**"],
      "deps": [],
      "tier": "cheap|mid|frontier",
      "pool_hint": "gemini|claude|auto"
    }
  ]
}
```

Builder model chosen by tier within the least-loaded allowed pool;
prosecutor model chosen from the *other* family, mid tier by default.
