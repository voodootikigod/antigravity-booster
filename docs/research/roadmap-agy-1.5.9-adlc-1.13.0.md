# Roadmap: antigravity-booster adaptation to agy 1.5.9 & ADLC 1.13.0

Delta audit since [roadmap-agy-1.4.7-adlc-1.12.0](roadmap-agy-1.4.7-adlc-1.12.0.md). Produced by `/modernize` on 2026-11-15.

Claims marked `[probed]` were verified live on this machine. Claims marked `[registry]` come from `npm view` and npm tarball inspection. Claims marked `[changelog]` come from `agy changelog` (`1.4.8` through `1.5.9`) and `voodootikigod/adlc` `v1.13.0` `CHANGELOG.md` (`sha256: 8d2afd9cc564f2aa5c8207872b954ab0ed099d8171fb9b4a0da6694bca6b2b19`).

---

## 1. Probed Live Facts & Upstream Delta

### agy runtime (`1.4.7` -> `1.5.9`)
- Installed `agy` is **1.5.9** `[probed]`.
- **Live model catalog (`agy models`) `[probed]`** expanded from 13 to **22 slugs** (0 retirements since `1.4.7`; 9 Gemini additions across `1.5.5`–`1.5.8`):
  - **New (`9`):**
    - `gemini-4-carbon-low`, `gemini-4-carbon-medium`, `gemini-4-carbon-high` (`Gemini 4 Carbon (Low|Medium|High)`, added in `1.5.8` `[changelog]`)
    - `gemini-4-hydrogen-low`, `gemini-4-hydrogen-medium`, `gemini-4-hydrogen-high`, `gemini-4-hydrogen-xhigh` (`Gemini 4 Hydrogen (Low|Medium|High|XHigh)`, added in `1.5.7` `[changelog]`)
    - `gemini-pro-orchestrator` (`Orchestrator (Carbon)`, added in `1.5.5` and updated to Carbon in `1.5.8` `[changelog]`)
    - `gemini-pro-orchestrator-argon` (`Orchestrator (Argon)`, added in `1.5.8` `[changelog]`)
  - **Unchanged (`13`):** `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium` `[probed]`.
- **Quota pools (`agy -p /quota --output-format json`) `[probed]`:** unchanged two-pool topology (`Gemini Models` covering Carbon, Argon, Hydrogen, Orchestrator Carbon/Argon, and 3.8 Flash; `Claude and GPT models` covering Claude Opus 5.5, Claude Sonnet 5.5, and GPT-OSS 120B), each with `weekly` and `5h` buckets.
- **CLI flags & subcommands `[probed]`:** `--output-format {text,json,stream-json}`, `--input-format {text,stream-json}` (`Input format for print mode (text, stream-json) (default text)` — enters headless print mode reading `stdin` without inline `--print <arg>`), `--json-schema`, `--sandbox`, `--print-timeout`, `--project`, `--effort {low,medium,high,xhigh,max}`, `--mode {accept-edits,auto,plan}` remain intact. Added since `1.4.7`: `--remote-agent` and `agy acp` (`1.5.0`). `agy 1.5.5` fixed headless `agy -p` hangs caused by background title generation `[changelog]`.
- **Plugin validation (`npm run plugin:validate`) `[probed]`:** passes against `agy 1.5.9` `--strict` with `errors: 0, warnings: 0, notes: 0` (`agents: 3, hooks: 1, mcpServers: 1, rules: 1, sidecars: 0, skills: 8`). Note: `agy 1.5.6` warns under `--strict` when `hooks.json` commands reference `$PLUGIN_ROOT` `[changelog]`; booster's `hooks.json` uses relative `bin/hook-runner.sh` and is unaffected.
- **New agent tools affecting `PreToolUse` (`hooks/policy/`) `[probed]` `[changelog]`:**
  - `swarm` (`1.5.5`): native multi-agent board tool (`action`, `brief`, `name`, `tasks`, `title`, `workspace`, `model`, `fork`, `n`, `all`).
  - `run_workflow` (`1.5.9`): dynamic Python workflow orchestrator (`Script`, `ScriptPath`, `Args`, `Cwd`, `Description`, `WaitMsBeforeAsync`) that spawns a `python3` process whose stdlib file/subprocess calls bypass `PreToolUse` tool hooks.
  - Hook stdin JSON also gained `hookEventName`, `cwd`, `toolCall.id` (`1.5.4`) and `PLUGIN_ROOT` / `PLUGIN_DATA` env vars (`1.5.3`) `[changelog]`.

