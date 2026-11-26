// Unit and integration tests for hooks/session-start.mjs (T-NG-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SRC = join(ROOT, 'hooks', 'session-start.mjs');
const LAUNCHER_SRC = join(ROOT, 'bin', 'node-launcher.sh');

function makeCleanPluginFixture({ version = '2.0.0', bootstrapScript = '' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'agb-session-start-'));
  const pluginRoot = join(base, 'clean-plugin');
  const pluginData = join(base, 'plugin-data');
  const homeDir = join(base, 'home');

  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  copyFileSync(HOOK_SRC, join(pluginRoot, 'hooks', 'session-start.mjs'));
  copyFileSync(LAUNCHER_SRC, join(pluginRoot, 'bin', 'node-launcher.sh'));
  chmodSync(join(pluginRoot, 'bin', 'node-launcher.sh'), 0o755);

  writeFileSync(
    join(pluginRoot, 'package.json'),
    JSON.stringify({ name: 'antigravity-booster', version, type: 'module' }, null, 2) + '\n',
  );
  writeFileSync(
    join(pluginRoot, 'dist', 'agb.mjs'),
    bootstrapScript || 'process.exit(0);\n',
  );

  return {
    base,
    pluginRoot,
    pluginData,
    homeDir,
    hookFile: join(pluginRoot, 'hooks', 'session-start.mjs'),
    launcherFile: join(pluginRoot, 'bin', 'node-launcher.sh'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function cleanHookEnv(fx, overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: fx.homeDir,
    PLUGIN_ROOT: fx.pluginRoot,
    PLUGIN_DATA: fx.pluginData,
  };
  return { ...env, ...overrides };
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

test('session-start: static hygiene — zero external/lib imports and only approved env tokens', () => {
  const src = readFileSync(HOOK_SRC, 'utf8');
  const imports = [...src.matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const spec of imports) {
    assert.match(spec, /^node:(?:fs|path|os|child_process|url)$/, `disallowed import in session-start.mjs: ${spec}`);
  }

  const envTokenRe = /\b(?:(?:AGB|ADLC|ANTIGRAVITY)_[A-Z0-9_]+|PLUGIN_ROOT|AGY_BIN)\b/g;
  const tokens = new Set([...src.matchAll(envTokenRe)].map((m) => m[0]));
  const allowed = new Set(['PLUGIN_ROOT', 'AGB_SKIP_SESSION_BOOTSTRAP', 'AGB_WORKER_TICKET', 'AGB_WORKER_MODE']);
  for (const t of tokens) {
    assert.ok(allowed.has(t), `unexpected scanned env token in hooks/session-start.mjs: ${t}`);
  }
});

test('session-start: clean clone without node_modules runs via bin/node-launcher.sh, emits injectSteps once, and writes bootstrap stamp', async () => {
  const countFile = 'bootstrap-invocations.log';
  const fx = makeCleanPluginFixture({
    version: '2.0.0',
    bootstrapScript: `
      import { appendFileSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = join(dirname(fileURLToPath(import.meta.url)), '..');
      if (process.argv[2] === 'bootstrap') {
        appendFileSync(join(root, '${countFile}'), 'ran\\n');
      }
    `,
  });
  try {
    assert.equal(existsSync(join(fx.pluginRoot, 'node_modules')), false);

    // Run via /bin/sh bin/node-launcher.sh hooks/session-start.mjs (exact hooks.json command).
    // Preserve host HOME so bin/node-launcher.sh trusts version-manager Node installations (fnm/mise/nvm),
    // while PLUGIN_ROOT and PLUGIN_DATA confine all hook reads/writes to the isolated temp fixture.
    const launcherEnv = cleanHookEnv(fx, { HOME: process.env.HOME || fx.homeDir });
    const first = spawnSync('/bin/sh', ['bin/node-launcher.sh', 'hooks/session-start.mjs'], {
      cwd: fx.pluginRoot,
      input: '{"sessionId":"sess-1"}\n',
      encoding: 'utf8',
      env: launcherEnv,
      timeout: 10_000,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout.trim()), {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: '',
            metadata: {
              user_markdown: '> **AGB:** Running one-time background bootstrap...',
            },
          },
        },
      ],
    });

    const stampPath = join(fx.pluginData, 'bootstrapped-2.0.0.json');
    const lockPath = join(fx.pluginData, 'session-bootstrap.lock');
    const stamped = await waitFor(() => existsSync(stampPath) && !existsSync(lockPath));
    assert.equal(stamped, true, 'expected detached worker to write stamp and remove lock');

    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    assert.equal(stamp.version, '2.0.0');
    assert.equal(typeof stamp.bootstrappedAt, 'string');
    assert.equal(typeof stamp.pid, 'number');
    if (process.platform !== 'win32') {
      assert.equal(statSync(stampPath).mode & 0o777, 0o600);
      assert.equal(statSync(fx.pluginData).mode & 0o777, 0o700);
    }
    assert.equal(readFileSync(join(fx.pluginRoot, countFile), 'utf8').trim().split('\n').length, 1);

    // Second invocation sees stamp and exits immediately with '{}'
    const second = spawnSync('/bin/sh', ['bin/node-launcher.sh', 'hooks/session-start.mjs'], {
      cwd: fx.pluginRoot,
      input: '{}\n',
      encoding: 'utf8',
      env: launcherEnv,
      timeout: 10_000,
    });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '{}\n');

    // Also verify default pluginDataDir fallback (<HOME>/.gemini/antigravity-cli/plugin_data/antigravity-booster) when PLUGIN_DATA is unset
    const fallbackStampDir = join(fx.homeDir, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
    const fallbackFirst = spawnSync(process.execPath, [fx.hookFile], {
      cwd: fx.pluginRoot,
      input: '{}\n',
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: fx.homeDir, PLUGIN_ROOT: fx.pluginRoot },
      timeout: 10_000,
    });
    assert.equal(fallbackFirst.status, 0);
    assert.ok(JSON.parse(fallbackFirst.stdout.trim()).injectSteps);
    const fallbackStamped = await waitFor(() => existsSync(join(fallbackStampDir, 'bootstrapped-2.0.0.json')));
    assert.equal(fallbackStamped, true, 'expected fallback homedir plugin_data stamp');
  } finally {
    fx.cleanup();
  }
});

