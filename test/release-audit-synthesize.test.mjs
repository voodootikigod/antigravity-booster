// Tests for scripts/release-audit-synthesize.mjs — Phase C of /release-audit.
//
// The verdict is the product. Everything here exists to prove the same property
// from different angles: the audit fails CLOSED. A red suite, a surviving
// blocker, a surface nobody audited, or a report that examined no files must
// each produce NO-GO — and none of the demotion rules may ever DELETE a finding,
// because a deleted finding is one a human can no longer disagree with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncReal } from 'node:fs';

import {
  BUCKETS,
  SUITE_UNITS,
  PROBE_SEVERITY,
  expectedSuiteUnits,
  blockerTestAsserted,
  parseArgs,
  parseSuiteResult,
  normalizeFinding,
  groundFinding,
  groundAll,
  dedupeFindings,
  applyDemotions,
  unitCoverage,
  probeFindings,
  computeVerdict,
  renderTerminal,
  synthesize,
  synthesizeMain,
} from '../scripts/release-audit-synthesize.mjs';

const PASSING_TEST = { user_hits_it: true, needs_another_release: true, worse_than_status_quo: true };

function finding(over = {}) {
  return normalizeFinding({
    bucket: 'BLOCKER',
    klass: 'false-green',
    title: 'enforcement gate passes on malformed input',
    body: 'the guard treats a parse error as no rails',
    file: 'scripts/release-audit-synthesize.mjs',
    line: 1,
    evidence: 'export const BUCKETS',
    consequence: 'a session runs with no rails',
    recommendation: 'fail closed',
    blocker_test: PASSING_TEST,
    ...over,
  }, over.unit ?? 'surface:policy-guard');
}

const CLEAN_PROBES = { lockstep: [], vendoredDigests: [], vendoredTarball: [], bundleDrift: [], websiteGen: [], releaseDrift: [], shellcheck: [], unconsultable: [], git: { syncedWithOriginMain: true } };
const CLEAN_INPUT = {
  package: 'antigravity-booster',
  version: '1.2.0',
  since: 'v1.1.0',
  units: [{ id: 'surface:policy-guard' }],
  probes: CLEAN_PROBES,
  filtered: false,
};
const GREEN = { ran: true, green: true, failed: [] };
const COVERED = { audited: ['surface:policy-guard'], hollow: [], missing: [] };
const FULL_REPORTS = [
  { unit: 'surface:policy-guard', files_examined: ['hooks/pre-tool-use.mjs'], findings: [], issue_verdicts: [] },
  ...expectedSuiteUnits(CLEAN_INPUT).map((u) => ({ unit: u, files_examined: ['README.md'], findings: [], issue_verdicts: [] })),
];

test('expectedSuiteUnits names the three fixed agents plus one shard per issue batch', () => {
  assert.deepEqual(expectedSuiteUnits({ issues: { sweepBatches: [[], [], []] } }), [...SUITE_UNITS, 'suite:issues:1', 'suite:issues:2', 'suite:issues:3']);
  assert.deepEqual(expectedSuiteUnits({}), [...SUITE_UNITS, 'suite:issues:1'], 'an empty backlog still expects one sweep');
  assert.deepEqual(expectedSuiteUnits({ issues: { sweepBatches: [[]] } }), ['suite:drift', 'suite:docs', 'suite:supply', 'suite:issues:1']);
});

test('parseArgs reads every path flag', () => {
  assert.deepEqual(parseArgs(['--input', 'i.json', '--reports', 'r.json', '--suite', 's.log', '--json', 'o.json']), { input: 'i.json', reports: 'r.json', suite: 's.log', json: 'o.json' });
});

// ─── the suite log ───────────────────────────────────────────────────────────

