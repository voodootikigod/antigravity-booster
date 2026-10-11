// Tests for scripts/release-audit-collect.mjs — Phase A of /release-audit.
//
// The routing tests carry most of the weight. Issue routing decides which agent
// sees which GitHub issue, and its governing rule is asymmetric on purpose:
// ambiguous evidence must route to NOBODY (the issue falls to the sweep agent)
// rather than to a plausible guess. The probe tests prove the other half of the
// contract: a probe that could not run is recorded as unconsultable, never as
// clean, and the one probe that rebuilds the tree refuses to do so on top of
// uncommitted work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UNITS,
  COMMAND_UNITS,
  SWEEP_BATCH_SIZE,
  ISSUE_EXCERPT,
  ISSUE_FETCH_LIMIT,
  PACKAGE_NAME,
  parseArgs,
  nextMinor,
  inventory,
  discoverUnits,
  unitForPath,
  globPrefix,
  linkedIssueNumbers,
  isEscalated,
  routeIssue,
  routeIssues,
  sweepBatches,
  stripBody,
  tryRun,
  newestVersionTag,
  churnFor,
  fetchIssues,
  ticketsByIssueNumber,
  lockstepProblems,
  sri512,
  tarballProblems,
  vendoredDigestProblems,
  bundleDriftProbe,
  websiteGenProbe,
  releaseDriftProbe,
  shellcheckProbe,
  probes,
  assemble,
  workflowArgs,
  collectMain,
} from '../scripts/release-audit-collect.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A fake execFileSync: answers by matching the joined command line. */
function fakeRun(table, calls = []) {
  return (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [pattern, result] of table) {
      if (pattern.test(line)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    const err = new Error(`no fake for: ${line}`);
    err.stderr = err.message;
    throw err;
  };
}

function tmpRoot(t, prefix = 'agb-release-audit-') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// ─── the declared surfaces ───────────────────────────────────────────────────

test('UNITS declares nine surfaces with unique ids', () => {
  assert.equal(UNITS.length, 9);
  assert.equal(new Set(UNITS.map((u) => u.id)).size, 9);
  for (const u of UNITS) assert.match(u.id, /^surface:[a-z-]+$/);
});

test('every declared surface path exists in the real repository', () => {
  // A surface that names a path which is not there audits air. This is the one
  // place a rename of lib/foo.mjs would otherwise go unnoticed by the audit.
  for (const u of UNITS) {
    for (const p of u.paths) assert.ok(existsSync(join(ROOT, p)), `${u.id} names a missing path: ${p}`);
  }
});

test('surface paths are disjoint — no path is claimed by two surfaces', () => {
  const owned = [];
  for (const u of UNITS) for (const p of u.paths) owned.push({ unit: u.id, path: p });
  for (const a of owned) {
    for (const b of owned) {
      if (a === b || a.unit === b.unit) continue;
      assert.ok(!(a.path === b.path || a.path.startsWith(`${b.path}/`)), `${a.unit}:${a.path} is inside ${b.unit}:${b.path}`);
    }
  }
});

test('the standing rails from AGENTS.md P3 live inside the scheduler surface', () => {
  const sched = UNITS.find((u) => u.id === 'surface:scheduler');
  assert.deepEqual(sched.rails, ['lib/lock.mjs', 'lib/gates.mjs']);
  for (const r of sched.rails) assert.ok(sched.paths.includes(r));
});

test('the policy guard is the only hook-kind surface and names the bundle that runs', () => {
  const hooks = UNITS.filter((u) => u.kind === 'hook');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].id, 'surface:policy-guard');
  assert.ok(hooks[0].paths.includes('dist/hooks'));
  assert.ok(hooks[0].paths.includes('bin/hook-runner.sh'));
});

test('every agb command in COMMAND_UNITS maps to a declared surface', () => {
  const ids = new Set(UNITS.map((u) => u.id));
  for (const [cmd, id] of Object.entries(COMMAND_UNITS)) assert.ok(ids.has(id), `agb ${cmd} → ${id} is not a surface`);
});

// ─── argument parsing ────────────────────────────────────────────────────────

test('parseArgs reads every flag and the positional version', () => {
  const a = parseArgs(['1.2.0', '--since', 'v1.1.0', '--units', 'cli, mcp ', '--skip-issues', '--skip-build', '--workflow-args']);
  assert.deepEqual(a, { version: '1.2.0', since: 'v1.1.0', units: ['cli', 'mcp'], skipIssues: true, skipBuild: true, workflowArgs: true });
});

test('parseArgs defaults everything to null/false', () => {
  assert.deepEqual(parseArgs([]), { version: null, since: null, units: null, skipIssues: false, skipBuild: false, workflowArgs: false });
});

test('parseArgs treats an empty --units list as unfiltered, not as "audit nothing"', () => {
  assert.equal(parseArgs(['--units', '']).units, null);
  assert.equal(parseArgs(['--units', ' , ,']).units, null);
});

test('parseArgs ignores unknown flags and keeps only the FIRST positional as version', () => {
  assert.equal(parseArgs(['--verbose', '1.2.0', '2.0.0']).version, '1.2.0');
});

test('nextMinor bumps the minor and zeroes the patch, matching /release default', () => {
  assert.equal(nextMinor('1.1.0'), '1.2.0');
  assert.equal(nextMinor('0.9.3'), '0.10.0');
  assert.equal(nextMinor('not-a-version'), 'not-a-version');
  assert.equal(nextMinor(undefined), '');
});

// ─── inventory ───────────────────────────────────────────────────────────────

