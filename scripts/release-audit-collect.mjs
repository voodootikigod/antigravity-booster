#!/usr/bin/env node
// release-audit-collect — Phase A of /release-audit: gather everything the audit
// needs BEFORE any model runs, and emit it as one JSON document.
//
// WHY THIS IS A SEPARATE PHASE. The audit fans out through the Workflow tool, and
// a workflow script has no filesystem and no child_process — it can only read the
// `args` value handed to it. So every mechanical fact the agents need (which
// surfaces exist, what changed since the last tag, which GitHub issue belongs to
// which surface, whether the tree is even in a releasable state) has to be
// collected here, in real Node, and passed in. Nothing in this file asks a model
// anything.
//
// WHY SURFACES, NOT PACKAGES. This is a port of adlc's release-audit, which gives
// every npm package in a lockstep monorepo its own agent. antigravity-booster is
// ONE npm package that is also a native agy plugin installed from a git URL with
// no `npm install` step, so "one agent per package" would be one agent for the
// whole repository — and one agent asked to read 2 MB of shipped code will skim.
// The units are therefore the shipped SURFACES (the CLI, the scheduler, the
// policy-guard hook, the MCP server, ...), declared in UNITS below rather than
// discovered, because the surface boundaries are an editorial decision about what
// a user installs and runs, not something a directory walk can infer.
//
// WHY THE MECHANICAL CHECKS ARE IMPORTED, NOT REIMPLEMENTED. This repository
// already owns its integrity gates: the vendored-adlc digest pins in
// lib/adlc-bridge.mjs, the digest computation in scripts/update-adlc-digests.mjs,
// and the stranded-release classifier in scripts/release-drift.mjs. Each of those
// records what it cost to learn its rule. Restating them here would recreate
// exactly the divergence they exist to prevent, so this file imports them and
// reports what they say.
//
// FAIL-CLOSED DISCIPLINE. A probe that could not run is recorded as
// `unconsultable`, never as clean. "Could not check" must never render as
// "verified".
//
// Usage:
//   node scripts/release-audit-collect.mjs [version] [--since <tag>]
//        [--units a,b] [--skip-issues] [--skip-build] [--workflow-args]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The published package, as npm and the registry know it. */
export const PACKAGE_NAME = 'antigravity-booster';

/** Source extensions a unit agent is asked to read. Shell and PowerShell ship. */
export const SOURCE_EXT = new Set(['.mjs', '.cjs', '.js', '.ts', '.json', '.md', '.sh', '.ps1', '.html', '.css', '.tgz']);

/** Directories never worth walking into when inventorying a unit. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.worktrees', '.next']);

/**
 * The shipped surfaces, each of which gets its own audit agent.
 *
 * `paths` are repo-relative files or directories that make up the surface as a
 * user experiences it — including the committed bundle under dist/ that actually
 * runs, because a bug that exists in dist/ and not in lib/ is the one the user
 * hits. The lists are disjoint (a test asserts it): an issue or a file routes to
 * exactly one surface or to none.
 *
 * `rails` names the standing candidate rails inside a surface (AGENTS.md P3): the
 * agent is told they are frozen so it audits them as read-only hardened code
 * rather than proposing edits.
 */
