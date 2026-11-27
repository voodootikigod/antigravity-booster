import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveSidecar, resolveSafeEventsPath } from '../sidecars/server.mjs';
import { parseJetskiPort, writeTokenFile, readJetskiEvents, start as startJetskiLauncher } from '../sidecars/jetski-launcher.mjs';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

  // When state.pools is reset to null and state.tickets is cleared, render() clears both DOM containers
  state.pools = null;
  state.tickets.clear();
  render();
  assert.equal(els['poolStatus'].innerHTML, '', 'poolStatus must be cleared when state.pools is null');
  assert.equal(els['ticketsGrid'].innerHTML, '', 'ticketsGrid must be cleared when state.tickets is empty');
});

test('sidecar: index.html and app.js render split telemetry SSE events safely', () => {
  const sidecarsDir = join(dirname(fileURLToPath(import.meta.url)), '../sidecars');
  const indexHtml = readFileSync(join(sidecarsDir, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="telemetryStrip"'), 'index.html must include telemetryStrip container');

  const appJs = readFileSync(join(sidecarsDir, 'app.js'), 'utf8');
  const els = {};
  const globalDoc = {
    createElement(tag) { return { tag, className: '', innerHTML: '', remove() {} }; },
    getElementById(id) {
      els[id] = els[id] || {
        innerHTML: '',
        style: {},
        children: [],
        prepend(el) { this.children.unshift(el); },
        remove() {},
        get lastChild() { return this.children[this.children.length - 1]; },
      };
      return els[id];
    },
  };
  const globalWindow = { location: { search: '?token=test' } };
  const sandbox = new Function(
    'document',
    'window',
    'setTimeout',
    'fetch',
    'console',
    appJs + '\nreturn { processEvent, render, state };'
  );
  const { processEvent, render, state } = sandbox(globalDoc, globalWindow, () => {}, () => {}, { error() {}, warn() {}, log() {} });

  processEvent({
    ts: Date.now(),
    type: 'telemetry',
    telemetry: {
      buildTokens: 900,
      prosecutionTokens: 250,
      reviewTokens: 150,
      system1Calls: 3,
      hollowShortCircuits: 1,
      skippedLenses: ['simplicity'],
    },
  });
  render();

  const stripHtml = els['telemetryStrip'].innerHTML;
  assert.ok(stripHtml.includes('Build') && stripHtml.includes('900 tok'));
  assert.ok(stripHtml.includes('Prosecute') && stripHtml.includes('250 tok'));
  assert.ok(stripHtml.includes('Review') && stripHtml.includes('150 tok'));
  assert.ok(stripHtml.includes('Sys1') && stripHtml.includes('3 calls'));
  assert.ok(stripHtml.includes('Hollow-SC') && stripHtml.includes('1'));
  assert.ok(stripHtml.includes('Skip-Lens') && stripHtml.includes('1'));
  assert.equal(els['telemetryStrip'].style.display, 'flex');

  const logHtml = els['eventsLog'].children[0].innerHTML;
  assert.ok(logHtml.includes('Telemetry: Build'));

  // XSS escaping in telemetry payload
  processEvent({
    ts: Date.now(),
    type: 'telemetry',
    telemetry: {
      buildTokens: '<script>x</script>',
      prosecutionTokens: 0,
      reviewTokens: 0,
      system1Calls: 0,
    },
  });
  render();
  assert.equal(els['telemetryStrip'].innerHTML.includes('<script>'), false);

  // Clearing telemetry hides strip
  state.telemetry = null;
  render();
  assert.equal(els['telemetryStrip'].innerHTML, '');
  assert.equal(els['telemetryStrip'].style.display, 'none');
});

import { spawn } from 'node:child_process';
test('sidecar: CLI launches clean localhost server on custom port without dynamic plugin side-effects', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-cli-'));
  const binPath = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-sidecar-home-'));
  const fakeState = mkdtempSync(join(tmpdir(), 'agb-sidecar-state-'));
  const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
  const child = spawn(process.execPath, [binPath, 'sidecar', repo, '--port', '0'], {
    stdio: 'pipe',
    env: { ...process.env, HOME: fakeHome, AGB_HOME_DIR: fakeHome, AGB_AGY_BIN: fakeAgy, FAKE_STATE_DIR: fakeState }
  });
  
  let timer;
  let boundPort;
  let validToken;
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', d => {
        out += d.toString();
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]{32})/);
        if (m) {
          boundPort = m[1];
          validToken = m[2];
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', code => {
        if (code !== 0) reject(new Error('Child exited with ' + code));
      });
      timer = setTimeout(() => reject(new Error('CLI sidecar startup timed out')), 4000);
    });
    
    const { existsSync, readdirSync } = await import('node:fs');
    assert.equal(existsSync(join(fakeState, 'plugin-installs')), false, 'Should never invoke agy plugin install');
    assert.equal(existsSync(join(fakeHome, '.gemini')), false, 'Should create zero agb-sidecar-plugin-* dirs under ~/.gemini');
    assert.deepEqual(readdirSync(fakeHome), [], 'Should write zero files to HOME');
    
    const resAuth = await fetchP(`http://127.0.0.1:${boundPort}/?token=test_token`);
    assert.equal(resAuth.statusCode, 403, 'Should reject wrong token');
    assert.ok(validToken, 'Should extract valid 128-bit hex token from stdout URL');
    
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
    try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
    try { rmSync(fakeState, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
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
    assert.equal(json1.warning, 'Dropped oversized line');
    assert.equal(json1.newOffset, Buffer.byteLength(huge, 'utf8'), 'Offset should advance past the entire oversized line on first poll');

    const res2 = await fetchP(`http://127.0.0.1:${port}/events?offset=${json1.newOffset}`);
    const json2 = JSON.parse(res2.data);
    assert.equal(json2.warning, undefined, 'Second poll should not emit a spurious corrupt-JSON warning');
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

test('sidecar: serves dashboard static web assets (index.html, app.js, style.css)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-assets-'));
  const token = 'test-token-1234';
  const server = await serveSidecar(repo, 0, token);
  try {
    const port = server.address().port;
    const resHtml = await fetchP(`http://127.0.0.1:${port}/?token=${token}`);
    assert.equal(resHtml.statusCode, 200);
    assert.match(resHtml.data, /<!DOCTYPE html>/i);

    const resJs = await fetchP(`http://127.0.0.1:${port}/app.js?token=${token}`);
    assert.equal(resJs.statusCode, 200);

    const resCss = await fetchP(`http://127.0.0.1:${port}/style.css?token=${token}`);
    assert.equal(resCss.statusCode, 200);
  } finally {
    server.close();
  }
});

