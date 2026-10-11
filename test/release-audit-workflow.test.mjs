// Tests for scripts/release-audit-workflow.mjs — the build step that turns the
// skill's markdown-fenced workflow into a runnable, self-contained script.
//
// The output is executed by the Workflow tool, so a defect here is not a bad
// report — it is a fan-out that never starts, after collection has already run
// and the background suite has been launched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, extractScript, buildScript, workflowMain, WORKFLOW_MD, INPUT_MARKER } from '../scripts/release-audit-workflow.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Compile the way the Workflow runtime does: inside an async wrapper. */
function compiles(source) {
  const body = source.replace('export const meta', 'const meta');
  return () => new vm.Script(`(async function (args, log, agent, pipeline, parallel) {\n${body}\n})`);
}

test('parseArgs reads both paths', () => {
  assert.deepEqual(parseArgs(['--input', 'a.json', '--out', 'b.mjs']), { input: 'a.json', out: 'b.mjs' });
  assert.deepEqual(parseArgs([]), { input: null, out: null });
});

test('extractScript returns the single javascript fence and refuses an ambiguous document', () => {
  assert.equal(extractScript('text\n```javascript\nconst a = 1\n```\nmore'), 'const a = 1');
  assert.throws(() => extractScript('```javascript\na\n```\n```javascript\nb\n```'), /found 2/);
  assert.throws(() => extractScript('no fences here'), /found 0/);
});

test('buildScript embeds the document at the marker and keeps the script intact', () => {
  const out = buildScript({ version: '1.2.0' }, `export const meta = {}\n${INPUT_MARKER}\nconst input = args || INPUT_DOC`);
  assert.match(out, /const INPUT_DOC = \{"version":"1\.2\.0"\}/);
  assert.match(out, /const input = args \|\| INPUT_DOC/);
  assert.match(out, /do not edit/);
});

test('buildScript leaves `export const meta` as the first statement and declares INPUT_DOC before it is read', () => {
  // The Workflow runtime REJECTS a script whose first statement is anything else.
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  const out = buildScript({ version: '1.2.0' }, script);
  const firstCode = out.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'));
  assert.match(firstCode, /^export const meta = \{/);
  assert.ok(out.indexOf('const INPUT_DOC =') < out.indexOf('|| INPUT_DOC'), 'a TDZ error would abort the run');
});

test('buildScript refuses a template with no marker rather than emitting a broken script', () => {
  assert.throws(() => buildScript({}, 'export const meta = {}\nconst input = INPUT_DOC'), /missing its/);
});

test('the committed workflow template carries the injection marker after meta', () => {
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  assert.ok(script.includes(INPUT_MARKER));
  assert.ok(script.indexOf('export const meta') < script.indexOf(INPUT_MARKER));
});

test('buildScript neutralises a script-closing sequence and the JSON-legal line terminators', () => {
  // Issue titles are written by anyone who can open an issue and are embedded
  // verbatim. `</script` and U+2028/U+2029 are legal JSON and hostile in a
  // script context.
  const out = buildScript({ units: [{ label: '</script><img src=x>' }], t: `a${LS}b${PS}c` }, INPUT_MARKER);
  assert.ok(!out.includes('</script'));
  assert.match(out, /\\u003c/);
  assert.ok(!out.includes(LS));
  assert.ok(!out.includes(PS));
});

test('an embedded document round-trips back to the original value after escaping', () => {
  const doc = { version: '1.2.0', units: [{ id: 'surface:cli', label: `</script> x${LS}y` }] };
  const out = buildScript(doc, `${INPUT_MARKER}\nRESULT = INPUT_DOC`);
  assert.doesNotThrow(compiles(out));
  const ctx = { RESULT: null };
  vm.createContext(ctx);
  new vm.Script(out).runInContext(ctx);
  // Compared as JSON: the value is built in another vm realm, so deepEqual
  // would fail on prototype identity rather than on content.
  assert.equal(JSON.stringify(ctx.RESULT), JSON.stringify(doc));
});

test('the committed workflow reference builds into a script that compiles', () => {
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  const built = buildScript({ version: '1.2.0', units: [], issues: { sweepBatches: [[]] }, probes: {} }, script);
  assert.doesNotThrow(compiles(built));
  assert.match(script, /typeof args !== 'undefined' && args/, 'a supplied args must still win over the embedded document');
});

test('workflowMain refuses to run without both paths', () => {
  const lines = [];
  assert.equal(workflowMain([], { log: (m) => lines.push(m) }), 1);
  assert.match(lines.join(' '), /usage:/);
});

test('workflowMain writes the built script and reports what it embedded', () => {
  const written = {};
  const lines = [];
  const code = workflowMain(['--input', 'in.json', '--out', 'out.mjs'], {
    readFile: (p) => (String(p).endsWith('in.json')
      ? JSON.stringify({ version: '1.2.0', units: [{ id: 'a' }, { id: 'b' }] })
      : readFileSync(join(ROOT, WORKFLOW_MD), 'utf8')),
    writeFile: (p, c) => { written[p] = c; },
    log: (m) => lines.push(m),
  });
  assert.equal(code, 0);
  assert.match(written['out.mjs'], /const INPUT_DOC = /);
  assert.match(lines.join(' '), /2 units/);
});
