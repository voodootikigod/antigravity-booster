import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import {
  hasFrontendChanges,
  isLoopbackBrowserUrl,
  resolveBrowserGateConfig,
  runBrowserGate,
} from '../lib/browser-gate.mjs';
import { runGateTicket } from '../lib/gate-ticket.mjs';

// Minimal valid 1x1 transparent PNG
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('hasFrontendChanges and isLoopbackBrowserUrl strictly classify frontend diffs and block non-loopback SSRF URLs', () => {
  assert.equal(hasFrontendChanges(null), false);
  assert.equal(hasFrontendChanges(['lib/scheduler.mjs', 'test/ui.test.tsx', 'components/Button.test.tsx', 'app/Card.spec.jsx']), false);
  assert.equal(hasFrontendChanges(['src/App.tsx']), true);
  assert.equal(hasFrontendChanges(['website/content/docs/index.mdx']), true);
  assert.equal(hasFrontendChanges(['styles/main.css']), true);

  const cwd = process.cwd();
  assert.equal(resolveBrowserGateConfig(cwd, {}, { changedFiles: ['src/App.tsx'], runId: 'run-29', env: {} }).runId, 'run-29');
  assert.equal(resolveBrowserGateConfig(cwd, {}, { changedFiles: ['src/App.tsx'], runId: 'r'.repeat(80), env: {} }).runId, 'r'.repeat(80));
  assert.equal(resolveBrowserGateConfig(cwd, {}, { changedFiles: ['src/App.tsx'], runId: 'r'.repeat(81), env: {} }).runId, 'gate-ticket');
  assert.equal(resolveBrowserGateConfig(cwd, {}, { changedFiles: ['src/App.tsx'], runId: '', env: {} }).runId, 'gate-ticket');

  assert.equal(isLoopbackBrowserUrl('http://127.0.0.1:3000'), true);
  assert.equal(isLoopbackBrowserUrl('http://localhost:4173/dashboard'), true);
  assert.equal(isLoopbackBrowserUrl('https://[::1]:8443'), true);
  assert.equal(isLoopbackBrowserUrl(''), false);
  assert.equal(isLoopbackBrowserUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isLoopbackBrowserUrl('https://example.com:3000'), false);
  assert.equal(isLoopbackBrowserUrl('http://user:pass@127.0.0.1:3000'), false);
  assert.equal(isLoopbackBrowserUrl('file:///etc/passwd'), false);
});

