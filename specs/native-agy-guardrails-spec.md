# Specification: Native Antigravity Guardrails & Verification Hardening

**Base:** `research/verification-and-guardrails` \
**Gate:** `{"test": "npm test"}`

--------------------------------------------------------------------------------

## 1. Overview & Objectives

This specification aligns `antigravity-booster` (`agb`) with Google Antigravity's normative **Verification and Guardrails** contracts (`permissions`, `sandbox`, `hooks`, and `https://antigravity.google/schemas/v1/settings.json`):

1.  **`PreToolUse` `force_ask` Escalation, Degraded Fail-Safe Hardening & Rollback Switch (`T-GUARD-1A`)**:
    -   Preserves Appendix A D7 strictly: Booster **never** emits `"decision": "allow"` or `"auto_approve"` (neutral pass-through remains empty stdout `""` with exit `0`; `overwrite` is never emitted).
    -   Adds `force_ask` (`RANK = { pass: 0, ask: 1, force_ask: 2, deny: 3 }`) across `hooks/policy/verdict.mjs`, `hooks/pre-tool-use.mjs`, and `bin/hook-runner.sh`.
    -   Upgrades interactive operator prompts in active-rail ADLC repos from `ask` to `force_ask` on `run_workflow`, third-party MCP calls, and `adlc ticket <verb> --authorize`, **and** upgrades `bin/hook-runner.sh`'s degraded interactive fail-safe (`run_command` in ADLC repos and `--fallback deny` in non-ADLC repos) from `ask` to `force_ask` so a hook timeout/crash can never downgrade `force_ask` to a cached `"Always Allow"` grant.
    -   Provides an explicit operator rollback switch `AGB_DISABLE_FORCE_ASK=1` (downgrading `force_ask` to `ask` in both `hooks/pre-tool-use.mjs` and `bin/hook-runner.sh`), while headless workers (`AGB_WORKER_TICKET` or `AGB_WORKER_MODE`) always convert any `ask` or `force_ask` to `deny`.
2.  **`agy v1.5.17` Tool Taxonomy Modernization (`T-GUARD-1B`)**:
    -   Updates `hooks/policy/` and `stepOne()` pre-dispatch path extraction for zero-argument `list_permissions({})`, `find_by_name` (`SearchDirectory`), `ask_permission` (`Action`, `Target`, `Reason`), and `generate_image` (`Prompt`, `ImageName`, `ImagePaths`).
3.  **Sandboxed, Env-Sanitized & Injectable Red-Phase Test Runner (`T-GUARD-2`)**:
    -   Hardens `verifyRedPhaseTests()` in `lib/tdd-split.mjs` with synchronous OS gate sandboxing (`sandboxProfile` / `linuxBwrapArgs` from frozen rail `lib/gates.mjs`), injectable `spawnFn` / `sandboxAvailableFn` execution seams for deterministic cross-platform testing, secret environment stripping, symlink escape rejection, and `--test-reporter=tap` startup verification so pre-runner/sandbox startup crashes return `ok: false`.
4.  **Strict `action(target)` `--settings` Profiles & Rail Compilation (`T-GUARD-3`, `T-GUARD-5`)**:
    -   Creates pure zero-dependency `lib/role-settings.mjs` (`PERMISSION_RULE_RE`, `isValidPermissionRule`, `compileRailsToDenyRules`, `buildRoleSettingsProfile`) emitting **only** `{ allowNonWorkspaceAccess: false, permissions: { deny: [...] } }`.
    -   `readonly` roles **unconditionally** deny `'mcp(*)'` regardless of `hasCodegraph`; `builder` roles deny `'mcp(*)'` when `!hasCodegraph` and deny `['mcp(agb/*)', 'mcp(antigravity-booster_agb/*)']` when `hasCodegraph === true` (while `stageFilteredMcpConfig` strips all non-codegraph servers from staged `mcp_config.json`), plus compiled `write_file(<rail>)` rules.
5.  **`MIN_AGY_VERSION = '1.5.7'`, `agb doctor` `settings.json` Audit & `force_ask` Self-Test (`T-GUARD-4`)**:
    -   Bumps `MIN_AGY_VERSION` in `lib/doctor.mjs` from `'1.2.6'` to `'1.5.7'`, adds advisory `checkCliSettings()` (`lib/doctor-settings.mjs`), and extends `checkPolicyGuard()` to verify `force_ask` emission on active-rail `run_workflow`.
6.  **Default-Contained `NdjsonWorkerDaemon` & Bundle/Docs Sync (`T-GUARD-5`, `T-GUARD-6`)**:
    -   Extracts async `prepareBuilderContainment()` in `lib/agy.mjs` preserving 100% `runAgy()` launch argv/mount/nonce parity, defaults `NdjsonWorkerDaemon` to `containment = (role === 'builder')` using `prepareBuilderContainment`, updates `test/fixtures/fake-agy` and `test/agy-no-mcp-storm.test.mjs`, and syncs `dist/{agb,mcp-server}.mjs`, `website/env-docs.json`, and `website/generated/**`.

