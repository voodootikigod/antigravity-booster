import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runAgy,
  classifyAgyOutcome,
  ALL_AGY_ERROR_KINDS,
  FAILURE_FINISHED_REASONS,
} from '../lib/agy.mjs';
import { poolOf } from '../lib/models.mjs';
import { validatePlan } from '../lib/plan.mjs';
import { runPlan } from '../lib/scheduler.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_agy_159_print_test_${process.pid}.json`);

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

const AGY_404 = 'AGY_ERROR: {"code":404,"status":"NOT_FOUND","message":"unknown model x"}';
const AGY_429 = 'AGY_ERROR: {"code":429,"status":"RESOURCE_EXHAUSTED"}';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('ALL_AGY_ERROR_KINDS is the exact frozen 17-item list', () => {
  assert.equal(ALL_AGY_ERROR_KINDS.length, 17);
  assert.ok(Object.isFrozen(ALL_AGY_ERROR_KINDS));
  assert.deepEqual([...ALL_AGY_ERROR_KINDS], [
    'containment_unavailable', 'stream_overflow', 'stream_corruption', 'timeout', 'spawn', 'signal',
    'interrupted', 'model_unavailable', 'envelope_error', 'server', 'server_shutdown_error', 'cli',
    'missing_terminal_result', 'missing_structured_output', 'schema_violation', 'empty', 'unclassified',
  ]);
});

test('FAILURE_FINISHED_REASONS matches the spec set', () => {
  assert.deepEqual([...FAILURE_FINISHED_REASONS].sort(), [
    'aborted', 'cancelled', 'canceled', 'error', 'failed', 'length', 'max_tokens', 'recitation', 'safety',
  ].sort());
});

// ---------------------------------------------------------------------------
// 14 canonical golden vectors
// ---------------------------------------------------------------------------

const OK_TERMINAL = { status: 'SUCCESS', exit_code: 0 };

