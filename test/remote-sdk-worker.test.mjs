import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRemoteSdkBridgeScript,
  DEFAULT_CONCURRENCY,
  isRemoteSdkAvailable,
  KILL_GRACE_MS,
  runRemoteSdkPlan,
  runRemoteSdkTicket,
  verifyAndMergeRemoteBranch,
} from '../lib/remote-sdk-worker.mjs';

const FAKE_SDK = fileURLToPath(new URL('./fixtures/fake-remote-sdk', import.meta.url));
chmodSync(FAKE_SDK, 0o755);

test('isRemoteSdkAvailable and buildRemoteSdkBridgeScript detect custom bin and emit valid Python bridge', () => {
  assert.equal(DEFAULT_CONCURRENCY, 8);
  assert.equal(KILL_GRACE_MS, 500);

  const avail = isRemoteSdkAvailable({ sdkBin: FAKE_SDK });
  assert.equal(avail.ok, true);
  assert.equal(avail.mode, 'custom-bin');

  const missing = isRemoteSdkAvailable({ sdkBin: '/nonexistent/agb-fake-sdk-bin' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/i);

  const script = buildRemoteSdkBridgeScript();
  assert.match(script, /import google_antigravity/);
  assert.match(script, /client\.create_session/);
  assert.ok(script.includes('sys.exit(2)'), 'missing SDK must exit with code 2');
  assert.ok(script.includes('payload.get("timeoutSec", 1800)'), 'default timeoutSec must be 1800');
});

test('runRemoteSdkTicket and runRemoteSdkPlan execute parallel waves, handle failures, block dependents, timeout cleanly, and support dryRun', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-remote-sdk-'));
  try {
    // 1. Invalid ticket ID fails cleanly
    const bad = await runRemoteSdkTicket({ ticket: { id: '../bad' }, repo, sdkBin: FAKE_SDK });
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, 'invalid_ticket');

    // 2. Dry-run wave grouping
    const plan = {
      repo,
      base: 'main',
      tickets: [
        { id: 'T-1', title: 'Alpha', body: 'Do alpha', scope: ['a.mjs'], edges: [{ to: 'T-3' }] },
        { id: 'T-2', title: 'Beta', body: 'Do beta', scope: ['b.mjs'], edges: [{ to: 'T-3' }] },
        { id: 'T-3', title: 'Gamma', body: 'Do gamma', scope: ['c.mjs'], edges: [] },
      ],
    };
    const dry = await runRemoteSdkPlan(plan, { dryRun: true, concurrency: 4 });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.driver, 'remote-sdk');
    assert.equal(dry.concurrency, 4);
    assert.deepEqual(dry.waves, [
      { wave: 1, tickets: ['T-1', 'T-2'] },
      { wave: 2, tickets: ['T-3'] },
    ]);

    // 3. Full wave execution via fake-remote-sdk
    const runRes = await runRemoteSdkPlan(plan, { sdkBin: FAKE_SDK, concurrency: 2 });
    assert.equal(runRes.ok, true, JSON.stringify(runRes));
    assert.deepEqual(runRes.completed.sort(), ['T-1', 'T-2', 'T-3']);
    assert.deepEqual(runRes.failed, {});
    assert.equal(runRes.sessions['T-1'].sessionId, 'remote-vm-T-1');
    assert.equal(runRes.sessions['T-3'].branch, 'agb/remote-t-3');

    // 4. Failed Wave-1 ticket blocks Wave-2 dependent without dispatching it
    const failPlan = {
      repo,
      base: 'main',
      tickets: [
        { id: 'T-1', title: 'Alpha', body: 'FAIL_TICKET', scope: ['a.mjs'], edges: [{ to: 'T-2' }] },
        { id: 'T-2', title: 'Beta', body: 'Depends on T-1', scope: ['b.mjs'], edges: [] },
      ],
    };
    const failRes = await runRemoteSdkPlan(failPlan, { sdkBin: FAKE_SDK });
    assert.equal(failRes.ok, false);
    assert.match(failRes.failed['T-1'], /Remote VM build failed/);
    assert.match(failRes.failed['T-2'], /blocked by failed dependency: T-1/);

    // 5. Timeout teardown
    const hangRes = await runRemoteSdkTicket({
      ticket: { id: 'T-HANG', title: 'Hang', body: 'HANG_TICKET', scope: ['h.mjs'] },
      repo,
      sdkBin: FAKE_SDK,
      timeoutMs: 120,
    });
    assert.equal(hangRes.ok, false);
    assert.equal(hangRes.kind, 'timeout');
    assert.match(hangRes.error, /timed out/i);

    // 6. CLI integration: agb run --help, --driver remote-sdk --dry-run, live AGB_REMOTE_SDK_BIN, and invalid --driver
    const { spawnSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const agbBin = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

    const runHelp = spawnSync(process.execPath, [agbBin, 'run', '--help'], { encoding: 'utf8' });
    assert.equal(runHelp.status, 0);
    assert.ok(runHelp.stdout.includes('[--driver <local|remote-sdk> (execution driver)]'));
    assert.ok(runHelp.stdout.includes('[--interactive (pause flailing Strike-2 ticket for /grill-me rescue without aborting siblings)]'));
    assert.ok(runHelp.stdout.includes('[--merge (verify and merge remote-sdk branches locally)]'));
    assert.ok(runHelp.stdout.includes('[-c <n> (cap concurrent workers)]'));

    const planFile = join(repo, 'remote-plan.json');
    writeFileSync(
      planFile,
      JSON.stringify({
        repo,
        gate: { test: 'npm test' },
        tickets: [
          { id: 'T-1', title: 'Alpha', body: 'Do alpha', scope: ['a.mjs'], edges: [] },
        ],
      }) + '\n'
    );

    const badDriver = spawnSync(process.execPath, [agbBin, 'run', planFile, '--driver', 'unknown'], { encoding: 'utf8' });
    assert.equal(badDriver.status, 1);
    assert.match(badDriver.stderr, /invalid --driver/);

    const cliDry = spawnSync(process.execPath, [agbBin, 'run', planFile, '--driver', 'remote-sdk', '--dry-run', '--merge', '--interactive'], { encoding: 'utf8' });
    assert.equal(cliDry.status, 0, cliDry.stderr);
    const parsedDry = JSON.parse(cliDry.stdout);
    assert.equal(parsedDry.driver, 'remote-sdk');
    assert.equal(parsedDry.dryRun, true);
    assert.deepEqual(parsedDry.waves, [{ wave: 1, tickets: ['T-1'] }]);

    const cliLive = spawnSync(process.execPath, [agbBin, 'run', planFile, '--driver', 'remote-sdk'], {
      encoding: 'utf8',
      env: { ...process.env, AGB_REMOTE_SDK_BIN: FAKE_SDK },
    });
    assert.equal(cliLive.status, 0, cliLive.stderr);
    const parsedLive = JSON.parse(cliLive.stdout);
    assert.equal(parsedLive.ok, true);
    assert.deepEqual(parsedLive.completed, ['T-1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyAndMergeRemoteBranch and runRemoteSdkPlan({ merge: true }) enforce rails, custom verifier, git --no-ff merge, and block dependents on merge failure', async () => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const repo = mkdtempSync(join(tmpdir(), 'agb-remote-merge-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    writeFileSync(join(repo, 'conflict.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'init');

    // 1. Invalid branch and missing branch
    const invalidRes = await verifyAndMergeRemoteBranch({ repo, branch: '-bad' });
    assert.equal(invalidRes.ok, false);
    assert.equal(invalidRes.kind, 'invalid_branch');

    const missingRes = await verifyAndMergeRemoteBranch({ repo, branch: 'agb/remote-missing' });
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.kind, 'branch_not_found');

    // 2. Create clean branch agb/remote-t-1
    git('checkout', '-b', 'agb/remote-t-1');
    writeFileSync(join(repo, 'feature-1.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-m', 'T-1 commit');

    // 3. Create rail-violating branch agb/remote-t-rail
    git('checkout', 'main');
    git('checkout', '-b', 'agb/remote-t-rail');
    mkdirSync(join(repo, 'frozen'), { recursive: true });
    writeFileSync(join(repo, 'frozen', 'rail.mjs'), 'tampered\n');
    git('add', '.');
    git('commit', '-m', 'rail touch');

    // 4. Create conflicting branch agb/remote-t-conflict
    git('checkout', 'main');
    git('checkout', '-b', 'agb/remote-t-conflict');
    writeFileSync(join(repo, 'conflict.txt'), 'branch-side\n');
    git('add', '.');
    git('commit', '-m', 'conflict side');

    git('checkout', 'main');
    writeFileSync(join(repo, 'conflict.txt'), 'main-side\n');
    git('add', '.');
    git('commit', '-m', 'main side');

    // Rail violation (glob prefix)
    const railRes = await verifyAndMergeRemoteBranch({
      repo,
      branch: 'agb/remote-t-rail',
      base: 'main',
      rails: ['frozen/**'],
    });
    assert.equal(railRes.ok, false);
    assert.equal(railRes.kind, 'rail_violation');
    assert.match(railRes.error, /frozen\/\*\*/);

    // Custom verifier rejection & exception
    const rejected = await verifyAndMergeRemoteBranch({
      repo,
      branch: 'agb/remote-t-1',
      base: 'main',
      verifyBranch: async () => ({ ok: false, error: 'hollow-test failed' }),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.kind, 'verification_failed');
    assert.match(rejected.error, /hollow-test failed/);

    const threw = await verifyAndMergeRemoteBranch({
      repo,
      branch: 'agb/remote-t-1',
      base: 'main',
      verifyBranch: async () => { throw new Error('verifier crash'); },
    });
    assert.equal(threw.ok, false);
    assert.equal(threw.kind, 'verification_failed');
    assert.match(threw.error, /verifier crash/);

    // Merge conflict aborts cleanly without leaving dirty state
    const conflictRes = await verifyAndMergeRemoteBranch({
      repo,
      branch: 'agb/remote-t-conflict',
      base: 'main',
    });
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.kind, 'merge_conflict');
    assert.equal(git('status', '--porcelain'), '');

    // Clean runRemoteSdkPlan({ merge: true }): T-1 merges, T-RAIL fails rail guard and blocks T-2
    const plan = {
      repo,
      base: 'main',
      tickets: [
        { id: 'T-1', title: 'Clean', body: 'ok', scope: ['feature-1.txt'], rails: ['', '  '], edges: [] },
        { id: 'T-RAIL', title: 'Rail touch', body: 'bad', scope: ['frozen/rail.mjs'], rails: ['frozen/**'], edges: [{ to: 'T-2' }] },
        { id: 'T-2', title: 'Dependent', body: 'blocked', scope: ['dep.txt'], edges: [] },
      ],
    };
    const mergedPlan = await runRemoteSdkPlan(plan, {
      sdkBin: FAKE_SDK,
      merge: true,
      verifyBranch: async ({ changedFiles }) => ({ ok: changedFiles.length > 0 }),
    });
    assert.equal(mergedPlan.ok, false);
    assert.deepEqual(mergedPlan.merged, ['T-1']);
    assert.ok(mergedPlan.sessions['T-1'].mergedSha);
    assert.equal(existsSync(join(repo, 'feature-1.txt')), true);
    assert.match(mergedPlan.failed['T-RAIL'], /frozen\/\*\*/);
    assert.match(mergedPlan.failed['T-2'], /blocked by failed dependency: T-RAIL/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

