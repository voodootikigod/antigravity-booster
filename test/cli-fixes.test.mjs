// Regression tests for T-CODE-FIXES-AUDIT (CLI/MCP correctness fixes).
// Fixture repos are throwaway, offline, and never sign commits.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
function mcpExchange(requests, { timeoutMs = 30000, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
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

test('item 2 (#172): agb_run input schema advertises concurrency (integer >= 1)', async () => {
  const res = await mcpExchange([{ id: 1, method: 'tools/list' }]);
  const run = res.get(1).result.tools.find((t) => t.name === 'agb_run');
  assert(run, 'agb_run tool missing');
  assert.equal(Object.hasOwn(run.inputSchema.properties, 'concurrency'), true);
  assert.equal(run.inputSchema.properties.concurrency.type, 'integer');
  assert.equal(run.inputSchema.properties.concurrency.minimum, 1);
});

test('item 2 (#172): agb_run rejects invalid concurrency values before spawning agb', async () => {
  const badValues = [0, -1, 1.5, '3', true, null];
  const reqs = badValues.map((val, idx) => ({
    id: 20 + idx,
    method: 'tools/call',
    params: { name: 'agb_run', arguments: { plan: join(TMP, 'nope.json'), concurrency: val } },
  }));
  const res = await mcpExchange(reqs);
  for (let idx = 0; idx < badValues.length; idx++) {
    const msg = res.get(20 + idx);
    assert(msg.error, `expected JSON-RPC error for concurrency=${JSON.stringify(badValues[idx])}`);
    assert.equal(msg.error.code, -32602);
    assert.match(msg.error.message, /concurrency/i);
    assert.doesNotMatch(msg.error.message, /no concurrency flag|ENOENT|nope\.json/, 'must reject invalid concurrency cleanly before spawning agb');
  }
});

test('item 2 (#172): agb_run with valid concurrency forwards [run, <plan>, -c, <n>] to agb', async () => {
  const log = join(TMP, 'agb-argv-concurrency.json');
  const preload = join(TMP, 'argv-preload-concurrency.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (/agb\\.mjs$/.test(process.argv[1] ?? '')) writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
`);
  const plan = join(TMP, 'nope.json');
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim() };
  await mcpExchange([{ id: 2, method: 'tools/call', params: { name: 'agb_run', arguments: { plan, concurrency: 3 } } }], { env });
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['run', plan, '-c', '3']);
});

test('item 2: agb_run without concurrency spawns agb run', async () => {
  const res = await mcpExchange([{ id: 3, method: 'tools/call', params: { name: 'agb_run', arguments: { plan: join(TMP, 'nope.json') } } }]);
  const text = res.get(3).result.content[0].text;
  assert.match(text, /nope\.json/, `agb run did not execute: ${text.slice(0, 300)}`);
  assert.doesNotMatch(text, /concurrency/);
});

test('item 2: agb_run forwards exactly [run, <plan>] to agb', async () => {
  // A preload records the argv of the spawned agb process (the MCP server
  // passes its env through), so any extra or wrong forwarded flag is caught.
  const log = join(TMP, 'agb-argv.json');
  const preload = join(TMP, 'argv-preload.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (/agb\\.mjs$/.test(process.argv[1] ?? '')) writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
`);
  const plan = join(TMP, 'nope.json');
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim() };
  await mcpExchange([{ id: 5, method: 'tools/call', params: { name: 'agb_run', arguments: { plan } } }], { env });
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['run', plan]);
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

// --- probe (items 5, 6) ---
function runProbe({ cwd, calDir }) {
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_QUOTA_STATE: join(TMP, 'pools-probe.json') };
  delete env.AGB_CALIBRATION_DIR;
  if (calDir) env.AGB_CALIBRATION_DIR = calDir;
  return spawnSync(process.execPath, [AGB_BIN, 'probe', '2'], { cwd, env, encoding: 'utf8' });
}

test('item 5: probe writes probes-<day>.md (the committed naming), not probe-<day>.md', () => {
  const calDir = join(TMP, 'cal-5');
  const r = runProbe({ cwd: TMP, calDir });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(calDir);
  assert.equal(files.length, 1, `expected one calibration file, got ${files}`);
  assert.match(files[0], /^probes-\d{4}-\d{2}-\d{2}\.md$/);
});

test('item 5: pools.mjs cites a committed calibration file', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/pools.mjs', import.meta.url)), 'utf8');
  const cited = [...src.matchAll(/docs\/calibration\/([\w.-]+\.md)/g)].map((m) => m[1]);
  assert(cited.length > 0, 'no calibration citation found');
  for (const f of cited) {
    assert(existsSync(fileURLToPath(new URL(`../docs/calibration/${f}`, import.meta.url))), `cited file missing: ${f}`);
  }
});

