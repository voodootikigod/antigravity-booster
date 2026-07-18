// renderTuiState formats event timestamps with Date.toTimeString(), which is
// local-time. Pin the suite to UTC so the golden fixture is reproducible on any
// machine (a developer's local zone vs CI's UTC would otherwise diverge). Node
// honours a runtime TZ change via tzset(), and this runs before any Date call.
process.env.TZ = 'UTC';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, padTruncate, renderTuiState, launchTUI } from '../lib/tui.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The transcript pane renders agent output, which is untrusted. A surviving
// escape or control byte would let that output drive the user's real terminal,
// so assert on the raw codepoints rather than on any particular regex shape.
const CONTROL_FREE = (s) => ![...s].some((ch) => {
  const c = ch.codePointAt(0);
  return c === 0x1b || c === 0x9b || c < 0x20 || (c >= 0x7f && c <= 0x9f);
});

test('tui: stripAnsi leaves no escape byte for the terminal to act on', () => {
  const hostile = [
    '(0',                  // charset select
    '#8',                  // DEC alignment test
    '=',                   // application keypad
    '7',                   // save cursor
    '[31mred[0m',    // CSI colour
    '[?1049h',             // CSI alt-screen switch
    ']0;Title',      // OSC window title (BEL-terminated)
    ']0;Title\\',    // OSC window title (ST-terminated)
    'P+q544e\\',     // DCS
    '31m'                  // 8-bit CSI
  ];
  for (const input of hostile) {
    assert.ok(CONTROL_FREE(stripAnsi(input)), `control byte survived: ${JSON.stringify(input)}`);
  }
});

test('tui: stripAnsi preserves printable text and removes colour codes', () => {
  assert.equal(stripAnsi('safe text'), 'safe text');
  assert.equal(stripAnsi('[31mred[0m'), 'red');
  assert.equal(stripAnsi('[?1049h'), '');
  assert.equal(stripAnsi(']0;Title'), '');
  assert.equal(stripAnsi(null), '');
});

test('tui: padTruncate formats text properly', () => {
  assert.equal(padTruncate('hello', 10), 'hello     ');
  assert.equal(padTruncate('hello', 10, 'right'), '     hello');
  assert.equal(padTruncate('very long string', 10), 'very lo...');
  assert.equal(padTruncate('very', 2), 've');
  assert.equal(padTruncate(null, 5), '     ');
});

test('tui: renderTuiState renders a basic state', () => {
  const state = {
    repo: '/test/repo',
    run: {
      tickets: {
        'T-1': { phase: 'pending', strikes: 0, model: 'model-a' }
      },
      pools: {
        caps: { 'pool-1': 10 },
        inFlight: { 'pool-1': 1 }
      }
    },
    events: [],
    transcript: [],
    selectedTicketIndex: 0,
    ticketScrollTop: 0,
    showTranscript: false,
    timelineScrollTop: -1,
    transcriptScrollTop: 0
  };

  const frame = renderTuiState(state, 80, 24);
  assert.ok(frame.includes('T-1'));
  assert.ok(frame.includes('pool-1: 1/10'));
  assert.ok(frame.includes('pending'));
  assert.ok(frame.split('\n').length > 10, 'renders multiple lines');
});

test('tui: renderTuiState shows transcript when showTranscript is true', () => {
  const state = {
    repo: '/test/repo',
    run: {
      tickets: {
        'T-1': { phase: 'pending', strikes: 0, model: 'model-a' }
      },
      pools: {}
    },
    events: [],
    transcript: [{ prompt: 'Hello', output: 'World', strike: 1 }],
    selectedTicketIndex: 0,
    ticketScrollTop: 0,
    showTranscript: true,
    timelineScrollTop: -1,
    transcriptScrollTop: 0
  };

  const frame = renderTuiState(state, 80, 24);
  assert.ok(frame.includes('[PROMPT]'));
  assert.ok(frame.includes('Hello'));
  assert.ok(frame.includes('[OUTPUT]'));
  assert.ok(frame.includes('World'));
});

test('tui: renderTuiState events rendering', () => {
  const state = {
    repo: '/test/repo',
    run: {},
    events: [
      { ts: '2023-01-01T10:00:00Z', type: 'phase', ticket: 'T-1', to: 'building' }
    ],
    selectedTicketIndex: 0,
    ticketScrollTop: 0,
    showTranscript: false,
    timelineScrollTop: -1,
    transcriptScrollTop: 0
  };

  const frame = renderTuiState(state, 80, 24);
  assert.ok(frame.includes('[phase] T-1 transitioned to building'));
});

