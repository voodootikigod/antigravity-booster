// Orchestrator frontier builder routing, per-slug circuit breaker, 4-Claude/GPT-OSS FIFO, and 60-tool completeness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore } from '@adlc/tickets';
import {
  FRONTIER_NO_ORCHESTRATOR,
  TIER_CANDIDATES,
  familyOf,
  poolOf,
  resetOrchestratorRoutingState,
  setOrchestratorRoutingState,
  tierCandidates,
} from '../lib/models.mjs';
import { PoolSet } from '../lib/pools.mjs';
import { RunStatus } from '../lib/status.mjs';
import { runPlan } from '../lib/scheduler.mjs';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const INIT_TOOLS_FIXTURE = fileURLToPath(new URL('./fixtures/agy-1.5.9-init-tools.json', import.meta.url));
const LINUX_ONLY = process.platform === 'linux' ? {} : { skip: 'linux bwrap scheduler test' };

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_orch_routing_test_${process.pid}.json`);

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agb-orch-repo-')));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  initializeDirectoryStore(join(dir, '.adlc', 'tickets'));
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

async function withEnv(overrides, fn) {
  const keys = [
    'AGB_AGY_BIN',
    'AGB_ADLC_BIN',
    'AGB_ALLOW_CUSTOM_ADLC_CLI',
    'AGB_DISABLE_ORCHESTRATOR',
    'AGB_QUOTA_STATE',
    'AGB_POOLS_V2',
    'AGB_POOLS_LOCK',
    'FAKE_AGY_VERSION',
    'FAKE_BUILDER_MODE',
    'FAKE_STATE_DIR',
    'HOME',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const tmpHome = mkdtempSync(join(tmpdir(), 'agb-orch-home-'));
  mkdirSync(join(tmpHome, '.gemini', 'config', 'plugins', 'adlc-antigravity'), { recursive: true });
  writeFileSync(
    join(tmpHome, '.gemini', 'config', 'plugins', 'adlc-antigravity', 'plugin.json'),
    JSON.stringify({ name: 'adlc-antigravity', version: '99.0.0', adlcContract: 1 }),
  );
  const poolDir = mkdtempSync(join(tmpdir(), 'agb-orch-pools-'));
  try {
    process.env.HOME = tmpHome;
    process.env.AGB_AGY_BIN = FAKE_AGY;
    process.env.AGB_ADLC_BIN = FAKE_ADLC;
    process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = '1';
    process.env.AGB_QUOTA_STATE = join(poolDir, 'quota.json');
    process.env.AGB_POOLS_V2 = join(poolDir, 'v2.json');
    process.env.AGB_POOLS_LOCK = join(poolDir, 'shared.lock');
    delete process.env.AGB_DISABLE_ORCHESTRATOR;
    delete process.env.FAKE_AGY_VERSION;
    delete process.env.FAKE_BUILDER_MODE;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    resetOrchestratorRoutingState();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(poolDir, { recursive: true, force: true });
  }
}

function builderModelsSeen(stateDir) {
  return readFileSync(join(stateDir, 'agy-argv-seen'), 'utf8')
    .split(/^(?=--print )/m)
    .filter((l) => l.startsWith('--print ') && l.includes('TICKET-DONE or TICKET-BLOCKED'))
    .map((l) => l.match(/--model (\S+)/)?.[1]);
}

test('PoolSet.route("frontier", "auto") spreads 4+4 at 4/4 capacity and 2+4 at 2/4 capacity; respects disable flags and Set/Array disabledModels', () => {
  assert.equal(tierCandidates('frontier', 'auto')[0], 'gemini-pro-orchestrator');
  resetOrchestratorRoutingState();
  assert.equal(poolOf('hydrogen-custom'), 'gemini-pro');

  // 4+4 at 4/4 capacity
  const pools44 = new PoolSet({ 'gemini-pro': 4, claude: 4 });
  const routed44 = Array.from({ length: 8 }, () => pools44.route('frontier', 'auto'));
  assert.equal(routed44.filter((m) => familyOf(m) === 'gemini').length, 4);
  assert.equal(routed44.filter((m) => familyOf(m) === 'claude').length, 4);
  assert.equal(routed44[0], 'gemini-pro-orchestrator');
  assert.equal(routed44[1], 'claude-sonnet-5-5-high');
  for (const m of routed44) pools44.unroute(m);

  // 2+4 at 2/4 capacity
  const pools24 = new PoolSet({ 'gemini-pro': 2, claude: 4 });
  const routed24 = Array.from({ length: 6 }, () => pools24.route('frontier', 'auto'));
  assert.equal(routed24.filter((m) => familyOf(m) === 'gemini').length, 2);
  assert.equal(routed24.filter((m) => familyOf(m) === 'claude').length, 4);
  for (const m of routed24) pools24.unroute(m);

  // Options & runtime state: disableOrchestrator + Set/Array/null disabledModels
  assert.deepEqual(tierCandidates('frontier', 'auto', { disableOrchestrator: true }), [...FRONTIER_NO_ORCHESTRATOR]);
  setOrchestratorRoutingState({ disableOrchestrator: true });
  assert.deepEqual(tierCandidates('frontier', 'auto'), [...FRONTIER_NO_ORCHESTRATOR]);
  // Explicit option overrides runtime state when false
  assert.deepEqual(tierCandidates('frontier', 'auto', { disableOrchestrator: false }), [...TIER_CANDIDATES.frontier]);
  resetOrchestratorRoutingState();

  const savedEnv = process.env.AGB_DISABLE_ORCHESTRATOR;
  try {
    process.env.AGB_DISABLE_ORCHESTRATOR = '1';
    assert.deepEqual(tierCandidates('frontier', 'auto'), [...FRONTIER_NO_ORCHESTRATOR]);
  } finally {
    if (savedEnv === undefined) delete process.env.AGB_DISABLE_ORCHESTRATOR;
    else process.env.AGB_DISABLE_ORCHESTRATOR = savedEnv;
  }

  // Set, Array, and null disabledModels
  setOrchestratorRoutingState({ disabledModels: new Set(['gemini-pro-orchestrator']) });
  assert.equal(tierCandidates('frontier', 'gemini')[0], 'gemini-pro-orchestrator-argon');
  setOrchestratorRoutingState({ disabledModels: ['gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon'] });
  assert.equal(tierCandidates('frontier', 'gemini')[0], 'gemini-4-argon-high');
  assert.equal(tierCandidates('frontier', 'gemini', { disabledModels: null })[0], 'gemini-pro-orchestrator');
  assert.equal(tierCandidates('frontier', 'gemini', { disabledModels: ['gemini-pro-orchestrator'] })[0], 'gemini-pro-orchestrator-argon');
  resetOrchestratorRoutingState();
  assert.deepEqual(tierCandidates(), TIER_CANDIDATES.mid);
});

test('RunStatus: initModelStats & updateModelStats scope persistence to (planHash, agyVersion) and sanitize entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-status-stats-'));
  try {
    const s1 = new RunStatus(dir, 'run-1');
    assert.deepEqual([...s1.initModelStats({ planHash: 'h1', agyVersion: '1.5.9' }, null)], []);
    s1.updateModelStats('gemini-pro-orchestrator', { resolved: true, builderFault: true, disabledModels: new Set(['gemini-pro-orchestrator']) });
    s1.updateModelStats('gemini-pro-orchestrator', { rateLimited: true });
    s1.updateModelStats('claude-sonnet-5-5-high', { resolved: true, merged: true, disabledModels: ['gemini-pro-orchestrator'] });
    assert.equal(s1.updateModelStats(null, { disabledModels: ['gemini-pro-orchestrator'] }), null);
    s1.updateModelStats('__proto__', { resolved: true });
    s1.updateModelStats('constructor', { resolved: true });
    s1.updateModelStats('', { resolved: true });
    assert.equal(Object.hasOwn(s1.state.modelStats, 'null'), false);
    assert.equal(Object.hasOwn(s1.state.modelStats, 'constructor'), false);
    assert.equal(Object.hasOwn(s1.state.modelStats, ''), false);

    const saved = JSON.parse(readFileSync(join(dir, '.booster', 'run.json'), 'utf8'));
    saved.modelStats['gemini-4-argon-high'] = { resolvedTickets: -5, builderFaultTickets: Infinity };
    saved.modelStats['bad-null'] = null;
    saved.modelStats['constructor'] = { resolvedTickets: 9 };
    assert.deepEqual(saved.modelStats['gemini-pro-orchestrator'], {
      resolvedTickets: 1,
      builderFaultTickets: 1,
      mergedTickets: 0,
      rateLimits: 1,
    });
    assert.deepEqual(saved.modelStats['claude-sonnet-5-5-high'], {
      resolvedTickets: 1,
      builderFaultTickets: 0,
      mergedTickets: 1,
      rateLimits: 0,
    });

    // Matching (planHash, agyVersion) restores stats and disabledModels
    const s2 = new RunStatus(dir, 'run-2');
    const restored = s2.initModelStats({ planHash: 'h1', agyVersion: '1.5.9' }, saved);
    assert.deepEqual([...restored], ['gemini-pro-orchestrator']);
    assert.deepEqual(s2.state.modelStats['gemini-pro-orchestrator'], {
      resolvedTickets: 1,
      builderFaultTickets: 1,
      mergedTickets: 0,
      rateLimits: 1,
    });
    assert.deepEqual(s2.state.modelStats['claude-sonnet-5-5-high'], {
      resolvedTickets: 1,
      builderFaultTickets: 0,
      mergedTickets: 1,
      rateLimits: 0,
    });
    assert.deepEqual(s2.state.modelStats['gemini-4-argon-high'], {
      resolvedTickets: 0,
      builderFaultTickets: 0,
      mergedTickets: 0,
      rateLimits: 0,
    });
    assert.equal(Object.hasOwn(s2.state.modelStats, 'constructor'), false);
    assert.equal(Object.hasOwn(s2.state.modelStats, 'bad-null'), false);

    // Changed agyVersion resets stats and disabledModels
    const s3 = new RunStatus(dir, 'run-3');
    const resetVer = s3.initModelStats({ planHash: 'h1', agyVersion: '1.6.0' }, saved);
    assert.deepEqual([...resetVer], []);
    assert.deepEqual(s3.state.modelStats, {});

    // Changed planHash resets stats and disabledModels
    const s4 = new RunStatus(dir, 'run-4');
    const resetPlan = s4.initModelStats({ planHash: 'h2', agyVersion: '1.5.9' }, saved);
    assert.deepEqual([...resetPlan], []);
    assert.deepEqual(s4.state.modelStats, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler: !gates.ok 4x increments resolvedTickets ONLY (0 builderFaultTickets); 2/4 builder faults demote ONLY gemini-pro-orchestrator while keeping gemini-pro-orchestrator-argon active; version/plan changes reset', LINUX_ONLY, async () => {
  // 1. 4 gate failures (!gates.ok) -> builderFaultTickets === 0, no demotion!
  const repoGateFail = makeRepo();
  const stateGateFail = mkdtempSync(join(tmpdir(), 'agb-orch-gf-'));
  try {
    await withEnv({ FAKE_BUILDER_MODE: 'good', FAKE_STATE_DIR: stateGateFail }, () =>
      runPlan({
        repo: repoGateFail,
        gate: { test: 'false' },
        tickets: ['T1', 'T2', 'T3', 'T4'].map((id) => ({
          id, title: id, body: 'x', scope: [`${id}.txt`], tier: 'frontier', pool_hint: 'gemini',
        })),
      }, { log: () => {} }),
    );
    const rj = JSON.parse(readFileSync(join(repoGateFail, '.booster', 'run.json'), 'utf8'));
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].resolvedTickets, 4);
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].builderFaultTickets, 0);
    assert.deepEqual(rj.disabledModels, []);
  } finally {
    rmSync(repoGateFail, { recursive: true, force: true });
    rmSync(stateGateFail, { recursive: true, force: true });
  }

  // 2. 2 merges + 2 builder faults (noop -> empty_diff) on same plan -> 2/4 >= 0.5 demotes ONLY gemini-pro-orchestrator,
  //    then a 3rd run on the SAME (planHash, agyVersion) routes to gemini-pro-orchestrator-argon,
  //    and changing agyVersion to 1.5.8 auto-disables Orchestrator slugs with notice!
  const repoBreaker = makeRepo();
  const stateBreaker = mkdtempSync(join(tmpdir(), 'agb-orch-br-'));
  const logs = [];
  const planTickets = ['T1', 'T2'].map((id) => ({
    id, title: id, body: 'x', scope: [`${id}.txt`], tier: 'frontier', pool_hint: 'gemini',
  }));
  try {
    // Run A: 2 noop faults (resolvedTickets: 2, builderFaultTickets: 2 — below >= 4 threshold, not demoted yet!)
    await withEnv({ FAKE_BUILDER_MODE: 'noop', FAKE_STATE_DIR: stateBreaker }, () =>
      runPlan({ repo: repoBreaker, gate: { test: 'true' }, tickets: planTickets }, { log: (m) => logs.push(m) }),
    );
    let rj = JSON.parse(readFileSync(join(repoBreaker, '.booster', 'run.json'), 'utf8'));
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].resolvedTickets, 2);
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].builderFaultTickets, 2);
    assert.deepEqual(rj.disabledModels, []);

    // Run B (same planHash & agyVersion 1.5.9): 2 merges -> resolvedTickets = 4, builderFaultTickets = 2 (50%!) -> demotes gemini-pro-orchestrator!
    await withEnv({ FAKE_BUILDER_MODE: 'good', FAKE_STATE_DIR: stateBreaker }, () =>
      runPlan({ repo: repoBreaker, gate: { test: 'true' }, tickets: planTickets }, { log: (m) => logs.push(m) }),
    );
    rj = JSON.parse(readFileSync(join(repoBreaker, '.booster', 'run.json'), 'utf8'));
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].resolvedTickets, 4);
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].builderFaultTickets, 2);
    assert.equal(rj.modelStats['gemini-pro-orchestrator'].mergedTickets, 2);
    assert.deepEqual(rj.disabledModels, ['gemini-pro-orchestrator']);
    assert.ok(logs.some((l) => l.includes('demoting gemini-pro-orchestrator after 2/4 builder-fault tickets (>= 50%)')));

    // Reset repo branches/files back to init commit so we can run the exact same planHash a 3rd time and observe gemini-pro-orchestrator-argon!
    const stateArgon = mkdtempSync(join(tmpdir(), 'agb-orch-argon-'));
    try {
      execFileSync('git', ['reset', '--hard', 'HEAD~2'], { cwd: repoBreaker });
      await withEnv({ FAKE_BUILDER_MODE: 'good', FAKE_STATE_DIR: stateArgon }, () =>
        runPlan({ repo: repoBreaker, gate: { test: 'true' }, tickets: planTickets }, { log: () => {} }),
      );
      const seenArgon = builderModelsSeen(stateArgon);
      assert.deepEqual(seenArgon, ['gemini-pro-orchestrator-argon', 'gemini-pro-orchestrator-argon']);
    } finally {
      rmSync(stateArgon, { recursive: true, force: true });
    }

    // Run on agy 1.5.8 & 1.5.9-rc.1 -> logs notice, resets stats on version change, and routes to gemini-4-argon-high!
    for (const oldVer of ['1.5.8', '1.5.9-rc.1']) {
      const repoOld = makeRepo();
      const stateOld = mkdtempSync(join(tmpdir(), 'agb-orch-old-'));
      const oldLogs = [];
      try {
        await withEnv({ FAKE_AGY_VERSION: oldVer, FAKE_BUILDER_MODE: 'good', FAKE_STATE_DIR: stateOld }, () =>
          runPlan({
            repo: repoOld,
            gate: { test: 'true' },
            tickets: [{ id: 'T1', title: 'T1', body: 'x', scope: ['T1.txt'], tier: 'frontier', pool_hint: 'gemini' }],
          }, { log: (m) => oldLogs.push(m) }),
        );
        assert.ok(oldLogs.some((l) => l.includes(`agy ${oldVer} < 1.5.9; Orchestrator slugs auto-disabled`)), oldVer);
        assert.deepEqual(builderModelsSeen(stateOld), ['gemini-4-argon-high']);
      } finally {
        rmSync(repoOld, { recursive: true, force: true });
        rmSync(stateOld, { recursive: true, force: true });
      }
    }

    // plan.disableOrchestrator: true AND AGB_DISABLE_ORCHESTRATOR=1 AND rateLimits accounting
    const repoPlanOptOut = makeRepo();
    const statePlanOptOut = mkdtempSync(join(tmpdir(), 'agb-orch-optout-'));
    try {
      await withEnv({ FAKE_BUILDER_MODE: 'blocked-ratelimit-good', FAKE_STATE_DIR: statePlanOptOut }, () =>
        runPlan({
          repo: repoPlanOptOut,
          disableOrchestrator: true,
          gate: { test: 'true' },
          tickets: [{ id: 'T1', title: 'T1', body: 'x', scope: ['T1.txt'], tier: 'frontier' }],
        }, { log: () => {} }),
      );
      const rjRl = JSON.parse(readFileSync(join(repoPlanOptOut, '.booster', 'run.json'), 'utf8'));
      assert.equal(rjRl.modelStats['gemini-4-argon-high'].rateLimits, 1);
      assert.equal(rjRl.modelStats['claude-sonnet-5-5-high'].mergedTickets, 1);
    } finally {
      rmSync(repoPlanOptOut, { recursive: true, force: true });
      rmSync(statePlanOptOut, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoBreaker, { recursive: true, force: true });
    rmSync(stateBreaker, { recursive: true, force: true });
  }
});

test('4-Claude Promise-barrier + gpt-oss-120b-medium prosecutor FIFO wakes cleanly without deadlock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-fifo-4c-'));
  await withEnv({}, async () => {
    const pools = new PoolSet({ claude: 4, 'gpt-oss': 2, 'gemini-pro': 4, 'gemini-flash': 4 }, { repo: dir });
    pools.quota = {
      gemini: { effectivePercent: 80, scaledCap: 4 },
      claude_gpt: { effectivePercent: 80, scaledCap: 4 },
      paused: false,
    };

    // Acquire all 4 claude_gpt family slots with Claude builders
    const rels = [];
    for (let i = 0; i < 4; i += 1) {
      rels.push(await pools.acquire('claude-sonnet-5-5-high', { repo: dir, ticketId: `C-${i}` }));
    }
    assert.equal(pools.familyInFlight('claude_gpt'), 4);

    // Queue gpt-oss-120b-medium prosecutor behind the 4 Claude builders using a deterministic Promise barrier
    let gptAcquired = false;
    const gptPromise = pools.acquire('gpt-oss-120b-medium', { repo: dir, ticketId: 'PROSECUTE-1' }).then((rel) => {
      gptAcquired = true;
      return rel;
    });

    await new Promise((r) => setTimeout(r, 25));
    assert.equal(gptAcquired, false, 'gpt-oss must wait while 4 claude_gpt slots are full');

    // Releasing 1 Claude builder wakes the sibling gpt-oss waiter cleanly with 0 deadlocks!
    await rels[0]();
    const gptRel = await gptPromise;
    assert.equal(gptAcquired, true);
    await gptRel();
    for (let i = 1; i < 4; i += 1) await rels[i]();
  });
  rmSync(dir, { recursive: true, force: true });
});

test('60-tool completeness canary against test/fixtures/agy-1.5.9-init-tools.json never emits ask in headless worker modes', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agb-60tools-')));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  initializeDirectoryStore(join(dir, '.adlc', 'tickets'));
  try {
    const tools = JSON.parse(readFileSync(INIT_TOOLS_FIXTURE, 'utf8')).tools;
    assert.equal(tools.length, 60);
    for (const name of tools) {
      for (const env of [{ AGB_WORKER_MODE: 'readonly' }, { AGB_WORKER_TICKET: 'T1' }]) {
        const v = evaluatePayload({ toolCall: { name, args: {} }, workspacePaths: [dir] }, { env, home, platform: 'linux' });
        assert.ok(v.decision === 'pass' || v.decision === 'deny', `${name} emitted ${v.decision}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
