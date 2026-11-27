# Specification: Wave 1 — Remote Agents, Zero-Install Cloud Mode & Proxy-Safe Sidecar

## 1. Context & Problem Statement

With Wave 0 (`PR #208` and `PR #209`) merged onto `main`, `antigravity-booster` (`agb`) is ready for the November 30, 2026 model catalog and Desktop App `v2.30+` MCP App surfaces. However, **Web Standalone** (`antigravity.google.com`) and **Remote Agents (`jetski` Cloud Devbox & SSH)** still face four structural gaps:

1. **No Zero-`agy` Ticket Prosecutor or `--prompt-only` Escape Hatch:** Inside Antigravity Remote Agents (`jetski`), no child `agy` binary exists on the VM, so `agb plan`, `agb review`, and `agb run` fail at quota/binary preflight even though the active Remote Agent itself (and its subagents via `invoke_subagent`) can execute planning and review prompts directly while delegating deterministic P5 verification (`rails-guard`, scope confinement, sandboxed tests, `hollow-test`, learned checks, and `gate-manifest`) to `agb`.
2. **No Zero-Install Cloud Repo Pack (`agb init --cloud`) or SSH Fast-Path:** Local laptop plugins (`~/.gemini/config/plugins/`) do not transfer into standalone cloud VMs; only repository-resident `.agents/**` files (`environment.json`, `rules/*.md`, `skills/*/SKILL.md`, `agents/*.md`) materialize automatically. Additionally, `agb bootstrap` should short-circuit immediately when `ANTIGRAVITY_RESOLVING_ENVIRONMENT=1` during Antigravity SSH environment probing.
3. **Legacy Synchronous `workflow-emit.mjs` & Unconfined `inherit` Subagents:** `compilePlanToWorkflow` in `lib/workflow-emit.mjs` currently emits a synchronous `def execute_workflow` with `parallel_fn(*tasks)`, missing `schema=`, and hardcoded `workspace="share"` (unsupported in `jetski`, which only supports `workspace="inherit"`). Meanwhile, `PreToolUse` (`hooks/policy/evaluate.mjs`) needs mechanical `AGB_WORKTREE_ROOT` confinement so `Workspace: "inherit"` subagents cannot mutate files outside their assigned `.worktrees/agb-<ticket-id>` checkout.
4. **Proxy `403 Forbidden` on `agb sidecar` & Missing Brain HTML Cockpit Artifacts:** `sidecars/server.mjs` rejects every non-loopback `Host` header with `403`, blocking SSH/cloud port-forwarding proxies even when a valid CSPRNG token is supplied, and `agb accept` lacks a self-contained `.html` artifact output (`--html`) for Web Standalone and Remote Agent Brain previews.

## 2. Goals & Non-Goals

### Goals
- Add `lib/gate-ticket.mjs` (`agb gate-ticket <ticket-id>`) for 100% deterministic, zero-`agy` ADLC P5 ticket verification (`rails-guard`, `verifyScopeAndAntiNoOp`, build/test gates, learned checks, `adlc hollow-test`, and `gate-manifest` recording).
- Add `--prompt-only` to `agb plan` (`buildPlanPrompts` in `lib/plan.mjs`) and `agb review` (`buildReviewPrompts` in `lib/review.mjs`) so Remote Agents and keyless harnesses can run P1/P2/P5 lenses in-harness without an `agy` binary.
- Add `agb init --cloud [--force]` (`runInit` in `lib/doctor.mjs`) scaffolding `.agents/environment.json`, `.agents/rules/adlc.md`, `.agents/skills/agb-cloud/SKILL.md`, and `.agents/agents/{prosecutor,spec-linter}.md` (`A8`), enrich `agents/*.md` subagent frontmatter, and short-circuit `bootstrap()` when `ANTIGRAVITY_RESOLVING_ENVIRONMENT=1`.
- Rewrite `compilePlanToWorkflow` (`lib/workflow-emit.mjs`) for async `/run-workflow` (`await parallel(wave, ...)`, `await agent(..., schema=TICKET_RESULT_SCHEMA, workspace="inherit")`, `.worktrees/agb-<ticket-id>` + `agb gate-ticket`), and enforce `AGB_WORKTREE_ROOT` write confinement in `hooks/policy/evaluate.mjs` (`A7`).
- Add proxy-safe `agb sidecar --cloud` (`sidecars/server.mjs`, `sidecars/jetski-launcher.mjs`) gated on constant-time CSPRNG token authentication, and add `agb accept --html <file.html>` (`formatAcceptanceDossierHtml` in `lib/accept.mjs`) for self-contained Web/Remote Agent Brain cockpit artifacts.

