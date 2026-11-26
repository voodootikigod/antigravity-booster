# Post-Merge Handoff: Native Antigravity Guardrails (`v2.0.0`)

This handoff captures everything remaining **after PR #202 (`feat(v2): adopt native Antigravity >= 1.5.17 verification and guardrails`) merges into `main`**, so a new session can pick up immediately with zero context loss.

---

## 0. What Landed in PR #202 (Completed)

All 9 tickets in `specs/native-agy-guardrails-spec.md` (`T-GUARD-0B` through `T-GUARD-6`), the 5-lens Code Adversarial Review Loop fixes (`T-GUARD-ARL-FIXES`), and the convergence merge with PR #201 (`origin/main`, Waves 2-4 + release-audit fixes) are complete:

- **Hard `agy >= 1.5.17` baseline (`T-GUARD-0B`):** `MIN_AGY_VERSION = '1.5.17'`, `RECOMMENDED_AGY_VERSION = '1.5.17'`, pruned all `< 1.5.17` compatibility shims across `lib/doctor.mjs`, `lib/ndjson-worker.mjs`, `lib/scheduler.mjs`, and docs/evals.
- **Native `PreToolUse` `force_ask` & `ask_permission` (`T-GUARD-1A`, `T-GUARD-1B`):**
  - Precedence Lattice: `deny > force_ask > ask > pass` (strictly preserving Appendix A D7: never emitting `"allow"`, `"auto_approve"`, or `overwrite`).
  - Interactive sessions escalate ambiguous shell syntax (`$VAR`, `${VAR}`, backticks, `$()`, eval/source, git-dir flags, `rm -r`, credentialed `curl`/`wget`) and out-of-workspace file mutations (`edit`, `write`, `delete`, `move`, `execute`) to `force_ask` so `--yolo` / `auto_approve` cannot silently auto-run them; headless workers (`AGB_WORKER_TICKET` / `AGB_WORKER_MODE`) still hard-`deny`.
  - Protected `.adlc/**` and `.booster/**` data roots inside OR across workspaces remain unconditionally `deny`.
