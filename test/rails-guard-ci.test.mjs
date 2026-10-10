// T-RAILS-GUARD-DIRSTORE: CI rail-freeze gate over the .adlc/tickets/ directory store.
// Fully offline: throwaway repos under os.tmpdir(), fake adlc on PATH, real
// history replayed from this repo's own object store (skipped when shallow).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  ACTIVE_DIR, ARCHIVE_DIR, ACTIVE_MANIFEST, ARCHIVE_MANIFEST, TRUST_ROOTS, MAX_SHARD_BYTES,
  canonicalJson, prettyCanonicalJson, ticketHash, ticketFilename, isValidRail, shapeError,
  makeGit, gitTree, loadStore, evaluate, verifyArchive, checkDirTransitions, main, Deny,
} from '../scripts/rails-guard-ci.mjs';
import { Repo, ROOT, GUARD, baseTicket, archivedShard, sh } from './fixtures/rails-guard-ci/repo.mjs';

// @adlc/tickets does not export lib/canonical.mjs or lib/filename.mjs; load them
// by file path from the installed (pinned 1.11.1) devDependency.
const ticketsDir = join(createRequire(import.meta.url).resolve('@adlc/tickets/package.json'), '..');
const lib = await import(pathToFileURL(join(ticketsDir, 'lib', 'canonical.mjs')).href);
const libName = await import(pathToFileURL(join(ticketsDir, 'lib', 'filename.mjs')).href);
const TICKETS_VERSION = JSON.parse(readFileSync(join(ticketsDir, 'package.json'), 'utf8')).version;

const withRepo = (fn) => () => { const r = new Repo(); try { return fn(r); } finally { r.cleanup(); } };
const expect = (r, code, re) => {
  const res = r.run();
  assert.equal(res.code, code, res.out);
  if (re) assert.match(res.out, re);
  return res;
};
const T = (id, extra) => baseTicket(id, extra);

// ---------------------------------------------------------------- parity
test('parity: mirror is pinned to @adlc/tickets 1.11.1', () => assert.equal(TICKETS_VERSION, '1.11.1'));

test('parity: ticketFilename matches @adlc/tickets and the real shard name', () => {
  assert.equal(ticketFilename('T-LOCKEXEC-SEAL-COVERAGE'),
    't-lockexec-seal-coverage--740b14bf66139ac40827d77447009e98604922ecd31f7ef704cd5ff0042b3e3d.json');
  for (const id of ['T-LOCKEXEC-SEAL-COVERAGE', 'Ünïcödé-ﬁ-Ticket', 'x'.repeat(47) + '-' + 'y'.repeat(20), '!!!', '---a---', 'Ⅻ']) {
    assert.equal(ticketFilename(id), libName.ticketFilename(id), id);
  }
});

test('parity: canonicalJson / prettyCanonicalJson / ticketHash match @adlc/tickets', () => {
  const samples = [
    T('Ünïcödé'), { b: 1, a: [{ z: null, y: 'é' }], '10': 1, '9': 2, 'B': true }, { 'é': 1, 'e': 2, 'Z': 3 },
    { id: 'x', nested: { c: [3, 2, 1], a: { '2': 'x', '1': 'y' } } },
  ];
  for (const s of samples) {
    assert.equal(canonicalJson(s), lib.canonicalJson(s));
    assert.equal(prettyCanonicalJson(s), lib.prettyCanonicalJson(s));
    assert.equal(ticketHash(s), lib.ticketHash(s));
  }
});

test('parity: every real _adlcArchive shard re-hashes to its recorded ticketHash', () => {
  const dir = join(ROOT, ARCHIVE_DIR);
  let checked = 0;
  for (const name of readdirSync(dir)) {
    if (name === '.store.json') continue;
    const v = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.equal(ticketFilename(v.id), name);
    if (!v._adlcArchive) continue;
    const { _adlcArchive: meta, ...rest } = v;
    assert.equal(ticketHash(rest), meta.ticketHash, name);
    assert.equal(ticketHash(rest), lib.ticketHash(rest), name);
    checked++;
  }
  assert.ok(checked > 0, 'expected at least one enveloped archive shard');
});

// ---------------------------------------------------------------- real store
test('real repo HEAD store loads (active + archive, legacy shards without envelope)', () => {
  const git = makeGit(ROOT);
  const head = gitTree(git, 'HEAD', 'base');
  assert.ok(loadStore(head, ACTIVE_DIR, ACTIVE_MANIFEST, { active: true }) instanceof Map);
  const arc = loadStore(head, ARCHIVE_DIR, ARCHIVE_MANIFEST, { active: false });
  assert.ok(arc.size > 0);
  assert.ok([...arc.values()].some(({ ticket }) => !ticket._adlcArchive), 'expected a migrated legacy archive shard');
});

