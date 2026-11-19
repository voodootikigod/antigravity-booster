import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunStatus, watchStatus } from '../lib/status.mjs';
import { checkHookLogDir } from '../lib/doctor.mjs';
import { isBoosterRepoCheckout, syncModels } from '../scripts/sync-models.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const AGB_BIN = join(REPO_ROOT, 'bin', 'agb.mjs');

test('RunStatus constructor removes stale .booster/report.json and report() stamps runId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-audit2-status-'));
  try {
    const boosterDir = join(dir, '.booster');
    const reportPath = join(boosterDir, 'report.json');
    mkdirSync(boosterDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ runId: 'old-run', merged: ['T0'], failed: {} }));
    assert.ok(existsSync(reportPath));

    const status = new RunStatus(dir, 'new-run-1');
    assert.equal(existsSync(reportPath), false, 'stale report.json should be removed on RunStatus init');

    status.report({ merged: ['T1'], failed: {}, requests: {} });
    await status.flushEvents();

    const written = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(written.runId, 'new-run-1');
    assert.deepEqual(written.merged, ['T1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchStatus ignores stale report.json with mismatched or missing runId, completes on matching runId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-audit2-watch-'));
  try {
    const boosterDir = join(dir, '.booster');
    const reportPath = join(boosterDir, 'report.json');
    const s = new RunStatus(dir, 'active-run-42');
    s.flush();

    // Plant a stale report from an older run with failure status (exit code 2 if erroneously accepted)
    writeFileSync(reportPath, JSON.stringify({ runId: 'stale-run-1', merged: [], failed: { T0: 'old failure' } }));

    let settled = false;
    const silentStream = { write: () => {} };
    const watchP = watchStatus(dir, { intervalMs: 25, interactive: false, stream: silentStream }).then((code) => {
      settled = true;
      return code;
    });

    // Give watchStatus several ticks; it must NOT terminate on mismatched runId
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(settled, false, 'watchStatus must not terminate on mismatched report.json runId');

    // Also test a legacy report with no runId at all
    writeFileSync(reportPath, JSON.stringify({ merged: [], failed: { T0: 'missing runId' } }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(settled, false, 'watchStatus must not terminate on report.json without runId');

    // Now write a report with the matching runId (clean completion -> exit 0)
    writeFileSync(reportPath, JSON.stringify({ runId: 'active-run-42', merged: ['T1'], failed: {} }));
    const code = await watchP;
    assert.equal(settled, true);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lib/agy.mjs has no duplicate hardcoded ":" PATH split block for realNodeBinDir', () => {
  const agySource = readFileSync(join(REPO_ROOT, 'lib', 'agy.mjs'), 'utf8');
  assert.equal(
    agySource.includes('realNodeBinDir'),
    false,
    'duplicate Linux-only realNodeBinDir PATH block should be removed'
  );
  assert.ok(
    agySource.includes("const sep = process.platform === 'win32' ? ';' : ':';"),
    'cross-platform PATH separator block should be preserved'
  );
});

test('checkHookLogDir detects symlinked dataRoot matching hook-runner.sh', () => {
  const home = mkdtempSync(join(tmpdir(), 'agb-audit2-doctor-home-'));
  const target = mkdtempSync(join(tmpdir(), 'agb-audit2-doctor-target-'));
  try {
    const pluginDataDir = join(home, '.gemini', 'antigravity-cli', 'plugin_data');
    mkdirSync(pluginDataDir, { recursive: true });
    const dataRoot = join(pluginDataDir, 'antigravity-booster');

    // Healthy when dataRoot does not exist yet
    const healthy = checkHookLogDir({ home });
    assert.equal(healthy.level, 'pass');

    // Symlinked dataRoot must trigger warn
    symlinkSync(target, dataRoot, 'dir');
    const symlinked = checkHookLogDir({ home });
    assert.equal(symlinked.level, 'warn');
    assert.match(symlinked.detail, /symlinked/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('agb sync-models --write refuses non-booster workspace without creating skills/', () => {
  const tmpWorkspace = mkdtempSync(join(tmpdir(), 'agb-audit2-nonbooster-'));
  try {
    // 1. Completely empty workspace
    const res1 = spawnSync(process.execPath, [AGB_BIN, 'sync-models', '--write', '--offline'], {
      cwd: tmpWorkspace,
      encoding: 'utf8',
    });
    assert.equal(res1.status, 1);
    assert.match(res1.stderr, /--write/);
    assert.match(res1.stderr, /antigravity-booster/);
    assert.equal(existsSync(join(tmpWorkspace, 'skills')), false, 'must not create skills/ in user repo');

    // 2. Workspace with package.json of a different project
    writeFileSync(join(tmpWorkspace, 'package.json'), JSON.stringify({ name: 'some-user-app' }));
    const res2 = spawnSync(process.execPath, [AGB_BIN, 'sync-models', '--write', '--offline'], {
      cwd: tmpWorkspace,
      encoding: 'utf8',
    });
    assert.equal(res2.status, 1);
    assert.equal(existsSync(join(tmpWorkspace, 'skills')), false);

    // 3. Workspace with antigravity-booster name but missing lib/models.mjs
    writeFileSync(join(tmpWorkspace, 'package.json'), JSON.stringify({ name: 'antigravity-booster' }));
    assert.equal(isBoosterRepoCheckout(tmpWorkspace), false);
    const res3 = syncModels({
      write: true,
      offline: true,
      rootDir: tmpWorkspace,
      requireBoosterCheckout: true,
    });
    assert.equal(res3.ok, false);
    assert.equal(res3.exitCode, 1);
    assert.equal(existsSync(join(tmpWorkspace, 'skills')), false);

    // 4. Adding lib/models.mjs makes it a valid booster checkout
    mkdirSync(join(tmpWorkspace, 'lib'), { recursive: true });
    writeFileSync(join(tmpWorkspace, 'lib', 'models.mjs'), '// stub\n');
    assert.equal(isBoosterRepoCheckout(tmpWorkspace), true);
  } finally {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});
