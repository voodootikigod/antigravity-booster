import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { startControlServer } from '../lib/control-ipc.mjs';
import { writeStatusLineQuotaCache } from '../lib/pools.mjs';
import {
  UI_RESOURCES,
  renderUiResource,
  buildPlanCardHtml,
  buildReviewCardHtml,
  buildFlightDeckHtml,
  buildMissionControlHtml,
  buildPlanViewerHtml,
  buildAcceptWorkbenchHtml,
} from '../mcp/ui-views.mjs';
import { findLiteralStart, parseLiteral } from '../website/scripts/lib/jslit.mjs';
import { scanEnvTokens } from '../website/scripts/gen-reference.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MCP_SRC = join(ROOT, 'mcp', 'server.mjs');
const MCP_DIST = join(ROOT, 'dist', 'mcp-server.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'agb-mcp-apps-'));

after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function mcpSession(entryPath = MCP_SRC, { env = process.env, cwd = ROOT } = {}) {
  const child = spawn(process.execPath, [entryPath], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });

  function send(req, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req.id);
        reject(new Error(`Timed out waiting for id=${req.id} (${req.method})`));
      }, timeoutMs);
      pending.set(req.id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...req }) + '\n');
    });
  }

  async function close() {
    for (const [, w] of pending) clearTimeout(w.timer);
    pending.clear();
    if (child.exitCode !== null || child.killed) return;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 1000);
      killTimer.unref?.();
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
  }

  return { send, close, child };
}

test('static invariants: TOOLS literal parses cleanly via jslit.mjs and mcp/ introduces zero undocumented env tokens', () => {
  const src = readFileSync(MCP_SRC, 'utf8');
  const start = findLiteralStart(src, /const\s+TOOLS\s*=\s*/);
  assert.ok(start !== -1, 'const TOOLS literal must exist in mcp/server.mjs');
  const { value: tools } = parseLiteral(src, start);
  assert.equal(Array.isArray(tools), true);
  assert.equal(tools.length, 15);

  const expectedNames = [
    'agb_shape',
    'agb_plan',
    'agb_distill',
    'agb_run',
    'agb_preflight',
    'agb_status',
    'agb_doctor',
    'agb_init',
    'agb_review',
    'agb_flight_deck',
    'agb_mission_control',
    'agb_plan_viewer',
    'agb_control',
    'agb_accept',
    'agb_holdout',
  ];
  assert.deepEqual(tools.map((t) => t.name), expectedNames);

  // Ensure mcp/ introduces zero AGB_*/ADLC_*/ANTIGRAVITY_* env tokens
  const envTokens = scanEnvTokens(ROOT);
  for (const [, where] of envTokens.entries()) {
    assert.equal(where.startsWith('mcp/'), false, `Unexpected env token in ${where}`);
  }
});

test('initialize & tools/list: advertises resources + conditional io.modelcontextprotocol/ui extension and all 13 tools across source and dist bundles', async () => {
  for (const entry of [MCP_SRC, MCP_DIST]) {
    const srv = mcpSession(entry);
    try {
      const initPlain = await srv.send({ id: 1, method: 'initialize', params: { capabilities: {} } });
      assert.deepEqual(initPlain.result.capabilities, { tools: {}, resources: {} });

      const initUi = await srv.send({
        id: 2,
        method: 'initialize',
        params: { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } },
      });
      assert.deepEqual(initUi.result.capabilities, {
        tools: {},
        resources: {},
        extensions: { 'io.modelcontextprotocol/ui': {} },
      });

      const listRes = await srv.send({ id: 3, method: 'tools/list', params: {} });
      const byName = new Map(listRes.result.tools.map((t) => [t.name, t]));
      assert.equal(byName.size, 15);

      assert.equal(byName.get('agb_shape')._meta.ui.resourceUri, 'ui://agb/plan-card.html');
      assert.equal(byName.get('agb_plan')._meta.ui.resourceUri, 'ui://agb/plan-card.html');
      assert.equal(byName.get('agb_preflight')._meta.ui.resourceUri, 'ui://agb/plan-card.html');
      assert.equal(byName.get('agb_review')._meta.ui.resourceUri, 'ui://agb/review-card.html');

      assert.deepEqual(byName.get('agb_flight_deck')._meta.ui, {
        resourceUri: 'ui://agb/flight-deck.html',
        surface: 'aux_pane',
        visibility: ['model', 'app'],
      });
      assert.deepEqual(byName.get('agb_mission_control')._meta.ui, {
        resourceUri: 'ui://agb/mission-control.html',
        surface: 'global',
        visibility: ['model', 'app'],
      });
      assert.deepEqual(byName.get('agb_plan_viewer')._meta.ui, {
        resourceUri: 'ui://agb/plan-viewer.html',
        surface: 'file',
        extensions: ['.agbplan'],
        visibility: ['model', 'app'],
      });
      assert.deepEqual(byName.get('agb_control')._meta.ui, {
        visibility: ['app'],
      });
      assert.deepEqual(byName.get('agb_accept')._meta.ui, {
        resourceUri: 'ui://agb/accept-workbench.html',
        visibility: ['model', 'app'],
      });

      const runProps = byName.get('agb_run').inputSchema.properties;
      assert.equal(runProps.concurrency.type, 'integer');
      assert.equal(runProps.concurrency.minimum, 1);
      assert.equal(runProps.resume.type, 'boolean');
      assert.equal(runProps.resetRescue.type, 'boolean');
    } finally {
      await srv.close();
    }
  }
});

