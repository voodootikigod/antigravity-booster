// Tests for the /release-audit skill assets.
//
// The workflow script is JavaScript that lives inside a markdown fence, so no
// linter, type checker or test runner sees it by default. A syntax error there
// fails at fan-out — AFTER collection has run and the background suite has been
// started — which is the most expensive moment to discover it. These tests give
// the fence the same guarantees a real source file gets, and pin the contracts
// it shares with the collector (what fields the prompts read) and the
// synthesizer (which unit ids coverage expects).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { SUITE_UNITS, expectedSuiteUnits, PROBE_SEVERITY } from '../scripts/release-audit-synthesize.mjs';
import { workflowArgs, UNITS, parseArgs } from '../scripts/release-audit-collect.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'release-audit');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const WORKFLOW_MD = join(SKILL_DIR, 'references', 'workflow-script.md');

function fences(markdown) {
  return [...String(markdown).matchAll(/```javascript\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}
const code = () => fences(readFileSync(WORKFLOW_MD, 'utf8'))[0];

test('the skill and its workflow reference exist', () => {
  assert.ok(existsSync(SKILL_MD), 'SKILL.md must exist');
  assert.ok(existsSync(WORKFLOW_MD), 'references/workflow-script.md must exist');
});

test('SKILL.md declares the frontmatter the slash command needs', () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(SKILL_MD, 'utf8'));
  assert.ok(fm, 'SKILL.md must open with YAML frontmatter');
  assert.match(fm[1], /^name: release-audit$/m);
  assert.match(fm[1], /^user-invocable: true$/m);
  assert.match(fm[1], /^argument-hint:/m);
  assert.match(fm[1], /description:/);
});

test('SKILL.md documents every flag the collector actually parses', () => {
  const text = readFileSync(SKILL_MD, 'utf8');
  const parsed = parseArgs(['--since', 'x', '--units', 'a', '--skip-issues', '--skip-build']);
  assert.equal(parsed.since, 'x');
  for (const flag of ['--since', '--units', '--skip-issues', '--skip-build']) {
    assert.ok(text.includes(flag), `SKILL.md must document ${flag}`);
  }
});

test('SKILL.md names every mechanical probe with its severity', () => {
  const text = readFileSync(SKILL_MD, 'utf8');
  for (const [key, severity] of Object.entries(PROBE_SEVERITY)) {
    const row = new RegExp(`\\| ${key} \\| ${severity} \\|`);
    assert.match(text, row, `SKILL.md must list probe ${key} as ${severity}`);
  }
});

test('SKILL.md says the suite is captured with npm test and that --suite is mandatory', () => {
  const text = readFileSync(SKILL_MD, 'utf8');
  assert.match(text, /npm test > <scratch>\/suite\.log 2>&1/);
  assert.match(text, /--suite` is not optional/);
});

test('the workflow reference holds exactly one javascript block', () => {
  assert.equal(fences(readFileSync(WORKFLOW_MD, 'utf8')).length, 1, 'ambiguity about which block to pass is itself a defect');
});

test('the workflow script parses as a workflow body', () => {
  // The runtime evaluates the script inside an async wrapper, which is why a
  // top-level `return` is legal there and would be a SyntaxError in a module.
  const body = code().replace('export const meta', 'const meta');
  assert.doesNotThrow(() => new vm.Script(`(async function (args, log, agent, pipeline, parallel) {\n${body}\n})`));
});

