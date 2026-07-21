import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveSidecar } from '../sidecars/server.mjs';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fetchP(url) {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    }).on('error', reject).end();
  });
}

test('sidecar: EADDRINUSE is handled gracefully', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv1 = await serveSidecar(repo, 0);
  const port = srv1.address().port;
  
  await assert.rejects(
    serveSidecar(repo, port),
    /EADDRINUSE/
  );
  
  srv1.close();
});

test('sidecar: path traversal blocked', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv = await serveSidecar(repo, 0);
  const port = srv.address().port;
  
  const res = await fetchP(`http://127.0.0.1:${port}/../package.json`);
  assert.equal(res.statusCode, 403);
  
  const res2 = await fetchP(`http://127.0.0.1:${port}/foo.html`);
  assert.equal(res2.statusCode, 404);
  
  srv.close();
});

test('sidecar: serves events properly and resets offset', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  mkdirSync(join(repo, '.booster'), { recursive: true });
  writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r1' }));
  
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  const eventsFile = join(repo, '.booster', 'logs', 'r1', 'events.jsonl');
  
  writeFileSync(eventsFile, '{"t": 1}\\n{"t": 2}\\n');
  
  const srv = await serveSidecar(repo, 0);
  const port = srv.address().port;
  
  // Normal fetch
  const res1 = await fetchP(`http://127.0.0.1:${port}/events`);
  let json1 = JSON.parse(res1.data);
  assert.equal(json1.lines.length, 2);
  assert.equal(json1.newOffset, 2);
  
  // Offset fetch
  const res2 = await fetchP(`http://127.0.0.1:${port}/events?offset=1`);
  let json2 = JSON.parse(res2.data);
  assert.equal(json2.lines.length, 1);
  assert.equal(json2.newOffset, 2);
  
  // Truncate file
  writeFileSync(eventsFile, '{"t": 3}\\n');
  const res3 = await fetchP(`http://127.0.0.1:${port}/events?offset=2`);
  let json3 = JSON.parse(res3.data);
  assert.equal(json3.lines.length, 1); // should reset to 0 and read 1
  assert.equal(json3.newOffset, 1);
  
  srv.close();
});

test('sidecar: handles missing run.json gracefully', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv = await serveSidecar(repo, 0);
  const port = srv.address().port;
  
  const res = await fetchP(`http://127.0.0.1:${port}/events`);
  let json = JSON.parse(res.data);
  assert.equal(json.lines.length, 0);
  
  srv.close();
});