test('session-start: normal mode fast-paths on AGB_SKIP_SESSION_BOOTSTRAP=1, worker env vars, and live lock', () => {
  const fx = makeCleanPluginFixture({
    version: '2.0.0',
    bootstrapScript: `
      import { writeFileSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { fileURLToPath } from 'node:url';
      writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'unexpected-run'), '1');
    `,
  });
  try {
    for (const envOverride of [
      { AGB_SKIP_SESSION_BOOTSTRAP: '1' },
      { AGB_WORKER_TICKET: 'T-NG-1' },
      { AGB_WORKER_MODE: 'readonly' },
    ]) {
      const res = spawnSync(process.execPath, [fx.hookFile], {
        input: '{}\n',
        encoding: 'utf8',
        env: cleanHookEnv(fx, envOverride),
        timeout: 5_000,
      });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '{}\n', JSON.stringify(envOverride));
    }

    // Live lock in pluginData causes normal mode to return '{}' without spawning
    mkdirSync(fx.pluginData, { recursive: true });
    const lockPath = join(fx.pluginData, 'session-bootstrap.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n');

    const liveRes = spawnSync(process.execPath, [fx.hookFile], {
      input: '{}\n',
      encoding: 'utf8',
      env: cleanHookEnv(fx),
      timeout: 5_000,
    });
    assert.equal(liveRes.status, 0);
    assert.equal(liveRes.stdout, '{}\n');
    assert.equal(existsSync(join(fx.pluginRoot, 'unexpected-run')), false);
  } finally {
    fx.cleanup();
  }
});

