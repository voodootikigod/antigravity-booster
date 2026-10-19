import { serveSidecar } from './server.mjs';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isJetski = !!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 3333;

let repoDir = process.argv[2] || process.cwd();
let repoPath = resolve(repoDir);

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

async function start() {
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

      app.api('/events', (data) => {
        const runJsonPath = join(repoPath, '.booster', 'run.json');
        let offset = Number(data && data.offset);
        if (!Number.isFinite(offset) || offset < 0) offset = 0;
        offset = Math.floor(offset);
        let runId = null;
        let eventsPath = null;
        if (existsSync(runJsonPath)) {
          try {
            const run = JSON.parse(readFileSync(runJsonPath, 'utf8'));
            runId = String(run.runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
            eventsPath = join(repoPath, '.booster', 'logs', runId, 'events.jsonl');
          } catch (e) {}
        }

        let isReset = false;
        let result = { lines: [], newOffset: offset, runId, repo: repoPath };
        if (eventsPath && existsSync(eventsPath)) {
          try {
            const stats = statSync(eventsPath);
            if (offset > stats.size) {
              offset = 0;
              isReset = true;
            }
            result = { lines: [], newOffset: offset, runId, repo: repoPath, ...(isReset ? { reset: true } : {}) };
            if (stats.size > offset) {
              const fd = openSync(eventsPath, 'r');
              try {
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
                    } catch (e) {
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
              } finally {
                closeSync(fd);
              }
            }
          } catch (e) {}
        }
        return makeResponse(JSON.stringify(result), 'application/json');
      }, 'GET');

      app.run();
      console.log('AGB Dashboard running via Jetski sidecar_sdk');
      return;
    }
  } catch (err) {
    // sidecar_sdk not available, proceed to standalone HTTP server
  }

  const token = randomBytes(16).toString('hex');

  try {
    const boosterDir = join(repoPath, '.booster');
    const tokenFile = join(boosterDir, 'token');
    mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  } catch {}

  console.log(`Starting AGB Dashboard for repository: ${repoPath} on port: ${port}`);
  serveSidecar(repoPath, port, token)
    .then(() => {
      console.log(`AGB Dashboard successfully running at http://127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error(`Failed to start AGB Dashboard: ${err.message}`);
      process.exit(1);
    });
}

start();
