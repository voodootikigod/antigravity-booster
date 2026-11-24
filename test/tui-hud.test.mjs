import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  ANSI,
  SPINNERS,
  PHASE_CONFIG,
  stripAnsi,
  visibleLength,
  padVisible,
  formatDuration,
  renderProgressBar,
  renderPoolGauge,
  renderTUIDashboard,
} from '../lib/tui.mjs';
import { TerminalHUD } from '../lib/hud.mjs';
import {
  sanitizeRunId,
  cleanOldLogs,
  formatReportMarkdown,
  RunStatus,
  renderStatus,
} from '../lib/status.mjs';
import {
  verifyScopeAndAntiNoOp,
  checkFlailDetector,
  runConsensusFix,
  recordGate,
  checkRailsGuard,
  checkEnforcementAvailable,
} from '../lib/scheduler-verify.mjs';
import { runInit, applyDoctorFixes } from '../lib/doctor.mjs';

test('tui: stripAnsi, visibleLength, padVisible, formatDuration, renderProgressBar, renderPoolGauge', () => {
  const plain = 'Hello world';
  const colored = `${ANSI.bold}${ANSI.cyan}Hello${ANSI.reset} ${ANSI.red}world${ANSI.reset}`;

  assert.equal(stripAnsi(colored), plain);
  assert.equal(visibleLength(colored), plain.length);
  assert.equal(visibleLength(''), 0);
  assert.equal(visibleLength(null), 0);
  assert.ok(Array.isArray(SPINNERS) && SPINNERS.length > 0);
  assert.ok(PHASE_CONFIG.building && PHASE_CONFIG.merged);

  const left = padVisible(`${ANSI.cyan}T1${ANSI.reset}`, 6, 'left');
  assert.equal(visibleLength(left), 6);
  const right = padVisible(`${ANSI.cyan}T1${ANSI.reset}`, 6, 'right');
  assert.equal(visibleLength(right), 6);
  const center = padVisible(`${ANSI.cyan}T1${ANSI.reset}`, 6, 'center');
  assert.equal(visibleLength(center), 6);

  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65000), '01:05');
  assert.equal(formatDuration(3665000), '01:01:05');

  const half = renderProgressBar(5, 10, 10);
  assert.ok(half.includes('50%'));
  assert.ok(half.includes('█████'));

  const gauge = renderPoolGauge('gemini-flash', 4, 8, 12, 8);
  assert.ok(gauge.includes('gemini-flash'));
  assert.ok(gauge.includes('4/8'));
  assert.ok(gauge.includes('(12 reqs)'));
});

test('tui: renderTUIDashboard renders full dashboard state and completed report', () => {
  const tickets = new Map([
    ['T1', { id: 'T1', phase: 'building', model: 'gemini-3-flash-agent', detail: 'Worktree active', strikes: 0 }],
    ['T2', { id: 'T2', phase: 'merged', model: 'gemini-3-flash-agent', strikes: 0 }],
    ['T3', { id: 'T3', phase: 'failed', model: 'claude-sonnet-4-6', strikes: 2, error: 'Gate failure: npm test' }],
    ['T4', { id: 'T4', phase: 'pending' }],
  ]);

  const state = {
    runId: 'run-test-789',
    startedAt: new Date(Date.now() - 30000).toISOString(),
    repo: '/test/repo',
    pools: {
      inFlight: { 'gemini-flash': 1, 'claude': 1 },
      caps: { 'gemini-flash': 8, 'claude': 4 },
      requests: { 'gemini-flash': 3, 'claude': 2 },
    },
    tickets,
    merged: new Set(['T2']),
    failed: new Set(['T3']),
    blocked: new Set(),
    done: false,
    report: null,
    events: [
      { ts: new Date().toISOString(), type: 'phase', ticket: 'T1', to: 'building', detail: 'Started' },
      { ts: new Date().toISOString(), type: 'strike', ticket: 'T3', error: 'Gate error', strikes: 1 },
    ],
  };

  const lines = renderTUIDashboard(state, { cols: 100, spinnerIndex: 0 });
  const text = lines.join('\n');

  assert.ok(text.includes('⚡ ANTIGRAVITY BOOSTER'));
  assert.ok(text.includes('run-test-789'));
  assert.ok(text.includes('RUNNING'));
  assert.ok(text.includes('gemini-flash'));
  assert.ok(text.includes('BUILDING'));
  assert.ok(text.includes('MERGED'));
  assert.ok(text.includes('FAILED'));
  assert.ok(text.includes('RECENT ACTIVITY'));
});