export const UNITS = Object.freeze([
  {
    id: 'surface:cli',
    kind: 'cli',
    label: 'CLI entry, slash commands, status and sweep',
    paths: ['bin/agb.mjs', 'dist/agb.mjs', 'lib/status.mjs', 'lib/sweep.mjs', 'lib/semver.mjs', 'lib/agy.mjs',
      'lib/charters.mjs', 'lib/brain.mjs', 'lib/plugin-paths.mjs', 'commands', 'agents', 'templates', 'docs/calibration'],
    rails: [],
  },
  {
    id: 'surface:scheduler',
    kind: 'core',
    label: 'Run scheduler: lock, pools, worktrees, run integrity, sandbox gates',
    paths: ['lib/scheduler.mjs', 'lib/lock.mjs', 'lib/pools.mjs', 'lib/worktrees.mjs', 'lib/run-integrity.mjs',
      'lib/gates.mjs', 'lib/sandbox-probe-helper.mjs', 'lib/job-object-wrapper.ps1'],
    rails: ['lib/lock.mjs', 'lib/gates.mjs'],
  },
  {
    id: 'surface:adlc-gates',
    kind: 'core',
    label: 'ADLC integrations: adlc bridge, rails, plan, review, preflight, prosecute',
    paths: ['lib/adlc-bridge.mjs', 'lib/active-rails.mjs', 'lib/prosecute.mjs', 'lib/review.mjs', 'lib/plan.mjs',
      'lib/preflight.mjs', 'lib/digest.mjs'],
    rails: [],
  },
  {
    id: 'surface:policy-guard',
    kind: 'hook',
    label: 'PreToolUse policy guard: hook bundle, runner and Node launcher',
    paths: ['hooks', 'hooks.json', 'bin/hook-runner.sh', 'bin/node-launcher.sh', 'dist/hooks'],
    rails: [],
  },
  {
    id: 'surface:mcp',
    kind: 'server',
    label: 'MCP server and its plugin wiring',
    paths: ['mcp', 'mcp_config.json', 'dist/mcp-server.mjs'],
    rails: [],
  },
  {
    id: 'surface:install',
    kind: 'install',
    label: 'Plugin manifest, bootstrap, doctor, migrate and rollback',
    paths: ['plugin.json', 'package.json', 'lib/bootstrap.mjs', 'lib/doctor.mjs', 'lib/migrate.mjs', 'lib/migration-lock.mjs'],
    rails: [],
  },
  {
    id: 'surface:vendor',
    kind: 'vendor',
    label: 'Vendored adlc dispatcher, pinned digests and the cached plugin tarball',
    paths: ['vendor', 'scripts/update-adlc-digests.mjs', 'scripts/check-bundle-externals.mjs'],
    rails: [],
  },
  {
    id: 'surface:skills',
    kind: 'skills',
    label: 'Shipped skills (modernize, release) and their scripts',
    paths: ['skills'],
    rails: [],
  },
  {
    id: 'surface:sidecar',
    kind: 'ui',
    label: 'Dashboard sidecar server and UI',
    paths: ['sidecars'],
    rails: [],
  },
]);

/**
 * `agb <command>` → the surface that owns it. Used as the third routing tier:
 * an issue titled "agb doctor reports OK when..." names the install surface even
 * when its body cites no path. Only exact command words count; a word that maps
 * to nothing routes nowhere.
 */
export const COMMAND_UNITS = Object.freeze({
  run: 'surface:scheduler',
  plan: 'surface:adlc-gates',
  review: 'surface:adlc-gates',
  prosecute: 'surface:adlc-gates',
  preflight: 'surface:adlc-gates',
  doctor: 'surface:install',
  bootstrap: 'surface:install',
  migrate: 'surface:install',
  status: 'surface:cli',
  sweep: 'surface:cli',
  probe: 'surface:cli',
  sidecar: 'surface:sidecar',
});

/** Labels that force an issue onto the sweep agent no matter where it routed. */
export const ESCALATE_LABELS = new Set(['bug', 'security']);

/**
 * Title markers that escalate. This repository has only GitHub's default labels,
 * so priority lives in the title ("[P1] fix: ..."), not in a label.
 */
export const ESCALATE_TITLE = /\[P[01]\]/;

/**
 * Issues per sweep agent. One agent asked to read the code behind a whole
 * backlog will skim or go hollow — the precise failure the coverage rules exist
 * to catch. Sharding keeps each agent's job small enough to actually do.
 */
export const SWEEP_BATCH_SIZE = 12;

// ─── argument parsing ────────────────────────────────────────────────────────

/**
 * Parse the skill's flags. Deliberately tiny: every additional mode is a way to
 * produce a weaker verdict that still looks like a verdict.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { version: null, since: null, units: null, skipIssues: false, skipBuild: false, workflowArgs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') { out.since = argv[i + 1] ?? null; i += 1; continue; }
    if (a === '--units') {
      const raw = argv[i + 1] ?? '';
      i += 1;
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      out.units = names.length ? names : null;
      continue;
    }
    if (a === '--skip-issues') { out.skipIssues = true; continue; }
    if (a === '--skip-build') { out.skipBuild = true; continue; }
    if (a === '--workflow-args') { out.workflowArgs = true; continue; }
    if (a.startsWith('-')) continue;
    if (out.version === null) out.version = a;
  }
  return out;
}

/**
 * The version this release would cut, when the caller did not name one. Minor,
 * because /release defaults to minor and the two must agree on what they are
 * talking about.
 */
export function nextMinor(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(current ?? ''));
  if (!m) return String(current ?? '');
  return `${m[1]}.${Number(m[2]) + 1}.0`;
}

// ─── unit inventory ──────────────────────────────────────────────────────────

/**
 * Every file under one declared path worth showing an agent, repo-relative,
 * sorted. A file path is listed as itself; a directory is walked, bounded by
 * extension and SKIP_DIRS.
 */
