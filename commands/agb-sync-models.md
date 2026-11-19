---
name: agb-sync-models
description: Audit live Antigravity models (agy models) against lib/models.mjs and regenerate references/models.json (--write) in an antigravity-booster checkout
---

# /agb-sync-models [--check] [--write] [--offline] [--json]

Audits live models reported by Google Antigravity (`agy models`) against the bundled `lib/models.mjs` catalog. Passing `--write` regenerates `skills/adversarial-review/references/models.json` inside an `antigravity-booster` repository checkout (it refuses to write in arbitrary user workspaces and does not mutate `lib/models.mjs` or `lib/pools.mjs`).

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb sync-models [--check] [--write] [--offline] [--json]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-sync-models`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