const SPEC_GREEN = `✔ lock: reclaim is serialized (12.1ms)\n✔ doctor: exits 1 on failure (3ms)\nℹ tests 1487\nℹ suites 9\nℹ pass 1487\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 42098.6\n`;
const SPEC_RED = `✔ lock: ok (1ms)\n✖ doctor: exits 1 on failure (3.2ms)\nℹ tests 1487\nℹ pass 1486\nℹ fail 1\nℹ cancelled 0\n\n✖ failing tests:\n\ntest at test/doctor.test.mjs:10:1\n✖ doctor: exits 1 on failure (3.2ms)\n`;
const TAP_GREEN = `TAP version 13\n# Subtest: lock\nok 1 - lock\n# tests 1487\n# suites 9\n# pass 1487\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 40000\n`;
const TAP_RED = `TAP version 13\nnot ok 2 - doctor: exits 1 on failure\n  ---\n  duration_ms: 3\n  ...\n# tests 1487\n# pass 1486\n# fail 1\n# cancelled 0\n`;

test('parseSuiteResult reads the spec reporter summary node --test prints locally', () => {
  const r = parseSuiteResult(SPEC_GREEN);
  assert.deepEqual(r, { ran: true, green: true, passed: 1487, total: 1487, failed: [], reason: null });
});

test('parseSuiteResult reports a red spec suite with the failing test names, de-duplicated', () => {
  const r = parseSuiteResult(SPEC_RED);
  assert.equal(r.ran, true);
  assert.equal(r.green, false);
  assert.deepEqual(r.failed, ['doctor: exits 1 on failure']);
});

test('parseSuiteResult reads the TAP reporter summary GitHub Actions captures', () => {
  assert.deepEqual(parseSuiteResult(TAP_GREEN), { ran: true, green: true, passed: 1487, total: 1487, failed: [], reason: null });
  const red = parseSuiteResult(TAP_RED);
  assert.equal(red.green, false);
  assert.deepEqual(red.failed, ['doctor: exits 1 on failure']);
});

test('parseSuiteResult treats a cancelled test as red even when fail is 0', () => {
  const r = parseSuiteResult('ℹ tests 10\nℹ pass 9\nℹ fail 0\nℹ cancelled 1\n');
  assert.equal(r.ran, true);
  assert.equal(r.green, false);
});

test('parseSuiteResult treats a log with NO summary line as not-run, never as green', () => {
  // A suite killed before it printed a summary must not read as a pass just
  // because no ✖ ever appeared.
  const r = parseSuiteResult('✔ lock: ok (1ms)\n✔ doctor: ok (1ms)\n');
  assert.equal(r.ran, false);
  assert.equal(r.green, false);
  assert.match(r.reason, /no node --test summary/);
  assert.equal(parseSuiteResult('ℹ tests 5\n').ran, false, 'a tests count without a fail count is not a summary');
  assert.equal(parseSuiteResult(undefined).ran, false);
});

// ─── findings ────────────────────────────────────────────────────────────────

test('normalizeFinding defaults an unknown bucket to the least severe one and keeps declared ones', () => {
  assert.equal(normalizeFinding({ bucket: 'CATASTROPHIC' }, 'x').bucket, 'BACKLOG');
  assert.equal(normalizeFinding({}, 'x').bucket, 'BACKLOG');
  for (const b of BUCKETS) assert.equal(normalizeFinding({ bucket: b }, 'x').bucket, b);
  const f = normalizeFinding({ bucket: 'BLOCKER', category: 'secrets', line: 'nine', blockerTest: PASSING_TEST, refuted: true, refutation: 'r' }, 'x');
  assert.equal(f.klass, 'secrets');
  assert.equal(f.line, null);
  assert.deepEqual(f.blockerTest, PASSING_TEST);
  assert.equal(f.refuted, true);
});

test('groundFinding accepts evidence that really occurs in the cited file, tolerating whitespace', () => {
  assert.deepEqual(groundFinding(finding()), { grounded: true, reason: null });
  assert.equal(groundFinding(finding({ evidence: '  export   const\n  BUCKETS ' })).grounded, true);
});

