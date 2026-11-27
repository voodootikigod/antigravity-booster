import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureGitignore, isDirty, syncCodegraphIndex } from '../lib/worktrees.mjs';

function initRepo(dir) {
  const g = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'agb-test');
  g('config', 'user.email', 'agb-test@local');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  g('add', 'README.md');
  g('commit', '--no-gpg-sign', '-q', '-m', 'init');
}

test('isDirty ignores untracked .codegraph/.gitignore while detecting real changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-wt-cg-'));
  try {
    initRepo(dir);
    assert.equal(isDirty(dir), false);

    // Simulate `codegraph init` creating untracked .codegraph/.gitignore & index files
    mkdirSync(join(dir, '.codegraph'), { recursive: true });
    writeFileSync(join(dir, '.codegraph', '.gitignore'), '*\n');
    writeFileSync(join(dir, '.codegraph', 'graph.db'), 'sqlite-placeholder');

    assert.equal(
      isDirty(dir),
      false,
      'untracked .codegraph/.gitignore and index files must not trip isDirty()'
    );

    // Real untracked source file still marks repo dirty
    writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n');
    assert.equal(isDirty(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureGitignore preserves canonical stanza byte-identical without adding .codegraph/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-wt-gi-'));
  try {
    initRepo(dir);
    const modified = ensureGitignore(dir);
    assert.equal(modified, true);

    const expected = [
      '.worktrees/',
      '.booster/',
      '.adlc/*',
      '!.adlc/tickets/',
      '!.adlc/tickets/**',
      '!.adlc/ticket-archive/',
      '!.adlc/ticket-archive/**',
      '!.adlc/specs/',
      '!.adlc/config.json',
      '',
    ].join('\n');

    const actual = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.equal(actual, expected);
    assert.ok(!actual.includes('.codegraph'));
    assert.equal(ensureGitignore(dir), false, 'second call must be idempotent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncCodegraphIndex runs sync when .codegraph exists and degrades cleanly otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-wt-sync-'));
  try {
    // 1. Missing .codegraph -> skipped cleanly without throwing
    const noIdx = syncCodegraphIndex(dir, { codegraphBin: '/nonexistent/codegraph' });
    assert.equal(noIdx.ok, false);
    assert.equal(noIdx.skipped, true);

    // 2. Symlinked .codegraph -> rejected cleanly
    const realTarget = join(dir, 'outside-cg');
    mkdirSync(realTarget);
    symlinkSync(realTarget, join(dir, '.codegraph'), 'dir');
    const symRes = syncCodegraphIndex(dir);
    assert.equal(symRes.ok, false);
    assert.equal(symRes.skipped, true);
    rmSync(join(dir, '.codegraph'), { recursive: true, force: true });

    // 3. Real .codegraph + mock binary succeeding
    mkdirSync(join(dir, '.codegraph'));
    const okBin = join(dir, 'fake-cg-ok.sh');
    writeFileSync(okBin, '#!/bin/sh\necho "SYNCED:$*"\n', { mode: 0o755 });
    const okRes = syncCodegraphIndex(dir, { codegraphBin: okBin });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.skipped, false);
    assert.match(okRes.stdout, /SYNCED:sync /);

    // 4. Disabled via AGB_CODEGRAPH=0 or enabled: false
    const disabledRes = syncCodegraphIndex(dir, { codegraphBin: okBin, enabled: false });
    assert.equal(disabledRes.ok, false);
    assert.equal(disabledRes.skipped, true);

    const prevEnv = process.env.AGB_CODEGRAPH;
    process.env.AGB_CODEGRAPH = '0';
    try {
      const envDisabledRes = syncCodegraphIndex(dir, { codegraphBin: okBin });
      assert.equal(envDisabledRes.ok, false);
      assert.equal(envDisabledRes.skipped, true);
    } finally {
      if (prevEnv === undefined) delete process.env.AGB_CODEGRAPH;
      else process.env.AGB_CODEGRAPH = prevEnv;
    }

    // 5. Failing binary degrades cleanly without throwing
    const failBin = join(dir, 'fake-cg-fail.sh');
    writeFileSync(failBin, '#!/bin/sh\necho "sync failed" >&2\nexit 1\n', { mode: 0o755 });
    const failRes = syncCodegraphIndex(dir, { codegraphBin: failBin });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.skipped, false);
    assert.match(failRes.error, /sync failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
