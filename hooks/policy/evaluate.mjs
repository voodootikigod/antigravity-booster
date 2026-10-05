// PreToolUse policy evaluation (spec §4.5.1 pipeline as amended by Appendix A).
//
// evaluatePayload(payload, options) -> { decision: 'deny'|'ask'|'pass', reason? }
// Pure apart from filesystem reads of the target repos' ticket stores.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { findAdlcRoot, resolveTicket, unionActiveRails } from '../../lib/active-rails.mjs';
import {
  BOOSTER_MCP_SERVER, BOOSTER_MCP_TOOLS, EXCLUDED_CONTENT_KEYS, ORCHESTRATION_TOOLS,
  PATH_MUTATING_TOOLS, READ_ONLY_TOOLS, READ_TOOL_PATH_SCHEMAS, TOOL_PATH_SCHEMAS,
} from './constants.mjs';
import {
  boosterDataRoots, hasHomePrefix, matchDeclaredRail, matchImplicitRail, matchRoot,
  matchesScope, protectedRoots, repoRelative, resolveCandidate,
} from './paths.mjs';
import { classifyRunCommand } from './shell.mjs';
import { ask, deny, mostRestrictive, PASS } from './verdict.mjs';

const UNEXPECTED_PATH = /[/\\]|\.(mjs|js|json)$/;
const FILE_URL = /^file:\/\//;

