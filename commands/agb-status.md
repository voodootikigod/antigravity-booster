---
name: agb-status
description: View real-time build progress, quota pool meters, and ticket state for an Antigravity Booster run
---

# /agb-status [repo-path] [--watch] [-w] [--tui] [--interval <ms>] [--follow] [--compact]

Renders the live execution status, ticket states, strikes, and quota pool metrics for a repository.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb status [repo-path] [--watch] [-w] [--tui] [--interval <ms>] [--follow] [--compact]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user.

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_status` tool with `repo`; it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-status`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
