#!/usr/bin/env node
// Zero-dependency CI rail-freeze gate (T-RAILS-GUARD-DIRSTORE).
// Exit codes: 0 pass, 1 operational failure (fail closed), 2 policy deny.
// Executed from the BASE branch copy (see .github/workflows/adlc-rails-guard.yml),
// never from the PR tree. Imports node: built-ins only. No env-var overrides.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export class Deny extends Error {}
export class OpFail extends Error {}
const deny = (m) => { throw new Deny(m); };
const opfail = (m) => { throw new OpFail(m); };

export const ACTIVE_DIR = '.adlc/tickets';
export const ARCHIVE_DIR = '.adlc/ticket-archive';
export const LEGACY = '.adlc/tickets.json';
export const LEGACY_ARCHIVE = '.adlc/tickets.archive.json';
export const ACTIVE_MANIFEST = Object.freeze({ format: 'adlc-ticket-directory', version: 1 });
export const ARCHIVE_MANIFEST = Object.freeze({ format: 'adlc-ticket-archive', version: 1 });
export const TRUST_ROOTS = Object.freeze(['.adlc/config.json', '.adlc/admin.pub', '.github/workflows/adlc-rails-guard.yml',
  'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', 'docs/ci/rails-guard.yml',
  'scripts/rails-guard-ci.mjs', 'scripts/test/rails-guard-workflow-hashes.json']);
export const DIR_STORE_ROOTS = Object.freeze([`${ACTIVE_DIR}/.store.json`, `${ARCHIVE_DIR}/.store.json`, LEGACY, LEGACY_ARCHIVE]);
export const MAX_SHARD_BYTES = 256 * 1024;
export const MAX_SHARDS = 5000;
export const GIT_TIMEOUT_MS = 60_000;
const ARCHIVE_META_KEYS = new Set(['version', 'archivedAt', 'reason', 'ticketHash', 'sourceStoreHash', 'sourceRevision']);
const HEX64 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40,64}$/;
const TICKET_HASH_DOMAIN = 'adlc:ticket:v1\0';

// ---- canonical forms: mirror of @adlc/tickets@1.11.1 lib/canonical.mjs and
// lib/filename.mjs (sorted-by-UTF-8-bytes object rebuild, then JSON.stringify,
// so integer-like keys order exactly as the library's output). Pinned by parity tests.
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const normalize = (v) => {
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort(byBytes)) out[k] = normalize(v[k]);
    return out;
  }
  return v;
};
export const canonicalJson = (v) => JSON.stringify(normalize(v));
export const prettyCanonicalJson = (v) => `${JSON.stringify(normalize(v), null, 2)}\n`;
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const ticketHash = (t) => sha256(TICKET_HASH_DOMAIN + canonicalJson(t));
export const ticketFilename = (id) => {
  const s = id.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return `${s || 'ticket'}--${sha256(id)}.json`;
};
export const eq = (a, b) => canonicalJson(a) === canonicalJson(b);
export const isValidRail = (r) => typeof r === 'string' && r.length > 0 && !r.includes('\0') && !/^[:-]/.test(r);
const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- git access (plumbing only; HEAD is never read from the working tree)
const safeEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
export function makeGit(cwd, { timeout = GIT_TIMEOUT_MS } = {}) {
  return (args, label, { allowFail = false } = {}) => {
    const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd, env: safeEnv(), encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) opfail(`${label} failed: ${r.error.message}`);
    if (r.signal) opfail(`${label} killed by ${r.signal}`);
    if (r.status !== 0 && !allowFail) opfail(`${label} exited ${r.status}: ${(r.stderr || '').trim()}`);
    return r;
  };
}
const parseLsTree = (out) => out.split('\0').filter(Boolean).map((rec) => {
  const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
  if (!m) opfail('unparseable ls-tree record');
  return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
});