// ---------------------------------------------------------------- unit helpers
test('isValidRail / shapeError', () => {
  for (const r of ['lib/a.mjs', 'lib/**']) assert.ok(isValidRail(r));
  for (const r of ['', ':(glob)x', '-rf', 'a\0b', 1, null]) assert.ok(!isValidRail(r), String(r));
  assert.equal(shapeError(T('A'), { active: true }), null);
  assert.match(shapeError([], { active: true }), /object/);
  assert.match(shapeError({ title: 't' }, { active: true }), /id/);
  assert.match(shapeError({ id: 'A' }, { active: true }), /title/);
  assert.match(shapeError(T('A', { scope: [1] }), { active: true }), /scope/);
  assert.match(shapeError(T('A', { rails: ['-x'] }), { active: true }), /rails/);
  assert.match(shapeError(T('A', { rails: 'x' }), { active: true }), /rails/);
  assert.match(shapeError(T('A', { edges: [{}] }), { active: true }), /edges/);
  assert.match(shapeError(T('A', { edges: {} }), { active: true }), /edges/);
  assert.match(shapeError(T('A', { duration: 0 }), { active: true }), /duration/);
  assert.equal(shapeError(T('A', { duration: 2 }), { active: true }), null);
  assert.match(shapeError(T('A', { completed: 'true' }), { active: true }), /completed/);
  assert.equal(shapeError(T('A', { completed: 'true' }), { active: false }), null);
  assert.match(shapeError({ ...T('A'), _adlcArchive: {} }, { active: true }), /_adlcArchive/);
});

test('verifyArchive accepts a well-formed envelope and rejects each malformation', () => {
  const b = T('A', { rails: ['lib/x.mjs'] });
  verifyArchive(b, archivedShard(b));
  verifyArchive(b, archivedShard(b, { sourceRevision: 'abc' }));
  const noRev = { ...archivedShard(b)._adlcArchive };
  delete noRev.sourceRevision;
  verifyArchive(b, { ...archivedShard(b), _adlcArchive: noRev });
  const bad = [
    [[], /not an object/],
    [{ ...b, completed: true }, /lacks an _adlcArchive/],
    [archivedShard(b, { extra: 1 }), /undeclared key extra/],
    [archivedShard(b, { version: 2 }), /version 1/],
    [archivedShard(b, { reason: 'done' }), /version 1/],
    [archivedShard(b, { archivedAt: 'not a date' }), /archivedAt/],
    [archivedShard(b, { archivedAt: 5 }), /archivedAt/],
    [archivedShard(b, { ticketHash: 'f'.repeat(64) }), /ticketHash does not match/],
    [archivedShard(b, { ticketHash: 'xyz' }), /hashes malformed/],
    [archivedShard(b, { sourceStoreHash: undefined }), /hashes malformed/],
    [archivedShard(b, { sourceRevision: 5 }), /sourceRevision/],
    [{ ...archivedShard(b), completed: 'true' }, /completed: true/],
    [archivedShard({ ...b, rails: [] }), /contract differs/],
  ];
  for (const [a, re] of bad) assert.throws(() => verifyArchive(b, a), (e) => e instanceof Deny && re.test(e.message), re.source);
});

// ---------------------------------------------------------------- pass cases
test('pass: no .adlc on base (bootstrap) exits 0; bootstrap-unverified exits 2', withRepo((r) => {
  r.write('src/a.mjs', '1').base().write('src/a.mjs', '2').merge();
  expect(r, 0, /bootstrap PR/);
  const res = r.run(['--base', 'origin/main', '--bootstrap-unverified']);
  assert.equal(res.code, 2, res.out);
}));

test('pass: .adlc with config but no ticket store protects trust roots only', withRepo((r) => {
  r.write('.adlc/config.json', {}).base().write('src/a.mjs', '2').merge();
  expect(r, 0, /trust roots only/);
}));

test('pass: no store at base, valid directory store introduced at HEAD', withRepo((r) => {
  r.write('.adlc/config.json', {}).base()
    .write(`${ACTIVE_DIR}/.store.json`, ACTIVE_MANIFEST).ticket(T('N')).merge();
  expect(r, 0);
}));

test('pass: new active shard (#85 shape)', withRepo((r) => {
  r.dirStore().base().ticket(T('NEW', { rails: ['lib/lock.mjs'], edges: [] })).write('lib/lock.mjs', 'x').merge();
  expect(r, 0, /0 active ticket/);
}));

test('pass: complete in place', withRepo((r) => {
  const a = T('A', { rails: ['lib/r.mjs'] });
  r.dirStore().ticket(a).base().ticket({ ...a, completed: true }).merge();
  expect(r, 0, /frozen rails \(1\): lib\/r\.mjs/);
  assert.match(r.railsGuardLog(), /rails=,?lib\/r\.mjs/);
}));

