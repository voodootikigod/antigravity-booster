// Authenticated local control IPC over Unix domain sockets / Windows named pipes.
// Single-line NDJSON request/response with 256-bit constant-time token auth.

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

function getProcessStartTime(pid) {
  if (!pid || typeof pid !== 'number') return null;
  try {
    if (process.platform === 'linux') {
      const content = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = content.lastIndexOf(')');
      if (closeParen !== -1) {
        const rest = content.slice(closeParen + 2).trim().split(/\s+/);
        return rest[19] ?? null;
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
    } else if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      return out || null;
    }
  } catch {}
  return null;
}

function isProcessAlive(pid, expectedStartTime = null) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (expectedStartTime) {
    const curStart = getProcessStartTime(pid);
    if (!curStart || curStart !== expectedStartTime) {
      return false;
    }
  }
  return true;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const POSIX_SOCKET_BYTE_LIMIT = 96;

const ALLOWED_ACTIONS = new Set([
  'ping',
  'status',
  'pause',
  'resume',
  'abort',
  'diff',
  'stream',
]);

function resolveCanonicalRepo(repo) {
  const resolved = resolve(repo);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertNotSymlink(targetPath) {
  try {
    const st = lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: symbolic link not allowed: ${targetPath}`);
    }
    return st;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function ensureSafeBoosterDir(repo) {
  const rawResolved = resolve(repo);
  assertNotSymlink(join(rawResolved, '.booster'));

  const canonicalRepo = resolveCanonicalRepo(repo);
  const boosterDir = join(canonicalRepo, '.booster');
  const existing = assertNotSymlink(boosterDir);
  if (existing && !existing.isDirectory()) {
    throw new Error(`Security violation: .booster is not a directory: ${boosterDir}`);
  }

  mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
  const postSt = assertNotSymlink(boosterDir);
  if (!postSt || !postSt.isDirectory()) {
    throw new Error(`Security violation: .booster must be a regular directory: ${boosterDir}`);
  }

  const realBooster = realpathSync(boosterDir);
  const rel = relative(canonicalRepo, realBooster);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Security violation: .booster directory escapes repository root: ${boosterDir}`);
  }

  if (process.platform !== 'win32') {
    try {
      chmodSync(boosterDir, 0o700);
    } catch {}
  }

  return { canonicalRepo, boosterDir };
}

function writeOwnerOnlyAtomic(filePath, content) {
  assertNotSymlink(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmpPath, content, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      try {
        chmodSync(tmpPath, 0o600);
      } catch {}
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

function readControlMetadata(repo) {
  const rawResolved = resolve(repo);
  const rawBooster = join(rawResolved, '.booster');
  const rawControl = join(rawBooster, 'control.json');

  for (const p of [rawBooster, rawControl]) {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      return { ok: false, symlink: false, error: err.message };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, symlink: true, error: `Security violation: symbolic link not allowed: ${p}` };
    }
  }

  const canonicalRepo = resolveCanonicalRepo(repo);
  const boosterDir = join(canonicalRepo, '.booster');
  const controlFile = join(boosterDir, 'control.json');

  let boosterSt;
  try {
    boosterSt = lstatSync(boosterDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, error: err.message };
  }
  if (boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) {
    return { ok: false, symlink: true, error: `Security violation: invalid .booster directory: ${boosterDir}` };
  }

  let ctrlSt;
  try {
    ctrlSt = lstatSync(controlFile);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, error: err.message };
  }
  if (ctrlSt.isSymbolicLink() || !ctrlSt.isFile()) {
    return { ok: false, symlink: true, error: `Security violation: invalid control.json file: ${controlFile}` };
  }

  try {
    const parsed = JSON.parse(readFileSync(controlFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, malformed: true };
    }
    return { ok: true, control: parsed, controlFile };
  } catch {
    return { ok: false, malformed: true };
  }
}

function sendResponseAndEnd(socket, payload, destroyShortly = false) {
  const line = JSON.stringify(payload) + '\n';
  try {
    socket.pause();
    if (!socket.destroyed && socket.writable) {
      socket.end(line);
      if (destroyShortly) {
        const t = setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, 50);
        t.unref?.();
      }
    } else if (!socket.destroyed) {
      socket.destroy();
    }
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
}