### Non-Goals
- Modifying frozen standing rails (`lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`).
- External multi-VM Python SDK cloud bursting (`agb run --driver remote-sdk`, deferred to Wave 4) or Browser Subagent visual prosecution (`browserGate`, deferred to Wave 2).

## 3. Ticket Decomposition

### Ticket 1: `T-W1-3` — Async `/run-workflow` Compiler & `AGB_WORKTREE_ROOT` `PreToolUse` Confinement

- **Scope**: `lib/workflow-emit.mjs`, `hooks/policy/evaluate.mjs`, `test/workflow-emit.test.mjs`, `test/pre-tool-use.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: `T-W1-3 -> T-W1-1`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Rewrite `compilePlanToWorkflow` in `lib/workflow-emit.mjs` to emit an async Python 3 script supporting Antigravity `/run-workflow` (`await parallel(wave, ...)`, `await agent(prompt=..., schema=TICKET_RESULT_SCHEMA, role=..., type_name="self", workspace="inherit", model=...)`), per-ticket `.worktrees/agb-<ticket-id>` provisioning + `agb gate-ticket` gating when live primitives are present, and clean standalone `python3` dry-run JSON output.
  2. Enforce `AGB_WORKTREE_ROOT` physical containment in `hooks/policy/evaluate.mjs` (`buildContext`, file mutations, and shell/command write checks): fail closed if `AGB_WORKTREE_ROOT` is non-empty and non-absolute, and deny any repo/filesystem mutation outside `AGB_WORKTREE_ROOT` (other than `tmpRoots` and verified Brain artifacts).
  3. Expand `test/workflow-emit.test.mjs` and `test/pre-tool-use.test.mjs` for async `parallel`/`agent` simulation, `workspace="inherit"`, and `AGB_WORKTREE_ROOT` escape rejection.
- **Acceptance Criteria**:
  - `npm run build:hooks && node --test test/workflow-emit.test.mjs test/pre-tool-use.test.mjs` exits `0`.

--------------------------------------------------------------------------------

### Ticket 2: `T-W1-2` — `agb init --cloud` Repo Pack, Subagent Frontmatter & SSH Env Fast-Path

- **Scope**: `lib/doctor.mjs`, `lib/bootstrap.mjs`, `agents/prosecutor.md`, `agents/spec-linter.md`, `agents/fleet-scheduler.md`, `test/cloud-init.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: `T-W1-2 -> T-W1-4`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Extend `runInit({ repo, cloud = false, force = false })` in `lib/doctor.mjs` so `cloud: true` scaffolds symlink-verified `.agents/environment.json`, `.agents/rules/adlc.md` (`trigger: always_on`), `.agents/skills/agb-cloud/SKILL.md`, and `.agents/agents/{prosecutor,spec-linter}.md` without overwriting existing user customizations unless `force: true`.
  2. Upgrade `agents/prosecutor.md`, `agents/spec-linter.md`, and `agents/fleet-scheduler.md` with Antigravity subagent YAML frontmatter (`subagent: true`, `mainAgent: false`, `commandExecutionPolicy: sandbox`, Nov 30 model defaults).
  3. Short-circuit `bootstrap()` in `lib/bootstrap.mjs` immediately when `ANTIGRAVITY_RESOLVING_ENVIRONMENT === '1'` so SSH environment resolution never hangs on plugin installation.
  4. Add `test/cloud-init.test.mjs` covering `runInit({ cloud: true })`, `--force`, symlink containment, `agents/*.md` frontmatter, and `ANTIGRAVITY_RESOLVING_ENVIRONMENT=1`.
- **Acceptance Criteria**:
  - `node --test test/cloud-init.test.mjs test/bootstrap-install.test.mjs` exits `0`.

--------------------------------------------------------------------------------

### Ticket 3: `T-W1-1` — Deterministic Zero-`agy` `gate-ticket` Engine & `--prompt-only` Plan/Review

