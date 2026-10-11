# release-audit workflow script

Build a runnable copy with `scripts/release-audit-workflow.mjs`, which injects the
collected document as `INPUT_DOC` and emits a self-contained script. Hand that file
to the **Workflow** tool as `scriptPath`; no `args` are needed.

The script still accepts `args` when one is supplied, so it stays parameterised —
but embedding is the normal path, because `args` must be transcribed inline into the
tool call and the collected document is tens of kilobytes.

A workflow script has no filesystem and no `child_process` — it can only read
`args`. Every mechanical fact it needs is therefore collected by
`scripts/release-audit-collect.mjs` first. The subagents it spawns *do* have tools
and read the repository directly.

```javascript
export const meta = {
  name: 'release-audit',
  description: 'Per-surface production-readiness audit of antigravity-booster before a release',
  phases: [
    { title: 'Audit', detail: 'one agent per shipped surface, plus the suite-level agents' },
    { title: 'Verify', detail: 'a refute pass over every blocker candidate' },
  ],
}

// <<INPUT_DOC>>

// `args` when the Workflow tool is given one; otherwise the document the build
// step embedded above. Embedding is the normal path: `args` must be transcribed
// inline into the tool call, and the collected document is tens of kilobytes.
const input = (typeof args !== 'undefined' && args) || INPUT_DOC
const FILTERED = input.filtered === true
const PKG = input.package || 'antigravity-booster'

const FINDING = {
  type: 'object',
  additionalProperties: false,
  required: ['bucket', 'klass', 'title', 'body', 'file', 'line', 'evidence', 'consequence', 'recommendation', 'blocker_test'],
  properties: {
    bucket: { type: 'string', enum: ['BLOCKER', 'SHOULD-FIX', 'BACKLOG'] },
    klass: {
      type: 'string',
      enum: ['false-green', 'install-first-run', 'undeclared-breaking-change', 'trust-boundary',
             'secrets', 'data-loss', 'doc-claim', 'dependency', 'unclassified'],
    },
    title: { type: 'string' },
    body: { type: 'string' },
    file: { type: ['string', 'null'], description: 'repo-relative path, e.g. lib/scheduler.mjs or dist/hooks/pre-tool-use.bundle.mjs' },
    line: { type: ['integer', 'null'] },
    evidence: { type: 'string', description: 'VERBATIM quote from the cited file. Checked mechanically.' },
    consequence: { type: 'string', description: 'what the user experiences when this bites' },
    recommendation: { type: 'string' },
    blocker_test: {
      type: 'object',
      additionalProperties: false,
      required: ['user_hits_it', 'needs_another_release', 'worse_than_status_quo'],
      properties: {
        user_hits_it: { type: 'boolean' },
        needs_another_release: { type: 'boolean' },
        worse_than_status_quo: { type: 'boolean' },
      },
    },
  },
}

const REPORT = {
  type: 'object',
  additionalProperties: false,
  required: ['unit', 'files_examined', 'findings', 'issue_verdicts', 'notes'],
  properties: {
    unit: { type: 'string' },
    files_examined: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: FINDING },
    issue_verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'verdict', 'rationale'],
        properties: {
          number: { type: 'integer' },
          verdict: { type: 'string', enum: ['still-reproducible', 'already-fixed-close-it', 'real-but-not-blocking', 'cannot-determine'] },
          rationale: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'refutation'],
  properties: {
    refuted: { type: 'boolean' },
    refutation: { type: 'string' },
  },
}

const CLASSES = `
Hunt these, in this priority order. The first is this product's signature risk:
antigravity-booster is a set of GATES around an agent fleet (rails, sandbox,
run lock, vendored-adlc authentication, a PreToolUse policy guard), and a gate's
catastrophic failure is not a crash — it is reporting clean when it should deny.

1. FALSE-GREEN / FAIL-OPEN — an ENFORCEMENT gate that passes when it should
   deny, or fails OPEN on malformed, empty, or absent input. AGENTS.md draws the
   line: AUDIT gates (gate-manifest, flail-detector) may degrade to
   { ok: false, error } and warn; ENFORCEMENT gates (rails-guard with active
   rails, the policy guard, run-integrity, vendored adlc digests, the run lock)
   must fail CLOSED. Includes: a degraded audit gate that forgets to say it
   degraded; "agb doctor" printing OK for a check that could not run; a snapshot
   diff that compares nothing and reports unchanged; a sandbox probe that
   skips and passes.
