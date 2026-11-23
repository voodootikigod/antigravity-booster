import { createServer } from 'node:http';
import {
  readFileSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  createReadStream,
  lstatSync,
  fstatSync,
  realpathSync,
  constants,
} from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

function lstatOrNull(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function readRegularFileNoFollow(filePath) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      const err = new Error(`Refusing to read non-file path: ${filePath}`);
      err.code = 'ENOTFILE';
      throw err;
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function resolveSafeEventsPath(repoPath) {
  let realRepo;
  try {
    realRepo = realpathSync(resolve(repoPath));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, runId: null, eventsPath: null };
    }
    return { ok: false, code: 'IO_ERROR', error: `Failed to resolve repository path: ${err.message}` };
  }

  const boosterDir = join(realRepo, '.booster');
  const boosterStat = lstatOrNull(boosterDir);
  if (!boosterStat) {
    return { ok: true, runId: null, eventsPath: null };
  }
  if (boosterStat.isSymbolicLink() || !boosterStat.isDirectory()) {
    return { ok: false, code: 'SYMLINK', error: 'Refusing to read events from symlinked or non-directory .booster path' };
  }

  const runJsonPath = join(boosterDir, 'run.json');
  const runJsonStat = lstatOrNull(runJsonPath);
  if (!runJsonStat) {
    return { ok: true, runId: null, eventsPath: null };
  }
  if (runJsonStat.isSymbolicLink() || !runJsonStat.isFile()) {
    return { ok: false, code: 'SYMLINK', error: 'Refusing to read symlinked or non-file .booster/run.json' };
  }

  let run;
  try {
    const raw = readRegularFileNoFollow(runJsonPath);
    run = JSON.parse(raw);
  } catch (err) {
    if (err?.code === 'ELOOP' || err?.code === 'ENOTFILE') {
      return { ok: false, code: 'SYMLINK', error: 'Refusing to read symlinked or non-file .booster/run.json' };
    }
    if (err?.code === 'ENOENT') {
      return { ok: true, runId: null, eventsPath: null };
    }
    return { ok: true, runId: null, eventsPath: null };
  }

  if (typeof run?.runId !== 'string') {
    return { ok: false, code: 'INVALID_RUN_ID', error: 'Rejected empty or invalid runId in .booster/run.json' };
  }
  const trimmedRunId = run.runId.trim();
  if (!trimmedRunId || !/^[a-zA-Z0-9_-]+$/.test(run.runId)) {
    return { ok: false, code: 'INVALID_RUN_ID', error: 'Rejected empty, whitespace, or invalid runId in .booster/run.json' };
  }
  const runId = trimmedRunId;

  const logsDir = join(boosterDir, 'logs');
  const logsStat = lstatOrNull(logsDir);
  if (!logsStat) {
    return { ok: true, runId, eventsPath: null };
  }
  if (logsStat.isSymbolicLink() || !logsStat.isDirectory()) {
    return { ok: false, code: 'SYMLINK', error: 'Refusing to read events from symlinked or non-directory .booster/logs path' };
  }

  const runLogDir = join(logsDir, runId);
  const runLogStat = lstatOrNull(runLogDir);
  if (!runLogStat) {
    return { ok: true, runId, eventsPath: null };
  }
  if (runLogStat.isSymbolicLink() || !runLogStat.isDirectory()) {
    return { ok: false, code: 'SYMLINK', error: 'Refusing to read events from symlinked or non-directory run log directory' };
  }

  const eventsPath = join(runLogDir, 'events.jsonl');
  const eventsStat = lstatOrNull(eventsPath);
  if (!eventsStat) {
    return { ok: true, runId, eventsPath: null };
  }
  if (eventsStat.isSymbolicLink() || !eventsStat.isFile()) {
    return { ok: false, code: 'SYMLINK', error: 'Refusing to read symlinked or non-file events.jsonl' };
  }

  let realEvents;
  try {
    realEvents = realpathSync(eventsPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, runId, eventsPath: null };
    }
    return { ok: false, code: 'SYMLINK', error: `Refusing to read events path: ${err.message}` };
  }
  const rel = relative(realRepo, realEvents);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: 'SYMLINK', error: 'Refusing to read events path escaping repository root' };
  }

  return { ok: true, runId, eventsPath: realEvents };
}

