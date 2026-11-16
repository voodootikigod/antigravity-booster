---
name: agb-shape
description: Shape a raw feature idea or concept into a hardened, DAG-validated specification via reconnaissance, /grill-me alignment, deterministic DAG pre-analysis (agb shape), a 5-lens Plan Adversarial Review Loop, and a Human Sign-Off Gate before agb plan.
---

# /agb-shape <idea | spec.md> [--yolo] [--out specs/<slug>-spec.md]

Shapes an initial idea or feature concept into a complete, DAG-validated
specification (`specs/<slug>-spec.md`) ready for `agb plan` compilation without
Stage A/B recycling.

## 5-Step Shaping & Hardening Pipeline

### Step 1: Codebase Reconnaissance

-   Search the repository for existing modules, conventions, frozen rails
    (`lib/lock.mjs`, `lib/gates.mjs`, etc.), and test gate commands (`npm test`,
    `pytest`, etc.).
-   Ground every file path, export signature, and architectural boundary in real
    repository state before interviewing or drafting.

### Step 2: `/grill-me` Alignment Loop (Interactive by Default)

-   **Standard Interactive Mode (Default)**: Interview the user **one decision
    branch at a time** using `ask_question` with `(Recommended)` defaults until
    all scope, architecture, edge-case, and acceptance-criteria ambiguities are
    resolved.
-   **Tier 1 Autonomous Shaping (`--yolo`)**: Skip the initial `/grill-me`
    interview, autonomously resolve design branches using codebase
    reconnaissance and `(Recommended)` defaults, and record any non-trivial
    assumptions in a `## Resolved Trade-Offs` section for human inspection at
    Step 5. (In headless CLI sessions where `ask_question` is unavailable, fall
    back to recording open assumptions in `## Resolved Trade-Offs`.)

### Step 3: Structured Spec Synthesis & Deterministic DAG Pre-Analysis (`agb shape`)

1.  Write the specification to `specs/<slug>-spec.md` using structured ticket
    sections (`### Ticket N: <id> -- Title` with `- **Scope**:`, `- **Rails**:`,
    `- **Edges**:`, `- **Tier**:`, `- **Pool Hint**:`, `- **Objectives**:`, and
    `- **Acceptance Criteria**:`).
2.  Run deterministic DAG pre-analysis via the terminal shim (or the
    `mcp__agb__agb_shape` tool when the `agb` MCP server is connected):

```sh
~/.local/bin/agb shape specs/<slug>-spec.md --analyze --json
```

3.  Verify `ok: true` (`0` structural errors, `0` concurrent scope overlaps,
    valid literal rail paths, and clean static import coupling across parallel
    tickets). Fix any structural or overlap errors before starting the Plan ARL.

### Step 4: 5-Lens Plan Adversarial Review Loop (`/plan-review --loop`)

Run the 5-lens cross-model Plan Gate (`devils_advocate`,
`requirements_fidelity`, `simplicity`, `evidence_strategy`, `dag_topology`) +
`arbiter` (capped at 3 rounds):

-   **`resolution_route: "auto-fix"`**: Apply structural, clarity, completeness,
    acceptance-criteria, and DAG-partitioning fixes directly to
    `specs/<slug>-spec.md`, re-run `~/.local/bin/agb shape specs/<slug>-spec.md --json`, and
    re-verify in the next round.
-   **`resolution_route: "grill-me"`**: Re-enter `/grill-me` with the user via
    `ask_question` ONLY when a finding exposes a genuine product/design
    trade-off or ambiguous user requirement (or in `--yolo` mode, resolve
    conservatively and document in `## Resolved Trade-Offs`), update
    `specs/<slug>-spec.md`, and re-verify.
-   **Fail-Closed Cap**: If 3 rounds complete without `gate_verdict: "SHIP"` (or
    `agb shape` remains non-zero), halt and escalate the remaining contested
    findings to the user — never proceed to `agb plan` with unresolved blockers.

### Step 5: Mandatory Human Sign-Off Gate

Upon receiving `gate_verdict: "SHIP"` from the Plan ARL and exit `0` from
`agb shape`:

1.  Sync the hardened spec to the Antigravity Brain Artifact (`agb_plan_artifact.md` in the active brain directory and `.booster/agb_plan_artifact.md`) via `~/.local/bin/agb shape specs/<slug>-spec.md --sync-brain` (or `mcp__agb__agb_shape` with `syncBrain: true`).
2.  Present a concise summary of the Plan ARL convergence and `agb shape`
    pre-analysis report, and **pause for explicit human sign-off** before
    running `agb plan` (applies to both `/agb-shape` and `/agb-shape --yolo`).

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-shape`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
