import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { estimatePlanQuotaRunway, readFreshStatusLineQuotaCache } from '../lib/pools.mjs';
import { FactoryLedger } from '../lib/factory-ledger.mjs';
import {
  buildAcceptanceDossier,
  formatAcceptanceDossierMarkdown,
  saveAcceptVerdicts,
} from '../lib/accept.mjs';
import { sendControlCommand } from '../lib/control-ipc.mjs';
import { TICKET_ID_RE, validatePlan } from '../lib/plan-integrity.mjs';
import { UI_RESOURCES, renderUiResource } from './ui-views.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_MAIN = process.argv[1] && (
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('/mcp/server.mjs') ||
  process.argv[1].endsWith('/dist/mcp-server.mjs')
);

const activeProcesses = new Map();
const cancelledRequests = new Set();

const MAX_STRUCTURED_BYTES = 512 * 1024;
const CLI_UI_TOOLS = new Set(['agb_shape', 'agb_plan', 'agb_preflight', 'agb_review']);
const CONTROL_ACTIONS = new Set(['snapshot', 'pause', 'resume', 'abort', 'diff', 'stream']);
const TICKET_SCOPED_ACTIONS = new Set(['abort', 'diff', 'stream']);

// Same version source as `agb --version`: the manifest one level up. Both
// `mcp/server.mjs` and the bundled `dist/mcp-server.mjs` sit one directory
// below the package root, so this resolves bundled and unbundled alike.
function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
  } catch (err) {
    logDiagnostic(`could not read package.json version: ${err.message}`);
    return 'unknown';
  }
}

// Resolution of the agb CLI entry point (spec §4.1):
// 1. Bundled (`dist/mcp-server.mjs`, built with --define:__AGB_BUNDLED__=true):
//    the sibling bundle `dist/agb.mjs` in the same staged plugin directory.
// 2. Source checkout (`mcp/server.mjs`): the repository's `bin/agb.mjs`.
// 3. Otherwise fall back to an `agb` on PATH.
const IS_BUNDLED = typeof __AGB_BUNDLED__ !== 'undefined' && __AGB_BUNDLED__ === true;