test('resources/list & resources/read: serves all 6 deterministic ui:// MCP App views with default-deny CSP, zero external URLs, valid inline JS, and -32602 on unknown URI', async () => {
  assert.equal(UI_RESOURCES.length, 6);
  assert.equal(buildPlanCardHtml(), buildPlanCardHtml());
  assert.equal(buildReviewCardHtml(), buildReviewCardHtml());
  assert.equal(buildFlightDeckHtml(), buildFlightDeckHtml());
  assert.equal(buildMissionControlHtml(), buildMissionControlHtml());
  assert.equal(buildPlanViewerHtml(), buildPlanViewerHtml());
  assert.equal(buildAcceptWorkbenchHtml(), buildAcceptWorkbenchHtml());
  assert.equal(renderUiResource('ui://agb/nonexistent.html'), null);

  const srv = mcpSession(MCP_DIST);
  try {
    const list = await srv.send({ id: 10, method: 'resources/list', params: {} });
    const uris = list.result.resources.map((r) => r.uri);
    assert.deepEqual(uris, [
      'ui://agb/plan-card.html',
      'ui://agb/review-card.html',
      'ui://agb/flight-deck.html',
      'ui://agb/mission-control.html',
      'ui://agb/plan-viewer.html',
      'ui://agb/accept-workbench.html',
    ]);

    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      const readRes = await srv.send({ id: 20 + i, method: 'resources/read', params: { uri } });
      assert.equal(readRes.result.contents.length, 1);
      const item = readRes.result.contents[0];
      assert.equal(item.uri, uri);
      assert.equal(item.mimeType, 'text/html;profile=mcp-app');
      assert.deepEqual(item._meta, {
        ui: { csp: { resourceDomains: [], connectDomains: [] } },
      });
      assert.match(item.text, /function escapeHtml\(/);
      assert.match(item.text, /var\(--agy-bg/);
      assert.match(item.text, /prefers-color-scheme:\s*light/);
      assert.match(item.text, /ui\/initialize/);
      assert.match(item.text, /ui\/notifications\/size-changed/);
      assert.doesNotMatch(item.text, /https?:\/\//i, `${uri} must not reference external URLs`);
      assert.doesNotMatch(item.text, /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=/i, `${uri} must not load external assets`);

      // Verify embedded <script> compiles cleanly and escapes XSS payloads at runtime
      const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(item.text);
      assert.ok(scriptMatch, `${uri} must include inline script`);
      const compiled = new vm.Script(scriptMatch[1], { filename: uri });

      const posted = [];
      const elements = new Map();
      const makeEl = () => ({
        style: {},
        innerHTML: '',
        textContent: '',
        value: '',
        className: '',
        classList: { toggle() {} },
        addEventListener() {},
      });
      let messageHandler = null;
      const sandbox = {
        console,
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: () => 2,
        clearInterval: () => {},
        ResizeObserver: class { observe() {} },
        document: {
          documentElement: { scrollHeight: 320 },
          body: { scrollHeight: 320 },
          getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeEl());
            return elements.get(id);
          },
        },
        window: {
          parent: { postMessage(msg) { posted.push(msg); } },
          addEventListener(ev, fn) { if (ev === 'message') messageHandler = fn; },
        },
      };
      compiled.runInNewContext(sandbox);
      assert.equal(posted[0]?.method, 'ui/initialize', `${uri} must send ui/initialize on boot`);
      assert.equal(typeof messageHandler, 'function');

      // Deliver XSS payload via ui/notifications/tool-result and verify escaped output + <=4 semaphore
      const xss = '<img src=x onerror=alert(1)>';
      messageHandler({
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: {
            structuredContent: {
              ok: false,
              verdict: xss,
              path: xss,
              tickets: [{ id: xss, tier: xss, pool_hint: xss, edges: [] }],
              errors: [xss],
              validationErrors: [xss],
              findings: [{ severity: xss, lens: xss, file: xss, summary: xss, recommendation: xss }],
              plan: { tickets: [{ id: xss, title: xss, tier: 'mid', pool_hint: 'auto', scope: ['a.mjs'], edges: [] }] },
              run: { runId: xss, done: false, tickets: { [xss]: { status: xss, model: xss } } },
              quotaCache: { quota: { gemini: { fiveHourRemainingPercent: 80, fiveHourResetTime: xss }, claude_gpt: { fiveHourRemainingPercent: 60, fiveHourResetTime: xss } } },
              modelStats: [{ model: xss, role: xss, ok: true, ms: 12 }],
              economics: { runs: 1, avgStrike0YieldPct: 90, avgCacheHitPct: 80, totalAutofixSaves: 2, totalBillableTokens: 500 },
              runwayEstimate: { willExhaust: true, recommendation: xss, totals: { gemini: 10, claude_gpt: 5 } },
              base: xss,
              hunks: [{ id: xss, file: xss, newStart: 1, lines: [xss], fingerprint: 'a'.repeat(64), verdict: xss }],
              externalCallers: { callers: [{ file: xss, line: 1, symbol: xss, snippet: xss }] },
            },
          },
        },
      });
      for (const [elId, el] of elements.entries()) {
        assert.equal(
          el.innerHTML.includes('<img'),
          false,
          `${uri}#${elId} must escape HTML in innerHTML (got: ${el.innerHTML})`
        );
      }

      // Verify <=4 concurrent in-flight tools/call semaphore
      posted.length = 0;
      const calls = [];
      for (let c = 0; c < 6; c++) {
        calls.push(vm.runInNewContext('__bridge.callTool', sandbox));
      }
      // Invoke 6 concurrent callTool calls inside the same context
      vm.runInNewContext(
        'globalThis.__p = Array.from({ length: 6 }, (_, i) => __bridge.callTool("agb_status", { repo: String(i) }));',
        sandbox
      );
      await new Promise((r) => setImmediate(r));
      const inFlightPosts = posted.filter((m) => m.method === 'tools/call');
      assert.equal(inFlightPosts.length, 4, `${uri} semaphore must cap concurrent tools/call at 4`);
    }

    const unknown = await srv.send({ id: 99, method: 'resources/read', params: { uri: 'ui://agb/unknown.html' } });
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /Unknown resource URI/);
  } finally {
    await srv.close();
  }
});

