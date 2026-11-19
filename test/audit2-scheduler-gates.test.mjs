import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runPlan,
  setupAttemptGitDatabase,
  reconcileIntegrationJournal,
  selectAlternateModel,
  buildSandboxCommandWrapper,
} from '../lib/scheduler.mjs';
import { currentBranch, isDirty } from '../lib/worktrees.mjs';
import { pluginManifestDir } from '../lib/adlc-bridge.mjs';
import { checkEnforcementAvailable } from '../lib/scheduler-verify.mjs';
import { snapshotRunIntegrity, verifyRunIntegrity } from '../lib/run-integrity.mjs';
import { reviewPlan } from '../lib/review.mjs';
import { ARL_FINDING_SCHEMA, ARBITER_TRIAGE_SCHEMA } from '../lib/schemas.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_audit2_${process.pid}.json`);

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const quiet = { log: () => {} };

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function makeTestRepo(prefix = 'agb-audit2-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(
    join(dir, '.gitignore'),
    '.worktrees/\n.booster/\n.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n' +
    '!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n!.adlc/config.json\n'
  );
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'sample.test.js'), 'console.log("ok");\n');
  g('add', '-A');
  g('commit', '-qm', 'init with tests');
  return dir;
}

function makeLoggingFakeBwrap(binDir, logFile) {
  const bwrapPath = join(binDir, 'bwrap');
  writeFileSync(
    bwrapPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${logFile}"
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
exec "$@"
`
  );
  chmodSync(bwrapPath, 0o755);
  return bwrapPath;
}

// --- 1. sanitizedGitEnv in worktrees & scheduler ---

test('sanitizedGitEnv: worktrees, setupAttemptGitDatabase, and reconcileIntegrationJournal ignore poisoned GIT_* env', async () => {
  const repo = makeTestRepo('agb-audit2-gitenv-');
  const decoyRepo = makeTestRepo('agb-audit2-decoy-');
  const wtDir = join(repo, '.worktrees', 'attempt-t1');
  mkdirSync(wtDir, { recursive: true });
  try {
    await withEnv(
      {
        GIT_DIR: join(decoyRepo, '.git'),
        GIT_WORK_TREE: decoyRepo,
        GIT_INDEX_FILE: join(decoyRepo, '.git', 'index'),
      },
      async () => {
        // worktrees.mjs git()
        assert.equal(currentBranch(repo), 'main');
        assert.equal(isDirty(repo), false);

        // scheduler.mjs setupAttemptGitDatabase()
        const { baseSha, gitDir } = setupAttemptGitDatabase(repo, wtDir, 'main');
        const expectedSha = execFileSync('git', ['rev-parse', 'main'], {
          cwd: repo,
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
        }).trim();
        assert.equal(baseSha, expectedSha, 'setupAttemptGitDatabase must resolve repo main, not decoy GIT_DIR');
        assert.ok(gitDir.startsWith(join(repo, '.worktrees', '.attempt_git')));

        // scheduler.mjs reconcileIntegrationJournal()
        const rec = await reconcileIntegrationJournal(repo, 'main');
        assert.equal(rec.ok, true);
        assert.equal(rec.status, 'clean');
      }
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(decoyRepo, { recursive: true, force: true });
  }
});

// --- 2. selectAlternateModel cross-family preference ---

test('selectAlternateModel: crossPool prefers different upstream family before falling back to different local pool', () => {
  const poolOfFn = (m) => ({
    'gemini-3.1-pro-high': 'gemini_pro',
    'gemini-3-flash': 'gemini_flash',
    'claude-sonnet-4-6': 'claude_gpt',
    'gpt-oss-120b': 'claude_gpt',
  }[m] ?? 'unknown');

  const upstreamPoolOfFn = (m) => ({
    'gemini-3.1-pro-high': 'gemini',
    'gemini-3-flash': 'gemini',
    'claude-sonnet-4-6': 'claude_gpt',
    'gpt-oss-120b': 'claude_gpt',
  }[m] ?? 'unknown');

  const candidates = ['gemini-3.1-pro-high', 'gemini-3-flash', 'claude-sonnet-4-6'];

  // Even though gemini-3-flash has a different local pool and appears earlier,
  // crossPool must pick claude-sonnet-4-6 because it is in a different upstream family.
  const crossFam = selectAlternateModel(candidates, 'gemini-3.1-pro-high', {
    crossPool: true,
    poolOfFn,
    upstreamPoolOfFn,
    caps: { gemini_pro: 1, gemini_flash: 1, claude_gpt: 1 },
    familyCap: () => 1,
  });
  assert.equal(crossFam, 'claude-sonnet-4-6');

  // When cross-family has 0 cap, fall back to different local pool in same family.
  const fallbackLocal = selectAlternateModel(candidates, 'gemini-3.1-pro-high', {
    crossPool: true,
    poolOfFn,
    upstreamPoolOfFn,
    caps: { gemini_pro: 1, gemini_flash: 1, claude_gpt: 0 },
    familyCap: (fam) => (fam === 'claude_gpt' ? 0 : 1),
  });
  assert.equal(fallbackLocal, 'gemini-3-flash');

  // When crossPool is false, pick first eligible non-current candidate regardless of family.
  const sameFam = selectAlternateModel(candidates, 'gemini-3.1-pro-high', {
    crossPool: false,
    poolOfFn,
    upstreamPoolOfFn,
    caps: { gemini_pro: 1, gemini_flash: 1, claude_gpt: 1 },
    familyCap: () => 1,
  });
  assert.equal(sameFam, 'gemini-3-flash');
});

// --- 3. Pass 2 adlc hollow-test outer OS sandboxing ---

test('buildSandboxCommandWrapper: wraps command directly in OS sandbox and fails closed without sandbox', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'agb-audit2-wt-'));
  const sbxDir = mkdtempSync(join(tmpdir(), 'agb-audit2-sbx-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-audit2-bin-'));
  try {
    makeLoggingFakeBwrap(binDir, join(sbxDir, 'bwrap.log'));
    const envWithBwrap = { PATH: `${binDir}:${process.env.PATH}` };

    const linuxRes = buildSandboxCommandWrapper(worktree, {
      env: envWithBwrap,
      plat: 'linux',
      sandboxTmpDir: sbxDir,
    });
    assert.equal(linuxRes.ok, true);
    const wrappedLinux = linuxRes.wrap({ command: '/usr/bin/adlc', args: ['hollow-test', '--test-cmd', 'npm test'] });
    assert.equal(wrappedLinux.command, 'bwrap');
    assert.ok(wrappedLinux.args.includes('--unshare-net'));
    const sepIdx = wrappedLinux.args.lastIndexOf('--');
    assert.deepEqual(wrappedLinux.args.slice(sepIdx + 1), ['/usr/bin/adlc', 'hollow-test', '--test-cmd', 'npm test']);

    const darwinRes = buildSandboxCommandWrapper(worktree, {
      env: envWithBwrap,
      plat: 'darwin',
      sandboxTmpDir: sbxDir,
    });
    assert.equal(darwinRes.ok, true);
    const wrappedDarwin = darwinRes.wrap({ command: '/usr/bin/adlc', args: ['hollow-test', '--test-cmd', 'npm test'] });
    assert.equal(wrappedDarwin.command, 'sandbox-exec');
    assert.equal(wrappedDarwin.args[0], '-f');
    assert.match(wrappedDarwin.args[1], /gate\.sb$/);
    assert.deepEqual(wrappedDarwin.args.slice(2), ['/usr/bin/adlc', 'hollow-test', '--test-cmd', 'npm test']);

    const disabled = buildSandboxCommandWrapper(worktree, {
      env: { ...envWithBwrap, AGB_SANDBOX_GATES: '0' },
      plat: 'linux',
      sandboxTmpDir: sbxDir,
    });
    assert.equal(disabled.ok, true);
    const passthrough = disabled.wrap({ command: '/usr/bin/adlc', args: ['hollow-test'] });
    assert.deepEqual(passthrough, { command: '/usr/bin/adlc', args: ['hollow-test'] });

    const noDir = buildSandboxCommandWrapper(worktree, { env: envWithBwrap, plat: 'linux' });
    assert.equal(noDir.ok, false);
    assert.match(noDir.error, /gate sandbox unavailable/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(sbxDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('scheduler: Pass 2 executes adlc hollow-test itself inside outer OS sandbox without nested bwrap', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('fake-bwrap invocation check runs on Linux');
    return;
  }
  const repo = makeTestRepo('agb-audit2-ht-');
  const state = mkdtempSync(join(tmpdir(), 'agb-audit2-ht-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-audit2-ht-bin-'));
  const bwrapLog = join(state, 'bwrap.log');
  const beforeSbxDirs = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('agb-ht-sbx-')));
  try {
    makeLoggingFakeBwrap(binDir, bwrapLog);
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
        FAKE_BUILDER_MODE: 'mod-test',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: undefined,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      () => runPlan({
        repo,
        gate: { test: 'node test/sample.test.js' },
        tickets: [{ id: 'T1', title: 'mod test', body: 'modify test', scope: ['test/sample.test.js'] }],
      }, quiet)
    );

    assert.deepEqual(report.merged, ['T1']);
    const bwrapCalls = readFileSync(bwrapLog, 'utf8');
    assert.match(bwrapCalls, /--unshare-net.*-- .*fake-adlc hollow-test --test-cmd node test\/sample\.test\.js --base /);

    // Ensure hollow-test received the raw test command (no nested bwrap)
    const htLog = readFileSync(join(state, 'hollow-test-invocations'), 'utf8');
    assert.match(htLog, /^test-cmd=node test\/sample\.test\.js base=/);

    const afterSbxDirs = readdirSync(tmpdir()).filter((n) => n.startsWith('agb-ht-sbx-') && !beforeSbxDirs.has(n));
    assert.deepEqual(afterSbxDirs, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

// --- 4. AGB_HOME_DIR gated on !bundled ---

test('AGB_HOME_DIR is ignored in bundled mode across pluginManifestDir, checkEnforcementAvailable, and run-integrity', () => {
  const spoofHome = mkdtempSync(join(tmpdir(), 'agb-audit2-home-'));
  const repo = makeTestRepo('agb-audit2-home-repo-');
  try {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    const spoofPluginDir = join(spoofHome, '.gemini', 'config', 'plugins', 'adlc-antigravity');
    mkdirSync(spoofPluginDir, { recursive: true });
    writeFileSync(join(spoofPluginDir, 'plugin.json'), JSON.stringify({ name: 'adlc-antigravity', version: '1.4.0', adlcContract: 1 }));

    // pluginManifestDir
    assert.equal(
      pluginManifestDir({ env: { AGB_HOME_DIR: spoofHome }, bundled: false }),
      spoofPluginDir
    );
    assert.equal(
      pluginManifestDir({ env: { AGB_HOME_DIR: spoofHome }, bundled: true }),
      join(homedir(), '.gemini', 'config', 'plugins', 'adlc-antigravity')
    );

    // checkEnforcementAvailable (also verifies bundled-before-home parameter order doesn't throw)
    const unbundledRes = checkEnforcementAvailable(repo, { env: { AGB_HOME_DIR: spoofHome }, bundled: false });
    assert.equal(unbundledRes.available, true);

    const bundledRes = checkEnforcementAvailable(repo, { env: { AGB_HOME_DIR: spoofHome }, bundled: true });
    const realHomeRes = checkEnforcementAvailable(repo, { env: {}, bundled: true });
    assert.deepEqual(bundledRes, realHomeRes, 'bundled mode must resolve against real homedir, not AGB_HOME_DIR');

    // snapshotRunIntegrity & verifyRunIntegrity
    const snapUnbundled = snapshotRunIntegrity({ cwd: repo, env: { AGB_HOME_DIR: spoofHome }, bundled: false });
    assert.equal(snapUnbundled.ok, true);
    assert.notEqual(snapUnbundled.snapshot.plugins['adlc-antigravity'], 'absent');

    const snapBundled = snapshotRunIntegrity({ cwd: repo, env: { AGB_HOME_DIR: spoofHome }, bundled: true });
    const snapRealHome = snapshotRunIntegrity({ cwd: repo, env: {}, bundled: true });
    assert.equal(snapBundled.ok, true);
    assert.deepEqual(snapBundled.snapshot, snapRealHome.snapshot);

    // Tampering spoofHome must not affect bundled verifyRunIntegrity
    writeFileSync(join(spoofPluginDir, 'extra.txt'), 'tamper');
    const verBundled = verifyRunIntegrity(snapBundled.snapshot, { cwd: repo, env: { AGB_HOME_DIR: spoofHome }, bundled: true });
    assert.equal(verBundled.ok, true);
    const verUnbundled = verifyRunIntegrity(snapUnbundled.snapshot, { cwd: repo, env: { AGB_HOME_DIR: spoofHome }, bundled: false });
    assert.equal(verUnbundled.ok, false);
  } finally {
    rmSync(spoofHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- 5. reviewPlan propagates arbiterDegraded & arbiterError ---

test('reviewPlan propagates arbiterDegraded and arbiterError when LLM arbiter fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-audit2-review-'));
  const fakeAgy = join(dir, 'fake-agy-degraded');
  // Return valid JSON for lens calls, fail on arbiter prompt
  writeFileSync(
    fakeAgy,
    `#!/bin/sh
args="$*"
case "$args" in
  *arbiter*|*Arbiter*|*triage*|*Triage*)
    echo "simulated arbiter outage" >&2
    exit 1
    ;;
  *)
    echo '{"findings":[{"id":"F1","severity":"high","file":"spec.md","line":12,"claim":"Missing rollback plan","evidence":"Section 2 omits rollback","resolution_route":"auto-fix"}]}'
    exit 0
    ;;
esac
`
  );
  chmodSync(fakeAgy, 0o755);

  const specPath = join(dir, 'spec.md');
  writeFileSync(
    specPath,
    '# Feature Spec\n\n## Tickets\n- T1: Add widget\n  - scope: lib/widget.mjs\n  - acceptance: widget exports foo\n'
  );

  try {
    const res = await withEnv({ AGB_AGY_BIN: fakeAgy }, () =>
      reviewPlan({
        specPath,
        repo: dir,
        lenses: ['devils-advocate'],
        arbiter: true,
        loop: false,
      })
    );

    assert.equal(res.arbiterDegraded, true);
    assert.equal(typeof res.arbiterError, 'string');
    assert.ok(res.arbiterError.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6. ARL_FINDING_SCHEMA & ARBITER_TRIAGE_SCHEMA line type ---

test('ARL_FINDING_SCHEMA and ARBITER_TRIAGE_SCHEMA allow string or integer for line', () => {
  assert.deepEqual(
    ARL_FINDING_SCHEMA.properties.findings.items.properties.line,
    { type: ['string', 'integer'] }
  );
  assert.deepEqual(
    ARBITER_TRIAGE_SCHEMA.properties.triaged.items.properties.line,
    { type: ['string', 'integer'] }
  );
});