export function resolveAgbEntry(dir = __dirname, bundled = IS_BUNDLED) {
  const candidate = bundled ? join(dir, 'agb.mjs') : join(dir, '..', 'bin', 'agb.mjs');
  if (bundled || existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
  return { cmd: 'agb', args: [] };
}

const { cmd: agbCmd, args: baseArgs } = resolveAgbEntry();

/** Diagnostics go to stderr only: stdout is reserved for JSON-RPC traffic. */
function logDiagnostic(message) {
  try {
    process.stderr.write(`[agb-mcp] ${message}\n`);
  } catch {
    // stderr closed: nothing safe left to report to.
  }
}

const TOOLS = [
  {
    name: 'agb_shape',
    description: 'Pre-analyze a structured spec or brain plan for DAG validity, scope overlaps, rails, and static import coupling before agb plan',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Path to spec.md or brain conversation ID/prefix' },
        repo: { type: 'string', description: 'Absolute path to the target repository' },
        syncBrain: { type: 'boolean', description: 'Sync formatted plan artifact to .booster/agb_plan_artifact.md and active brain session' },
        maxTicketScope: { type: 'number', description: 'Maximum recommended file scope per ticket before emitting a scope warning (default 12)' },
        strict: { type: 'boolean', description: 'Fail closed on coupling or scope warnings' }
      },
      required: ['spec', 'repo']
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/plan-card.html'
      }
    }
  },
  {
    name: 'agb_plan',
    description: 'Compile an Antigravity brain plan or spec file into plan.json',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Brain ID, prefix, or spec.md path to compile' },
        repo: { type: 'string', description: 'Absolute path to the target repository' },
        estimate: { type: 'boolean', description: 'Forecast wave-by-wave quota burn without writing plan.json or running Stage B LLM gates' },
        out: { type: 'string', description: 'Custom output file path (default plan.json)' },
        force: { type: 'boolean', description: 'Force overwrite the output file if it exists' },
        decompose: { type: 'boolean', description: 'Automatically split wide tickets exceeding maxTicketScope' },
        maxTicketScope: { type: 'number', description: 'Maximum files per ticket when decompose is enabled (default 3)' },
        noFastPath: { type: 'boolean', description: 'Disable zero-LLM structured Markdown fast-path and force LLM conversion' },
        noColdstart: { type: 'boolean', description: 'Skip coldstart plan gate' },
        noParallax: { type: 'boolean', description: 'Skip parallax spec ambiguity check' },
        noPremortem: { type: 'boolean', description: 'Skip premortem advisory risk gate' },
        emitWorkflow: { type: 'string', description: 'Optional output path for compiled run_workflow Python script' }
      },
      required: ['spec', 'repo']
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/plan-card.html'
      }
    }
  },
  {
    name: 'agb_distill',
    description: 'Scan repository review and prosecution logs for recurring finding patterns and stage or apply learned ADLC defenses',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository' },
        apply: { type: 'boolean', description: 'Write compacted defenses to .gemini/rules/adlc-learned.md' }
      },
      required: ['repo']
    }
  },
  {
    name: 'agb_run',
    description: 'Execute a compiled ticket DAG plan.json',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Path to plan.json file' },
        concurrency: {
          type: 'integer',
          minimum: 1,
          description: 'Optional maximum concurrent workers cap (-c <n>)'
        },
        resume: {
          type: 'boolean',
          description: 'Resume from previously merged tickets'
        },
        resetRescue: {
          type: 'boolean',
          description: 'Clear active or preserved rescue locks before running'
        }
      },
      required: ['plan']
    }
  },
  {
    name: 'agb_preflight',
    description: 'Run plan-level coldstart probes and forecast scope overlaps',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Path to plan.json file' },
        noColdstart: { type: 'boolean', description: 'Skip coldstart plan gate' }
      },
      required: ['plan']
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/plan-card.html'
      }
    }
  },
  {
    name: 'agb_status',
    description: 'Get execution status of a booster run in the target repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository' }
      },
      required: ['repo']
    }
  },
  {
    name: 'agb_doctor',
    description: 'Run diagnostic health check for tools, auth, and sandbox setup',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional path to target repository' },
        fix: { type: 'boolean', description: 'Automatically repair missing .adlc store, .gitignore, or companion plugin' }
      }
    }
  },
  {
    name: 'agb_init',
    description: 'Initialize a target repository for ADLC and Antigravity Booster (.adlc/config.json, specs/feature-template.md, .gitignore)',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository' }
      },
      required: ['repo']
    }
  },
  {
    name: 'agb_review',
    description: 'Deploy a read-only fleet of models to audit changes or a plan specification',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository' },
        ref: { type: 'string', description: 'Optional diff reference range (e.g. main...HEAD)' },
        plan: { type: 'string', description: 'Optional spec.md path to run 5-lens Plan ARL instead of diff review' },
        loop: { type: 'boolean', description: 'Run iterative ARL up to 3 rounds' },
        fiveLens: { type: 'boolean', description: 'Run 5-lens Code ARL (Correctness, Simplicity, Security, Evidence, Anti-Slop)' },
        arbiter: { type: 'boolean', description: 'Enable neutral arbiter triage (default true; pass false for --no-arbiter)' }
      },
      required: ['repo']
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/review-card.html'
      }
    }
  },
  {
    name: 'agb_flight_deck',
    description: 'Open the live AGB Flight Deck auxiliary pane to monitor and control active fleet runs',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository (defaults to cwd)' }
      }
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/flight-deck.html',
        surface: 'aux_pane',
        visibility: ['model', 'app']
      }
    }
  },
  {
    name: 'agb_mission_control',
    description: 'Open the global AGB Mission Control dashboard for 4-window quota gauges and model telemetry',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional path to target repository' }
      }
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/mission-control.html',
        surface: 'global',
        visibility: ['model', 'app']
      }
    }
  },
  {
    name: 'agb_plan_viewer',
    description: 'Inspect, validate, and edit a .agbplan or plan.json ticket DAG file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .agbplan or plan.json file' },
        repo: { type: 'string', description: 'Optional repository path' }
      },
      required: ['path']
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/plan-viewer.html',
        surface: 'file',
        extensions: ['.agbplan'],
        visibility: ['model', 'app']
      }
    }
  },
  {
    name: 'agb_control',
    description: 'Send authenticated control IPC or snapshot/diff/stream telemetry queries to an AGB run',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository (defaults to cwd)' },
        action: {
          type: 'string',
          enum: ['snapshot', 'pause', 'resume', 'abort', 'diff', 'stream'],
          description: 'Control or telemetry action'
        },
        ticketId: { type: 'string', description: 'Target ticket ID for abort, diff, or stream' },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max stream lines to return (default 40)'
        }
      },
      required: ['action']
    },
    _meta: {
      ui: {
        visibility: ['app']
      }
    }
  },
  {
    name: 'agb_accept',
    description: 'Inspect candidate diff hunks, external-caller blast radius, and gate manifest evidence for ADLC P6 human sign-off',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional path to target repository (defaults to cwd)' },
        base: { type: 'string', description: 'Optional git base ref (defaults to HEAD)' },
        verdicts: {
          type: 'object',
          description: 'Optional map of 64-char SHA-256 hunk fingerprints to accepted, flagged, or pending'
        },
        saveVerdicts: {
          type: 'boolean',
          description: 'Persist hunk verdicts to .booster/accept-state.json'
        }
      }
    },
    _meta: {
      ui: {
        resourceUri: 'ui://agb/accept-workbench.html',
        visibility: ['model', 'app']
      }
    }
  }
];

// No `output` stream: readline must never echo anything onto stdout.
if (IS_MAIN) {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      if (request.jsonrpc !== '2.0') {
        sendError(request.id, -32600, 'Invalid Request');
        return;
      }

      // Handle cancellation notification (standard MCP 2024-11-05 and legacy $/cancel)
      if (request.method === 'notifications/cancelled' || request.method === '$/cancel') {
        const cancelParams = request.params;
        const targetId = cancelParams?.requestId ?? cancelParams?.id;
        handleCancelNotification({ id: targetId });
        return;
      }

      // Ignore other notifications (messages without an ID)
      if (request.id === undefined || request.id === null) {
        return;
      }

      await handleRequest(request);
    } catch (err) {
      logDiagnostic(`parse error: ${err.message}`);
      sendError(null, -32700, `Parse error: ${err.message}`);
    }
  });
  rl.on('close', () => { cleanup(); process.exit(0); });
}