// A read-only view of one revision. Base anomalies -> OpFail (exit 1), head anomalies -> Deny (exit 2).
export function gitTree(git, rev, side) {
  const bad = side === 'base' ? opfail : deny;
  const entry = (p) => {
    const e = parseLsTree(git(['ls-tree', '-z', '--full-tree', rev, '--', `:(literal)${p}`], `ls-tree ${side} ${p}`).stdout);
    return e.find((x) => x.path === p) ?? null;
  };
  const blob = (e) => {
    if (e.mode !== '100644' || e.type !== 'blob') bad(`${side}:${e.path} must be a regular 100644 blob`);
    if (!OID.test(e.oid)) opfail(`bad oid for ${e.path}`);
    const size = Number(git(['cat-file', '-s', e.oid], `cat-file -s ${e.path}`).stdout.trim());
    if (!(size <= MAX_SHARD_BYTES)) bad(`${side}:${e.path} exceeds ${MAX_SHARD_BYTES} bytes`);
    return git(['cat-file', 'blob', e.oid], `cat-file ${e.path}`).stdout;
  };
  return {
    side, bad,
    read(p) { const e = entry(p); return e ? blob(e) : null; },
    list(dir) {
      const d = entry(dir);
      if (!d) return null;
      if (d.type !== 'tree') bad(`${side}:${dir} must be a directory`);
      return parseLsTree(git(['ls-tree', '-z', '--full-tree', rev, '--', `:(literal)${dir}/`], `ls-tree ${side} ${dir}/`).stdout)
        .map((e) => ({ ...e, read: () => blob(e) }));
    },
  };
}

const parseJson = (tree, txt, label) => {
  try { return JSON.parse(txt); } catch (e) { return tree.bad(`cannot parse ${label}: ${e.message}`); }
};

export function shapeError(t, { active }) {
  if (!isObj(t)) return 'not an object';
  if (typeof t.id !== 'string' || !t.id) return 'id must be a non-empty string';
  if (typeof t.title !== 'string' || !t.title) return 'title must be a non-empty string';
  if (t.scope !== undefined && !isStrArr(t.scope)) return 'scope must be a string array';
  if (t.rails !== undefined && (!Array.isArray(t.rails) || !t.rails.every(isValidRail))) return 'rails must be valid rail strings';
  if (t.edges !== undefined && (!Array.isArray(t.edges) || !t.edges.every((e) => isObj(e) && typeof e.to === 'string' && e.to))) return 'edges must be [{to}]';
  if (t.duration !== undefined && !(Number.isFinite(t.duration) && t.duration > 0)) return 'duration must be positive';
  if (active && t.completed !== undefined && typeof t.completed !== 'boolean') return 'completed must be boolean';
  if (active && '_adlcArchive' in t) return '_adlcArchive not allowed in active store';
  return null;
}

function validateGraph(tree, map) {
  for (const { ticket } of map.values())
    for (const e of ticket.edges ?? []) if (!map.has(e.to)) tree.bad(`${tree.side}: ticket ${ticket.id} edge to unknown ${e.to}`);
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) tree.bad(`${tree.side}: edge cycle through ${id}`);
    state.set(id, 1);
    for (const e of map.get(id).ticket.edges ?? []) visit(e.to);
    state.set(id, 2);
  };
  for (const id of map.keys()) visit(id);
}

// Returns Map<id,{ticket,file}>, or null when the directory is absent.
export function loadStore(tree, dir, manifest, { active }) {
  const entries = tree.list(dir);
  if (entries === null) return null;
  if (entries.length > MAX_SHARDS + 1) tree.bad(`${tree.side}:${dir} has more than ${MAX_SHARDS} shards`);
  const map = new Map();
  const lower = new Set();
  let manifestOk = false;
  for (const e of entries) {
    const name = e.path.slice(dir.length + 1);
    if (e.type !== 'blob' || name.includes('/')) tree.bad(`${tree.side}:${e.path} nested or non-file entry in flat store`);
    if (lower.has(name.toLowerCase())) tree.bad(`${tree.side}:${e.path} case-insensitive name collision`);
    lower.add(name.toLowerCase());
    if (name !== '.store.json' && !name.endsWith('.json')) tree.bad(`${tree.side}:${e.path} non-json entry`);
    const v = parseJson(tree, e.read(), `${tree.side}:${e.path}`);
    if (name === '.store.json') {
      if (!eq(v, manifest)) tree.bad(`${tree.side}:${e.path} manifest mismatch`);
      manifestOk = true;
      continue;
    }
    const err = shapeError(v, { active });
    if (err) tree.bad(`${tree.side}:${e.path}: ${err}`);
    if (ticketFilename(v.id) !== name) tree.bad(`${tree.side}:${e.path} FILENAME_MISMATCH for id ${v.id}`);
    if (map.has(v.id)) tree.bad(`${tree.side}: duplicate ticket id ${v.id}`);
    map.set(v.id, { ticket: v, file: name });
  }
  if (!manifestOk) tree.bad(`${tree.side}:${dir} has no .store.json manifest`);
  if (active) validateGraph(tree, map);
  return map;
}