test('pass: complete+archive via the real adlc ticket CLI (#86 shape)', withRepo((r) => {
  const adlc = join(ROOT, 'node_modules', '.bin', 'adlc');
  r.dirStore().base('base0');
  r.git('checkout', '-q', 'main');
  sh(r.dir, adlc, ['ticket', 'create', '--input', '-', '--write'],
    { input: JSON.stringify({ id: 'T-A', title: 'a', body: 'b', scope: ['x'], rails: ['lib/r.mjs'], edges: [] }) });
  r.commit('ticket');
  r.git('update-ref', 'refs/remotes/origin/main', 'main');
  r.git('branch', '-f', 'pr', 'main');
  r.git('checkout', '-q', 'pr');
  sh(r.dir, adlc, ['ticket', 'complete', 'T-A', '--write', '--authorize', '--allow-unsigned']);
  sh(r.dir, adlc, ['ticket', 'archive', 'T-A', '--write', '--authorize', '--allow-unsigned']);
  r.rm('.adlc/manifest.jsonl').rm('.adlc/ticket-transactions').rm('.adlc/tickets.lock');
  r.merge();
  expect(r, 0, /1 active ticket\(s\), 0 archived/);
}));

test('pass: archive + new ticket + unrelated code together (#82 shape)', withRepo((r) => {
  const a = T('A', { rails: ['lib/r.mjs'] });
  r.dirStore().ticket(a).base();
  r.rm(r.shardPath('A')).archived(a).ticket(T('B', { rails: ['lib/r.mjs'] })).write('src/app.mjs', 'changed').merge();
  expect(r, 0);
}));

test('pass: a base ticket already completed:true does not freeze its rails', withRepo((r) => {
  r.dirStore().ticket(T('A', { rails: ['src/app.mjs'], completed: true })).base().write('src/app.mjs', 'edit').merge();
  const res = expect(r, 0, /frozen rails \(0\)/);
  assert.equal(r.railsGuardLog(), '', res.out);
}));

test('pass: manifest.jsonl append-only', withRepo((r) => {
  r.dirStore().write('.adlc/manifest.jsonl', '{"a":1}\n').base().write('.adlc/manifest.jsonl', '{"a":1}\n{"b":2}\n').merge();
  expect(r, 0);
}));

test('pass: legacy tickets.json base with an additive change', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('.adlc/tickets.json', { tickets: [T('A', { rails: ['lib/r.mjs'] })] }).base()
    .write('.adlc/tickets.json', { tickets: [T('A', { rails: ['lib/r.mjs'] }), T('B')] }).merge();
  expect(r, 0, /frozen rails \(1\)/);
}));

// ---------------------------------------------------------------- rail enforcement
test('rails: editing a frozen rail of an active base ticket denies; both rails passed to adlc', withRepo((r) => {
  r.dirStore().write('lib/lock.mjs', 'a').write('lib/gates.mjs', 'a')
    .ticket(T('A', { rails: ['lib/lock.mjs', 'lib/gates.mjs'] })).base().write('lib/lock.mjs', 'b').merge();
  expect(r, 2);
  const log = r.railsGuardLog();
  assert.match(log, /lib\/lock\.mjs/);
  assert.match(log, /lib\/gates\.mjs/);
}));

test('rails: archiving a ticket does not unfreeze its rail within the same PR', withRepo((r) => {
  const a = T('A', { rails: ['lib/lock.mjs', 'lib/gates.mjs'] });
  r.dirStore().write('lib/gates.mjs', 'a').ticket(a).base();
  r.rm(r.shardPath('A')).archived(a).write('lib/gates.mjs', 'b').merge();
  expect(r, 2);
}));

test('rails: legacy base rails still freeze', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('lib/r.mjs', 'a').write('.adlc/tickets.json', { tickets: [T('A', { rails: ['lib/r.mjs'] })] })
    .base().write('lib/r.mjs', 'b').merge();
  expect(r, 2);
}));

test('rails: pure R100 rename of a frozen rail file denies even when adlc passes', withRepo((r) => {
  r.dirStore().write('lib/x.mjs', 'x\n').ticket(T('A', { rails: ['lib/x.mjs'] })).base();
  r.git('mv', 'lib/x.mjs', 'lib/z.mjs'); r.merge();
  expect(r, 2, /frozen rail changed, deleted, or renamed[\s\S]*lib\/x\.mjs/);
}));

test('rails: pure rename of a frozen rail parent directory denies', withRepo((r) => {
  r.dirStore().write('lib/x.mjs', 'x\n').ticket(T('A', { rails: ['lib/x.mjs'] })).base();
  r.git('mv', 'lib', 'lib2'); r.merge();
  expect(r, 2, /frozen rail changed/);
}));

test('rails: rename out from under a glob rail denies', withRepo((r) => {
  r.dirStore().write('lib/x.mjs', 'x\n').ticket(T('A', { rails: ['lib/*.mjs'] })).base();
  r.git('mv', 'lib/x.mjs', 'src/x.mjs'); r.merge();
  expect(r, 2, /frozen rail changed/);
}));

