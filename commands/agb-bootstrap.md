---
name: agb-bootstrap
description: Install or refresh antigravity-booster's ADLC doctrine plugin, skills and the ~/.local/bin/agb terminal shim
---

# /agb-bootstrap [--force-reinstall]

Installs the pinned `@adlc/antigravity` doctrine plugin from the vendored tarball, wires the ADLC skills into `~/.gemini/skills`, and installs the `~/.local/bin/agb` terminal shim that every other `/agb-*` command uses. It is idempotent: re-running it verifies and repairs the installation. `--force-reinstall` replaces an existing doctrine plugin or a modified shim.

## How to run it

If `~/.local/bin/agb` already exists, use your shell tool (`run_command`) to run it, passing the user's arguments through unchanged:

```sh
~/.local/bin/agb bootstrap [--force-reinstall]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user.

## First run (no shim yet)

The shim cannot exist before the first bootstrap. If `~/.local/bin/agb` is missing, tell the user to run this once from a terminal (outside the agent session), then retry `/agb-bootstrap` or any other `/agb-*` command:

```sh
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
```

This runs the staged plugin's bundled CLI through its Node launcher, which validates the Node.js version before starting. Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
