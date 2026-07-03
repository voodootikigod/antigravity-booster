# Handoff: Full ADLC-Antigravity Integration for antigravity-booster

**Status:** planning document — not yet started
**Author context:** written from a review of `fix/move-to-adlc` (current branch) against `../adlc/plugins/adlc-antigravity` (merged PR #53) and the broader `../adlc` toolkit (`@adlc/cli` 1.1.0, `@adlc/core`)
**Intended use:** input to `/adlc plan` (or a `workflows/ultracode` fan-out) to compile this into a ticket DAG and execute with `agb`/`agy` self-orchestration. Each workstream below is written to be independently ticket-able; dependencies between workstreams are called out explicitly.

---

## 1. Goal

`fix/move-to-adlc` was supposed to align antigravity-booster with the ADLC toolkit and, specifically, fully leverage the newly built `adlc-antigravity` plugin. As shipped, it is a mechanical rename (`aidlc` → `adlc` across imports, README, package-lock) — it does not change booster's relationship to the plugin at all. This document defines what "properly and fully integrated" actually requires, plus a set of opportunities to extend booster *beyond* what the plugin provides ("enabling beyond and around it").

The end state:

1. Booster **depends on** `adlc-antigravity` as the canonical source of doctrine/prosecutor/self-orchestrate skills, rails enforcement, and the prosecutor agent — it no longer hand-vendors competing copies.
2. Booster's own execution engine (`lib/scheduler.mjs`, `lib/prosecute.mjs`, `lib/preflight.mjs`) is **rail-aware and gate-aware** in the same sense the plugin's in-session hook and the ADLC CI gate are — mechanical, not prompt-based, and backed by `@adlc/core`/`@adlc/cli` rather than reimplementing subsets of it.
3. Booster **dogfoods** the full ADLC on its own repository (`.adlc/` workspace, frozen rails, CI rails-guard) — it should not ask target repos to do something it doesn't do to itself.
4. Booster **exposes** ADLC toolkit capabilities the plugin doesn't surface on its own (`model-router`, `merge-forecast`, `flail-detector`, `consensus-fix`, `hollow-test`, `gate-manifest`, `lesson-foundry`, `rejection-mining`) through its scheduler/review/sweep commands — this is the "beyond and around" part: booster becomes the fleet-orchestration layer *on top of* the plugin's in-session/CI layers, not a parallel implementation of them.

---

## 2. Current state (evidence, not assumption)

### 2.1 What `fix/move-to-adlc` actually contains

11 files changed, mechanical string rename only:

- `README.md`, `bin/agb.mjs`, `lib/{brain,plan,preflight,prosecute,review,scheduler}.mjs`, `skills/adlc-self-orchestrate/SKILL.md`: `@aidlc/*` → `@adlc/*`, `../aidlc/ADLC.md` → `../adlc/ADLC.md`.
- `package.json` / `package-lock.json`: `@adlc/core` now resolves to `file:../adlc/packages/core` (renamed sibling checkout).
- One commit (`7fbcb5e`) folds in unrelated review feedback for the raw-spec-path feature (already independently on `main`).
- 74/74 tests pass. No behavior changed.

### 2.2 What booster owns today (predates the plugin, built 2026-06-11)

| Layer | Booster's implementation | Location |
|---|---|---|
| Doctrine/prosecutor/self-orchestrate skills | Hand-authored, vendored into `~/.gemini/skills` via `agb bootstrap` (symlink in dev, copy under npx) | `skills/adlc-doctrine/`, `skills/adlc-prosecutor/`, `skills/adlc-self-orchestrate/`, `lib/bootstrap.mjs` |
| Rail/scope enforcement | Mechanical, **post-hoc**: after a builder finishes, `scheduler.mjs` checks the diff against the ticket's `scope`/`rails` globs (via `@adlc/core/tickets`) | `lib/scheduler.mjs` |
| Prosecution | Prompt/charter dispatched to a cross-family model (`agb prosecute`); parses a JSON verdict; no use of any `adlc` CLI gate | `lib/prosecute.mjs`, `lib/charters.mjs` |
| Plan compilation | `agb plan` — brain → ticket DAG, structural/overlap/coldstart/parallax/premortem gates, native `runAgy` implementation (not `@adlc/*` packages) | `lib/plan.mjs` |
| Bootstrap/install | `agb bootstrap` — custom npx/symlink installer for booster's own skills only; does not touch `agy plugin install` at all | `lib/bootstrap.mjs` |
| CI | `publish.yml` only (npm publish on release) — no test/build gate, no rails gate | `.github/workflows/publish.yml` |
| ADLC self-hosting | None — no `.adlc/` workspace in this repo, no frozen rails, no active tickets | (absent) |

### 2.3 What the plugin provides that booster does not use

`adlc-antigravity` (PR #53, merged after booster's initial build) is the sixth native ADLC host integration (parity with Claude Code, Codex, Cursor, OpenCode, Pi). Verified structure at `../adlc/plugins/adlc-antigravity/`:

| Component | What it does | File |
|---|---|---|
| `PreToolUse` rails-guard hook | Live, in-session denial of edits to frozen rails while an `agy` session runs. Fails **open** on hook crash/timeout (agy's own contract) — advisory, not the guarantee. | `hooks/adlc-rails-guard.{cjs,mjs}` |
| `rails-checker.mjs` + `core-inline.mjs` | Editor-agnostic rail decision engine, self-contained (inlines `@adlc/core` primitives) because `agy plugin install` copies without `node_modules` | `rails-checker.mjs`, `core-inline.mjs` |
| `prosecutor` agent | A real subagent definition that runs `adlc` CLI gates (`hollow-test`, `behavior-diff`, etc.) and reports a verdict backed by machine-checkable output, not just a prompt's self-report | `agents/prosecutor.md` |
| Doctrine/prosecutor/self-orchestrate skills | Same three skills booster vendors — **already textually drifted** from booster's copies (confirmed: `adlc-doctrine/SKILL.md` differs in wording; `adlc-prosecutor/SKILL.md` and `adlc-self-orchestrate/SKILL.md` are currently identical but unpinned) | `skills/` |
| `/adlc-init` command | Installs the plugin into `agy`, scaffolds `.adlc/`, wires the CI rails-guard workflow, sets `ADLC_P4_ENFORCEMENT=1` | `commands/adlc-init.md` |
| CI diff gate (the actual guarantee) | `scripts/rails-guard-ci.mjs` in `../adlc`, templated as `docs/ci/rails-guard.yml` — reads frozen rails from the trusted base ref, rejects any PR editing them regardless of edit mechanism (catches shell writes the in-session hook can't gate) | `../adlc/scripts/rails-guard-ci.mjs`, `../adlc/docs/ci/rails-guard.yml` |
| `adlc` CLI (20 tools) | `spec-lint`, `premortem`, `parallax`, `coldstart`, `preflight`, `model-router`, `merge-forecast`, `rails-guard`, `flail-detector`, `consensus-fix`, `behavior-diff`, `gate-manifest`, `hollow-test`, `prosecute`, `review-calibration`, `model-ratchet`, `gate-fuzzing`, `lesson-foundry`, `rejection-mining`, `skill-rot` — none of these are invoked anywhere in booster today except the ad-hoc `@adlc/core` ticket/glob primitives | `@adlc/cli` (globally installed, `adlc --version` → 1.1.0) |

### 2.4 The core problem

Booster and the plugin **independently reimplement the same three skills** with no dependency relationship, and booster's enforcement (post-hoc scope diffing) is strictly weaker than the plugin's two-layer model (in-session hook + CI gate) while also not being the thing the plugin's docs call "the guarantee." Meanwhile booster ignores 18 of the 20 `adlc` CLI tools that would directly strengthen its own scheduler, prosecution, and review commands.

---

## 3. Target integration model

```
                     ┌─────────────────────────────────────────┐
                     │   adlc-antigravity plugin (agy-native)   │
                     │   - PreToolUse rails-guard (advisory)    │
                     │   - doctrine/prosecutor/self-orch skills │
                     │   - prosecutor agent                     │
                     │   - /adlc-init                           │
                     └───────────────┬───────────────────────────┘
                                      │ installed via `agy plugin install`,
                                      │ booster verifies/bootstraps it —
                                      │ does NOT vendor a copy
                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                       antigravity-booster (agb)                   │
│  Fleet orchestration ON TOP of the plugin's in-session layer:     │
│   - lib/scheduler.mjs: worktree fan-out, quota-pool semaphores,   │
│     `adlc rails-guard` as the mechanical post-build check         │
│     (replacing the current ad-hoc glob diff)                      │
│   - lib/prosecute.mjs: dispatches to the SAME prosecutor charter  │
│     the plugin's agent uses, backed by `adlc hollow-test` /       │
│     `adlc behavior-diff` evidence, not prompt self-report alone   │
│   - lib/plan.mjs: `adlc model-router` / `adlc merge-forecast` for │
│     tier assignment and fan-out width (replacing ad-hoc heuristics)│
│   - lib/review.mjs (`agb review`): `adlc flail-detector`,         │
│     `adlc consensus-fix`, `adlc review-calibration`               │
│   - agb bootstrap: installs the PLUGIN via `agy plugin install` + │
│     runs `/adlc-init`, then verifies — does not copy skill files  │
└─────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
                     ┌─────────────────────────────┐
                     │  This repo (booster) is      │
                     │  itself ADLC-initialized:     │
                     │  .adlc/, frozen rails,         │
                     │  CI rails-guard, gate-manifest │
                     └─────────────────────────────┘
```

---

## 4. Gap analysis, mapped to ADLC phases

Using the same P0–P7 framing the plugin's own docs use (`../adlc/docs/integrations/antigravity.md`), scored for booster specifically:

| Phase | Plugin coverage | Booster today | Gap |
|---|---|---|---|
| P0 Triage | `/adlc-init` → `.adlc/tickets.json` | `agb plan` compiles a brain into `plan.json` — a **parallel**, booster-specific ticket format, not `.adlc/tickets.json` | Decide: keep `plan.json` as booster's execution artifact (it has fields `.adlc/tickets.json` doesn't — `tier`, `pool_hint`) but make it **derivable from / reconcilable with** `.adlc/tickets.json` so the plugin's rails-guard and CLI tools can resolve the same active ticket. See Workstream C. |
| P1 Interrogate | `adlc spec-lint/premortem/parallax` | `lib/plan.mjs` has its own native `runAgy` implementation of coldstart + parallax + premortem | Booster's versions are bespoke and untested against the CLI tools' calibration. Evaluate replacing with direct `adlc` CLI calls (Workstream F). |
| P2 Decompose | `adlc coldstart/model-router/merge-forecast` | `agb plan` has ad-hoc coldstart; no model-router or merge-forecast use — tier assignment is `lib/pools.mjs` heuristics | Wire `adlc model-router` and `adlc merge-forecast` into `agb plan`'s tier-assignment and fan-out-width decisions (Workstream F). |
| P3 Rail | PreToolUse hook (advisory) + CI gate (guarantee) | Post-hoc scope/rail diff check only, after the builder has already run | Booster never blocks a rail write **during** the build — it only fails the ticket afterward, burning the full builder quota on a doomed attempt. Wire the plugin's hook into every worktree the scheduler spins up (Workstream B). |
| P4 Build | doctrine skill; `flail-detector`/`consensus-fix` | Doctrine skill vendored (drifting copy); no flail-detector, no consensus-fix — "two-strike regeneration" is booster's own bespoke heuristic | Replace/augment two-strike regen with `adlc flail-detector` (repeated errors, scope violations, edit churn) for a principled trigger, and `adlc consensus-fix` for the fix-round itself (Workstream F). |
| P5 Prosecute | `adlc-prosecutor` skill + agent; `hollow-test`/`behavior-diff` | Charter-prompted cross-model review only; verdict is self-reported JSON with no machine-checkable backing | This is the single highest-value gap. Wire `adlc hollow-test` (mutate changed code, confirm tests catch it) into `lib/prosecute.mjs` as a hard precondition to a "ship" verdict (Workstream D). |
| P6 Integrate | human gate, `adlc gate-manifest` | Merge lock + post-merge gate + rollback; no append-only evidence record | Record every gate pass/fail (pre-merge build, prosecution, post-merge build) via `adlc gate-manifest` so a run has an auditable, attestable trail, not just log files (Workstream E). |
| P7 Distill | `adlc lesson-foundry`/`rejection-mining` | None | Booster currently throws away every failed/regenerated ticket's context. Mine it (Workstream F, lowest priority — real payoff needs volume). |

---

## 5. Workstreams

Each workstream is written to be independently ticketable. Suggested `rails` (files each workstream must NOT touch, to keep them parallelizable) are noted.

### Workstream A — Retire vendored skill duplication

**Problem:** `skills/adlc-doctrine/`, `skills/adlc-prosecutor/`, `skills/adlc-self-orchestrate/` in this repo are unowned forks of the plugin's copies and have already drifted (confirmed wording diff in `adlc-doctrine/SKILL.md`).

**Tasks:**
1. Delete `skills/adlc-doctrine/`, `skills/adlc-prosecutor/`, `skills/adlc-self-orchestrate/` from this repo. Keep `skills/release/` (booster-specific, not an ADLC doctrine skill).
2. Change `lib/bootstrap.mjs` (`agb bootstrap`) so it no longer copies/symlinks these three skill directories. Instead it should shell out to `agy plugin install <path-to-adlc-antigravity>` (resolve the plugin path via a documented `ADLC_ANTIGRAVITY_PLUGIN_PATH` env var or a relative `../adlc/plugins/adlc-antigravity` convention, matching how `package.json` already resolves `@adlc/core` via `file:../adlc/packages/core`), then run the plugin's install verification (`agy plugin list` should show `adlc-antigravity`).
3. Update `README.md` Install section: `agb bootstrap` now installs the plugin, not booster-owned skill copies. Remove language implying booster ships its own doctrine content.
4. Update `test/*.test.mjs` bootstrap tests — they currently assert on skill-copy behavior (`bootstrap: installs skills into custom destination directory`); rewrite to assert `agy plugin install` was invoked with the right path and that failure (plugin path not found / `agy` too old to support `plugin install`) is handled with a clear error, not a silent skip.

**Acceptance criteria:**
- `grep -r adlc-doctrine skills/` returns nothing.
- `agb bootstrap` on a machine with `../adlc` checked out results in `agy plugin list` showing `adlc-antigravity`.
- `agb bootstrap` on a machine *without* `../adlc` checked out fails loudly with an actionable message (not a silent no-op) — this repo's `@adlc/core` dependency already requires the sibling checkout, so this is consistent with an existing constraint, not a new one.
- Existing 74 tests still green, updated bootstrap tests pass.

**Rails (do not touch):** `lib/scheduler.mjs`, `lib/prosecute.mjs`, `lib/plan.mjs` — this workstream is install/bootstrap only.

**Depends on:** nothing. Do this first — it removes the drift risk immediately and unblocks the others (Workstream B assumes the plugin is the installed source of the rails-guard hook, not a vendored copy).

---

### Workstream B — Live rail enforcement in the scheduler

**Problem:** `lib/scheduler.mjs` only discovers a rail violation *after* a builder has finished and its full diff is available — the builder has already spent its quota, and (per the plugin's own docs) shell writes aren't even caught by the in-session hook, only by the CI gate. Booster's worktree-per-ticket model is exactly the shape the plugin's hook was designed for, but nothing wires it in.

**Tasks:**
1. When `runPlan` (`lib/scheduler.mjs`) creates a worktree for a ticket (`lib/worktrees.mjs`), ensure `agy` inside that worktree has the `adlc-antigravity` plugin active and `ADLC_P4_ENFORCEMENT=1` set for the duration of the builder's `agy --print` invocation, with `ADLC_TICKET` (or `.adlc/current-ticket.json`) pointing at the ticket currently being built. This requires the target repo to be ADLC-initialized (`.adlc/` present) — see the compatibility note below.
2. Compatibility note: booster's `plan.json` ticket schema (`tier`, `pool_hint` extensions) is not `.adlc/tickets.json`. Before setting `ADLC_TICKET`, the scheduler needs to materialize the current ticket into the format the plugin's `rails-checker.mjs` expects (`id`, `title`, `scope`, `rails`, `edges`) — a pure projection, no new fields invented. Add a `planTicketToAdlcTicket()` helper in `lib/plan.mjs` or a new `lib/adlc-bridge.mjs`.
3. Keep the existing post-hoc scope/rail diff check in `scheduler.mjs` as the belt to the hook's suspenders (mirrors the plugin's own two-layer stance: in-session is advisory, something else is the guarantee) — but change its role from "the only check" to "the fast-fail confirmation," and make the post-hoc check call `adlc rails-guard` (diff-based) directly instead of the current bespoke `@adlc/core` glob comparison, so booster and the plugin share one enforcement engine.
4. When enforcement is unavailable (target repo isn't ADLC-initialized, or `adlc`/plugin isn't present), booster must **fail closed and say so** in the ticket log — not silently degrade to prompt-only discipline, which is what happens today.

**Acceptance criteria:**
- A planted rail violation (builder prompt instructed to edit a frozen rail path) is denied **during** the build, not just failed after — verified with a live smoke ticket, mirroring the plugin's own "Write to a frozen rail → DENIED" live verification.
- The post-hoc check now calls `adlc rails-guard`, confirmed via a test that stubs the CLI and asserts it's invoked with the right diff/base-ref args.
- Running the scheduler against a non-ADLC-initialized target repo produces a clear warning in the run report, not silent success.

**Rails:** `lib/prosecute.mjs`, `lib/review.mjs`, `skills/` — scheduler/worktree files only.

**Depends on:** Workstream A (plugin must be the installed source, not vendored, before wiring it into every worktree).

---

### Workstream C — Reconcile `plan.json` and `.adlc/tickets.json`

**Problem:** `agb plan` produces `plan.json`, a booster-only artifact. The plugin, the CLI's 20 tools, and `/adlc-init` all operate on `.adlc/tickets.json`. Right now these are two unrelated ticket universes; Workstream B needs a bridge between them, and that bridge should be a first-class, tested artifact rather than an inline helper.

**Tasks:**
1. Formalize the projection from a `plan.json` ticket to an `.adlc/tickets.json` ticket (see Workstream B, task 2) as its own module with unit tests: `lib/adlc-bridge.mjs` exporting `planToAdlcTickets(plan)` and `writeAdlcTickets(repo, tickets)`.
2. `agb plan` should, as part of its existing gate pipeline (structural validate → overlap → coldstart → parallax → premortem), also **write** `.adlc/tickets.json` into the target repo (gitignored per the plugin's own convention: `.adlc/*` tracked exception `!.adlc/tickets.json` — confirm which policy booster wants; the plugin's `/adlc-init` docs suggest tracking the tickets file).
3. Document in `docs/guidelines.md` (`The Plan Phase` section already exists and is the right place) that `plan.json` remains the execution artifact (carries `tier`/`pool_hint` the CLI schema doesn't have) and `.adlc/tickets.json` is a generated projection consumed by the plugin/CLI — not a second source of truth a human edits.
4. Add a round-trip test: compile a brain → `plan.json` → project to `.adlc/tickets.json` → run `adlc coldstart` against the projection and confirm it doesn't error on well-formed booster tickets.

**Acceptance criteria:**
- `agb plan <brain-id> /abs/repo` leaves both `plan.json` (booster's) and `.adlc/tickets.json` (plugin/CLI's) in a consistent state.
- `adlc --version` / `adlc coldstart .adlc/tickets.json` succeeds against a plan booster just compiled.
- New module has isolated unit tests (target ≥ 80% per the coding-style testing bar) independent of the scheduler.

**Rails:** `lib/scheduler.mjs` (consumes the bridge, doesn't define it).

**Depends on:** nothing directly, but Workstream B is blocked on this landing first — do C before or alongside B.

---

### Workstream D — Evidence-backed prosecution

**Problem:** `lib/prosecute.mjs` asks a model to self-report a verdict. The plugin's `prosecutor` agent instead runs machine-checkable gates (`adlc hollow-test`, `adlc behavior-diff`) and backs its verdict with their output. Booster's current approach is exactly the failure mode ADLC doctrine calls out ("tests that pass without testing anything") applied to the *reviewer* itself — a hollow prosecution is just as dangerous as a hollow test.

**Tasks:**
1. Before dispatching the cross-model prosecution prompt in `lib/prosecute.mjs`, run `adlc hollow-test --test-cmd "<ticket's gate command>"` against the ticket's worktree. Attach its structured result (survivors, if any) to the prosecution prompt as evidence the model must address, not just narrative context.
2. If `adlc hollow-test` reports exit `2` (mutation survivors — tests don't actually constrain the changed lines), treat this as an automatic **prosecution hit** (reject) independent of the model's verdict, mirroring the plugin agent's stated behavior ("this is a prosecution hit"). Don't let the model overrule a hard mutation-testing signal.
3. Where the ticket's change touches an HTTP/API surface, run `adlc behavior-diff` and attach the snapshot comparison the same way.
4. Keep the existing cross-model dispatch (`agb prosecute` is stronger than the plugin's single-model agent because booster already does Gemini⇄Claude family alternation) — the CLI gates are additive evidence, not a replacement for cross-model review.
5. Record every prosecution's gate evidence via `adlc gate-manifest` (ties into Workstream E).

**Acceptance criteria:**
- A ticket whose tests pass but whose mutation-tested lines survive is rejected even if the LLM verdict says "ship" — verified with a planted-hollow-test fixture.
- Prosecution prompts in the log show the `hollow-test` evidence block, not just the diff.
- Existing cross-model prosecution tests still pass; new tests cover the hard-reject-on-survivors path.

**Rails:** `lib/scheduler.mjs`'s merge/rollback logic — this workstream changes what feeds into a verdict, not what happens after one.

**Depends on:** Workstream A (needs `adlc` CLI conventions confirmed working via the plugin path) — can run in parallel with B/C.

---

### Workstream E — Booster dogfoods the ADLC on itself

**Problem:** Booster asks every target repo it orchestrates to be ADLC-shaped (rails, gates, tickets) but is not itself ADLC-initialized. No `.adlc/` workspace, no frozen rails, no CI rails-guard, no gate-manifest. This is a credibility gap as much as a technical one — a tool advocating a doctrine should run it.

**Tasks:**
1. Run `/adlc-init` (or `adlc init`) on this repo: scaffold `.adlc/`, add the `.gitignore` stanza per the plugin's own convention (`.adlc/*` / `!.adlc/tickets.json`).
2. Add `.github/workflows/adlc-rails-guard.yml` from `../adlc/docs/ci/rails-guard.yml`, make it a required check. **Read the security limitation in that template first** — it does not protect rails introduced for the first time in the same PR; freeze any new rails in a merged commit before the PR that needs them protected.
3. Protect the deployed workflow file itself per the template's self-protection requirement (CODEOWNERS or branch ruleset) — the template explicitly documents that a PR can otherwise remove its own gate.
4. Decide and freeze booster's own rails: candidates are `lib/lock.mjs` (merge-lock correctness, already hardened over 7 adversarial-review rounds — regressions here are the highest-blast-radius class of bug in this repo), `lib/gates.mjs` (sandbox enforcement), and this `handoff.md` itself once workstreams are ticketed (prevents silent scope drift mid-execution).
5. Add `agb`'s own build/test to CI (currently only `publish.yml` exists — no gate runs on PRs at all today). This is a prerequisite for the rails-guard CI gate to mean anything; a rails-clean PR that doesn't build is not "safe."

**Acceptance criteria:**
- `.adlc/` exists in this repo with `ADLC_P4_ENFORCEMENT` documented in `docs/guidelines.md`.
- A PR that edits a frozen rail (e.g. `lib/lock.mjs` without going through the documented ticket process) fails CI.
- `.github/workflows/` includes a real test/build gate, not just publish.

**Rails:** none — this workstream *defines* rails for the others, so sequence it early, but it can run in parallel with A–D since it only adds new files (`.adlc/`, workflow YAML).

**Depends on:** nothing technically, but do this after Workstream A lands (so the rails-guard hook it dogfoods is the plugin's, not a vendored copy) for the story to be coherent.

---

### Workstream F — Surface the rest of the `adlc` CLI ("beyond and around")

**Problem:** 18 of 20 `adlc` CLI tools are unused by booster even though several map directly onto heuristics booster already hand-rolls. This is the highest-leverage, lowest-risk workstream — it's additive, not a rewrite of existing enforcement.

**Tasks, roughly in payoff order:**
1. **`adlc model-router`** → `lib/plan.mjs` / `lib/pools.mjs` tier assignment. Booster's tier heuristics (which pool/model a ticket routes to) are currently bespoke; replace or cross-check against the CLI's frontier/direct/ladder strategy assignment.
2. **`adlc merge-forecast`** → `agb plan`'s fan-out width decision. Booster already does transitive scope-overlap forecasting (`lib/preflight.mjs`); `merge-forecast` estimates dependency pressure and merge backpressure specifically — likely complementary, not redundant. Evaluate whether it should gate `plan.json`'s concurrency cap.
3. **`adlc flail-detector`** → replace booster's bespoke "two-strike regeneration" trigger (currently just a failed-gate counter) with the CLI's detector for repeated errors, scope violations, edit churn, and oversized logs — a more principled signal for "this worker is flailing, regenerate fresh" than gate-pass/fail alone.
4. **`adlc consensus-fix`** → the one-shot fix-round after a failed prosecution (`lib/scheduler.mjs`'s current single-attempt fix loop) could fan out multiple candidate fixes and pick the gated consensus winner instead of trusting one regeneration.
5. **`adlc gate-manifest`** → every gate this run already produces (pre-merge build, prosecution verdict, post-merge build, rollback) should be recorded as append-only, attestable evidence, not just `.booster/report.json` log lines. This is the audit trail Workstream E's CI gate and Workstream D's prosecution both want to point at.
6. **`adlc review-calibration`** → `agb review` (the read-only loop-until-dry lens fleet) could self-measure recall periodically — does the review fleet actually catch planted mutants? — closing the loop on booster's own reviewer quality the way `hollow-test` closes it for a single ticket's tests.
7. **`adlc lesson-foundry` / `adlc rejection-mining`** → lowest priority, needs volume to pay off. Booster currently discards every failed/regenerated ticket's context. Once Workstream E's gate-manifest is recording history, mine it periodically (candidate for a `agb distill` command, or a periodic job, not urgent now).
8. **`adlc skill-rot`** → run against booster's own doctrine skills (once Workstream A makes the plugin the source, this applies to the plugin, not booster — note this as a plugin-side, not booster-side, follow-up).

**Acceptance criteria:** each sub-task lands as its own PR with before/after behavior documented in `docs/guidelines.md`; none of these block A–E, so land opportunistically.

**Rails:** none prescribed — each task touches a different file, sequence by whoever picks it up next.

**Depends on:** Workstream A for CLI availability; otherwise independent of B–E.

---

## 6. Sequencing

```
A (retire vendored skills)
├─→ B (live rail enforcement)  ←── depends on C landing first (or alongside)
├─→ C (plan.json ⇄ .adlc/tickets.json bridge)
├─→ D (evidence-backed prosecution)
└─→ F (surface remaining CLI tools) — opportunistic, any order after A

E (dogfood ADLC on booster itself) — parallel to all of the above,
   sequence after A for narrative coherence, not a hard technical dependency
```

Recommended first PR: **Workstream A alone.** It's small, removes the active drift risk (vendored skills already disagreeing with the plugin), and unblocks everything else. Workstream C should follow immediately since B is gated on it.

---

## 7. Open questions for the user

1. **Tracking `.adlc/tickets.json` in booster's own repo (Workstream E):** the plugin's `/adlc-init` docs suggest tracking it; does booster want its own tickets file committed, or generated fresh per session?
2. **`ADLC_PROVIDER=agy` scope:** today this env var routes general `@adlc` tool calls through the Antigravity session/quota. Workstream B additionally wants `ADLC_TICKET`/`ADLC_P4_ENFORCEMENT` set per-worktree during scheduler-driven builds — confirm these compose without conflict (a worker's `agy --print` invocation setting its own scoped env, not the parent scheduler process's).
3. **Workstream F prioritization:** the list is ordered by estimated payoff, not requested urgency — confirm `model-router` and `flail-detector` (replacing existing bespoke heuristics) are the right first two versus, say, `gate-manifest` (net-new audit capability) landing first to support Workstream E's CI story.
4. **CI gate scope (Workstream E, task 5):** booster has no test/build CI today. Confirm this should gate on the existing `npm test` (74 unit/integration tests) or whether a broader smoke-run-against-a-fixture-repo gate is wanted before this ships as a required check.

---

## 8. Appendix — file reference map

| File (this repo) | Role today | Workstream touching it |
|---|---|---|
| `lib/bootstrap.mjs` | Vendored skill installer | A |
| `skills/adlc-{doctrine,prosecutor,self-orchestrate}/` | Vendored, drifting copies | A (deleted) |
| `lib/scheduler.mjs` | Worktree fan-out, post-hoc rail check, merge/rollback | B, D (evidence feed only) |
| `lib/worktrees.mjs` | Worktree lifecycle | B |
| `lib/plan.mjs` | Brain → `plan.json` compiler, native coldstart/parallax/premortem | C, F (model-router/merge-forecast) |
| `lib/preflight.mjs` | Transitive scope-overlap + coldstart forecasting | F (merge-forecast cross-check) |
| `lib/prosecute.mjs` | Cross-model prosecution dispatch | D |
| `lib/charters.mjs` | Prompt charters for builder/prosecutor/fix/regen | D (evidence injected into prompts here) |
| `lib/review.mjs` | `agb review` lens fleet | F (review-calibration) |
| `lib/pools.mjs` | Quota-pool tier heuristics | F (model-router) |
| `lib/lock.mjs` | Merge-lock correctness (hardened, 7 adversarial-review rounds) | E (candidate frozen rail) |
| `lib/gates.mjs` | Sandbox build/test gate execution | E (candidate frozen rail) |
| `docs/guidelines.md` | Architectural doctrine doc | A, C, F (each workstream documents its change here) |
| `.github/workflows/publish.yml` | npm publish only | E (add a real CI gate alongside it) |
| (new) `.adlc/` | ADLC workspace for this repo | E |
| (new) `.github/workflows/adlc-rails-guard.yml` | CI rails gate for this repo | E |
| (new) `lib/adlc-bridge.mjs` | `plan.json` ⇄ `.adlc/tickets.json` projection | C |

**External reference paths used throughout this document** (verify they still resolve before starting — this repo depends on `../adlc` as a sibling checkout, so these are load-bearing, not just documentation links):
- `../adlc/plugins/adlc-antigravity/` — the plugin itself
- `../adlc/docs/integrations/antigravity.md` — plugin's own integration doc (P0–P7 table, hook contract appendix)
- `../adlc/docs/ci/rails-guard.yml` — CI gate template
- `../adlc/scripts/rails-guard-ci.mjs` — the CI gate implementation
- `../adlc/packages/core` — `@adlc/core`, booster's existing dependency
- `@adlc/cli` (global install, `adlc --version` → confirmed 1.1.0 present in this environment)
