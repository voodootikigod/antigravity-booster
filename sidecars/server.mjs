import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function serveSidecar(repoPath, port = process.env.AGB_SIDECAR_PORT || 3333) {
  return new Promise((resolve, reject) => {
    const runJsonPath = join(repoPath, '.booster', 'run.json');
    
    const server = createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      const url = new URL(req.url, 'http://localhost');
      
      if (url.pathname === '/events') {
        let offset = parseInt(url.searchParams.get('offset') || '0', 10);
        
        let eventsPath = null;
        if (existsSync(runJsonPath)) {
          try {
            const run = JSON.parse(readFileSync(runJsonPath, 'utf8'));
            const runId = String(run.runId || '').replace(/[\\/\\\\]/g, '_');
            eventsPath = join(repoPath, '.booster', 'logs', runId, 'events.jsonl');
          } catch (e) {}
        }

        if (!eventsPath || !existsSync(eventsPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ lines: [], newOffset: offset }));
        }

        try {
          const stats = statSync(eventsPath);
          if (stats.size < offset) {
            // File truncated/restarted
            offset = 0;
          }
          
          // Very basic read all strategy for UI - optimized for small events logs
          const content = readFileSync(eventsPath, 'utf8');
          const lines = content.split('\\n').filter(Boolean);
          
          // We track offset by array length here to be simple
          const newLines = lines.slice(offset);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ lines: newLines, newOffset: lines.length }));
        } catch (err) {
          res.writeHead(500);
          res.end('Error reading events');
        }
        return;
      }

      // Static files
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(__dirname, safePath);
      
      // Prevent path traversal
      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (!existsSync(filePath)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      
      const ext = filePath.split('.').pop();
      const mimes = { 'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript' };
      res.writeHead(200, { 'Content-Type': mimes[ext] || 'text/plain' });
      res.end(readFileSync(filePath));
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start sidecar server on port ${port}: ${err.message}`));
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`AGB Sidecar Server running at http://127.0.0.1:${port}`);
      console.log('Use sidecar/agb.json to mount this natively in Antigravity');
    });
    
    // Resolve when the server is ready, but keep the process alive
    server.on('listening', () => resolve(server));
  });
}
