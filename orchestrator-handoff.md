# Orchestrator, Hydrogen & `agy 1.5.9` Alignment Specification (`orchestrator-handoff.md`)

- **Document Status:** `SHIP — APPROVED VIA /adversarial-review-loop (EXIT 0, verdict: "approve")`
- **Rollout & SemVer Decision:** **Merge [PR #158](https://github.com/voodootikigod/antigravity-booster/pull/158) (`chore/modernize-agy-1.5.9-adlc-1.13.0`, `HEAD` `6c7d828`) first** as the clean modernization baseline, then ship this specification on a fresh branch (`feat/orchestrator-and-agy-1-5-9-hardening`) in minor release **`v1.3.0`**.
- **ADLC Spec Ticket:** `t-spec-orchestrator-handoff` (converged to `SHIP` in Round 9 via `adversarial-review --provider claude --verify --json`; full evidence ledger stamped in §7).
- **Backward-Compatible Runtime Policy (`lib/doctor.mjs:27`):** Keep hard floor `MIN_AGY_VERSION = '1.2.6'` and add `RECOMMENDED_AGY_VERSION = '1.5.9'` (`warn` + automatic `FRONTIER_NO_ORCHESTRATOR` routing on `1.2.6 <= agy < 1.5.9`; full `1.1.9`–`1.5.9` version-range reconciliation in §3.2 & §4.2) alongside `@adlc/* 1.13.0`.

---

## 1. Executive Summary

A live runtime, Go binary reflection, and changelog audit of `agy 1.1.9`–`1.5.9` and the [Gemini 4 Hydrogen & Orchestrator announcement](https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity/) identified three hardening/optimization tracks for `antigravity-booster` (`agb`), plus explicit boundaries against upstream interactive multi-agent features:

1. **Track 1 — Flag-, Version- & Per-Slug Breaker-Guarded Frontier Routing with Orchestrator (`Carbon` / `Argon`) (`lib/models.mjs`, `lib/scheduler.mjs`, `lib/status.mjs`):**
   - `gemini-pro-orchestrator` (`Orchestrator (Carbon)`) and `gemini-pro-orchestrator-argon` (`Orchestrator (Argon)`) are single-session planner+executor trajectories pairing Carbon/Argon planning & error recovery with `Gemini 4 Hydrogen` execution — **not** multi-agent sub-swarms.
   - Promote `gemini-pro-orchestrator` to index `0` of `TIER_CANDIDATES.frontier` and `claude-sonnet-5-5-high` to index `1`, guarded by `AGB_DISABLE_ORCHESTRATOR=1`, `plan.disableOrchestrator: true`, automatic `< 1.5.9` / `404` model-unavailable demotion, and a **per-slug, per-ticket, builder-fault-only** circuit breaker (`>= 50%` builder-fault tickets across `>= 4` resolved tickets, keyed to `(planHash, agyVersion)`) in `.booster/run.json`. Keep Orchestrator **excluded** from `cheap`, `mid`, `PROSECUTORS`, `PROSECUTOR_CANDIDATES`, and `ROLE_MODELS`.
2. **Track 2 — `PreToolUse` `agy 1.5.9` 59-Tool Taxonomy, Go `fold.go` Key Parity, 348-Case Bracket-Free `sed_file` Subset & `PASSWD_HOME`-Anchored `PLUGIN_DATA` (`hooks/policy/*`, `bin/hook-runner.sh`):**
   - Reconcile `hooks/policy/constants.mjs` against `test/fixtures/agy-1.5.9-init-tools.json` (with live drift detection in `test/live/hooks.live.test.mjs`).
   - Enforce pure printable-ASCII keys + Go `encoding/json` (`fold.go`) duplicate rejection (`ſ`/`K`), strict string-type + unknown-key validation on all 10 required-path read tools, an unconditional 2-production (`d` and length-bounded, bracket/backref-free `s`) `sed_file` subset across **all** 5 context columns, **strict `deny`-on-`ask`/`deny` mapping across all 5 columns** (`0` `ask` verdicts anywhere in §3.5), and `PASSWD_HOME`-anchored audit-log writes enforced via `PLUGIN_ROOT` staging detection.
3. **Track 3 — Unconditional `--disable-slash-commands` (`agy >= 1.2.6`) & 1,440-State Verified Exit-3 / `finished_reason` Classifier (`lib/agy.mjs`, `lib/scheduler.mjs`, `lib/doctor.mjs`):**
   - Pass `--disable-slash-commands` in `runAgy()` (supported since `agy 1.1.9`) and enforce worker-env tagging across all `9/9` `runAgy()` callsites.
   - Implement pure helper `classifyAgyOutcome()` in `lib/agy.mjs` using an explicit known-bad `FAILURE_FINISHED_REASONS` set (preventing future benign upstream `finished_reason` values from breaking builds) and version-gated legacy `< 1.5.0` timeout fallback, paired atomically in `T4` with `lib/scheduler.mjs` handling for every `ALL_AGY_ERROR_KINDS` value.

---

## 2. Track 1: Orchestrator (`Carbon` / `Argon`), Hydrogen & Combined Pool Model

### 2.1 Empirical Upstream Quota Bucket Verification (`agy 1.5.9`)
Live `agy -p /quota --output-format json` on `agy 1.5.9` (`2026-11-15`) returned two quota groups:
1. **`"Gemini Models"`** (`gemini-weekly`, `gemini-5h`): `"Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash"` — shared weekly and 5-hour limits consumed proportionally to token cost (`/quota` schema introduced prior to `1.5.9` and parsed defensively in `lib/pools.mjs` with fallback to `BASE_CAPS` if `/quota` output changes on older `1.2.6`–`1.4.x` binaries).
2. **`"Claude and GPT models"`** (`3p-weekly`, `3p-5h`): `"Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B"`.

**Pool & Family Cap Accounting (`lib/pools.mjs:81-94, 1561-1563` — Zero Edits to `lib/pools.mjs` Required):**
- One `agy -p --model gemini-pro-orchestrator` session runs one model at any instant (Carbon/Argon *or* Hydrogen), occupying 1 `gemini-pro` concurrency slot (`DEFAULT_CAPS = { 'gemini-flash': 8, 'gemini-pro': 4, claude: 4, 'gpt-oss': 2 }`, `BASE_CAPS = { gemini: 12, claude_gpt: 4 }`).
- `familyInFlight('claude_gpt') = totalInFlight('claude') + totalInFlight('gpt-oss')` (`lib/pools.mjs:1562`): `claude` and `gpt-oss` share `familyCap('claude_gpt')` (`<= 4`) and `3p-weekly` / `3p-5h`.

### 2.2 Flag-Guarded `TIER_CANDIDATES.frontier`, Per-Slug Auto-Demotion & `RunStatus.modelStats`
On `HEAD` (`6c7d828`), `PoolSet.route('frontier', 'auto')` already alternates `1:1` between `gemini-pro` and `claude` at `4:4` caps. Update `TIER_CANDIDATES.frontier` to:
```js
frontier: [
  'gemini-pro-orchestrator',       // pool: gemini-pro (cap 4), upstreamPool: gemini
  'claude-sonnet-5-5-high',        // pool: claude     (cap 4), upstreamPool: claude_gpt
  'gemini-pro-orchestrator-argon', // pool: gemini-pro (cap 4), upstreamPool: gemini
  'gemini-4-argon-high',           // pool: gemini-pro (cap 4), upstreamPool: gemini
  'gemini-4-carbon-high',          // pool: gemini-pro (cap 4), upstreamPool: gemini
  'claude-opus-5-5-high',          // pool: claude     (cap 4), upstreamPool: claude_gpt
],
```

**Operational Safety, Resume Semantics & Per-Slug Builder-Fault Breaker:**
1. **Fallback Candidate Order (`FRONTIER_NO_ORCHESTRATOR`) & Resume Re-Evaluation:**
   - Define `FRONTIER_NO_ORCHESTRATOR = ['gemini-4-argon-high', 'claude-sonnet-5-5-high', 'gemini-4-carbon-high', 'claude-opus-5-5-high']`.
   - `agb run` (`lib/scheduler.mjs`) persists only merged commits on `main`; every new or resumed `agb run` invocation re-runs `checkAgyBinary()` and routes unmerged tickets fresh against the live `agy` binary.
   - `tierCandidates('frontier', poolHint, options)` (backed by `setOrchestratorRoutingState({ disableOrchestrator, disabledModels })` / `resetOrchestratorRoutingState()` in `lib/models.mjs` so `PoolSet.prototype.route(tier, poolHint)` in frozen `lib/pools.mjs:1753` honors run-scoped state with zero edits to `lib/pools.mjs`) returns `FRONTIER_NO_ORCHESTRATOR` (filtered by `disabledModels`) when `process.env.AGB_DISABLE_ORCHESTRATOR === '1'`, `disableOrchestrator === true` (`plan.disableOrchestrator === true` or `semverLt(agyCheck.version, '1.5.9')`), logging `[agb] notice: agy ${agyCheck.version} < 1.5.9; Orchestrator slugs auto-disabled`. Otherwise it filters `TIER_CANDIDATES.frontier` by `!disabledModels.has(slug)`, allowing **individual** slug demotion.
2. **Per-Ticket, Per-Slug, Builder-Fault-Only `modelStats` (`lib/status.mjs` + `lib/scheduler.mjs`):**
   - Persisted atomically in `.booster/run.json` via `writeOwnerOnly` (`0o600` `.tmp` + `renameSync` serialized on `this.writePromise`, `lib/status.mjs:20-25, 55`) alongside `statsContext: { planHash, agyVersion }`. On resume, prior `modelStats` are loaded **only** if both `planHash` and `agyCheck.version` match `statsContext`; any plan edit or `agy` upgrade/downgrade resets `modelStats` cleanly to `{}`!
   - **Per-ticket, builder-fault-only accounting (prevents flawed tickets, gate flakes, or awaiting-gate builds from false-tripping):**
     Schema per `modelSlug`: `{ resolvedTickets: number, builderFaultTickets: number, mergedTickets: number, rateLimits: number }`, updated **once when a ticket finishes its attempt on `modelSlug`** (never while a build is still awaiting gates):
     - If `buildOnce` reroutes on `model_unavailable` (`404` / `NOT_FOUND`): add `modelSlug` immediately to `disabledModels` (`0` strikes, `0` `resolvedTickets` increment).
     - If `buildOnce` reroutes on `build.rateLimited === true`: increment `rateLimits += 1` only (does **not** increment `resolvedTickets` or `builderFaultTickets`).
     - When a ticket **merges** on `modelSlug`: increment `resolvedTickets += 1` and `mergedTickets += 1`.
     - When a ticket **exhausts a strike or fails due to a builder execution fault** (`!build.ok` with non-rate-limit `kind` in `['timeout', 'interrupted', 'signal', 'server', 'server_shutdown_error', 'missing_terminal_result', 'empty', 'unclassified']`, or `empty_diff` anti-no-op, counted **at most once per `(ticketId, modelSlug)` pair**): increment `resolvedTickets += 1` and `builderFaultTickets += 1`.
     - **Gate/test failures (`!gates.ok`) and prosecutor rejections (`verdict === 'block'`) increment `resolvedTickets += 1` when the ticket finishes on `modelSlug` without incrementing `builderFaultTickets`**, because test/spec/prosecution failures are ticket-content signals rather than Orchestrator runtime failures!
   - **Per-slug trip condition:** When a specific Orchestrator slug (`m === 'gemini-pro-orchestrator'` or `m === 'gemini-pro-orchestrator-argon'`) reaches **`resolvedTickets >= 4 && builderFaultTickets / resolvedTickets >= 0.5`** (i.e., `>= 2` distinct tickets suffered builder execution faults out of `>= 4` resolved tickets on that exact slug), `scheduler.mjs` logs a warning and adds **only that specific slug `m`** to `disabledModels`!
3. **Deterministic prosecutor FIFO progress (`lib/scheduler.mjs:1681, 1688`):** Builders release their lease in `buildOnce()`'s `finally` (`scheduler.mjs:1681`) **before** `prosecuteBranch()` (`scheduler.mjs:1688`), so even when `4` `claude` builders saturate `familyCap('claude_gpt') = 4`, a waiting `gpt-oss-120b-medium` prosecutor acquires FIFO immediately upon the single next `claude` builder `finally` release (`0` deadlocks).
4. **Measurable Acceptance Criteria for Track 1 (`T5`):**
   - `PoolSet.route('frontier', 'auto')`: 8 reservations at `4/4` -> 4 `gemini-pro-orchestrator` + 4 `claude-sonnet-5-5-high`; 6 at `2/4` -> 2 + 4; with `AGB_DISABLE_ORCHESTRATOR=1`, `plan.disableOrchestrator: true`, or `agy 1.5.8` / `1.5.9-rc.1` -> 4 `gemini-4-argon-high` + 4 `claude-sonnet-5-5-high`.
   - Test per-slug breaker accuracy: (a) 4 tickets failing `npm test` gates on `gemini-pro-orchestrator` yield `builderFaultTickets === 0` (**no** false demotion); (b) 4 distinct tickets where 2 hit builder `timeout`/`empty_diff` on `gemini-pro-orchestrator` demote **only** `gemini-pro-orchestrator` while leaving `gemini-pro-orchestrator-argon` active; (c) upgrading `agyVersion` on resume resets stale `modelStats`.
   - Deterministic 4-Claude Promise-barrier prosecutor FIFO test (`0` deadlocks); Orchestrator excluded from `cheap`, `mid`, `PROSECUTORS`, `PROSECUTOR_CANDIDATES`, `ROLE_MODELS`; `poolOf('hydrogen-custom') === 'gemini-pro'`.

---

## 3. Track 2: `PreToolUse` `agy 1.5.9` Taxonomy, Go Key Parity & `PLUGIN_DATA`

### 3.1 Full 5-Column Context Lattice & Exact Verdict Mapping (Zero `ask` Outputs)
Every rule in `hooks/policy/evaluate.mjs` maps onto the mutually exclusive **5-column context lattice** (`buildContext()`, `evaluate.mjs:633-635, 670-672`):
1. **`ctx.readonly === true`** (`Boolean(env.AGB_WORKER_MODE)`; implies `ctx.headless === true`; **wins if both `AGB_WORKER_MODE` and `AGB_WORKER_TICKET` are set**).
2. **`ctx.workerTicket !== null && !ctx.readonly`** (`Boolean(env.AGB_WORKER_TICKET)` — `agb run` builders; implies `ctx.headless === true`).
3. **`!ctx.headless` in an ADLC repository (`repo.adlc === true`) with `activeRail === true` or `!repo.store.ok`**.
4. **`!ctx.headless` in an ADLC repository (`repo.adlc === true`) with `repo.store.ok === true && activeRail === false`**.
5. **`!ctx.headless` in a Non-ADLC workspace (`repo.adlc === false` across all target paths and workspace anchors; no ticket store exists)**.

**Parent-Process `AGB_WORKER_*` Environment Trust Boundary (`bin/hook-runner.sh:22-24`, `test/live/hooks.live.test.mjs:311-319` V2):**
- `agy` executes `PreToolUse` hooks as direct child processes of the `agy` host process (`V2`), inheriting the environment passed to `spawn(agyBin, ...)` by `lib/agy.mjs`. Tool subshells spawned by the model (`run_command`) run as sibling/descendant processes that **cannot** mutate or strip `AGB_WORKER_TICKET` / `AGB_WORKER_MODE` in the parent `agy` process's environment. A caller that controls the outer environment before launching `agy` already operates outside the `PreToolUse` boundary (`AGB_HOOK_DISABLE` killswitch, `bin/hook-runner.sh:25`).

**Exact Verdict Mapping for Stdin & Kernel Tools (`test/live/hooks.live.test.mjs:354-361` V6):**
Because `V6` proved `"ask"` executes the tool in raw non-TTY `agy -p`, **no evaluator in §3.5 ever emits `"ask"` or maps `"ask"` to `PASS`**:
- **Cols 1, 2 & 3:** `notebook_execution`, non-terminate `send_command_input`, and `manage_task` (`Action: 'send_input'`) return **hard `deny`**.
- **Cols 4 & 5 (`send_command_input` with non-empty `Input` or `Terminate !== true`, and `manage_task` `Action: 'send_input'`):**
  1. In Col 4 (`repo.adlc === true`), if `!repo.store.ok` -> **`deny`**.
  2. Run `stepOne` + `scanPathLike` (`protectedRoots`, `boosterDataRoots`, and in Col 4 `implicitRails`): any hit -> **`deny`**.
  3. Run `shVerdict = evaluateShell({ CommandLine: String(Input ?? ''), Cwd: ctx.workspacePaths[0] }, ctx)`: `shVerdict.decision === 'pass'` -> **`PASS`**; both `'deny'` and `'ask'` -> **`deny`**.
- **Documented Residual Risk in Cols 4–5 (`hooks/policy/shell.mjs:3-8`):** Characters split across sequential `send_command_input` calls into an interactive REPL in Cols 4–5 (`activeRail === false`) share the same Turing-complete boundary as interactive `run_command` `python3`; compensated by Cols 1–3 hard-`deny`, `agb` kernel sandboxing, and merge/CI `adlc rails-guard`.

### 3.2 Verbatim `agy 1.5.9` 59-Tool Snapshot & Reconciled `1.1.9`–`1.5.9` Timeline
- **Upstream Changelog Timeline (Verified via `agy changelog` on `agy 1.5.9`):**
  - `agy 1.1.9`: `--disable-slash-commands` added (supported on 100% of `>= 1.2.6` binaries).
  - `agy 1.2.6` (`MIN_AGY_VERSION`): `--output-format stream-json` added; `finished_reason` and `PLUGIN_DATA` not yet emitted (`finished_reason === undefined`, `PLUGIN_DATA` unset -> `hook-runner.sh` falls back to `${PASSWD_HOME}/.gemini/antigravity-cli/plugin_data/antigravity-booster`; legacy `isAgyTimeout(out)` active when `semverLt(agyVersion, '1.5.0')`).
  - `agy 1.5.0`–`1.5.3`: `finished_reason` (`'print_timeout'`, `'interrupted'`, `'error'`), `[agy] print timeout after <d>` + `AGY_ERROR: {...}` stderr teardown with exit `3`, and hook `PLUGIN_DATA` env export added.
  - `agy 1.5.9` (`RECOMMENDED_AGY_VERSION`): `gemini-pro-orchestrator*`, `gemini-4-hydrogen-*`, and the 59-tool `init.tools` catalog (committed at `test/fixtures/agy-1.5.9-init-tools.json`; offline canary in `test/models-live-catalog.test.mjs`, live drift check in `test/live/hooks.live.test.mjs`). Older `1.2.6`–`1.5.8` hosts that omit `1.5.9`-only tools simply never invoke them, while legacy tool names (`list_directory`, `create_file`, `save_file`, `delete_file`, `file_search`, `code_search`, `read_browser_page`) remain registered in `constants.mjs`.
- **Promote to `READ_ONLY_TOOLS`:** `list_dir`, `list_permissions`, `search_in_file`, `wait`, `wait_5_seconds`.
- **Dedicated mutating / execution evaluators:** `sed_file`, `notebook_edit`, `notebook_execution`, `send_command_input`.

### 3.3 Go `encoding/json/fold.go` Parity & Strict Required-Path Read Schemas
- **`normalizeArgsCaseInsensitive(args)` (`hooks/policy/evaluate.mjs`):**
  1. Non-plain-object (`null`, primitive, `Array`) -> **hard `deny`**.
  2. **Pure Printable-ASCII Key Gate first:** Every key `k` in `Object.keys(args)` MUST match `/^[\x20-\x7E]+$/`; any non-ASCII rune (including Go's `U+017F` `'ſ'` and `U+212A` `'K'`) or control byte -> **hard `deny`** across all 5 columns.
  3. **Go-parity fold (`goFoldKey(k)`):** `k.replace(/\u017f/g, 's').replace(/\u212a/g, 'k').toLowerCase()`. Any two keys colliding under `goFoldKey` -> **hard `deny`** across all 5 columns.
- **Required-Path Read Tools (`extractReadToolPaths` in `stepOne` — all 10 tools: `view_file`, `read_file`, `view_file_outline`, `read_notebook`, `read_browser_page`, `read_url_content`, `list_dir`, `list_directory`, `list_permissions`, `search_in_file`):**
  1. `REQUIRED_READ_PATH_KEYS`: `view_file`/`view_file_outline`: `['absolutepath','filepath','path']`; `read_file`: `['path','absolutepath','filepath']`; `read_notebook`: `['notebookpath','absolutepath','path']`; `read_browser_page`/`read_url_content`: `['url']`; `list_dir`/`list_directory`: `['directorypath','dirabsolutepath','absolutepath','path','dir']`; `list_permissions`: `['paths','path']`; `search_in_file`: `['paths','path','directorypath','searchpath']`.
  2. Every present key in `REQUIRED_READ_PATH_KEYS[name]` MUST hold a non-empty `string` (or non-empty `string[]` of non-empty strings for `paths`) — e.g. `{"AbsolutePath": true, "path": "safe"}` -> **hard `deny`**.
  3. Require `extractedPaths.length >= 1` (`0` -> **hard `deny`**).
  4. Non-path string keys `{ toolaction, toolsummary }` (plus `pattern`/`query` on `search_in_file` and `pageid` on `read_browser_page`) must be strings; any other key with `boolean` or finite `number` value is allowed; any other key with `string`, `Array`, `Object`, or `null` value -> **hard `deny`**.
  5. Run `toPath()` + `boosterDataRoots` on all extracted paths **plus** `scanPathLike(rawArgs)`. Apply `normalizeArgsCaseInsensitive` across all mutating/execution evaluators.

### 3.4 `sed_file` — Length/Backref-Bounded 2-Production Subset & 348-Case Suite
`agy`'s `sed_file` invokes `sed -i` on `target_file`. `evaluateSedFile` gates `target_file` before execution via `stepOne` + `evaluateFileTool` (which resolves symlinks via `physicalResolve` and checks **both** `r.real` and `r.lexical`, blocking symlinked rail/outside-scope targets) and enforces `validateSedCall` unconditionally across **all 5 context columns**:
1. Closed folded keys `{ target_file, targetfile, expressions, file_content, filecontent, toolaction, toolsummary }` (`duplicate` or unknown -> **`deny`**); `file_content` anything other than `undefined`, `null`, or `{}` -> **`deny`**; `target_file` excluded from `SHARD_WRITERS`.
2. `validateSedCall(expressions)`: `1..128` strings (`1..1024` chars each, `!/[\0\r\n]/`, no trimming); each `expr` must match **(A)** `/^(?:[1-9]\d*|\$)(?:,(?:[1-9]\d*|\$))?d$/` or **(B)** optional `/^(?:[1-9]\d*|\$)(?:,(?:[1-9]\d*|\$))?/` + `s` + `delim` (`'/'` or `'|'`), `rest.split(delim)` length `=== 3` (`[pattern, replacement, flags]`), **`1 <= pattern.length <= 256`**, **`replacement.length <= 512`**, **`!/[\[\]]/.test(pattern)` and `!/\\[1-9]/.test(pattern)`** (forbids BRE bracket expressions and backreferences, preventing NP-complete BRE backtracking hangs!), neither `pattern` nor `replacement` ending in an odd backslash run (`!/(?:^|[^\\])(?:\\\\)*\\$/`), and `flags` matching `/^(?:g|[1-9]\d*|p|I|i|m|M)*$/`. *(Note: `&` and `\n` inside `replacement` only reshape substituted text within the already-authorized `target_file` — identical to `replace_file_content` — and cannot execute commands or access external files.)*
3. **Independent-Oracle 348-Case Differential Suite (`test/policy-1-5-9-sed-notebook.test.mjs`):**
   - **324 cartesian cases** (`delims=['/','|',','] (3) × addrs=['','1,5','/re/'] (3) × patterns=['foo','','a[b','[a/b]','a\\','a\\\\'] (6) × replacements=['bar','bar\\','x;e'] (3) × flags=['g','ge'] (2) = 324`): assert `validateSedCall([expr])` matches `(delim === '/' || delim === '|') && (addr === '' || addr === '1,5') && (pattern === 'foo' || pattern === 'a\\\\') && (replacement === 'bar' || replacement === 'x;e') && flag === 'g'` (**exact `16` `ACCEPT`, `308` `DENY`**).
   - **24 verbatim fixed vectors (`6 ACCEPT`, `18 DENY`):**
     - **Expected `ACCEPT` (`6`):** `(1) "1d"`, `(2) "$d"`, `(3) "1,$d"`, `(22) "s/a\\|b/c/g"`, `(23) "s|foo/bar|&\\nbaz|g"` *(exercises `&` and `\n` replacement)*, `(24) "s/foo/bar/2pIm"`.
     - **Expected `DENY` (`18`):** `(4) "0d"`, `(5) "1,2d;3d"`, `(6) "{1d}"`, `(7) "1!d"`, `(8) "e"`, `(9) "e touch pwn"`, `(10) "s/foo/bar/e"`, `(11) "s/foo/bar/w pwn"`, `(12) "s/foo/bar/W pwn"`, `(13) "w pwn"`, `(14) "W pwn"`, `(15) "1r /etc/passwd"`, `(16) "1R /etc/passwd"`, `(17) "F"`, `(18) "z"`, `(19) "s/(a)\\1/b/g"` *(backref denied)*, `(20) "s/foo/bar/\0"`, `(21) "s|a\\|b|c|g"`.
   - Execute all `22` (`16 + 6`) accepted cases via `spawnSync('sed', ['-i', expr, tmpFile], { timeout: 2000 })` (`process.platform === 'linux'` fails hard if GNU `sed` is absent), asserting `status === 0`, `signal === null`, expected file contents, and zero extra files in `tmpDir`.

### 3.5 Complete 5-Column Policy Matrix (Every Cell Returns Strictly `deny` or `PASS`)

| Tool & Case-Insensitive Args | Col 1: `ctx.readonly` | Col 2: `ctx.workerTicket` (Builder) | Col 3: Interactive ADLC (`activeRail` or `!store.ok`) | Col 4: Interactive ADLC (`store.ok && !activeRail`) | Col 5: Interactive Non-ADLC (`!repo.adlc`) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`sed_file`** (`target_file`, `expressions`) | **`deny`** | `evaluateFileTool` (`scope` + rails) **AND** `validateSedCall` (`deny`/`PASS`) | `evaluateFileTool` (rails + shards) **AND** `validateSedCall` (`deny`/`PASS`) | `evaluateFileTool` (implicit rails + shards) **AND** `validateSedCall` (`deny`/`PASS`) | `stepOne` (`protectedRoots`/`boosterDataRoots`) **AND** `validateSedCall` (`deny`/`PASS`) |
| **`notebook_edit`** (`NotebookPath` + `TOOL_CONTENT_KEYS.notebook_edit`) | **`deny`** | `evaluateFileTool` (`scope` + rails; not in `SHARD_WRITERS`) (`deny`/`PASS`) | `evaluateFileTool` (`deny` on rail/implicit rail/missing path, else `PASS`) | `evaluateFileTool` (`deny` on implicit rail/missing path, else `PASS`) | `stepOne` (`deny` on protected/missing path, else `PASS`) |
| **`notebook_execution`** (`NotebookPath`, `CellIDs`) | **`deny`** | **`deny`** | **`deny`** | Step 1 + Gate 1 on `NotebookPath` (`deny` on implicit rail, else `PASS`) | `stepOne` on `NotebookPath` (`deny` on missing/protected, else `PASS`) |
| **`send_command_input`** (`Terminate === true` & empty `Input`) | **`deny`** | **`deny`** | `repo.store.ok ? PASS : deny` | **`PASS`** | **`PASS`** |
| **`send_command_input`** (non-empty `Input` or `Terminate !== true`) | **`deny`** | **`deny`** | **`deny`** | `stepOne` + `scanPathLike` + `evaluateShell(Input)` (`deny` or `ask` -> **`deny`**; `pass` -> **`PASS`**) | `stepOne` + `scanPathLike` + `evaluateShell(Input)` (`deny` or `ask` -> **`deny`**; `pass` -> **`PASS`**) |
| **`manage_task`** (`Action: 'list' \| 'status'`) | **`PASS`** | **`PASS`** | **`PASS`** | **`PASS`** | **`PASS`** |
| **`manage_task`** (`Action: 'kill'`) | **`deny`** | **`deny`** | **`PASS`** | **`PASS`** | **`PASS`** |
| **`manage_task`** (`Action: 'send_input'`) | **`deny`** | **`deny`** | **`deny`** | Same as `send_command_input` (non-empty `Input`) (`deny`/`ask` -> **`deny`**; `pass` -> **`PASS`**) | Same as `send_command_input` (non-empty `Input`) (`deny`/`ask` -> **`deny`**; `pass` -> **`PASS`**) |
| **`manage_task`** (missing or unknown `Action`) | **`deny`** | **`deny`** | **`deny`** | **`deny`** | **`deny`** |
| **`invoke_subagent` / `define_subagent` / `manage_subagents`** | **`deny`** | **`deny`** (`D1`) | `stepOne` + `scanPathLike` (`deny` on rail/protected/`!store.ok`, else `PASS`) | `stepOne` + `scanPathLike` (`deny` on implicit-rail/protected, else `PASS`) | `stepOne` + `scanPathLike` (`deny` on protected roots, else `PASS`) |

### 3.6 `PASSWD_HOME` Audit-Log Enforcement via `PLUGIN_ROOT` Staging Detection
- **Concrete Shell Staging Check (Matches `bin/node-launcher.sh:5-14`, Zero Bundler Constant Needed):**
  1. In `bin/hook-runner.sh`, compute `RUNNER_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"` and `RUNNER_ROOT="$(dirname -- "$RUNNER_DIR")"`.
  2. Resolve OS account home `PASSWD_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"` (or `dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}'` on macOS).
  3. **Production staged plugin (`case "$RUNNER_ROOT" in */.gemini/config/plugins/*)`):** **Unconditionally ignore `AGB_TEST_PASSWD_HOME` and `HOME`**, using strictly `PASSWD_HOME` (falling back to `${RUNNER_ROOT%%/.gemini/*}` verified via `[ -O ... ]` only if `getent`/`dscl` is absent). Only when `RUNNER_ROOT` is **outside** `*/.gemini/config/plugins/*` **and** `[ -f "$RUNNER_ROOT/test/hook-runner.test.mjs" ]` (an unbundled source checkout during `npm test`) may `AGB_TEST_PASSWD_HOME` redirect the test log into `mkdtempSync` — verified by an explicit test in `test/hook-runner.test.mjs` staging `bin/hook-runner.sh` into `<tmp>/.gemini/config/plugins/antigravity-booster/bin/hook-runner.sh` and asserting `AGB_TEST_PASSWD_HOME` is ignored!
- **4-Canonical-Root Allowlist & Fail-Closed Degradation:**
  1. `paths.mjs` protects canonical roots across both `os.userInfo().homedir` and `env.HOME` (`ctx.homes`). `bin/hook-runner.sh` accepts `env.PLUGIN_DATA` **iff** its physical path (with non-symlink leaf `[ ! -L ]`) equals one of the 4 canonical roots (`~/.gemini/{antigravity-cli,antigravity,antigravity-ide}/plugin_data/antigravity-booster` or `~/.config/antigravity-booster`) under `PASSWD_HOME`.
  2. Atomic log init via `umask 0077`, symlink/UID integrity checks (`LOG_TAMPERED=1` if `[ -L "$HOOK_LOG_DIR" ] || [ -L "$HOOK_LOG_FILE" ] || ( [ -e "$HOOK_LOG_DIR" ] && [ ! -O "$HOOK_LOG_DIR" ] ) || ( [ -e "$HOOK_LOG_FILE" ] && [ ! -O "$HOOK_LOG_FILE" ] )`), and `( set -C; : >"$HOOK_LOG_FILE" )` when creating a new log file. On **`LOG_TAMPERED=1`** (symlink or foreign-UID log path): write `0600` `${PASSWD_HOME}/.gemini/antigravity-cli/.agb-hook-log-degraded` (checked by `checkHookLogDir()` in `lib/doctor.mjs`), emit `stderr` warning, and in headless workers immediately emit `{"decision":"deny","reason":"agb hook audit log tampered in headless worker"}` and `exit 0`. On **`LOG_DEGRADED=1` without tampering** (e.g., `bwrap` `--ro-bind` read-only `$HOME/.gemini` in `lib/agy.mjs:689` and `test/hook-runner.test.mjs:689-707`): fall back to `HOOK_LOG_FILE="/dev/null"`, best-effort write `.agb-hook-log-degraded` when writable, append ` [audit-log-degraded]` on fallback JSON `reason`s, and allow normal child policy evaluation to proceed so `bwrap` read-only mounts continue working.

---

## 4. Track 3: Headless `agy` Print-Mode & Scheduler Hardening (`lib/agy.mjs`, `lib/scheduler.mjs`)

### 4.1 Worker Env Invariant & Unconditional `--disable-slash-commands`
- **`/quota` (`1` site):** `lib/pools.mjs:1306` calls `execFileP` directly — never `runAgy()`.
- **All `9` `runAgy()` callers:** `lib/scheduler.mjs:1646` sets `worker: { ticket }`; `lib/prosecute.mjs:83` and `lib/review.mjs:148` set `AGB_WORKER_MODE: 'readonly'`; update `lib/plan.mjs:406,516,547`, `lib/preflight.mjs:162`, `lib/brain.mjs:163`, and `bin/agb.mjs:346` to pass `AGB_WORKER_MODE: 'readonly'`.
- **`--disable-slash-commands`:** Supported since `agy 1.1.9` (`< MIN_AGY_VERSION = '1.2.6'`); `runAgy()` appends `'--disable-slash-commands'` whenever `disableSlashCommands !== false`. `test/fixtures/fake-agy` accepts `--disable-slash-commands` and exits `2` on unknown `--*` flags.

### 4.2 Known-Bad `FAILURE_FINISHED_REASONS` & 1,440-State `classifyAgyOutcome()`
Pre-computed inputs passed to pure exported helper `classifyAgyOutcome(...)` in `lib/agy.mjs`:
- `terminalResult` (`stream-json`) & `envelope` (`json` pre-parse `{ jsonValid, envelope, schemaErrorKind }`) normalized upfront.
- **Explicit known-bad `FAILURE_FINISHED_REASONS` (forward-compatible with future benign upstream reasons like `'completed'`):**
  Instead of rejecting unknown `finished_reason` strings when `code === 0 && status === 'SUCCESS'`, Row 4 matches `'print_timeout'`, Row 5 matches `'interrupted'`, and Row 6 matches **`FAILURE_FINISHED_REASONS = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled', 'max_tokens', 'length', 'safety', 'recitation'])`**! Any future benign completion string (`'stop'`, `'end_turn'`, `'completed'`, `undefined`, etc.) falls through cleanly and succeeds **only** if `code === 0` and `status === 'SUCCESS'` (`exit_code === 0`) / valid `json` / non-empty `text` in Row 13!
- **Version-reconciled timeout & stderr helpers (`1.2.6`–`1.5.9`):**
  - `lastErrLine`: last non-empty `\r?\n`-trimmed line of `err` when `typeof code === 'number' && code !== 0`, else `''`.
  - `isPrintTimeout`: `finishedReason === 'print_timeout'` **OR** (`!terminalResult && !envelope && code === 3 && /^\[agy\] print timeout after \d+/.test(lastErrLine)`) **OR** (`outputFormat === 'text' && legacyPre150 && isAgyTimeout(out)` — preserving existing `lib/agy.mjs:1220` `text`-mode timeout detection for `1.2.6 <= agy < 1.5.0` where `finished_reason` did not yet exist, while never scanning `out` on `stream-json`, `json`, or `agy >= 1.5.0`).
  - `extractLastAgyError(code, lastErrLine)`: when `typeof code === 'number' && code !== 0`, match `/^AGY_ERROR:\s*(\{[^\r\n]{1,4096}\})$/` on `lastErrLine` only and return parsed plain object or `null`.
  - `isModelUnavailableError(e, errText)`: `e?.code === 404 || e?.httpStatus === 404 || e?.status === 'NOT_FOUND' || /unknown model|model.*not (?:found|available)/i.test(errText)`.
  - `detectRateLimit({ code, lastErrLine, terminalResult, envelope })`: checks structured `e` (`429` / `'RESOURCE_EXHAUSTED'` -> `true`, any other structured status -> `false`), else regex `/\b429\b|RESOURCE_EXHAUSTED|rate[ _-]?limit(?:ed)?|quota exceeded/i` against `terminalResult?.error ?? envelope?.error ?? (code !== 0 ? lastErrLine : '')`.

| Row | Sequential `if / else if` Branch (Evaluated only when Rows `1..Row-1` are `false`) | `ok` | `kind` (`ALL_AGY_ERROR_KINDS`) | `rateLimited` | `lib/scheduler.mjs` Handling (Shipped Atomically in `T4`) |
| :---: | :--- | :---: | :--- | :---: | :--- |
| **1** | `killReason != null` | `false` | `killReason.kind` | `false` | `stream_*` -> `strikes = 2, throw` (`1933`); `timeout` -> `strikes += 1`, `safeResetToBase()`, skip `recordStrikeSession()`. |
| **2** | `spawnError != null \|\| (code === null && signal === null)` | `false` | `'spawn'` | `false` | `strikes += 1`, `safeResetToBase()`, skip `recordStrikeSession()`. |
| **3** | `code === null` *(Row 2 false => `signal !== null`: external OS signal)* | `false` | `'signal'` | `false` | `strikes += 1`, `safeResetToBase()`, skip `recordStrikeSession()` (never `'cli'`). |
| **4** | `isPrintTimeout` | `false` | `'timeout'` | `false` | `strikes += 1`, `safeResetToBase()`, skip `recordStrikeSession()`. |
| **5** | `finishedReason === 'interrupted'` | `false` | `'interrupted'` | `false` | `strikes += 1`, `safeResetToBase()`, skip `recordStrikeSession()`. |
| **6** | `FAILURE_FINISHED_REASONS.has(String(finishedReason ?? '').toLowerCase())` **OR** (`outputFormat === 'stream-json' && terminalResult != null && (terminalResult.status !== 'SUCCESS' \|\| terminalResult.exit_code !== 0))` **OR** (`outputFormat === 'json' && envelope != null && ['error', 'failed'].includes(String(envelope.status ?? '').toLowerCase()))` | `false` | `isModelUnavailable ? 'model_unavailable' : (outputFormat === 'json' ? 'envelope_error' : 'server')` | `detectRateLimit(...)` | `'model_unavailable'` -> add to `disabledModels`, reroute (`0` strikes); else `refreshQuota()`, cross-pool reroute iff depleted or `rateLimited && strikes < 2` (clearing `lastConversationId`/`lastStrikeModel`), else `strikes += 1`, `safeResetToBase()`. |
| **7** | `outputFormat === 'stream-json' && terminalResult != null && code !== 0` *(post-`SUCCESS` non-zero teardown crash)* | `false` | `'server_shutdown_error'` | `false` | `strikes += 1`, `safeResetToBase()`. |
| **8** | `outputFormat === 'stream-json' && terminalResult == null && code !== 0` | `false` | `lastAgyErr ? (isModelUnavailable ? 'model_unavailable' : 'server') : 'cli'` | `detectRateLimit(...)` | `'model_unavailable'` / `'server'` -> Row 6; `'cli'` -> `fleetCliFailures += 1, strikes += 1` (`1962`). |
| **9** | `outputFormat === 'stream-json' && terminalResult == null` *(`code === 0`)* | `false` | `'missing_terminal_result'` | `false` | `strikes += 1`, `safeResetToBase()`. |
| **10** | `outputFormat !== 'stream-json' && code !== 0` | `false` | `isModelUnavailable ? 'model_unavailable' : 'server'` | `detectRateLimit(...)` | Same as Row 6. |
| **11** | `outputFormat === 'json' && (!jsonValid \|\| schemaErrorKind != null)` *(`code === 0`)* | `false` | `schemaErrorKind ?? 'schema_violation'` | `false` | Existing `lib/agy.mjs:1260-1331`. |
| **12** | `outputFormat === 'text' && out.trim().length === 0` *(`code === 0`)* | `false` | `'empty'` | `false` | Existing `lib/agy.mjs:1233-1236`. |
| **13** | `outputFormat === 'stream-json' \|\| outputFormat === 'json' \|\| outputFormat === 'text'` *(`code === 0`, valid output)* | `true` | `null` | `false` | Proceeds to scope, anti-no-op, test, hollow-test, and prosecution gates. |
| **14** | **Defensive Final `else`** *(unknown `outputFormat`)* | `false` | `'unclassified'` | `false` | Fail-closed (`strikes += 1`, `safeResetToBase()`, no reroute). |

**Independent 14-Vector Golden Oracle + 1,440-State Totality Suite (`test/agy-1-5-9-print.test.mjs`, `T4`):**
- Assert exact `{ ok, kind, rateLimited }` on 14 canonical hand-authored fixtures (1 per Row `1..14`, plus `'completed'` future-benign `finished_reason` with `code: 0, status: 'SUCCESS'` -> `ok: true` and `'max_tokens'` -> `ok: false, kind: 'server'`), plus the `1,440`-state cross-product (`3 outputFormats × 2 killReasons × 4 [code,signal] pairs [[0,null],[1,null],[3,null],[null,'SIGKILL']] × 5 result states × 4 finishedReasons [undefined,'completed','print_timeout','max_tokens'] × 3 lastErrLines = 1,440` states, Rows `1..13` each hit `>= 1` time).

### 4.3 Empirical Rejection of `--mode plan` and `--mode auto`
Live on `agy 1.5.9`: `--mode plan` + `--disable-slash-commands` warns `--mode plan has no effect while slash command expansion is disabled`; `--mode auto` warns `--mode auto is not available because the terminal sandbox is not available on this host`. `agb` retains `AGB_WORKER_MODE=readonly` + `PreToolUse` and outer kernel sandboxing (`bwrap` / `sandbox-exec` / AppContainer) + `--sandbox`.

---

## 5. Explicit Non-Goals & Deferred Backlog

- **Do NOT replace `agb` with `/swarm`, `run_workflow`, or `Stop` hooks:** `/swarm` uses a single coordinator model without ADLC rails, dual-pool scheduling, or serialized merge rollback; `run_workflow` limits `model` to 4 Gemini tiers with fail-fast `parallel()`; `Stop` hooks duplicate `scheduler.mjs` post-exit gates.
- **Deferred:** `usage` (`cache_read_tokens`) Sidecar UI display; per-ticket `--effort`; persistent `--input-format stream-json` warm-turn benchmarking.

---

## 6. 5-Ticket ADLC Pipeline, Golden Cross-Column Matrix & Scope Table

Execute sequentially (`T1 -> T2 -> T3 -> T4 -> T5`) on `feat/orchestrator-and-agy-1-5-9-hardening` **after PR #158 merges**:
1. **Wave-Wide Frozen `rails` (`(⋃ rails) ∩ (⋃ scope) = ∅`):** Every ticket declares **`W_RAILS = ["lib/lock.mjs", "lib/gates.mjs", "lib/pools.mjs", "lib/merge.mjs", "bin/node-launcher.sh", ".github/workflows/**"]`**.
2. **End-to-End Cross-Column Golden Regression Suite Across Shared Source Edits:**
   - Every dedicated test file exercises full public entrypoints (`evaluate()` across all 5 context columns in `T1`–`T3`, and `runPlan()` / `scheduler.mjs` in `T4`–`T5`), is omitted from all subsequent tickets' `scope` (`PreToolUse` + `verifyScopeAndAntiNoOp` forbid edits), and runs mandatorily via full `npm test` + `adlc hollow-test --test-cmd "npm test" --base main` (`0` survivors) on every ticket.

| Ticket ID | `edges` | Exact `scope` (`scope ∩ W_RAILS = ∅`) | `rails` |
| :--- | :--- | :--- | :--- |
| **`T1`: `t-policy-1-5-9-readonly-and-plugin-data`** | `[]` | `hooks/policy/constants.mjs`, `hooks/policy/evaluate.mjs`, `hooks/policy/paths.mjs`, `bin/hook-runner.sh`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/fixtures/agy-1.5.9-init-tools.json`, `test/pre-tool-use.test.mjs`, `test/policy-1-5-9-readonly.test.mjs`, `test/hook-runner.test.mjs` | `W_RAILS` |
| **`T2`: `t-policy-1-5-9-sed-and-notebook`** | `["t-policy-1-5-9-readonly-and-plugin-data"]` | `hooks/policy/constants.mjs`, `hooks/policy/evaluate.mjs`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/policy-1-5-9-sed-notebook.test.mjs` | `W_RAILS` |
| **`T3`: `t-policy-1-5-9-stdin-and-subagents`** | `["t-policy-1-5-9-sed-and-notebook"]` | `hooks/policy/constants.mjs`, `hooks/policy/evaluate.mjs`, `dist/hooks/pre-tool-use.bundle.mjs`, `test/policy-1-5-9-stdin-subagents.test.mjs`, `test/plugin-layout.test.mjs` | `W_RAILS` |
| **`T4`: `t-agy-print-hardening-1-5-9`** | `["t-policy-1-5-9-stdin-and-subagents"]` | `lib/agy.mjs`, `lib/scheduler.mjs`, `lib/doctor.mjs`, `lib/plan.mjs`, `lib/preflight.mjs`, `lib/brain.mjs`, `lib/prosecute.mjs`, `lib/review.mjs`, `bin/agb.mjs`, `test/fixtures/fake-agy`, `test/agy-1-5-9-print.test.mjs`, `test/doctor.test.mjs` | `W_RAILS` |
| **`T5`: `t-orchestrator-builder-routing`** | `["t-agy-print-hardening-1-5-9"]` | `lib/models.mjs`, `lib/scheduler.mjs`, `lib/status.mjs`, `test/models-live-catalog.test.mjs`, `test/models-registry.test.mjs`, `test/orchestrator-routing.test.mjs`, `test/live/hooks.live.test.mjs`, `docs/guidelines.md`, `USAGE.md`, `CHANGELOG.md`, `website/generated/**` | `W_RAILS` |

### Per-Ticket Deliverables & Rollback
1. **`T1`:** Commit `test/fixtures/agy-1.5.9-init-tools.json`; `normalizeArgsCaseInsensitive` + `goFoldKey` + §3.3 strict `extractReadToolPaths`; promote `list_dir`, `list_permissions`, `search_in_file`, `wait`, `wait_5_seconds`; §3.6 `RUNNER_ROOT`-gated `PASSWD_HOME` audit-log writes (including staged `.gemini/config/plugins/` test asserting `AGB_TEST_PASSWD_HOME` is ignored), `set -C` log init, `.agb-hook-log-degraded`, fail-closed headless worker denial, and 5-column baseline golden matrix; full `npm test`, `npm run build:hooks`, `npm run plugin:validate`, `adlc hollow-test`. Rollback: `git revert <sha>`.
2. **`T2`:** §3.4 `evaluateSedFile` + `validateSedCall` (length/backref-bounded 2-production subset, 5-column `evaluate()` matrix, 324 cartesian `16 ACCEPT / 308 DENY` + 24 pinned `6 ACCEPT / 18 DENY` GNU `sed` `{ timeout: 2000 }` differential suite); `notebook_edit` + `notebook_execution` (`Col 3 -> deny`); full `npm test`, `npm run build:hooks`, `npm run plugin:validate`, `adlc hollow-test`. Rollback: `git revert <sha>`.
3. **`T3`:** §3.5 strict `deny`/`PASS` 5-column `evaluate()` matrix for `send_command_input`, `manage_task`, and subagent tools (`ask -> deny` in Cols 4–5); non-mutating `mkdtempSync` `esbuild` bundle-freshness test in `test/plugin-layout.test.mjs`; full `npm test`, `npm run build:hooks`, `npm run plugin:validate`, `adlc hollow-test`. Rollback: `git revert <sha>`.
4. **`T4`:** `RECOMMENDED_AGY_VERSION = '1.5.9'` (`MIN_AGY_VERSION = '1.2.6'`) + `checkHookLogDir()` in `lib/doctor.mjs`; unconditional `'--disable-slash-commands'` + unknown-`--*`-flag `exit 2` in `fake-agy`; worker env across all `9/9` `runAgy()` callsites; `BRAIN_PLAN_SCHEMA` optional `disableOrchestrator`; §4.2 `classifyAgyOutcome()` (`FAILURE_FINISHED_REASONS` + `< 1.5.0` legacy `text` fallback) + `ALL_AGY_ERROR_KINDS` atomically with `lib/scheduler.mjs` (`14`-vector golden oracle + `1,440`-state totality + end-to-end scheduler tests); full `npm test`, `adlc hollow-test`. Rollback: `git revert <sha>`.
5. **`T5`:** Interleaved `TIER_CANDIDATES.frontier` + `FRONTIER_NO_ORCHESTRATOR`, `(planHash, agyVersion)`-scoped `RunStatus.state.modelStats` + per-slug, per-ticket builder-fault-only breaker (`>= 50%` over `>= 4` resolved tickets), 4-Claude Promise-barrier prosecutor FIFO test, offline + `AGB_LIVE_AGY=1` 59-tool canary & live Orchestrator smoke test, and `USAGE.md` / `docs/guidelines.md` / `CHANGELOG.md` updates; full `npm test`, `npm run docs:check`, `adlc hollow-test`. Rollback: `AGB_DISABLE_ORCHESTRATOR=1` or `plan.disableOrchestrator: true`, or `git revert <sha>`.

---

## 7. Adversarial Review Loop Audit Trail (`t-spec-orchestrator-handoff`)

Cross-family adversarial review executed via `adversarial-review --provider claude --verify --json`:

| Round | Mode | Gating Findings (`>= 0.5`) | Non-Gating (`< 0.5`) | Disposition |
| :---: | :--- | :---: | :---: | :--- |
| **1** | `--input` | 7 (`4 high`, `3 medium`) | 2 | Remediated (`sed` whitelist, `manage_task`/`invoke_subagent` worker `deny`, `/quota` live probe, 5-ticket split). |
| **2** | `--input` | 8 (`2 high`, `6 medium`) | 1 | Remediated (case-insensitive keys, unconditional 5-col `sed`, `Terminate: true` worker `deny`, `rateLimited` detector, `T5` scope). |
| **3** | `--input --verify` | 3 (`3 high`) | 6 | Remediated (Go `fold.go` `ſ`/`K` + ASCII key gate, total precedence table, non-overlapping wave rails). |
| **4** | `--input --verify` | 6 (`4 high`, `2 medium`) | 3 | Remediated (serialized `T1..T5`, Col 3 zero-`ask` stdin `deny`, `signal !== null` row, `AGB_DISABLE_ORCHESTRATOR`). |
| **5** | `--input --verify` | 4 (`3 high`, `1 medium`) | 2 | Remediated (atomic `T4` `agy.mjs`+`scheduler.mjs`, Cols 4–5 `evaluateShell` parity, `W_RAILS` + dedicated test files). |
| **6** | `--input --verify` | 5 (`4 high`, `1 medium`) | 1 | Remediated (`1,440`-state arithmetic, all 24 `sed` vectors enumerated, SemVer-minor `1.2.6` + `RECOMMENDED 1.5.9`, `RunStatus.modelStats`). |
| **7** | `--input --verify` | 4 (`3 high`, `1 medium`) | 2 | Remediated (`ask -> deny` in Cols 4–5, `PASSWD_HOME` anchoring, independent `sed` & classifier oracles, auto-demotion). |
| **8** | `working-tree --verify` | 4 (`0 high`, `4 medium`) | 1 (`low`) | Remediated (`RUNNER_ROOT` staging gate for `PASSWD_HOME`, per-slug/per-ticket builder-fault-only breaker keyed to `(planHash, agyVersion)`, `FAILURE_FINISHED_REASONS` deny-list, `1.1.9`–`1.5.9` timeline, `sed` backref/length bounds, and §7 ledger). |
| **9** | `working-tree --verify` | **0** (`EXIT_CODE=0`, `verdict: "approve"`) | 3 (`< 0.5` effective) | **`SHIP` (`verdict: "approve"`, exit `0`).** 0 gating findings; 1 `noise` (`82f5746eecb1015e`) and 2 `accepted_tradeoffs` / implementation guardrails (`f202a6062a8e2da3`, `5c5d1227c6cb5199`) logged below. |

### Round 9 Non-Gating Triage & Implementation Guardrails
- **`82f5746eecb1015e` (`noise`, refutation-halved to `0.275 < 0.50`):** §6 (`T5` deliverable 5) already assigns `test/live/hooks.live.test.mjs` (both the `AGB_LIVE_AGY=1` live 59-tool drift canary and live Orchestrator smoke test) to `T5`, while `T1` commits the offline `test/fixtures/agy-1.5.9-init-tools.json` snapshot.
- **`f202a6062a8e2da3` (`tradeoff`, `0.45 < 0.50` — `T4` Implementation Guardrail):** Require structured `404` / `NOT_FOUND` (or an `AGY_ERROR` message explicitly naming the requested `modelSlug`) before permanent `disabledModels` demotion; treat loose text regex matches as ordinary strikes so unrelated file-not-found messages (`model.json`) never disable a healthy slug.
- **`5c5d1227c6cb5199` (`tradeoff`, `0.40 < 0.50` — `T4` Implementation Guardrail):** Row 7 intentionally fails closed (`safeResetToBase()`) when `agy` exits non-zero after `SUCCESS` to avoid merging partially flushed worktrees; in `T4`, scan a bounded reverse tail (last `16` non-empty lines) of `stderr` when `code !== 0` so trailing Go shutdown notices cannot mask `AGY_ERROR:` or `[agy] print timeout`.

### Consolidated ADLC P6 `loop_summary` Evidence Event (Single-Line NDJSON)
```json
{"type": "loop_summary", "iterations": 9, "verdict": "approve", "exit_reason": "clean", "baseline_test_status": "passing", "resolved_findings_count": 58, "accepted_tradeoffs_count": 2, "surviving_findings_count": 0, "fingerprints": {"resolved": ["5c5b35f99e8cab68", "f4376aea11eeb9a3", "dc79ab69c17a695a", "8360583d86c85368", "8f227c1b676e3e65", "0617f0a8e04a1a1d", "d0b3f246971759e3", "37feecb03eabb8d2", "672d469789bff2b5", "96c3ca444abaa7b3", "ac753cc5cb38d292", "686d87896418d715", "7f146922e4e14c01", "96dc96fac5701ca8", "22013e90f3b3eb18", "1e412527b7edf7c1", "4b8f857e40ed3800", "a9976c3218255b93", "0cd8f4e8d5d68551", "f80e5a2aa9b519a4", "050c90d67c47541b", "24f9e861234e4cc8", "b3af8966778b8ddd", "e5ab05dd473773f0", "97b5606eb9e5fad4", "144f3bd5c14a4a34", "366968a7e0c89116", "d9564e8605d6d33b", "8f4de8a671ab2d99", "93f2cabf0e8fabca", "118e0285ccc9fcdc", "c7ba64450138b182", "59d280355d6e01e8", "471d66507b3dc9d1", "cf880c4166b2af99", "a66e07f32c5f0fd8", "1c09ec8258718f70", "3e5e60f3e76afca8", "91e1f615d4471b73", "1048d468c0cda15c", "218d6b45ac8608c2", "0c94fb6dbbbedb2f", "9091b9d1d07df3bc", "283c69d53a23b8e4", "cc2c661aec4a7b63", "3e66910153852c14", "e475cb1b8c71901e", "85bfb3e323323bf7", "931901ea38fd8575", "43660eb0ed30d798", "12ceef0627360b80", "129dbfdc968a200e", "515384696569ea0e", "559e5739d784e01a", "a85bb25691037fe2", "a54a9b79a375bf87", "726c26ca5b085ff6", "45b547226b66e142"], "accepted_tradeoffs": ["f202a6062a8e2da3", "5c5d1227c6cb5199"]}, "tradeoffs": [{"fingerprint": "f202a6062a8e2da3", "category": "correctness", "title": "Loose model-unavailable regex can permanently disable a healthy model", "justification": "Non-gating (confidence 0.45 < 0.50); T4 implementation guardrail: require structured 404/NOT_FOUND or slug-specific AGY_ERROR message for permanent disabledModels demotion and treat loose text matches as ordinary strikes."}, {"fingerprint": "5c5d1227c6cb5199", "category": "correctness", "title": "Classifier reads only the last stderr line and discards successful builds on teardown exit", "justification": "Non-gating (confidence 0.40 < 0.50); Row 7 intentionally fails closed on non-zero exit after SUCCESS to avoid committing partially flushed worktrees, and T4 scans a bounded reverse tail (last 16 non-empty lines) of stderr for AGY_ERROR/print-timeout."}]}
```
