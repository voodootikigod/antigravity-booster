// Clean-clone acceptance (spec §6 AC3, Appendix A P1): a `git ls-files` copy
// with no node_modules — what `agy plugin install <git-url>` stages — must run
// the CLI, MCP server and policy guard bundles with zero missing modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-clean-clone-')));
const clone = join(base, 'clone');
const home = join(base, 'home');
test.after(() => rmSync(base, { recursive: true, force: true }));

const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
for (const rel of listed.stdout.split('\0').filter(Boolean)) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) continue; // deleted in the working tree
  mkdirSync(dirname(join(clone, rel)), { recursive: true });
  cpSync(src, join(clone, rel));
}
mkdirSync(home, { recursive: true });

const ENV = { PATH: process.env.PATH, HOME: home };
const agb = (args, opts = {}) =>
  spawnSync(process.execPath, [join(clone, 'dist', 'agb.mjs'), ...args], { cwd: home, env: ENV, encoding: 'utf8', timeout: 30000, input: '', ...opts });
const CRASH = /Uncaught|ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError/;

test('clean clone has bundles and no node_modules', () => {
  assert.equal(existsSync(join(clone, 'node_modules')), false);
  for (const f of ['dist/agb.mjs', 'dist/mcp-server.mjs', 'dist/hooks/pre-tool-use.bundle.mjs']) {
    assert.ok(existsSync(join(clone, f)), `${f} must be committed`);
  }
});

test('every agb subcommand answers --help with exit 0 and no side effects', () => {
  const help = agb(['--help']);
  assert.equal(help.status, 0, help.stderr);
  const subcommands = [...new Set([...help.stdout.matchAll(/^\s{2}agb ([a-z][a-z-]*)/gm)].map((m) => m[1]))];
  assert.ok(subcommands.length >= 10, `expected the full subcommand list, got ${subcommands}`);
  for (const sub of subcommands) {
    const r = agb([sub, '--help']);
    assert.equal(r.status, 0, `${sub} --help: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, CRASH, sub);
  }
  assert.equal(existsSync(join(home, '.gemini')), false, '--help must not touch HOME');
});

test('doctor on an empty HOME fails cleanly (no uncaught exception)', () => {
  const r = agb(['doctor']);
  assert.notEqual(r.status, 0, 'adlc-antigravity is not installed');
  assert.doesNotMatch(r.stderr + r.stdout, CRASH);
  assert.match(r.stdout + r.stderr, /adlc-antigravity/);
});

test('MCP server answers initialize and tools/list with clean JSON-RPC on stdout', async () => {
  const child = spawn(process.execPath, [join(clone, 'dist', 'mcp-server.mjs')], { cwd: clone, env: ENV });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const deadline = Date.now() + 10000;
  while (!/"id":2/.test(stdout) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const lines = stdout.trim().split('\n');
  const messages = lines.map((l) => JSON.parse(l)); // every stdout line must be JSON-RPC
  assert.ok(messages.every((m) => m.jsonrpc === '2.0'));
  const list = messages.find((m) => m.id === 2);
  const names = list.result.tools.map((t) => t.name);
  for (const t of ['agb_status', 'agb_doctor']) assert.ok(names.includes(t), `missing ${t}`);
});

test('policy guard bundle evaluates valid, malformed and rail-violating payloads', () => {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
  writeFileSync(join(repo, '.adlc', 'tickets', ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['lib/lock.mjs'], edges: [] }));
  const hook = (input) =>
    spawnSync(process.execPath, [join(clone, 'dist', 'hooks', 'pre-tool-use.bundle.mjs')], { cwd: clone, env: ENV, encoding: 'utf8', input, timeout: 10000 });
  const call = (name, args) => JSON.stringify({ toolCall: { name, args }, workspacePaths: [repo] });

  const rail = hook(call('write_to_file', { TargetFile: join(repo, 'lib', 'lock.mjs') }));
  assert.equal(rail.status, 0, rail.stderr);
  assert.deepEqual(JSON.parse(rail.stdout), { decision: 'deny', reason: 'Target path matches frozen rail: lib/lock.mjs' });

  const ok = hook(call('write_to_file', { TargetFile: join(repo, 'lib', 'foo.mjs') }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');

  const bad = hook('{not json');
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).decision, 'deny');
  for (const r of [rail, ok, bad]) assert.doesNotMatch(r.stderr, CRASH);
});