// --- T-TUI-RENDER: pi-tui rendering layer ---

// The other renderTuiState tests are substring spot-checks: they confirm a value
// appears somewhere in the frame but pin nothing about pane widths, column sizes,
// or heights. This golden fixture pins the EXACT frame, so any drift in the
// layout math (column widths, the 50/70 splits, pane heights) is caught. The
// fixture was generated from the known-good renderer and is the authoritative
// layout contract now that T3's prose is retired. To intentionally change the
// layout, regenerate it — do not hand-edit.
test('tui: renderTuiState reproduces the golden layout exactly', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'tui-golden.json'), 'utf8'));
  const base = { selectedTicketIndex: 0, ticketScrollTop: 0, showTranscript: false, timelineScrollTop: -1, transcriptScrollTop: 0 };
  const states = {
    oneTicket: { run: { tickets: { 'T-1': { phase: 'building', strikes: 0, model: 'gemini-3-pro' } }, pools: { caps: { p1: 10 }, inFlight: { p1: 3 } } }, events: [], transcript: [] },
    manyTicketsPools: { run: { tickets: Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['T-' + i, { phase: 'pending', strikes: i % 4, model: 'gemini-3-flash' }])), pools: { caps: { alpha: 4, beta: 8, gamma: 2 }, inFlight: { alpha: 1, beta: 8, gamma: 0 } } }, events: [], transcript: [] },
    selectedSecond: { run: { tickets: { 'T-1': { phase: 'a', strikes: 0, model: 'm' }, 'T-2': { phase: 'b', strikes: 1, model: 'm2' } }, pools: {} }, events: [], transcript: [], selectedTicketIndex: 1 },
    events: { run: { tickets: { 'T-1': { phase: 'done', strikes: [1, 2], model: 'm' } }, pools: {} }, events: [{ ts: '2026-07-16T10:00:00Z', type: 'phase', ticket: 'T-1', to: 'p0' }, { ts: '2026-07-16T10:00:01Z', type: 'strike', ticket: 'T-1', detail: { ok: true } }, { ts: '2026-07-16T10:00:02Z', type: 'strike', ticket: 'T-1', detail: { ok: false } }, { ts: '2026-07-16T10:00:03Z', type: 'pool' }], transcript: [] },
    transcriptOpen: { run: { tickets: { 'T-1': { phase: 'building', strikes: 0, model: 'm' } }, pools: {} }, events: [{ ts: '2026-07-16T10:00:00Z', type: 'pool' }], transcript: [{ strike: 1, prompt: 'do the thing\nsecond', output: 'did it\nok' }], showTranscript: true },
  };
  for (const [name, s] of Object.entries(states)) {
    for (const [w, h] of [[80, 24], [100, 30], [120, 40]]) {
      const key = `${name}@${w}x${h}`;
      assert.equal(renderTuiState({ ...base, ...s }, w, h), golden[key], `frame drifted: ${key}`);
    }
  }
});

// Any TUI that a test abandons before pressing 'q' (e.g. an assertion throws
// first) would leave launchTUI's poll interval running and hang the whole
// runner at exit. Track started terminals and force-quit any survivors after
// the suite, so a failing test can never wedge the process.
const LIVE_TERMS = new Set();
after(() => {
  for (const t of LIVE_TERMS) { try { t.onInput?.('q'); } catch {} }
  LIVE_TERMS.clear();
});

// A Terminal stub so the render path can be asserted on without a real TTY.
// Mirrors pi-tui's Terminal interface (see its dist/terminal.d.ts).
class FakeTerminal {
  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
    this.writes = [];
    this.kittyProtocolActive = false;
  }
  start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize; LIVE_TERMS.add(this); }
  stop() { LIVE_TERMS.delete(this); }
  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() { this.cursorRestored = true; }
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

const mkRepo = (run) => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-tui-'));
  mkdirSync(join(repo, '.booster'), { recursive: true });
  writeFileSync(join(repo, '.booster', 'run.json'), JSON.stringify(run));
  return repo;
};