export function verifyArchive(baseTicket, archived) {
  const id = baseTicket.id;
  if (!isObj(archived)) deny(`archived ${id} is not an object`);
  const { _adlcArchive: meta, ...rest } = archived;
  if (!isObj(meta)) deny(`archived ${id} lacks an _adlcArchive object`);
  for (const k of Object.keys(meta)) if (!ARCHIVE_META_KEYS.has(k)) deny(`archived ${id} _adlcArchive has undeclared key ${k}`);
  if (meta.version !== 1 || meta.reason !== 'completed') deny(`archived ${id} must be version 1, reason "completed"`);
  if (typeof meta.archivedAt !== 'string' || !Number.isFinite(Date.parse(meta.archivedAt))) deny(`archived ${id} archivedAt invalid`);
  if (!HEX64.test(meta.ticketHash ?? '') || !HEX64.test(meta.sourceStoreHash ?? '')) deny(`archived ${id} hashes malformed`);
  if (!(meta.sourceRevision === undefined || meta.sourceRevision === null || typeof meta.sourceRevision === 'string')) deny(`archived ${id} sourceRevision invalid`);
  if (rest.completed !== true) deny(`archived ${id} must carry completed: true`);
  if (!eq(rest, { ...baseTicket, completed: true })) deny(`archived ${id} contract differs from base (only completed:true may be added)`);
  if (meta.ticketHash !== ticketHash(rest)) deny(`archived ${id} ticketHash does not match content`);
}

export function checkDirTransitions({ baseAct, headAct, baseArc, headArc, mbAct }) {
  const unchangedSinceBranch = (id, b) => {
    const m = mbAct?.get(id)?.ticket;
    if (!m || !eq(m, b)) deny(`ticket ${id} changed on base since the PR branched; rebase before completing/archiving it`);
  };
  const archivedNow = new Set();
  for (const [id, { ticket: b, file }] of baseAct) {
    const h = headAct.get(id);
    if (h) {
      if (eq(h.ticket, b)) continue;
      if (b.completed !== true && eq(h.ticket, { ...b, completed: true })) { unchangedSinceBranch(id, b); continue; }
      deny(`base ticket ${id} contract cannot change in a PR (only completed:true may be added)`);
    }
    const a = headArc.get(id);
    if (!a || a.file !== file) deny(`base ticket ${id} cannot be removed except by archiving it to ${ARCHIVE_DIR}/${file}`);
    if (baseArc.has(id)) deny(`ticket ${id} is already archived at base (ARCHIVE_COLLISION)`);
    verifyArchive(b, a.ticket);
    unchangedSinceBranch(id, b);
    for (const { ticket } of headAct.values())
      if ((ticket.edges ?? []).some((e) => e.to === id)) deny(`ARCHIVE_INBOUND_EDGE: ${ticket.id} still points at archived ${id}`);
    archivedNow.add(id);
  }
  for (const [id, { ticket, file }] of baseArc) {
    const h = headArc.get(id);
    if (!h || h.file !== file || !eq(h.ticket, ticket)) deny(`archived ticket ${id} cannot be modified, removed, or restored in a PR`);
  }
  for (const id of headArc.keys())
    if (!baseArc.has(id) && !archivedNow.has(id)) deny(`archive shard for ${id} is not paired with removal of an active base ticket`);
  for (const id of headAct.keys())
    if (!baseAct.has(id) && baseArc.has(id)) deny(`new active ticket reuses archived id ${id}`);
}