test('groundFinding rejects fabricated evidence, a missing file, an absent file and empty evidence', () => {
  assert.match(groundFinding(finding({ evidence: 'this string is nowhere in that file at all' })).reason, /does not appear/);
  assert.match(groundFinding(finding({ file: null })).reason, /no file cited/);
  assert.match(groundFinding(finding({ file: 'scripts/does-not-exist.mjs' })).reason, /does not exist/);
  assert.match(groundFinding(finding({ evidence: '   ' })).reason, /no evidence quoted/);
  assert.match(groundFinding(finding(), { readFile: () => { throw new Error('EACCES'); } }).reason, /unreadable: EACCES/);
});

test('groundFinding refuses to read a path that escapes the repository', () => {
  // finding.file is model-authored, so it is untrusted input to a file read.
  const g = groundFinding(finding({ file: '../../../../../../etc/passwd', evidence: 'root' }));
  assert.equal(g.grounded, false);
  assert.match(g.reason, /outside the repository/);
  const abs = groundFinding(finding({ file: '/etc/passwd', evidence: 'root' }));
  assert.equal(abs.grounded, false);
});

test('groundAll grounds every finding once and leaves an already-grounded one alone', () => {
  const [a, b] = groundAll([finding(), { ...finding(), grounded: false, groundingReason: 'pre-set' }]);
  assert.equal(a.grounded, true);
  assert.equal(b.groundingReason, 'pre-set');
});

test('dedupeFindings collapses the same defect, counts duplicates, keeps units apart', () => {
  const out = dedupeFindings([finding(), finding(), finding({ title: 'something else' })]);
  assert.equal(out.length, 2);
  assert.equal(out[0].duplicates, 1);
  assert.equal(dedupeFindings([finding({ unit: 'surface:cli' }), finding({ unit: 'surface:mcp' })]).length, 2);
});

test('dedupeFindings keeps the MOST severe reading and carries its justification', () => {
  const shouldFix = finding({ bucket: 'SHOULD-FIX', blocker_test: null, consequence: 'mild' });
  const blocker = finding({ consequence: 'severe' });
  const [merged] = applyDemotions(dedupeFindings(groundAll([shouldFix, blocker])));
  assert.equal(merged.bucket, 'BLOCKER');
  assert.equal(merged.consequence, 'severe');
  assert.deepEqual(merged.demotions, []);
  const [reverse] = applyDemotions(dedupeFindings(groundAll([blocker, shouldFix])));
  assert.equal(reverse.bucket, 'BLOCKER');
});

test('dedupeFindings survivor prefers the copy whose evidence checks out', () => {
  const paraphrased = { ...finding(), evidence: 'a paraphrase that is not in the file' };
  const [merged] = dedupeFindings(groundAll([paraphrased, finding()]));
  assert.equal(merged.grounded, true);
  assert.equal(merged.evidence, 'export const BUCKETS');
});

test('dedupeFindings adopts a blocker test from any copy and does not let one refuted copy refute the defect', () => {
  const [a] = dedupeFindings(groundAll([finding({ blocker_test: null }), finding()]));
  assert.equal(blockerTestAsserted(a.blockerTest), true);
  const [b] = dedupeFindings(groundAll([{ ...finding(), refuted: true, refutation: 'x' }, finding()]));
  assert.equal(b.refuted, false);
});

test('blockerTestAsserted requires all three booleans to be exactly true', () => {
  assert.equal(blockerTestAsserted(PASSING_TEST), true);
  assert.equal(blockerTestAsserted(null), false);
  assert.equal(blockerTestAsserted({ ...PASSING_TEST, user_hits_it: false }), false);
  assert.equal(blockerTestAsserted({ ...PASSING_TEST, needs_another_release: 'yes' }), false);
});

test('applyDemotions keeps a grounded, unrefuted, fully-asserted blocker', () => {
  const [f] = applyDemotions([finding()]);
  assert.equal(f.bucket, 'BLOCKER');
  assert.deepEqual(f.demotions, []);
});

