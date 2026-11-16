---
name: code-review
description: Adversarially review a code change or branch across 5 isolated lenses with neutral arbiter triage
---

# /code-review [repo-path] [ref] [--loop]

Runs the 5-lens Cross-Model Code Adversarial Review Loop (`correctness_redteam`, `security`, `simplicity`, `evidence_runner`, `anti_slop`) with neutral `arbiter` triage and author rebuttal on a working tree or branch diff.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb review [repo-path] [ref] --five-lens [--loop] [--no-arbiter]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_review` tool with `fiveLens: true` (plus `repo`, `ref`, `loop`, `arbiter` when specified); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/code-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