function loadLegacy(tree, txt, label) {
  const v = parseJson(tree, txt, label);
  if (!isObj(v) || !Array.isArray(v.tickets)) tree.bad(`${label} must be {tickets:[...]}`);
  const ids = new Set();
  for (const t of v.tickets) {
    if (!isObj(t) || typeof t.id !== 'string' || !t.id) tree.bad(`${label}: ticket without id`);
    if (ids.has(t.id)) tree.bad(`${label}: duplicate id ${t.id}`);
    if (t.rails !== undefined && (!Array.isArray(t.rails) || !t.rails.every(isValidRail))) tree.bad(`${label}: ${t.id} invalid rails`);
    ids.add(t.id);
  }
  return v.tickets;
}

function legacyRails(base, head, baseTxt) {
  const bt = loadLegacy(base, baseTxt, `base ${LEGACY}`);
  const headTxt = head.read(LEGACY);
  if (headTxt === null) deny(`${LEGACY} exists at base but is absent at HEAD`);
  const ht = new Map(loadLegacy(head, headTxt, `head ${LEGACY}`).map((t) => [t.id, t]));
  for (const t of bt) {
    if (!ht.has(t.id)) deny(`base ticket ${t.id} cannot be removed from ${LEGACY} in a PR`);
    if (!eq(ht.get(t.id), t)) deny(`base ticket ${t.id} contract cannot change in a PR`);
  }
  return bt.flatMap((t) => t.rails ?? []); // legacy: status ignored, unchanged semantics
}

function checkManifest(base, head) {
  const b = base.read('.adlc/manifest.jsonl');
  const h = head.read('.adlc/manifest.jsonl');
  if (b !== null) { if (h === null || !h.startsWith(b)) deny('.adlc/manifest.jsonl must be append-only'); }
  else if (h !== null && h.length > 0) deny('.adlc/manifest.jsonl cannot be introduced non-empty in a PR');
}

function evaluateDirStore({ base, head, mergeBase, baseAct, headAct, log }) {
  if (head.read(LEGACY) !== null || head.read(LEGACY_ARCHIVE) !== null) deny('cannot reintroduce legacy ticket files next to the directory store');
  if (!headAct) deny(`${ACTIVE_DIR} store removed at HEAD`);
  const baseArc = loadStore(base, ARCHIVE_DIR, ARCHIVE_MANIFEST, { active: false }) ?? new Map();
  const headArc = loadStore(head, ARCHIVE_DIR, ARCHIVE_MANIFEST, { active: false }) ?? new Map();
  const mbAct = mergeBase.list(ACTIVE_DIR) === null ? null : loadStore(mergeBase, ACTIVE_DIR, ACTIVE_MANIFEST, { active: true });
  checkDirTransitions({ baseAct, headAct, baseArc, headArc, mbAct });
  log(`directory ticket store at base: ${baseAct.size} active ticket(s), ${baseArc.size} archived.`);
  return [...baseAct.values()].filter(({ ticket }) => ticket.completed !== true).flatMap(({ ticket }) => ticket.rails ?? []);
}

// Core: trees in, frozen rails + trust roots out. Throws Deny/OpFail.
export function evaluate({ base, head, mergeBase, log = () => {} }) {
  const baseLegacyTxt = base.read(LEGACY);
  const baseAct = loadStore(base, ACTIVE_DIR, ACTIVE_MANIFEST, { active: true });
  if (baseLegacyTxt !== null && baseAct) opfail('AMBIGUOUS_STORE at base (both tickets.json and tickets/)');
  const headAct = loadStore(head, ACTIVE_DIR, ACTIVE_MANIFEST, { active: true });
  if (head.read(LEGACY) !== null && headAct) deny('AMBIGUOUS_STORE at HEAD');
  let rails = [];
  let extraRoots = [];
  if (baseAct) {
    rails = evaluateDirStore({ base, head, mergeBase, baseAct, headAct, log });
    extraRoots = DIR_STORE_ROOTS;
  } else if (baseLegacyTxt !== null) {
    rails = legacyRails(base, head, baseLegacyTxt);
  } else {
    log('no ticket store at base — protecting ADLC trust roots only.');
  }
  checkManifest(base, head);
  for (const r of rails) if (!isValidRail(r)) opfail(`invalid rail string at base: ${JSON.stringify(r)}`);
  return { rails: [...new Set(rails)].sort(byBytes), trustRoots: [...TRUST_ROOTS, ...extraRoots] };
}

