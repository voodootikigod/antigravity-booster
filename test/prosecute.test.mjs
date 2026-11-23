import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prosecute, runHollowTest, blockingFindings } from '../lib/prosecute.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

const FAKE_ENV_KEYS = [
  'AGB_AGY_BIN',
  'AGB_ADLC_BIN',
  'AGB_ALLOW_CUSTOM_ADLC_CLI',
  'AGB_SANDBOX_GATES',
  'FAKE_PROSECUTOR_VERDICT',
  'FAKE_HOLLOW_TEST_MODE',
  'FAKE_STATE_DIR',
];

function withFakes(env, fn) {
  const prev = {};
  const keys = new Set([...FAKE_ENV_KEYS, ...Object.keys(env)]);
  for (const k of keys) prev[k] = process.env[k];
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.AGB_ADLC_BIN = FAKE_ADLC;
  process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = '1';
  process.env.AGB_SANDBOX_GATES = '0';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
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

// The gate's core promise: the JSON contract decides, not the model's opinion.
// A model that reports a high-severity finding and then says "ship" anyway must
// not be able to talk its way past the merge. Kept separate from the hollow-test
// cases above so this asserts the severity path specifically — with hollow-test
// clean, `modelBlocking` is the only thing that can produce a block.
test('prosecute: a high-severity finding blocks even when the model votes ship', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship-with-high', FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
    const v = await prosecute({
      ticket: { id: 'T1', body: 'spec' },
      diff: 'real diff',
      model: 'Claude Sonnet 4.6 (Thinking)',
      worktree: '/tmp',
      testCmd: 'npm test',
    });
    assert.equal(v.hollowTest.survived, 0, 'hollow-test is clean, so severity is the only possible cause of a block');
    assert.equal(v.verdict, 'block', 'a high-severity finding is not overrulable by the model\'s ship verdict');
    assert.equal(blockingFindings(v.findings).length, 1);
  });
});

test('prosecute: a critical-severity finding blocks even when the model votes ship', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship-with-critical', FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
    const v = await prosecute({
      ticket: { id: 'T1', body: 'spec' },
      diff: 'real diff',
      model: 'Claude Sonnet 4.6 (Thinking)',
      worktree: '/tmp',
      testCmd: 'npm test',
    });
    assert.equal(v.hollowTest.survived, 0);
    assert.equal(v.verdict, 'block');
    assert.equal(blockingFindings(v.findings)[0].severity, 'critical');
  });
});

// The other half of the contract: severity is a threshold, not "any finding".
// Without this, `findings.length > 0` would pass the test above while blocking
// every cosmetic nit and making the gate useless.
test('prosecute: a low-severity finding does not block a ship verdict', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship-with-low', FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
    const v = await prosecute({
      ticket: { id: 'T1', body: 'spec' },
      diff: 'real diff',
      model: 'Claude Sonnet 4.6 (Thinking)',
      worktree: '/tmp',
      testCmd: 'npm test',
    });
    assert.equal(v.findings.length, 1, 'the low finding is still reported');
    assert.equal(blockingFindings(v.findings).length, 0, 'but it is not merge-gating');
    assert.equal(v.verdict, 'ship');
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

    // The transcript is JSONL, one record per agy call. role and strike are what
    // let a reader (and checkFlailDetector) tell a prosecution apart from a
    // builder attempt; a prosecution is never a builder strike.
    const record = JSON.parse(logged.trim().split('\n')[0]);
    assert.equal(record.role, 'prosecutor');
    assert.equal(record.strike, 0, 'prosecution must not be recorded as a builder strike');
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

test('prosecute: passes the project option to runAgy', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-log-'));
  const logFile = join(logDir, 'prosecution.log');
  const prevState = process.env.FAKE_STATE_DIR;
  process.env.FAKE_STATE_DIR = logDir;
  try {
    await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship' }, async () => {
      await prosecute({
        ticket: { id: 'T1', body: 'spec' },
        diff: 'real diff',
        model: 'Claude Sonnet 4.6 (Thinking)',
        logFile,
        project: 'test-prosecute-proj',
      });
    });
    const argvSeen = readFileSync(join(logDir, 'agy-argv-seen'), 'utf8');
    assert.match(argvSeen, /--project test-prosecute-proj/, 'prosecute passes the project flag to agy');
  } finally {
    if (prevState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = prevState;
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('prosecute: forwards adlcBin to runHollowTest (#122)', async () => {
  await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_HOLLOW_TEST_MODE: 'survivors' }, async () => {
    const v = await prosecute({
      ticket: { id: 'T1', body: 'spec' },
      diff: 'real diff',
      model: 'Claude Sonnet 4.6 (Thinking)',
      worktree: '/tmp',
      testCmd: 'npm test',
      adlcBin: FAKE_ADLC,
    });
    assert.equal(v.hollowTest.ok, true);
    assert.equal(v.hollowTest.survived, 1);
    assert.equal(v.verdict, 'block');
  });
});

