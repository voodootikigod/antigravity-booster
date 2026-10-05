---
name: agb-plan
description: Compile an Antigravity brain plan or spec file into plan.json
---

# /agb-plan <id | spec.md> <repo-path> [--out <file>] [--force] [--no-coldstart] [--no-parallax] [--no-premortem]

Compiles a plan artifact (an Antigravity brain ID or prefix, or a raw Markdown spec file) into an executable `plan.json` ticket DAG. It converts, validates, runs the overlap/coldstart/parallax gates with a feedback loop, then an advisory premortem.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb plan <id | spec.md> <repo-path> [--out <file>] [--force] [--no-coldstart] [--no-parallax] [--no-premortem]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_plan` tool with `spec` and `repo` (plus `out`, `force`, `noColdstart`, `noParallax`, `noPremortem` when the user passed the matching flags); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-plan`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
