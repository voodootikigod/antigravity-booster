# agy CLI — Hands-On Research (verified locally, v1.0.7, 2026-06-11)

Everything below was verified by direct probing on this machine unless marked
[web], which comes from the web-research report (see antigravity-gui.md for
sources).

## Invocation

- `agy --print --model "<name>"` reads the prompt from **stdin**, prints the
  final response to stdout, exit 0 on success. Errors print
  `Error: timed out waiting for response` (still exit 0 — **do not trust the
  exit code alone**; verify output content).
- `--print-timeout` default 5m; accepts Go durations (`80s`, `10m`).
- Model names are the exact strings from `agy models`:
  - `Gemini 3.5 Flash (Low|Medium|High)`
  - `Gemini 3.1 Pro (Low|High)`
  - `Claude Sonnet 4.6 (Thinking)`
  - `Claude Opus 4.6 (Thinking)`
  - `GPT-OSS 120B (Medium)`

## Context loading (verified)

- **`AGENTS.md` and `GEMINI.md` in the cwd both auto-load** into every prompt,
  including print mode. This is the worker-context delivery mechanism: the
  orchestrator writes an `AGENTS.md` (ticket + charter + rails) into each
  worktree before spawning the worker.
- Global skills auto-load from **`~/.gemini/skills/`** (verified: a worker
  listed all skills installed there). Project skills: `.agents/skills/` [web].
- Global context: `~/.gemini/GEMINI.md` [web].

## Tool use in print mode (verified)

- Workers **write files and run shell commands non-interactively** in print
  mode without `--dangerously-skip-permissions`, governed by the permission
  allowlist in `~/.gemini/antigravity-cli/settings.json`
  (`permissions.allow: ["command(git status)", ...]`) plus
  `allowNonWorkspaceAccess` and `trustedWorkspaces`.
- Tool-permission modes exist: `request-review` (default),
  `proceed-in-sandbox`, `always-proceed`, `strict` (read-only) [web].
  `strict` is the right mode for prosecutors/readers.

## Sandbox (verified)

`--sandbox` (macOS Seatbelt; macOS-only [web]) permitted in our probe:
`git init/status`, `npm --version`, `node -e`, `curl` (network!), and writes
under `/tmp`. Sandbox is therefore viable for builders; it restricts less than
expected. Decision: builders run `--sandbox` inside worktrees; skip-perms not
needed for the common path.

## Conversation store

- `--continue`, `--conversation <ID>` resume sessions; conversations are
  SQLite under `~/.gemini/antigravity-cli/conversations/` [web: native since
  1.0.4]. Desktop-app conversations can import to CLI (fixed in 1.0.6) [web].
- Fix-loops can resume a builder's conversation (`--conversation`) per ADLC
  Appendix F: fixers continue, reviewers never do.

## Quirks

- `agy inspect` requires a TTY (bubbletea error when piped) — unusable from
  scripts.
- Exit code 0 even on print-timeout. Always assert on output content
  (sentinel markers).
- The same `~/.gemini/GEMINI.md` is read by legacy Gemini CLI — config
  conflict reports exist [web].