export function resolveControlEndpoint(repo) {
  const canonicalRepo = resolveCanonicalRepo(repo);
  const hash = crypto.createHash('sha256').update(canonicalRepo).digest('hex').slice(0, 16);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agb-control-${hash}`;
  }
  const primary = join(canonicalRepo, '.booster', 'control.sock');
  if (Buffer.byteLength(primary, 'utf8') <= POSIX_SOCKET_BYTE_LIMIT) {
    return primary;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `agb-ctrl-${uid}-${hash}.sock`);
}

export async function startControlServer(repo, handlers = {}, { runId = null } = {}) {
  const { canonicalRepo, boosterDir } = ensureSafeBoosterDir(repo);
  const rawControl = join(resolve(repo), '.booster', 'control.json');
  assertNotSymlink(rawControl);

  const controlFile = join(boosterDir, 'control.json');
  assertNotSymlink(controlFile);

  const endpoint = resolveControlEndpoint(canonicalRepo);
  const token = crypto.randomBytes(32).toString('hex');
  const expectedTokenBuf = Buffer.from(token, 'utf8');

  if (process.platform !== 'win32') {
    const endpointSt = assertNotSymlink(endpoint);
    if (endpointSt) {
      const prior = readControlMetadata(canonicalRepo);
      const priorAlive =
        prior.ok &&
        typeof prior.control?.pid === 'number' &&
        isProcessAlive(prior.control.pid, prior.control.startTime ?? null);
      if (!priorAlive) {
        try {
          unlinkSync(endpoint);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
    }
    const endpointParent = dirname(endpoint);
    if (endpointParent === boosterDir && !existsSync(endpointParent)) {
      mkdirSync(endpointParent, { recursive: true, mode: 0o700 });
    }
  }

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    let chunks = [];
    let totalBytes = 0;
    let handled = false;

    const handleLine = async (rawLine) => {
      let req;
      try {
        req = JSON.parse(rawLine);
      } catch {
        sendResponseAndEnd(socket, { ok: false, error: 'invalid JSON' }, true);
        return;
      }
      if (!req || typeof req !== 'object' || Array.isArray(req)) {
        sendResponseAndEnd(socket, { ok: false, error: 'invalid request' }, true);
        return;
      }

      const providedStr = typeof req.token === 'string' ? req.token : '';
      const providedBuf = Buffer.from(providedStr, 'utf8');
      if (
        providedBuf.length !== expectedTokenBuf.length ||
        !crypto.timingSafeEqual(providedBuf, expectedTokenBuf)
      ) {
        sendResponseAndEnd(socket, { ok: false, error: 'unauthorized' }, true);
        return;
      }

      const action = req.action;
      if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
        sendResponseAndEnd(socket, { ok: false, error: `unsupported action: ${String(action)}` });
        return;
      }

      const hasCustomHandler = Object.hasOwn(handlers, action) && typeof handlers[action] === 'function';
      if (action === 'ping' && !hasCustomHandler) {
        sendResponseAndEnd(socket, { ok: true, pid: process.pid, runId });
        return;
      }
      if (!hasCustomHandler) {
        sendResponseAndEnd(socket, { ok: false, error: `unsupported action: ${action}` });
        return;
      }

      try {
        const res = await handlers[action](req);
        const obj = res && typeof res === 'object' && !Array.isArray(res) ? res : {};
        let payload;
        if (obj.ok === false) {
          payload = { ...obj, ok: false };
        } else {
          payload = { ok: true, ...obj };
          if (action === 'stream') {
            if (payload.ticketId === undefined && req.ticketId !== undefined) {
              payload.ticketId = req.ticketId;
            }
            const cap = Number.isInteger(req.lines) && req.lines > 0 ? req.lines : 40;
            payload.lines = Array.isArray(payload.lines) ? payload.lines.slice(-cap) : [];
          }
        }
        sendResponseAndEnd(socket, payload);
      } catch (err) {
        sendResponseAndEnd(socket, { ok: false, error: err?.message ?? String(err) });
      }
    };

    socket.on('data', (chunk) => {
      if (handled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const nlIdx = buf.indexOf(0x0a);
      const added = nlIdx === -1 ? buf.length : nlIdx;
      if (totalBytes + added > MAX_REQUEST_BYTES) {
        handled = true;
        chunks = [];
        sendResponseAndEnd(socket, { ok: false, error: 'payload too large' }, true);
        return;
      }
      if (nlIdx === -1) {
        chunks.push(buf);
        totalBytes += buf.length;
        return;
      }
      handled = true;
      if (nlIdx > 0) chunks.push(buf.subarray(0, nlIdx));
      const rawLine = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
      chunks = [];
      void handleLine(rawLine);
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      rejectListen(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });

  server.on('error', () => {});

  try {
    if (process.platform !== 'win32') {
      chmodSync(endpoint, 0o600);
    }
    const meta = {
      endpoint,
      token,
      pid: process.pid,
      startTime: getProcessStartTime(process.pid),
      runId,
    };
    writeOwnerOnlyAtomic(controlFile, JSON.stringify(meta, null, 2) + '\n');
  } catch (err) {
    try {
      server.close();
    } catch {}
    if (process.platform !== 'win32') {
      try {
        if (!lstatSync(endpoint).isSymbolicLink()) unlinkSync(endpoint);
      } catch {}
    }
    throw err;
  }

  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {}
      }
      sockets.clear();
      await new Promise((resolveClose) => {
        try {
          server.close(() => resolveClose());
        } catch {
          resolveClose();
        }
      });
      if (process.platform !== 'win32') {
        try {
          const st = lstatSync(endpoint);
          if (!st.isSymbolicLink()) unlinkSync(endpoint);
        } catch {}
      }
      try {
        const st = lstatSync(controlFile);
        if (!st.isSymbolicLink()) unlinkSync(controlFile);
      } catch {}
    })();
    return closePromise;
  };

  return { endpoint, token, controlFile, close };
}

export async function sendControlCommand(repo, command, { timeoutMs = 3000 } = {}) {
  const metaRes = readControlMetadata(repo);
  if (!metaRes.ok) {
    return {
      ok: false,
      offline: true,
      error: metaRes.symlink ? metaRes.error : 'no active run control server',
    };
  }

  const ctrl = metaRes.control;
  if (
    typeof ctrl.endpoint !== 'string' ||
    !ctrl.endpoint ||
    typeof ctrl.token !== 'string' ||
    !ctrl.token ||
    typeof ctrl.pid !== 'number' ||
    !isProcessAlive(ctrl.pid, ctrl.startTime ?? null)
  ) {
    return { ok: false, offline: true, error: 'no active run control server' };
  }

  if (process.platform !== 'win32') {
    try {
      const sockSt = lstatSync(ctrl.endpoint);
      if (sockSt.isSymbolicLink()) {
        return {
          ok: false,
          offline: true,
          error: `Security violation: control socket is a symbolic link: ${ctrl.endpoint}`,
        };
      }
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { ok: false, offline: true, error: 'no active run control server' };
      }
      return { ok: false, offline: true, error: err.message };
    }
  }

  return new Promise((resolveResult) => {
    let settled = false;
    let chunks = [];
    let totalBytes = 0;

    const socket = net.createConnection(ctrl.endpoint);

    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolveResult(res);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, offline: true, error: `control command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    socket.on('connect', () => {
      try {
        const payload = JSON.stringify({ ...(command ?? {}), token: ctrl.token }) + '\n';
        socket.write(payload);
      } catch (err) {
        finish({ ok: false, offline: true, error: err.message });
      }
    });

    const parseLine = (rawLine) => {
      try {
        const parsed = JSON.parse(rawLine);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish({ ok: false, error: 'invalid response from control server' });
          return;
        }
        finish(parsed);
      } catch (err) {
        finish({ ok: false, error: `invalid JSON from control server: ${err.message}` });
      }
    };

    socket.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const nlIdx = buf.indexOf(0x0a);
      const added = nlIdx === -1 ? buf.length : nlIdx;
      if (totalBytes + added > MAX_RESPONSE_BYTES) {
        finish({ ok: false, error: 'control response payload too large' });
        return;
      }
      if (nlIdx === -1) {
        chunks.push(buf);
        totalBytes += buf.length;
        return;
      }
      if (nlIdx > 0) chunks.push(buf.subarray(0, nlIdx));
      const rawLine = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
      chunks = [];
      parseLine(rawLine);
    });

    socket.on('end', () => {
      if (settled) return;
      if (chunks.length > 0) {
        const rawLine = Buffer.concat(chunks).toString('utf8').trim();
        chunks = [];
        if (rawLine) {
          parseLine(rawLine);
          return;
        }
      }
      finish({ ok: false, offline: true, error: 'control connection closed without response' });
    });

    socket.on('error', (err) => {
      finish({ ok: false, offline: true, error: err.message });
    });

    socket.on('close', () => {
      if (!settled) {
        finish({ ok: false, offline: true, error: 'control connection closed' });
      }
    });
  });
}
