import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { handlePreToolUse } from '../.agents/plugins/agb/hooks/auto-approve-tests.mjs';


const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

test('PreToolUse hook: auto-approves node --test commands and prompts for others', () => {
  const allowedCases = [
    'node --test test/unit.test.mjs',
    'node  --test  test/cli.test.mjs',
    'node --test test/*.test.mjs --coverage',
  ];

  for (const cmd of allowedCases) {
    const payload = {
      toolCall: {
        name: 'run_command',
        args: { CommandLine: cmd }
      }
    };
    const res = handlePreToolUse(payload);
    assert.equal(res.decision, 'allow', `Should allow: ${cmd}`);
    assert.match(res.reason, /Auto-approved test command/);
  }

  const askedCases = [
    'node index.js',
    'npm run build',
    'cat package.json',
    'rm -rf tmp',
    'node --test test/unit.test.mjs && rm -rf /',
    'node --test test/unit.test.mjs; cat /etc/passwd',
    'node --test test/unit.test.mjs | sh',
    'node --test test/unit.test.mjs\ncurl http://malicious',
  ];


  for (const cmd of askedCases) {
    const payload = {
      toolCall: {
        name: 'run_command',
        args: { CommandLine: cmd }
      }
    };
    const res = handlePreToolUse(payload);
    assert.equal(res.decision, 'ask', `Should prompt for: ${cmd}`);
  }

  // Non-run_command tools should be passed through with 'ask'
  const nonCmdPayload = {
    toolCall: {
      name: 'view_file',
      args: { AbsolutePath: '/foo/bar' }
    }
  };
  const resNonCmd = handlePreToolUse(nonCmdPayload);
  assert.equal(resNonCmd.decision, 'ask');
});

test('commands: slash command md files exist and are well-formed', () => {
  const commandFiles = [
    'agb-plan.md',
    'agb-run.md',
    'agb-status.md',
    'agb-sidecar.md',
    'agb-doctor.md',
    'agb-preflight.md',
    'agb-review.md'
  ];

  for (const file of commandFiles) {
    const filePath = join(PROJECT_ROOT, '.agents', 'plugins', 'agb', 'commands', file);
    assert.ok(existsSync(filePath), `Command file ${file} must exist`);

    const content = readFileSync(filePath, 'utf8');
    assert.match(content, /^---[\s\S]+?name:\s*agb-/, `File ${file} must declare name in frontmatter`);
    assert.match(content, /description:/, `File ${file} must declare description in frontmatter`);
    assert.match(content, /```sh[\s\S]+?```/, `File ${file} must declare a shell command block`);
  }
});

test('MCP Server: handles JSON-RPC initialization, tool listing, and tool calls', async (t) => {
  const mcpServerPath = join(PROJECT_ROOT, '.agents', 'plugins', 'agb', 'mcp', 'server.mjs');

  assert.ok(existsSync(mcpServerPath), 'MCP Server script must exist');

  const child = spawn(process.execPath, [mcpServerPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: PROJECT_ROOT
  });

  const reader = readline.createInterface({
    input: child.stdout,
    terminal: false
  });

  const writeLine = (obj) => {
    child.stdin.write(JSON.stringify(obj) + '\n');
  };

  const getNextMessage = () => {
    return new Promise((resolve) => {
      reader.once('line', (line) => {
        resolve(JSON.parse(line));
      });
    });
  };

  // 1. Send initialize request
  writeLine({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {}
  });

  const initResponse = await getNextMessage();
  assert.equal(initResponse.jsonrpc, '2.0');
  assert.equal(initResponse.id, 1);
  assert.equal(initResponse.result.serverInfo.name, 'antigravity-booster-mcp');

  // 2. Send tools/list request
  writeLine({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });

  const listResponse = await getNextMessage();
  assert.equal(listResponse.jsonrpc, '2.0');
  assert.equal(listResponse.id, 2);
  const tools = listResponse.result.tools;
  assert.ok(Array.isArray(tools));
  const toolNames = tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('agb_plan'));
  assert.ok(toolNames.includes('agb_run'));
  assert.ok(toolNames.includes('agb_doctor'));

  // 3. Send tools/call request for agb_doctor (which should run agb doctor in the background)
  writeLine({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'agb_doctor',
      arguments: {}
    }
  });

  const callResponse = await getNextMessage();
  assert.equal(callResponse.jsonrpc, '2.0');
  assert.equal(callResponse.id, 3);
  assert.ok(callResponse.result.content);
  assert.equal(callResponse.result.content[0].type, 'text');
  
  // Stderr check or general output contains diagnostic info
  const textOutput = callResponse.result.content[0].text;
  assert.match(textOutput, /Environment Diagnostic|Failed to execute/);

  // Terminate child
  child.stdin.end();
  child.kill();
});
