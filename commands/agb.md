---
name: agb
description: End-to-end 5-phase Factory orchestrator and umbrella router (/agb <description> [--yolo])
---

# /agb <description> [--yolo]

Executes the 5-phase Factory pipeline (`/agb-shape` -> `agb plan` -> `agb preflight` -> `agb run` -> `/code-review`) or routes any natural-language task description or subcommand to the right `antigravity-booster` (`agb`) workflow.

## Intent Routing Table (`Where am I? -> which agb command`)

| User Intent in `<description>` | Target Workflow | Command / MCP Tool to Execute |
| :--- | :--- | :--- |
| **Build or implement a feature / concept end-to-end** (e.g. *"build the webhook retry queue in parallel"*, *"/agb --yolo add rate limiting"*) | **5-Phase Factory** (`/agb-shape` -> `plan` -> `preflight` -> `run` -> `/code-review`) | 1. Shape & harden `specs/<slug>-spec.md` with `/agb-shape` (`~/.local/bin/agb shape` + 5-lens Plan ARL + Sign-Off Gate unless `--yolo`).<br>2. Compile via `~/.local/bin/agb plan specs/<slug>-spec.md . --out plan.json --force`.<br>3. Validate via `~/.local/bin/agb preflight plan.json`.<br>4. Capture `<pre-run-base-sha>` (`git rev-parse HEAD`), then execute via `~/.local/bin/agb run plan.json`.<br>5. Verify with `npm test` and `~/.local/bin/agb review . <pre-run-base-sha> --five-lens --loop` (not `main`, which diffs nothing after merging onto `main`). |
| **Shape a feature idea or analyze a spec DAG** (e.g. *"shape specs/auth-spec.md"*) | **Shape** (`/agb-shape`) | `~/.local/bin/agb shape <spec.md \| id> [repo-path] [--analyze] [--strict] [--sync-brain] [--max-ticket-scope <n>] [--json]` or `mcp__agb__agb_shape` |
| **Compile an existing spec file or Antigravity brain artifact into `plan.json` (or a `run_workflow` script)** | **Plan** (`/agb-plan`) | `~/.local/bin/agb plan <id \| spec.md> [repo-path] [--emit-workflow <file.py>]` or `mcp__agb__agb_plan` (with `emitWorkflow`) |
| **Execute an existing `plan.json` ticket DAG** | **Run** (`/agb-run`) | `~/.local/bin/agb run <plan.json> [-c <n>]` or `mcp__agb__agb_run` |
| **Pre-flight or validate a `plan.json` without running builders** | **Preflight / Validate** | `~/.local/bin/agb preflight <plan.json>` (`mcp__agb__agb_preflight`) or `~/.local/bin/agb validate <plan.json>` |
| **Review, prosecute, or audit a branch / diff or spec** | **Review** (`/agb-review`, `/plan-review`, `/code-review`) | `~/.local/bin/agb review [repo-path] [ref] [--plan <spec.md>] [--five-lens] [--loop]` or `mcp__agb__agb_review` |
| **Distill recurring review/prosecution findings into learned ADLC defenses** | **Distill** | `~/.local/bin/agb distill [repo-path] [--apply] [--json]` or `mcp__agb__agb_distill` |
| **Check environment health or self-heal recoverable state** | **Doctor** (`/agb-doctor`) | `~/.local/bin/agb doctor [repo-path] [--fix]` or `mcp__agb__agb_doctor` |
| **Check live fleet run status or launch interactive TUI** | **Status / Watch** (`/agb-status`, `/agb-watch`) | `~/.local/bin/agb status [repo-path]` (`mcp__agb__agb_status`) or `~/.local/bin/agb watch [repo-path]` |
| **Audit or sync live Antigravity model catalog** | **Sync Models** (`/agb-sync-models`) | `~/.local/bin/agb sync-models [--check] [--write]` |
| **Initialize a target repository for ADLC and agb** | **Init** | `~/.local/bin/agb init [repo-path]` or `mcp__agb__agb_init` |

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb plan <id | spec.md> [repo-path] [--out <file>] [--emit-workflow <file.py>] [--force] [--decompose] [--max-ticket-scope <n>] [--no-fast-path] [--no-coldstart] [--no-parallax] [--no-premortem]
~/.local/bin/agb shape <spec.md | id> [repo-path] [--analyze] [--strict] [--sync-brain] [--max-ticket-scope <n>] [--json]
~/.local/bin/agb run <plan.json> [-c <n>]
~/.local/bin/agb review [repo-path] [ref] [--plan <spec.md>] [--loop] [--five-lens] [--no-arbiter]
~/.local/bin/agb distill [repo-path] [--apply] [--json]
~/.local/bin/agb doctor [repo-path] [--fix]
~/.local/bin/agb status [repo-path] [--watch] [-w] [--interval <ms>] [--tui] [--follow] [--compact]
~/.local/bin/agb watch [repo-path] [--interval <ms>] [--follow] [--compact]
~/.local/bin/agb sync-models [--check] [--write] [--offline] [--json]
~/.local/bin/agb init [repo-path]
~/.local/bin/agb pool drain [repo-path]
~/.local/bin/agb preflight <plan.json>
~/.local/bin/agb validate <plan.json>
~/.local/bin/agb sidecar [repo-path] [--port <port>]
~/.local/bin/agb bootstrap [--force] [--force-reinstall]
~/.local/bin/agb migrate [--rollback] [--force-rollback] [--force] [--break-lock]
```

If the `agb` MCP server is connected, you may instead prefer `mcp__agb__agb_shape`, `mcp__agb__agb_plan`, `mcp__agb__agb_run`, `mcp__agb__agb_review`, `mcp__agb__agb_distill`, `mcp__agb__agb_doctor`, `mcp__agb__agb_status`, `mcp__agb__agb_preflight`, or `mcp__agb__agb_init` for the corresponding workflow.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
