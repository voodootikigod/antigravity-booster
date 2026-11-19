import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildContext, evaluatePayload, isBoosterMcpTool } from '../hooks/policy/evaluate.mjs';
import { classifyRunCommand } from '../hooks/policy/shell.mjs';
import {
  BUNDLE_ALLOWED_OPTIONAL_PROBES,
  findExternalSpecifiers,
  main as checkBundleExternalsMain,
} from '../scripts/check-bundle-externals.mjs';
import {
  stageMarketplacePlugin,
  validateStagedPluginStrict,
} from '../scripts/stage-marketplace-plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_AGY = join(ROOT, 'test', 'fixtures', 'fake-agy');

function makeAdlcRepo(t) {
  const base = mkdtempSync(join(tmpdir(), 'agb-audit2-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(join(home, '.gemini'), { recursive: true });
  mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1 }));
  writeFileSync(join(repo, 'lib', 'lock.mjs'), 'export const lock = true;\n');
  // Create a valid active ticket with rail on lib/lock.mjs
  const ticket = {
    id: 'T-RAIL-1',
    title: 'Active rail ticket',
    status: 'in_progress',
    body: 'Test ticket body',
    scope: ['src/**'],
    rails: ['lib/lock.mjs'],
    edges: [],
  };
  writeFileSync(
    join(repo, '.adlc', 'tickets', 't-rail-1--0000000000000000000000000000000000000000000000000000000000000000.json'),
    JSON.stringify(ticket),
  );
  return { base, home, repo, outside };
}

test('audit2 #1: classifyRunCommand and buildContext normalize args case-insensitively and fail closed on collisions', (t) => {
  const { home, repo, outside } = makeAdlcRepo(t);
  const opts = { home, env: {}, platform: 'linux' };

  // buildContext picks up lowercase cwd as anchor
  const ctxLower = buildContext(
    { workspacePaths: [repo], toolCall: { name: 'run_command', args: { cwd: outside, commandline: 'ls' } } },
    opts,
  );
  assert.equal(ctxLower.anchor, outside);
  assert.ok(ctxLower.anchors.includes(outside));

  // buildContext ignores colliding Cwd/cwd rather than silently picking one
  const ctxCollide = buildContext(
    { workspacePaths: [repo], toolCall: { name: 'run_command', args: { Cwd: repo, cwd: outside, commandline: 'ls' } } },
    opts,
  );
  assert.equal(ctxCollide.anchor, repo);
  assert.ok(!ctxCollide.anchors.includes(outside));

  // classifyRunCommand enforces lowercase cwd outside workspace in ADLC repo
  const ctxRepo = buildContext({ workspacePaths: [repo], toolCall: { name: 'run_command', args: {} } }, opts);
  const resOutside = classifyRunCommand({ commandline: 'ls', cwd: outside }, ctxRepo);
  assert.equal(resOutside.decision, 'deny');
  assert.match(resOutside.reason, /outside declared workspace/i);

  // classifyRunCommand enforces lowercase commandline touching frozen rail
  const resRail = classifyRunCommand({ commandline: 'rm lib/lock.mjs', cwd: repo }, ctxRepo);
  assert.equal(resRail.decision, 'deny');

  // classifyRunCommand fails closed on colliding keys
  const resCollideCmd = classifyRunCommand({ CommandLine: 'ls', commandline: 'rm lib/lock.mjs', Cwd: repo }, ctxRepo);
  assert.equal(resCollideCmd.decision, 'deny');
  assert.match(resCollideCmd.reason, /Duplicate case-folded/i);

  const resCollideCwd = classifyRunCommand({ CommandLine: 'ls', Cwd: repo, cwd: outside }, ctxRepo);
  assert.equal(resCollideCwd.decision, 'deny');
  assert.match(resCollideCwd.reason, /Duplicate case-folded/i);

  // Non-plain-object fails closed
  const resNonObj = classifyRunCommand(null, ctxRepo);
  assert.equal(resNonObj.decision, 'deny');

  // End-to-end via evaluatePayload with lowercase keys
  const e2e = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'run_command', args: { commandline: 'ls', cwd: outside } } },
    opts,
  );
  assert.equal(e2e.decision, 'deny');
});