- **Native `--settings` `action(target)` profiles (`T-GUARD-2`):** `lib/role-settings.mjs` emits `{ allowNonWorkspaceAccess: false, permissions: { deny: [...] } }` with defense-in-depth `edit(rail)` / `write(rail)` / `delete(rail)` rules for active ticket rails alongside `bwrap` + `adlc rails-guard`.
- **Interactive CLI Settings Audit (`T-GUARD-3`) & SessionStart Advisory (`T-GUARD-4`):** `checkCliSettings()` in `agb doctor` audits `~/.gemini/antigravity-cli/settings.json` for `allowNonWorkspaceAccess`, missing sensitive denies, and dangerous `permissions.allow` wildcards; `hooks/session-start.mjs` surfaces a once-per-session `additionalContext` warning when `allowNonWorkspaceAccess === true`.
- **Mandatory `NdjsonWorkerDaemon` Builder Containment (`T-GUARD-5A`, `T-GUARD-5B`):** Shared `prepareBuilderContainment()` + `buildSpawnEnv()` between `runAgy()` and `NdjsonWorkerDaemon` (including Dark-Factory `holdouts` tmpfs masking inside `bwrap` from PR #201).

---

## 1. Workstream 1 — Sync Local Checkout, Clean Worktree & Re-Bootstrap Host Plugin

Once PR #202 is merged on GitHub, sync the primary checkout, remove the feature worktree, update the locally installed Antigravity plugin (`~/.gemini/config/plugins/antigravity-booster`), and verify `agb doctor` on the live host.

### Exact Commands
```sh
cd /home/voodootikigod/Projects/voodootikigod/antigravity-booster
git checkout main
git pull --ff-only origin main

# Remove the merged feature worktree and prune stale refs
git worktree remove .worktrees/verification-and-guardrails
git worktree prune
git fetch --prune origin

# Archive the completed PR #202 tickets from .adlc/tickets/ into .adlc/ticket-archive/
# in forward topological order (sources before targets so no inbound edges remain)
for id in T-GUARD-0 T-GUARD-0B T-GUARD-3 T-GUARD-2 T-GUARD-1A T-GUARD-1B T-GUARD-4 T-GUARD-5A T-GUARD-5B T-GUARD-6 T-GUARD-FINAL-SYNC T-GUARD-ARL-FIXES T-GUARD-MERGE-MAIN; do
  npx --no-install adlc ticket archive "$id" --write --authorize --allow-unsigned
done
npx --no-install adlc ticket doctor --archive

# Re-install / update the local Antigravity plugin from main and re-bootstrap
agy plugin install /home/voodootikigod/Projects/voodootikigod/antigravity-booster
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
agb doctor
```

### Expected Verification
- `agb doctor` reports `pass` (or actionable `warn` if user `~/.gemini/antigravity-cli/settings.json` has `allowNonWorkspaceAccess: true`) on:
  - `agy binary` (`>= 1.5.17`)
  - `CLI settings` (`checkCliSettings`)
  - `Policy guard` (self-tests `deny` AND interactive `force_ask` round-trip)
  - `Companion plugin` (`adlc-antigravity` contract `1`)

---

## 2. Workstream 2 — Upstream `adlc` Repository Follow-Ups (Cross-Repo)

PR #202 intentionally kept changes scoped to `antigravity-booster` without forking vendored ADLC artifacts (`AGENTS.md` rule: never hand-edit `vendor/cache/adlc-antigravity-*.tgz`). Two upstream improvements in the sibling/upstream `adlc` repository (`https://github.com/voodootikigod/adlc`) will pay down cross-repo workarounds:

1. **`@adlc/hollow-test` — Native Generated-Bundle Exclusion (`--exclude-glob`):**
   - **Current state in `antigravity-booster`:** `lib/prosecute.mjs` and `lib/scheduler.mjs` pass `'--test-glob', 'dist/**'` because `@adlc/hollow-test` (`lib/targets.mjs`) uses `--test-glob` as its non-mutable file exclusion list, and otherwise attempts to mutate thousands of lines inside esbuild-generated `dist/*.mjs` bundles (causing 300s timeouts and dead-code bundle survivors).
   - **Upstream change in `adlc`:** Add a dedicated `--exclude-glob <glob>` flag (and default-exclude `dist/**`, `build/**`, `*.bundle.mjs`, `*.min.js`) in `@adlc/hollow-test`, then update `lib/prosecute.mjs` and `lib/scheduler.mjs` to use `--exclude-glob 'dist/**'`.
2. **`@adlc/antigravity` Companion Plugin — `agy >= 1.5.17` Guardrail Doctrine Alignment:**
   - **Upstream change in `adlc/plugins/adlc-antigravity`:** Update companion skills (`adlc-doctrine`, `adlc-prosecutor`, `adlc`) to document Antigravity `>= 1.5.17` `PreToolUse` `force_ask` escalations (`--yolo` boundary), `ask_permission` interception, and `action(target)` `--settings` permission rules.
   - **Sync back into `antigravity-booster` after publishing `@adlc/core` / `@adlc/antigravity`:**
     ```sh
     npm install @adlc/core@latest @adlc/antigravity@latest
     npm pack @adlc/antigravity@$(node -p "require('./package.json').dependencies['@adlc/antigravity']") --pack-destination vendor/cache
     node scripts/update-adlc-digests.mjs
     npm run build && npm test
     ```

---

## 3. Workstream 3 — Optional Post-Merge Hardening Polish (In `antigravity-booster`)

During the 5-lens Code Adversarial Review Loop on PR #202, three non-blocking defense-in-depth improvements were identified and deferred to avoid unnecessary churn across frozen ticket test expectations:

1. **Expand Default `readonly` / `builder` Denies in `lib/role-settings.mjs`:**
   - Add `'download_url(*)'` and `'unsandboxed(*)'` to the base `readonly` and `builder` `permissions.deny` arrays in `lib/role-settings.mjs` so headless prosecutors, reviewers, and builders cannot invoke `download_url` or request `unsandboxed` tool execution via Antigravity's native permission engine.
   - Update exact-array assertions in `test/role-settings.test.mjs` and `test/ndjson-worker.test.mjs`.
2. **Non-Bypassable Builder Containment in `NdjsonWorkerDaemon` (`lib/ndjson-worker.mjs`):**
   - Currently `_requiresContainment()` returns `this.role === 'builder' && Boolean(this.containment || this.sandbox)` so unit tests in `test/ndjson-worker.test.mjs` can pass `{ containment: false, sandbox: false }` (`PURE`) with tiny mock scripts.
   - Align `NdjsonWorkerDaemon` with `runAgy()` so `role === 'builder'` unconditionally enters `prepareBuilderContainment()` unless an explicit test-only seam (gated by `isTestExecution()`) is passed, and route `this.userHome` through `resolveUserHome()` from `lib/agy.mjs`.
3. **Rename Legacy Benchmark Key in `evals/v13-enhancements-bench.mjs` & `evals/runner.mjs`:**
   - Rename `versionAutoDisableOk` -> `belowFloorRejectedOk` (kept during `T-GUARD-0B` for JSON report key continuity) if breaking eval JSON schema keys is acceptable for `2.0.0`.

Remember ADLC mandatory discipline (`AGENTS.md`): open a P0 ticket via `npx adlc ticket create` before editing, run `npm test` + `adlc hollow-test` + `adlc rails-guard`, and archive the ticket before merge.

---

## 4. Workstream 4 — Cut `v2.0.0` Release (`/release-audit` -> `/release`)

Once PR #202 is merged to `main` (and after deciding whether to include Workstream 3 in `2.0.0` or `2.0.1`), run the maintainer release pipeline from a fresh session on `main`:

1. **Run `/release-audit`:**
   - Starter prompt for a new session:
     > Run `/release-audit` on `main` to verify production readiness for `antigravity-booster` `v2.0.0` (including Waves 2–4 from PR #201 and Native Antigravity `>= 1.5.17` Guardrails from PR #202).
   - Verify all mechanical integrity gates pass:
     - `npm run build`
     - `node scripts/check-bundle-externals.mjs`
     - `node website/scripts/gen-reference.mjs && node website/scripts/check-all.mjs`
     - `npm run plugin:validate`
     - `npm test`
     - `npx --no-install adlc rails-guard --base origin/main --rails 'lib/lock.mjs' --rails 'lib/gates.mjs'`
     - `npx --no-install adlc ticket doctor --archive`
     - `npx --no-install adlc gate-manifest verify`
2. **Prepare `CHANGELOG.md` `2.0.0` Breaking Changes Section & Remove `HANDOFF.md` (or archive into `docs/`):**
   - Document breaking `v2.0.0` requirements clearly:
     - Minimum `agy` CLI raised from `1.2.6` to **`1.5.17`**.
     - `PreToolUse` hook now emits `force_ask` for ambiguous interactive shell commands and out-of-workspace writes (prompts human even under `--yolo`).
     - `buildRoleSettingsProfile()` now emits Antigravity `1.5.17` `{ allowNonWorkspaceAccess: false, permissions: { deny: [...] } }` instead of legacy `{ sandbox, autoApprove, deniedTools }`.
   - Remove `HANDOFF.md` (or move to `.adlc/` / `docs/` if desired) as part of the release prep ticket so root layout stays clean.
3. **Run `/release`:**
   - Starter prompt:
     > Cut the `2.0.0` major release using `/release` (bump version to `2.0.0`, rebuild `dist/` and website reference docs, tag `v2.0.0`, and shepherd through human-approved OIDC trusted npm publishing).