function fixtureTree(t) {
  const root = tmpRoot(t);
  mkdirSync(join(root, 'unit', 'sub'), { recursive: true });
  for (const name of ['a.mjs', 'b.cjs', 'c.js', 'd.ts', 'e.json', 'f.md', 'g.sh', 'h.ps1', 'i.html', 'j.css', 'k.tgz']) {
    writeFileSync(join(root, 'unit', name), 'x');
  }
  writeFileSync(join(root, 'unit', 'sub', 'nested.mjs'), 'xy');
  for (const name of ['l.txt', 'm.lock', 'n']) writeFileSync(join(root, 'unit', name), 'x');
  for (const dir of ['node_modules', '.git', 'coverage', '.worktrees', '.next']) {
    mkdirSync(join(root, 'unit', dir), { recursive: true });
    writeFileSync(join(root, 'unit', dir, 'buried.mjs'), 'x');
  }
  writeFileSync(join(root, 'single.json'), '{}');
  return root;
}

test('inventory walks a directory and lists every shipped extension', (t) => {
  const root = fixtureTree(t);
  const found = inventory(['unit'], { root }).map((f) => f.path).sort();
  assert.deepEqual(found, [
    'unit/a.mjs', 'unit/b.cjs', 'unit/c.js', 'unit/d.ts', 'unit/e.json', 'unit/f.md', 'unit/g.sh',
    'unit/h.ps1', 'unit/i.html', 'unit/j.css', 'unit/k.tgz', 'unit/sub/nested.mjs',
  ].sort());
});

test('inventory lists a declared file as itself and skips a missing path', (t) => {
  const root = fixtureTree(t);
  const found = inventory(['single.json', 'does/not/exist'], { root }).map((f) => f.path);
  assert.deepEqual(found, ['single.json']);
});

test('inventory never descends into a skipped directory', (t) => {
  const root = fixtureTree(t);
  const found = inventory(['unit'], { root }).map((f) => f.path);
  for (const dir of ['node_modules', '.git', 'coverage', '.worktrees', '.next']) {
    assert.ok(!found.some((f) => f.includes(`/${dir}/`)), `${dir} must be skipped`);
  }
  for (const excluded of ['unit/l.txt', 'unit/m.lock', 'unit/n']) assert.ok(!found.includes(excluded));
});

test('inventory reports each file size, so a unit prompt can state its real weight', (t) => {
  const root = fixtureTree(t);
  assert.equal(inventory(['unit'], { root }).find((f) => f.path === 'unit/sub/nested.mjs').bytes, 2);
});

test('discoverUnits attaches a real inventory to every surface in this repo', () => {
  const units = discoverUnits();
  assert.equal(units.length, 9);
  for (const u of units) {
    assert.ok(u.fileCount > 0, `${u.id} has no files`);
    assert.deepEqual(u.missingPaths, [], `${u.id} names missing paths`);
    assert.ok(u.files.every((f) => !f.includes('node_modules')));
  }
  const guard = units.find((u) => u.id === 'surface:policy-guard');
  assert.ok(guard.files.includes('dist/hooks/pre-tool-use.bundle.mjs'), 'the hook bundle that actually runs must be audited');
  const vendor = units.find((u) => u.id === 'surface:vendor');
  assert.ok(vendor.files.some((f) => /^vendor\/cache\/adlc-antigravity-.*\.tgz$/.test(f)));
});

test('discoverUnits records a declared path that is missing rather than dropping it', (t) => {
  const root = tmpRoot(t);
  const units = discoverUnits({ root });
  const cli = units.find((u) => u.id === 'surface:cli');
  assert.deepEqual(cli.missingPaths, cli.paths);
  assert.equal(cli.fileCount, 0);
});

// ─── routing ─────────────────────────────────────────────────────────────────

test('unitForPath prefers the longest declared path', () => {
  assert.equal(unitForPath('lib/lock.mjs'), 'surface:scheduler');
  assert.equal(unitForPath('hooks/policy/shell.mjs'), 'surface:policy-guard');
  assert.equal(unitForPath('dist/hooks/pre-tool-use.bundle.mjs'), 'surface:policy-guard');
  assert.equal(unitForPath('dist/agb.mjs'), 'surface:cli');
  assert.equal(unitForPath('bin/node-launcher.sh'), 'surface:policy-guard');
});

test('unitForPath rejects a non-surface path and a prefix that is not a directory boundary', () => {
  assert.equal(unitForPath('scripts/release-drift.mjs'), null);
  assert.equal(unitForPath('lib/lock.mjs.bak'), null);
  assert.equal(unitForPath('hooks.json'), 'surface:policy-guard');
  assert.equal(unitForPath('hooks.json5'), null);
});

test('globPrefix returns the literal directory before the first wildcard', () => {
  assert.equal(globPrefix('hooks/**'), 'hooks');
  assert.equal(globPrefix('lib/adlc-*.mjs'), 'lib');
  assert.equal(globPrefix('mcp/server.mjs'), 'mcp/server.mjs');
  assert.equal(globPrefix('**/x.mjs'), '');
});

test('linkedIssueNumbers extracts and de-duplicates issue backlinks', () => {
  const body = 'see https://github.com/voodootikigod/antigravity-booster/issues/54 and again /issues/54 and https://github.com/voodootikigod/antigravity-booster/issues/16';
  assert.deepEqual(linkedIssueNumbers(body).sort((a, b) => a - b), [16, 54]);
  assert.deepEqual(linkedIssueNumbers(undefined), []);
});

test('isEscalated fires on bug/security labels and on [P0]/[P1] title markers', () => {
  assert.equal(isEscalated({ title: 'x', labels: ['bug'] }), true);
  assert.equal(isEscalated({ title: 'x', labels: [{ name: 'security' }] }), true);
  assert.equal(isEscalated({ title: '[P1] fix: real --help', labels: [] }), true);
  assert.equal(isEscalated({ title: '[P0] boom', labels: [] }), true);
});