test('rails: change outside rails passes the own rail check', withRepo((r) => {
  r.dirStore().write('lib/x.mjs', 'x\n').ticket(T('A', { rails: ['lib/x.mjs'] })).base().write('src/a.mjs', '1').merge();
  expect(r, 0);
}));

test('checkDirTransitions: archiving an id already archived at base denies ARCHIVE_COLLISION', () => {
  const b = T('X');
  const file = ticketFilename('X');
  const arc = new Map([['X', { ticket: archivedShard(b), file }]]);
  const act = new Map([['X', { ticket: b, file }]]);
  assert.throws(() => checkDirTransitions({ baseAct: act, headAct: new Map(), baseArc: arc, headArc: new Map(arc), mbAct: act }),
    (e) => e instanceof Deny && /ARCHIVE_COLLISION/.test(e.message));
});

test('rails: adlc missing from PATH fails closed (exit 1)', withRepo((r) => {
  r.dirStore().ticket(T('A', { rails: ['lib/r.mjs'] })).base().write('src/app.mjs', 'z').merge();
  rmSync(join(r.bin, 'adlc'));
  const env = { PATH: `${r.bin}:/nonexistent-bin`, HOME: '/nonexistent' };
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(r.bin, 'git'), `#!/bin/sh\nexec '${git}' "$@"\n`); chmodSync(join(r.bin, 'git'), 0o755);
  const res = spawnSync(process.execPath, [GUARD, '--base', 'origin/main'], { cwd: r.dir, env, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /could not run adlc rails-guard/);
}));

// ---------------------------------------------------------------- deny cases (exit 2)
const denyCases = [
  ['E: active shard removed without archive', (r, a) => r.rm(r.shardPath(a.id)), /cannot be removed except by archiving/],
  ['F: rails edited', (r, a) => r.ticket({ ...a, rails: [] }), /contract cannot change/],
  ['F: title edited', (r, a) => r.ticket({ ...a, title: 'x' }), /contract cannot change/],
  ['F: array order changed', (r, a) => r.ticket({ ...a, rails: [...a.rails].reverse() }), /contract cannot change/],
  ['F: completed:false is not completion', (r, a) => r.ticket({ ...a, completed: false }), /contract cannot change/],
  ['D: archive without metadata', (r, a) => r.rm(r.shardPath(a.id)).write(r.shardPath(a.id, ARCHIVE_DIR), { ...a, completed: true }), /lacks an _adlcArchive/],
  ['D: extra metadata key', (r, a) => r.rm(r.shardPath(a.id)).archived(a, { by: 'me' }), /undeclared key/],
  ['D: version 2', (r, a) => r.rm(r.shardPath(a.id)).archived(a, { version: 2 }), /version 1/],
  ['D: reason done', (r, a) => r.rm(r.shardPath(a.id)).archived(a, { reason: 'done' }), /reason/],
  ['D: bad ticketHash', (r, a) => r.rm(r.shardPath(a.id)).archived(a, { ticketHash: '0'.repeat(64) }), /ticketHash does not match/],
  ['D: bad archivedAt', (r, a) => r.rm(r.shardPath(a.id)).archived(a, { archivedAt: 'yesterday' }), /archivedAt/],
  ['D: completed as string', (r, a) => r.rm(r.shardPath(a.id)).write(r.shardPath(a.id, ARCHIVE_DIR), { ...archivedShard(a), completed: 'true' }), /completed: true/],
  ['D: rails edited during move', (r, a) => r.rm(r.shardPath(a.id)).write(r.shardPath(a.id, ARCHIVE_DIR), archivedShard({ ...a, rails: [] })), /contract differs/],
  ['D: archive under a different filename', (r, a) => r.rm(r.shardPath(a.id)).write(`${ARCHIVE_DIR}/${ticketFilename('OTHER')}`, archivedShard(a)), /FILENAME_MISMATCH/],
  ['D: inbound edge left pointing at archived ticket', (r, a) => r.rm(r.shardPath(a.id)).archived(a).ticket(T('B', { edges: [{ to: a.id }] })), /edge to unknown/],
  ['G: smuggled archive shard', (r) => r.archived(T('GHOST')), /not paired/],
  ['H: base archive shard edited', (r) => r.write(r.shardPath('OLD', ARCHIVE_DIR), { ...archivedShard(T('OLD')), title: 'changed' }), /cannot be modified, removed, or restored/],
  ['H: base archive shard deleted', (r) => r.rm(r.shardPath('OLD', ARCHIVE_DIR)), /cannot be modified, removed, or restored/],
  ['H: archived ticket restored to active', (r) => r.rm(r.shardPath('OLD', ARCHIVE_DIR)).ticket(T('OLD')), /cannot be modified, removed, or restored/],
  ['A: new active ticket reuses archived id', (r) => r.ticket(T('OLD')), /reuses archived id/],
  ['A: new ticket edge to unknown id', (r) => r.ticket(T('N', { edges: [{ to: 'NOPE' }] })), /edge to unknown/],
  ['A: edge cycle', (r) => r.ticket(T('N1', { edges: [{ to: 'N2' }] })).ticket(T('N2', { edges: [{ to: 'N1' }] })), /cycle/],
  ['A: new ticket with invalid rail', (r) => r.ticket(T('N', { rails: [':(glob)**'] })), /rails must be valid/],
  ['I: tickets.json added next to directory store', (r) => r.write('.adlc/tickets.json', { tickets: [] }), /AMBIGUOUS_STORE at HEAD/],
  ['I: tickets.archive.json added', (r) => r.write('.adlc/tickets.archive.json', { tickets: [] }), /reintroduce legacy/],
  ['I: active .store.json edited', (r) => r.write(`${ACTIVE_DIR}/.store.json`, { ...ACTIVE_MANIFEST, extra: 1 }), /manifest mismatch/],
  ['I: .store.json reformatted (same content) is a trust-root change', (r) => r.write(`${ARCHIVE_DIR}/.store.json`, JSON.stringify(ARCHIVE_MANIFEST)), /trust root changed/],
  ['I: tickets/ deleted', (r) => r.rm(ACTIVE_DIR), /store removed at HEAD/],
  ['J: symlink shard at HEAD', (r) => r.symlink('x', r.shardPath('S')), /100644/],
  ['J: executable shard at HEAD', (r) => { r.ticket(T('X')); chmodSync(join(r.dir, r.shardPath('X')), 0o755); }, /100644/],
  ['J: subdirectory in store at HEAD', (r) => r.write(`${ACTIVE_DIR}/sub/x.json`, T('Q')), /nested or non-file/],
  ['J: non-json entry at HEAD', (r) => r.write(`${ACTIVE_DIR}/README.md`, 'hi'), /non-json/],
  ['J: non-canonical filename', (r) => r.write(`${ACTIVE_DIR}/x.json`, T('N')), /FILENAME_MISMATCH/],
  ['J: unparseable JSON at HEAD', (r) => r.write(r.shardPath('N'), '{nope'), /cannot parse/],
  ['J: duplicate id at HEAD (case collision)', (r, a) => r.stageOnly(r.shardPath(a.id).replace('/a--', '/A--'), a), /case-insensitive|FILENAME_MISMATCH/],
  ['J: shard over size limit', (r) => r.ticket(T('BIG', { body: 'x'.repeat(MAX_SHARD_BYTES) })), /exceeds/],
  ['manifest.jsonl rewritten', (r) => r.write('.adlc/manifest.jsonl', 'rewritten\n'), /append-only/],
  ['manifest.jsonl introduced non-empty', (r) => r.rm('.adlc/manifest.jsonl'), null],
];