2. INSTALL / FIRST-RUN — what breaks for someone running
   "agy plugin install <git-url>" (NO npm install happens: only committed
   dist/ bundles, vendor/, and the files named in package.json "files" exist),
   or "npm i -g ${PKG}", or "agb bootstrap" / "agb migrate". A bundle that
   imports anything but Node built-ins; a path in hooks.json, mcp_config.json or
   plugin.json that does not exist in the tree; bin/hook-runner.sh and
   bin/node-launcher.sh under a stripped GUI PATH with no Node >= 22.19 on it;
   a migrate/rollback state table with a hole; Windows path handling.
3. UNDECLARED BREAKING CHANGE — a CLI flag or exit code (doctor exits 1), an
   MCP tool's input schema or serverInfo, the hook's verdict shape, plan.json
   or the events schema, or the plugin contract (adlcContract) that changed
   since the baseline tag without being called out in CHANGELOG.md.
4. TRUST BOUNDARY — the policy guard runs on EVERY tool call with the ambient
   environment; the vendored adlc digest pins; every AGB_*/ADLC_* override that
   the bundled build (__AGB_BUNDLED__) must ignore; worktree hooks disabled;
   bwrap sandbox enforcement; anything that lets the TARGET repository
   influence the tool reviewing it.
5. SECRETS — ADLC_MANIFEST_KEY, tokens, or signing material reaching a log,
   hooks.log, an events file, a sidecar response, or an error message.
6. DATA LOSS — the run lock and stale-reclaim path, migration snapshots and
   rollback, writes to the ticket store or manifest, worktree removal, a
   non-atomic rewrite that can truncate on interrupt.
