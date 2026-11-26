---
name: implement-and-review
description: Implement a requested feature or ticket and immediately execute the full 5-lens adversarial review loop before claiming completion.
---

# /implement-and-review <task-description>

Directs the agent to implement code changes under ADLC supervision, run the repository's deterministic test gate (`npm test`, `pytest`, etc.), and immediately run the 5-lens Code Adversarial Review Loop (`/code-review`) until convergence before reporting completion.

## Workflow

1.  **Implement**: Author the requested code and unit tests within the declared scope while respecting frozen rails.
2.  **Verify**: Run the project's test and build gates (`npm test`, `npm run build`).
3.  **Adversarial Review Loop (Single-Pass + Delta Fix Verification)**: Execute the 5-lens Code Gate (`correctness_redteam`, `security`, `simplicity`, `evidence_runner`, `anti_slop`) + neutral `arbiter` against `main` (single-pass default with 1-turn host pre-baked context slices; note: `git diff main` excludes untracked files, so newly created untracked files must be staged/committed or inspected explicitly before running the review):

```sh
~/.local/bin/agb review . main --five-lens
```

4.  **Fix & Delta Re-Verify**: Apply accepted fixes, re-run tests, and on Round 2+ re-verify only the fix delta and prior findings (skipping untouched clean lenses) until `gate_verdict: "SHIP"` (exit code `0`) is achieved (pass `--thorough` or `--dry-rounds <n>` only when stochastic multi-dry convergence is explicitly desired):

```sh
~/.local/bin/agb review . main --five-lens --delta <pre-fix-ref> --prior-findings .review/last-findings.json
```

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/implement-and-review`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