for (const [name, mutate, re] of denyCases) {
  test(`deny: ${name}`, withRepo((r) => {
    const a = T('A', { rails: ['lib/never-touched.mjs', 'lib/never-two.mjs'] });
    r.dirStore().ticket(a).archived(T('OLD'));
    if (name === 'manifest.jsonl rewritten') r.write('.adlc/manifest.jsonl', '{"a":1}\n');
    r.base();
    mutate(r, a);
    if (name === 'manifest.jsonl introduced non-empty') {
      r.write('.adlc/manifest.jsonl', 'evidence\n');
      r.merge();
      expect(r, 2, /introduced non-empty/);
      return;
    }
    r.merge();
    expect(r, 2, re);
  }));
}

test('deny: legacy HEAD tickets.json malformed exits 2 without crashing', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('.adlc/tickets.json', { tickets: [T('A')] }).base().write('.adlc/tickets.json', '{bad').merge();
  expect(r, 2, /cannot parse head/);
}));

test('deny: legacy ticket edited', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('.adlc/tickets.json', { tickets: [T('A'), T('B')] }).base();
  r.write('.adlc/tickets.json', { tickets: [{ ...T('A'), title: 'z' }, T('B')] }).merge();
  expect(r, 2, /contract cannot change/);
}));

test('deny: legacy ticket removed', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('.adlc/tickets.json', { tickets: [T('A'), T('B')] }).base()
    .write('.adlc/tickets.json', { tickets: [T('A')] }).merge();
  expect(r, 2, /cannot be removed/);
}));

test('deny: legacy tickets.json deleted at HEAD', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('.adlc/tickets.json', { tickets: [T('A')] }).base().rm('.adlc/tickets.json').merge();
  expect(r, 2, /absent at HEAD/);
}));

