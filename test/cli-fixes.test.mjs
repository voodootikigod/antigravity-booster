// Regression tests for T-CODE-FIXES-AUDIT (CLI/MCP correctness fixes).
// Fixture repos are throwaway, offline, and never sign commits.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('fixtures/fake-adlc', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agb-cli-fixes-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

function makeRepo(name) {
  const repo = join(TMP, name);
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: name, scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-m', 'init');
  return repo;
}

test('item 1: agb sweep --project passes the project to every agy invocation', () => {
  const repo = makeRepo('sweep-repo');
  const state = join(TMP, 'sweep-state');
  mkdirSync(state);
  writeFileSync(join(TMP, 'sweep.json'), JSON.stringify({
    repo, operation: 'touch {target}', targets: ['S1.txt'], gate: { test: 'npm test' },
  }));
  const env = {
    ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
    AGB_ALLOW_DIRTY: '1', AGB_SANDBOX_GATES: '0', FAKE_STATE_DIR: state,
    AGB_QUOTA_STATE: join(TMP, 'pools-sweep.json'),
  };
  execFileSync(process.execPath, [AGB_BIN, 'sweep', join(TMP, 'sweep.json'), '--project', 'my-proj'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' });
  // Prompts are multi-line, so split the argv log on invocation starts.
  const seen = readFileSync(join(state, 'agy-argv-seen'), 'utf8').split(/^(?=--print )/m).filter((l) => l.startsWith('--print '));
  // Builder AND prosecutor must both have been spawned for this to mean anything.
  assert(seen.length >= 2, `expected builder + prosecutor invocations, saw ${seen.length}`);
  for (const line of seen) assert.match(line, /--project my-proj\b/, `agy invocation missing --project: ${line.slice(0, 200)}`);
});

// --- MCP server (items 2, 3) ---
const MCP_SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const ROOT_PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

/** Send JSON-RPC requests to a fresh MCP server; resolve with responses keyed by id. */
function mcpExchange(requests, { timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const want = new Set(requests.map((r) => r.id));
    const got = new Map();
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`MCP timeout; got ${[...got.keys()]}`)); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (want.has(msg.id)) got.set(msg.id, msg);
      }
      if (got.size === want.size) { clearTimeout(timer); child.stdin.end(); child.kill(); resolvePromise(got); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n');
  });
}

test('item 2: agb_run input schema does not advertise concurrency', async () => {
  const res = await mcpExchange([{ id: 1, method: 'tools/list' }]);
  const run = res.get(1).result.tools.find((t) => t.name === 'agb_run');
  assert(run, 'agb_run tool missing');
  assert.equal(Object.hasOwn(run.inputSchema.properties, 'concurrency'), false);
});

test('item 2: agb_run with concurrency returns a tool error naming the parameter', async () => {
  const res = await mcpExchange([{ id: 2, method: 'tools/call', params: { name: 'agb_run', arguments: { plan: join(TMP, 'nope.json'), concurrency: 3 } } }]);
  const r = res.get(2).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /concurrency/);
  assert.doesNotMatch(r.content[0].text, /ENOENT|nope\.json/, 'must reject before spawning agb');
});

test('item 2: agb_run without concurrency spawns agb run', async () => {
  const res = await mcpExchange([{ id: 3, method: 'tools/call', params: { name: 'agb_run', arguments: { plan: join(TMP, 'nope.json') } } }]);
  const text = res.get(3).result.content[0].text;
  assert.match(text, /nope\.json/, `agb run did not execute: ${text.slice(0, 300)}`);
  assert.doesNotMatch(text, /concurrency/);
});

test('item 3: MCP serverInfo.version equals root package.json version', async () => {
  const res = await mcpExchange([{ id: 4, method: 'initialize', params: {} }]);
  assert.equal(res.get(4).result.serverInfo.version, ROOT_PKG.version);
});

test('item 4: usage and unknown-command output contain no literal backslash-n', () => {
  const help = execFileSync(process.execPath, [AGB_BIN, '--help'], { encoding: 'utf8' });
  assert(help.includes('Exit codes:'), 'usage text not printed');
  assert.equal(help.includes('\\n'), false, 'usage output contains a literal \\n');
  const r = spawnSync(process.execPath, [AGB_BIN, 'definitely-not-a-command'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert(r.stderr.includes("unknown command 'definitely-not-a-command'"));
  assert.equal(r.stderr.includes('\\n'), false, 'unknown-command output contains a literal \\n');
});
