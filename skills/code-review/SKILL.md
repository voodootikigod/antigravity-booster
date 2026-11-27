---
name: code-review
description: Adversarially review a code change, branch, or pull request across 5 isolated reviewer personas (Correctness/Red-Team, Simplicity, Security, Evidence Runner, Anti-Slop) with neutral arbiter triage and author rebuttal.
---

# /code-review [repo-path] [ref] [--loop] [--thorough] [--dry-rounds <n>] [--seams-only] [--delta <base-ref>] [--prior-findings <path>]

Run the 5-lens Cross-Model Adversarial Review Loop on your working tree or branch diff before merging or opening a pull request.

-   **Single-pass default & 1-turn Context Pack**: Each lens runs 1 pass per static diff state (`dryRounds = 1, maxRounds = 1`) over a host pre-baked Context Pack (filtered diff + enclosing symbols + external callers/callees), with filesystem read tools denied by default to prevent multi-turn diff re-billing.
-   **Delta fix loops**: On Round 2+ after applying fixes, pass `--delta <base-ref>` (and `--prior-findings <path>`, default `.review/last-findings.json`) to audit only the fix delta and prior findings while skipping untouched clean lenses.
-   **Thorough / Seam-only modes**: Pass `--thorough` / `--dry-rounds <n>` for multi-dry convergence, or `--seams-only` (with `--plan-file <plan.json>`) for post-run cross-ticket seam auditing after per-ticket System-2 prosecution.

## Cross-Model Lens Routing (`lib/models.mjs` at runtime; offline snapshot in `adversarial-review/references/models.json`)

High-risk diffs route to full frontier models below; lower blast-radius diffs automatically scale down via `selectRiskTieredLensModel()` while preserving cross-family isolation:

1.  **`correctness_redteam`**: `claude-opus-5-5-high` (`claude`) -> fallback `gemini-4-neon-high` (`gemini`)
2.  **`security`**: `gemini-4-neon-high` (`gemini`) -> fallback `claude-opus-5-5-high` (`claude`)
3.  **`simplicity`**: `claude-sonnet-5-5-medium` (`claude`) -> fallback `gemini-4-hydrogen-medium` (`gemini`)
4.  **`evidence_runner`**: `gemini-4-hydrogen-medium` (`gemini`) -> fallback `claude-sonnet-5-5-medium` (`claude`)
5.  **`anti_slop`**: `claude-sonnet-5-5-high` (`claude`) -> fallback `gemini-4-hydrogen-high` (`gemini`)
6.  **`arbiter`**: `gemini-4-neon-high` (`gemini`) -> fallback `claude-opus-5-5-high` (`claude`) (hybrid cascade: System-1 -> deterministic fast-path -> System-2)

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim (or `mcp__agb__agb_review` with `fiveLens: true` when the `agb` MCP server is connected):

```sh
~/.local/bin/agb review [repo-path] [ref] --five-lens [--loop] [--no-arbiter] [--thorough] [--dry-rounds <n>] [--seams-only] [--delta <base-ref>] [--prior-findings <path>]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/code-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
