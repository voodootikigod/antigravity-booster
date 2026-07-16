# Changelog

Notable changes to `antigravity-booster`. This project is pre-1.0 — see
[Stability](README.md#stability).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries before 0.4.0 were reconstructed from git history, so they summarise
rather than enumerate.

## [Unreleased]

## [0.4.3] — 2026-07-16

### Fixed

- **agb doctor:** `checkAgyAuth` no longer hangs when no TTY is attached. The
  `agy models` invocation is now wrapped with `script` on macOS and Linux to
  allocate a PTY, so background telemetry cannot block it indefinitely. The
  check timeout also rises from 5s to 15s to tolerate slow network responses.

## [0.4.2] — 2026-07-15

### Fixed

- **agb doctor:** Fixed `checkPlugin` logic and contract checking so that valid plugin installations are correctly recognized instead of triggering the legacy version warning.

## [0.4.1] — 2026-07-15

### Fixed

- **CI / Publish Workflow:** Add missing `adlc` CLI installation to the publish workflow, resolving `ENOENT` test failures during `npm publish`.

## [0.4.0] — 2026-07-15

### Added

- `agb tui` — full-screen, zero-dependency dashboard reading live from
  `events.jsonl`, plus `agb status --watch --ui`.
- `agb --version` (also `-v`, `version`).
- Per-run `events.jsonl` append-only event log, and per-ticket transcripts
  normalised to JSONL.
- Project isolation for `runAgy`, allowing per-run boundaries.
- `SECURITY.md` (disclosure process and threat model), `CONTRIBUTING.md`, and
  this changelog.
- CI now runs on macOS as well as Linux, across Node 18/20/22. The macOS leg
  exercises the `sandbox-exec` gate-sandbox tests, which skip on Linux and so had
  never run in CI.

### Fixed

- **Run state and transcripts are now written owner-only (`0600`).** They record
  full prompts and model output, which can quote secrets read from the worktree;
  previously they were world-readable.
- `@adlc/core` and `@adlc/antigravity` upgraded to 1.4.1. The plugin manifest
  declares `adlcContract: 1` from 1.4.0, so the bootstrap handshake now reports
  compatible and **live rail enforcement is active** instead of degrading to
  tolerant mode.
- Documentation corrected: `agb status` was described as a live full-screen
  dashboard (it is a one-shot render), the plugin was described as unpublished,
  and the README opened with a link to a repo no public reader can access.
- The published package no longer ships the test suite, CI config, or
  development scratch — `files` is scoped to what the CLI needs at runtime.
- The test suite no longer writes scratch files into the working tree.

### Security

- Merge-gate, worktree rebase-conflict, and DAG-ordering guards are now covered by
  tests verified to fail when the guard is removed. Previously all three could be
  deleted with the suite fully green.

## [0.3.1] — 2026-06-22

Patch release.

## [0.3.0] — 2026-06-22

ADLC alignment: the toolkit is consumed from the `@adlc/*` npm packages rather
than a sibling checkout.

## [0.2.0] — 2026-06-11

First public release: ticket-DAG scheduler, quota-pool-aware dispatch, worktree
fleets, cross-model prosecution, and deterministic gates.

[Unreleased]: https://github.com/voodootikigod/antigravity-booster/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/voodootikigod/antigravity-booster/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/voodootikigod/antigravity-booster/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/voodootikigod/antigravity-booster/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/voodootikigod/antigravity-booster/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/voodootikigod/antigravity-booster/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/voodootikigod/antigravity-booster/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/voodootikigod/antigravity-booster/releases/tag/v0.2.0
