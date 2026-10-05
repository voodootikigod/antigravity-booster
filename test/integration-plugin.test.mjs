import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';


const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

test('PreToolUse: the legacy auto-approve-tests hook is gone and no hook registration emits allow (D7)', () => {
  assert.ok(!existsSync(join(PROJECT_ROOT, '.agents', 'plugins', 'agb', 'hooks', 'auto-approve-tests.mjs')));
  assert.ok(!existsSync(join(PROJECT_ROOT, '.agents', 'plugins', 'agb', 'hooks.json')));
  const hooks = JSON.parse(readFileSync(join(PROJECT_ROOT, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks), ['agb-policy-guard'], 'root hooks.json is the only hook registration');
});

test('commands: slash command md files exist and are well-formed', () => {
  const commandFiles = [
    'agb-plan.md',
    'agb-run.md',
    'agb-review.md',
    'agb-bootstrap.md',
    'agb-doctor.md',
    'agb-migrate.md',
    'agb-sidecar.md'
  ];

  for (const file of commandFiles) {
    const filePath = join(PROJECT_ROOT, 'commands', file);
    assert.ok(existsSync(filePath), `Command file ${file} must exist`);

    const content = readFileSync(filePath, 'utf8');
    assert.match(content, /^---[\s\S]+?name:\s*agb-/, `File ${file} must declare name in frontmatter`);
    assert.match(content, /description:/, `File ${file} must declare description in frontmatter`);
    const sub = file.replace(/^agb-/, '').replace(/\.md$/, '');
    assert.match(content, new RegExp('```sh\\n~/\\.local/bin/agb ' + sub), `File ${file} must show the shim invocation in a shell block`);
  }
});

test('MCP Server: handles JSON-RPC initialization, tool listing, and tool calls', async (t) => {
  const mcpServerPath = join(PROJECT_ROOT, 'mcp', 'server.mjs');

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
