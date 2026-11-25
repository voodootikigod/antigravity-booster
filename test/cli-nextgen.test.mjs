// End-to-end CLI tests for v2.0.0 Next-Gen Cockpit & MCP Apps wiring (T-NG-6):
//  - version 2.0.0 in CLI + manifests
//  - agb statusline [render|title|install|uninstall] [--force]
//  - bootstrap() non-clobbering statusLine/title installation + malformed settings.json resilience
//  - statusline quota cache fast-path in CLI commands when AGB_AGY_BIN is unset
//  - agb rescue <id> [repo] [--continue] [--plan <plan.json>] exit codes (0 vs 2)
//  - agb run --resume and --reset-rescue CLI flag forwarding
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync as execBin, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { bootstrap } from '../lib/bootstrap.mjs';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agb-cli-nextgen-')));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

function runAgb(args, opts = {}) {
  return spawnSync(process.execPath, [AGB_BIN, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    ...opts,
  });
}

function makeGitRepo(name) {
  const repo = join(TMP, name);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2) + '\n'
  );
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.booster/\n.worktrees/\n');
  writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1 }, null, 2) + '\n');
  initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
  writeFileSync(join(repo, 'src', 'base.js'), 'export const base = 1;\n');

  execBin('git', ['init', '-b', 'main', '-q', repo]);
  execBin('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execBin('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execBin('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
  execBin('git', ['-C', repo, 'add', '.']);
  execBin('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
}

test('agb --version reports 2.0.0', () => {
  const res = runAgb(['--version']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '2.0.0');
});

test('agb statusline render, title, install, --force, uninstall, and bad action', () => {
  const home = join(TMP, 'home-statusline');
  const repo = makeGitRepo('repo-statusline');
  writeFileSync(
    join(repo, '.adlc', 'tickets', ticketFilename('T-42')),
    JSON.stringify({ id: 'T-42', title: 'Widget', body: 'b', scope: ['src/**'], rails: ['lib/lock.mjs', 'lib/gates.mjs'], edges: [] })
  );

  const env = { ...process.env, HOME: home, AGB_HOME_DIR: home, AGB_POOLS_DIR: join(home, 'pools') };
  const future = new Date(Date.now() + 3600_000).toISOString();
  const stdinPayload = JSON.stringify({
    cwd: repo,
    context_window: { used_percentage: 84, exceeds_200k_tokens: true },
    quota: {
      buckets: [
        { id: 'gemini-5h', remaining_percentage: 72, reset_time: future },
        { id: 'gemini-weekly', remaining_percentage: 88, reset_time: future },
        { id: '3p-5h', remaining_percentage: 41, reset_time: future },
        { id: '3p-weekly', remaining_percentage: 65, reset_time: future },
      ],
    },
  });

  const renderRes = runAgb(['statusline', 'render'], { env, input: stdinPayload });
  assert.equal(renderRes.status, 0, renderRes.stderr);
  assert.match(renderRes.stdout, /\[AGB\]/);
  assert.match(renderRes.stdout, /T-42/);
  assert.match(renderRes.stdout, /🔒2 rails/);
  assert.match(renderRes.stdout, /G:72%/);
  assert.match(renderRes.stdout, /C:41%/);
  assert.match(renderRes.stdout, /!ROT/);
  assert.equal(existsSync(join(home, 'pools', 'agb_statusline_quota.json')), true, 'Should write lock-free quota cache');

  const titleRes = runAgb(['statusline', 'title'], { env, input: stdinPayload });
  assert.equal(titleRes.status, 0, titleRes.stderr);
  assert.equal(titleRes.stdout.trim(), 'AGB · repo-statusline · T-42');

  // Install into empty home
  const instRes = runAgb(['statusline', 'install'], { env, input: '' });
  assert.equal(instRes.status, 0, instRes.stderr);
  const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const settings1 = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings1.statusLine.stack_with_default, true);
  assert.match(settings1.statusLine.command, /statusline render$/);
  assert.match(settings1.title.command, /statusline title$/);

  // Preserve custom user statusLine unless --force is passed
  writeFileSync(
    settingsPath,
    JSON.stringify({
      theme: 'solarized',
      statusLine: { type: 'command', command: '/usr/local/bin/custom-bar' },
      title: { type: 'command', command: '/usr/local/bin/custom-title' },
    }, null, 2)
  );
  const preserveRes = runAgb(['statusline', 'install'], { env, input: '' });
  assert.equal(preserveRes.status, 0, preserveRes.stderr);
  const settingsPreserved = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settingsPreserved.statusLine.command, '/usr/local/bin/custom-bar');
  assert.equal(settingsPreserved.theme, 'solarized');

  const forceRes = runAgb(['statusline', 'install', '--force'], { env, input: '' });
  assert.equal(forceRes.status, 0, forceRes.stderr);
  const settingsForced = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.match(settingsForced.statusLine.command, /statusline render$/);
  assert.equal(settingsForced.theme, 'solarized');

  // Uninstall removes only statusline entries and preserves unrelated settings
  const uninstRes = runAgb(['statusline', 'uninstall'], { env, input: '' });
  assert.equal(uninstRes.status, 0, uninstRes.stderr);
  const settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settingsAfter.statusLine, undefined);
  assert.equal(settingsAfter.title, undefined);
  assert.equal(settingsAfter.theme, 'solarized');

  // Invalid subaction exits 1
  const badRes = runAgb(['statusline', 'bogus'], { env, input: '' });
  assert.equal(badRes.status, 1);
  assert.match(badRes.stderr, /unknown statusline action 'bogus'/);
});

