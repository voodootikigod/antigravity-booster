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
| **Shape a feature idea or analyze a spec DAG** (e.g. *"shape specs/auth-spec.md"*) | **Shape** (`/agb-shape`) | `~/.local/bin/agb shape <spec.md \| id> [repo-path] [--analyze] [--strict] [--sync-brain] [--max-ticket-scope <n>] [--json]` or `agb_shape` on `antigravity-booster_agb` |
| **Compile an existing spec file or Antigravity brain artifact into `plan.json` (or a `run_workflow` script)** | **Plan** (`/agb-plan`) | `~/.local/bin/agb plan <id \| spec.md> [repo-path] [--delta <prev-plan.json>] [--out <file>] [--emit-workflow <file.py>] [--estimate] [--prompt-only] [--json]` or `agb_plan` on `antigravity-booster_agb` (with `emitWorkflow`) |
| **Execute an existing `plan.json` ticket DAG (or run single-ticket P5/P6 verification and handoff)** | **Run / Gate-Ticket / Handoff** (`/agb-run`, `/agb-handoff`) | `~/.local/bin/agb run <plan.json> [-c <n>] [--resume] [--reset-rescue]` (`agb_run` on `antigravity-booster_agb`), `~/.local/bin/agb gate-ticket <ticket-id> [repo-path] [--base <ref>] [--json]`, or `~/.local/bin/agb handoff <ticket-id> [repo-path] [--base <ref>] [--html <file>] [--prompt-only] [--json]` |
| **Pre-flight or validate a `plan.json` without running builders** | **Preflight / Validate** | `~/.local/bin/agb preflight <plan.json>` (`agb_preflight` on `antigravity-booster_agb`) or `~/.local/bin/agb validate <plan.json>` |
| **Review, prosecute, or audit a branch / diff or spec** | **Review** (`/agb-review`, `/plan-review`, `/code-review`) | `~/.local/bin/agb review [repo-path] [ref] [--plan <spec.md>] [--five-lens] [--loop] [--prompt-only] [--json]` or `agb_review` on `antigravity-booster_agb` |
| **Distill recurring review/prosecution findings into learned ADLC defenses** | **Distill** | `~/.local/bin/agb distill [repo-path] [--apply] [--compile-checks] [--json]` or `agb_distill` on `antigravity-booster_agb` |
| **Rescue a failed ticket interactively or inspect P6 hunk acceptance** | **Rescue / Accept** | `~/.local/bin/agb rescue <ticket-id> [repo-path] [--continue] [--plan <plan.json>]` or `~/.local/bin/agb accept [repo-path] [--base <ref>] [--markdown <file>] [--html <file>] [--json]` (`agb_accept` on `antigravity-booster_agb`) |
| **Manage sealed black-box holdouts or CLI statusLine HUD** | **Holdout / Statusline** | `~/.local/bin/agb holdout <list\|run\|clean> [repo-path]` (`agb_holdout` on `antigravity-booster_agb`) or `~/.local/bin/agb statusline <render\|title\|install\|uninstall>` |
| **Check environment health or self-heal recoverable state** | **Doctor** (`/agb-doctor`) | `~/.local/bin/agb doctor [repo-path] [--fix]` or `mcp_antigravity-booster_agb_doctor` |
| **Check live fleet run status or launch interactive TUI** | **Status / Watch** (`/agb-status`, `/agb-watch`) | `~/.local/bin/agb status [repo-path]` (`mcp_antigravity-booster_agb_status`) or `~/.local/bin/agb watch [repo-path] [--mux] [--no-alerts]` |
| **Audit or sync live Antigravity model catalog** | **Sync Models** (`/agb-sync-models`) | `~/.local/bin/agb sync-models [--check] [--write]` |
| **Initialize a target repository for ADLC and agb (or Cloud / Automations)** | **Init** | `~/.local/bin/agb init [repo-path] [--cloud] [--automations] [--force]` or `agb_init` on `antigravity-booster_agb` |

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb plan <id | spec.md> [repo-path] [--delta <prev-plan.json>] [--out <file>] [--emit-workflow <file.py>] [--estimate] [--prompt-only] [--json] [--force] [--decompose] [--max-ticket-scope <n>] [--no-fast-path] [--no-coldstart] [--no-parallax] [--no-premortem]
~/.local/bin/agb shape <spec.md | id> [repo-path] [--analyze] [--strict] [--sync-brain] [--max-ticket-scope <n>] [--json]
~/.local/bin/agb run <plan.json> [-c <n>] [--resume] [--reset-rescue] [--driver <local|remote-sdk>] [--dry-run]
~/.local/bin/agb gate-ticket <ticket-id> [repo-path] [--base <ref>] [--worktree <dir>] [--test-cmd <cmd>] [--build-cmd <cmd>] [--browser-url <url>] [--skip-hollow] [--skip-browser] [--autocommit] [--no-manifest] [--json]
~/.local/bin/agb handoff <ticket-id> [repo-path] [--base <ref>] [--worktree <dir>] [--test-cmd <cmd>] [--build-cmd <cmd>] [--browser-url <url>] [--html <file>] [--skip-hollow] [--skip-browser] [--autocommit] [--no-prosecute] [--prompt-only] [--require-prosecutor] [--no-manifest] [--json]
~/.local/bin/agb rescue <ticket-id> [repo-path] [--continue] [--plan <plan.json>]
~/.local/bin/agb accept [repo-path] [--base <ref>] [--json] [--markdown <file>] [--html <file>] [--mobile]
~/.local/bin/agb holdout <list | run | clean> [repo-path] [--ticket <id>] [--run-id <id>] [--json]
~/.local/bin/agb statusline <render | title | install | uninstall> [--force]
~/.local/bin/agb review [repo-path] [ref] [--plan <spec.md>] [--loop] [--five-lens] [--no-arbiter] [--prompt-only] [--json]
~/.local/bin/agb distill [repo-path] [--apply] [--compile-checks] [--json]
~/.local/bin/agb doctor [repo-path] [--fix]
~/.local/bin/agb status [repo-path] [--watch] [-w] [--interval <ms>] [--tui] [--follow] [--compact] [--mobile]
~/.local/bin/agb watch [repo-path] [--interval <ms>] [--follow] [--compact] [--mux] [--no-alerts]
~/.local/bin/agb sync-models [--check] [--write] [--offline] [--json]
~/.local/bin/agb init [repo-path] [--cloud] [--automations] [--force]
~/.local/bin/agb pool drain [repo-path]
~/.local/bin/agb preflight <plan.json>
~/.local/bin/agb validate <plan.json>
~/.local/bin/agb sidecar [repo-path] [--port <port>] [--cloud]
~/.local/bin/agb remote-control [repo-path] [--dry-run] [--json]
~/.local/bin/agb bootstrap [--force] [--force-reinstall]
~/.local/bin/agb migrate [--rollback] [--force-rollback] [--force] [--break-lock]
```

If the `antigravity-booster_agb` MCP server is connected, you may instead invoke eager tools (`mcp_antigravity-booster_agb_status`, `mcp_antigravity-booster_agb_doctor`) or `call_mcp_tool(ServerName="antigravity-booster_agb", ToolName=...)` for `agb_shape`, `agb_plan`, `agb_preflight`, `agb_run`, `agb_review`, `agb_distill`, `agb_accept`, `agb_holdout`, `agb_flight_deck`, `agb_mission_control`, `agb_plan_viewer`, `agb_ticket_viewer`, `agb_manifest_viewer`, or `agb_init`.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