test('isEscalated does not fire on [P2] or ordinary labels', () => {
  assert.equal(isEscalated({ title: '[P2] refactor: tidy', labels: ['enhancement', 'documentation'] }), false);
  assert.equal(isEscalated({}), false);
});

test('routeIssue tier 1: a single explicit path mention wins', () => {
  const r = routeIssue({ number: 1, title: 'crash', body: 'in lib/scheduler.mjs when ...' });
  assert.deepEqual(r, { unit: 'surface:scheduler', via: 'path-mention' });
});

test('routeIssue tier 1 recognises bare manifest files and trailing punctuation', () => {
  assert.equal(routeIssue({ number: 1, title: 'hooks.json points at a missing bundle.', body: '' }).unit, 'surface:policy-guard');
  assert.equal(routeIssue({ number: 2, title: 'x', body: 'see `mcp/server.mjs`, line 155' }).unit, 'surface:mcp');
});

test('routeIssue refuses to guess when two surfaces are named', () => {
  const r = routeIssue({ number: 2, title: 'x', body: 'lib/lock.mjs and mcp/server.mjs both' });
  assert.equal(r.unit, null);
  assert.equal(r.via, 'ambiguous-path');
});

test('routeIssue tier 2: a linked ticket scope routes when it lands in one surface', () => {
  const tickets = new Map([[7, [{ id: 'T7', scope: ['hooks/**', 'hooks/policy/*.mjs'] }]]]);
  assert.deepEqual(routeIssue({ number: 7, title: 'guard bug', body: '' }, UNITS, tickets), { unit: 'surface:policy-guard', via: 'ticket-scope' });
});

test('routeIssue refuses a ticket scope that spans two surfaces', () => {
  const tickets = new Map([[8, [{ id: 'T8', scope: ['hooks/**', 'sidecars/**'] }]]]);
  const r = routeIssue({ number: 8, title: 'x', body: '' }, UNITS, tickets);
  assert.equal(r.unit, null);
  assert.equal(r.via, 'ambiguous-ticket-scope');
});

test('routeIssue tier 3: an `agb <command>` token in the TITLE routes by COMMAND_UNITS', () => {
  assert.deepEqual(routeIssue({ number: 15, title: 'feat: agb doctor — one-command diagnostic', body: '' }), { unit: 'surface:install', via: 'command-token' });
  assert.deepEqual(routeIssue({ number: 22, title: 'feat: agb status --watch', body: '' }), { unit: 'surface:cli', via: 'command-token' });
});

test('routeIssue tier 3: an MCP tool name routes to the MCP surface', () => {
  assert.deepEqual(routeIssue({ number: 3, title: 'agb_run accepts a concurrency it ignores', body: '' }), { unit: 'surface:mcp', via: 'command-token' });
});

test('routeIssue refuses two different command tokens, and an unknown command routes nowhere', () => {
  const two = routeIssue({ number: 4, title: 'agb run and agb doctor disagree', body: '' });
  assert.deepEqual(two, { unit: null, via: 'ambiguous-command' });
  assert.deepEqual(routeIssue({ number: 5, title: 'agb frobnicate', body: '' }), { unit: null, via: 'unrouted' });
});

test('routeIssue tiers are ordered: a path mention beats a command token', () => {
  const r = routeIssue({ number: 12, title: 'agb doctor', body: 'actually in lib/scheduler.mjs' });
  assert.equal(r.unit, 'surface:scheduler');
  assert.equal(r.via, 'path-mention');
});

test('routeIssue only honours a command token for a surface in the given unit list', () => {
  const narrowed = UNITS.filter((u) => u.id === 'surface:cli');
  assert.equal(routeIssue({ number: 1, title: 'agb doctor', body: '' }, narrowed).unit, null);
});

test('routeIssues partitions into routed, unmapped and escalated', () => {
  const issues = [
    { number: 1, title: 'a', body: 'lib/scheduler.mjs', labels: [] },
    { number: 2, title: 'b', body: 'nothing identifiable', labels: ['enhancement'] },
    { number: 3, title: 'c', body: 'mcp/server.mjs', labels: ['bug'] },
  ];
  const { byUnit, unmapped, escalated } = routeIssues(issues);
  assert.deepEqual(byUnit.get('surface:scheduler').map((i) => i.number), [1]);
  assert.deepEqual(unmapped.map((i) => i.number), [2]);
  assert.deepEqual(escalated.map((i) => i.number), [3]);
  assert.equal(byUnit.get('surface:mcp')[0].routedVia, 'path-mention');
  assert.equal(byUnit.get('surface:mcp')[0].routedTo, 'surface:mcp');
});

test('routed issues carry no body into the emitted document', () => {
  const { byUnit, unmapped } = routeIssues([
    { number: 1, title: 'a', body: 'lib/lock.mjs ' + 'y'.repeat(9000), labels: [] },
    { number: 2, title: 'b', body: 'z'.repeat(9000), labels: [] },
  ]);
  assert.equal(byUnit.get('surface:scheduler')[0].body, undefined);
  assert.equal(unmapped[0].body, undefined);
});

test('sweepBatches merges unrouted and escalated without duplicating, in fixed shards', () => {
  const [batch] = sweepBatches([{ number: 3 }, { number: 1 }], [{ number: 1 }, { number: 7 }]);
  assert.deepEqual(batch.map((i) => i.number), [1, 3, 7]);
  const many = Array.from({ length: 25 }, (_, i) => ({ number: i + 1 }));
  assert.deepEqual(sweepBatches(many, []).map((b) => b.length), [12, 12, 1]);
  assert.equal(SWEEP_BATCH_SIZE, 12);
  assert.deepEqual(sweepBatches([], []), [[]], 'an empty backlog still has one shard to expect');
});