test('audit2 #2: isBoosterMcpTool and evaluateMcpTool normalize outer and inner MCP args case-insensitively', (t) => {
  const { home, repo } = makeAdlcRepo(t);
  const roOpts = { home, env: { AGB_WORKER_MODE: 'readonly' }, platform: 'linux' };

  // isBoosterMcpTool matches lowercase servername / toolname
  assert.equal(isBoosterMcpTool('call_mcp_tool', { servername: 'agb', toolname: 'agb_status' }), true);
  assert.equal(isBoosterMcpTool('call_mcp_tool', { SERVERNAME: 'agb', TOOLNAME: 'agb_doctor' }), true);
  // Colliding keys return false
  assert.equal(isBoosterMcpTool('call_mcp_tool', { ServerName: 'agb', servername: 'other', ToolName: 'agb_status' }), false);

  // Read-only worker: lowercase servername/toolname for mutating agb_run is denied
  const runDeny = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { servername: 'agb', toolname: 'agb_run', arguments: {} } } },
    roOpts,
  );
  assert.equal(runDeny.decision, 'deny');
  assert.match(runDeny.reason, /mutating MCP tool: agb_run/);

  // Read-only worker: agb_doctor with uppercase/mixed-case Fix in lowercase arguments or toolargs is denied
  const docFixArg = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { servername: 'agb', toolname: 'agb_doctor', arguments: { Fix: true } } } },
    roOpts,
  );
  assert.equal(docFixArg.decision, 'deny');
  assert.match(docFixArg.reason, /mutating MCP tool: agb_doctor/);

  const docFixToolArgs = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { servername: 'agb', toolname: 'agb_doctor', toolargs: { FIX: true } } } },
    roOpts,
  );
  assert.equal(docFixToolArgs.decision, 'deny');

  // Read-only worker: agb_shape with lowercase syncbrain or uppercase SYNCBRAIN is denied
  const shapeSync = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { servername: 'agb', toolname: 'agb_shape', arguments: { syncbrain: true } } } },
    roOpts,
  );
  assert.equal(shapeSync.decision, 'deny');
  assert.match(shapeSync.reason, /mutating MCP tool: agb_shape/);

  const directShapeSync = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'mcp__agb__agb_shape', args: { SYNCBRAIN: true } } },
    roOpts,
  );
  assert.equal(directShapeSync.decision, 'deny');

  const directDocFix = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'mcp__agb__agb_doctor', args: { Fix: true } } },
    roOpts,
  );
  assert.equal(directDocFix.decision, 'deny');

  // Colliding keys in inner arguments fail closed
  const innerCollide = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { ServerName: 'agb', ToolName: 'agb_doctor', Arguments: { fix: false, Fix: true } } } },
    roOpts,
  );
  assert.equal(innerCollide.decision, 'deny');
  assert.match(innerCollide.reason, /Duplicate case-folded/i);

  // Conflicting arguments + toolArgs on call_mcp_tool fail closed
  const conflictArgs = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { ServerName: 'agb', ToolName: 'agb_doctor', arguments: {}, toolArgs: { fix: true } } } },
    roOpts,
  );
  assert.equal(conflictArgs.decision, 'deny');
  assert.match(conflictArgs.reason, /Conflicting arguments\/toolArgs/i);

  // Benign read-only call with lowercase keys passes
  const benign = evaluatePayload(
    { workspacePaths: [repo], toolCall: { name: 'call_mcp_tool', args: { servername: 'agb', toolname: 'agb_status', arguments: {} } } },
    roOpts,
  );
  assert.equal(benign.decision, 'pass');
});

test('audit2 #3: stepOne re-anchors protectedRoots for run_workflow using case-folded cwd and scriptpath', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'agb-audit2-wf-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const work = join(base, 'work');
  const geminiDir = join(home, '.gemini');
  mkdirSync(geminiDir, { recursive: true });
  mkdirSync(work, { recursive: true });

  const opts = { home, env: {}, platform: 'linux' };

  // Non-ADLC workspace: lowercase cwd pointing to ~/.gemini + relative scriptpath must be denied by stepOne protectedRoots
  const resReanchor = evaluatePayload(
    {
      workspacePaths: [work],
      toolCall: {
        name: 'run_workflow',
        args: { cwd: geminiDir, scriptpath: 'settings.json' },
      },
    },
    opts,
  );
  assert.equal(resReanchor.decision, 'deny');
  assert.match(resReanchor.reason, /platform configuration|booster plugin data/i);

  // Lowercase scriptpath directly targeting protected root
  const resDirect = evaluatePayload(
    {
      workspacePaths: [work],
      toolCall: {
        name: 'run_workflow',
        args: { scriptpath: join(geminiDir, 'config.json') },
      },
    },
    opts,
  );
  assert.equal(resDirect.decision, 'deny');
  assert.match(resDirect.reason, /platform configuration|booster plugin data/i);

  // Colliding Cwd/cwd fails closed
  const resCollide = evaluatePayload(
    {
      workspacePaths: [work],
      toolCall: {
        name: 'run_workflow',
        args: { Cwd: work, cwd: geminiDir, ScriptPath: 'ok.py' },
      },
    },
    opts,
  );
  assert.equal(resCollide.decision, 'deny');
  assert.match(resCollide.reason, /Duplicate case-folded/i);
});

