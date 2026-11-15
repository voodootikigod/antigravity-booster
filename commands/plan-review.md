---
name: plan-review
description: Interrogate a plan or spec across 5 lenses (Devils Advocate, Simplicity, Fidelity, Evidence, DAG Topology)
---

# /plan-review <spec.md> [--loop]

Reviews a specification or plan across 5 cross-model lenses (`devils_advocate`, `requirements_fidelity`, `simplicity`, `evidence_strategy`, `dag_topology`) plus a neutral `arbiter` in single-pass briefing mode or iterative Plan ARL (`--loop`, up to 3 rounds until `SHIP`).

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb review [repo-path] --plan <spec.md> [--loop]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_review` tool with `plan` (plus `repo` and `loop`); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/plan-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