test('bootstrap() configures statusLine/title non-destructively and never fails on malformed settings.json', () => {
  const homeOk = join(TMP, 'home-bootstrap-ok');
  const fakeState = join(TMP, 'bootstrap-fake-state');
  mkdirSync(fakeState, { recursive: true });

  // Pre-seed a compatible higher-version companion plugin so bootstrap preserves it offline
  const companionDir = join(homeOk, '.gemini', 'config', 'plugins', 'adlc-antigravity');
  mkdirSync(companionDir, { recursive: true });
  writeFileSync(join(companionDir, 'plugin.json'), JSON.stringify({ name: 'adlc-antigravity', version: '99.0.0', adlcContract: 1 }));

  // Create a stub agy binary that accepts --version and `plugin install <src>`
  const stubAgy = join(TMP, 'stub-agy-bootstrap.sh');
  writeFileSync(
    stubAgy,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "agy 2.0.0"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  SRC="$3"
  DEST="${homeOk}/.gemini/config/plugins/antigravity-booster"
  mkdir -p "$DEST"
  cp "$SRC/plugin.json" "$DEST/plugin.json"
  exit 0
fi
exit 0
`,
    { mode: 0o755 }
  );

  const prevExit = process.exitCode;
  try {
    process.exitCode = undefined;
    bootstrap({ home: homeOk, agyBin: stubAgy });
    assert.notEqual(process.exitCode, 1, 'bootstrap should succeed cleanly');
    const settings = JSON.parse(readFileSync(join(homeOk, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    assert.equal(settings.statusLine.stack_with_default, true);
    assert.match(settings.title.command, /statusline title$/);

    // Malformed settings.json emits warning and does NOT fail bootstrap
    const homeBad = join(TMP, 'home-bootstrap-bad');
    const badCompanion = join(homeBad, '.gemini', 'config', 'plugins', 'adlc-antigravity');
    mkdirSync(badCompanion, { recursive: true });
    writeFileSync(join(badCompanion, 'plugin.json'), JSON.stringify({ name: 'adlc-antigravity', version: '99.0.0', adlcContract: 1 }));
    mkdirSync(join(homeBad, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(homeBad, '.gemini', 'antigravity-cli', 'settings.json'), '{not-valid-json');

    const stubAgyBad = join(TMP, 'stub-agy-bootstrap-bad.sh');
    writeFileSync(
      stubAgyBad,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "agy 2.0.0"; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  SRC="$3"
  DEST="${homeBad}/.gemini/config/plugins/antigravity-booster"
  mkdir -p "$DEST"
  cp "$SRC/plugin.json" "$DEST/plugin.json"
  exit 0
fi
exit 0
`,
      { mode: 0o755 }
    );

    process.exitCode = undefined;
    bootstrap({ home: homeBad, agyBin: stubAgyBad });
    assert.notEqual(process.exitCode, 1, 'malformed settings.json must not fail bootstrap');
  } finally {
    process.exitCode = prevExit;
  }
});