// ---------------------------------------------------------------- merge hazard
test('hazard: base edits rails after branch point, PR completes -> denied', withRepo((r) => {
  const a = T('A', { rails: ['lib/one.mjs'] });
  r.dirStore().ticket(a).base();
  r.ticket({ ...a, completed: true });
  r.advanceBase((x) => x.ticket({ ...a, rails: ['lib/one.mjs', 'lib/two.mjs'] }));
  r.merge();
  expect(r, 2, /changed on base since the PR branched/);
}));

test('hazard: archive of a ticket changed since merge-base -> denied (unit)', () => {
  const a0 = T('A', { rails: ['lib/one.mjs'] });
  const a = { ...a0, rails: ['lib/one.mjs', 'lib/two.mjs'] };
  const f = ticketFilename('A');
  const store = (...ts) => new Map(ts.map((t) => [t.id, { ticket: t, file: ticketFilename(t.id) }]));
  const headArc = new Map([['A', { ticket: archivedShard(a), file: f }]]);
  const args = { baseAct: store(a), headAct: store(), baseArc: store(), headArc };
  assert.throws(() => checkDirTransitions({ ...args, mbAct: store(a0) }), /changed on base since the PR branched/);
  assert.throws(() => checkDirTransitions({ ...args, mbAct: null }), /changed on base since the PR branched/);
  checkDirTransitions({ ...args, mbAct: store(a) });
});

