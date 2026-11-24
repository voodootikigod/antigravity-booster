import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttentionTransitionTracker,
  formatOsc8FileLink,
  formatOscAttentionAlert,
  sanitizeOscField,
  stripOscAndAnsi,
} from '../lib/terminal-osc.mjs';

test('formatOsc8FileLink & stripOscAndAnsi: preserve exact visible column width and strip ESC/BEL/C0/C1 injection bytes', () => {
  const link = formatOsc8FileLink('/workspace/repo/lib/foo.mjs', 'lib/foo.mjs:42', {
    line: 42,
    enabled: true,
  });
  assert.match(link, /^\x1b\]8;;file:\/\/\/workspace\/repo\/lib\/foo\.mjs#L42\x07lib\/foo\.mjs:42\x1b\]8;;\x07$/);
  assert.equal(stripOscAndAnsi(link), 'lib/foo.mjs:42');
  assert.equal(stripOscAndAnsi(link).length, 'lib/foo.mjs:42'.length);

  // Disabled mode returns plain sanitized label
  assert.equal(
    formatOsc8FileLink('/workspace/repo/lib/foo.mjs', 'lib/foo.mjs', { enabled: false }),
    'lib/foo.mjs'
  );

  // Relative paths never emit broken file:// URIs
  assert.equal(
    formatOsc8FileLink('relative/foo.mjs', 'relative/foo.mjs', { enabled: true }),
    'relative/foo.mjs'
  );

  // Hostile path & label with embedded OSC/BEL/newline/semicolon escapes are neutralized
  const evilLink = formatOsc8FileLink(
    '/tmp/evil;dir\x07\x1b]9;PWNED\x07/a.js',
    'a.js\x1b[31m\r\n\x07',
    { line: 7, enabled: true }
  );
  assert.doesNotMatch(evilLink, /PWNED|\r|\n/);
  assert.match(evilLink, /%3Bdir/);
  assert.equal(stripOscAndAnsi(evilLink), 'a.js');

  // Nested escape reconstruction & inner CSI inside OSC payloads are neutralized in one pass
  const spliced = stripOscAndAnsi('\x1b\x1bA]9;PWNED\x07');
  assert.equal(spliced.includes('\x1b'), false, 'must never leave ESC byte in stripped output');
  const oscWithInnerCsi = stripOscAndAnsi('\x1b]8;;file:///a\x1b[31mb\x07visible\x1b]8;;\x07');
  assert.equal(oscWithInnerCsi, 'visible');
});

test('formatOscAttentionAlert & AttentionTransitionTracker: sanitize notifications and fire strictly once per edge transition', () => {
  assert.equal(formatOscAttentionAlert('Title', 'Body', { enabled: false }), '');

  const osc9 = formatOscAttentionAlert('Needs;Rescue\x07', 'Ticket T1\nfailed', {
    protocol: 'osc9',
    enabled: true,
  });
  assert.equal(osc9, '\x1b]9;Needs:Rescue: Ticket T1failed\x07');

  const osc777 = formatOscAttentionAlert('AGB;Alert', 'P6;Ready', {
    protocol: 'osc777',
    enabled: true,
  });
  assert.equal(osc777, '\x1b]777;notify;AGB:Alert;P6:Ready\x07');
  assert.equal(sanitizeOscField('clean\x1b]0;spoof\x07\x9b31mtext'), 'cleantext');

  const tracker = new AttentionTransitionTracker();
  const baseState = {
    runId: 'run-1',
    done: false,
    failed: new Set(['T1']),
    runwayWarning: true,
    pools: { quota: { paused: true, depletionCause: 'five_hour_depletion' } },
  };

  // Tick 1: fires all 3 rising edges once
  const first = tracker.evaluate(baseState);
  assert.deepEqual(
    first.map((a) => a.kind),
    ['ticket_failed', 'runway_warning', 'quota_paused']
  );

  // Tick 2 with identical state: zero duplicate alerts!
  assert.deepEqual(tracker.evaluate(baseState), []);

  // Tick 3: T2 fails and run finishes -> fires only new T2 failure + run_done
  const doneState = {
    ...baseState,
    done: true,
    failed: new Set(['T1', 'T2']),
  };
  const third = tracker.evaluate(doneState);
  assert.deepEqual(
    third.map((a) => a.kind),
    ['ticket_failed', 'run_done']
  );
  assert.equal(third[0].ticketId, 'T2');

  // Tick 4 after completion: zero duplicate done alerts
  assert.deepEqual(tracker.evaluate(doneState), []);

  // Tick 5: when T1 leaves failed (e.g. rescued/retried) and later fails again, or runId changes, re-alerts cleanly
  assert.deepEqual(tracker.evaluate({ runId: 'run-1', done: false, failed: new Set() }), []);
  const reFailed = tracker.evaluate({ runId: 'run-1', done: false, failed: new Set(['T1']) });
  assert.deepEqual(reFailed.map((a) => a.kind), ['ticket_failed']);
  const nextRun = tracker.evaluate({ runId: 'run-2', done: false, failed: new Set(['T1']) });
  assert.deepEqual(nextRun.map((a) => a.kind), ['ticket_failed']);
});