## Resolved Trade-Offs

-   **`MIN_AGY_VERSION` & `force_ask` Rollback (`F-002`):** Bump `MIN_AGY_VERSION` in `lib/doctor.mjs` to `'1.5.7'` (requiring modern `auto` mode & `PreToolUse` `force_ask` support) **and** provide `AGB_DISABLE_FORCE_ASK=1` rollback switch downgrading `force_ask` to `ask`.
-   **Strict `action(target)` Schema vs. Legacy Bare Tool Names (`F-003`, `F-004`):** Antigravity's official `https://antigravity.google/schemas/v1/settings.json` (`permissionRule`) specifies that `agy` ignores rules outside `^(command|read_file|write_file|read_url|execute_url|mcp|unsandboxed)\(.*\)$`; live `agy 1.5.17` probing confirmed `allowNonWorkspaceAccess: false` + `action(target)` rules are accepted natively while `PreToolUse` (`stageHooksOnlyBoosterPlugin`) blocks orchestration tools (`invoke_subagent`, `swarm`, `run_workflow`) in every headless worker. `readonly` roles unconditionally include `'mcp(*)'` in `permissions.deny`; `builder` roles with `hasCodegraph: true` include `'mcp(agb/*)'` and `'mcp(antigravity-booster_agb/*)'` while `stageFilteredMcpConfig` excludes all non-codegraph servers.
-   **Nested Sandbox Avoidance (`F-001` Round 1):** `buildRoleSettingsProfile()` omits `enableTerminalSandbox`, `toolPermission`, and `agentMode` so outer `bwrap` / Seatbelt containment never hits nested `CLONE_NEWUSER` / `sandbox_init()` `EPERM`.
-   **Why `T-GUARD-4 -> T-GUARD-5` Edge Exists (`F-023`):** `lib/agy.mjs` (`T-GUARD-5`) directly imports `./doctor.mjs` (`T-GUARD-4`), so `agb shape --strict` (`scanStaticImportCoupling`) requires a serializing edge between `T-GUARD-4` and `T-GUARD-5`; `T-GUARD-2` runs completely in parallel and wires directly to leaf `T-GUARD-6`.

--------------------------------------------------------------------------------

## 2. Ticket Dependency DAG

```mermaid
graph TD
  T-GUARD-1A["T-GUARD-1A: force_ask Verdict, Fail-Safe & Rollback Switch"] --> T-GUARD-1B["T-GUARD-1B: agy v1.5.17 Tool Taxonomy & stepOne Evaluators"]
  T-GUARD-1B --> T-GUARD-4["T-GUARD-4: MIN_AGY_VERSION 1.5.7, CLI Settings Audit & Self-Test"]
  T-GUARD-3["T-GUARD-3: Pure role-settings Module & Rail Compiler"] --> T-GUARD-4
  T-GUARD-3 --> T-GUARD-5["T-GUARD-5: Wire role-settings & Async prepareBuilderContainment"]
  T-GUARD-4 --> T-GUARD-5
  T-GUARD-2["T-GUARD-2: Sandboxed & Injectable verifyRedPhaseTests"] --> T-GUARD-6["T-GUARD-6: Bundle Rebuild, env-docs/Reference Sync & E2E"]
  T-GUARD-5 --> T-GUARD-6
```

--------------------------------------------------------------------------------

## 3. Ticket Specifications

### Ticket 1: `T-GUARD-1A` — PreToolUse `force_ask` Verdict, Fail-Safe Hardening & `AGB_DISABLE_FORCE_ASK` Rollback

-   **Scope**: `hooks/policy/verdict.mjs`, `hooks/policy/evaluate.mjs`, `hooks/policy/shell.mjs`, `hooks/pre-tool-use.mjs`, `bin/hook-runner.sh`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/hook-runner.test.mjs`, `test/pre-tool-use.test.mjs`, `test/policy-guard-bypass.test.mjs`, `test/audit-policy-and-supply.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `T-GUARD-1A -> T-GUARD-1B`
-   **Tier**: `frontier`
-   **Pool Hint**: `claude-gpt`
-   **Objectives**:
    1.  In `hooks/policy/verdict.mjs`, export `forceAsk = (reason) => ({ decision: 'force_ask', reason })` and set `RANK = { pass: 0, ask: 1, force_ask: 2, deny: 3 }` so `mostRestrictive()` enforces `deny > force_ask > ask > pass`. Preserve Appendix A D7 (`pass` emits empty stdout; never emit `allow` or `auto_approve`).
    2.  In `hooks/pre-tool-use.mjs`:
        -   Accept `verdict.decision` in `['deny', 'ask', 'force_ask']`.
        -   If `verdict.decision === 'force_ask'` and `process.env.AGB_DISABLE_FORCE_ASK === '1'`, emit `decision: 'ask'` with the same `reason`; otherwise emit `verdict.decision`.
    3.  In `bin/hook-runner.sh`:
        -   Accept `ask|force_ask|deny` in `--fallback` validation.
        -   Define helper variable `PROMPT_DECISION="force_ask"` (set to `"ask"` when `[ "$AGB_DISABLE_FORCE_ASK" = "1" ]`).
        -   In `emit_fallback`: for interactive `run_command` in an ADLC repository (`line ~504`) and for non-ADLC `deny|force_ask` fallback (`line ~528`), emit `"decision":"$PROMPT_DECISION"` instead of hardcoded `"ask"` so a crashed or timed-out hook cannot downgrade `force_ask` to a cached `"Always Allow"` grant (and when `FALLBACK_DECISION="ask"` with `AGB_DISABLE_FORCE_ASK != 1`, preserve `"ask"`).
        -   In final `OUTPUT` validation (`line ~618`), accept single-line `'{"decision":"force_ask"'*` and `'{"decision": "force_ask"'*` alongside `ask` and `deny`:
            -   If `[ -n "$AGB_WORKER_TICKET" ] || [ -n "$AGB_WORKER_MODE" ]` and `OUTPUT` has `ask` or `force_ask`, reject and call `emit_fallback` (which emits `deny` in headless worker mode).
            -   If `[ "$AGB_DISABLE_FORCE_ASK" = "1" ]` and `OUTPUT` starts with `'{"decision":"force_ask"'` or `'{"decision": "force_ask"'`, rewrite the leading decision token to `"decision":"ask"` before printing.
            -   Continue rejecting `allow` / `auto_approve` via `emit_fallback`.
    4.  Upgrade three interactive active-rail prompts from `ask(...)` to `forceAsk(...)` (headless workers continue returning `deny`):
        -   `evaluateMcpTool` (`hooks/policy/evaluate.mjs:793`): third-party MCP tool call in an active-rail ADLC repo returns `forceAsk('Third-party MCP tool call in an active-rail ADLC repository requires operator confirmation')`.
        -   `evaluateWorkflowTool` (`hooks/policy/evaluate.mjs:1033`): `run_workflow` in an active-rail ADLC repo returns `forceAsk('run_workflow executes Python outside PreToolUse file hooks in an active-rail ADLC repository; operator confirmation required')`.
        -   `classifySubcommand` (`hooks/policy/shell.mjs:501`): interactive `adlc ticket <verb> --authorize` in an ADLC repo returns `forceAsk('Authorized ticket lifecycle change requires operator confirmation')`.
    5.  Run `npm run build:hooks` to rebuild `dist/hooks/pre-tool-use.bundle.mjs`, and update assertions in `test/hook-runner.test.mjs` (including degraded ADLC `run_command` `force_ask`, headless `ask`/`force_ask` -> `deny`, and `AGB_DISABLE_FORCE_ASK=1` downgrade), `test/pre-tool-use.test.mjs` (`lines 208, 316, 657, 686, 710`), `test/policy-guard-bypass.test.mjs` (`line 245`), and `test/audit-policy-and-supply.test.mjs` (`line 114`).
-   **Acceptance Criteria**:
    -   `node --test test/hook-runner.test.mjs test/pre-tool-use.test.mjs test/policy-guard-bypass.test.mjs test/audit-policy-and-supply.test.mjs test/plugin-layout.test.mjs` exits `0`.
    -   `npm test` exits `0` with 0 failures.

--------------------------------------------------------------------------------

### Ticket 2: `T-GUARD-1B` — `agy v1.5.17` Tool Taxonomy (`list_permissions`, `find_by_name`, `ask_permission`, `generate_image`)

-   **Scope**: `hooks/policy/constants.mjs`, `hooks/policy/evaluate.mjs`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/policy-1-5-9-readonly.test.mjs`, `test/policy-guardrails-1-5-17.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `T-GUARD-1B -> T-GUARD-4`
-   **Tier**: `frontier`
-   **Pool Hint**: `claude-gpt`
-   **Objectives**:
    1.  In `hooks/policy/constants.mjs`:
        -   Remove `list_permissions` from `REQUIRED_READ_PATH_KEYS` while keeping `list_permissions: ['paths', 'path']` in `READ_TOOL_PATH_SCHEMAS`.
        -   Add `'SearchDirectory'` to `READ_TOOL_PATH_SCHEMAS.find_by_name`.
        -   Export `ASK_PERMISSION_ACTIONS = new Set(['command', 'read_file', 'write_file', 'read_url', 'execute_url', 'download_url', 'mcp'])`, `ASK_PERMISSION_PROSE_KEYS = new Set(['Reason', 'reason', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary'])`, and `GENERATE_IMAGE_PROSE_KEYS = new Set(['Prompt', 'prompt', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary'])`.
    2.  In `hooks/policy/evaluate.mjs`:
        -   Update `extractReadToolPaths(name, rawArgs)` so `const pathKeys = REQUIRED_READ_PATH_KEYS[name] ?? READ_TOOL_PATH_SCHEMAS[name] ?? []; const pathRequired = Object.hasOwn(REQUIRED_READ_PATH_KEYS, name);`: validate argument shape identically (rejecting empty string, empty array `[]`, or unapproved extra keys), and require `extractedPaths.length >= 1` only when `pathRequired === true`. Call `extractReadToolPaths` in `stepOne` for `name === 'list_permissions'` as well as `REQUIRED_READ_PATH_KEYS` tools so 0-arg `list_permissions({})` passes while `list_permissions({ paths: [] })` or `list_permissions({ paths: [boosterDataPath] })` is denied.
        -   Update `stepOne(name, args, ctx)` pre-dispatch candidate extraction so `generate_image` and `ask_permission` do not fall into the generic `scanPathLike(args)` branch that scans `Prompt` prose or misclassifies `read_file` brain targets:
            -   For `name === 'generate_image'`: extract candidates strictly from `(typeof norm.folded.imagename === 'string' && looksLikePath(norm.folded.imagename) ? [toPath(norm.folded.imagename)] : [])` plus `(Array.isArray(norm.folded.imagepaths) ? norm.folded.imagepaths.filter((s) => typeof s === 'string').map(toPath) : [])`; `isRead` remains `false` so `stepOne` allows only verified active-session `brainRoots` artifacts (`isAllowedBrainArtifactTarget`) and denies `protectedRoots` / `boosterDataRoots`.
            -   For `name === 'ask_permission'`: scan `args` with `topLevelSkipKeys: ASK_PERMISSION_PROSE_KEYS`, plus `toPath(norm.folded.target)` when `typeof norm.folded.target === 'string'` and (`['read_file', 'write_file'].includes(String(norm.folded.action ?? '').toLowerCase())` || `looksLikePath(norm.folded.target)`); set `isRead` in `stepOne` to `String(norm.folded.action ?? '').toLowerCase() === 'read_file'`.
        -   Add `evaluateAskPermission(rawArgs, ctx)` dispatched from `evaluatePayload` when `name === 'ask_permission'`: deny in `ctx.headless`; normalize via `normalizeArgsCaseInsensitive`; allow only keys `action`, `target`, `reason`, `toolaction`, `toolsummary`; require non-empty strings `action` and `target`, and optional string `reason`. Lowercase `act = action.trim().toLowerCase()`; deny if `act === 'unsandboxed'` or `!ASK_PERMISSION_ACTIONS.has(act)`. Resolve path candidates (`act === 'read_file' || act === 'write_file' || looksLikePath(target)`) via `resolveAll` (denying unanchorable relative paths, `boosterDataRoots`, `protectedRoots` on non-read, `containsProtected` on `write_file`, or `gateOnePath` non-pass; also check `globTargetVerdict`-equivalent wildcard rails by denying any `write_file`/`read_file` target containing `*` when an anchor or resolved path is in an ADLC repo). If any anchor or resolved repo is ADLC with `!r.store.ok`, deny; if `r.activeRail`, return `forceAsk('Permission request in an active-rail ADLC repository requires operator confirmation')`; else `PASS`.
        -   Add `evaluateGenerateImage(rawArgs, ctx)` dispatched from `evaluatePayload` when `name === 'generate_image'`: deny in `ctx.headless` (`ctx.readonly || ctx.workerTicket`); normalize via `normalizeArgsCaseInsensitive`; allow only keys `prompt`, `imagename`, `imagepaths`, `toolaction`, `toolsummary`; require non-empty strings `prompt` and `imagename` (rejecting `..` path segments in `imagename`), and optional `imagepaths` as an array of `1..20` non-empty strings (`imagepaths: []` allowed as empty). For every path candidate (`looksLikePath(imagename)` and each `imagepaths` item), resolve via `resolveAll` and run `containsProtected` + `evaluateOneTargetForm(r, 'write_file', { Path: token }, ctx, [])` (checking both `r` and lexical form when `r.lexical !== r.real`), returning `deny` on any non-pass verdict; otherwise `PASS`.
    3.  Run `npm run build:hooks` to rebuild `dist/hooks/pre-tool-use.bundle.mjs`, update `test/policy-1-5-9-readonly.test.mjs` for 0-arg `list_permissions({})`, and create `test/policy-guardrails-1-5-17.test.mjs` (<320 lines) covering `list_permissions`, `find_by_name` (`SearchDirectory`), `ask_permission`, and `generate_image` (including `Prompt` prose mentioning `lib/lock.mjs` and `~/.ssh` without false-positive denial, session brain artifact target pass, and rail/protected target denial).
-   **Acceptance Criteria**:
    -   `node --test test/policy-1-5-9-readonly.test.mjs test/policy-guardrails-1-5-17.test.mjs test/plugin-layout.test.mjs` exits `0`.
    -   `npm test` exits `0` with 0 failures.

--------------------------------------------------------------------------------

### Ticket 3: `T-GUARD-2` — Sandboxed, Env-Sanitized & Injectable `verifyRedPhaseTests`

-   **Scope**: `lib/tdd-split.mjs`, `test/tdd-split.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `T-GUARD-2 -> T-GUARD-6`
-   **Tier**: `mid`
-   **Pool Hint**: `gemini`
-   **Objectives**:
    1.  Harden synchronous `verifyRedPhaseTests(testFiles = [], { worktree = process.cwd(), timeoutMs = 30_000, env = process.env, platform = process.platform, spawnFn = spawnSync, sandboxAvailableFn = gateSandboxAvailable } = {})` in `lib/tdd-split.mjs` (<320 lines) without editing frozen rail `lib/gates.mjs`:
        -   Validate `wtRoot = resolve(worktree)` exists as a directory and compute `realWtRoot = realpathSync(wtRoot)`. For each entry in `testFiles`, reject control chars (`/[\0\r\n]/`), absolute paths, `..` segments, or paths failing `isTestPathspec`; verify via `lstatSync` and `realpathSync` that the file exists, is not a symlink, and `realFull.startsWith(realWtRoot + sep)`.
        -   Export `sanitizeRedPhaseEnv(env = process.env, platform = process.platform)`: copy only allowlisted baseline keys (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, `TEMP`, `TMP`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`), set `NODE_ENV = 'test'`, and strip `NODE_TEST_CONTEXT`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, and any key matching `/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|CERT/i`.
        -   Syntax-check each file via `spawnFn(process.execPath, ['--check', full], { cwd: realWtRoot, env: childEnv, timeout: 10_000, encoding: 'utf8' })`, returning `{ ok: false, reason: 'spec-test syntax error in ...' }` when `status !== 0`.
        -   Import `gateSandboxAvailable`, `sandboxProfile`, and `linuxBwrapArgs` from `./gates.mjs`. When `env.AGB_SANDBOX_GATES !== '0'`:
            -   If `(platform !== 'darwin' && platform !== 'linux') || !sandboxAvailableFn(env)`, fail closed returning `{ ok: false, reason: 'spec-test red-phase sandbox unavailable on ' + platform + ' (set AGB_SANDBOX_GATES=0 only in disposable containers)' }`.
            -   On `darwin`: write `sandboxProfile(realWtRoot)` to a temp dir (`mkdtempSync`), invoke `spawnFn('sandbox-exec', ['-f', profileFile, process.execPath, '--test', '--test-reporter=tap', ...cleanFiles], { cwd: realWtRoot, env: childEnv, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })`, and remove the temp dir in `finally`.
            -   On `linux`: create `emptyRoDir = mkdtempSync(...)`, record pre-existing `.git` and `node_modules` inside `realWtRoot`, build shell-quoted `cmd = [process.execPath, '--test', '--test-reporter=tap', ...cleanFiles].map((s) => "'" + String(s).replace(/'/g, "'\\''") + "'").join(' ')`, invoke `spawnFn('bwrap', linuxBwrapArgs(realWtRoot, cmd, emptyRoDir), { cwd: realWtRoot, env: childEnv, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })`, and in `finally` remove `emptyRoDir` plus any empty `.git`/`node_modules` mountpoint dirs created during the call.
        -   When `env.AGB_SANDBOX_GATES === '0'`, invoke `spawnFn(process.execPath, ['--test', '--test-reporter=tap', ...cleanFiles], { cwd: realWtRoot, env: childEnv, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })`.
        -   Check `res`:
            -   If `res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM' || res.signal === 'SIGKILL'`, return `{ ok: false, reason: 'spec-test red-phase verification timed out' }`.
            -   If `res.status === 0`, return `{ ok: false, reason: 'tautological spec tests: tests passed on unimplemented base (red-phase failure required)' }`.
            -   Catch pre-runner / sandbox startup failures: require `/^TAP version \d+/m.test(res.stdout ?? '')` and `/^not ok \d+/m.test(res.stdout ?? '')`; if absent, return `{ ok: false, reason: 'spec-test red-phase runner failed before executing TAP tests: ' + String(res.stderr || res.error?.message || 'unknown error').slice(0, 240) }`.
            -   Otherwise return `{ ok: true, verifiedFiles: cleanFiles, exitCode: res.status ?? 1 }`.
    2.  Expand `test/tdd-split.test.mjs` (<280 lines) testing real execution (`AGB_SANDBOX_GATES: '0'` and live Linux `bwrap` when `gateSandboxAvailable()` is true), secret env stripping, symlink/traversal rejection, and deterministic `spawnFn` / `sandboxAvailableFn` unit tests for `darwin` `sandbox-exec`, `linux` `bwrap` EPERM startup failure (`ok: false`), `win32` fail-closed, and timeout handling.
-   **Acceptance Criteria**:
    -   `lib/tdd-split.mjs` is strictly under 320 lines, synchronous, and leaves `lib/gates.mjs` untouched.
    -   `node --test test/tdd-split.test.mjs` and `npm test` exit `0`.

--------------------------------------------------------------------------------

### Ticket 4: `T-GUARD-3` — Pure `lib/role-settings.mjs` Permission Grammar & Rail Compiler

-   **Scope**: `lib/role-settings.mjs`, `test/role-settings.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `T-GUARD-3 -> T-GUARD-4`, `T-GUARD-3 -> T-GUARD-5`
-   **Tier**: `mid`
-   **Pool Hint**: `gemini`
-   **Objectives**:
    1.  Create pure zero-dependency `lib/role-settings.mjs` (<200 lines) exporting:
        -   `PERMISSION_RULE_RE = /^(command|read_file|write_file|read_url|execute_url|download_url|mcp|unsandboxed)\(.+\)$/`
        -   `isValidPermissionRule(rule)`: returns `true` iff `typeof rule === 'string' && rule.length <= 1024 && !/[\r\n\0]/.test(rule) && rule.trim() === rule && PERMISSION_RULE_RE.test(rule)`.
        -   `compileRailsToDenyRules(rails = [])`: normalizes repo-relative rail pathspecs (`\` -> `/`, strips leading `./`), skips empty strings, control chars, `..` segments, leading `/` or `~`, or strings containing `(` or `)`; converts trailing `/**` or `/*` on wildcard-free directory prefixes (e.g. `vendor/cache/**` -> `vendor/cache/`); skips any remaining entry containing wildcard chars `[*?[\]{}]` (e.g. `**/*.snap`); returns deduplicated `write_file(<target>)` rules passing `isValidPermissionRule`.
        -   `buildRoleSettingsProfile(role = 'builder', { hasCodegraph = false, rails = [], extraSettings = {} } = {})`:
            -   Emits **only** `allowNonWorkspaceAccess: false` and `permissions: { deny: [...] }` by default (omitting `enableTerminalSandbox`, `toolPermission`, and `agentMode`).
            -   `readonly` roles (`prosecutor`, `review`, `review-plan`, `coldstart`, `parallax`, `premortem`, `brain`, `arbiter`, `readonly`) **unconditionally** deny `'mcp(*)'` regardless of `hasCodegraph`: `['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']`.
            -   `builder` roles emit deduplicated `['write_file(.git/)', 'write_file(.adlc/)', 'write_file(.booster/)', ...compileRailsToDenyRules(rails), 'command(sudo)', 'command(rm -rf)', 'command(git push)', 'read_url(*)', 'execute_url(*)', ...(hasCodegraph ? ['mcp(agb/*)', 'mcp(antigravity-booster_agb/*)'] : ['mcp(*)'])]`.
            -   Deep-merges `extraSettings.permissions` (`allow`, `ask`, `deny` arrays) without clobbering base `deny` rules.
    2.  Create `test/role-settings.test.mjs` (<220 lines) verifying `isValidPermissionRule`, `compileRailsToDenyRules`, unconditional `'mcp(*)'` on `readonly` even with `{ hasCodegraph: true }`, `mcp(agb/*)`/`mcp(antigravity-booster_agb/*)` on `builder` with `{ hasCodegraph: true }`, and `extraSettings` deep merge.
-   **Acceptance Criteria**:
    -   `lib/role-settings.mjs` is strictly under 200 lines with zero external package imports.
    -   `node --test test/role-settings.test.mjs` and `npm test` exit `0`.

--------------------------------------------------------------------------------

### Ticket 5: `T-GUARD-4` — `MIN_AGY_VERSION = '1.5.7'`, `agb doctor` `settings.json` Audit & `force_ask` Self-Test

-   **Scope**: `lib/doctor-settings.mjs`, `lib/doctor.mjs`, `test/doctor-settings.test.mjs`, `test/doctor-selftest.test.mjs`, `test/doctor.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `T-GUARD-4 -> T-GUARD-5`
-   **Tier**: `mid`
-   **Pool Hint**: `gemini`
-   **Objectives**:
    1.  Create `lib/doctor-settings.mjs` (<200 lines) importing `isValidPermissionRule` directly from `./role-settings.mjs` (no barrel re-export churn):
        -   Export `checkCliSettings({ home = homedir(), env = process.env } = {})` inspecting `<home>/.gemini/antigravity-cli/settings.json` (`home || env.HOME || homedir()`).
        -   Returns `{ name: 'CLI settings', level: 'pass', detail: 'defaults (no settings.json)', fix: null }` when absent (`ENOENT`).
        -   Rejects symlinks, non-regular files, or files `> 1024 * 1024` bytes via `lstatSync` with `level: 'warn'`.
        -   Strips JSONC comments outside string literals, parses JSON (`level: 'warn'` on invalid JSON or non-object), and warns (`level: 'warn'`, never `'fail'`) on `toolPermission === 'always-proceed'`, `allowNonWorkspaceAccess === true`, or non-object `permissions` / non-array `allow`/`ask`/`deny` / any rule failing `isValidPermissionRule`. Returns `{ name: 'CLI settings', level: 'pass', detail: 'guardrails intact', fix: null }` when clean.
    2.  In `lib/doctor.mjs`:
        -   Bump `export const MIN_AGY_VERSION = '1.5.7'` (`RECOMMENDED_AGY_VERSION` stays `'1.5.13'`) and update the fail fix string to `'Upgrade agy to >= 1.5.7 for modern PreToolUse force_ask and sandbox support.'`.
        -   Import `checkCliSettings` from `./doctor-settings.mjs`, re-export `checkCliSettings` from `lib/doctor.mjs`, and include `checkCliSettings(resolvedOpts)` in `runDoctor()` (never mutating `settings.json` in `applyDoctorFixes()`).
        -   Extend `checkPolicyGuard()` in `lib/doctor.mjs` to also send `{ toolCall: { name: 'run_workflow', args: { Script: 'print(1)', Cwd: repo } }, workspacePaths: [repo] }` (with `AGB_DISABLE_FORCE_ASK: ''` in `hookEnv`) and verify exit `0` + single JSON line with `out.decision === 'force_ask'`.
    3.  Update `test/doctor.test.mjs` (`lines 43-59` for `MIN_AGY_VERSION === '1.5.7'`, testing `'1.5.6'` as `fail` and `'1.5.7'`/`'1.5.8'` as `warn`), add `force_ask` self-test coverage in `test/doctor-selftest.test.mjs`, and create `test/doctor-settings.test.mjs` (<220 lines).
-   **Acceptance Criteria**:
    -   `MIN_AGY_VERSION` equals `'1.5.7'` and `applyDoctorFixes()` never mutates `settings.json`.
    -   `node --test test/doctor.test.mjs test/doctor-selftest.test.mjs test/doctor-settings.test.mjs` and `npm test` exit `0`.

--------------------------------------------------------------------------------

### Ticket 6: `T-GUARD-5` — Wire `role-settings` & Async `prepareBuilderContainment` into `runAgy`, `NdjsonWorkerDaemon` & `scheduler`

-   **Scope**: `lib/ndjson-worker.mjs`, `lib/agy.mjs`, `lib/scheduler.mjs`, `test/fixtures/fake-agy`, `test/ndjson-worker.test.mjs`, `test/v14-integration.test.mjs`, `test/agy-no-mcp-storm.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `T-GUARD-5 -> T-GUARD-6`
-   **Tier**: `frontier`
-   **Pool Hint**: `claude-gpt`
-   **Objectives**:
    1.  In `lib/agy.mjs` and `lib/scheduler.mjs`:
        -   Import and re-export `buildRoleSettingsProfile` from `./role-settings.mjs`. Accept optional `rails` in `runAgy({ ..., rails })` and pass `{ hasCodegraph, rails }` to `buildRoleSettingsProfile(role, { hasCodegraph, rails })` when `useRoleSettings` is true and `settings === undefined`. Pass `rails: t.rails` in `buildOnce()` in `lib/scheduler.mjs` (`line ~1982`).
        -   Extract `export async function prepareBuilderContainment({ agyBin, args, cwd, repo, sandbox = true, containment = true, env = process.env, userHome, allowCodegraph = false, platform = process.platform, verifiedBypass = null })` in `lib/agy.mjs`, encapsulating `runAgy()`'s existing builder sandbox/containment logic across `bwrap_pid` (Linux), `seatbelt` (macOS), `job_object` + `verifyWindowsSandboxActive` / `verifySandboxBypassAttestation` (Windows, reusing `verifiedBypass` when supplied so daemon respawns never double-consume a single-use nonce), and rejected mechanisms (`cgroups_v2_scope`, `pid_namespace`, missing cwd). Return `{ ok: true, launchBin, launchArgs, stagedBuilderHome, verifiedBypass, cleanup }` or `{ ok: false, kind: 'containment_unavailable', error }`, and have `runAgy()` delegate to `prepareBuilderContainment()` with zero change to `runAgy()`'s launch argv, mounts, or cleanup behavior.
    2.  In `lib/ndjson-worker.mjs` (<520 lines):
        -   Import and re-export `buildRoleSettingsProfile` from `./role-settings.mjs` (removing the old inline `READONLY_DENY_TOOLS` / `BUILDER_BASE_DENY_TOOLS`).
        -   Update `NdjsonWorkerDaemon`: accept `role = 'builder'`, `sandbox = role === 'builder'`, `containment = role === 'builder'`, `repo = null`, `platform = process.platform`, and `prepareContainment = null` in `constructor(...)`. Make `_spawnDaemon()` `async` (awaited inside `sendTurn()`):
            -   When `this.role === 'builder' && (this.containment || this.sandbox)`: resolve `const containmentFn = this.prepareContainment ?? (await import('./agy.mjs')).prepareBuilderContainment`, call `await containmentFn({ agyBin: this.bin, args, cwd: this.cwd, repo: this.repo ?? this.cwd, sandbox: this.sandbox, containment: this.containment, env: spawnEnv, platform: this.platform, verifiedBypass: this._verifiedBypass })`, cache `this._verifiedBypass = res.verifiedBypass ?? this._verifiedBypass`, store `this._containmentCleanup = res.cleanup ?? null`, and if `!res.ok` return `{ ok: false, kind: res.kind ?? 'containment_unavailable', error: res.error }` from `sendTurn()` without spawning raw `this.bin` (and without falling back to uncontained single-shot).
            -   In `close()`, invoke and clear `this._containmentCleanup()` after killing the daemon process tree.
    3.  Update `test/fixtures/fake-agy` (`ALLOWED_SETTINGS_KEYS = new Set(["permissions", "allowNonWorkspaceAccess"])`), `test/agy-no-mcp-storm.test.mjs` (`mock-storm-agy` allowed settings keys + assertions at lines `316-318, 383-386, 523, 543` for `allowNonWorkspaceAccess: false`, `write_file(*)`, `mcp(*)`, `mcp(agb/*)`), `test/ndjson-worker.test.mjs` (passing `containment: false, sandbox: false` on pure NDJSON protocol unit tests + adding default builder containment, respawn nonce preservation, and cleanup tests), and `test/v14-integration.test.mjs` (including `runAgy()` builder launch argv/mount parity assertions).
-   **Acceptance Criteria**:
    -   `node --test test/ndjson-worker.test.mjs test/v14-integration.test.mjs test/agy-no-mcp-storm.test.mjs` exits `0`.
    -   `npm test` exits `0` with 0 failures.

--------------------------------------------------------------------------------

### Ticket 7: `T-GUARD-6` — Bundle Rebuild, `env-docs.json` / Reference Sync & End-to-End Guardrail Verification

-   **Scope**: `dist/agb.mjs`, `dist/mcp-server.mjs`, `website/env-docs.json`, `website/generated/**`, `test/guardrails-e2e.test.mjs`
-   **Rails**: `lib/lock.mjs`, `lib/gates.mjs`, `vendor/cache/**`, `vendor/adlc/**`, `dist/hooks/pre-tool-use.bundle.mjs`, `scripts/rails-guard-ci.mjs`
-   **Edges**: `(leaf — depends on T-GUARD-2 and T-GUARD-5)`
-   **Tier**: `mid`
-   **Pool Hint**: `gemini`
-   **Objectives**:
    1.  Rebuild `dist/agb.mjs` and `dist/mcp-server.mjs` via `npm run build:agb && npm run build:mcp` (keeping `dist/hooks/pre-tool-use.bundle.mjs` and `vendor/adlc/**` frozen in `Rails`) and verify `node scripts/check-bundle-externals.mjs` exits `0`.
    2.  Document `AGB_DISABLE_FORCE_ASK` in `website/env-docs.json` (`group: "sandbox-and-gates"`, `default: "unset"`, `bundledIgnored: false`, description explaining that setting `1` downgrades `PreToolUse` `force_ask` prompts and degraded ADLC shell fallbacks to `ask`), then run `node website/scripts/gen-reference.mjs` to update `website/generated/**` (including `env.mdx` and `modules.mdx` for `lib/role-settings.mjs` and `lib/doctor-settings.mjs`) and verify `node website/scripts/gen-reference.mjs --check` exits `0`.
    3.  Create `test/guardrails-e2e.test.mjs` (<220 lines) testing end-to-end across shipped bundles and modules:
        -   `bin/hook-runner.sh` + `dist/hooks/pre-tool-use.bundle.mjs`: `force_ask` on active-rail `run_workflow` & degraded ADLC `run_command`, `ask` downgrade under `AGB_DISABLE_FORCE_ASK=1`, `deny` in `AGB_WORKER_TICKET` mode, empty stdout on 0-arg `list_permissions({})`, and `deny` on `ask_permission` targeting `unsandboxed` or frozen rails.
        -   `buildRoleSettingsProfile` (`builder` with rails + `prosecutor`) written to `<tmpHome>/.gemini/antigravity-cli/settings.json` passes `checkCliSettings({ home: tmpHome })` with `level: 'pass'`.
        -   `verifyRedPhaseTests` secret stripping and TAP verification.
    4.  Run `npm run plugin:validate` and `npm test` to confirm full marketplace validation and suite greenness.
-   **Acceptance Criteria**:
    -   `node --test test/guardrails-e2e.test.mjs` exits `0`.
    -   `node scripts/check-bundle-externals.mjs`, `node website/scripts/gen-reference.mjs --check`, `npm run plugin:validate`, and `npm test` all exit `0`.
