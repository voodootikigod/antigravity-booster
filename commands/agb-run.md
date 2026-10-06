---
name: agb-run
description: Execute a ticket DAG (build, gate, prosecute, merge)
---

# /agb-run <plan.json> [options]

Executes the ticket DAG defined in `plan.json`: builds each ticket in an isolated worktree fleet, runs the deterministic gates, prosecutes, and merges. This is long-running and mutates the target repository, so confirm the plan path with the user if it is ambiguous.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb run <plan.json> [options]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_run` tool with `plan` (and `concurrency` if the user gave one); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-run`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