test('applyDemotions demotes — never deletes — for each rule, and names the rule', () => {
  const ungrounded = applyDemotions([finding({ evidence: 'not in the file' })]);
  assert.equal(ungrounded.length, 1);
  assert.equal(ungrounded[0].bucket, 'SHOULD-FIX');
  assert.equal(ungrounded[0].originalBucket, 'BLOCKER');
  assert.match(ungrounded[0].demotions.join(' '), /ungrounded/);
  assert.match(applyDemotions([finding({ refuted: true })])[0].demotions.join(' '), /refuted/);
  assert.match(applyDemotions([finding()], { hollowUnits: new Set(['surface:policy-guard']) })[0].demotions.join(' '), /examined no files/);
  for (const missing of ['user_hits_it', 'needs_another_release', 'worse_than_status_quo']) {
    const out = applyDemotions([finding({ blocker_test: { ...PASSING_TEST, [missing]: false } })]);
    assert.equal(out[0].bucket, 'SHOULD-FIX', `${missing}=false must not block`);
    assert.match(out[0].demotions.join(' '), /blocker test not fully asserted/);
  }
  assert.equal(applyDemotions([finding({ blocker_test: null })])[0].bucket, 'SHOULD-FIX');
  assert.equal(applyDemotions([finding({ bucket: 'SHOULD-FIX', evidence: 'nowhere' })])[0].bucket, 'SHOULD-FIX');
});

test('unitCoverage separates audited, hollow and missing, accepting either spelling', () => {
  const c = unitCoverage([{ unit: 'a', files_examined: ['x'] }, { unit: 'b', files_examined: [] }, { unit: 'd', filesExamined: ['y'] }], ['a', 'b', 'c', 'd']);
  assert.deepEqual(c, { audited: ['a', 'd'], hollow: ['b'], missing: ['c'] });
});

test('probeFindings blocks on the integrity probes and only warns on website and shellcheck', () => {
  const out = probeFindings({
    lockstep: ['plugin.json 1.0.0 != 1.1.0'],
    vendoredDigests: ['treeDigest drift'],
    vendoredTarball: ['hash mismatch'],
    bundleDrift: [' M dist/agb.mjs'],
    releaseDrift: ['untagged: ...'],
    websiteGen: ['changelog.mdx out of date'],
    shellcheck: ['SC2086'],
  });
  assert.equal(out.length, 7);
  assert.equal(out.filter((f) => f.bucket === 'BLOCKER').length, 5);
  assert.deepEqual(out.filter((f) => f.bucket === 'SHOULD-FIX').map((f) => f.klass), ['probe:websiteGen', 'probe:shellcheck']);
  assert.deepEqual(PROBE_SEVERITY, { lockstep: 'BLOCKER', vendoredDigests: 'BLOCKER', vendoredTarball: 'BLOCKER', bundleDrift: 'BLOCKER', releaseDrift: 'BLOCKER', websiteGen: 'SHOULD-FIX', shellcheck: 'SHOULD-FIX' });
  for (const f of out) {
    assert.equal(f.mechanical, true);
    assert.equal(f.grounded, true);
    assert.equal(f.unit, 'suite:mechanical');
    assert.ok(f.consequence.length > 0, `${f.klass} needs a consequence`);
    assert.ok(f.recommendation.length > 0, `${f.klass} needs a recommendation`);
  }
  assert.deepEqual(probeFindings(undefined), []);
});

// ─── the verdict ─────────────────────────────────────────────────────────────

test('computeVerdict returns GO only when everything checked out', () => {
  assert.equal(computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: GREEN }).verdict, 'GO');
});

test('computeVerdict is NO-GO on a red suite, an absent suite, or an uncaptured suite', () => {
  const red = computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: { ran: true, green: false, failed: ['doctor: x'] } });
  assert.equal(red.verdict, 'NO-GO');
  assert.match(red.reasons.join(' '), /test suite is red: 1 failing test/);
  const absent = computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: null });
  assert.equal(absent.verdict, 'NO-GO');
  assert.match(absent.reasons.join(' '), /no test suite result was supplied/);
  const notRun = computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: { ran: false, green: false, failed: [], reason: 'no summary' } });
  assert.equal(notRun.verdict, 'NO-GO');
  assert.match(notRun.reasons.join(' '), /no summary/);
});