test('agb_flight_deck, agb_mission_control & agb_control: live control server + quota cache + modelStats + offline rescue-latest fallback', async () => {
  const repo = join(TMP, 'live-repo');
  mkdirSync(join(repo, '.booster', 'rescue-latest'), { recursive: true });
  writeFileSync(
    join(repo, '.booster', 'run.json'),
    JSON.stringify({ runId: 'run-42', done: false, tickets: { 'T-1': { status: 'running', model: 'gemini-2.5-pro' } } })
  );
  writeFileSync(
    join(repo, '.booster', 'report.json'),
    JSON.stringify({ runId: 'run-42', merged: ['T-0'], failed: {} })
  );
  const statsLines = Array.from({ length: 60 }, (_, idx) =>
    JSON.stringify({ seq: idx + 1, model: 'gemini-2.5-flash', role: 'builder', ok: true, ms: 100 + idx })
  ).join('\n') + '\n';
  writeFileSync(join(repo, '.booster', 'model_stats.jsonl'), statsLines);
  writeFileSync(
    join(repo, '.booster', 'rescue-latest', 't-1.json'),
    JSON.stringify({ ticketId: 'T-1', savedAt: new Date().toISOString(), diff: '--- a/x.js\n+++ b/x.js\n+saved rescue diff\n' })
  );

  const quotaFile = join(TMP, 'statusline_quota.json');
  const futureIso = new Date(Date.now() + 3600_000).toISOString();
  const env = { ...process.env, AGB_STATUSLINE_QUOTA_FILE: quotaFile };

  // Write fresh quota cache using the real helper under AGB_STATUSLINE_QUOTA_FILE
  const prevQuotaEnv = process.env.AGB_STATUSLINE_QUOTA_FILE;
  process.env.AGB_STATUSLINE_QUOTA_FILE = quotaFile;
  try {
    const wrote = writeStatusLineQuotaCache({
      gemini: {
        fiveHourRemainingPercent: 88,
        weeklyRemainingPercent: 74,
        fiveHourResetTime: futureIso,
        weeklyResetTime: futureIso,
      },
      claude_gpt: {
        fiveHourRemainingPercent: 65,
        weeklyRemainingPercent: 52,
        fiveHourResetTime: futureIso,
        weeklyResetTime: futureIso,
      },
    });
    assert.equal(wrote, true);
  } finally {
    if (prevQuotaEnv === undefined) delete process.env.AGB_STATUSLINE_QUOTA_FILE;
    else process.env.AGB_STATUSLINE_QUOTA_FILE = prevQuotaEnv;
  }

  let pausedState = false;
  const aborted = [];
  const ctrl = await startControlServer(
    repo,
    {
      status: () => ({ paused: pausedState, activeWorkers: 1 }),
      pause: () => { pausedState = true; return { paused: true }; },
      resume: () => { pausedState = false; return { paused: false }; },
      abort: (req) => { aborted.push(req.ticketId); return { aborted: req.ticketId }; },
      diff: (req) => ({ ticketId: req.ticketId, diff: '+live control diff\n' }),
      stream: (req) => ({ ticketId: req.ticketId, lines: ['line-1', 'line-2', 'line-3'] }),
    },
    { runId: 'run-42' }
  );

  const srv = mcpSession(MCP_SRC, { env });
  try {
    // 1. Flight deck & mission control while live
    const fdRes = await srv.send({
      id: 1,
      method: 'tools/call',
      params: { name: 'agb_flight_deck', arguments: { repo } },
    });
    assert.equal(fdRes.result.structuredContent.surface, 'aux_pane');
    assert.equal(fdRes.result.structuredContent.ok, true);
    assert.equal(fdRes.result.structuredContent.run.runId, 'run-42');
    assert.equal(fdRes.result.structuredContent.control.ok, true);
    assert.equal(fdRes.result.structuredContent.quotaCache.quota.gemini.fiveHourRemainingPercent, 88);
    assert.equal(fdRes.result.structuredContent.modelStats.length, 50);
    assert.equal(fdRes.result.structuredContent.modelStats[0].seq, 11);
    assert.equal(fdRes.result.structuredContent.modelStats[49].seq, 60);

    const mcRes = await srv.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'agb_mission_control', arguments: { repo } },
    });
    assert.equal(mcRes.result.structuredContent.surface, 'global');
    assert.equal(mcRes.result.structuredContent.quotaCache.quota.claude_gpt.weeklyRemainingPercent, 52);

    // 2. Live agb_control actions: snapshot, pause, resume, abort, diff, stream
    const snapRes = await srv.send({
      id: 3,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'snapshot' } },
    });
    assert.equal(snapRes.result.structuredContent.ok, true);
    assert.equal(snapRes.result.structuredContent.control.activeWorkers, 1);

    const pauseRes = await srv.send({
      id: 4,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'pause' } },
    });
    assert.equal(pauseRes.result.structuredContent.ok, true);
    assert.equal(pauseRes.result.structuredContent.paused, true);

    const resumeRes = await srv.send({
      id: 5,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'resume' } },
    });
    assert.equal(resumeRes.result.structuredContent.ok, true);
    assert.equal(resumeRes.result.structuredContent.paused, false);

    const abortRes = await srv.send({
      id: 6,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'abort', ticketId: 'T-1' } },
    });
    assert.equal(abortRes.result.structuredContent.ok, true);
    assert.deepEqual(aborted, ['T-1']);

    const liveDiffRes = await srv.send({
      id: 7,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'diff', ticketId: 'T-1' } },
    });
    assert.equal(liveDiffRes.result.structuredContent.ok, true);
    assert.equal(liveDiffRes.result.structuredContent.offline, false);
    assert.match(liveDiffRes.result.structuredContent.diff, /\+live control diff/);

    const streamRes = await srv.send({
      id: 8,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'stream', ticketId: 'T-1', lines: 2 } },
    });
    assert.equal(streamRes.result.structuredContent.ok, true);
    assert.deepEqual(streamRes.result.structuredContent.lines, ['line-2', 'line-3']);

    // 3. Close control server -> verify offline fallbacks
    await ctrl.close();

    const offlineDiffSaved = await srv.send({
      id: 9,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'diff', ticketId: 'T-1' } },
    });
    assert.equal(offlineDiffSaved.result.isError, false);
    assert.equal(offlineDiffSaved.result.structuredContent.ok, true);
    assert.equal(offlineDiffSaved.result.structuredContent.offline, true);
    assert.match(offlineDiffSaved.result.structuredContent.diff, /\+saved rescue diff/);

    const offlineDiffMissing = await srv.send({
      id: 10,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'diff', ticketId: 'T-MISSING' } },
    });
    assert.equal(offlineDiffMissing.result.isError, false);
    assert.deepEqual(offlineDiffMissing.result.structuredContent, {
      ok: false,
      offline: true,
      ticketId: 'T-MISSING',
      diff: '',
      error: 'no active run or saved rescue snapshot',
    });

    const offlineStream = await srv.send({
      id: 11,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'stream', ticketId: 'T-1' } },
    });
    assert.equal(offlineStream.result.isError, false);
    assert.equal(offlineStream.result.structuredContent.ok, false);
    assert.equal(offlineStream.result.structuredContent.offline, true);
    assert.deepEqual(offlineStream.result.structuredContent.lines, []);

    const offlinePause = await srv.send({
      id: 12,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'pause' } },
    });
    assert.equal(offlinePause.result.isError, false);
    assert.equal(offlinePause.result.structuredContent.ok, false);
    assert.equal(offlinePause.result.structuredContent.offline, true);
    assert.equal(offlinePause.result.structuredContent.ticketId, null);

    // 4. Input validation errors return isError: true
    const badAction = await srv.send({
      id: 13,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'reboot' } },
    });
    assert.equal(badAction.result.isError, true);

    const missingTicket = await srv.send({
      id: 14,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo, action: 'abort' } },
    });
    assert.equal(missingTicket.result.isError, true);
  } finally {
    await ctrl.close();
    await srv.close();
  }
});