test('runBrowserGate enforces Wave 2 A9 policy (enforced vs advisory), captures screenshots safely, and integrates with runGateTicket', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-browser-gate-'));
  let mode = 'ok';
  const srv = createServer((req, res) => {
    if (mode === '500' || req.url === '/boom') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
      return;
    }
    if (mode === 'console-err') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'x-agb-console-errors': '2' });
      res.end('<html></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>ok</body></html>');
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const localUrl = `http://127.0.0.1:${port}`;

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1, securityMode: 'unsigned-fallback' }, null, 2) + '\n');
    initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app', 'View.tsx'), 'export const View = () => null;\n');

    // 1. Non-frontend diff with no browserGate skips cleanly
    const skipRes = await runBrowserGate(repo, { id: 'T-BG' }, { changedFiles: ['lib/core.mjs'], env: {} });
    assert.equal(skipRes.ok, true);
    assert.equal(skipRes.skipped, true);

    // 2. Undeclared frontend diff without driver degrades cleanly on headless/SSH hosts (A9 advisory)
    const advUnconf = await runBrowserGate(repo, { id: 'T-BG' }, { changedFiles: ['app/View.tsx'], env: {} });
    assert.equal(advUnconf.ok, true);
    assert.equal(advUnconf.skipped, true);
    assert.equal(advUnconf.advisory, true);

    // 3. Explicit ticket.browserGate without driver FAILS CLOSED (A9 enforced)
    const enfUnconf = await runBrowserGate(
      repo,
      { id: 'T-BG', browserGate: { routes: ['/'] } },
      { changedFiles: ['app/View.tsx'], env: {} }
    );
    assert.equal(enfUnconf.ok, false);
    assert.equal(enfUnconf.enforced, true);
    assert.equal(enfUnconf.kind, 'browser_gate_unconfigured');

    // 4. Non-loopback URL is rejected even in advisory mode (SSRF defense)
    const ssrfRes = await runBrowserGate(
      repo,
      { id: 'T-BG' },
      { changedFiles: ['app/View.tsx'], browserUrl: 'http://10.0.0.1:8080', env: {} }
    );
    assert.equal(ssrfRes.ok, false);
    assert.equal(ssrfRes.kind, 'invalid_browser_url');

    // 5. Enforced browserGate fails closed on HTTP 5xx and console errors, and advisory returns ok:true with warning
    mode = '500';
    const enf500 = await runBrowserGate(
      repo,
      { id: 'T-BG', browserGate: { url: localUrl, routes: ['/'] } },
      { changedFiles: ['app/View.tsx'], env: {} }
    );
    assert.equal(enf500.ok, false);
    assert.equal(enf500.enforced, true);
    assert.equal(enf500.serverErrors.length, 1);

    const adv500 = await runBrowserGate(
      repo,
      { id: 'T-BG' },
      { changedFiles: ['app/View.tsx'], browserUrl: localUrl, env: {} }
    );
    assert.equal(adv500.ok, true);
    assert.equal(adv500.advisory, true);
    assert.match(adv500.warning, /HTTP 502/);

    mode = 'console-err';
    const enfConsole = await runBrowserGate(
      repo,
      { id: 'T-BG', browserGate: { url: localUrl, routes: ['dashboard'] } },
      { changedFiles: ['app/View.tsx'], env: {} }
    );
    assert.equal(enfConsole.ok, false);
    assert.equal(enfConsole.consoleErrors.length, 1);

    // 6. Clean pass with checkCmd + verified PNG screenshot capture + symlink rejection + runGateTicket integration
    mode = 'ok';
    const rawShotPath = join(repo, 'shot.png');
    writeFileSync(rawShotPath, ONE_PIXEL_PNG);
    const checkScript = `node -e 'console.log(JSON.stringify({ consoleErrors: [], serverErrors: [], screenshots: ["shot.png"] }))'`;

    writeFileSync(
      join(repo, '.adlc', 'tickets', ticketFilename('T-BG-1')),
      JSON.stringify(
        {
          id: 'T-BG-1',
          title: 'Frontend visual ticket',
          body: 'Update View.tsx',
          scope: ['app/**'],
          rails: [],
          edges: [],
          browserGate: { url: localUrl, routes: ['/'], checkCmd: checkScript },
        },
        null,
        2
      ) + '\n'
    );
    execFileSync('git', ['add', '.adlc/config.json', '.adlc/tickets', 'app/View.tsx'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    rmSync(rawShotPath, { force: true });
    const shotTmp = mkdtempSync(join(tmpdir(), 'agb-shot-src-'));
    const extShot = join(shotTmp, 'home.png');
    writeFileSync(extShot, ONE_PIXEL_PNG);

    try {
      // Update ticket checkCmd to point to extShot & modify app/View.tsx in scope
      writeFileSync(
        join(repo, '.adlc', 'tickets', ticketFilename('T-BG-1')),
        JSON.stringify(
          {
            id: 'T-BG-1',
            title: 'Frontend visual ticket',
            body: 'Update View.tsx',
            scope: ['app/**'],
            rails: [],
            edges: [],
            browserGate: {
              url: localUrl,
              routes: ['/'],
              checkCmd: `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({ consoleErrors: [], serverErrors: [], screenshots: [${JSON.stringify(extShot)}] }))'`,
            },
          },
          null,
          2
        ) + '\n'
      );
      writeFileSync(join(repo, 'app', 'View.tsx'), 'export const View = () => "updated";\n');

      const gtRes = await runGateTicket(repo, 'T-BG-1', {
        base: 'HEAD',
        testCmd: 'node -e "process.exit(0)"',
        sandbox: false,
        skipHollow: true,
        recordManifest: false,
      });
      assert.equal(gtRes.ok, true, JSON.stringify(gtRes));
      assert.equal(gtRes.stages.browserGate.ok, true);
      assert.equal(gtRes.stages.browserGate.enforced, true);
      assert.equal(gtRes.stages.browserGate.screenshots.length, 1);
      assert.equal(existsSync(join(repo, gtRes.stages.browserGate.screenshots[0].path)), true);

      // Enforced browserGate failure inside runGateTicket fails closed with ok: false
      mode = '500';
      const gtFail = await runGateTicket(repo, 'T-BG-1', {
        base: 'HEAD',
        testCmd: 'node -e "process.exit(0)"',
        sandbox: false,
        skipHollow: true,
        recordManifest: false,
      });
      assert.equal(gtFail.ok, false);
      assert.equal(gtFail.kind, 'browser_gate_failed');
      assert.match(gtFail.error, /HTTP 502/);

      // skipBrowser: true bypasses browserGate cleanly
      const gtSkip = await runGateTicket(repo, 'T-BG-1', {
        base: 'HEAD',
        testCmd: 'node -e "process.exit(0)"',
        sandbox: false,
        skipHollow: true,
        skipBrowser: true,
        recordManifest: false,
      });
      assert.equal(gtSkip.ok, true);
      assert.equal(gtSkip.stages.browserGate.skipped, true);
      assert.equal(gtSkip.stages.browserGate.reason, 'skipBrowser');
      mode = 'ok';

      // Symlinked screenshot source is rejected
      const symShot = join(shotTmp, 'sym.png');
      symlinkSync(extShot, symShot);
      await assert.rejects(
        () =>
          runBrowserGate(
            repo,
            {
              id: 'T-BG-1',
              browserGate: {
                url: localUrl,
                checkCmd: `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({ screenshots: [${JSON.stringify(symShot)}] }))'`,
              },
            },
            { changedFiles: ['app/View.tsx'], env: {} }
          ),
        /symbolic link not allowed/i
      );
    } finally {
      rmSync(shotTmp, { recursive: true, force: true });
    }
  } finally {
    srv.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