test('stripBody replaces a long body with a bounded excerpt and keeps routing fields', () => {
  const long = stripBody({ number: 1, title: 't', body: 'x'.repeat(5000) });
  assert.equal(long.body, undefined);
  assert.equal(long.excerpt.length, ISSUE_EXCERPT + 1);
  assert.ok(long.excerpt.endsWith('…'));
  const short = stripBody({ number: 7, title: 't', url: 'u', labels: ['bug'], routedVia: 'path-mention', routedTo: 'surface:mcp', body: '  b ' });
  assert.deepEqual(short, { number: 7, title: 't', url: 'u', labels: ['bug'], routedVia: 'path-mention', routedTo: 'surface:mcp', excerpt: 'b' });
});

// ─── git and gh helpers ──────────────────────────────────────────────────────

test('tryRun returns {ok:false, out} with stderr rather than throwing', () => {
  const err = Object.assign(new Error('boom'), { stderr: 'fatal: not a git repo' });
  assert.deepEqual(tryRun('git', ['x'], { run: () => { throw err; } }), { ok: false, out: 'fatal: not a git repo' });
  assert.deepEqual(tryRun('git', ['x'], { run: () => ' fine \n' }), { ok: true, out: ' fine' }, 'only trailing whitespace is trimmed');
  assert.equal(tryRun('git', ['x'], { run: () => { throw new Error('plain'); } }).out, 'plain');
});

test('newestVersionTag picks the first well-formed vX.Y.Z tag and tolerates failure', () => {
  assert.equal(newestVersionTag({ run: () => 'v1.1.0-rc\nv1.1.0\nv1.0.0' }), 'v1.1.0');
  assert.equal(newestVersionTag({ run: () => { throw new Error('no git'); } }), null);
});

test('churnFor reports commits and files since the baseline, or why it could not', () => {
  const run = fakeRun([
    [/^git log/, 'abc fix: one\ndef feat: two'],
    [/^git diff --name-only/, 'lib/a.mjs\nlib/b.mjs\nlib/c.mjs'],
  ]);
  const c = churnFor(['lib/a.mjs'], 'v1.1.0', { run });
  assert.equal(c.commits, 2);
  assert.equal(c.filesChanged, 3);
  assert.equal(churnFor(['lib'], null).unconsultable, 'no baseline tag');
  assert.match(churnFor(['lib'], 'v1', { run: () => { throw Object.assign(new Error('x'), { stderr: 'bad rev' }); } }).unconsultable, /bad rev/);
});

test('fetchIssues reports a capped response as truncated instead of accepting it', () => {
  const full = JSON.stringify(Array.from({ length: ISSUE_FETCH_LIMIT }, (_, i) => ({ number: i + 1, title: 't', body: '', labels: [], url: 'u' })));
  const r = fetchIssues({ run: () => full });
  assert.equal(r.truncated, ISSUE_FETCH_LIMIT);
  assert.equal(r.issues.length, ISSUE_FETCH_LIMIT);
});

test('fetchIssues normalises labels, bounds bodies, and names every failure mode', () => {
  const ok = fetchIssues({ run: () => JSON.stringify([{ number: 1, title: 't', body: 'b'.repeat(5000), labels: [{ name: 'bug' }], url: 'u', milestone: { title: 'm' } }]) });
  assert.deepEqual(ok.issues[0].labels, ['bug']);
  assert.equal(ok.issues[0].body.length, 4000);
  assert.equal(ok.issues[0].milestone, 'm');
  assert.equal(ok.truncated, null);
  assert.match(fetchIssues({ run: () => { throw Object.assign(new Error('x'), { stderr: 'gh: not authenticated' }); } }).unconsultable, /gh issue list failed/);
  assert.match(fetchIssues({ run: () => 'not json' }).unconsultable, /unparseable JSON/);
  assert.match(fetchIssues({ skip: true }).unconsultable, /--skip-issues/);
});

test('ticketsByIssueNumber indexes directory-store tickets by their issue backlinks', () => {
  const files = { 'a.json': JSON.stringify({ id: 'T-A', title: 'a', scope: ['hooks/**'], body: 'fixes https://github.com/o/r/issues/9' }), 'b.json': 'not json', 'c.txt': '' };
  const index = ticketsByIssueNumber({ root: '/x', readDir: () => Object.keys(files), readFile: (p) => files[String(p).split('/').pop()] });
  assert.deepEqual([...index.keys()], [9]);
  assert.equal(index.get(9)[0].id, 'T-A');
  assert.equal(index.get(9)[0].completed, false);
  assert.equal(ticketsByIssueNumber({ root: '/x', readDir: () => { throw new Error('ENOENT'); } }).size, 0);
});

test('ticketsByIssueNumber reads the real store without throwing', () => {
  assert.ok(ticketsByIssueNumber() instanceof Map);
});

// ─── the probes ──────────────────────────────────────────────────────────────

const PKG = { version: '1.1.0', devDependencies: { '@adlc/antigravity': '1.7.0' } };
const PLUGIN = { version: '1.1.0' };
const TARBALL = Buffer.from('tarball bytes');
const LOCK = {
  version: '1.1.0',
  packages: { '': { version: '1.1.0' }, 'node_modules/@adlc/antigravity': { version: '1.7.0', integrity: sri512(TARBALL) } },
};

test('lockstepProblems is silent when all four version fields agree (D11)', () => {
  assert.deepEqual(lockstepProblems({ pkg: PKG, plugin: PLUGIN, lock: LOCK }), []);
});