test('preflight CLI hydrates quota from fresh agb_statusline_quota.json without spawning agy /quota when AGB_AGY_BIN is unset', () => {
  const repo = makeGitRepo('repo-preflight-cache');
  const poolsDir = join(TMP, 'pools-fastpath');
  mkdirSync(poolsDir, { recursive: true });
  const future = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(
    join(poolsDir, 'agb_statusline_quota.json'),
    JSON.stringify({
      updatedAt: Date.now(),
      quota: {
        gemini: { fiveHourRemainingPercent: 90, fiveHourResetTime: future, weeklyRemainingPercent: 90, weeklyResetTime: future },
        claude_gpt: { fiveHourRemainingPercent: 85, fiveHourResetTime: future, weeklyRemainingPercent: 85, weeklyResetTime: future },
        'claude-gpt': { fiveHourRemainingPercent: 85, fiveHourResetTime: future, weeklyRemainingPercent: 85, weeklyResetTime: future },
      },
    })
  );

  const planPath = join(repo, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      repo,
      gate: { test: 'npm test' },
      tickets: [
        {
          id: 'T-FAST-1',
          title: 'Add helper',
          body: 'Create src/fast.js exporting `export const fast = 1;` and verify with `npm test`.',
          scope: ['src/fast.js'],
          rails: ['src/base.js'],
          tier: 'cheap',
          pool_hint: 'gemini',
          edges: [],
        },
      ],
    }, null, 2)
  );

  // Place a fake `agy` on PATH that fails on `/quota` so preflight ONLY succeeds if statusline cache is honoured!
  const binDir = join(TMP, 'bin-no-quota');
  mkdirSync(binDir, { recursive: true });
  const pathAgy = join(binDir, 'agy');
  writeFileSync(
    pathAgy,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "/quota" ]; then
    echo "ERROR: /quota should have been bypassed by statusline cache" >&2
    exit 1
  fi
done
exec "${FAKE_AGY}" "$@"
`,
    { mode: 0o755 }
  );
  chmodSync(pathAgy, 0o755);

  const fakeState = join(TMP, 'preflight-state');
  mkdirSync(fakeState, { recursive: true });
  const env = {
    ...process.env,
    HOME: join(TMP, 'empty-home-preflight'),
    AGB_HOME_DIR: join(TMP, 'empty-home-preflight'),
    PATH: `${binDir}:${process.env.PATH}`,
    AGB_POOLS_DIR: poolsDir,
    FAKE_STATE_DIR: fakeState,
    ADLC_CLI_PATH: FAKE_ADLC,
    AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
  };
  delete env.AGB_AGY_BIN;

  const res = runAgb(['preflight', planPath], { env });
  assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
});

test('agb rescue exits 2 on non-zero interactive exit and exits 0 when rescued worktree passes P3/P5 and merges', () => {
  const repo = makeGitRepo('repo-cli-rescue');
  const ticket = {
    id: 'T-RES-1',
    title: 'Implement rescued module',
    body: 'Create src/rescued.js exporting `export const rescued = 42;` and verify with `npm test`.',
    scope: ['src/rescued.js'],
    rails: ['src/base.js'],
    tier: 'mid',
    pool_hint: 'gemini',
    edges: [],
  };
  const planPath = join(repo, 'rescue-plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      repo,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [ticket],
    }, null, 2)
  );
  execBin('git', ['-C', repo, 'add', 'rescue-plan.json']);
  execBin('git', ['-C', repo, 'commit', '-q', '-m', 'add plan']);

  const failAgy = join(TMP, 'fail-interactive-agy.sh');
  writeFileSync(
    failAgy,
    `#!/bin/sh
