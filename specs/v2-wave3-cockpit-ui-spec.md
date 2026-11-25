# Specification: v2.0.0 Wave 3 — Bidirectional MCP Apps v2, Attention-Driven Cockpit & P6 Sign-Off Workbench

- **Status**: Approved Architecture (Stacked on `explore-advancements` PR #195)
- **Base**: `explore-advancements`
- **Gate**: {"build":"npm run build","test":"npm test"}

---

## 1. Context & Owner-Aligned Design Decisions

Waves 1 and 2 (`explore-advancements`, PR #195 + merged PR #198) established the Antigravity 2.0 `statusLine`, authenticated `control.sock` IPC, `agb rescue`, `agb watch` v2 Flight Deck, 5 initial `ui://agb/*.html` MCP App shells, 3-layer KV-cache-stable charters, default-on `AGENTS.md` hydration, billable-token bandit routing, post-guard `gate.autofix`, and `agb plan --estimate` + `!RUNWAY` alerts.

Wave 3 (`v2-wave3-cockpit-ui`) upgrades the **CLI/TUI and Native GUI/MCP App surfaces** into a bidirectional, attention-driven Software Factory cockpit (`Proposals G1, G2, G3, T1, T2`):

1. **Append-Only Factory Economics Ledger (`G3`):** Persist per-run factory efficiency metrics (`strike0YieldPct`, `cacheHitPct`, `autofixAppliedCount`, `billableTokens`, `requestsByPool`) in `<plugin_data>/factory_ledger.jsonl` under `withLockSync`, surfaced in Mission Control (`ui://agb/mission-control.html`) and `agb watch` (`lib/tui.mjs`).
2. **Attention-Driven Terminal Cockpit & `tmux`/`cmux`/`herdr` Orchestration (`T1`):** Add injection-safe OSC 8 `file://` hyperlinks (`formatOsc8FileLink`, with OSC-aware `stripAnsi`), edge-triggered OSC 9 / OSC 777 desktop attention notifications (`Needs Rescue`, `Runway / Quota Paused`, `P6 Ready`) in `watchStatus`, and owner-confirmed `tmux` (with `tmuxh` alias), `cmux`, and `herdr` split-pane / notification support (`lib/mux.mjs`, explicitly excluding `zellij`).
3. **Interactive P6 Hunk-Level Sign-Off Dossier & TUI (`T2` + `G2`):** Provide pure dossier/hunk analysis in `lib/accept.mjs` and interactive terminal review in `lib/accept-tui.mjs`, persisting hunk verdicts keyed by SHA-256 hunk diff content fingerprints in `.booster/accept-state.json` (auto-invalidating modified hunks) while never auto-merging or pushing.
4. **Bidirectional MCP Apps v2 & PreToolUse Registration (`G1` + `G2`):** Set `agb_control._meta.ui.visibility` to `["app"]`, add `agb_accept` + `ui://agb/accept-workbench.html` (registered in `BOOSTER_MCP_TOOLS` with `ctx.readonly` mutation denial on `saveVerdicts`), compute `runwayEstimate` server-side via `estimatePlanQuotaRunway` for `agb_plan_viewer`, and wire `ui/update-model-context` across views.

---

## 2. Standing Architectural & Security Invariants

- **Frozen Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, and `plugin.json` are read-only across all Wave 3 tickets.
- **Static Literals & Env-Token Discipline**: `const COMMANDS` in `bin/agb.mjs` and `const TOOLS` in `mcp/server.mjs` must remain pure static JS literals parseable by `website/scripts/lib/jslit.mjs`. `mcp/` files must introduce zero `AGB_*`, `ADLC_*`, or `ANTIGRAVITY_*` `process.env` tokens.
- **PreToolUse Hook Contract**: Never emit `decision: "allow"` in `hooks/**` (`PASS` is `{}`). Register `agb_accept` in `BOOSTER_MCP_TOOLS` (`hooks/policy/constants.mjs`), protect `.booster/accept-state.json` and `.booster/accept-dossier.md` from headless/rescue workers (`hooks/policy/paths.mjs` & `hooks/policy/evaluate.mjs`), key `agb_accept.verdicts` strictly by 64-hex SHA-256 fingerprints, and deny `agb_accept` with truthy `saveVerdicts` inside `ctx.readonly` sessions (`hooks/policy/evaluate.mjs`).
- **MCP App CSP & XSS Hardening**: All 6 `ui://agb/*.html` resources enforce default-deny CSP (`resourceDomains: [], connectDomains: []`), zero external URLs or external asset tags, mandatory `escapeHtml(...)`, and clean `node:vm` compilation.
- **P6 Human Sovereignty**: Neither `agb accept` nor `agb_accept` executes `git merge`, `git push`, or `gh pr merge`.

---

## 3. Ticket Decomposition (`T-W3-1` – `T-W3-6`)

### Ticket 1: `T-W3-1` — Append-Only Factory Economics Ledger (`lib/factory-ledger.mjs`)

- **Scope**: `lib/factory-ledger.mjs`, `test/factory-ledger.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W3-1 -> T-W3-4, T-W3-5`
- **Tier**: `cheap`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Create `lib/factory-ledger.mjs` exporting `defaultFactoryLedgerPath`, `computeRunEconomics`, and `FactoryLedger` (`appendRunSummary`, `readRuns`, `summarizeEconomics`), protected by `withLockSync` and bounded to `maxEntries = 1000` (honoring `AGB_FACTORY_LEDGER_FILE` and `AGB_HOME_DIR` in unbundled mode, and isolating to `<repo>/.booster/factory_ledger.jsonl` under `NODE_TEST_CONTEXT` when unset).
- **Acceptance Criteria**:
  - `FactoryLedger` atomically records bounded run summaries under lock, rejects symlinked ledger paths, and computes aggregate `runs`, `avgStrike0YieldPct`, `avgCacheHitPct`, `totalAutofixSaves`, and `totalBillableTokens`. Verify: `node --test test/factory-ledger.test.mjs`

--------------------------------------------------------------------------------

### Ticket 2: `T-W3-2` — OSC 8 / Attention Escapes & `tmux`/`cmux`/`herdr` Multiplexer Engine

- **Scope**: `lib/terminal-osc.mjs`, `lib/mux.mjs`, `test/terminal-osc.test.mjs`, `test/mux.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W3-2 -> T-W3-3, T-W3-4`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Create `lib/terminal-osc.mjs` exporting `sanitizeOscField`, `stripOscAndAnsi`, `formatOsc8FileLink(absPath, label, { line, enabled })`, `formatOscAttentionAlert(title, message, { protocol, enabled })`, and `AttentionTransitionTracker` (firing once per distinct `failed:<id>`, `runwayWarning`, `paused`, or `done:<runId>` transition).
  2. Create `lib/mux.mjs` exporting `SUPPORTED_MUXES` (`['tmux', 'cmux', 'herdr']`, normalizing `'tmuxh'` alias to `'tmux'`), `detectMultiplexer(env)`, `buildMuxSplitPlan({ mux, cwd, command, env })`, `buildMuxNotificationArgs({ mux, title, body, env })`, and `launchMuxSplit({ mux, cwd, command, env, spawnSyncFn })` using shell-free argv arrays (`herdr pane split --current --direction right --cwd <cwd> --no-focus` + `herdr pane run <paneId> <cmd>`, `cmux new-split right`, `tmux split-window -h -d -c <cwd>`).
- **Acceptance Criteria**:
  - `formatOsc8FileLink` and `formatOscAttentionAlert` strip ESC/BEL/C0/C1 control bytes, `AttentionTransitionTracker` suppresses duplicate alerts, and `mux.mjs` builds verified argv vectors for `tmux` (`tmuxh`), `cmux`, and `herdr` while rejecting unsupported `zellij` or shell metacharacter injection. Verify: `node --test test/terminal-osc.test.mjs test/mux.test.mjs`

--------------------------------------------------------------------------------

### Ticket 3: `T-W3-3` — P6 Hunk-Level Sign-Off Dossier (`lib/accept.mjs`) & Interactive TUI (`lib/accept-tui.mjs`)

- **Scope**: `lib/accept.mjs`, `lib/accept-tui.mjs`, `test/accept.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W3-3 -> T-W3-4, T-W3-5, T-W3-6`
- **Tier**: `mid`
- **Pool Hint**: `claude-gpt`
- **Objectives**:
  1. Create `lib/accept.mjs` exporting `computeHunkFingerprint`, `parseUnifiedDiffHunks`, `loadAcceptVerdicts`, `saveAcceptVerdicts`, `buildAcceptanceDossier({ repo, base })`, and `formatAcceptanceDossierMarkdown(dossier)`. Key persisted verdicts in `.booster/accept-state.json` by SHA-256 hunk diff fingerprint (rejecting symlinks and auto-invalidating hunks when diff lines change), attach `discoverExternalCallers` blast radius + `.adlc/manifest.jsonl` gate records, and use `sanitizedGitEnv()`.
  2. Create `lib/accept-tui.mjs` exporting `renderAcceptTuiFrame` and `runInteractiveAcceptTui(dossier, { repo, stdin, stdout, osc8 })` (`j/k` hunk navigation, `a` accept, `f` flag for rescue, `d` export `.booster/accept-dossier.md`, `q` quit).
- **Acceptance Criteria**:
  - `buildAcceptanceDossier`, SHA-256 fingerprint invalidation in `.booster/accept-state.json`, `formatAcceptanceDossierMarkdown`, and `runInteractiveAcceptTui` pass offline tests while rejecting symlinked `.booster` paths and mutating zero git refs. Verify: `node --test test/accept.test.mjs`

--------------------------------------------------------------------------------

### Ticket 4: `T-W3-4` — Scheduler Economics Recording, OSC-Aware TUI Cost Strip & Watch Multiplexer/Attention Wiring

- **Scope**: `lib/scheduler.mjs`, `lib/tui.mjs`, `lib/status.mjs`, `test/tui-hud.test.mjs`, `test/status.test.mjs`, `test/scheduler.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W3-4 -> T-W3-6`
- **Tier**: `mid`
- **Pool Hint**: `claude-gpt`
- **Objectives**:
  1. In `lib/scheduler.mjs`: track run-level `strike0MergedCount`, `autofixAppliedCount`, and cumulative builder token counters; attach `economics` onto `report` and append to `FactoryLedger` at run completion.
  2. In `lib/tui.mjs`: update `stripAnsi` via `stripOscAndAnsi` so `visibleLength` and `padVisible` measure OSC 8 links accurately; render a compact **Factory Economics Strip** when `state.economics` or `state.report?.economics` is present; and render OSC 8 links on prosecutor finding file paths when `opts.osc8 === true`.
  3. In `lib/status.mjs`: wire `AttentionTransitionTracker` in interactive `watchStatus` (`opts.alerts !== false`) to emit deduplicated OSC 9 notifications (and optional multiplexer notifications) on failed-ticket, runway/pause, and completion transitions, and wire `opts.mux` split-pane launching via `launchMuxSplit`.
- **Acceptance Criteria**:
  - `stripAnsi` strips OSC 8 hyperlinks with exact `visibleLength`, `renderTUIDashboard` renders the Factory Economics Strip and OSC 8 links, `watchStatus` emits deduplicated attention alerts and delegates `opts.mux`, and `runPlan` records `report.economics`. Verify: `node --test test/tui-hud.test.mjs test/status.test.mjs test/scheduler.test.mjs`

--------------------------------------------------------------------------------

### Ticket 5: `T-W3-5` — MCP Apps v2 Views, Server (`visibility: ["app"]`, `agb_accept`) & PreToolUse Policy Registration

- **Scope**: `mcp/ui-views.mjs`, `mcp/server.mjs`, `hooks/policy/constants.mjs`, `hooks/policy/paths.mjs`, `hooks/policy/evaluate.mjs`, `dist/mcp-server.mjs`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/mcp-apps.test.mjs`, `test/pre-tool-use.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: `T-W3-5 -> T-W3-6`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. In `mcp/ui-views.mjs`: export `buildAcceptWorkbenchHtml()` and register `ui://agb/accept-workbench.html` (6 views total, keying `verdicts` strictly by 64-hex SHA-256 fingerprints); upgrade `buildPlanViewerHtml()` with `effort`, `tdd_split`, `gate.autofix`, server-provided `runwayEstimate` display, and `ui/update-model-context`; upgrade `buildMissionControlHtml()` with Factory Economics (`mcState.economics`); and wire `ui/update-model-context` in `buildPlanCardHtml()` and `buildFlightDeckHtml()`.
  2. In `mcp/server.mjs`: set `agb_control._meta.ui.visibility` to `['app']`, add `agb_accept` (`{ repo?, base?, verdicts?, saveVerdicts? }`, rejecting non-64-hex verdict keys) with `resourceUri: 'ui://agb/accept-workbench.html'`, attach `FactoryLedger` `economics` to `buildSnapshotPayload`, and attach server-computed `estimatePlanQuotaRunway` `runwayEstimate` + `quotaCache` to `agb_plan_viewer`.
  3. In `hooks/policy/constants.mjs`, `hooks/policy/paths.mjs`, & `hooks/policy/evaluate.mjs`: add `'agb_accept'` to `BOOSTER_MCP_TOOLS`, protect `.booster/accept-state.json` and `.booster/accept-dossier.md` in headless/rescue sessions, deny `agb_accept` with truthy `saveVerdicts` in `ctx.readonly` sessions, and rebuild `dist/mcp-server.mjs` + `dist/hooks/pre-tool-use.bundle.mjs`.
- **Acceptance Criteria**:
  - `TOOLS` parses via `jslit.mjs` (14 tools, zero `mcp/` env tokens), `agb_control` has `visibility: ['app']`, all 6 `ui://` views pass CSP/XSS/`node:vm` tests across source and `dist/mcp-server.mjs`, and `PreToolUse` allows read-only `agb_accept` while denying `saveVerdicts: true` in `ctx.readonly` sessions and protecting `accept-state.json`/`accept-dossier.md` from headless workers. Verify: `npm run build:mcp && npm run build:hooks && node --test test/mcp-apps.test.mjs test/pre-tool-use.test.mjs`

--------------------------------------------------------------------------------

### Ticket 6: `T-W3-6` — CLI `agb accept` & `agb watch --mux`, Env/Reference Docs & Rebuilt CLI Bundle

- **Scope**: `bin/agb.mjs`, `website/env-docs.json`, `website/generated/**`, `dist/agb.mjs`, `test/cli-nextgen.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`
- **Edges**: none
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Objectives**:
  1. Add `accept` command (`agb accept [repo] [--base <ref>] [--json] [--markdown <file>]`) and `--mux` / `--mux=<mode>` / `--no-alerts` flags on `agb watch` in `bin/agb.mjs` (`const COMMANDS` static literal + pre-normalized `--mux` flag handling so `[repo]` positional arguments are never consumed as mux mode).
  2. Register `AGB_FACTORY_LEDGER_FILE` in `website/env-docs.json`, rebuild `dist/**` (`npm run build`) and `website/generated/**` (`gen-reference.mjs`), and add CLI tests in `test/cli-nextgen.test.mjs`.
- **Acceptance Criteria**:
  - `agb accept` and `agb watch --mux` execute cleanly offline without mutating git refs, both source and `dist/` MCP bundles pass `test/mcp-apps.test.mjs`, and `npm run coverage:check` passes with zero bundle/doc drift. Verify: `npm run build && node website/scripts/gen-reference.mjs && git diff --exit-code dist/ website/generated/ && node website/scripts/check-all.mjs && npm run plugin:validate && npm run skills:check && npm run coverage:check`

---

## 4. Acceptance Criteria

- [ ] `FactoryLedger` records bounded run summaries under lock, rejects symlinks, and computes aggregate factory economics. Verify: `node --test test/factory-ledger.test.mjs`
- [ ] `terminal-osc.mjs` and `mux.mjs` sanitize OSC escapes, deduplicate transition alerts, and build shell-free argv vectors for `tmux` (`tmuxh`), `cmux`, and `herdr` (rejecting `zellij`). Verify: `node --test test/terminal-osc.test.mjs test/mux.test.mjs`
- [ ] `accept.mjs` and `accept-tui.mjs` compute SHA-256 hunk fingerprints, external callers, and gate-manifest dossiers without mutating git refs. Verify: `node --test test/accept.test.mjs`
- [ ] `scheduler.mjs`, `tui.mjs`, and `status.mjs` record `report.economics`, measure OSC 8 width accurately, emit deduplicated attention alerts, and delegate `opts.mux`. Verify: `node --test test/tui-hud.test.mjs test/status.test.mjs test/scheduler.test.mjs`
- [ ] All 6 `ui://agb/*.html` MCP App views, `agb_control` (`visibility: ['app']`), `agb_accept`, and `PreToolUse` `BOOSTER_MCP_TOOLS` policy checks pass across source and `dist/`. Verify: `npm run build && node --test test/mcp-apps.test.mjs test/pre-tool-use.test.mjs`
- [ ] `agb accept`, `agb watch --mux`, `AGB_FACTORY_LEDGER_FILE` docs, and rebuilt `dist/**` + `website/generated/**` pass full CI parity and `coverage:check` with zero drift. Verify: `npm run build && node website/scripts/gen-reference.mjs && git diff --exit-code dist/ website/generated/ && node website/scripts/check-all.mjs && npm run plugin:validate && npm run skills:check && npm run coverage:check`
