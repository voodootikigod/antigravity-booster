---
name: agb-bootstrap
description: Install the ~/.local/bin/agb terminal shim and bundled companion plugin adlc-antigravity after installing antigravity-booster. Use on first run or when ~/.local/bin/agb is missing.
---

# /agb-bootstrap [--force] [--force-reinstall]

Installs the pinned `@adlc/antigravity` companion plugin from the vendored tarball, links booster's own skills into `~/.gemini/skills`, configures CLI `statusLine`/`title` settings in `~/.gemini/antigravity-cli/settings.json`, and installs the `~/.local/bin/agb` terminal shim that every other `/agb-*` command uses. It is idempotent: re-running it verifies and repairs the installation. `--force` replaces non-symlink skill directories in `~/.gemini/skills`; `--force-reinstall` replaces an existing companion plugin or a modified `~/.local/bin/agb` shim.

## How to run it

If `~/.local/bin/agb` already exists, use your shell tool (`run_command`) to run it, passing the user's arguments through unchanged:

```sh
~/.local/bin/agb bootstrap [--force] [--force-reinstall]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (`0` = pass, `1` = failure or error).

## First run (no shim yet)

`SessionStart` runs a one-time background bootstrap automatically in new Antigravity sessions. If `~/.local/bin/agb` is still missing, stop and tell the user to run this once from a terminal, then retry `/agb-bootstrap` or any other `/agb-*` command:

```sh
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
```

This runs the staged plugin's bundled CLI through its Node launcher, which validates the Node.js version before starting. Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
