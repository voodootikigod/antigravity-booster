# Specification: v2.0.0 Release Audit Remediation & Convergence Hardening

- **Status**: Proposed (Phase 1 Shaping — Stacked on `v2-release-audit` @ `17e6186`)
- **Base**: `v2-release-audit`
- **Gate**: {"build":"npm run build","test":"npm test"}

---

## 1. Context & Owner-Aligned Design Decisions

`/release-audit 2.0.0 --since v1.3.0` (`run` `2026-11-25`) executed the full test suite (`2261/2261` passing) and all `13/13` audit surfaces (`9` shipped surfaces + `drift`, `docs`, `supply`, `issues`), returning `1` expected release-gate `BLOCKER` (`probe:releaseDrift`: `v2.0.0` tag cannot be cut until the convergence PR lands on `origin/main`) and `46` `SHOULD-FIX` findings (deduped to `18` distinct code/security/UX defects, `12` documentation/changelog alignments, `8` duplicate `CHANGELOG.md` entries, and `1` stale v1.x sidecar claim `[24]` already auto-demoted by Phase C), plus a `29`-module `UNITS` inventory gap in `scripts/release-audit-collect.mjs`.

During `/grill-me` alignment, the owner confirmed all four architectural/product trade-offs:

1. **Bounded Review Truncation (`[7]`, `lib/review.mjs`)**: When `boundReviewDiff()` or `planLensPrompt()` truncates a diff or specification exceeding `MAX_REVIEW_PAYLOAD_CHARS` (`180_000`), `reviewFleet()` and `reviewPlan()` MUST **fail closed** (`gateVerdict: 'ITERATE'`, `truncated: true`, plus a blocking `critical` finding injected post-triage citing exact character counts vs `180_000`) so truncated reviews can never silently certify `SHIP`.
2. **Dead `reviewCalibration()` (`[46]` / Issue `#175`, `lib/review.mjs`)**: Keep `@adlc/review-calibration` out of `package.json` and `vendor/adlc/src/dispatch.mjs`. Annotate `reviewCalibration()` with `@deprecated` JSDoc and surface a clear deprecation diagnostic when vendored `adlc` rejects `review-calibration`, while preserving existing `test/review-calibration.test.mjs` and `test/adlc-tool.test.mjs` contracts.
3. **Windows Shell Redirects & POSIX Prerequisite (`[34]`, `[35]`)**: Do NOT add speculative `nul` sink rewrites in `hooks/policy/shell.mjs`; document the POSIX `/bin/sh` (Git Bash / WSL) prerequisite explicitly in `README.md` and `website/content/docs/getting-started/installation.mdx`, and remove the inaccurate `"or NUL on Windows"` claim from `website/content/docs/internals/policy-guard.mdx`.
4. **`agb sidecar` Pure-HTTP `?token=` URL (`[2]` / `[24]`)**: Keep the intentional v2.0.0 `127.0.0.1` ephemeral HTTP + `?token=` design in `bin/agb.mjs`, and update all stale v1.x `commands/agb-sidecar.md`, `skills/agb-sidecar/SKILL.md`, and `website/` sidecar docs to match reality (noting token sensitivity in stdout/transcript logs).
5. **Release Drift Blocker (`probe:releaseDrift`)**: Do NOT bump `version` past `2.0.0` (`package.json`, `plugin.json`, `package-lock.json` remain `2.0.0`). `probe:releaseDrift` clears strictly post-merge via `/release` once the convergence PR merges to `origin/main` and `v2.0.0` is tagged.

---

## 2. Standing Architectural & Security Invariants

- **Frozen Rails (Read-Only Across Every Ticket)**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, and `.adlc/config.json` attestation flags MUST NOT be modified.
- **Zero `"allow"` Tokens in Hooks**: No file under `hooks/**` may emit `decision: "allow"` (`PASS` is `{}`).
- **Bundled Isolation Contract (`IS_BUNDLED`)**: In bundled plugin builds (`__AGB_BUNDLED__ === true` or installed under `~/.gemini/config/plugins/`), ambient `AGB_HOME_DIR`, `AGB_EXEC_CACHE_DIR`, `AGB_EXEC_LOCKS_DIR`, `AGB_HOLDOUT_DIR`, `AGB_MODEL_STATS_FILE`, `ADLC_ANTIGRAVITY_PLUGIN_PATH`, `AGB_SKIP_SESSION_BOOTSTRAP`, and `NODE_ENV=test` test-bypass overrides are strictly ignored.
- **Static Metadata Literals & Env-Token Discipline**: `COMMANDS` in `bin/agb.mjs` and `TOOLS` in `mcp/server.mjs` remain pure static JS literals parseable by `website/scripts/lib/jslit.mjs`; `mcp/*.mjs` introduces zero `AGB_*`, `ADLC_*`, or `ANTIGRAVITY_*` `process.env` tokens.
- **Per-Ticket Bundle Freshness**: Tickets editing source modules compiled into committed `dist/` bundles own their corresponding `npm run build:*` target (`dist/hooks/pre-tool-use.bundle.mjs` in `T-RA-3`; `dist/agb.mjs` and `dist/mcp-server.mjs` in `T-RA-5`) so merge-gate Pass 1 (`npm test`) never sees stale bundles.