export function resolveRevs(git, baseRef) {
  const r = git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], `rev-parse ${baseRef}`, { allowFail: true });
  if (r.status !== 0) opfail(`base ref ${baseRef} does not resolve — rails cannot be verified`);
  const T = r.stdout.trim();
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'], 'rev-list HEAD').stdout.trim().split(' ');
  if (parents.length !== 3) opfail('HEAD is not a PR merge ref (expected exactly 2 parents)');
  if (parents[1] !== T) opfail(`stale merge ref: HEAD^1 ${parents[1]} != ${baseRef} ${T}; re-run the check`);
  const mbs = git(['merge-base', '--all', T, parents[2]], 'merge-base').stdout.trim().split('\n').filter(Boolean);
  if (mbs.length !== 1) opfail('no single merge-base (criss-cross or unrelated history)');
  return { T, H: parents[0], P: parents[2], M: mbs[0] };
}

function runRailsGuard(cwd, T, rails) {
  const r = spawnSync('adlc', ['rails-guard', '--base', T, ...rails.flatMap((x) => ['--rails', x])],
    { cwd, env: safeEnv(), stdio: 'inherit', timeout: 120_000 });
  if (r.error) opfail(`could not run adlc rails-guard: ${r.error.message} (is @adlc/cli installed?)`);
  if (r.signal) opfail(`adlc rails-guard killed by ${r.signal}`);
  return typeof r.status === 'number' ? r.status : 1;
}

export function main(argv, { cwd = process.cwd(), log = console.log, err = console.error, gitTimeout } = {}) {
  const bi = argv.indexOf('--base');
  const baseRef = bi >= 0 ? argv[bi + 1] : undefined;
  const bootstrap = argv.includes('--bootstrap-unverified');
  try {
    if (!baseRef || baseRef.startsWith('-')) opfail('usage: rails-guard-ci.mjs --base <ref> [--bootstrap-unverified]');
    const git = makeGit(cwd, gitTimeout ? { timeout: gitTimeout } : {});
    const { T, H, M } = resolveRevs(git, baseRef);
    const base = gitTree(git, T, 'base');
    const head = gitTree(git, H, 'head');
    const mergeBase = gitTree(git, M, 'base');
    if (base.list('.adlc') === null) {
      log('base has no .adlc tree — bootstrap PR; the acknowledgement step governs.');
      if (bootstrap) deny('BOOTSTRAP: guard is not on base yet; this PR-copy run is informational and never passes');
      return 0;
    }
    if (base.read('.adlc/config.json') === null) opfail('base has .adlc but no .adlc/config.json; rail-freeze gate cannot run without bootstrap acknowledgement');
    const { rails, trustRoots } = evaluate({ base, head, mergeBase, log });
    log(`frozen rails (${rails.length}): ${rails.join(' ') || '(none)'}`);
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-M', `${T}...${H}`, '--',
      ...trustRoots.map((p) => `:(literal)${p}`)], 'git diff trust roots').stdout.trim();
    if (diff) deny(`ADLC trust root changed, deleted, or renamed:\n${diff}`);
    if (bootstrap) deny('BOOTSTRAP: guard is not on base yet; this PR-copy run is informational and never passes');
    if (!rails.length) { log('no active rails at base — nothing frozen beyond trust roots.'); return 0; }
    // Own rail check with renames disabled: upstream rails-guard reports a pure (R100) rename only
    // under its new path, so a frozen rail could be moved out from under its glob unnoticed.
    const code = runRailsGuard(cwd, T, rails);
    if (code !== 0) return code;
    const railDiff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', `${T}...${H}`, '--',
      ...rails.flatMap((x) => [`:(literal)${x}`, `:(glob)${x}`])], 'git diff rails').stdout.trim();
    if (railDiff) deny(`frozen rail changed, deleted, or renamed:\n${railDiff}`);
    return 0;
  } catch (e) {
    err(`rails-guard-ci: ${e?.message ?? String(e)}`);
    return e instanceof Deny ? 2 : 1;
  }
}

// Entry check on resolved paths: import.meta.url is symlink-resolved but
// argv[1] is not (macOS /var -> /private/var). A mismatch here used to skip
// main() and exit 0, i.e. pass every PR, so compare realpaths.
const isEntry = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (process.argv[1] && isEntry()) process.exit(main(process.argv.slice(2)));
