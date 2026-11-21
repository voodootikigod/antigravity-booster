# Roadmap: antigravity-booster adaptation to agy 1.5.13 & ADLC 1.13.0

Delta audit since [roadmap-agy-1.5.9-adlc-1.13.0](roadmap-agy-1.5.9-adlc-1.13.0.md). Produced by `/modernize` on 2026-11-20.

Claims marked `[probed]` were verified live on this machine. Claims marked `[registry]` come from `npm view` against the npm registry. Claims marked `[changelog]` come from `agy changelog` (`1.5.10` through `1.5.13`).

---

## 1. Probed Live Facts & Upstream Delta

### agy runtime (`1.5.9` -> `1.5.13`)
- Installed `agy` is **1.5.13** `[probed]`.
- **Live model catalog (`agy models`) `[probed]`** expanded from 22 to **27 slugs** (0 retirements since `1.5.9`; 5 Gemini additions across `1.5.12`–`1.5.13`):
  - **New (`5`):**
    - `gemini-4-neon-low`, `gemini-4-neon-medium`, `gemini-4-neon-high`, `gemini-4-neon-xhigh` (`Gemini 4 Neon (Low|Medium|High|XHigh)`, added in `1.5.12` for `GEMINI_API_KEY` and `1.5.13` for ADC / enterprise gateways `[changelog]`)
    - `gemini-pro-orchestrator-neon` (`Orchestrator (Neon)` `[probed]`)
  - **Unchanged (`22`):** `gemini-4-carbon-{low,medium,high}`, `gemini-4-argon-{low,medium,high}`, `gemini-4-hydrogen-{low,medium,high,xhigh}`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium` `[probed]`.
- **Quota pools (`agy -p /quota --output-format json`) `[probed]`:** unchanged two-pool topology:
  - `Gemini Models`: `Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash` (`weekly` + `5h` buckets).
  - `Claude and GPT models`: `Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B` (`weekly` + `5h` buckets).
- **CLI flags & subcommands `[probed]`:** `--output-format {text,json,stream-json}`, `--input-format {text,stream-json}`, `--json-schema`, `--sandbox`, `--print-timeout`, `--project`, `--effort {low,medium,high,xhigh,max}`, `--mode {accept-edits,auto,plan}`, `--disable-slash-commands`, `--remote-agent`, `--settings`, and `agy plugin validate [target] [--strict] [--json]` all remain intact.
- **Reliability & security fixes relevant to headless `agb` runs `[changelog]`:**
  - `1.5.13`: Fixed `--output-format json` and `stream-json` results reporting `status: "ERROR"` (with a prior failed attempt's error) when a run succeeded after retrying a model request; they now report `SUCCESS`.
  - `1.5.13`: Agents no longer start a native `/swarm` autonomously unless the user invokes `/swarm` (reduces accidental quota burn in interactive sessions; booster's headless `PreToolUse` deny on `swarm` remains defense-in-depth).
  - `1.5.11`: Fixed resumed `--json-schema` conversations (`--conversation`) ending on plain-text replies without structured output after an earlier turn produced one; `agy plugin validate` now also accepts `.zip` archives and GitHub URLs.
  - `1.5.10`: Doubled silent-thinking stall timeout from 5m to 10m for long high-effort turns; hardened terminal sandbox to block reads of `~/.config` (`XDG_CONFIG_HOME`), Windows `AppData\Roaming`, and `~/.git-credentials` by default.
- **Agent tool surface (`init.tools`) `[probed]`:** Live `agy -p --output-format stream-json --mode plan` emits **60 tools**, with `0` added and `0` removed compared to `test/fixtures/agy-1.5.9-init-tools.json`. Zero `hooks/policy/` changes required.
- **Plugin validation (`npm run plugin:validate`) `[probed]`:** passes against `agy 1.5.13` `--strict` with `errors: 0, warnings: 0, notes: 0` (`agents: 3, hooks: 1, mcpServers: 1, rules: 1, sidecars: 0, skills: 17`).

### ADLC (`1.13.0` -> `1.13.0`, no upstream bump)
- `@adlc/cli` (`1.13.0`), `@adlc/core` (`1.13.0`), and `@adlc/antigravity` (`1.7.0`) are already at the latest published npm versions `[registry]` and match `package.json`, `package-lock.json`, and `vendor/cache/adlc-antigravity-1.7.0.tgz` `[probed]`. Zero ADLC dependency bumps required.

### Booster impact (static & live doctor) `[probed]`
- `node bin/agb.mjs doctor` passes 13/14 checks and emits **1 WARN** on `Model catalog`:
  `unrecognized: gemini-4-neon-high, gemini-4-neon-xhigh, gemini-4-neon-medium, gemini-4-neon-low, gemini-pro-orchestrator-neon`.
- `lib/models.mjs`, `scripts/sync-models.mjs` (`CACHED_MODELS_OUTPUT`), `skills/adversarial-review/references/models.json`, `test/fixtures/fake-agy`, and `test/models-live-catalog.test.mjs` still pin the 22-slug `1.5.9` catalog.
- `lib/doctor.mjs` sets `RECOMMENDED_AGY_VERSION = '1.5.9'`.
- `maintainer-skills/modernize/scripts/audit.mjs` Stage 1 `candidateModels` still lists 22 slugs (missing the 5 Neon slugs).
- **Codeweight & repo hygiene `[probed]`:**
  - `lib/` totals **19,334 lines (747.4 KB)** with **0 pruning candidates** reported by Stage 2.
  - `npm run skills:check` passes (`3 skills x 2 harness dirs` in sync).
  - `.adlc/tickets/` contains **17 stale ticket shards** from already-shipped PRs (`12` marked `completed: true` but unarchived: `T-FACTORY-1..7`, `T-FACTORY-ARL-FIXES`, `t-post-159-*`, `t-scheduler-cwd-and-shell-policy`; and `5` shipped in `#163`/`#180` still uncompleted: `T-AUDIT2-1..4`, `t-linux-worker-npm-and-shell-policy`). These should be completed and archived before dispatching new work so stale rail declarations do not block unrelated edits.

