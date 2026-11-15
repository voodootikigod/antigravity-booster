---
name: agb-status
description: View real-time build progress, quota pool meters, and ticket state for an active or completed Antigravity Booster run.
---

# /agb-status [repo-path] [--watch] [-w] [--tui] [--interval <ms>] [--follow] [--compact]

Renders the live execution status, ticket states, strikes, and quota pool metrics for a repository.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim (or `mcp__agb__agb_status` when the `agb` MCP server is connected):

```sh
~/.local/bin/agb status [repo-path] [--watch] [-w] [--tui] [--interval <ms>] [--follow] [--compact]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-status`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
