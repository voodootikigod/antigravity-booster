// §7.12: generator determinism, --check, env drift (positive and negative), required env entries,
// --extra-token, and negative fixtures for the COMMANDS / TOOLS parsers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { convertRootDoc, parseExports, parseFlags } from '../gen-reference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'gen-reference.mjs');
const WEBSITE = path.join(HERE, '..', '..');
const gen = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

// The §7.2 required list; each must be in env-docs.json vars and rendered (unless test-only).
const REQUIRED = [
  'ANTIGRAVITY_SIDECAR_WEB_PORT',
  'ANTIGRAVITY_CONVERSATION_ID',
  'ADLC_ADMIN_KEY',
  'ADLC_MANIFEST_KEY',
  'ADLC_P4_ENFORCEMENT',
  'ADLC_PROVIDER',
  'ADLC_TICKET',
  'ADLC_TICKETS',
  'ADLC_TICKET_STORE',
  'ADLC_ANTIGRAVITY_PLUGIN_NAME',
  'ADLC_ANTIGRAVITY_PLUGIN_PATH',
  'AGB_AGY_BIN',
  'AGB_CALIBRATION_DIR',
  'AGB_ALLOW_DIRTY',
  'AGB_BUILD_TIMEOUT',
  'AGB_REQUIRE_DRIVER_SIGNATURE',
  'AGB_SANDBOX_PROBE_CMD',
  'AGB_SANDBOX_PROBE_HELPER',
  'AGB_DEV_ALLOW_UNVERIFIED_PLUGIN',
  'AGB_HOOK_DISABLE',
  'AGB_WORKER_MODE',
  'AGB_WORKER_TICKET',
  'AGB_STRICT_GATES',
  'AGB_SIDECAR_PORT',
  'AGB_BUILD_MAX_TIMEOUT',
  'AGB_EVENT_PROGRESS_TIMEOUT',
  'AGB_KILL_GRACE_MS',
  'AGB_QUOTA_TIMEOUT_MS',
  'AGB_POOLS_DIR',
  'AGB_POOLS_V2',
  'AGB_POOLS_LOCK',
  'AGB_QUOTA_STATE',
  'AGB_HOME_DIR',
  'AGB_EXEC_CACHE_DIR',
  'AGB_EXEC_LOCKS_DIR',
  'AGB_ALLOW_SYSTEM_ADLC',
  'AGB_ALLOW_CUSTOM_ADLC_CLI',
  'AGB_BRAIN_DIR',
  'AGB_ARTIFACT_DIR',
  'AGB_SESSION_ID',
  'AGB_TARGET_REPO',
  'AGB_PROVIDER',
  'AGB_SANDBOX_GATES',
  'AGB_PLUGIN_DIR',
  'AGB_PLUGIN_ROOT',
  'AGB_ADLC_BIN',
  'ADLC_CLI_PATH',
];

