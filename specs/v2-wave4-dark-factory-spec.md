# Specification: v2.0.0 Wave 4 — Dark-Factory Verification, Ephemeral Digital Twins & 6-Event Lifecycle Hooks

- **Status**: Approved Architecture (Stacked on `explore-advancements` PR #195)
- **Base**: `explore-advancements`
- **Gate**: {"build":"npm run build","test":"npm test"}

---

## 1. Context & Owner-Aligned Design Decisions

Waves 1–3 (`explore-advancements`, PRs #195, #198, #199) delivered the Antigravity 2.0 `statusLine` HUD, authenticated `control.sock` IPC, `agb rescue`, 3-layer KV-cache-stable charters, default-on `AGENTS.md` hydration, billable-token bandit routing, post-guard `gate.autofix`, `agb plan --estimate` + `!RUNWAY`, `FactoryLedger`, OSC 8 / OSC 9 attention cockpit + `tmux`/`cmux`/`herdr` mux orchestration, and the P6 Hunk-Level Sign-Off Workbench (`agb accept` / `agb_accept`).

Wave 4 (`v2-wave4-dark-factory`) completes the `v2.0.0` **Dependable & Cost-Effective Agentic Software Factory** stack (`Proposals D1, D2, D3`):

1. **PR Base Branch (`A1`):** Stack `v2-wave4-dark-factory` onto `explore-advancements`, completing the Wave 2–4 stack before running `/release-audit` and opening the final rebased convergence PR onto `main`.
2. **Sealed Holdout Scenarios (`D1`, Default-On for `frontier` Tickets):** Automatically activate sealed black-box holdout scenarios on `frontier` tickets (`tier === 'frontier'` or `ticket.holdout_scenarios === true`, with `ticket.holdout_scenarios === false` / `plan.holdouts === false` opt-out). Store holdout test files strictly under `<plugin_data>/holdouts/<repoHash>/<runId>/<ticketId>/` (mechanically sealed from builders by `PreToolUse` `boosterDataRoots` and read-only inside P5 OS sandboxes). Execute inside the OS sandbox during P5 and sanitize any failure output so builders receive only high-level behavioral scenario symptoms — never holdout file paths, stack frames, or expected assertion literals.
3. **Dual-Mode Ephemeral "Digital Twin" Fixture Sidecars (`D2` — `A2`):** Support declarative zero-network `plan.gate.twins` (`[{ name, envVar, routes: [{ method, path, status, headers, body }] }]`) running as real `127.0.0.1:0` loopback HTTP servers on the host (post-merge gates, CLI, and `AGB_SANDBOX_GATES=0` containers) **plus** a read-only `NODE_OPTIONS=--import` route interceptor under `<plugin_data>/twins-runtime/<uuid>/` inside network-denied P5 worktree sandboxes (`bwrap --unshare-net` on Linux, Seatbelt `(deny network*)` on macOS) — requiring **zero** edits to frozen `lib/gates.mjs` and opening zero external network holes.
4. **Full 6-Event In-Session Lifecycle Hooks & Executable `agb distill --compile-checks` (`D3` — `A3`):**
   - Register `PostToolUse` (grouped), `PreInvocation` (flat), `PostInvocation` (flat), and `Stop` (flat) alongside `PreToolUse` and `SessionStart` in `hooks.json` (`agy plugin validate --strict` clean).
   - Emit 0-model-token `metadata.user_markdown` readiness/context-rot cards (`systemMessage: ""`) on `PreInvocation`, and enforce an **active-ticket-scoped** `Stop` Dirty-Since-Gate continuation (`decision: "continue"`) strictly when `!continuationActive`, `terminationReason === "NO_TOOL_CALL"`, not in headless worker mode, and an active `.adlc/tickets/` shard has unverified edits since the last passing test/gate.
   - Extend `agb distill --compile-checks` to emit ReDoS-safe, declarative `.adlc/learned-checks.json` invariants evaluated deterministically during P5 gates.

---

## 2. Standing Architectural & Security Invariants

- **Frozen Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, and `plugin.json` are strictly read-only across all Wave 4 tickets.
- **Static Literals & Env-Token Discipline**: `const COMMANDS` in `bin/agb.mjs` and `const TOOLS` in `mcp/server.mjs` must remain pure static JS literals parseable by `website/scripts/lib/jslit.mjs`. `mcp/` files must introduce zero `AGB_*`, `ADLC_*`, or `ANTIGRAVITY_*` `process.env` tokens.
- **Hook Output & Bundled Isolation Contracts**:
  - Never emit `decision: "allow"` anywhere in `hooks/**` (`PASS` is `{}`).
  - `hooks.json` uses **grouped** `[{ matcher: "*", hooks: [...] }]` ONLY for `PreToolUse` and `PostToolUse`, and **flat** `[{ type: "command", ... }]` for `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop`.
  - In bundled plugin builds (`__AGB_BUNDLED__ === true`), ignore unverified path overrides (`AGB_HOLDOUT_DIR`, `AGB_HOME_DIR`) and resolve `<plugin_data>` strictly from `~/.gemini/antigravity-cli/plugin_data/antigravity-booster`.
- **Sandboxed Execution & Information Barrier**:
  - P5 holdout execution against untrusted candidate worktrees MUST run inside the OS sandbox (`bwrap --unshare-net` / `sandbox-exec`) when `AGB_SANDBOX_GATES !== '0'`, failing closed when unavailable, and clean any candidate scratch writes afterward.
  - Holdout failure messages returned to `regenPrompt` must strip holdout paths, line numbers, stack frames, and `Expected`/`Actual` literals.

---

## 3. Ticket Decomposition (`T-W4-1` – `T-W4-6`)

### Ticket 1: `T-W4-1` — Sealed Holdout Scenarios Engine (`lib/holdout.mjs`)

- **Scope**: `lib/holdout.mjs`, `test/holdout.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W4-1 -> T-W4-5, T-W4-6`
- **Tier**: `frontier`
- **Pool Hint**: `claude-gpt`
- **Objectives**:
  1. Create `lib/holdout.mjs` exporting `shouldRunHoldoutScenarios(ticket, plan)` (default-on for `tier === 'frontier'` or `ticket.holdout_scenarios === true` or non-empty `ticket.holdout_scenarios` array; opt-out via `ticket.holdout_scenarios === false` or `plan?.holdouts === false`), `selectOppositeHoldoutPool(poolHint, builderModelSlug)`, `resolveHoldoutDir({ repo, runId, ticketId, env, bundled })` (`<plugin_data>/holdouts/<repoHash16>/<safeRunId>/<safeTicketId>`, `0o700`, `ESYMLINK`-safe, ignoring `AGB_HOLDOUT_DIR`/`AGB_HOME_DIR` when `bundled === true`), `stageHoldoutScenarios`, `listHoldoutScenarios`, `cleanHoldoutScenarios`, `buildHoldoutAuthorPrompt`, `extractHoldoutCodeBlock`, `sanitizeHoldoutFailureOutput`, `verifyHoldoutRedPhase`, and `runHoldoutScenarios`.
  2. Enforce OS-sandboxed execution (`bwrap --unshare-net` on Linux, `sandbox-exec` on macOS) in `runHoldoutScenarios` with `AGB_CANDIDATE_ROOT` pointing at the candidate worktree, failing closed when `sandbox === true` and `AGB_SANDBOX_GATES !== '0'` on a host without an OS sandbox, and stripping holdout paths, line numbers, stack frames, and expected/actual literals in `sanitizeHoldoutFailureOutput`.
- **Acceptance Criteria**:
  - `shouldRunHoldoutScenarios` defaults to `true` for `frontier` tickets and honors opt-outs; `stageHoldoutScenarios`/`listHoldoutScenarios`/`cleanHoldoutScenarios` reject symlinked paths and validate `node --check` syntax; `verifyHoldoutRedPhase` rejects tautological tests passing on base; `runHoldoutScenarios` executes sealed holdouts against `AGB_CANDIDATE_ROOT`; and `sanitizeHoldoutFailureOutput` leaks zero holdout paths, line numbers, or assertion literals. Verify: `node --test test/holdout.test.mjs`

--------------------------------------------------------------------------------

### Ticket 2: `T-W4-2` — Dual-Mode Ephemeral Digital Twin Fixture Sidecars (`lib/twins.mjs`)

- **Scope**: `lib/twins.mjs`, `test/twins.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W4-2 -> T-W4-5`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Create `lib/twins.mjs` exporting `validateTwinsConfig(twins)`, `startDigitalTwins(twins, { runtimeRoot, env, bundled })`, and `buildTwinGateEnv(baseEnv, handle, { sandboxed })`.
  2. Validate twin names, safe uppercase `envVar` names (forbidding `PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `AGB_*`, `ADLC_*`, `ANTIGRAVITY_*`, `GIT_*`, and secret/credential keys), HTTP methods, `/`-prefixed paths, status codes (`100..599`), CR/LF-free headers, and bounded payload size (`<= 256 KiB`).
  3. Bind each twin HTTP server strictly to `127.0.0.1` ephemeral port `0` with active socket tracking for immediate `stop()` teardown, AND materialize a read-only (`0o400`) `NODE_OPTIONS=--import` route-interceptor bundle under `<plugin_data>/twins-runtime/<uuid>/` so `fetch` and `node:http` requests to twin loopback URLs succeed deterministically inside network-denied P5 sandboxes while non-twin network requests continue to fail closed.
- **Acceptance Criteria**:
  - `validateTwinsConfig` rejects forbidden env vars, CRLF headers, and malformed routes; `startDigitalTwins` serves declarative routes on `127.0.0.1:<ephemeralPort>` and tears down open keep-alive sockets cleanly on `stop()`; and `buildTwinGateEnv(..., { sandboxed: true })` serves twin `fetch` and `http.request` calls in a child Node process even when real network access is unreachable while leaving non-twin hosts unintercepted. Verify: `node --test test/twins.test.mjs`

--------------------------------------------------------------------------------

### Ticket 3: `T-W4-3` — Executable Learned Invariants (`agb distill --compile-checks`, `lib/distill.mjs`)

- **Scope**: `lib/distill.mjs`, `test/bandit-distill.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W4-3 -> T-W4-5, T-W4-6`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Extend `distillRunDefenses` in `lib/distill.mjs` with `compileChecks = false` to synthesize declarative, non-Turing-complete `.adlc/learned-checks.json` rules (`forbidLiteral`, `requireLiteral`, ReDoS-guarded `forbidRegex`, `glob`) from recurring finding clusters and explicit `finding.check` metadata, written atomically with symlink rejection.
  2. Export `validateLearnedChecksSpec(spec)` (rejecting nested-quantifier ReDoS regexes, oversized patterns `> 160` chars, or path-escaping globs) and `runLearnedChecks(repoRoot, { changedFiles, checksPath })` returning `{ ok, checkedFiles, violations }` across regular non-symlink repo files (`<= 512 KiB`).
- **Acceptance Criteria**:
  - `distillRunDefenses({ compileChecks: true })` writes valid `.adlc/learned-checks.json` and rejects symlinked `.adlc` targets; `validateLearnedChecksSpec` rejects ReDoS nested quantifiers; and `runLearnedChecks` deterministically flags matching violations on `changedFiles` with line numbers while degrading cleanly to `{ ok: true, violations: [] }` when `.adlc/learned-checks.json` is absent. Verify: `node --test test/bandit-distill.test.mjs`

--------------------------------------------------------------------------------

### Ticket 4: `T-W4-4` — 6-Event In-Session Lifecycle Hooks (`hooks/lifecycle.mjs`, `hooks.json`, `lib/agy.mjs`)

- **Scope**: `hooks/lifecycle.mjs`, `hooks.json`, `lib/agy.mjs`, `test/lifecycle-hooks.test.mjs`, `test/plugin-layout.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W4-4 -> T-W4-5, T-W4-6`
- **Tier**: `frontier`
- **Pool Hint**: `claude-gpt`
- **Objectives**:
  1. Create zero-dependency `hooks/lifecycle.mjs` (pure Node built-ins only, zero `decision: "allow"`) handling `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`:
     - Immediately output `{}\n` when `AGB_WORKER_TICKET`, `AGB_WORKER_MODE`, `AGB_HOOK_DISABLE`, or `AGB_LIFECYCLE_HOOKS === '0'` is set.
     - Persist symlink-safe per-conversation state under `<plugin_data>/session-state/<conversationId>.json` (`0o700` dir, `0o600` atomic write).
     - Track `dirtySinceGate` on mutating tool completions inside active-ticket ADLC repos and clear `dirtySinceGate` on passing test/gate `run_command` executions (`PostToolUse` -> `{}`).
     - Emit 0-token `injectSteps` `metadata.user_markdown` (`systemMessage: ""`) on `PreInvocation` for initial active-ticket/rail readiness and one-time turn-threshold context-rot guidance (`/compact`).
     - Emit `{ decision: "continue", reason: "..." }` on `Stop` **only** when `!payload.continuationActive`, `payload.terminationReason === 'NO_TOOL_CALL'`, an active `.adlc/tickets/` ticket exists, `dirtySinceGate === true`, and `stopContinuationCount < 1` since the last edit; otherwise `{}`.
  2. Register `PostToolUse` (grouped `matcher: "*"`) and `PreInvocation`, `PostInvocation`, `Stop` (flat arrays) in `hooks.json`; stage `hooks/lifecycle.mjs` in `stageHooksOnlyBoosterPlugin` (`lib/agy.mjs`); and update `test/plugin-layout.test.mjs`.
- **Acceptance Criteria**:
  - `hooks/lifecycle.mjs` passes unit/subprocess tests across all 4 events (including headless fast-exit, `continuationActive: true` stop-loop prevention, active-ticket scoping, 0-token `systemMessage: ""` `PreInvocation` badges, and symlink rejection), `stageHooksOnlyBoosterPlugin` stages `hooks/lifecycle.mjs`, and `npm run plugin:validate` (`agy plugin validate --strict`) passes with 0 errors, 0 warnings, and 0 notes. Verify: `node --test test/lifecycle-hooks.test.mjs test/plugin-layout.test.mjs && npm run plugin:validate`

--------------------------------------------------------------------------------

### Ticket 5: `T-W4-5` — Plan Schema & Scheduler P5 Integration (`holdouts`, `gate.twins`, `learned-checks`)

- **Scope**: `lib/schemas.mjs`, `lib/plan-integrity.mjs`, `lib/plan.mjs`, `lib/shape.mjs`, `lib/brain.mjs`, `lib/rescue.mjs`, `lib/scheduler-verify.mjs`, `lib/scheduler.mjs`, `test/scheduler.test.mjs`, `test/shape.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W4-5 -> T-W4-6`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Validate `plan.holdouts` (`boolean`), `ticket.holdout_scenarios` (`boolean` or inline scenario specs), and `plan.gate.twins` (`validateTwinsConfig`) in `lib/schemas.mjs` (`BRAIN_PLAN_SCHEMA`), `lib/plan-integrity.mjs`, `lib/plan.mjs`, `lib/shape.mjs` (`**Holdouts**` field + `twins` in `**Gate**` JSON), `lib/brain.mjs`, `lib/worktrees.mjs`, and `.gitignore` (`!.adlc/learned-checks.json`).
  2. Wire Digital Twins (`startDigitalTwins` / `buildTwinGateEnv` / `wrapTestCmdWithTwinEnv` / guaranteed `finally` `stop()`), `runLearnedChecks` (loaded from trusted host `repo`), and Sealed Holdouts (`shouldRunHoldoutScenarios`, cross-pool/staged holdout execution via `runHoldoutScenarios`, allowlist-sanitized failure symptoms via `sanitizeHoldoutFailureOutput`, and `gate-manifest` `twins`/`learned-checks`/`holdout` records) into `lib/scheduler-verify.mjs`, `lib/scheduler.mjs`, and `lib/rescue.mjs` P5 verification, protecting `.adlc/learned-checks.json` in `verifyScopeAndAntiNoOp`.
- **Acceptance Criteria**:
  - `validatePlan` and `parseStructuredSpec` validate `holdouts`, `holdout_scenarios`, and `gate.twins`; and `runPlan` executes `gate.twins`, `runLearnedChecks`, and sealed holdouts during P5 with sanitized Strike-2 feedback and guaranteed twin teardown. Verify: `node --test test/shape.test.mjs test/scheduler.test.mjs`

--------------------------------------------------------------------------------

### Ticket 6: `T-W4-6` — CLI (`agb holdout`, `agb distill --compile-checks`), MCP (`agb_holdout`), PreToolUse Policy, Docs & Bundles

- **Scope**: `bin/agb.mjs`, `mcp/server.mjs`, `hooks/policy/constants.mjs`, `hooks/policy/evaluate.mjs`, `website/env-docs.json`, `website/generated/**`, `dist/**`, `test/cli-nextgen.test.mjs`, `test/mcp-apps.test.mjs`, `test/pre-tool-use.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: none
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Add `agb holdout <list|run|clean> [repo] [--ticket <id>] [--run-id <id>] [--json]` and `agb distill --compile-checks` in `bin/agb.mjs` (`const COMMANDS` static literal); add `compileChecks` on `agb_distill` and `agb_holdout` in `mcp/server.mjs` (`const TOOLS` static literal, zero `mcp/` env tokens).
  2. Add `agb_holdout` to `BOOSTER_MCP_TOOLS` and `.adlc/learned-checks.json` to `IMPLICIT_RAIL_FILES` in `hooks/policy/constants.mjs`, deny non-`list` `agb_holdout` mutations in `ctx.readonly` sessions and protect custom `AGB_HOLDOUT_DIR` (`hooks/policy/evaluate.mjs`), document `AGB_HOLDOUT_DIR`, `AGB_CANDIDATE_ROOT`, and `AGB_LIFECYCLE_HOOKS` in `website/env-docs.json`, rebuild `dist/**` and `website/generated/**`, and add CLI/MCP/PreToolUse tests.
- **Acceptance Criteria**:
  - `agb holdout`, `agb distill --compile-checks`, and `agb_holdout` pass CLI, MCP, `jslit.mjs`, and `PreToolUse` tests across source and `dist/`, and `npm run build` + `node website/scripts/check-all.mjs` + `npm run coverage:check` pass with zero drift. Verify: `npm run build && node website/scripts/gen-reference.mjs && node website/scripts/check-all.mjs && node --test test/cli-nextgen.test.mjs test/mcp-apps.test.mjs test/pre-tool-use.test.mjs`

---

## 4. Acceptance Criteria

- [ ] `lib/holdout.mjs` defaults sealed holdouts to `true` on `frontier` tickets, executes inside OS sandboxes against `AGB_CANDIDATE_ROOT`, rejects symlinks/tautological red-phase tests, and sanitizes all holdout paths, line numbers, and assertion literals from failure symptoms. Verify: `node --test test/holdout.test.mjs`
- [ ] `lib/twins.mjs` validates declarative routes/envVars, serves `127.0.0.1:0` loopback HTTP with deterministic socket teardown on host, and intercepts twin URLs via read-only `NODE_OPTIONS=--import` inside network-denied P5 sandboxes without editing `lib/gates.mjs`. Verify: `node --test test/twins.test.mjs`
- [ ] `lib/distill.mjs` compiles ReDoS-safe `.adlc/learned-checks.json` rules via `compileChecks: true` and evaluates `runLearnedChecks` deterministically against `changedFiles`. Verify: `node --test test/bandit-distill.test.mjs`
- [ ] `hooks/lifecycle.mjs` and `hooks.json` handle `PostToolUse`, `PreInvocation` (0-token `user_markdown`), `PostInvocation`, and active-ticket-scoped `Stop` (`!continuationActive`, `NO_TOOL_CALL`, `stopContinuationCount < 1`), stage cleanly in `.agb_home`, and pass `agy plugin validate --strict` with 0 errors, 0 warnings, and 0 notes. Verify: `node --test test/lifecycle-hooks.test.mjs test/plugin-layout.test.mjs && npm run plugin:validate`
- [ ] `validatePlan`, `parseStructuredSpec`, and `runPlan` execute `gate.twins`, `runLearnedChecks`, and sealed holdouts during P5 verification with sanitized Strike-2 feedback and guaranteed twin teardown. Verify: `node --test test/shape.test.mjs test/scheduler.test.mjs`
- [ ] `agb holdout`, `agb distill --compile-checks`, `agb_holdout`, `PreToolUse` policy updates, `website/env-docs.json`, and rebuilt `dist/**` + `website/generated/**` pass full CI parity and `coverage:check` with zero drift. Verify: `npm run build && node website/scripts/gen-reference.mjs && git diff --exit-code dist/ website/generated/ && node website/scripts/check-all.mjs && npm run plugin:validate && npm run skills:check && npm run coverage:check`
