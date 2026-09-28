import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveSidecar } from '../sidecars/server.mjs';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function fetchP(url, headers = {}) {
  return new Promise((resolve, reject) => {
    // Disable keepAlive so the test process can exit cleanly when srv.close() is called
    const opts = { agent: false, headers };
    request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data, headers: res.headers }));
    }).on('error', reject).end();
  });
}

test('sidecar: EADDRINUSE is handled gracefully', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv1 = await serveSidecar(repo, 0);
  try {
    const port = srv1.address().port;
    
    await assert.rejects(
      serveSidecar(repo, port),
      /EADDRINUSE/
    );
  } finally {
    srv1.close();
  }
});

test('sidecar: path traversal blocked', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv = await serveSidecar(repo, 0);
  try {
    const port = srv.address().port;
    
    // Encoded traversal that avoids client normalization
    const res = await fetchP(`http://127.0.0.1:${port}/%2e%2e%2fpackage.json`);
    assert.equal(res.statusCode, 403);
    
    const res2 = await fetchP(`http://127.0.0.1:${port}/foo.html`);
    assert.equal(res2.statusCode, 403);
  } finally {
    srv.close();
  }
});

test('sidecar: host header validation', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv = await serveSidecar(repo, 0);
  try {
    const port = srv.address().port;
    
    // Explicit 127.0.0.1 host header should pass
    const res1 = await new Promise((resolve, reject) => {
      request(`http://127.0.0.1:${port}/events`, { agent: false, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        resolve({ statusCode: res.statusCode });
      }).on('error', reject).end();
    });
    assert.equal(res1.statusCode, 200);
    
    // Evil host header should fail
    const res2 = await new Promise((resolve, reject) => {
      request(`http://127.0.0.1:${port}/events`, { agent: false, headers: { Host: 'evil.com' } }, (res) => {
        resolve({ statusCode: res.statusCode });
      }).on('error', reject).end();
    });
    assert.equal(res2.statusCode, 403);
  } finally {
    srv.close();
  }
});

test('sidecar: serves events properly and resets offset', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  mkdirSync(join(repo, '.booster'), { recursive: true });
  writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r1' }));
  
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  const eventsFile = join(repo, '.booster', 'logs', 'r1', 'events.jsonl');
  
  writeFileSync(eventsFile, '{"t": 1}\n{"t": 2}\n');
  
  const srv = await serveSidecar(repo, 0);
  try {
    const port = srv.address().port;
    
    // Normal fetch
    const res1 = await fetchP(`http://127.0.0.1:${port}/events`);
    let json1 = JSON.parse(res1.data);
    assert.equal(json1.lines.length, 2);
    assert.equal(json1.newOffset, 18);
    
    // Offset fetch
    const res2 = await fetchP(`http://127.0.0.1:${port}/events?offset=9`);
    let json2 = JSON.parse(res2.data);
    assert.equal(json2.lines.length, 1);
    assert.equal(json2.newOffset, 18);
    
    // Truncate file
    writeFileSync(eventsFile, '{"t": 3}\n');
    const res3 = await fetchP(`http://127.0.0.1:${port}/events?offset=18`);
    let json3 = JSON.parse(res3.data);
    assert.equal(json3.lines.length, 1); // should reset to 0 and read 1
    assert.equal(json3.newOffset, 9);
    
    // Negative offset (clamps to 0)
    const res4 = await fetchP(`http://127.0.0.1:${port}/events?offset=-10`);
    let json4 = JSON.parse(res4.data);
    assert.equal(json4.lines.length, 1);
    
    // NaN offset (clamps to 0)
    const res5 = await fetchP(`http://127.0.0.1:${port}/events?offset=abc`);
    let json5 = JSON.parse(res5.data);
    assert.equal(json5.lines.length, 1);
    
    // Past EOF offset (clamps to 0)
    const res6 = await fetchP(`http://127.0.0.1:${port}/events?offset=99999`);
    let json6 = JSON.parse(res6.data);
    assert.equal(json6.lines.length, 1);
  } finally {
    srv.close();
  }
});

test('sidecar: handles missing run.json gracefully', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-'));
  const srv = await serveSidecar(repo, 0);
  try {
    const port = srv.address().port;
    
    const res = await fetchP(`http://127.0.0.1:${port}/events`);
    let json = JSON.parse(res.data);
    assert.equal(json.lines.length, 0);
  } finally {
    srv.close();
  }
});

