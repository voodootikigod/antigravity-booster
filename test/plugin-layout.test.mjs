// Native agy plugin layout (T-PLUGIN-01-CORE, spec §2.1, §4.1, §4.5, Appendix A D3/D7/D9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const EXPECTED_COMMANDS = [
  'agb-bootstrap.md',
  'agb-doctor.md',
  'agb-migrate.md',
  'agb-plan.md',
  'agb-review.md',
  'agb-run.md',
  'agb-sidecar.md',
];
const EXPECTED_AGENTS = ['fleet-scheduler.md', 'prosecutor.md', 'spec-linter.md'];

/** Parse a leading `---` YAML frontmatter block of flat `key: value` lines. */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: m[2] };
}

test('layout: root plugin.json is a minimal valid manifest named antigravity-booster', () => {
  const manifest = readJson('plugin.json');
  assert.equal(manifest.name, 'antigravity-booster');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);
  assert.equal(typeof manifest.author, 'string');
  assert.equal(manifest.sidecars, undefined, 'agy does not recognise a sidecars category (spec §2.1)');
  if (manifest.agents !== undefined) {
    for (const p of manifest.agents) {
      assert.ok(!String(p).includes('.agents'), `agents entry must not point into .agents/: ${p}`);
    }
  }
});

test('layout: hooks.json is exactly the single agb-policy-guard registration (spec §4.1)', () => {
  assert.deepEqual(readJson('hooks.json'), {
    'agb-policy-guard': {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: '/bin/sh bin/hook-runner.sh --timeout 9 dist/hooks/pre-tool-use.bundle.mjs',
              timeout: 15,
            },
          ],
        },
      ],
    },
  });
});

test('layout: mcp_config.json launches the bundled MCP server via node-launcher (spec §4.1)', () => {
  assert.deepEqual(readJson('mcp_config.json'), {
    mcpServers: {
      agb: {
        command: '/bin/sh',
        args: ['${PLUGIN_ROOT}/bin/node-launcher.sh', '${PLUGIN_ROOT}/dist/mcp-server.mjs'],
      },
    },
  });
});

test('layout: commands/ holds exactly the 7 agb slash commands', () => {
  const files = readdirSync(join(ROOT, 'commands')).sort();
  assert.deepEqual(files, EXPECTED_COMMANDS);
  for (const file of files) {
    const fm = parseFrontmatter(readFileSync(join(ROOT, 'commands', file), 'utf8'));
    assert.ok(fm, `${file} must start with YAML frontmatter`);
    assert.equal(fm.fields.name, file.replace(/\.md$/, ''), `${file} frontmatter name`);
    assert.ok(fm.fields.description, `${file} must declare a description`);
  }
});

test('layout: agents/ holds the 3 converted subagents with name/description/tools frontmatter (spec §4.5)', () => {
  const files = readdirSync(join(ROOT, 'agents')).sort();
  assert.deepEqual(files, EXPECTED_AGENTS);
  for (const file of files) {
    const fm = parseFrontmatter(readFileSync(join(ROOT, 'agents', file), 'utf8'));
    assert.ok(fm, `${file} must start with YAML frontmatter`);
    assert.equal(fm.fields.name, file.replace(/\.md$/, ''));
    assert.ok(fm.fields.description, `${file} must declare a description`);
    assert.ok(fm.fields.tools, `${file} must declare tools`);
    const tools = fm.fields.tools.split(',').map((t) => t.trim());
    assert.ok(tools.length > 0 && tools.every(Boolean), `${file} tools must be a comma list`);
    assert.ok(fm.body.trim().length > 0, `${file} must carry the system prompt as its body`);
  }
});

test('layout: MCP server source lives at mcp/server.mjs', () => {
  assert.ok(existsSync(join(ROOT, 'mcp', 'server.mjs')));
});

test('layout: the legacy .agents/ tree is gone (Appendix A D9); top-level sidecars/ is the dashboard source', () => {
  assert.equal(existsSync(join(ROOT, '.agents')), false);
  assert.ok(statSync(join(ROOT, 'sidecars')).isDirectory());
});

function agyAvailable() {
  const r = spawnSync('agy', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0;
}

test('layout: agy plugin validate processes skills, agents, commands, mcpServers and hooks', (t) => {
  if (!agyAvailable()) {
    t.skip('agy not on PATH; CI stays offline (spec D8)');
    return;
  }
  const r = spawnSync('agy', ['plugin', 'validate', ROOT], { encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(r.status, 0, out);
  for (const category of ['skills', 'agents', 'commands', 'mcpServers', 'hooks']) {
    assert.match(out, new RegExp(`${category}\\s*:\\s*\\d+ processed`), `${category} not processed:\n${out}`);
  }
});
