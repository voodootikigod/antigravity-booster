---
name: agb-review
description: Read-only lens fleet over a diff, loop-until-dry
---

# /agb-review [repo-path] [ref]

Deploys a read-only fleet of models to audit a diff until no new critical or high findings remain. Exit code 2 means findings were reported; summarise them for the user.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb review [repo-path] [ref]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_review` tool with `repo` (and `ref` if the user gave one); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