test('lockstepProblems names each field that disagrees', () => {
  const out = lockstepProblems({ pkg: PKG, plugin: { version: '1.0.0' }, lock: { version: '1.0.0', packages: { '': { version: '1.0.0' } } } });
  assert.equal(out.length, 3);
  assert.match(out[0], /plugin\.json version 1\.0\.0 != package\.json 1\.1\.0/);
  assert.match(out[1], /package-lock\.json version 1\.0\.0/);
  assert.match(out[2], /packages\[""\]\.version 1\.0\.0/);
  assert.deepEqual(lockstepProblems({ pkg: {}, plugin: PLUGIN, lock: LOCK }), ['package.json has no version']);
});

test('sri512 produces npm lockfile-format integrity strings', () => {
  assert.equal(sri512(TARBALL), `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`);
});

test('tarballProblems is silent when the cached tarball hashes to the lockfile integrity', () => {
  const out = tarballProblems({ pkg: PKG, lock: LOCK, root: '/r', readFile: () => TARBALL, exists: () => true });
  assert.deepEqual(out, []);
});

test('tarballProblems reports a missing pin, missing file, version mismatch, and a wrong hash', () => {
  assert.match(tarballProblems({ pkg: { devDependencies: {} }, lock: LOCK })[0], /does not pin @adlc\/antigravity/);
  assert.match(tarballProblems({ pkg: PKG, lock: LOCK, exists: () => false })[0], /adlc-antigravity-1\.7\.0\.tgz is missing/);
  assert.match(tarballProblems({ pkg: PKG, lock: { packages: {} }, exists: () => true })[0], /no integrity/);
  const drifted = { ...LOCK, packages: { ...LOCK.packages, 'node_modules/@adlc/antigravity': { version: '1.6.0', integrity: 'sha512-nope' } } };
  const out = tarballProblems({ pkg: PKG, lock: drifted, readFile: () => TARBALL, exists: () => true });
  assert.equal(out.length, 2);
  assert.match(out[0], /resolves @adlc\/antigravity@1\.6\.0, package\.json pins 1\.7\.0/);
  assert.match(out[1], /not the pristine release/);
  assert.match(tarballProblems({ pkg: PKG, lock: LOCK, readFile: () => { throw new Error('EACCES'); }, exists: () => true })[0], /unreadable: EACCES/);
});

test('vendoredDigestProblems names each pinned digest that the tree no longer matches', () => {
  const known = { version: '1.11.1', binarySha256: 'a', vendoredBundleSha256: 'b', treeDigest: 'c' };
  assert.deepEqual(vendoredDigestProblems({ computed: { ...known }, known }), []);
  const out = vendoredDigestProblems({ computed: { ...known, treeDigest: 'zzz' }, known });
  assert.equal(out.length, 1);
  assert.match(out[0], /treeDigest: tree has zzz, lib\/adlc-bridge\.mjs pins c/);
  assert.match(out[0], /vendored-adlc-tampered/);
  assert.equal(vendoredDigestProblems({ computed: null, known }).length, 4);
});

test('bundleDriftProbe refuses to rebuild on a dirty tree and says so', () => {
  const calls = [];
  const r = bundleDriftProbe({ run: fakeRun([], calls), clean: false });
  assert.deepEqual(r, { problems: [], rebuilt: false, unconsultable: 'working tree is not clean, so the bundle rebuild was not run (commit or stash first)' });
  assert.deepEqual(calls, [], 'npm run build must not have been invoked');
  assert.match(bundleDriftProbe({ run: fakeRun([], calls), clean: null }).unconsultable, /not clean/);
});

test('bundleDriftProbe can be skipped, and records the skip', () => {
  const calls = [];
  assert.deepEqual(bundleDriftProbe({ run: fakeRun([], calls), clean: true, skip: true }), { problems: [], rebuilt: false, unconsultable: 'skipped via --skip-build' });
  assert.deepEqual(calls, []);
});

test('bundleDriftProbe rebuilds a clean tree and reports no drift when git sees nothing', () => {
  const calls = [];
  const run = fakeRun([[/^npm run build$/, ''], [/^git status --porcelain --untracked-files=all dist\/ vendor\/$/, '']], calls);
  assert.deepEqual(bundleDriftProbe({ run, clean: true }), { problems: [], rebuilt: true, unconsultable: null });
  assert.equal(calls.length, 2);
});

test('bundleDriftProbe reports every stale or untracked bundle path, as CI would', () => {
  const run = fakeRun([[/^npm run build$/, ''], [/^git status/, ' M dist/agb.mjs\n?? vendor/adlc/dist/extra.mjs']]);
  const r = bundleDriftProbe({ run, clean: true });
  assert.equal(r.rebuilt, true);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /stale or untracked after a fresh build: M dist\/agb\.mjs/);
});

test('bundleDriftProbe reports a failed build as a problem, not as clean', () => {
  const run = fakeRun([[/^npm run build$/, Object.assign(new Error('x'), { stderr: 'check-bundle-externals: dist/agb.mjs imports minimatch' })]]);
  const r = bundleDriftProbe({ run, clean: true });
  assert.equal(r.rebuilt, true);
  assert.match(r.problems[0], /npm run build failed: check-bundle-externals/);
  const r2 = bundleDriftProbe({ run: fakeRun([[/^npm run build$/, ''], [/^git status/, Object.assign(new Error('x'), { stderr: 'git died' })]]), clean: true });
  assert.match(r2.unconsultable, /git status failed after the rebuild: git died/);
});

