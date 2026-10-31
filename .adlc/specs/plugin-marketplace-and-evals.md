# Specification: Antigravity Plugin Marketplace Packaging, Publishing, Engagement & Statistical Evaluation Suite

- **Status:** Active
- **Author:** Chris Williams (`voodootikigod`)
- **Date:** 2026-10-30
- **Target Runtime:** Google Antigravity (`agy` >= 1.4.11) & Antigravity Plugin Marketplace (`https://antigravity.google/blog/plugin-marketplace-in-antigravity`)
- **Frozen Standing Rails:** `lib/lock.mjs`, `lib/gates.mjs`

---

## 1. Executive Summary & Context

Google Antigravity released the **Antigravity Plugin Marketplace** (`Customizations > Marketplace` in the IDE, `/plugin` Discover tab in the CLI, and `agy plugin install <name>@<marketplace>`), introducing:
1. A stricter native plugin validator (`agy plugin validate --strict`) that rejects legacy hybrid plugin layouts with warnings (`commands/` directory ignored in native plugins; root `AGENTS.md` ignored outside `rules/AGENTS.md`) and flags missing discovery metadata (`logo`, `displayName`, `suggestedPrompts`).
2. Two distribution channels built into the Antigravity language server (`language_server/marketplace`):
   - **Official Curated Marketplace** (`antigravity-plugins-official`) for 1-click GUI discovery across Software Delivery & Security verticals.
   - **Custom Self-Hosted Marketplace Feeds (`marketplace.json`)** supporting `<name>=<https-url>` registration and SHA-256-verified `.zip` plugin archives (`source: { url, sha256 }`).

This specification defines:
1. **Native Plugin Packaging & Strict Conformance**: Eliminating all `agy plugin validate --strict` warnings and notes, adding Marketplace UI discovery metadata (`displayName`, `logo`, `suggestedPrompts`, `homepage`, `repository`), exposing all 7 user-facing `/agb-*` commands as native plugin skills (`skills/agb-*/SKILL.md`), adding an always-on session orchestration rule (`rules/AGENTS.md`), and updating `lib/migrate.mjs` to parse `agy 1.4.x` `plugin validate` output.
2. **Multi-Channel Publishing Architecture**: Official Marketplace submission + self-hosted `https://www.agybooster.com/marketplace.json` catalog bundling both `antigravity-booster` and companion plugin `adlc-antigravity`.
3. **User Engagement & Activation Funnel**: Turning passive installs into active multi-agent fleet runs via `suggestedPrompts` starter chips, progressive-disclosure skill descriptions, `rules/AGENTS.md` session routing, and visual Sidecar telemetry.
4. **Reproducible Statistical Evaluation Suite (`evals/`)**: A deterministic, zero-dependency statistical benchmark framework (`evals/stats.mjs`, `evals/scenarios.mjs`, `evals/runner.mjs`) with $N=100$ paired Monte Carlo trials grounded in empirical probe distributions (`docs/calibration/probes-2026-06-11.md`, `docs/calibration/probes-2026-07-14.md`), proving statistically significant ($p < 0.0001$) performance and accuracy gains over straight Antigravity (`agy`) without Booster.

---

## 2. Root-Cause Findings Against Live `agy 1.4.11`

Probing the current repository against `/home/voodootikigod/.local/bin/agy plugin validate --strict --json` surfaced three defects and one runtime regression:

1. **Defect 1 — `commands/` Ignored in Native Plugins (`⚠ commands: never loaded: plugins have no commands`)**:
   - In `agy 1.4.x`, native Antigravity plugins (`plugin.json` at root) only load skills from `skills/<name>/SKILL.md`. The `commands/` directory is only converted when importing foreign Claude Code (`.claude-plugin/plugin.json`) or Gemini CLI (`gemini-extension.json`) extensions. As a result, all 7 user-facing slash commands (`agb-bootstrap`, `agb-doctor`, `agb-migrate`, `agb-plan`, `agb-review`, `agb-run`, `agb-sidecar`) were invisible to the native Antigravity plugin loader.
2. **Defect 2 — Root `AGENTS.md` Flagged & `rules/` Empty (`⚠ AGENTS.md: never loaded: plugins load rules only from rules/`)**:
   - `(*pluginValidator).checkRules` in `agy 1.4.11` warns whenever `AGENTS.md` or `GEMINI.md` exists at the plugin root, failing `--strict`. Meanwhile, the plugin shipped `rules: 0`, providing no always-on guidance in enabled sessions for when to invoke `mcp__agb__*` tools or `/agb-*` skills.