/** A minimal fake repo with every generator input. `over` replaces files by relative path. */
function fakeRepo(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agb-gen-'));
  const files = {
    'bin/agb.mjs': [
      'const rawArgs = process.argv.slice(2);',
      "for (let i = 0; i < rawArgs.length; i++) { if (rawArgs[i] === '--project') {} }",
      'const COMMANDS = {',
      "  run: { args: '<plan.json>', desc: 'execute a ticket DAG' },",
      "  bootstrap: { args: '[--force]', desc: 'wire skills', flags: '--force-reinstall (replace the plugin)' },",
      '};',
      "if (cmd === '--version' || cmd === '-v') {}",
      "if (!cmd || cmd === 'help' || cmd === '--help') {}",
      "const name = (cmd === 'setup' || cmd === 'install') ? 'bootstrap' : cmd;",
      'const home = process.env.AGB_HOME_DIR;',
      '',
    ].join('\n'),
    'mcp/server.mjs': [
      'const TOOLS = [',
      "  { name: 'agb_run', description: 'Run a plan', inputSchema: { type: 'object',",
      "    properties: { plan: { type: 'string', description: 'Path' } }, required: ['plan'] } },",
      '];',
      'export function main() {}',
      '',
    ].join('\n'),
    'lib/a.mjs': "export const X = 1;\nexport { y as z } from './b.mjs';\n// ADLC_DIGESTS is a constant name\n",
    'lib/test/ignored.mjs': 'process.env.AGB_ONLY_IN_TESTS;\n',
    'scripts/s.mjs': 'process.env.ANTIGRAVITY_THING;\n',
    'plugin.json': '{ "name": "p", "version": "1.0.0" }\n',
    'hooks.json': '{}\n',
    'mcp_config.json': '{ "mcpServers": {} }\n',
    'package.json': '{ "files": ["lib/"] }\n',
    'commands/c.md': '---\nname: c\ndescription: A command\n---\n\n# /c [x]\n',
    'agents/a.md': '---\nname: a\ndescription: An agent\ntools: view_file\n---\n',
    'skills/s/SKILL.md': '---\nname: s\ndescription: A skill\nuser-invocable: true\n---\n',
    'CONTRIBUTING.md': '# Contributing\n\nSee [SECURITY.md](SECURITY.md) and `<x>`.\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- a {b}\n',
    'website/env-docs.json': JSON.stringify(
      {
        vars: [
          { name: 'AGB_HOME_DIR', group: 'paths', description: 'Home.', default: 'home', bundledIgnored: false },
          { name: 'ANTIGRAVITY_THING', group: 'internal/test-only', description: 'T.', bundledIgnored: false },
        ],
        ignore: [{ name: 'ADLC_DIGESTS', reason: 'constant name, not an environment variable' }],
      },
      null,
      2,
    ),
    ...over,
  };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('the committed partials are up to date (--check)', () => {
  const r = gen('--check');
  assert.equal(r.status, 0, r.stderr);
});

test('generation is byte-identical across runs', () => {
  const out1 = mkdtempSync(path.join(tmpdir(), 'agb-gen-out-'));
  const out2 = mkdtempSync(path.join(tmpdir(), 'agb-gen-out-'));
  try {
    assert.equal(gen('--out', out1).status, 0);
    assert.equal(gen('--out', out2).status, 0);
    for (const f of ['cli-run.mdx', 'environment.mdx', 'modules.mdx', 'mcp-tools.mdx', 'changelog.mdx'])
      assert.equal(readFileSync(path.join(out1, f), 'utf8'), readFileSync(path.join(out2, f), 'utf8'));
  } finally {
    rmSync(out1, { recursive: true, force: true });
    rmSync(out2, { recursive: true, force: true });
  }
});

test('--check fails when a committed partial is stale', () => {
  const repo = fakeRepo();
  try {
    assert.equal(gen('--repo', repo).status, 0);
    writeFileSync(path.join(repo, 'website/generated/cli-run.mdx'), 'stale\n');
    const r = gen('--repo', repo, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /website\/generated\/cli-run\.mdx:1: out of date/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fake repo: every generator output, aliases, flags, root-doc rewrite', () => {
  const repo = fakeRepo();
  try {
    const r = gen('--repo', repo);
    assert.equal(r.status, 0, r.stderr);
    const read = (f) => readFileSync(path.join(repo, 'website/generated', f), 'utf8');
    assert.match(read('cli-bootstrap.mdx'), /\| --force-reinstall \| — \| replace the plugin \|/);
    assert.match(read('cli-bootstrap.mdx'), /Aliases: `agb setup`, `agb install`/);
    assert.match(read('cli-index.mdx'), /\| --project \|/);
    assert.match(read('modules.mdx'), /\| lib\/a\.mjs \| X, z; re-exports \.\/b\.mjs \|/);
    assert.match(read('mcp-tools.mdx'), /\| plan \| string \| yes \| Path \|/);
    assert.doesNotMatch(read('environment.mdx'), /ANTIGRAVITY_THING/, 'test-only group is not rendered');
    assert.match(read('environment.mdx'), /\| AGB_HOME_DIR \| home \| Home\. \| honoured \|/);
    assert.match(
      read('contributing.mdx'),
      /\[SECURITY\.md\]\(https:\/\/github\.com\/voodootikigod\/antigravity-booster\/blob\/main\/SECURITY\.md\)/,
    );
    assert.doesNotMatch(read('contributing.mdx'), /^# Contributing/m);
    assert.match(read('changelog.mdx'), /a &#123;b&#125;/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('env drift: undocumented token, stale vars entry and stale ignore entry all fail with file:line', () => {
  const repo = fakeRepo({
    'lib/b.mjs': 'process.env.AGB_UNDOCUMENTED;\n',
    'lib/a.mjs': 'export const X = 1;\n',
    'website/env-docs.json': JSON.stringify(
      {
        vars: [
          { name: 'AGB_HOME_DIR', group: 'paths', description: 'Home.', bundledIgnored: false },
          { name: 'AGB_GONE', group: 'core', description: 'Removed.', bundledIgnored: false },
          { name: 'ANTIGRAVITY_THING', group: 'internal/test-only', description: 'T.', bundledIgnored: false },
        ],
        ignore: [{ name: 'ADLC_DIGESTS', reason: 'constant' }],
      },
      null,
      2,
    ),
  });
  try {
    const r = gen('--repo', repo, '--env-only', '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lib\/b\.mjs:1: AGB_UNDOCUMENTED found in code but not in env-docs\.json/);
    assert.match(r.stderr, /website\/env-docs\.json:\d+: AGB_GONE is documented in vars but not found in code/);
    assert.match(r.stderr, /website\/env-docs\.json:\d+: ADLC_DIGESTS is in ignore but not found in code/);
    assert.doesNotMatch(r.stderr, /AGB_ONLY_IN_TESTS/, 'test/ directories are not scanned');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('--extra-token makes the real env check fail and names the token (AC12)', () => {
  const ok = gen('--env-only', '--check');
  assert.equal(ok.status, 0, ok.stderr);
  const r = gen('--env-only', '--check', '--extra-token', 'AGB_FAKE_UNDOCUMENTED', '--extra-token', 'AGB_FAKE_TWO');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AGB_FAKE_UNDOCUMENTED/);
  assert.match(r.stderr, /AGB_FAKE_TWO/);
});

test('env-docs.json carries every §7.2 required entry, rendered, with the sidecar security text', () => {
  const docs = JSON.parse(readFileSync(path.join(WEBSITE, 'env-docs.json'), 'utf8'));
  const byName = new Map(docs.vars.map((v) => [v.name, v]));
  const rendered = readFileSync(path.join(WEBSITE, 'generated/environment.mdx'), 'utf8');
  for (const name of REQUIRED) {
    assert.ok(byName.has(name), `${name} missing from vars`);
    assert.notEqual(byName.get(name).group, 'internal/test-only', `${name} must be rendered`);
    assert.match(rendered, new RegExp(`^\\| ${name} \\|`, 'm'), `${name} not rendered`);
  }
  assert.match(byName.get('ANTIGRAVITY_SIDECAR_WEB_PORT').security, /disables token auth/);
  for (const v of docs.vars.filter((x) => x.group === 'internal/test-only'))
    assert.doesNotMatch(rendered, new RegExp(`\\b${v.name}\\b`));
  for (const name of ['ADLC_ANTIGRAVITY_PLUGIN_PATH', 'AGB_DEV_ALLOW_UNVERIFIED_PLUGIN'])
    assert.equal(byName.get(name).bundledIgnored, true, name);
});

for (const [label, literal, line] of [
  ['spread', "const COMMANDS = {\n  run: { args: '', desc: 'x' },\n  ...EXTRA,\n};\n", 3],
  ['computed key', "const COMMANDS = {\n  run: { args: '', desc: 'x' },\n  [dyn]: { args: '', desc: 'y' },\n};\n", 3],
])
  test(`COMMANDS parser rejects a ${label} with bin/agb.mjs:<line>`, () => {
    const repo = fakeRepo({ 'bin/agb.mjs': literal });
    try {
      const r = gen('--repo', repo, '--only', 'cli', '--check');
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`^bin/agb\\.mjs:${line}: COMMANDS: .*${label.split(' ')[0]}`, 'm'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

for (const [label, literal, line] of [
  ['spread', "const TOOLS = [\n  { name: 'a', description: 'x' },\n  ...more,\n];\n", 3],
  ['computed key', "const TOOLS = [\n  { name: 'a',\n    [k]: 'x' },\n];\n", 3],
])
  test(`TOOLS parser rejects a ${label} with mcp/server.mjs:<line>`, () => {
    const repo = fakeRepo({ 'mcp/server.mjs': literal });
    try {
      const r = gen('--repo', repo, '--only', 'modules', '--check');
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`^mcp/server\\.mjs:${line}: TOOLS: .*${label.split(' ')[0]}`, 'm'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

test('unknown --only value and unknown flags exit 1', () => {
  assert.equal(gen('--only', 'nope').status, 1);
  assert.equal(gen('--bogus').status, 1);
});

test('parseFlags handles brackets, arguments and parenthesised descriptions', () => {
  assert.deepEqual(parseFlags('--watch [--interval <ms>]'), [
    { flag: '--interval', arg: '<ms>', desc: '' },
    { flag: '--watch', arg: '', desc: '' },
  ]);
  assert.deepEqual(parseFlags('--force (re-run) --force'), [{ flag: '--force', arg: '', desc: 're-run' }]);
});

test('parseExports covers declarations, lists, defaults and star re-exports', () => {
  const src = [
    'export async function a() {}',
    'export class B {}',
    'export const { c, d: e } = obj;',
    'export { f, g as h };',
    "export * from './x.mjs';",
    "export * as ns from './y.mjs';",
    'export default 1;',
  ].join('\n');
  assert.deepEqual(parseExports(src), {
    names: ['B', 'a', 'c', 'default', 'e', 'f', 'h', 'ns'],
    reexports: ['* from ./x.mjs', '* from ./y.mjs'],
  });
});

test('convertRootDoc keeps code untouched and leaves absolute links alone', () => {
  const out = convertRootDoc(
    '# T\n\n```js\nconst a = {b: 1} < 2;\n```\n\n[x](https://e.com) [d](docs/a.md#h) `{c}` <https://u.io>\n',
    'CONTRIBUTING.md',
  );
  assert.match(out, /const a = \{b: 1\} < 2;/);
  assert.match(out, /\[x\]\(https:\/\/e\.com\)/);
  assert.match(out, /blob\/main\/docs\/a\.md#h\)/);
  assert.match(out, /`\{c\}`/);
  assert.match(out, /\[https:\/\/u\.io\]\(https:\/\/u\.io\)/);
});

test('dispatchFlags finds flags read from rest in a command branch only', async () => {
  const { dispatchFlags } = await import('../gen-reference.mjs');
  const src = [
    "if (cmd === 'run') {",
    "  const x = rest.includes('--dry');",
    "} else if (cmd === 'preflight') {",
    "  const skip = rest.includes('--no-coldstart');",
    "  if (rest[i] === '--out') {}",
    "} else if (cmd === 'plan') {",
    "  rest.indexOf('--interval');",
    '}',
  ].join('\n');
  assert.deepEqual(dispatchFlags(src, 'preflight'), ['--no-coldstart', '--out']);
  assert.deepEqual(dispatchFlags(src, 'run'), ['--dry']);
  assert.deepEqual(dispatchFlags(src, 'plan'), ['--interval']);
  assert.deepEqual(dispatchFlags(src, 'missing'), []);
});

test('generated preflight reference lists --no-coldstart', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../generated/cli-preflight.mdx', import.meta.url), 'utf8');
  assert.match(page, /--no-coldstart/);
  assert.doesNotMatch(page, /takes no flags/);
});
