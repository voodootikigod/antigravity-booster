---
name: agb-sidecar
description: Launch the live HTTP telemetry dashboard server for the Antigravity Booster Sidecar UI to monitor ticket DAG waves, quota pool saturation, and prosecutor verdicts in real time.
---

# /agb-sidecar [repo-path] [--port <port>]

Launches the native web dashboard sidecar server for a repository and prints the local host/port binding, while the full authenticated URL containing the session token is registered into the dynamic sidecar plugin manifest. The server keeps running until stopped, so always run it as a background task (or instruct the user to run it in their own terminal) rather than blocking on it.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb sidecar [repo-path] [--port <port>]
```

Run it in the background from the user's workspace (e.g. as a background process or daemon), then report the server status to the user.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-sidecar`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
