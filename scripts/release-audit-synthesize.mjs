#!/usr/bin/env node
// release-audit-synthesize — Phase C of /release-audit: turn the agent reports
// into one defensible GO / GO-WITH-RISK / NO-GO.
//
// WHY THE VERDICT IS COMPUTED HERE AND NOT BY A MODEL. The whole audit exists to
// surface release blockers, and the cheapest way to lose one is to hand a dozen
// structured reports to a summarizing agent and let it decide what was worth
// mentioning. Bucketing, grounding, dedup and the verdict are therefore plain
// arithmetic over the reports. A model may narrate this output; it is
// structurally unable to drop an item from it.
//
// THE DEMOTION RULES, and why each demotes rather than deletes:
//   ungrounded — the finding's quoted evidence does not appear in the file it
//     cites, so the reasoning rests on text the agent did not read.
//   refuted    — a second agent, asked to break the finding, broke it.
//   hollow     — the unit report lists no files examined. "I found nothing" from
//     an agent that read nothing is not a clean bill of health.
//   unasserted — a BLOCKER whose three-part blocker test is not fully asserted
//     is a severity claim the agent never actually made.
// None of these deletes a finding. A deleted finding is unreviewable; a demoted
// one still appears, with the demotion named, and a human can disagree.
//
// FAIL-CLOSED COVERAGE. A shipped surface whose agent produced no report at all
// forces NO-GO. "Could not check" must never render as "verified".
//
// Usage:
//   node scripts/release-audit-synthesize.mjs --input <collect.json>
//                                             --reports <workflow-output.json>
//                                             [--suite <npm-test-log>]
//                                             [--json <out.json>]

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const BUCKETS = ['BLOCKER', 'SHOULD-FIX', 'BACKLOG'];

/**
 * The suite-level agents, which audit what no single-surface agent can see.
 * Expected in coverage exactly like a surface: a missing suite report is an
 * unaudited surface, not a quiet omission.
 */
export const SUITE_UNITS = ['suite:drift', 'suite:docs', 'suite:supply'];

/**
 * Every suite-level unit this run must hear from: the three fixed agents plus
 * one issue-sweep shard per batch the collector produced. The shard count is
 * data, not a constant, and coverage has to expect exactly the agents that were
 * actually dispatched or every run fails closed for a reason nobody can find.
 */
export function expectedSuiteUnits(input) {
  const batches = input?.issues?.sweepBatches ?? [[]];
  return [...SUITE_UNITS, ...batches.map((_, i) => `suite:issues:${i + 1}`)];
}

/**
 * Probe problems that block a release outright, versus ones a release can ship
 * past with eyes open.
 *
 *   lockstep        — plugin.json/package.json/lockfile disagree: the git-URL
 *                     install and the npm install would ship different versions,
 *                     and the publish job refuses the tag anyway.
 *   vendoredDigests — vendor/adlc no longer matches the digests pinned in
 *                     lib/adlc-bridge.mjs: every adlc call in the bundled plugin
 *                     fails closed as vendored-adlc-tampered. Nothing works.
 *   vendoredTarball — the bootstrap tarball is not the pristine registry release.
 *   bundleDrift     — dist/ or vendor/ is stale: users run code that lib/ no
 *                     longer says.
 *   releaseDrift    — the PREVIOUS release is stranded; cutting on top skips a
 *                     version on npm.
 *   websiteGen      — the Docs workflow goes red on main; the npm artifact is fine.
 *   shellcheck      — CI will fail on it, but it is a lint, not a user-facing break.
 */
export const PROBE_SEVERITY = {
  lockstep: 'BLOCKER',
  vendoredDigests: 'BLOCKER',
  vendoredTarball: 'BLOCKER',
  bundleDrift: 'BLOCKER',
  releaseDrift: 'BLOCKER',
  websiteGen: 'SHOULD-FIX',
  shellcheck: 'SHOULD-FIX',
};

/** What a user experiences when each probe's problem ships. */
const PROBE_CONSEQUENCE = {
  lockstep: 'the git-URL plugin install and the npm install report different versions, and publish.yml refuses the tag',
  vendoredDigests: 'every adlc call in the installed plugin fails closed (vendored-adlc-tampered): run, review, plan, preflight, prosecute and doctor all stop',
  vendoredTarball: 'agb bootstrap installs a tarball that is not the pristine @adlc/antigravity release',
  bundleDrift: 'the committed bundle users run does not match the source that was reviewed and tested',
  releaseDrift: 'the previous version never reached npm; a new release on top skips it entirely',
  websiteGen: 'the Docs workflow gen-check job fails on main after the release merges',
  shellcheck: 'CI plugin-integrity fails on the shell launchers',
};

