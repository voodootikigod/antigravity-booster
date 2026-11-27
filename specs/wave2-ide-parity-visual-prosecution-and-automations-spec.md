# Specification: Wave 2 — IDE Parity, Visual Browser Prosecution, MCP File Viewers & Declarative Automations

## 1. Context & Problem Statement

With Wave 0 (`PR #208`, `PR #209`) and Wave 1 (`PR #212`) merged onto `main`, `antigravity-booster` (`agb`) supports the November 30, 2026 model catalog, Desktop App `v2.30+` MCP App surfaces, and Remote Agent / Cloud VM orchestration. Four UX and verification multipliers remain for Wave 2 across **Desktop App**, **Antigravity IDE**, and the **7 IDE Extensions** (VS Code, JetBrains, Zed, Android Studio, Visual Studio, Xcode, Eclipse):

1. **No Visual & Browser Prosecutor (`browserGate`, Locked Decision `A9`):** Frontend/UI tickets (`*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `*.html`, `website/**`) pass unit tests even when routes return `5xx`, throw uncaught browser console errors, or lack screenshot evidence in `agb accept`. Per `A9`, explicit `browserGate` declarations on a ticket or `.adlc/config.json` must fail closed on route/5xx/console errors and record screenshot evidence, while undeclared frontend globs run advisories when configured and degrade cleanly on headless/SSH hosts.
2. **No Single-Ticket `/agb-handoff` or Incremental `agb plan --delta` Compiler:** IDE and Extension developers typically implement one ticket interactively and leave inline review comments (`<!-- comment: ... -->`, `> [!COMMENT]`, `> **Comment**: ...`) on `implementation_plan.md` or structured specs. Today `agb` lacks a single-command `/agb-handoff <ticket-id>` gate combining `gate-ticket` + optional single-diff prosecution + P6 summary, and `agb plan` recompiles every ticket from scratch instead of preserving untouched ticket IDs/hashes (`--delta`).
3. **Deferred MCP App Custom File Viewers (`A4`) & Declarative Automations:** Per `A4`, custom `file`-surface MCP App viewers for `.adlc/tickets/*.json` (`.agbticket`) and `.adlc/manifest.jsonl` (`.agbmanifest`) were deferred from Wave 0 PR 2 to Wave 2, and `agb init` does not yet scaffold Antigravity 2.0 declarative automation definitions (`agb init --automations`).

## 2. Goals & Non-Goals

### Goals
- Add `lib/browser-gate.mjs` implementing `runBrowserGate` (loopback-only route health probe, `5xx` & console-error detection, symlink-safe screenshot capture into `.booster/logs/<runId>/screenshots/`, and locked `A9` enforced-vs-advisory policy), wire it into `runGateTicket` (`lib/gate-ticket.mjs`), and surface `browserEvidence` + inline screenshot previews in `lib/accept.mjs`.
- Add `lib/handoff.mjs` (`runTicketHandoff`, `formatHandoffMarkdown` for `agb handoff <ticket-id>`) and incremental delta plan compilation (`compilePlanDelta`, `extractInlinePlanComments`, `--delta <prev-plan.json>`) in `lib/plan.mjs`.
- Add `ui://agb/ticket-viewer.html` (`agb_ticket_viewer`, `.agbticket` + `.adlc/tickets/*.json` + `antigravity-file://`) and `ui://agb/manifest-viewer.html` (`agb_manifest_viewer`, `.agbmanifest` + `.adlc/manifest.jsonl` + `antigravity-file://`) in `mcp/ui-views.mjs` and `mcp/server.mjs`, plus `agb init --automations [--force]` in `lib/doctor.mjs` scaffolding `agb-quota-resume`, `agb-nightshift-distill`, and `agb-pr-prosecutor`.
- Wire `agb handoff`, `agb gate-ticket --skip-browser --browser-url`, `agb plan --delta`, and `agb init --automations` in `bin/agb.mjs`, ship `/agb-handoff` (`commands/agb-handoff.md`, `skills/agb-handoff/SKILL.md`), update website reference docs & `ia.json`, and rebuild `dist/**`.

### Non-Goals
- Modifying standing frozen rails (`lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`).
- Persistent `agy acp` JSON-RPC daemon pools or mobile Remote Control cards (scheduled for Wave 3).

## 3. Ticket Decomposition

### Ticket 1: `T-W2-1` — Browser Prosecutor (`browserGate`, `A9`) & Visual Evidence in `gate-ticket` / `accept`

- **Scope**: `lib/browser-gate.mjs`, `lib/gate-ticket.mjs`, `lib/accept.mjs`, `test/browser-gate.test.mjs`, `test/accept.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: `T-W2-1 -> T-W2-2`, `T-W2-1 -> T-W2-3`, `T-W2-1 -> T-W2-4`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Create `lib/browser-gate.mjs` exporting `hasFrontendChanges`, `isLoopbackBrowserUrl`, `resolveBrowserGateConfig`, and `runBrowserGate`: enforce loopback-only target URLs (preventing SSRF), probe configured routes for `< 500` HTTP status, parse optional `AGB_BROWSER_CHECK_CMD` / `checkCmd` JSON telemetry (`consoleErrors`, `serverErrors`, `screenshots`), copy verified non-symlink screenshots into `.booster/logs/<runId>/screenshots/`, fail closed when `browserGate` is explicitly declared (`enforced: true`), and degrade advisories cleanly on headless/SSH hosts (`advisory: true`).
  2. Integrate `runBrowserGate` into `runGateTicket` (`lib/gate-ticket.mjs`) with `skipBrowser` and `browserUrl` options and record `browser-gate` in `gate-manifest`.
  3. Surface `browserEvidence` (route results, error counts, and symlink-safe screenshot metadata / bounded data-URI previews) in `buildAcceptanceDossier`, `formatAcceptanceDossierMarkdown`, and `formatAcceptanceDossierHtml` (`lib/accept.mjs`).
  4. Add `test/browser-gate.test.mjs` and expand `test/accept.test.mjs` covering enforced vs advisory `A9` behavior, SSRF rejection, `5xx`/console-error failure, symlink defense, and dossier rendering.
- **Acceptance Criteria**:
  - `node --test test/browser-gate.test.mjs test/accept.test.mjs test/gate-ticket-and-prompt-only.test.mjs` exits `0`.

--------------------------------------------------------------------------------

### Ticket 2: `T-W2-2` — Interactive `/agb-handoff` Single-Ticket Gate & Incremental `agb plan --delta` Compiler

- **Scope**: `lib/handoff.mjs`, `lib/plan.mjs`, `test/handoff-and-plan-delta.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: `T-W2-2 -> T-W2-4`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Create `lib/handoff.mjs` exporting `runTicketHandoff` and `formatHandoffMarkdown` to execute `runGateTicket`, run single-diff cross-model `prosecute()` when `agy` + quota are available (or emit a structured `prosecutorPrompt` in `--prompt-only` / zero-`agy` fallback mode unless `requireProsecutor: true`), and render a P5/P6 Markdown + optional `--html` handoff dossier.
  2. Export `extractInlinePlanComments` and `compilePlanDelta` in `lib/plan.mjs`, and wire `deltaFrom` into `compilePlan` and `buildPlanPrompts` so untouched tickets in a prior `plan.json` are preserved verbatim (`preservedTicketIds`) while modified, commented, or newly added tickets are incrementally recompiled (`changedTicketIds`, `addedTicketIds`, `removedTicketIds`).
  3. Add `test/handoff-and-plan-delta.test.mjs` testing `runTicketHandoff` (pass, gate fail, live fake-`agy` prosecution, prompt-only fallback, `requireProsecutor` fail-closed) and `compilePlanDelta` (inline comments, preserved untouched tickets, modified/added/removed tickets, parallax edge filtering).
- **Acceptance Criteria**:
  - `node --test test/handoff-and-plan-delta.test.mjs test/plan.test.mjs` exits `0`.

--------------------------------------------------------------------------------

### Ticket 3: `T-W2-3` — MCP App File Viewers (`ticket-viewer`, `manifest-viewer`) & `agb init --automations`

- **Scope**: `mcp/ui-views.mjs`, `mcp/server.mjs`, `lib/doctor.mjs`, `test/mcp-apps.test.mjs`, `test/automations-init.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: `T-W2-3 -> T-W2-4`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Add `ui://agb/ticket-viewer.html` (`buildTicketViewerHtml`) and `ui://agb/manifest-viewer.html` (`buildManifestViewerHtml`) in `mcp/ui-views.mjs`, and register `agb_ticket_viewer` (`surface: 'file'`, `extensions: ['.agbticket']`) and `agb_manifest_viewer` (`surface: 'file'`, `extensions: ['.agbmanifest']`) in `mcp/server.mjs` supporting symlink-verified `.adlc/tickets/*.json` / `.adlc/manifest.jsonl` reads and `antigravity-file://` deferred reads.
  2. Extend `runInit` in `lib/doctor.mjs` with `automations = false` (`agb init --automations [--force]`) to scaffold symlink-verified `.agents/automations/{agb-quota-resume,agb-nightshift-distill,agb-pr-prosecutor}.json` declarative Antigravity 2.0 automation definitions without overwriting user edits unless `force: true`.
  3. Expand `test/mcp-apps.test.mjs` (`8` UI resources, `agb_ticket_viewer`, `agb_manifest_viewer`, symlink & `antigravity-file://` checks) and add `test/automations-init.test.mjs`.
- **Acceptance Criteria**:
  - `node --test test/mcp-apps.test.mjs test/automations-init.test.mjs` exits `0`.

--------------------------------------------------------------------------------

### Ticket 4: `T-W2-4` — CLI Wiring, `/agb-handoff` Skill & Command, Website Docs & Bundles

- **Scope**: `bin/agb.mjs`, `scripts/release-audit-collect.mjs`, `commands/agb.md`, `commands/agb-handoff.md`, `skills/agb/SKILL.md`, `skills/agb-handoff/SKILL.md`, `test/commands.test.mjs`, `test/plugin-layout.test.mjs`, `test/skills-cross-harness.test.mjs`, `website/**`, `dist/**`, `specs/wave2-ide-parity-visual-prosecution-and-automations-spec.md`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
- **Edges**: None
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Wire `agb handoff`, `agb gate-ticket --skip-browser --browser-url`, `agb plan --delta`, and `agb init --automations` in `bin/agb.mjs`, and register `lib/browser-gate.mjs` + `lib/handoff.mjs` + `handoff` in `scripts/release-audit-collect.mjs`.
  2. Author `commands/agb-handoff.md` and `skills/agb-handoff/SKILL.md`, update `commands/agb.md` and `skills/agb/SKILL.md`, and update skill/command inventories in `test/commands.test.mjs`, `test/plugin-layout.test.mjs`, and `test/skills-cross-harness.test.mjs`.
  3. Add `AGB_BROWSER_CHECK_CMD` to `website/env-docs.json`, create `website/content/docs/reference/cli/handoff.mdx`, register `"handoff"` in `website/content/docs/reference/cli/meta.json` and `website/scripts/ia.json`, regenerate `website/generated/*`, verify `node website/scripts/check-all.mjs`, and rebuild `dist/**`.
- **Acceptance Criteria**:
  - `npm run build && node website/scripts/gen-reference.mjs --check && node website/scripts/check-all.mjs && npm run skills:check && node --test test/commands.test.mjs test/plugin-layout.test.mjs test/skills-cross-harness.test.mjs` exits `0`.

--------------------------------------------------------------------------------

## 4. Acceptance Criteria

1. `runBrowserGate` enforces loopback-only URLs, fails closed when `browserGate` is explicitly configured (`A9`), degrades advisories cleanly on headless hosts, and surfaces `browserEvidence` in `agb gate-ticket` and `agb accept`. Verify: `node --test test/browser-gate.test.mjs test/accept.test.mjs`
2. `agb handoff <ticket-id>` executes deterministic gates + optional cross-model prosecution or prompt-only fallback, and `agb plan --delta` preserves untouched tickets while recompiling modified/commented tickets. Verify: `node --test test/handoff-and-plan-delta.test.mjs`
3. `agb_ticket_viewer` and `agb_manifest_viewer` mount as `file`-surface MCP Apps supporting `.adlc/tickets/*.json`, `.adlc/manifest.jsonl`, and `antigravity-file://`, and `agb init --automations` scaffolds symlink-safe `.agents/automations/*.json`. Verify: `node --test test/mcp-apps.test.mjs test/automations-init.test.mjs`
4. All CLI commands, `/agb-handoff` skill & command, audit surfaces, website docs (`check-all.mjs`), bundles, mutation gate, and full test suite pass. Verify: `npm run build && node website/scripts/check-all.mjs && npm test`
