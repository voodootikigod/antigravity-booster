import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyDrift } from '../scripts/release-drift.mjs';

// The two cases below are the incidents this check exists for. If either stops
// being detected, a release can strand silently again — so they are asserted on
// status, not just on ok-ness.

test('release-drift: in sync when manifest matches npm', () => {
  const r = classifyDrift({ manifestVersion: '0.5.0', npmLatest: '0.5.0', tags: ['v0.5.0'] });
  assert.equal(r.status, 'ok');
  assert.equal(r.ok, true);
});

test('release-drift: untagged bump is drift (the v0.5.0 failure)', () => {
  // Bump landed on main inside a feature PR; no tag was ever pushed, so no
  // publish run exists. Aged past the grace window so it is not "in flight".
  const r = classifyDrift({
    manifestVersion: '0.5.0',
    npmLatest: '0.4.3',
    tags: ['v0.4.3'],
    bumpAgeMinutes: 60 * 24,
  });
  assert.equal(r.status, 'untagged');
  assert.equal(r.ok, false);
  // The dangerous response is bumping on top, which skips the version on npm.
  assert.match(r.message, /Do NOT bump on top/);
});

test('release-drift: tag waiting on the approval gate is drift (the v0.4.3 failure)', () => {
  const r = classifyDrift({
    manifestVersion: '0.4.3',
    npmLatest: '0.4.2',
    tags: ['v0.4.3'],
    runStatus: 'waiting',
    bumpAgeMinutes: 60 * 24,
  });
  assert.equal(r.status, 'awaiting-approval');
  assert.equal(r.ok, false);
  assert.match(r.message, /never publish on its own/);
});

test('release-drift: a fresh untagged bump is in-flight, not drift', () => {
  // A release in progress must not fire the alarm — a check that goes off on
  // every healthy release gets muted, and a muted check catches nothing.
  const r = classifyDrift({
    manifestVersion: '0.6.0',
    npmLatest: '0.5.0',
    tags: ['v0.5.0'],
    bumpAgeMinutes: 5,
  });
  assert.equal(r.status, 'in-flight');
  assert.equal(r.ok, true);
});

test('release-drift: the grace window expires', () => {
  // Same facts as above but aged out — this is what stops the in-flight
  // suppression from swallowing a genuinely stranded release forever.
  const r = classifyDrift({
    manifestVersion: '0.6.0',
    npmLatest: '0.5.0',
    tags: ['v0.5.0'],
    bumpAgeMinutes: 91,
  });
  assert.equal(r.status, 'untagged');
  assert.equal(r.ok, false);
});

test('release-drift: an unreachable registry is undetermined, not clean', () => {
  // "I could not look" must never read as "it is fine".
  const r = classifyDrift({ manifestVersion: '0.5.0', npmLatest: null, tags: ['v0.5.0'] });
  assert.equal(r.status, 'undetermined');
  assert.equal(r.ok, false);
});

test('release-drift: a failed publish run strands the tag', () => {
  const r = classifyDrift({
    manifestVersion: '0.5.0',
    npmLatest: '0.4.3',
    tags: ['v0.5.0'],
    runStatus: 'completed',
    runConclusion: 'failure',
    bumpAgeMinutes: 60 * 24,
  });
  assert.equal(r.status, 'publish-failed');
  assert.equal(r.ok, false);
});

test('release-drift: a tag with no run at all is drift', () => {
  const r = classifyDrift({
    manifestVersion: '0.5.0',
    npmLatest: '0.4.3',
    tags: ['v0.5.0'],
    runStatus: null,
    bumpAgeMinutes: 60 * 24,
  });
  assert.equal(r.status, 'no-run');
  assert.equal(r.ok, false);
});

test('release-drift: a green run that did not reach npm is drift', () => {
  // The precise reason verification asserts the registry rather than CI status:
  // a successful run is not proof the artifact exists.
  const r = classifyDrift({
    manifestVersion: '0.5.0',
    npmLatest: '0.4.3',
    tags: ['v0.5.0'],
    runStatus: 'completed',
    runConclusion: 'success',
    bumpAgeMinutes: 60 * 24,
  });
  assert.equal(r.status, 'published-but-missing');
  assert.equal(r.ok, false);
  assert.match(r.message, /green run is not a publish/);
});

test('release-drift: an in-progress publish is not drift', () => {
  const r = classifyDrift({
    manifestVersion: '0.5.0',
    npmLatest: '0.4.3',
    tags: ['v0.5.0'],
    runStatus: 'in_progress',
    bumpAgeMinutes: 60 * 24,
  });
  assert.equal(r.status, 'in-flight');
  assert.equal(r.ok, true);
});