const RUN = { runId: 'r1', tickets: { 'T-1': { phase: 'building', strikes: 0, model: 'm' } }, pools: {} };

// The bug this guards: padTruncate measured columns with String.length, so a
// CJK grapheme counted as 1 column while occupying 2. A Japanese transcript
// produced a 115-column line in an 80-column viewport, which wrapped, pushed
// the frame down and scrolled the buffer on every repaint.
test('tui: renderTuiState never exceeds the viewport width on CJK and emoji output', () => {
  const state = {
    run: {
      tickets: { 'T-1': { phase: '構築中', strikes: 0, model: 'モデル-A' } },
      pools: { caps: { プール: 4 }, inFlight: { プール: 2 } },
    },
    events: [{ ts: '2026-07-16T10:00:00Z', type: 'phase', ticket: 'チケット', to: '日本語のフェーズです' }],
    transcript: [{ strike: 1, prompt: '日本語のテキストです'.repeat(4), output: '🎉'.repeat(40) }],
    selectedTicketIndex: 0,
    ticketScrollTop: 0,
    showTranscript: true,
    timelineScrollTop: -1,
    transcriptScrollTop: 0,
  };
  for (const [w, h] of [[80, 24], [100, 30], [120, 40]]) {
    renderTuiState(state, w, h).split('\n').forEach((line, i) => {
      assert.ok(
        visibleWidth(line) <= w,
        `line ${i} occupies ${visibleWidth(line)} columns in a ${w}-column viewport: ${JSON.stringify(line)}`
      );
    });
  }
});

// T-TUI-STRIKES: the Strikes column rendered blank because padTruncate stripAnsi's
// its numeric argument to ''. These pin the count so that regression can't return.
test('tui: renders the strikes count, not a blank column', () => {
  const mk = (strikes) => renderTuiState({
    run: { tickets: { 'T-1': { phase: 'building', strikes, model: 'm' } }, pools: {} },
    events: [], transcript: [], selectedTicketIndex: 0, ticketScrollTop: 0,
    showTranscript: false, timelineScrollTop: -1, transcriptScrollTop: 0,
  }, 80, 24);
  // Line 0 is the header; line 1 is the first ticket row. The strikes cell is a
  // right-aligned number immediately before the single-space-separated model.
  const row = (frame) => stripAnsi(frame.split('\n')[1].split('│')[0]);
  assert.match(row(mk(3)), /\b3 m/, 'strikes: 3 renders 3, not blank');
  assert.match(row(mk([1, 2])), /\b2 m/, 'array strikes render their length, 2');
  assert.doesNotMatch(row(mk(3)), /^\S+ +building +m/, 'the strikes cell is not blank');
  // A ticket with no strikes field defaults to 0, and 0 must be shown, not blank.
  const noStrikes = renderTuiState({
    run: { tickets: { 'T-1': { phase: 'building', model: 'm' } }, pools: {} },
    events: [], transcript: [], selectedTicketIndex: 0, ticketScrollTop: 0,
    showTranscript: false, timelineScrollTop: -1, transcriptScrollTop: 0,
  }, 80, 24);
  assert.match(row(noStrikes), /\b0 m/, 'a missing strikes field renders 0, not blank');
});

test('tui: padTruncate never emits a lone surrogate', () => {
  for (const len of [1, 2, 3, 4, 5, 10, 20]) {
    const out = padTruncate('🎉'.repeat(30), len);
    const lone = [...out].some((ch) => {
      const c = ch.codePointAt(0);
      return c >= 0xd800 && c <= 0xdfff;
    });
    assert.ok(!lone, `lone surrogate at len=${len}: ${JSON.stringify(out)}`);
    assert.ok(visibleWidth(out) <= len, `overflowed at len=${len}: ${JSON.stringify(out)}`);
  }
});

test('tui: padTruncate measures in terminal columns, not code units', () => {
  assert.equal(visibleWidth(padTruncate('日本語テキスト', 20)), 20);
  assert.equal(visibleWidth(padTruncate('日本語テキスト', 6)), 6);
  assert.equal(visibleWidth(padTruncate('🎉🎉🎉', 4)), 4);
});

