---
name: agb-doctor
description: Verify your environment and tools, with optional self-healing (--fix)
---

# /agb-doctor [repo-path] [--fix]

Runs comprehensive environment diagnostics: Node runtime, the `agy` CLI and its authentication, sandboxing, the ADLC toolkit, and the staged plugin installation. Pass `--fix` to automatically repair recoverable setup issues (missing `.adlc/config.json`, missing `.adlc/tickets` directory store, missing `.gitignore` stanzas, and missing `adlc-antigravity` companion plugin). Report every failing or warning check to the user with its suggested fix.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb doctor [repo-path] [--fix]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 1 = failure or error).

If the `agb` MCP server is connected, you may instead prefer the `mcp__agb__agb_doctor` tool (it accepts optional `repo` and `fix` parameters); it runs the same command and returns its output.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-doctor`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
