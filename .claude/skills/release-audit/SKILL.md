---
name: release-audit
description: >-
  Production-readiness audit of antigravity-booster before cutting a release. Audits every
  shipped surface in parallel — the CLI, scheduler, ADLC gates, the PreToolUse policy guard,
  the MCP server, install/migrate, the vendored adlc, shipped skills, the sidecar — plus
  suite-level drift, docs and supply-chain agents, hunting release-BLOCKING issues rather
  than general code smells. Runs this repo's own integrity gates as mechanical probes and
  triages open GitHub issues against the code. Runs on the currently selected model.
  Triggers on "release audit", "are we ready to release", "production readiness", "what's
  blocking the release", "audit before release", "pre-release check", "release blockers",
  "can we ship 1.2".
user-invocable: true
argument-hint: "[version] [--since <tag>] [--units a,b] [--skip-issues] [--skip-build]"
---

# Release Audit

A **GO / GO-WITH-RISK / NO-GO** read on antigravity-booster before a release. Every
shipped surface gets its own agent, in parallel, and the verdict is arithmetic over what
they return — not a model's summary of them.

This is not `/adversarial-review`. That reviews a **diff** and deliberately runs on a
*different* model. This audits **standing state** — a landmine that shipped in 0.8.0 and is
still in `dist/` is exactly what a diff review structurally cannot see — and runs on the
**currently selected model**, with a refute pass as the precision mechanism.

It is a port of adlc's `/release-audit`, reshaped for this repository: adlc gives one agent
per npm package in a lockstep monorepo; booster is **one** npm package that is also a native
agy plugin installed from a git URL with no `npm install`, so the units are the shipped
**surfaces** (declared in `scripts/release-audit-collect.mjs` `UNITS`) and the mechanical
probes are this repo's own gates — the vendored-adlc digest pins, the bundle drift gate,
the vendored tarball integrity, D11 lockstep, the website generator, and the stranded-release
classifier — imported rather than restated.

## When to use

- Before `/release` — the readiness question, asked before the mechanical bump.
- "What is blocking 1.2.0?" / "are we ready to ship?"
- After fixing blockers: re-run narrowed with `--units` (that run can never return GO).

## What counts as a blocker

Three booleans, all of which each agent must assert explicitly:

| test | meaning |
|---|---|
| `user_hits_it` | someone running `agy plugin install <git-url>`, `npm i -g antigravity-booster@<version>` or `agb migrate` actually encounters it |
| `needs_another_release` | it cannot be fixed after the fact |
| `worse_than_status_quo` | it is worse than what the last release already shipped |

Anything failing one of the three is **SHOULD-FIX** (ship, eyes open) or **BACKLOG**. A
BLOCKER that does not carry all three assertions is demoted automatically — the severity
claim was never actually made. Agents are told outright that most findings are not blockers.

Failure classes, in priority order: **false-green / fail-open** (an *enforcement* gate —
rails-guard with active rails, the policy guard, run-integrity, vendored-adlc
authentication, the run lock — passing when it should deny; audit gates may degrade but
must say so) → install/first-run (git-URL install with no `npm install`) → undeclared
breaking change → trust boundary → secrets → data loss → doc-claim → dependency.

## Procedure

### 1. Start the background suite

The agents run for minutes and are read-only, so the test suite is free if it runs
alongside them. Launch it first, in the background, capturing to a log:

```bash
npm test > <scratch>/suite.log 2>&1
```

`<scratch>` is the session scratchpad directory, not `/tmp`. The synthesizer reads node's
own `ℹ tests N` / `ℹ fail N` summary (or the TAP `# tests` / `# fail` form); a log with no
summary counts as not-run, never as green. A red suite makes the verdict NO-GO no matter
what the agents find.

### 2. Collect (Phase A)

```bash
node scripts/release-audit-collect.mjs [version] [--since <tag>] [--units a,b] [--skip-issues] [--skip-build] \
  > <scratch>/input.json
node scripts/release-audit-collect.mjs [same flags] --workflow-args > <scratch>/wargs.json
```

This inventories the nine declared surfaces, computes per-surface churn since the baseline
tag, routes open GitHub issues to surfaces (path mentions → ADLC ticket scope → `agb <cmd>`
tokens; ambiguity routes to nobody), and runs the mechanical probes:

| probe | severity | what it imports |
|---|---|---|
| lockstep | BLOCKER | plugin.json, package.json, package-lock.json versions agree (D11) |
| vendoredDigests | BLOCKER | `computeVendoredDigests()` vs `KNOWN_VENDORED_ADLC` in `lib/adlc-bridge.mjs` |
| vendoredTarball | BLOCKER | `vendor/cache/adlc-antigravity-<v>.tgz` SHA-512 vs the lockfile integrity |
| bundleDrift | BLOCKER | `npm run build` then `git status dist/ vendor/` — CI's plugin-integrity gate |
| releaseDrift | BLOCKER | `classifyDrift()` from `scripts/release-drift.mjs` — is the *previous* release stranded? |
| websiteGen | SHOULD-FIX | `website/scripts/gen-reference.mjs --check` |
| shellcheck | SHOULD-FIX | `shellcheck -s sh bin/*.sh`, unconsultable when not installed |

**`bundleDrift` rebuilds `dist/` and `vendor/`.** It therefore runs only on a clean tree
(a dirty tree records it as unconsultable) and records `bundleRebuilt: true`. If it reports
drift, the rebuilt bundles are now in your working tree — that is the fix, and also the
reason not to run the audit on top of uncommitted work. `--skip-build` skips it and the
verdict names the gap.