export function inventory(paths, { root = ROOT, readDir = readdirSync, stat = statSync, exists = existsSync } = {}) {
  const found = [];
  const rel = (abs) => relative(root, abs).split(sep).join('/');
  const add = (abs) => {
    let size = 0;
    try { size = stat(abs).size; } catch { size = 0; }
    found.push({ path: rel(abs), bytes: size });
  };
  const walk = (abs) => {
    let entries;
    try { entries = readDir(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) { walk(child); continue; }
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXT.has(entry.name.slice(dot))) continue;
      add(child);
    }
  };
  for (const p of paths) {
    const abs = join(root, p);
    if (!exists(abs)) continue;
    let isDir = false;
    try { isDir = stat(abs).isDirectory(); } catch { isDir = false; }
    if (isDir) walk(abs); else add(abs);
  }
  return found;
}

/** The declared units with their real inventory attached. */
export function discoverUnits({ root = ROOT, readDir = readdirSync, stat = statSync, exists = existsSync } = {}) {
  return UNITS.map((u) => {
    const files = inventory(u.paths, { root, readDir, stat, exists });
    const missing = u.paths.filter((p) => !exists(join(root, p)));
    return {
      ...u,
      paths: [...u.paths],
      rails: [...u.rails],
      missingPaths: missing,
      fileCount: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      files: files.map((f) => f.path),
    };
  });
}

// ─── issue routing ───────────────────────────────────────────────────────────

/**
 * The unit a repo-relative path belongs to, or null. Longest matching declared
 * path wins, so `lib/lock.mjs` cannot be claimed by a sibling prefix.
 */
