import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, padTruncate, renderTuiState } from '../lib/tui.mjs';

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