test('agb_plan_viewer & symlink defenses: validates .agbplan, reports schema errors, and rejects symlinks on planFile and .booster', async () => {
  const repo = join(TMP, 'viewer-repo');
  mkdirSync(repo, { recursive: true });

  const validPlanPath = join(repo, 'feature.agbplan');
  const validPlan = {
    repo,
    gate: { test: 'npm test' },
    tickets: [
      {
        id: 'T-1',
        title: 'First ticket',
        body: 'Implement lib/a.mjs cleanly.',
        scope: ['lib/a.mjs'],
        rails: ['lib/lock.mjs'],
        tier: 'mid',
        pool_hint: 'gemini',
        edges: [],
      },
    ],
  };
  writeFileSync(validPlanPath, JSON.stringify(validPlan, null, 2));

  const badJsonPath = join(repo, 'broken.agbplan');
  writeFileSync(badJsonPath, '{broken json');

  const symlinkPlanPath = join(repo, 'symlink.agbplan');
  symlinkSync(validPlanPath, symlinkPlanPath);

  const symBoosterRepo = join(TMP, 'sym-booster-repo');
  mkdirSync(symBoosterRepo, { recursive: true });
  symlinkSync(repo, join(symBoosterRepo, '.booster'));

  const srv = mcpSession(MCP_DIST);
  try {
    const okRes = await srv.send({
      id: 1,
      method: 'tools/call',
      params: { name: 'agb_plan_viewer', arguments: { path: 'feature.agbplan', repo } },
    });
    assert.equal(Boolean(okRes.result.isError), false);
    assert.equal(okRes.result.content[0].text, 'Plan feature.agbplan: 1 ticket(s)');
    assert.equal(okRes.result.structuredContent.ok, true);
    assert.deepEqual(okRes.result.structuredContent.validationErrors, []);
    assert.equal(okRes.result.structuredContent.plan.tickets[0].id, 'T-1');
    assert.ok(okRes.result.structuredContent.runwayEstimate && typeof okRes.result.structuredContent.runwayEstimate === 'object');
    assert.equal(Array.isArray(okRes.result.structuredContent.runwayEstimate.waves), true);

    const badJsonRes = await srv.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'agb_plan_viewer', arguments: { path: badJsonPath } },
    });
    assert.equal(badJsonRes.result.isError, true);
    assert.match(badJsonRes.result.content[0].text, /Invalid JSON/);

    const symPlanRes = await srv.send({
      id: 3,
      method: 'tools/call',
      params: { name: 'agb_plan_viewer', arguments: { path: 'symlink.agbplan', repo } },
    });
    assert.equal(symPlanRes.result.isError, true);
    assert.match(symPlanRes.result.content[0].text, /symbolic link/i);

    const symBoosterRes = await srv.send({
      id: 4,
      method: 'tools/call',
      params: { name: 'agb_flight_deck', arguments: { repo: symBoosterRepo } },
    });
    assert.equal(symBoosterRes.result.isError, true);
    assert.match(symBoosterRes.result.content[0].text, /symbolic link/i);

    // Reject > 512 KiB plan files
    const hugePlanPath = join(repo, 'huge.agbplan');
    writeFileSync(hugePlanPath, JSON.stringify({ repo, gate: { test: 'npm test' }, pad: 'x'.repeat(530 * 1024), tickets: [] }));
    const hugePlanRes = await srv.send({
      id: 5,
      method: 'tools/call',
      params: { name: 'agb_plan_viewer', arguments: { path: 'huge.agbplan', repo } },
    });
    assert.equal(hugePlanRes.result.isError, true);
    assert.match(hugePlanRes.result.content[0].text, /exceeds/i);

    // Reject symlinked run.json and rescue-latest/<id>.json inside a real .booster directory
    const symInnerRepo = join(TMP, 'sym-inner-repo');
    mkdirSync(join(symInnerRepo, '.booster', 'rescue-latest'), { recursive: true });
    symlinkSync(validPlanPath, join(symInnerRepo, '.booster', 'rescue-latest', 't-1.json'));
    const symRescueRes = await srv.send({
      id: 6,
      method: 'tools/call',
      params: { name: 'agb_control', arguments: { repo: symInnerRepo, action: 'diff', ticketId: 'T-1' } },
    });
    assert.equal(symRescueRes.result.isError, true);
    assert.match(symRescueRes.result.content[0].text, /symbolic link/i);

    symlinkSync(validPlanPath, join(symInnerRepo, '.booster', 'run.json'));
    const symRunJsonRes = await srv.send({
      id: 7,
      method: 'tools/call',
      params: { name: 'agb_mission_control', arguments: { repo: symInnerRepo } },
    });
    assert.equal(symRunJsonRes.result.isError, true);
    assert.match(symRunJsonRes.result.content[0].text, /symbolic link/i);
  } finally {
    await srv.close();
  }
});