const GOLDEN = [
  ['row 1: kill reason', { outputFormat: 'stream-json', killReason: { kind: 'stream_overflow', error: 'big' }, code: 0 },
    { ok: false, kind: 'stream_overflow', rateLimited: false, error: 'big' }],
  ['row 2: spawn error', { outputFormat: 'text', spawnError: new Error('ENOENT'), code: null },
    { ok: false, kind: 'spawn', rateLimited: false, error: 'spawn: ENOENT' }],
  ['row 2: no code and no signal', { outputFormat: 'text', code: null, signal: null },
    { ok: false, kind: 'spawn', rateLimited: false, error: 'spawn: failed to start' }],
  ['row 3: signal', { outputFormat: 'text', code: null, signal: 'SIGKILL' },
    { ok: false, kind: 'signal', rateLimited: false, error: 'killed by signal SIGKILL' }],
  ['row 4: print_timeout finished_reason', { outputFormat: 'json', code: 0, finishedReason: 'print_timeout' },
    { ok: false, kind: 'timeout', rateLimited: false, error: 'print-timeout' }],
  ['row 4: exit 3 + [agy] print timeout stderr', { outputFormat: 'stream-json', code: 3, err: 'noise\n[agy] print timeout after 30s\n' },
    { ok: false, kind: 'timeout', rateLimited: false, error: 'print-timeout' }],
  ['row 5: interrupted', { outputFormat: 'stream-json', code: 0, terminalResult: { ...OK_TERMINAL, finished_reason: 'interrupted' } },
    { ok: false, kind: 'interrupted', rateLimited: false, error: 'interrupted' }],
  ['row 6: stream-json ERROR terminal result', { outputFormat: 'stream-json', code: 0, terminalResult: { status: 'ERROR', exit_code: 1 } },
    { ok: false, kind: 'server', rateLimited: false, error: 'terminal result status ERROR: exit_code 1' }],
  ['row 6: stream-json SUCCESS with non-zero exit_code', { outputFormat: 'stream-json', code: 0, terminalResult: { status: 'SUCCESS', exit_code: 2 } },
    { ok: false, kind: 'server', rateLimited: false, error: 'terminal result status SUCCESS: exit_code 2' }],
  ['row 6: json envelope error status', { outputFormat: 'json', code: 0, envelope: { status: 'error', error: 'boom' } },
    { ok: false, kind: 'envelope_error', rateLimited: false, error: 'agy returned error status in JSON envelope: error (boom)' }],
  ['row 7: SUCCESS result but non-zero exit', { outputFormat: 'stream-json', code: 1, terminalResult: OK_TERMINAL },
    { ok: false, kind: 'server_shutdown_error', rateLimited: false, error: 'process exited with code 1 despite terminal result SUCCESS' }],
  ['row 8: stream-json no terminal result, non-zero exit', { outputFormat: 'stream-json', code: 1, err: 'kaboom' },
    { ok: false, kind: 'cli', rateLimited: false, error: 'exit 1: kaboom' }],
  ['row 8: stream-json no terminal result, structured agy error', { outputFormat: 'stream-json', code: 1, err: AGY_429 },
    { ok: false, kind: 'server', rateLimited: true, error: `exit 1: ${AGY_429}` }],
  ['row 9: stream-json exit 0 without terminal result', { outputFormat: 'stream-json', code: 0 },
    { ok: false, kind: 'missing_terminal_result', rateLimited: false, error: 'process exited with 0 without emitting terminal result' }],
  ['row 10: text non-zero exit', { outputFormat: 'text', code: 2, err: 'plain failure' },
    { ok: false, kind: 'server', rateLimited: false, error: 'exit 2: plain failure' }],
  ['row 10: json non-zero exit with model 404', { outputFormat: 'json', code: 1, err: AGY_404, requestedModel: 'x' },
    { ok: false, kind: 'model_unavailable', rateLimited: false, error: `exit 1: ${AGY_404}` }],
  ['row 11: invalid json', { outputFormat: 'json', code: 0, jsonValid: false },
    { ok: false, kind: 'schema_violation', rateLimited: false, error: 'Invalid JSON structured output' }],
  ['row 11: explicit schema error kind', { outputFormat: 'json', code: 0, schemaErrorKind: 'missing_structured_output', schemaErrorMsg: 'nope' },
    { ok: false, kind: 'missing_structured_output', rateLimited: false, error: 'nope' }],
  ['row 12: empty text', { outputFormat: 'text', code: 0, out: '  \n' },
    { ok: false, kind: 'empty', rateLimited: false, error: 'exit 0: empty output' }],
  ['row 13: text ok', { outputFormat: 'text', code: 0, out: 'hello' },
    { ok: true, kind: null, rateLimited: false, error: null }],
  ['row 13: json ok', { outputFormat: 'json', code: 0, envelope: { status: 'ok' } },
    { ok: true, kind: null, rateLimited: false, error: null }],
  ['row 13: stream-json ok', { outputFormat: 'stream-json', code: 0, terminalResult: OK_TERMINAL },
    { ok: true, kind: null, rateLimited: false, error: null }],
  ['row 14: unclassified output format', { outputFormat: 'xml', code: 0, out: 'x' },
    { ok: false, kind: 'unclassified', rateLimited: false, error: 'unclassified agy outcome for outputFormat=xml' }],
];

for (const [name, input, expected] of GOLDEN) {
  test(`classifyAgyOutcome golden: ${name}`, () => {
    assert.deepEqual(classifyAgyOutcome(input), expected);
  });
}

