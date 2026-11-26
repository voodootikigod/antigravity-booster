// Zero-dependency SessionStart hook for one-time background bootstrap.
// Pure Node built-ins only so clean clones without node_modules work out-of-the-box.
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCK_TTL_MS = 300_000;
const BOOTSTRAP_TIMEOUT_MS = 120_000;
const SAFE_VERSION_RE = /^[0-9A-Za-z._+-]{1,64}$/;

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function readPackageVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    if (typeof pkg?.version === 'string' && SAFE_VERSION_RE.test(pkg.version)) {
      return pkg.version;
    }
  } catch {
    // fallback below
  }
  return '0.0.0';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function hasLiveBootstrapLock(lockPath) {
  try {
    const st = lstatSync(lockPath);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const raw = readFileSync(lockPath, 'utf8');
    if (raw.trim() === '') {
      return Date.now() - st.mtimeMs < 5_000;
    }
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    const ts = Number(parsed?.ts ?? parsed?.startTime);
    if (!Number.isFinite(ts)) return false;
    const age = Date.now() - ts;
    if (age < 0 || age >= LOCK_TTL_MS) return false;
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

function hasBootstrapStamp(stampPath) {
  const st = lstatOrNull(stampPath);
  if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  return existsSync(stampPath);
}

function getStaleLockInode(lockPath) {
  try {
    const st = lstatSync(lockPath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const raw = readFileSync(lockPath, 'utf8');
    if (raw.trim() === '') {
      return Date.now() - st.mtimeMs < 5_000 ? null : st.ino;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Date.now() - st.mtimeMs < 5_000 ? null : st.ino;
    }
    const pid = Number(parsed?.pid);
    const ts = Number(parsed?.ts ?? parsed?.startTime);
    if (!Number.isFinite(ts)) return st.ino;
    const age = Date.now() - ts;
    if (age < 0 || age >= LOCK_TTL_MS) return st.ino;
    return isPidAlive(pid) ? null : st.ino;
  } catch {
    return null;
  }
}

function acquireWorkerLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (lstatOrNull(lockPath)?.isSymbolicLink()) return null;
      return openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
      if (attempt === 1) return null;
      const staleIno = getStaleLockInode(lockPath);
      if (staleIno === null) return null;
      try {
        if (lstatOrNull(lockPath)?.ino !== staleIno) return null;
        unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function runDetachedWorker(workerArgs) {
  const [rawPluginRoot, rawDataDir, targetVersion] = workerArgs;
  if (!rawPluginRoot || !rawDataDir || !targetVersion || !SAFE_VERSION_RE.test(targetVersion)) {
    return;
  }
  const targetPluginRoot = resolve(rawPluginRoot);
  const targetDataDir = resolve(rawDataDir);

  const preStat = lstatOrNull(targetDataDir);
  if (preStat?.isSymbolicLink()) return;
  try {
    mkdirSync(targetDataDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  const dirStat = lstatOrNull(targetDataDir);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return;

  const stampPath = join(targetDataDir, `bootstrapped-${targetVersion}.json`);
  if (hasBootstrapStamp(stampPath)) return;

  const lockPath = join(targetDataDir, 'session-bootstrap.lock');
  let fd = acquireWorkerLock(lockPath);
  if (fd === null) return;

  try {
    const now = Date.now();
    const lockPayload = JSON.stringify({ pid: process.pid, ts: now, startTime: now }) + '\n';
    writeFileSync(fd, lockPayload, { encoding: 'utf8' });
    closeSync(fd);
    fd = null;

    if (hasBootstrapStamp(stampPath)) return;

    execFileSync(process.execPath, [join(targetPluginRoot, 'dist', 'agb.mjs'), 'bootstrap'], {
      stdio: 'ignore',
      timeout: BOOTSTRAP_TIMEOUT_MS,
    });

    if (lstatOrNull(stampPath)?.isSymbolicLink()) return;
    const tmpPath = join(targetDataDir, `.bootstrapped-${targetVersion}.${process.pid}.${Date.now()}.tmp`);
    const stampBody = JSON.stringify(
      {
        version: targetVersion,
        bootstrappedAt: new Date().toISOString(),
        pid: process.pid,
      },
      null,
      2,
    ) + '\n';
    writeFileSync(tmpPath, stampBody, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, stampPath);
  } catch {
    // Exit 0 silently without writing stamp when bootstrap fails.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      try {
        if (!hasLiveBootstrapLock(lockPath)) unlinkSync(lockPath);
      } catch {}
    }
  }
}

function drainStdinNonBlocking() {
  try {
    process.stdin.on('error', () => {});
    process.stdin.resume();
    process.stdin.unref?.();
  } catch {
    // ignore stdin errors
  }
}

function runSessionStartHook() {
  drainStdinNonBlocking();

  const selfPath = fileURLToPath(import.meta.url);
  const pluginRoot = process.env.PLUGIN_ROOT
    ? resolve(process.env.PLUGIN_ROOT)
    : resolve(dirname(selfPath), '..');
  const pkgVersion = readPackageVersion(pluginRoot);
  const pluginDataDir = process.env.PLUGIN_DATA
    ? resolve(process.env.PLUGIN_DATA)
    : join(homedir(), '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');

  const unbundled = typeof __AGB_BUNDLED__ === 'undefined' || !__AGB_BUNDLED__;
  const stampPath = join(pluginDataDir, `bootstrapped-${pkgVersion}.json`);
  const lockPath = join(pluginDataDir, 'session-bootstrap.lock');

  if (
    (unbundled && process.env.AGB_SKIP_SESSION_BOOTSTRAP === '1') ||
    Boolean(process.env.AGB_WORKER_TICKET) ||
    Boolean(process.env.AGB_WORKER_MODE) ||
    hasBootstrapStamp(stampPath) ||
    hasLiveBootstrapLock(lockPath)
  ) {
    writeSync(1, '{}\n');
    return;
  }

  try {
    const child = spawn(
      process.execPath,
      [selfPath, '--worker', pluginRoot, pluginDataDir, pkgVersion],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    writeSync(1, '{}\n');
    return;
  }

  const response = {
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
  };
  writeSync(1, `${JSON.stringify(response)}\n`);
}

try {
  if (process.argv[2] === '--worker') {
    runDetachedWorker(process.argv.slice(3));
  } else {
    runSessionStartHook();
  }
} catch {
  if (process.argv[2] !== '--worker') {
    try {
      writeSync(1, '{}\n');
    } catch {}
  }
}
