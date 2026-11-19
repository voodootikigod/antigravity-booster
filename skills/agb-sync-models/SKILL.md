---
name: agb-sync-models
description: Audit live Antigravity models (agy models) against the bundled lib/models.mjs catalog and regenerate skills/adversarial-review/references/models.json inside an antigravity-booster checkout (--write).
---

# /agb-sync-models [--check] [--write] [--offline] [--json]

Audits live models reported by Google Antigravity (`agy models`) against the bundled `lib/models.mjs` catalog. Passing `--write` regenerates `skills/adversarial-review/references/models.json` inside an `antigravity-booster` repository checkout (it refuses to write in arbitrary user workspaces and does not mutate `lib/models.mjs` or `lib/pools.mjs`).

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim:

```sh
~/.local/bin/agb sync-models [--check] [--write] [--offline] [--json]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-sync-models`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