---

## 2. Subsystem Delta Matrix

| Pillar | Existing (`agy 1.5.9` / `ADLC 1.13.0`) | Delta / Action (`agy 1.5.13` / `ADLC 1.13.0`) |
| :--- | :--- | :--- |
| **1. Model Catalog & Dual-Pool Quota Routing** | 22 models (`gemini-4-{argon,carbon,hydrogen}-*`, `gemini-pro-orchestrator{,-argon}`, `gemini-3.8-flash-*`, `claude-{opus,sonnet}-5-5-*`, `gpt-oss-120b-medium`); 2 quota pools. | Add 5 live Gemini slugs (`gemini-4-neon-{low,medium,high,xhigh}`, `gemini-pro-orchestrator-neon`) + display aliases + `ORCHESTRATOR_MODELS` membership; 0 retirements; update `scripts/sync-models.mjs`, `skills/adversarial-review/references/models.json`, `fake-agy`, and catalog tests; keep 2-pool topology. |
| **2. Subprocess Protocol & Structured Output** | `--output-format json\|stream-json`, `--input-format text` stdin piping, `--json-schema`, `--disable-slash-commands`. | No protocol changes needed. `agy 1.5.13` fixes retry-then-success `status: "ERROR"` in `json`/`stream-json` and `1.5.11` fixes resumed `--json-schema` turns. |
| **3. Execution Timeouts & Watchdog Controls** | `--print-timeout`, `--effort low\|medium\|high\|xhigh\|max`, `RECOMMENDED_AGY_VERSION = '1.5.9'`. | Upstream `1.5.10` doubles silent-thinking stall window to 10m. Optionally bump `RECOMMENDED_AGY_VERSION` to `'1.5.13'` in `lib/doctor.mjs` (Open Question 2) to steer users onto the `stream-json` status and sandbox fixes. |
| **4. ADLC Deep Integration & Binary Authority** | `@adlc/*` `1.13.0` devDeps, vendored bundle, `@adlc/antigravity` `1.7.0`. | Already at latest npm versions (`1.13.0` / `1.7.0`). No ADLC package or digest changes needed. |
| **5. Platform Sandboxing & Policy Guard** | `bwrap` / `sandbox-exec`; 60-tool `PreToolUse` policy guard (`hooks/policy/`). | `init.tools` is 100% unchanged (60/60 tools `[probed]`). Upstream `1.5.10` blocks `~/.config` & `~/.git-credentials` in terminal sandbox; no policy-guard edits required. |
| **6. Deprecation & Codeweight Pruning** | `lib/` at 19,334 LOC / 747.4 KB; 0 dead-code pruning candidates; 17 shipped shards in `.adlc/tickets/`. | Update `audit.mjs` Stage 1 `candidateModels` to 27 slugs; complete & archive the 17 shipped `.adlc/tickets/` shards before dispatching new runs (Open Question 3). |

---

## 3. Design Decisions

