import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { isActiveTicket, unionActiveRails, findAdlcRoot, resolveTicket } from '../lib/active-rails.mjs';

function makeRepo({ adlc = true, store = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agb-active-rails-'));
  if (adlc) mkdirSync(join(root, '.adlc'), { recursive: true });
  if (adlc && store) initializeDirectoryStore(join(root, '.adlc', 'tickets'));
  return root;
}

function writeShard(root, ticket) {
  const t = { title: 't', body: 'b', scope: [], rails: [], edges: [], ...ticket };
  writeFileSync(join(root, '.adlc', 'tickets', ticketFilename(t.id)), JSON.stringify(t, null, 2) + '\n');
}

test('isActiveTicket: no status and no completed flag is active (fail closed)', () => {
  assert.equal(isActiveTicket({ id: 'T1' }), true);
});

test('isActiveTicket: unknown in-flight statuses stay active', () => {
  for (const status of ['open', 'in_progress', 'in-review', 'blocked', 'weird']) {
    assert.equal(isActiveTicket({ id: 'T1', status }), true, status);
  }
});

test('isActiveTicket: completed, closed, archived statuses are inactive', () => {
  for (const status of ['completed', 'closed', 'archived']) {
    assert.equal(isActiveTicket({ id: 'T1', status }), false, status);
  }
});

test('isActiveTicket: the store completion flag (completed: true) is inactive; completed: false is active', () => {
  assert.equal(isActiveTicket({ id: 'T1', completed: true }), false);
  assert.equal(isActiveTicket({ id: 'T1', completed: false }), true);
  assert.equal(isActiveTicket({ id: 'T1', completed: 'true' }), true, 'only the boolean true retires a ticket');
});

test('isActiveTicket: non-object input is treated as active (fail closed)', () => {
  assert.equal(isActiveTicket(null), true);
  assert.equal(isActiveTicket(undefined), true);
  assert.equal(isActiveTicket('T1'), true);
});

test('unionActiveRails: repo without .adlc is not an ADLC repo and has no rails', () => {
  const root = makeRepo({ adlc: false });
  try {
    assert.deepEqual(unionActiveRails(root), { ok: true, adlc: false, hasActiveTickets: false, rails: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unionActiveRails: .adlc without a ticket store has no active tickets', () => {
  const root = makeRepo({ store: false });
  try {
    assert.deepEqual(unionActiveRails(root), { ok: true, adlc: true, hasActiveTickets: false, rails: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unionActiveRails: unions and dedupes rails across active tickets, ignoring inactive ones', () => {
  const root = makeRepo();
  try {
    writeShard(root, { id: 'T1', rails: ['lib/lock.mjs', 'lib/gates.mjs'] });
    writeShard(root, { id: 'T2', rails: ['lib/gates.mjs', 'bin/**'] });
    writeShard(root, { id: 'T3', rails: ['retired.mjs'], completed: true });
    writeShard(root, { id: 'T4', rails: ['also-retired.mjs'], status: 'archived' });
    const r = unionActiveRails(root);
    assert.equal(r.ok, true);
    assert.equal(r.adlc, true);
    assert.equal(r.hasActiveTickets, true);
    assert.deepEqual(r.rails, ['bin/**', 'lib/gates.mjs', 'lib/lock.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unionActiveRails: active tickets with rails: [] report hasActiveTickets but no rails', () => {
  const root = makeRepo();
  try {
    writeShard(root, { id: 'T1', rails: [] });
    assert.deepEqual(unionActiveRails(root), { ok: true, adlc: true, hasActiveTickets: true, rails: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unionActiveRails: a corrupt shard fails closed with railsPresent', () => {
  const root = makeRepo();
  try {
    writeShard(root, { id: 'T1', rails: ['lib/lock.mjs'] });
    writeFileSync(join(root, '.adlc', 'tickets', ticketFilename('T2')), '{not json');
    const r = unionActiveRails(root);
    assert.equal(r.ok, false);
    assert.equal(r.railsPresent, true);
    assert.match(r.error, /\S/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unionActiveRails: a misnamed shard fails closed rather than being skipped', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, '.adlc', 'tickets', 'stray.json'), JSON.stringify({ id: 'Z', title: 't', body: 'b', scope: [], rails: [], edges: [] }));
    const r = unionActiveRails(root);
    assert.equal(r.ok, false);
    assert.equal(r.railsPresent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findAdlcRoot: walks up from a nested (possibly non-existent) path to the nearest .adlc ancestor', () => {
  const root = makeRepo();
  try {
    mkdirSync(join(root, 'lib', 'deep'), { recursive: true });
    assert.equal(findAdlcRoot(join(root, 'lib', 'deep', 'file.mjs')), root);
    assert.equal(findAdlcRoot(join(root, 'not', 'yet', 'created.mjs')), root);
    assert.equal(findAdlcRoot(root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findAdlcRoot: returns null outside any ADLC repo', () => {
  const root = makeRepo({ adlc: false });
  try {
    assert.equal(findAdlcRoot(join(root, 'x.mjs')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveTicket: finds a ticket by id field regardless of shard filename hash', () => {
  const root = makeRepo();
  try {
    writeShard(root, { id: 'T-PLUGIN-01-CORE', scope: ['lib/**'], rails: ['lib/lock.mjs'] });
    const r = resolveTicket(root, 'T-PLUGIN-01-CORE');
    assert.equal(r.ok, true);
    assert.equal(r.ticket.id, 'T-PLUGIN-01-CORE');
    assert.deepEqual(r.ticket.scope, ['lib/**']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveTicket: missing id and unreadable store both fail closed', () => {
  const root = makeRepo();
  try {
    assert.deepEqual(resolveTicket(root, 'NOPE'), { ok: false, error: 'ticket not found: NOPE' });
    writeFileSync(join(root, '.adlc', 'tickets', ticketFilename('T2')), '{not json');
    const r = resolveTicket(root, 'T2');
    assert.equal(r.ok, false);
    assert.match(r.error, /\S/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