7. DOC-CLAIM — README/USAGE stubs, website/content/docs, commands/*.md,
   agents/*.md or a SKILL.md that documents behaviour the code does not have.
   Users act on documented behaviour, so a false claim is a real defect.
8. DEPENDENCY — package.json has NO runtime dependencies by design and the
   bundles must contain only Node built-ins; anything that would need
   node_modules at runtime, or a devDependency imported by shipped code.
`

const BLOCKER_TEST = `
MOST FINDINGS ARE NOT BLOCKERS. Bucket a finding BLOCKER only when all three are
true, and assert each one explicitly in blocker_test:

  user_hits_it            — someone running "agy plugin install <git-url>",
                            "npm i -g ${PKG}@${input.version}" or "agb migrate"
                            actually encounters it. Not "could in theory".
  needs_another_release   — it cannot be fixed after the fact; correcting it
                            requires cutting a new release.
  worse_than_status_quo   — it is worse than what ${input.since || 'the last release'}
                            already shipped. A long-standing wart that is no worse
                            than last release is SHOULD-FIX, not a blocker.

If any of the three is false, the bucket is SHOULD-FIX (ship, eyes open) or
BACKLOG (file it, move on). A report where everything is a BLOCKER is a report
nobody can act on, and will be treated as noise.
`

const HONESTY = `
files_examined must list every file you actually read. It is checked. An empty
list is treated as a hollow report — "I found nothing" from an agent that read
nothing is not a clean bill of health, and it forces the whole audit to NO-GO.

evidence must be a VERBATIM quote from the file named in \`file\`. It is verified
mechanically against the real file; a finding whose quote is not there is demoted
out of BLOCKER regardless of how right it sounds. Quote the code, do not
paraphrase it.

If you cannot determine something, say so in notes. "Could not check" must never
be reported as "verified".
`

function issueBlock(issues) {
  if (!issues || issues.length === 0) return 'No open GitHub issues routed to this surface.\n'
  const lines = issues.map((i) =>
    `- #${i.number} [${(i.labels || []).join(', ') || 'no labels'}] ${i.title}\n  ${i.url}\n  routed via ${i.routedVia}`)
  return `Open GitHub issues routed here. For EACH, return an issue_verdicts entry saying whether it
still reproduces in the code as it stands, is already fixed and should be closed, is real
but not release-blocking, or cannot be determined. Read the code before answering.

${lines.join('\n')}
`
}

function churnBlock(c) {
  if (!c) return 'No churn data.\n'
  if (c.unconsultable) return `Churn since ${c.since || 'baseline'} could not be read: ${c.unconsultable}\n`
  if (c.commits === 0) return `Unchanged since ${c.since}. Audit it anyway — a landmine that shipped three releases ago is still a landmine.\n`
  return `Changed since ${c.since}: ${c.commits} commit(s) across ${c.filesChanged} file(s). Weight these, but audit the whole surface.
${(c.subjects || []).map((s) => `  ${s}`).join('\n')}
`
}

function unitPrompt(u) {
  const hookNote = u.kind === 'hook' ? `
THIS IS THE PRETOOLUSE POLICY GUARD, so it carries the hook surface — code that
returns deny/ask decisions for every tool call in every agy session, with the
ambient environment in scope, launched by bin/hook-runner.sh under a 9 s
watchdog through bin/node-launcher.sh. That is where false-green is
catastrophic: a hook that fails OPEN silently disables every rail for an entire
session, and a hook that fails CLOSED wrongly can deny every mutating tool call.
Booster never emits "allow". Read every hook entrypoint, in hooks/ AND in the
committed dist/hooks/pre-tool-use.bundle.mjs that actually runs. Check what
happens on malformed input, absent input, a wrapper timeout, a stripped PATH
with no trusted Node, and "agy -p" print mode (where ask degrades to allow, so
protection there is deny-only).
` : ''
  const railNote = (u.rails || []).length ? `
STANDING RAILS: ${u.rails.join(', ')} are frozen (AGENTS.md P3) and hardened over
repeated adversarial rounds. Audit them as read-only; do not recommend edits to
them lightly, and say explicitly if a finding would require changing one.
` : ''
  const missingNote = (u.missingPaths || []).length ? `
WARNING: these declared paths do not exist in the tree: ${u.missingPaths.join(', ')}.
Treat that as a finding in its own right if anything (hooks.json, mcp_config.json,
package.json "files", a command doc) still refers to them.
` : ''

  return `You are auditing ONE shipped surface of ${PKG} for production readiness
before release ${input.version}.

SURFACE: ${u.label} (${u.id})
  paths:      ${u.paths.join(', ')}
  ${u.fileCount} files, ${Math.round(u.bytes / 1024)} KB
${hookNote}${railNote}${missingNote}
${churnBlock(u.churn)}
${issueBlock(u.issues)}
Read the surface directly with your tools — source, the committed dist/ bundle
where one exists, tests under test/, and whatever docs describe it (README.md,
commands/*.md, website/content/docs). Do not audit from this prompt alone; it is
an index, not the code.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report. unit must be exactly "${u.id}".`
}

const SUITE_SPECS = [
  {
    id: 'suite:drift',
    label: 'suite:drift',
    prompt: `You audit CROSS-SURFACE DRIFT for ${PKG} before release ${input.version}.
No single-surface agent can see what you are looking for.

1. BUNDLES vs SOURCE. dist/agb.mjs, dist/mcp-server.mjs and
   dist/hooks/pre-tool-use.bundle.mjs are committed esbuild output of
   bin/agb.mjs, mcp/server.mjs and hooks/pre-tool-use.mjs. The mechanical probe
   rebuilt and diffed them (result below). Look for what a byte diff cannot
   see: a feature or fix in lib/ that the bundle visibly lacks, or a
   __AGB_BUNDLED__ branch whose bundled behaviour differs from the unbundled one
   in a way the tests do not cover.
2. VENDORED ADLC. vendor/adlc is a booster-owned bundle of eight adlc verbs,
   pinned by digest in lib/adlc-bridge.mjs KNOWN_VENDORED_ADLC; the version it
   claims must match the @adlc/* devDependencies it was built from.
   vendor/cache/adlc-antigravity-<v>.tgz must be the version package.json pins.
3. MANIFEST WIRING. hooks.json, mcp_config.json and plugin.json name paths and
   commands; every one must exist in the tree and in package.json "files".
   plugin.json version must equal package.json (D11 lockstep). commands/*.md
   and agents/*.md must describe commands and agents the CLI actually has.
4. WEBSITE PARTIALS. website/generated/*.mdx are generated from the CLI and
   CHANGELOG.md by website/scripts/gen-reference.mjs; the probe ran --check.
   Look for generated content that is current but WRONG (a generator reading
   the wrong source).
5. AGENTS.md CLAIMS. AGENTS.md states pinned facts (plugin contract version,
   resolution chain, vendored tarball rules). Check each against the code.

The mechanical probes already run and reported:
  lockstep:         ${JSON.stringify(input.probes.lockstep || [])}
  vendored digests: ${JSON.stringify(input.probes.vendoredDigests || [])}
  vendored tarball: ${JSON.stringify(input.probes.vendoredTarball || [])}
  bundle drift:     ${JSON.stringify(input.probes.bundleDrift || [])}
  website partials: ${JSON.stringify(input.probes.websiteGen || [])}
  could not run:    ${JSON.stringify(input.probes.unconsultable || [])}
Do not re-report those; look for what they cannot see.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "suite:drift".`,
  },
  {
    id: 'suite:docs',
    label: 'suite:docs',
    prompt: `You audit DOCUMENTATION ACCURACY for ${PKG} before release ${input.version}.
Users act on documented behaviour, so a doc that describes behaviour the code does not have
is a real defect, not a cosmetic one.

1. CHANGELOG.md — is there an Unreleased section describing what actually landed
   since ${input.since || 'the last release'}? Are breaking changes (flags, exit
   codes, removed hooks, schema changes) called out as breaking? The /release
   skill promotes Unreleased to ${input.version} by hand, so a missing or wrong
   entry ships as the release notes.
2. THE DOCS SITE — website/content/docs is the canonical documentation
   (README.md, USAGE.md, ARCHITECTURE.md and docs/*.md are stubs pointing at
   it). For the documented commands, flags, exit codes, environment variables
   and install steps, confirm the code agrees. website/scripts/stale-claims.json
   lists claims already known to rot; check whether any has rotted again.
3. INSTALL INSTRUCTIONS — the git-URL install, "agb bootstrap", "agb migrate"
   and "agb migrate --rollback" as documented versus what lib/bootstrap.mjs,
   lib/migrate.mjs and lib/doctor.mjs actually do, including the Node floor and
   the ~/.local/bin/agb shim.
4. SHIPPED PROSE — commands/*.md, agents/*.md, skills/*/SKILL.md and
   hooks.json descriptions are installed into the user's agy; a wrong claim
   there is a claim the user's agent will act on.
