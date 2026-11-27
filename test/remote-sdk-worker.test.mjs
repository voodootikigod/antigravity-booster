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

    const cliDry = spawnSync(process.execPath, [agbBin, 'run', planFile, '--driver', 'remote-sdk', '--dry-run'], { encoding: 'utf8' });
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
