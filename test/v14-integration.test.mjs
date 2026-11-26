import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  realpathSync,
  chmodSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runAgy,
  prepareBuilderContainment,
  NdjsonWorkerDaemon,
  buildRoleSettingsProfile,
  StreamWatchdog,
  resolveDynamicEffort,
} from '../lib/agy.mjs';
import {
  runSymbolScopeVerification,
  prepareTicketContextAndTdd,
  resolveTicketGateConfig,
  executeSpeculativeMergeBatch,
  BanditModelRouter,
  syncOverviewPaneState,
} from '../lib/scheduler.mjs';
import { compilePlanToWorkflow } from '../lib/plan.mjs';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';
import { writeAdlcTickets } from '../lib/adlc-bridge.mjs';
import { arbiterPrompt } from '../lib/review.mjs';

const FAKE_AGY = join(process.cwd(), 'test', 'fixtures', 'fake-agy');
const AGB_BIN = join(process.cwd(), 'bin', 'agb.mjs');

test('v1.4 integration: runAgy supports --settings and --effort and re-exports NdjsonWorkerDaemon & StreamWatchdog', async () => {
  assert.equal(typeof NdjsonWorkerDaemon, 'function');
  assert.equal(typeof buildRoleSettingsProfile, 'function');
  assert.equal(typeof StreamWatchdog, 'function');
  assert.equal(typeof resolveDynamicEffort, 'function');

  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-agy-'));
  const settingsOut = join(dir, 'settings.json');
  try {
    const res = await runAgy({
      model: 'gemini-4-neon-medium',
      prompt: 'Reply OK',
      cwd: dir,
      bin: FAKE_AGY,
      useRoleSettings: true,
      role: 'prosecutor',
      effort: 'high',
      worker: { mode: 'readonly' },
      env: { FAKE_SETTINGS_FILE: settingsOut },
    });
    assert.equal(res.ok, true);
    assert.ok(existsSync(settingsOut));
    const parsed = JSON.parse(readFileSync(settingsOut, 'utf8'));
    assert.deepEqual(Object.keys(parsed), ['allowNonWorkspaceAccess', 'permissions']);
    assert.equal(parsed.allowNonWorkspaceAccess, false);
    assert.ok(Array.isArray(parsed.permissions.deny));
    assert.ok(parsed.permissions.deny.includes('write_file(*)'));
    assert.ok(parsed.permissions.deny.includes('command(*)'));
    assert.ok(parsed.permissions.deny.includes('mcp(*)'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4 integration: scheduler-verify delegation wrappers orchestrate context slicing, TDD split, symbol verification, delta gates, and speculative merge bisection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-sched-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(
      join(dir, 'lib', 'calc.mjs'),
      'export function add(a, b) {\n  return a + b;\n}\n\nexport function frozenMul(a, b) {\n  return a * b;\n}\n'
    );
    writeFileSync(
      join(dir, 'test', 'calc.test.mjs'),
      'import { add } from "../lib/calc.mjs";\n'
    );

    const ticket = {
      id: 'T-FRONT-1',
      title: 'Enhance calculator',
      tier: 'frontier',
      pool_hint: 'gemini',
      scope: ['lib/calc.mjs', 'test/calc.test.mjs'],
      rails: ['lib/lock.mjs'],
      symbol_scope: ['lib/calc.mjs#add'],
      symbol_rails: ['lib/calc.mjs#frozenMul'],
      body: 'Update add(a, b).',
    };

    const prep = prepareTicketContextAndTdd(ticket, {}, {
      repo: dir,
      builderModel: 'gemini-4-neon-high',
    });
    assert.equal(prep.contextSlice.ok, true);
    assert.equal(prep.tddEnabled, true);
    assert.equal(prep.tddPartition.specPoolHint, 'claude-gpt');
    assert.deepEqual(prep.tddPartition.testScope, ['test/calc.test.mjs']);

    const symPass = runSymbolScopeVerification(
      ticket,
      '--- a/lib/calc.mjs\n+++ b/lib/calc.mjs\n@@ -2,1 +2,1 @@\n-  return a + b;\n+  return Number(a) + Number(b);\n',
      { repo: dir }
    );
    assert.equal(symPass.ok, true);

    const strikeGate = resolveTicketGateConfig(
      { test: 'npm test' },
      ['lib/calc.mjs'],
      { repo: dir, phase: 'strike0' }
    );
    assert.equal(strikeGate.fast, true);
    assert.equal(strikeGate.test, 'node --test test/calc.test.mjs');

    const mergeGate = resolveTicketGateConfig(
      { test: 'npm test' },
      ['lib/calc.mjs'],
      { repo: dir, phase: 'merge' }
    );
    assert.equal(mergeGate.fast, false);
    assert.equal(mergeGate.test, 'npm test');

    // Speculative merge batch with 1 poison ticket ("T-BAD") isolated via bisection
    const ready = [
      { id: 'T-OK1', scope: ['lib/a.mjs'], changedFiles: ['lib/a.mjs'] },
      { id: 'T-BAD', scope: ['lib/b.mjs'], changedFiles: ['lib/b.mjs'] },
      { id: 'T-OK2', scope: ['lib/c.mjs'], changedFiles: ['lib/c.mjs'] },
    ];
    const batchRes = await executeSpeculativeMergeBatch(
      ready,
      async (batch) => {
        const hasBad = batch.some((t) => t.id === 'T-BAD');
        return hasBad ? { ok: false, error: 'T-BAD failed gate' } : { ok: true };
      },
      { repo: null, maxBatchSize: 4 }
    );
    assert.deepEqual(batchRes.merged.sort(), ['T-OK1', 'T-OK2']);
    assert.equal(batchRes.failed.length, 1);
    assert.equal(batchRes.failed[0].id, 'T-BAD');

    const ov = syncOverviewPaneState(
      { runId: 'run-1', tickets: { 'T-OK1': { phase: 'merged' } } },
      { repo: dir }
    );
    assert.equal(ov.ok, true);

    const router = new BanditModelRouter({ statsFile: join(dir, 'stats.jsonl') });
    router.recordOutcome({ model: 'gemini-4-neon-high', strike0Pass: true });
    assert.equal(router.readRecords().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4 integration: CLI `agb distill --json` and `compilePlanToWorkflow` execute cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-cli-'));
  try {
    mkdirSync(join(dir, '.booster'), { recursive: true });
    writeFileSync(
      join(dir, '.booster', 'review.json'),
      JSON.stringify({
        findings: [
          { lens: 'security', severity: 'high', claim: 'Missing boundary check at line 10' },
          { lens: 'security', severity: 'high', claim: 'Missing boundary check at line 95' },
        ],
      })
    );

    const out = execFileSync(process.execPath, [AGB_BIN, 'distill', dir, '--apply', '--json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.recurringCount, 1);
    assert.equal(parsed.applied, true);
    assert.ok(existsSync(join(dir, '.gemini', 'rules', 'adlc-learned.md')));

    const wfPath = join(dir, 'wf.py');
    const wf = compilePlanToWorkflow(
      {
        repo: dir,
        base: 'main',
        gate: { test: 'npm test' },
        tickets: [
          {
            id: 'T-1',
            title: 'First ticket',
            body: 'Do work',
            scope: ['lib/a.mjs'],
            rails: ['lib/lock.mjs'],
            edges: [],
          },
        ],
      },
      { outPath: wfPath }
    );
    assert.equal(wf.ok, true);
    assert.ok(existsSync(wfPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4 integration: PreToolUse hook enforces CodeGraph explore and agb_distill policies, and arbiterPrompt compacts oversized payloads', () => {
  const ws = mkdtempSync(join(tmpdir(), 'agb-v14-hook-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'agb-v14-outside-'));
  try {
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeAdlcTickets(ws, [
      { id: 'T-V14-1', title: 'Test ticket', body: 'Test', scope: ['lib/**'], rails: ['lib/lock.mjs'] },
    ]);
    for (const toolName of [
      'codegraph_explore',
      'mcp_codegraph_codegraph_explore',
      'mcp__codegraph__codegraph_explore',
    ]) {
      // Interactive session allows in-workspace queries
      const interactiveAllowed = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: {} }
      );
      assert.equal(interactiveAllowed.decision, 'pass', `${toolName} inside workspace must be allowed interactively`);

      // Headless/readonly sessions deny by default
      const workerDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: { AGB_WORKER_TICKET: 'T-V14-1' } }
      );
      assert.equal(workerDenied.decision, 'deny', `${toolName} must be denied in headless worker by default`);

      const readonlyDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: { AGB_WORKER_MODE: 'readonly' } }
      );
      assert.equal(readonlyDenied.decision, 'deny', `${toolName} must be denied in readonly worker by default`);

      // Headless session with explicit AGB_ALLOW_CODEGRAPH_MCP=1 allows in-workspace queries
      const optInAllowed = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: ws, query: 'BanditModelRouter' },
          },
        },
        { env: { AGB_WORKER_TICKET: 'T-V14-1', AGB_ALLOW_CODEGRAPH_MCP: '1' } }
      );
      assert.equal(optInAllowed.decision, 'pass', `${toolName} inside workspace must be allowed with AGB_ALLOW_CODEGRAPH_MCP=1`);

      // Out-of-workspace path is denied both interactively and with AGB_ALLOW_CODEGRAPH_MCP=1
      const outsideInteractive = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: outsideDir, query: 'secret' },
          },
        },
        { env: {} }
      );
      assert.equal(outsideInteractive.decision, 'deny', `${toolName} outside workspace must be denied interactively`);

      const outsideOptIn = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: { projectPath: outsideDir, query: 'secret' },
          },
        },
        { env: { AGB_WORKER_TICKET: 'T-V14-1', AGB_ALLOW_CODEGRAPH_MCP: '1' } }
      );
      assert.equal(outsideOptIn.decision, 'deny', `${toolName} outside workspace must be denied even with AGB_ALLOW_CODEGRAPH_MCP=1`);

      // Protected boosterDataRoots is denied both interactively and with AGB_ALLOW_CODEGRAPH_MCP=1
      const denied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: toolName,
            args: {
              projectPath: join(ws, '.config', 'antigravity-booster'),
              query: 'secret',
            },
          },
        },
        { home: ws, env: { AGB_WORKER_TICKET: 'T-V14-1', AGB_ALLOW_CODEGRAPH_MCP: '1' } }
      );
      assert.equal(denied.decision, 'deny', `${toolName} on protected booster data root must be denied`);
    }

    // agb_distill: allowed interactively, denied in readonly and headless worker modes
    const distillRes = evaluatePayload(
      {
        workspacePaths: [ws],
        toolCall: {
          name: 'mcp__agb__agb_distill',
          args: { repo: ws },
        },
      },
      { env: {} }
    );
    assert.equal(distillRes.decision, 'pass');

    for (const env of [{ AGB_WORKER_MODE: 'readonly' }, { AGB_WORKER_TICKET: 'T-V14-1' }]) {
      const directDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: 'mcp__agb__agb_distill',
            args: { repo: ws, apply: false },
          },
        },
        { env }
      );
      assert.equal(directDenied.decision, 'deny', `mcp__agb__agb_distill must be denied under ${JSON.stringify(env)}`);

      const callMcpDenied = evaluatePayload(
        {
          workspacePaths: [ws],
          toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'agb', ToolName: 'agb_distill', Arguments: { repo: ws } },
          },
        },
        { env }
      );
      assert.equal(callMcpDenied.decision, 'deny', `call_mcp_tool(agb, agb_distill) must be denied under ${JSON.stringify(env)}`);
    }

    const hugeContext = 'A'.repeat(25000);
    const hugeFindings = Array.from({ length: 70 }, (_, i) => ({
      id: `fp-${i}`,
      lens: 'correctness',
      severity: 'high',
      file: 'lib/a.mjs',
      line: i + 1,
      claim: 'C'.repeat(800),
      evidence: 'E'.repeat(800),
    }));
    const prompt = arbiterPrompt(hugeFindings, { targetType: 'plan', context: hugeContext });
    assert.ok(prompt.includes('...(truncated)'), 'oversized context must be compacted');
    assert.ok(!prompt.includes('fp-65'), 'findings list must be capped at 60 items');
    assert.ok(prompt.length < 90000, `compacted prompt length (${prompt.length}) must stay bounded`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

const mockMechanism = (mechanism) => ({ AGB_MOCK_CONTAINMENT_MECHANISM: mechanism });

function makeContainmentFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agb-v14-pbc-')));
  const repo = join(root, 'repo');
  const cwd = join(repo, '.worktrees', 'wt');
  const home = join(root, 'home');
  const privateTmp = join(root, 'private-tmp');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(repo, '.codegraph'), { recursive: true });
  mkdirSync(join(cwd, '.codegraph'), { recursive: true });
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  mkdirSync(privateTmp, { recursive: true });
  writeFileSync(
    join(home, '.gemini', 'config', 'mcp_config.json'),
    JSON.stringify({ mcpServers: { codegraph: { command: 'cg' }, other: { command: 'x' } } })
  );
  const agyBin = join(root, 'agy-bin');
  writeFileSync(agyBin, '#!/bin/sh\nexit 0\n');
  chmodSync(agyBin, 0o755);
  return {
    root,
    repo,
    cwd,
    home,
    privateTmp,
    agyBin,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('prepareBuilderContainment (linux bwrap_pid): argv, node_modules mount, default codegraph exclusion and cleanup', async () => {
  const fx = makeContainmentFixture();
  try {
    const args = ['--print', 'hello'];
    const base = {
      agyBin: fx.agyBin,
      args,
      cwd: fx.cwd,
      repo: fx.repo,
      userHome: fx.home,
      platform: 'linux',
      env: mockMechanism('bwrap_pid'),
    };
    const localNm = join(fx.cwd, 'node_modules');
    // sandbox, containment and allowCodegraph are intentionally omitted to exercise their defaults
    const res = await withEnv({ TMPDIR: fx.privateTmp }, () => prepareBuilderContainment(base));
    assert.equal(res.ok, true, res.error);
    assert.equal(res.launchBin, 'bwrap');
    assert.equal(res.verifiedBypass, null);
    assert.ok(res.launchArgs.includes('--unshare-pid'));
    const sep = res.launchArgs.indexOf('--');
    assert.deepEqual(res.launchArgs.slice(sep), ['--', fx.agyBin, ...args], 'nested --sandbox must be stripped');
    assert.deepEqual(args, ['--print', 'hello'], 'caller args must not be mutated');

    const tmpIdx = res.launchArgs.indexOf('/tmp');
    assert.equal(res.launchArgs[tmpIdx - 2], '--bind');
    const bwrapTmpDir = res.launchArgs[tmpIdx - 1];
    assert.ok(basename(bwrapTmpDir).startsWith('agb-bwrap-tmp-'));
    assert.equal(dirname(bwrapTmpDir), fx.privateTmp);

    const nmIdx = res.launchArgs.findIndex((a, i) => a === '--ro-bind' && res.launchArgs[i + 2] === localNm);
    assert.ok(nmIdx >= 0, 'canonical node_modules must be mounted over the worktree');
    assert.equal(res.launchArgs[nmIdx + 1], join(fx.repo, 'node_modules'));

    assert.equal(res.stagedBuilderHome, join(fx.cwd, '.agb_home'));
    const stagedMcp = readFileSync(join(res.stagedBuilderHome, '.gemini', 'mcp_config.json'), 'utf8');
    assert.deepEqual(JSON.parse(stagedMcp), { mcpServers: {} });
    assert.equal(stagedMcp.includes('codegraph'), false, 'codegraph MCP must not be staged by default');

    assert.equal(typeof res.cleanup, 'function');
    assert.equal(existsSync(localNm), true);
    assert.equal(existsSync(bwrapTmpDir), true);
    res.cleanup();
    assert.equal(existsSync(localNm), false);
    assert.equal(existsSync(bwrapTmpDir), false);
    assert.deepEqual(readdirSync(fx.privateTmp), []);
    res.cleanup();

    const opted = await withEnv({ TMPDIR: fx.privateTmp }, () =>
      prepareBuilderContainment({ ...base, allowCodegraph: true })
    );
    assert.equal(opted.ok, true, opted.error);
    const optedMcp = JSON.parse(readFileSync(join(opted.stagedBuilderHome, '.gemini', 'mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(optedMcp.mcpServers), ['codegraph']);
    opted.cleanup();
    assert.deepEqual(readdirSync(fx.privateTmp), []);
  } finally {
    fx.cleanup();
  }
});

test('prepareBuilderContainment (error paths): rejected mechanisms, missing cwd and disabled sandbox/containment leave nothing behind', async () => {
  const fx = makeContainmentFixture();
  try {
    const base = {
      agyBin: fx.agyBin,
      args: ['--print', 'x'],
      cwd: fx.cwd,
      repo: fx.repo,
      userHome: fx.home,
      platform: 'linux',
      env: mockMechanism('bwrap_pid'),
    };
    const cases = [
      [{ sandbox: false }, /Builder sandbox is mandatory on linux/],
      [{ containment: false }, /Builder containment is mandatory on linux/],
      [{ cwd: '' }, /requires an existing directory worktree cwd/],
      [{ cwd: join(fx.root, 'missing') }, /requires an existing directory worktree cwd/],
      [{ cwd: join(fx.repo, 'package.json-not-a-dir') }, /requires an existing directory worktree cwd/],
      [{ env: { AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1' } }, /Kernel containment floor unavailable on linux: .*Attestation bypass is restricted to Windows/],
      [{ env: mockMechanism('cgroups_v2_scope') }, /mechanism 'cgroups_v2_scope' provides insufficient filesystem isolation/],
      [{ env: mockMechanism('pid_namespace') }, /mechanism 'pid_namespace' provides insufficient filesystem isolation/],
      [{ env: mockMechanism('mystery') }, /mechanism 'mystery' cannot be attached to subprocess directly/],
    ];
    for (const [override, pattern] of cases) {
      const res = await withEnv({ TMPDIR: fx.privateTmp }, () => prepareBuilderContainment({ ...base, ...override }));
      assert.equal(res.ok, false);
      assert.equal(res.kind, 'containment_unavailable');
      assert.match(res.error, pattern);
      assert.equal(res.cleanup, undefined);
      assert.equal(existsSync(join(fx.cwd, 'node_modules')), false);
      assert.deepEqual(readdirSync(fx.privateTmp), [], `no temp dirs may leak for ${pattern}`);
    }
  } finally {
    fx.cleanup();
  }
});

test('prepareBuilderContainment (darwin seatbelt): sandbox-exec profile without nested --sandbox', async () => {
  const fx = makeContainmentFixture();
  try {
    const args = ['--print', 'hi'];
    const res = await prepareBuilderContainment({
      agyBin: fx.agyBin,
      args,
      cwd: fx.cwd,
      repo: fx.repo,
      userHome: fx.home,
      platform: 'darwin',
      env: mockMechanism('seatbelt'),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.launchBin, 'sandbox-exec');
    assert.equal(res.launchArgs[0], '-p');
    assert.ok(res.launchArgs[1].includes(`(allow file-write* (subpath "${fx.cwd}"))`));
    assert.equal(res.launchArgs[2], fx.agyBin);
    assert.deepEqual(res.launchArgs.slice(3), args);
    assert.equal(res.stagedBuilderHome, null);
    assert.equal(res.verifiedBypass, null);
    assert.equal(typeof res.cleanup, 'function');
    res.cleanup();

    const noSandbox = await prepareBuilderContainment({
      agyBin: fx.agyBin,
      args,
      cwd: fx.cwd,
      platform: 'darwin',
      sandbox: false,
      env: mockMechanism('seatbelt'),
    });
    assert.equal(noSandbox.ok, false);
    assert.match(noSandbox.error, /Builder sandbox is mandatory on darwin/);

    if (process.platform !== 'win32') {
      const badCwd = join(fx.root, 'bad\nname');
      mkdirSync(badCwd, { recursive: true });
      const bad = await prepareBuilderContainment({
        agyBin: fx.agyBin,
        args,
        cwd: badCwd,
        platform: 'darwin',
        env: mockMechanism('seatbelt'),
      });
      assert.equal(bad.ok, false);
      assert.equal(bad.kind, 'containment_unavailable');
      assert.match(bad.error, /Unsafe worktree path for seatbelt containment/);
    }
  } finally {
    fx.cleanup();
  }
});

test('prepareBuilderContainment (win32 job_object): attestation, verifiedBypass reuse, --sandbox gating and args temp dir cleanup', async () => {
  const fx = makeContainmentFixture();
  try {
    const decodeInline = (res) =>
      JSON.parse(Buffer.from(res.launchArgs[res.launchArgs.indexOf('-ArgsBase64') + 1], 'base64').toString('utf8'));
    const bypass = { valid: true };
    const base = {
      agyBin: fx.agyBin,
      args: ['--print', 'hi'],
      cwd: fx.cwd,
      repo: fx.repo,
      userHome: fx.home,
      platform: 'win32',
      env: mockMechanism('job_object'),
      verifiedBypass: bypass,
    };

    const sandboxed = await prepareBuilderContainment({ ...base, sandbox: true });
    assert.equal(sandboxed.ok, true, sandboxed.error);
    assert.equal(sandboxed.launchBin, 'powershell.exe');
    assert.equal(sandboxed.launchArgs[sandboxed.launchArgs.indexOf('-TargetBin') + 1], fx.agyBin);
    assert.deepEqual(decodeInline(sandboxed), ['--print', 'hi', '--sandbox']);
    assert.equal(sandboxed.verifiedBypass, bypass);
    assert.equal(sandboxed.stagedBuilderHome, null);
    sandboxed.cleanup();

    const unsandboxed = await prepareBuilderContainment({ ...base, sandbox: false });
    assert.equal(unsandboxed.ok, true, unsandboxed.error);
    assert.deepEqual(decodeInline(unsandboxed), ['--print', 'hi']);
    assert.equal(unsandboxed.verifiedBypass, bypass);

    const uncontained = await prepareBuilderContainment({ ...base, containment: false });
    assert.equal(uncontained.ok, true, uncontained.error);
    assert.equal(uncontained.launchBin, fx.agyBin);
    assert.deepEqual(uncontained.launchArgs, ['--print', 'hi', '--sandbox']);

    const floorMissing = await prepareBuilderContainment({
      ...base,
      env: { AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1' },
    });
    assert.equal(floorMissing.ok, true, floorMissing.error);
    assert.equal(floorMissing.launchBin, fx.agyBin);

    for (const sandbox of [true, false]) {
      const big = await withEnv({ HOME: fx.home, USERPROFILE: fx.home }, () =>
        prepareBuilderContainment({ ...base, args: ['--print', 'x'.repeat(9000)], sandbox })
      );
      assert.equal(big.ok, true, big.error);
      assert.equal(big.launchBin, 'powershell.exe');
      const argsFile = big.launchArgs[big.launchArgs.indexOf('-ArgsFile') + 1];
      const argsTempDir = dirname(argsFile);
      assert.ok(basename(argsTempDir).startsWith('agb-args-'));
      assert.equal(existsSync(argsFile), true);
      const written = JSON.parse(readFileSync(argsFile, 'utf8'));
      assert.equal(written.includes('--sandbox'), sandbox);
      big.cleanup();
      assert.equal(existsSync(argsTempDir), false);
      assert.equal(existsSync(argsFile), false);
      big.cleanup();
    }

    const denied = await prepareBuilderContainment({ ...base, verifiedBypass: null, sandbox: false });
    assert.equal(denied.ok, false);
    assert.equal(denied.kind, 'containment_unavailable');
    assert.match(denied.error, /^Sandbox bypass denied: /);

    const floorDenied = await prepareBuilderContainment({
      ...base,
      verifiedBypass: null,
      env: { AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1' },
    });
    assert.equal(floorDenied.ok, false);
    assert.match(floorDenied.error, /^Kernel containment floor unavailable: .*Authenticated bypass attestation required: /);

    const uncontainedDenied = await prepareBuilderContainment({ ...base, verifiedBypass: null, containment: false });
    assert.equal(uncontainedDenied.ok, false);
    assert.match(uncontainedDenied.error, /^Builder containment cannot be disabled without an authenticated bypass attestation: /);
  } finally {
    fx.cleanup();
  }
});

test('runAgy builder delegates containment failures to prepareBuilderContainment', async () => {
  const noSandbox = await runAgy({ model: 'gemini-4-neon-medium', role: 'builder', cwd: '', prompt: 'x' });
  assert.equal(noSandbox.ok, false);
  assert.equal(noSandbox.ms, 0);
  assert.equal(noSandbox.output, '');
  assert.equal(noSandbox.kind, 'containment_unavailable');
  assert.match(noSandbox.error, /Builder sandbox is mandatory/);

  const noCwd = await runAgy({ model: 'gemini-4-neon-medium', role: 'builder', cwd: '', prompt: 'x', sandbox: true });
  assert.equal(noCwd.ok, false);
  assert.equal(noCwd.ms, 0);
  assert.equal(noCwd.kind, 'containment_unavailable');
  assert.match(noCwd.error, /requires an existing directory worktree cwd/);
});

test('runAgy non-builder roles append --sandbox only when requested and forward rails into role settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-v14-argv-'));
  try {
    const recorder = join(dir, 'rec-agy');
    writeFileSync(recorder, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGB_ARGV_FILE"\necho OK\n');
    chmodSync(recorder, 0o755);
    const argvFile = join(dir, 'argv.txt');
    const run = async (extra) => {
      const res = await runAgy({
        model: 'gemini-4-neon-medium',
        prompt: 'Reply OK',
        cwd: dir,
        bin: recorder,
        role: 'prosecutor',
        worker: { mode: 'readonly' },
        env: { AGB_ARGV_FILE: argvFile },
        ...extra,
      });
      assert.equal(res.ok, true, res.error);
      return readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    };

    assert.ok((await run({ sandbox: true })).includes('--sandbox'));
    assert.equal((await run({ sandbox: false })).includes('--sandbox'), false);
    assert.equal((await run({})).includes('--sandbox'), false);

    const withRails = await run({
      role: 'implementer',
      useRoleSettings: true,
      rails: ['lib/lock.mjs'],
    });
    const settings = JSON.parse(withRails[withRails.indexOf('--settings') + 1]);
    assert.ok(settings.permissions.deny.includes('write_file(lib/lock.mjs)'));
    assert.equal(settings.allowNonWorkspaceAccess, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