export function serveSidecar(repoPath, port = 3333, token = null) {

  const handleRequest = async (req, res) => {
    const hostHeader = req.headers.host || '';
    let hostname = '';
    try {
      hostname = new URL('http://' + hostHeader).hostname;
    } catch(e) {}
    const allowlistHosts = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    
    if (!allowlistHosts.includes(hostname)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const reqUrl = new URL(req.url, 'http://localhost');
    const reqToken = reqUrl.searchParams.get('token');
    
    if (token) {
      const tokenBuf = Buffer.from(token);
      if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
        const reqTokenBuf = reqToken ? Buffer.from(reqToken) : null;
        const isAuth = reqTokenBuf && reqTokenBuf.length === tokenBuf.length && timingSafeEqual(reqTokenBuf, tokenBuf);
        if (!isAuth) {
          res.writeHead(403);
          return res.end('Forbidden: Invalid token');
        }
      } else if (reqUrl.pathname === '/events') {
        const authHeader = req.headers.authorization || '';
        const bearerToken = authHeader.replace(/^Bearer\s+/, '');
        const bearerTokenBuf = bearerToken ? Buffer.from(bearerToken) : null;
        const reqTokenBuf = reqToken ? Buffer.from(reqToken) : null;
        const isAuth = (bearerTokenBuf && bearerTokenBuf.length === tokenBuf.length && timingSafeEqual(bearerTokenBuf, tokenBuf)) ||
                       (reqTokenBuf && reqTokenBuf.length === tokenBuf.length && timingSafeEqual(reqTokenBuf, tokenBuf));
        if (!isAuth) {
          res.writeHead(403);
          return res.end('Forbidden: Invalid token header');
        }
      }
      // /app.js and /style.css are served without token checks.
    }

    if (reqUrl.pathname === '/events') {
      let offset = Number(reqUrl.searchParams.get('offset')) || 0;
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      offset = Math.floor(offset);

      const resolved = resolveSafeEventsPath(repoPath);
      if (!resolved.ok) {
        const status = resolved.code === 'SYMLINK' ? 403 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          lines: [],
          newOffset: 0,
          runId: null,
          repo: repoPath,
          error: resolved.error,
        }));
      }

      const { runId, eventsPath } = resolved;
      if (!eventsPath) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ lines: [], newOffset: 0, runId, repo: repoPath }));
      }

      let fd;
      try {
        fd = openSync(eventsPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stats = fstatSync(fd);
        if (!stats.isFile()) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            lines: [],
            newOffset: 0,
            runId: null,
            repo: repoPath,
            error: 'Refusing to read non-file events.jsonl',
          }));
        }
        let isReset = false;
        if (offset > stats.size) {
          offset = 0;
          isReset = true;
        }

        if (stats.size > offset) {
          const MAX_CHUNK = 1024 * 1024; // 1MB
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
            if (buffer[i] === 10) { // '\n'
              lastNewline = i;
              break;
            }
          }

          if (lastNewline === -1) {
            if (offset + toRead < stats.size) {
              // The chunk contains no newline and we haven't reached EOF.
              // Scan forward in 64 KiB chunks until the next newline (or stats.size)
              // so newOffset advances past the entire oversized line on the first poll.
              let scanPos = offset + toRead;
              const scanBuf = Buffer.alloc(65536);
              while (scanPos < stats.size) {
                const n = readSync(fd, scanBuf, 0, Math.min(scanBuf.length, stats.size - scanPos), scanPos);
                if (n <= 0) break;
                let nl = -1;
                for (let j = 0; j < n; j++) {
                  if (scanBuf[j] === 10) { nl = j; break; }
                }
                if (nl !== -1) {
                  scanPos += nl + 1;
                  break;
                }
                scanPos += n;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ 
                lines: [buffer.toString('utf8', 0, toRead)], 
                newOffset: scanPos, 
                runId, 
                repo: repoPath, 
                reset: isReset, 
                warning: "Dropped oversized line" 
              }));
            }
          }

          if (lastNewline !== -1) {
            const completeBuffer = buffer.subarray(0, lastNewline);
            const completeContent = completeBuffer.toString('utf8');
            let droppedCorrupt = false;
            const lines = completeContent.split('\n').filter(Boolean).filter(line => {
              try { JSON.parse(line); return true; } catch (e) { droppedCorrupt = true; return false; }
            });
            const newOffset = offset + lastNewline + 1;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            const payload = { lines, newOffset, runId, repo: repoPath, reset: isReset };
            if (droppedCorrupt) payload.warning = "Dropped unparseable JSON line";
            return res.end(JSON.stringify(payload));
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines: [], newOffset: offset, runId, repo: repoPath, reset: isReset }));
      } catch (err) {
        if (err?.code === 'ELOOP') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            lines: [],
            newOffset: 0,
            runId: null,
            repo: repoPath,
            error: 'Refusing to read symlinked events.jsonl',
          }));
        } else if (err?.code === 'ENOENT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ lines: [], newOffset: 0, runId, repo: repoPath }));
        } else {
          res.writeHead(500);
          res.end('Error reading events');
        }
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
        }
      }
      return;
    }

    const safePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
    const allowlist = ['/index.html', '/app.js', '/style.css'];

    if (!allowlist.includes(safePath)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let filePath = join(__dirname, safePath);
    if (!existsSync(filePath)) {
      filePath = join(__dirname, '..', 'sidecars', safePath);
    }
    if (!existsSync(filePath)) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const ext = filePath.split('.').pop();
    const mimes = { 'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript', 'json': 'application/json' };
    const contentType = mimes[ext] || 'text/plain';
    
    if (ext === 'html') {
      const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;";
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Content-Type', contentType);
      let html = readFileSync(filePath, 'utf8');
      // Static subresources (/app.js, /style.css) are allowlisted on the local origin; /events requires token.
      return res.end(html);
    }
    
    res.setHeader('Content-Type', contentType);
    const s = createReadStream(filePath);
    s.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Read error');
      }
    });
    s.pipe(res);
  };

  return new Promise((resolve, reject) => {
    let isListening = false;
    const server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (err) {
        console.error('Sidecar request error:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        }
      }
    });

    server.on('error', (err) => {
      if (!isListening) {
        reject(new Error(`Failed to start sidecar server on port ${port}: ${err.message}`));
      } else {
        console.error('Sidecar server error:', err);
      }
    });
    
    server.listen(port, '127.0.0.1', () => {
      isListening = true;
      console.log(`AGB Sidecar Server running at http://127.0.0.1:${server.address().port}`);
      resolve(server);
    });
  });
}
