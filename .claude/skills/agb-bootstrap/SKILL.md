---
name: agb-bootstrap
description: Install the ~/.local/bin/agb terminal shim and bundled companion plugin adlc-antigravity after installing antigravity-booster. Use on first run or when ~/.local/bin/agb is missing.
---

# /agb-bootstrap [--force]

First-run setup after `agy plugin install`: writes the `~/.local/bin/agb` terminal shim (`0755`) and installs the bundled `adlc-antigravity` companion plugin from the verified tarball in `vendor/cache/`. Idempotent — safe to re-run; pass `--force` to overwrite an existing shim that was not created by `agb`.

## How to run it

`bootstrap` is the one command that can run **before** `~/.local/bin/agb` exists, so invoke it through the plugin's bundled launcher rather than the shim. Use your shell tool (`run_command`) from the user's workspace:

```sh
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
```

If the user explicitly asked for `--force`, append `--force`. Wait for it to finish, then report its output and exit code to the user (`0` = pass, `1` = failure or error).
