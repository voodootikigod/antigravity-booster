import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function serveSidecar(repoPath, port = 3333, token = null) {
  const runJsonPath = join(repoPath, '.booster', 'run.json');

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
    
    const cookies = req.headers.cookie || '';
    let cookieToken = null;
    const cookieMatch = cookies.match(/agb_token=([^;]+)/);
    if (cookieMatch) cookieToken = cookieMatch[1];
    
    if (token) {
      if (reqUrl.pathname === '/' && reqToken) {
        // Authenticating via query param on first load
        const isValid = reqToken.length === token.length && timingSafeEqual(Buffer.from(reqToken), Buffer.from(token));
        if (!isValid) {
          res.writeHead(403);
          return res.end('Forbidden: Invalid token');
        }
        res.setHeader('Set-Cookie', `agb_token=${reqToken}; HttpOnly; SameSite=Strict; Path=/`);
      } else {
        // All other requests or subsequent root requests must use the cookie
        if (!cookieToken) {
          res.writeHead(403);
          return res.end('Forbidden: Missing token cookie');
        }
        const isValid = cookieToken.length === token.length && timingSafeEqual(Buffer.from(cookieToken), Buffer.from(token));
        if (!isValid) {
          res.writeHead(403);
          return res.end('Forbidden: Invalid token cookie');
        }
      }
    }

    if (reqUrl.pathname === '/events') {
      let offset = Number(reqUrl.searchParams.get('offset')) || 0;
      let runId = null;
      let eventsPath = null;
      if (existsSync(runJsonPath)) {
        try {
          const run = JSON.parse(readFileSync(runJsonPath, 'utf8'));
          runId = String(run.runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
          eventsPath = join(repoPath, '.booster', 'logs', runId, 'events.jsonl');
        } catch (e) {}
      }

      if (!eventsPath || !existsSync(eventsPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ lines: [], newOffset: 0, runId, repo: repoPath }));
      }

      try {
        const stats = statSync(eventsPath);
        if (!Number.isFinite(offset) || offset < 0) offset = 0;
        let isReset = false;
        if (offset > stats.size) {
          offset = 0;
          isReset = true;
        }

        if (stats.size > offset) {
          const fd = openSync(eventsPath, 'r');
          const MAX_CHUNK = 1024 * 1024; // 1MB
          const toRead = Math.min(stats.size - offset, MAX_CHUNK);
          const buffer = Buffer.alloc(toRead);
          try {
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
                // We are stuck on an oversized line. We just return what we have and advance offset.
                // The client will fail JSON.parse until it hits the next newline.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ 
                  lines: [buffer.toString('utf8', 0, toRead)], 
                  newOffset: offset + toRead, 
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
          } finally {
            closeSync(fd);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines: [], newOffset: offset, runId, repo: repoPath, reset: isReset }));
      } catch (err) {
        res.writeHead(500);
        res.end('Error reading events');
      }
      return;
    }

    const safePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
    const allowlist = ['/index.html', '/app.js', '/style.css'];

    if (!allowlist.includes(safePath)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const filePath = join(__dirname, safePath);
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
      // No longer inject ?token= into subresource URLs since the HttpOnly cookie handles it.
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