if [ "$1" = "-i" ]; then
  mkdir -p src
  printf 'export const partial = 1;\\n' > src/rescued.js
  exit 1
fi
exec "${FAKE_AGY}" "$@"
`,
    { mode: 0o755 }
  );

  const envBase = {
    ...process.env,
    FAKE_STATE_DIR: join(TMP, 'rescue-fake-state'),
    AGB_POOLS_DIR: join(TMP, 'rescue-pools'),
    ADLC_CLI_PATH: FAKE_ADLC,
    AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
    AGB_SANDBOX_GATES: '0',
  };
  mkdirSync(envBase.FAKE_STATE_DIR, { recursive: true });

  // 1. Failing interactive session -> exit 2, worktree preserved
  const resFail = runAgb(['rescue', 'T-RES-1', repo, '--plan', planPath], {
    env: { ...envBase, AGB_AGY_BIN: failAgy },
  });
  assert.equal(resFail.status, 2, `expected exit 2, got ${resFail.status}: ${resFail.stderr}`);
  const failPayload = JSON.parse(resFail.stdout);
  assert.equal(failPayload.ok, false);
  assert.equal(failPayload.merged, false);
  assert.ok(existsSync(join(repo, '.booster', 'rescue-locks', 't-res-1.json')), 'Rescue lock should be preserved');

  // 2. Continuing rescue with --continue -> fixes file, passes gates + prosecutor, merges to main -> exit 0
  const passAgy = join(TMP, 'pass-interactive-agy.sh');
  writeFileSync(
    passAgy,
    `#!/bin/sh
if [ "$1" = "-i" ]; then
  if [ ! -f src/rescued.js ]; then
    echo "expected preserved src/rescued.js from prior attempt" >&2
    exit 3
  fi
  printf 'export const rescued = 42;\\n' > src/rescued.js
  exit 0
fi
exec "${FAKE_AGY}" "$@"
`,
    { mode: 0o755 }
  );

  const resPass = runAgb(['rescue', 'T-RES-1', repo, '--continue', '--plan', planPath], {
    env: { ...envBase, AGB_AGY_BIN: passAgy },
  });
  assert.equal(resPass.status, 0, `expected exit 0, got ${resPass.status}\nstderr: ${resPass.stderr}\nstdout: ${resPass.stdout}`);
  const passPayload = JSON.parse(resPass.stdout);
  assert.equal(passPayload.ok, true);
  assert.equal(passPayload.merged, true);
  assert.equal(readFileSync(join(repo, 'src', 'rescued.js'), 'utf8'), 'export const rescued = 42;\n');
  assert.equal(existsSync(join(repo, '.booster', 'rescue-locks', 't-res-1.json')), false, 'Rescue lock cleared on merge');
});

test('agb run forwards --resume and --reset-rescue to scheduler', () => {
  const repo = makeGitRepo('repo-cli-resume');
  // Pre-merge T1 on main and record in report.json + run.json
  writeFileSync(join(repo, 'src', 't1.js'), 'export const t1 = 1;\n');
  execBin('git', ['-C', repo, 'add', 'src/t1.js']);
  execBin('git', ['-C', repo, 'commit', '-q', '-m', 'T1: add t1']);
  const t1Sha = execBin('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  mkdirSync(join(repo, '.booster', 'rescue-locks'), { recursive: true });
  writeFileSync(
    join(repo, '.booster', 'report.json'),
    JSON.stringify({ runId: 'r-prev', merged: ['T1'], failed: {} }, null, 2)
  );
  writeFileSync(
    join(repo, '.booster', 'run.json'),
    JSON.stringify({
      runId: 'r-prev',
      done: true,
      tickets: {
        T1: { phase: 'merged', mergeSha: t1Sha },
        T2: { phase: 'failed', error: 'prior failure' },
      },
    }, null, 2)
  );
  // Seed a stale rescue lock on T2
  writeFileSync(
    join(repo, '.booster', 'rescue-locks', 't2.json'),
    JSON.stringify({ ticketId: 'T2', state: 'preserved', updatedAt: new Date().toISOString() })
  );

  const planPath = join(repo, '.booster', 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      repo,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [
        {
          id: 'T1',
          title: 'Add t1',
          body: 'Create src/t1.js exporting t1.',
          scope: ['src/t1.js'],
          rails: ['src/base.js'],
          tier: 'cheap',
          pool_hint: 'gemini',
          edges: [{ to: 'T2' }],
        },
        {
          id: 'T2',
          title: 'Add t2',
          body: 'Create src/t2.js exporting t2.',
          scope: ['src/t2.js', 'T2.txt'],
          rails: ['src/base.js'],
          tier: 'cheap',
          pool_hint: 'gemini',
          edges: [],
        },
      ],
    }, null, 2)
  );

  const resumeBinDir = join(TMP, 'resume-bin');
  const resumeStateDir = join(TMP, 'resume-fake-state');
  mkdirSync(resumeBinDir, { recursive: true });
  mkdirSync(resumeStateDir, { recursive: true });
  const copiedFakeAgy = join(resumeBinDir, 'real-fake-agy');
  copyFileSync(FAKE_AGY, copiedFakeAgy);
  chmodSync(copiedFakeAgy, 0o755);

  const builderAgy = join(resumeBinDir, 'builder-resume-agy.sh');
  const invokedLog = join(resumeStateDir, 'builder-invoked.log');
  writeFileSync(
    builderAgy,
    `#!/bin/sh
