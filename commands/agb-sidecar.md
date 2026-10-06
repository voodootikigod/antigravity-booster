---
name: agb-sidecar
description: Launch the HTTP server for the Antigravity Sidecar UI
---

# /agb-sidecar [repo-path] [--port <port>]

Launches the native web dashboard sidecar server for a repository and prints the URL to open. The server keeps running until stopped, so start it in the background (or tell the user to run it in their own terminal) rather than blocking on it.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb sidecar [repo-path] [--port <port>]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-sidecar`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
