// PreToolUse policy evaluation (spec §4.5.1 pipeline as amended by Appendix A).
//
// evaluatePayload(payload, options) -> { decision: 'deny'|'ask'|'pass', reason? }
// Pure apart from filesystem reads of the target repos' ticket stores.
//
// File and MCP tools are the EXACT layer (owner decision 2026-10-05): every
// path they name is resolved physically and judged against rails, the ADLC
// trust root and the platform's protected roots, failing closed.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { findAdlcRoot, resolveTicket, unionActiveRails } from '../../lib/active-rails.mjs';
import {
  BOOSTER_MCP_SERVER, BOOSTER_MCP_TOOLS, EXCLUDED_CONTENT_KEYS, ORCHESTRATION_TOOLS,
  PATH_MUTATING_TOOLS, READ_ONLY_TOOLS, READ_TOOL_PATH_SCHEMAS, TOOL_PATH_SCHEMAS,
} from './constants.mjs';
import {
  boosterDataRoots, hasHomePrefix, isWithin, matchDeclaredRail, matchImplicitRail, matchRoot,
  matchesScope, protectedRoots, repoRelative, resolveCandidate,
} from './paths.mjs';
import { classifyRunCommand } from './shell.mjs';
import { ask, deny, mostRestrictive, PASS } from './verdict.mjs';

const UNEXPECTED_PATH = /[/\\]|\.(mjs|js|json)$/;
// file:/abs, file:///abs, file://localhost/abs — any case (P5 rounds 1 and 3).
const FILE_URL = /^file:(\/\/(localhost)?)?(?=\/)/i;
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_NODES = 20000;

