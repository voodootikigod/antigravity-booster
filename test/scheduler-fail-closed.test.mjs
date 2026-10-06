// T-PLUGIN-02 item 4: the §4.2 enforcement gate. When rails are declared (by
// the target repo's active tickets or the plan) and the rails engine cannot be
// trusted — ticket store unreadable, adlc unauthenticated, rails-guard
// erroring — nothing is dispatched or merged. Audit-only gates keep warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';

import { runPlan } from '../lib/scheduler.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_fail_closed_test.json');

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));
const quiet = { log: () => {} };

function git(dir, ...a) {
  return execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
}

function makeRepo({ storeTickets = null, corruptShard = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agb-fail-closed-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  writeFileSync(join(dir, 'RAIL.txt'), 'frozen\n');
  if (storeTickets || corruptShard) {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    initializeDirectoryStore(join(dir, '.adlc', 'tickets'));
    for (const t of storeTickets ?? []) {
      const shard = { title: 't', body: 'b', scope: [], rails: [], edges: [], ...t };
      writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename(t.id)), JSON.stringify(shard, null, 2) + '\n');
    }
    if (corruptShard) writeFileSync(join(dir, '.adlc', 'tickets', ticketFilename('BROKEN')), '{not json');
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

// A vendor-less plugin root so resolveAdlcBinary reaches no trusted tier.
const noVendorRoot = mkdtempSync(join(tmpdir(), 'agb-no-vendor-'));
test.after(() => rmSync(noVendorRoot, { recursive: true, force: true }));

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

const trusted = (state, extra = {}) => ({
  AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1', FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0', ...extra,
});
const untrusted = (state, extra = {}) => ({
  AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: undefined, ADLC_CLI_PATH: undefined, AGB_ALLOW_CUSTOM_ADLC_CLI: undefined,
  AGB_ALLOW_SYSTEM_ADLC: undefined, AGB_PLUGIN_ROOT: noVendorRoot, FAKE_STATE_DIR: state, AGB_SANDBOX_GATES: '0', ...extra,
});

const headOf = (repo) => git(repo, 'rev-parse', 'HEAD').trim();

test('unauthenticated adlc + plan-declared rails: refuses to dispatch, repo untouched', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  const before = headOf(repo);
  try {
    await assert.rejects(
      withEnv(untrusted(state), () => runPlan({
        repo, gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'] }],
      }, quiet)),
      /enforcement gate: .*adlc/i,
    );
    assert.equal(headOf(repo), before, 'no commit (not even .gitignore) landed');
    assert.equal(existsSync(join(state, 'builds')), false, 'no builder was dispatched');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('unauthenticated adlc + store-declared rails: refuses to dispatch', async () => {
  const repo = makeRepo({ storeTickets: [{ id: 'S-1', rails: ['RAIL.txt'] }] });
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  try {
    await assert.rejects(
      withEnv(untrusted(state), () => runPlan({
        repo, gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)),
      /enforcement gate: .*adlc/i,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('corrupt ticket shard: refuses to dispatch even when adlc is trusted and the plan declares no rails', async () => {
  const repo = makeRepo({ corruptShard: true });
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  const before = headOf(repo);
  try {
    await assert.rejects(
      withEnv(trusted(state), () => runPlan({
        repo, gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)),
      /enforcement gate: ticket store unreadable/,
    );
    assert.equal(headOf(repo), before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('no rails anywhere: an unauthenticated adlc only degrades (audit gates warn), the run still merges', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  const lines = [];
  try {
    const report = await withEnv(untrusted(state), () => runPlan({
      repo, gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
    }, { log: (l) => lines.push(l) }));
    assert.deepEqual(report.merged, ['T1']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('active store rails are enforced post-hoc even when the plan ticket declares none', async () => {
  const repo = makeRepo({ storeTickets: [{ id: 'S-1', rails: ['RAIL.txt'] }] });
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  try {
    const report = await withEnv(trusted(state, { FAKE_BUILDER_MODE: 'rail' }), () => runPlan({
      repo, gate: { test: 'true' },
      tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt', 'RAIL.txt'] }],
    }, quiet));
    assert.equal(report.merged.length, 0);
    assert.match(report.failed.T1, /rail violation.*RAIL\.txt/);
    assert.match(readFileSync(join(state, 'rails-guard-invocations'), 'utf8'), /rails=.*RAIL\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('rails-guard operational error: the run is compromised and nothing merges', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  const before = headOf(repo);
  try {
    const report = await withEnv(trusted(state, { FAKE_RAILS_GUARD_MODE: 'error' }), () => runPlan({
      repo, gate: { test: 'true' },
      tickets: [
        { id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: ['RAIL.txt'] },
        { id: 'T2', title: 'two', body: 'y', scope: ['T2.txt'] },
      ],
    }, quiet));
    assert.equal(report.merged.length, 0, 'no ticket merges once the rails engine is unverifiable');
    assert.match(report.failed.T1, /run compromised: .*rails-guard/);
    assert.ok(report.compromised, 'report flags the run as compromised');
    assert.equal(git(repo, 'log', '--format=%s', `${before}..HEAD`).includes('T2'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

// enforcementGate is pure; pin every branch directly.
import { enforcementGate } from '../lib/run-integrity.mjs';

const okStore = (rails = []) => ({ ok: true, adlc: true, hasActiveTickets: rails.length > 0, rails });
const authed = { ok: true, binary: '/x/adlc' };
const unauthed = { ok: false, error: 'no trusted tier' };

test('enforcementGate: unreadable store blocks regardless of adlc or plan rails', () => {
  for (const adlc of [authed, unauthed]) {
    for (const planRails of [true, false]) {
      const r = enforcementGate({ activeRails: { ok: false, error: 'STORE_CORRUPT: x', railsPresent: true }, planRails, adlc });
      assert.equal(r.ok, false);
      assert.match(r.reason, /ticket store unreadable \(STORE_CORRUPT: x\)/);
    }
  }
});

test('enforcementGate: rails from the plan or the store need an authenticated adlc', () => {
  assert.equal(enforcementGate({ activeRails: okStore(), planRails: true, adlc: unauthed }).ok, false);
  const fromStore = enforcementGate({ activeRails: okStore(['RAIL.txt']), planRails: false, adlc: unauthed });
  assert.equal(fromStore.ok, false);
  assert.match(fromStore.reason, /not authenticated \(no trusted tier\)/);
});

test('enforcementGate: passes with an authenticated adlc, or with no rails anywhere', () => {
  assert.deepEqual(enforcementGate({ activeRails: okStore(['A', 'B']), planRails: true, adlc: authed }), { ok: true, railsPresent: true, storeRails: ['A', 'B'] });
  assert.deepEqual(enforcementGate({ activeRails: okStore(), planRails: false, adlc: unauthed }), { ok: true, railsPresent: false, storeRails: [] });
});

import { isWellFormedRail } from '../lib/run-integrity.mjs';

test('isWellFormedRail: blank or unbalanced globs are rejected, ordinary globs pass', () => {
  for (const bad of ['', '   ', '[', 'a]', '{a', 'a}', '[]]', null, 3]) assert.equal(isWellFormedRail(bad), false, String(bad));
  for (const good of ['RAIL.txt', 'lib/**', 'src/[ab].js', '*.{js,mjs}']) assert.equal(isWellFormedRail(good), true, good);
});

test('enforcementGate: a malformed rail blocks the run instead of silently enforcing nothing', () => {
  const r = enforcementGate({ activeRails: okStore(), planRails: true, adlc: authed, rails: ['ok/**', '['] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /malformed rail glob\(s\) \["\["\]/);
});

test('runPlan: a plan ticket with a malformed rail dispatches nothing', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-fc-state-'));
  try {
    await assert.rejects(
      withEnv(trusted(state), () => runPlan({
        repo, gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'], rails: [''] }],
      }, quiet)),
      /malformed rail glob/,
    );
    assert.equal(existsSync(join(state, 'builds')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