---

## 3. Ticket Decomposition (`T-RA-1` – `T-RA-6`)

### Ticket 1: `T-RA-1` — Pool State & Cache Hardening + Review Fail-Closed & Calibration Deprecation

- **Scope**: `lib/pools.mjs`, `lib/review.mjs`, `test/pools.test.mjs`, `test/review-arl.test.mjs`, `test/review-calibration.test.mjs`, `test/review.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, `.adlc/config.json`
- **Edges**: `T-RA-1 -> T-RA-2`
- **Tier**: `frontier`
- **Pool Hint**: `claude-gpt`
- **Body**:
  - **1. `lib/pools.mjs` (`[4]` `#168`, `[5]`)**:
    - Export `durableWriteJson(targetPath, data, deps)` (`L509`): validate non-symlink parent directory (`lstatSync(dir)` is a non-symlink directory), validate existing `targetPath` is a regular file and not a symlink (`lstatSync(targetPath)`), generate unguessable temp path `${targetPath}.${process.pid}.${randomUUID()}.tmp`, open with `constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0)` (mode `0o600`), fsync/close, atomically rename onto `targetPath`, and unlink `tmpPath` inside `catch` on any failure.
    - Enforce POSIX UID ownership in BOTH `readFreshStatusLineQuotaCache({ ..., lstatSyncFn, getuidFn })` (`L266`) and `writeStatusLineQuotaCache(...)` (`L178-260`) when `typeof getuidFn === 'function'`: reject / return `null` on `fileStat.uid !== uid`, and when the parent directory lacks the sticky bit (`(dirStat.mode & 0o1000) === 0`) and `dirStat.uid !== uid`, return `null` / abort safely without colliding with foreign temp files. Expose clean optional DI hooks (`lstatSyncFn`, `getuidFn`) so unit tests run deterministically as non-root.
  - **2. `lib/review.mjs` (`[7]`, `[46]` `#175`)**:
    - Track truncation metadata (`truncated: boolean`, `originalChars: number`, `maxChars: number`) from `boundReviewDiff()` (`L127`) and `planLensPrompt()` (`L187`) into `reviewFleet()` (`L564`) and `reviewPlan()` (`L730`).
    - When `diff` or `specText` exceeds `MAX_REVIEW_PAYLOAD_CHARS` (`180_000`), fail closed AFTER `triageFindings()` (so the LLM arbiter cannot drop or downgrade the finding): set `truncated: true`, prepend/append a `critical` blocking finding (`id: 'PAYLOAD-TRUNCATED'`) naming the exact truncated char count vs `180_000`, and force `gateVerdict: 'ITERATE'` (`ok: false` in `reviewPlan`).
    - Annotate `reviewCalibration()` (`L952`) with `@deprecated` JSDoc noting `review-calibration` is absent from `vendor/adlc/src/dispatch.mjs`. When `runAdlcTool` returns `verb not vendored`, return `{ ok: false, deprecated: true, error: 'reviewCalibration is deprecated: adlc review-calibration is not vendored in vendor/adlc/src/dispatch.mjs (unbundled runs may pass AGB_ALLOW_CUSTOM_ADLC_CLI=1 with a custom adlcBin)' }` while keeping explicit custom `adlcBin` invocations in existing tests passing.
- **Acceptance Criteria**:
  - `durableWriteJson` rejects symlinked parent dirs and symlinked/non-file targets, opens temps with `O_EXCL`/`O_NOFOLLOW` + `randomUUID()`, and unlinks temp files on write/rename error; both `readFreshStatusLineQuotaCache` and `writeStatusLineQuotaCache` reject foreign-UID cache entries.
  - `reviewFleet()` and `reviewPlan()` fail closed (`gateVerdict: 'ITERATE'`, `truncated: true`, critical blocking finding preserved even with `arbiter: true`) on payloads `> 180_000` chars; `reviewCalibration` test suite includes real `vendor/adlc/bin/adlc.mjs` `deprecated: true` coverage alongside custom-CLI cases.
  - Verify: `node --test test/pools.test.mjs test/review-arl.test.mjs test/review-calibration.test.mjs test/review.test.mjs test/adlc-tool.test.mjs`

--------------------------------------------------------------------------------

### Ticket 2: `T-RA-2` — Strict `IS_BUNDLED` Path & Env Isolation (`adlc-bridge`, `ndjson-worker`, `bandit-router`, `bootstrap`)

