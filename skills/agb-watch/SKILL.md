---
name: agb-watch
description: Launch the interactive live terminal TUI dashboard for real-time build progress, quota pool meters, ticket state, and event activity.
---

# /agb-watch [repo-path] [--interval <ms>] [--follow] [--compact]

Launches the interactive Terminal User Interface (TUI) dashboard displaying:
- Real-time run status, elapsed timer, and overall merge progress bar
- Model quota pool meters with in-flight gauges and request counters
- Live ticket state table with phase badges, model assignments, and strike details
- Scrolling recent activity stream from `events.jsonl`
- Interactive hotkeys (`[q]` quit, `[r]` refresh, `[c]` toggle compact, `[space]` pause/resume)

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim:

```sh
~/.local/bin/agb watch [repo-path] [--interval <ms>] [--follow] [--compact]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-watch`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