test('session-start: --worker lock contention, stale/dead lock recovery, exit-0-only stamp writing, and symlink rejection', async () => {
  const logFile = 'worker-runs.log';
  const fx = makeCleanPluginFixture({
    version: '2.0.0',
    bootstrapScript: `
      import { appendFileSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = join(dirname(fileURLToPath(import.meta.url)), '..');
      if (process.env.FAIL_BOOTSTRAP === '1') {
        appendFileSync(join(root, '${logFile}'), 'failed\\n');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 150));
      appendFileSync(join(root, '${logFile}'), 'ok\\n');
    `,
  });

  try {
    mkdirSync(fx.pluginData, { recursive: true, mode: 0o700 });
    const lockPath = join(fx.pluginData, 'session-bootstrap.lock');
    const stampPath = join(fx.pluginData, 'bootstrapped-2.0.0.json');

    // 1. Live lock holder -> worker exits 0 immediately without touching lock or running bootstrap
    const livePayload = JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n';
    writeFileSync(lockPath, livePayload);
    const contended = spawnSync(
      process.execPath,
      [fx.hookFile, '--worker', fx.pluginRoot, fx.pluginData, '2.0.0'],
      { encoding: 'utf8', env: cleanHookEnv(fx), timeout: 5_000 },
    );
    assert.equal(contended.status, 0);
    assert.equal(existsSync(stampPath), false);
    assert.equal(existsSync(lockPath), true, 'must not unlink live holder lock');
    assert.equal(existsSync(join(fx.pluginRoot, logFile)), false);

    // 2. Failed bootstrap (exit 1) after reclaiming stale lock (> 300_000ms old) -> exits 0, removes lock, writes NO stamp
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - 305_000 }) + '\n');
    const failedRun = spawnSync(
      process.execPath,
      [fx.hookFile, '--worker', fx.pluginRoot, fx.pluginData, '2.0.0'],
      { encoding: 'utf8', env: cleanHookEnv(fx, { FAIL_BOOTSTRAP: '1' }), timeout: 5_000 },
    );
    assert.equal(failedRun.status, 0, 'worker must never fail noisily');
    assert.equal(existsSync(stampPath), false, 'stamp must NOT be written when bootstrap fails');
    assert.equal(existsSync(lockPath), false, 'lock must be unlinked in finally');

    // 3. Dead PID lock reclamation + parallel worker race -> exactly 1 bootstrap execution
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, ts: Date.now() }) + '\n');
    const children = Array.from({ length: 4 }, () =>
      new Promise((resolveChild) => {
        const c = spawn(
          process.execPath,
          [fx.hookFile, '--worker', fx.pluginRoot, fx.pluginData, '2.0.0'],
          { env: cleanHookEnv(fx), stdio: 'ignore' },
        );
        c.on('exit', (code) => resolveChild(code));
      }),
    );
    const codes = await Promise.all(children);
    assert.deepEqual(codes, [0, 0, 0, 0]);
    assert.equal(existsSync(stampPath), true);
    assert.equal(existsSync(lockPath), false);

    const lines = readFileSync(join(fx.pluginRoot, logFile), 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['failed', 'ok'], '4 concurrent workers must run bootstrap only once');

    // 3b. Late worker arriving after stamp is already written skips bootstrap immediately
    const lateWorker = spawnSync(
      process.execPath,
      [fx.hookFile, '--worker', fx.pluginRoot, fx.pluginData, '2.0.0'],
      { encoding: 'utf8', env: cleanHookEnv(fx), timeout: 5_000 },
    );
    assert.equal(lateWorker.status, 0);
    const linesAfterLate = readFileSync(join(fx.pluginRoot, logFile), 'utf8').trim().split('\n');
    assert.deepEqual(linesAfterLate, ['failed', 'ok'], 'late worker must skip bootstrap when stamp exists');

    // 3c. Truncated/corrupt non-empty lock file older than 5s is reclaimed rather than wedging bootstrap forever
    rmSync(stampPath, { force: true });
    writeFileSync(lockPath, '{"pid":123');
    const oldSec = Math.floor((Date.now() - 10_000) / 1000);
    const { utimesSync } = await import('node:fs');
    utimesSync(lockPath, oldSec, oldSec);
    const corruptReclaim = spawnSync(
      process.execPath,
      [fx.hookFile, '--worker', fx.pluginRoot, fx.pluginData, '2.0.0'],
      { encoding: 'utf8', env: cleanHookEnv(fx), timeout: 5_000 },
    );
    assert.equal(corruptReclaim.status, 0);
    assert.equal(existsSync(stampPath), true, 'corrupt stale lock must be reclaimed');
    assert.equal(existsSync(lockPath), false);

    // 4. Symlinked targetDataDir is rejected without writing through symlink
    const realTarget = join(fx.base, 'real-sym-target');
    const symDataDir = join(fx.base, 'sym-plugin-data');
    mkdirSync(realTarget, { recursive: true });
    symlinkSync(realTarget, symDataDir);
    const symRun = spawnSync(
      process.execPath,
      [fx.hookFile, '--worker', fx.pluginRoot, symDataDir, '2.0.0'],
      { encoding: 'utf8', env: cleanHookEnv(fx), timeout: 5_000 },
    );
    assert.equal(symRun.status, 0);
    assert.equal(existsSync(join(realTarget, 'bootstrapped-2.0.0.json')), false);
  } finally {
    fx.cleanup();
  }
});