test('websiteGenProbe is silent when the partials are current and names each stale one', () => {
  assert.deepEqual(websiteGenProbe({ run: fakeRun([[/gen-reference\.mjs --check$/, 'gen-reference: up to date 27 partial(s)']]), exists: () => true }), { problems: [], unconsultable: null });
  const stale = fakeRun([[/gen-reference\.mjs --check$/, Object.assign(new Error('x'), { stdout: 'website/generated/changelog.mdx:1: out of date (run: cd website && npm run gen)\nwebsite/generated/plugin-layout.mdx:1: out of date (run: cd website && npm run gen)' })]]);
  const r = websiteGenProbe({ run: stale, exists: () => true });
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /changelog\.mdx:1: out of date/);
  assert.match(r.problems[0], /gen-check job fails on main/);
});

test('websiteGenProbe records a missing generator or an unexplained failure as unconsultable', () => {
  assert.match(websiteGenProbe({ run: fakeRun([]), exists: () => false }).unconsultable, /gen-reference\.mjs is missing/);
  const r = websiteGenProbe({ run: fakeRun([[/gen-reference/, Object.assign(new Error('x'), { stderr: 'Cannot find module' })]]), exists: () => true });
  assert.deepEqual(r.problems, []);
  assert.match(r.unconsultable, /failed without naming a stale partial: Cannot find module/);
});

test('releaseDriftProbe hands the gathered facts to classifyDrift and is silent when in sync', () => {
  const seen = [];
  const classify = (facts) => { seen.push(facts); return { status: 'ok', ok: true, message: 'In sync' }; };
  const run = fakeRun([
    [/^npm view antigravity-booster dist-tags\.latest$/, '1.1.0'],
    [/^git tag -l$/, 'v1.0.0\nv1.1.0'],
    [/^git log -1 --format=%ct -- package\.json$/, '1000'],
    [/^gh repo view/, 'o/r'],
    [/^gh api repos\/o\/r\/actions\/runs/, '{"status":"completed","conclusion":"success"}'],
  ]);
  const r = releaseDriftProbe({ run, classify, manifestVersion: '1.1.0', now: () => 1000 * 1000 + 60 * 60 * 1000 });
  assert.deepEqual(r, { problems: [], unconsultable: null, status: 'ok' });
  assert.equal(seen[0].npmLatest, '1.1.0');
  assert.deepEqual(seen[0].tags, ['v1.0.0', 'v1.1.0']);
  assert.equal(seen[0].runStatus, 'completed');
  assert.equal(seen[0].runConclusion, 'success');
  assert.ok(Math.abs(seen[0].bumpAgeMinutes - 60) < 1e-6);
});

test('releaseDriftProbe reports a stranded previous release as a problem', () => {
  const classify = () => ({ status: 'untagged', ok: false, message: 'Manifest is at 1.1.0 but npm serves 1.0.0' });
  const run = fakeRun([[/^npm view/, '1.0.0'], [/^git tag -l$/, 'v1.0.0'], [/^git log/, '']]);
  const r = releaseDriftProbe({ run, classify, manifestVersion: '1.1.0' });
  assert.deepEqual(r.problems, ['untagged: Manifest is at 1.1.0 but npm serves 1.0.0']);
});

test('releaseDriftProbe treats an unreachable registry and a missing classifier as unconsultable', () => {
  const classify = ({ npmLatest }) => (npmLatest == null ? { status: 'undetermined', ok: false, message: 'Could not read dist-tags.latest' } : { status: 'ok', ok: true, message: '' });
  const run = fakeRun([[/^npm view/, Object.assign(new Error('x'), { stderr: 'ENOTFOUND' })], [/^git tag -l$/, ''], [/^git log/, '']]);
  assert.match(releaseDriftProbe({ run, classify, manifestVersion: '1.1.0' }).unconsultable, /Could not read dist-tags/);
  assert.match(releaseDriftProbe({ run, classify: null, manifestVersion: '1.1.0' }).unconsultable, /release-drift\.mjs could not be loaded/);
});

test('releaseDriftProbe leaves the run status null when gh cannot answer (the loud, safe direction)', () => {
  const seen = [];
  const classify = (f) => { seen.push(f); return { status: 'ok', ok: true, message: '' }; };
  const run = fakeRun([[/^npm view/, '1.1.0'], [/^git tag -l$/, 'v1.1.0'], [/^git log/, ''], [/^gh repo view/, 'o/r'], [/^gh api/, 'garbage']]);
  releaseDriftProbe({ run, classify, manifestVersion: '1.1.0' });
  assert.equal(seen[0].runStatus, null);
  assert.equal(seen[0].bumpAgeMinutes, null);
});

test('shellcheckProbe is unconsultable without shellcheck, silent on clean launchers, and quotes a failure', () => {
  assert.match(shellcheckProbe({ run: fakeRun([[/^shellcheck --version$/, new Error('ENOENT')]]) }).unconsultable, /not installed/);
  assert.deepEqual(shellcheckProbe({ run: fakeRun([[/^shellcheck --version$/, '0.9'], [/^shellcheck -s sh/, '']]) }), { problems: [], unconsultable: null });
  const r = shellcheckProbe({ run: fakeRun([[/^shellcheck --version$/, '0.9'], [/^shellcheck -s sh/, Object.assign(new Error('x'), { stdout: 'SC2086: quote this' })]]) });
  assert.match(r.problems[0], /shellcheck: SC2086/);
});