- **Scope**: `lib/gate-ticket.mjs`, `lib/plan.mjs`, `lib/review.mjs`, `test/gate-ticket-and-prompt-only.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: `T-W1-1 -> T-W1-4`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Create `lib/gate-ticket.mjs` exporting `runGateTicket(repo, ticketId, opts)` to execute deterministic P5 verification (`resolveTicket`, `checkRailsGuard`, `verifyScopeAndAntiNoOp`, `runGates`, `executeLearnedChecks`, `adlc hollow-test`, and `recordGate`) with zero `agy` binary dependency.
  2. Export `buildPlanPrompts(id, opts)` in `lib/plan.mjs` and `buildReviewPrompts(opts)` in `lib/review.mjs` to emit structured conversion/premortem/parallax and 5-lens Plan/Code ARL prompts + schemas with zero `agy` binary or quota probe required.
  3. Add `test/gate-ticket-and-prompt-only.test.mjs` verifying pass/fail paths for scope leaks, rail violations, failing tests, clean diffs, `buildPlanPrompts`, and `buildReviewPrompts`.
- **Acceptance Criteria**:
  - `node --test test/gate-ticket-and-prompt-only.test.mjs` exits `0`.

--------------------------------------------------------------------------------

### Ticket 4: `T-W1-4` — CLI Wiring, Proxy-Safe `sidecar --cloud`, Brain HTML Dossier, Docs & Bundles

- **Scope**: `bin/agb.mjs`, `lib/accept.mjs`, `sidecars/server.mjs`, `sidecars/jetski-launcher.mjs`, `scripts/release-audit-collect.mjs`, `commands/agb.md`, `skills/agb/SKILL.md`, `test/accept.test.mjs`, `test/sidecar.test.mjs`, `website/**`, `dist/**`, `specs/wave1-remote-agents-and-cloud-mode-spec.md`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: None
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Add `allowProxyHost` support to `serveSidecar` (`sidecars/server.mjs`) and `sidecars/jetski-launcher.mjs`, permitting non-loopback `Host` headers only when authenticated via constant-time `timingSafeEqual` CSPRNG `?token=`, `Bearer`, or `HttpOnly; SameSite=Lax` session cookie across all routes.
  2. Add `formatAcceptanceDossierHtml` and `writeAcceptHtmlFile` in `lib/accept.mjs` for self-contained interactive P6 HTML cockpit artifacts (`agb accept --html <file.html>`).
  3. Wire `agb gate-ticket`, `agb plan --prompt-only`, `agb review --prompt-only`, `agb init --cloud [--force]`, `agb sidecar --cloud`, and `agb accept --html` in `bin/agb.mjs`, update `commands/agb.md`, `skills/agb/SKILL.md` (+ `npm run skills:sync`), and `website/content/docs/`, regenerate `website/generated/`, and rebuild `dist/**`.
  4. Expand `test/sidecar.test.mjs` and `test/accept.test.mjs` for `--cloud` proxy host auth and `--html` dossier output.
- **Acceptance Criteria**:
  - `npm run build && node website/scripts/gen-reference.mjs --check && npm run skills:check && node --test test/sidecar.test.mjs test/accept.test.mjs` exits `0`.

--------------------------------------------------------------------------------

## 4. Acceptance Criteria

1. `agb gate-ticket <ticket-id>` enforces `rails-guard`, ticket `scope` confinement, build/test gates, learned checks, and `hollow-test` without requiring an `agy` binary, and `agb plan --prompt-only` / `agb review --prompt-only` emit structured prompts offline. Verify: `node --test test/gate-ticket-and-prompt-only.test.mjs`
2. `agb init --cloud` scaffolds symlink-safe `.agents/environment.json`, `.agents/rules/adlc.md`, `.agents/skills/agb-cloud/SKILL.md`, and `.agents/agents/{prosecutor,spec-linter}.md`, `agents/*.md` declare full Antigravity subagent frontmatter, and `bootstrap()` short-circuits when `ANTIGRAVITY_RESOLVING_ENVIRONMENT=1`. Verify: `node --test test/cloud-init.test.mjs`
3. `compilePlanToWorkflow` emits valid async `/run-workflow` Python (`await parallel`, `schema=`, `workspace="inherit"`) and `PreToolUse` denies writes outside `AGB_WORKTREE_ROOT`. Verify: `npm run build:hooks && node --test test/workflow-emit.test.mjs test/pre-tool-use.test.mjs`
4. `agb sidecar --cloud` accepts proxied `Host` headers only with valid constant-time token authentication, `agb accept --html` writes a self-contained P6 HTML cockpit artifact, and all bundles, docs, and tests pass. Verify: `npm run build && node website/scripts/gen-reference.mjs --check && npm run skills:check && npm test`
