import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveSidecar } from '../sidecars/server.mjs';
import { runPlan, wrapConsensusGateCommand } from '../lib/scheduler.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), `agb_pools_audit_sched_sidecar_${process.pid}.json`);

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const JETSKI_LAUNCHER = fileURLToPath(new URL('../sidecars/jetski-launcher.mjs', import.meta.url));

function fetchP(url, headers = {}) {
  return new Promise((resolve, reject) => {
    request(url, { agent: false, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, data, headers: res.headers }));
    }).on('error', reject).end();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function makeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-audit-ht-'));
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

function makeFakeBwrap(binDir, { removeAfterGateCalls = 0, countFile = '', logFile = '' } = {}) {
  const bwrapPath = join(binDir, 'bwrap');
  const logLine = logFile ? `printf '%s\\n' "$*" >> "${logFile}"\n` : '';
  const selfRemove = removeAfterGateCalls > 0
    ? `
if [ "$1" = "/bin/sh" ]; then
  n=$(cat "${countFile}" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "${countFile}"
  if [ "$n" -ge ${removeAfterGateCalls} ]; then
    rm -f "$bwrap_self"
  fi
fi
`
    : '';
  writeFileSync(
    bwrapPath,
    `#!/bin/sh
bwrap_self="$0"
${logLine}while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
${selfRemove}
exec "$@"
`
  );
  chmodSync(bwrapPath, 0o755);
  return bwrapPath;
}

const quiet = { log: () => {} };

// --- Sidecar token enforcement tests ---

