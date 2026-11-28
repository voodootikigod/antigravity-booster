# Wave 5 Spec: Interactive Strike-2 Escalation & `remote-sdk` Local Merge-Queue Integration

## Goals
1. **Interactive Strike-2 Escalation (`T-W5-1`)**: When `agb run --interactive` hits Strike 2 (`flail-detector` or repeated failure), pause only the affected ticket without aborting sibling wave tickets, emit a terminal bell (`\x07`) + OSC title alert (`⚠ rescue <ticketId>`), and run a structured `/grill-me`-style escalation prompt supporting `retry` (with optional operator guidance injected into the next strike prompt), `skip` (park the ticket while siblings continue), or `abort`.
2. **`remote-sdk` Local Merge-Queue Verification (`T-W5-2`)**: Extend `runRemoteSdkPlan` in `lib/remote-sdk-worker.mjs` with an opt-in `merge: true` mode (and injectable `verifyBranch` / `mergeBranch` hooks) that verifies each completed remote ticket branch against rails and `gate.test` (or custom verifier) and merges verified branches sequentially into the target branch, populating `report.merged` and failing closed (blocking downstream dependents) if verification or merge fails.
3. **CLI, Docs, Release Audit & Bundles (`T-W5-3`)**: Wire `--interactive` and `--merge` into `bin/agb.mjs` (`COMMANDS.run` and `cmd === 'run'`), register `lib/interactive-escalation.mjs` in `scripts/release-audit-collect.mjs`, update `commands/agb.md` and `skills/agb/SKILL.md`, regenerate `website/generated/*`, and rebuild `dist/agb.mjs`.

## Scope & Frozen Rails
- **Frozen Rails (Untouched):** `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`.
- **No Raw Model Literals:** No hardcoded model slugs outside `lib/models.mjs`.
- **Clean Degradation:** Escalation and merge helpers return structured results and never crash sibling workers or leak unhandled rejections.

## Tickets

### Ticket 1: `T-W5-1` — Interactive Strike-2 Escalation (`--interactive`)
- **Scope:** `lib/interactive-escalation.mjs`, `lib/scheduler.mjs`, `test/interactive-escalation.test.mjs`
- **Rails:** `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges:** `T-W5-3`
- **Deliverable:** Create `lib/interactive-escalation.mjs` exporting `formatEscalationAlert`, `buildGrillMeEscalationPrompt`, and `runInteractiveEscalation` (terminal bell + OSC title alert, structured `/grill-me` interview supporting `retry` with guidance, `skip`, or `abort`). Wire `interactive` and `onEscalation` into `lib/scheduler.mjs` at Strike-2 flail/failure so only the affected ticket pauses without aborting sibling wave tickets. Add unit and scheduler-integration tests in `test/interactive-escalation.test.mjs`.

#### Acceptance Criteria
- [ ] `node --test test/interactive-escalation.test.mjs` passes with coverage of terminal alert emission, `/grill-me` prompt formatting, `retry` with guidance, `skip`, `abort`, and scheduler non-aborting sibling isolation.

### Ticket 2: `T-W5-2` — Local Merge-Queue Verification for `remote-sdk`
- **Scope:** `lib/remote-sdk-worker.mjs`, `test/remote-sdk-worker.test.mjs`
- **Rails:** `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges:** `T-W5-3`
- **Deliverable:** Extend `lib/remote-sdk-worker.mjs` with `verifyAndMergeRemoteBranch` and opt-in `merge: true` (plus `verifyBranch` / `mergeBranch` hooks) in `runRemoteSdkPlan` so completed remote ticket branches are sequentially verified and merged into the target branch, populating `report.merged` and failing closed (blocking downstream dependents) on verification or merge failure. Expand `test/remote-sdk-worker.test.mjs`.

#### Acceptance Criteria
- [ ] `node --test test/remote-sdk-worker.test.mjs` passes with coverage of `merge: true`, sequential git `--no-ff` merge into target branch, and rail/verification failure blocking downstream dependents.

### Ticket 3: `T-W5-3` — CLI Wiring, Docs, Release Audit & Bundles
- **Scope:** `bin/agb.mjs`, `scripts/release-audit-collect.mjs`, `commands/agb.md`, `skills/agb/SKILL.md`, `website/generated/**`, `dist/agb.mjs`
- **Rails:** `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Depends on:** `T-W5-1`, `T-W5-2`
- **Deliverable:** Add `--interactive` and `--merge` flags to `COMMANDS.run` and `cmd === 'run'` in `bin/agb.mjs`, register `lib/interactive-escalation.mjs` in `scripts/release-audit-collect.mjs`, document flags in `commands/agb.md` and `skills/agb/SKILL.md`, regenerate `website/generated/*`, and rebuild `dist/agb.mjs`.

#### Acceptance Criteria
- [ ] `npm run build && node website/scripts/gen-reference.mjs --check && node website/scripts/check-all.mjs && npm run skills:check` passes.

## Acceptance Criteria
- `node --test test/interactive-escalation.test.mjs` passes with coverage of terminal alert emission, `/grill-me` prompt formatting, `retry` with guidance, `skip`, `abort`, and scheduler non-aborting sibling isolation.
- `node --test test/remote-sdk-worker.test.mjs` passes with coverage of `merge: true`, sequential git `--no-ff` merge into target branch, rail/verification failure blocking downstream dependents, and CLI `--merge` / `--interactive` flag validation.
- `npm run build && node website/scripts/gen-reference.mjs --check && node website/scripts/check-all.mjs && npm run skills:check` passes.
- `npx adlc hollow-test --base origin/main` kills 100% of valid mutants (`0` survivors).
- `npm test` passes with `0` failures.
