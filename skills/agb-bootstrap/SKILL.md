---
name: agb-bootstrap
description: Install the ~/.local/bin/agb terminal shim and bundled companion plugin adlc-antigravity after installing antigravity-booster. Use on first run or when ~/.local/bin/agb is missing.
---

# /agb-bootstrap [--force] [--force-reinstall]

Installs the pinned `@adlc/antigravity` doctrine plugin from the vendored tarball, wires the ADLC skills into `~/.gemini/skills`, and installs the `~/.local/bin/agb` terminal shim that every other `/agb-*` command uses. It is idempotent: re-running it verifies and repairs the installation. `--force` replaces non-symlink skill directories in `~/.gemini/skills`; `--force-reinstall` replaces an existing doctrine plugin or a modified `~/.local/bin/agb` shim.

## How to run it

If `~/.local/bin/agb` already exists, use your shell tool (`run_command`) to run it, passing the user's arguments through unchanged:

```sh
~/.local/bin/agb bootstrap [--force] [--force-reinstall]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (`0` = pass, `1` = failure or error).

## First run (no shim yet)

The shim cannot exist before the first bootstrap. If `~/.local/bin/agb` is missing, invoke `bootstrap` through the plugin's bundled launcher from the user's workspace:

```sh
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
```

If the user explicitly asked for `--force` or `--force-reinstall`, append that flag. Wait for it to finish, then report its output and exit code to the user (`0` = pass, `1` = failure or error). Do not try to locate or run the plugin's `bin/` or `dist/` files directly without `node-launcher.sh`.