test('sidecar: explicit token is enforced on / and /events even when ANTIGRAVITY_SIDECAR_WEB_PORT is set', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-audit-sidecar-'));
  try {
    await withEnv({ ANTIGRAVITY_SIDECAR_WEB_PORT: '4321' }, async () => {
      const srv = await serveSidecar(repo, 0, 'secret');
      try {
        const port = srv.address().port;

        // Missing or wrong token must return 403 on /, /index.html, and /events
        assert.equal((await fetchP(`http://127.0.0.1:${port}/`)).statusCode, 403);
        assert.equal((await fetchP(`http://127.0.0.1:${port}/index.html`)).statusCode, 403);
        assert.equal((await fetchP(`http://127.0.0.1:${port}/?token=wrong`)).statusCode, 403);
        assert.equal((await fetchP(`http://127.0.0.1:${port}/events`)).statusCode, 403);
        assert.equal((await fetchP(`http://127.0.0.1:${port}/events?token=wrong`)).statusCode, 403);
        assert.equal(
          (await fetchP(`http://127.0.0.1:${port}/events`, { Authorization: 'Bearer wrong' })).statusCode,
          403
        );

        // Valid token must return 200
        assert.equal((await fetchP(`http://127.0.0.1:${port}/?token=secret`)).statusCode, 200);
        assert.equal((await fetchP(`http://127.0.0.1:${port}/index.html?token=secret`)).statusCode, 200);
        assert.equal((await fetchP(`http://127.0.0.1:${port}/events?token=secret`)).statusCode, 200);
        assert.equal(
          (await fetchP(`http://127.0.0.1:${port}/events`, { Authorization: 'Bearer secret' })).statusCode,
          200
        );
      } finally {
        srv.close();
      }
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('jetski-launcher: skips token generation and passes null token when ANTIGRAVITY_SIDECAR_WEB_PORT is set', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-audit-jetski-'));
  const port = await getFreePort();
  const child = spawn(process.execPath, [JETSKI_LAUNCHER, repo], {
    env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`jetski-launcher timed out; output=${out}`)), 5000);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        if (out.includes(`http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`jetski-launcher exited early with code ${code}; output=${out}`));
      });
    });

    assert.equal(existsSync(join(repo, '.booster', 'token')), false, 'must not write .booster/token in Jetski mode');
    assert.equal((await fetchP(`http://127.0.0.1:${port}/`)).statusCode, 200);
    assert.equal((await fetchP(`http://127.0.0.1:${port}/events`)).statusCode, 200);
  } finally {
    child.kill('SIGTERM');
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- Scheduler Pass 2 hollow-test sandboxing tests ---

test('scheduler: wrapConsensusGateCommand wraps gate.test for hollow-test and fails closed without sandbox', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'agb-audit-wt-'));
  const sbxDir = mkdtempSync(join(tmpdir(), 'agb-audit-sbx-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-audit-bin-'));
  try {
    makeFakeBwrap(binDir);
    const envWithBwrap = { PATH: `${binDir}:${process.env.PATH}` };

    const wrappedLinux = wrapConsensusGateCommand('node test/sample.test.js', worktree, {
      env: envWithBwrap,
      plat: 'linux',
      sandboxTmpDir: sbxDir,
    });
    assert.equal(wrappedLinux.ok, true);
    assert.match(wrappedLinux.cmd, /^'bwrap' '--unshare-net'.*'--' '\/bin\/sh' '-c' 'node test\/sample\.test\.js'$/);

    const wrappedDarwin = wrapConsensusGateCommand('node test/sample.test.js', worktree, {
      env: envWithBwrap,
      plat: 'darwin',
      sandboxTmpDir: sbxDir,
    });
    assert.equal(wrappedDarwin.ok, true);
    assert.match(wrappedDarwin.cmd, /^'sandbox-exec' '-f' '.*\/gate\.sb' '\/bin\/sh' '-c' 'node test\/sample\.test\.js'$/);

    const disabled = wrapConsensusGateCommand('node test/sample.test.js', worktree, {
      env: { ...envWithBwrap, AGB_SANDBOX_GATES: '0' },
      sandboxTmpDir: sbxDir,
    });
    assert.deepEqual(disabled, { ok: true, cmd: 'node test/sample.test.js' });

    const noSbxDir = wrapConsensusGateCommand('node test/sample.test.js', worktree, {
      env: envWithBwrap,
      plat: 'linux',
    });
    assert.equal(noSbxDir.ok, false);
    assert.match(noSbxDir.error, /gate sandbox unavailable/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(sbxDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('wrapConsensusGateCommand: fails closed on Linux when bwrap is not on PATH', (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux bwrap PATH probe only runs on Linux');
    return;
  }
  const worktree = mkdtempSync(join(tmpdir(), 'agb-audit-wt-'));
  const sbxDir = mkdtempSync(join(tmpdir(), 'agb-audit-sbx-'));
  try {
    const noSandbox = wrapConsensusGateCommand('node test/sample.test.js', worktree, {
      env: { PATH: '/nonexistent' },
      plat: 'linux',
      sandboxTmpDir: sbxDir,
    });
    assert.equal(noSandbox.ok, false);
    assert.match(noSandbox.error, /gate sandbox unavailable/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(sbxDir, { recursive: true, force: true });
  }
});

test('scheduler: Pass 2 hollow-test runs sandboxed when AGB_SANDBOX_GATES !== "0" and cleans up temp dir', async () => {
  const repo = makeTestRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-audit-ht-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-audit-ht-bin-'));
  const isolatedTmp = mkdtempSync(join(tmpdir(), 'agb-audit-ht-tmp-'));
  const bwrapLog = join(state, 'bwrap-invocations.log');
  try {
    if (process.platform === 'linux') {
      makeFakeBwrap(binDir, { logFile: bwrapLog });
    }

    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
        FAKE_BUILDER_MODE: 'mod-test',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: undefined,
        TMPDIR: isolatedTmp,
        TMP: isolatedTmp,
        TEMP: isolatedTmp,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      () => runPlan({
        repo,
        gate: { test: 'node test/sample.test.js' },
        tickets: [{ id: 'T1', title: 'mod test', body: 'modify test', scope: ['test/sample.test.js'] }],
      }, quiet)
    );

    assert.deepEqual(report.merged, ['T1']);

    // Verify hollow-test received a sandbox-wrapped --test-cmd (adlc itself runs outside so gitDir inflight record stays writable)
    const htLog = readFileSync(join(state, 'hollow-test-invocations'), 'utf8');
    if (process.platform === 'linux') {
      assert.match(htLog, /test-cmd='?bwrap'? .*--unshare-net.*agb-ht-sbx-.*node test\/sample\.test\.js/);
      assert.ok(htLog.includes(isolatedTmp), 'sandbox temp dir must be created inside isolated TMPDIR');
    } else if (process.platform === 'darwin') {
      assert.match(htLog, /test-cmd='?sandbox-exec'? .*agb-ht-sbx-.*node test\/sample\.test\.js/);
      assert.ok(htLog.includes(isolatedTmp), 'sandbox temp dir must be created inside isolated TMPDIR');
    } else {
      assert.match(htLog, /node test\/sample\.test\.js/);
    }

    // Verify no agb-ht-sbx-* temp directories were leaked inside the isolated temp root
    const leakedSbxDirs = readdirSync(isolatedTmp).filter((n) => n.startsWith('agb-ht-sbx-'));
    assert.deepEqual(leakedSbxDirs, [], 'hollow-test sandbox temp dir must be cleaned up');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

test('scheduler: Pass 2 hollow-test fails closed when OS sandbox is unavailable and AGB_SANDBOX_GATES !== "0"', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('bwrap availability toggle applies to Linux');
    return;
  }

  const repo = makeTestRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-audit-ht-fc-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'agb-audit-ht-fc-bin-'));
  const shimDir = mkdtempSync(join(tmpdir(), 'agb-audit-ht-shim-'));
  const isolatedTmp = mkdtempSync(join(tmpdir(), 'agb-audit-ht-fc-tmp-'));
  try {
    const countFile = join(state, 'bwrap-count');
    // Builder gating (1) + merge Pass 1 (2) + merge Pass 2 (3) invoke bwrap with /bin/sh;
    // removing bwrap on gate call 3 makes it unavailable right before Pass 2 hollow-test.
    makeFakeBwrap(binDir, { removeAfterGateCalls: 3, countFile });

    // Build a PATH with our fake bwrap + standard tools WITHOUT any host /usr/bin/bwrap.
    for (const tool of [
      'git', 'node', 'sh', 'which', 'true', 'cat', 'rm', 'mkdir', 'sed', 'awk',
      'grep', 'sort', 'tr', 'cut', 'basename', 'dirname', 'cp', 'find', 'pgrep', 'env',
    ]) {
      try {
        const resolved = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
        if (resolved) {
          writeFileSync(join(shimDir, tool), `#!/bin/sh\nexec "${resolved}" "$@"\n`);
          chmodSync(join(shimDir, tool), 0o755);
        }
      } catch {}
    }

    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
        FAKE_BUILDER_MODE: 'mod-test',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: undefined,
        TMPDIR: isolatedTmp,
        TMP: isolatedTmp,
        TEMP: isolatedTmp,
        PATH: `${binDir}:${shimDir}`,
      },
      () => runPlan({
        repo,
        gate: { test: 'node test/sample.test.js' },
        tickets: [{ id: 'T1', title: 'mod test', body: 'modify test', scope: ['test/sample.test.js'] }],
      }, quiet)
    );

    assert.equal(report.merged.length, 0, 'ticket must not merge when hollow-test sandbox is unavailable');
    assert.match(report.failed.T1, /hollow-test mutation verification failed: gate sandbox unavailable/);
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'HEAD must remain unchanged on fail-closed rollback');

    // Verify sandbox temp dir is cleaned up inside isolated TMPDIR even on fail-closed error
    const leakedSbxDirs = readdirSync(isolatedTmp).filter((n) => n.startsWith('agb-ht-sbx-'));
    assert.deepEqual(leakedSbxDirs, [], 'hollow-test sandbox temp dir must be cleaned up on failure');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
});
