# Roadmap: antigravity-booster adaptation to agy 1.4.7 & ADLC 1.12.0

Delta audit since [roadmap-agy-1.2.8-adlc-1.11.1](roadmap-agy-1.2.8-adlc-1.11.1.md). Produced by `/modernize` on 2026-10-24.

Claims marked `[probed]` were verified live on this machine. Claims marked `[registry]` come from `npm view`. Claims marked `[changelog]` come from `agy changelog` output. The ADLC 1.12.0 release notes were **not** retrieved: the published `@adlc/cli@1.12.0` tarball ships no CHANGELOG. Treat 1.12.0 behavior changes as unreviewed (see Open Questions).

---

## 1. Probed Live Facts & Upstream Delta

### agy runtime
- Installed `agy` is **1.4.7** `[probed]`. The previous roadmap targeted 1.2.8.
- **Live model catalog (`agy models`) `[probed]`** has changed substantially:
  - `gemini-4-argon-{low,medium,high}` (new)
  - `gemini-3.8-flash-{low,medium,high}`
  - `claude-opus-5-5-{low,medium,high}` (new; replaces `claude-opus-4-6-thinking`)
  - `claude-sonnet-5-5-{low,medium,high}` (new; replaces `claude-sonnet-4-6`)
  - `gpt-oss-120b-medium`
  - **Gone from the catalog:** `gemini-3.7-flash-*`, `gemini-3.6-flash-*`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`.
- **Quota pools (`agy -p "/quota"`) `[probed]`:** unchanged. Two pools (`Gemini Models`, `Claude and GPT models`), each with Weekly and Five Hour limits.
- **Flags `[probed]`:** `--output-format {text,json,stream-json}`, `--input-format stream-json`, `--json-schema`, `--sandbox`, `--print-timeout` (0 waits for turn end), `--project`, `--effort {low,medium,high,xhigh,max}`, `--mode {accept-edits,auto,plan}`. New since 1.2.8: `xhigh`/`max` effort levels and `--mode`.
- **Relevant changelog entries 1.4.3 to 1.4.7 `[changelog]`:**
  - 1.4.6: terminal sandbox defaults now deny `~/.docker`, `~/.kube`, `~/_netrc` unless granted. Builders that use registry or cluster credentials will start failing silently.
  - 1.4.7: headless `-p` runs use much less CPU and skip transcript rendering.
  - 1.4.4 to 1.4.6: `agy plugin validate` is much stricter (hooks, sidecars, `plugin.json` fields, skills entries).
  - 1.4.7: hook stdin JSON gains `lastUserInput`.
  - 1.4.3: sandbox-dependent options are no longer offered where the sandbox cannot run.

### ADLC
- `@adlc/cli`, `@adlc/core` latest is **1.12.0** `[registry]`. The repo pins 1.11.1 and the authenticated local `adlc` reports 1.11.1 `[probed]`.
- `@adlc/antigravity` latest is **1.7.0** `[registry]`, equal to the pin. No action.

### Booster impact (static) `[probed]`
`lib/models.mjs` is the single source of truth and is now stale against the live catalog:
- `PROSECUTORS.claude`, `PROSECUTORS['gpt-oss']`, `ROLE_MODELS.{premortem,parallaxJudge,brainConvert}`, `reviewFleetAlternates`, and `TIER_CANDIDATES.frontier` all lead with `gemini-3.1-pro-high`, which no longer exists.
- Every Claude slug (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`) in `MODELS.claude`, `TIER_CANDIDATES`, and `PROSECUTOR_CANDIDATES` no longer exists.
- Consequence: premortem, parallax-judge, brain-convert, and frontier-tier dispatch will request nonexistent models. Cross-model prosecution of Claude builders has no valid prosecutor default. Current catalog models (Argon, Claude 5.5) are unreachable because `poolOf` has no slug match for them under the explicit `MODELS` table.
- `RETIRED_35_MAP` is a one-generation special case. This is the second retirement wave, so it should become a generic retired-model map.
- Stale references also exist in `test/fixtures/fake-agy`, `test/{unit,pools,models-registry}.test.mjs`, and website docs (`pools-and-tiers`, `prosecution`, `walkthrough`, `review`, `writing-plans`).

---