test('the workflow script declares meta with both phases', () => {
  const c = code();
  assert.match(c, /export const meta = \{/);
  assert.match(c, /name: 'release-audit'/);
  assert.match(c, /title: 'Audit'/);
  assert.match(c, /title: 'Verify'/);
});

test('the workflow script forces a schema on every agent call', () => {
  // An agent without a schema returns prose, and prose cannot be bucketed,
  // grounded or counted — the whole verdict would degrade to a summary.
  const c = code();
  const calls = [...c.matchAll(/agent\(/g)];
  assert.ok(calls.length >= 2, 'expected a unit agent and a refute agent');
  assert.equal([...c.matchAll(/schema: (REPORT|VERDICT)/g)].length, calls.length, 'every agent() call must pass a schema');
});

test('the report and finding schemas require the anti-hollow, grounding and blocker-test fields', () => {
  const c = code();
  assert.match(c, /required: \['unit', 'files_examined', 'findings', 'issue_verdicts', 'notes'\]/);
  assert.match(c, /evidence: \{ type: 'string'/);
  assert.match(c, /required: \['user_hits_it', 'needs_another_release', 'worse_than_status_quo'\]/);
});

test('the workflow skips the suite agents on a filtered run', () => {
  const c = code();
  assert.match(c, /const FILTERED = input\.filtered === true/);
  assert.match(c, /FILTERED \? \[\] : \[\.\.\.SUITE_SPECS, \.\.\.SWEEP_SPECS\]/);
});

test('the fixed suite agent ids in the workflow match the ones the synthesizer expects', () => {
  // These two lists are the coverage contract: the synthesizer forces NO-GO for
  // any expected unit that produced no report, so a rename on one side alone
  // would make every run fail closed for a reason nobody could find.
  const c = code();
  for (const id of SUITE_UNITS) {
    assert.ok(c.includes(`id: '${id}'`), `workflow must define the ${id} agent`);
    assert.ok(c.includes(`unit exactly "${id}"`), `workflow must pin ${id}'s reported unit id`);
  }
});

test('the workflow shards the issue sweep with ids the synthesizer can predict', () => {
  const c = code();
  assert.match(c, /input\.issues\?\.sweepBatches/);
  assert.ok(!/input\.issues\.sweepBatches/.test(c), 'no unguarded input.issues.sweepBatches access may remain');
  assert.match(c, /suite:issues:\$\{idx \+ 1\}/);
  assert.deepEqual(expectedSuiteUnits({ issues: { sweepBatches: [[], []] } }).filter((u) => u.startsWith('suite:issues:')), ['suite:issues:1', 'suite:issues:2']);
});

test('the prompts are bespoke to booster: the hook surface, the git-URL install, the standing rails', () => {
  const c = code();
  assert.match(c, /u\.kind === 'hook'/);
  assert.match(c, /PRETOOLUSE POLICY GUARD/);
  assert.match(c, /agy plugin install <git-url>/);
  assert.match(c, /STANDING RAILS/);
  assert.match(c, /vendored-adlc|KNOWN_VENDORED_ADLC/);
  assert.match(c, /Do not answer from the issue text alone/);
  assert.match(c, /Your job is to REFUTE it/);
  assert.match(c, /Do not refuse to refute/);
});

test('the unit projection provides every unit field the workflow prompts read', () => {
  // A field dropped from the projection is `undefined` inside a template
  // literal, which renders as the string "undefined" in a prompt rather than
  // throwing. So the contract is asserted mechanically against the script.
  const referenced = new Set([...code().matchAll(/\bu\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const projected = workflowArgs({ units: [{ ...UNITS[0], missingPaths: [], fileCount: 1, bytes: 1, churn: {}, issues: [], files: ['f'] }] }).units[0];
  const missing = [...referenced].filter((f) => !(f in projected));
  assert.deepEqual(missing, [], `workflowArgs must project: ${missing.join(', ')}`);
});

test('the projection provides every ISSUE field the workflow prompts render', () => {
  const referenced = new Set([...code().matchAll(/\bi\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const full = { number: 1, title: 't', url: 'u', labels: [], routedVia: 'v', routedTo: null, excerpt: 'e' };
  const projected = workflowArgs({ units: [{ issues: [full] }], issues: { sweepBatches: [[full]] } });
  for (const record of [projected.units[0].issues[0], projected.issues.sweepBatches[0][0]]) {
    const missing = [...referenced].filter((f) => !(f in record));
    assert.deepEqual(missing, [], `issue projection must keep: ${missing.join(', ')}`);
  }
});

test('the top-level projection provides every input field and every probe key the workflow reads', () => {
  const c = code();
  const referenced = new Set([...c.matchAll(/\binput\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const projected = workflowArgs({ version: '1', currentVersion: '1', since: 'v1' });
  const missing = [...referenced].filter((f) => !(f in projected));
  assert.deepEqual(missing, [], `workflowArgs must project: ${missing.join(', ')}`);
  const probeKeys = new Set([...c.matchAll(/\binput\.probes\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const missingProbes = [...probeKeys].filter((k) => !(k in projected.probes));
  assert.deepEqual(missingProbes, [], `workflowArgs.probes must project: ${missingProbes.join(', ')}`);
});

test('the suite prompts hand every blocking probe result to an agent so it is not re-reported', () => {
  const c = code();
  for (const [key, severity] of Object.entries(PROBE_SEVERITY)) {
    if (severity !== 'BLOCKER') continue;
    assert.ok(c.includes(`input.probes.${key}`), `a suite prompt must surface probe ${key}`);
  }
});
