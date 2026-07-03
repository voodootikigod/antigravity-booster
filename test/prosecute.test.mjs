import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prosecute, runHollowTest, blockingFindings } from '../lib/prosecute.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

const FAKE_ENV_KEYS = ['AGB_AGY_BIN', 'AGB_ADLC_BIN', 'FAKE_PROSECUTOR_VERDICT', 'FAKE_HOLLOW_TEST_MODE'];

function withFakes(env, fn) {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.AGB_ADLC_BIN = FAKE_ADLC;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of FAKE_ENV_KEYS) delete process.env[k]; });
}

// --- runHollowTest ---

test('runHollowTest: clean run reports zero survivors', async () => {
  await withFakes({ FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
    const r = await runHollowTest({ worktree: '/tmp', testCmd: 'npm test' });
    assert.equal(r.ok, true);
    assert.equal(r.total, 2);
    assert.equal(r.survived, 0);
    assert.deepEqual(r.mutants, []);
  });
});

test('runHollowTest: survivors are recovered from the exit-2 gate-fail path', async () => {
  await withFakes({ FAKE_HOLLOW_TEST_MODE: 'survivors' }, async () => {
    const r = await runHollowTest({ worktree: '/tmp', testCmd: 'npm test' });
    assert.equal(r.ok, true, 'exit 2 with a valid JSON payload is still a successful hollow-test run');
    assert.equal(r.total, 2);
    assert.equal(r.survived, 1);
    assert.equal(r.mutants.length, 1);
    assert.equal(r.mutants[0].status, 'survived');
  });
});

test('runHollowTest: an operational failure (exit 1, unparseable) degrades to ok:false, not a throw', async () => {
  await withFakes({ FAKE_HOLLOW_TEST_MODE: 'fail' }, async () => {
    const r = await runHollowTest({ worktree: '/tmp', testCmd: 'npm test' });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});

test('runHollowTest: no testCmd short-circuits without invoking adlc at all', async () => {
  const r = await runHollowTest({ worktree: '/tmp' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no gate test command configured/);
});

// --- prosecute(): evidence gate ---

test('prosecute: AC1 — hollow-test survivors force block even when the model verdict is ship', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_HOLLOW_TEST_MODE: 'survivors' }, async () => {
    const v = await prosecute({
      ticket: { id: 'T1', body: 'spec' },
      diff: 'real diff',
      model: 'Claude Sonnet 4.6 (Thinking)',
      worktree: '/tmp',
      testCmd: 'npm test',
    });
    assert.equal(v.verdict, 'block', 'a hollow-test survivor is not overrulable by the model\'s ship verdict');
    assert.ok(
      v.findings.some((f) => f.charge === 'tests' && /hollow-test/.test(f.claim)),
      'the automatic hollow-test finding is present in the returned findings'
    );
    assert.equal(v.hollowTest.survived, 1);
    assert.equal(blockingFindings(v.findings).some((f) => f.charge === 'tests'), true);
  });
});

test('prosecute: clean hollow-test + ship verdict still ships', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
    const v = await prosecute({
      ticket: { id: 'T1', body: 'spec' },
      diff: 'real diff',
      model: 'Claude Sonnet 4.6 (Thinking)',
      worktree: '/tmp',
      testCmd: 'npm test',
    });
    assert.equal(v.verdict, 'ship');
    assert.equal(v.hollowTest.survived, 0);
  });
});

test('prosecute: AC2 — the prosecution prompt embeds the hollow-test evidence block, not just the diff', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-log-'));
  const logFile = join(logDir, 'prosecution.log');
  try {
    await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_HOLLOW_TEST_MODE: 'survivors' }, async () => {
      await prosecute({
        ticket: { id: 'T1', body: 'spec' },
        diff: 'real diff',
        model: 'Claude Sonnet 4.6 (Thinking)',
        worktree: '/tmp',
        testCmd: 'npm test',
        logFile,
      });
    });
    const logged = readFileSync(logFile, 'utf8');
    assert.match(logged, /Mutation-testing evidence \(adlc hollow-test\) — SURVIVORS FOUND/);
    assert.match(logged, /1\/2 injected mutant\(s\) SURVIVED/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('prosecute: backward compatible — omitting worktree/testCmd skips hollow-test entirely (existing callers unaffected)', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship' }, async () => {
    const v = await prosecute({ ticket: { id: 'T1', body: 'spec' }, diff: 'real diff', model: 'Claude Sonnet 4.6 (Thinking)' });
    assert.equal(v.verdict, 'ship');
    assert.equal(v.hollowTest, null);
  });
});

test('prosecute: an unavailable hollow-test (operational error) does not itself block — model verdict still decides, and the prompt says so explicitly', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-log-'));
  const logFile = join(logDir, 'prosecution.log');
  try {
    await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_HOLLOW_TEST_MODE: 'fail' }, async () => {
      const v = await prosecute({
        ticket: { id: 'T1', body: 'spec' },
        diff: 'real diff',
        model: 'Claude Sonnet 4.6 (Thinking)',
        worktree: '/tmp',
        testCmd: 'npm test',
        logFile,
      });
      assert.equal(v.verdict, 'ship');
      assert.equal(v.hollowTest.ok, false);
    });
    const logged = readFileSync(logFile, 'utf8');
    assert.match(logged, /Unavailable for this prosecution:/, 'the unavailable-evidence branch renders its lead-in text, not a blank/null section');
    assert.match(logged, /is not itself a finding/, 'the unavailable-evidence branch renders its full explanatory text');
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