async function handleRequest(req) {
  const { method, params, id } = req;

  if (method === 'initialize') {
    const hasUiExtension = Boolean(params?.capabilities?.extensions?.['io.modelcontextprotocol/ui']);
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},
        ...(hasUiExtension ? { extensions: { 'io.modelcontextprotocol/ui': {} } } : {})
      },
      serverInfo: {
        name: 'antigravity-booster-mcp',
        version: readPackageVersion()
      }
    });
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'resources/list') {
    sendResult(id, { resources: UI_RESOURCES });
    return;
  }

  if (method === 'resources/read') {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    const rendered = uri ? renderUiResource(uri) : null;
    if (!rendered) {
      sendError(id, -32602, `Unknown resource URI: ${params?.uri}`);
      return;
    }
    sendResult(id, { contents: [rendered] });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    await handleToolCall(id, name, args || {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

function requireNonFlagString(args, key) {
  const val = args?.[key];
  if (typeof val !== 'string' || val.trim().length === 0) {
    return { ok: false, error: `Invalid or missing required string argument '${key}'` };
  }
  if (val.startsWith('-')) {
    return { ok: false, error: `Positional argument '${key}' must not start with '-'` };
  }
  return { ok: true, value: val };
}

function validateDirectory(dirPath, paramName, rawVal = dirPath) {
  let isDir = false;
  try {
    isDir = statSync(dirPath).isDirectory();
  } catch {}
  if (!isDir) {
    return { ok: false, error: `Invalid parameter '${paramName}': directory does not exist: ${rawVal}` };
  }
  return { ok: true };
}

function resolveSpecPath(rawSpec, targetCwd) {
  const specInTarget = resolve(targetCwd, rawSpec);
  const specInAmbient = resolve(rawSpec);
  if (existsSync(specInTarget)) return specInTarget;
  if (existsSync(specInAmbient)) return specInAmbient;
  if (isAbsolute(rawSpec) || rawSpec.includes('/') || rawSpec.includes('\\') || /\.(md|markdown|txt|json)$/i.test(rawSpec)) {
    return specInTarget;
  }
  return rawSpec;
}

function symlinkSecurityError(targetPath) {
  const err = new Error(`Security violation: symbolic link not allowed: ${targetPath}`);
  err.code = 'ESYMLINK';
  return err;
}

function lstatOrNull(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

function readRegularFileBounded(filePath, maxBytes = MAX_STRUCTURED_BYTES) {
  const st = lstatOrNull(filePath);
  if (!st) return { missing: true };
  if (st.isSymbolicLink()) throw symlinkSecurityError(filePath);
  if (!st.isFile()) {
    const err = new Error(`Refusing to read non-regular file: ${filePath}`);
    err.code = 'ENOTFILE';
    throw err;
  }
  if (st.size > maxBytes) {
    const err = new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
    err.code = 'ETOOBIG';
    throw err;
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch (err) {
    if (err?.code === 'ELOOP') throw symlinkSecurityError(filePath);
    if (err?.code === 'ENOENT') return { missing: true };
    throw err;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      const err = new Error(`Refusing to read non-regular file: ${filePath}`);
      err.code = 'ENOTFILE';
      throw err;
    }
    if (fst.size > maxBytes) {
      const err = new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
      err.code = 'ETOOBIG';
      throw err;
    }
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const err = new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
      err.code = 'ETOOBIG';
      throw err;
    }
    return { missing: false, text };
  } finally {
    closeSync(fd);
  }
}

function readJsonOrNull(filePath, maxBytes = 256 * 1024) {
  let res;
  try {
    res = readRegularFileBounded(filePath, maxBytes);
  } catch (err) {
    if (err?.code === 'ESYMLINK') throw err;
    return null;
  }
  if (res.missing) return null;
  try {
    const parsed = JSON.parse(res.text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readTailJsonl(filePath, { maxLines = 50, maxTailBytes = 192 * 1024 } = {}) {
  const st = lstatOrNull(filePath);
  if (!st) return [];
  if (st.isSymbolicLink()) throw symlinkSecurityError(filePath);
  if (!st.isFile()) return [];
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch (err) {
    if (err?.code === 'ELOOP') throw symlinkSecurityError(filePath);
    return [];
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size === 0) return [];
    const readLen = Math.min(fst.size, maxTailBytes);
    const offset = fst.size - readLen;
    const buf = Buffer.alloc(readLen);
    const bytesRead = readSync(fd, buf, 0, readLen, offset);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl === -1 ? '' : text.slice(firstNl + 1);
    }
    const items = [];
    for (const rawLine of text.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          items.push(parsed);
        }
      } catch {}
    }
    return items.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

function inspectBoosterDir(repo) {
  const rawRepo = resolve(repo);
  const rawBooster = join(rawRepo, '.booster');
  const rawSt = lstatOrNull(rawBooster);
  if (rawSt && rawSt.isSymbolicLink()) {
    throw symlinkSecurityError(rawBooster);
  }

  let canonicalRepo = rawRepo;
  try {
    canonicalRepo = realpathSync(rawRepo);
  } catch {}

  const boosterDir = join(canonicalRepo, '.booster');
  const boosterSt = lstatOrNull(boosterDir);
  if (!boosterSt) {
    return { resolvedRepo: rawRepo, canonicalRepo, boosterDir, exists: false };
  }
  if (boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) {
    throw symlinkSecurityError(boosterDir);
  }
  for (const sub of [
    'run.json',
    'report.json',
    'model_stats.jsonl',
    'rescue-latest',
    'factory_ledger.jsonl',
    'accept-state.json',
    'accept-dossier.md',
  ]) {
    const p = join(boosterDir, sub);
    const st = lstatOrNull(p);
    if (st && st.isSymbolicLink()) {
      throw symlinkSecurityError(p);
    }
  }
  return { resolvedRepo: rawRepo, canonicalRepo, boosterDir, exists: true };
}

function sliceUtf8(str, maxBytes) {
  const s = String(str ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  return Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
}

function boundStructuredObject(obj, fallbackFactory) {
  const encoded = JSON.stringify(obj);
  if (Buffer.byteLength(encoded, 'utf8') < MAX_STRUCTURED_BYTES) {
    return obj;
  }
  return fallbackFactory();
}

export async function buildSnapshotPayload(repo) {
  const { resolvedRepo, boosterDir, exists } = inspectBoosterDir(repo);
  const run = exists ? readJsonOrNull(join(boosterDir, 'run.json'), 192 * 1024) : null;
  const report = exists ? readJsonOrNull(join(boosterDir, 'report.json'), 192 * 1024) : null;
  const quotaCache = readFreshStatusLineQuotaCache();
  const modelStats = exists ? readTailJsonl(join(boosterDir, 'model_stats.jsonl'), { maxLines: 50 }) : [];
  let economics = null;
  try {
    economics = new FactoryLedger({ repo: resolvedRepo }).summarizeEconomics({ recentLimit: 10 });
  } catch (err) {
    if (err?.code === 'ESYMLINK' || /symbolic link/i.test(String(err?.message ?? ''))) {
      throw err;
    }
    economics = null;
  }

  const rawControl = await sendControlCommand(resolvedRepo, { action: 'status' });
  if (rawControl?.error && /symbolic link/i.test(rawControl.error)) {
    throw symlinkSecurityError(join(boosterDir, 'control.json'));
  }
  const control = rawControl && typeof rawControl === 'object'
    ? (rawControl.ok ? rawControl : { ok: false, offline: true, ...(rawControl.error ? { error: rawControl.error } : {}) })
    : { ok: false, offline: true };

  const snapshot = {
    ok: true,
    repo: resolvedRepo,
    run,
    report,
    control,
    quotaCache,
    modelStats,
    economics,
  };

  return boundStructuredObject(snapshot, () => ({
    ok: true,
    repo: resolvedRepo,
    run: run ? { runId: run.runId ?? null, done: run.done ?? null, startedAt: run.startedAt ?? null, truncated: true } : null,
    report: report ? { runId: report.runId ?? null, merged: Array.isArray(report.merged) ? report.merged : [], truncated: true } : null,
    control,
    quotaCache,
    modelStats: modelStats.slice(-20),
    economics: economics ? { ...economics, recentRuns: [] } : null,
    truncated: true,
  }));
}

function sendToolError(id, message) {
  sendResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function resolveOptionalRepoArg(args) {
  if (args?.repo === undefined) {
    return { ok: true, repo: process.cwd() };
  }
  const repoCheck = requireNonFlagString(args, 'repo');
  if (!repoCheck.ok) return repoCheck;
  const resolved = resolve(repoCheck.value);
  const dirCheck = validateDirectory(resolved, 'repo', repoCheck.value);
  if (!dirCheck.ok) return dirCheck;
  return { ok: true, repo: resolved };
}

function assertNoSymlinkSegments(baseDir, targetPath) {
  const rel = relative(baseDir, targetPath);
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    let cur = baseDir;
    for (const seg of rel.split(sep).filter(Boolean)) {
      cur = join(cur, seg);
      const st = lstatOrNull(cur);
      if (st && st.isSymbolicLink()) {
        throw symlinkSecurityError(cur);
      }
    }
  }
  const finalSt = lstatOrNull(targetPath);
  if (finalSt && finalSt.isSymbolicLink()) {
    throw symlinkSecurityError(targetPath);
  }
}

async function handleInProcessUiTool(id, name, args) {
  if (name === 'agb_flight_deck' || name === 'agb_mission_control') {
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    try {
      const snap = await buildSnapshotPayload(repoRes.repo);
      const surface = name === 'agb_flight_deck' ? 'aux_pane' : 'global';
      const structuredContent = boundStructuredObject(
        { ...snap, surface },
        () => ({ ...snap, modelStats: [], surface, truncated: true })
      );
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              runId: snap.run?.runId ?? null,
              done: snap.run?.done ?? null,
              offline: Boolean(snap.control?.offline),
            }),
          },
        ],
        structuredContent,
      });
    } catch (err) {
      sendToolError(id, err.message);
    }
    return;
  }

  if (name === 'agb_plan_viewer') {
    const pathCheck = requireNonFlagString(args, 'path');
    if (!pathCheck.ok) {
      sendToolError(id, pathCheck.error);
      return;
    }
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    const planFile = resolve(repoRes.repo, pathCheck.value);
    let fileData;
    try {
      assertNoSymlinkSegments(repoRes.repo, planFile);
      fileData = readRegularFileBounded(planFile, MAX_STRUCTURED_BYTES);
    } catch (err) {
      sendToolError(id, err.message);
      return;
    }
    if (fileData.missing) {
      sendToolError(id, `Plan file does not exist: ${planFile}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fileData.text);
    } catch (err) {
      sendToolError(id, `Invalid JSON in plan file ${planFile}: ${err.message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendToolError(id, `Invalid plan object in ${planFile}`);
      return;
    }
    const errors = validatePlan(parsed);
    const quotaCache = readFreshStatusLineQuotaCache();
    let runwayEstimate = null;
    if (errors.length === 0) {
      try {
        runwayEstimate = estimatePlanQuotaRunway(parsed, { quota: quotaCache?.quota ?? null });
      } catch {
        runwayEstimate = null;
      }
    }
    const structuredContent = {
      ok: errors.length === 0,
      path: planFile,
      plan: parsed,
      validationErrors: errors,
      quotaCache,
      runwayEstimate,
    };
    if (Buffer.byteLength(JSON.stringify(structuredContent), 'utf8') >= MAX_STRUCTURED_BYTES) {
      sendToolError(id, `Plan payload exceeds 512 KiB limit: ${planFile}`);
      return;
    }
    sendResult(id, {
      content: [
        {
          type: 'text',
          text: `Plan ${basename(planFile)}: ${(parsed.tickets ?? []).length} ticket(s)`,
        },
      ],
      structuredContent,
    });
    return;
  }

  if (name === 'agb_accept') {
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    let base = 'HEAD';
    if (args?.base !== undefined) {
      const baseCheck = requireNonFlagString(args, 'base');
      if (!baseCheck.ok) {
        sendToolError(id, baseCheck.error);
        return;
      }
      base = baseCheck.value.trim();
    }
    if (args?.saveVerdicts !== undefined && typeof args.saveVerdicts !== 'boolean') {
      sendToolError(id, 'Invalid saveVerdicts: expected boolean');
      return;
    }
    let cleanVerdicts = null;
    if (args?.verdicts !== undefined) {
      if (!args.verdicts || typeof args.verdicts !== 'object' || Array.isArray(args.verdicts)) {
        sendToolError(id, 'Invalid verdicts: expected object mapping 64-hex SHA-256 fingerprints to accepted, flagged, or pending');
        return;
      }
      cleanVerdicts = {};
      for (const [fp, val] of Object.entries(args.verdicts)) {
        if (!/^[0-9a-f]{64}$/.test(fp)) {
          sendToolError(id, `Invalid hunk fingerprint key '${fp}': expected 64-char lowercase hex SHA-256`);
          return;
        }
        if (val !== 'accepted' && val !== 'flagged' && val !== 'pending') {
          sendToolError(id, `Invalid verdict '${String(val)}' for ${fp}`);
          return;
        }
        cleanVerdicts[fp] = val;
      }
    }
    try {
      inspectBoosterDir(repoRes.repo);
      if (args?.saveVerdicts === true) {
        saveAcceptVerdicts(repoRes.repo, cleanVerdicts ?? {}, { merge: true });
      }
      const dossier = buildAcceptanceDossier({
        repo: repoRes.repo,
        base,
        verdictsOverride: args?.saveVerdicts === true ? null : cleanVerdicts,
      });
      const markdown = sliceUtf8(formatAcceptanceDossierMarkdown(dossier), 64 * 1024);
      const structuredContent = boundStructuredObject(
        { ...dossier, markdown },
        () => ({
          ...dossier,
          hunks: dossier.hunks.slice(0, 40).map((h) => ({ ...h, lines: h.lines.slice(0, 20) })),
          markdown,
          truncated: true,
        })
      );
      sendResult(id, {
        content: [{ type: 'text', text: markdown }],
        structuredContent,
      });
    } catch (err) {
      sendToolError(id, err.message);
    }
    return;
  }

  if (name === 'agb_control') {
    const action = args?.action;
    if (typeof action !== 'string' || !CONTROL_ACTIONS.has(action)) {
      sendToolError(id, `Invalid or missing control action: ${String(action)}`);
      return;
    }
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    let ticketId;
    if (TICKET_SCOPED_ACTIONS.has(action)) {
      if (typeof args?.ticketId !== 'string' || !args.ticketId.trim() || !TICKET_ID_RE.test(args.ticketId.trim())) {
        sendToolError(id, `Action '${action}' requires a valid non-empty ticketId`);
        return;
      }
      ticketId = args.ticketId.trim();
    } else if (args?.ticketId !== undefined) {
      if (typeof args.ticketId !== 'string' || !args.ticketId.trim() || !TICKET_ID_RE.test(args.ticketId.trim())) {
        sendToolError(id, `Invalid ticketId: ${String(args.ticketId)}`);
        return;
      }
      ticketId = args.ticketId.trim();
    }

    let lines;
    if (args?.lines !== undefined) {
      if (typeof args.lines !== 'number' || !Number.isInteger(args.lines) || args.lines < 1 || args.lines > 200) {
        sendToolError(id, 'Invalid lines: expected integer between 1 and 200');
        return;
      }
      lines = args.lines;
    }

    const targetRepo = repoRes.repo;
    let boosterInfo;
    try {
      boosterInfo = inspectBoosterDir(targetRepo);
    } catch (err) {
      sendToolError(id, err.message);
      return;
    }

    if (action === 'snapshot') {
      try {
        const snap = await buildSnapshotPayload(targetRepo);
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(snap) }],
          structuredContent: snap,
        });
      } catch (err) {
        sendToolError(id, err.message);
      }
      return;
    }

    if (action === 'diff') {
      const res = await sendControlCommand(targetRepo, { action: 'diff', ticketId });
      if (res?.error && /symbolic link/i.test(res.error)) {
        sendToolError(id, res.error);
        return;
      }
      if (res && res.ok === true) {
        const diffText = sliceUtf8(typeof res.diff === 'string' ? res.diff : '', 384 * 1024);
        const structuredContent = {
          ...res,
          ok: true,
          offline: false,
          ticketId: res.ticketId ?? ticketId,
          diff: diffText,
        };
        sendResult(id, {
          content: [{ type: 'text', text: diffText || JSON.stringify(structuredContent) }],
          structuredContent,
          isError: false,
        });
        return;
      }

      if (res?.offline === true) {
        const rescueDir = join(boosterInfo.boosterDir, 'rescue-latest');
        try {
          const dirSt = lstatOrNull(rescueDir);
          if (dirSt && (dirSt.isSymbolicLink() || !dirSt.isDirectory())) {
            throw symlinkSecurityError(rescueDir);
          }
          const latestFile = join(rescueDir, `${ticketId.toLowerCase()}.json`);
          const saved = dirSt ? readJsonOrNull(latestFile, 384 * 1024) : null;
          if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            const diffText = sliceUtf8(typeof saved.diff === 'string' ? saved.diff : '', 384 * 1024);
            const structuredContent = {
              ok: true,
              offline: true,
              ticketId,
              diff: diffText,
            };
            sendResult(id, {
              content: [{ type: 'text', text: diffText || JSON.stringify(structuredContent) }],
              structuredContent,
              isError: false,
            });
            return;
          }
        } catch (err) {
          if (err?.code === 'ESYMLINK') {
            sendToolError(id, err.message);
            return;
          }
        }
        const missPayload = {
          ok: false,
          offline: true,
          ticketId,
          diff: '',
          error: 'no active run or saved rescue snapshot',
        };
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(missPayload) }],
          structuredContent: missPayload,
          isError: false,
        });
        return;
      }

      const failPayload = {
        ok: false,
        offline: false,
        action: 'diff',
        ticketId,
        diff: '',
        error: res?.error ?? 'control command failed',
      };
      sendResult(id, {
        content: [{ type: 'text', text: JSON.stringify(failPayload) }],
        structuredContent: failPayload,
        isError: false,
      });
      return;
    }

    // 'pause', 'resume', 'abort', 'stream'
    const cmdPayload = {
      action,
      ...(ticketId ? { ticketId } : {}),
      ...(lines !== undefined ? { lines } : {}),
    };
    const res = await sendControlCommand(targetRepo, cmdPayload);
    if (res?.error && /symbolic link/i.test(res.error)) {
      sendToolError(id, res.error);
      return;
    }
    if (res && res.ok === true) {
      const structuredContent = boundStructuredObject(
        {
          ...res,
          ok: true,
          offline: false,
          action,
          ...(ticketId ? { ticketId: res.ticketId ?? ticketId } : {}),
        },
        () => ({
          ok: true,
          offline: false,
          action,
          ...(ticketId ? { ticketId } : {}),
          ...(action === 'stream' && Array.isArray(res.lines) ? { lines: res.lines.slice(-40).map((l) => sliceUtf8(l, 2048)) } : {}),
          truncated: true,
        })
      );
      sendResult(id, {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false,
      });
      return;
    }

    const structuredContent = {
      ok: false,
      offline: Boolean(res?.offline),
      action,
      ticketId: ticketId ?? null,
      ...(action === 'stream' ? { lines: [] } : {}),
      error: res?.error ?? 'control command failed',
    };
    sendResult(id, {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    });
  }
}

