import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prosecute, prepareProsecutionPrecheck, runHollowTest, blockingFindings } from '../lib/prosecute.mjs';
import { DecisionEngine } from '../lib/decision-engine.mjs';

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
        shortCircuitHollowTest: false,
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
  const worktree = mkdtempSync(join(tmpdir(), 'agb-prosecute-wt-'));
  const state = mkdtempSync(join(tmpdir(), 'agb-prosecute-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-bin-'));
  const emptyBinDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-empty-'));
  const isolatedTmp = mkdtempSync(join(tmpdir(), 'agb-prosecute-ht-tmp-'));
  const tmpEnv = { TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp };
  try {
    // 1. Missing worktree fails closed when sandboxing is enabled
    await withFakes({ ...tmpEnv, AGB_SANDBOX_GATES: undefined, FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
      const noWt = await runHollowTest({ testCmd: 'npm test' });
      assert.equal(noWt.ok, false);
      assert.match(noWt.error, /gate sandbox requires a worktree path/);
    });

    if (process.platform === 'linux') {
      // 2. Fails closed when bwrap is unavailable on PATH and AGB_SANDBOX_GATES !== '0'
      await withFakes({ ...tmpEnv, AGB_SANDBOX_GATES: undefined, PATH: emptyBinDir, FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
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
          ...tmpEnv,
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
      assert.ok(htLog.includes(isolatedTmp), 'sandbox temp dir must be created inside isolated TMPDIR');
    }

    const leakedSbxDirs = readdirSync(isolatedTmp).filter((n) => n.startsWith('agb-prosecute-ht-sbx-'));
    assert.deepEqual(leakedSbxDirs, [], 'sandbox temp dirs must be cleaned up');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(emptyBinDir, { recursive: true, force: true });
    rmSync(isolatedTmp, { recursive: true, force: true });
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

test('resolveHollowTestCommand & runHollowTest: excludes dist/** bundles and slow shell/bwrap suites when fast unit tests exist', async () => {
  const { resolveHollowTestCommand } = await import('../lib/prosecute.mjs');
  const { execFileSync } = await import('node:child_process');
  const cmdMixed = resolveHollowTestCommand(
    [
      'bin/hook-runner.sh',
      'dist/hooks/pre-tool-use.bundle.mjs',
      'hooks/policy/verdict.mjs',
      'test/hook-runner.test.mjs',
      'test/pre-tool-use.test.mjs',
    ],
    { repo: process.cwd(), fallbackTestCmd: 'npm test' },
  );
  assert.match(cmdMixed, /^node --test /);
  assert.ok(cmdMixed.includes('test/pre-tool-use.test.mjs'));
  assert.equal(cmdMixed.includes('test/hook-runner.test.mjs'), false);
  assert.equal(cmdMixed.includes('test/orchestrator-routing.test.mjs'), false);

  const cmdSlowOnly = resolveHollowTestCommand(
    ['test/orchestrator-routing.test.mjs'],
    { repo: process.cwd(), fallbackTestCmd: 'npm test' },
  );
  assert.equal(cmdSlowOnly, 'node --test test/orchestrator-routing.test.mjs');

  const repo = mkdtempSync(join(tmpdir(), 'agb-prosecute-dist-ht-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'dist', 'hooks'), { recursive: true });
    writeFileSync(join(repo, 'src.mjs'), 'export const flag = (x) => x > 0;\n');
    writeFileSync(join(repo, 'dist', 'hooks', 'bundle.mjs'), 'export const untouchedBundle = (y) => y === 42;\n');
    writeFileSync(
      join(repo, 'src.test.mjs'),
      'import assert from "node:assert/strict"; import { flag } from "./src.mjs"; assert.equal(flag(1), true); assert.equal(flag(0), false);\n',
    );
    g('add', '-A');
    g('commit', '-qm', 'init');

    g('checkout', '-qb', 'feat');
    writeFileSync(join(repo, 'src.mjs'), 'export const flag = (x) => x >= 1;\n');
    writeFileSync(join(repo, 'dist', 'hooks', 'bundle.mjs'), 'export const untouchedBundle = (y) => y === 99;\n');
    g('add', '-A');
    g('commit', '-qm', 'feat with rebuilt dist bundle');

    const prevSbx = process.env.AGB_SANDBOX_GATES;
    const prevBin = process.env.AGB_ADLC_BIN;
    try {
      process.env.AGB_SANDBOX_GATES = '0';
      delete process.env.AGB_ADLC_BIN;
      const r = await runHollowTest({
        worktree: repo,
        testCmd: `${process.execPath} src.test.mjs`,
        base: 'main',
        fastHollowTest: false,
      });
      assert.equal(r.ok, true, `expected ok: true, got ${r.error}`);
      assert.equal(r.survived, 0, 'dist/** bundle must not be mutated as hand-authored source');
    } finally {
      if (prevSbx === undefined) delete process.env.AGB_SANDBOX_GATES; else process.env.AGB_SANDBOX_GATES = prevSbx;
      if (prevBin === undefined) delete process.env.AGB_ADLC_BIN; else process.env.AGB_ADLC_BIN = prevBin;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('prosecute forwards optional cryptographic seed for deterministic diff fencing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-prosecute-seed-'));
  const promptOut = join(dir, 'prompt.txt');
  const seedAgy = join(dir, 'agy-seed');
  writeFileSync(
    seedAgy,
    [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'node:fs';",
      'const idx = process.argv.indexOf("--print");',
      `if (idx !== -1) writeFileSync(${JSON.stringify(promptOut)}, process.argv[idx + 1]);`,
      'console.log(JSON.stringify({ verdict: "ship", findings: [] }));',
    ].join('\n'),
    { mode: 0o755 }
  );
  try {
    const seed = '0123456789abcdef0123456789abcdef';
    await withFakes({ AGB_AGY_BIN: seedAgy }, async () => {
      const v1 = await prosecute({
        ticket: { id: 'T-SEED', body: 'spec body', scope: ['lib/a.mjs'] },
        diff: 'diff --git a/lib/a.mjs b/lib/a.mjs\n+export const s = 1;\n',
        model: 'claude-sonnet-5-5-medium',
        builderModel: 'gemini-4-neon-high',
        seed,
      });
      assert.equal(v1.verdict, 'ship');
      assert.equal(v1.prosecutionMode, 'cross-family');
      const p1 = readFileSync(promptOut, 'utf8');

      const v2 = await prosecute({
        ticket: { id: 'T-SEED', body: 'spec body', scope: ['lib/a.mjs'] },
        diff: 'diff --git a/lib/a.mjs b/lib/a.mjs\n+export const s = 1;\n',
        model: 'gemini-4-carbon-high',
        builderModel: 'gemini-4-neon-high',
        seed,
      });
      assert.equal(v2.prosecutionMode, 'same-family-fallback');
      const p2 = readFileSync(promptOut, 'utf8');
      assert.equal(p1, p2, 'same seed + diff must produce identical prosecution prompt');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- T-TE-5a: hollow-test short-circuit, blast-radius precheck, System-1 fast-ship & telemetry ---

test('prosecute: default shortCircuitHollowTest: true blocks with 0 agy spawns and 0 LLM telemetry', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-prosecute-sc-'));
  let spawnCount = 0;
  let decisionEngineCalls = 0;
  const neverCalledEngine = new DecisionEngine({
    provider: 'jev',
    apiKey: 'sk-test-secret-1234',
    transport: async () => {
      decisionEngineCalls += 1;
      throw new Error('System-1 must not be called when hollow-test short-circuits');
    },
  });
  try {
    await withFakes(
      {
        AGB_AGY_BIN: '/does-not-exist/agy-must-not-spawn',
        FAKE_HOLLOW_TEST_MODE: 'survivors',
        FAKE_STATE_DIR: stateDir,
      },
      async () => {
        const v = await prosecute({
          ticket: {
            id: 'T-SC',
            body: 'spec',
            tier: 'mid',
            scope: ['lib/leaf.mjs'],
            extractedACs: ['ac1'],
          },
          diff: 'diff --git a/lib/leaf.mjs b/lib/leaf.mjs\n--- a/lib/leaf.mjs\n+++ b/lib/leaf.mjs\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n',
          model: 'claude-sonnet-5-5-medium',
          worktree: '/tmp',
          testCmd: 'npm test',
          decisionEngine: neverCalledEngine,
          onSpawn: () => { spawnCount += 1; },
        });
        assert.equal(v.verdict, 'block');
        assert.equal(v.shortCircuited, 'hollow-test');
        assert.equal(v.hollowTest.survived, 1);
        assert.equal(v.blastRadius.level, 'low');
        assert.deepEqual(v.telemetry, {
          uncachedInputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          inputTokens: 0,
          system1Calls: 0,
        });
        assert.ok(v.findings.some((f) => f.charge === 'tests' && f.severity === 'critical'));
        assert.equal(spawnCount, 0, '0 agy subprocesses must spawn on hollow-test short-circuit');
        assert.equal(decisionEngineCalls, 0, 'System-1 engine must not run after hollow-test survivors');
        assert.equal(existsSync(join(stateDir, 'agy-argv-seen')), false);
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('prepareProsecutionPrecheck: computes blastRadius, contextPack, forwards rootRepo + changedFiles to CodeGraph-backed runHollowTest, and avoids duplicate work in prosecute()', async () => {
  const rootRepo = mkdtempSync(join(tmpdir(), 'agb-precheck-root-'));
  const worktree = mkdtempSync(join(tmpdir(), 'agb-precheck-wt-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-precheck-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-precheck-bin-'));
  try {
    mkdirSync(join(rootRepo, '.codegraph'));
    mkdirSync(join(worktree, 'lib'), { recursive: true });
    mkdirSync(join(worktree, 'test'), { recursive: true });
    writeFileSync(join(worktree, 'lib', 'leaf.mjs'), 'export function leafFn(x) {\n  return x + 1;\n}\n');
    writeFileSync(join(worktree, 'lib', 'caller.mjs'), 'import { leafFn } from "./leaf.mjs";\nexport const out = leafFn(2);\n');
    writeFileSync(join(worktree, 'test', 'affected.test.mjs'), 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');

    const cgLog = join(stateDir, 'codegraph.log');
    writeFileSync(
      join(binDir, 'codegraph'),
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(cgLog)}, process.cwd() + '|' + process.argv.slice(2).join(' ') + '\\n');`,
        'const cmd = process.argv[2];',
        'if (cmd === "affected") console.log(JSON.stringify({ affectedTests: ["test/affected.test.mjs"] }));',
        'else if (cmd === "callers") console.log(JSON.stringify({ callers: [{ file: "lib/caller.mjs", line: 2, snippet: "leafFn(2)" }] }));',
        'else if (cmd === "callees") console.log(JSON.stringify({ callees: [] }));',
        'else if (cmd === "impact") console.log(JSON.stringify({ fanIn: 1 }));',
        'else console.log("{}");',
      ].join('\n'),
      { mode: 0o755 },
    );

    const leafDiff = [
      'diff --git a/lib/leaf.mjs b/lib/leaf.mjs',
      '--- a/lib/leaf.mjs',
      '+++ b/lib/leaf.mjs',
      '@@ -1,3 +1,3 @@',
      ' export function leafFn(x) {',
      '-  return x;',
      '+  return x + 1;',
      ' }',
    ].join('\n');

    await withFakes(
      {
        AGB_AGY_BIN: '/does-not-exist/agy-must-not-spawn',
        FAKE_HOLLOW_TEST_MODE: 'clean',
        FAKE_STATE_DIR: stateDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      async () => {
        const precheck = await prepareProsecutionPrecheck({
          ticket: { id: 'T-PRE', body: 'spec', scope: ['lib/leaf.mjs'] },
          diff: leafDiff,
          worktree,
          rootRepo,
          testCmd: 'npm test',
          changedFiles: ['lib/leaf.mjs'],
        });

        assert.equal(precheck.shortCircuited, null);
        assert.equal(precheck.fastShipped, null);
        assert.equal(precheck.hollowTest.ok, true);
        assert.equal(precheck.hollowTest.survived, 0);
        assert.equal(precheck.blastRadius.level, 'low');
        assert.equal(precheck.blastRadius.source, 'codegraph');
        assert.match(precheck.contextPack.contextBlock, /lib\/caller\.mjs/);
        assert.deepEqual(precheck.telemetry, {
          uncachedInputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          inputTokens: 0,
          system1Calls: 0,
        });

        const htInvocations = readFileSync(join(stateDir, 'hollow-test-invocations'), 'utf8').trim().split('\n');
        assert.equal(htInvocations.length, 1);
        assert.equal(htInvocations[0], 'test-cmd=node --test test/affected.test.mjs base=main');

        // Reusing precheck in prosecute() does not re-run adlc hollow-test
        const settingsOut = join(stateDir, 'settings.json');
        const logFile = join(stateDir, 'pros.jsonl');
        await withFakes(
          {
            AGB_AGY_BIN: FAKE_AGY,
            FAKE_PROSECUTOR_VERDICT: 'ship',
            FAKE_SETTINGS_FILE: settingsOut,
            FAKE_STATE_DIR: stateDir,
          },
          async () => {
            const verdict = await prosecute({
              ticket: { id: 'T-PRE', body: 'spec', scope: ['lib/leaf.mjs'] },
              diff: leafDiff,
              model: 'claude-sonnet-5-5-medium',
              worktree,
              rootRepo,
              testCmd: 'npm test',
              logFile,
              precheck,
            });
            assert.equal(verdict.verdict, 'ship');
            assert.equal(verdict.blastRadius.level, 'low');
          },
        );
        const htInvocationsAfter = readFileSync(join(stateDir, 'hollow-test-invocations'), 'utf8').trim().split('\n');
        assert.equal(htInvocationsAfter.length, 1, 'supplying precheck skips duplicate runHollowTest');
        const loggedPrompt = readFileSync(logFile, 'utf8');
        assert.match(loggedPrompt, /lib\/caller\.mjs/, 'contextPack.contextBlock must be embedded in prompt');
        const deny = JSON.parse(readFileSync(settingsOut, 'utf8')).permissions.deny;
        assert.ok(deny.includes('read_file(*)'), 'non-truncated contextPack keeps read tools locked down');

        // Security-sensitive path triggers blastRadius.level === 'high' before any LLM call
        const secPrecheck = await prepareProsecutionPrecheck({
          ticket: { id: 'T-SEC', body: 'spec', scope: ['lib/gates.mjs'] },
          diff: 'diff --git a/lib/gates.mjs b/lib/gates.mjs\n--- a/lib/gates.mjs\n+++ b/lib/gates.mjs\n@@ -1 +1 @@\n-a\n+b\n',
        });
        assert.equal(secPrecheck.blastRadius.touchesSecuritySensitivePath, true);
        assert.equal(secPrecheck.blastRadius.level, 'high');

        // codegraph: false forces static-ast fallback even when rootRepo/.codegraph exists
        const noCgPrecheck = await prepareProsecutionPrecheck({
          ticket: { id: 'T-NOCG', body: 'spec', scope: ['lib/leaf.mjs'] },
          diff: leafDiff,
          worktree,
          rootRepo,
          testCmd: 'npm test',
          changedFiles: ['lib/leaf.mjs'],
          codegraph: false,
        });
        assert.equal(noCgPrecheck.blastRadius.source, 'static-ast');
        assert.equal(noCgPrecheck.contextPack.source, 'static-ast');
      },
    );
  } finally {
    rmSync(rootRepo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('prepareProsecutionPrecheck & prosecute: System-1 fast-ship ships only when all fail-closed conditions hold and escalates otherwise', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'agb-s1-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-s1-state-'));
  try {
    mkdirSync(join(repoDir, '.adlc'), { recursive: true });
    const leafDiff = [
      'diff --git a/lib/leaf.mjs b/lib/leaf.mjs',
      '--- a/lib/leaf.mjs',
      '+++ b/lib/leaf.mjs',
      '@@ -1 +1 @@',
      '-const x = 1;',
      '+const x = 2;',
    ].join('\n');

    const makeEngine = ({ acProb = 0.97, chargeProb = 0.02, confidence = 0.95, fail = false } = {}) => {
      let calls = 0;
      const engine = new DecisionEngine({
        provider: 'jev',
        apiKey: 'sk-test-secret-1234',
        transport: async (_url, init) => {
          calls += 1;
          if (fail) throw new Error('system1 down');
          const items = JSON.parse(init.body).items;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: items.map((i) => ({
                probability: i.id.startsWith('ac') ? acProb : chargeProb,
                confidence,
              })),
            }),
          };
        },
      });
      return { engine, getCalls: () => calls };
    };

    const baseTicket = {
      id: 'T-S1',
      tier: 'mid',
      body: 'Update leaf constant',
      scope: ['lib/leaf.mjs'],
      extractedACs: ['Constant x is updated to 2'],
      charges: ['No regressions'],
    };

    // 1. All fail-closed conditions met -> fastShipped: 'system1', verdict: 'ship', 0 agy spawns
    const fast = makeEngine();
    await withFakes(
      {
        AGB_AGY_BIN: '/does-not-exist/agy-must-not-spawn',
        FAKE_HOLLOW_TEST_MODE: 'clean',
        FAKE_STATE_DIR: stateDir,
      },
      async () => {
        const pre = await prepareProsecutionPrecheck({
          ticket: baseTicket,
          diff: leafDiff,
          worktree: repoDir,
          rootRepo: repoDir,
          testCmd: 'npm test',
          decisionEngine: fast.engine,
        });
        assert.equal(pre.fastShipped, 'system1');
        assert.equal(pre.decisionRes.fastShip, true);
        assert.equal(pre.decisionRes.model, 'jev-latest');
        assert.equal(pre.telemetry.system1Calls, 1);

        const res = await prosecute({
          ticket: baseTicket,
          diff: leafDiff,
          model: 'claude-sonnet-5-5-medium',
          worktree: repoDir,
          rootRepo: repoDir,
          testCmd: 'npm test',
          decisionEngine: fast.engine,
        });
        assert.equal(res.verdict, 'ship');
        assert.equal(res.fastShipped, 'system1');
        assert.equal(res.model, 'jev-latest');
        assert.deepEqual(res.findings, []);
        assert.equal(res.telemetry.system1Calls, 1);
        assert.equal(fast.getCalls(), 2);
        assert.equal(existsSync(join(stateDir, 'agy-argv-seen')), false, '0 agy processes spawned on fast-ship');
      },
    );

    // 2. Fail-closed pre-guards (no System-1 network call, must escalate to System-2 runAgy):
    //    - frontier tier
    //    - missing extractedACs
    //    - blastRadius !== 'low' (security-sensitive path)
    //    - hollowTest.total === 0 (without worktree/testCmd or zero mutants)
    //    - decisionEngine: false opt-out
    const guardCases = [
      { label: 'frontier tier', ticket: { ...baseTicket, tier: 'frontier' }, diff: leafDiff, worktree: repoDir, testCmd: 'npm test' },
      { label: 'empty extractedACs', ticket: { ...baseTicket, extractedACs: [] }, diff: leafDiff, worktree: repoDir, testCmd: 'npm test' },
      {
        label: 'high blastRadius',
        ticket: { ...baseTicket, scope: ['lib/gates.mjs'] },
        diff: 'diff --git a/lib/gates.mjs b/lib/gates.mjs\n--- a/lib/gates.mjs\n+++ b/lib/gates.mjs\n@@ -1 +1 @@\n-a\n+b\n',
        worktree: repoDir,
        testCmd: 'npm test',
      },
      { label: 'hollowTest missing (no worktree)', ticket: baseTicket, diff: leafDiff, worktree: undefined, testCmd: undefined },
    ];

    for (const tc of guardCases) {
      const guardEng = makeEngine();
      await withFakes({ FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
        const res = await prosecute({
          ticket: tc.ticket,
          diff: tc.diff,
          model: 'claude-sonnet-5-5-medium',
          worktree: tc.worktree,
          rootRepo: tc.worktree ? repoDir : undefined,
          testCmd: tc.testCmd,
          decisionEngine: guardEng.engine,
        });
        assert.equal(res.verdict, 'ship', tc.label);
        assert.equal(res.fastShipped, undefined, `${tc.label} must not fast-ship`);
        assert.equal(guardEng.getCalls(), 0, `${tc.label} must fail closed before calling System-1`);
        assert.equal(res.telemetry.system1Calls, 0, tc.label);
      });
    }

    // 3. Fail-closed post-decision guards (1 System-1 call made, escalates to System-2 runAgy with system1Calls: 1)
    const escalateEngines = [
      { label: 'low confidence', eng: makeEngine({ confidence: 0.7 }) },
      { label: 'low AC probability', eng: makeEngine({ acProb: 0.8 }) },
      { label: 'high charge risk', eng: makeEngine({ chargeProb: 0.25 }) },
      { label: 'transport failure', eng: makeEngine({ fail: true }) },
    ];

    for (const { label, eng } of escalateEngines) {
      await withFakes({ FAKE_PROSECUTOR_VERDICT: 'block', FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
        const res = await prosecute({
          ticket: baseTicket,
          diff: leafDiff,
          model: 'claude-sonnet-5-5-medium',
          worktree: repoDir,
          rootRepo: repoDir,
          testCmd: 'npm test',
          decisionEngine: eng.engine,
        });
        assert.equal(res.verdict, 'block', `${label} must escalate to System-2 prosecutor`);
        assert.equal(res.fastShipped, undefined, label);
        assert.equal(eng.getCalls(), 1, label);
        assert.equal(res.telemetry.system1Calls, 1, label);
      });
    }

    // 4. decisionEngine: false skips System-1 even when env/config would configure it
    const prevProvider = process.env.AGB_DECISION_PROVIDER;
    const prevKey = process.env.TYPESAFE_API_KEY;
    try {
      process.env.AGB_DECISION_PROVIDER = 'jev';
      process.env.TYPESAFE_API_KEY = 'sk-test-secret-1234';
      const preOff = await prepareProsecutionPrecheck({
        ticket: baseTicket,
        diff: leafDiff,
        rootRepo: repoDir,
        decisionEngine: false,
      });
      assert.equal(preOff.fastShipped, null);
      assert.equal(preOff.decisionRes, null);
      assert.equal(preOff.telemetry.system1Calls, 0);
    } finally {
      if (prevProvider === undefined) delete process.env.AGB_DECISION_PROVIDER;
      else process.env.AGB_DECISION_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prevKey;
    }

    // 5. Omitting decisionEngine resolves .adlc/config.json via resolveDecisionConfig({ repo: rootRepo ?? worktree })
    const origFetch = globalThis.fetch;
    let fetchedUrl = null;
    globalThis.fetch = async (url, init) => {
      fetchedUrl = String(url);
      const items = JSON.parse(init.body).items ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'kev-local',
          answers: items.map((i) => ({
            probability: i.id.startsWith('ac') ? 0.96 : 0.03,
            confidence: 0.94,
          })),
        }),
      };
    };
    try {
      writeFileSync(
        join(repoDir, '.adlc', 'config.json'),
        JSON.stringify({
          accelerators: {
            decision: {
              enabled: true,
              provider: 'kev',
              baseUrl: 'http://127.0.0.1:18080/v1',
            },
          },
        }),
      );
      await withFakes({ FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
        const cfgPre = await prepareProsecutionPrecheck({
          ticket: baseTicket,
          diff: leafDiff,
          worktree: repoDir,
          rootRepo: repoDir,
          testCmd: 'npm test',
        });
        assert.equal(fetchedUrl, 'http://127.0.0.1:18080/v1');
        assert.equal(cfgPre.fastShipped, 'system1');
        assert.equal(cfgPre.decisionRes.model, 'kev-local');
        assert.equal(cfgPre.telemetry.system1Calls, 1);
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('prosecute: clean run forwards observed token telemetry, aggregates System-1 escalation calls, and toggles allowReadTools on truncatedContext', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-prosecute-tel-'));
  const settingsOut = join(dir, 'settings.json');
  const telemetryAgy = join(dir, 'agy-tel');
  writeFileSync(
    telemetryAgy,
    [
      '#!/bin/sh',
      'echo \'{"status":"SUCCESS","structured_output":{"verdict":"ship","findings":[]},"telemetry":{"input_tokens":1000,"cached_tokens":700,"output_tokens":150}}\'',
    ].join('\n'),
    { mode: 0o755 },
  );
  try {
    await withFakes({ AGB_AGY_BIN: telemetryAgy, FAKE_HOLLOW_TEST_MODE: 'clean' }, async () => {
      // Pure System-2 prosecution forwards exact observed token telemetry
      const v1 = await prosecute({
        ticket: { id: 'T-TEL-1', body: 'spec', scope: ['lib/a.mjs'] },
        diff: 'diff --git a/lib/a.mjs b/lib/a.mjs\n+export const a = 1;\n',
        model: 'claude-sonnet-5-5-medium',
        worktree: dir,
        testCmd: 'npm test',
      });
      assert.equal(v1.verdict, 'ship');
      assert.deepEqual(v1.telemetry, {
        uncachedInputTokens: 300,
        cachedTokens: 700,
        outputTokens: 150,
        inputTokens: 1000,
        system1Calls: 0,
      });

      // Escalated System-1 + System-2 prosecution aggregates both
      const lowConfEngine = new DecisionEngine({
        provider: 'jev',
        apiKey: 'sk-test-secret-1234',
        transport: async (_url, init) => {
          const items = JSON.parse(init.body).items;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: items.map(() => ({ probability: 0.99, confidence: 0.4 })),
            }),
          };
        },
      });
      const v2 = await prosecute({
        ticket: { id: 'T-TEL-2', tier: 'mid', body: 'spec', scope: ['lib/a.mjs'], extractedACs: ['ac'] },
        diff: 'diff --git a/lib/a.mjs b/lib/a.mjs\n+export const a = 1;\n',
        model: 'claude-sonnet-5-5-medium',
        worktree: dir,
        testCmd: 'npm test',
        decisionEngine: lowConfEngine,
      });
      assert.equal(v2.verdict, 'ship');
      assert.deepEqual(v2.telemetry, {
        uncachedInputTokens: 300,
        cachedTokens: 700,
        outputTokens: 150,
        inputTokens: 1000,
        system1Calls: 1,
      });
    });

    // Truncated precheck contextPack forwards allowReadTools: true into agy --settings
    await withFakes({ AGB_AGY_BIN: FAKE_AGY, FAKE_PROSECUTOR_VERDICT: 'ship', FAKE_SETTINGS_FILE: settingsOut }, async () => {
      const v3 = await prosecute({
        ticket: { id: 'T-TRUNC', body: 'spec' },
        diff: 'real diff',
        model: 'claude-sonnet-5-5-medium',
        precheck: {
          hollowTest: null,
          blastRadius: { level: 'low' },
          contextPack: { contextBlock: '<<UNTRUSTED:CALLERS:1>>\n...\n<</UNTRUSTED:CALLERS:1>>', truncatedContext: true },
          shortCircuited: null,
          fastShipped: null,
          decisionRes: null,
          telemetry: { uncachedInputTokens: 0, cachedTokens: 0, outputTokens: 0, inputTokens: 0, system1Calls: 0 },
        },
      });
      assert.equal(v3.verdict, 'ship');
      const deny = JSON.parse(readFileSync(settingsOut, 'utf8')).permissions.deny;
      assert.equal(deny.includes('read_file(*)'), false, 'truncatedContext must permit read_file(*) via allowReadTools: true');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProsecutionMode: classifies cross-family, same-family-fallback, missing args, and unknown model strings', async () => {
  const { resolveProsecutionMode } = await import('../lib/prosecute.mjs');
  assert.equal(resolveProsecutionMode(null, 'gemini-4-neon-high'), 'cross-family');
  assert.equal(resolveProsecutionMode('claude-sonnet-5-5-high', null), 'cross-family');
  assert.equal(resolveProsecutionMode('', ''), 'cross-family');
  assert.equal(resolveProsecutionMode('claude-sonnet-5-5-high', 'gemini-4-neon-high'), 'cross-family');
  assert.equal(resolveProsecutionMode('gemini-4-carbon-high', 'gemini-4-neon-high'), 'same-family-fallback');
  assert.equal(resolveProsecutionMode('claude-opus-5-5-high', 'claude-sonnet-5-5-medium'), 'same-family-fallback');
  assert.equal(resolveProsecutionMode('unknown-noncatalog-model', 'gemini-4-neon-high'), 'cross-family');
  assert.equal(resolveProsecutionMode('gemini-4-neon-high', 'unknown-noncatalog-model'), 'cross-family');
});

test('prosecute: blocks empty and oversized diffs and propagates prosecutionMode on agy errors', async () => {
  const emptyRes = await prosecute({
    ticket: { id: 'T-EMPTY', body: 'spec', scope: ['lib/a.mjs'] },
    diff: '   \n\t  ',
    model: 'gemini-4-carbon-high',
    builderModel: 'gemini-4-neon-high',
  });
  assert.equal(emptyRes.verdict, 'block');
  assert.equal(emptyRes.model, 'gemini-4-carbon-high');
  assert.equal(emptyRes.prosecutionMode, 'same-family-fallback');
  assert.equal(emptyRes.findings.length, 1);
  assert.match(emptyRes.findings[0].claim, /empty diff/);

  const hugeRes = await prosecute({
    ticket: { id: 'T-HUGE', body: 'spec', scope: ['lib/a.mjs'] },
    diff: `diff --git a/lib/a.mjs b/lib/a.mjs\n+${'x'.repeat(120_050)}\n`,
    model: 'claude-sonnet-5-5-high',
    builderModel: 'gemini-4-neon-high',
  });
  assert.equal(hugeRes.verdict, 'block');
  assert.equal(hugeRes.prosecutionMode, 'cross-family');
  assert.match(hugeRes.findings[0].claim, /diff too large/);

  const dir = mkdtempSync(join(tmpdir(), 'agb-pros-badjson-'));
  const badAgy = join(dir, 'agy');
  writeFileSync(badAgy, '#!/usr/bin/env bash\necho "not valid json"\nexit 0\n', { mode: 0o755 });
  try {
    await withFakes({ AGB_AGY_BIN: badAgy }, async () => {
      const errRes = await prosecute({
        ticket: { id: 'T-BAD', body: 'spec', scope: ['lib/a.mjs'] },
        diff: 'diff --git a/lib/a.mjs b/lib/a.mjs\n+export const z = 1;\n',
        model: 'gemini-4-carbon-high',
        builderModel: 'gemini-4-neon-high',
      });
      assert.equal(errRes.verdict, 'error');
      assert.equal(errRes.model, 'gemini-4-carbon-high');
      assert.equal(errRes.prosecutionMode, 'same-family-fallback');
      assert.deepEqual(errRes.findings, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
