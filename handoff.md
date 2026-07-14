# Antigravity Booster - Session Handoff

## Context
This session is migrating to a new context window (and potentially a new macOS system) to leverage macOS sandbox capabilities (`sandbox-exec`) for live rail enforcement during `agb run`. 

## Current State
- **Wave 1 & Wave 2** are completed. 
- **PR #38** (CLI Commands table, help generation, and `install.sh` cleanup) is currently open on GitHub and awaiting merge.
- The `lib/agy.mjs` failure classification (Issue #14) and `agb run` preflight binary check (Issue #16) are verified to be fully implemented.
- The `.adlc/tickets.json` queue is currently empty.
- **Portability**: There is no stranded local infrastructure or pending `git worktree` state to migrate. Antigravity-booster cleans up its `adlc-ticket-*` worktrees upon successful completion, and we have no in-flight runs. The repository state commutes perfectly.

## Setup Instructions for the New Machine
Since you are migrating to a fresh clone on a new machine, the new agent/user should perform the following initialization:
1. **Clone the repository** and pull the `main` branch (ensure PR #38 is merged down first).
2. **Install dependencies**: Run `npm install`.
3. **Bootstrap ADLC**: Run `node bin/agb.mjs bootstrap` to install the local ADLC plugin and skills into your Antigravity setup (this wires up `~/.gemini/config/plugins/adlc-antigravity`).
4. **Sandbox Mode**: On macOS, `AGB_SANDBOX_GATES` is enabled by default. You no longer need to run `AGB_SANDBOX_GATES=0` as we did on Linux; you can now fully leverage `sandbox-exec` to securely enforce rails during ticket execution.

## Next Steps (Wave 3 & 4)
Proceed with the remaining backlog defined in **Tracking Issue #28**:
- **Wave 3 (P2)**: 
  - Issue #23 -> #24 (Log framing and observability)
  - Issue #25 -> #26 (agy wrapper / scheduler strike loop)
- **Wave 4 (Refactors)**: 
  - Issue #20 -> #21 (Cross-cutting refactors - these should be run *last* after Wave 3 merges)

To begin, grab the specs for the Wave 3 tasks from Tracking Issue #28, author them into `.adlc/tickets.json`, and trigger the agentic build out using `agb plan` / `agb run`.
