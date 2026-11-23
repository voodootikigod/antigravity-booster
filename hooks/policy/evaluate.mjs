// PreToolUse policy evaluation (spec §4.5.1 pipeline as amended by Appendix A).
//
// evaluatePayload(payload, options) -> { decision: 'deny'|'ask'|'pass', reason? }
// Pure apart from filesystem reads of the target repos' ticket stores.
//
// File and MCP tools are the EXACT layer (owner decision 2026-10-05): every
// path they name is resolved physically and judged against rails, the ADLC
// trust root and the platform's protected roots, failing closed.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketFilename, validateTicket } from '@adlc/tickets';
import { findAdlcRoot, resolveTicket, unionActiveRails } from '../../lib/active-rails.mjs';
import {
  AGY_CONTROL_TOOLS, BOOSTER_MCP_SERVER, BOOSTER_MCP_SERVERS, BOOSTER_MCP_TOOLS, CODEGRAPH_READ_TOOLS,
  EXCLUDED_CONTENT_KEYS, NOTEBOOK_EXEC_TOOLS, ORCHESTRATION_TOOLS, PATH_MUTATING_TOOLS, PURE_READERS, READONLY_BOOSTER_CONTROL_ACTIONS,
  READ_ONLY_TOOLS, READ_TOOL_PATH_SCHEMAS, REQUIRED_READ_PATH_KEYS, SED_ALLOWED_KEYS, STDIN_TOOLS,
  SUBAGENT_PROSE_KEYS, SUBAGENT_TOOLS, SWARM_META_KEYS, SWARM_PROSE_KEYS, SWARM_WORKSPACE_MODES,
  TICKET_STORE_DIR, TOOL_PATH_SCHEMAS, WORKFLOW_PROSE_KEYS, WORKFLOW_TOOLS,
} from './constants.mjs';
import {
  beginEvaluation, boosterDataRoots, brainRoots, hasHomePrefix, headlessProtectedMatcher, isAllowedBrainArtifactTarget,
  isBenignProcRead, isWithin, matchDeclaredRail, matchImplicitRail, matchRoot, matchesScope, physicalResolve,
  protectedRoots, repoRelative, resolveCandidate, verifyBrainArtifactDirectory,
} from './paths.mjs';
import { classifyRunCommand } from './shell.mjs';
import { lexCommandLine } from './shell-lexer.mjs';
import { ask, deny, mostRestrictive, PASS } from './verdict.mjs';

const UNEXPECTED_PATH = /[/\\]|\.(mjs|js|json)$/;
// Any file: URL (P5 rounds 1, 3, 5). Only an empty or `localhost` authority is a
// local path; anything with a host, userinfo or port cannot be verified.
const FILE_URL = /^file:/i;
const FILE_URL_PARTS = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i;
// Resolves as a process-relative magic path, which mutations always deny.
const UNVERIFIABLE_URL = '/dev/fd/unverifiable-file-url';
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_NODES = 20000;

/**
 * Tools may name targets as file: URLs. Policy evaluates the percent-decoded
 * path WITHOUT URL normalisation — WHATWG URL collapses `..` lexically, but
 * a writer that strips the scheme lets the kernel follow symlinks first
 * (P5 round 5 M2) — with any query or fragment dropped.
 */
function toPath(value) {
  if (!FILE_URL.test(value)) return value;
  const [, authority = '', rawPath = ''] = FILE_URL_PARTS.exec(value) ?? [];
  if (authority !== '' && authority.toLowerCase() !== 'localhost') return UNVERIFIABLE_URL;
  if (!rawPath.startsWith('/')) return UNVERIFIABLE_URL;
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const unique = (xs) => [...new Set(xs)];

/** Repo lookups are cached per evaluation: the ticket store is read at most once per repo. */
function makeRepoCache(home, homes) {
  const byRoot = new Map();
  return {
    repoAt(absPath) {
      const root = findAdlcRoot(absPath, { home, homes });
      if (!root) return { adlc: false };
      if (!byRoot.has(root)) {
        const store = unionActiveRails(root);
        byRoot.set(root, { adlc: true, root, store, activeRail: !store.ok || store.rails.length > 0 });
      }
      return byRoot.get(root);
    },
    knownRepos: () => [...byRoot.values()],
  };
}

function matchDirectBoosterMcpPrefix(name) {
  for (const server of BOOSTER_MCP_SERVERS) {
    for (const prefix of [`mcp__${server}__`, `mcp_${server}_`]) {
      if (name.startsWith(prefix)) {
        const tool = name.slice(prefix.length);
        if (BOOSTER_MCP_TOOLS.has(tool)) return tool;
      }
    }
  }
  return null;
}

export function isBoosterMcpTool(name, args) {
  if (name === 'call_mcp_tool') {
    const norm = normalizeArgsCaseInsensitive(args);
    if (!norm.ok) return false;
    return BOOSTER_MCP_SERVERS.has(norm.folded.servername) && BOOSTER_MCP_TOOLS.has(norm.folded.toolname);
  }
  return matchDirectBoosterMcpPrefix(name) !== null;
}

function boosterMcpToolName(name, args) {
  if (name === 'call_mcp_tool') {
    const norm = normalizeArgsCaseInsensitive(args);
    return norm.ok ? norm.folded.toolname : undefined;
  }
  return matchDirectBoosterMcpPrefix(name) ?? name.slice(`mcp__${BOOSTER_MCP_SERVER}__`.length);
}

/** Probed-schema path extraction for file-mutating tools (§4.5.1). */
const FOLDED_EXCLUDED_CONTENT_KEYS = new Set([...EXCLUDED_CONTENT_KEYS].map((k) => String(k).toLowerCase()));

/** Mirrors Go's strings.EqualFold simple folding for the runes that fold into ASCII. */
export function goFoldKey(k) {
  return String(k).replace(/\u017f/g, 's').replace(/\u212a/g, 'k').toLowerCase();
}

/**
 * Case-insensitive argument view matching the host's Go decoder: only plain
 * objects with printable-ASCII keys that stay unique under folding are accepted.
 */
export function normalizeArgsCaseInsensitive(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: 'Tool arguments must be a plain JSON object' };
  }
  const keys = Object.keys(args);
  for (const k of keys) {
    if (!/^[\x20-\x7E]+$/.test(k)) return { ok: false, reason: 'Non-ASCII or control character in tool argument key' };
  }
  const folded = Object.create(null);
  for (const k of keys) {
    const fk = goFoldKey(k);
    if (fk in folded) return { ok: false, reason: 'Duplicate case-folded argument key' };
    folded[fk] = args[k];
  }
  return { ok: true, folded, raw: args };
}

export function extractProbedPaths(toolName, args) {
  const schema = TOOL_PATH_SCHEMAS[toolName];
  if (!schema) return null;
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return { error: norm.reason };
  const folded = norm.folded;
  const get = (k) => folded[goFoldKey(k)];
  const isPresent = (k) => get(k) !== undefined && get(k) !== null && String(get(k)).trim().length > 0;
  const hasReq = schema.required.some(isPresent);
  const hasAlt = Array.isArray(schema.altRequired) && schema.altRequired.some(isPresent);
  if (hasReq && hasAlt) {
    return { error: `Conflicting path parameters in mutating tool call: ${schema.required.join(', ')} and ${schema.altRequired.join(', ')}` };
  }
  const activeKeys = (!hasReq && hasAlt) ? schema.altRequired : schema.required;
  const activeFolded = new Set(activeKeys.map(goFoldKey));
  const inactiveFolded = new Set([...schema.required, ...(schema.altRequired ?? [])].map(goFoldKey).filter((k) => !activeFolded.has(k)));
  const paths = [];
  for (const key of activeKeys) {
    const val = get(key);
    if (typeof val !== 'string' || val.trim().length === 0) return { error: `Missing required path parameter: ${key}` };
    paths.push(val);
  }
  for (const [fk, val] of Object.entries(folded)) {
    if (activeFolded.has(fk) || FOLDED_EXCLUDED_CONTENT_KEYS.has(fk)) continue;
    if (inactiveFolded.has(fk) && val !== undefined && val !== null) return { error: `Unexpected path parameter in mutating tool call: ${fk}` };
    if (typeof val === 'string' && UNEXPECTED_PATH.test(val)) return { error: `Unexpected path parameter in mutating tool call: ${fk}` };
  }
  return { paths };
}

