---
name: agb-sync-models
description: Audit live Antigravity models (agy models) and automatically synchronize model mappings, quota pool catalogs, and cross-model adversarial review routing tables.
---

# /agb-sync-models [--check] [--write] [--offline] [--json]

Inspects live models reported by Google Antigravity (`agy models`), audits current mappings in `lib/models.mjs`, `lib/pools.mjs`, and `skills/adversarial-review/references/models.json`, and updates definitions to support new model releases.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim:

```sh
~/.local/bin/agb sync-models [--check] [--write] [--offline] [--json]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-sync-models`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
