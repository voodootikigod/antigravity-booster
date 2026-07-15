import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padTruncate, renderTuiState } from '../lib/tui.mjs';

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