/** Tools may name targets as file: URLs; policy always evaluates the decoded path. */
function toPath(value) {
  if (!FILE_URL.test(value)) return value;
  const path = value.replace(FILE_URL, '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
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
function makeRepoCache(home) {
  const byRoot = new Map();
  return {
    repoAt(absPath) {
      const root = findAdlcRoot(absPath, { home });
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

export function isBoosterMcpTool(name, args) {
  if (name === 'call_mcp_tool') return args?.ServerName === BOOSTER_MCP_SERVER && BOOSTER_MCP_TOOLS.has(args?.ToolName);
  const prefix = `mcp__${BOOSTER_MCP_SERVER}__`;
  return name.startsWith(prefix) && BOOSTER_MCP_TOOLS.has(name.slice(prefix.length));
}

function boosterMcpToolName(name, args) {
  return name === 'call_mcp_tool' ? args?.ToolName : name.slice(`mcp__${BOOSTER_MCP_SERVER}__`.length);
}

/** Probed-schema path extraction for file-mutating tools (§4.5.1). */
export function extractProbedPaths(toolName, args) {
  const schema = TOOL_PATH_SCHEMAS[toolName];
  if (!schema) return null;
  const paths = [];
  for (const key of schema.required) {
    const val = args?.[key];
    if (typeof val !== 'string' || val.trim().length === 0) return { error: `Missing required path parameter: ${key}` };
    paths.push(val);
  }
  for (const [key, val] of Object.entries(args ?? {})) {
    if (schema.required.includes(key) || EXCLUDED_CONTENT_KEYS.has(key)) continue;
    if (typeof val === 'string' && UNEXPECTED_PATH.test(val)) return { error: `Unexpected path parameter in mutating tool call: ${key}` };
  }
  return { paths };
}

const looksLikePath = (s) => isAbsolute(s) || hasHomePrefix(s) || s.includes('/') || s.startsWith('.') || FILE_URL.test(s);

/**
 * A.6 item 9: every string (and object key) that looks like a path, anywhere
 * in the arguments, iteratively and with depth/size limits so hostile nesting
 * cannot crash the evaluator (P5 round 3 F1). `skipContentKeys` drops the
 * free-text keys of file tools; MCP and unknown tools get no such exemption.
 */
function scanPathLike(value, { skipContentKeys = false } = {}) {
  const paths = [];
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value: v, depth } = stack.pop();
    nodes += 1;
    if (depth > MAX_SCAN_DEPTH || nodes > MAX_SCAN_NODES) return { paths, overflow: true };
    if (typeof v === 'string') {
      if (looksLikePath(v)) paths.push(toPath(v));
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push({ value: item, depth: depth + 1 });
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (skipContentKeys && EXCLUDED_CONTENT_KEYS.has(k)) continue;
        if (looksLikePath(k)) paths.push(toPath(k));
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return { paths, overflow: false };
}

const OVERFLOW = deny('Tool arguments are nested too deeply or are too large to verify');

function readToolPaths(name, args) {
  const keys = READ_TOOL_PATH_SCHEMAS[name] ?? [];
  return keys.map((k) => args?.[k]).filter((v) => typeof v === 'string' && v.length > 0).map(toPath);
}

/**
 * Every physical path a token can denote. Absolute and home-relative tokens
 * have one; a relative token is resolved against EVERY anchor (Cwd and each
 * workspace path), because the caller chooses the anchor (P5 round 3 M5).
 * No anchor at all yields [] — callers fail closed.
 */
function resolveAll(token, ctx) {
  if (isAbsolute(token) || hasHomePrefix(token)) return [resolveCandidate(token, '/', ctx.home)];
  return ctx.anchors.map((anchor) => resolveCandidate(token, anchor, ctx.home));
}

/** A directory operation on a path that CONTAINS a workspace repo or protected root (P5 round 3 H1). */
function containsProtected(r, ctx) {
  if (ctx.protectedRoots.some((root) => isWithin(root, r.real, ctx.platform) || isWithin(root, r.lexical, ctx.platform))) {
    return deny('Target path contains platform configuration, plugins, or Node runtimes');
  }
  for (const w of ctx.workspacePaths) {
    const repo = ctx.repoAt(w);
    if (repo.adlc && repo.root !== r.real && isWithin(repo.root, r.real, ctx.platform)) {
      return deny('Target path contains an ADLC repository');
    }
  }
  return null;
}

/** Gate 1 for one resolved path: store overrides, implicit rails, shards, declared rails. */
function gateOnePath(resolved, ctx, { rootIsTarget = true } = {}) {
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

function stepOne(name, args, ctx) {
  if (name === 'run_command') return PASS; // shell tokens are checked by the classifier
  const isRead = READ_ONLY_TOOLS.has(name) || Boolean(READ_TOOL_PATH_SCHEMAS[name]);
  let candidates;
  if (isRead) candidates = readToolPaths(name, args);
  else if (TOOL_PATH_SCHEMAS[name]) candidates = TOOL_PATH_SCHEMAS[name].required.map((k) => args?.[k]).filter((v) => typeof v === 'string').map(toPath);
  else {
    const scan = scanPathLike(args);
    if (scan.overflow) return OVERFLOW;
    candidates = scan.paths;
  }
  for (const token of candidates) {
    for (const r of resolveAll(token, ctx)) {
      if (matchRoot(r, ctx.boosterDataRoots, ctx.platform)) {
        return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
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
  const required = (TOOL_PATH_SCHEMAS[name]?.required ?? []).map((k) => args?.[k]).filter((v) => typeof v === 'string' && v.length > 0).map(toPath);
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

function evaluateFileTool(name, args, ctx) {
  const extracted = extractProbedPaths(name, args);
  if (!extracted || extracted.error) {
    const reason = extracted
      ? `Mutating tool argument schema violation: ${extracted.error}`
      : 'Unknown mutating tool in ADLC repository with active frozen rails; cannot verify target path safety';
    return schemaViolationVerdict(name, args, reason, ctx);
  }
  if (ctx.readonly) return deny('Read-only agb worker session: file mutations are forbidden');
  const workerHome = ctx.workerTicket ? ctx.repoAt(ctx.workspacePaths[0] ?? '/') : null;
  const verdicts = [];
  for (const token of extracted.paths.map(toPath)) {
    const resolved = resolveAll(token, ctx);
    if (resolved.length === 0) {
      verdicts.push(deny(`Relative target '${token}' has no workspace to anchor it`));
      continue;
    }
    for (const r of resolved) {
      const contains = containsProtected(r, ctx);
      if (contains) {
        verdicts.push(contains);
        continue;
      }
      const { verdict, repo, rel } = gateOnePath(r, ctx);
      if (verdict.decision !== 'pass') {
        verdicts.push(verdict);
        continue;
      }
      if (workerHome?.adlc) {
        // A worker inside an ADLC repo may only write inside that repo's ticket scope (P5 round 3 W2).
        if (!repo.adlc || repo.root !== workerHome.root) {
          verdicts.push(deny(`Headless worker for ticket ${ctx.workerTicket} attempted mutation outside its repository: ${r.real}`));
        } else {
          verdicts.push(workerScopeVerdict(repo, rel, ctx));
        }
      }
    }
  }
  return mostRestrictive(verdicts);
}

function evaluateMcpTool(name, args, ctx) {
  const scan = scanPathLike(args);
  if (scan.overflow) return OVERFLOW;
  const verdicts = [];
  for (const token of scan.paths) {
    for (const r of resolveAll(token, ctx)) {
      // An MCP argument that names a repository (e.g. `repo`) is a reference, not a mutation target.
      const { verdict } = gateOnePath(r, ctx, { rootIsTarget: false });
      if (verdict.decision === 'deny') verdicts.push(deny(`Target path '${token}' in MCP tool call references frozen rail (${verdict.reason})`));
    }
  }
  if (verdicts.length) return mostRestrictive(verdicts);
  if (isBoosterMcpTool(name, args)) {
    if (ctx.readonly && boosterMcpToolName(name, args) === 'agb_run') return deny('Read-only agb worker session cannot start an agb run');
    return PASS;
  }
  if (ctx.readonly) return deny('Third-party MCP tool call cannot prompt operator in a read-only agb worker session');
  const repos = ctx.anchors.map((a) => ctx.repoAt(a));
  if (ctx.workerTicket && repos.some((r) => r.adlc)) return deny('Third-party MCP tool call cannot prompt operator in headless worker mode');
  if (repos.some((r) => r.adlc && r.activeRail)) {
    return ctx.headless
      ? deny('Third-party MCP tool call cannot prompt operator in headless worker mode')
      : ask('Third-party MCP tool call in an active-rail ADLC repository requires operator confirmation');
  }
  return PASS;
}

function evaluateUnknownTool(args, ctx) {
  if (ctx.readonly) return deny('Unknown tool in a read-only agb worker session');
  // Trust-root and rail gating applies to unknown tools in every repo (P5 round 3 M6).
  const scan = scanPathLike(args);
  if (scan.overflow) return OVERFLOW;
  for (const token of scan.paths) {
    for (const r of resolveAll(token, ctx)) {
      const { verdict } = gateOnePath(r, ctx, { rootIsTarget: false });
      if (verdict.decision === 'deny') return verdict;
    }
  }
  const repos = ctx.anchors.map((a) => ctx.repoAt(a));
  if (repos.some((r) => r.adlc && (r.activeRail || ctx.workerTicket))) {
    return deny('Unknown tool in ADLC repository with active frozen rails; cannot verify safety');
  }
  return PASS;
}

export function buildContext(payload, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const realHome = realOr(home);
  const workspacePaths = (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [])
    .filter((p) => typeof p === 'string' && isAbsolute(p))
    .map((p) => resolve(p));
  const workerTicket = env.AGB_WORKER_TICKET ? String(env.AGB_WORKER_TICKET) : null;
  const readonly = Boolean(env.AGB_WORKER_MODE);
  const args = payload?.toolCall?.args;
  const cwd = typeof args?.Cwd === 'string' && isAbsolute(args.Cwd) ? resolve(args.Cwd) : null;
  const homes = unique([home, realHome]);
  return {
    home,
    realHome,
    platform: options.platform ?? process.platform,
    workspacePaths,
    workerTicket,
    readonly,
    cdpath: Boolean(env.CDPATH),
    headless: Boolean(workerTicket) || readonly,
    anchor: cwd ?? workspacePaths[0] ?? null,
    anchors: unique([...(cwd ? [cwd] : []), ...workspacePaths]),
    // Roots for both the lexical and the physical home (P5 round 3 M4).
    protectedRoots: unique(homes.flatMap((h) => protectedRoots(h))),
    boosterDataRoots: unique(homes.flatMap((h) => boosterDataRoots(h))),
    storeOverrides: [env.ADLC_TICKET_STORE, env.ADLC_TICKETS].filter((p) => typeof p === 'string' && p.length > 0).map((p) => realOr(resolve(p))),
    ...makeRepoCache(home),
  };
}

export function evaluatePayload(payload, options = {}) {
  const name = payload?.toolCall?.name;
  if (typeof name !== 'string' || name.length === 0) return deny('Malformed PreToolUse payload: missing tool name');
  const args = payload.toolCall.args ?? {};
  const ctx = buildContext(payload, options);

  const step1 = stepOne(name, args, ctx);
  if (step1.decision === 'deny') return step1;

  if (READ_ONLY_TOOLS.has(name) || ORCHESTRATION_TOOLS.has(name)) return PASS;
  if (name === 'run_command') return classifyRunCommand(args, ctx);
  if (PATH_MUTATING_TOOLS.has(name)) return evaluateFileTool(name, args, ctx);
  if (name === 'call_mcp_tool' || name.startsWith('mcp__')) return evaluateMcpTool(name, args, ctx);
  return evaluateUnknownTool(args, ctx);
}