test('hud: TerminalHUD writes to stream (default stderr) and clears in TTY mode', () => {
  let output = '';
  const mockStream = {
    write: (chunk) => { output += chunk; },
  };

  const hudNonTty = new TerminalHUD({ isTTY: false, stream: mockStream });
  hudNonTty.updateTicket('T1', { phase: 'building' });
  hudNonTty.log('Standard log message');
  hudNonTty.stop();
  assert.equal(output, 'Standard log message\n');

  output = '';
  const hud = new TerminalHUD({ isTTY: true, stream: mockStream });
  hud.updateTicket('T1', { phase: 'building', model: 'gemini-3-flash-agent' });
  hud.updateTicket('T2', { phase: 'pending' });
  hud.updatePools({ inFlight: { flash: 1 }, caps: { flash: 4 } });

  assert.ok(output.includes('[AGB HUD]'));
  assert.ok(output.includes('T1: building'));
  assert.ok(output.includes('flash:1/4'));

  hud.stop();
  assert.ok(output.includes('\x1b[2K'));
});

test('status: RunStatus.report writes both report.json and report.md, and renderStatus supports { tui: true }', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-status-md-'));
  try {
    const s = new RunStatus(dir, 'run-md-test');
    s.ticket('T1', { phase: 'merged', model: 'gemini-3-flash-agent' });
    s.report({ merged: ['T1'], failed: {}, requests: { 'gemini-3-flash-agent': 1 } });
    await s.flushEvents();

    assert.equal(sanitizeRunId('run/../foo/bar'), 'run___foo_bar');
    assert.ok(existsSync(join(dir, '.booster', 'report.json')));
    assert.ok(existsSync(join(dir, '.booster', 'report.md')));

    const md = readFileSync(join(dir, '.booster', 'report.md'), 'utf8');
    assert.ok(md.includes('# AGB Execution Report: Execution Succeeded'));
    assert.ok(md.includes('`T1`'));
    assert.ok(md.includes('✓ Merged'));

    const legacyOut = renderStatus(dir);
    assert.ok(legacyOut.includes('run run-md-test  DONE'));

    const tuiOut = renderStatus(dir, { tui: true, cols: 90 });
    assert.ok(stripAnsi(tuiOut).includes('ANTIGRAVITY BOOSTER'));
    assert.ok(stripAnsi(tuiOut).includes('CONVERGED'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler-verify: exports verification helpers cleanly', () => {
  assert.equal(typeof verifyScopeAndAntiNoOp, 'function');
  assert.equal(typeof checkFlailDetector, 'function');
  assert.equal(typeof runConsensusFix, 'function');
  assert.equal(typeof recordGate, 'function');
  assert.equal(typeof checkRailsGuard, 'function');
  assert.equal(typeof checkEnforcementAvailable, 'function');
});

test('doctor: runInit and applyDoctorFixes initialize .adlc, specs/feature-template.md, and .gitignore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-init-test-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const res = runInit({ repo: dir });
    assert.equal(res.ok, true);
    assert.ok(existsSync(join(dir, '.adlc', 'config.json')));
    assert.ok(existsSync(join(dir, '.adlc', 'tickets', '.store.json')));
    assert.ok(existsSync(join(dir, 'specs', 'feature-template.md')));
    assert.ok(existsSync(join(dir, '.gitignore')));

    // Legacy ticket store must throw in applyDoctorFixes / runInit
    const legacyDir = mkdtempSync(join(tmpdir(), 'agb-init-legacy-'));
    try {
      mkdirSync(join(legacyDir, '.adlc'), { recursive: true });
      writeFileSync(join(legacyDir, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
      assert.throws(() => runInit({ repo: legacyDir }), { code: 'LEGACY_TICKET_STORE' });
      await assert.rejects(() => applyDoctorFixes({ cwd: legacyDir }), { code: 'LEGACY_TICKET_STORE' });
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }

    // Verify unsigned-fallback config never sets human-only attestation flags
    const cfg = JSON.parse(readFileSync(join(dir, '.adlc', 'config.json'), 'utf8'));
    assert.equal(cfg.securityMode, 'unsigned-fallback');
    assert.equal(Object.hasOwn(cfg, 'acknowledgedNewRailBypass'), false);
    assert.equal(Object.hasOwn(cfg, 'trustedCodeownersAttested'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchStatus, cleanOldLogs, and symlink containment checks', async () => {
  const { symlinkSync, utimesSync } = await import('node:fs');
  const { EventEmitter } = await import('node:events');
  const { watchStatus } = await import('../lib/status.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-logs-'));
  try {
    // 1. cleanOldLogs removes expired directories and rejects symlinked .booster
    const oldLogDir = join(dir, '.booster', 'logs', 'old-run');
    const freshLogDir = join(dir, '.booster', 'logs', 'fresh-run');
    mkdirSync(oldLogDir, { recursive: true });
    mkdirSync(freshLogDir, { recursive: true });
    const expired = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldLogDir, expired, expired);
    const cleaned = cleanOldLogs(dir, 7 * 24 * 60 * 60 * 1000);
    assert.deepEqual(cleaned, ['old-run']);
    assert.equal(existsSync(oldLogDir), false);
    assert.equal(existsSync(freshLogDir), true);

    // 2. watchStatus interactive 'q' key quits cleanly and clears interval timer
    writeFileSync(join(dir, '.booster', 'run.json'), JSON.stringify({ runId: 'live-1', startedAt: new Date().toISOString() }));
    let out = '';
    const fakeStdout = { write: (c) => { out += c; }, columns: 90, rows: 30 };
    const fakeStdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    });
    const watchPromise = watchStatus(dir, {
      intervalMs: 500,
      interactive: true,
      stdout: fakeStdout,
      stdin: fakeStdin,
    });
    setTimeout(() => fakeStdin.emit('data', Buffer.from('q')), 30);
    const code = await watchPromise;
    assert.equal(code, 0);
    assert.ok(out.includes('\x1b[?1049l'), 'expected alt-screen teardown');

    // 3. Symlinked .adlc rejected by runInit
    const symRepo = mkdtempSync(join(tmpdir(), 'agb-sym-init-'));
    const outside = mkdtempSync(join(tmpdir(), 'agb-outside-'));
    try {
      symlinkSync(outside, join(symRepo, '.adlc'));
      assert.throws(() => runInit({ repo: symRepo }), /symbolic link/i);
    } finally {
      rmSync(symRepo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tui v2 cockpit: renderTUIDashboard renders cursor, filter, Flight Deck tabs, stream/diff/prosecutor panes, and notice', () => {
  const tickets = new Map([
    ['T1', { id: 'T1', phase: 'building', model: 'gemini-4-neon-high', detail: 'Implementing cockpit', strikes: 0 }],
    ['T2', { id: 'T2', phase: 'failed', model: 'claude-sonnet-5-5-high', strikes: 2, error: 'Gate test failed: expected 0 got 1' }],
    ['T3', { id: 'T3', phase: 'merged', model: 'gemini-4-carbon-high', detail: 'resumed (already merged)', strikes: 0 }],
  ]);

  const state = {
    runId: 'run-cockpit-v2',
    startedAt: new Date(Date.now() - 45000).toISOString(),
    repo: '/test/cockpit',
    pools: {
      inFlight: { gemini: 1 },
      caps: { gemini: 4 },
      requests: { gemini: 2 },
    },
    tickets,
    merged: new Set(['T3']),
    failed: new Set(['T2']),
    blocked: new Set(),
    done: false,
    schedulerPaused: true,
    report: null,
    events: [
      { ts: new Date().toISOString(), type: 'phase', ticket: 'T1', to: 'building', detail: 'Started' },
    ],
  };

  // Stream tab + selected row cursor
  const streamOut = renderTUIDashboard(state, {
    cols: 110,
    selectedTicketId: 'T1',
    activeTab: 'stream',
    streamLines: ['[12:00:01] edit_file: lib/tui.mjs', '[12:00:04] run_command: npm test'],
    controlNotice: 'Scheduler paused — in-flight steps will finish',
  });
  assert.ok(Array.isArray(streamOut), 'renderTUIDashboard must return string[]');
  const plainStream = stripAnsi(streamOut.join('\n'));
  assert.ok(plainStream.includes('▸ T1'), 'selected ticket row must show ▸ cursor');
  assert.ok(plainStream.includes('PAUSED'), 'paused scheduler badge must render');
  assert.ok(plainStream.includes('[1] Activity  [2] Stream  [3] Diff  [4] Prosecutor'));
  assert.ok(plainStream.includes('[12:00:01] edit_file: lib/tui.mjs'));
  assert.ok(plainStream.includes('Scheduler paused — in-flight steps will finish'));
  assert.ok(plainStream.includes('j/k select · 1-4 tabs · p pause · x abort · / filter · Enter rescue · q quit'));

  // Diff tab + filterText
  const diffOut = renderTUIDashboard(state, {
    cols: 110,
    selectedTicketId: 'T2',
    activeTab: 'diff',
    filterText: 'claude',
    diffText: 'diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n+const x = 1;',
  });
  const plainDiff = stripAnsi(diffOut.join('\n'));
  assert.ok(plainDiff.includes('▸ T2'));
  assert.ok(!plainDiff.includes('  T1 '), 'filtered out ticket must not appear');
  assert.ok(plainDiff.includes('+const x = 1;'));

  // Prosecutor tab
  const prosOut = renderTUIDashboard(state, {
    cols: 110,
    selectedTicketId: 'T2',
    activeTab: 'prosecutor',
    prosecutorFindings: [{ severity: 'high', file: 'lib/foo.mjs', claim: 'Missing null guard' }],
  });
  const plainPros = stripAnsi(prosOut.join('\n'));
  assert.ok(plainPros.includes('[HIGH] lib/foo.mjs: Missing null guard'));
});