/** Where to look for the check that produced each probe finding. */
const PROBE_SOURCE = {
  lockstep: 'scripts/release-audit-collect.mjs lockstepProblems; .claude/release-profile.md bumpSites',
  vendoredDigests: 'scripts/update-adlc-digests.mjs (re-pin with --write only after the lockfile check passes)',
  vendoredTarball: 'npm pack @adlc/antigravity@<pinned> and compare; AGENTS.md amendment D6',
  bundleDrift: 'npm run build && git status --porcelain dist/ vendor/ (CI plugin-integrity)',
  releaseDrift: 'scripts/release-drift.mjs (the message names the exact recovery)',
  websiteGen: 'cd website && node scripts/gen-reference.mjs',
  shellcheck: 'shellcheck -s sh bin/node-launcher.sh bin/hook-runner.sh',
};

/**
 * Whether a finding's three-part blocker test is fully asserted. Shared, because
 * dedup and demotion must agree on what counts as a supported severity claim.
 */
export function blockerTestAsserted(t) {
  return Boolean(t && t.user_hits_it === true && t.needs_another_release === true && t.worse_than_status_quo === true);
}

export function parseArgs(argv) {
  const out = { input: null, reports: null, suite: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') { out.input = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--reports') { out.reports = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--suite') { out.suite = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--json') { out.json = argv[i + 1] ?? null; i += 1; continue; }
  }
  return out;
}

/**
 * Read node --test's own summary out of a captured `npm test` log.
 *
 * Both reporters are accepted: `spec` (what a terminal and, on this Node line, a
 * pipe get) prints `ℹ tests N` / `ℹ fail N` and marks failures `✖ name`; `tap`
 * (what GitHub Actions captures) prints `# tests N` / `# fail N` and
 * `not ok N - name`. Deliberately does NOT infer success from the absence of
 * failure markers: a suite killed before it printed a summary would then read
 * as green. No summary line means `ran: false`.
 */