test('prosecute: normalizes verdict to ship when model returns block with only low/medium findings and no hollow-test survivors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-prosecute-lowblock-'));
  const customAgy = join(dir, 'agy');
  writeFileSync(
    customAgy,
    `#!/bin/sh\necho '{"verdict":"block","findings":[{"severity":"low","charge":"style","file":"a.js","claim":"nit","evidence":"x"}]}'\n`,
    { mode: 0o755 },
  );
  try {
    await withFakes({ AGB_AGY_BIN: customAgy }, async () => {
      const v = await prosecute({
        ticket: { id: 'T1', body: 'spec' },
        diff: 'real diff',
        model: 'Claude Sonnet 4.6 (Thinking)',
      });
      assert.equal(v.verdict, 'ship');
      assert.equal(v.findings.length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blockingFindings and prosecute: normalize mixed-case severities ("HIGH", "Critical") so they block', async () => {
  const mixed = [
    { severity: 'HIGH', claim: 'uppercase high' },
    { severity: 'Critical', claim: 'titlecase critical' },
    { severity: '  high  ', claim: 'padded high' },
    { severity: 'MEDIUM', claim: 'uppercase medium' },
    { severity: 'LOW', claim: 'uppercase low' },
    { claim: 'missing severity' },
  ];
  const blocked = blockingFindings(mixed);
  assert.deepEqual(
    blocked.map((f) => f.claim),
    ['uppercase high', 'titlecase critical', 'padded high'],
  );

  const dir = mkdtempSync(join(tmpdir(), 'agb-prosecute-mixed-sev-'));
  const highBlockAgy = join(dir, 'agy-high');
  const critShipAgy = join(dir, 'agy-crit');
  writeFileSync(
    highBlockAgy,
    `#!/bin/sh\necho '{"verdict":"block","findings":[{"severity":"HIGH","charge":"correctness","file":"a.mjs","claim":"mixed-case high","evidence":"line 1"}]}'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    critShipAgy,
    `#!/bin/sh\necho '{"verdict":"ship","findings":[{"severity":"Critical","charge":"security","file":"a.mjs","claim":"mixed-case critical","evidence":"line 2"}]}'\n`,
    { mode: 0o755 },
  );
  try {
    await withFakes({ AGB_AGY_BIN: highBlockAgy }, async () => {
      const v = await prosecute({
        ticket: { id: 'T1', body: 'spec' },
        diff: 'real diff',
        model: 'Claude Sonnet 4.6 (Thinking)',
      });
      assert.equal(v.verdict, 'block', 'mixed-case HIGH must not flip block verdict to ship');
      assert.equal(blockingFindings(v.findings).length, 1);
    });

    await withFakes({ AGB_AGY_BIN: critShipAgy }, async () => {
      const v = await prosecute({
        ticket: { id: 'T1', body: 'spec' },
        diff: 'real diff',
        model: 'Claude Sonnet 4.6 (Thinking)',
      });
      assert.equal(v.verdict, 'block', 'mixed-case Critical must force block even when model votes ship');
      assert.equal(blockingFindings(v.findings).length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runHollowTest: only substitutes fastHollowTest for compatible Node test commands (npm test / node --test) and executes non-Node commands directly', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'agb-ht-fast-wt-'));
  const state = mkdtempSync(join(tmpdir(), 'agb-ht-fast-state-'));
  try {
    mkdirSync(join(worktree, 'lib'), { recursive: true });
    mkdirSync(join(worktree, 'test'), { recursive: true });
    writeFileSync(join(worktree, 'lib', 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
    writeFileSync(join(worktree, 'test', 'calc.test.mjs'), 'import { add } from "../lib/calc.mjs";\n');

    await withFakes({ FAKE_HOLLOW_TEST_MODE: 'clean', FAKE_STATE_DIR: state }, async () => {
      const rNpm = await runHollowTest({ worktree, testCmd: 'npm test', changedFiles: ['lib/calc.mjs'] });
      assert.equal(rNpm.ok, true);

      const rNode = await runHollowTest({ worktree, testCmd: 'node --test', changedFiles: ['lib/calc.mjs'] });
      assert.equal(rNode.ok, true);

      const rPytest = await runHollowTest({ worktree, testCmd: 'pytest', changedFiles: ['lib/calc.mjs'] });
      assert.equal(rPytest.ok, true);

      const rVitest = await runHollowTest({ worktree, testCmd: 'vitest run', changedFiles: ['lib/calc.mjs'] });
      assert.equal(rVitest.ok, true);

      const rCustomNpm = await runHollowTest({ worktree, testCmd: 'npm run test:e2e', changedFiles: ['lib/calc.mjs'] });
      assert.equal(rCustomNpm.ok, true);
    });

    const lines = readFileSync(join(state, 'hollow-test-invocations'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    assert.equal(lines[0], 'test-cmd=node --test test/calc.test.mjs base=main');
    assert.equal(lines[1], 'test-cmd=node --test test/calc.test.mjs base=main');
    assert.equal(lines[2], 'test-cmd=pytest base=main');
    assert.equal(lines[3], 'test-cmd=vitest run base=main');
    assert.equal(lines[4], 'test-cmd=npm run test:e2e base=main');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runHollowTest: wraps adlc hollow-test in OS sandbox unless AGB_SANDBOX_GATES=0 and fails closed when unavailable', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'agb-ht-sbx-wt-'));
  const state = mkdtempSync(join(tmpdir(), 'agb-ht-sbx-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-ht-sbx-bin-'));
  const emptyBinDir = mkdtempSync(join(tmpdir(), 'agb-ht-sbx-empty-'));
  const beforeSbxDirs = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('agb-prosecute-ht-sbx-')));
  try {
    // 1. Missing worktree fails closed when sandboxing is enabled
    await withFakes({ AGB_SANDBOX_GATES: undefined, FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
      const noWt = await runHollowTest({ testCmd: 'npm test' });
      assert.equal(noWt.ok, false);
      assert.match(noWt.error, /gate sandbox requires a worktree path/);
    });

    if (process.platform === 'linux') {
      // 2. Fails closed when bwrap is unavailable on PATH and AGB_SANDBOX_GATES !== '0'
      await withFakes({ AGB_SANDBOX_GATES: undefined, PATH: emptyBinDir, FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
        const failClosed = await runHollowTest({ worktree, testCmd: 'npm test' });
        assert.equal(failClosed.ok, false);
        assert.match(failClosed.error, /gate sandbox unavailable/);
      });

      // 3. Wraps --test-cmd in bwrap (leaving authenticated adlc hollow-test outside so gitDir inflight record stays writable)
      const bwrapLog = join(state, 'bwrap.log');
      const fakeBwrap = join(binDir, 'bwrap');
      writeFileSync(
        fakeBwrap,
        [
          '#!/bin/sh',
          `printf '%s\\n' "$*" >> ${JSON.stringify(bwrapLog)}`,
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "--" ]; then shift; break; fi',
          '  shift',
          'done',
          'exec "$@"',
        ].join('\n'),
        { mode: 0o755 },
      );

      await withFakes(
        {
          AGB_SANDBOX_GATES: undefined,
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_HOLLOW_TEST_MODE: 'clean',
          FAKE_STATE_DIR: state,
        },
        async () => {
          const r = await runHollowTest({ worktree, testCmd: 'npm test', base: 'main' });
          assert.equal(r.ok, true, r.error);
          assert.equal(r.total, 2);
          assert.equal(r.survived, 0);
        },
      );

      const htLog = readFileSync(join(state, 'hollow-test-invocations'), 'utf8');
      assert.match(htLog, /^test-cmd='?bwrap'? .*--unshare-net.*npm test.* base=main/);
    }

    const afterSbxDirs = readdirSync(tmpdir()).filter((n) => n.startsWith('agb-prosecute-ht-sbx-') && !beforeSbxDirs.has(n));
    assert.deepEqual(afterSbxDirs, [], 'sandbox temp dirs must be cleaned up');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(emptyBinDir, { recursive: true, force: true });
  }
});

test('runHollowTest: real vendored adlc hollow-test succeeds under real OS sandbox without EROFS on gitDir', async () => {
  const { execFileSync } = await import('node:child_process');
  const { gateSandboxAvailable } = await import('../lib/gates.mjs');
  if (!gateSandboxAvailable()) return;

  const repo = mkdtempSync(join(tmpdir(), 'agb-prosecute-real-ht-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) { return a + b; }\n');
    writeFileSync(join(repo, 'math.test.mjs'), 'import assert from "node:assert/strict"; import { add } from "./math.mjs"; assert.equal(add(2, 3), 5);\n');
    g('add', '-A');
    g('commit', '-qm', 'init');

    g('checkout', '-qb', 'feat');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  if (a < 0) return 0;\n  return a + b;\n}\n');
    writeFileSync(join(repo, 'math.test.mjs'), 'import assert from "node:assert/strict"; import { add } from "./math.mjs"; assert.equal(add(-1, 7), 0); assert.equal(add(0, 7), 7); assert.equal(add(2, 3), 5);\n');
    g('add', '-A');
    g('commit', '-qm', 'feat');

    const prevSbx = process.env.AGB_SANDBOX_GATES;
    const prevBin = process.env.AGB_ADLC_BIN;
    try {
      delete process.env.AGB_SANDBOX_GATES;
      delete process.env.AGB_ADLC_BIN;
      const r = await runHollowTest({ worktree: repo, testCmd: `${process.execPath} math.test.mjs`, base: 'main', fastHollowTest: false });
      assert.equal(r.ok, true, `real vendored adlc hollow-test must succeed under OS sandbox, got: ${r.error}`);
      assert.ok(r.total >= 1, `expected >= 1 mutant tested, got ${r.total}`);
      assert.equal(r.survived, 0, 'all mutants should be killed by math.test.mjs');
    } finally {
      if (prevSbx === undefined) delete process.env.AGB_SANDBOX_GATES; else process.env.AGB_SANDBOX_GATES = prevSbx;
      if (prevBin === undefined) delete process.env.AGB_ADLC_BIN; else process.env.AGB_ADLC_BIN = prevBin;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});



