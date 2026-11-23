---
name: plan-review
description: Interrogate a plan or spec before implementation using 5-lens multi-perspective adversarial review (Devils Advocate, Simplicity, Requirements Fidelity, Evidence Strategy, DAG Topology) in single-pass briefing or iterative Plan ARL (--loop) mode.
---

# /plan-review <plan-file> [--loop]

Review a specification or plan before writing code to identify unstated
assumptions, over-engineering, missing acceptance criteria, and
DAG/scope-partitioning hazards across `gemini` and `claude` model families.

## Cross-Model Lens Routing (`lib/models.mjs` at runtime; offline snapshot in `adversarial-review/references/models.json`)

1.  **`devils_advocate`**: `claude-opus-5-5-high` (`claude`) -> fallback `gemini-4-argon-high` (`gemini`)
2.  **`requirements_fidelity`**: `gemini-4-argon-medium` (`gemini`) -> fallback `claude-sonnet-5-5-high` (`claude`)
3.  **`simplicity`**: `claude-sonnet-5-5-medium` (`claude`) -> fallback `gemini-3.8-flash-medium` (`gemini`)
4.  **`evidence_strategy`**: `gemini-3.8-flash-medium` (`gemini`) -> fallback `claude-sonnet-5-5-medium` (`claude`)
5.  **`dag_topology`**: `gemini-4-argon-high` (`gemini`) -> fallback `claude-opus-5-5-high` (`claude`)
6.  **`arbiter`**: `gemini-4-argon-high` (`gemini`) -> fallback `claude-opus-5-5-high` (`claude`)

## Operating Modes

-   **Default Single-Pass Briefing (`/plan-review <spec.md>`)**: Fans out the 5
    lenses + arbiter and presents a ranked briefing to the human for direct
    adjudication.
-   **Iterative Plan ARL (`/plan-review <spec.md> --loop`, used by `/agb-shape`
    and `/agb`)**: Capped at 3 rounds. The arbiter tags each accepted finding
    with `resolution_route: "auto-fix" | "grill-me"` and emits
    `gate_verdict: "SHIP" | "ITERATE"`. Structural/DAG findings (`auto-fix`) are
    repaired directly in the spec and re-verified with `agb shape`; genuine
    product/design trade-offs (`grill-me`) bounce back to `/grill-me`
    (`ask_question`) before re-verifying.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim (or `mcp__agb__agb_review` with `plan` and `loop` when the `agb` MCP server is connected):

```sh
~/.local/bin/agb review [repo-path] --plan <spec.md> [--loop]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/plan-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
