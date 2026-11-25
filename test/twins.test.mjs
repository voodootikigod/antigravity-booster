import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateTwinsConfig,
  isAllowedTwinEnvVar,
  startDigitalTwins,
  buildTwinGateEnv,
} from '../lib/twins.mjs';

test('validateTwinsConfig enforces safe envVar names, valid HTTP routes, and CRLF-free headers', () => {
  assert.deepEqual(validateTwinsConfig(undefined), []);
  assert.equal(isAllowedTwinEnvVar('API_BASE_URL'), true);
  assert.equal(isAllowedTwinEnvVar('STRIPE_MOCK_URL'), true);
  assert.equal(isAllowedTwinEnvVar('NODE_OPTIONS'), false);
  assert.equal(isAllowedTwinEnvVar('PATH'), false);
  assert.equal(isAllowedTwinEnvVar('AGB_WORKER_TICKET'), false);
  assert.equal(isAllowedTwinEnvVar('ADLC_MANIFEST_KEY'), false);
  assert.equal(isAllowedTwinEnvVar('API_SECRET_KEY'), false);
  assert.equal(isAllowedTwinEnvVar('LD_PRELOAD'), false);

  const errs = validateTwinsConfig([
    {
      name: 'bad twin',
      envVar: 'NODE_OPTIONS',
      routes: [
        { method: 'TRACE', path: 'missing-slash', status: 999, headers: { 'X-Bad': 'line1\r\nEvil: 1' } },
      ],
    },
  ]);
  assert.ok(errs.length >= 4);
});

test('startDigitalTwins serves loopback HTTP routes on 127.0.0.1:0 and destroys keep-alive sockets on stop()', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'agb-twins-rt-'));
  let handle = null;
  try {
    handle = await startDigitalTwins(
      [
        {
          name: 'billing',
          envVar: 'BILLING_BASE_URL',
          routes: [
            { method: 'GET', path: '/v1/Subscription', status: 200, body: { active: true, plan: 'pro' } },
            { method: 'POST', path: '/v1/charges/*', status: 201, headers: { 'X-Twin': 'ok' }, body: { id: 'ch_1' } },
          ],
        },
      ],
      { runtimeRoot }
    );

    assert.match(handle.env.BILLING_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);

    const getRes = await fetch(`${handle.env.BILLING_BASE_URL}/v1/Subscription`);
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), { active: true, plan: 'pro' });

    const postRes = await fetch(`${handle.env.BILLING_BASE_URL}/v1/charges/abc`, { method: 'POST' });
    assert.equal(postRes.status, 201);
    assert.equal(postRes.headers.get('x-twin'), 'ok');
    assert.deepEqual(await postRes.json(), { id: 'ch_1' });

    const missRes = await fetch(`${handle.env.BILLING_BASE_URL}/unknown`);
    assert.equal(missRes.status, 404);
    assert.equal(handle.requests.length, 3);

    const instanceDir = handle.instanceDir;
    assert.equal(existsSync(instanceDir), true);
    await handle.stop();
    assert.equal(existsSync(instanceDir), false, 'runtime preload dir must be cleaned on stop()');
  } finally {
    if (handle) await handle.stop();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('buildTwinGateEnv preload interceptor serves fetch and http.get in child process even after TCP server is closed (simulating --unshare-net)', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'agb-twins-preload-'));
  const handle = await startDigitalTwins(
    [
      {
        name: 'catalog',
        envVar: 'CATALOG_URL',
        routes: [
          { method: 'GET', path: '/items', status: 200, body: { items: ['alpha', 'beta'] } },
        ],
      },
    ],
    { runtimeRoot }
  );
  try {
    const gateEnv = buildTwinGateEnv(process.env, handle, { sandboxed: true });
    assert.match(gateEnv.NODE_OPTIONS, /--import=file:\/\//);

    // Close ONLY the underlying TCP server socket first? Even better: verify child process gets twin response
    // AND non-twin closed port (127.0.0.1:1) is NOT intercepted and fails closed!
    const script = [
      'import http from "node:http";',
      'import assert from "node:assert/strict";',
      'const r1 = await fetch(process.env.CATALOG_URL + "/items");',
      'assert.equal(r1.status, 200);',
      'const j1 = await r1.json();',
      'assert.deepEqual(j1, { items: ["alpha", "beta"] });',
      'const j2 = await new Promise((resolve, reject) => {',
      '  http.get(process.env.CATALOG_URL + "/items", (res) => {',
      '    let body = "";',
      '    res.on("data", (c) => body += c);',
      '    res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(body) }));',
      '  }).on("error", reject);',
      '});',
      'assert.equal(j2.status, 200);',
      'assert.deepEqual(j2.data, { items: ["alpha", "beta"] });',
      'let externalBlocked = false;',
      'try { await fetch("http://127.0.0.1:1/nope"); } catch { externalBlocked = true; }',
      'assert.equal(externalBlocked, true);',
      'console.log("PRELOAD_OK");',
    ].join('\n');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: gateEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.match(out, /PRELOAD_OK/);
    // Because fetch & http.get were intercepted in-memory inside the child process,
    // the host TCP server received 0 network packets!
    assert.equal(handle.requests.length, 0, 'preload must satisfy twin requests in-memory without touching host sockets');
  } finally {
    await handle.stop();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