### ADLC (`1.12.0` -> `1.13.0`)
- `@adlc/{cli,core,consensus-fix,flail-detector,gate-manifest,hollow-test,merge-forecast,model-router,rails-guard,tickets}` latest on npm is **1.13.0** `[registry]`; repo currently pins `1.12.0` `[probed]`.
- `@adlc/antigravity` latest on npm remains **1.7.0** `[registry]`, matching `package.json` and `vendor/cache/adlc-antigravity-1.7.0.tgz`. No action.
- Dependency closure check `[registry]`: `@adlc/cli@1.13.0` retains the exact same 30 `@adlc/*` subpackages as `1.12.0` and `@adlc/hollow-test@1.13.0` depends solely on `@adlc/core@1.13.0` (zero new third-party dependencies).
- Relevant `ADLC 1.13.0` capabilities `[changelog]`:
  - `hollow-test`: native TypeScript / TSX / JSX mutation testing support (inherited automatically once `vendor/adlc` and devDependencies bump to `1.13.0`).
  - `consensus-fix`: new `--require-rails` flag enforcing non-empty rail protection at the CLI boundary.
  - `merge-forecast`: new `signalsEvaluated` array in `--json` output.
  - `gate-manifest`: new `--require-entries` flag on `verify` to reject empty manifests in CI.
  - Upgrade note: delete `.adlc/backlog-groom-ledger.json` if present (verified absent in this repository `[probed]`).

### Booster impact (static & live doctor) `[probed]`
- `node bin/agb.mjs doctor` passes 12/13 checks and warns on `Model catalog` for the 9 unrecognized `1.5.9` slugs; `test/models-live-catalog.test.mjs` similarly pins the 13-slug `1.4.7` snapshot. Because `poolOf()` matches explicit `MODELS` arrays, the 9 new Gemini slugs are currently unroutable (`poolOf(slug) === null`).
- **Policy-guard false-denial & containment gap (`hooks/policy/{constants,evaluate}.mjs`):**
  1. `swarm` is absent from `ORCHESTRATION_TOOLS`, so `evaluateUnknownTool()` **falsely denies** interactive `/teamwork` / `swarm` invocations in any repo with active rails (`Unrecognized tool "swarm" denied while ADLC rails are active`). Conversely, in headless `agb` worker sessions (`ctx.headless`), `swarm` **must remain denied** so workers cannot spawn unmanaged native swarms outside `PoolSet` leases.
  2. `run_workflow` hits `evaluateUnknownTool()` and is **hard-denied** for interactive users in active-rail repos, whereas `hooks/policy/shell.mjs` classifies `python -c` as `ask` interactively (`!ctx.headless`), `deny` in headless workers (`ctx.headless`), and `pass` in plain repos after path inspection.
- **Codeweight & repo hygiene `[probed]`:** `lib/*.mjs` (27 files) totals **15,298 lines (601.1 KB)**. Two stale ticket shards remain in `.adlc/tickets/` (`t-fix-review-loop-dd0310f` completed in `#154` but unarchived; untracked `t-fix-ci-policy-fuzzer-p95` already shipped in `#156`). Additionally, `maintainer-skills/modernize/scripts/audit.mjs` Stage 2 misflags `lib/adlc-bridge.mjs`'s intentional `LEGACY_TICKET_STORE` fail-closed check (`bridgeContent.includes('tickets.json')`) as an unpruned legacy write backend.

---

## 2. Subsystem Delta Matrix