5. SECURITY.md and CONTRIBUTING.md claims about sandboxing, dependencies and
   versions.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "suite:docs".`,
  },
  {
    id: 'suite:supply',
    label: 'suite:supply',
    prompt: `You audit SUPPLY CHAIN AND RELEASE MECHANICS for ${PKG} release ${input.version}.

1. DEPENDENCIES — package.json must have NO runtime dependencies; every
   @adlc/* devDependency must be exact-pinned; the four bundles must contain only
   Node built-ins (scripts/check-bundle-externals.mjs enforces this — read it and
   look for what it cannot see, such as a dynamic import or a require of a
   non-builtin by computed name). Check engines against the syntax used.
2. RELEASE WORKFLOW — read .github/workflows/publish.yml and
   .claude/release-profile.md. The standard is a human-approved deployment on
   the npm-publish environment plus OIDC trusted publishing with no NPM_TOKEN at
   any scope. Confirm the publish job is the gated job, that it requests
   id-token: write, that it refuses a tag not on origin/main and a tag that
   disagrees with package.json, and that nothing in this release weakens any of
   that.
3. CI GATES — ci.yml (test matrix, coverage:check, plugin-integrity: bundle
   drift, shellcheck, vendored tarball byte-identity), adlc-rails-guard.yml,
   release-drift.yml and docs.yml. Every action must be SHA-pinned. Look for a
   gate that can be skipped by a path filter, a job that fails open on a missing
   tool, or a workflow a PR could rewrite without a CODEOWNERS review.
4. PACKAGING — package.json "files" versus what the plugin and the CLI import
   at runtime; bin.agb pointing at the committed dist/agb.mjs; the tarball
   contents a user gets from "npm pack".
5. PROVENANCE — the last release's npm metadata carries a SLSA provenance
   attestation; confirm nothing here (repository.url, publishConfig) would make
   the next publish fail sigstore and strand the tag.

The mechanical probes already run and reported:
  vendored tarball: ${JSON.stringify(input.probes.vendoredTarball || [])}
  release drift:    ${JSON.stringify(input.probes.releaseDrift || [])}
  shellcheck:       ${JSON.stringify(input.probes.shellcheck || [])}
  could not run:    ${JSON.stringify(input.probes.unconsultable || [])}
Do not re-report those; look for what they cannot see.
${CLASSES}
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "suite:supply".`,
  },
]

// The issue sweep is SHARDED. One agent asked to read the code behind a whole
// backlog will skim or report nothing examined; the collector therefore batches
// them and each batch gets its own agent. The shard ids must match what the
// synthesizer expects in expectedSuiteUnits(), or coverage fails closed on a
// phantom unit.
const SWEEP_BATCHES = input.issues?.sweepBatches || [[]]
const SWEEP_SPECS = SWEEP_BATCHES.map((batch, idx) => {
  const id = `suite:issues:${idx + 1}`
  return {
    id,
    label: id,
    prompt: `You are ISSUE SWEEP SHARD ${idx + 1} of ${SWEEP_BATCHES.length} for ${PKG} release ${input.version}.

These issues either belong to no single surface, or are labelled bug / security
or titled [P0] / [P1] and therefore get a second read from you even if a surface
agent also saw them. Nobody else is looking at this batch.

${batch.map((i) => `- #${i.number} [${(i.labels || []).join(', ') || 'no labels'}] ${i.title}\n  ${i.url}\n  ${i.routedTo ? `also routed to ${i.routedTo}` : `unrouted (${i.routedVia})`}`).join('\n') || '(this shard is empty — return an empty report)'}

For EVERY issue above, read the relevant code and return an issue_verdicts entry:
still-reproducible / already-fixed-close-it / real-but-not-blocking / cannot-determine.
Do not answer from the issue text alone — open the code it describes. An issue that was
quietly fixed months ago and never closed is a useful finding, and you are the only one
positioned to notice. The 1.1.0 lock reclaim fix (#54) is a precedent: check whether the
issue is still open only because nobody closed it.

Then raise a finding for any issue that genuinely blocks release ${input.version}.

No milestone in this repo names a version, so no existing label tells you what must ship
before ${input.version}. Judge from the code and the issue, not from the backlog's triage.
${BLOCKER_TEST}
${HONESTY}
Return the structured report with unit exactly "${id}".`,
  }
})

// One work item per shipped surface, plus the suite agents. A narrowed run
// (--units) skips the suite agents, and the synthesizer caps such a run below GO.
const WORK = [
  ...input.units.map((u) => ({ id: u.id, label: u.id, prompt: unitPrompt(u) })),
  ...(FILTERED ? [] : [...SUITE_SPECS, ...SWEEP_SPECS]),
]

log(`auditing ${WORK.length} units of ${PKG} for ${input.version} (baseline ${input.since || 'none'})`)

const reports = await pipeline(
  WORK,
  (spec) => agent(spec.prompt, { label: spec.label, phase: 'Audit', schema: REPORT }),

  // Refute pass, per unit, as soon as THAT unit finishes — no barrier. Only
  // blocker candidates pay for it, so the cost tracks how alarming the audit was,
  // not how big the repo is. A refuted finding is marked, never deleted: the
  // synthesizer demotes it to SHOULD-FIX so a human can still disagree.
  async (report, spec) => {
    if (!report) return null
    const candidates = (report.findings || []).filter((f) => f.bucket === 'BLOCKER')
    if (candidates.length === 0) return report
    const verdicts = await parallel(candidates.map((f) => () =>
      agent(
        `A release audit of ${spec.id} claims this is a RELEASE BLOCKER for ${PKG} ${input.version}.
Your job is to REFUTE it. Read the actual code and find the reason it is not blocking:
the path is unreachable, the input cannot occur, a caller already guards it, the quoted
evidence does not mean what the claim says, a test already pins the safe behaviour, or it
is no worse than what ${input.since || 'the last release'} already shipped.

CLAIM:      ${f.title}
CLASS:      ${f.klass}
WHERE:      ${f.file || '(no file)'}${f.line ? `:${f.line}` : ''}
EVIDENCE:   ${f.evidence}
BODY:       ${f.body}
CONSEQUENCE:${f.consequence}

Set refuted=true only if you can point at the specific reason it does not block, and say
what that reason is. If it genuinely blocks the release, set refuted=false and say why the
refutation attempt failed. Do not refuse to refute merely because the claim sounds serious.`,
        { label: `refute:${spec.id}`, phase: 'Verify', schema: VERDICT },
      )))
    const findings = candidates.map((f, i) => {
      const v = verdicts[i]
      return v ? { ...f, refuted: v.refuted === true, refutation: v.refutation } : f
    })
    const untouched = (report.findings || []).filter((f) => f.bucket !== 'BLOCKER')
    return { ...report, findings: [...findings, ...untouched] }
  },
)

const kept = reports.filter(Boolean)
log(`${kept.length}/${WORK.length} units reported`)
return { reports: kept }
```