// The whole point of the rewrite: an idle dashboard must not repaint. The old
// renderer wrote a full 2,123-byte frame every 100ms regardless of whether any
// line had changed.
test('tui: an unchanged state writes zero bytes', { timeout: 5000 }, async () => {
  const repo = mkRepo(RUN);
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });

  await new Promise((r) => setTimeout(r, 80));
  assert.ok(term.writes.length > 0, 'the first paint should write something');

  term.writes.length = 0;
  await new Promise((r) => setTimeout(r, 120)); // many poll ticks, nothing changed
  const idleBytes = term.writes.join('').length;

  term.onInput('q');
  await exit;
  assert.equal(idleBytes, 0, `idle wrote ${idleBytes} bytes: ${JSON.stringify(term.writes)}`);
});

test('tui: a new event repaints', { timeout: 5000 }, async () => {
  const repo = mkRepo(RUN);
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 80));

  term.writes.length = 0;
  writeFileSync(
    join(repo, '.booster', 'logs', 'r1', 'events.jsonl'),
    JSON.stringify({ ts: '2026-07-16T10:00:00Z', type: 'phase', ticket: 'T-1', to: 'done' }) + '\n'
  );
  await new Promise((r) => setTimeout(r, 120));
  const bytes = term.writes.join('').length;

  term.onInput('q');
  await exit;
  assert.ok(bytes > 0, 'a new event should trigger a repaint');
});

test('tui: restores the cursor on exit', { timeout: 5000 }, async () => {
  const repo = mkRepo(RUN);
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 60));
  term.onInput('q');
  await exit;
  assert.equal(term.cursorRestored, true, 'cursor must be restored or the terminal is left broken');
});

// bin/agb.mjs depends on this asymmetry at two call sites, and it is easy to
// "tidy" into an unconditional 'fallback' during a rewrite.
test('tui: falls back without a TTY, and the return value depends on isWatch', { timeout: 5000 }, async () => {
  const repo = mkRepo(RUN);
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await launchTUI(repo, false), 0);
    assert.equal(await launchTUI(repo, true), 'fallback');
  } finally {
    console.log = log;
  }
});

test('tui: q resolves the report exit code once the run is done', { timeout: 5000 }, async () => {
  const repo = mkRepo({ ...RUN, done: true, report: { failed: { 'T-1': 'boom' } } });
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 60));
  term.onInput('q');
  assert.equal(await exit, 2, 'a failed report must exit 2');
});

test('tui: watch mode resolves 2 when the report has failures', { timeout: 5000 }, async () => {
  const repo = mkRepo({ ...RUN, done: true, report: { failed: { 'T-1': 'boom' } } });
  const term = new FakeTerminal();
  assert.equal(await launchTUI(repo, true, 10, { terminal: term }), 2);
});

test('tui: watch mode resolves 0 when the report is clean', { timeout: 5000 }, async () => {
  const repo = mkRepo({ ...RUN, done: true, report: { failed: {} } });
  const term = new FakeTerminal();
  assert.equal(await launchTUI(repo, true, 10, { terminal: term }), 0);
});

test('tui: ctrl-c resolves 130', { timeout: 5000 }, async () => {
  const repo = mkRepo(RUN);
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 60));
  term.onInput('\x03');
  assert.equal(await exit, 130);
});

// Keybindings are a stated contract of the ticket and are trivially easy to
// drop in a rewrite, since nothing else exercises them.
const MULTI = {
  runId: 'r1',
  tickets: {
    'T-1': { phase: 'building', strikes: 0, model: 'm1' },
    'T-2': { phase: 'pending', strikes: 1, model: 'm2' },
    'T-3': { phase: 'pending', strikes: 2, model: 'm3' },
  },
  pools: {},
};