| Pillar | Existing (`agy 1.4.7` / `ADLC 1.12.0`) | Delta / Action (`agy 1.5.9` / `ADLC 1.13.0`) |
| :--- | :--- | :--- |
| **1. Model Catalog & Dual-Pool Quota Routing** | 13 models (`gemini-4-argon-*`, `gemini-3.8-flash-*`, `claude-{opus,sonnet}-5-5-*`, `gpt-oss-120b-medium`); 2 quota pools. | Add 9 live Gemini slugs (`gemini-4-carbon-{low,medium,high}`, `gemini-4-hydrogen-{low,medium,high,xhigh}`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`) + display aliases; 0 retirements; update `fake-agy` and `models-live-catalog` snapshot; keep 2-pool topology. |
| **2. Subprocess Protocol & Structured Output** | `--output-format json\|stream-json`, `--json-schema`, headless `-p`. | Pipe prompts `> 24 KiB` via `--input-format text` on `stdin` (`agy 1.5.9` headless print mode) so large review/prosecution diffs avoid Linux `MAX_ARG_STRLEN` (`131,072` B) `spawn E2BIG`; `1.5.5` upstream fix also improves `-p` exit reliability. |
| **3. Execution Timeouts & Watchdog Controls** | `--print-timeout`, `--effort low\|medium\|high` (with `xhigh` slug suffix on Hydrogen). | Keep `runAgy` timeout/watchdog unchanged; support `-xhigh` slug suffix via explicit `gemini-4-hydrogen-xhigh` catalog entry. |
| **4. ADLC Deep Integration & Binary Authority** | `@adlc/*` `1.12.0` devDeps, vendored bundle, digest pins in `lib/adlc-bridge.mjs`, workflow CLI pins. | Bump 10 `@adlc/*` packages + `vendor/adlc` + CI workflow pins + digest tables to `1.13.0` (gated on owner trust-anchor signature); adopt `consensus-fix --require-rails` and `merge-forecast` `signalsEvaluated`. |
| **5. Platform Sandboxing & Policy Guard** | `bwrap` / `sandbox-exec`; `PreToolUse` fail-closed policy guard (`hooks/policy/`). | Explicitly classify `agy 1.5.5` `swarm` and `agy 1.5.9` `run_workflow` in `hooks/policy/`: deny both in `ctx.headless` workers; allow interactive `swarm` (excluding prose `brief`/`title`/`tasks` from false path matches); `ask` on interactive `run_workflow` under active rails after `ScriptPath`/`Cwd`/`Args` path checks. |
| **6. Deprecation & Codeweight Pruning** | `lib/` at 15,298 LOC / 601.1 KB; legacy `tickets.json` write path retired in `#137`; 1-line `RETIRED_35_MAP` deprecated alias retained. | Refine `audit.mjs` Stage 1 (`candidateModels`) and Stage 2 (`tickets.json` fail-closed detector vs legacy write path); archive/clean stale `.adlc/tickets/` shards; owner decision on `RETIRED_35_MAP` export alias. |

---

## 3. Design Decisions

1. **Bucket mapping for `agy 1.5.9` Gemini additions.** `gemini-4-carbon-{low,medium,high}`, `gemini-pro-orchestrator`, and `gemini-pro-orchestrator-argon` join `MODELS['gemini-pro']` (`upstreamPool: 'gemini'`, `family: 'gemini'`). `gemini-4-hydrogen-{low,medium,high,xhigh}` joins `MODELS['gemini-pro']` unless the owner elects a separate Flash/mid tier placement (see Open Question 2) — both map to `upstreamPool: 'gemini'` and `family: 'gemini'` per live `/quota` `[probed]`. Orchestrator slugs (`gemini-pro-orchestrator*`) are registered in `MODELS['gemini-pro']` and `MODEL_ALIASES` so `agb doctor` and explicit `--model` overrides work, but are **excluded** from builder `TIER_CANDIDATES` and single-turn `PROSECUTORS` because they are coordinator-tuned personas rather than leaf builders/prosecutors.
2. **Policy-guard classification for `swarm` and `run_workflow`.**
   - **`swarm`:** Added to `ORCHESTRATION_TOOLS` with dedicated handling in `evaluateOrchestration()`: always `deny` when `ctx.headless` (`workerTicket` or `readonly`) so dispatched `agb` workers cannot bypass `PoolSet` quota leases or spawn untracked sub-workspaces; in interactive sessions (`!ctx.headless`), skip free-text prose keys (`brief`, `title`, `tasks`) during `stepOne` path extraction (matching `invoke_subagent.Prompt` / `send_message.Message`) so tickets mentioning railed paths in prose are not false-denied.
   - **`run_workflow`:** Evaluated via a dedicated `evaluateWorkflowTool()` before `evaluateUnknownTool()`: always `deny` when `ctx.headless`; run `stepOne` + active-rail checks across `ScriptPath`, `Cwd`, and `Args` (denying protected roots and frozen rails immediately); if `ctx.activeRails` is true in an interactive session, return `ask` (`run_workflow executes arbitrary Python outside PreToolUse file hooks while ADLC rails are active`), matching `python -c` in `hooks/policy/shell.mjs`; otherwise `pass`.
3. **Lockstep `@adlc/*` `1.13.0` upgrade without touching CI trust-root code.** `package.json`, `package-lock.json`, `vendor/adlc/package.json`, `vendor/adlc/dist/**`, `lib/adlc-bridge.mjs` (`KNOWN_ADLC_DIGESTS`, `KNOWN_ADLC_DEPENDENCY_DIGESTS`, `KNOWN_VENDORED_ADLC`), `.github/workflows/{adlc-rails-guard,ci,publish}.yml`, and the 8 version-pinned test files move together in `t-deps-adlc-1-13`. `scripts/rails-guard-ci.mjs` is **not** edited (it is a protected CI trust-root script; only `test/rails-guard-ci.test.mjs`'s `TICKETS_VERSION` parity assertion updates to `'1.13.0'`).
4. **Provenance boundary.** No ticket `scope`, `rails`, or `gate` command is derived from upstream changelog strings; every path below comes from static inspection of this repository. Mandatory standing rails (`lib/lock.mjs`, `lib/gates.mjs`) plus `vendor/cache/**` and `scripts/rails-guard-ci.mjs` remain frozen across every ticket.

---

## 4. Verification Gates
- `npm test` (offline suite using updated `test/fixtures/fake-agy` and `test/fixtures/fake-adlc`).
- `npm run build && git diff --exit-code dist/ vendor/adlc/dist/` (zero bundle drift).
- `npm run skills:check` (zero mirror drift across `maintainer-skills/`, `.claude/skills/`, `.agents/skills/`).
- `npm run plugin:validate` (`agy plugin validate --strict --json` -> `0` errors, `0` warnings).
- `adlc rails-guard --base main --rails lib/lock.mjs,lib/gates.mjs,vendor/cache/**,scripts/rails-guard-ci.mjs`.
- `adlc hollow-test --test-cmd "npm test" --base main` on modified `lib/` and `hooks/policy/` modules.
- `node maintainer-skills/modernize/scripts/audit.mjs 1.13.0 v1.13.0 1.5.9 v1.5.9` (all 5 stages `[PASS]` once operator signs `~/.adlc/trusted_packages.json`).
- `agb review` 4-lens refutation fleet (`correctness`, `security`, `tests`, `contracts`) looped to two consecutive dry rounds, recorded with `adlc gate-manifest record`.

---

## 5. Open Questions for the Owner
1. ~~Approve `@adlc/*` `1.13.0` upgrade & trust-anchor signature?~~ **Resolved 2026-11-15: owner approved** (`t-deps-adlc-1-13`; bookkeeping note only — approval lives in the session/PR record).
2. ~~Tier, role & prosecutor placement for Carbon and Hydrogen (`t-models-catalog-1-5-9`)?~~ **Resolved 2026-11-15: Option A approved** (keep `gemini-4-argon-high` as frontier/role/prosecutor lead; append `gemini-4-carbon-high` to `frontier` + `PROSECUTOR_CANDIDATES` and `gemini-4-carbon-medium` / `gemini-4-hydrogen-medium` to `mid`; register all 9 slugs in `MODELS['gemini-pro']` + `MODEL_ALIASES`).
3. ~~Retain or remove deprecated `RETIRED_35_MAP` export alias?~~ **Resolved 2026-11-15: keep for `1.2.x` semver stability** (refine `audit.mjs` Stage 2 check).
4. ~~Clean up stale `.adlc/tickets/` shards before `agb run`?~~ **Resolved 2026-11-15: archived `t-fix-review-loop-dd0310f` and discarded untracked `t-fix-ci-policy-fuzzer-p95`.**

---

## 6. Implementation Ticket DAG

Edge convention: `{ "to": X }` on ticket A means A completes before X starts.

1. **Wave 1:** `t-models-catalog-1-5-9` (`lib/models.mjs` + `dist/**` + catalog tests/fixtures).
2. **Wave 2 (parallel across pools):**
   - `t-policy-guard-agy-1-5-tools` (`hooks/policy/` + `dist/**` + `test/pre-tool-use.test.mjs`) on the `claude-gpt` pool.
   - `t-modernize-audit-refresh` (`maintainer-skills/modernize/` + synced `.claude`/`.agents` mirrors + `test/modernize-skill.test.mjs`) on the `gemini` pool.
3. **Wave 3 (gated on Open Question 1):** `t-deps-adlc-1-13` (`@adlc/*` `1.13.0` bump, vendored bundle, digest tables, CI workflow pins, version-pinned tests).
4. **Wave 4:** `t-adlc-1-13-integrations` (`consensus-fix --require-rails` in `lib/scheduler.mjs`, `merge-forecast` `signalsEvaluated` in `lib/preflight.mjs`, `dist/**`, `fake-adlc`, tests).
5. **Wave 5:** `t-docs-refresh-1-5-9` (`website/content/docs/` + `website/generated/**` regeneration after all `lib/` changes land).

### Canonical Machine-Readable Ticket Plan

```json
{
  "repo": "/home/voodootikigod/Projects/voodootikigod/antigravity-booster",
  "base": "main",
  "concurrencyCap": 3,
  "gate": {
    "build": "npm run build",
    "test": "npm test"
  },
  "tickets": [
    {
      "id": "t-models-catalog-1-5-9",
      "title": "Refresh model catalog to live agy 1.5.9 (Carbon, Hydrogen, Orchestrator)",
      "body": "Update lib/models.mjs to match the 22-slug live agy 1.5.9 catalog: add gemini-4-carbon-{low,medium,high}, gemini-4-hydrogen-{low,medium,high,xhigh}, gemini-pro-orchestrator, and gemini-pro-orchestrator-argon to MODELS['gemini-pro'] and add their exact agy models display-name entries ('Gemini 4 Carbon (Low|Medium|High)', 'Gemini 4 Hydrogen (Low|Medium|High|XHigh)', 'Orchestrator (Carbon)', 'Orchestrator (Argon)') to MODEL_ALIASES. Keep all 13 existing 1.4.7 slugs and keep RETIRED_35_MAP as a deprecated alias to RETIRED_MODEL_MAP. Append gemini-4-carbon-high to TIER_CANDIDATES.frontier and PROSECUTOR_CANDIDATES.{claude,'gpt-oss'} (preserving family independence) and append gemini-4-carbon-medium and gemini-4-hydrogen-medium to TIER_CANDIDATES.mid; do NOT place gemini-pro-orchestrator* in builder TIER_CANDIDATES or PROSECUTORS. Update test/fixtures/fake-agy `models` output and LIVE_CATALOG in test/models-live-catalog.test.mjs to all 22 slugs, update test/models-registry.test.mjs, test/pools.test.mjs, and test/unit.test.mjs, and run `npm run build` so dist/ has zero drift. Acceptance: `npm run build && npm test` green; ALL_MODELS equals the 22 live agy 1.5.9 slugs.",
      "scope": [
        "lib/models.mjs",
        "dist/**",
        "test/models-live-catalog.test.mjs",
        "test/models-registry.test.mjs",
        "test/pools.test.mjs",
        "test/unit.test.mjs",
        "test/fixtures/fake-agy"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-policy-guard-agy-1-5-tools" },
        { "to": "t-modernize-audit-refresh" },
        { "to": "t-docs-refresh-1-5-9" }
      ],
      "tier": "mid",
      "pool_hint": "gemini"
    },
    {
      "id": "t-policy-guard-agy-1-5-tools",
      "title": "Classify agy 1.5.5 swarm and agy 1.5.9 run_workflow in PreToolUse policy guard",
      "body": "Update hooks/policy/constants.mjs and hooks/policy/evaluate.mjs to handle the two new agy 1.5.x native tools cleanly: (1) `swarm` (agy 1.5.5): add 'swarm' to ORCHESTRATION_TOOLS; in headless agb worker sessions (`ctx.headless`, i.e. workerTicket or readonly), ALWAYS deny `swarm` so workers cannot spawn unmanaged multi-agent swarms outside PoolSet quota leases; in interactive sessions (`!ctx.headless`), exclude free-text prose parameters (`brief`, `title`, `tasks`) from `stepOne` path extraction (matching `invoke_subagent.Prompt` / `send_message.Message`) so prose mentioning railed files does not false-deny, while still denying protected-root or rail-path violations in any path-bearing parameters. (2) `run_workflow` (agy 1.5.9): add explicit `evaluateWorkflowTool` handling before `evaluateUnknownTool`; always deny in `ctx.headless`; inspect `ScriptPath`, `Cwd`, and `Args` through `stepOne` and active-rail checks (denying any protected root or frozen rail target); in interactive sessions with `ctx.activeRails`, return `ask` (aligning `run_workflow` with `python -c` in hooks/policy/shell.mjs rather than hard-denying), and `pass` in plain non-ADLC repos. Run `npm run build` to regenerate dist/hooks/pre-tool-use.bundle.mjs and dist/*.mjs. Add comprehensive tests in test/pre-tool-use.test.mjs covering interactive active-rail, plain-repo, headless builder worker, readonly reviewer worker, and rail/protected-root path injection cases for both `swarm` and `run_workflow`. Acceptance: `npm run build && npm test` green.",
      "scope": [
        "hooks/policy/constants.mjs",
        "hooks/policy/evaluate.mjs",
        "dist/**",
        "test/pre-tool-use.test.mjs"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-deps-adlc-1-13" }
      ],
      "tier": "mid",
      "pool_hint": "claude"
    },
    {
      "id": "t-modernize-audit-refresh",
      "title": "Refresh modernize audit.mjs for agy 1.5.9 catalog and fail-closed ticket store detector",
      "body": "In maintainer-skills/modernize/scripts/audit.mjs: (1) update Stage 1 `candidateModels` to include the 9 new agy 1.5.9 slugs (`gemini-4-carbon-low`, `gemini-4-carbon-medium`, `gemini-4-carbon-high`, `gemini-4-hydrogen-low`, `gemini-4-hydrogen-medium`, `gemini-4-hydrogen-high`, `gemini-4-hydrogen-xhigh`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`); (2) update Stage 2 `pruningCandidates` so `lib/adlc-bridge.mjs`'s intentional fail-closed `LEGACY_TICKET_STORE` detector (`detectTicketStoreBackend` / `assertNoLegacyTicketStore`) and the intentional 1-line `@deprecated` `RETIRED_35_MAP` re-export alias are not misreported as unpruned legacy implementations, while still flagging if legacy dual-write backend code were reintroduced. Run `npm run skills:sync` so `.claude/skills/modernize/` and `.agents/skills/modernize/` match byte-for-byte (`npm run skills:check`). Add regression coverage in test/modernize-skill.test.mjs. Acceptance: `npm run skills:check && npm test` green.",
      "scope": [
        "maintainer-skills/modernize/**",
        ".claude/skills/modernize/**",
        ".agents/skills/modernize/**",
        "test/modernize-skill.test.mjs"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-deps-adlc-1-13" }
      ],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "t-deps-adlc-1-13",
      "title": "Bump @adlc/* suite from 1.12.0 to 1.13.0 across devDeps, vendored bundle, digests, and CI",
      "body": "Owner-approved (Open Question 1). Bump @adlc/{cli,core,consensus-fix,flail-detector,gate-manifest,hollow-test,merge-forecast,model-router,rails-guard,tickets} from 1.12.0 to 1.13.0 in package.json, regenerate package-lock.json, and bump vendor/adlc/package.json to 1.13.0 (leave @adlc/antigravity at 1.7.0 and do NOT touch vendor/cache/** or scripts/rails-guard-ci.mjs). Run `npm run build` to rebuild vendor/adlc/dist/**, run `node scripts/update-adlc-digests.mjs --write` to record the 1.13.0 registry tarball/tree/vendored SHA-512 digests in lib/adlc-bridge.mjs, and re-run `npm run build` so dist/ embeds the updated digest tables. Update `@adlc/cli@1.12.0` to `@adlc/cli@1.13.0` in .github/workflows/{adlc-rails-guard,ci,publish}.yml. Update pinned 1.12.0 version assertions and fixtures in test/rails-guard-ci.test.mjs, test/adlc-bridge-bundled.test.mjs, test/adlc-bridge.test.mjs, test/doctor.test.mjs, test/adlc-tool.test.mjs, test/modernize-skill.test.mjs, test/trust-anchor.test.mjs, and test/fixtures/package.json. Acceptance: `npm run build && npm test` green; authenticated local `adlc --version` reports 1.13.0.",
      "scope": [
        "package.json",
        "package-lock.json",
        "vendor/adlc/**",
        "lib/adlc-bridge.mjs",
        "dist/**",
        ".github/workflows/adlc-rails-guard.yml",
        ".github/workflows/ci.yml",
        ".github/workflows/publish.yml",
        "test/rails-guard-ci.test.mjs",
        "test/adlc-bridge-bundled.test.mjs",
        "test/adlc-bridge.test.mjs",
        "test/doctor.test.mjs",
        "test/adlc-tool.test.mjs",
        "test/modernize-skill.test.mjs",
        "test/trust-anchor.test.mjs",
        "test/fixtures/package.json",
        "docs/research/roadmap-agy-1.5.9-adlc-1.13.0.md",
        "scripts/check-bundle-externals.mjs",
        "test/check-bundle-externals.test.mjs",
        "test/vendor-adlc-smoke.test.mjs"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-adlc-1-13-integrations" },
        { "to": "t-fix-vendor-ts-worker-mode" }
      ],
      "tier": "mid",
      "pool_hint": "gemini"
    },
    {
      "id": "t-adlc-1-13-integrations",
      "title": "Adopt @adlc 1.13.0 consensus-fix --require-rails and merge-forecast signalsEvaluated",
      "body": "Adopt two non-breaking @adlc 1.13.0 CLI enhancements and fix the consensus-fix --rails contract: (1) in lib/scheduler.mjs (`runConsensusFix`), pass the regression gate command (`railsCmd || testCmd`, never raw rail path globs which consensus-fix executes via sh -c) alongside `--require-rails` whenever `railsCmd` is supplied or `rails.length > 0` (path-glob rail immutability continues to be enforced by `checkRailsGuard`); (2) in lib/preflight.mjs (`applyMergeForecast`), surface `firstWaveWidth`, `scheduleWidth`, and `signalsEvaluated` (the plain boolean-map object `{ scopeOverlap, namespaceCollision, importRadius, coChange, graphCoupling }`, or `null` when absent) from `adlc merge-forecast --json`. Update test/fixtures/fake-adlc to record `--rails` and `--require-rails` in `consensus-fix` and emit `firstWaveWidth`, `scheduleWidth`, and `signalsEvaluated` in `merge-forecast --json`, add unit tests in test/scheduler-consensus-fix.test.mjs and test/plan-merge-forecast.test.mjs, sync docs/research/roadmap-agy-1.5.9-adlc-1.13.0.md, and run `npm run build` to refresh dist/**. Acceptance: `npm run build && npm test` green.",
      "scope": [
        "lib/scheduler.mjs",
        "lib/preflight.mjs",
        "dist/**",
        "test/fixtures/fake-adlc",
        "test/scheduler-consensus-fix.test.mjs",
        "test/plan-merge-forecast.test.mjs",
        "docs/research/roadmap-agy-1.5.9-adlc-1.13.0.md"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-docs-refresh-1-5-9" }
      ],
      "tier": "mid",
      "pool_hint": "claude"
    },
    {
      "id": "t-docs-refresh-1-5-9",
      "title": "Refresh website docs and generated reference pages for agy 1.5.9 and ADLC 1.13.0",
      "body": "Update website/content/docs/ for the agy 1.5.9 and ADLC 1.13.0 modernization wave: (1) website/content/docs/concepts/pools-and-tiers.mdx and website/content/docs/concepts/prosecution.mdx to reflect the 22-slug catalog (Gemini 4 Carbon, Hydrogen, and Orchestrator entries alongside Argon, 3.8 Flash, Claude 5.5, and GPT-OSS 120B); (2) website/content/docs/internals/policy-guard.mdx to document PreToolUse handling of `swarm` (agy 1.5.5) and `run_workflow` (agy 1.5.9) across interactive and headless worker sessions; (3) website/content/docs/concepts/gate-evidence.mdx to document `adlc gate-manifest verify --require-entries` (@adlc/gate-manifest 1.13.0). Run `cd website && npm run gen` so website/generated/** stays in sync with any module export or doc-comment updates. Do not modify historical roadmap pages. Acceptance: `cd website && npm run gen && git diff --exit-code website/generated/` and `npm test` green.",
      "scope": [
        "website/content/docs/concepts/pools-and-tiers.mdx",
        "website/content/docs/concepts/prosecution.mdx",
        "website/content/docs/concepts/gate-evidence.mdx",
        "website/content/docs/internals/policy-guard.mdx",
        "website/generated/**"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-fix-p5-prosecution" }
      ],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "t-fix-vendor-ts-worker-mode",
      "title": "Normalize vendor/adlc/dist/syntax-check-typescript.mjs mode to 0644 for win32 digest parity",
      "body": "Normalize file mode of `vendor/adlc/dist/syntax-check-typescript.mjs` to `0644` in `package.json` `vendor:bundle` so `computeDirectoryDigest` produces identical SHA-512 tree digests on POSIX and Windows (`win32`), refresh `KNOWN_VENDORED_ADLC` via `node scripts/update-adlc-digests.mjs --write`, and rebuild `dist/**`. Acceptance: `npm run build && node --test test/digest.test.mjs` green.",
      "scope": [
        "package.json",
        "vendor/adlc/dist/syntax-check-typescript.mjs",
        "lib/adlc-bridge.mjs",
        "dist/**"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-fix-p5-prosecution" }
      ],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "t-fix-p5-prosecution",
      "title": "Remediate P5 adversarial review findings, review-fleet E2BIG/lock bugs, and hollow-test survivors",
      "body": "Resolve P5 adversarial review findings F2-F9, live agb review dogfooding bugs, and adlc hollow-test mutation survivors across lib/agy.mjs, lib/pools.mjs, lib/review.mjs, lib/adlc-bridge.mjs, lib/preflight.mjs, lib/scheduler.mjs, hooks/policy/{constants,evaluate}.mjs, scripts/check-bundle-externals.mjs, modernize audit mirrors, docs, dist bundles, and tests. Acceptance: `npm run build && npm run coverage:check && npx adlc hollow-test --base main` green.",
      "scope": [
        "lib/agy.mjs",
        "lib/pools.mjs",
        "lib/review.mjs",
        "lib/adlc-bridge.mjs",
        "lib/preflight.mjs",
        "lib/scheduler.mjs",
        "hooks/policy/constants.mjs",
        "hooks/policy/evaluate.mjs",
        "scripts/check-bundle-externals.mjs",
        "maintainer-skills/modernize/scripts/audit.mjs",
        ".claude/skills/modernize/scripts/audit.mjs",
        ".agents/skills/modernize/scripts/audit.mjs",
        "website/content/docs/internals/policy-guard.mdx",
        "website/generated/**",
        "docs/research/roadmap-agy-1.5.9-adlc-1.13.0.md",
        "dist/**",
        "test/**"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [],
      "tier": "frontier",
      "pool_hint": "claude"
    }
  ]
}
```