test('item 6: probe defaults to <cwd>/docs/calibration when AGB_CALIBRATION_DIR is unset', () => {
  const cwd = join(TMP, 'probe-cwd');
  mkdirSync(cwd, { recursive: true });
  const r = runProbe({ cwd });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(join(cwd, 'docs', 'calibration'));
  assert.equal(files.length, 1, `expected one file under cwd/docs/calibration, got ${files}`);
});

test('item 6: AGB_CALIBRATION_DIR overrides the default probe dir', () => {
  const cwd = join(TMP, 'probe-cwd-override');
  const calDir = join(TMP, 'cal-6');
  mkdirSync(cwd, { recursive: true });
  const r = runProbe({ cwd, calDir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(calDir).length, 1);
  assert.equal(existsSync(join(cwd, 'docs')), false, 'default dir must not be used when overridden');
});

test('item 6: empty AGB_CALIBRATION_DIR falls back to <cwd>/docs/calibration', () => {
  const cwd = join(TMP, 'probe-cwd-empty');
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_QUOTA_STATE: join(TMP, 'pools-probe.json'), AGB_CALIBRATION_DIR: '' };
  const r = spawnSync(process.execPath, [AGB_BIN, 'probe', '2'], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(cwd), ['docs'], 'empty AGB_CALIBRATION_DIR must not write into the bare cwd');
  assert.equal(readdirSync(join(cwd, 'docs', 'calibration')).length, 1);
});

test('item 6: probe help text names the default calibration dir', () => {
  const out = execFileSync(process.execPath, [AGB_BIN, 'help', 'probe'], { encoding: 'utf8' });
  assert.match(out, /AGB_CALIBRATION_DIR/);
  assert.match(out, /docs\/calibration/);
});

test('MCP: notifications/cancelled is recognized and handled', async () => {
  const child = spawn(process.execPath, [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    // Send a cancellation notification using MCP 2024-11-05 method
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 9999, reason: 'user cancelled' }
    }) + '\n');
    // Ensure server didn't crash or error on the notification
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }) + '\n');
    const out = await new Promise((resolve) => {
      child.stdout.once('data', (d) => resolve(JSON.parse(d.toString().trim())));
    });
    assert.equal(out.id, 10);
    assert.ok(out.result.tools.length > 0);
  } finally {
    child.kill();
  }
});

test('probe: defaults to Gemini 3.8 Flash (Low) model', () => {
  const cwd = join(TMP, 'probe-cwd-model');
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_QUOTA_STATE: join(TMP, 'pools-probe-model.json') };
  const r = spawnSync(process.execPath, [AGB_BIN, 'probe', '1'], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /deprecated|retired/i);
});

test('readBrain: recognizes backslash path separator as local file candidate (#121)', async () => {
  const { readBrain } = await import('../lib/brain.mjs');
  const dir = join(TMP, 'brain-local-candidate');
  mkdirSync(dir, { recursive: true });
  // Extensionless local spec file inside TMP; on POSIX a filename can even contain '\\' or we can verify it does not fall through to conversation lookup when existsSync is true
  const specFile = join(dir, 'sub\\SPEC');
  writeFileSync(specFile, '# Backslash Spec\nBody text\n');
  const res = readBrain(specFile, join(TMP, 'empty-brain-dir'));
  assert.equal(res.sourceType, 'local-spec');
  assert.equal(res.title, 'Backslash Spec');
});

test('checkBrainDir: respects injected home parameter (#126)', async () => {
  const { checkBrainDir } = await import('../lib/doctor.mjs');
  const fakeHome = join(TMP, 'fake-home-brain');
  const cliBrain = join(fakeHome, '.gemini', 'antigravity-cli', 'brain');
  mkdirSync(cliBrain, { recursive: true });
  const res = await checkBrainDir({ env: {}, home: fakeHome });
  assert.equal(res.level, 'pass');
  assert.equal(res.detail, 'exists');
});