1. **Bucket and tier placement for Gemini 4 Neon & Orchestrator (Neon).**
   - `gemini-4-neon-{low,medium,high,xhigh}` and `gemini-pro-orchestrator-neon` join `MODELS['gemini-pro']` (`upstreamPool: 'gemini'`, `family: 'gemini'`, verified via live `/quota` `[probed]`).
   - `gemini-pro-orchestrator-neon` is added to `ORCHESTRATOR_MODELS` so `--disable-orchestrator` / `AGB_DISABLE_ORCHESTRATOR=1` and the Orchestrator circuit breaker treat it identically to `gemini-pro-orchestrator` and `gemini-pro-orchestrator-argon`.
   - Default conservative routing (subject to Open Question 1): keep `gemini-4-argon-high` / `gemini-pro-orchestrator` as existing primary leads; append `gemini-4-neon-medium` to `TIER_CANDIDATES.mid`, `gemini-4-neon-high` to `FRONTIER_NO_ORCHESTRATOR`, `TIER_CANDIDATES.frontier`, and `PROSECUTOR_CANDIDATES.{claude,'gpt-oss'}`, and `gemini-pro-orchestrator-neon` to `TIER_CANDIDATES.frontier` (while keeping all orchestrator slugs excluded from `cheap`/`mid`, `PROSECUTORS`, and `ROLE_MODELS`).
2. **No `hooks/policy/` or `@adlc/*` churn.**
   - Live probing confirmed `0` tool additions/removals in `init.tools` and `0` new `@adlc/*` releases; keeping scope strictly bounded avoids unnecessary risk to hardened security boundaries.
3. **Provenance boundary.**
   - No ticket `scope`, `rails`, or `gate` command is derived from upstream changelog strings; every path below comes from static inspection of this repository. Mandatory standing rails (`lib/lock.mjs`, `lib/gates.mjs`) plus `vendor/cache/**` and `scripts/rails-guard-ci.mjs` remain frozen across every ticket.

---

## 4. Verification Gates
- `npm test` (offline suite using updated `test/fixtures/fake-agy`).
- `npm run build && git diff --exit-code dist/ vendor/adlc/dist/` (zero bundle drift).
- `npm run skills:check` (zero mirror drift across `maintainer-skills/`, `.claude/skills/`, `.agents/skills/`).
- `npm run plugin:validate` (`agy plugin validate --strict --json` -> `0` errors, `0` warnings).
- `node bin/agb.mjs doctor` (`Model catalog` -> `PASS`, 27/27 models match).
- `adlc rails-guard --base main --rails lib/lock.mjs,lib/gates.mjs,vendor/cache/**,scripts/rails-guard-ci.mjs`.
- `adlc hollow-test --test-cmd "npm test" --base main` on modified `lib/` modules.
- `node maintainer-skills/modernize/scripts/audit.mjs 1.13.0 "" 1.5.13` (all 5 stages `[PASS]`).
- `agb review` 4-lens refutation fleet (`correctness`, `security`, `tests`, `contracts`) looped to consecutive dry rounds, recorded with `adlc gate-manifest record`.

---

## 5. Open Questions for the Owner
1. ~~Tier & routing placement for Gemini 4 Neon / Orchestrator (Neon) (`t-models-catalog-1-5-13`)?~~ **Resolved 2026-11-20: Option A approved** (register all 5 slugs in `MODELS['gemini-pro']`, `MODEL_ALIASES`, and `ORCHESTRATOR_MODELS`; keep current leads and append `gemini-4-neon-medium` to `mid`, `gemini-4-neon-high` to `frontier` + `FRONTIER_NO_ORCHESTRATOR` + `PROSECUTOR_CANDIDATES`, and `gemini-pro-orchestrator-neon` to `frontier`).
2. ~~Bump `RECOMMENDED_AGY_VERSION` in `lib/doctor.mjs` from `'1.5.9'` to `'1.5.13'` (`t-doctor-and-modernize-1-5-13`)?~~ **Resolved 2026-11-20: approved** (`'1.5.13'`).
3. ~~Complete & archive the 17 shipped `.adlc/tickets/` shards before running `agb run`?~~ **Resolved 2026-11-20: approved and archived.**

---

## 6. Implementation Ticket DAG

Edge convention: `{ "to": X }` on ticket A means A completes before X starts.