/** Everything probes() shells out to, answered as a healthy, in-sync tree. */
function healthyRun(calls = [], overrides = []) {
  return fakeRun([
    ...overrides,
    [/^git rev-parse --abbrev-ref HEAD$/, 'main'],
    [/^git status --porcelain$/, ''],
    [/^git rev-parse HEAD$/, 'abc'],
    [/^git rev-parse origin\/main$/, 'abc'],
    [/^npm run build$/, ''],
    [/^git status --porcelain --untracked-files=all/, ''],
    [/gen-reference\.mjs --check$/, 'up to date'],
    [/^npm view/, '1.1.0'],
    [/^git tag -l$/, 'v1.1.0'],
    [/^git log -1 --format=%ct/, '1'],
    [/^gh repo view/, 'o/r'],
    [/^gh api/, '{"status":"completed","conclusion":"success"}'],
    [/^shellcheck --version$/, '0.9'],
    [/^shellcheck -s sh/, ''],
  ], calls);
}

const KNOWN = { version: '1.11.1', binarySha256: 'a', vendoredBundleSha256: 'b', treeDigest: 'c' };
const manifests = { 'package.json': JSON.stringify(PKG), 'plugin.json': JSON.stringify(PLUGIN), 'package-lock.json': JSON.stringify(LOCK) };
const fakeReadFile = (p) => {
  const name = String(p).split('/').pop();
  if (manifests[name]) return manifests[name];
  if (name.endsWith('.tgz')) return TARBALL;
  throw new Error(`unexpected read: ${p}`);
};
const healthyDeps = (calls) => ({
  root: '/repo',
  run: healthyRun(calls),
  readFile: fakeReadFile,
  exists: () => true,
  loadBridge: async () => ({ KNOWN_VENDORED_ADLC: KNOWN }),
  loadDigests: async () => ({ computeVendoredDigests: () => ({ ...KNOWN }) }),
  loadDrift: async () => ({ classifyDrift: () => ({ status: 'ok', ok: true, message: '' }) }),
  now: () => 1000,
});

test('probes() on a healthy tree reports every probe empty, nothing unconsultable, and that it rebuilt', async () => {
  const calls = [];
  const out = await probes(healthyDeps(calls));
  assert.deepEqual(out.unconsultable, []);
  for (const k of ['lockstep', 'vendoredDigests', 'vendoredTarball', 'bundleDrift', 'websiteGen', 'releaseDrift', 'shellcheck']) {
    assert.deepEqual(out[k], [], `${k} must be clean`);
  }
  assert.equal(out.bundleRebuilt, true);
  assert.deepEqual(out.git, { branch: 'main', clean: true, dirtyPaths: [], head: 'abc', originMain: 'abc', syncedWithOriginMain: true });
  assert.ok(calls.some((c) => c === 'npm run build'));
});

test('probes() on a dirty tree skips the rebuild and names it, and honours --skip-build', async () => {
  const calls = [];
  const deps = healthyDeps(calls);
  deps.run = healthyRun(calls, [[/^git status --porcelain$/, ' M lib/x.mjs']]);
  const out = await probes(deps);
  assert.equal(out.git.clean, false);
  assert.deepEqual(out.git.dirtyPaths, [' M lib/x.mjs']);
  assert.equal(out.bundleRebuilt, false);
  assert.ok(out.unconsultable.some((u) => /bundle drift: working tree is not clean/.test(u)));
  assert.ok(!calls.includes('npm run build'));

  const skipped = await probes({ ...healthyDeps([]), skipBuild: true });
  assert.ok(skipped.unconsultable.some((u) => /skipped via --skip-build/.test(u)));
});

test('probes() records an unparseable manifest and a failing digest import as unconsultable, never clean', async () => {
  const deps = healthyDeps([]);
  deps.readFile = () => { throw new Error('ENOENT'); };
  deps.loadDigests = async () => { throw new Error('vendor/adlc missing'); };
  const out = await probes(deps);
  assert.ok(out.unconsultable.some((u) => /could not be parsed; lockstep and tarball probes skipped/.test(u)));
  assert.ok(out.unconsultable.some((u) => /vendored adlc digests: vendor\/adlc missing/.test(u)));
  assert.deepEqual(out.lockstep, []);
  assert.deepEqual(out.vendoredDigests, []);
});

test('probes() surfaces a lockstep break and a release-drift module failure', async () => {
  const deps = healthyDeps([]);
  deps.readFile = (p) => (String(p).endsWith('plugin.json') ? JSON.stringify({ version: '1.0.0' }) : fakeReadFile(p));
  deps.loadDrift = async () => { throw new Error('no classifier'); };
  const out = await probes(deps);
  assert.equal(out.lockstep.length, 1);
  assert.ok(out.unconsultable.some((u) => /release drift: no classifier/.test(u)));
  assert.ok(out.unconsultable.some((u) => /release-drift\.mjs could not be loaded/.test(u)));
});

// ─── assembly and projection ─────────────────────────────────────────────────

test('assemble produces the input document shape the synthesizer reads', () => {
  const units = [{ id: 'surface:cli', paths: ['bin/agb.mjs'] }];
  const routed = { byUnit: new Map([['surface:cli', [{ number: 1 }]]]), unmapped: [{ number: 2 }], escalated: [] };
  const doc = assemble({ version: '1.2.0', since: 'v1.1.0', units, issues: [{}, {}], routed, probeResults: { unconsultable: [] }, churn: new Map([['surface:cli', { commits: 1 }]]), issuesUnconsultable: null });
  assert.equal(doc.schema, 'release-audit-input/booster-1');
  assert.equal(doc.package, PACKAGE_NAME);
  assert.equal(doc.unitCount, 1);
  assert.deepEqual(doc.units[0].issues, [{ number: 1 }]);
  assert.deepEqual(doc.units[0].churn, { commits: 1 });
  assert.equal(doc.issues.open, 2);
  assert.equal(doc.issues.routed, 1);
  assert.deepEqual(doc.issues.sweepBatches, [[{ number: 2 }]]);
});