- **Scope**: `lib/adlc-bridge.mjs`, `lib/ndjson-worker.mjs`, `lib/bandit-router.mjs`, `lib/bootstrap.mjs`, `test/adlc-bridge-bundled.test.mjs`, `test/ndjson-worker.test.mjs`, `test/bandit-distill.test.mjs`, `test/bootstrap-install.test.mjs`, `test/bootstrap-vendor.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, `.adlc/config.json`
- **Edges**: `T-RA-2 -> T-RA-4`
- **Tier**: `frontier`
- **Pool Hint**: `gemini`
- **Body**:
  - **1. `lib/adlc-bridge.mjs` (`[27]`)**: In `getApprovedPinnedBase({ bundled = IS_BUNDLED } = {})` (`L1152`) and `getApprovedLocksDir({ bundled = IS_BUNDLED } = {})` (`L1172`), honor `process.env.AGB_EXEC_CACHE_DIR`, `process.env.AGB_EXEC_LOCKS_DIR`, and `process.env.AGB_HOME_DIR` ONLY when `!bundled` (falling back strictly to `homedir()` when `bundled` is true, matching `pluginManifestDir` DI convention).
  - **2. `lib/ndjson-worker.mjs` (`[28]`, `[32]`, `[43]`)**: Import `IS_BUNDLED` from `./adlc-bridge.mjs`. Support optional `{ bundled = IS_BUNDLED }` (or resolve via `IS_BUNDLED`), ignoring ambient `process.env.AGB_HOME_DIR` and `env?.AGB_HOME_DIR` in BOTH `NdjsonWorkerDaemon` constructor (`L216`) and `_spawnDaemon()` (`L257`, `L288`) whenever `bundled` / `IS_BUNDLED` is true.
  - **3. `lib/bandit-router.mjs` (`[44]`)**: Import `IS_BUNDLED` from `./adlc-bridge.mjs`. Gate BOTH `process.env.AGB_HOME_DIR` and `process.env.AGB_MODEL_STATS_FILE` in `defaultStatsFilePath(home, { bundled = IS_BUNDLED })` (`L16`) and `BanditModelRouter` constructor on `!bundled`, and enforce `lstatSync` non-symlink verification on `this.statsFile` and its parent directory inside `readRecords()` (`L68`) and `recordOutcome()` (`L143`), opening temp files exclusively with `flag: 'wx'` (`mode: 0o600`) and unlinking on write/rename error.
  - **4. `lib/bootstrap.mjs` (`[30]`)**: Gate `resolvePluginPath({ bundled = IS_BUNDLED } = {})` (`L61`) on `!bundled`: when `bundled` is true, throw a clear error refusing `ADLC_ANTIGRAVITY_PLUGIN_PATH` / sibling fallback instead of resolving external plugin paths, while preserving unbundled behavior for `test/unit.test.mjs`.
- **Acceptance Criteria**:
  - When `bundled: true` (and in compiled `dist/` bundles where `__AGB_BUNDLED__ === true`), `getApprovedPinnedBase`, `getApprovedLocksDir`, `NdjsonWorkerDaemon`, `defaultStatsFilePath`/`BanditModelRouter`, and `resolvePluginPath` strictly ignore `AGB_HOME_DIR`, `AGB_EXEC_CACHE_DIR`, `AGB_EXEC_LOCKS_DIR`, `AGB_MODEL_STATS_FILE`, and `ADLC_ANTIGRAVITY_PLUGIN_PATH`.
  - `BanditModelRouter` rejects symlinked stats files/directories and cleans up exclusive `'wx'` temp writes on failure.
  - Verify: `node --test test/adlc-bridge-bundled.test.mjs test/ndjson-worker.test.mjs test/bandit-distill.test.mjs test/bootstrap-install.test.mjs test/bootstrap-vendor.test.mjs test/unit.test.mjs`

--------------------------------------------------------------------------------

### Ticket 3: `T-RA-3` — Policy Guard, SessionStart Bootstrap, Hook-Runner & Launcher Resilience

- **Scope**: `hooks/policy/evaluate.mjs`, `hooks/policy/shell.mjs`, `hooks/session-start.mjs`, `bin/hook-runner.sh`, `bin/node-launcher.sh`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/policy-guard-bypass.test.mjs`, `test/policy-guard-e2e.test.mjs`, `test/session-start-hook.test.mjs`, `test/lifecycle-hooks.test.mjs`, `test/hook-runner.test.mjs`, `test/node-launcher.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, `.adlc/config.json`
- **Edges**: `T-RA-3 -> T-RA-5`
- **Tier**: `frontier`
- **Pool Hint**: `claude-gpt`
- **Body**:
  - **1. `hooks/policy/evaluate.mjs` & `hooks/policy/shell.mjs` (`[10]`, `[12]`)**:
    - Export `unwrap` (`L55`) and `inlineScript` (`L451`) from `hooks/policy/shell.mjs`.
    - In `buildContext()` (`L1138` of `hooks/policy/evaluate.mjs`), only add `env.AGB_USER_HOME` to `extraHomes` when `homeMarker.test(home) || homeMarker.test(realHome)` so ambient `AGB_USER_HOME` in non-sandboxed sessions cannot mask `.adlc` rail roots.
    - Fix `isMutatingAgbCliSubcommand()` (`L1226`) to skip global value-taking flags such as `--project <val>` (matching `bin/agb.mjs:48-65`) before reading `positionals[0]`, AND import/reuse `unwrap` and `inlineScript` from `./shell.mjs` inside `evaluateRunCommand()` (`L1275`) up to bounded depth (`MAX_NESTING = 3`) to recursively inspect nested inline shell invocations (`env ... sh -c`, `bash -lc`, `eval`, etc.), failing closed (`deny`) if nested parsing fails or contains mutating `agb holdout` / `agb distill --apply` / `--compile-checks`.
  - **2. `hooks/session-start.mjs` (`[11]`, `[41]`)**:
    - Port `detectInstalledPluginPath()` (matching `/\.gemini\/config\/plugins\//` on lexical & realpath of `import.meta.url`) into `hooks/session-start.mjs`, deriving `isBundled = (typeof __AGB_BUNDLED__ !== 'undefined' && Boolean(__AGB_BUNDLED__)) || detectInstalledPluginPath()`.
    - Ignore `AGB_SKIP_SESSION_BOOTSTRAP` whenever `isBundled` is true.
    - Anchor `pluginRoot` via `realpathSync` equality against `resolve(dirname(selfPath), '..')` when `process.env.PLUGIN_ROOT` is set.
    - Validate `process.env.PLUGIN_DATA` when `isBundled` using nearest-existing-ancestor `realpathSync` resolution (so first-run installs before `plugin_data/antigravity-booster` exists via `mkdirSync` do NOT throw `ENOENT`!), falling back strictly to `<homedir>/.gemini/antigravity-cli/plugin_data/antigravity-booster` when mismatched or outside expected data root.
  - **3. `bin/hook-runner.sh` (`[10]`, `[13]`)**:
    - In `emit_fallback()` (`L394`), skip `"${AGB_USER_HOME%/}"` ONLY when `$HOME` matches `*/.agb_home` / `*/.agb_home/*`, matching `evaluate.mjs` so ambient `AGB_USER_HOME` never suppresses ADLC rail discovery.
    - Extend fallback `TARGETS_PROTECTED` (`L476`) so payloads matching `.booster`, `agb-ctrl-`, `/.gemini/`, `control.sock`, `holdouts`, `twins-runtime`, or `accept-state` set `TARGETS_PROTECTED=1`.
  - **4. `bin/node-launcher.sh` (`[10]`, `[42]`)**:
    - Unset pre-existing ambient `AGB_USER_HOME` when `USER_HOME == HOME` or `HOME` is not an `.agb_home` sandbox directory (`L298`).
    - When `NODE_BIN` is empty (`No Node.js >= 22.19.0 found`, `L271`) and `$1` is `hooks/session-start.mjs` or `hooks/lifecycle.mjs`, emit `{}\n` and exit `0` cleanly instead of exit `86` (keeping exit `86` intact for `dist/agb.mjs`, `dist/hooks/pre-tool-use.bundle.mjs`, and all other scripts, and keeping `hooks.json` frozen).
  - **5. Bundle Rebuild**: Run `npm run build:hooks && node scripts/check-bundle-externals.mjs dist/hooks/pre-tool-use.bundle.mjs` so committed `dist/hooks/pre-tool-use.bundle.mjs` matches `hooks/policy/evaluate.mjs`.
  - **Invariant**: Zero `"allow"` tokens anywhere inside `hooks/**`.