const looksLikePath = (s) => isAbsolute(s) || hasHomePrefix(s) || s.includes('/') || s.includes('\\') || s.startsWith('.') || FILE_URL.test(s);

function isAllowedTopLevelProse(key, item, topLevelSkipKeys) {
  if (!topLevelSkipKeys || !topLevelSkipKeys.has(key)) return false;
  if (key === 'tasks') return Array.isArray(item) && item.every((x) => typeof x === 'string');
  return typeof item === 'string';
}

/**
 * A.6 item 9: every string (and object key) that looks like a path, anywhere
 * in the arguments, iteratively and with depth/size limits so hostile nesting
 * cannot crash the evaluator (P5 round 3 F1). `skipContentKeys` drops the
 * free-text keys of file tools; MCP and unknown tools get no such exemption.
 * `topLevelSkipKeys` drops verified top-level prose fields (e.g. `swarm.brief`,
 * `run_workflow.Script`) without exempting nested user-supplied dictionaries.
 */
function scanPathLike(value, {
  skipContentKeys = false,
  topLevelSkipKeys = null,
  topLevelBareSkipKeys = null,
  includeBareTokens = false,
} = {}) {
  const paths = [];
  const bareTokens = [];
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value: v, depth, skipBare } = stack.pop();
    nodes += 1;
    if (depth > MAX_SCAN_DEPTH || nodes > MAX_SCAN_NODES) return { paths, bareTokens, overflow: true };
    if (typeof v === 'string') {
      if (looksLikePath(v)) paths.push(toPath(v));
      else if (includeBareTokens && !skipBare && v.trim().length > 0 && v.length <= 255) {
        bareTokens.push(v.trim());
      }
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push({ value: item, depth: depth + 1, skipBare: false });
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (skipContentKeys && EXCLUDED_CONTENT_KEYS.has(k)) continue;
        if (depth === 0 && isAllowedTopLevelProse(k, item, topLevelSkipKeys)) continue;
        if (looksLikePath(k)) paths.push(toPath(k));
        const nextSkipBare = depth === 0 && Boolean(topLevelBareSkipKeys?.has(k));
        stack.push({ value: item, depth: depth + 1, skipBare: nextSkipBare });
      }
    }
  }
  return { paths, bareTokens, overflow: false };
}

const OVERFLOW = deny('Tool arguments are nested too deeply or are too large to verify');

function readToolPaths(name, norm) {
  const keys = READ_TOOL_PATH_SCHEMAS[name] ?? [];
  return keys.map((k) => norm.folded[goFoldKey(k)]).filter((v) => typeof v === 'string' && v.length > 0).map(toPath);
}

const READ_STRING_KEYS = ['toolaction', 'toolsummary'];
const READ_EXTRA_STRING_KEYS = { search_in_file: ['pattern', 'query'], read_browser_page: ['pageid'] };
const READ_PATH_PARAM_ERROR = 'Invalid read-tool path parameter';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Path extraction and argument-shape validation for read tools that require a path. */
export function extractReadToolPaths(name, rawArgs) {
  const norm = normalizeArgsCaseInsensitive(rawArgs);
  if (!norm.ok) return { ok: false, reason: norm.reason };
  const pathKeys = REQUIRED_READ_PATH_KEYS[name];
  const extractedPaths = [];
  for (const k of pathKeys) {
    const val = norm.folded[k];
    if (val === undefined) continue;
    if (k === 'paths') {
      if (isNonEmptyString(val)) extractedPaths.push(val);
      else if (Array.isArray(val) && val.length > 0 && val.every(isNonEmptyString)) extractedPaths.push(...val);
      else return { ok: false, reason: READ_PATH_PARAM_ERROR };
    } else if (isNonEmptyString(val)) {
      extractedPaths.push(val);
    } else {
      return { ok: false, reason: READ_PATH_PARAM_ERROR };
    }
  }
  if (extractedPaths.length < 1) return { ok: false, reason: 'Missing required read-tool path parameter' };
  const stringKeys = new Set([...READ_STRING_KEYS, ...(READ_EXTRA_STRING_KEYS[name] ?? [])]);
  for (const [k, val] of Object.entries(norm.folded)) {
    if (pathKeys.includes(k)) continue;
    if (stringKeys.has(k)) {
      if (typeof val !== 'string' && val !== undefined) return { ok: false, reason: 'Unexpected non-scalar or unapproved string argument on read tool' };
      continue;
    }
    if (val === undefined) continue;
    if (typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val))) continue;
    return { ok: false, reason: 'Unexpected non-scalar or unapproved string argument on read tool' };
  }
  return { ok: true, paths: extractedPaths.map(toPath) };
}

/**
 * Every physical path a token can denote. Absolute and home-relative tokens
 * have one; a relative token is resolved against EVERY anchor (Cwd and each
 * workspace path), because the caller chooses the anchor (P5 round 3 M5).
 * No anchor at all yields [] — callers fail closed.
 */
function resolveAll(token, ctx) {
  if (hasHomePrefix(token)) {
    const homes = ctx.homes ?? [ctx.home];
    return homes.map((h) => resolveCandidate(token, '/', h, ctx.platform));
  }
  if (isAbsolute(token)) return [resolveCandidate(token, '/', ctx.home, ctx.platform)];
  return ctx.anchors.map((anchor) => resolveCandidate(token, anchor, ctx.home, ctx.platform));
}

const DEFAULT_SUBTREE_ENTRIES = 50000;
const SUBTREE_SKIP = new Set(['node_modules', '.git']);

/**
 * Does an existing directory hold any `.adlc` below it (P5 rounds 4–5)?
 * Bounded BFS that never descends through symlinks, but counts a SYMLINK named
 * `.adlc` as a hit (findAdlcRoot follows it). Answers true, false,
 * 'unreadable' (a subdirectory hides its contents) or 'too-large'.
 * node_modules/ and .git/ are not scanned (documented residual).
 */
function subtreeHoldsAdlc(dir, limit) {
  const queue = [dir];
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      return 'unreadable';
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > limit) return 'too-large';
      if (entry.name === '.adlc' && (entry.isDirectory() || entry.isSymbolicLink())) return true;
      if (entry.isDirectory() && !SUBTREE_SKIP.has(entry.name)) queue.push(join(current, entry.name));
    }
  }
  return false;
}