test('jetski-launcher: parseJetskiPort strictly validates integers in 1..65535', () => {
  assert.equal(parseJetskiPort('1'), 1);
  assert.equal(parseJetskiPort('3333'), 3333);
  assert.equal(parseJetskiPort('65535'), 65535);

  for (const invalid of ['0', '00', '65536', '99999', '-1', 'false', 'true', 'abc', '3333.5', ' 3333', '3333 ', '0x10', '', undefined, null]) {
    assert.equal(parseJetskiPort(invalid), null, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
});

test('jetski-launcher: non-port ANTIGRAVITY_SIDECAR_WEB_PORT values do not disable token auth', async () => {
  for (const rawPort of ['0', 'false', 'abc', '65536']) {
    const repo = mkdtempSync(join(tmpdir(), 'agb-jetski-port-'));
    let server;
    try {
      server = await startJetskiLauncher({
        repoPath: repo,
        env: { ANTIGRAVITY_SIDECAR_WEB_PORT: rawPort },
        defaultPort: 0,
      });
      const port = server.address().port;
      const tokenPath = join(repo, '.booster', 'token');
      assert.equal(existsSync(tokenPath), true, `token file must be created for invalid port ${rawPort}`);
      const token = readFileSync(tokenPath, 'utf8').trim();
      assert.match(token, /^[0-9a-f]{32}$/, 'generated 16-byte CSPRNG token must be 32 hex chars');

      assert.equal((await fetchP(`http://127.0.0.1:${port}/`)).statusCode, 403);
      assert.equal((await fetchP(`http://127.0.0.1:${port}/events`)).statusCode, 403);
      assert.equal((await fetchP(`http://127.0.0.1:${port}/?token=${token}`)).statusCode, 200);
      assert.equal((await fetchP(`http://127.0.0.1:${port}/events`, { Authorization: `Bearer ${token}` })).statusCode, 200);
    } finally {
      server?.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('jetski-launcher: writeTokenFile rejects symlinks on .booster and .booster/token and surfaces errors', () => {
  const outside = mkdtempSync(join(tmpdir(), 'agb-token-outside-'));
  const outsideFile = join(outside, 'victim.txt');
  writeFileSync(outsideFile, 'original-secret', { mode: 0o644 });
  chmodSync(outsideFile, 0o644);

  // Case 1: .booster is a live symlink
  const repo1 = mkdtempSync(join(tmpdir(), 'agb-token-symdir-'));
  try {
    symlinkSync(outside, join(repo1, '.booster'));
    assert.throws(() => writeTokenFile(repo1, 'new-token'), /symbolic link/i);
    assert.equal(existsSync(join(outside, 'token')), false, 'must not write through symlinked .booster');
  } finally {
    rmSync(repo1, { recursive: true, force: true });
  }

  // Case 2: .booster is a dangling symlink
  const repo2 = mkdtempSync(join(tmpdir(), 'agb-token-danglingdir-'));
  try {
    symlinkSync(join(outside, 'does-not-exist'), join(repo2, '.booster'));
    assert.throws(() => writeTokenFile(repo2, 'new-token'), /symbolic link/i);
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }

  // Case 3: .booster/token is a symlink to an outside file
  const repo3 = mkdtempSync(join(tmpdir(), 'agb-token-symfile-'));
  try {
    mkdirSync(join(repo3, '.booster'), { recursive: true });
    symlinkSync(outsideFile, join(repo3, '.booster', 'token'));
    assert.throws(() => writeTokenFile(repo3, 'new-token'), /symbolic link/i);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'original-secret', 'must not overwrite symlink target');
    if (process.platform !== 'win32') {
      assert.equal(statSync(outsideFile).mode & 0o777, 0o644, 'must not chmod symlink target');
    }
  } finally {
    rmSync(repo3, { recursive: true, force: true });
  }

  // Case 4: .booster is a regular file (not a directory)
  const repo4 = mkdtempSync(join(tmpdir(), 'agb-token-notdir-'));
  try {
    writeFileSync(join(repo4, '.booster'), 'not-a-dir');
    assert.throws(() => writeTokenFile(repo4, 'new-token'), /not a directory/i);
  } finally {
    rmSync(repo4, { recursive: true, force: true });
  }

  // Case 5: Subprocess launcher fails closed with error on stderr when .booster is symlinked and port is invalid ("false")
  const repo5 = mkdtempSync(join(tmpdir(), 'agb-token-subproc-'));
  const launcherPath = fileURLToPath(new URL('../sidecars/jetski-launcher.mjs', import.meta.url));
  try {
    symlinkSync(outside, join(repo5, '.booster'));
    const res = spawnSync(process.execPath, [launcherPath, repo5], {
      env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: 'false' },
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0, 'launcher must exit non-zero on token write symlink error');
    assert.match(res.stderr, /Failed to write sidecar token:.*symbolic link/i);
    assert.equal(existsSync(join(outside, 'token')), false);
  } finally {
    rmSync(repo5, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('sidecar & jetski /events readers reject empty, whitespace, and invalid runId', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-empty-runid-'));
  mkdirSync(join(repo, '.booster', 'logs'), { recursive: true });
  // Place a decoy file at .booster/logs/events.jsonl that empty runId would previously resolve to
  writeFileSync(join(repo, '.booster', 'logs', 'events.jsonl'), '{"leaked":true}\n');

  const srv = await serveSidecar(repo, 0);
  try {
    const port = srv.address().port;
    for (const payload of [{ runId: '' }, { runId: '   ' }, { runId: '\t\n' }, { runId: '../escape' }, {}]) {
      writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify(payload));

      const res = await fetchP(`http://127.0.0.1:${port}/events`);
      assert.equal(res.statusCode, 400, `server.mjs must reject ${JSON.stringify(payload)}`);
      const body = JSON.parse(res.data);
      assert.deepEqual(body.lines, []);
      assert.equal(body.runId, null);
      assert.match(body.error, /runId/i);

      const jetskiBody = readJetskiEvents(repo, { offset: 0 });
      assert.deepEqual(jetskiBody.lines, []);
      assert.equal(jetskiBody.runId, null);
      assert.match(jetskiBody.error, /runId/i);
    }
  } finally {
    srv.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('sidecar & jetski /events readers reject symlinked .booster, run.json, logs, run dir, and events.jsonl', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'agb-sidecar-outside-'));
  mkdirSync(join(outside, 'logs', 'r1'), { recursive: true });
  const secretEvents = join(outside, 'logs', 'r1', 'events.jsonl');
  writeFileSync(secretEvents, '{"secret":"should-not-leak"}\n');
  const outsideRunJson = join(outside, 'run.json');
  writeFileSync(outsideRunJson, JSON.stringify({ runId: 'r1' }));

  const cases = [
    {
      name: 'symlinked .booster',
      setup: (repo) => {
        symlinkSync(outside, join(repo, '.booster'));
      },
    },
    {
      name: 'symlinked .booster/run.json',
      setup: (repo) => {
        mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
        symlinkSync(outsideRunJson, join(repo, '.booster', 'run.json'));
        writeFileSync(join(repo, '.booster', 'logs', 'r1', 'events.jsonl'), '{"secret":"no"}\n');
      },
    },
    {
      name: 'symlinked .booster/logs',
      setup: (repo) => {
        mkdirSync(join(repo, '.booster'), { recursive: true });
        writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r1' }));
        symlinkSync(join(outside, 'logs'), join(repo, '.booster', 'logs'));
      },
    },
    {
      name: 'symlinked .booster/logs/<runId>',
      setup: (repo) => {
        mkdirSync(join(repo, '.booster', 'logs'), { recursive: true });
        writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r1' }));
        symlinkSync(join(outside, 'logs', 'r1'), join(repo, '.booster', 'logs', 'r1'));
      },
    },
    {
      name: 'symlinked events.jsonl',
      setup: (repo) => {
        mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
        writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r1' }));
        symlinkSync(secretEvents, join(repo, '.booster', 'logs', 'r1', 'events.jsonl'));
      },
    },
  ];

  try {
    for (const c of cases) {
      const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-sym-'));
      c.setup(repo);
      const srv = await serveSidecar(repo, 0);
      try {
        const port = srv.address().port;
        const resolved = resolveSafeEventsPath(repo);
        assert.equal(resolved.ok, false, `${c.name}: resolveSafeEventsPath must fail`);
        assert.equal(resolved.code, 'SYMLINK', `${c.name}: expected SYMLINK code`);

        const res = await fetchP(`http://127.0.0.1:${port}/events`);
        assert.equal(res.statusCode, 403, `${c.name}: server.mjs must return 403`);
        const body = JSON.parse(res.data);
        assert.deepEqual(body.lines, [], `${c.name}: server.mjs must not return lines`);
        assert.match(body.error, /symlink/i);

        const jetskiBody = readJetskiEvents(repo, { offset: 0 });
        assert.deepEqual(jetskiBody.lines, [], `${c.name}: jetski-launcher must not return lines`);
        assert.equal(jetskiBody.runId, null);
        assert.match(jetskiBody.error, /symlink/i);
      } finally {
        srv.close();
        rmSync(repo, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('jetski-launcher: readJetskiEvents reads valid events and advances offset', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-jetski-events-ok-'));
  try {
    mkdirSync(join(repo, '.booster', 'logs', 'r-ok'), { recursive: true });
    writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r-ok' }));
    writeFileSync(join(repo, '.booster', 'logs', 'r-ok', 'events.jsonl'), '{"t":1}\n{"t":2}\n');

    const r1 = readJetskiEvents(repo, { offset: 0 });
    assert.equal(r1.error, undefined);
    assert.equal(r1.runId, 'r-ok');
    assert.deepEqual(r1.lines, ['{"t":1}', '{"t":2}']);
    assert.equal(r1.newOffset, 16);

    const r2 = readJetskiEvents(repo, { offset: r1.newOffset });
    assert.deepEqual(r2.lines, []);
    assert.equal(r2.newOffset, 16);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('sidecar --cloud (allowProxyHost): enforces mandatory CSPRNG token and constant-time query/Bearer/cookie auth on proxy Host headers', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-sidecar-cloud-'));
  try {
    mkdirSync(join(repo, '.booster', 'logs', 'r-cloud'), { recursive: true });
    writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify({ runId: 'r-cloud' }));
    writeFileSync(join(repo, '.booster', 'logs', 'r-cloud', 'events.jsonl'), '{"cloud":true}\n');

    // 1. allowProxyHost without a non-empty token is rejected immediately
    await assert.rejects(
      serveSidecar(repo, 0, null, { allowProxyHost: true }),
      /non-empty token is required/
    );

    const secret = 'deadbeefcafebabe0123456789abcdef';
    const srv = await serveSidecar(repo, 0, secret, { allowProxyHost: true });
    try {
      const port = srv.address().port;
      const proxyHost = '3333-devbox-proxy.example.com';

      // 2. Non-loopback Host WITHOUT valid token is rejected (403) on ALL routes, including /style.css
      const noTokRoot = await fetchP(`http://127.0.0.1:${port}/`, { Host: proxyHost });
      assert.equal(noTokRoot.statusCode, 403);
      const noTokCss = await fetchP(`http://127.0.0.1:${port}/style.css`, { Host: proxyHost });
      assert.equal(noTokCss.statusCode, 403);
      const badTokEvents = await fetchP(`http://127.0.0.1:${port}/events?token=wrong`, { Host: proxyHost });
      assert.equal(badTokEvents.statusCode, 403);

      // 3. Visiting /?token=<secret> over proxy Host succeeds (200) and sets HttpOnly SameSite=Lax cookie
      const okRoot = await fetchP(`http://127.0.0.1:${port}/?token=${secret}`, { Host: proxyHost });
      assert.equal(okRoot.statusCode, 200);
      const setCookie = String(okRoot.headers['set-cookie'] ?? '');
      assert.match(setCookie, /agb_sidecar_token=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);

      // 4. Subsequent subresource & /events requests over proxy Host succeed using Cookie or Bearer token
      const cookieHeader = `agb_sidecar_token=${secret}`;
      const okCss = await fetchP(`http://127.0.0.1:${port}/style.css`, { Host: proxyHost, Cookie: cookieHeader });
      assert.equal(okCss.statusCode, 200);

      const okEventsCookie = await fetchP(`http://127.0.0.1:${port}/events`, { Host: proxyHost, Cookie: cookieHeader });
      assert.equal(okEventsCookie.statusCode, 200);
      assert.deepEqual(JSON.parse(okEventsCookie.data).lines, ['{"cloud":true}']);

      const okEventsBearer = await fetchP(`http://127.0.0.1:${port}/events`, {
        Host: proxyHost,
        Authorization: `Bearer ${secret}`,
      });
      assert.equal(okEventsBearer.statusCode, 200);
    } finally {
      srv.close();
    }

    // 5. startJetskiLauncher with allowProxyHost: true generates CSPRNG token and accepts authenticated proxy Host
    const launcherRepo = mkdtempSync(join(tmpdir(), 'agb-jetski-proxy-'));
    let launcherSrv;
    try {
      launcherSrv = await startJetskiLauncher({
        repoPath: launcherRepo,
        env: {},
        defaultPort: 0,
        allowProxyHost: true,
      });
      const lPort = launcherSrv.address().port;
      const lToken = readFileSync(join(launcherRepo, '.booster', 'token'), 'utf8').trim();
      const pHost = 'devbox-proxy.antigravity.google:8080';
      assert.match(lToken, /^[0-9a-f]{32}$/);
      assert.equal((await fetchP(`http://127.0.0.1:${lPort}/`, { Host: pHost })).statusCode, 403);
      assert.equal((await fetchP(`http://127.0.0.1:${lPort}/?token=${lToken}`, { Host: pHost })).statusCode, 200);
    } finally {
      launcherSrv?.close();
      rmSync(launcherRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

