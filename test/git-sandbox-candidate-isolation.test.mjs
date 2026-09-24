import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  snapshotRootGit,
  verifyRootGitIntegrity,
  setupAttemptGitDatabase,
  hostMediatedFetch,
  verifyScopeAndAntiNoOp,
} from '../lib/scheduler.mjs';
import { createWorktree } from '../lib/worktrees.mjs';

function makeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-git-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@test.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'initial root content\n');
  g('add', '-A');
  g('commit', '-qm', 'initial commit');
  return dir;
}

test('setupAttemptGitDatabase: creates isolated attempt git database with pointer file in worktree', () => {
  const repo = makeTestRepo();
  try {
    const wt = createWorktree(repo, 'T1', 'main');
    const { baseSha, gitDir } = setupAttemptGitDatabase(repo, wt, 'main');

    assert.ok(existsSync(gitDir), 'bare attempt git directory created');
    assert.equal(existsSync(join(wt, '.git')), true, '.git entry exists in worktree');

    const gitContent = readFileSync(join(wt, '.git'), 'utf8');
    assert.match(gitContent, /^gitdir: /, '.git in worktree is a pointer file, not a directory');

    // Alternates points to root repo objects
    const alternates = readFileSync(join(gitDir, 'objects', 'info', 'alternates'), 'utf8').trim();
    assert.equal(alternates, join(repo, '.git', 'objects'));

    // Check HEAD and refs
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();
    assert.equal(head, baseSha, 'worktree HEAD is at baseSha');
    const mainRef = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: wt, encoding: 'utf8' }).trim();
    assert.equal(mainRef, baseSha, 'worktree main ref is at baseSha');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hostMediatedFetch: ingests candidate commit into root repo assigned attempt namespace', () => {
  const repo = makeTestRepo();
  try {
    const wt = createWorktree(repo, 'T1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');

    // Builder commits to candidate branch in worktree
    writeFileSync(join(wt, 'T1.txt'), 'candidate content\n');
    execFileSync('git', ['add', 'T1.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'candidate commit'], { cwd: wt });
    const wtSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();

    const attemptSlug = 'attempts/T1/1/token123';
    const fetchedSha = hostMediatedFetch(repo, wt, attemptSlug);

    assert.equal(fetchedSha, wtSha, 'fetched SHA matches worktree candidate commit');
    const destRef = `refs/namespaces/${attemptSlug}/refs/heads/candidate`;
    const repoSha = execFileSync('git', ['rev-parse', destRef], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(repoSha, wtSha, 'candidate ref exists in root repo under assigned namespace');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyRootGitIntegrity: verifies porcelain, HEAD, protected refs, and fails on unauthorized mutations', () => {
  const repo = makeTestRepo();
  try {
    const wt = createWorktree(repo, 'T1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');
    const preSnapshot = snapshotRootGit(repo);
    const attemptSlug = 'attempts/T1/1/token123';

    writeFileSync(join(wt, 'T1.txt'), 'candidate content\n');
    execFileSync('git', ['add', 'T1.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'candidate commit'], { cwd: wt });

    const candidateSha = hostMediatedFetch(repo, wt, attemptSlug);
    const activeAttemptNamespaces = new Set([attemptSlug]);

    // Clean check passes
    const cleanCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(cleanCheck.ok, true);

    // 1. Porcelain alteration in root repo fails
    writeFileSync(join(repo, 'stray.txt'), 'mutated root\n');
    const porcelainCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(porcelainCheck.ok, false);
    assert.match(porcelainCheck.error, /Porcelain status altered/);
    rmSync(join(repo, 'stray.txt'));

    // 2. Unauthorized protected ref creation fails
    execFileSync('git', ['update-ref', 'refs/heads/evil', candidateSha], { cwd: repo });
    const refCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(refCheck.ok, false);
    assert.match(refCheck.error, /Unauthorized new protected ref created|Protected Git reflogs altered/);
    execFileSync('git', ['update-ref', '-d', 'refs/heads/evil'], { cwd: repo });

    // 3. Unauthorized attempt namespace modification fails
    const unauthorizedSlug = 'attempts/UNKNOWN/1/fake';
    execFileSync('git', ['update-ref', `refs/namespaces/${unauthorizedSlug}/refs/heads/candidate`, candidateSha], { cwd: repo });
    const foreignCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(foreignCheck.ok, false);
    assert.match(foreignCheck.error, /Unauthorized or unregistered attempt namespace modified/);
    execFileSync('git', ['update-ref', '-d', `refs/namespaces/${unauthorizedSlug}/refs/heads/candidate`], { cwd: repo });

    // 3b. Scheduler-owned temporary refs pass integrity check
    execFileSync('git', ['update-ref', 'refs/transactions/T1/tok123', candidateSha], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/quarantine/agb-t1-failed', candidateSha], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/heads/agb/t1', candidateSha], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/namespaces/attempts/t1/rebased', candidateSha], { cwd: repo });

    const schedulerRefsCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(schedulerRefsCheck.ok, true, `Scheduler-owned refs must be permitted: ${schedulerRefsCheck.error}`);

    execFileSync('git', ['update-ref', '-d', 'refs/transactions/T1/tok123'], { cwd: repo });
    execFileSync('git', ['update-ref', '-d', 'refs/quarantine/agb-t1-failed'], { cwd: repo });
    execFileSync('git', ['update-ref', '-d', 'refs/heads/agb/t1'], { cwd: repo });
    execFileSync('git', ['update-ref', '-d', 'refs/namespaces/attempts/t1/rebased'], { cwd: repo });

    // 3b. Unauthorized scheduler ref for unknown ticket fails
    execFileSync('git', ['update-ref', 'refs/heads/agb/unknown_ticket', candidateSha], { cwd: repo });
    const unknownSchedulerRefCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(unknownSchedulerRefCheck.ok, false);
    assert.match(unknownSchedulerRefCheck.error, /Unauthorized scheduler ref created for unknown ticket/);
    execFileSync('git', ['update-ref', '-d', 'refs/heads/agb/unknown_ticket'], { cwd: repo });

    // 4. Unauthorized stray object in root .git/objects fails
    const straySha = execFileSync(
      'git',
      ['hash-object', '-w', '--stdin'],
      { cwd: repo, input: 'stray object content', encoding: 'utf8' }
    ).trim();
    const strayCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
    });
    assert.equal(strayCheck.ok, false);
    assert.match(strayCheck.error, /Unauthorized stray object detected/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyScopeAndAntiNoOp: validates non-empty diff, scope, rails, and containment', () => {
  const repo = makeTestRepo();
  try {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const wt = createWorktree(repo, 'T1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');

    // 1. Zero changes fails with empty_diff
    const emptyCheck = verifyScopeAndAntiNoOp(repo, wt, baseSha, { id: 'T1', scope: ['T1.txt'], rails: [] });
    assert.equal(emptyCheck.ok, false);
    assert.equal(emptyCheck.kind, 'empty_diff');

    // 2. In-scope change passes
    writeFileSync(join(wt, 'T1.txt'), 'hello T1\n');
    execFileSync('git', ['add', 'T1.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'add T1'], { cwd: wt });

    const goodCheck = verifyScopeAndAntiNoOp(repo, wt, baseSha, { id: 'T1', scope: ['T1.txt'], rails: [] });
    assert.equal(goodCheck.ok, true);
    assert.deepEqual(goodCheck.changedFiles, ['T1.txt']);

    // 3. Rail change fails with rail_violation
    writeFileSync(join(wt, 'RAIL.txt'), 'edited rail\n');
    execFileSync('git', ['add', 'RAIL.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'rail edit'], { cwd: wt });

    const railCheck = verifyScopeAndAntiNoOp(repo, wt, baseSha, { id: 'T1', scope: ['**'], rails: ['RAIL.txt'] });
    assert.equal(railCheck.ok, false);
    assert.equal(railCheck.kind, 'rail_violation');
    assert.match(railCheck.error, /rail violation/);

    // 4. Out-of-scope change fails with scope_violation
    const scopeCheck = verifyScopeAndAntiNoOp(repo, wt, baseSha, { id: 'T1', scope: ['src/**'], rails: [] });
    assert.equal(scopeCheck.ok, false);
    assert.equal(scopeCheck.kind, 'scope_violation');
    assert.match(scopeCheck.error, /Out-of-scope/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyRootGitIntegrity: rejects mutations to unrelated scheduler refs and invalid commit provenance', () => {
  const repo = makeTestRepo();
  try {
    const wt = createWorktree(repo, 'T1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');
    const attemptSlug = 'attempts/T1/1/token123';

    // Plant an existing scheduler ref for another ticket T2
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/agb/t2', baseSha], { cwd: repo });

    const preSnapshot = snapshotRootGit(repo);

    writeFileSync(join(wt, 'T1.txt'), 'candidate content\n');
    execFileSync('git', ['add', 'T1.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'candidate commit'], { cwd: wt });
    const candidateSha = hostMediatedFetch(repo, wt, attemptSlug);
    const activeAttemptNamespaces = new Set([attemptSlug]);

    // 1. Mutating unrelated ticket's scheduler ref fails
    execFileSync('git', ['update-ref', 'refs/heads/agb/t2', candidateSha], { cwd: repo });
    const unrelatedCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      ticketId: 'T1',
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
    });
    assert.equal(unrelatedCheck.ok, false);
    assert.match(unrelatedCheck.error, /Unauthorized mutation to scheduler ref refs\/heads\/agb\/t2 belonging to unrelated ticket 't2'/);
    execFileSync('git', ['update-ref', 'refs/heads/agb/t2', baseSha], { cwd: repo });

    // 2. Setting current ticket ref to an unrelated unproven commit fails
    const rogueSha = execFileSync('git', ['commit-tree', '-m', 'rogue', baseSha + '^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/agb/t1', rogueSha], { cwd: repo });
    const unprovenCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      ticketId: 'T1',
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
    });
    assert.equal(unprovenCheck.ok, false);
    assert.match(unprovenCheck.error, /not reachable from candidate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