if [ -n "$AGB_WORKER_TICKET" ]; then
  echo "$AGB_WORKER_TICKET" >> "${invokedLog}"
  mkdir -p src
  if [ "$AGB_WORKER_TICKET" = "T2" ]; then
    printf 'export const t2 = 2;\\n' > src/t2.js
  fi
fi
exec "${copiedFakeAgy}" "$@"
`,
    { mode: 0o755 }
  );

  const env = {
    ...process.env,
    AGB_AGY_BIN: builderAgy,
    FAKE_STATE_DIR: resumeStateDir,
    AGB_POOLS_DIR: join(TMP, 'resume-pools'),
    ADLC_CLI_PATH: FAKE_ADLC,
    AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
    AGB_SANDBOX_GATES: '0',
  };

  // 1. Without --reset-rescue, run refuses to clobber protected T2 rescue lock -> exit 1
  const blockedRes = runAgb(['run', planPath, '--resume'], { env });
  assert.equal(blockedRes.status, 1, `expected exit 1 when rescue lock protects T2, got ${blockedRes.status}: ${blockedRes.stderr}`);
  assert.match(blockedRes.stderr, /Refusing to clobber active or preserved rescue worktree.*--reset-rescue/i);

  // 2. With --resume --reset-rescue, skips T1 (already merged) and builds/merges only T2 -> exit 0
  const okRes = runAgb(['run', planPath, '--resume', '--reset-rescue'], { env });
  assert.equal(okRes.status, 0, `expected exit 0, got ${okRes.status}\nstderr: ${okRes.stderr}\nstdout: ${okRes.stdout}`);
  const okReport = JSON.parse(okRes.stdout);
  assert.deepEqual(okReport.merged, ['T1', 'T2']);
  const invokedTickets = readFileSync(invokedLog, 'utf8').trim().split('\n');
  assert.deepEqual(invokedTickets, ['T2'], 'Should skip already-merged T1 and only build T2');
  assert.equal(readFileSync(join(repo, 'src', 't2.js'), 'utf8'), 'export const t2 = 2;\n');
});

test('agb plan --estimate [--json] forecasts wave-by-wave quota burn offline without --force and mutates zero files', () => {
  const repo = makeGitRepo('repo-cli-estimate');
  const existingPlan = '{"handwritten":true}\n';
  writeFileSync(join(repo, 'plan.json'), existingPlan);
  const specPath = join(repo, 'feature-spec.md');
  writeFileSync(
    specPath,
    `# Estimate Spec

