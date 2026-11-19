---
name: adversarial-review
description: Adversarial multi-agent review of a plan or code diff: fans out isolated reviewer personas (correctness/red-team, simplicity, security, evidence, anti-slop), a neutral arbiter triages findings, the author rebuts, and only the contested residue escalates to you. Use when running a Code gate or Plan gate review, deslop/clean-code review, multi-perspective code review, or hardening a plan before implementation.
---

# adversarial-review

Multi-perspective review that fans out isolated reviewers, filters their output
through a neutral arbiter, lets the author rebut, and escalates only the small
contested residue to the human. Two gates: **plan** (lightweight or iterative
Plan ARL) and **code** (full loop).

## When to use this

-   Reviewing a plan or specification before implementation (plan gate).
-   Reviewing a branch, pull request, or working-tree diff before merging (code
    gate).
-   "Adversarially review this", "deslop this", multi-perspective / clean-code
    review.

## Core invariants (apply to both gates)

-   **Isolation** — reviewers never see each other's findings, and never see the
    author's rationale. Run them as separate parallel workers.
-   **Grounding** — reviewers get the requirement (spec/ticket) + the diff, NOT
    the author's justification. They judge against what was asked.
-   **Evidence-or-downweight** — every finding carries an `evidence` field
    (`schema/finding.json`). `evidence: null` + low confidence is
    auto-downweighted by the arbiter.
-   **Arbiter owns "is it real"; author owns "what's the fix."** Disputes route
    back to the arbiter, never straight to rejection.
-   **Severity floor + cap** — arbiter drops below `minor` (category-aware: auth
    / migration / data-loss paths are never nits) and surfaces only top-N by
    `severity × confidence`.

## Persona files

Each reviewer reads only its own charter, in its own isolated worker. Do not
inline these into a worker prompt beyond a pointer — the worker reads the file.

File                                     | Role
---------------------------------------- | ----
`personas/plan_devils_advocate.md`       | Plan: challenge the approach
`personas/plan_simplicity.md`            | Plan: YAGNI / over-engineering
`personas/plan_requirements_fidelity.md` | Plan: does it solve the requirement as written
`personas/plan_evidence_strategy.md`     | Plan: is there a before/after evidence-capture plan
`personas/plan_dag_topology.md`          | Plan: ticket DAG topology, scope disjointness, coldstart/parallax
`personas/code_correctness_redteam.md`   | Code: find the bug
`personas/code_simplicity.md`            | Code: scope / speculative generality
`personas/code_security.md`              | Code: security & privacy
`personas/code_evidence_runner.md`       | Code: run tests / build / lint
`personas/code_anti_slop.md`             | Code: craft, restraint, readability
`personas/stack_decomposition.md`        | Stacked branches: is the split good (atomic, reviewable, correct layering)
`personas/arbiter.md`                    | Triage, dedup, severity floor, adjudicate disputes
`personas/author_rebuttal.md`            | Author: fix or dispute each finding

## Code gate — full loop

State lives in `.review/<ref>/round-<N>/`.

1.  **Gather context** (orchestrator, read-only). Get the requirement (spec or
    issue text) and the git diff (`git diff <ref>`). Write both to
    `.review/<ref>/round-<N>/context.md`. **Do not include the author's
    rationale.**
2.  **Fan out the panel** in parallel using `~/.local/bin/agb review [repo] [ref] --five-lens`
    (or `mcp__agb__agb_review` with `fiveLens: true`), which routes each lens via
    `code_lenses` in `references/models.json` across `gemini` and `claude` model
    families with read-only worker enforcement (`AGB_WORKER_MODE=readonly`) and
    stdin prompt delivery (never interpolate untrusted diff or spec text inside
    double-quoted shell arguments), or via isolated subagent invocation using the
    lens's tier (`pro` or `flash`). Five subtasks, each:
    > "Adopt the reviewer in `<persona file>`. Read `context.md`. You MAY read
    > the repo for surrounding code. Emit findings as a JSON array matching
    > `schema/finding.json` to `.review/<ref>/round-<N>/findings.<lens>.json`."
    Lenses: `correctness_redteam`, `simplicity`, `security`, `evidence_runner`,
    `anti_slop`.
3.  **Arbiter triage** (fresh worker routed to the `arbiter` entry in
    `references/models.json`; `personas/arbiter.md`): read all
    `findings.*.json` + diff + requirement → dedup → severity floor → cap top-N
    → write `triaged.json` with each item marked `drop | accept-candidate |
    escalate`.
4.  **Author rebuttal** (resume the authoring session if available, or invoke a
    subagent with full context; `personas/author_rebuttal.md`): for each
    accept-candidate, respond `fix` (apply the change) or `dispute:<reason>`.
