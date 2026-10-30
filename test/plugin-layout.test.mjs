// Native agy plugin layout (T-PLUGIN-01-CORE, spec §2.1, §4.1, §4.5, Appendix A D3/D7/D9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageMarketplacePlugin, validateStagedPluginStrict } from '../scripts/stage-marketplace-plugin.mjs';

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

test('layout: the legacy .agents/ tree is gone (Appendix A D9, amended); .agents/ may hold only the generated skills mirror; top-level sidecars/ is the dashboard source', () => {
  // Codex and agy discover repo skills at .agents/skills/, so that one generated
  // mirror (scripts/sync-skills.mjs) is allowed. Nothing else: no second editable
  // copy of sidecars, agents or skills sources.
  const agentsDir = join(ROOT, '.agents');
  // A harness may add its own state next to it, so ban the legacy trees by name rather than pinning the listing.
  for (const legacy of ['sidecars', 'agents', 'commands', 'hooks']) {
    assert.equal(existsSync(join(agentsDir, legacy)), false, `.agents/${legacy} is a legacy D9 tree`);
  }
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
  for (const category of ['skills', 'agents', ' mcpServers', 'hooks']) {
    const trimmed = category.trim();
    assert.match(
      out,
      new RegExp(`${trimmed}\\s*(?::\\s*\\d+\\s+processed|\\s+\\d+)`),
      `${trimmed} not processed:\n${out}`,
    );
  }
  if (out.includes('commands')) {
    assert.match(out, /commands\s*(?::\s*\d+\s+processed|\s+\d+|: never loaded)/, `commands not processed:\n${out}`);
  }
  assert.match(out, /Validation passed/i, `Validation did not pass:\n${out}`);
});

test('layout: plugin.json has Marketplace discovery metadata, assets/logo.svg, rules/AGENTS.md, and 7 agb-* skills', () => {
  const manifest = readJson('plugin.json');
  assert.equal(manifest.displayName, 'Antigravity Booster');
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.equal(manifest.homepage, 'https://www.agybooster.com');
  assert.equal(manifest.repository, 'https://github.com/voodootikigod/antigravity-booster');
  assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length === 3, 'suggestedPrompts must have 3 starter prompts');
  for (const p of manifest.suggestedPrompts) {
    assert.ok(typeof p === 'string' && p.length >= 20, `invalid suggestedPrompt: ${p}`);
  }
  const logoSvg = readFileSync(join(ROOT, 'assets', 'logo.svg'), 'utf8');
  assert.match(logoSvg, /viewBox="0 0 256 256"/);
  assert.match(logoSvg, /width="256"/);
  assert.match(logoSvg, /height="256"/);

  const rulesMd = readFileSync(join(ROOT, 'rules', 'AGENTS.md'), 'utf8');
  assert.match(rulesMd, /mcp__agb__agb_plan/);
  assert.match(rulesMd, /\/agb-run/);

  for (const skill of ['agb-bootstrap', 'agb-doctor', 'agb-migrate', 'agb-plan', 'agb-review', 'agb-run', 'agb-sidecar']) {
    const skillPath = join(ROOT, 'skills', skill, 'SKILL.md');
    assert.ok(existsSync(skillPath), `missing native skill ${skillPath}`);
    const content = readFileSync(skillPath, 'utf8');
    assert.match(content, new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, 'm'));
  }
});

test('layout: stageMarketplacePlugin produces clean bundle + marketplace.json and passes agy plugin validate --strict with 0 warnings/notes', () => {
  const staged = stageMarketplacePlugin({ repoRoot: ROOT });
  try {
    assert.equal(existsSync(join(staged.pluginDir, 'AGENTS.md')), false, 'root AGENTS.md excluded from staged bundle');
    assert.equal(existsSync(join(staged.pluginDir, 'commands')), false, 'legacy commands/ excluded from staged bundle');
    assert.equal(existsSync(join(staged.pluginDir, 'rules', 'AGENTS.md')), true, 'rules/AGENTS.md present');
    assert.equal(existsSync(join(staged.pluginDir, 'assets', 'logo.svg')), true, 'assets/logo.svg present');
    assert.equal(existsSync(join(staged.pluginDir, 'skills', 'modernize')), false, 'maintainer-only skills excluded');
    assert.equal(existsSync(join(staged.pluginDir, 'skills', 'agb-run', 'SKILL.md')), true, 'user-facing skills included');
    assert.equal(staged.catalog.name, 'agybooster');
    assert.equal(staged.catalog.plugins.length, 2);

    const strictRes = validateStagedPluginStrict(staged.pluginDir);
    if (!strictRes.skipped) {
      assert.equal(strictRes.ok, true, JSON.stringify(strictRes));
      assert.equal(strictRes.errors, 0);
      assert.equal(strictRes.warnings, 0);
      assert.equal(strictRes.notes, 0);
    }
  } finally {
    rmSync(staged.stageRoot, { recursive: true, force: true });
  }
});
