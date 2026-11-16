---
name: agb
description: End-to-end autonomous software development orchestrator and umbrella router (/agb <description> [--yolo]). Shapes a feature concept into a formal spec (/agb-shape), compiles an executable ticket DAG with gates (agb plan), runs parallel worktrees with cross-model prosecution (agb run), audits the final build with the adversarial review loop, or routes any subcommand.
---

# /agb <description of feature or subcommand> [--yolo]

Executes the complete Agentic Development Lifecycle (ADLC) 5-phase Factory
workflow end-to-end for a requested feature, refactor, or architectural concept,
or routes any specific subcommand (`shape`, `plan`, `preflight`, `run`, `review`,
`status`, `watch`, `sidecar`, `doctor`, `sync-models`, `init`, `bootstrap`,
`migrate`, `pool`, `brains`, `sweep`).

## 5-Phase End-to-End Factory Pipeline

When invoked with `/agb <feature description> [--yolo]`, execute the following 5
phases sequentially:

### Phase 1: Spec Shaping, DAG Pre-Analysis & Plan ARL (`/agb-shape`)

1.  **Reconnaissance & `/grill-me` Alignment**:
    -   Search the repository for related files, models, utilities, existing
        tests, and frozen rails (`lib/lock.mjs`, `lib/gates.mjs`, etc.).
    -   In standard interactive mode (default), interview the user one decision
        branch at a time via `/grill-me` (`ask_question` with `(Recommended)`
        defaults) until all architectural, scope, and behavioral ambiguities are
        resolved.
2.  **Structured Spec Synthesis & Deterministic DAG Pre-Analysis (`agb shape`)**:
    -   Write `specs/<feature-slug>-spec.md` with structured ticket sections
        (`Scope`, `Rails`, `Edges`, `Tier`, `Pool Hint`, `Objectives`,
        `Acceptance Criteria`) and a Mermaid `graph TD` block.
    -   Run `~/.local/bin/agb shape specs/<feature-slug>-spec.md --analyze --json`
        (or `mcp__agb__agb_shape`) to verify `ok: true` (`0` structural errors,
        `0` concurrent scope overlaps, valid rails, and clean static import
        coupling).
3.  **5-Lens Plan Adversarial Review Loop (`/plan-review --loop`)**:
    -   Run the 5-lens Plan Gate (`devils_advocate`, `requirements_fidelity`,
        `simplicity`, `evidence_strategy`, `dag_topology`) + `arbiter` (capped
        at 3 rounds):
        -   Auto-fix (`resolution_route: "auto-fix"`) structural, clarity,
            completeness, and DAG-partitioning findings directly in
            `specs/<feature-slug>-spec.md` and re-run `agb shape`.
        -   Bounce back to `/grill-me` (`resolution_route: "grill-me"`) *only*
            when a finding exposes a genuine product/design trade-off or
            ambiguous user requirement.
        -   Fail closed if 3 rounds complete without `gate_verdict: "SHIP"`.
4.  **Human Sign-Off Gate vs. Full End-to-End YOLO (`--yolo`)**:
    -   **Standard Interactive Mode (Default `/agb`)**: Upon receiving
        `gate_verdict: "SHIP"`, sync the hardened spec to the Antigravity Brain
        Artifact (`~/.local/bin/agb shape specs/<feature-slug>-spec.md --sync-brain`)
        and **pause for explicit human sign-off** before Phase 2 (`agb plan`).
    -   **Full End-to-End YOLO Mode (`/agb --yolo <idea>`)**: Passing `--yolo`
        to `/agb` is the user's explicit authorization to run Autonomous
        Shaping + `agb shape` DAG Pre-Analysis + 5-Lens Plan ARL until `SHIP` +
        Phase 2 `agb plan` (fast-path) + Phase 3 `agb preflight` + Phase 4
        `agb run` + Phase 5 Code ARL continuously without pausing at the Step 5
        Human Sign-Off Gate (halting only if Plan ARL fails to achieve `SHIP`
        within 3 rounds or a build/test gate fails).

### Phase 2: Gated Plan Compilation (`agb plan`)

Compile the hardened Markdown spec into an executable, dependency-ordered ticket
DAG:

```sh
~/.local/bin/agb plan specs/<feature-slug>-spec.md . --out plan.json --force
```

-   When `preAnalyzeSpec()` passes (`preAnalysis.ok === true`), `agb plan` uses
    the **Structured Spec Fast-Path** (0 Stage A LLM conversion calls) and
    proceeds directly to Stage B (`coldstart`, `parallax`, `premortem`,
    `model-router`, `merge-forecast`).
-   Confirm `plan.json` is generated and tickets are projected into `.adlc/tickets/`.

### Phase 3: Preflight Validation (`agb preflight`)

Validate the compiled DAG before parallel execution:

```sh
~/.local/bin/agb preflight plan.json
```

### Phase 4: Parallel Execution & Prosecution (`agb run`)

Execute the ticket DAG across isolated worktrees:

```sh
~/.local/bin/agb run plan.json
```

-   Builder agents execute each ticket in isolated git worktrees (`.worktrees/agb-<ticketId>`).
-   Sandboxed gates run build and test suites (`bwrap` on Linux / `sandbox-exec` on macOS).
-   Cross-model prosecutors audit diffs against acceptance criteria and mutation tests (`adlc hollow-test`).
-   Passing tickets are rebased and merged sequentially onto `main`.

### Phase 5: Final Review & Delivery

1.  **Verify Combined Test Suite**: Run the project's test gate (e.g. `npm test`) on `main` to confirm the merged tree passes cleanly.
2.  **5-Lens Code Adversarial Review Loop**: Run `/code-review` (`~/.local/bin/agb review . main --five-lens --loop`) to audit the combined diff across `correctness_redteam`, `security`, `simplicity`, `evidence_runner`, and `anti_slop` with neutral arbiter triage.
3.  **Report to User**: Present a concise summary of the implemented components, test results, merged tickets, and gate evidence.

## Subcommand Routing Reference

```sh
~/.local/bin/agb shape <spec.md | id> [repo-path] [--analyze] [--strict] [--sync-brain] [--max-ticket-scope <n>] [--json]
~/.local/bin/agb plan <id | spec.md> [repo-path] [--out <file>] [--force] [--decompose] [--max-ticket-scope <n>] [--no-fast-path] [--no-coldstart] [--no-parallax] [--no-premortem]
~/.local/bin/agb preflight [plan.json]
~/.local/bin/agb run <plan.json> [-c <n>]
~/.local/bin/agb review [repo-path] [ref] [--plan <spec.md>] [--loop] [--five-lens] [--no-arbiter]
~/.local/bin/agb status [repo-path] [--watch] [-w] [--interval <ms>] [--tui] [--follow] [--compact]
~/.local/bin/agb watch [repo-path] [--interval <ms>] [--follow] [--compact]
~/.local/bin/agb sidecar [repo-path] [--port <port>]
~/.local/bin/agb doctor [repo-path] [--fix]
~/.local/bin/agb sync-models [--check] [--write] [--offline] [--json]
~/.local/bin/agb init [repo-path]
~/.local/bin/agb bootstrap [--force] [--force-reinstall]
~/.local/bin/agb migrate [--rollback] [--force-rollback] [--force] [--break-lock]
```

If the `agb` MCP server is connected, you may instead prefer `mcp__agb__agb_shape`, `mcp__agb__agb_plan`, `mcp__agb__agb_preflight`, `mcp__agb__agb_run`, `mcp__agb__agb_review`, `mcp__agb__agb_status`, `mcp__agb__agb_doctor`, or `mcp__agb__agb_init`.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