- **Acceptance Criteria**:
  - `agb --project foo holdout ...`, `env FOO=1 sh -lc 'agb holdout ...'`, and `eval "agb distill --compile-checks"` are denied in `AGB_RESCUE_TICKET` and headless worker sessions; ambient `AGB_USER_HOME` does not skip `.adlc` root discovery in `evaluate.mjs` or `hook-runner.sh:emit_fallback()`.
  - `hooks/session-start.mjs` works cleanly on first-run installs before `plugin_data/antigravity-booster` exists, ignores `AGB_SKIP_SESSION_BOOTSTRAP=1` when installed, and rejects spoofed `PLUGIN_ROOT`/`PLUGIN_DATA`.
  - `bin/node-launcher.sh hooks/session-start.mjs` and `hooks/lifecycle.mjs` degrade to `{}\n` + exit `0` without Node >= 22.19 while `dist/hooks/pre-tool-use.bundle.mjs` rebuilds byte-identically for `test/plugin-layout.test.mjs`.
  - Verify: `npm run build:hooks && node scripts/check-bundle-externals.mjs dist/hooks/pre-tool-use.bundle.mjs && node --test test/policy-guard-bypass.test.mjs test/policy-guard-e2e.test.mjs test/session-start-hook.test.mjs test/lifecycle-hooks.test.mjs test/hook-runner.test.mjs test/node-launcher.test.mjs test/plugin-layout.test.mjs test/no-allow.test.mjs`

