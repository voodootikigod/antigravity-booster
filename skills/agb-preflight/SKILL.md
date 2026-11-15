---
name: agb-preflight
description: Run plan-time coldstart probes and forecast scope overlaps between parallel tickets in a plan.json DAG before launching builders.
---

# /agb-preflight [plan.json] [--no-coldstart] [--project <name>]

Validates ticket self-sufficiency and detects potential concurrent file-scope overlaps before running a parallel build fleet.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim (or `mcp__agb__agb_preflight` when the `agb` MCP server is connected):

```sh
~/.local/bin/agb preflight [plan.json] [--no-coldstart] [--project <name>]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-preflight`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
