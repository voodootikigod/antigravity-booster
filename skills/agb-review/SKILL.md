---
name: agb-review
description: Deploy a read-only cross-model review fleet across 4 lenses (correctness, security, tests, contracts) or 5-lens Adversarial Review Loop (Plan Gate or Code Gate with neutral arbiter triage) until convergence.
---

# /agb-review [repo-path] [ref] [--plan <spec.md>] [--loop] [--five-lens] [--no-arbiter] [--thorough] [--dry-rounds <n>] [--seams-only] [--plan-file <plan.json>] [--delta <base-ref>] [--prior-findings <path>] [--no-codegraph] [--no-decision-engine] [--project <name>]

Deploys a read-only fleet of models across Gemini and Claude quota pools to audit a git diff or specification (`--plan <spec.md>`) using either the 4-lens fleet or the 5-lens Adversarial Review Loop (`--five-lens`, `--loop`) with neutral arbiter triage.

-   **Single-pass default**: Reviews each static diff state once (`dryRounds = 1, maxRounds = 1`) using a 1-turn host-assembled Context Pack (enclosing modified symbols + external callers/callees via CodeGraph or static-AST fallback; filesystem read tools are denied by default and only re-enabled if host context is truncated).
-   **Delta fix-round loops**: Pass `--delta <base-ref>` (and optional `--prior-findings <path>`, defaulting to `.review/last-findings.json`) on Round 2+ after applying fixes to review only the fix delta and verify prior findings while skipping untouched clean lenses.
-   **Thorough & multi-dry mode**: Pass `--thorough` (`dryRounds = 2, maxRounds = 3`) or `--dry-rounds <n>` when stochastic multi-pass convergence over a static diff is explicitly desired.
-   **Post-run seam review**: Pass `--seams-only` (with optional `--plan-file <plan.json>`) after `agb run` to audit cross-ticket integration seams (`contracts`, `correctness_redteam`, `security`); automatically fails closed if any commit in `ref..HEAD` lacks a passing System-2 prosecution record.
-   **Accelerator opt-outs**: Pass `--no-codegraph` or `--no-decision-engine` to disable opt-in CodeGraph slicing or System-1 lens gating/arbiter triage.

Exit code 2 means blocking findings were reported; summarise them for the user.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb review [repo-path] [ref] [--plan <spec.md>] [--loop] [--five-lens] [--no-arbiter] [--thorough] [--dry-rounds <n>] [--seams-only] [--plan-file <plan.json>] [--delta <base-ref>] [--prior-findings <path>] [--no-codegraph] [--no-decision-engine] [--project <name>]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_review` tool with `repo` (and `ref`, `plan`, `loop`, `fiveLens`, `arbiter`, `thorough`, `dryRounds`, `seamsOnly`, `planFile`, `delta`, `priorFindings`, `codegraph`, or `decisionEngine` if the user gave them); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
