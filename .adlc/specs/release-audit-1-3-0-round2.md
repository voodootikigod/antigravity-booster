# Release Audit 1.3.0 Round 2 — Blocker + SHOULD-FIX Remediation Plan

- **Base**: `fix/release-audit-1-3-0-round2`
- **Gate**: `npm test`

## Overview

Resolve the 1 surviving `BLOCKER` (`lib/status.mjs:628` stale `.booster/report.json` in `watchStatus()`) and all 33 `SHOULD-FIX` findings from the second `1.3.0` release audit (`VERDICT: NO-GO`), keeping standing frozen rails (`lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`) untouched.

### Ticket 1: `T-AUDIT2-1` — Fix watchStatus stale report BLOCKER, Windows PATH append, doctor DATA_ROOT symlink, and sync-models --write guard

- **Scope**: `lib/status.mjs`, `lib/agy.mjs`, `lib/doctor.mjs`, `bin/agb.mjs`, `scripts/sync-models.mjs`, `test/audit2-cli-status-doctor.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`
- **Tier**: `mid`

#### Acceptance Criteria
- [ ] `RunStatus` clears stale `.booster/report.json` on new run start and stamps `runId`, and `watchStatus()` only accepts `.booster/report.json` when `rep.runId === state.runId`.
- [ ] Duplicate Linux-only `:` PATH append block in `lib/agy.mjs:1143-1149` is removed.
- [ ] `checkHookLogDir` in `lib/doctor.mjs` checks `lstatOrNull(dataRoot)?.isSymbolicLink()`.
- [ ] `agb sync-models --write` refuses to write into arbitrary non-booster `process.cwd()` workspaces.
- [ ] Unit tests in `test/audit2-cli-status-doctor.test.mjs` pass.

### Ticket 2: `T-AUDIT2-2` — Sanitize git env in worktrees/scheduler, fix cross-family failover, sandbox hollow-test process, gate AGB_HOME_DIR when bundled, and fix reviewPlan/schemas

- **Scope**: `lib/worktrees.mjs`, `lib/scheduler.mjs`, `lib/scheduler-verify.mjs`, `lib/adlc-bridge.mjs`, `lib/run-integrity.mjs`, `lib/review.mjs`, `lib/schemas.mjs`, `test/audit2-scheduler-gates.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`
- **Tier**: `mid`

#### Acceptance Criteria
- [ ] `lib/worktrees.mjs` `git()` and `lib/scheduler.mjs` git calls pass `env: sanitizedGitEnv()`.
- [ ] `pickAlternateModel({ crossPool: true })` prefers `upstreamPoolOf(m) !== upstreamPoolOf(current)`.
- [ ] Pass 2 `adlc hollow-test` executes inside OS sandbox when `AGB_SANDBOX_GATES !== '0'` so target-repo `node_modules/typescript` cannot escape onto the host.
- [ ] `AGB_HOME_DIR` is ignored when `bundled` / `IS_BUNDLED` is true in `lib/adlc-bridge.mjs`, `lib/scheduler-verify.mjs`, and `lib/run-integrity.mjs`.
- [ ] `reviewPlan()` propagates `arbiterDegraded` / `arbiterError`, and `ARL_FINDING_SCHEMA` / `ARBITER_TRIAGE_SCHEMA` accept `['string', 'integer']` for `line`.
- [ ] Unit tests in `test/audit2-scheduler-gates.test.mjs` pass.

### Ticket 3: `T-AUDIT2-3` — Policy-guard Go JSON case-folding parity and supply-chain gate hardening

- **Scope**: `hooks/policy/shell.mjs`, `hooks/policy/evaluate.mjs`, `scripts/check-bundle-externals.mjs`, `scripts/stage-marketplace-plugin.mjs`, `test/audit2-policy-supply.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`
- **Tier**: `mid`

#### Acceptance Criteria
- [ ] `classifyRunCommand`, `buildContext`, `isBoosterMcpTool`, `boosterMcpToolName`, `evaluateMcpTool`, and `stepOne` normalize args case-insensitively and fail closed on case collisions.
- [ ] `scripts/check-bundle-externals.mjs` records all unquoted dynamic args (including builtin-named identifiers like `path`), with `path` allowlisted only for the two `@adlc` TypeScript syntax-check bundles.
- [ ] `scripts/stage-marketplace-plugin.mjs` does not fall back to `fake-agy` in CLI mode and fails closed when `agy` is missing unless `--allow-skip` is passed.
- [ ] Unit tests in `test/audit2-policy-supply.test.mjs` pass.

### Ticket 4: `T-AUDIT2-4` — Docs, skills, commands, rules, CHANGELOG, website generator, and bundle rebuild

- **Scope**: `CHANGELOG.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `rules/AGENTS.md`, `skills/**`, `commands/**`, `website/**`, `dist/**`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`
- **Tier**: `mid`

#### Acceptance Criteria
- [ ] All doc-claim SHOULD-FIX findings across `CHANGELOG.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `rules/AGENTS.md`, `skills/**`, `commands/**`, `website/scripts/gen-reference.mjs`, `website/env-docs.json`, and `website/content/docs/**` are resolved.
- [ ] `npm run build`, `node website/scripts/gen-reference.mjs`, `node website/scripts/check-all.mjs`, `npm run plugin:validate`, `npm run skills:check`, and `npm test` all pass.