test('computeVerdict is NO-GO on a surviving blocker, a missing surface, or a hollow report', () => {
  assert.equal(computeVerdict({ findings: [finding()], coverage: COVERED, probes: CLEAN_PROBES, suite: GREEN }).verdict, 'NO-GO');
  const missing = computeVerdict({ findings: [], coverage: { ...COVERED, missing: ['surface:mcp'] }, probes: CLEAN_PROBES, suite: GREEN });
  assert.equal(missing.verdict, 'NO-GO');
  assert.match(missing.reasons.join(' '), /no audit report: surface:mcp/);
  const hollow = computeVerdict({ findings: [], coverage: { audited: [], hollow: ['surface:cli'], missing: [] }, probes: CLEAN_PROBES, suite: GREEN });
  assert.equal(hollow.verdict, 'NO-GO');
  assert.match(hollow.reasons.join(' '), /examined no files/);
});

test('computeVerdict is GO-WITH-RISK for should-fix items, unconsultable probes, and an unsynced HEAD', () => {
  const v = computeVerdict({ findings: [finding({ bucket: 'SHOULD-FIX' })], coverage: COVERED, probes: { ...CLEAN_PROBES, unconsultable: ['shellcheck: not installed'], git: { syncedWithOriginMain: false } }, suite: GREEN });
  assert.equal(v.verdict, 'GO-WITH-RISK');
  assert.match(v.reasons.join(' '), /1 should-fix/);
  assert.match(v.reasons.join(' '), /probe could not run: shellcheck/);
  assert.match(v.reasons.join(' '), /HEAD is not origin\/main/);
});

test('computeVerdict names an untriaged or truncated backlog rather than reading it as "no issues"', () => {
  const un = computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: GREEN, issues: { unconsultable: 'gh issue list failed' } });
  assert.equal(un.verdict, 'GO-WITH-RISK');
  assert.match(un.reasons.join(' '), /GitHub issues were not triaged/);
  const tr = computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: GREEN, issues: { truncated: 500 } });
  assert.match(tr.reasons.join(' '), /hit its fetch limit \(500\)/);
});

test('computeVerdict never returns GO for a partial (--units) run', () => {
  const v = computeVerdict({ findings: [], coverage: COVERED, probes: CLEAN_PROBES, suite: GREEN, partial: true });
  assert.equal(v.verdict, 'GO-WITH-RISK');
  assert.match(v.reasons.join(' '), /partial audit \(--units\)/);
});

// ─── end to end ──────────────────────────────────────────────────────────────

test('synthesize end-to-end: a clean full run is GO', () => {
  const r = synthesize({ input: CLEAN_INPUT, reports: FULL_REPORTS, suite: GREEN });
  assert.equal(r.verdict.verdict, 'GO');
  assert.equal(r.schema, 'release-audit-result/booster-1');
  assert.equal(r.package, 'antigravity-booster');
  assert.equal(r.coverage.missing.length, 0);
  assert.equal(r.findings.length, 0);
});

test('synthesize expects the suite agents, and dropping any one of them is NO-GO', () => {
  for (const omitted of ['suite:drift', 'suite:docs', 'suite:supply', 'suite:issues:1']) {
    const r = synthesize({ input: CLEAN_INPUT, reports: FULL_REPORTS.filter((x) => x.unit !== omitted), suite: GREEN });
    assert.equal(r.verdict.verdict, 'NO-GO', `${omitted} going missing must block`);
    assert.ok(r.coverage.missing.includes(omitted));
  }
});