## 2. Subsystem Delta Matrix

| Pillar | Existing | Delta / action |
| :--- | :--- | :--- |
| 1. Model catalog & pools | Gemini 3.8/3.7/3.6 flash, 3.1 pro, Claude 4.6, gpt-oss | Add `gemini-4-argon-*`, `claude-{opus,sonnet}-5-5-*`; retire 3.7, 3.6, 3.1-pro, Claude 4.6 via a generic retired-model map; re-point every role, tier, and prosecutor default. Pools stay 2-way. |
| 2. Subprocess protocol | json / stream-json / `--json-schema` already adopted | No change. `[probed]` flags all still present. |
| 3. Timeouts & effort | `--print-timeout`, `--effort low|medium|high` | Optional: allow `xhigh`/`max` in effort validation. Defer; no current consumer. |
| 4. ADLC integration | `@adlc/*` 1.11.1 | Bump to 1.12.0 after a human reads the release notes. |
| 5. Sandbox | Detection in `lib/doctor.mjs` | Document the 1.4.6 credential-path denial; add a doctor warning when a builder gate needs `~/.docker`/`~/.kube`. Run `agy plugin validate` on the shipped plugin. |
| 6. Pruning | 2 candidates flagged: model fallbacks, legacy `tickets.json` | Model fallbacks: remove the 3.5 alias block (superseded by the generic retired map). Legacy `tickets.json`: **keep**; AGENTS.md says it is still recognized for unmigrated target repos. Owner decision needed to retire it. |

---

## 3. Design Decisions

1. **Catalog drift must be detected, not just fixed.** A one-time slug swap will rot again. `agb doctor` gains a check that compares `ALL_MODELS` against `agy models` and reports retired or unknown slugs as a warning. The check degrades to `{ ok: false, error }` when `agy models` is unavailable, per AGENTS.md.
2. **Family mapping.** `gemini-4-argon-*` joins the `gemini-pro` bucket (the successor frontier Gemini). `gemini-3.8-flash-*` stays `gemini-flash`. `claude-*-5-5-*` joins `claude`. `poolOf`/`familyOf`/`upstreamPoolOf` semantics are unchanged.
3. **Prosecutor independence is preserved.** Claude builders get an Argon or gpt-oss prosecutor. Gemini builders get gpt-oss or Claude Sonnet 5.5. gpt-oss builders get Argon or Claude.
4. **Effort-suffixed slugs.** The new Claude slugs are per-effort (`-low|-medium|-high`). Tiers map: cheap to `-low`, mid to `-medium`, frontier to `-high`.
5. **No ticket scope or rails derive from changelog text.** Ticket paths below were chosen from the static audit of this repo only.

---

## 4. Verification Gates
- `npm test` (offline, via `test/fixtures/fake-agy`; the fixture is updated alongside the catalog).
- `adlc rails-guard --base main --rails lib/lock.mjs,lib/gates.mjs` shows no rail edits.
- `adlc hollow-test --test-cmd "npm test" --base main` on `lib/models.mjs` and `lib/doctor.mjs` changes.
- `agb review` fleet (correctness, security, tests, contracts), looped until two consecutive dry rounds.
- `adlc gate-manifest record` per ticket; `adlc gate-manifest verify` at the end.
- Docs: `website/` generator check passes (see CONTRIBUTING.md "Docs generator contract").

---

## 5. Open Questions for the Owner
1. Read the `@adlc` 1.12.0 release notes (not retrievable from the tarball) before approving the dependency bump. Was anything breaking, for example `merge-forecast`, `rails-guard`, or ticket-store changes?
2. ~~Retire the legacy `.adlc/tickets.json` backend?~~ **Resolved 2026-10-25: owner approved retiring it** (`t-retire-legacy-tickets-json`; the migrate path stays).
3. ~~Should `claude-opus-5-5-*` be in default tiers?~~ **Resolved 2026-10-25: frontier-only.**

---

## 6. Implementation Ticket DAG

Edge convention: an edge `{ "to": X }` on a ticket means that ticket completes before X.

1. `t-models-catalog-refresh` (the live breakage; first) then `t-doctor-catalog-drift` and `t-docs-models-refresh`
2. `t-doctor-catalog-drift` then `t-sandbox-cred-paths` then `t-retire-legacy-tickets-json` (serialized because they share `lib/doctor.mjs` and `test/**`)
3. `t-deps-adlc-1-12` (independent; gated on Open Question 1)