function isExistingDirectory(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A directory operation on a path that CONTAINS an ADLC repo or a protected root (P5 rounds 3–4). */
function containsProtected(r, ctx) {
  if (ctx.headless) {
    const isBoosterDir = (p) => /(?:^|[\\/])\.booster$/i.test(p);
    if (
      isBoosterDir(r.real) ||
      isBoosterDir(r.lexical) ||
      (ctx.tmpRoots ?? []).some((t) => isWithin(t, r.real, ctx.platform) || isWithin(t, r.lexical, ctx.platform))
    ) {
      return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
    }
  }
  if (ctx.protectedRoots.some((root) => isWithin(root, r.real, ctx.platform) || isWithin(root, r.lexical, ctx.platform))) {
    return deny('Target path contains platform configuration, plugins, or Node runtimes');
  }
  for (const w of ctx.workspacePaths) {
    const repo = ctx.repoAt(w);
    if (!repo.adlc) continue;
    const repoReal = realOr(repo.root);
    if ((repoReal !== r.real && isWithin(repoReal, r.real, ctx.platform)) ||
        (repo.root !== r.lexical && isWithin(repo.root, r.lexical, ctx.platform))) {
      return deny('Target path contains an ADLC repository');
    }
  }
  if (isExistingDirectory(r.real)) {
    const holds = subtreeHoldsAdlc(r.real, ctx.limits.subtreeEntries);
    if (holds === true) return deny('Target directory contains an ADLC repository (.adlc/)');
    if (holds === 'unreadable') return deny('Target directory has unreadable subdirectories; cannot verify it holds no ADLC repository');
    if (holds === 'too-large') {
      const reason = 'Target directory is too large to verify that it holds no ADLC repository';
      return ctx.headless ? deny(reason) : ask(reason);
    }
  }
  return null;
}

const SHARD_WRITERS = new Set(['write_to_file', 'write_file', 'create_file', 'save_file']);
const SHARD_CONTENT_KEYS = ['codecontent', 'content'];

/**
 * A new ticket shard must be a schema-valid ticket written to its canonical
 * file, `ticketFilename(id)`, by a whole-file writer, and EVERY content field
 * must agree. Anything else would make the store unloadable and freeze every
 * later tool call (P5 rounds 4–5). Case folds on darwin.
 */
function newShardVerdict(name, rel, args, platform) {
  const folded = (platform === 'darwin' || platform === 'win32') ? rel.toLowerCase() : rel;
  if (!folded.startsWith(`${TICKET_STORE_DIR}/`)) return null;
  const reason = 'A new ticket shard must be a schema-valid ticket written whole to its canonical <id>--<sha256(id)>.json file';
  if (!SHARD_WRITERS.has(name)) return deny(reason);
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  const present = SHARD_CONTENT_KEYS.filter((k) => norm.folded[k] !== undefined);
  if (present.length === 0) return deny(reason);
  for (const key of present) {
    if (typeof norm.folded[key] !== 'string') return deny(reason);
    let ticket;
    try {
      ticket = JSON.parse(norm.folded[key]);
    } catch {
      return deny(reason);
    }
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return deny(reason);
    if (validateTicket(ticket).length > 0 || ticketFilename(ticket.id) !== basename(rel)) return deny(reason);
  }
  return null;
}

/** Gate 1 for one resolved path: store overrides, implicit rails, shards, declared rails. */
function gateOnePath(resolved, ctx, { rootIsTarget = true } = {}) {
  if (resolved.unresolved) return { verdict: deny('Target path cannot be resolved (symlink loop or oversized path)'), repo: { adlc: false } };
  if (ctx.storeOverrides.some((store) => isWithin(resolved.real, store, ctx.platform) || isWithin(store, resolved.real, ctx.platform))) {
    return { verdict: deny('Target path is (or contains) the configured ADLC ticket store'), repo: { adlc: false } };
  }
  const repo = ctx.repoAt(resolved.real);
  if (!repo.adlc) return { verdict: PASS, repo };
  if (!repo.store.ok) return { verdict: deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified'), repo };
  const rel = repoRelative(resolved.real, repo.root);
  if (rel === null) return { verdict: deny('Target path sits outside repository root'), repo };
  if (rel === '') {
    // The repository root itself holds the trust root: a mutation there is never routine.
    return rootIsTarget ? { verdict: deny('Target path is an ADLC repository root, which holds frozen trust-root state'), repo, rel } : { verdict: PASS, repo, rel };
  }
  const implicit = matchImplicitRail(rel, repo.root, ctx.platform);
  if (implicit) return { verdict: deny(`Target path matches standing ADLC implicit rail: ${implicit}`), repo, rel };
  if (repo.activeRail) {
    const rail = matchDeclaredRail(rel, repo.store.rails, ctx.platform);
    if (rail) return { verdict: deny(`Target path matches frozen rail: ${rail}`), repo, rel };
  }
  return { verdict: PASS, repo, rel };
}

function workerScopeVerdict(repo, rel, ctx) {
  const found = resolveTicket(repo.root, ctx.workerTicket);
  if (!found.ok) return deny(`Headless worker ticket ${ctx.workerTicket} cannot be resolved (${found.error}); mutations denied`);
  const scope = Array.isArray(found.ticket.scope) ? found.ticket.scope : [];
  if (!matchesScope(rel, scope, ctx.platform)) {
    return deny(`Headless worker for ticket ${ctx.workerTicket} attempted mutation outside declared ticket scope: ${rel}`);
  }
  return PASS;
}

const SEND_MESSAGE_PROSE_KEYS = new Set(['Message', 'message', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary']);

function stepOne(name, args, ctx) {
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  if (name === 'run_command' || STDIN_TOOLS.has(name) || (name === 'manage_task' && norm.folded.action === 'send_input')) {
    return PASS; // shell/stdin tokens are checked by their dedicated classifiers
  }
  const isRead = READ_ONLY_TOOLS.has(name) || Boolean(READ_TOOL_PATH_SCHEMAS[name]);
  let candidates;
  if (isRead) {
    let extra = [];
    if (Object.hasOwn(REQUIRED_READ_PATH_KEYS, name)) {
      const readRes = extractReadToolPaths(name, args);
      if (!readRes.ok) return deny(readRes.reason);
      extra = readRes.paths;
    } else {
      extra = readToolPaths(name, norm);
    }
    const scanned = scanPathLike(args);
    if (scanned.overflow) return OVERFLOW;
    candidates = [...extra, ...scanned.paths];
  } else if (name === 'sed_file') {
    const target = norm.folded.target_file ?? norm.folded.targetfile;
    candidates = typeof target === 'string' ? [toPath(target)] : [];
  } else if (NOTEBOOK_EXEC_TOOLS.has(name)) {
    const np = norm.folded.notebookpath ?? norm.folded.absolutepath ?? norm.folded.path;
    candidates = typeof np === 'string' ? [toPath(np)] : [];
  } else if (TOOL_PATH_SCHEMAS[name]) {
    const schemaKeys = [...TOOL_PATH_SCHEMAS[name].required, ...(TOOL_PATH_SCHEMAS[name].altRequired ?? [])];
    candidates = schemaKeys.map((k) => norm.folded[goFoldKey(k)]).filter((v) => typeof v === 'string').map(toPath);
  } else {
    const isSwarm = name === 'swarm';
    const isWorkflow = WORKFLOW_TOOLS.has(name);
    const topLevelSkipKeys = isSwarm
      ? SWARM_PROSE_KEYS
      : isWorkflow
        ? WORKFLOW_PROSE_KEYS
        : SUBAGENT_TOOLS.has(name)
          ? SUBAGENT_PROSE_KEYS
          : name === 'send_message'
            ? SEND_MESSAGE_PROSE_KEYS
            : null;
    const scan = scanPathLike(args, {
      topLevelSkipKeys,
      topLevelBareSkipKeys: isSwarm ? SWARM_META_KEYS : null,
      includeBareTokens: isSwarm || isWorkflow,
    });
    if (scan.overflow) return OVERFLOW;
    candidates = [...scan.paths, ...scan.bareTokens];
    if (isWorkflow) {
      const wfScriptPath = norm.folded.scriptpath;
      if (typeof wfScriptPath === 'string' && wfScriptPath.trim().length > 0) {
        candidates.push(toPath(wfScriptPath.trim()));
      }
      const wfCwd = norm.folded.cwd;
      if (typeof wfCwd === 'string' && wfCwd.trim().length > 0) {
        candidates.push(toPath(wfCwd.trim()));
      }
    }
  }
  let stepCtx = ctx;
  const wfCwdArg = norm.folded.cwd;
  if (WORKFLOW_TOOLS.has(name) && typeof wfCwdArg === 'string' && wfCwdArg.trim().length > 0) {
    const wfCwdPhys = physicalResolve(wfCwdArg, ctx.workspacePaths[0] || '/', ctx.platform);
    if (wfCwdPhys) stepCtx = { ...ctx, anchors: unique([wfCwdPhys, ...ctx.anchors]) };
  }
  const isListDir = name === 'list_dir' || name === 'list_directory';
  for (const token of candidates) {
    for (const r of resolveAll(token, stepCtx)) {
      if (matchRoot(r, ctx.boosterDataRoots, ctx.platform)) {
        return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
      }
      if (r.unresolved && !(isRead && isBenignProcRead(token, r))) {
        return deny('Target path cannot be resolved (symlink loop or oversized path)');
      }
      if (matchRoot(r, ctx.brainRoots, ctx.platform)) {
        if (!isRead) {
          if (!isAllowedBrainArtifactTarget(token, r, ctx.verifiedBrainArtifact, { allowExactDir: false, allowSystemGeneratedRead: false, platform: ctx.platform })) {
            return deny('Access to Antigravity brain directory outside the active verified session artifact directory (or inside .system_generated) is forbidden');
          }
          continue;
        }
        // Interactive read: when session metadata is supplied, enforce active-conversation isolation + symlink safety while permitting own .system_generated transcripts
        if (ctx.hasBrainMetadata) {
          if (!isAllowedBrainArtifactTarget(token, r, ctx.verifiedBrainArtifact, { allowExactDir: isListDir, allowSystemGeneratedRead: true, platform: ctx.platform })) {
            return deny('Access to another Antigravity conversation brain directory or symlinked brain target is forbidden');
          }
        } else if (r.lexical !== r.real) {
          return deny('Access to symlinked Antigravity brain path is forbidden');
        }
        continue;
      }
      if (!isRead && matchRoot(r, ctx.protectedRoots, ctx.platform)) {
        return deny('Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden');
      }
    }
  }
  return PASS;
}

/**
 * A schema-violating call is judged by every path it could touch, not by the
 * caller-controllable anchor (P5 H3, Appendix A.6 item 8): deny when any
 * candidate lands in an ADLC repository or a protected root.
 */
function schemaViolationVerdict(name, args, reason, ctx) {
  if (ctx.readonly) return deny(reason);
  const schemaKeys = [...(TOOL_PATH_SCHEMAS[name]?.required ?? []), ...(TOOL_PATH_SCHEMAS[name]?.altRequired ?? [])];
  const required = schemaKeys.map((k) => args?.[k]).filter((v) => typeof v === 'string' && v.length > 0).map(toPath);
  const scan = scanPathLike(args, { skipContentKeys: true });
  if (scan.overflow) return OVERFLOW;
  if (ctx.anchors.some((a) => {
    const repo = ctx.repoAt(a);
    return repo.adlc && (repo.activeRail || ctx.workerTicket);
  })) return deny(reason);
  for (const token of [...required, ...scan.paths]) {
    const resolved = resolveAll(token, ctx);
    if (resolved.length === 0) return deny(reason);
    for (const r of resolved) {
      if (matchRoot(r, ctx.protectedRoots, ctx.platform) || ctx.repoAt(r.real).adlc) return deny(reason);
    }
  }
  return PASS;
}

function evaluateOneTargetForm(target, name, args, ctx, workerRepos) {
  const { verdict, repo, rel } = gateOnePath(target, ctx);
  if (verdict.decision !== 'pass') return verdict;
  if (repo.adlc && rel) {
    const shard = newShardVerdict(name, rel, args, ctx.platform);
    if (shard) return shard;
  }
  // A worker may write only inside its own ADLC repo's ticket scope, and never
  // into an ADLC repo that is not its own (P5 rounds 3–5).
  const repoRealRoot = repo.adlc ? realOr(repo.root) : null;
  if (ctx.workerTicket && repo.adlc && !workerRepos.some((w) => realOr(w.root) === repoRealRoot)) {
    return deny(`Headless worker for ticket ${ctx.workerTicket} attempted mutation in another ADLC repository: ${target.real}`);
  } else if (workerRepos.length > 0) {
    if (!repo.adlc || !workerRepos.some((w) => realOr(w.root) === repoRealRoot)) {
      return deny(`Headless worker for ticket ${ctx.workerTicket} attempted mutation outside its repository: ${target.real}`);
    }
    return workerScopeVerdict(repo, rel, ctx);
  }
  return PASS;
}

const SED_DELETE_RE = /^(?:[1-9]\d*|\$)(?:,(?:[1-9]\d*|\$))?d$/;
const SED_SUB_HEAD_RE = /^(?:(?:[1-9]\d*|\$)(?:,(?:[1-9]\d*|\$))?)?s([/|])(.*)$/;
const SED_ODD_TRAILING_BS_RE = /(?:^|[^\\])(?:\\\\)*\\$/;
const SED_FLAGS_RE = /^(?:g|[1-9]\d*|p|I|i|m|M)*$/;

/**
 * Validates the 2-production bracket/backref-free sed_file expression subset (§3.4).
 */
export function validateSedCall(expressions) {
  if (!Array.isArray(expressions) || expressions.length === 0 || expressions.length > 128) {
    return { ok: false, reason: 'sed_file expressions must be a non-empty bounded array' };
  }
  for (const expr of expressions) {
    if (typeof expr !== 'string' || !expr || expr.length > 1024 || /[\0\r\n]/.test(expr)) {
      return { ok: false, reason: 'Invalid sed_file expression string' };
    }
    if (SED_DELETE_RE.test(expr)) continue;
    const head = SED_SUB_HEAD_RE.exec(expr);
    if (!head) return { ok: false, reason: 'Disallowed sed_file command' };
    const delim = head[1];
    const parts = head[2].split(delim);
    if (parts.length !== 3) return { ok: false, reason: 'Unbalanced or escaped delimiter in sed_file substitution' };
    const [pattern, replacement, flags] = parts;
    if (pattern.length < 1 || pattern.length > 256 || replacement.length > 512) {
      return { ok: false, reason: 'sed_file pattern or replacement exceeds length bounds' };
    }
    if (/[\[\]]/.test(pattern) || /\\[1-9]/.test(pattern)) {
      return { ok: false, reason: 'Bracket expressions and backreferences are forbidden in sed_file' };
    }
    if (SED_ODD_TRAILING_BS_RE.test(pattern) || SED_ODD_TRAILING_BS_RE.test(replacement)) {
      return { ok: false, reason: 'Trailing odd backslash before delimiter in sed_file' };
    }
    if (!SED_FLAGS_RE.test(flags)) {
      return { ok: false, reason: 'Disallowed sed_file substitution flag' };
    }
  }
  return { ok: true };
}

export function evaluateSedFile(rawArgs, ctx) {
  const norm = normalizeArgsCaseInsensitive(rawArgs);
  if (!norm.ok) return deny(norm.reason);
  if (ctx.readonly) return deny('Mutating tool sed_file denied in read-only worker session');
  for (const k of Object.keys(norm.folded)) {
    if (!SED_ALLOWED_KEYS.has(k)) return deny(`Unexpected argument in sed_file: ${k}`);
  }
  if ('target_file' in norm.folded && 'targetfile' in norm.folded) {
    return deny('Conflicting target_file parameters in sed_file');
  }
  if ('file_content' in norm.folded && 'filecontent' in norm.folded) {
    return deny('Conflicting file_content parameters in sed_file');
  }
  const fc = norm.folded.file_content !== undefined ? norm.folded.file_content : norm.folded.filecontent;
  if (fc !== undefined && fc !== null && (typeof fc !== 'object' || Array.isArray(fc) || Object.keys(fc).length > 0)) {
    return deny('Non-empty file_content is forbidden in sed_file');
  }
  const target = norm.folded.target_file ?? norm.folded.targetfile;
  if (!isNonEmptyString(target)) return deny('Missing required target_file parameter in sed_file');
  const sedCheck = validateSedCall(norm.folded.expressions);
  if (!sedCheck.ok) return deny(sedCheck.reason);
  const v = evaluateFileTool('write_to_file', { TargetFile: target }, ctx);
  return v.decision === 'ask' ? deny(v.reason) : v;
}

const NOTEBOOK_EXEC_ALLOWED_KEYS = new Set(['notebookpath', 'absolutepath', 'path', 'cellids', 'toolaction', 'toolsummary']);
const NOTEBOOK_EXEC_PATH_KEYS = ['notebookpath', 'absolutepath', 'path'];

export function evaluateNotebookExecution(rawArgs, ctx) {
  const norm = normalizeArgsCaseInsensitive(rawArgs);
  if (!norm.ok) return deny(norm.reason);
  if (ctx.readonly) return deny('Read-only agb worker session cannot execute notebooks');
  if (ctx.workerTicket) return deny('Headless agb worker session cannot execute notebooks');
  for (const [k, v] of Object.entries(norm.folded)) {
    if (!NOTEBOOK_EXEC_ALLOWED_KEYS.has(k)) return deny(`Unexpected argument in notebook_execution: ${k}`);
    if ((k === 'toolaction' || k === 'toolsummary') && v !== undefined && typeof v !== 'string') {
      return deny(`Invalid ${k} parameter in notebook_execution`);
    }
  }
  const presentPathKeys = NOTEBOOK_EXEC_PATH_KEYS.filter((k) => norm.folded[k] !== undefined);
  if (presentPathKeys.length > 1) return deny('Conflicting notebook path parameters in notebook_execution');
  const np = norm.folded.notebookpath ?? norm.folded.absolutepath ?? norm.folded.path;
  if (!isNonEmptyString(np)) return deny('Missing required NotebookPath parameter in notebook_execution');
  if (norm.folded.cellids !== undefined && (!Array.isArray(norm.folded.cellids) || !norm.folded.cellids.every((x) => typeof x === 'string'))) {
    return deny('Invalid CellIds parameter in notebook_execution');
  }
  const resolved = resolveAll(toPath(np), ctx);
  if (resolved.length === 0) return deny('Relative notebook path has no workspace to anchor it');
  const repos = [...ctx.anchors.map((a) => ctx.repoAt(a))];
  for (const r of resolved) {
    const c = containsProtected(r, ctx);
    if (c) return deny(c.reason);
    const g = gateOnePath(r, ctx);
    repos.push(g.repo);
    if (g.verdict.decision !== 'pass') return deny(g.verdict.reason);
    if (g.repo.adlc && g.rel && newShardVerdict('notebook_execution', g.rel, {}, ctx.platform)) {
      return deny('Target path matches standing ADLC implicit rail: .adlc/tickets/');
    }
    if (r.lexical !== r.real) {
      const lexRes = gateOnePath({ ...r, real: r.lexical }, ctx);
      repos.push(lexRes.repo);
      if (lexRes.verdict.decision !== 'pass') return deny(lexRes.verdict.reason);
    }
  }
  if (repos.some((r) => r.adlc && (r.activeRail || !r.store.ok))) {
    return deny('Notebook execution forbidden while ADLC rails are active or store is unreadable');
  }
  return PASS;
}

function evaluateFileTool(name, args, ctx) {
  const extracted = extractProbedPaths(name, args);
  if (!extracted || extracted.error) {
    const reason = extracted
      ? `Mutating tool argument schema violation: ${extracted.error}`
      : 'Unknown mutating tool in ADLC repository with active frozen rails; cannot verify target path safety';
    return schemaViolationVerdict(name, args, reason, ctx);
  }
  if (ctx.readonly) return deny('Read-only agb worker session: file mutations are forbidden');
  // A worker's repositories come from every anchor; a worker with none fails closed (P5 round 4 M3).
  const workerRepos = ctx.workerTicket ? ctx.anchors.map((a) => ctx.repoAt(a)).filter((r) => r.adlc) : [];
  if (ctx.workerTicket && ctx.anchors.length === 0) return deny('Headless worker has no workspace; mutations denied');
  const verdicts = [];
  for (const token of extracted.paths.map(toPath)) {
    const resolved = resolveAll(token, ctx);
    if (resolved.length === 0) {
      verdicts.push(deny(`Relative target '${token}' has no workspace to anchor it`));
      continue;
    }
    for (const r of resolved) {
      if (r.unresolved) {
        verdicts.push(deny(`Target path '${token}' cannot be resolved (symlink loop or oversized path)`));
        continue;
      }
      if (matchRoot(r, ctx.boosterDataRoots, ctx.platform)) {
        verdicts.push(deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden'));
        continue;
      }
      if (matchRoot(r, ctx.brainRoots, ctx.platform)) {
        if (!isAllowedBrainArtifactTarget(token, r, ctx.verifiedBrainArtifact, { allowExactDir: false, platform: ctx.platform })) {
          verdicts.push(deny('Access to Antigravity brain directory outside the active verified session artifact directory (or inside .system_generated) is forbidden'));
        } else {
          verdicts.push(PASS);
        }
        continue;
      }
      const contains = containsProtected(r, ctx);
      if (contains) {
        verdicts.push(contains);
        continue;
      }
      verdicts.push(evaluateOneTargetForm(r, name, args, ctx, workerRepos));
      if (r.lexical !== r.real) {
        verdicts.push(evaluateOneTargetForm({ ...r, real: r.lexical }, name, args, ctx, workerRepos));
      }
    }
  }
  const finalVerdict = mostRestrictive(verdicts);
  return name === 'notebook_edit' && finalVerdict.decision === 'ask' ? deny(finalVerdict.reason) : finalVerdict;
}

function evaluateMcpTool(name, args, ctx) {
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  const scan = scanPathLike(args);
  if (scan.overflow) return OVERFLOW;
  const verdicts = [];
  const scannedRepos = [];
  for (const token of scan.paths) {
    for (const r of resolveAll(token, ctx)) {
      // An MCP argument that names a repository (e.g. `repo`) is a reference, not a mutation target.
      const { verdict, repo } = gateOnePath(r, ctx, { rootIsTarget: false });
      scannedRepos.push(repo);
      if (verdict.decision === 'deny') verdicts.push(deny(`Target path '${token}' in MCP tool call references frozen rail (${verdict.reason})`));
      if (r.lexical !== r.real) {
        const lexRes = gateOnePath({ ...r, real: r.lexical }, ctx, { rootIsTarget: false });
        scannedRepos.push(lexRes.repo);
        if (lexRes.verdict.decision === 'deny') verdicts.push(deny(`Target path '${token}' in MCP tool call references frozen rail (${lexRes.verdict.reason})`));
      }
    }
  }
  if (verdicts.length) return mostRestrictive(verdicts);
  if (isBoosterMcpTool(name, args)) {
    if (ctx.workerTicket) return deny('Headless agb worker cannot invoke Booster MCP tools');
    const tool = boosterMcpToolName(name, args);
    const hasArguments = norm.folded.arguments !== undefined;
    const hasToolArgs = norm.folded.toolargs !== undefined;
    if (name === 'call_mcp_tool' && hasArguments && hasToolArgs) {
      return deny('Conflicting arguments/toolArgs parameters in call_mcp_tool');
    }
    const rawMcpArgs = name === 'call_mcp_tool' ? (norm.folded.arguments ?? norm.folded.toolargs ?? {}) : (args ?? {});
    const mcpNorm = normalizeArgsCaseInsensitive(rawMcpArgs);
    if (!mcpNorm.ok) return deny(mcpNorm.reason);
    const isMutatingControl =
      tool === 'agb_control' &&
      (typeof mcpNorm.folded.action !== 'string' || !READONLY_BOOSTER_CONTROL_ACTIONS.has(goFoldKey(mcpNorm.folded.action)));
    if (
      ctx.readonly &&
      (
        tool === 'agb_run' ||
        tool === 'agb_plan' ||
        tool === 'agb_init' ||
        tool === 'agb_distill' ||
        isMutatingControl ||
        (tool === 'agb_doctor' && Boolean(mcpNorm.folded.fix)) ||
        (tool === 'agb_shape' && Boolean(mcpNorm.folded.syncbrain))
      )
    ) {
      return deny(`Read-only agb worker session cannot invoke mutating MCP tool: ${tool}`);
    }
    return PASS;
  }
  if (ctx.readonly) return deny('Third-party MCP tool call cannot prompt operator in a read-only agb worker session');
  if (ctx.workerTicket && ctx.anchors.length === 0) return deny('Headless worker has no workspace; tool call denied');
  const repos = [...ctx.anchors.map((a) => ctx.repoAt(a)), ...scannedRepos];
  if (ctx.workerTicket && repos.some((r) => r.adlc)) return deny('Third-party MCP tool call cannot prompt operator in headless worker mode');
  if (repos.some((r) => r.adlc && r.activeRail)) {
    return ctx.headless
      ? deny('Third-party MCP tool call cannot prompt operator in headless worker mode')
      : ask('Third-party MCP tool call in an active-rail ADLC repository requires operator confirmation');
  }
  return PASS;
}

const STDIN_SKIP_KEYS = new Set(['Input', 'input', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary']);
const STDIN_ALLOWED_KEYS = new Set(['commandid', 'input', 'terminate', 'waitms', 'waitmsbeforeasync', 'toolaction', 'toolsummary']);

function extractInputPathTokens(inputText) {
  return inputText
    .split(/[\s'"`(),;[\]{}=]+/)
    .filter(looksLikePath)
    .map(toPath);
}

function scanStdinPaths(rawArgs, ctx, inputText = '') {
  const scan = scanPathLike(rawArgs, { topLevelSkipKeys: STDIN_SKIP_KEYS });
  if (scan.overflow) return OVERFLOW;
  const extraTokens = extractInputPathTokens(inputText);
  for (const token of [...scan.paths, ...extraTokens]) {
    const resolved = resolveAll(token, ctx);
    if (resolved.length === 0) return deny(`Relative path '${token}' has no workspace to anchor it`);
    for (const r of resolved) {
      if (matchRoot(r, ctx.boosterDataRoots, ctx.platform)) {
        return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
      }
      if (matchRoot(r, ctx.brainRoots, ctx.platform)) {
        if (!isAllowedBrainArtifactTarget(token, r, ctx.verifiedBrainArtifact, { allowExactDir: false, platform: ctx.platform })) {
          return deny('Access to Antigravity brain directory outside the active verified session artifact directory (or inside .system_generated) is forbidden');
        }
        continue;
      }
      if (matchRoot(r, ctx.protectedRoots, ctx.platform)) {
        return deny('Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden');
      }
      const { verdict } = gateOnePath(r, ctx, { rootIsTarget: false });
      if (verdict.decision !== 'pass') return deny(verdict.reason);
      if (r.lexical !== r.real) {
        const lexRes = gateOnePath({ ...r, real: r.lexical }, ctx, { rootIsTarget: false });
        if (lexRes.verdict.decision !== 'pass') return deny(lexRes.verdict.reason);
      }
    }
  }
  return null;
}

export function evaluateSendCommandInput(rawArgs, ctx) {
  const norm = normalizeArgsCaseInsensitive(rawArgs);
  if (!norm.ok) return deny(norm.reason);
  if (ctx.headless) return deny('Headless agb worker session cannot use send_command_input');
  for (const [k, v] of Object.entries(norm.folded)) {
    if (!STDIN_ALLOWED_KEYS.has(k)) return deny(`Unexpected argument in send_command_input: ${k}`);
    if (v === undefined) continue;
    if (k === 'commandid' && !isNonEmptyString(v)) return deny('Invalid CommandId in send_command_input');
    if (k === 'terminate' && typeof v !== 'boolean') return deny('Invalid Terminate flag in send_command_input');
    if ((k === 'input' || k === 'toolaction' || k === 'toolsummary') && typeof v !== 'string') {
      return deny(`Invalid ${k} parameter in send_command_input`);
    }
    if ((k === 'waitms' || k === 'waitmsbeforeasync') && (typeof v !== 'number' || !Number.isFinite(v))) {
      return deny(`Invalid ${k} parameter in send_command_input`);
    }
  }
  const anchorRepos = ctx.anchors.map((a) => ctx.repoAt(a));
  if (norm.folded.terminate === true && !norm.folded.input) {
    const nonInputErr = scanStdinPaths(rawArgs, ctx, '');
    if (nonInputErr) return nonInputErr;
    if (anchorRepos.some((r) => r.adlc && !r.store.ok)) {
      return deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified');
    }
    return PASS;
  }
  if (anchorRepos.some((r) => r.adlc && (r.activeRail || !r.store.ok))) {
    return deny('Interactive stdin write forbidden while ADLC rails are active or store is unreadable');
  }
  const stdinPathErr = scanStdinPaths(rawArgs, ctx, norm.folded.input ?? '');
  if (stdinPathErr) return stdinPathErr;
  const shVerdict = classifyRunCommand({ CommandLine: norm.folded.input ?? '', Cwd: ctx.anchor }, ctx);
  return shVerdict.decision === 'pass' ? PASS : deny(shVerdict.reason);
}

function evaluateOrchestrationTool(name, args, ctx) {
  if (name === 'manage_task') {
    const norm = normalizeArgsCaseInsensitive(args);
    if (!norm.ok) return deny(norm.reason);
    const action = norm.folded.action;
    if (action === 'list' || action === 'status') return PASS;
    if (action === 'kill') {
      if (ctx.headless) return deny('Headless agb worker session cannot kill tasks');
      if (ctx.anchors.some((a) => { const r = ctx.repoAt(a); return r.adlc && !r.store.ok; })) {
        return deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified');
      }
      return PASS;
    }
    if (action === 'send_input') {
      if (typeof norm.folded.input !== 'string') return deny('manage_task send_input requires a string Input parameter');
      if (ctx.headless || ctx.anchors.some((a) => { const r = ctx.repoAt(a); return r.adlc && (r.activeRail || !r.store.ok); })) {
        return deny('manage_task send_input forbidden in headless worker or active-rail ADLC repository');
      }
      const stdinPathErr = scanStdinPaths(args, ctx, norm.folded.input);
      if (stdinPathErr) return stdinPathErr;
      const shVerdict = classifyRunCommand({ CommandLine: norm.folded.input, Cwd: ctx.anchor }, ctx);
      return shVerdict.decision === 'pass' ? PASS : deny(shVerdict.reason);
    }
    return deny('Unsupported or missing manage_task Action');
  }

  if (SUBAGENT_TOOLS.has(name)) {
    if (ctx.headless) return deny('Headless agb worker session cannot spawn or manage subagents');
    if (ctx.anchors.some((a) => { const r = ctx.repoAt(a); return r.adlc && !r.store.ok; })) {
      return deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified');
    }
    const scan = scanPathLike(args, { topLevelSkipKeys: SUBAGENT_PROSE_KEYS });
    if (scan.overflow) return OVERFLOW;
    for (const token of scan.paths) {
      const resolved = resolveAll(token, ctx);
      if (resolved.length === 0) return deny(`Relative path '${token}' in ${name} has no workspace to anchor it`);
      for (const r of resolved) {
        const { verdict } = gateOnePath(r, ctx, { rootIsTarget: false });
        if (verdict.decision !== 'pass') return deny(verdict.reason);
        if (r.lexical !== r.real) {
          const lexRes = gateOnePath({ ...r, real: r.lexical }, ctx, { rootIsTarget: false });
          if (lexRes.verdict.decision !== 'pass') return deny(lexRes.verdict.reason);
        }
      }
    }
    return PASS;
  }

  if (name === 'schedule' || name === 'send_message') {
    if (ctx.headless) return deny(`Headless agb worker session cannot invoke ${name}`);
    return PASS;
  }

  if (name !== 'swarm') return PASS;
  if (ctx.headless) return deny('Headless agb worker session cannot invoke native swarm orchestration');
  if (ctx.anchors.some((a) => { const r = ctx.repoAt(a); return r.adlc && !r.store.ok; })) {
    return deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified');
  }
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  const workspace = norm.folded.workspace;
  if (workspace !== undefined && workspace !== null) {
    if (typeof workspace !== 'string' || !SWARM_WORKSPACE_MODES.has(workspace)) {
      return deny('Invalid swarm workspace mode; expected inherit, share, or branch');
    }
  }
  const scan = scanPathLike(args, {
    topLevelSkipKeys: SWARM_PROSE_KEYS,
    topLevelBareSkipKeys: SWARM_META_KEYS,
    includeBareTokens: true,
  });
  if (scan.overflow) return OVERFLOW;
  for (const token of [...scan.paths, ...scan.bareTokens]) {
    const resolved = resolveAll(token, ctx);
    if (resolved.length === 0) return deny(`Relative path '${token}' in swarm has no workspace to anchor it`);
    for (const r of resolved) {
      const { verdict } = gateOnePath(r, ctx, { rootIsTarget: false });
      if (verdict.decision === 'deny') return verdict;
      if (r.lexical !== r.real) {
        const lexRes = gateOnePath({ ...r, real: r.lexical }, ctx, { rootIsTarget: false });
        if (lexRes.verdict.decision === 'deny') return lexRes.verdict;
      }
    }
  }
  return PASS;
}

function evaluateWorkflowTool(args, ctx) {
  if (ctx.readonly) return deny('Read-only agb worker session cannot execute run_workflow');
  if (ctx.headless) return deny('Headless agb worker session cannot execute run_workflow');

  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  const folded = norm.folded;

  const scannedRepos = [];
  const cwdArg = folded.cwd;
  const hasExplicitCwd = cwdArg !== undefined && cwdArg !== null;
  if (hasExplicitCwd && (typeof cwdArg !== 'string' || cwdArg.trim().length === 0)) {
    return deny('Workflow working directory must be a non-empty path string');
  }
  const rawCwd = hasExplicitCwd ? cwdArg : ctx.workspacePaths[0];
  if (!rawCwd) {
    return deny('Cannot determine workflow working directory');
  }
  const cwdPhys = physicalResolve(rawCwd, ctx.workspacePaths[0] || '/', ctx.platform);
  if (!cwdPhys) {
    return deny('Workflow working directory cannot be resolved (symlink loop or oversized path)');
  }
  const cwdRepo = ctx.repoAt(cwdPhys);
  scannedRepos.push(cwdRepo);
  const wsAdlc = ctx.workspacePaths.some((w) => ctx.repoAt(w).adlc);
  const adlcContext = cwdRepo.adlc || wsAdlc;
  const insideWorkspace = ctx.workspaceRealPaths.some((wReal) => isWithin(cwdPhys, wReal, ctx.platform));
  if (adlcContext && ((hasExplicitCwd && !isAbsolute(cwdArg)) || !insideWorkspace)) {
    return deny('Workflow working directory outside declared workspace paths in an ADLC repository is forbidden');
  }
  const wfCtx = { ...ctx, anchors: unique([cwdPhys, ...ctx.anchors]) };

  const scriptPathArg = folded.scriptpath;
  if (scriptPathArg !== undefined && scriptPathArg !== null) {
    if (typeof scriptPathArg !== 'string' || scriptPathArg.trim().length === 0) {
      return schemaViolationVerdict('run_workflow', args, 'Invalid ScriptPath parameter in run_workflow', wfCtx);
    }
    const resolved = resolveAll(toPath(scriptPathArg), wfCtx);
    if (resolved.length === 0) return deny(`Relative ScriptPath '${scriptPathArg}' has no workspace to anchor it`);
    for (const r of resolved) {
      const { verdict, repo } = gateOnePath(r, wfCtx, { rootIsTarget: true });
      scannedRepos.push(repo);
      if (verdict.decision === 'deny') return verdict;
      if (r.lexical !== r.real) {
        const lexRes = gateOnePath({ ...r, real: r.lexical }, wfCtx, { rootIsTarget: true });
        scannedRepos.push(lexRes.repo);
        if (lexRes.verdict.decision === 'deny') return lexRes.verdict;
      }
    }
  }

  const scan = scanPathLike(args, { topLevelSkipKeys: WORKFLOW_PROSE_KEYS, includeBareTokens: true });
  if (scan.overflow) return OVERFLOW;
  for (const token of [...scan.paths, ...scan.bareTokens]) {
    const resolved = resolveAll(token, wfCtx);
    if (resolved.length === 0) return deny(`Relative path '${token}' in run_workflow has no workspace to anchor it`);
    for (const r of resolved) {
      const { verdict, repo } = gateOnePath(r, wfCtx, { rootIsTarget: false });
      scannedRepos.push(repo);
      if (verdict.decision === 'deny') return verdict;
      if (r.lexical !== r.real) {
        const lexRes = gateOnePath({ ...r, real: r.lexical }, wfCtx, { rootIsTarget: false });
        scannedRepos.push(lexRes.repo);
        if (lexRes.verdict.decision === 'deny') return lexRes.verdict;
      }
    }
  }

  const repos = [...wfCtx.anchors.map((a) => wfCtx.repoAt(a)), ...scannedRepos];
  if (repos.some((r) => r.adlc && !r.store.ok)) {
    return deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified');
  }
  if (repos.some((r) => r.adlc && r.activeRail)) {
    return ask('run_workflow executes Python outside PreToolUse file hooks in an active-rail ADLC repository; operator confirmation required');
  }
  return PASS;
}

function evaluateCodegraphTool(name, args, ctx) {
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  if ((ctx.headless || ctx.readonly) && !ctx.allowCodegraphMcp) {
    return deny('CodeGraph MCP queries are denied in headless/read-only worker sessions unless AGB_ALLOW_CODEGRAPH_MCP=1');
  }
  if (ctx.workspaceRealPaths.length === 0) {
    return deny('CodeGraph query requires a declared workspace to verify path containment');
  }
  const schemaPaths = [];
  for (const key of READ_TOOL_PATH_SCHEMAS[name] ?? []) {
    const fk = goFoldKey(key);
    const val = norm.folded[fk];
    if (val === undefined) continue;
    if (!isNonEmptyString(val)) {
      return deny(`Invalid CodeGraph path parameter: ${key}`);
    }
    schemaPaths.push(toPath(val.trim()));
  }
  const scanned = scanPathLike(args);
  if (scanned.overflow) return OVERFLOW;
  const candidates = unique([...schemaPaths, ...scanned.paths]);
  for (const token of candidates) {
    const resolved = resolveAll(token, ctx);
    if (resolved.length === 0) {
      return deny(`Relative path '${token}' in ${name} has no workspace to anchor it`);
    }
    for (const r of resolved) {
      if (matchRoot(r, ctx.boosterDataRoots, ctx.platform)) {
        return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
      }
      if (r.unresolved) {
        return deny('Target path cannot be resolved (symlink loop or oversized path)');
      }
      const insideWorkspace = ctx.workspaceRealPaths.some((wReal) => isWithin(r.real, wReal, ctx.platform));
      if (!insideWorkspace) {
        return deny(`CodeGraph query path '${token}' resolves outside declared workspace`);
      }
    }
  }
  return PASS;
}

function evaluateUnknownTool(args, ctx) {
  if (ctx.readonly) return deny('Unknown tool in a read-only agb worker session');
  if (ctx.workerTicket && ctx.anchors.length === 0) return deny('Headless worker has no workspace; tool call denied');
  // Trust-root and rail gating applies to unknown tools in every repo (P5 round 3 M6).
  const scan = scanPathLike(args);
  if (scan.overflow) return OVERFLOW;
  const scannedRepos = [];
  for (const token of scan.paths) {
    for (const r of resolveAll(token, ctx)) {
      const { verdict, repo } = gateOnePath(r, ctx, { rootIsTarget: false });
      scannedRepos.push(repo);
      if (verdict.decision === 'deny') return verdict;
      if (r.lexical !== r.real) {
        const lexRes = gateOnePath({ ...r, real: r.lexical }, ctx, { rootIsTarget: false });
        scannedRepos.push(lexRes.repo);
        if (lexRes.verdict.decision === 'deny') return lexRes.verdict;
      }
    }
  }
  const repos = [...ctx.anchors.map((a) => ctx.repoAt(a)), ...scannedRepos];
  if (repos.some((r) => r.adlc && (r.activeRail || ctx.workerTicket))) {
    return deny('Unknown tool in ADLC repository with active frozen rails; cannot verify safety');
  }
  return PASS;
}

export function buildContext(payload, options = {}) {
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? homedir()); // a relative HOME would disable protection (P5 r4 L8)
  const realHome = realOr(home);
  const platform = options.platform ?? process.platform;
  const workspacePaths = (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [])
    .filter((p) => typeof p === 'string' && isAbsolute(p))
    .map((p) => resolve(p));
  const workspaceRealPaths = unique(workspacePaths.map((w) => physicalResolve(w, '/', platform) ?? w));
  const workerTicket = env.AGB_WORKER_TICKET ? String(env.AGB_WORKER_TICKET) : null;
  const rescueTicket = env.AGB_RESCUE_TICKET ? String(env.AGB_RESCUE_TICKET) : null;
  const rawWorkerBuildCmd = typeof env.AGB_WORKER_BUILD_CMD === 'string' ? env.AGB_WORKER_BUILD_CMD.trim() : '';
  const workerBuildCmd = /^npm run [a-zA-Z0-9_.:-]+$/.test(rawWorkerBuildCmd) ? rawWorkerBuildCmd : null;
  const readonly = Boolean(env.AGB_WORKER_MODE);
  const args = payload?.toolCall?.args;
  const normArgs = args !== undefined && args !== null ? normalizeArgsCaseInsensitive(args) : null;
  const cwdArg = normArgs?.ok ? normArgs.folded.cwd : undefined;
  const cwd = typeof cwdArg === 'string' && isAbsolute(cwdArg) ? resolve(cwdArg) : null;
  const extraHomes = [];
  const homeMarker = /(^|[\/\\])\.agb_home$/;
  if (typeof env.AGB_USER_HOME === 'string' && isAbsolute(env.AGB_USER_HOME)) {
    const uh = resolve(env.AGB_USER_HOME);
    extraHomes.push(uh, realOr(uh));
  }
  if (homeMarker.test(home) || homeMarker.test(realHome)) {
    try {
      const osHome = userInfo().homedir;
      if (typeof osHome === 'string' && isAbsolute(osHome)) {
        const uh = resolve(osHome);
        extraHomes.push(uh, realOr(uh));
      }
    } catch {}
    try {
      const selfPath = fileURLToPath(import.meta.url);
      const geminiMarker = '/' + '.gemini/';
      const geminiIdx = selfPath.indexOf(geminiMarker);
      if (geminiIdx > 0) {
        const uh = resolve(selfPath.slice(0, geminiIdx));
        extraHomes.push(uh, realOr(uh));
      }
    } catch {}
  }
  const homes = unique([home, realHome, ...extraHomes]);
  const headless = Boolean(workerTicket) || readonly;
  const rawTmpCandidates = [tmpdir(), '/tmp', '/private/tmp', env.TMPDIR, env.TMP, env.TEMP]
    .filter((p) => typeof p === 'string' && p.length > 0 && isAbsolute(p));
  const tmpRoots = unique(rawTmpCandidates.flatMap((p) => {
    const resolvedTmp = resolve(p);
    return [resolvedTmp, realOr(resolvedTmp)];
  }));
  const baseBoosterDataRoots = unique(homes.flatMap((h) => boosterDataRoots(h)));
  const brainRootsList = unique(homes.flatMap((h) => brainRoots(h)));
  const hasBrainMetadata = payload?.conversationId !== undefined || payload?.artifactDirectoryPath !== undefined;
  const verifiedBrainArtifact = verifyBrainArtifactDirectory(payload, { home, realHome, headless, platform });
  return {
    home,
    realHome,
    homes,
    platform,
    workspacePaths,
    workspaceRealPaths,
    workerTicket,
    rescueTicket,
    workerBuildCmd,
    readonly,
    allowCodegraphMcp: env.AGB_ALLOW_CODEGRAPH_MCP === '1',
    cdpath: Boolean(env.CDPATH),
    headless,
    tmpRoots,
    brainRoots: brainRootsList,
    hasBrainMetadata,
    verifiedBrainArtifact,
    anchor: cwd ?? workspacePaths[0] ?? null,
    anchors: unique([...(cwd ? [cwd] : []), ...workspacePaths]),
    // Roots for both the lexical and the physical home (P5 round 3 M4).
    protectedRoots: unique(homes.flatMap((h) => protectedRoots(h))),
    boosterDataRoots: headless
      ? [...baseBoosterDataRoots, ...brainRootsList, headlessProtectedMatcher(tmpRoots)]
      : rescueTicket
        ? [...baseBoosterDataRoots, headlessProtectedMatcher(tmpRoots)]
        : baseBoosterDataRoots,
    limits: { subtreeEntries: options.limits?.subtreeEntries ?? DEFAULT_SUBTREE_ENTRIES },
    storeOverrides: [env.ADLC_TICKET_STORE, env.ADLC_TICKETS].filter((p) => typeof p === 'string' && p.length > 0).map((p) => realOr(resolve(p))),
    ...makeRepoCache(home, homes),
  };
}

const HEADLESS_DESTRUCTIVE_SHELL_CMDS = new Set([
  'rm', 'mv', 'shred', 'unlink', 'rmdir', 'cp', 'tar', 'rsync', 'chmod', 'chown', 'chgrp', 'find',
]);
const HEADLESS_FORBIDDEN_SHELL_LITERAL =
  /(?:control\.json|control\.sock|rescue-locks|rescue-latest|agb-ctrl-)/i;

function evaluateRunCommand(args, ctx) {
  const verdict = classifyRunCommand(args, ctx);
  if (verdict.decision === 'deny' || (!ctx.headless && !ctx.rescueTicket)) return verdict;
  const norm = normalizeArgsCaseInsensitive(args);
  if (!norm.ok) return deny(norm.reason);
  const line = norm.folded.commandline;
  if (typeof line !== 'string') return deny('run_command without a CommandLine string cannot be verified');
  if (HEADLESS_FORBIDDEN_SHELL_LITERAL.test(line)) {
    return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
  }
  const lexed = lexCommandLine(line);
  if (!lexed.ok) {
    return deny('Shell command could not be parsed in protected worker/rescue session');
  }
  const cwdArg = norm.folded.cwd;
  const baseCwd = typeof cwdArg === 'string' && cwdArg.length > 0 ? resolve(cwdArg) : (ctx.workspacePaths[0] ?? '/');
  const ipcMatcher = headlessProtectedMatcher(ctx.tmpRoots);
  for (const sub of lexed.subcommands) {
    const cmd = basename(sub.argv[0] ?? '');
    const isDestructive = HEADLESS_DESTRUCTIVE_SHELL_CMDS.has(cmd);
    const argvTokens = sub.argv.slice(1).flatMap((t) => {
      if (!t.startsWith('-')) return [t];
      const eq = t.indexOf('=');
      return eq > 0 && eq < t.length - 1 ? [t.slice(eq + 1)] : [];
    });
    for (const tok of argvTokens) {
      const cand = resolveCandidate(tok, baseCwd, ctx.home, ctx.platform);
      if (ipcMatcher(cand.real, ctx.platform) || ipcMatcher(cand.lexical, ctx.platform)) {
        return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
      }
      if (isDestructive) {
        const isBoosterDir = /(?:^|[\\/])\.booster$/i.test(cand.real) || /(?:^|[\\/])\.booster$/i.test(cand.lexical);
        const containsTmp = (ctx.tmpRoots ?? []).some((t) => isWithin(t, cand.real, ctx.platform) || isWithin(t, cand.lexical, ctx.platform));
        if (isBoosterDir || containsTmp) {
          return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
        }
      }
    }
    for (const redir of sub.redirects ?? []) {
      if (!redir.target) continue;
      const cand = resolveCandidate(redir.target, baseCwd, ctx.home, ctx.platform);
      if (ipcMatcher(cand.real, ctx.platform) || ipcMatcher(cand.lexical, ctx.platform)) {
        return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
      }
      if (String(redir.op ?? '').includes('>')) {
        const inBooster = /(?:^|[\\/])\.booster(?:$|[\\/])/i.test(cand.real) || /(?:^|[\\/])\.booster(?:$|[\\/])/i.test(cand.lexical);
        if (inBooster) {
          return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
        }
      }
    }
  }
  return verdict;
}

export function evaluatePayload(payload, options = {}) {
  const name = payload?.toolCall?.name;
  if (typeof name !== 'string' || name.length === 0) return deny('Malformed PreToolUse payload: missing tool name');
  const args = payload.toolCall.args === undefined ? {} : payload.toolCall.args;
  // Before Step 1: a control step's args are the model's answer, not paths.
  if (AGY_CONTROL_TOOLS.has(name)) return PASS;
  beginEvaluation();
  const ctx = buildContext(payload, options);

  const step1 = stepOne(name, args, ctx);
  if (step1.decision === 'deny') return step1;

  if (READ_ONLY_TOOLS.has(name)) return PASS;
  if (CODEGRAPH_READ_TOOLS.has(name)) return evaluateCodegraphTool(name, args, ctx);
  if (name === 'sed_file') return evaluateSedFile(args, ctx);
  if (NOTEBOOK_EXEC_TOOLS.has(name)) return evaluateNotebookExecution(args, ctx);
  if (STDIN_TOOLS.has(name)) return evaluateSendCommandInput(args, ctx);
  if (ORCHESTRATION_TOOLS.has(name)) return evaluateOrchestrationTool(name, args, ctx);
  if (WORKFLOW_TOOLS.has(name)) return evaluateWorkflowTool(args, ctx);
  if (name === 'run_command') return evaluateRunCommand(args, ctx);
  if (PATH_MUTATING_TOOLS.has(name)) return evaluateFileTool(name, args, ctx);
  if (name === 'call_mcp_tool' || name.startsWith('mcp__') || name.startsWith('mcp_')) return evaluateMcpTool(name, args, ctx);
  return evaluateUnknownTool(args, ctx);
}