test('audit2 #4: check-bundle-externals records all unquoted dynamic identifiers including builtin-named variables', (t) => {
  const src = [
    'const a = require(path);',
    'const b = require(url);',
    'const c = require(os);',
    'const d = require(module);',
    'const e = await import(fs);',
    'const f = require2(path);',
    'const ok1 = require("path");',
    'const ok2 = await import("node:url");',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['fs', 'module', 'os', 'path', 'url']);

  // BUNDLE_ALLOWED_OPTIONAL_PROBES includes 'path' ONLY for the two vendored adlc bundles
  assert.equal(BUNDLE_ALLOWED_OPTIONAL_PROBES['vendor/adlc/dist/adlc.bundle.mjs'].has('path'), true);
  assert.equal(BUNDLE_ALLOWED_OPTIONAL_PROBES['vendor/adlc/dist/syntax-check-typescript.mjs'].has('path'), true);
  assert.equal(BUNDLE_ALLOWED_OPTIONAL_PROBES['dist/agb.mjs'], undefined);

  // Non-allowlisted bundle calling require(path) fails main()
  const tmp = mkdtempSync(join(tmpdir(), 'agb-audit2-cbe-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const badBundle = join(tmp, 'bad-dynamic-path.mjs');
  writeFileSync(badBundle, 'export function load(path) { return require(path); }\n');
  assert.equal(checkBundleExternalsMain([badBundle]), 1);

  // All 6 committed bundles still pass
  assert.equal(checkBundleExternalsMain([]), 0);
});

test('audit2 #5: stage-marketplace-plugin does not silently fall back to fake-agy and fails closed on missing agy unless --allow-skip', (t) => {
  const staged = stageMarketplacePlugin();
  t.after(() => rmSync(staged.stageRoot, { recursive: true, force: true }));

  const missingBin = join(staged.stageRoot, 'nonexistent-agy-binary');

  // Missing agy -> skipped: true, ok: false (no silent fake-agy fallback)
  const failRes = validateStagedPluginStrict(staged.pluginDir, { agyBin: missingBin });
  assert.equal(failRes.skipped, true);
  assert.equal(failRes.ok, false);
  assert.match(failRes.reason, /agy binary not found/);

  // Missing agy with allowSkip: true -> skipped: true, ok: true
  const allowRes = validateStagedPluginStrict(staged.pluginDir, { agyBin: missingBin, allowSkip: true });
  assert.equal(allowRes.skipped, true);
  assert.equal(allowRes.ok, true);

  // Explicit options.agyBin = fake-agy still works for tests
  const fakeRes = validateStagedPluginStrict(staged.pluginDir, { agyBin: FAKE_AGY });
  assert.equal(fakeRes.skipped, false);
  assert.equal(fakeRes.ok, true);

  // CLI mode without --allow-skip exits non-zero when AGY_BIN is missing
  const cliFail = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'stage-marketplace-plugin.mjs'), '--validate-strict'],
    {
      encoding: 'utf8',
      env: { ...process.env, AGY_BIN: missingBin },
      timeout: 30_000,
    },
  );
  assert.equal(cliFail.status, 1, `expected exit 1, got ${cliFail.status}: ${cliFail.stdout}${cliFail.stderr}`);
  const parsedFail = JSON.parse(cliFail.stdout);
  assert.equal(parsedFail.ok, false);
  assert.equal(parsedFail.skipped, true);

  // CLI mode with --allow-skip exits 0 when AGY_BIN is missing
  const cliAllow = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'stage-marketplace-plugin.mjs'), '--validate-strict', '--allow-skip'],
    {
      encoding: 'utf8',
      env: { ...process.env, AGY_BIN: missingBin },
      timeout: 30_000,
    },
  );
  assert.equal(cliAllow.status, 0, `expected exit 0, got ${cliAllow.status}: ${cliAllow.stdout}${cliAllow.stderr}`);
  const parsedAllow = JSON.parse(cliAllow.stdout);
  assert.equal(parsedAllow.ok, true);
  assert.equal(parsedAllow.skipped, true);
});
