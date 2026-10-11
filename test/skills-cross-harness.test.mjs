// Tests for the cross-harness skill layout (T-SKILLS-CROSS-HARNESS).
//
// skills/<name>/ is canonical; .claude/skills and .agents/skills are generated
// mirrors for Claude Code and for Codex/agy. These tests pin the contracts that
// let one SKILL.md run in all three: portable frontmatter, in-sync mirrors, and a
// stated fallback wherever a body reaches for a Claude-only tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalSkills, syncSkills, syncMain, isSafeSkillName, MIRRORS, MANIFEST } from '../scripts/sync-skills.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return m ? m[1] : null;
}

function scratchRepo(t, skills = { alpha: { 'SKILL.md': '---\nname: alpha\ndescription: a\n---\n# a\n', 'scripts/run.mjs': 'x' } }) {
  const root = mkdtempSync(join(tmpdir(), 'agb-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, body] of Object.entries(files)) {
      const p = join(root, 'skills', name, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    }
  }
  return root;
}

// ---------------------------------------------------------------- real repo

test('the repo ships the three project skills from skills/', () => {
  assert.deepEqual(canonicalSkills(ROOT), ['modernize', 'release', 'release-audit']);
});

test('every skill has frontmatter all three harnesses accept', () => {
  for (const name of canonicalSkills(ROOT)) {
    const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    assert.ok(fm, `${name}: SKILL.md must open with YAML frontmatter`);
    assert.match(fm, new RegExp(`^name: ${name}$`, 'm'), `${name}: frontmatter name must equal the directory name`);
    assert.ok(name.length <= 64 && /^[a-z0-9-]+$/.test(name), `${name}: Codex needs a lowercase-hyphen name of at most 64 chars`);
    assert.match(fm, /^description: ["'A-Za-z]/m, `${name}: description must be a single logical line, not a YAML block scalar (the docs generator and some harnesses do not expand >- or |)`);
    // Codex caps description at 1024 chars; collapse folded-scalar whitespace the way YAML does.
    const desc = /^description:[ \t]*(?:[>|][-+]?)?\n?([\s\S]*?)(?=\n[A-Za-z][\w-]*:|$)/m.exec(fm);
    assert.ok(desc, `${name}: description is required`);
    const flat = desc[1].replace(/\s+/g, ' ').trim();
    assert.ok(flat.length > 0, `${name}: description must not be empty`);
    assert.ok(flat.length <= 1024, `${name}: description is ${flat.length} chars, Codex rejects more than 1024`);
  }
});

test('the harness mirrors are byte-identical to skills/', () => {
  const r = syncSkills({ root: ROOT, check: true });
  assert.deepEqual(r.problems, [], 'run `npm run skills:sync` and commit the mirrors');
  assert.equal(r.ok, true);
});

test('both discovery dirs carry every skill', () => {
  for (const mirror of MIRRORS) {
    for (const name of canonicalSkills(ROOT)) {
      assert.ok(existsSync(join(ROOT, mirror, name, 'SKILL.md')), `${mirror}/${name}/SKILL.md must exist`);
    }
  }
});

test('a Claude-only tool in a skill body always comes with a stated fallback', () => {
  // Workflow / Artifact / Agent exist only in Claude Code. A body may name them,
  // but Codex and agy runs must be told what to do instead.
  for (const name of canonicalSkills(ROOT)) {
    const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    if (!/\*\*(Workflow|Artifact)\*\*|Workflow\(|`Workflow`|Artifact tool/.test(text)) continue;
    assert.match(text, /## Harness notes/, `${name}: names a Claude-only tool, so it needs a "## Harness notes" section`);
    for (const harness of ['Claude Code', 'Codex', 'agy']) {
      assert.ok(text.includes(harness), `${name}: Harness notes must cover ${harness}`);
    }
  }
});

test('no skill body relies on a bare slash command to reach another skill', () => {
  // Codex invokes skills as $name and agy by name; "/release" only works in Claude Code.
  for (const name of canonicalSkills(ROOT)) {
    const body = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    const hits = [...body.matchAll(/(^|[\s(`])\/(release|release-audit|modernize|adversarial-review)\b/g)].map((m) => m[0].trim());
    assert.deepEqual(hits, [], `${name}: say "the release skill", not a slash command`);
  }
});

// ---------------------------------------------------------------- sync mechanics

test('sync writes every mirror and records what it manages', (t) => {
  const root = scratchRepo(t);
  const r = syncSkills({ root });
  assert.equal(r.ok, true);
  for (const mirror of MIRRORS) {
    assert.equal(readFileSync(join(root, mirror, 'alpha', 'scripts', 'run.mjs'), 'utf8'), 'x');
    assert.deepEqual(JSON.parse(readFileSync(join(root, mirror, MANIFEST), 'utf8')), { managed: ['alpha'] });
  }
  assert.deepEqual(syncSkills({ root, check: true }).problems, []);
});

test('check reports missing, differing and extra files and writes nothing', (t) => {
  const root = scratchRepo(t);
  assert.ok(syncSkills({ root, check: true }).problems.some((p) => /alpha: missing/.test(p)));
  assert.equal(existsSync(join(root, '.claude')), false, '--check must never write');

  syncSkills({ root });
  writeFileSync(join(root, '.agents/skills/alpha/SKILL.md'), 'tampered');
  writeFileSync(join(root, '.claude/skills/alpha/stray.txt'), 's');
  rmSync(join(root, '.claude/skills/alpha/scripts/run.mjs'));
  const problems = syncSkills({ root, check: true }).problems.join('\n');
  assert.match(problems, /\.agents\/skills\/alpha: differs SKILL\.md/);
  assert.match(problems, /\.claude\/skills\/alpha: extra file stray\.txt/);
  assert.match(problems, /\.claude\/skills\/alpha: missing file scripts\/run\.mjs/);
});

test('sync repairs drift and leaves foreign skills alone', (t) => {
  const root = scratchRepo(t);
  const foreign = join(root, '.claude/skills/someone-elses');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'SKILL.md'), 'theirs');
  syncSkills({ root });
  writeFileSync(join(root, '.claude/skills/alpha/SKILL.md'), 'tampered');
  syncSkills({ root });
  assert.deepEqual(syncSkills({ root, check: true }).problems, []);
  assert.equal(readFileSync(join(foreign, 'SKILL.md'), 'utf8'), 'theirs');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/skills', MANIFEST), 'utf8')).managed, ['alpha']);
});

test('a skill removed from skills/ is removed from the mirrors it created, and only that one', (t) => {
  const root = scratchRepo(t, {
    alpha: { 'SKILL.md': '---\nname: alpha\ndescription: a\n---\n' },
    beta: { 'SKILL.md': '---\nname: beta\ndescription: b\n---\n' },
  });
  syncSkills({ root });
  const foreign = join(root, '.agents/skills/someone-elses');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'SKILL.md'), 'theirs');

  rmSync(join(root, 'skills/beta'), { recursive: true });
  assert.ok(syncSkills({ root, check: true }).problems.some((p) => /beta: removed from skills\//.test(p)));
  syncSkills({ root });
  assert.equal(existsSync(join(root, '.agents/skills/beta')), false);
  assert.equal(existsSync(join(root, '.claude/skills/beta')), false);
  assert.equal(existsSync(foreign), true);
});

test('a symlink inside a skill tree is refused, not followed', (t) => {
  const root = scratchRepo(t);
  symlinkSync('/etc/passwd', join(root, 'skills/alpha/leak'));
  assert.throws(() => syncSkills({ root }), /refusing symlink/);
});

test('syncMain: exit codes, usage and the check message', (t) => {
  const root = scratchRepo(t);
  const out = [];
  const errs = [];
  const io = { log: (m) => out.push(m), err: (m) => errs.push(m), root };
  assert.equal(syncMain(['--check'], io), 1);
  assert.match(errs.join('\n'), /npm run skills:sync/);
  assert.equal(syncMain([], io), 0);
  assert.equal(syncMain(['--check'], io), 0);
  assert.match(out.join('\n'), /in sync/);
  assert.equal(syncMain(['--bogus'], io), 1);
  assert.equal(readdirSync(join(root, 'skills')).length, 1);
});

test('a crafted manifest cannot make sync delete anything outside the mirror', (t) => {
  const root = scratchRepo(t);
  syncSkills({ root });
  const victim = join(root, 'lib');
  mkdirSync(victim);
  writeFileSync(join(victim, 'keep.mjs'), 'precious');
  writeFileSync(join(root, '.agents/skills', MANIFEST), JSON.stringify({ managed: ['alpha', '../../lib', '..', '/etc', 'a/b'] }));
  syncSkills({ root });
  assert.equal(readFileSync(join(victim, 'keep.mjs'), 'utf8'), 'precious');
  assert.equal(existsSync(join(root, 'skills')), true);
  // and --check must not treat the hostile entry as a stale mirror either
  assert.deepEqual(syncSkills({ root, check: true }).problems, []);
});

test('isSafeSkillName admits plain directory names only', () => {
  for (const ok of ['alpha', 'release-audit', 'a.b_c']) assert.equal(isSafeSkillName(ok), true, ok);
  for (const bad of ['', '..', '../x', 'a/b', '/abs', '.hidden', 'a..b', 7, null]) assert.equal(isSafeSkillName(bad), false, String(bad));
});

test('emptying skills/ clears the manifest so a later foreign skill of the same name survives', (t) => {
  const root = scratchRepo(t);
  syncSkills({ root });
  rmSync(join(root, 'skills/alpha'), { recursive: true });
  assert.ok(syncSkills({ root, check: true }).problems.length > 0, 'stale mirror must be reported');
  syncSkills({ root });
  for (const mirror of MIRRORS) {
    assert.deepEqual(JSON.parse(readFileSync(join(root, mirror, MANIFEST), 'utf8')), { managed: [] });
    mkdirSync(join(root, mirror, 'alpha'));
    writeFileSync(join(root, mirror, 'alpha/SKILL.md'), 'mine');
  }
  syncSkills({ root });
  for (const mirror of MIRRORS) assert.equal(readFileSync(join(root, mirror, 'alpha/SKILL.md'), 'utf8'), 'mine');
  assert.deepEqual(syncSkills({ root, check: true }).problems, []);
});
