import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function serveSidecar(repoPath, port = process.env.AGB_SIDECAR_PORT || 3333) {
  return new Promise((resolve, reject) => {
    const runJsonPath = join(repoPath, '.booster', 'run.json');
    
    const server = createServer((req, res) => {
      
      const url = new URL(req.url, 'http://localhost');
      
      if (url.pathname === '/events') {
        let offset = parseInt(url.searchParams.get('offset') || '0', 10);
        
        let runId = null;
        if (existsSync(runJsonPath)) {
          try {
            const run = JSON.parse(readFileSync(runJsonPath, 'utf8'));
            runId = String(run.runId || '').replace(/[\\/\\\\]/g, '_');
            eventsPath = join(repoPath, '.booster', 'logs', runId, 'events.jsonl');
          } catch (e) {}
        }

        if (!eventsPath || !existsSync(eventsPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ lines: [], newOffset: offset, runId }));
        }

        try {
          const stats = statSync(eventsPath);
          if (stats.size < offset) {
            // File truncated/restarted
            offset = 0;
          }
          
          if (stats.size > offset) {
            const fd = openSync(eventsPath, 'r');
            const buffer = Buffer.alloc(stats.size - offset);
            readSync(fd, buffer, 0, buffer.length, offset);
            closeSync(fd);
            
            const content = buffer.toString('utf8');
            const lastNewline = content.lastIndexOf('\\n');
            
            if (lastNewline !== -1) {
              const completeContent = content.substring(0, lastNewline);
              const lines = completeContent.split('\\n').filter(Boolean);
              offset += Buffer.byteLength(completeContent) + 1; // +1 for the newline
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ lines, newOffset: offset, runId }));
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ lines: [], newOffset: offset, runId }));
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
      const actualPort = server.address().port;
      console.log(`AGB Sidecar Server running at http://127.0.0.1:${actualPort}`);
      console.log('Use sidecar/agb.json to mount this natively in Antigravity');
      
      // Dynamically update the agb.json descriptor to use the bound port
      try {
        const agbJsonPath = join(__dirname, 'agb.json');
        if (existsSync(agbJsonPath)) {
          const agbJson = JSON.parse(readFileSync(agbJsonPath, 'utf8'));
          agbJson.url = `http://127.0.0.1:${actualPort}/`;
          writeFileSync(agbJsonPath, JSON.stringify(agbJson, null, 2));
        }
      } catch (e) {
        console.warn('Could not update agb.json port configuration');
      }
    });
    
    // Resolve when the server is ready, but keep the process alive
    server.on('listening', () => resolve(server));
  });
}
