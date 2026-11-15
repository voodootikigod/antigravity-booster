---
name: code-review
description: Adversarially review a code change, branch, or pull request across 5 isolated reviewer personas (Correctness/Red-Team, Simplicity, Security, Evidence Runner, Anti-Slop) with neutral arbiter triage and author rebuttal.
---

# /code-review [repo-path] [ref] [--loop]

Run the 5-lens Cross-Model Adversarial Review Loop on your working tree or branch diff before merging or opening a pull request.

## Cross-Model Lens Routing (`adversarial-review/references/models.json`)

1.  **`correctness_redteam`**: `claude-opus-5-5-high` (`claude`) -> fallback `gemini-4-argon-high` (`gemini`)
2.  **`security`**: `gemini-4-argon-high` (`gemini`) -> fallback `claude-opus-5-5-high` (`claude`)
3.  **`simplicity`**: `claude-sonnet-5-5-medium` (`claude`) -> fallback `gemini-3.8-flash-medium` (`gemini`)
4.  **`evidence_runner`**: `gemini-3.8-flash-medium` (`gemini`) -> fallback `claude-sonnet-5-5-medium` (`claude`)
5.  **`anti_slop`**: `claude-sonnet-5-5-high` (`claude`) -> fallback `gemini-3.8-flash-high` (`gemini`)
6.  **`arbiter`**: `gemini-4-argon-high` (`gemini`) -> fallback `claude-opus-5-5-high` (`claude`)

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim (or `mcp__agb__agb_review` with `fiveLens: true` when the `agb` MCP server is connected):

```sh
~/.local/bin/agb review [repo-path] [ref] --five-lens [--loop] [--no-arbiter]
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/code-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
