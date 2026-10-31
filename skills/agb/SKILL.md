---
name: agb
description: Umbrella router for Antigravity Booster (/agb <description>). Interprets any natural-language request or subcommand and routes it to the right agb workflow (plan, run, review, doctor, bootstrap, migrate, sidecar, status, preflight, validate, pool, brains, or sweep).
---

# /agb <description>

Routes a natural-language task description or subcommand to the right `antigravity-booster` (`agb`) workflow. Use this command whenever the user invokes `/agb <description>` instead of a specific `/agb-<subcommand>`.

## Intent Routing Table (`Where am I? -> which agb command`)

Inspect the user's `<description>` and select the matching workflow below:

| User Intent in `<description>` | Target Workflow | Command / MCP Tool to Execute |
| :--- | :--- | :--- |
| **Build or implement a feature / task from a natural-language description** (e.g. *"build the webhook retry queue in parallel"*, *"implement multi-tenant auth"*) | **Plan -> Run** | 1. Write a concise spec file (e.g. `.adlc/specs/<slug>.md`) capturing the goal, acceptance criteria, `scope` globs, and `rails`.<br>2. Compile it via `~/.local/bin/agb plan <spec.md> <repo-path>` (or `mcp__agb__agb_plan`).<br>3. Execute the resulting `plan.json` via `~/.local/bin/agb run <plan.json>` (or `mcp__agb__agb_run`). |
| **Compile an existing spec file or Antigravity brain artifact into `plan.json`** (e.g. *"plan specs/auth.md"*, *"compile my brain plan"*) | **Plan** (`/agb-plan`) | `~/.local/bin/agb plan <id \| spec.md> <repo-path>` or `mcp__agb__agb_plan` |
| **Execute an existing `plan.json` ticket DAG** (e.g. *"run plan.json"*, *"execute .booster/plan.json"*) | **Run** (`/agb-run`) | `~/.local/bin/agb run <plan.json>` or `mcp__agb__agb_run` |
| **Pre-flight or validate a `plan.json` without running builders** (e.g. *"preflight plan.json"*, *"validate plan.json"*) | **Preflight / Validate** | `~/.local/bin/agb preflight <plan.json>` (`mcp__agb__agb_preflight`) or `~/.local/bin/agb validate <plan.json>` |
| **Review, prosecute, or audit a branch / diff before merge** (e.g. *"review this branch"*, *"is this safe to merge"*, *"prosecute diff against main"*) | **Review** (`/agb-review`) | `~/.local/bin/agb review [repo-path] [ref]` or `mcp__agb__agb_review` |
| **Check environment health, quota pools, ADLC companion plugin, or sandbox readiness** (e.g. *"doctor"*, *"check my setup"*, *"verify environment"*) | **Doctor** (`/agb-doctor`) | `~/.local/bin/agb doctor [repo-path]` or `mcp__agb__agb_doctor` |
| **Check live fleet run status or quota pool caps** (e.g. *"status"*, *"what is the fleet doing"*, *"check quota pools"*) | **Status / Pool** | `~/.local/bin/agb status [repo-path]` (`mcp__agb__agb_status`) or `~/.local/bin/agb pool` |
| **List or import Antigravity brain plan artifacts** (e.g. *"list brains"*, *"import brain"*) | **Brains** | `~/.local/bin/agb brains` or `~/.local/bin/agb import-brain <id-or-prefix>` |
| **Open or start the live sidecar telemetry dashboard** (e.g. *"sidecar"*, *"open dashboard"*, *"monitor run"*) | **Sidecar** (`/agb-sidecar`) | `~/.local/bin/agb sidecar [repo-path] [--port <port>] [--open]` |
| **First-run setup or repairing `~/.local/bin/agb` & `adlc-antigravity`** (e.g. *"bootstrap"*, *"setup"*, *"install shim"*) | **Bootstrap** (`/agb-bootstrap`) | `~/.local/bin/agb bootstrap [--force] [--force-reinstall]` |
| **Migrate from a legacy npm-global or git-checkout install** (e.g. *"migrate"*, *"upgrade from npm"*, *"rollback migration"*) | **Migrate** (`/agb-migrate`) | `~/.local/bin/agb migrate [--dry-run] [--yes] [--rollback]` |
| **Run a multi-repository sweep** (e.g. *"sweep sweep.json"*) | **Sweep** | `~/.local/bin/agb sweep <sweep.json>` |

## How to run the selected command

Use your shell tool (`run_command`) from the user's workspace (or the matching `mcp__agb__agb_*` tool when connected), quoting each argument and never interpolating untrusted text into a larger shell string:

```sh
~/.local/bin/agb plan <id | spec.md> <repo-path> [--out <file>] [--force] [--no-coldstart] [--no-parallax] [--no-premortem]
~/.local/bin/agb run <plan.json>
~/.local/bin/agb review [repo-path] [ref]
~/.local/bin/agb doctor [repo-path]
~/.local/bin/agb status [repo-path]
~/.local/bin/agb preflight <plan.json>
~/.local/bin/agb validate <plan.json>
~/.local/bin/agb sidecar [repo-path] [--port <port>] [--open]
~/.local/bin/agb bootstrap [--force] [--force-reinstall]
~/.local/bin/agb migrate [--dry-run] [--yes] [--rollback]
```

Wait for the command to finish, then report its output and exit code (`0` = pass, `2` = gate failure or findings, `1` = usage or internal error) to the user.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), either run `bootstrap` if the user asked for setup, or tell the user to run this once from a terminal and retry `/agb`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files directly without `node-launcher.sh`.
