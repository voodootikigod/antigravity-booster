import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

// Scratch lives outside the checkout so a test run never dirties the working
// tree, and is torn down in `after` so it survives an assertion failing early.
// realpathSync resolves macOS's /var -> /private/var symlink, which git
// canonicalises and would otherwise mismatch paths reported back to us.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agb-cli-test-')));
process.env.AGB_QUOTA_STATE = join(TMP, 'agb_pools_cli_test.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

test('agb COMMANDS table covers all dispatched commands', () => {
  const code = readFileSync(AGB_BIN, 'utf8');
  const cmdMatches = [...code.matchAll(/cmd === '([^']+)'/g)].map(m => m[1]);
  const tableStart = code.indexOf('const COMMANDS = {');
  const tableEnd = code.indexOf('};', tableStart);
  assert(tableStart !== -1 && tableEnd !== -1, 'COMMANDS table not found');
  const tableStr = code.slice(tableStart, tableEnd + 2);

  const declaredCmds = [...tableStr.matchAll(/(\w+|'[^']+'):/g)].map(m => m[1].replace(/'/g, ''));

  // Aliases and flags are not commands and have no table row of their own.
  for (const cmd of cmdMatches) {
    if (['setup', 'install', 'skills', 'help', '--help', '-h', 'version', '--version', '-v'].includes(cmd)) continue;
    assert(declaredCmds.includes(cmd), `Command ${cmd} is dispatched but not in COMMANDS table`);
  }
});

test('agb status --ui exits non-zero with migration message', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-test-'));
  const res = spawnSync(process.execPath, [AGB_BIN, 'status', repo, '--ui']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr.toString(), /TUI flag has been removed.*agb sidecar/);
});

test('agb tui exits non-zero with migration message', () => {
  const res = spawnSync(process.execPath, [AGB_BIN, 'tui']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr.toString(), /TUI has been removed.*agb sidecar/);
});



test('agb version', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  for (const flag of ['--version', '-v', 'version']) {
    const stdout = execFileSync(process.execPath, [AGB_BIN, flag], { encoding: 'utf8' }).trim();
    assert.equal(stdout, pkg.version, `agb ${flag} must report the manifest version`);
  }
});

test('agb help exits 0 and prints usage', () => {
  const stdout = execFileSync(process.execPath, [AGB_BIN, 'help'], { encoding: 'utf8' });
  assert(stdout.includes('Antigravity Booster orchestrator'));
  assert(stdout.includes('agb run <plan.json>'));
});

test('agb --help exits 0 and prints usage', () => {
  const stdout = execFileSync(process.execPath, [AGB_BIN, '--help'], { encoding: 'utf8' });
  assert(stdout.includes('Antigravity Booster orchestrator'));
});

test('agb unknown exits 1 and prints error', () => {
  let threw = false;
  try {
    execFileSync(process.execPath, [AGB_BIN, 'unknown-cmd'], { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 1);
    assert(err.stderr.includes("unknown command 'unknown-cmd'"));
  }
  assert(threw, 'unknown command did not throw');
});

test('agb help <cmd> exits 0 and prints per-cmd usage', () => {
  const stdout = execFileSync(process.execPath, [AGB_BIN, 'help', 'run'], { encoding: 'utf8' });
  assert(stdout.includes('agb run <plan.json>'));
  assert(stdout.includes('execute a ticket DAG'));
});

test('agb validate exits 0 on valid plan', () => {
  const plan = { repo: '.', tickets: [{id: 'T1', title: 't', body: 'b', scope: ['src/**'], rails: [], edges: []}], gate: { build: 'true' } };
  const planFile = join(TMP, 'valid.json');
  writeFileSync(planFile, JSON.stringify(plan));
  execFileSync(process.execPath, [AGB_BIN, 'validate', planFile]);
});

test('agb validate exits 2 on invalid plan', () => {
  let threw = false;
  const plan = { tickets: [{ id: '1' }, { id: '1' }] }; // duplicate id
  const planFile = join(TMP, 'invalid.json');
  writeFileSync(planFile, JSON.stringify(plan));
  try {
    execFileSync(process.execPath, [AGB_BIN, 'validate', planFile]);
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 2);
  }
  assert(threw);
});

test('agb plan --out overwrite refusal', () => {
  const tmp = join(TMP, 'plan-out.json');
  writeFileSync(tmp, '{"exists":true}');
  let threw = false;
  try {
    execFileSync(process.execPath, [AGB_BIN, 'plan', 'foo', '.', '--out', tmp, '--no-premortem'], { encoding: 'utf8', env: { ...process.env, AGB_AGY_BIN: 'true' } });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 1);
    assert(err.stderr.includes('already exists — pass --force to overwrite'));
  }
  assert(threw);
});

test('agb run smoke on a tiny fixture (fake-agy, success)', () => {
  const repo = join(TMP, 'cli-repo');
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-b', 'main');
  // Throwaway test repos must not depend on the developer's (or CI runner's)
  // identity / commit-signing setup — set local config only.
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  g('commit', '--allow-empty', '-m', 'init');

  const plan = {
    repo,
    tickets: [
      { id: 'T1', title: 'test', body: 't', scope: ['T1.txt'], rails: [], edges: [] }
    ],
    gate: { build: 'true', test: 'true' }
  };
  writeFileSync(join(repo, 'plan.json'), JSON.stringify(plan));

  // Fake agy script that succeeds
  const fakeAgy = fileURLToPath(new URL('fixtures/fake-agy', import.meta.url));
  const env = { ...process.env, AGB_AGY_BIN: fakeAgy, AGB_ADLC_BIN: fileURLToPath(new URL('fixtures/fake-adlc', import.meta.url)), AGB_ALLOW_CUSTOM_ADLC_CLI: '1', PATH: process.env.PATH, AGB_ALLOW_DIRTY: '1', AGB_SANDBOX_GATES: '0' };

  // success
  const out = execFileSync(process.execPath, [AGB_BIN, 'run', 'plan.json'], { cwd: repo, env, encoding: 'utf8' });
  assert(out.includes('"merged": [\n    "T1"\n  ]'));
});

test('agb status against a synthetic .booster/run.json', () => {
  const repo = join(TMP, 'status-repo');
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, '.booster'), { recursive: true });

  const runState = {
    started: new Date().toISOString(),
    status: 'RUNNING',
    tickets: {
      T1: { phase: 'merged', model: 'fake', attempts: [] }
    },
    edges: []
  };
  writeFileSync(join(repo, '.booster/run.json'), JSON.stringify(runState));

  const out = execFileSync(process.execPath, [AGB_BIN, 'status', repo], { encoding: 'utf8' });
  assert(out.includes('T1'));
  assert(out.includes('merged'));
});
