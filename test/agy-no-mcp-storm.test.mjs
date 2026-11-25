import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  lstatSync,
  symlinkSync,
  copyFileSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runAgy,
  buildSpawnEnv,
  stageHooksOnlyBoosterPlugin,
  stageFilteredMcpConfig,
  stageIsolatedGeminiHome,
  stageBuilderGeminiHome,
  stageReadonlyGeminiHome,
} from '../lib/agy.mjs';

const REPO_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const FAKE_AGY = join(REPO_ROOT, 'test', 'fixtures', 'fake-agy');

/**
 * Create a realistic fake userHome containing host MCP configs (both paths, with
 * UTF-8 BOM + JSONC comments), extensions, antigravity-booster (full tree with
 * mcp_config.json, mcp.json, dist/mcp-server.mjs, rules/, skills/, commands/, agents/),
 * adlc-antigravity, adlc-gemini, agb-dynamic-sidecar, and a third-party plugin.
 * Every configured MCP server points to a canary script that writes a marker file
 * into `canaryDir` if spawned.
 */
function createCanaryFixture({ baseDir = tmpdir(), prefix = 'agb-storm-' } = {}) {
  const root = realpathSync(mkdtempSync(join(baseDir, prefix)));
  const userHome = join(root, 'user-home');
  const worktree = join(root, 'worktree');
  const canaryDir = join(worktree, '.canary-spawns');
  const binDir = join(root, 'bin');

  mkdirSync(userHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(canaryDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Canary script: writes a marker file whenever an MCP server is launched.
  const canaryScript = join(binDir, 'mcp-canary.mjs');
  writeFileSync(
    canaryScript,
    `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [dir, label] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, label + '.marker'), JSON.stringify({ label, pid: process.pid, home: process.env.HOME }), 'utf8');
`,
    { mode: 0o755 },
  );

  // Mock agy binary: mimics real agy 1.5.15 MCP discovery across:
  //   1. $HOME/.gemini/mcp_config.json
  //   2. $HOME/.gemini/config/mcp_config.json
  //   3. $HOME/.gemini/config/plugins/*/{mcp_config,mcp}.json
  //   4. $HOME/.gemini/extensions/*/{mcp_config,mcp}.json
  // Executes every discovered MCP server command and records full diagnostics.
  const mockAgyBin = join(binDir, 'mock-storm-agy');
  writeFileSync(
    mockAgyBin,
    `#!${process.execPath}
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let outputFormat = 'text';
let settingsRaw = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output-format') outputFormat = args[i + 1];
  if (args[i] === '--settings') settingsRaw = args[i + 1];
}

if (settingsRaw !== null) {
  const parsed = JSON.parse(settingsRaw);
  for (const k of Object.keys(parsed)) {
    if (k !== 'permissions') {
      process.stderr.write(\`Error: --settings: unknown setting "\${k}"\\n\`);
      process.exit(1);
    }
  }
}

const home = process.env.HOME || '';
const discoveredServers = [];
const discoveredPlugins = [];

function loadAndRunMcp(filePath, sourceLabel) {
  if (!existsSync(filePath)) return;
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers || {};
    for (const [name, cfg] of Object.entries(servers)) {
      discoveredServers.push({ source: sourceLabel, name, command: cfg?.command });
      if (cfg && typeof cfg.command === 'string') {
        spawnSync(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], { stdio: 'ignore' });
      }
    }
  } catch {}
}

loadAndRunMcp(join(home, '.gemini', 'mcp_config.json'), 'root-mcp');
loadAndRunMcp(join(home, '.gemini', 'config', 'mcp_config.json'), 'config-mcp');

const pluginsDir = join(home, '.gemini', 'config', 'plugins');
if (existsSync(pluginsDir)) {
  for (const name of readdirSync(pluginsDir).sort()) {
    discoveredPlugins.push(name);
    loadAndRunMcp(join(pluginsDir, name, 'mcp_config.json'), \`plugin:\${name}:mcp_config\`);
    loadAndRunMcp(join(pluginsDir, name, 'mcp.json'), \`plugin:\${name}:mcp\`);
  }
}

const extDir = join(home, '.gemini', 'extensions');
if (existsSync(extDir)) {
  for (const name of readdirSync(extDir).sort()) {
    loadAndRunMcp(join(extDir, name, 'mcp_config.json'), \`ext:\${name}\`);
  }
}

const reportPath = process.env.AGB_TEST_REPORT_FILE;
if (reportPath) {
  writeFileSync(
    reportPath,
    JSON.stringify({
      HOME: process.env.HOME ?? null,
      USERPROFILE: process.env.USERPROFILE ?? null,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
      AGB_USER_HOME: process.env.AGB_USER_HOME ?? null,
      AGB_WORKER_MODE: process.env.AGB_WORKER_MODE ?? null,
      AGB_WORKER_TICKET: process.env.AGB_WORKER_TICKET ?? null,
      settings: settingsRaw ? JSON.parse(settingsRaw) : null,
      discoveredPlugins,
      discoveredServers,
    }, null, 2),
    'utf8',
  );
}

if (outputFormat === 'stream-json') {
  process.stdout.write('{"event":"result","result":{"status":"SUCCESS","exit_code":0,"response":"ok"}}\\n');
} else if (outputFormat === 'json') {
  process.stdout.write('{"status":"SUCCESS","response":"ok"}\\n');
} else {
  process.stdout.write('OK\\n');
}
`,
    { mode: 0o755 },
  );

  const gemini = join(userHome, '.gemini');
  const config = join(gemini, 'config');
  const plugins = join(config, 'plugins');
  const cli = join(gemini, 'antigravity-cli');
  mkdirSync(plugins, { recursive: true });
  mkdirSync(cli, { recursive: true });
  mkdirSync(join(gemini, 'extensions', 'canary-ext'), { recursive: true });

  // Auth files that MUST remain accessible
  writeFileSync(join(gemini, 'oauth_creds.json'), '{"access_token":"ok"}\n');
  writeFileSync(join(cli, 'antigravity-oauth-token'), 'tok-123\n');

  const mkCanaryServer = (label) => ({
    command: process.execPath,
    args: [canaryScript, canaryDir, label],
  });

  // Host ~/.gemini/mcp_config.json
  const hostRootMcp = JSON.stringify(
    {
      mcpServers: {
        codegraph: mkCanaryServer('root-codegraph'),
        'canary-root': mkCanaryServer('canary-root'),
      },
    },
    null,
    2,
  ) + '\n';
  writeFileSync(join(gemini, 'mcp_config.json'), hostRootMcp, 'utf8');

  // Host ~/.gemini/config/mcp_config.json (with UTF-8 BOM + JSONC comments + URL inside string!)
  const hostConfigMcp =
    '\uFEFF// Leading JSONC line comment\n' +
    '{\n' +
    '  /* Block comment before mcpServers */\n' +
    '  "mcpServers": {\n' +
    `    "codegraph": ${JSON.stringify({ ...mkCanaryServer('config-codegraph'), env: { DOCS_URL: 'https://example.com/a//b' } })},\n` +
    `    "canary-config": ${JSON.stringify(mkCanaryServer('canary-config'))}\n` +
    '  }\n' +
    '}\n';
  writeFileSync(join(config, 'mcp_config.json'), hostConfigMcp, 'utf8');

  // Host ~/.gemini/extensions/canary-ext/mcp_config.json
  writeFileSync(
    join(gemini, 'extensions', 'canary-ext', 'mcp_config.json'),
    JSON.stringify({ mcpServers: { 'canary-ext': mkCanaryServer('canary-ext') } }),
    'utf8',
  );

  // Full antigravity-booster plugin tree with forbidden files/dirs
  const boosterSrc = join(plugins, 'antigravity-booster');
  mkdirSync(join(boosterSrc, 'bin'), { recursive: true });
  mkdirSync(join(boosterSrc, 'dist', 'hooks'), { recursive: true });
  mkdirSync(join(boosterSrc, 'hooks'), { recursive: true });
  mkdirSync(join(boosterSrc, 'rules'), { recursive: true });
  mkdirSync(join(boosterSrc, 'skills', 'agb'), { recursive: true });
  mkdirSync(join(boosterSrc, 'commands'), { recursive: true });
  mkdirSync(join(boosterSrc, 'agents'), { recursive: true });
  writeFileSync(join(boosterSrc, 'plugin.json'), '{"name":"antigravity-booster","version":"1.3.0"}\n');
  writeFileSync(join(boosterSrc, 'hooks.json'), '{"agb-policy-guard":{}}\n');
  writeFileSync(join(boosterSrc, 'bin', 'hook-runner.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(boosterSrc, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'), '// hook bundle\n');
  writeFileSync(join(boosterSrc, 'hooks', 'session-start.mjs'), '// session-start hook\n');
  writeFileSync(join(boosterSrc, 'dist', 'mcp-server.mjs'), '// forbidden mcp server\n');
  writeFileSync(join(boosterSrc, 'dist', 'agb.mjs'), '// forbidden cli bundle\n');
  writeFileSync(
    join(boosterSrc, 'mcp_config.json'),
    JSON.stringify({ mcpServers: { 'booster-self': mkCanaryServer('booster-self-mcp-config') } }),
  );
  writeFileSync(
    join(boosterSrc, 'mcp.json'),
    JSON.stringify({ mcpServers: { 'booster-self-mcp': mkCanaryServer('booster-self-mcp') } }),
  );
  writeFileSync(join(boosterSrc, 'rules', 'AGENTS.md'), '# orchestrator rules\n');
  writeFileSync(join(boosterSrc, 'skills', 'agb', 'SKILL.md'), '# skill\n');
  writeFileSync(join(boosterSrc, 'commands', 'agb.md'), '# cmd\n');
  writeFileSync(join(boosterSrc, 'agents', 'fleet.md'), '# agent\n');

  // Companion builder plugins (preserved for builders, omitted for readonly)
  for (const name of ['adlc-antigravity', 'adlc-gemini']) {
    mkdirSync(join(plugins, name), { recursive: true });
    writeFileSync(join(plugins, name, 'plugin.json'), JSON.stringify({ name }));
  }

  // Sidecar & unrelated third-party plugins (ALWAYS excluded)
  for (const name of ['agb-dynamic-sidecar', 'third-party-mcp']) {
    mkdirSync(join(plugins, name), { recursive: true });
    writeFileSync(join(plugins, name, 'plugin.json'), JSON.stringify({ name }));
    writeFileSync(
      join(plugins, name, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { [name]: mkCanaryServer(`plugin-${name}`) } }),
    );
  }

  const readCanaries = () =>
    existsSync(canaryDir) ? readdirSync(canaryDir).filter((f) => f.endsWith('.marker')).sort() : [];

  const clearCanaries = () => {
    if (!existsSync(canaryDir)) return;
    for (const f of readdirSync(canaryDir)) {
      rmSync(join(canaryDir, f), { force: true });
    }
  };

  return {
    root,
    userHome,
    worktree,
    canaryDir,
    mockAgyBin,
    hostRootMcp,
    hostConfigMcp,
    readCanaries,
    clearCanaries,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('readonly runAgy spawns 0 canary MCP servers, strips non-booster plugins, and cleans up ephemeral agb-ro-* dir', async () => {
  const fx = createCanaryFixture();
  const savedHomeDir = process.env.AGB_HOME_DIR;
  process.env.AGB_HOME_DIR = fx.userHome;
  const reportFile = join(fx.worktree, 'ro-report.json');
  try {
    const res = await runAgy({
      bin: fx.mockAgyBin,
      model: 'gemini-4-neon-medium',
      prompt: 'readonly probe',
      cwd: fx.worktree,
      repo: fx.worktree,
      role: 'prosecutor',
      useRoleSettings: true,
      worker: { mode: 'readonly' },
      env: { AGB_TEST_REPORT_FILE: reportFile },
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(fx.readCanaries(), [], 'readonly runAgy must spawn 0 canary MCP servers');

    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.AGB_WORKER_MODE, 'readonly');
    assert.equal(report.AGB_USER_HOME, fx.userHome);
    assert.notEqual(report.HOME, fx.userHome);
    assert.match(report.HOME, /agb-ro-.*[/\\]\.agb_home$/);
    assert.equal(report.USERPROFILE, report.HOME);
    assert.equal(report.XDG_CONFIG_HOME, join(report.HOME, '.config'));
    assert.deepEqual(report.discoveredPlugins, ['antigravity-booster']);
    assert.deepEqual(report.discoveredServers, []);
    assert.deepEqual(Object.keys(report.settings), ['permissions']);
    assert.ok(report.settings.permissions.deny.includes('write_file'));
    assert.ok(report.settings.permissions.deny.includes('call_mcp_tool'));

    // Ephemeral agb-ro-* temp dir MUST be cleaned up on exit
    assert.equal(existsSync(report.HOME), false, 'ephemeral agb-ro-* .agb_home must be removed in finally');
    assert.equal(existsSync(dirname(report.HOME)), false, 'ephemeral agb-ro-* root must be removed in finally');

    // Also verify cleanup happens when spawn fails synchronously (isolated TMPDIR avoids racing parallel test files)
    const privateTmp = join(fx.root, 'private-tmp');
    mkdirSync(privateTmp, { recursive: true });
    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = privateTmp;
    try {
      const failRes = await runAgy({
        bin: '/invalid/\0/agy',
        model: 'gemini-4-neon-medium',
        prompt: 'spawn fail probe',
        role: 'coldstart',
        worker: { mode: 'readonly' },
      });
      assert.equal(failRes.ok, false);
      assert.equal(failRes.kind, 'spawn');
      assert.deepEqual(
        readdirSync(privateTmp).filter((d) => d.startsWith('agb-ro-')),
        [],
        'failed readonly spawn must not leak agb-ro-* dirs',
      );
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
    }
  } finally {
    if (savedHomeDir === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeDir;
    fx.cleanup();
  }
});

test('builder runAgy (default) spawns 0 canary MCP servers, keeps hooks-only booster + adlc plugins, and excludes sidecar/third-party', async () => {
  const fx = createCanaryFixture();
  const savedHomeDir = process.env.AGB_HOME_DIR;
  process.env.AGB_HOME_DIR = fx.userHome;
  const reportFile = join(fx.worktree, 'builder-report.json');
  try {
    const res = await runAgy({
      bin: fx.mockAgyBin,
      model: 'gemini-4-neon-medium',
      prompt: 'builder probe',
      cwd: fx.worktree,
      repo: fx.worktree,
      role: 'builder',
      sandbox: true,
      useRoleSettings: true,
      outputFormat: 'stream-json',
      worker: { ticket: 'T-STORM-BUILD-1' },
      env: { AGB_TEST_REPORT_FILE: reportFile },
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(fx.readCanaries(), [], 'default builder runAgy must spawn 0 canary MCP servers');

    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.AGB_WORKER_TICKET, 'T-STORM-BUILD-1');
    assert.equal(report.AGB_USER_HOME, fx.userHome);
    assert.equal(report.HOME, join(fx.worktree, '.agb_home'));
    assert.deepEqual(report.discoveredPlugins, ['adlc-antigravity', 'adlc-gemini', 'antigravity-booster']);
    assert.deepEqual(report.discoveredServers, []);
    assert.deepEqual(Object.keys(report.settings), ['permissions']);
    assert.ok(report.settings.permissions.deny.includes('call_mcp_tool'));
    assert.ok(report.settings.permissions.deny.includes('invoke_subagent'));
    assert.equal(report.settings.permissions.deny.includes('write_file'), false);

    // Inspect staged hooks-only antigravity-booster projection
    const stagedGemini = join(fx.worktree, '.agb_home', '.gemini');
    const stagedBooster = join(stagedGemini, 'config', 'plugins', 'antigravity-booster');
    assert.equal(lstatSync(stagedBooster).isSymbolicLink(), false);
    assert.equal(existsSync(join(stagedBooster, 'plugin.json')), true);
    assert.equal(existsSync(join(stagedBooster, 'hooks.json')), true);
    assert.equal(existsSync(join(stagedBooster, 'bin', 'hook-runner.sh')), true);
    assert.equal(lstatSync(join(stagedBooster, 'dist')).isSymbolicLink(), false);
    assert.equal(existsSync(join(stagedBooster, 'dist', 'hooks', 'pre-tool-use.bundle.mjs')), true);
    assert.equal(existsSync(join(stagedBooster, 'hooks', 'session-start.mjs')), true);
    for (const forbidden of [
      'mcp_config.json',
      'mcp.json',
      'rules',
      'skills',
      'commands',
      'agents',
      join('dist', 'mcp-server.mjs'),
      join('dist', 'agb.mjs'),
    ]) {
      assert.equal(existsSync(join(stagedBooster, forbidden)), false, `staged booster must exclude ${forbidden}`);
    }
    assert.equal(existsSync(join(stagedGemini, 'extensions')), false, 'extensions must be excluded');
    assert.deepEqual(JSON.parse(readFileSync(join(stagedGemini, 'mcp_config.json'), 'utf8')), { mcpServers: {} });
    assert.deepEqual(JSON.parse(readFileSync(join(stagedGemini, 'config', 'mcp_config.json'), 'utf8')), { mcpServers: {} });
  } finally {
    if (savedHomeDir === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeDir;
    fx.cleanup();
  }
});

test('builder runAgy on a reused worktree safely unlinks pre-existing symlinks and never clobbers host userHome', async () => {
  const fx = createCanaryFixture();
  const savedHomeDir = process.env.AGB_HOME_DIR;
  process.env.AGB_HOME_DIR = fx.userHome;
  const reportFile = join(fx.worktree, 'reused-report.json');
  try {
    const stagedGemini = join(fx.worktree, '.agb_home', '.gemini');
    const stagedConfig = join(stagedGemini, 'config');
    mkdirSync(stagedConfig, { recursive: true });

    // Pre-seed legacy/hostile symlinks pointing directly into host ~/.gemini
    symlinkSync(join(fx.userHome, '.gemini', 'config', 'plugins'), join(stagedConfig, 'plugins'));
    symlinkSync(join(fx.userHome, '.gemini', 'mcp_config.json'), join(stagedGemini, 'mcp_config.json'));
    symlinkSync(join(fx.userHome, '.gemini', 'config', 'mcp_config.json'), join(stagedConfig, 'mcp_config.json'));
    symlinkSync(join(fx.userHome, '.gemini', 'extensions'), join(stagedGemini, 'extensions'));

    const res = await runAgy({
      bin: fx.mockAgyBin,
      model: 'gemini-4-neon-medium',
      prompt: 'reused worktree probe',
      cwd: fx.worktree,
      repo: fx.worktree,
      role: 'builder',
      sandbox: true,
      useRoleSettings: true,
      outputFormat: 'stream-json',
      worker: { ticket: 'T-STORM-REUSE-1' },
      env: { AGB_TEST_REPORT_FILE: reportFile },
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(fx.readCanaries(), [], 'reused worktree must spawn 0 canary MCP servers');

    // Symlinks must have been unlinked and replaced with real dirs/files
    assert.equal(lstatSync(join(stagedConfig, 'plugins')).isSymbolicLink(), false);
    assert.equal(lstatSync(join(stagedGemini, 'mcp_config.json')).isSymbolicLink(), false);
    assert.equal(lstatSync(join(stagedConfig, 'mcp_config.json')).isSymbolicLink(), false);
    assert.equal(existsSync(join(stagedGemini, 'extensions')), false);

    // Host files must be byte-for-byte untouched!
    assert.equal(readFileSync(join(fx.userHome, '.gemini', 'mcp_config.json'), 'utf8'), fx.hostRootMcp);
    assert.equal(readFileSync(join(fx.userHome, '.gemini', 'config', 'mcp_config.json'), 'utf8'), fx.hostConfigMcp);
    assert.equal(
      existsSync(join(fx.userHome, '.gemini', 'config', 'plugins', 'antigravity-booster', 'mcp_config.json')),
      true,
      'host plugin mcp_config.json must never be deleted',
    );
    assert.equal(
      existsSync(join(fx.userHome, '.gemini', 'config', 'plugins', 'agb-dynamic-sidecar', 'mcp_config.json')),
      true,
      'host sidecar plugin must never be deleted',
    );
  } finally {
    if (savedHomeDir === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeDir;
    fx.cleanup();
  }
});

test('codegraph MCP is staged ONLY when BOTH AGB_ALLOW_CODEGRAPH_MCP=1 AND <repo>/.codegraph exist (unrelated servers stay excluded)', async () => {
  const fx = createCanaryFixture();
  const savedHomeDir = process.env.AGB_HOME_DIR;
  process.env.AGB_HOME_DIR = fx.userHome;
  const reportFile = join(fx.worktree, 'cg-report.json');
  try {
    // Case A: AGB_ALLOW_CODEGRAPH_MCP=1 WITHOUT .codegraph -> 0 MCP servers
    const resA = await runAgy({
      bin: fx.mockAgyBin,
      model: 'gemini-4-neon-medium',
      prompt: 'cg opt-in without index',
      cwd: fx.worktree,
      repo: fx.worktree,
      role: 'builder',
      sandbox: true,
      useRoleSettings: true,
      outputFormat: 'stream-json',
      worker: { ticket: 'T-CG-A' },
      env: { AGB_ALLOW_CODEGRAPH_MCP: '1', AGB_TEST_REPORT_FILE: reportFile },
    });
    assert.equal(resA.ok, true, resA.error);
    assert.deepEqual(fx.readCanaries(), []);
    const repA = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.deepEqual(repA.discoveredServers, []);
    assert.ok(repA.settings.permissions.deny.includes('call_mcp_tool'));

    // Case B: .codegraph exists WITHOUT AGB_ALLOW_CODEGRAPH_MCP=1 -> 0 MCP servers
    mkdirSync(join(fx.worktree, '.codegraph'), { recursive: true });
    const resB = await runAgy({
      bin: fx.mockAgyBin,
      model: 'gemini-4-neon-medium',
      prompt: 'cg index without opt-in',
      cwd: fx.worktree,
      repo: fx.worktree,
      role: 'builder',
      sandbox: true,
      useRoleSettings: true,
      outputFormat: 'stream-json',
      worker: { ticket: 'T-CG-B' },
      env: { AGB_TEST_REPORT_FILE: reportFile },
    });
    assert.equal(resB.ok, true, resB.error);
    assert.deepEqual(fx.readCanaries(), []);
    const repB = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.deepEqual(repB.discoveredServers, []);
    assert.ok(repB.settings.permissions.deny.includes('call_mcp_tool'));

    // Case C: BOTH AGB_ALLOW_CODEGRAPH_MCP=1 AND .codegraph exist -> ONLY codegraph staged
    const resC = await runAgy({
      bin: fx.mockAgyBin,
      model: 'gemini-4-neon-medium',
      prompt: 'cg both enabled',
      cwd: fx.worktree,
      repo: fx.worktree,
      role: 'builder',
      sandbox: true,
      useRoleSettings: true,
      outputFormat: 'stream-json',
      worker: { ticket: 'T-CG-C' },
      env: { AGB_ALLOW_CODEGRAPH_MCP: '1', AGB_TEST_REPORT_FILE: reportFile },
    });
    assert.equal(resC.ok, true, resC.error);
    const repC = JSON.parse(readFileSync(reportFile, 'utf8'));
    // Only codegraph was staged (from BOM+JSONC config/mcp_config.json), NOT canary-config/canary-root/booster-self
    assert.deepEqual(fx.readCanaries(), ['config-codegraph.marker']);
    assert.equal(repC.settings.permissions.deny.includes('call_mcp_tool'), false);
    const stagedRootMcp = JSON.parse(readFileSync(join(fx.worktree, '.agb_home', '.gemini', 'mcp_config.json'), 'utf8'));
    const stagedCfgMcp = JSON.parse(readFileSync(join(fx.worktree, '.agb_home', '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(stagedRootMcp.mcpServers), ['codegraph']);
    assert.deepEqual(Object.keys(stagedCfgMcp.mcpServers), ['codegraph']);
    assert.equal(stagedCfgMcp.mcpServers.codegraph.env.DOCS_URL, 'https://example.com/a//b');

    // Case D: fallback to ~/.gemini/mcp_config.json when ~/.gemini/config/mcp_config.json lacks codegraph
    rmSync(join(fx.userHome, '.gemini', 'config', 'mcp_config.json'), { force: true });
    stageFilteredMcpConfig(
      fx.userHome,
      join(fx.worktree, '.agb_home', '.gemini'),
      join(fx.worktree, '.agb_home', '.gemini', 'config'),
      { allowCodegraph: true, repoRoot: fx.worktree },
    );
    const fallbackMcp = JSON.parse(readFileSync(join(fx.worktree, '.agb_home', '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(fallbackMcp.mcpServers), ['codegraph']);
    assert.equal(fallbackMcp.mcpServers.codegraph.args[2], 'root-codegraph');
  } finally {
    if (savedHomeDir === undefined) delete process.env.AGB_HOME_DIR;
    else process.env.AGB_HOME_DIR = savedHomeDir;
    fx.cleanup();
  }
});

test('win32 staging copies hooks-only booster without symlinks and buildSpawnEnv deduplicates case-variant readonly HOME/USERPROFILE', () => {
  const fx = createCanaryFixture();
  try {
    // Direct stageHooksOnlyBoosterPlugin gracefully handles missing srcPluginDir
    assert.equal(stageHooksOnlyBoosterPlugin(join(fx.root, 'does-not-exist'), join(fx.root, 'dst'), 'win32'), false);

    const agbHome = stageBuilderGeminiHome(fx.worktree, fx.userHome, 'win32');
    const stagedBooster = join(agbHome, '.gemini', 'config', 'plugins', 'antigravity-booster');
    assert.equal(lstatSync(stagedBooster).isSymbolicLink(), false);
    assert.equal(lstatSync(join(stagedBooster, 'bin')).isSymbolicLink(), false);
    assert.equal(lstatSync(join(stagedBooster, 'dist')).isSymbolicLink(), false);
    assert.equal(lstatSync(join(stagedBooster, 'dist', 'hooks')).isSymbolicLink(), false);
    assert.equal(existsSync(join(stagedBooster, 'dist', 'hooks', 'pre-tool-use.bundle.mjs')), true);
    assert.equal(existsSync(join(stagedBooster, 'mcp_config.json')), false);
    assert.equal(existsSync(join(stagedBooster, 'dist', 'mcp-server.mjs')), false);

    const stagedRo = stageReadonlyGeminiHome(fx.userHome, { platform: 'win32' });
    try {
      const roEnv = buildSpawnEnv({
        processEnv: {
          Home: 'C:\\Users\\Old',
          HOME: 'C:\\Users\\OldUpper',
          UserProfile: 'C:\\Users\\Mixed',
          Xdg_Config_Home: 'C:\\Users\\OldXdg',
          agb_user_home: 'C:\\Users\\Spoof',
        },
        sanitizeEnv: false,
        worker: { mode: 'readonly' },
        userHome: fx.userHome,
        readonlyHome: stagedRo.agbHome,
        platform: 'win32',
      });
      assert.deepEqual(Object.keys(roEnv).filter((k) => k.toLowerCase() === 'home'), ['HOME']);
      assert.deepEqual(Object.keys(roEnv).filter((k) => k.toLowerCase() === 'userprofile'), ['USERPROFILE']);
      assert.deepEqual(Object.keys(roEnv).filter((k) => k.toLowerCase() === 'xdg_config_home'), ['XDG_CONFIG_HOME']);
      assert.deepEqual(Object.keys(roEnv).filter((k) => k.toLowerCase() === 'agb_user_home'), ['AGB_USER_HOME']);
      assert.equal(roEnv.HOME, stagedRo.agbHome);
      assert.equal(roEnv.USERPROFILE, stagedRo.agbHome);
      assert.equal(roEnv.XDG_CONFIG_HOME, join(stagedRo.agbHome, '.config'));
      assert.equal(roEnv.AGB_USER_HOME, fx.userHome);
    } finally {
      stagedRo.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('live PreToolUse hook executes from staged hooks-only .agb_home and denies readonly write_file via real pre-tool-use.bundle.mjs', () => {
  // Place fakeUserHome under REPO_ROOT (outside /tmp) so bin/node-launcher.sh trusts
  // the version-manager wrapper under $USER_HOME/.local/share/fnm/... on machines
  // without /usr/bin/node (e.g. fnm/nvm setups).
  const underTmp = /(^|\/)tmp(\/|$)/.test(REPO_ROOT);
  const hookBase = underTmp
    ? realpathSync(mkdtempSync(join(tmpdir(), 'agb-storm-hook-')))
    : realpathSync(mkdtempSync(join(REPO_ROOT, '.agb-storm-hook-')));
  const fakeUserHome = join(hookBase, 'home');
  const targetRepo = realpathSync(mkdtempSync(join(tmpdir(), 'agb-storm-repo-')));
  let stagedRo = null;

  try {
    // Stage real plugin files (bin/hook-runner.sh, bin/node-launcher.sh, dist/hooks/pre-tool-use.bundle.mjs)
    const srcPlugin = join(fakeUserHome, '.gemini', 'config', 'plugins', 'antigravity-booster');
    mkdirSync(join(srcPlugin, 'bin'), { recursive: true });
    mkdirSync(join(srcPlugin, 'dist', 'hooks'), { recursive: true });
    copyFileSync(join(REPO_ROOT, 'plugin.json'), join(srcPlugin, 'plugin.json'));
    copyFileSync(join(REPO_ROOT, 'hooks.json'), join(srcPlugin, 'hooks.json'));
    copyFileSync(join(REPO_ROOT, 'bin', 'hook-runner.sh'), join(srcPlugin, 'bin', 'hook-runner.sh'));
    copyFileSync(join(REPO_ROOT, 'bin', 'node-launcher.sh'), join(srcPlugin, 'bin', 'node-launcher.sh'));
    copyFileSync(
      join(REPO_ROOT, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'),
      join(srcPlugin, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'),
    );
    chmodSync(join(srcPlugin, 'bin', 'hook-runner.sh'), 0o755);
    chmodSync(join(srcPlugin, 'bin', 'node-launcher.sh'), 0o755);

    // Provide a real non-symlink wrapper in fakeUserHome's fnm prefix delegating to process.execPath
    const fnmNodeDir = join(fakeUserHome, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
    mkdirSync(fnmNodeDir, { recursive: true });
    writeFileSync(
      join(fnmNodeDir, 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );

    // Prepare a temp ADLC target repo
    mkdirSync(join(targetRepo, '.git'), { recursive: true });
    mkdirSync(join(targetRepo, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(targetRepo, '.adlc', 'config.json'), '{}\n');
    writeFileSync(join(targetRepo, 'README.md'), '# hello\n');

    stagedRo = stageReadonlyGeminiHome(fakeUserHome);
    const stagedPluginDir = join(stagedRo.agbHome, '.gemini', 'config', 'plugins', 'antigravity-booster');
    assert.equal(existsSync(join(stagedPluginDir, 'mcp_config.json')), false);
    assert.equal(existsSync(join(stagedPluginDir, 'dist', 'mcp-server.mjs')), false);

    const spawnEnv = buildSpawnEnv({
      processEnv: process.env,
      cwd: targetRepo,
      repo: targetRepo,
      worker: { mode: 'readonly' },
      userHome: fakeUserHome,
      readonlyHome: stagedRo.agbHome,
    });

    const payload = JSON.stringify({
      workspacePaths: [targetRepo],
      toolCall: {
        name: 'write_file',
        args: { Path: join(targetRepo, 'README.md'), Content: 'mutated' },
      },
    });

    const res = spawnSync(
      '/bin/sh',
      ['bin/hook-runner.sh', '--timeout', '9', 'dist/hooks/pre-tool-use.bundle.mjs'],
      {
        cwd: stagedPluginDir,
        env: spawnEnv,
        input: payload,
        encoding: 'utf8',
      },
    );

    assert.equal(res.status, 0, `hook-runner exited ${res.status}: stderr=${res.stderr}`);
    const trimmed = res.stdout.trim();
    assert.ok(trimmed.length > 0, `expected deny decision JSON, got empty stdout (stderr=${res.stderr})`);
    const parsed = JSON.parse(trimmed);
    assert.equal(parsed.decision, 'deny');
    if (!underTmp) {
      assert.doesNotMatch(
        parsed.reason || '',
        /Hook runner fail-safe/,
        `expected real pre-tool-use.bundle.mjs denial rather than shell fallback: ${trimmed}`,
      );
    }
  } finally {
    stagedRo?.cleanup();
    rmSync(hookBase, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test('fake-agy strictly rejects unknown --settings top-level keys mirroring agy 1.5.15', async () => {
  const res = await runAgy({
    bin: FAKE_AGY,
    model: 'gemini-4-neon-medium',
    prompt: 'settings rejection test',
    role: 'prosecutor',
    worker: { mode: 'readonly' },
    settings: { mcpServersDisabled: true },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Error: --settings: unknown setting "mcpServersDisabled"/);
});

test('stageIsolatedGeminiHome stages only Library/Keychains on darwin for agy 1.5.17 OAuth', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agb-keychain-')));
  const userHome = join(root, 'user-home');
  const agbDarwin = join(root, 'agb-darwin');
  const agbLinux = join(root, 'agb-linux');
  try {
    mkdirSync(join(userHome, 'Library', 'Keychains'), { recursive: true });
    mkdirSync(join(userHome, 'Library', 'Cookies'), { recursive: true });
    writeFileSync(join(userHome, 'Library', 'Keychains', 'login.keychain-db'), 'stub');

    stageIsolatedGeminiHome(agbDarwin, userHome, { mode: 'readonly', platform: 'darwin' });
    assert.equal(existsSync(join(agbDarwin, 'Library', 'Keychains', 'login.keychain-db')), true);
    assert.equal(lstatSync(join(agbDarwin, 'Library', 'Keychains')).isSymbolicLink(), true);
    assert.equal(existsSync(join(agbDarwin, 'Library', 'Cookies')), false);

    stageIsolatedGeminiHome(agbLinux, userHome, { mode: 'readonly', platform: 'linux' });
    assert.equal(existsSync(join(agbLinux, 'Library')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
