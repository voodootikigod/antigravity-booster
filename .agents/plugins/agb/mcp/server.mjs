import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const activeProcesses = new Map();


// Smart resolution of agb executable:
// 1. If running locally in dev/test, use the repository source file
// 2. Otherwise, fall back to global 'agb' CLI on the system PATH
let agbCmd = 'agb';
let baseArgs = [];

const localBin = join(__dirname, '..', '..', '..', '..', 'bin', 'agb.mjs');
if (existsSync(localBin)) {
  agbCmd = process.execPath;
  baseArgs = [localBin];
}

const TOOLS = [
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
        noColdstart: { type: 'boolean', description: 'Skip coldstart plan gate' },
        noParallax: { type: 'boolean', description: 'Skip parallax spec ambiguity check' },
        noPremortem: { type: 'boolean', description: 'Skip premortem advisory risk gate' }
      },
      required: ['spec', 'repo']
    }
  },
  {
    name: 'agb_run',
    description: 'Execute a compiled ticket DAG plan.json',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Path to plan.json file' },
        concurrency: { type: 'integer', description: 'Override default concurrency cap' }
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
        plan: { type: 'string', description: 'Path to plan.json file' }
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
      properties: {}
    }
  },
  {
    name: 'agb_review',
    description: 'Deploy a read-only fleet of models to audit changes',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to target repository' },
        ref: { type: 'string', description: 'Optional diff reference range (e.g. main...HEAD)' }
      },
      required: ['repo']
    }
  }
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
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
    
    // Handle cancellation notification
    if (request.method === '$/cancel') {
      handleCancelNotification(request.params);
      return;
    }

    // Ignore other notifications (messages without an ID)
    if (request.id === undefined || request.id === null) {
      return;
    }


    await handleRequest(request);
  } catch (err) {
    sendError(null, -32700, `Parse error: ${err.message}`);
  }
});

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
        version: '0.7.0'
      }
    });
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

async function handleToolCall(id, name, args) {
  let cliArgs = [...baseArgs];
  
  if (name === 'agb_plan') {
    cliArgs.push('plan', args.spec, args.repo);
    if (args.out) cliArgs.push('--out', args.out);
    if (args.force) cliArgs.push('--force');
    if (args.noColdstart) cliArgs.push('--no-coldstart');
    if (args.noParallax) cliArgs.push('--no-parallax');
    if (args.noPremortem) cliArgs.push('--no-premortem');
  } else if (name === 'agb_run') {
    cliArgs.push('run', args.plan);
    if (args.concurrency !== undefined) cliArgs.push('--concurrency', String(args.concurrency));
  } else if (name === 'agb_preflight') {
    cliArgs.push('preflight', args.plan);
  } else if (name === 'agb_status') {
    cliArgs.push('status', args.repo);
  } else if (name === 'agb_doctor') {
    cliArgs.push('doctor');
  } else if (name === 'agb_review') {
    cliArgs.push('review', args.repo);
    if (args.ref) cliArgs.push(args.ref);
  } else {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  // Spawn agb CLI execution
  try {
    const child = spawn(agbCmd, cliArgs, {
      env: { ...process.env, AGB_PROVIDER: 'jetski' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeProcesses.set(id, child);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data;
    });

    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('close', (code) => {
      activeProcesses.delete(id);
      const output = stdout.trim() + (stderr ? '\nStderr:\n' + stderr.trim() : '');
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: output || `Executed successfully (exit code ${code})`
          }
        ],
        isError: code !== 0
      });
    });

    child.on('error', (err) => {
      activeProcesses.delete(id);
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
    const child = activeProcesses.get(targetId);
    try {
      child.kill('SIGTERM');
    } catch (e) {}
    activeProcesses.delete(targetId);
  }
}

function cleanup() {
  for (const [id, child] of activeProcesses.entries()) {
    try {
      child.kill('SIGTERM');
    } catch (e) {}
  }
  activeProcesses.clear();
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
rl.on('close', () => { cleanup(); process.exit(0); });