Defaults: version = next minor from `package.json`; baseline = newest `vX.Y.Z` tag.

Two outputs, deliberately: `input.json` is the full document Phase C builds the report from,
and `wargs.json` is the projection the fan-out consumes (it drops the per-surface file
inventory and issue excerpts). Never pass `input.json` as `args`.

### 3. Fan out (Phase B)

Build a self-contained script and hand the Workflow tool its path:

```bash
node scripts/release-audit-workflow.mjs --input <scratch>/wargs.json --out <scratch>/workflow.mjs
```

```
Workflow({ scriptPath: "<scratch>/workflow.mjs" })
```

No `args` are passed. The builder embeds the collected document as `INPUT_DOC`, so nothing
has to be transcribed into the tool call. Issue titles are written by anyone who can open an
issue and are embedded verbatim, so `<`, U+2028 and U+2029 are escaped on the way in.

Invoking this skill **is** the opt-in for multi-agent orchestration, and a full run
deliberately exceeds the default workflow size guideline — nine surface agents, three suite
agents, one sweep shard per twelve issues, plus one refute agent per blocker candidate.
Auditing each surface individually is the point. Write the workflow's returned
`{ reports: [...] }` to `<scratch>/reports.json`.

A workflow script has no filesystem and no `child_process`; it reads only `args`. That is
why Phase A exists and why the script needs no editing between runs.

### 4. Synthesize (Phase C)

```bash
node scripts/release-audit-synthesize.mjs \
  --input <scratch>/input.json \
  --reports <scratch>/reports.json \
  --suite <scratch>/suite.log \
  --json <scratch>/release-audit-<version>.json
```

Exit `0` = GO or GO-WITH-RISK, `2` = NO-GO, `1` = could not run.

`--suite` is not optional in practice: omitting it means nothing is known about the tests,
which is the same state as a suite that did not run, so the verdict is NO-GO. The flag
cannot be skipped to obtain a cleaner result.

It grounds every finding (the quoted evidence must appear verbatim in the cited file, and
the cited path must resolve inside the repository), dedupes, applies the demotion rules,
folds in the probe results and the suite outcome, and computes the verdict. Print its
terminal output as-is.

### 5. Publish the report

Load the `artifact-design` skill, then build the full report as an HTML page from the
Phase C JSON and publish it with the **Artifact** tool: every surface's section, all three
buckets, the issue-verdict table, demoted findings with their reasons, and the mechanical
baseline. Keep the terminal output terse; the detail lives at the URL.

### 6. Report honestly

Give the verdict and the blockers as the synthesizer computed them. Do not soften a NO-GO,
and do not act on findings — deciding what to fix is the maintainer's call. If the verdict
is GO or GO-WITH-RISK and the maintainer wants to proceed, the next step is `/release`.

## Demotion rules — why nothing is ever deleted

| rule | trigger | effect |
|---|---|---|
| ungrounded | quoted evidence is not in the cited file | BLOCKER → SHOULD-FIX |
| refuted | the verification agent broke the claim | BLOCKER → SHOULD-FIX |
| hollow | the reporting unit examined no files | BLOCKER → SHOULD-FIX |
| unasserted | `blocker_test` is not all three true | BLOCKER → SHOULD-FIX |

A deleted finding is unreviewable. A demoted one still appears, with the demotion named, so
a human can disagree.

## Fail-closed behaviour

- A shipped surface that produced **no report** forces NO-GO. *"Could not check" must
  never render as "verified"* — the rule `scripts/release-drift.mjs` already states.
- A report listing **no files examined** is hollow, not clean, and also forces NO-GO.
- A suite log with **no summary line** counts as not-run, never as green.
- A `--units` run is capped at GO-WITH-RISK — it has nothing to say about what it skipped.
- An **absent** `--suite` is treated exactly like a suite that did not run: NO-GO.
- A failed or skipped `gh issue list` is named in the verdict, so an untriaged backlog can
  never read as "no blocking issues". Same for a fetch that hit its 500-issue limit.
- A probe that could not run (`shellcheck` missing, dirty tree, unreachable npm) is named in
  the verdict as `probe could not run`, and caps the verdict at GO-WITH-RISK.
- HEAD not equal to `origin/main` is named: the audited tree is not what `/release` would tag.
- A finding citing a path outside the repository is rejected rather than read — the cited
  path is model-authored, and grounding must not become an arbitrary-file probe.

## Verification

```bash
node scripts/release-audit-collect.mjs --skip-issues --skip-build | head -20   # emits JSON, exit 0
node --test test/release-audit-*.test.mjs
```

The helpers live flat in `scripts/` with tests in `test/` (the repo's flat `npm test`
layout), and `scripts/` is not in `package.json` `files`, so none of this ships to users.

## Related

- `/release` — the mechanical cut (`.claude/release-profile.md` holds its facts). This
  skill answers whether that should happen.
- `/adversarial-review` — diff-scoped, cross-model. Different question, different scope.
- `scripts/release-drift.mjs` + `release-drift.yml` — the scheduled stranded-release check
  this audit reuses.
- `AGENTS.md` — the ADLC doctrine the probes and prompts encode (P3 rails, P5 prosecution,
  the degrade-vs-fail-closed amendment).
