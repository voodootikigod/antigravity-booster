# Changelog

Notable changes to `antigravity-booster`. This project is pre-1.0 — see
[Stability](README.md#stability).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries before 0.4.0 were reconstructed from git history, so they summarise
rather than enumerate.

## [Unreleased]

## [0.8.0] — 2026-10-03

### Added

- **Antigravity 1.2.8 & ADLC 1.11.1 Modernization:** Upgraded core runtime and orchestration to support Google Antigravity CLI (`agy >= 1.2.8`) and the Agentic Development Lifecycle (`@adlc >= 1.11.1`).
- **Model Catalog & Quota Routing:** Integrated Gemini 3.8/3.7/3.6 model tiers; retired Gemini 3.5 variants; implemented dual-pool quota routing dividing Gemini and Claude/GPT-OSS model pools.
- **Structured Subprocess Protocol:** Integrated `agy --output-format stream-json` and `--json-schema` validation with watchdog controls for line length and total stream bytes.
- **Hardened Platform Sandboxing:**
  - **Linux**: Bubblewrap (`bwrap`) containment with read-only root mounts, masked `.gnupg` and host credentials, and loopback network denial.
  - **macOS**: Hardened Seatbelt profile enforcing strict worktree write containment and credential masking while supporting standard Darwin process execution.
  - **Windows**: AppContainer differential sandbox probing and replay-defended attestation nonces.
- **Transactional Attempt Databases:** Added per-attempt bare Git databases with external gitdir alternates, preventing worktree leakage and ensuring clean atomic rollbacks.
- **Modernization Skill (`skills/modernize/`):** Added automated 5-stage verification audit checking live environment compatibility, dependencies, architectural pillars, and cryptographic provenance.

### Changed

- **The ADLC directory ticket store (`.adlc/tickets/`) is now the canonical
  projection target.** `agb plan` and the per-worktree rail projection write
  the directory store (one canonical JSON shard per ticket beside a
  `.store.json` manifest) on new repos, and keep writing a legacy
  `.adlc/tickets.json` only where one is already checked in (1.x bridge) —
  never both, since the adlc-antigravity plugin's reader fails closed when
  both stores exist. `agb doctor` gained a Ticket Store check that reports
  the detected backend and fails on the both-stores state. This repo's own
  workspace migrated via `adlc ticket store migrate`. In-session rail
  enforcement on directory-store repos requires the `@adlc/antigravity`
  plugin ≥ 1.6.0 (older plugins degrade to the scheduler's post-hoc
  enforcement).
- `ensureGitignore` now writes the full canonical ADLC stanza into target
  repos (negating `.adlc/tickets/`, `.adlc/ticket-archive/`, `.adlc/specs/`,
  and `.adlc/config.json`), matching `adlc ticket store migrate` and the
  plugin's `adlc-init`.
- `@adlc/core` and `@adlc/antigravity` upgraded to 1.11.1; `@adlc/tickets`
  added as a direct dependency; CI installs `@adlc/cli@1.6.0`.
- Modernized documentation and added comparison matrix with built-in `/boost`
  command.

## [0.7.0] — 2026-07-21

### Breaking

- **`agb tui` and `agb status --ui` have been permanently removed.** The terminal UI was limited by terminal rendering engines and could not safely run in the background. It has been completely replaced by the Antigravity Sidecar dashboard.

### Added

- **Native Antigravity Plugin Support:** `antigravity-booster` is now officially an Antigravity Plugin.
- **Sidecar GUI Plugin:** You can now run `agb sidecar <repo>` and point the Antigravity UI to it via the AGB Dashboard panel. Port flexibility is supported (`AGB_SIDECAR_PORT` or `--port`), though the GUI manifest defaults to `3333`. Note that starting the server requires `--unsafe-open` to acknowledge the unauthenticated local HTTP exposure of private logs.

### Fixed

- **XSS & Path Traversal Prevention:** The new sidecar server blocks path traversal attempts from the browser, and the dashboard DOM safely escapes all inputs from model payloads to prevent Cross-Site Scripting. CSP headers have been hardened by dropping `unsafe-inline` scripts.
- **Improved Sidecar Log Tail:** The `events.jsonl` reader tracks true file offsets so the dashboard polls efficiently across long 20,000+ event orchestration runs, including gracefully clamping negative or NaN bounds.
- **Dashboard Stability:** Fixed crashes in the browser panel caused by unstringified model error payloads, ensuring strikes are rendered rather than silently dropping dashboard updates.

## [0.5.1] — 2026-07-19

### Fixed

- **A run whose repo lock was stolen mid-flight now aborts instead of reverting
  a checkout it no longer owns.** `acquireRepoLock` confirmed ownership once, at
  acquire time, and never re-checked. Because the stale-lock reclaim path can
  hand the lock to a second live process, the robbed run carried on and ran
  `git reset --hard` on a repo another run had taken over — the exact corruption
  the lock exists to prevent. Ownership is now re-verified in the merge critical
  section, alongside the branch and dirty-tree checks that were already there,
  and a lost lock fails the ticket rather than the repository.

### Known issues

- **Two concurrent runs can still acquire the same repo lock.** The reclaim path
  moves the lock out of its canonical path before verifying it is still the
  stale lock it read; while it is moved aside, the `mkdir` exclusion the scheme
  relies on is void. Re-verifying immediately before that move narrows the window
  but cannot close it — POSIX has no compare-and-swap on file content — so a real
  fix means changing the lock primitive. The guard above bounds the damage to a
  failed run in the meantime. Tracked in
  [#54](https://github.com/voodootikigod/antigravity-booster/issues/54).

## [0.5.0] — 2026-07-17

### Breaking

- **Node 22.19.0 or newer is now required** (`engines.node` moves from `>=18`).
  The TUI is now built on `@earendil-works/pi-tui`, whose own floor is
  `>=22.19.0`. Node 18 and 20 are both past end-of-life (2025-04-30 and
  2026-04-30). Stay on `0.4.x` if you need them. The CI matrix drops to `[22]`
  to match.
- **`agb tui` and `agb status --watch --ui` no longer use the alternate screen.**
  The dashboard renders into normal scrollback, so it neither clears the screen
  on entry nor erases itself on exit; the final frame stays in your scrollback.

### Fixed

- **The TUI no longer flickers.** It had no frame-committing layer at all: every
  tick wrote a full frame with `stdout.write('\x1b[H' + frame)` at 10fps,
  unconditionally, with the cursor visible and no synchronized-output markers.
  An idle dashboard wrote 212,600 bytes per 10 seconds while zero of its 24
  lines had changed. Rendering is now differential (only changed lines are
  written), wrapped in DECSET 2026 so terminals present frames atomically, and
  request-driven rather than timer-driven — an unchanged dashboard now writes
  **nothing at all**.
- **The TUI no longer garbles or scrolls on non-ASCII agent output.**
  `padTruncate` measured columns with `String.length`, counting a CJK grapheme
  as one column when it occupies two. A transcript containing Japanese text
  rendered a 115-column line into an 80-column viewport, which wrapped, pushed
  the frame down and scrolled the buffer on every repaint. Column math now runs
  through `visibleWidth`/`sliceByColumn`, which are grapheme-aware — so emoji
  are also no longer split mid-surrogate into invalid UTF-8.
- **Long runs no longer degrade the TUI.** The in-memory event list grew without
  bound and every frame rebuilt strings from the entire history to display ~11
  lines (12.21ms/frame at 20,000 events). It is now a bounded ring buffer.
- **The cursor is restored on every TUI exit path**, including `SIGINT`/`SIGTERM`
  and crashes, rather than leaving the terminal with a hidden cursor.

### Changed

- `agb status --watch --interval` now sets how often the run is polled for new
  data; it no longer sets a repaint rate, because repaints are driven by state
  changes.

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
