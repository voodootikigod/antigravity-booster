---
name: agb-handoff
description: Run single-ticket ADLC P5+P6 verification, cross-model prosecution, and handoff dossier (/agb-handoff <ticket-id> [repo-path])
---

# /agb-handoff <ticket-id> [repo-path] [--base <ref>] [--html <file>] [--prompt-only] [--json]

Executes the interactive single-ticket ADLC P5+P6 handoff pipeline for Antigravity IDE, the 7 IDE Extensions, CLI sessions, and Cloud VMs:

1. **Deterministic P5 Gate (`gate-ticket`)**: Verifies strict ticket `scope`, physical symlink containment, `adlc rails-guard`, sandboxed build/test execution, `.adlc/learned-checks.json` invariants, `browserGate` route/console checks, `adlc hollow-test`, and `adlc gate-manifest` recording.
2. **Cross-Model Prosecution**: Runs single-diff `prosecute()` across model families when `agy` and quota are available, or emits a structured prosecutor prompt in `--prompt-only` / zero-`agy` fallback mode (pass `--require-prosecutor` to fail closed if `agy` is unavailable).
3. **P6 Sign-Off Dossier**: Emits a concise Markdown handoff summary (and optional interactive HTML P6 cockpit via `--html <file>`).

## How to run it

Use your shell tool (`run_command`) to run the antigravity-booster terminal shim, passing the user's arguments through unchanged (quote each argument; never interpolate untrusted text into a larger shell string):

```sh
~/.local/bin/agb handoff <ticket-id> [repo-path] [--base <ref>] [--worktree <dir>] [--test-cmd <cmd>] [--build-cmd <cmd>] [--browser-url <url>] [--html <file>] [--skip-hollow] [--skip-browser] [--autocommit] [--no-prosecute] [--prompt-only] [--require-prosecutor] [--no-manifest] [--json]
```

Run it from the user's workspace, wait for it to finish, then report the handoff dossier and exit code to the user (exit 0 = ready for P6 handoff, 2 = gate or prosecution blocked, 1 = usage or internal error). If `prosecution.mode` is `prompt-only` or `prompt-only-fallback`, evaluate the emitted prosecutor prompt directly in your session against the JSON schema before presenting P6 sign-off.

## If the shim is missing

If `~/.local/bin/agb` does not exist (the shell reports `No such file or directory` or `not found`), stop and tell the user that antigravity-booster has not been bootstrapped yet. They must run this once from a terminal, then retry `/agb-handoff`:

`/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap`

Do not try to locate or run the plugin's `bin/` or `dist/` files yourself.
