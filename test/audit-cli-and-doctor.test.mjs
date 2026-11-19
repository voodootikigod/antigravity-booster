// Regression tests for ADLC Ticket T-AUDIT-2:
//  (a) --interval validation on `agb status` and `agb watch`
//  (b) unknown --* flag rejection across subcommands
//  (c) applyDoctorFixes refusing to create .adlc/ outside git/ADLC repos
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyDoctorFixes } from '../lib/doctor.mjs';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agb-audit-cli-doctor-')));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

function runAgb(args, opts = {}) {
  return spawnSync(process.execPath, [AGB_BIN, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

function makeFakeHome(name) {
  const home = join(TMP, name);
  const pluginDir = join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ version: '99.0.0', adlcContract: 1 }));
  return home;
}

// --- (a) --interval validation on status and watch ---

for (const subcmd of ['status', 'watch']) {
  test(`agb ${subcmd}: rejects missing --interval value with exit code 1`, () => {
    const resEnd = runAgb([subcmd, '--interval']);
    assert.equal(resEnd.status, 1);
    assert.match(resEnd.stderr, /missing value for --interval/i);

    const resNextFlag = runAgb([subcmd, '--interval', '--json']);
    assert.equal(resNextFlag.status, 1);
    assert.match(resNextFlag.stderr, /missing value for --interval/i);

    const resValidNextFlag = runAgb([subcmd, '--interval', '--compact']);
    assert.equal(resValidNextFlag.status, 1);
    assert.match(resValidNextFlag.stderr, /missing value for --interval/i);
  });

  for (const badVal of ['0', '-5', 'abc', '10.5', '-w', '1e3']) {
    test(`agb ${subcmd}: rejects invalid --interval '${badVal}' with exit code 1`, () => {
      const res = runAgb([subcmd, '--interval', badVal]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /invalid --interval/i);
    });
  }
}

test('agb status and watch accept valid positive integer --interval', () => {
  const repo = join(TMP, 'interval-ok-repo');
  mkdirSync(join(repo, '.booster'), { recursive: true });
  writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r-ok', startedAt: new Date().toISOString() }));
  writeFileSync(join(repo, '.booster', 'report.json'), JSON.stringify({ runId: 'r-ok', merged: ['T1'], failed: {} }));

  const statusRes = runAgb(['status', repo, '--interval', '25', '--compact'], {
    env: { ...process.env, CI: '1' },
  });
  assert.equal(statusRes.status, 0, statusRes.stderr);

  const watchRes = runAgb(['watch', repo, '--interval', '25', '--compact'], {
    env: { ...process.env, CI: '1' },
  });
  assert.equal(watchRes.status, 0, watchRes.stderr);
  assert.match(watchRes.stdout, /\[AGB Watch\] run r-ok/);
});

// --- (b) unknown --* flag rejection across subcommands ---

const UNKNOWN_FLAG_CASES = [
  { cmd: 'plan', args: ['plan', 'spec.md', '--bogus-flag'], label: 'plan' },
  { cmd: 'review', args: ['review', '.', '--bogus-flag'], label: 'review' },
  { cmd: 'preflight', args: ['preflight', 'plan.json', '--bogus-flag'], label: 'preflight' },
  { cmd: 'status', args: ['status', '.', '--bogus-flag'], label: 'status' },
  { cmd: 'watch', args: ['watch', '.', '--bogus-flag'], label: 'watch' },
  { cmd: 'bootstrap', args: ['bootstrap', '--bogus-flag'], label: 'bootstrap' },
  { cmd: 'setup', args: ['setup', '--bogus-flag'], label: 'bootstrap' },
  { cmd: 'install', args: ['install', '--bogus-flag'], label: 'bootstrap' },
  { cmd: 'skills install', args: ['skills', 'install', '--bogus-flag'], label: 'bootstrap' },
  { cmd: 'doctor', args: ['doctor', '--bogus-flag'], label: 'doctor' },
  { cmd: 'sync-models', args: ['sync-models', '--bogus-flag'], label: 'sync-models' },
  { cmd: 'validate', args: ['validate', 'plan.json', '--bogus-flag'], label: 'validate' },
  { cmd: 'validate (flag first)', args: ['validate', '--bogus-flag'], label: 'validate' },
];

for (const { cmd, args, label } of UNKNOWN_FLAG_CASES) {
  test(`agb ${cmd}: rejects unknown --bogus-flag with exit code 1`, () => {
    const res = runAgb(args);
    assert.equal(res.status, 1, `expected exit 1 for agb ${cmd}, got ${res.status} (stderr: ${res.stderr})`);
    assert.match(res.stderr, new RegExp(`unknown flag '--bogus-flag' for ${label}`));
  });
}

test('agb status --ui still prints removed TUI migration message', () => {
  const res = runAgb(['status', TMP, '--ui']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /TUI flag has been removed.*agb sidecar/);
});

// --- (c) applyDoctorFixes repository guard ---

test('applyDoctorFixes: does not create .adlc/ in a non-git, non-ADLC directory', async () => {
  const plainDir = join(TMP, 'plain-non-repo');
  mkdirSync(plainDir, { recursive: true });
  const home = makeFakeHome('home-non-repo');

  const applied = await applyDoctorFixes({ cwd: plainDir, home, env: { HOME: home } });
  assert.equal(existsSync(join(plainDir, '.adlc')), false, '.adlc/ must not be created outside a git or ADLC repo');
  assert.equal(existsSync(join(plainDir, '.gitignore')), false, '.gitignore must not be created outside a git repo');
  assert.deepEqual(applied, []);
});

test('applyDoctorFixes: creates .adlc/config.json and .adlc/tickets/ inside a git repo', async () => {
  const gitRepo = join(TMP, 'git-repo-fix');
  mkdirSync(gitRepo, { recursive: true });
  execFileSync('git', ['init', '-q', gitRepo]);
  const home = makeFakeHome('home-git-repo');

  const applied = await applyDoctorFixes({ cwd: gitRepo, home, env: { HOME: home } });
  assert.equal(existsSync(join(gitRepo, '.adlc', 'config.json')), true);
  assert.equal(existsSync(join(gitRepo, '.adlc', 'tickets', '.store.json')), true);
  assert.equal(existsSync(join(gitRepo, '.gitignore')), true);
  assert.ok(applied.some((f) => f.includes('.adlc/config.json')));
  assert.ok(applied.some((f) => f.includes('.adlc/tickets')));
});

test('applyDoctorFixes: repairs missing config and ticket store when .adlc/ already exists', async () => {
  const adlcOnlyDir = join(TMP, 'adlc-only-dir');
  mkdirSync(join(adlcOnlyDir, '.adlc'), { recursive: true });
  const home = makeFakeHome('home-adlc-only');

  const applied = await applyDoctorFixes({ cwd: adlcOnlyDir, home, env: { HOME: home } });
  assert.equal(existsSync(join(adlcOnlyDir, '.adlc', 'config.json')), true);
  assert.equal(existsSync(join(adlcOnlyDir, '.adlc', 'tickets', '.store.json')), true);
  assert.equal(existsSync(join(adlcOnlyDir, '.gitignore')), false);
  assert.ok(applied.some((f) => f.includes('.adlc/config.json')));
  assert.ok(applied.some((f) => f.includes('.adlc/tickets')));
});