export function parseSuiteResult(text) {
  const s = String(text ?? '');
  const num = (label) => {
    const m = new RegExp(`^[ \\t]*(?:ℹ|#)[ \\t]+${label}[ \\t]+(\\d+)[ \\t]*$`, 'm').exec(s);
    return m ? Number(m[1]) : null;
  };
  const total = num('tests');
  const fail = num('fail');
  if (total === null || fail === null) {
    return { ran: false, green: false, passed: null, total: null, failed: [], reason: 'no node --test summary (tests/fail counts) in suite log' };
  }
  const passed = num('pass');
  const cancelled = num('cancelled') ?? 0;
  const names = new Set();
  for (const m of s.matchAll(/^[ \t]*✖[ \t]+(.+?)(?:[ \t]+\([\d.]+ms\))?[ \t]*$/gm)) {
    if (!/^failing tests:?$/.test(m[1].trim())) names.add(m[1].trim());
  }
  for (const m of s.matchAll(/^[ \t]*not ok[ \t]+\d+[ \t]+-[ \t]+(.+?)(?:[ \t]+#.*)?[ \t]*$/gm)) names.add(m[1].trim());
  const failed = [...names];
  return {
    ran: true,
    green: fail === 0 && cancelled === 0 && failed.length === 0,
    passed,
    total,
    failed,
    reason: null,
  };
}

/** Normalize whatever an agent returned into the finding shape the report uses. */
export function normalizeFinding(raw, unit) {
  const bucket = BUCKETS.includes(raw?.bucket) ? raw.bucket : 'BACKLOG';
  return {
    unit,
    bucket,
    originalBucket: bucket,
    klass: String(raw?.klass ?? raw?.category ?? 'unclassified'),
    title: String(raw?.title ?? '(untitled)'),
    body: String(raw?.body ?? ''),
    file: raw?.file ? String(raw.file) : null,
    line: Number.isFinite(raw?.line) ? raw.line : null,
    evidence: typeof raw?.evidence === 'string' ? raw.evidence : '',
    consequence: String(raw?.consequence ?? ''),
    recommendation: String(raw?.recommendation ?? ''),
    blockerTest: raw?.blocker_test ?? raw?.blockerTest ?? null,
    refuted: raw?.refuted === true,
    refutation: raw?.refutation ?? null,
    grounded: null,
    demotions: [],
  };
}

/**
 * Verify a finding's evidence actually occurs in the file it cites. Whitespace
 * is normalized on both sides: an agent quoting source through a JSON round-trip
 * reliably differs in indentation, and failing a true finding on leading spaces
 * would train everyone to ignore the check.
 */
export function groundFinding(finding, { root = ROOT, readFile = readFileSync, exists = existsSync } = {}) {
  if (!finding.file) return { grounded: false, reason: 'no file cited' };
  if (!finding.evidence.trim()) return { grounded: false, reason: 'no evidence quoted' };
  // The cited path comes from a model, so it is untrusted input to a file read.
  // A finding is only ever about a file IN the repository; anything that
  // resolves outside it is malformed by definition, and reading it would turn a
  // grounding check into an arbitrary-file probe.
  const abs = resolve(root, finding.file);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) {
    return { grounded: false, reason: `cited path resolves outside the repository: ${finding.file}` };
  }
  if (!exists(abs)) return { grounded: false, reason: `cited file does not exist: ${finding.file}` };
  let source;
  try { source = readFile(abs, 'utf8'); } catch (err) { return { grounded: false, reason: `unreadable: ${err.message}` }; }
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
  if (flat(source).includes(flat(finding.evidence))) return { grounded: true, reason: null };
  return { grounded: false, reason: 'quoted evidence does not appear in the cited file' };
}

/** Attach the grounding result to every finding, before anything merges them. */
export function groundAll(findings, { root = ROOT, readFile = readFileSync, exists = existsSync } = {}) {
  return findings.map((f) => {
    if (f.grounded !== null && f.grounded !== undefined) return f;
    const g = groundFinding(f, { root, readFile, exists });
    return { ...f, grounded: g.grounded, groundingReason: g.reason };
  });
}

/**
 * Collapse findings that name the same defect in the same place. Grounding runs
 * BEFORE this, and the survivor prefers a grounded member: two agents can find
 * the same defect and quote it differently. Severity merges upward and carries
 * the reasoning that justifies it; evidence merges toward whichever copy checks
 * out; one refuted copy does not refute the defect.
 */
export function dedupeFindings(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = [f.unit, f.file ?? '-', f.line ?? '-', f.title.toLowerCase().replace(/\W+/g, ' ').trim()].join('|');
    const prior = seen.get(key);
    if (!prior) { seen.set(key, { ...f, duplicates: 0 }); continue; }
    prior.duplicates += 1;
    if (BUCKETS.indexOf(f.bucket) < BUCKETS.indexOf(prior.bucket)) {
      prior.bucket = f.bucket;
      prior.originalBucket = f.originalBucket;
      prior.klass = f.klass;
      prior.consequence = f.consequence;
      prior.recommendation = f.recommendation;
    }
    if (blockerTestAsserted(f.blockerTest) && !blockerTestAsserted(prior.blockerTest)) {
      prior.blockerTest = f.blockerTest;
    }
    if (prior.grounded !== true && f.grounded === true) {
      prior.grounded = true;
      prior.groundingReason = null;
      prior.evidence = f.evidence;
      prior.file = f.file;
      prior.line = f.line;
    }
    if (prior.refuted && !f.refuted) { prior.refuted = false; prior.refutation = f.refutation; }
  }
  return [...seen.values()];
}

/** Apply the demotion rules. Never deletes; always records why. */
export function applyDemotions(findings, { root = ROOT, readFile = readFileSync, exists = existsSync, hollowUnits = new Set() } = {}) {
  return findings.map((f) => {
    const out = { ...f, demotions: [...f.demotions] };
    if (out.grounded === null || out.grounded === undefined) {
      const g = groundFinding(out, { root, readFile, exists });
      out.grounded = g.grounded;
      out.groundingReason = g.reason;
    }
    if (!out.grounded) out.demotions.push(`ungrounded: ${out.groundingReason ?? 'evidence not verified'}`);
    if (out.refuted) out.demotions.push('refuted by the verification pass');
    if (hollowUnits.has(out.unit)) out.demotions.push('reported by a unit that examined no files');
    if (out.originalBucket === 'BLOCKER' && !out.mechanical) {
      if (!blockerTestAsserted(out.blockerTest)) out.demotions.push('blocker test not fully asserted');
    }
    if (out.bucket === 'BLOCKER' && out.demotions.length > 0) out.bucket = 'SHOULD-FIX';
    return out;
  });
}

/**
 * Which surfaces were actually audited.
 * `hollow` = a report that examined no files; `missing` = no report at all.
 */
export function unitCoverage(reports, expectedUnitIds) {
  const byUnit = new Map(reports.map((r) => [r.unit, r]));
  const audited = [];
  const hollow = [];
  const missing = [];
  for (const id of expectedUnitIds) {
    const r = byUnit.get(id);
    if (!r) { missing.push(id); continue; }
    const examined = Array.isArray(r.files_examined) ? r.files_examined : (r.filesExamined ?? []);
    if (examined.length === 0) hollow.push(id);
    else audited.push(id);
  }
  return { audited, hollow, missing };
}

/** Turn the mechanical probe results into findings, so nothing lives outside the report. */
export function probeFindings(probes) {
  const out = [];
  for (const [key, bucket] of Object.entries(PROBE_SEVERITY)) {
    for (const problem of probes?.[key] ?? []) {
      out.push({
        unit: 'suite:mechanical',
        bucket,
        originalBucket: bucket,
        klass: `probe:${key}`,
        title: problem.slice(0, 120),
        body: problem,
        file: null,
        line: null,
        // Mechanical checks are their own evidence — they read the tree directly.
        evidence: '',
        consequence: PROBE_CONSEQUENCE[key],
        recommendation: PROBE_SOURCE[key],
        blockerTest: null,
        refuted: false,
        refutation: null,
        grounded: true,
        mechanical: true,
        demotions: [],
      });
    }
  }
  return out;
}

/**
 * The verdict. Fail-closed by construction:
 *   NO-GO        red or unknown suite, a surviving BLOCKER, or a surface nobody audited
 *   GO-WITH-RISK no blockers, but open SHOULD-FIX items, an unconsultable probe,
 *                an untriaged backlog, or a narrowed run
 *   GO           nothing outstanding and everything was actually checked
 */
export function computeVerdict({ findings, coverage, probes, suite, issues, partial = false }) {
  const reasons = [];
  const blockers = findings.filter((f) => f.bucket === 'BLOCKER');

  // An ABSENT suite result is the same epistemic state as one that did not run.
  // Treating null as "fine" would let a caller obtain a GO by omitting --suite.
  if (!suite) reasons.push('no test suite result was supplied (--suite) — the tests are unverified');
  else if (suite.ran && !suite.green) reasons.push(`test suite is red: ${suite.failed.length} failing test(s) — ${suite.failed.slice(0, 8).join(', ')}${suite.failed.length > 8 ? ', …' : ''}`);
  else if (!suite.ran) reasons.push(`test suite result unavailable — ${suite.reason ?? 'no summary line was captured'}`);
  if (blockers.length) reasons.push(`${blockers.length} release blocker(s) survived verification`);
  if (coverage.missing.length) reasons.push(`${coverage.missing.length} shipped surface(s) produced no audit report: ${coverage.missing.join(', ')}`);
  if (coverage.hollow.length) reasons.push(`${coverage.hollow.length} audit report(s) examined no files: ${coverage.hollow.join(', ')}`);
  if (reasons.length) return { verdict: 'NO-GO', reasons };

  const shouldFix = findings.filter((f) => f.bucket === 'SHOULD-FIX');
  const unconsultable = probes?.unconsultable ?? [];
  if (shouldFix.length) reasons.push(`${shouldFix.length} should-fix item(s) open`);
  for (const u of unconsultable) reasons.push(`probe could not run: ${u}`);
  if (probes?.git && probes.git.syncedWithOriginMain === false) reasons.push('HEAD is not origin/main — the audited tree is not what /release would tag');
  if (issues?.unconsultable) reasons.push(`GitHub issues were not triaged: ${issues.unconsultable}`);
  if (issues?.truncated) reasons.push(`the open-issue list hit its fetch limit (${issues.truncated}) — some issues were never routed`);
  if (partial) reasons.push('partial audit (--units) — the unaudited surfaces and the suite-level agents were not run');
  if (reasons.length) return { verdict: 'GO-WITH-RISK', reasons };

  return { verdict: 'GO', reasons: ['no blockers, every shipped surface audited, suite green'] };
}

/** The terse thing a human reads before deciding to cut the release. */
export function renderTerminal(result) {
  const L = [];
  const { verdict, reasons } = result.verdict;
  L.push(`RELEASE AUDIT — ${result.package} ${result.version} (baseline ${result.since ?? 'none'})`);
  L.push(`VERDICT: ${verdict}`);
  for (const r of reasons) L.push(`  · ${r}`);
  L.push('');
  L.push(`surfaces audited ${result.coverage.audited.length}/${result.expectedUnits}`
    + `${result.coverage.hollow.length ? `  hollow ${result.coverage.hollow.length}` : ''}`
    + `${result.coverage.missing.length ? `  missing ${result.coverage.missing.length}` : ''}`);
  L.push(BUCKETS.map((b) => `${b} ${result.findings.filter((f) => f.bucket === b).length}`).join('   '));
  if (result.probes?.bundleRebuilt) L.push('note: the bundle drift probe rebuilt dist/ and vendor/ — check git status before committing anything else');
  const blockers = result.findings.filter((f) => f.bucket === 'BLOCKER');
  if (blockers.length) {
    L.push('');
    L.push('BLOCKERS');
    for (const b of blockers) {
      L.push(`  [${b.klass}] ${b.unit} — ${b.title}`);
      if (b.file) L.push(`      ${b.file}${b.line ? `:${b.line}` : ''}`);
      if (b.consequence) L.push(`      → ${b.consequence}`);
    }
  }
  const demoted = result.findings.filter((f) => f.originalBucket === 'BLOCKER' && f.bucket !== 'BLOCKER');
  if (demoted.length) {
    L.push('');
    L.push(`DEMOTED FROM BLOCKER (${demoted.length}) — reported, not blocking`);
    for (const d of demoted) L.push(`  ${d.unit} — ${d.title}  [${d.demotions.join('; ')}]`);
  }
  return L.join('\n');
}

export function synthesize({ input, reports, suite, root = ROOT, readFile = readFileSync, exists = existsSync }) {
  // A narrowed run (--units) does not run the suite agents, so it must not be
  // held to their coverage — and, by the same token, must never read as GO.
  const expectedUnitIds = [
    ...(input.units ?? []).map((u) => u.id),
    ...(input.filtered ? [] : expectedSuiteUnits(input)),
  ];
  const coverage = unitCoverage(reports, expectedUnitIds);
  const hollowUnits = new Set(coverage.hollow);

  const raw = [];
  for (const r of reports) {
    for (const f of r.findings ?? []) raw.push(normalizeFinding(f, r.unit));
  }
  const grounded = applyDemotions(
    dedupeFindings(groundAll(raw, { root, readFile, exists })),
    { root, readFile, exists, hollowUnits },
  );
  const findings = [...probeFindings(input.probes), ...grounded]
    .sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));

  return {
    schema: 'release-audit-result/booster-1',
    package: input.package ?? 'antigravity-booster',
    version: input.version,
    since: input.since,
    expectedUnits: expectedUnitIds.length,
    coverage,
    suite,
    probes: input.probes,
    issues: input.issues,
    issueVerdicts: reports.flatMap((r) => (r.issue_verdicts ?? r.issueVerdicts ?? []).map((v) => ({ unit: r.unit, ...v }))),
    findings,
    partial: input.filtered === true,
    verdict: computeVerdict({ findings, coverage, probes: input.probes, suite, issues: input.issues, partial: input.filtered === true }),
  };
}

export function synthesizeMain(argv = process.argv.slice(2), { readFile = readFileSync, writeFile = writeFileSync, log = console.log, root = ROOT } = {}) {
  const args = parseArgs(argv);
  if (!args.input || !args.reports) {
    log('usage: release-audit-synthesize --input <collect.json> --reports <workflow.json> [--suite <log>] [--json <out>]');
    return 1;
  }
  const input = JSON.parse(readFile(args.input, 'utf8'));
  const reportDoc = JSON.parse(readFile(args.reports, 'utf8'));
  const reports = Array.isArray(reportDoc) ? reportDoc : (reportDoc.reports ?? []);
  const suite = args.suite ? parseSuiteResult(readFile(args.suite, 'utf8')) : null;

  const result = synthesize({ input, reports, suite, root, readFile });
  if (args.json) writeFile(args.json, JSON.stringify(result, null, 2));
  log(renderTerminal(result));
  return result.verdict.verdict === 'NO-GO' ? 2 : 0;
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(synthesizeMain());