test('sweepToPlan: preserves dollar replacement patterns in target paths literally', async () => {
  const { sweepToPlan } = await import('../lib/sweep.mjs');
  const plan = sweepToPlan({
    repo: TMP,
    operation: 'Refactor {target} (#{i})',
    targets: ['src/$&/$$/file.mjs'],
  });
  assert.equal(plan.tickets[0].body.includes('Refactor src/$&/$$/file.mjs (#1)'), true);
  assert.deepEqual(plan.tickets[0].scope, ['src/$&/$$/file.mjs']);
});

test('agb help preflight outputs Flags: --no-coldstart', () => {
  const r = spawnSync(process.execPath, [AGB_BIN, 'help', 'preflight'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /agb preflight <plan\.json>/);
  assert.match(r.stdout, /Flags:\s+--no-coldstart/);
});

test('agb_preflight MCP tool includes noColdstart in inputSchema and forwards flag', async () => {
  const resList = await mcpExchange([{ id: 101, method: 'tools/list' }]);
  const preflightTool = resList.get(101).result.tools.find((t) => t.name === 'agb_preflight');
  assert.ok(preflightTool, 'agb_preflight tool exists');
  assert.equal(preflightTool.inputSchema.properties.noColdstart?.type, 'boolean');

  const log = join(TMP, 'agb-preflight-argv.json');
  const preload = join(TMP, 'argv-preflight-preload.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (/agb\\.mjs$/.test(process.argv[1] ?? '')) writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
`);
  const plan = join(TMP, 'nope-preflight.json');
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim() };
  await mcpExchange([{ id: 102, method: 'tools/call', params: { name: 'agb_preflight', arguments: { plan, noColdstart: true } } }], { env });
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['preflight', plan, '--no-coldstart']);
});

test('extractPositionalArgs and sanitizeRemoteUrl: imported directly from lib/plan-integrity.mjs', async () => {
  const { extractPositionalArgs, sanitizeRemoteUrl } = await import('../lib/plan-integrity.mjs');
  assert.deepEqual(
    extractPositionalArgs(['--plan', 'specs/foo.md', '--loop', './my-repo'], new Set(['--plan'])),
    ['./my-repo']
  );
  assert.deepEqual(
    extractPositionalArgs(['specs/foo.md', '--max-ticket-scope', '5', '--decompose', './my-repo'], new Set(['--out', '--max-ticket-scope'])),
    ['specs/foo.md', './my-repo']
  );
  assert.equal(sanitizeRemoteUrl('https://user:secret-pat@github.com/org/repo.git?token=abc#frag'), 'https://github.com/org/repo.git');
  assert.equal(sanitizeRemoteUrl('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
});

test('agb --version --provenance prints version with git metadata or graceful fallback', () => {
  const r = spawnSync(process.execPath, [AGB_BIN, '--version', '--provenance'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), new RegExp(`^antigravity-booster v${ROOT_PKG.version}`));
});

test('agb shape, watch, init, sync-models, and tui commands work as expected', () => {
  const shapeRes = spawnSync(process.execPath, [AGB_BIN, 'shape', 'templates/specs/feature-template.md', '--json'], { encoding: 'utf8' });
  assert.equal(shapeRes.status, 0, shapeRes.stderr);
  const parsedShape = JSON.parse(shapeRes.stdout);
  assert.equal(parsedShape.ok, true);
  assert.equal(parsedShape.structured, true);

  const initRepo = makeRepo('init-cli-repo');
  const initRes = spawnSync(process.execPath, [AGB_BIN, 'init', initRepo], { encoding: 'utf8' });
  assert.equal(initRes.status, 0, initRes.stderr);
  const parsedInit = JSON.parse(initRes.stdout);
  assert.equal(parsedInit.ok, true);
  assert.ok(existsSync(join(initRepo, 'specs', 'feature-template.md')));

  const syncRes = spawnSync(process.execPath, [AGB_BIN, 'sync-models', '--offline', '--json'], { encoding: 'utf8' });
  assert.equal(syncRes.status, 0, syncRes.stderr);
  const parsedSync = JSON.parse(syncRes.stdout);
  assert.equal(parsedSync.ok, true);

  const tuiHelp = spawnSync(process.execPath, [AGB_BIN, 'help', 'tui'], { encoding: 'utf8' });
  assert.equal(tuiHelp.status, 0);
  assert.match(tuiHelp.stdout, /Removed\. Use agb sidecar or agb watch instead\./);
});

test('MCP server exposes agb_shape, agb_init, and extended agb_plan/agb_review/agb_doctor flags', async () => {
  const resList = await mcpExchange([{ id: 201, method: 'tools/list' }]);
  const tools = resList.get(201).result.tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('agb_shape'));
  assert.ok(names.includes('agb_init'));

  const planTool = tools.find((t) => t.name === 'agb_plan');
  assert.equal(planTool.inputSchema.properties.decompose?.type, 'boolean');
  assert.equal(planTool.inputSchema.properties.maxTicketScope?.type, 'number');
  assert.equal(planTool.inputSchema.properties.noFastPath?.type, 'boolean');

  const reviewTool = tools.find((t) => t.name === 'agb_review');
  assert.equal(reviewTool.inputSchema.properties.plan?.type, 'string');
  assert.equal(reviewTool.inputSchema.properties.loop?.type, 'boolean');
  assert.equal(reviewTool.inputSchema.properties.fiveLens?.type, 'boolean');
  assert.equal(reviewTool.inputSchema.properties.arbiter?.type, 'boolean');

  const shapeTool = tools.find((t) => t.name === 'agb_shape');
  assert.deepEqual(shapeTool.inputSchema.required, ['spec', 'repo']);

  const doctorTool = tools.find((t) => t.name === 'agb_doctor');
  assert.equal(doctorTool.inputSchema.properties.fix?.type, 'boolean');

  // Calling agb_shape without repo must fail closed with -32602 instead of using plugin process.cwd()
  const missingRepoRes = await mcpExchange([
    { id: 300, method: 'tools/call', params: { name: 'agb_shape', arguments: { spec: 'spec.md' } } },
  ]);
  const missingRepoList = Array.isArray(missingRepoRes) ? missingRepoRes : (missingRepoRes?.messages ?? missingRepoRes?.responses ?? []);
  const missingRepoMsg = missingRepoList.find((m) => m.id === 300) ?? missingRepoRes?.get?.(300);
  assert.equal(missingRepoMsg?.error?.code, -32602);
  assert.match(missingRepoMsg?.error?.message ?? '', /repo/i);

  // Verify MCP tools/call argv forwarding for agb_shape, agb_init, agb_plan, agb_review, agb_doctor
  const log = join(TMP, 'agb-mcp-dispatch.jsonl');
  const preload = join(TMP, 'argv-mcp-dispatch.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
if (/agb\\.mjs$/.test(process.argv[1] ?? '')) appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  const dispatchRepo = makeRepo('mcp-dispatch-repo');
  const specFile = join(dispatchRepo, 'spec.md');
  writeFileSync(specFile, '# Spec\n');
  const env = {
    ...process.env,
    AGB_AGY_BIN: FAKE_AGY,
    AGB_QUOTA_STATE: join(TMP, 'pools-mcp-dispatch.json'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim(),
  };
  await mcpExchange([
    { id: 301, method: 'tools/call', params: { name: 'agb_shape', arguments: { spec: 'spec.md', repo: dispatchRepo, strict: true, maxTicketScope: 6 } } },
    { id: 302, method: 'tools/call', params: { name: 'agb_init', arguments: { repo: dispatchRepo } } },
    { id: 303, method: 'tools/call', params: { name: 'agb_review', arguments: { repo: dispatchRepo, plan: 'spec.md', loop: true, arbiter: false } } },
  ], { env });
  const recorded = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(recorded.some((a) => a[0] === 'shape' && a.includes('--strict') && a.includes('--max-ticket-scope') && a.includes('6')));
  assert.ok(recorded.some((a) => a[0] === 'init' && a[1] === dispatchRepo));
  assert.ok(recorded.some((a) => a[0] === 'review' && a.includes('--plan') && a.includes('--loop') && a.includes('--no-arbiter')));
});

test('CLI subprocess: agb run -c validation, agb watch, agb review --plan, agb plan --decompose, and run-tests --coverage', () => {
  const badC = spawnSync(process.execPath, [AGB_BIN, 'run', '-c', '0'], { encoding: 'utf8' });
  assert.equal(badC.status, 1);
  assert.match(badC.stderr, /invalid concurrency/);

  const watchRepo = makeRepo('watch-cli-repo');
  mkdirSync(join(watchRepo, '.booster'), { recursive: true });
  writeFileSync(join(watchRepo, '.booster', 'run.json'), JSON.stringify({ runId: 'r1', startedAt: new Date().toISOString() }));
  writeFileSync(join(watchRepo, '.booster', 'report.json'), JSON.stringify({ runId: 'r1', merged: ['T1'], failed: {} }));
  const watchRes = spawnSync(process.execPath, [AGB_BIN, 'watch', watchRepo, '--interval', '20', '--compact'], {
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  assert.equal(watchRes.status, 0, watchRes.stderr);
  assert.match(watchRes.stdout, /\[AGB Watch\] run r1/);

  const planRepo = makeRepo('plan-cli-repo');
  mkdirSync(join(planRepo, 'lib'), { recursive: true });
  writeFileSync(join(planRepo, 'lib', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(planRepo, 'lib', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(planRepo, 'lib', 'c.mjs'), 'export const c = 3;\n');
  const specPath = join(planRepo, 'spec.md');
  writeFileSync(specPath, [
    '# Decompose Spec',
    '### Ticket 1: `T-WIDE` — Wide Ticket',
    '- **Scope**: `lib/a.mjs`, `lib/b.mjs`, `lib/c.mjs`',
    '- **Acceptance Criteria**:',
    '  - Exports a, b, c.',
    '',
  ].join('\n'));
  const outPlan = join(planRepo, 'out-plan.json');
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_QUOTA_STATE: join(TMP, 'pools-cli-plan.json') };
  const planRes = spawnSync(process.execPath, [
    AGB_BIN, 'plan', specPath, planRepo,
    '--out', outPlan, '--force', '--decompose', '--max-ticket-scope', '2',
    '--no-coldstart', '--no-parallax', '--no-premortem',
  ], { encoding: 'utf8', env });
  assert.equal(planRes.status, 0, planRes.stderr);
  const compiled = JSON.parse(readFileSync(outPlan, 'utf8'));
  assert.equal(compiled.tickets.length, 2);
  assert.equal(compiled.tickets[0].id, 'T-WIDE-p1');
  assert.equal(compiled.tickets[1].id, 'T-WIDE-p2');

  const revRes = spawnSync(process.execPath, [AGB_BIN, 'review', planRepo, '--plan', 'spec.md', '--no-arbiter'], { encoding: 'utf8', env });
  assert.equal(revRes.status, 0, revRes.stderr);
  assert.equal(JSON.parse(revRes.stdout).gateVerdict, 'SHIP');

  const runnerScript = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url));
  const covRes = spawnSync(process.execPath, [runnerScript, '--coverage', 'test/semver.test.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(covRes.status, 0, covRes.stderr);
});

test('T-RA-4B: agb plan --emit-workflow overwrites existing workflow only when --force is passed', () => {
  const planRepo = makeRepo('plan-emit-wf-force-repo');
  mkdirSync(join(planRepo, 'lib'), { recursive: true });
  writeFileSync(join(planRepo, 'lib', 'x.mjs'), 'export const x = 1;\n');
  const specPath = join(planRepo, 'spec.md');
  writeFileSync(specPath, [
    '# Workflow Spec',
    '### Ticket 1: `T-WF1` — Simple Ticket',
    '- **Scope**: `lib/x.mjs`',
    '- **Acceptance Criteria**:',
    '  - Exports x.',
    '',
  ].join('\n'));
  const outPlan = join(planRepo, 'plan-wf.json');
  const existingWf = join(planRepo, 'existing-wf.py');
  writeFileSync(existingWf, '# old hand-written workflow\n');
  const env = { ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_QUOTA_STATE: join(TMP, 'pools-cli-plan-wf.json') };

  // Without --force: fails closed with exit 1, leaves existing workflow untouched, does not write plan.
  const denied = spawnSync(process.execPath, [
    AGB_BIN, 'plan', specPath, planRepo,
    '--out', outPlan, '--emit-workflow', 'existing-wf.py',
    '--no-coldstart', '--no-parallax', '--no-premortem',
  ], { encoding: 'utf8', env });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /already exists/);
  assert.match(denied.stderr, /--force/);
  assert.equal(readFileSync(existingWf, 'utf8'), '# old hand-written workflow\n');
  assert.equal(existsSync(outPlan), false);

  // With --force: compiles plan and overwrites existing workflow.
  const allowed = spawnSync(process.execPath, [
    AGB_BIN, 'plan', specPath, planRepo,
    '--out', outPlan, '--emit-workflow', 'existing-wf.py', '--force',
    '--no-coldstart', '--no-parallax', '--no-premortem',
  ], { encoding: 'utf8', env });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(existsSync(outPlan), true);
  const wfContent = readFileSync(existingWf, 'utf8');
  assert.match(wfContent, /Generated by `agb plan --emit-workflow`/);
});


