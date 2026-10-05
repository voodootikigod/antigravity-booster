---
name: agb-migrate
description: Migrate from the npm-global/legacy install to the native agy plugin, or roll back
---

# /agb-migrate [--rollback]

Migrates an existing npm-global or legacy `.agents/plugins/agb` installation to the native `antigravity-booster` agy plugin: it snapshots the current state, installs the plugin and the `~/.local/bin/agb` terminal shim, and removes stale skill links. Migration is resumable; re-running it continues from the recorded state.

To undo a migration, run:

```sh
~/.local/bin/agb migrate --rollback
```

Rollback restores the pre-migration baseline snapshot. Both directions take the migration lock; if the command reports the lock is held, show the user the message rather than retrying.

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb migrate [--rollback]
```

Run it from the user's workspace, wait for it to finish, then report its output and exit code to the user (exit 0 = pass, 2 = gate failure or findings, 1 = usage or internal error).

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-migrate`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