function buildCliStructuredContent(name, stdout, stderr, exitCode, planOutPath = null) {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (name === 'agb_plan' && exitCode === 0 && !Array.isArray(parsed.tickets) && planOutPath) {
          try {
            const compiled = readJsonOrNull(planOutPath, 256 * 1024);
            if (compiled && Array.isArray(compiled.tickets)) {
              parsed.tickets = compiled.tickets;
            }
          } catch {}
        }
        if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') < MAX_STRUCTURED_BYTES) {
          return parsed;
        }
      }
    } catch {
      // Non-JSON CLI output: fall back to bounded rawText object.
    }
  }
  const rawSource = trimmed || stderr.trim();
  return {
    ok: exitCode === 0,
    rawText: sliceUtf8(rawSource.slice(0, 262144), 262144),
    exitCode: exitCode ?? 1,
  };
}

async function handleToolCall(id, name, args) {
  if (
    name === 'agb_flight_deck' ||
    name === 'agb_mission_control' ||
    name === 'agb_plan_viewer' ||
    name === 'agb_control' ||
    name === 'agb_accept'
  ) {
    await handleInProcessUiTool(id, name, args);
    return;
  }

  let cliArgs = [...baseArgs];
  let targetCwd;
  let planOutPath = null;

  if (name === 'agb_shape') {
    const specCheck = requireNonFlagString(args, 'spec');
    if (!specCheck.ok) { sendError(id, -32602, specCheck.error); return; }
    const repoCheck = requireNonFlagString(args, 'repo');
    if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
    targetCwd = resolve(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, 'repo', repoCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    const resolvedSpec = resolveSpecPath(specCheck.value, targetCwd);
    cliArgs.push('shape', resolvedSpec, targetCwd, '--json');
    if (args.syncBrain) cliArgs.push('--sync-brain');
    if (args.maxTicketScope !== undefined) {
      const n = Number(args.maxTicketScope);
      if (!Number.isInteger(n) || n <= 0) {
        sendError(id, -32602, `Invalid maxTicketScope: expected positive integer`);
        return;
      }
      cliArgs.push('--max-ticket-scope', String(n));
    }
    if (args.strict) cliArgs.push('--strict');
  } else if (name === 'agb_plan') {
    const specCheck = requireNonFlagString(args, 'spec');
    if (!specCheck.ok) { sendError(id, -32602, specCheck.error); return; }
    const repoCheck = requireNonFlagString(args, 'repo');
    if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
    targetCwd = resolve(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, 'repo', repoCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    if (args.estimate !== undefined && typeof args.estimate !== 'boolean') {
      sendError(id, -32602, 'Invalid estimate: expected boolean');
      return;
    }
    const resolvedSpec = resolveSpecPath(specCheck.value, targetCwd);
    cliArgs.push('plan', resolvedSpec, targetCwd);
    if (args.estimate === true) {
      cliArgs.push('--estimate', '--json');
    } else if (args.out !== undefined) {
      const outCheck = requireNonFlagString(args, 'out');
      if (!outCheck.ok) { sendError(id, -32602, outCheck.error); return; }
      planOutPath = resolve(targetCwd, outCheck.value);
      cliArgs.push('--out', planOutPath);
    } else {
      planOutPath = resolve(targetCwd, 'plan.json');
      cliArgs.push('--out', planOutPath);
    }
    if (args.force) cliArgs.push('--force');
    if (args.decompose) cliArgs.push('--decompose');
    if (args.maxTicketScope !== undefined) {
      const n = Number(args.maxTicketScope);
      if (!Number.isInteger(n) || n <= 0) {
        sendError(id, -32602, `Invalid maxTicketScope: expected positive integer`);
        return;
      }
      cliArgs.push('--max-ticket-scope', String(n));
    }
    if (args.noFastPath) cliArgs.push('--no-fast-path');
    if (args.noColdstart) cliArgs.push('--no-coldstart');
    if (args.noParallax) cliArgs.push('--no-parallax');
    if (args.noPremortem) cliArgs.push('--no-premortem');
    if (args.emitWorkflow !== undefined) {
      const wfCheck = requireNonFlagString(args, 'emitWorkflow');
      if (!wfCheck.ok) { sendError(id, -32602, wfCheck.error); return; }
      cliArgs.push('--emit-workflow', resolve(targetCwd, wfCheck.value));
    }
  } else if (name === 'agb_distill') {
    const repoCheck = requireNonFlagString(args, 'repo');
    if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
    targetCwd = resolve(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, 'repo', repoCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('distill', targetCwd, '--json');
    if (args.apply) cliArgs.push('--apply');
  } else if (name === 'agb_run') {
    const planCheck = requireNonFlagString(args, 'plan');
    if (!planCheck.ok) { sendError(id, -32602, planCheck.error); return; }
    let concurrency;
    if (args.concurrency !== undefined) {
      if (typeof args.concurrency !== 'number' || !Number.isInteger(args.concurrency) || args.concurrency < 1) {
        sendError(id, -32602, 'Invalid concurrency: expected integer >= 1');
        return;
      }
      concurrency = args.concurrency;
    }
    if (args.resume !== undefined && typeof args.resume !== 'boolean') {
      sendError(id, -32602, 'Invalid resume: expected boolean');
      return;
    }
    if (args.resetRescue !== undefined && typeof args.resetRescue !== 'boolean') {
      sendError(id, -32602, 'Invalid resetRescue: expected boolean');
      return;
    }
    const absPlan = resolve(planCheck.value);
    targetCwd = dirname(absPlan);
    const dirCheck = validateDirectory(targetCwd, 'plan', planCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('run', absPlan);
    if (concurrency !== undefined) {
      cliArgs.push('-c', String(concurrency));
    }
    if (args.resume) {
      cliArgs.push('--resume');
    }
    if (args.resetRescue) {
      cliArgs.push('--reset-rescue');
    }
  } else if (name === 'agb_preflight') {
    const planCheck = requireNonFlagString(args, 'plan');
    if (!planCheck.ok) { sendError(id, -32602, planCheck.error); return; }
    const absPlan = resolve(planCheck.value);
    targetCwd = dirname(absPlan);
    const dirCheck = validateDirectory(targetCwd, 'plan', planCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('preflight', absPlan);
    if (args.noColdstart) cliArgs.push('--no-coldstart');
  } else if (name === 'agb_status') {
    const repoCheck = requireNonFlagString(args, 'repo');
    if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
    targetCwd = resolve(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, 'repo', repoCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('status', targetCwd);
  } else if (name === 'agb_doctor') {
    if (args.repo !== undefined) {
      const repoCheck = requireNonFlagString(args, 'repo');
      if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
      const resolvedRepo = resolve(repoCheck.value);
      const dirCheck = validateDirectory(resolvedRepo, 'repo', repoCheck.value);
      if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
      targetCwd = resolvedRepo;
      cliArgs.push('doctor', targetCwd);
    } else {
      cliArgs.push('doctor');
    }
    if (args.fix) cliArgs.push('--fix');
  } else if (name === 'agb_init') {
    const repoCheck = requireNonFlagString(args, 'repo');
    if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
    targetCwd = resolve(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, 'repo', repoCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('init', targetCwd);
  } else if (name === 'agb_review') {
    const repoCheck = requireNonFlagString(args, 'repo');
    if (!repoCheck.ok) { sendError(id, -32602, repoCheck.error); return; }
    targetCwd = resolve(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, 'repo', repoCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('review', targetCwd);
    if (args.ref !== undefined) {
      const refCheck = requireNonFlagString(args, 'ref');
      if (!refCheck.ok) { sendError(id, -32602, refCheck.error); return; }
      cliArgs.push(refCheck.value);
    }
    if (args.plan !== undefined) {
      const planCheck = requireNonFlagString(args, 'plan');
      if (!planCheck.ok) { sendError(id, -32602, planCheck.error); return; }
      cliArgs.push('--plan', resolveSpecPath(planCheck.value, targetCwd));
    }
    if (args.loop) cliArgs.push('--loop');
    if (args.fiveLens) cliArgs.push('--five-lens');
    if (args.arbiter === false || args.noArbiter === true) cliArgs.push('--no-arbiter');
  } else {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  // Spawn agb CLI execution
  try {
    const spawnOpts = {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    };
    if (targetCwd) {
      spawnOpts.cwd = targetCwd;
    }
    const child = spawn(agbCmd, cliArgs, spawnOpts);

    activeProcesses.set(id, child);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data;
    });

    child.stderr.on('data', (data) => {
      stderr += data;
    });

    let responded = false;

    child.on('close', (code) => {
      activeProcesses.delete(id);
      if (responded) return;
      responded = true;
      if (cancelledRequests.has(id)) {
        cancelledRequests.delete(id);
        sendError(id, -32800, 'Request cancelled');
        return;
      }
      const output = stdout.trim() + (stderr ? '\nStderr:\n' + stderr.trim() : '');
      const resultPayload = {
        content: [
          {
            type: 'text',
            text: output || (code === 0 ? 'Executed successfully' : `Command failed with exit code ${code}`)
          }
        ],
        isError: code !== 0
      };
      if (CLI_UI_TOOLS.has(name)) {
        resultPayload.structuredContent = buildCliStructuredContent(name, stdout, stderr, code, planOutPath);
      }
      sendResult(id, resultPayload);
    });

    child.on('error', (err) => {
      activeProcesses.delete(id);
      if (responded) return;
      responded = true;
      if (cancelledRequests.has(id)) cancelledRequests.delete(id);
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: `Failed to execute: ${err.message}`
          }
        ],
        isError: true
      });
    });
  } catch (err) {
    sendResult(id, {
      content: [
        {
          type: 'text',
          text: `Spawn error: ${err.message}`
        }
      ],
      isError: true
    });
  }
}

function sendResult(id, result) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  }) + '\n');
}

function handleCancelNotification(params) {
  const targetId = params?.id;
  if (targetId !== undefined && activeProcesses.has(targetId)) {
    cancelledRequests.add(targetId);
    const child = activeProcesses.get(targetId);
    try {
      child.kill('SIGTERM');
    } catch (e) {
      logDiagnostic(`cancel ${targetId}: ${e.message}`);
    }
  }
}

function cleanup() {
  for (const [id, child] of activeProcesses.entries()) {
    try {
      child.kill('SIGTERM');
    } catch (e) {
      logDiagnostic(`cleanup ${id}: ${e.message}`);
    }
  }
  activeProcesses.clear();
}

if (IS_MAIN) {
  process.on('uncaughtException', (err) => {
    logDiagnostic(`uncaught exception: ${err?.stack || err}`);
  });
  process.on('unhandledRejection', (err) => {
    logDiagnostic(`unhandled rejection: ${err?.stack || err}`);
  });
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