5.  **Adjudicate disputes** — send disputes back to the arbiter for **one**
    round; it upholds or drops each.
6.  **Escalate to the human ONLY**: author-disputed-and-upheld, any blast-radius
    category (data loss, irreversible migration, security/privacy, auth), and
    any high-confidence blocker the arbiter dropped. Present these; auto-apply
    the rest.
7.  **Convergence** — on re-run, review only the delta introduced by the fixes,
    cap at 2 full passes; the final pass may only `block`, never raise fresh
    nits.
8.  **Metrics** — append one line to `.review/<ref>/metrics.jsonl`: `{round,
    findings_total, accepted, disputed, upheld, escalated}`.

## Plan gate — 5-lens briefing or iterative Plan ARL (`--loop`)

1.  Gather context: the requirement/issue + the plan +
    `agb shape <spec.md> --json` pre-analysis output →
    `.review/plan-<id>/round-<N>/context.md`.
2.  Fan out 5 subtasks in parallel via `~/.local/bin/agb review [repo] --plan <spec.md> [--loop]`
    (or `mcp__agb__agb_review` with `plan: "<spec.md>"`), routed via `plan_lenses` in
    `references/models.json` (with `AGB_WORKER_MODE=readonly` and stdin prompt
    delivery, or isolated subagent invocation with the mapped tier): `devils_advocate`,
    `simplicity`, `requirements_fidelity`, `evidence_strategy`, `dag_topology` →
    `findings.<lens>.json`.
3.  Arbiter triage (routed to the `arbiter` model in `references/models.json`).
4.  **Default Single-Pass Mode (`/plan-review`)**: Present the ranked briefing
    to the human, who adjudicates the approach directly. No author rebuttal, no
    auto-apply — the human is the arbiter of "right approach."
5.  **Iterative Plan ARL Mode (`/plan-review --loop`, invoked by `/agb-shape`
    and `/agb`)**: Capped at 3 rounds. The arbiter tags each `accept-candidate`
    finding with `resolution_route: "auto-fix" | "grill-me"` and emits
    `gate_verdict: "SHIP" | "ITERATE"`:
    -   For `"auto-fix"` findings: fix the spec directly, re-run
        `agb shape <spec.md> --json`, and re-verify in the next round.
    -   For `"grill-me"` findings: bounce back to `/grill-me` (`ask_question`)
        to resolve the genuine product/design trade-off with the user, update
        the spec, and re-verify.
    -   When `gate_verdict: "SHIP"` is reached (zero `blocker`/`major` findings
        and `agb shape` exits `0`), sync the hardened spec to the Antigravity
        Brain Artifact (`agb shape <spec.md> --sync-brain`) for Human Sign-Off
        before `agb plan`. If 3 rounds are exhausted without `SHIP`, fail closed
        and escalate remaining findings to the user.

## Stacked Branches / PRs (dependent stack of N changes)

A dependent stack is NOT N independent Code gates. Reviewing each branch in
isolation manufactures false positives (a helper looks unused, code looks
untested/undefended) because the caller/consumer/tests arrive in a later branch.
So reviewers must be **stack-aware**, and the work splits into a stack-level
pass plus a reduced, stack-aware per-branch pass.

-   **Pass 1 — stack-level (run ONCE over the union + manifest), 3 lenses routed
    via `plan_lenses` / `code_lenses` in `references/models.json`:**
    `stack_decomposition`, `requirements_fidelity`, `simplicity`.
-   **Pass 2 — per-branch, BOTTOM-UP, stack-aware, 4 lenses each routed via
    `code_lenses` in `references/models.json`:**
    `correctness_redteam`, `security`, `anti_slop`, `evidence_runner`.
-   Findings carry `target_ref`; route each fix to the branch it belongs in,
    fixing bottom-up.

### Keeping the Model Catalog Up to Date

Whenever Antigravity releases or retires models in `agy models`, audit drift against the bundled `lib/models.mjs` catalog or regenerate `references/models.json` from inside an `antigravity-booster` repository checkout:

```bash
# Audit live models against lib/models.mjs and check for drift (exits 1 on drift)
~/.local/bin/agb sync-models --check

# Regenerate skills/adversarial-review/references/models.json (antigravity-booster repo checkout only; does not mutate lib/models.mjs or lib/pools.mjs)
~/.local/bin/agb sync-models --write
```

## Output Schemas

-   **Per-Lens Findings (`schema/finding.json`)**: Every isolated reviewer worker
    emits a JSON array of objects conforming to `schema/finding.json` into
    `.review/<ref>/round-<N>/findings.<lens>.json` (fields: `id`, `lens`,
    `severity`, `confidence`, `location`, `claim`, `evidence`, `suggested_fix`,
    `blast_radius`, `verdict`, `resolution_route`, and optional `target_ref` for
    stacks).
