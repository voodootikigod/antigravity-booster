import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_MAIN = process.argv[1] && (
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('/mcp/server.mjs') ||
  process.argv[1].endsWith('/dist/mcp-server.mjs')
);

const activeProcesses = new Map();
const cancelledRequests = new Set();

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
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
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

async function handleToolCall(id, name, args) {
  let cliArgs = [...baseArgs];
  let targetCwd;

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
    const resolvedSpec = resolveSpecPath(specCheck.value, targetCwd);
    cliArgs.push('plan', resolvedSpec, targetCwd);
    if (args.out !== undefined) {
      const outCheck = requireNonFlagString(args, 'out');
      if (!outCheck.ok) { sendError(id, -32602, outCheck.error); return; }
      cliArgs.push('--out', resolve(targetCwd, outCheck.value));
    } else {
      cliArgs.push('--out', resolve(targetCwd, 'plan.json'));
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
    const absPlan = resolve(planCheck.value);
    targetCwd = dirname(absPlan);
    const dirCheck = validateDirectory(targetCwd, 'plan', planCheck.value);
    if (!dirCheck.ok) { sendError(id, -32602, dirCheck.error); return; }
    cliArgs.push('run', absPlan);
    if (concurrency !== undefined) {
      cliArgs.push('-c', String(concurrency));
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
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: output || (code === 0 ? 'Executed successfully' : `Command failed with exit code ${code}`)
          }
        ],
        isError: code !== 0
      });
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
