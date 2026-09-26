import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  snapshotRootGit,
  verifyRootGitIntegrity,
  setupAttemptGitDatabase,
  hostMediatedFetch,
  verifyScopeAndAntiNoOp,
  getGitCommonDir,
  verifyWorktreeGitPointer,
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
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/agb/t1', baseSha], { cwd: repo });
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

test('verifyScopeAndAntiNoOp: rejects multi-hop symlink escaping containment', () => {
  const repo = makeTestRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'agb-outside-'));
  try {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const wt = createWorktree(repo, 'T1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');

    const outsideSecret = join(outsideDir, 'secret.txt');
    writeFileSync(outsideSecret, 'secret data\n');

    // Create intermediate symlinkB in worktree pointing to outsideSecret
    // Then symlinkA pointing to symlinkB
    symlinkSync(outsideSecret, join(wt, 'symlinkB'));
    symlinkSync('symlinkB', join(wt, 'symlinkA'));

    execFileSync('git', ['add', 'symlinkB', 'symlinkA'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'add symlinks'], { cwd: wt });

    const res = verifyScopeAndAntiNoOp(repo, wt, baseSha, { id: 'T1', scope: ['**'], rails: [] });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'scope_violation');
    assert.match(res.error, /Physical containment escape \(symlink target\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
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
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyRootGitIntegrity: rejects unauthorized deletion of scheduler refs belonging to unmerged tickets', () => {
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

    // Deleting unrelated ticket's scheduler ref fails when ticket is not confirmed merged
    execFileSync('git', ['update-ref', '-d', 'refs/heads/agb/t2'], { cwd: repo });
    const unmergedDeleteCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      ticketId: 'T1',
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
      mergedTickets: new Set(),
    });
    assert.equal(unmergedDeleteCheck.ok, false);
    assert.match(unmergedDeleteCheck.error, /Unauthorized deletion of scheduler ref refs\/heads\/agb\/t2 belonging to unmerged ticket 't2'/);

    // But if T2 is confirmed merged with legitimate old sha, deletion is accepted
    const mergedDeleteCheck = verifyRootGitIntegrity(repo, preSnapshot, {
      ticketId: 'T1',
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces,
      candidateSha,
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
      mergedTickets: new Set(['T2']),
      mergedShas: new Set([baseSha]),
    });
    assert.equal(mergedDeleteCheck.ok, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('getGitCommonDir, setupAttemptGitDatabase, and snapshotRootGit operate correctly when repo is a linked worktree', () => {
  const repo = makeTestRepo();
  const linkedDir = mkdtempSync(join(tmpdir(), 'agb-linked-wt-'));
  try {
    execFileSync('git', ['worktree', 'add', linkedDir, '-b', 'linked-branch'], { cwd: repo });

    const rootGitCommon = getGitCommonDir(repo);
    const linkedGitCommon = getGitCommonDir(linkedDir);
    assert.equal(rootGitCommon, join(repo, '.git'));
    assert.equal(linkedGitCommon, join(repo, '.git'));

    // setupAttemptGitDatabase configures alternates pointing to common dir objects
    const wt = createWorktree(linkedDir, 'T1', 'linked-branch');
    const { baseSha, gitDir } = setupAttemptGitDatabase(linkedDir, wt, 'linked-branch');
    const alternates = readFileSync(join(gitDir, 'objects', 'info', 'alternates'), 'utf8').trim();
    assert.equal(alternates, join(repo, '.git', 'objects'));

    // snapshotRootGit on the linked worktree hashes the common objects directory
    const preSnapshot = snapshotRootGit(linkedDir);
    assert.ok(preSnapshot.headSha, 'snapshot has headSha');
    assert.ok(preSnapshot.objectsManifest.size > 0, 'snapshot found git objects via common dir');

    writeFileSync(join(wt, 'linked_file.txt'), 'candidate commit on linked worktree\n');
    execFileSync('git', ['add', 'linked_file.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'candidate commit'], { cwd: wt });

    const attemptSlug = 'attempts/T1/1/tokenLinked';
    const candidateSha = hostMediatedFetch(linkedDir, wt, attemptSlug);
    assert.ok(candidateSha, 'candidate Sha resolved from fetch into linked repo');

    const integrityRes = verifyRootGitIntegrity(linkedDir, preSnapshot, {
      ticketId: 'T1',
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces: new Set([attemptSlug]),
      candidateSha,
      knownTickets: [{ id: 'T1' }],
    });
    assert.equal(integrityRes.ok, true);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', linkedDir], { cwd: repo });
    } catch {}
    rmSync(linkedDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hostMediatedFetch: namespace ref can be cleaned up and verifyRootGitIntegrity tolerates ephemeral deletion', () => {
  const repo = makeTestRepo();
  try {
    const wt = createWorktree(repo, 'T1', 'main');
    setupAttemptGitDatabase(repo, wt, 'main');
    const preSnapshot = snapshotRootGit(repo);
    const attemptSlug = 'attempts/T1/1/tokenCleanup';

    writeFileSync(join(wt, 'T1.txt'), 'candidate content\n');
    execFileSync('git', ['add', 'T1.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'candidate commit'], { cwd: wt });

    const candidateSha = hostMediatedFetch(repo, wt, attemptSlug);
    const attemptRef = `refs/namespaces/${attemptSlug}/refs/heads/candidate`;
    assert.equal(execFileSync('git', ['rev-parse', attemptRef], { cwd: repo, encoding: 'utf8' }).trim(), candidateSha);

    // After attempt completes (in finally block), attempt ref is deleted
    execFileSync('git', ['update-ref', '-d', attemptRef], { cwd: repo });

    // Ref no longer exists in git repo
    assert.throws(() => execFileSync('git', ['rev-parse', attemptRef], { cwd: repo, stdio: 'pipe' }));

    // verifyRootGitIntegrity accepts that attempt namespace refs are deleted
    const integrityRes = verifyRootGitIntegrity(repo, preSnapshot, {
      ticketId: 'T1',
      attemptNamespace: attemptSlug,
      activeAttemptNamespaces: new Set(),
      candidateSha,
      knownTickets: [{ id: 'T1' }],
    });
    assert.equal(integrityRes.ok, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyRootGitIntegrity: rejects deletion and mutation of unrelated unmerged attempt refs', () => {
  const repo = makeTestRepo();
  try {
    const unrelatedAttemptSlug = 'attempts/T2/1/tokenT2';
    const unrelatedRef = `refs/namespaces/${unrelatedAttemptSlug}/refs/heads/candidate`;

    // Simulate pre-existing attempt ref for T2
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', unrelatedRef, headSha], { cwd: repo });
    const preWithT2 = snapshotRootGit(repo);

    // 1. Unrelated attempt ref deletion during T1 attempt is rejected
    execFileSync('git', ['update-ref', '-d', unrelatedRef], { cwd: repo });
    const delRes = verifyRootGitIntegrity(repo, preWithT2, {
      ticketId: 'T1',
      attemptNamespace: 'attempts/T1/1/tokenT1',
      activeAttemptNamespaces: new Set(['attempts/T1/1/tokenT1']),
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
      mergedTickets: new Set(),
      mergedShas: new Set(),
    });
    assert.equal(delRes.ok, false);
    assert.match(delRes.error, /Unauthorized deletion of scheduler ref.*belonging to unmerged ticket 'T2'/);

    // 2. Unrelated attempt ref mutation during T1 attempt is rejected even if mutated to a merged SHA
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'merged commit'], { cwd: repo });
    const mergedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', unrelatedRef, mergedSha], { cwd: repo });

    const mutRes = verifyRootGitIntegrity(repo, preWithT2, {
      ticketId: 'T1',
      attemptNamespace: 'attempts/T1/1/tokenT1',
      activeAttemptNamespaces: new Set(['attempts/T1/1/tokenT1']),
      knownTickets: [{ id: 'T1' }, { id: 'T2' }],
      mergedTickets: new Set(), // T2 is unmerged
      mergedShas: new Set([mergedSha]),
    });
    assert.equal(mutRes.ok, false);
    assert.match(mutRes.error, /Unauthorized mutation to scheduler ref.*belonging to unrelated ticket 'T2'/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verifyWorktreeGitPointer: rejects redirected, symlinked, or missing worktree .git pointer before host operations', () => {
  const repo = makeTestRepo();
  try {
    const wt = createWorktree(repo, 'T1', 'main');
    const { gitDir } = setupAttemptGitDatabase(repo, wt, 'main');

    // 1. Authentic pointer passes
    assert.equal(verifyWorktreeGitPointer(wt, gitDir), true);

    // 2. Tampered pointer pointing to root repo is rejected
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    assert.throws(
      () => verifyWorktreeGitPointer(wt, gitDir),
      /Security violation: worktree \.git pointer at .* redirected to .* expected/
    );

    // 3. Symlink pointer is rejected
    rmSync(join(wt, '.git'), { force: true });
    symlinkSync(gitDir, join(wt, '.git'));
    assert.throws(
      () => verifyWorktreeGitPointer(wt, gitDir),
      /Security violation: worktree \.git pointer at .* is not a regular file/
    );

    // 4. Missing pointer is rejected
    rmSync(join(wt, '.git'), { force: true });
    assert.throws(
      () => verifyWorktreeGitPointer(wt, gitDir),
      /Security violation: worktree \.git pointer missing/
    );

    // 5. hostMediatedFetch rejects tampered pointer before host git execution
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    assert.throws(
      () => hostMediatedFetch(repo, wt, 'attempts/T1/1/token1', gitDir),
      /Security violation: worktree \.git pointer/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