test('synthesize does not expect the suite agents on a filtered run, and caps it below GO', () => {
  const r = synthesize({ input: { ...CLEAN_INPUT, filtered: true }, reports: [FULL_REPORTS[0]], suite: GREEN });
  assert.equal(r.coverage.missing.length, 0);
  assert.equal(r.partial, true);
  assert.equal(r.verdict.verdict, 'GO-WITH-RISK');
});

test('synthesize surfaces a mechanical probe blocker with no agent involved', () => {
  const r = synthesize({ input: { ...CLEAN_INPUT, probes: { ...CLEAN_PROBES, vendoredDigests: ['treeDigest drift'] } }, reports: FULL_REPORTS, suite: GREEN });
  assert.equal(r.verdict.verdict, 'NO-GO');
  assert.equal(r.findings.filter((f) => f.bucket === 'BLOCKER').length, 1);
});

test('synthesize collects issue verdicts from every report', () => {
  const reports = FULL_REPORTS.map((r, i) => (i === 0 ? { ...r, issue_verdicts: [{ number: 54, verdict: 'already-fixed-close-it', rationale: 'fixed in #107' }] } : r));
  const r = synthesize({ input: CLEAN_INPUT, reports, suite: GREEN });
  assert.deepEqual(r.issueVerdicts, [{ unit: 'surface:policy-guard', number: 54, verdict: 'already-fixed-close-it', rationale: 'fixed in #107' }]);
});

test('renderTerminal names the verdict, the blockers, the demotions and a rebuilt tree', () => {
  const r = synthesize({
    input: { ...CLEAN_INPUT, probes: { ...CLEAN_PROBES, bundleRebuilt: true } },
    reports: FULL_REPORTS.map((x, i) => (i === 0 ? { ...x, findings: [{ ...finding(), title: 'fabricated claim', evidence: 'nowhere at all' }, finding()] } : x)),
    suite: GREEN,
  });
  const text = renderTerminal(r);
  assert.match(text, /RELEASE AUDIT — antigravity-booster 1\.2\.0 \(baseline v1\.1\.0\)/);
  assert.match(text, /VERDICT: NO-GO/);
  assert.match(text, /BLOCKERS/);
  assert.match(text, /scripts\/release-audit-synthesize\.mjs:1/);
  assert.match(text, /DEMOTED FROM BLOCKER \(1\)/);
  assert.match(text, /ungrounded/);
  assert.match(text, /rebuilt dist\/ and vendor\//);
});

test('synthesizeMain refuses to run without both inputs, and exits 2 on NO-GO / 0 otherwise', () => {
  const lines = [];
  assert.equal(synthesizeMain([], { log: (m) => lines.push(m) }), 1);
  assert.match(lines.join(' '), /usage:/);

  const files = {
    'in.json': JSON.stringify(CLEAN_INPUT),
    'full.json': JSON.stringify({ reports: FULL_REPORTS }),
    'partial.json': JSON.stringify([FULL_REPORTS[0]]),
    'green.log': SPEC_GREEN,
  };
  // Grounding reads real repo files; everything else comes from the table.
  const readFile = (p, enc) => (files[String(p).split('/').pop()] ?? readFileSyncReal(p, enc));
  const written = {};
  const ok = synthesizeMain(['--input', 'in.json', '--reports', 'full.json', '--suite', 'green.log', '--json', 'out.json'], { readFile, writeFile: (p, c) => { written[p] = c; }, log: () => {} });
  assert.equal(ok, 0);
  assert.equal(JSON.parse(written['out.json']).verdict.verdict, 'GO');
  const noGo = synthesizeMain(['--input', 'in.json', '--reports', 'partial.json', '--suite', 'green.log'], { readFile, log: () => {} });
  assert.equal(noGo, 2);
  const noSuite = synthesizeMain(['--input', 'in.json', '--reports', 'full.json'], { readFile, log: () => {} });
  assert.equal(noSuite, 2, 'omitting --suite can never produce a passing exit code');
});


test('BUCKETS lists exactly the three severities the report renders', () => {
  assert.deepEqual(BUCKETS, ['BLOCKER', 'SHOULD-FIX', 'BACKLOG']);
});
