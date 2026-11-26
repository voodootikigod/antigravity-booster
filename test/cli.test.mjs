import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

// Scratch lives outside the checkout so a test run never dirties the working
// tree, and is torn down in `after` so it survives an assertion failing early.
// realpathSync resolves macOS's /var -> /private/var symlink, which git
// canonicalises and would otherwise mismatch paths reported back to us.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agb-cli-test-')));
process.env.AGB_QUOTA_STATE = join(TMP, `agb_pools_cli_test_${process.pid}.json`);
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
  const plan = { repo: '.', tickets: [{id: 'T1', title: 't', body: 'b', scope: ['src/**'], rails: [], edges: []}], gate: { test: 'npm test' } };
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
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'cli-repo',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  g('add', '-A');
  g('commit', '-m', 'init');

  const plan = {
    repo,
    tickets: [
      { id: 'T1', title: 'test', body: 't', scope: ['T1.txt'], rails: [], edges: [] }
    ],
    gate: { test: 'npm test' }
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

test('agb migrate rejects unknown flags and missing value flags with exit code 1', () => {
  const resUnknown = spawnSync(process.execPath, [AGB_BIN, 'migrate', '--dry-run'], { encoding: 'utf8' });
  assert.strictEqual(resUnknown.status, 1);
  assert.match(resUnknown.stderr, /Unknown flag for agb migrate: --dry-run/);

  const resMissingVal = spawnSync(process.execPath, [AGB_BIN, 'migrate', '--finish-uninstall', '--token'], { encoding: 'utf8' });
  assert.strictEqual(resMissingVal.status, 1);
  assert.match(resMissingVal.stderr, /Missing value for --token/);
});

test('mcp resolveAgbEntry fails closed to bundled agb.mjs when bundled=true', async () => {
  const { resolveAgbEntry } = await import('../mcp/server.mjs');
  const nonExistentDir = join(TMP, 'no-such-bundle-dir');
  const bundledEntry = resolveAgbEntry(nonExistentDir, true);
  assert.strictEqual(bundledEntry.cmd, process.execPath);
  assert.deepStrictEqual(bundledEntry.args, [join(nonExistentDir, 'agb.mjs')]);
});

test('T-RA-4B: --follow help text describes keep-watching behavior, not log tailing', () => {
  for (const args of [['--help'], ['help', 'status'], ['help', 'watch']]) {
    const out = execFileSync(process.execPath, [AGB_BIN, ...args], { encoding: 'utf8' });
    assert.match(out, /--follow \(keep watching after run completion\)/);
    assert.doesNotMatch(out, /follow logs/i);
  }
});

test('T-RA-4B: agb plan --emit-workflow refuses to overwrite existing file without --force before compilePlan()', () => {
  const repo = join(TMP, 'emit-wf-refuse-repo');
  mkdirSync(repo, { recursive: true });
  const existingWf = join(repo, 'existing-workflow.py');
  writeFileSync(existingWf, '# hand-edited workflow\n');
  const outPlan = join(TMP, 'emit-wf-out.json');

  // Relative --emit-workflow resolves against [repo]; invalid AGB_AGY_BIN proves
  // we fail closed before quota refresh / compilePlan().
  const resRel = spawnSync(
    process.execPath,
    [AGB_BIN, 'plan', 'nonexistent-spec.md', repo, '--out', outPlan, '--emit-workflow', 'existing-workflow.py'],
    { encoding: 'utf8', env: { ...process.env, AGB_AGY_BIN: '/nonexistent/agy' } }
  );
  assert.strictEqual(resRel.status, 1);
  assert.match(resRel.stderr, /already exists/);
  assert.match(resRel.stderr, /--force/);
  assert.doesNotMatch(resRel.stderr, /quota telemetry unavailable/i);
  assert.strictEqual(readFileSync(existingWf, 'utf8'), '# hand-edited workflow\n');
  assert.strictEqual(existsSync(outPlan), false);

  // Absolute --emit-workflow path is also guarded before compilePlan().
  const resAbs = spawnSync(
    process.execPath,
    [AGB_BIN, 'plan', 'nonexistent-spec.md', repo, '--out', outPlan, '--emit-workflow', existingWf],
    { encoding: 'utf8', env: { ...process.env, AGB_AGY_BIN: '/nonexistent/agy' } }
  );
  assert.strictEqual(resAbs.status, 1);
  assert.match(resAbs.stderr, /already exists/);
  assert.match(resAbs.stderr, /--force/);
  assert.strictEqual(readFileSync(existingWf, 'utf8'), '# hand-edited workflow\n');
});

test('T-RA-4B: init, sweep, brains, import-brain, probe, and pool reject unknown flags without mutating cwd', () => {
  const cleanDir = join(TMP, 'no-mutate-init');
  mkdirSync(cleanDir, { recursive: true });

  const initDryRun = spawnSync(process.execPath, [AGB_BIN, 'init', '--dry-run'], {
    cwd: cleanDir,
    encoding: 'utf8',
  });
  assert.strictEqual(initDryRun.status, 1);
  assert.match(initDryRun.stderr, /unknown flag '--dry-run' for init/);
  assert.strictEqual(existsSync(join(cleanDir, '.adlc')), false, 'must not create .adlc on rejected flag');
  assert.strictEqual(existsSync(join(cleanDir, 'specs')), false, 'must not create specs on rejected flag');
  assert.strictEqual(existsSync(join(cleanDir, '.gitignore')), false, 'must not create .gitignore on rejected flag');

  const initShort = spawnSync(process.execPath, [AGB_BIN, 'init', cleanDir, '-n'], {
    cwd: cleanDir,
    encoding: 'utf8',
  });
  assert.strictEqual(initShort.status, 1);
  assert.match(initShort.stderr, /unknown flag '-n' for init/);
  assert.strictEqual(existsSync(join(cleanDir, '.adlc')), false);

  const cases = [
    { args: ['sweep', 'sweep.json', '--dry-run'], flag: '--dry-run', cmd: 'sweep' },
    { args: ['sweep', '-x'], flag: '-x', cmd: 'sweep' },
    { args: ['brains', '--json'], flag: '--json', cmd: 'brains' },
    { args: ['brains', '-l'], flag: '-l', cmd: 'brains' },
    { args: ['import-brain', 'abc', cleanDir, '--force'], flag: '--force', cmd: 'import-brain' },
    { args: ['probe', '2', '--json'], flag: '--json', cmd: 'probe' },
    { args: ['pool', 'drain', cleanDir, '--force'], flag: '--force', cmd: 'pool' },
    { args: ['pool', '--bogus'], flag: '--bogus', cmd: 'pool' },
  ];
  for (const { args, flag, cmd } of cases) {
    const r = spawnSync(process.execPath, [AGB_BIN, ...args], { cwd: cleanDir, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, `expected exit 1 for agb ${args.join(' ')}, got ${r.status}`);
    assert.match(r.stderr, new RegExp(`unknown flag '${flag}' for ${cmd}`));
  }

  // Verify valid invocations of brains and pool drain still succeed.
  const poolRes = spawnSync(process.execPath, [AGB_BIN, 'pool', 'drain', cleanDir], { encoding: 'utf8' });
  assert.strictEqual(poolRes.status, 0, poolRes.stderr);
  const brainsRes = spawnSync(process.execPath, [AGB_BIN, 'brains'], { encoding: 'utf8' });
  assert.strictEqual(brainsRes.status, 0, brainsRes.stderr);
});

test('T-TE-7a: help text documents new review, preflight, and init flags', () => {
  const reviewHelp = execFileSync(process.execPath, [AGB_BIN, 'help', 'review'], { encoding: 'utf8' });
  for (const flag of ['--thorough', '--dry-rounds', '--seams-only', '--plan-file', '--delta', '--prior-findings', '--no-codegraph', '--no-decision-engine']) {
    assert.ok(reviewHelp.includes(flag), `agb help review missing ${flag}`);
  }
  const preflightHelp = execFileSync(process.execPath, [AGB_BIN, 'help', 'preflight'], { encoding: 'utf8' });
  assert.ok(preflightHelp.includes('--force-coldstart'), 'agb help preflight missing --force-coldstart');
  const initHelp = execFileSync(process.execPath, [AGB_BIN, 'help', 'init'], { encoding: 'utf8' });
  assert.ok(initHelp.includes('--with-codegraph'), 'agb help init missing --with-codegraph');
  assert.ok(initHelp.includes('--decision-provider'), 'agb help init missing --decision-provider');
});

test('T-TE-7a: agb init --with-codegraph and --decision-provider scaffold config & .gitignore and reject invalid provider', () => {
  const repo = join(TMP, 'init-accel-repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

  // Invalid provider fails before mutating repo
  const bad = spawnSync(process.execPath, [AGB_BIN, 'init', repo, '--decision-provider', 'bogus'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /invalid --decision-provider 'bogus'/);
  assert.strictEqual(existsSync(join(repo, '.adlc', 'config.json')), false);

  // Valid --with-codegraph + --decision-provider gemini-decisions
  const minimalPath = '/usr/bin:/bin';
  const ok = spawnSync(
    process.execPath,
    [AGB_BIN, 'init', repo, '--with-codegraph', '--decision-provider', 'gemini-decisions'],
    { encoding: 'utf8', env: { ...process.env, PATH: minimalPath } }
  );
  assert.strictEqual(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.withCodegraph, true);
  assert.strictEqual(parsed.decisionProvider, 'gemini-decisions');

  const cfg = JSON.parse(readFileSync(join(repo, '.adlc', 'config.json'), 'utf8'));
  assert.strictEqual(cfg.accelerators?.codegraph, true);
  assert.deepStrictEqual(cfg.accelerators?.decision, { enabled: true, provider: 'gemini-decisions' });

  const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.codegraph\/$/m);

  // Idempotent second run does not duplicate .codegraph/
  const ok2 = spawnSync(
    process.execPath,
    [AGB_BIN, 'init', repo, '--with-codegraph'],
    { encoding: 'utf8', env: { ...process.env, PATH: minimalPath } }
  );
  assert.strictEqual(ok2.status, 0, ok2.stderr);
  const gitignore2 = readFileSync(join(repo, '.gitignore'), 'utf8');
  assert.strictEqual(gitignore2.match(/^\.codegraph\/$/gm)?.length, 1);
});

test('T-TE-7a: agb review validates new flags, decouples --loop from static multi-round, and supports --delta + --prior-findings', async () => {
  const repo = join(TMP, 'review-flags-repo');
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'app.js'), 'export const x = 1;\n');
  g('add', '-A');
  g('commit', '-m', 'init');
  writeFileSync(join(repo, 'app.js'), 'export const x = 2;\n');

  // Reject unknown flag and invalid --dry-rounds
  const badFlag = spawnSync(process.execPath, [AGB_BIN, 'review', repo, '--bogus-flag'], { encoding: 'utf8' });
  assert.strictEqual(badFlag.status, 1);
  assert.match(badFlag.stderr, /unknown flag '--bogus-flag' for review/);

  const badDry = spawnSync(process.execPath, [AGB_BIN, 'review', repo, '--dry-rounds', '0'], { encoding: 'utf8' });
  assert.strictEqual(badDry.status, 1);
  assert.match(badDry.stderr, /invalid --dry-rounds '0'/);

  const badPlanFile = join(TMP, 'bad-plan-file.json');
  writeFileSync(badPlanFile, JSON.stringify({ notTickets: true }));
  const badPfRes = spawnSync(process.execPath, [AGB_BIN, 'review', repo, '--plan-file', badPlanFile], { encoding: 'utf8' });
  assert.strictEqual(badPfRes.status, 1);
  assert.match(badPfRes.stderr, /invalid --plan-file/);

  const fakeAgy = fileURLToPath(new URL('fixtures/fake-agy', import.meta.url));
  const env = { ...process.env, AGB_AGY_BIN: fakeAgy, AGB_DECISION_ENGINE: '0' };

  // --loop over a static diff must NOT force maxRounds: 3 (runs 1 round by default)
  const loopRes = spawnSync(
    process.execPath,
    [AGB_BIN, 'review', repo, '--loop', '--no-codegraph', '--no-decision-engine'],
    { encoding: 'utf8', env }
  );
  assert.strictEqual(loopRes.status, 0, loopRes.stderr);
  const loopJson = JSON.parse(loopRes.stdout);
  assert.strictEqual(loopJson.rounds, 1, 'static diff --loop must default to 1 round unless --thorough or --dry-rounds is set');

  // --thorough runs multi-dry convergence (2 dry rounds)
  const thoroughRes = spawnSync(
    process.execPath,
    [AGB_BIN, 'review', repo, '--thorough', '--no-codegraph', '--no-decision-engine'],
    { encoding: 'utf8', env }
  );
  assert.strictEqual(thoroughRes.status, 0, thoroughRes.stderr);
  const thoroughJson = JSON.parse(thoroughRes.stdout);
  assert.strictEqual(thoroughJson.rounds, 2, '--thorough must run 2 dry rounds on clean diff');

  // --delta + --prior-findings persists updated findings state
  const priorPath = join(repo, '.review', 'custom-findings.json');
  mkdirSync(join(repo, '.review'), { recursive: true });
  writeFileSync(priorPath, JSON.stringify([{ file: 'app.js', lens: 'correctness', claim: 'old issue', severity: 'low' }]));
  const deltaRes = spawnSync(
    process.execPath,
    [AGB_BIN, 'review', repo, '--delta', 'HEAD', '--prior-findings', priorPath, '--no-codegraph', '--no-decision-engine'],
    { encoding: 'utf8', env }
  );
  assert.strictEqual(deltaRes.status, 0, deltaRes.stderr);
  assert.strictEqual(existsSync(priorPath), true);
  assert.deepStrictEqual(JSON.parse(readFileSync(priorPath, 'utf8')), []);
});

test('T-TE-7a: agb preflight --force-coldstart bypasses cached coldstart hashes', async () => {
  const { hashTicketColdstart } = await import('../lib/preflight.mjs');
  const repo = join(TMP, 'preflight-force-repo');
  mkdirSync(repo, { recursive: true });
  const ticket = { id: 'T1', title: 'test', body: 'Do work in a.txt', scope: ['a.txt'], rails: [], edges: [] };
  const gate = { test: 'npm test' };
  const plan = {
    repo,
    tickets: [ticket],
    gate,
    gateProvenance: {
      coldstartHashes: { T1: hashTicketColdstart(ticket, gate) },
    },
  };
  const planPath = join(repo, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const fakeAgy = fileURLToPath(new URL('fixtures/fake-agy', import.meta.url));
  const env = { ...process.env, AGB_AGY_BIN: fakeAgy };

  const cachedRes = spawnSync(process.execPath, [AGB_BIN, 'preflight', planPath], { encoding: 'utf8', env });
  assert.strictEqual(cachedRes.status, 0, cachedRes.stderr);
  assert.deepStrictEqual(JSON.parse(cachedRes.stdout).cachedColdstartIds, ['T1']);

  const forcedRes = spawnSync(process.execPath, [AGB_BIN, 'preflight', planPath, '--force-coldstart'], { encoding: 'utf8', env });
  assert.strictEqual(forcedRes.status, 0, forcedRes.stderr);
  assert.deepStrictEqual(JSON.parse(forcedRes.stdout).cachedColdstartIds, []);

  const badRes = spawnSync(process.execPath, [AGB_BIN, 'preflight', planPath, '--unknown'], { encoding: 'utf8', env });
  assert.strictEqual(badRes.status, 1);
  assert.match(badRes.stderr, /unknown flag '--unknown' for preflight/);
});