// The selected row is the one wrapped in reverse video.
const selectedIn = (frame) => {
  const m = frame.match(/\x1b\[7m\s*(T-\d)/);
  return m ? m[1] : null;
};

const press = async (term, key) => {
  term.writes.length = 0;
  term.onInput(key);
  await new Promise((r) => setTimeout(r, 40));
  return term.writes.join('');
};

test('tui: up/down move the ticket selection', { timeout: 5000 }, async () => {
  const repo = mkRepo(MULTI);
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(selectedIn(term.writes.join('')), 'T-1', 'first ticket starts selected');

  assert.equal(selectedIn(await press(term, '\x1b[B')), 'T-2', 'down selects T-2');
  assert.equal(selectedIn(await press(term, '\x1b[B')), 'T-3', 'down selects T-3');
  assert.equal(selectedIn(await press(term, '\x1b[A')), 'T-2', 'up returns to T-2');

  term.onInput('q');
  await exit;
});

test('tui: down stops at the last ticket and up stops at the first', { timeout: 5000 }, async () => {
  const repo = mkRepo(MULTI);
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 60));

  for (let i = 0; i < 6; i++) await press(term, '\x1b[B');
  assert.equal(selectedIn(await press(term, '\x1b[B')) ?? 'T-3', 'T-3', 'cannot move past the last ticket');
  for (let i = 0; i < 6; i++) await press(term, '\x1b[A');
  assert.equal(selectedIn(await press(term, '\x1b[A')) ?? 'T-1', 'T-1', 'cannot move above the first ticket');

  term.onInput('q');
  await exit;
});

test('tui: enter toggles the transcript pane', { timeout: 5000 }, async () => {
  const repo = mkRepo(MULTI);
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 60));

  assert.match(await press(term, '\r'), /\(No transcript available\)/, 'enter opens the transcript');
  const closed = await press(term, '\r');
  assert.doesNotMatch(closed, /\(No transcript available\)/, 'enter closes it again');

  term.onInput('q');
  await exit;
});

test('tui: bracket keys and home/end scroll the timeline', { timeout: 5000 }, async () => {
  const repo = mkRepo(MULTI);
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  writeFileSync(
    join(repo, '.booster', 'logs', 'r1', 'events.jsonl'),
    Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ ts: '2026-07-16T10:00:00Z', type: 'phase', ticket: 'T-1', to: 'evt' + i })
    ).join('\n') + '\n'
  );
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 80));

  // Tail is pinned to the newest event until we scroll away from it.
  assert.match(term.writes.join(''), /evt59/, 'timeline starts at the tail');
  assert.match(await press(term, '['), /evt/, 'scrolling back redraws the timeline');
  assert.match(await press(term, '\x1b[H'), /evt0/, 'home (CSI H) jumps to the oldest event');
  assert.match(await press(term, '\x1b[F'), /evt59/, 'end (CSI F) returns to the newest');
  // The KEY_FALLBACK entries: the CSI ~ encodings parseKey does not resolve.
  assert.match(await press(term, '\x1b[1~'), /evt0/, 'home (CSI 1~) jumps to the oldest event');
  assert.match(await press(term, '\x1b[4~'), /evt59/, 'end (CSI 4~) returns to the newest');

  term.onInput('q');
  await exit;
});

test('tui: pageup/pagedown scroll the transcript', { timeout: 5000 }, async () => {
  const repo = mkRepo(MULTI);
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  writeFileSync(
    join(repo, '.booster', 'logs', 'r1', 'T-1.jsonl'),
    JSON.stringify({
      strike: 1,
      prompt: Array.from({ length: 40 }, (_, i) => 'prompt-line-' + i).join('\n'),
      output: Array.from({ length: 40 }, (_, i) => 'output-line-' + i).join('\n'),
    }) + '\n'
  );
  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 80));

  await press(term, '\r'); // open transcript
  const down = await press(term, '\x1b[6~');
  assert.match(down, /prompt-line-/, 'pagedown advances through the transcript');
  const up = await press(term, '\x1b[5~');
  assert.match(up, /PROMPT|prompt-line-/, 'pageup scrolls back');

  term.onInput('q');
  await exit;
});

test('tui: the event buffer stays bounded on a long run', { timeout: 5000 }, async () => {
  const repo = mkRepo(RUN);
  mkdirSync(join(repo, '.booster', 'logs', 'r1'), { recursive: true });
  const lines = Array.from({ length: 2500 }, (_, i) =>
    JSON.stringify({ ts: '2026-07-16T10:00:00Z', type: 'phase', ticket: 'T-1', to: 'p' + i })
  ).join('\n') + '\n';
  writeFileSync(join(repo, '.booster', 'logs', 'r1', 'events.jsonl'), lines);

  const term = new FakeTerminal();
  const exit = launchTUI(repo, false, 10, { terminal: term });
  await new Promise((r) => setTimeout(r, 120));
  term.onInput('q');
  await exit;
  // The frame still renders, and the tail (the newest events) is what survives.
  assert.ok(term.writes.join('').includes('p2499'), 'the newest event must still be visible');
});