test('sidecar: app.js escapes DOM nodes', () => {
  const appJsPath = join(dirname(fileURLToPath(import.meta.url)), '../sidecars/app.js');
  const appJs = readFileSync(appJsPath, 'utf8');

  const els = {};
  const globalDoc = {
    createElement(tag) { return { tag, className: '', innerHTML: '', remove() {} }; },
    getElementById(id) { 
      els[id] = els[id] || { innerHTML: '', children: [], prepend(el) { this.children.unshift(el); }, remove() {}, get lastChild() { return this.children[this.children.length - 1]; } }; 
      return els[id];
    }
  };

  const globalWindow = { location: { search: '?token=test' } };
  const sandbox = new Function('document', 'window', 'setTimeout', 'fetch', 'console', appJs + '\nreturn { addEventLog, render, state };');
  const { addEventLog, render, state } = sandbox(globalDoc, globalWindow, () => {}, () => {}, { error(){}, warn(){}, log(){} });
  
  const payload = '<script>alert("xss")</script>';
  state.tickets.set('t1', { id: payload, phase: payload, model: payload, error: payload, detail: payload });
  render();
  
  const gridHtml = els['ticketsGrid'].innerHTML;
  assert.ok(!gridHtml.includes('<script>'));
  assert.ok(gridHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'ticketsGrid must escape ticket data correctly');

  // Ensure 0 is rendered correctly
  state.tickets.set('t2', { id: 't2', phase: 0, model: 0, strikes: 0, error: 0, detail: 0 });
  state.pools = { caps: { p1: 0 }, inFlight: { p1: 0 } };
  render();

  const gridHtml0 = els['ticketsGrid'].innerHTML;
  assert.ok(gridHtml0.includes('0'), 'Should render 0 correctly');
  
  const poolHtml0 = els['poolStatus'].innerHTML;
  assert.ok(poolHtml0.includes('0 / 0'), 'Should render 0 pool values correctly');
  
  addEventLog({ type: 'phase', ticket: payload, to: payload, detail: payload, ts: 0 });
  const logHtml = els['eventsLog'].children[0].innerHTML;
  assert.ok(!logHtml.includes('<script>'), 'eventsLog must escape event data');
});

import { spawn } from 'node:child_process';
test('sidecar: CLI launches server on custom port', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-cli-'));
  const binPath = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
  const pluginDir = mkdtempSync(join(tmpdir(), 'agb-test-plugin-dir-'));
  const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
  const child = spawn(process.execPath, [binPath, 'sidecar', repo, '--port', '0'], {
    stdio: 'pipe',
    env: { ...process.env, AGB_PLUGIN_DIR: pluginDir, AGB_AGY_BIN: fakeAgy, FAKE_STATE_DIR: pluginDir }
  });
  
  let timer;
  let boundPort;
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', d => {
        out += d.toString();
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m && out.includes('Successfully registered the dynamic sidecar plugin')) {
          boundPort = m[1];
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', code => {
        if (code !== 0) reject(new Error('Child exited with ' + code));
      });
      timer = setTimeout(() => reject(new Error('CLI sidecar startup timed out')), 4000);
    });
    
    
    const installs = readFileSync(join(pluginDir, 'plugin-installs'), 'utf8');
    assert.ok(installs.includes(pluginDir), 'Should invoke agy plugin install <pluginDir>');
    
    const resAuth = await fetchP(`http://127.0.0.1:${boundPort}/?token=test_token`);
    assert.equal(resAuth.statusCode, 403, 'Should reject wrong token');
    
    const manifestPath = join(pluginDir, 'sidecars', 'agb.json');
    const { statSync } = await import('node:fs');
    const stat = statSync(manifestPath);
    assert.equal(stat.mode & 0o777, 0o600, 'Manifest file should have restrictive 0o600 permissions');
    
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const tokenMatch = manifest.url.match(/token=([a-f0-9]+)/);
    const validToken = tokenMatch ? tokenMatch[1] : '';
    assert.ok(validToken, 'Should extract token from generated manifest');
    
    const resIndex = await fetchP(`http://127.0.0.1:${boundPort}/?token=${validToken}`);
    assert.equal(resIndex.statusCode, 200, 'Should allow authenticated index request');
    assert.equal(resIndex.headers['set-cookie'], undefined, 'Should not set any cookie');
    
    const res = await fetchP(`http://127.0.0.1:${boundPort}/events`);
    assert.equal(res.statusCode, 403, 'Should reject unauthenticated request');
    
    const authHeaders = { 'Authorization': `Bearer ${validToken}` };
    const resEvents = await fetchP(`http://127.0.0.1:${boundPort}/events`, authHeaders);
    assert.equal(resEvents.statusCode, 200, 'Should allow authenticated events request with Bearer token');
    
    const resApp = await fetchP(`http://127.0.0.1:${boundPort}/app.js`);
    assert.equal(resApp.statusCode, 200, 'Should allow asset request without token');
    
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', () => r());
      setTimeout(r, 200);
    });
    const { rmSync } = await import('node:fs');
    try { rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('sidecar: accepts Host without port', async () => {
  const { serveSidecar } = await import('../sidecars/server.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-host-'));
  const server = await serveSidecar(repo, 0);
  
  try {
    const res = await fetchP(`http://127.0.0.1:${server.address().port}/events`, { Host: '127.0.0.1' });
    assert.equal(res.statusCode, 200, 'should accept Host header without port');
  } finally {
    server.close();
  }
});