export function unitForPath(path, units = UNITS) {
  const p = String(path ?? '').split('\\').join('/').replace(/^\.\//, '');
  let best = null;
  let bestLen = -1;
  for (const u of units) {
    for (const base of u.paths) {
      if ((p === base || p.startsWith(`${base}/`)) && base.length > bestLen) {
        best = u.id;
        bestLen = base.length;
      }
    }
  }
  return best;
}

/** The literal directory prefix of a glob — everything before the first wildcard. */
export function globPrefix(glob) {
  const g = String(glob ?? '').split('\\').join('/');
  const star = g.search(/[*?[]/);
  if (star === -1) return g;
  const literal = g.slice(0, star);
  const cut = literal.lastIndexOf('/');
  return cut === -1 ? '' : literal.slice(0, cut);
}

/** GitHub issue numbers a ticket body backlinks to. */
export function linkedIssueNumbers(body) {
  const out = new Set();
  const re = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/g;
  let m;
  while ((m = re.exec(String(body ?? ''))) !== null) out.add(Number(m[1]));
  return [...out];
}

/** True when an issue must reach the sweep agent regardless of where it routed. */
export function isEscalated(issue) {
  const labelled = (issue?.labels ?? []).some((l) => ESCALATE_LABELS.has(typeof l === 'string' ? l : l?.name));
  return labelled || ESCALATE_TITLE.test(String(issue?.title ?? ''));
}

/** Repo-relative path mentions in free text, restricted to the declared surfaces' roots. */
const PATH_RE = /(?:^|[\s`'"(,:])((?:bin|lib|hooks|mcp|dist|vendor|sidecars|skills|commands|agents|templates|scripts|docs)\/[A-Za-z0-9._/-]*|hooks\.json|mcp_config\.json|plugin\.json)/g;

/**
 * Route one issue to a surface, by descending evidence strength:
 *   1. an explicit repo path in the title or body
 *   2. a linked ADLC ticket whose `scope` globs land in exactly one surface
 *   3. an `agb <command>` or `agb_<tool>` token in the TITLE
 *
 * Every tier refuses to guess when the evidence points at more than one surface.
 * Under-claiming is safe; over-claiming hands an issue to one agent and hides it
 * from the one that owns it. An unrouted issue is not lost — it goes to the sweep
 * agent, which exists for exactly this residue.
 *
 * @returns {{unit: string|null, via: string}}
 */
export function routeIssue(issue, units = UNITS, ticketsByIssue = new Map()) {
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;

  const pathHits = new Set();
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const id = unitForPath(m[1].replace(/[.,:;)]+$/, ''), units);
    if (id) pathHits.add(id);
  }
  if (pathHits.size === 1) return { unit: [...pathHits][0], via: 'path-mention' };

  const scopeHits = new Set();
  for (const ticket of ticketsByIssue.get(issue.number) ?? []) {
    for (const glob of ticket.scope ?? []) {
      const id = unitForPath(globPrefix(glob), units);
      if (id) scopeHits.add(id);
    }
  }
  if (scopeHits.size === 1) return { unit: [...scopeHits][0], via: 'ticket-scope' };

  const commandHits = new Set();
  const title = String(issue.title ?? '');
  const cmdRe = /\bagb\s+([a-z-]+)/g;
  while ((m = cmdRe.exec(title)) !== null) {
    const id = COMMAND_UNITS[m[1]];
    if (id && units.some((u) => u.id === id)) commandHits.add(id);
  }
  if (/\bagb_[a-z_]+\b/.test(title) && units.some((u) => u.id === 'surface:mcp')) commandHits.add('surface:mcp');
  if (commandHits.size === 1) return { unit: [...commandHits][0], via: 'command-token' };

  if (pathHits.size > 1) return { unit: null, via: 'ambiguous-path' };
  if (scopeHits.size > 1) return { unit: null, via: 'ambiguous-ticket-scope' };
  if (commandHits.size > 1) return { unit: null, via: 'ambiguous-command' };
  return { unit: null, via: 'unrouted' };
}

/**
 * The sweep agents' workload: every unrouted issue, plus every escalated one
 * (which a surface agent may also have seen), de-duplicated by number and split
 * into fixed-size batches. Always at least one batch, so the coverage contract
 * has something to expect even on an empty backlog.
 */
export function sweepBatches(unmapped, escalated, size = SWEEP_BATCH_SIZE) {
  const byNumber = new Map();
  for (const i of [...unmapped, ...escalated]) if (!byNumber.has(i.number)) byNumber.set(i.number, i);
  const all = [...byNumber.values()].sort((a, b) => a.number - b.number);
  if (all.length === 0) return [[]];
  const out = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

/** How much of an issue body survives into the emitted document. */
export const ISSUE_EXCERPT = 200;

/**
 * Drop issue bodies from an issue record, keeping a short excerpt. Bodies are
 * read for ROUTING and then never referenced again — no agent prompt uses them,
 * and the document is embedded into the workflow script byte for byte.
 */
export function stripBody(issue) {
  const { body, ...rest } = issue;
  const text = String(body ?? '').trim();
  return { ...rest, excerpt: text.length > ISSUE_EXCERPT ? `${text.slice(0, ISSUE_EXCERPT)}…` : text };
}

/** Route every open issue, and collect the ones the sweep agent must see regardless. */
export function routeIssues(issues, units = UNITS, ticketsByIssue = new Map()) {
  const byUnit = new Map();
  const unmapped = [];
  const escalated = [];
  for (const issue of issues) {
    const { unit, via } = routeIssue(issue, units, ticketsByIssue);
    const record = stripBody({ ...issue, routedVia: via, routedTo: unit });
    if (unit) {
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit).push(record);
    } else {
      unmapped.push(record);
    }
    if (isEscalated(issue)) escalated.push(record);
  }
  return { byUnit, unmapped, escalated };
}

// ─── repository probes ───────────────────────────────────────────────────────

/**
 * Run a command, returning `{ok, out}` rather than throwing. Only TRAILING
 * whitespace is trimmed: `git status --porcelain` is positional ("XY path"), and
 * a full trim would eat the first line's status column.
 */
export function tryRun(cmd, args, { run = execFileSync, cwd = ROOT } = {}) {
  try {
    return { ok: true, out: String(run(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trimEnd() };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : '';
    const stdout = err?.stdout ? String(err.stdout) : '';
    return { ok: false, out: (stderr || stdout || String(err?.message ?? err)).trim() };
  }
}

/** The newest `vX.Y.Z` tag, which is the default audit baseline. */
export function newestVersionTag({ run = execFileSync } = {}) {
  const r = tryRun('git', ['tag', '--sort=-v:refname', '--list', 'v*'], { run });
  if (!r.ok) return null;
  return r.out.split('\n').map((s) => s.trim()).find((s) => /^v\d+\.\d+\.\d+$/.test(s)) ?? null;
}

/**
 * What changed in a surface since the baseline tag — the delta hint that tells
 * an agent where to spend its attention. Not a scope restriction: the agent
 * still audits the whole surface.
 */
export function churnFor(paths, since, { run = execFileSync } = {}) {
  if (!since) return { since: null, commits: 0, subjects: [], filesChanged: 0, unconsultable: 'no baseline tag' };
  const log = tryRun('git', ['log', '--no-merges', '--format=%h %s', `${since}..HEAD`, '--', ...paths], { run });
  if (!log.ok) return { since, commits: 0, subjects: [], filesChanged: 0, unconsultable: log.out };
  const subjects = log.out ? log.out.split('\n') : [];
  const stat = tryRun('git', ['diff', '--name-only', `${since}..HEAD`, '--', ...paths], { run });
  const files = stat.ok && stat.out ? stat.out.split('\n') : [];
  return { since, commits: subjects.length, subjects: subjects.slice(0, 25), filesChanged: files.length, files: files.slice(0, 50) };
}

/** How many open issues a single fetch will ask for. */
export const ISSUE_FETCH_LIMIT = 500;

/**
 * Open GitHub issues, or an explicit unconsultable record when `gh` cannot
 * answer. A response of exactly ISSUE_FETCH_LIMIT is reported as `truncated`
 * rather than accepted: a capped list is indistinguishable from a complete one.
 */
export function fetchIssues({ run = execFileSync, skip = false } = {}) {
  if (skip) return { issues: [], unconsultable: 'skipped via --skip-issues', truncated: null };
  const r = tryRun('gh', ['issue', 'list', '--state', 'open', '--limit', String(ISSUE_FETCH_LIMIT), '--json', 'number,title,body,labels,url,milestone'], { run });
  if (!r.ok) return { issues: [], unconsultable: `gh issue list failed: ${r.out.slice(0, 400)}`, truncated: null };
  try {
    const parsed = JSON.parse(r.out);
    return {
      issues: parsed.map((i) => ({
        number: i.number,
        title: i.title,
        body: String(i.body ?? '').slice(0, 4000),
        labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
        url: i.url,
        milestone: i.milestone?.title ?? null,
      })),
      unconsultable: null,
      truncated: parsed.length >= ISSUE_FETCH_LIMIT ? ISSUE_FETCH_LIMIT : null,
    };
  } catch (err) {
    return { issues: [], unconsultable: `gh issue list returned unparseable JSON: ${err.message}`, truncated: null };
  }
}

/** Every ADLC ticket in the directory store, indexed by the GitHub issue its body backlinks to. */
export function ticketsByIssueNumber({ root = ROOT, readDir = readdirSync, readFile = readFileSync } = {}) {
  const index = new Map();
  let files;
  try { files = readDir(join(root, '.adlc', 'tickets')); } catch { return index; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let ticket;
    try { ticket = JSON.parse(readFile(join(root, '.adlc', 'tickets', f), 'utf8')); } catch { continue; }
    for (const n of linkedIssueNumbers(ticket.body)) {
      if (!index.has(n)) index.set(n, []);
      index.get(n).push({ id: ticket.id, title: ticket.title, scope: ticket.scope ?? [], completed: ticket.completed === true });
    }
  }
  return index;
}

// ─── the individual probes, each pure over injected readers ──────────────────

/**
 * D11 lockstep: the git-URL plugin install reads plugin.json, npm reads
 * package.json, and the publish job refuses a tag that does not match
 * package.json. All four version fields must agree or one install path ships a
 * different version than the other.
 */
export function lockstepProblems({ pkg, plugin, lock }) {
  const problems = [];
  const v = pkg?.version;
  if (!v) return ['package.json has no version'];
  if (plugin?.version !== v) problems.push(`plugin.json version ${plugin?.version ?? '(missing)'} != package.json ${v} (D11 lockstep)`);
  if (lock?.version !== v) problems.push(`package-lock.json version ${lock?.version ?? '(missing)'} != package.json ${v}`);
  const rootEntry = lock?.packages?.['']?.version;
  if (rootEntry !== v) problems.push(`package-lock.json packages[""].version ${rootEntry ?? '(missing)'} != package.json ${v}`);
  return problems;
}

/** SRI string for a buffer, matching npm's lockfile `integrity` format. */
export function sri512(buf) {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

/**
 * The cached @adlc/antigravity tarball is what `agb bootstrap` installs from, so
 * it must be the pristine registry release (AGENTS.md amendment D6). CI proves
 * that by re-downloading with `npm pack`; offline, the same fact is the SHA-512
 * in package-lock.json, which IS the registry's published hash.
 */
export function tarballProblems({ pkg, lock, root = ROOT, readFile = readFileSync, exists = existsSync }) {
  const version = pkg?.devDependencies?.['@adlc/antigravity'];
  if (!version) return ['package.json does not pin @adlc/antigravity in devDependencies'];
  const rel = `vendor/cache/adlc-antigravity-${version}.tgz`;
  const abs = join(root, rel);
  if (!exists(abs)) return [`${rel} is missing — the bootstrap tarball for the pinned @adlc/antigravity@${version}`];
  const entry = lock?.packages?.['node_modules/@adlc/antigravity'];
  if (!entry?.integrity) return [`package-lock.json has no integrity for node_modules/@adlc/antigravity`];
  const problems = [];
  if (entry.version !== version) problems.push(`package-lock.json resolves @adlc/antigravity@${entry.version}, package.json pins ${version}`);
  let actual;
  try { actual = sri512(readFile(abs)); } catch (err) { return [`${rel} unreadable: ${err.message}`]; }
  if (actual !== entry.integrity) problems.push(`${rel} SHA-512 does not match the package-lock.json registry integrity (not the pristine release)`);
  return problems;
}

/** The pinned vendored-adlc digests versus what the tree actually hashes to. */
export function vendoredDigestProblems({ computed, known }) {
  const problems = [];
  for (const key of ['version', 'binarySha256', 'vendoredBundleSha256', 'treeDigest']) {
    if (computed?.[key] !== known?.[key]) {
      problems.push(`vendor/adlc ${key}: tree has ${computed?.[key] ?? '(none)'}, lib/adlc-bridge.mjs pins ${known?.[key] ?? '(none)'} — the bundled plugin would refuse it as vendored-adlc-tampered`);
    }
  }
  return problems;
}

/**
 * The bundle drift gate, exactly as CI's plugin-integrity job runs it: rebuild,
 * then ask git whether dist/ or vendor/ moved. This is the one probe that
 * MUTATES the tree (it rewrites the bundles), so it runs only on a clean tree —
 * mixing a stale-bundle rebuild into someone's uncommitted work would make the
 * result unreadable — and it records that it rebuilt.
 */
export function bundleDriftProbe({ run = execFileSync, root = ROOT, clean, skip = false }) {
  if (skip) return { problems: [], rebuilt: false, unconsultable: 'skipped via --skip-build' };
  if (clean !== true) return { problems: [], rebuilt: false, unconsultable: 'working tree is not clean, so the bundle rebuild was not run (commit or stash first)' };
  const build = tryRun('npm', ['run', 'build'], { run, cwd: root });
  if (!build.ok) return { problems: [`npm run build failed: ${build.out.slice(0, 600)}`], rebuilt: true, unconsultable: null };
  const status = tryRun('git', ['status', '--porcelain', '--untracked-files=all', 'dist/', 'vendor/'], { run, cwd: root });
  if (!status.ok) return { problems: [], rebuilt: true, unconsultable: `git status failed after the rebuild: ${status.out}` };
  const lines = status.out ? status.out.split('\n').filter(Boolean) : [];
  return {
    problems: lines.map((l) => `committed bundle is stale or untracked after a fresh build: ${l.trim()}`),
    rebuilt: true,
    unconsultable: null,
  };
}

/** The website's generated partials versus the CLI and CHANGELOG they are generated from. */
export function websiteGenProbe({ run = execFileSync, root = ROOT, exists = existsSync }) {
  const script = join(root, 'website', 'scripts', 'gen-reference.mjs');
  if (!exists(script)) return { problems: [], unconsultable: 'website/scripts/gen-reference.mjs is missing' };
  const r = tryRun(process.execPath, ['scripts/gen-reference.mjs', '--check'], { run, cwd: join(root, 'website') });
  if (r.ok) return { problems: [], unconsultable: null };
  const lines = r.out.split('\n').filter((l) => /out of date/.test(l));
  if (lines.length === 0) return { problems: [], unconsultable: `gen-reference --check failed without naming a stale partial: ${r.out.slice(0, 300)}` };
  return { problems: lines.map((l) => `website generated partial ${l.trim()} (the Docs workflow's gen-check job fails on main)`), unconsultable: null };
}

/**
 * Is the PREVIOUS release stranded? scripts/release-drift.mjs owns the
 * classification (two real incidents are recorded there); this gathers the same
 * facts and asks it. A new release cut on top of a stranded one skips a version
 * on npm entirely, which is why this is a blocker rather than a note.
 */
export function releaseDriftProbe({ run = execFileSync, classify, manifestVersion, now = Date.now }) {
  if (typeof classify !== 'function') return { problems: [], unconsultable: 'scripts/release-drift.mjs could not be loaded' };
  const latest = tryRun('npm', ['view', PACKAGE_NAME, 'dist-tags.latest'], { run });
  const tags = tryRun('git', ['tag', '-l'], { run });
  const ts = tryRun('git', ['log', '-1', '--format=%ct', '--', 'package.json'], { run });
  const tagList = tags.ok && tags.out ? tags.out.split('\n').filter(Boolean) : [];
  let runStatus = null;
  let runConclusion = null;
  if (tagList.includes(`v${manifestVersion}`)) {
    const repo = tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { run });
    if (repo.ok && repo.out) {
      const q = tryRun('gh', ['api', `repos/${repo.out}/actions/runs?event=push&per_page=50`, '--jq',
        `[.workflow_runs[] | select(.head_branch=="v${manifestVersion}")][0] | {status, conclusion}`], { run });
      if (q.ok && q.out && q.out !== 'null') {
        try { const p = JSON.parse(q.out); runStatus = p.status ?? null; runConclusion = p.conclusion ?? null; } catch { /* stays null: reported as no-run, the loud direction */ }
      }
    }
  }
  const result = classify({
    manifestVersion,
    npmLatest: latest.ok ? latest.out : null,
    tags: tagList,
    runStatus,
    runConclusion,
    bumpAgeMinutes: ts.ok && ts.out ? (now() / 1000 - Number(ts.out)) / 60 : null,
  });
  if (result.status === 'undetermined') return { problems: [], unconsultable: result.message };
  return { problems: result.ok ? [] : [`${result.status}: ${result.message}`], unconsultable: null, status: result.status };
}

/** shellcheck over the two POSIX launchers, as CI runs it; absent shellcheck is unconsultable. */
export function shellcheckProbe({ run = execFileSync, root = ROOT }) {
  const present = tryRun('shellcheck', ['--version'], { run, cwd: root });
  if (!present.ok) return { problems: [], unconsultable: 'shellcheck is not installed, so bin/*.sh were not linted' };
  const r = tryRun('shellcheck', ['-s', 'sh', 'bin/node-launcher.sh', 'bin/hook-runner.sh'], { run, cwd: root });
  if (r.ok) return { problems: [], unconsultable: null };
  return { problems: [`shellcheck: ${r.out.slice(0, 800)}`], unconsultable: null };
}

/**
 * The cheap mechanical baseline, run synchronously before the agents fan out.
 * Every probe either answers or is named in `unconsultable`.
 */
export async function probes({
  root = ROOT,
  run = execFileSync,
  readFile = readFileSync,
  exists = existsSync,
  skipBuild = false,
  loadBridge = () => import('../lib/adlc-bridge.mjs'),
  loadDigests = () => import('./update-adlc-digests.mjs'),
  loadDrift = () => import('./release-drift.mjs'),
  now = Date.now,
} = {}) {
  const out = { unconsultable: [], bundleRebuilt: false };
  const readJson = (p) => { try { return JSON.parse(readFile(join(root, p), 'utf8')); } catch { return null; } };

  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { run, cwd: root });
  const status = tryRun('git', ['status', '--porcelain'], { run, cwd: root });
  const head = tryRun('git', ['rev-parse', 'HEAD'], { run, cwd: root });
  const originMain = tryRun('git', ['rev-parse', 'origin/main'], { run, cwd: root });
  out.git = {
    branch: branch.ok ? branch.out : null,
    clean: status.ok ? status.out === '' : null,
    dirtyPaths: status.ok && status.out ? status.out.split('\n').slice(0, 40) : [],
    head: head.ok ? head.out : null,
    originMain: originMain.ok ? originMain.out : null,
    syncedWithOriginMain: head.ok && originMain.ok ? head.out === originMain.out : null,
  };

  const pkg = readJson('package.json');
  const plugin = readJson('plugin.json');
  const lock = readJson('package-lock.json');
  if (!pkg || !plugin || !lock) {
    out.unconsultable.push('package.json, plugin.json or package-lock.json could not be parsed; lockstep and tarball probes skipped');
    out.lockstep = [];
    out.vendoredTarball = [];
  } else {
    out.lockstep = lockstepProblems({ pkg, plugin, lock });
    out.vendoredTarball = tarballProblems({ pkg, lock, root, readFile, exists });
  }

  try {
    const [bridge, digests] = await Promise.all([loadBridge(), loadDigests()]);
    out.vendoredDigests = vendoredDigestProblems({
      computed: digests.computeVendoredDigests(join(root, 'vendor', 'adlc')),
      known: bridge.KNOWN_VENDORED_ADLC,
    });
  } catch (err) {
    out.vendoredDigests = [];
    out.unconsultable.push(`vendored adlc digests: ${err.message}`);
  }

  const drift = bundleDriftProbe({ run, root, clean: out.git.clean, skip: skipBuild });
  out.bundleDrift = drift.problems;
  out.bundleRebuilt = drift.rebuilt;
  if (drift.unconsultable) out.unconsultable.push(`bundle drift: ${drift.unconsultable}`);

  const site = websiteGenProbe({ run, root, exists });
  out.websiteGen = site.problems;
  if (site.unconsultable) out.unconsultable.push(`website partials: ${site.unconsultable}`);

  let classify = null;
  try { classify = (await loadDrift()).classifyDrift; } catch (err) { out.unconsultable.push(`release drift: ${err.message}`); }
  const rd = releaseDriftProbe({ run, classify, manifestVersion: pkg?.version ?? null, now });
  out.releaseDrift = rd.problems;
  if (rd.unconsultable) out.unconsultable.push(`release drift: ${rd.unconsultable}`);

  const sc = shellcheckProbe({ run, root });
  out.shellcheck = sc.problems;
  if (sc.unconsultable) out.unconsultable.push(`shellcheck: ${sc.unconsultable}`);

  return out;
}

// ─── assembly ────────────────────────────────────────────────────────────────

/** Assemble the audit input document. Pure, so the whole shape is assertable without a repo. */
export function assemble({ version, since, units, issues, routed, probeResults, churn, issuesUnconsultable, issuesTruncated = null }) {
  return {
    schema: 'release-audit-input/booster-1',
    package: PACKAGE_NAME,
    version,
    since,
    unitCount: units.length,
    units: units.map((u) => ({
      ...u,
      churn: churn.get(u.id) ?? null,
      issues: routed.byUnit.get(u.id) ?? [],
    })),
    issues: {
      open: issues.length,
      routed: [...routed.byUnit.values()].reduce((n, list) => n + list.length, 0),
      unmapped: routed.unmapped,
      escalated: routed.escalated,
      sweepBatches: sweepBatches(routed.unmapped, routed.escalated),
      unconsultable: issuesUnconsultable,
      truncated: issuesTruncated,
    },
    probes: probeResults,
  };
}

/**
 * The subset of the collected document the workflow script actually reads.
 * Anything the workflow reads must appear here — a field dropped from this
 * projection becomes `undefined` inside a prompt, which renders as the literal
 * string "undefined" rather than failing. A test asserts the two agree.
 */
export function workflowArgs(doc) {
  const slimIssue = ({ excerpt, ...rest }) => rest;
  const probeList = (k) => doc.probes?.[k] ?? [];
  return {
    package: doc.package ?? PACKAGE_NAME,
    version: doc.version,
    currentVersion: doc.currentVersion,
    since: doc.since,
    filtered: doc.filtered === true,
    units: (doc.units ?? []).map((u) => ({
      id: u.id, kind: u.kind, label: u.label, paths: u.paths, rails: u.rails, missingPaths: u.missingPaths,
      fileCount: u.fileCount, bytes: u.bytes, churn: u.churn,
      issues: (u.issues ?? []).map(slimIssue),
    })),
    issues: { sweepBatches: (doc.issues?.sweepBatches ?? [[]]).map((b) => b.map(slimIssue)) },
    probes: {
      lockstep: probeList('lockstep'),
      vendoredDigests: probeList('vendoredDigests'),
      vendoredTarball: probeList('vendoredTarball'),
      bundleDrift: probeList('bundleDrift'),
      websiteGen: probeList('websiteGen'),
      releaseDrift: probeList('releaseDrift'),
      shellcheck: probeList('shellcheck'),
      unconsultable: doc.probes?.unconsultable ?? [],
    },
  };
}

export async function collectMain(argv = process.argv.slice(2), deps = {}) {
  const { root = ROOT, readFile = readFileSync, log = console.log } = deps;
  const args = parseArgs(argv);

  const rootPkg = JSON.parse(readFile(join(root, 'package.json'), 'utf8'));
  const currentVersion = rootPkg.version;
  const version = args.version ?? nextMinor(currentVersion);
  const since = args.since ?? newestVersionTag(deps);

  // Discover EVERY unit, then narrow. Routing must see the whole repository even
  // when the run does not: filtering first would make an issue that names two
  // surfaces look unambiguous once only one of them is left standing.
  const allUnits = discoverUnits({ root, ...deps });
  const units = args.units
    ? allUnits.filter((u) => {
      const wanted = new Set(args.units.map((n) => (n.startsWith('surface:') ? n : `surface:${n}`)));
      return wanted.has(u.id);
    })
    : allUnits;

  const churn = new Map(units.map((u) => [u.id, churnFor(u.paths, since, deps)]));
  const { issues, unconsultable: issuesUnconsultable, truncated: issuesTruncated } = fetchIssues({ ...deps, skip: args.skipIssues });
  const routed = routeIssues(issues, allUnits, ticketsByIssueNumber({ root, ...deps }));
  const probeResults = await probes({ root, skipBuild: args.skipBuild, ...deps });

  const doc = assemble({ version, since, units, issues, routed, probeResults, churn, issuesUnconsultable, issuesTruncated });
  doc.currentVersion = currentVersion;
  doc.filtered = Boolean(args.units);
  log(JSON.stringify(args.workflowArgs ? workflowArgs(doc) : doc, null, 2));
  return 0;
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(await collectMain());