// ---------------------------------------------------------------- operational failures (exit 1)
const baseFail = [
  ['unparseable base shard', (r) => r.write(r.shardPath('A'), '{x'), /cannot parse/],
  ['bad base manifest', (r) => r.write(`${ACTIVE_DIR}/.store.json`, { format: 'x', version: 1 }), /manifest mismatch/],
  ['missing base manifest', (r) => r.rm(`${ACTIVE_DIR}/.store.json`).ticket(T('A')), /no .store.json/],
  ['base filename mismatch', (r) => r.write(`${ACTIVE_DIR}/a.json`, T('A')), /FILENAME_MISMATCH/],
  ['base symlink', (r) => r.symlink('x', r.shardPath('A')), /100644/],
  ['base invalid rail', (r) => r.ticket(T('A', { rails: ['-x'] })), /rails must be valid/],
  ['both stores at base', (r) => r.write('.adlc/tickets.json', { tickets: [] }), /AMBIGUOUS_STORE at base/],
  ['base ticket store is a file', (r) => r.rm(ACTIVE_DIR).write(ACTIVE_DIR, 'x'), /must be a directory/],
  ['base has .adlc but no config', (r) => r.rm('.adlc/config.json'), /no .adlc\/config.json/],
  ['base legacy malformed', (r) => r.write('.adlc/tickets.json', { tickets: [{ id: 'A' }, { id: 'A' }] }).rm(ACTIVE_DIR), /duplicate id/],
  ['base legacy wrong shape', (r) => r.write('.adlc/tickets.json', []).rm(ACTIVE_DIR), /must be \{tickets/],
  ['base legacy invalid rail', (r) => r.write('.adlc/tickets.json', { tickets: [T('A', { rails: [':x'] })] }).rm(ACTIVE_DIR), /invalid rails/],
  ['base legacy ticket without id', (r) => r.write('.adlc/tickets.json', { tickets: [{}] }).rm(ACTIVE_DIR), /without id/],
];
for (const [name, mutate, re] of baseFail) {
  test(`fail closed: ${name}`, withRepo((r) => {
    r.dirStore();
    mutate(r);
    r.base().write('src/app.mjs', 'z').merge();
    expect(r, 1, re);
  }));
}

test('fail closed: base ref does not resolve', withRepo((r) => {
  r.dirStore().base().merge();
  const res = r.run(['--base', 'origin/nope']);
  assert.equal(res.code, 1);
  assert.match(res.out, /does not resolve/);
}));

test('fail closed: usage errors', withRepo((r) => {
  r.dirStore().base().merge();
  for (const args of [[], ['--base'], ['--base', '--x']]) assert.equal(r.run(args).code, 1);
}));

test('fail closed: HEAD is not a merge commit', withRepo((r) => {
  r.dirStore().base().commit('single');
  expect(r, 1, /not a PR merge ref/);
}));

test('fail closed: stale merge ref', withRepo((r) => {
  r.dirStore().base().merge();
  const head = r.git('rev-parse', 'HEAD').trim();
  r.git('checkout', '-q', 'main');
  r.write('src/x.mjs', 'adv').commit('advance');
  r.git('update-ref', 'refs/remotes/origin/main', 'main');
  r.git('checkout', '-q', '--detach', head);
  expect(r, 1, /stale merge ref/);
}));

test('fail closed: criss-cross merge bases', withRepo((r) => {
  r.dirStore().commit('root');
  r.git('checkout', '-q', '-b', 'pr');
  r.write('p1', '1').commit('p1');
  r.git('checkout', '-q', 'main');
  r.write('m1', '1').commit('m1');
  const m1 = r.git('rev-parse', 'HEAD').trim();
  r.git('merge', '-q', '--no-ff', '-m', 'm merges p1', 'pr');
  r.git('checkout', '-q', 'pr');
  r.git('merge', '-q', '--no-ff', '-m', 'p merges m1', m1);
  r.git('checkout', '-q', 'main');
  r.write('m2', '1').commit('m2');
  r.git('update-ref', 'refs/remotes/origin/main', 'main');
  r.git('checkout', '-q', 'pr');
  r.write('p2', '1').commit('p2');
  r.git('checkout', '-q', '--detach', 'main');
  r.git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  expect(r, 1, /merge-base/);
}));

test('fail closed: a git that hangs times out (exit 1, no crash)', withRepo((r) => {
  r.dirStore().base().merge();
  const bin = mkdtempSync(join(tmpdir(), 'rg-slowgit-'));
  try {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n');
    chmodSync(join(bin, 'git'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    const errs = [];
    let code;
    try { code = main(['--base', 'origin/main'], { cwd: r.dir, log: () => {}, err: (m) => errs.push(m), gitTimeout: 200 }); }
    finally { process.env.PATH = saved; }
    assert.equal(code, 1);
    assert.match(errs.join('\n'), /killed by|ETIMEDOUT/);
  } finally { rmSync(bin, { recursive: true, force: true }); }
}));

// ---------------------------------------------------------------- trust roots
for (const root of [...TRUST_ROOTS.filter((p) => p !== '.adlc/config.json'), `${ACTIVE_DIR}/.store.json`]) {
  test(`trust root: adding/modifying ${root} denies`, withRepo((r) => {
    r.dirStore().base();
    if (root.endsWith('.store.json')) r.write(root, `${JSON.stringify(ACTIVE_MANIFEST)}\n`);
    else r.write(root, 'x\n');
    r.merge();
    expect(r, 2, /trust root changed/);
  }));
}

test('trust root: modifying, deleting and renaming .adlc/config.json deny', withRepo((r) => {
  r.dirStore().write('CODEOWNERS', '* @o\n').base().write('.adlc/config.json', { version: 2 }).merge();
  expect(r, 2, /M\t\.adlc\/config\.json/);
}));

test('trust root: rename of CODEOWNERS denies', withRepo((r) => {
  r.dirStore().write('CODEOWNERS', '* @owner\n'.repeat(20)).base();
  r.git('mv', 'CODEOWNERS', 'OWNERS.txt');
  r.merge();
  expect(r, 2, /[DR]\d*\tCODEOWNERS/);
}));

test('trust root: deletion denies', withRepo((r) => {
  r.dirStore().write('docs/ci/rails-guard.yml', 'a\n').base().rm('docs/ci/rails-guard.yml').merge();
  expect(r, 2, /D\tdocs\/ci\/rails-guard\.yml/);
}));

test('trust root: .gitattributes textconv cannot hide a change', withRepo((r) => {
  r.dirStore().write('CODEOWNERS', '* @o\n').base();
  r.git('config', 'diff.hide.textconv', 'true');
  r.write('.gitattributes', 'CODEOWNERS diff=hide\n').write('CODEOWNERS', '* @evil\n').merge();
  expect(r, 2, /CODEOWNERS/);
}));

test('trust root: legacy base does not freeze tickets.json itself', withRepo((r) => {
  r.write('.adlc/config.json', {}).write('.adlc/tickets.json', { tickets: [] }).base()
    .write('.adlc/tickets.json', { tickets: [T('N')] }).merge();
  expect(r, 0);
}));

// ---------------------------------------------------------------- workflow: base copy runs
function railFreezeRun() {
  const yml = readFileSync(join(ROOT, '.github/workflows/adlc-rails-guard.yml'), 'utf8');
  const step = yml.split('\n      - name: ').find((s) => s.startsWith('Rail-freeze gate'));
  assert.ok(step, 'Rail-freeze gate step present');
  const m = /\n {8}run: \|\n([\s\S]*)$/.exec(step);
  assert.ok(m, 'run block');
  return { step, script: m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n') };
}

function runStep(r) {
  const tmp = mkdtempSync(join(tmpdir(), 'rg-runner-temp-'));
  try {
    const env = { PATH: `${r.bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/nonexistent', BASE_REF: 'main', RUNNER_TEMP: tmp, GITHUB_WORKSPACE: r.dir };
    const res = spawnSync('bash', ['-c', railFreezeRun().script], { cwd: r.dir, env, encoding: 'utf8' });
    return { code: res.status, out: res.stdout + res.stderr };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

test('workflow: the BASE copy of the guard runs, not the PR copy', withRepo((r) => {
  r.dirStore().write('scripts/rails-guard-ci.mjs', readFileSync(GUARD, 'utf8')).base();
  r.write('scripts/rails-guard-ci.mjs', 'process.exit(0);\n').merge();
  const blob = r.git('rev-parse', 'origin/main:scripts/rails-guard-ci.mjs').trim();
  const res = runStep(r);
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, new RegExp(`using base guard blob ${blob}`));
  assert.match(res.out, /trust root changed/);
}));

test('workflow: base guard + clean PR passes', withRepo((r) => {
  r.dirStore().write('scripts/rails-guard-ci.mjs', readFileSync(GUARD, 'utf8')).base().write('src/app.mjs', 'ok').merge();
  const res = runStep(r);
  assert.equal(res.code, 0, res.out);
}));

test('workflow: no guard on base -> bootstrap mode always exits 2', withRepo((r) => {
  r.dirStore().base().write('scripts/rails-guard-ci.mjs', readFileSync(GUARD, 'utf8')).merge();
  const res = runStep(r);
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /bootstrap mode/);
}));

test('workflow: bootstrap mode exits 2 even with no trust-root diff', withRepo((r) => {
  r.dirStore().write('scripts/rails-guard-ci.mjs', readFileSync(GUARD, 'utf8')).base().write('src/app.mjs', 'ok').merge();
  assert.equal(r.run(['--base', 'origin/main', '--bootstrap-unverified']).code, 2);
}));

// ---------------------------------------------------------------- YAML lint
test('workflow lint: trigger, pinned @adlc/cli matches package-lock, run block hygiene', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/adlc-rails-guard.yml'), 'utf8');
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const ver = lock.packages['node_modules/@adlc/cli'].version;
  assert.match(yml, /\non:\n {2}pull_request:\n\n/);
  assert.doesNotMatch(yml, /pull_request_target/);
  const pins = [...yml.matchAll(/@adlc\/cli@([\w.-]+)/g), ...ci.matchAll(/@adlc\/cli@([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 3);
  for (const p of pins) assert.equal(p, ver);
  const { step, script } = railFreezeRun();
  assert.doesNotMatch(script, /npm (ci|install)/);
  assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotMatch(step, /ADLC_RAILS_GUARD_CMD/);
  const shows = [...script.matchAll(/git show "([^"]+):scripts\/rails-guard-ci\.mjs"/g)].map((m) => m[1]);
  assert.deepEqual(shows, ['$base', 'HEAD']);
  assert.match(script, /mode="--bootstrap-unverified"/);
  assert.match(script, /env -i /);
});

// ---------------------------------------------------------------- replay real history
const REPLAY = [['#86', '7f4dce0', '2b0ffb1'], ['#83', '9da153c', '6daddae'], ['#82', '5d1245a', '9da153c'], ['#85', 'b5aaf32', '7f4dce0']];
const hasHistory = (() => {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  return shallow !== 'true' && REPLAY.every(([, b, h]) =>
    [b, h].every((c) => spawnSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: ROOT }).status === 0));
})();

for (const [pr, b, h] of REPLAY) {
  test(`replay: real ${pr} (${b}..${h}) passes the evaluator`, { skip: hasHistory ? false : 'shallow clone / history unavailable' }, () => {
    const git = makeGit(ROOT);
    const M = git(['merge-base', b, h], 'mb').stdout.trim();
    const res = evaluate({ base: gitTree(git, b, 'base'), head: gitTree(git, h, 'head'), mergeBase: gitTree(git, M, 'base') });
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--name-status', `${b}...${h}`, '--', ...res.trustRoots.map((p) => `:(literal)${p}`)], 'diff').stdout.trim();
    assert.equal(diff, '');
  });
}

test('replay: real #82 rails come from the active base ticket', { skip: hasHistory ? false : 'history unavailable' }, () => {
  const git = makeGit(ROOT);
  const res = evaluate({ base: gitTree(git, '5d1245a', 'base'), head: gitTree(git, '9da153c', 'head'), mergeBase: gitTree(git, '5d1245a', 'base') });
  assert.ok(res.rails.includes('lib/lock.mjs'));
});

// Regression: invoked through a symlinked directory (macOS $TMPDIR is
// /var -> /private/var), the entry check once failed, skipped main() and
// exited 0, passing every PR. The guard must still run and deny here.
test('entry: guard invoked via a symlinked path still runs (no silent exit 0)', withRepo((r) => {
  const real = mkdtempSync(join(tmpdir(), 'rg-real-'));
  const link = `${real}-link`;
  try {
    mkdirSync(join(real, 'g'));
    copyFileSync(GUARD, join(real, 'g', 'rails-guard-ci.mjs'));
    symlinkSync(real, link);
    r.dirStore().base().write('src/app.mjs', 'ok').merge();
    const res = r.run(['--base', 'origin/main', '--bootstrap-unverified'], { guard: join(link, 'g', 'rails-guard-ci.mjs') });
    assert.equal(res.code, 2, res.out);
  } finally { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); }
}));