test('sidecar: accepts IPv6 loopback Host without port', async () => {
  const { serveSidecar } = await import('../sidecars/server.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-host-ipv6-'));
  const server = await serveSidecar(repo, 0);
  
  try {
    const res = await fetchP(`http://127.0.0.1:${server.address().port}/events`, { Host: '[::1]' });
    assert.equal(res.statusCode, 200, 'should accept [::1] Host header');
  } finally {
    server.close();
  }
});

test('sidecar: recovers from oversized lines without stalling', async () => {
  const { serveSidecar } = await import('../sidecars/server.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-large-'));
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  writeFileSync(join(repo, '.booster', 'run.json'), '{"runId":"r1"}');
  const eventsFile = join(repo, '.booster', 'logs', 'r1', 'events.jsonl');
  const server = await serveSidecar(repo, 0);
  
  try {
    const port = server.address().port;
    
    // Write an oversized line > 1MB, then a normal line
    const huge = '{"large":"' + 'a'.repeat(1024 * 1024 + 10) + '"}\n';
    const normal = '{"t": 1}\n';
    writeFileSync(eventsFile, huge + normal);
    
    const res1 = await fetchP(`http://127.0.0.1:${port}/events?offset=0`);
    const json1 = JSON.parse(res1.data);
    assert.equal(json1.lines.length, 1);
    assert.ok(json1.newOffset > 0, 'Offset should advance to skip oversized line');

    const res2 = await fetchP(`http://127.0.0.1:${port}/events?offset=${json1.newOffset}`);
    const json2 = JSON.parse(res2.data);
    // Eventually it should find the normal line
    const foundNormal = json2.lines.some(l => typeof l === 'string' && l.includes('"t": 1'));
    assert.ok(foundNormal, 'Should continue reading past oversized line');
  } finally {
    server.close();
  }
});
test('sidecar: recovers from oversized lines without stalling (multibyte boundary)', async () => {
  const { serveSidecar } = await import('../sidecars/server.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-large-mb-'));
  mkdirSync(join(repo, '.booster', 'logs', 'r2'), { recursive: true });
  writeFileSync(join(repo, '.booster', 'run.json'), '{"runId":"r2"}');
  const eventsFile = join(repo, '.booster', 'logs', 'r2', 'events.jsonl');
  const server = await serveSidecar(repo, 0);
  
  try {
    const port = server.address().port;
    
    // Write an oversized line > 1MB, then a normal line
    const hugePrefix = '{"large":"' + 'a'.repeat(1024 * 1024 - 15);
    // Emojis are 4 bytes. We will ensure the emoji crosses the 1MB (1048576) boundary
    const hugeSuffix = '👍👍👍👍👍👍👍👍👍👍"}\n';
    const huge = hugePrefix + hugeSuffix;
    const normal = '{"t": 1}\n';
    writeFileSync(eventsFile, huge + normal);

    const res1 = await fetchP(`http://127.0.0.1:${port}/events?offset=0`);
    const json1 = JSON.parse(res1.data);
    assert.equal(json1.lines.length, 1);
    assert.ok(json1.newOffset > 0, 'Offset should advance to skip oversized line');

    const res2 = await fetchP(`http://127.0.0.1:${port}/events?offset=${json1.newOffset}`);
    const json2 = JSON.parse(res2.data);
    
    const foundNormal = json2.lines.some(l => typeof l === 'string' && l.includes('"t": 1'));
    assert.ok(foundNormal, 'Should continue reading past oversized line with multibyte chars');
  } finally {
    server.close();
  }
});