- **Gates**: test=\`npm test\`

### Ticket 1: \`T-EST-1\` — Core
- **Scope**: \`src/a.js\`
- **Rails**: \`src/base.js\`
- **Edges**: \`T-EST-1 -> T-EST-2\`
- **Tier**: \`frontier\`
- **Pool Hint**: \`gemini\`
- **Effort**: \`high\`
- **Objectives**:
  1. Build src/a.js.
- **Acceptance Criteria**:
  - Works. Verify: \`npm test\`

### Ticket 2: \`T-EST-2\` — Followup
- **Scope**: \`src/b.js\`
- **Rails**: \`src/base.js\`
- **Edges**: none
- **Tier**: \`mid\`
- **Pool Hint**: \`claude-gpt\`
- **Objectives**:
  1. Build src/b.js.
- **Acceptance Criteria**:
  - Works. Verify: \`npm test\`
`
  );

  const poolsDir = join(TMP, 'estimate-empty-pools');
  mkdirSync(poolsDir, { recursive: true });
  const env = {
    ...process.env,
    AGB_AGY_BIN: '/nonexistent/agy-should-never-be-spawned',
    AGB_POOLS_DIR: poolsDir,
  };

  // Run inside repo where plan.json ALREADY exists without passing --force
  const jsonRes = runAgb(['plan', specPath, repo, '--estimate', '--json'], { cwd: repo, env });
  assert.equal(jsonRes.status, 0, `expected exit 0, got ${jsonRes.status}: ${jsonRes.stderr}`);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.quotaEstimate.waves.length, 2);
  assert.equal(parsed.tickets.length, 2);
  assert.equal(parsed.tickets[0].effort, 'high');

  const textRes = runAgb(['plan', specPath, repo, '--estimate'], { cwd: repo, env });
  assert.equal(textRes.status, 0);
  assert.match(textRes.stdout, /Quota Runway Forecast/);
  assert.match(textRes.stdout, /Wave 1 \[T-EST-1\]/);

  // Zero side-effect writes: existing plan.json untouched, no ticket shards or pools state created
  assert.equal(readFileSync(join(repo, 'plan.json'), 'utf8'), existingPlan);
  assert.deepEqual(readdirSync(join(repo, '.adlc', 'tickets')), ['.store.json']);
  assert.equal(existsSync(join(poolsDir, 'agb_pools_v2.json')), false);
});

