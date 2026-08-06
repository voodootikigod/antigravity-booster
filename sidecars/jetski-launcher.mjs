import { serveSidecar } from './server.mjs';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
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
        let offset = Number(data && data.offset) || 0;
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
          return { lines: [], newOffset: 0, runId, repo: repoPath };
        }

        try {
          const content = readFileSync(eventsPath, 'utf8');
          const allLines = content.split('\n').filter(Boolean);
          const newLines = allLines.slice(offset);
          return { lines: newLines, newOffset: allLines.length, runId, repo: repoPath };
        } catch (e) {
          return { lines: [], newOffset: offset, runId, repo: repoPath };
        }
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
