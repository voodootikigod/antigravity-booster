import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemoteControlArgs,
  formatMobileAcceptCard,
  formatMobileStatusCard,
  isRemoteControlEnv,
  launchRemoteControl,
} from '../lib/remote-control.mjs';
import { renderStatus } from '../lib/status.mjs';
import { formatAcceptanceDossierMobile } from '../lib/accept.mjs';

test('isRemoteControlEnv and buildRemoteControlArgs validate flags and detect ANTIGRAVITY_REMOTE_CONTROL', () => {
  assert.equal(isRemoteControlEnv({}), false);
  assert.equal(isRemoteControlEnv({}, true), true);
  assert.equal(isRemoteControlEnv({ ANTIGRAVITY_REMOTE_CONTROL: '1' }), true);
  assert.equal(isRemoteControlEnv({ ANTIGRAVITY_REMOTE_CONTROL: 'true' }), true);
  assert.equal(isRemoteControlEnv({ ANTIGRAVITY_REMOTE_CONTROL: '0' }), false);

  assert.deepEqual(buildRemoteControlArgs(), ['--remote-control']);
  assert.deepEqual(buildRemoteControlArgs({ project: 'a' }), ['--remote-control', '--project', 'a']);
  assert.deepEqual(buildRemoteControlArgs({ project: 'team/demo', prompt: 'watch' }), [
    '--remote-control',
    '--project',
    'team/demo',
    'watch',
  ]);
  assert.throws(() => buildRemoteControlArgs({ project: 'bad;rm -rf /' }), /Invalid --project/);
  assert.throws(() => buildRemoteControlArgs({ prompt: 'hi\0there' }), /null byte/i);
});

test('launchRemoteControl dry-run, missing repo, and mobile status/accept cards', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-remote-control-'));
  try {
    // 1. Missing repo fails cleanly
    const missing = await launchRemoteControl({ repo: join(repo, 'missing'), dryRun: true });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /does not exist/);

    // 2. Dry-run returns structured launch plan
    const dry = await launchRemoteControl({ repo, project: 'demo', dryRun: true, agyBin: '/usr/bin/agy' });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.agyBin, '/usr/bin/agy');
    assert.equal(dry.args[0], '--remote-control');
    assert.equal(dry.args[1], '--project');
    assert.equal(dry.args[2], 'demo');
    assert.equal(dry.env.ANTIGRAVITY_REMOTE_CONTROL, '1');

    // 3. Real spawn against node -e "process.exit(0)" succeeds
    const liveOk = await launchRemoteControl({
      repo,
      agyBin: process.execPath,
      prompt: 'test',
      dryRun: false,
    });
    assert.equal(liveOk.ok, false); // node rejects --remote-control, verifying close exitCode propagation
    assert.equal(typeof liveOk.exitCode, 'number');

    // 4. Mobile status card via renderStatus({ mobile: true }) & ANTIGRAVITY_REMOTE_CONTROL=1
    mkdirSync(join(repo, '.booster'), { recursive: true });
    writeFileSync(
      join(repo, '.booster', 'run.json'),
      JSON.stringify({
        runId: 'run-mob-1',
        done: false,
        startedAt: '2026-11-27T00:00:00Z',
        pools: { quota: { gemini: { effectivePercent: 85 }, claude_gpt: { effectivePercent: 40 } } },
        tickets: {
          'T-1': { phase: 'merged', model: 'gemini-4-neon-high' },
          'T-2': { phase: 'failed', model: 'gemini-4-neon-medium' },
          'T-3': { phase: 'running', model: 'gemini-4-hydrogen-medium' },
        },
      })
    );

    const mobileOut = renderStatus(repo, { mobile: true });
    assert.match(mobileOut, /### AGB Fleet — `run-mob-1` \(RUNNING\)/);
    assert.match(mobileOut, /1\/3 merged · 1 active · 1 failed · 0 blocked/);
    assert.match(mobileOut, /Gemini 85% · Claude\/GPT 40%/);
    assert.match(mobileOut, /Run Surgical Rescue on T-2/);

    const plainOut = renderStatus(repo, { env: {} });
    assert.match(plainOut, /^run run-mob-1/);
    assert.doesNotMatch(plainOut, /### AGB Fleet/);

    const envMobileOut = renderStatus(repo, { env: { ANTIGRAVITY_REMOTE_CONTROL: '1' } });
    assert.equal(envMobileOut, mobileOut);

    const doneCard = formatMobileStatusCard({
      runId: 'run-done',
      done: true,
      tickets: { 'T-1': { phase: 'merged' } },
    });
    assert.match(doneCard, /DONE/);
    assert.match(doneCard, /Open P6 Sign-Off/);

    // 5. Mobile P6 accept card (ready vs needs review)
    const readyCard = formatAcceptanceDossierMobile({
      base: 'origin/main',
      readyForSignOff: true,
      counts: { filesChanged: 2, totalHunks: 4, acceptedHunks: 4, flaggedHunks: 0, pendingHunks: 0 },
      gateManifest: { totalEntries: 6 },
      browserEvidence: { ok: true, routes: ['/'], screenshots: [{ name: 'a.png' }] },
      externalCallers: { callers: [{ file: 'a.mjs', line: 1 }] },
    });
    assert.match(readyCard, /READY FOR P6 MERGE/);
    assert.match(readyCard, /Approve & Merge/);
    assert.match(readyCard, /Browser Gate:\*\* PASS/);
    assert.match(readyCard, /External Callers:\*\* 1/);

    const reviewCard = formatMobileAcceptCard({
      base: 'HEAD',
      readyForSignOff: false,
      counts: { filesChanged: 1, totalHunks: 2, acceptedHunks: 0, flaggedHunks: 1, pendingHunks: 1 },
    });
    assert.match(reviewCard, /NEEDS REVIEW/);
    assert.match(reviewCard, /Review Flagged\/Pending Hunks/);

    // 6. CLI integration: agb remote-control --help / --dry-run --json, agb status --mobile, agb accept --mobile
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const agbBin = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

    const rcHelp = spawnSync(process.execPath, [agbBin, 'remote-control', '--help'], { encoding: 'utf8' });
    assert.equal(rcHelp.status, 0);
    assert.match(rcHelp.stdout, /agb remote-control \[repo\]/);
    assert.match(rcHelp.stdout, /--dry-run/);

    const rcDry = spawnSync(process.execPath, [agbBin, 'remote-control', repo, '--dry-run', '--json'], { encoding: 'utf8' });
    assert.equal(rcDry.status, 0, rcDry.stderr);
    const parsedDry = JSON.parse(rcDry.stdout);
    assert.equal(parsedDry.ok, true);
    assert.equal(parsedDry.dryRun, true);
    assert.equal(parsedDry.args[0], '--remote-control');

    const statusCli = spawnSync(process.execPath, [agbBin, 'status', repo, '--mobile'], { encoding: 'utf8' });
    assert.equal(statusCli.status, 0, statusCli.stderr);
    assert.match(statusCli.stdout, /### AGB Fleet — `run-mob-1` \(RUNNING\)/);

    const statusHelp = spawnSync(process.execPath, [agbBin, 'status', '--help'], { encoding: 'utf8' });
    assert.ok(statusHelp.stdout.includes('[--interval <ms> (poll interval)]'));
    assert.match(statusHelp.stdout, /--mobile/);

    const acceptHelp = spawnSync(process.execPath, [agbBin, 'accept', '--help'], { encoding: 'utf8' });
    assert.ok(acceptHelp.stdout.includes('[--base <ref> (git base ref)]'));
    assert.match(acceptHelp.stdout, /--mobile/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
