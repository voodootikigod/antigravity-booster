import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStatus } from '../lib/status.mjs';
import { serveSidecar } from '../sidecars/server.mjs';
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('events.jsonl schema replay contract: strike payload must have an error field', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-schema-'));
  const runId = 'schema_run';
  
  const status = new RunStatus(repo, runId);
  status.ticket('T1', { phase: 'build' });
  status.strike('T1', { error: 'test failure', model: 'test-model', strikes: 1 });
  // Ensure background writes flush
  await status.writePromise;
  
  const eventsFile = join(repo, '.booster', 'logs', runId, 'events.jsonl');
  const eventsData = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  
  const strikeEvent = eventsData.find(e => e.type === 'strike');
  assert.ok(strikeEvent, 'Strike event must be emitted');
  assert.equal(strikeEvent.error, 'test failure', 'Strike event must have an error field to satisfy the schema');
  
  const srv = await serveSidecar(repo, 0);
  try {
     const port = srv.address().port;
     const res = await new Promise((resolve) => {
       import('node:http').then(({ get }) => {
         get(`http://127.0.0.1:${port}/events`, (r) => {
            let data = '';
            r.on('data', c => data += c);
            r.on('end', () => resolve({ statusCode: r.statusCode, data }));
         });
       });
     });
     
     const json = JSON.parse(res.data);
     assert.equal(json.lines.length, 2);
     const parsedLines = json.lines.map(l => JSON.parse(l));
     const serverStrike = parsedLines.find(e => e.type === 'strike');
     assert.equal(serverStrike.error, 'test failure', 'Server must proxy the error payload correctly');
  } finally {
     srv.close();
  }
});