test('agb_run & CLI-backed UI tools: forwards concurrency, --resume, --reset-rescue and attaches JSON or rawText structuredContent', async () => {
  const argvLog = join(TMP, 'run-argv.json');
  const preload = join(TMP, 'capture-argv.mjs');
  writeFileSync(
    preload,
    `import { writeFileSync } from 'node:fs';
const entry = process.argv[1] ?? '';
const sub = process.argv[2] ?? '';
if (/agb\\.mjs$/.test(entry)) {
  if (sub === 'run') {
    writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
    process.exit(0);
  }
  if (sub === 'shape') {
    console.log(JSON.stringify({
      ok: true,
      structured: true,
      readinessScore: 100,
      tickets: [{ id: 'T-X', tier: 'mid', pool_hint: 'gemini', edges: [] }],
      errors: [],
      couplingWarnings: [],
    }));
    process.exit(0);
  }
  if (sub === 'plan') {
    if (process.argv.includes('--estimate')) {
      writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
      console.log(JSON.stringify({ ok: true, quotaEstimate: { ok: true, willExhaust: false, waves: [] }, tickets: [{ id: 'T-PLAN-1' }] }));
      process.exit(0);
    }
    const outIdx = process.argv.indexOf('--out');
    if (outIdx !== -1 && process.argv[outIdx + 1]) {
      writeFileSync(
        process.argv[outIdx + 1],
        JSON.stringify({ tickets: [{ id: 'T-PLAN-1', tier: 'frontier', pool_hint: 'claude', edges: [] }] })
      );
    }
    console.log(JSON.stringify({ attempts: 1, gatePasses: ['coldstart'], fastPath: true, blocking: [] }));
    process.exit(0);
  }
  if (sub === 'review') {
    process.stderr.write('review: empty diff — nothing to prosecute\\n');
    process.exit(0);
  }
}
`
  );
  const planFile = join(TMP, 'sample-plan.json');
  writeFileSync(planFile, '{}');

  const specDir = join(TMP, 'shape-repo');
  mkdirSync(join(specDir, 'lib'), { recursive: true });
  writeFileSync(join(specDir, 'lib', 'x.mjs'), 'export const x = 1;\n');
  const specPath = join(specDir, 'spec.md');
  writeFileSync(specPath, '# Feature Spec\n');

  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim(),
  };

  const srv = mcpSession(MCP_SRC, { env });
  try {
    const runRes = await srv.send({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'agb_run',
        arguments: { plan: planFile, concurrency: 4, resume: true, resetRescue: true },
      },
    });
    assert.equal(runRes.result.isError, false);
    assert.deepEqual(JSON.parse(readFileSync(argvLog, 'utf8')), [
      'run',
      planFile,
      '-c',
      '4',
      '--resume',
      '--reset-rescue',
    ]);

    const badResume = await srv.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'agb_run', arguments: { plan: planFile, resume: 'yes' } },
    });
    assert.equal(badResume.error.code, -32602);

    const badResetRescue = await srv.send({
      id: 3,
      method: 'tools/call',
      params: { name: 'agb_run', arguments: { plan: planFile, resetRescue: 123 } },
    });
    assert.equal(badResetRescue.error.code, -32602);

    const shapeRes = await srv.send({
      id: 4,
      method: 'tools/call',
      params: { name: 'agb_shape', arguments: { spec: specPath, repo: specDir } },
    });
    assert.equal(shapeRes.result.isError, false);
    assert.equal(shapeRes.result.structuredContent.ok, true);
    assert.equal(shapeRes.result.structuredContent.readinessScore, 100);
    assert.equal(shapeRes.result.structuredContent.tickets[0].id, 'T-X');

    const planRes = await srv.send({
      id: 5,
      method: 'tools/call',
      params: { name: 'agb_plan', arguments: { spec: specPath, repo: specDir, force: true } },
    });
    assert.equal(planRes.result.isError, false);
    assert.equal(planRes.result.structuredContent.fastPath, true);
    assert.equal(planRes.result.structuredContent.tickets[0].id, 'T-PLAN-1');

    const estRes = await srv.send({
      id: 50,
      method: 'tools/call',
      params: { name: 'agb_plan', arguments: { spec: specPath, repo: specDir, estimate: true } },
    });
    assert.equal(estRes.result.isError, false);
    assert.deepEqual(JSON.parse(readFileSync(argvLog, 'utf8')), [
      'plan',
      specPath,
      specDir,
      '--estimate',
      '--json',
    ]);

    const badEst = await srv.send({
      id: 51,
      method: 'tools/call',
      params: { name: 'agb_plan', arguments: { spec: specPath, repo: specDir, estimate: 'yes' } },
    });
    assert.equal(badEst.error.code, -32602);

    const reviewRes = await srv.send({
      id: 6,
      method: 'tools/call',
      params: { name: 'agb_review', arguments: { repo: specDir } },
    });
    assert.equal(reviewRes.result.isError, false);
    assert.equal(reviewRes.result.structuredContent.ok, true);
    assert.equal(reviewRes.result.structuredContent.exitCode, 0);
    assert.match(reviewRes.result.structuredContent.rawText, /empty diff/);
  } finally {
    await srv.close();
  }
});