/** Tools may name targets as file:// URLs; policy always evaluates the path (P5 prosecution M3). */
const toPath = (value) => value.replace(FILE_URL, '');

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Repo lookups are cached per evaluation: the ticket store is read at most once per repo. */
function makeRepoCache() {
  const byRoot = new Map();
  return {
    repoAt(absPath) {
      const root = findAdlcRoot(absPath);
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

/** A.6 item 9: recursive scan of string args that look like paths (unknown and MCP tools). */
function scanPathLike(value, out = [], key = null) {
  if (key !== null && EXCLUDED_CONTENT_KEYS.has(key)) return out;
  if (typeof value === 'string') {
    if (isAbsolute(value) || hasHomePrefix(value) || value.includes('/')) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) scanPathLike(v, out, null);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanPathLike(v, out, k);
  }
  return out;
}

function readToolPaths(name, args) {
  const keys = READ_TOOL_PATH_SCHEMAS[name] ?? [];
  return keys.map((k) => args?.[k]).filter((v) => typeof v === 'string' && v.length > 0).map(toPath);
}

/** Gate 1 for one resolved path inside the repo cache: implicit rails, shards, declared rails. */
function gateOnePath(resolved, ctx, { rootIsTarget = true } = {}) {
  const repo = ctx.repoAt(resolved.real);
  if (!repo.adlc) return { verdict: PASS, repo };
  if (!repo.store.ok) return { verdict: deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified'), repo };
  const rel = repoRelative(resolved.real, repo.root);
  if (rel === null) return { verdict: deny('Target path sits outside repository root'), repo };
  const implicit = rel === '' && !rootIsTarget ? null : matchImplicitRail(rel, repo.root, ctx.platform);
  if (implicit) return { verdict: deny(`Target path matches standing ADLC implicit rail: ${implicit}`), repo, rel };
  if (repo.activeRail) {
    if (rel === '') {
      return rootIsTarget ? { verdict: deny('Target path is repository root, which contains active frozen rails'), repo, rel } : { verdict: PASS, repo, rel };
    }
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
  const anchor = ctx.anchor;
  let candidates;
  if (READ_ONLY_TOOLS.has(name) || READ_TOOL_PATH_SCHEMAS[name]) candidates = readToolPaths(name, args);
  else if (TOOL_PATH_SCHEMAS[name]) {
    candidates = TOOL_PATH_SCHEMAS[name].required.map((k) => args?.[k]).filter((v) => typeof v === 'string').map(toPath);
  } else if (name === 'run_command') return PASS; // shell tokens are checked by the classifier
  else candidates = scanPathLike(args);

  for (const token of candidates) {
    const r = resolveCandidate(token, anchor, ctx.home);
    if (matchRoot(r, boosterDataRoots(ctx.home), ctx.platform)) {
      return deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden');
    }
    if (!READ_ONLY_TOOLS.has(name) && !READ_TOOL_PATH_SCHEMAS[name] && matchRoot(r, protectedRoots(ctx.home), ctx.platform)) {
      return deny('Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden');
    }
  }
  return PASS;
}

/**
 * A schema-violating call is judged by every path it could touch, not by the
 * caller-controllable anchor (P5 prosecution H3, Appendix A.6 item 8): deny
 * when any candidate lands in an ADLC repository or a protected root.
 */
function schemaViolationVerdict(name, args, reason, ctx) {
  if (ctx.readonly) return deny(reason);
  const required = (TOOL_PATH_SCHEMAS[name]?.required ?? []).map((k) => args?.[k]).filter((v) => typeof v === 'string' && v.length > 0);
  const anchorRepo = ctx.repoAt(ctx.anchor ?? '/');
  if (anchorRepo.adlc && (anchorRepo.activeRail || ctx.workerTicket)) return deny(reason);
  for (const token of [...required, ...scanPathLike(args)].map(toPath)) {
    const r = resolveCandidate(token, ctx.anchor, ctx.home);
    if (matchRoot(r, protectedRoots(ctx.home), ctx.platform) || ctx.repoAt(r.real).adlc) return deny(reason);
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
  const verdicts = [];
  for (const token of extracted.paths.map(toPath)) {
    const r = resolveCandidate(token, ctx.anchor, ctx.home);
    const { verdict, repo, rel } = gateOnePath(r, ctx);
    if (verdict.decision !== 'pass') {
      verdicts.push(verdict);
      continue;
    }
    if (ctx.workerTicket && repo.adlc) verdicts.push(workerScopeVerdict(repo, rel, ctx));
  }
  return mostRestrictive(verdicts);
}

function evaluateMcpTool(name, args, ctx) {
  const verdicts = [];
  for (const token of scanPathLike(args)) {
    // An MCP argument that names a repository (e.g. `repo`) is a reference, not a mutation target.
    const { verdict } = gateOnePath(resolveCandidate(token, ctx.anchor, ctx.home), ctx, { rootIsTarget: false });
    if (verdict.decision === 'deny') verdicts.push(deny(`Target path '${token}' in MCP tool call references frozen rail (${verdict.reason})`));
  }
  if (verdicts.length) return mostRestrictive(verdicts);
  if (isBoosterMcpTool(name, args)) {
    if (ctx.readonly && boosterMcpToolName(name, args) === 'agb_run') return deny('Read-only agb worker session cannot start an agb run');
    return PASS;
  }
  if (ctx.readonly) return deny('Third-party MCP tool call cannot prompt operator in a read-only agb worker session');
  const repo = ctx.repoAt(ctx.anchor ?? '/');
  if (ctx.workerTicket && repo.adlc) return deny('Third-party MCP tool call cannot prompt operator in headless worker mode');
  if (repo.adlc && repo.activeRail) {
    return ctx.headless
      ? deny('Third-party MCP tool call cannot prompt operator in headless worker mode')
      : ask('Third-party MCP tool call in an active-rail ADLC repository requires operator confirmation');
  }
  return PASS;
}

function evaluateUnknownTool(ctx) {
  if (ctx.readonly) return deny('Unknown tool in a read-only agb worker session');
  const repo = ctx.repoAt(ctx.anchor ?? '/');
  if (repo.adlc && (repo.activeRail || ctx.workerTicket)) {
    return deny('Unknown tool in ADLC repository with active frozen rails; cannot verify safety');
  }
  return PASS;
}

export function buildContext(payload, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const workspacePaths = (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [])
    .filter((p) => typeof p === 'string' && isAbsolute(p))
    .map((p) => resolve(p));
  const workerTicket = env.AGB_WORKER_TICKET ? String(env.AGB_WORKER_TICKET) : null;
  const readonly = Boolean(env.AGB_WORKER_MODE);
  const args = payload?.toolCall?.args;
  const cwd = typeof args?.Cwd === 'string' && isAbsolute(args.Cwd) ? resolve(args.Cwd) : null;
  return {
    home,
    realHome: realOr(home),
    platform: options.platform ?? process.platform,
    workspacePaths,
    workerTicket,
    readonly,
    headless: Boolean(workerTicket) || readonly,
    anchor: cwd ?? workspacePaths[0] ?? null,
    ...makeRepoCache(),
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
  return evaluateUnknownTool(ctx);
}