test('agb accept [--base --json --markdown] and agb watch [--mux / --mux=zellij] operate offline without mutating git refs', () => {
  const repo = makeGitRepo('repo-cli-accept-mux');
  const baseSha = execBin('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'src', 'caller.js'), 'import { base } from "./base.js";\nexport const v = base + 1;\n');
  writeFileSync(join(repo, 'src', 'base.js'), 'export const base = 2;\n');
  execBin('git', ['-C', repo, 'add', 'src/caller.js', 'src/base.js']);
  execBin('git', ['-C', repo, 'commit', '-q', '-m', 'candidate change']);
  const candSha = execBin('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const mdPath = join(repo, '.booster', 'pr-dossier.md');
  const acceptRes = runAgb(['accept', repo, '--base', baseSha, '--json', '--markdown', mdPath]);
  assert.equal(acceptRes.status, 0, acceptRes.stderr);
  const dossier = JSON.parse(acceptRes.stdout);
  assert.equal(dossier.ok, true);
  assert.equal(dossier.counts.filesChanged, 2);
  assert.equal(dossier.counts.totalHunks, 2);
  assert.ok(existsSync(mdPath));
  assert.match(readFileSync(mdPath, 'utf8'), /# ADLC P6 Sign-Off Evidence Dossier/);
  assert.equal(execBin('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), candSha);

  // Default non-TTY stdout renders Markdown dossier; invalid/missing flags exit 1
  const defaultMdRes = runAgb(['accept', repo, '--base', baseSha]);
  assert.equal(defaultMdRes.status, 0, defaultMdRes.stderr);
  assert.match(defaultMdRes.stdout, /# ADLC P6 Sign-Off Evidence Dossier/);
  assert.equal(runAgb(['accept', repo, '--base']).status, 1);
  assert.equal(runAgb(['accept', repo, '--bogus-flag']).status, 1);

  // Unsupported mux (zellij) must exit 1 cleanly
  const zellijRes = runAgb(['watch', repo, '--mux=zellij']);
  assert.equal(zellijRes.status, 1);
  assert.match(zellijRes.stderr, /Unsupported multiplexer 'zellij'/);

  // Bare --mux before [repo] must NOT consume [repo] as mux mode and must exit 0 on completed run.json
  mkdirSync(join(repo, '.booster'), { recursive: true });
  writeFileSync(
    join(repo, '.booster', 'run.json'),
    JSON.stringify({ runId: 'run-mux-done', startedAt: new Date().toISOString(), done: true, report: { merged: ['T1'], failed: {} } })
  );
  const muxAutoRes = runAgb(['watch', '--mux', repo, '--no-alerts'], {
    env: { ...process.env, TMUX: '', HERDR_ENV: '', HERDR_PANE_ID: '', CMUX_WORKSPACE_ID: '', CMUX_SOCKET_PATH: '' },
  });
  assert.equal(muxAutoRes.status, 0, muxAutoRes.stderr);
});

test('agb distill --compile-checks and agb holdout <list|run|clean> operate offline with sanitized outputs', async () => {
  const repo = makeGitRepo('repo-cli-w4');
  const holdoutRoot = join(TMP, 'cli-w4-holdouts');
  mkdirSync(holdoutRoot, { recursive: true });
  mkdirSync(join(repo, '.booster'), { recursive: true });
  writeFileSync(
    join(repo, '.booster', 'review-findings.json'),
    JSON.stringify({
      findings: [
        {
          lens: 'security',
          severity: 'high',
          claim: 'Hook emitted decision: "allow" on line 10',
        },
        {
          lens: 'security',
          severity: 'high',
          claim: 'Hook emitted decision: "allow" on line 22',
        },
      ],
    })
  );

  const distillRes = runAgb(['distill', repo, '--compile-checks', '--json']);
  assert.equal(distillRes.status, 0, distillRes.stderr);
  const distillParsed = JSON.parse(distillRes.stdout);
  assert.equal(distillParsed.ok, true);
  assert.equal(distillParsed.compiledChecks, true);
  assert.equal(distillParsed.compiledChecksCount, 1);
  assert.ok(existsSync(join(repo, '.adlc', 'learned-checks.json')));

  const { stageHoldoutScenarios } = await import('../lib/holdout.mjs');
  writeFileSync(join(repo, 'src', 'math.mjs'), 'export const double = (x) => x * 2;\n');
  const staged = stageHoldoutScenarios({
    repo,
    runId: 'run-cli',
    ticketId: 'T-1',
    scenarios: [
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { join } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        'test("Scenario: doubles positive numbers", async () => {',
        '  const m = await import(pathToFileURL(join(process.env.AGB_CANDIDATE_ROOT, "src/math.mjs")).href);',
        '  assert.equal(m.double(6), 12);',
        '});',
      ].join('\n'),
    ],
    holdoutRoot,
  });
  assert.equal(staged.ok, true);

  const env = { ...process.env, AGB_HOLDOUT_DIR: holdoutRoot, AGB_SANDBOX_GATES: '0' };
  const listRes = runAgb(['holdout', 'list', repo, '--json'], { env });
  assert.equal(listRes.status, 0, listRes.stderr);
  const listJson = JSON.parse(listRes.stdout);
  assert.equal(listJson.totalFiles, 1);
  assert.equal(listRes.stdout.includes('m.double'), false, 'agb holdout list must never leak holdout source');

  const runRes = runAgb(['holdout', 'run', repo, '--run-id', 'run-cli', '--ticket', 'T-1', '--json'], { env });
  assert.equal(runRes.status, 0, runRes.stderr);
  assert.equal(JSON.parse(runRes.stdout).ok, true);

  const cleanRes = runAgb(['holdout', 'clean', repo, '--run-id', 'run-cli', '--ticket', 'T-1', '--json'], { env });
  assert.equal(cleanRes.status, 0, cleanRes.stderr);
  assert.equal(JSON.parse(cleanRes.stdout).removed, true);
});


