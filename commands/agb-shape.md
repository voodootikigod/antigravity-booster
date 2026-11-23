---
name: agb-shape
description: Shape a raw feature idea or spec file via reconnaissance, /grill-me, DAG pre-analysis, and 5-lens Plan ARL
---

# /agb-shape <idea | spec.md> [--yolo] [--out specs/<slug>-spec.md]

Shapes a raw feature idea or concept into a complete, DAG-validated specification (`specs/<slug>-spec.md`) via reconnaissance, `/grill-me` alignment, deterministic DAG pre-analysis (`agb shape`), the 5-lens Plan Adversarial Review Loop (`/plan-review --loop`), and a Human Sign-Off Gate before `agb plan`.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim during Step 3 and Step 5, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb shape <spec.md | id> [repo-path] [--analyze] [--strict] [--sync-brain] [--max-ticket-scope <n>] [--json]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = structural or scope-overlap findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_shape` tool with required `spec` and `repo` (plus optional `strict`, `syncBrain`, `maxTicketScope` when applicable); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-shape`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
