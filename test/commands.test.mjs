// Slash commands are model-interpreted skills (spec Appendix A V7/E3/D3):
// each instructs the model to run the terminal shim `~/.local/bin/agb <sub>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMANDS_DIR = join(ROOT, 'commands');
const commandFiles = () => readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
const read = (file) => readFileSync(join(COMMANDS_DIR, file), 'utf8');
const subcommandOf = (file) => file.replace(/^agb-/, '').replace(/\.md$/, '');

/** Every fenced code block as { lang, body }. */
function fencedBlocks(text) {
  return [...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].trim(), body: m[2] }));
}

test('commands: every root command instructs running ~/.local/bin/agb <its subcommand>', () => {
  const files = commandFiles();
  assert.equal(files.length, 7);
  for (const file of files) {
    const sub = subcommandOf(file);
    assert.ok(read(file).includes(`~/.local/bin/agb ${sub}`), `${file} must reference ~/.local/bin/agb ${sub}`);
  }
});

test('commands: no command embeds a PLUGIN_ROOT-resolving node-launcher shell block (V7)', () => {
  for (const file of commandFiles()) {
    const text = read(file);
    assert.ok(!/PLUGIN_ROOT|PLUGIN_DIR|PLUGINS_BASE/.test(text), `${file} must not reference PLUGIN_ROOT resolution`);
    assert.ok(!/"\$@"/.test(text), `${file} must not rely on positional "$@" (code blocks are not executed)`);
    for (const block of fencedBlocks(text)) {
      if (!/^(sh|bash|shell|zsh)?$/.test(block.lang)) continue;
      if (block.body.includes('node-launcher')) {
        assert.equal(file, 'agb-bootstrap.md', `${file}: only bootstrap may show the first-run launcher form`);
      }
    }
  }
});

test('commands: agb-bootstrap documents the first-run terminal launcher form (D3)', () => {
  const text = read('agb-bootstrap.md');
  assert.ok(
    text.includes(
      '/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap',
    ),
  );
});

test('commands: every command explains the first-run bootstrap when the shim is missing', () => {
  for (const file of commandFiles()) {
    const text = read(file);
    assert.match(text, /\/agb-bootstrap|bootstrap/, `${file} must explain the missing-shim recovery`);
    assert.ok(text.includes('node-launcher.sh" dist/agb.mjs bootstrap'), `${file} must show the first-run form`);
  }
});

test('commands: agb-migrate documents --rollback', () => {
  assert.ok(read('agb-migrate.md').includes('~/.local/bin/agb migrate --rollback'));
});

test('commands: commands with an MCP equivalent mention the mcp__agb__ tool', () => {
  for (const [file, tool] of [
    ['agb-plan.md', 'agb_plan'],
    ['agb-run.md', 'agb_run'],
    ['agb-review.md', 'agb_review'],
    ['agb-doctor.md', 'agb_doctor'],
  ]) {
    assert.ok(read(file).includes(`mcp__agb__${tool}`), `${file} must mention mcp__agb__${tool}`);
  }
});

function runMcp(lines, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server timed out; stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

test('mcp: moved server answers initialize + tools/list with clean JSON-RPC on stdout', async () => {
  const { stdout } = await runMcp([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ]);
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, `expected exactly two responses, got:\n${stdout}`);
  const messages = lines.map((l) => JSON.parse(l));
  for (const msg of messages) {
    assert.equal(msg.jsonrpc, '2.0');
    assert.ok('result' in msg || 'error' in msg);
  }
  const [init, list] = messages;
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'antigravity-booster-mcp');
  assert.equal(list.id, 2);
  const names = list.result.tools.map((tool) => tool.name);
  for (const name of ['agb_plan', 'agb_run', 'agb_review', 'agb_doctor']) assert.ok(names.includes(name), name);
});

test('mcp: malformed input yields a JSON-RPC parse error on stdout, diagnostics only on stderr', async () => {
  const { stdout } = await runMcp(['{not json', JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'nope' })]);
  const messages = stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].id, 9);
  assert.equal(messages[1].error.code, -32601);
});