test('classifyAgyOutcome: benign finished_reason "completed" is ok', () => {
  const r = classifyAgyOutcome({ outputFormat: 'text', code: 0, out: 'done', finishedReason: 'completed' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, null);
});

test('classifyAgyOutcome: finished_reason max_tokens is a server failure', () => {
  const r = classifyAgyOutcome({ outputFormat: 'text', code: 0, out: 'partial', finishedReason: 'max_tokens' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'server');
});

test('classifyAgyOutcome: terminal result finished_reason is honored when none passed explicitly', () => {
  const r = classifyAgyOutcome({ outputFormat: 'stream-json', code: 0, terminalResult: { ...OK_TERMINAL, finished_reason: 'safety' } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'server');
});

test('classifyAgyOutcome: a model.json file error is not model_unavailable', () => {
  const plain = classifyAgyOutcome({ outputFormat: 'text', code: 1, err: 'cannot open model.json: file not found' });
  assert.equal(plain.kind, 'server');
  const structured = classifyAgyOutcome({
    outputFormat: 'stream-json',
    code: 1,
    err: 'AGY_ERROR: {"message":"model foo.json not found"}',
    requestedModel: 'foo.json',
  });
  assert.notEqual(structured.kind, 'model_unavailable');
  assert.equal(structured.kind, 'server');
});

test('classifyAgyOutcome: unknown-model message and mismatched requested model', () => {
  const unknown = classifyAgyOutcome({
    outputFormat: 'stream-json',
    code: 1,
    err: 'AGY_ERROR: {"message":"unknown model gemini-9"}',
    requestedModel: 'something-else',
  });
  assert.equal(unknown.kind, 'model_unavailable');
  const mismatch = classifyAgyOutcome({
    outputFormat: 'stream-json',
    code: 1,
    err: 'AGY_ERROR: {"message":"model other-model not found"}',
    requestedModel: 'wanted-model',
  });
  assert.equal(mismatch.kind, 'server');
  const match = classifyAgyOutcome({
    outputFormat: 'stream-json',
    code: 1,
    err: 'AGY_ERROR: {"message":"model wanted-model not found"}',
    requestedModel: 'wanted-model',
  });
  assert.equal(match.kind, 'model_unavailable');
});

test('classifyAgyOutcome: trailing Go shutdown line after AGY_ERROR 429 still rate limits', () => {
  const r = classifyAgyOutcome({
    outputFormat: 'text',
    code: 1,
    err: `${AGY_429}\nexit status 1\n`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'server');
  assert.equal(r.rateLimited, true);
});

test('classifyAgyOutcome: structured non-429 agy error is not a rate limit even if the text says so', () => {
  const r = classifyAgyOutcome({
    outputFormat: 'text',
    code: 1,
    err: 'AGY_ERROR: {"code":500,"message":"rate limit mentioned in prose"}',
  });
  assert.equal(r.rateLimited, false);
});

test('classifyAgyOutcome: unstructured stderr rate-limit prose is detected', () => {
  assert.equal(classifyAgyOutcome({ outputFormat: 'text', code: 1, err: 'quota exceeded for project' }).rateLimited, true);
  assert.equal(classifyAgyOutcome({ outputFormat: 'text', code: 1, err: 'something else' }).rateLimited, false);
});

test('classifyAgyOutcome: lastErrLine overrides stderr scanning', () => {
  const r = classifyAgyOutcome({ outputFormat: 'text', code: 1, err: 'ignored', lastErrLine: AGY_429 });
  assert.equal(r.rateLimited, true);
});

test('classifyAgyOutcome: legacy (< 1.5.0) vs >= 1.5.0 text timeout', () => {
  const out = 'Error: timed out waiting for response.';
  const legacy = classifyAgyOutcome({ outputFormat: 'text', code: 0, out, legacyPre150: true });
  assert.equal(legacy.kind, 'timeout');
  assert.equal(legacy.error, 'print-timeout');

  const modern = classifyAgyOutcome({ outputFormat: 'text', code: 0, out, legacyPre150: false });
  assert.equal(modern.ok, true);

  const modernExit3 = classifyAgyOutcome({ outputFormat: 'text', code: 3, out: '', err: '[agy] print timeout after 600s' });
  assert.equal(modernExit3.kind, 'timeout');
});

// ---------------------------------------------------------------------------
// 1,440-state exhaustive cross-product
// ---------------------------------------------------------------------------

const FORMATS = ['text', 'json', 'stream-json'];
const KILLED = [false, true];
const ENDS = ['ok0', 'exit1', 'signal', 'nostart'];
const RESULTS = ['none', 'success', 'error', 'interrupted', 'print_timeout'];
const BODIES = [
  { jsonValid: true, out: 'hello' },
  { jsonValid: true, out: '' },
  { jsonValid: false, out: 'hello' },
  { jsonValid: false, out: '' },
];
const STDERRS = [
  { name: 'none', err: '' },
  { name: 'e404', err: AGY_404 },
  { name: 'e429', err: AGY_429 },
];

function buildInput(s) {
  const input = {
    outputFormat: s.fmt,
    killReason: s.killed ? { kind: 'timeout', error: 'killed' } : null,
    jsonValid: s.body.jsonValid,
    out: s.body.out,
    err: s.stderr.err,
    requestedModel: 'x',
  };
  if (s.end === 'ok0') Object.assign(input, { code: 0, signal: null });
  else if (s.end === 'exit1') Object.assign(input, { code: 1, signal: null });
  else if (s.end === 'signal') Object.assign(input, { code: null, signal: 'SIGTERM' });
  else Object.assign(input, { code: null, signal: null });

  switch (s.res) {
    case 'success':
      if (s.fmt === 'stream-json') input.terminalResult = { status: 'SUCCESS', exit_code: 0 };
      else if (s.fmt === 'json') input.envelope = { status: 'ok' };
      break;
    case 'error':
      if (s.fmt === 'stream-json') input.terminalResult = { status: 'ERROR', exit_code: 1 };
      else if (s.fmt === 'json') input.envelope = { status: 'error' };
      else input.finishedReason = 'error';
      break;
    case 'interrupted':
      input.finishedReason = 'interrupted';
      break;
    case 'print_timeout':
      input.finishedReason = 'print_timeout';
      break;
    default:
      break;
  }
  return input;
}

// Independent oracle: (row, kind) for each state, derived from the spec table.
function oracle(s) {
  const code1 = s.end === 'exit1';
  const isModel = code1 && s.stderr.name === 'e404';
  if (s.killed) return { row: 1, kind: 'timeout' };
  if (s.end === 'nostart') return { row: 2, kind: 'spawn' };
  if (s.end === 'signal') return { row: 3, kind: 'signal' };
  if (s.res === 'print_timeout') return { row: 4, kind: 'timeout' };
  if (s.res === 'interrupted') return { row: 5, kind: 'interrupted' };
  if (s.res === 'error') {
    return { row: 6, kind: isModel ? 'model_unavailable' : (s.fmt === 'json' ? 'envelope_error' : 'server') };
  }
  if (s.fmt === 'stream-json') {
    if (s.res === 'success') {
      return code1 ? { row: 7, kind: 'server_shutdown_error' } : { row: 13, kind: null };
    }
    if (code1) {
      return { row: 8, kind: s.stderr.name !== 'none' ? (isModel ? 'model_unavailable' : 'server') : 'cli' };
    }
    return { row: 9, kind: 'missing_terminal_result' };
  }
  if (code1) return { row: 10, kind: isModel ? 'model_unavailable' : 'server' };
  if (s.fmt === 'json' && !s.body.jsonValid) return { row: 11, kind: 'schema_violation' };
  if (s.fmt === 'text' && s.body.out === '') return { row: 12, kind: 'empty' };
  return { row: 13, kind: null };
}

test('classifyAgyOutcome: 1,440-state cross-product is total, consistent, and covers rows 1..13', () => {
  const rowHits = new Map();
  let states = 0;
  for (const fmt of FORMATS) {
    for (const killed of KILLED) {
      for (const end of ENDS) {
        for (const res of RESULTS) {
          for (const body of BODIES) {
            for (const stderr of STDERRS) {
              const s = { fmt, killed, end, res, body, stderr };
              states += 1;
              const r = classifyAgyOutcome(buildInput(s));
              assert.equal(r.ok, r.kind === null, `ok === (kind === null) for ${JSON.stringify(s)}`);
              if (r.kind !== null) {
                assert.ok(ALL_AGY_ERROR_KINDS.includes(r.kind), `kind ${r.kind} must be a known kind`);
                assert.equal(typeof r.error, 'string');
              } else {
                assert.equal(r.error, null);
              }
              assert.equal(typeof r.rateLimited, 'boolean');
              const expected = oracle(s);
              assert.equal(r.kind, expected.kind, `row ${expected.row} kind mismatch for ${JSON.stringify(s)}`);
              rowHits.set(expected.row, (rowHits.get(expected.row) ?? 0) + 1);
            }
          }
        }
      }
    }
  }
  assert.equal(states, 3 * 2 * 4 * 5 * 4 * 3);
  assert.equal(states, 1440);
  for (let row = 1; row <= 13; row += 1) {
    assert.ok((rowHits.get(row) ?? 0) >= 1, `row ${row} must be hit at least once`);
  }
});

// ---------------------------------------------------------------------------
// runAgy wiring + fake-agy flag strictness
// ---------------------------------------------------------------------------

function withTempState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy-159-state-'));
  const saved = process.env.FAKE_STATE_DIR;
  process.env.FAKE_STATE_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (saved === undefined) delete process.env.FAKE_STATE_DIR;
      else process.env.FAKE_STATE_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    });
}

test('runAgy: appends --disable-slash-commands after --model by default', async () => {
  await withTempState(async (stateDir) => {
    const res = await runAgy({ bin: FAKE_AGY, model: 'gemini-3.8-flash-low', prompt: 'hello probe', sandbox: false });
    assert.ok(res.ok, res.error);
    assert.equal(res.rateLimited, false);
    const argv = readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8');
    assert.match(argv, /--model gemini-3\.8-flash-low --disable-slash-commands/);
  });
});

test('runAgy: disableSlashCommands:false omits the flag', async () => {
  await withTempState(async (stateDir) => {
    const res = await runAgy({ bin: FAKE_AGY, model: 'gemini-3.8-flash-low', prompt: 'hello probe', sandbox: false, disableSlashCommands: false });
    assert.ok(res.ok, res.error);
    const argv = readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8');
    assert.doesNotMatch(argv, /--disable-slash-commands/);
  });
});

test('runAgy: stdin-piped large prompts also carry --disable-slash-commands', async () => {
  await withTempState(async (stateDir) => {
    const res = await runAgy({ bin: FAKE_AGY, model: 'gemini-3.8-flash-low', prompt: 'x'.repeat(30 * 1024), sandbox: false });
    assert.ok(res.ok, res.error);
    const argv = readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8');
    assert.match(argv, /--input-format text .*--model gemini-3\.8-flash-low --disable-slash-commands/);
  });
});

test('fake-agy: exits 2 on unknown --flags in print mode and accepts --disable-slash-commands', () => {
  const bad = spawnSync(FAKE_AGY, ['--print', 'hi', '--bogus-flag'], { encoding: 'utf8', input: '' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown flag: --bogus-flag/);

  const badStdin = spawnSync(FAKE_AGY, ['--input-format', 'text', '--bogus-flag'], { encoding: 'utf8', input: 'hi' });
  assert.equal(badStdin.status, 2);

  const good = spawnSync(FAKE_AGY, ['--print', 'hi', '--model', 'm', '--disable-slash-commands'], { encoding: 'utf8', input: '' });
  assert.equal(good.status, 0);
});

test('runAgy: classifies a model 404 from stderr as model_unavailable with rateLimited false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy-159-mock-'));
  const bin = join(dir, 'agy');
  writeFileSync(bin, `#!/bin/sh\necho '${AGY_404}' >&2\nexit 1\n`, { mode: 0o755 });
  try {
    const res = await runAgy({ bin, model: 'gemini-3.8-flash-low', prompt: 'hi', sandbox: false });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'model_unavailable');
    assert.equal(res.rateLimited, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy: classifies a structured 429 followed by a shutdown line as rateLimited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy-159-mock-'));
  const bin = join(dir, 'agy');
  writeFileSync(bin, `#!/bin/sh\necho '${AGY_429}' >&2\necho 'exit status 1' >&2\nexit 1\n`, { mode: 0o755 });
  try {
    const res = await runAgy({ bin, model: 'gemini-3.8-flash-low', prompt: 'hi', sandbox: false, outputFormat: 'stream-json' });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'server');
    assert.equal(res.rateLimited, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy: a self-signalled agy surfaces kind signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy-159-mock-'));
  const bin = join(dir, 'agy');
  writeFileSync(bin, '#!/bin/sh\nkill -KILL $$\n', { mode: 0o755 });
  try {
    const res = await runAgy({ bin, model: 'gemini-3.8-flash-low', prompt: 'hi', sandbox: false });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'signal');
    assert.match(res.error, /killed by signal SIGKILL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgy: legacy text timeout sentinel on exit 0 is still a timeout', async () => {
  await withTempState(async () => {
    const res = await runAgy({ bin: FAKE_AGY, model: 'gemini-3.8-flash-low', prompt: 'FAKE:TIMEOUT', sandbox: false });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'timeout');
  });
});

// ---------------------------------------------------------------------------
// Scheduler integration (builder spawns go through a pass-through `bwrap` shim
// so signal/exit semantics are those of the fake agy process itself).
// ---------------------------------------------------------------------------

const LINUX_ONLY = { skip: process.platform !== 'linux' };

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy159-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return dir;
}