### Canonical Machine-Readable Ticket Plan

```json
{
  "repo": "/home/voodootikigod/Projects/voodootikigod/antigravity-booster",
  "base": "main",
  "concurrencyCap": 3,
  "gate": {
    "build": "npm test",
    "test": "npm test"
  },
  "tickets": [
    {
      "id": "t-models-catalog-refresh",
      "title": "Refresh model catalog to live agy 1.4.7 (Argon, Claude 5.5) and retire dead slugs",
      "body": "In lib/models.mjs: add gemini-4-argon-{low,medium,high} to the gemini-pro bucket and claude-{opus,sonnet}-5-5-{low,medium,high} to the claude bucket; remove gemini-3.7-flash-*, gemini-3.6-flash-*, gemini-3.1-pro-*, claude-sonnet-4-6, claude-opus-4-6-thinking from MODELS. Replace RETIRED_35_MAP with a generic RETIRED_MODEL_MAP (3.5 -> 3.8 flash, 3.7/3.6 -> 3.8 flash, 3.1-pro -> gemini-4-argon, claude-sonnet-4-6 -> claude-sonnet-5-5-medium, claude-opus-4-6-thinking -> claude-opus-5-5-high) and keep resolveModelSlug warning on remap. Re-point TIER_CANDIDATES, PROSECUTORS, PROSECUTOR_CANDIDATES and ROLE_MODELS to live slugs while keeping prosecutor/builder family independence. Update test/fixtures/fake-agy to emit the live catalog and update the registry/pools/unit tests, adding a test that every default role, tier and prosecutor slug is a member of ALL_MODELS and that every retired slug resolves to a live one. Acceptance: npm test green; no default references a slug absent from `agy models`.",
      "scope": ["lib/models.mjs", "test/models-registry.test.mjs", "test/pools.test.mjs", "test/unit.test.mjs", "test/fixtures/fake-agy"],
      "rails": ["lib/lock.mjs", "lib/gates.mjs"],
      "edges": [{ "to": "t-doctor-catalog-drift" }, { "to": "t-docs-models-refresh" }],
      "tier": "mid",
      "pool_hint": "gemini"
    },
    {
      "id": "t-doctor-catalog-drift",
      "title": "agb doctor: warn when the model catalog drifts from live agy models",
      "body": "In lib/doctor.mjs add a check that runs `agy models`, parses slugs, and compares them with ALL_MODELS from lib/models.mjs. Report slugs in ALL_MODELS missing upstream as 'retired' and live slugs unknown to booster as 'unrecognized', both as warnings (not failures). If `agy models` is unavailable or fails, return { ok: false, error } without throwing, matching the CLI-integration degrade rule. Add tests using test/fixtures/fake-agy covering clean, drifted, and agy-unavailable cases. Acceptance: npm test green; doctor output names the drifted slugs.",
      "scope": ["lib/doctor.mjs", "test/doctor.test.mjs"],
      "rails": ["lib/lock.mjs", "lib/gates.mjs"],
      "edges": [{ "to": "t-sandbox-cred-paths" }],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "t-deps-adlc-1-12",
      "title": "Bump @adlc/* dependencies from 1.11.1 to 1.12.0",
      "body": "BLOCKED until the owner has reviewed the @adlc 1.12.0 release notes. Bump @adlc/cli, core, tickets, consensus-fix, flail-detector, gate-manifest, hollow-test, merge-forecast, model-router, rails-guard to 1.12.0 in package.json and regenerate package-lock.json with integrity hashes. Leave @adlc/antigravity at 1.7.0 and do not touch vendor/cache. Update any hardcoded 1.11.1 floor in lib/doctor.mjs only if the release notes require it. Acceptance: npm test green with the new binary; `adlc --version` reports 1.12.0 from the authenticated local shim.",
      "scope": ["package.json", "package-lock.json"],
      "rails": ["lib/lock.mjs", "lib/gates.mjs", "vendor/cache/**"],
      "edges": [],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "t-sandbox-cred-paths",
      "title": "Document and warn about agy 1.4.6 sandbox credential-path denial",
      "body": "agy 1.4.6 denies ~/.docker, ~/.kube and ~/_netrc inside the terminal sandbox unless explicitly granted. Add a short section to website/content/docs/concepts/gates-and-sandboxing.mdx describing the change and the explicit-grant remedy, and add a doctor warning when the configured gate command mentions docker or kubectl while the sandbox is enabled. Also run `agy plugin validate` against the shipped companion plugin and record the result in the ticket. Acceptance: npm test green; doc section present; warning covered by a test.",
      "scope": ["website/content/docs/concepts/gates-and-sandboxing.mdx", "lib/doctor.mjs", "test/doctor.test.mjs"],
      "rails": ["lib/lock.mjs", "lib/gates.mjs"],
      "edges": [{ "to": "t-retire-legacy-tickets-json" }],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "t-retire-legacy-tickets-json",
      "title": "Retire the legacy single-file .adlc/tickets.json backend (owner-approved)",
      "body": "Owner approved retiring the legacy single-file ticket backend. Remove the dual-backend code paths so the directory store (.adlc/tickets/) is the only backend: lib/adlc-bridge.mjs (legacy/both write modes, hasLegacy detection), lib/active-rails.mjs, lib/worktrees.mjs (the '!.adlc/tickets.json' ignore/exclude entries), lib/plan.mjs and lib/preflight.mjs (projection to tickets.json), lib/scheduler.mjs, lib/doctor.mjs. KEEP the one-way migration path in lib/migrate.mjs so an unmigrated target repo with a legacy tickets.json is migrated or gets a clear actionable error telling the user to run `agb migrate`; never silently ignore a legacy file (enforcement gates fail closed). Update test/fixtures/fake-adlc and affected tests, add a test that a repo with only a legacy tickets.json produces the migrate-or-error outcome. Amend the AGENTS.md sentence that says the single-file backend is 'still recognized in unmigrated target repos' (owner-approved doctrine amendment), add a CHANGELOG.md breaking-change entry, and update the website pages that mention tickets.json (internals/plan-compiler, internals/policy-guard, project/adlc-in-this-repo, reference/file-layout, getting-started/verify, concepts/rail-enforcement, concepts/plan-boundary). Acceptance: `grep -rn 'tickets\\.json' lib` matches only lib/migrate.mjs; npm test green.",
      "scope": ["lib/adlc-bridge.mjs", "lib/active-rails.mjs", "lib/worktrees.mjs", "lib/plan.mjs", "lib/preflight.mjs", "lib/scheduler.mjs", "lib/doctor.mjs", "lib/migrate.mjs", "test/**", "AGENTS.md", "CHANGELOG.md", "website/content/docs/internals/plan-compiler.mdx", "website/content/docs/internals/policy-guard.mdx", "website/content/docs/project/adlc-in-this-repo.mdx", "website/content/docs/reference/file-layout.mdx", "website/content/docs/getting-started/verify.mdx", "website/content/docs/concepts/rail-enforcement.mdx", "website/content/docs/concepts/plan-boundary.mdx"],
      "rails": ["lib/lock.mjs", "lib/gates.mjs"],
      "edges": [],
      "tier": "frontier",
      "pool_hint": "auto"
    },
    {
      "id": "t-docs-models-refresh",
      "title": "Refresh website docs for the new model catalog",
      "body": "Update website/content/docs concepts/pools-and-tiers, concepts/prosecution, guides/walkthrough, guides/review and guides/writing-plans so every model slug and example matches the post-refresh lib/models.mjs. Reference pages are generated; regenerate them and run the generator check per CONTRIBUTING.md. Do not edit design-history pages for older roadmaps. Acceptance: docs generator check passes; grep for retired slugs in website/content (excluding design-history) returns nothing.",
      "scope": ["website/content/docs/concepts/pools-and-tiers.mdx", "website/content/docs/concepts/prosecution.mdx", "website/content/docs/guides/walkthrough.mdx", "website/content/docs/guides/review.mdx", "website/content/docs/guides/writing-plans.mdx"],
      "rails": ["lib/lock.mjs", "lib/gates.mjs"],
      "edges": [],
      "tier": "cheap",
      "pool_hint": "gemini"
    }
  ]
}
```
