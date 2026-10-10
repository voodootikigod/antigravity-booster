import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { iaPaths, localRefs } from '../check-site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'check-site.mjs');
const FIX = path.join(HERE, 'fixtures', 'check-site');
// 1x1 PNG signature is enough: check (g) inspects status and content-type only.
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const page = (body) => ({ status: 200, type: 'text/html', body: `<html><body>${body}</body></html>` });

function routes(mode) {
  const ok = {
    '/': page(
      'These docs track main. Latest release: v9.8.7. <a href="/docs">Docs</a> <a href="https://example.com/x">ext</a>',
    ),
    '/docs': page(
      '<a href="/docs/getting-started/installation#prereqs">Install</a><link href="/style.css"><a href="/api/search">s</a>',
    ),
    '/docs/getting-started/installation': page('<img src="/og/docs/getting-started/installation/image.png">'),
    '/docs/project/design-history': page('<div>Historical, superseded</div>'),
    '/style.css': { status: 200, type: 'text/css', body: 'body{}' },
    '/llms.txt': { status: 200, type: 'text/plain', body: '- [Installation](/docs/getting-started/installation)\n' },
    '/og/docs/getting-started/installation/image.png': { status: 200, type: 'image/png', body: PNG },
    '/api/search?query=rails-guard': {
      status: 200,
      type: 'application/json',
      body: JSON.stringify([{ id: '1', url: '/docs/concepts/rail-enforcement' }]),
    },
    '/api/search?query=Design%20history': { status: 200, type: 'application/json', body: '[]' },
  };
  if (mode === 'pass') return ok;
  if (mode === 'og-status')
    return {
      ...ok,
      // No <img> link to the OG route here, so only check (g) can catch the 500.
      '/docs/getting-started/installation': page('Install'),
      '/og/docs/getting-started/installation/image.png': { status: 500, type: 'image/png', body: PNG },
    };
  return {
    ...ok,
    '/': page('These docs track main. Latest release: v0.0.1. <a href="/docs/">Docs</a>'),
    '/docs/getting-started/installation': { status: 404, type: 'text/html', body: 'nope' },
    '/docs/project/design-history': page('<div>no banner</div>'),
    '/style.css': { status: 404, type: 'text/css', body: 'gone' },
    '/llms.txt': { status: 200, type: 'text/plain', body: '- [History](/docs/project/design-history/agy-cli)\n' },
    '/og/docs/getting-started/installation/image.png': { status: 200, type: 'text/html', body: 'x' },
    '/api/search?query=rails-guard': { status: 200, type: 'application/json', body: '[]' },
    '/api/search?query=Design%20history': {
      status: 200,
      type: 'application/json',
      body: JSON.stringify([{ url: '/docs/project/design-history' }, { url: '/docs/project/design-history/agy-cli' }]),
    },
  };
}

async function withServer(mode, fn) {
  const table = routes(mode);
  const server = createServer((req, res) => {
    if (req.url === '/docs/') {
      res.writeHead(308, { location: '/docs' }).end();
      return;
    }
    const r = table[req.url];
    if (!r) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(r.status, { 'content-type': r.type }).end(r.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

test('iaPaths maps the root index to /docs and folder index to the folder', () => {
  assert.deepEqual(iaPaths(['index', '---X---', { dir: 'a', pages: ['index', 'b'] }]), [
    '/docs',
    '/docs/a',
    '/docs/a/b',
  ]);
});

test('localRefs keeps root-relative refs only and drops fragments', () => {
  const refs = localRefs(
    '<a href="/a#x"></a><img src=\'/b?x=1&amp;y=2\'><a href="//cdn/x"></a><a href="https://e.com/"></a>',
  );
  assert.deepEqual([...refs].sort(), ['/a', '/b?x=1&y=2']);
});

test('check-site passes against a passing fixture server', async () => {
  const r = await withServer('pass', (url) => runCli(['--base-url', url, '--root', path.join(FIX, 'pass', 'website')]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check-site: ok/);
});

test('check-site reports every failing check (a)-(g) against a failing fixture server', async () => {
  const r = await withServer('fail', (url) => runCli(['--base-url', url, '--root', path.join(FIX, 'fail', 'website')]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/docs\/getting-started\/installation: \(a\) expected 200, got 404/);
  assert.match(r.stderr, /\(b\) link \/docs\/ returned 308/);
  assert.match(r.stderr, /\/docs: \(b\) link \/style\.css returned 404/);
  assert.match(r.stderr, /query=rails-guard: \(c\) no results/);
  assert.match(r.stderr, /query=Design%20history: \(c\) design-history result/);
  assert.match(r.stderr, /\/llms\.txt: \(d\) missing/);
  assert.match(r.stderr, /\/llms\.txt: \(d\) contains design history/);
  assert.match(r.stderr, /\/: \(e\) missing "Latest release: v9\.8\.7"/);
  assert.match(r.stderr, /\/docs\/project\/design-history: \(f\) missing/);
  assert.match(r.stderr, /image\.png: \(g\) expected 200 image\/png/);
});

test('check-site (g) rejects a non-200 OG response even with an image/png content type', async () => {
  const r = await withServer('og-status', (url) =>
    runCli(['--base-url', url, '--root', path.join(FIX, 'pass', 'website')]),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /image\.png: \(g\) expected 200 image\/png, got 500 image\/png/);
  assert.doesNotMatch(r.stderr, /\((a|b|c|d|e|f)\)/);
});

test('check-site refuses a non-127.0.0.1 --base-url', async () => {
  const r = await runCli(['--base-url', 'http://example.com', '--root', path.join(FIX, 'pass', 'website')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be on 127\.0\.0\.1/);
});

test('check-site fails fast without a build', async () => {
  const r = await runCli(['--root', path.join(FIX, 'pass', 'website'), '--port', '4399']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run `npm run build` first/);
});