test('workflowArgs drops the per-surface file inventory and issue excerpts the prompts never read', () => {
  const doc = { version: '1.2.0', units: [{ id: 'surface:cli', fileCount: 32, bytes: 900, files: ['a', 'b'], issues: [{ number: 1, excerpt: 'long' }] }], issues: { sweepBatches: [[{ number: 2, excerpt: 'x' }]] }, probes: {} };
  const a = workflowArgs(doc);
  assert.equal(a.units[0].files, undefined);
  assert.equal(a.units[0].fileCount, 32);
  assert.equal(a.units[0].issues[0].excerpt, undefined);
  assert.equal(a.issues.sweepBatches[0][0].excerpt, undefined);
});

test('workflowArgs keeps the fan-out inputs and defaults the absent ones', () => {
  const a = workflowArgs({ version: '1.2.0', currentVersion: '1.1.0', since: 'v1.1.0' });
  assert.equal(a.package, PACKAGE_NAME);
  assert.equal(a.version, '1.2.0');
  assert.equal(a.filtered, false);
  assert.deepEqual(a.units, []);
  assert.deepEqual(a.issues.sweepBatches, [[]]);
  for (const k of ['lockstep', 'vendoredDigests', 'vendoredTarball', 'bundleDrift', 'websiteGen', 'releaseDrift', 'shellcheck', 'unconsultable']) {
    assert.deepEqual(a.probes[k], [], `probes.${k} must default to []`);
  }
  assert.equal(workflowArgs({ filtered: true }).filtered, true);
});

// ─── end to end, offline ─────────────────────────────────────────────────────

/** collectMain against the real tree with every subprocess faked. */
function offlineDeps(lines, extraRun = []) {
  const calls = [];
  const issues = JSON.stringify([
    { number: 1, title: 'agb doctor lies', body: '', labels: [{ name: 'bug' }], url: 'u1' },
    { number: 2, title: '[P1] fix: something unrouted', body: 'no path here', labels: [], url: 'u2' },
    { number: 3, title: 'x', body: 'in lib/lock.mjs and mcp/server.mjs', labels: [], url: 'u3' },
  ]);
  const run = fakeRun([
    ...extraRun,
    [/^git tag --sort=-v:refname --list v\*$/, 'v1.1.0\nv1.0.0'],
    [/^git log --no-merges/, 'abc one'],
    [/^git diff --name-only/, 'lib/a.mjs'],
    [/^gh issue list/, issues],
    [/^git rev-parse --abbrev-ref HEAD$/, 'main'],
    [/^git status --porcelain$/, ''],
    [/^git rev-parse HEAD$/, 'abc'],
    [/^git rev-parse origin\/main$/, 'abc'],
    [/gen-reference\.mjs --check$/, 'up to date'],
    [/^npm view/, '1.1.0'],
    [/^git tag -l$/, 'v1.1.0'],
    [/^git log -1 --format=%ct/, '1'],
    [/^gh repo view/, 'o/r'],
    [/^gh api/, '{"status":"completed","conclusion":"success"}'],
    [/^shellcheck --version$/, new Error('ENOENT')],
  ], calls);
  return {
    calls,
    deps: {
      run,
      log: (m) => lines.push(m),
      loadBridge: async () => ({ KNOWN_VENDORED_ADLC: KNOWN }),
      loadDigests: async () => ({ computeVendoredDigests: () => ({ ...KNOWN }) }),
      loadDrift: async () => ({ classifyDrift: () => ({ status: 'ok', ok: true, message: '' }) }),
    },
  };
}

test('collectMain emits the full document for the real tree with every subprocess faked', async () => {
  const lines = [];
  const { deps, calls } = offlineDeps(lines);
  const code = await collectMain(['--skip-build'], deps);
  assert.equal(code, 0);
  const doc = JSON.parse(lines.join(''));
  assert.equal(doc.unitCount, 9);
  assert.deepEqual(doc.units.map((u) => u.id), UNITS.map((u) => u.id));
  assert.equal(doc.since, 'v1.1.0');
  assert.match(doc.version, /^\d+\.\d+\.0$/);
  assert.equal(doc.filtered, false);
  assert.equal(doc.issues.open, 3);
  const install = doc.units.find((u) => u.id === 'surface:install');
  assert.deepEqual(install.issues.map((i) => i.number), [1], 'agb doctor routes to the install surface');
  assert.deepEqual(doc.issues.unmapped.map((i) => i.number), [2, 3]);
  assert.deepEqual(doc.issues.escalated.map((i) => i.number), [1, 2]);
  assert.deepEqual(doc.issues.sweepBatches.flat().map((i) => i.number), [1, 2, 3]);
  assert.ok(doc.probes.unconsultable.some((u) => /skipped via --skip-build/.test(u)));
  assert.ok(doc.probes.unconsultable.some((u) => /shellcheck/.test(u)));
  assert.ok(!calls.includes('npm run build'));
});

test('collectMain narrows the audited units but still routes against every surface', async () => {
  const lines = [];
  const { deps } = offlineDeps(lines);
  await collectMain(['--units', 'cli', '--skip-build', '--workflow-args'], deps);
  const a = JSON.parse(lines.join(''));
  assert.equal(a.filtered, true);
  assert.deepEqual(a.units.map((u) => u.id), ['surface:cli']);
  // #3 names two surfaces; narrowing to cli must not make it look unambiguous.
  assert.ok(a.issues.sweepBatches.flat().some((i) => i.number === 3 && i.routedVia === 'ambiguous-path'));
  assert.equal(a.units[0].files, undefined, 'the projection drops the inventory');
});
