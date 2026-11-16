---
name: agb-watch
description: Launch the interactive live terminal TUI dashboard for real-time build progress and ticket state
---

# /agb-watch [repo-path] [--interval <ms>] [--follow] [--compact]

Launches the interactive Terminal User Interface (TUI) dashboard displaying real-time run status, quota pool meters, live ticket state, and scrolling event activity.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb watch [repo-path] [--interval <ms>] [--follow] [--compact]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-watch`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
