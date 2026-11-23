---
name: implement-and-review
description: Implement a requested feature or ticket and immediately execute the 5-lens Code Adversarial Review Loop
---

# /implement-and-review <task-description>

Implements the requested feature or ticket within declared scope, verifies deterministic build/test gates, and immediately executes the 5-lens Code Adversarial Review Loop (`/code-review`) until `SHIP` convergence before claiming completion.

## How to run it

After implementing the code and passing tests, use your shell tool (`run_command`) to run the antigravity-booster terminal shim against `main` (or `mcp__agb__agb_review` with `ref: "main"`, `fiveLens: true`, and `loop: true`). Note that `git diff main` omits untracked files, so newly created untracked files must be staged/committed or inspected explicitly before running the review:

```sh
~/.local/bin/agb review . main --five-lens --loop
```

Run it from the user's workspace, wait for it to finish, apply any accepted fixes, and report the final output and exit code to the user.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/implement-and-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