3. **Defect 3 — Missing Marketplace UI Metadata (`· plugin.json: no logo: the plugin shows a generic icon`)**:
   - `plugin.json` omitted `displayName`, `logo`, `suggestedPrompts`, `homepage`, and `repository`, causing the Marketplace card to render a generic fallback icon and no starter prompt chips.
4. **Defect 4 — `lib/migrate.mjs` `parseValidateOutput` Breaks on `agy 1.4.x`**:
   - `parseValidateOutput` in `lib/migrate.mjs` matched only `agy 1.2.x` output (`✔ <cat> : <n> processed`). `agy 1.4.x` outputs `skills 10 · agents 3 · rules 1 · hooks 1 · mcpServers 1 · sidecars 1` without a `commands` counter, causing `validateBooster` to fail on `agy 1.4.x`.

---

## 3. Acceptance Criteria

1. **Marketplace-optimized `plugin.json` and `assets/logo.svg`**. `plugin.json` contains `displayName` (`"Antigravity Booster"`), search-optimized `description`, `logo` (`"assets/logo.svg"`), `suggestedPrompts` (array of 3 prompts), `homepage` (`"https://www.agybooster.com"`), and `repository` (`"https://github.com/voodootikigod/antigravity-booster"`), and `assets/logo.svg` exists as a 256x256 square SVG with >=10% outer margin. Verification: `node --test test/plugin-layout.test.mjs; echo $?` → `0`.
2. **Native plugin skills (`skills/agb-*/SKILL.md`) and always-on session rule (`rules/AGENTS.md`)**. All 7 user-facing `/agb-*` commands (`agb-bootstrap`, `agb-doctor`, `agb-migrate`, `agb-plan`, `agb-review`, `agb-run`, `agb-sidecar`) are exposed as native plugin skills in `skills/<name>/SKILL.md` with synced `.claude/skills` and `.agents/skills` mirrors, and `rules/AGENTS.md` exists with orchestration routing guidance. Verification: `npm run skills:sync -- --check && node --test test/plugin-layout.test.mjs test/commands.test.mjs; echo $?` → `0`.
3. **Zero-warning `agy plugin validate --strict` on staged Marketplace bundle**. `scripts/stage-marketplace-plugin.mjs` stages a clean Marketplace plugin bundle (and `marketplace.json` catalog descriptor) excluding repo-only contributor files (`AGENTS.md` at root, `commands/`, `test/`, `website/`, `.adlc/`, `.github/`, `.worktrees/`, `node_modules/`) and passes `agy plugin validate --strict --json` with `valid: true`, `errors === 0`, `warnings === 0`, and `notes === 0`. Verification: `node scripts/stage-marketplace-plugin.mjs --validate-strict; echo $?` → `0`.
4. **`agy 1.4.x` compatibility in `lib/migrate.mjs` (`parseValidateOutput` and `validateBooster`)**. `parseValidateOutput` parses both legacy `agy 1.2.x` (`✔ <cat> : <n> processed`) and current `agy 1.4.x` (`skills <n> · agents <n> · ...`) output formats without falsely failing when `commands` is omitted by `agy 1.4.x`. Verification: `node --test test/migrate-rollback.test.mjs; echo $?` → `0`.
5. **Reproducible Statistical Evaluation & Benchmark Suite (`evals/`)**. `evals/stats.mjs`, `evals/scenarios.mjs`, and `evals/runner.mjs` execute $N=100$ paired Monte Carlo trials across 4 canonical scenarios (`perf-8-ticket-dag`, `perf-16-ticket-scale`, `acc-cross-model-prosecution`, `acc-mechanical-safety-gates`) plus live mechanical probes, verifying $p < 0.0001$, speedup $> 2.5\times$, defect escape reduction $> 75\%$, and rail violation block rate $= 100\%$, and writing the report to `docs/benchmarks/marketplace-eval-report.md`. Verification: `node --test test/evals.test.mjs && node evals/runner.mjs --json; echo $?` → `0`.
6. **NPM package isolation and frozen rail integrity**. `package.json` `files` includes `assets/` and `rules/` while preserving `test/packaging.test.mjs` isolation (`docs/` outside `docs/calibration/` excluded from tarball) and leaving standing rails `lib/lock.mjs` and `lib/gates.mjs` untouched. Verification: `node --test test/packaging.test.mjs && adlc rails-guard --base origin/main --rails lib/lock.mjs --rails lib/gates.mjs; echo $?` → `0`.