test('agb_accept: inspects P6 hunk dossier, saves 64-hex SHA-256 verdicts, rejects non-hex verdict keys, and surfaces economics in Mission Control', async () => {
  const { execFileSync } = await import('node:child_process');
  const acceptRepo = join(TMP, 'accept-mcp-repo');
  mkdirSync(join(acceptRepo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', acceptRepo]);
  execFileSync('git', ['-C', acceptRepo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', acceptRepo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', acceptRepo, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(join(acceptRepo, 'src', 'app.mjs'), 'export function run() { return 1; }\n');
  execFileSync('git', ['-C', acceptRepo, 'add', 'src/app.mjs']);
  execFileSync('git', ['-C', acceptRepo, 'commit', '-qm', 'base']);
  const baseSha = execFileSync('git', ['-C', acceptRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(acceptRepo, 'src', 'app.mjs'), 'export function run() { return 2; }\n');

  const ledgerFile = join(TMP, 'factory_ledger_mcp.jsonl');
  writeFileSync(
    ledgerFile,
    JSON.stringify({
      runId: 'run-econ-1',
      totalTickets: 4,
      mergedCount: 4,
      failedCount: 0,
      strike0MergedCount: 3,
      autofixAppliedCount: 2,
      uncachedInputTokens: 1000,
      cachedTokens: 4000,
      outputTokens: 200,
      billableTokens: 2000,
    }) + '\n'
  );

  // Use MCP_SRC when testing AGB_FACTORY_LEDGER_FILE env override (MCP_DIST ignores unbundled env overrides per Decision 2)
  const srv = mcpSession(MCP_SRC, {
    env: { ...process.env, AGB_FACTORY_LEDGER_FILE: ledgerFile },
  });
  try {
    const mcRes = await srv.send({
      id: 1,
      method: 'tools/call',
      params: { name: 'agb_mission_control', arguments: { repo: acceptRepo } },
    });
    assert.equal(mcRes.result.structuredContent.economics.runs, 1);
    assert.equal(mcRes.result.structuredContent.economics.avgStrike0YieldPct, 75);
    assert.equal(mcRes.result.structuredContent.economics.totalAutofixSaves, 2);

    const d1 = await srv.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'agb_accept', arguments: { repo: acceptRepo, base: baseSha } },
    });
    assert.equal(Boolean(d1.result.isError), false);
    assert.equal(d1.result.structuredContent.counts.totalHunks, 1);
    assert.equal(d1.result.structuredContent.readyForSignOff, false);
    const fp = d1.result.structuredContent.hunks[0].fingerprint;
    assert.match(fp, /^[0-9a-f]{64}$/);

    // Non-64-hex verdict key must return isError: true
    const badKey = await srv.send({
      id: 3,
      method: 'tools/call',
      params: {
        name: 'agb_accept',
        arguments: { repo: acceptRepo, base: baseSha, verdicts: { 'src/app.mjs': 'accepted' } },
      },
    });
    assert.equal(badKey.result.isError, true);
    assert.match(badKey.result.content[0].text, /64-char lowercase hex SHA-256/);

    // Saving valid 64-hex verdict transitions readyForSignOff -> true, and partial merge preserves untouched fingerprints
    const otherFp = 'b'.repeat(64);
    await srv.send({
      id: 40,
      method: 'tools/call',
      params: {
        name: 'agb_accept',
        arguments: { repo: acceptRepo, base: baseSha, verdicts: { [otherFp]: 'flagged' }, saveVerdicts: true },
      },
    });
    const saved = await srv.send({
      id: 4,
      method: 'tools/call',
      params: {
        name: 'agb_accept',
        arguments: { repo: acceptRepo, base: baseSha, verdicts: { [fp]: 'accepted' }, saveVerdicts: true },
      },
    });
    assert.equal(Boolean(saved.result.isError), false);
    assert.equal(saved.result.structuredContent.readyForSignOff, true);
    assert.equal(saved.result.structuredContent.counts.acceptedHunks, 1);
    const persisted = JSON.parse(readFileSync(join(acceptRepo, '.booster', 'accept-state.json'), 'utf8'));
    assert.equal(persisted.verdicts[otherFp], 'flagged', 'partial saveVerdicts must preserve untouched hunk fingerprints');
    assert.equal(persisted.verdicts[fp], 'accepted');

    // Wave 4: agb_holdout list & validation over MCP
    const holdoutList = await srv.send({
      id: 5,
      method: 'tools/call',
      params: { name: 'agb_holdout', arguments: { action: 'list', repo: acceptRepo } },
    });
    assert.equal(Boolean(holdoutList.result.isError), false);
    assert.equal(JSON.parse(holdoutList.result.content[0].text).ok, true);

    const holdoutBad = await srv.send({
      id: 6,
      method: 'tools/call',
      params: { name: 'agb_holdout', arguments: { action: 'invalid', repo: acceptRepo } },
    });
    assert.ok(holdoutBad.error);
  } finally {
    await srv.close();
  }
});
