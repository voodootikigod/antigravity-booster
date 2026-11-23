import { serveSidecar, resolveSafeEventsPath } from './server.mjs';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  writeFileSync,
  mkdirSync,
  chmodSync,
  fchmodSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  readSync,
  lstatSync,
  fstatSync,
  realpathSync,
  constants,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseJetskiPort(rawPort) {
  if (typeof rawPort !== 'string') return null;
  if (!/^\d+$/.test(rawPort)) return null;
  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

export function resolveRepoPath(rawDir = process.cwd()) {
  let repoPath = resolve(rawDir || process.cwd());
  if (repoPath.includes('.agents') || repoPath.includes('.gemini')) {
    let cur = repoPath;
    while (cur !== resolve(cur, '..')) {
      if (existsSync(join(cur, 'package.json')) && (existsSync(join(cur, 'lib')) || existsSync(join(cur, '.git')))) {
        repoPath = cur;
        break;
      }
      cur = resolve(cur, '..');
    }
  }
  return repoPath;
}

export function writeTokenFile(repoPath, token) {
  const realRepo = realpathSync(resolve(repoPath));
  const boosterDir = join(realRepo, '.booster');

  let boosterStat = null;
  try {
    boosterStat = lstatSync(boosterDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (boosterStat) {
    if (boosterStat.isSymbolicLink()) {
      throw new Error(`Refusing to write token: ${boosterDir} is a symbolic link`);
    }
    if (!boosterStat.isDirectory()) {
      throw new Error(`Refusing to write token: ${boosterDir} is not a directory`);
    }
  } else {
    mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
    const postStat = lstatSync(boosterDir);
    if (postStat.isSymbolicLink() || !postStat.isDirectory()) {
      throw new Error(`Refusing to write token: ${boosterDir} is not a safe directory`);
    }
  }
  if (process.platform !== 'win32') {
    chmodSync(boosterDir, 0o700);
  }

  const tokenFile = join(boosterDir, 'token');
  let tokenStat = null;
  try {
    tokenStat = lstatSync(tokenFile);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (tokenStat) {
    if (tokenStat.isSymbolicLink()) {
      throw new Error(`Refusing to write token: ${tokenFile} is a symbolic link`);
    }
    if (!tokenStat.isFile()) {
      throw new Error(`Refusing to write token: ${tokenFile} is not a regular file`);
    }
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0);
  const fd = openSync(tokenFile, flags, 0o600);
  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      throw new Error(`Refusing to write token: ${tokenFile} is not a regular file`);
    }
    writeFileSync(fd, token, 'utf8');
    if (process.platform !== 'win32') {
      fchmodSync(fd, 0o600);
    }
  } finally {
    closeSync(fd);
  }
  return tokenFile;
}

export function readJetskiEvents(repoPath, data = {}) {
  let offset = Number(data && data.offset);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.floor(offset);

  const resolved = resolveSafeEventsPath(repoPath);
  if (!resolved.ok) {
    return {
      lines: [],
      newOffset: 0,
      runId: null,
      repo: repoPath,
      error: resolved.error,
    };
  }

  const { runId, eventsPath } = resolved;
  let isReset = false;
  let result = { lines: [], newOffset: offset, runId, repo: repoPath };
  if (!eventsPath) {
    return result;
  }

  let fd;
  try {
    fd = openSync(eventsPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      return {
        lines: [],
        newOffset: 0,
        runId: null,
        repo: repoPath,
        error: 'Refusing to read non-file events.jsonl',
      };
    }
    if (offset > stats.size) {
      offset = 0;
      isReset = true;
    }
    result = { lines: [], newOffset: offset, runId, repo: repoPath, ...(isReset ? { reset: true } : {}) };
    if (stats.size > offset) {
      const MAX_CHUNK = 1024 * 1024;
      const toRead = Math.min(stats.size - offset, MAX_CHUNK);
      const buffer = Buffer.alloc(toRead);
      let totalRead = 0;
      while (totalRead < buffer.length) {
        const bytesRead = readSync(fd, buffer, totalRead, buffer.length - totalRead, offset + totalRead);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
      }
      let lastNewline = -1;
      for (let i = totalRead - 1; i >= 0; i--) {
        if (buffer[i] === 10) {
          lastNewline = i;
          break;
        }
      }
      if (lastNewline === -1) {
        if (offset + totalRead < stats.size) {
          let scanOffset = offset + totalRead;
          const scanBuf = Buffer.alloc(65536);
          while (scanOffset < stats.size) {
            const n = readSync(fd, scanBuf, 0, Math.min(scanBuf.length, stats.size - scanOffset), scanOffset);
            if (n === 0) break;
            const nl = scanBuf.subarray(0, n).indexOf(10);
            if (nl !== -1) {
              scanOffset += nl + 1;
              break;
            }
            scanOffset += n;
          }
          result = {
            lines: [],
            newOffset: scanOffset,
            runId,
            repo: repoPath,
            reset: isReset,
            warning: 'Dropped oversized line',
          };
        }
      } else {
        const completeBuffer = buffer.subarray(0, lastNewline);
        const completeContent = completeBuffer.toString('utf8');
        let droppedCorrupt = false;
        const lines = completeContent.split('\n').filter(Boolean).filter((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            droppedCorrupt = true;
            return false;
          }
        });
        result = {
          lines,
          newOffset: offset + lastNewline + 1,
          runId,
          repo: repoPath,
          reset: isReset,
          ...(droppedCorrupt ? { warning: 'Dropped unparseable JSON line' } : {}),
        };
      }
    }
  } catch (err) {
    if (err?.code === 'ELOOP') {
      return {
        lines: [],
        newOffset: 0,
        runId: null,
        repo: repoPath,
        error: 'Refusing to read symlinked events.jsonl',
      };
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
  return result;
}

export async function start({
  repoPath = resolveRepoPath(process.argv[2] || process.cwd()),
  env = process.env,
  defaultPort = 3333,
  exitOnError = false,
} = {}) {
  const jetskiPort = parseJetskiPort(env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  const isJetski = jetskiPort !== null;
  const port = isJetski ? jetskiPort : defaultPort;

  try {
    const sdk = await import('sidecar_sdk');
    if (sdk && sdk.SidecarApp) {
      console.log(`Initializing AGB Dashboard using Jetski sidecar_sdk for repo: ${repoPath}`);
      const app = new sdk.SidecarApp();

      app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));
      app.page('/index.html', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));

      const makeResponse = (content, mimeType) => {
        if (typeof sdk.Response === 'function') {
          return new sdk.Response(content, { contentType: mimeType });
        }
        return { body: content, headers: { 'Content-Type': mimeType } };
      };

      app.api('/style.css', () => makeResponse(readFileSync(join(__dirname, 'style.css'), 'utf8'), 'text/css'), 'GET');
      app.api('/app.js', () => makeResponse(readFileSync(join(__dirname, 'app.js'), 'utf8'), 'application/javascript'), 'GET');
      app.api('/events', (data) => makeResponse(JSON.stringify(readJetskiEvents(repoPath, data)), 'application/json'), 'GET');

      app.run();
      console.log('AGB Dashboard running via Jetski sidecar_sdk');
      return null;
    }
  } catch (err) {
    // sidecar_sdk not available, proceed to standalone HTTP server
  }

  const token = isJetski ? null : randomBytes(16).toString('hex');

  if (token) {
    try {
      writeTokenFile(repoPath, token);
    } catch (err) {
      console.error(`Failed to write sidecar token: ${err.message}`);
      if (exitOnError) {
        process.exit(1);
      }
      throw err;
    }
  }

  console.log(`Starting AGB Dashboard for repository: ${repoPath} on port: ${port}`);
  try {
    const server = await serveSidecar(repoPath, port, token);
    const actualPort = server.address()?.port ?? port;
    console.log(`AGB Dashboard successfully running at http://127.0.0.1:${actualPort}`);
    return server;
  } catch (err) {
    console.error(`Failed to start AGB Dashboard: ${err.message}`);
    if (exitOnError) {
      process.exit(1);
    }
    throw err;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  start({ exitOnError: true });
}
