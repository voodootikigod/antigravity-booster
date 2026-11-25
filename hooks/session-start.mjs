// Zero-dependency SessionStart hook for one-time background bootstrap.
// Pure Node built-ins only so clean clones without node_modules work out-of-the-box.
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

function acquireLockUnderReclaimMutex(lockPath) {
  const reclaimDir = `${lockPath}.reclaim`;
  if (lstatOrNull(reclaimDir)?.isSymbolicLink()) return null;
  try {
    mkdirSync(reclaimDir, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== 'EEXIST') return null;
    const reclaimStat = lstatOrNull(reclaimDir);
    if (!reclaimStat || reclaimStat.isSymbolicLink() || Date.now() - reclaimStat.mtimeMs <= 30_000) {
      return null;
    }
    const orphanDir = `${reclaimDir}.orphan.${process.pid}`;
    try {
      renameSync(reclaimDir, orphanDir);
      try {
        rmdirSync(orphanDir);
      } catch {
        // Best-effort cleanup of abandoned reclaim directory.
      }
      mkdirSync(reclaimDir, { mode: 0o700 });
    } catch {
      return null;
    }
  }
  try {
    if (lstatOrNull(lockPath)?.isSymbolicLink() || hasLiveBootstrapLock(lockPath)) {
      return null;
    }
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') return null;
    }
    if (lstatOrNull(lockPath)?.isSymbolicLink()) return null;
    try {
      return openSync(lockPath, 'wx', 0o600);
    } catch {
      return null;
    }
  } finally {
    try {
      rmdirSync(reclaimDir);
    } catch {
      // Best-effort cleanup of reclamation lock directory.
    }
  }
}

function acquireWorkerLock(lockPath) {
  try {
    if (lstatOrNull(lockPath)?.isSymbolicLink()) return null;
    return openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err?.code !== 'EEXIST') return null;
    if (hasLiveBootstrapLock(lockPath)) return null;
    return acquireLockUnderReclaimMutex(lockPath);
  }
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
    if (hasBootstrapStamp(stampPath)) return;
    const now = Date.now();
    const lockPayload = JSON.stringify({ pid: process.pid, ts: now, startTime: now }) + '\n';
    writeFileSync(fd, lockPayload, { encoding: 'utf8' });
    closeSync(fd);
    fd = null;

    execFileSync(process.execPath, [join(targetPluginRoot, 'dist', 'agb.mjs'), 'bootstrap'], {
      stdio: 'ignore',
      timeout: BOOTSTRAP_TIMEOUT_MS,
    });

    if (lstatOrNull(stampPath)?.isSymbolicLink()) return;
    const tmpPath = join(
      targetDataDir,
      `.bootstrapped-${targetVersion}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    const stampBody = JSON.stringify(
      {
        version: targetVersion,
        bootstrappedAt: new Date().toISOString(),
        pid: process.pid,
      },
      null,
      2,
    ) + '\n';
    try {
      writeFileSync(tmpPath, stampBody, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(tmpPath, stampPath);
    } catch (stampErr) {
      try { unlinkSync(tmpPath); } catch {}
      throw stampErr;
    }
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

function detectInstalledPluginPath(selfPath) {
  try {
    const paths = [selfPath];
    try { paths.push(realpathSync(selfPath)); } catch {}
    for (const p of paths) {
      if (p.replace(/\\/g, '/').includes('/.gemini/config/plugins/')) return true;
    }
  } catch {}
  return false;
}

function resolveExistingAncestorRealpath(targetPath) {
  const abs = resolve(targetPath);
  let curr = abs;
  const suffix = [];
  while (curr && !existsSync(curr)) {
    const parent = dirname(curr);
    if (parent === curr) break;
    suffix.unshift(basename(curr));
    curr = parent;
  }
  try {
    const real = realpathSync(curr);
    return suffix.length > 0 ? join(real, ...suffix) : real;
  } catch {
    return abs;
  }
}

function isWithinDir(parentDir, childPath) {
  const rel = relative(parentDir, childPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

function runSessionStartHook() {
  drainStdinNonBlocking();

  const selfPath = fileURLToPath(import.meta.url);
  const derivedRoot = resolve(dirname(selfPath), '..');
  let realDerivedRoot;
  try {
    realDerivedRoot = realpathSync(derivedRoot);
  } catch {
    realDerivedRoot = derivedRoot;
  }
  if (process.env.PLUGIN_ROOT) {
    const envRootReal = resolveExistingAncestorRealpath(process.env.PLUGIN_ROOT);
    if (envRootReal !== realDerivedRoot) {
      writeSync(1, '{}\n');
      return;
    }
  }
  const pluginRoot = realDerivedRoot;
  const pkgVersion = readPackageVersion(pluginRoot);
  const expectedDataDir = join(homedir(), '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
  const isBundled =
    (typeof __AGB_BUNDLED__ !== 'undefined' && Boolean(__AGB_BUNDLED__)) ||
    detectInstalledPluginPath(selfPath);
  let pluginDataDir = expectedDataDir;
  if (process.env.PLUGIN_DATA) {
    const rawDataDir = resolve(process.env.PLUGIN_DATA);
    if (!isBundled) {
      pluginDataDir = rawDataDir;
    } else {
      const realCandidateData = resolveExistingAncestorRealpath(rawDataDir);
      const realExpectedData = resolveExistingAncestorRealpath(expectedDataDir);
      if (isWithinDir(realExpectedData, realCandidateData)) {
        pluginDataDir = realCandidateData;
      }
    }
  }

  const unbundled = !isBundled;
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