--------------------------------------------------------------------------------

### Ticket 4: `T-RA-4` — Doctor Fail-Warn Accuracy, Migration Rollback & Windows Shim Detection

- **Scope**: `lib/doctor.mjs`, `lib/migrate.mjs`, `test/doctor.test.mjs`, `test/doctor-selftest.test.mjs`, `test/windows-sandbox-doctor.test.mjs`, `test/migrate-rollback.test.mjs`, `test/builder-stream-json.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, `.adlc/config.json`
- **Edges**: `T-RA-4 -> T-RA-5`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Body**:
  - **1. `lib/doctor.mjs` (`[19]`, `[25]`, `[26]`, `[29]`, `[36]`, `[45]`)**:
    - Update `isTestExecution()` (`L837`): unconditionally return `false` when `IS_BUNDLED` is true; preserve the early `false` return whenever `effectiveNodeEnv && effectiveNodeEnv !== 'test'` (so `NODE_ENV: 'production'` under `node --test` remains `false`); and otherwise require `Boolean(process.env.NODE_TEST_CONTEXT || env?.NODE_TEST_CONTEXT || process.execArgv.includes('--test') || process.argv.some(...))` instead of trusting `NODE_ENV=test` alone (`test/builder-stream-json.test.mjs` updated if needed).
    - Update `checkAdlcBinary()` (`L398-399`, `[36]`): remove inaccurate `'not found (will be installed by bootstrap)'` / `'npx agb bootstrap'` text; state accurate `@adlc/cli` remediation (`npm install @adlc/cli` or bundled vendored ADLC runtime).
    - Update `checkSandbox()` (`L1164`): when `env.AGB_SANDBOX_GATES === '0'`, return `level: 'warn'` (not `'pass'`) with `fix: 'Unset AGB_SANDBOX_GATES outside disposable containers so gate commands remain sandboxed.'`.
    - Update `checkTicketStore()` (`L1309`): when `!bin` in unbundled non-tamper mode (ADLC CLI unavailable to verify active directory store), return `level: 'warn'` with detail `` `${backend} backend (unverified: ${errReason || 'adlc CLI unavailable'})` `` and remediation hint rather than `'pass'`.
    - Update `checkSecondaryInstall({ home, env, platform = process.platform })` (`L337`): compute delimiter as `platform === 'win32' ? ';' : ':'`, read `String(env.PATH ?? env.Path ?? '')`, and check `agb.cmd` and `agb.ps1` alongside `agb` when `platform === 'win32'`.
  - **2. `lib/migrate.mjs` (`[21]`, `[29]`)**:
    - Import `uninstallCliStatusLineSettings` directly from `./cli-statusline.mjs` (`L620`, NOT `./bootstrap.mjs`).
    - In `agbElsewhereOnPath()` (`L501`), use `(platform === 'win32' ? ';' : ':')`, `env.PATH ?? env.Path`, and inspect `agb.cmd`/`agb.ps1` when `platform === 'win32'`.
    - In `migrate` baseline snapshot / `restoreFromBaseline()` (`L524`), snapshot `settings.json` statusLine/title presence (or cleanly call `uninstallCliStatusLineSettings({ home })` whenever `baseline.settingsPreviouslyHadStatusLine !== true`, including pre-existing v1.x shims `shimPreviouslyAbsent === false` upgraded to v2.0 `agb bootstrap`), ignoring missing-settings errors safely so `agb migrate --rollback` leaves zero orphaned v2.0.0 `statusLine`/`title` entries.
- **Acceptance Criteria**:
  - `isTestExecution()` returns `false` when bundled or `NODE_ENV !== 'test'`, and requires `NODE_TEST_CONTEXT` or `--test` otherwise; `checkSandbox({ env: { AGB_SANDBOX_GATES: '0' } })` and unverified `checkTicketStore` return `level: 'warn'`; `checkAdlcBinary()` no longer claims `agb bootstrap` installs `@adlc/cli`; `checkSecondaryInstall` & `agbElsewhereOnPath` support injected `platform: 'win32'`, `;` delimiter, `env.Path`, and `.cmd`/`.ps1`.
  - `migrate --rollback` invokes `uninstallCliStatusLineSettings({ home })` (from `./cli-statusline.mjs`) when rolling back v2.0 `settings.json` wiring even if a v1.x shim previously existed.
  - Verify: `node --test test/doctor.test.mjs test/doctor-selftest.test.mjs test/windows-sandbox-doctor.test.mjs test/migrate-rollback.test.mjs test/builder-stream-json.test.mjs`

--------------------------------------------------------------------------------

### Ticket 5: `T-RA-5` — MCP UI Path/Error Hardening, Scoped Bundle Externals, Audit Coverage & Bundle Build

- **Scope**: `mcp/ui-views.mjs`, `scripts/check-bundle-externals.mjs`, `scripts/release-audit-collect.mjs`, `bin/agb.mjs`, `dist/agb.mjs`, `dist/mcp-server.mjs`, `test/mcp-apps.test.mjs`, `test/check-bundle-externals.test.mjs`, `test/audit2-policy-supply.test.mjs`, `test/release-audit-collect.test.mjs`, `test/commands.test.mjs`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, `.adlc/config.json`
- **Edges**: `T-RA-5 -> T-RA-6`
- **Tier**: `mid`
- **Pool Hint**: `gemini`
- **Body**:
  - **1. `mcp/ui-views.mjs` (`[16]`)**:
    - Do NOT reference any `AGB_*`/`ADLC_*`/`ANTIGRAVITY_*` env variables anywhere in `mcp/*.mjs`.
    - In Plan Card (`btnCompile` `L571`, `btnLaunch` `L586`) AND Plan Viewer (`btnRunPlan` `L1350`): inspect `res && res.isError`, surfacing extracted error text on status lines instead of reporting false success.
    - In `btnLaunch` (`L586`) and `btnRunPlan` (`L1350`), resolve relative `plan`/`out`/`targetPath` against `repo` (`inp.repo || planState.repo` / `viewerState.repo || (inp && inp.repo)`), and call `agb_run` strictly with `{ plan: resolvedPlanPath }` (never passing an unknown `repo` parameter that fails `agb_run` MCP schema validation).
  - **2. `scripts/check-bundle-externals.mjs` (`[23]`)**:
    - Keep `export const BUNDLE_ALLOWED_OPTIONAL_PROBES` intact (`test/audit2-policy-supply.test.mjs:246-249` asserts it), AND replace file-wide exemption for vendored bundles with lightweight range-scoped verification targeting the exact guarded probe regions where optional `typescript` probing actually lives in `vendor/adlc/dist/adlc.bundle.mjs` and `vendor/adlc/dist/syntax-check-typescript.mjs` (`inspectTypeScript` function slice + guarded top-level `syntax-check-typescript` block, NEVER the 3-line `resolveTypeScript` wrapper alone!), rejecting `'typescript'` / `'path'` / `'resolved.path'` anywhere else in those bundles without adding any AST parser dependency.
  - **3. `scripts/release-audit-collect.mjs`**:
    - Map all 29 currently unowned `lib/*.mjs` modules cleanly into the existing `9` `UNITS` (`surface:cli`, `surface:scheduler`, `surface:adlc-gates`, `surface:mcp`, `surface:install`), keeping `UNITS.length === 9` and strictly disjoint paths so `/release-audit` covers every `lib/*.mjs` module.
  - **4. `bin/agb.mjs` (`[36]`)**:
    - Keep `const COMMANDS` a pure static JS literal and update `COMMANDS.bootstrap.desc` to accurately state skill linking, `adlc-antigravity` install, `~/.local/bin/agb` shim creation, and `settings.json` `statusLine`/`title` wiring.
  - **5. CLI & MCP Bundle Rebuild**:
    - Because `T-RA-5` follows `T-RA-1 -> T-RA-2 -> T-RA-4`, rebuild `npm run build:agb && npm run build:mcp && node scripts/check-bundle-externals.mjs` so `dist/agb.mjs` and `dist/mcp-server.mjs` carry all `T-RA-1..5` fixes for Pass 1 (`test/mcp-apps.test.mjs`) and bundled isolation tests.
- **Acceptance Criteria**:
  - `btnLaunch` and `btnRunPlan` resolve relative `plan` paths against `repo` without passing unknown `repo` arg to `agb_run`, and `btnCompile`/`btnLaunch`/`btnRunPlan` display `isError: true` tool failures.
  - `check-bundle-externals.mjs` rejects `'typescript'` injected outside `inspectTypeScript()` / top-level guarded `syntax-check-typescript` try-block while passing clean vendored bundles and preserving `BUNDLE_ALLOWED_OPTIONAL_PROBES` contract.
  - Every `lib/*.mjs` file maps to one of the `9` `UNITS` in `scripts/release-audit-collect.mjs`; `dist/agb.mjs` and `dist/mcp-server.mjs` are rebuilt and clean under `check-bundle-externals.mjs`.
  - Verify: `npm run build:agb && npm run build:mcp && node scripts/check-bundle-externals.mjs && node --test test/mcp-apps.test.mjs test/check-bundle-externals.test.mjs test/audit2-policy-supply.test.mjs test/release-audit-collect.test.mjs test/commands.test.mjs`

--------------------------------------------------------------------------------

### Ticket 6: `T-RA-6` — v2.0.0 Changelog, Documentation & Website Convergence

- **Scope**: `CHANGELOG.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `README.md`, `commands/**`, `skills/**`, `website/**`
- **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/dist/**`, `scripts/rails-guard-ci.mjs`, `hooks/pre-tool-use.mjs`, `mcp_config.json`, `plugin.json`, `hooks.json`, `.adlc/config.json`, `dist/**`, `.claude/**`, `.agents/**`
- **Edges**: (none — converges after `T-RA-5`)
- **Tier**: `mid`
- **Pool Hint**: `claude-gpt`
- **Body**:
  - **1. `CHANGELOG.md` (`[1],[6],[9],[14],[15],[20],[31],[40]`)**: Keep `package.json`/`plugin.json` at `2.0.0`. Populate `CHANGELOG.md` under `## [2.0.0]` with complete Waves 1–4 notes and explicit `Breaking Changes`: sidecar dynamic manifest removal & HTTP `?token=` URL, `agb watch` alt-screen buffer + hotkeys, new `rescue`/`accept`/`statusline`/`holdout` commands + flags, rescue-lock refusal without `--reset-rescue`, `--resume`, `runConfiguredGates` build/test key filtering, `agb bootstrap` `settings.json` `statusLine`/`title` wiring, `SessionStart` + 6-event lifecycle hooks, frontier default-on Sealed Holdouts, Ephemeral Digital Twins, Bandit Router, `gate.autofix`, MCP 15 tools + 6 UI apps, and `doctor` warn levels.
  - **2. Sidecar Docs (`[2]`)**: Update `commands/agb-sidecar.md`, `skills/agb-sidecar/SKILL.md`, `website/content/docs/reference/cli/sidecar.mdx`, and `website/content/docs/guides/sidecar-dashboard.mdx` to match the v2.0.0 HTTP `127.0.0.1` `/?token=` URL architecture accurately (and warn against exposing `?token=` URLs in shared logs/transcripts).
  - **3. CLI, Plan, Bootstrap, Review & MCP Reference Docs (`[3],[8],[17],[18],[22],[26],[36],[37],[38],[39]`)**:
    - Update `website/env-docs.json` for `AGB_MODEL_STATS_FILE` (`"bundledIgnored": true`, aligned with `T-RA-2`).
    - Create `website/content/docs/reference/cli/{accept,holdout,rescue,statusline}.mdx`, register them in `website/content/docs/reference/cli/meta.json` and `website/scripts/ia.json`, and update `website/content/docs/reference/cli/run.mdx`, `plan.mdx`, `distill.mdx`, `watch.mdx`, `review.mdx`, `bootstrap.mdx`, `website/content/docs/reference/plan-schema.mdx`, `website/content/docs/concepts/plan-boundary.mdx`, `website/content/docs/internals/plan-compiler.mdx`, `website/content/docs/guides/review.mdx`, `website/content/docs/guides/headless-and-mcp.mdx`, `website/content/docs/reference/mcp-tools.mdx`, `website/content/docs/getting-started/bootstrap.mdx`, and `website/content/docs/getting-started/verify.mdx` (pass/warn/fail table at `L67` `[26]`).
    - Update `commands/agb.md`, `commands/agb-plan.md`, `commands/agb-bootstrap.md`, `skills/agb/SKILL.md`, `skills/agb-plan/SKILL.md`, and `skills/agb-bootstrap/SKILL.md` with new v2.0.0 subcommands/flags and unify first-run bootstrap guidance (`commands/agb-bootstrap.md:22-28` vs `skills/agb-bootstrap/SKILL.md:22-28`).
    - Align `website/content/docs/reference/agy-integration.mdx` with `--disable-slash-commands` and all `17` failure kinds (`#178`).
  - **4. Architecture, Security & Platform Docs (`[30],[33],[34],[35]`)**:
    - Update `AGENTS.md` to reference `installAdlcAntigravityFromVendor()` in `lib/plugin-paths.mjs` (called by `installVendoredAdlcAntigravity()` in `lib/bootstrap.mjs`), `devDependencies`, and `!IS_BUNDLED` `resolvePluginPath()`.
    - Update `SECURITY.md` and `CONTRIBUTING.md` Windows sandboxing docs (`AGB_SANDBOX_GATES=0` runs gates unsandboxed; active AppContainer or HMAC `sandboxBypassAttestation` required otherwise; refresh stale line-number references).
    - Update `README.md` and `website/content/docs/getting-started/installation.mdx` with POSIX `/bin/sh` (Git Bash / WSL) prerequisite on Windows, and remove `"or NUL on Windows"` from `website/content/docs/internals/policy-guard.mdx`.
  - **5. Website Regeneration & Gate Checks**:
    - Run `node website/scripts/gen-reference.mjs && node website/scripts/check-all.mjs && npm run skills:check && npm run plugin:validate -- --allow-skip && node scripts/check-bundle-externals.mjs && npm test`. (Never invoke `vendor:bundle` or `skills:sync`.)
- **Acceptance Criteria**:
  - Zero stale v1.x claims across `commands/`, `skills/`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `website/env-docs.json`, and `website/content/docs/**`.
  - `node website/scripts/gen-reference.mjs && node website/scripts/check-all.mjs && npm run skills:check && npm run plugin:validate -- --allow-skip && node scripts/check-bundle-externals.mjs && npm test` exits `0`.

---

## 4. Acceptance Criteria

- [ ] `durableWriteJson` in `lib/pools.mjs` rejects symlinked parent/target paths, uses `O_EXCL`/`O_NOFOLLOW` + `randomUUID()`, and cleans up temp files, and both `readFreshStatusLineQuotaCache` and `writeStatusLineQuotaCache` enforce POSIX UID ownership. Verify: `node --test test/pools.test.mjs`
- [ ] `reviewFleet()` and `reviewPlan()` in `lib/review.mjs` fail closed (`gateVerdict: 'ITERATE'`, `truncated: true`, critical finding preserved post-triage) on payloads `> 180_000` chars, and `reviewCalibration()` carries `@deprecated` docs + real vendored diagnostics. Verify: `node --test test/review-arl.test.mjs test/review-calibration.test.mjs test/review.test.mjs test/adlc-tool.test.mjs`
- [ ] Bundled execution in `lib/adlc-bridge.mjs`, `lib/ndjson-worker.mjs`, `lib/bandit-router.mjs`, and `lib/bootstrap.mjs` ignores `AGB_HOME_DIR`, `AGB_EXEC_CACHE_DIR`, `AGB_EXEC_LOCKS_DIR`, `AGB_MODEL_STATS_FILE`, and `ADLC_ANTIGRAVITY_PLUGIN_PATH`, and `BanditModelRouter` rejects symlinks. Verify: `node --test test/adlc-bridge-bundled.test.mjs test/ndjson-worker.test.mjs test/bandit-distill.test.mjs test/bootstrap-install.test.mjs test/bootstrap-vendor.test.mjs test/unit.test.mjs`
- [ ] `hooks/policy/evaluate.mjs` reuses `hooks/policy/shell.mjs` `unwrap`/`inlineScript` for `sh -c`/`eval`, skips `--project`, and restricts `AGB_USER_HOME`; `hooks/session-start.mjs` handles first-run `PLUGIN_DATA` ancestors safely; `bin/hook-runner.sh` (`emit_fallback` + `TARGETS_PROTECTED`) and `bin/node-launcher.sh` (graceful `{}\n` exit `0` on non-blocking hooks) are hardened with `dist/hooks/pre-tool-use.bundle.mjs` rebuilt. Verify: `npm run build:hooks && node scripts/check-bundle-externals.mjs dist/hooks/pre-tool-use.bundle.mjs && node --test test/policy-guard-bypass.test.mjs test/policy-guard-e2e.test.mjs test/session-start-hook.test.mjs test/lifecycle-hooks.test.mjs test/hook-runner.test.mjs test/node-launcher.test.mjs test/plugin-layout.test.mjs test/no-allow.test.mjs`
- [ ] `lib/doctor.mjs` gates `isTestExecution()` cleanly, returns `level: 'warn'` for bypassed sandbox and unavailable unbundled `adlc`, updates `checkAdlcBinary()` text, and detects Win32 `.cmd`/`.ps1` shims alongside `lib/migrate.mjs`, while `migrate --rollback` invokes `uninstallCliStatusLineSettings({ home })` from `lib/cli-statusline.mjs`. Verify: `node --test test/doctor.test.mjs test/doctor-selftest.test.mjs test/windows-sandbox-doctor.test.mjs test/migrate-rollback.test.mjs test/builder-stream-json.test.mjs`
- [ ] `mcp/ui-views.mjs` resolves relative `plan` paths against `repo` without passing unknown `repo` args and handles `isError`; `scripts/check-bundle-externals.mjs` scopes `'typescript'` probes cleanly; `scripts/release-audit-collect.mjs` maps every `lib/*.mjs` file into `9` `UNITS`; CLI & MCP bundles are rebuilt. Verify: `npm run build:agb && npm run build:mcp && node scripts/check-bundle-externals.mjs && node --test test/mcp-apps.test.mjs test/check-bundle-externals.test.mjs test/audit2-policy-supply.test.mjs test/release-audit-collect.test.mjs test/commands.test.mjs`
- [ ] `CHANGELOG.md`, `website/env-docs.json`, docs/skills, and regenerated website assets align with v2.0.0 runtime behavior and pass every integrity gate. Verify: `node website/scripts/gen-reference.mjs && node website/scripts/check-all.mjs && npm run skills:check && npm run plugin:validate -- --allow-skip && node scripts/check-bundle-externals.mjs && npm test`
