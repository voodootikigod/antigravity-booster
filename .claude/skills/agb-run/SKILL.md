---
name: agb-run
description: Execute a plan.json ticket DAG in parallel across isolated git worktrees with quota-pool routing, PreToolUse rail protection, cross-model prosecution, and serialized merge gates. Use when running a multi-ticket build fleet.
---

# /agb-run <plan.json> [--dry-run] [--concurrency <N>] [--no-prosecute] [--allow-unauthenticated-rails] [--allow-degraded-sandboxing]

Executes a `plan.json` ticket DAG in parallel: dispatches builders into isolated git worktrees across quota pools, prosecutes each diff with a cross-family model, runs the test gate, and merges in dependency order.

`--allow-unauthenticated-rails` and `--allow-degraded-sandboxing` weaken safety gates; **only** pass them when the user has explicitly asked for them by name.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb run <plan.json> [--dry-run] [--concurrency <N>] [--no-prosecute]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_run` tool with `plan` (plus `dryRun`, `concurrency`, `noProsecute`, `allowUnauthenticatedRails`, `allowDegradedSandboxing` when the user passed the matching flags); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-run`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