function makeBwrapShim() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-agy159-shim-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bwrap'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    { mode: 0o755 },
  );
  return dir;
}

async function withSchedulerEnv(env, fn) {
  const shim = makeBwrapShim();
  const mergedEnv = {
    AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
    AGB_AGY_BIN: FAKE_AGY,
    AGB_ADLC_BIN: FAKE_ADLC,
    AGB_SANDBOX_GATES: '0',
    PATH: `${shim}:${process.env.PATH}`,
    ...env,
  };
  const saved = {};
  for (const [k, v] of Object.entries(mergedEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(shim, { recursive: true, force: true });
  }
}

const quiet = { log: () => {} };

function builderInvocations(stateDir) {
  return readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8')
    .split(/^(?=--print )/m)
    .filter((l) => l.startsWith('--print ') && l.includes('TICKET-DONE or TICKET-BLOCKED'));
}

const modelOf = (line) => line.match(/--model (\S+)/)?.[1];

test('scheduler: signal kills strike but never bump the fleet CLI failure budget', LINUX_ONLY, async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-agy159-state-'));
  try {
    const report = await withSchedulerEnv(
      { FAKE_BUILDER_MODE: 'signal-always', FAKE_STATE_DIR: state },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [
          { id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] },
          { id: 'T2', title: 'two', body: 'x', scope: ['T2.txt'] },
          { id: 'T3', title: 'three', body: 'x', scope: ['T3.txt'] },
        ],
      }, quiet),
    );
    assert.deepEqual(report.merged, []);
    for (const id of ['T1', 'T2', 'T3']) {
      assert.match(report.failed[id], /signal/, `${id}: ${report.failed[id]}`);
      assert.doesNotMatch(report.failed[id], /fleet CLI failure budget/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('scheduler: model_unavailable demotes the model without burning a strike', LINUX_ONLY, async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-agy159-state-'));
  try {
    const report = await withSchedulerEnv(
      { FAKE_BUILDER_MODE: 'model-unavailable-twice', FAKE_STATE_DIR: state },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet),
    );
    assert.deepEqual(report.merged, ['T1']);
    assert.equal(report.failed.T1, undefined);
    assert.equal(readFileSync(join(state, 'builds'), 'utf8').trim(), '3');

    const models = builderInvocations(state).map(modelOf);
    assert.equal(models.length, 3);
    assert.equal(new Set(models).size, 3, `each attempt must use a fresh model, got ${models.join(', ')}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('scheduler: rateLimited reroutes cross-pool for free and clears the warm-resume session', LINUX_ONLY, async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-agy159-state-'));
  try {
    const report = await withSchedulerEnv(
      { FAKE_BUILDER_MODE: 'blocked-ratelimit-good', FAKE_CONVERSATION_ID: 'fake-conv-123', FAKE_STATE_DIR: state },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet),
    );
    assert.deepEqual(report.merged, ['T1']);
    assert.equal(report.failed.T1, undefined);
    assert.equal(readFileSync(join(state, 'builds'), 'utf8').trim(), '3');

    const invocations = builderInvocations(state);
    assert.equal(invocations.length, 3);
    assert.doesNotMatch(invocations[0], /--conversation/);
    assert.match(invocations[1], /--conversation fake-conv-123/, 'strike 2 warm-resumes the blocked session');
    assert.doesNotMatch(invocations[2], /--conversation/, 'rate-limit reroute must clear the stored conversation');
    assert.notEqual(poolOf(modelOf(invocations[2])), poolOf(modelOf(invocations[1])), 'reroute must cross pools');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('classifyAgyOutcome & validatePlan: minimal AGY_ERROR: {} and disableOrchestrator boolean validation', () => {
  const minErr = classifyAgyOutcome({
    outputFormat: 'stream-json',
    code: 1,
    terminalResult: null,
    err: 'AGY_ERROR: {}',
  });
  assert.equal(minErr.ok, false);
  assert.equal(minErr.kind, 'server');
  const exact4096 = 'AGY_ERROR: {"m":"' + 'x'.repeat(4096 - 19) + '"}';
  assert.equal(exact4096.length, 4096);
  assert.equal(classifyAgyOutcome({ outputFormat: 'stream-json', code: 1, err: exact4096 }).kind, 'server');
  const over4096 = 'AGY_ERROR: {"m":"' + 'x'.repeat(4097 - 19) + '"}';
  assert.equal(over4096.length, 4097);
  assert.equal(classifyAgyOutcome({ outputFormat: 'stream-json', code: 1, err: over4096 }).kind, 'cli');

  const basePlan = {
    repo: '/tmp/r',
    gate: { test: 'npm test' },
    tickets: [{ id: 'T1', title: 't', body: 'b', scope: ['a.js'], edges: [] }],
  };
  assert.deepEqual(validatePlan(basePlan), []);
  assert.deepEqual(validatePlan({ ...basePlan, disableOrchestrator: true }), []);
  assert.deepEqual(validatePlan({ ...basePlan, disableOrchestrator: false }), []);
  const errs = validatePlan({ ...basePlan, disableOrchestrator: 'yes' });
  assert.ok(errs.some((e) => e.includes('disableOrchestrator must be a boolean')));
});

test('scheduler: model_unavailable with pool_hint gemini demotes within same pool and ignores TICKET-BLOCKED inside tool_call payloads', LINUX_ONLY, async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-agy159-state-'));
  try {
    const report = await withSchedulerEnv(
      { FAKE_BUILDER_MODE: 'model-unavailable-once', FAKE_STATE_DIR: state },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], tier: 'frontier', pool_hint: 'gemini' }],
      }, quiet),
    );
    assert.deepEqual(report.merged, ['T1']);
    assert.equal(report.failed.T1, undefined);
    const models = builderInvocations(state).map(modelOf);
    assert.equal(models.length, 2);
    assert.equal(poolOf(models[0]), poolOf(models[1]), 'same-pool demotion required for pool_hint gemini');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