1. **Wave 1:** `t-models-catalog-1-5-13` (`lib/models.mjs`, `scripts/sync-models.mjs`, `skills/adversarial-review/references/models.json`, `dist/**`, `test/fixtures/fake-agy`, catalog/routing tests).
2. **Wave 2:** `t-doctor-and-modernize-1-5-13` (`lib/doctor.mjs`, `maintainer-skills/modernize/scripts/audit.mjs`, synced `.claude`/`.agents` skill mirrors, `dist/**`, `test/doctor.test.mjs`, `test/modernize-skill.test.mjs`).
3. **Wave 3:** `t-docs-refresh-1-5-13` (`website/content/docs/**`, `website/generated/**` regeneration after all `lib/` changes land).

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
      "id": "t-models-catalog-1-5-13",
      "title": "Refresh model catalog to live agy 1.5.13 (Gemini 4 Neon & Orchestrator Neon)",
      "body": "Update lib/models.mjs to match the 27-slug live agy 1.5.13 catalog: add gemini-4-neon-{low,medium,high,xhigh} and gemini-pro-orchestrator-neon to MODELS['gemini-pro'], add their exact agy models display-name entries ('Gemini 4 Neon (Low|Medium|High|XHigh)', 'Orchestrator (Neon)') to MODEL_ALIASES, and add gemini-pro-orchestrator-neon to ORCHESTRATOR_MODELS. Keep all 22 existing 1.5.9 slugs and RETIRED_35_MAP intact. Append gemini-4-neon-medium to TIER_CANDIDATES.mid, append gemini-4-neon-high to FRONTIER_NO_ORCHESTRATOR, TIER_CANDIDATES.frontier, and PROSECUTOR_CANDIDATES.{claude,'gpt-oss'} (preserving cross-family independence), and append gemini-pro-orchestrator-neon to TIER_CANDIDATES.frontier (keeping all orchestrator slugs excluded from cheap/mid, PROSECUTORS, and ROLE_MODELS). Update CACHED_MODELS_OUTPUT in scripts/sync-models.mjs and regenerate skills/adversarial-review/references/models.json via sync-models. Update test/fixtures/fake-agy models output to all 27 slugs, update LIVE_CATALOG in test/models-live-catalog.test.mjs, update test/models-registry.test.mjs, test/pools.test.mjs, test/orchestrator-routing.test.mjs, test/sync-models.test.mjs, and test/unit.test.mjs, and run `npm run build` so dist/ has zero drift. Acceptance: `npm run build && npm test` green; ALL_MODELS equals the 27 live agy 1.5.13 slugs; `node bin/agb.mjs doctor` reports Model catalog PASS.",
      "scope": [
        "lib/models.mjs",
        "scripts/sync-models.mjs",
        "skills/adversarial-review/references/models.json",
        "dist/**",
        "test/models-live-catalog.test.mjs",
        "test/models-registry.test.mjs",
        "test/pools.test.mjs",
        "test/orchestrator-routing.test.mjs",
        "test/sync-models.test.mjs",
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
        { "to": "t-doctor-and-modernize-1-5-13" },
        { "to": "t-docs-refresh-1-5-13" }
      ],
      "tier": "mid",
      "pool_hint": "gemini"
    },
    {
      "id": "t-doctor-and-modernize-1-5-13",
      "title": "Update RECOMMENDED_AGY_VERSION and modernize audit script for agy 1.5.13",
      "body": "Update lib/doctor.mjs RECOMMENDED_AGY_VERSION from '1.5.9' to '1.5.13' (if approved by owner; otherwise retain '1.5.9' and update only audit.mjs) and align test/doctor.test.mjs version-band assertions accordingly. Update maintainer-skills/modernize/scripts/audit.mjs Stage 1 candidateModels to include the 5 new agy 1.5.13 Neon slugs (gemini-4-neon-{low,medium,high,xhigh}, gemini-pro-orchestrator-neon) so Stage 1 verifies all 27 live models, run `npm run skills:sync` to keep .claude/skills/ and .agents/skills/ mirrors in sync, update test/modernize-skill.test.mjs to target agy 1.5.13 and docs/research/roadmap-agy-1.5.13-adlc-1.13.0.md, and run `npm run build` so dist/ has zero drift. Acceptance: `npm run build && npm run skills:check && npm test` green; `node maintainer-skills/modernize/scripts/audit.mjs 1.13.0 \"\" 1.5.13` passes all 5 stages.",
      "scope": [
        "lib/doctor.mjs",
        "maintainer-skills/modernize/scripts/audit.mjs",
        ".claude/skills/modernize/**",
        ".agents/skills/modernize/**",
        "dist/**",
        "test/doctor.test.mjs",
        "test/modernize-skill.test.mjs"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [
        { "to": "t-docs-refresh-1-5-13" }
      ],
      "tier": "mid",
      "pool_hint": "claude-gpt"
    },
    {
      "id": "t-docs-refresh-1-5-13",
      "title": "Regenerate website docs and reference pages for agy 1.5.13 catalog",
      "body": "After t-models-catalog-1-5-13 and t-doctor-and-modernize-1-5-13 land, regenerate website/generated/** using the repo docs generator script and update any agy 1.5.9 / 22-model catalog references in website/content/docs/** to reflect the 27-slug agy 1.5.13 catalog (including Gemini 4 Neon and Orchestrator Neon). Acceptance: docs generator runs cleanly with zero diff drift and `npm test` remains green.",
      "scope": [
        "website/content/docs/**",
        "website/generated/**"
      ],
      "rails": [
        "lib/lock.mjs",
        "lib/gates.mjs",
        "vendor/cache/**",
        "scripts/rails-guard-ci.mjs"
      ],
      "edges": [],
      "tier": "cheap",
      "pool_hint": "gemini"
    }
  ]
}
```
