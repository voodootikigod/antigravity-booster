// The orchestrator loop (ADLC D0: control flow is code, judgment is models).
//
// Ticket lifecycle:
//   pending → building (agy in worktree) → gating (build+test) →
//   prosecuting (cross-model refute) → [fixing → gating → prosecuting]¹ →
//   merging (sequential, rebase-first) → merged | failed
//
// Dispatch is event-driven: a ticket becomes ready the moment its edge
// predecessors merge (no wave barriers). Two-strike rule: one regeneration
// with failure context appended, then the ticket fails (the ticket is
// wrong, not the agent — ADLC P4).

import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, lstatSync, readlinkSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path, { join, resolve, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { topoSort, globMatch } from '@adlc/core/tickets';
import { runAgy } from './agy.mjs';
import { PoolSet, reconcileLeases, tierCandidates, poolOf, upstreamPoolOf } from './pools.mjs';
import { builderAgentsMd, builderPrompt, fixPrompt, regenPrompt } from './charters.mjs';
import { checkAgyBinary } from './doctor.mjs';
import { runGates } from './gates.mjs';
import { prosecute, blockingFindings } from './prosecute.mjs';
import { verifyGateScriptIntegrity } from './plan.mjs';
import { planTicketToRailTicket, writeAdlcTickets, readPluginContract, SUPPORTED_PLUGIN_CONTRACT, resolveAdlcBinary, revalidateAdlcBinary, execFileAuthenticatedAdlc } from './adlc-bridge.mjs';
import {
  ensureGitignore, createWorktree, removeWorktree, pruneWorktrees,
  branchDiff, commitAll, mergeWorktree, changedFiles, abortAnyMerge,
  isDirty, deleteBranch, currentBranch, resetToBase, discardProjection,
  JOURNAL_PHASES, createIntegrationWorktree, reapIntegrationWorktrees,
  writeIntegrationJournal, readIntegrationJournal, quarantineIntegrationJournal,
  unlinkIntegrationJournal, assertSafeAdlcDir,
} from './worktrees.mjs';
import { RunStatus } from './status.mjs';
import { acquireRepoLock } from './lock.mjs';

function hashDir(dir, filterFn = () => true) {
  if (!existsSync(dir)) return null;
  const hash = crypto.createHash('sha256');
  let count = 0;
  const walk = (d, rel = '') => {
    try {
      const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        const entRel = rel ? `${rel}/${ent.name}` : ent.name;
        const full = join(d, ent.name);
        if (ent.isDirectory()) {
          walk(full, entRel);
        } else if (ent.isFile()) {
          if (filterFn(entRel)) {
            count++;
            hash.update(entRel);
            hash.update(readFileSync(full));
          }
        }
      }
    } catch {}
  };
  walk(dir);
  return count > 0 ? hash.digest('hex') : null;
}

function listObjects(objectsDir) {
  const set = new Set();
  if (!existsSync(objectsDir)) return set;
  const walk = (d, rel = '') => {
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const ent of entries) {
        const entRel = rel ? `${rel}/${ent.name}` : ent.name;
        const full = join(d, ent.name);
        if (ent.isDirectory() && ent.name !== 'info') {
          walk(full, entRel);
        } else if (ent.isFile()) {
          set.add(entRel);
        }
      }
    } catch {}
  };
  walk(objectsDir);
  return set;
}

export function getGitCommonDir(repo) {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
    return resolve(repo, raw);
  } catch {
    return join(repo, '.git');
  }
}

export function snapshotRootGit(repo) {
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const gitDir = getGitCommonDir(repo);

  const headSha = g('rev-parse', 'HEAD');
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo });

  let refs = '';
  try {
    refs = execFileSync('git', ['show-ref'], { cwd: repo, encoding: 'utf8' });
  } catch {}

  const configPath = join(gitDir, 'config');
  const configHash = existsSync(configPath)
    ? crypto.createHash('sha256').update(readFileSync(configPath)).digest('hex')
    : null;

  const hooksHash = hashDir(join(gitDir, 'hooks'));

  const indexPath = join(gitDir, 'index');
  const indexHash = existsSync(indexPath)
    ? crypto.createHash('sha256').update(readFileSync(indexPath)).digest('hex')
    : null;

  const packedRefsPath = join(gitDir, 'packed-refs');
  const packedRefsHash = existsSync(packedRefsPath)
    ? crypto.createHash('sha256').update(readFileSync(packedRefsPath)).digest('hex')
    : null;

  const infoHash = hashDir(join(gitDir, 'info'));

  const logsHash = hashDir(
    join(gitDir, 'logs'),
    (rel) =>
      !rel.startsWith('refs/namespaces/attempts') &&
      !rel.startsWith('refs/heads/') &&
      !rel.startsWith('refs/transactions') &&
      !rel.startsWith('refs/quarantine') &&
      rel !== 'HEAD'
  );

  const objectsManifest = listObjects(join(gitDir, 'objects'));

  return {
    headSha,
    status,
    refs,
    configHash,
    hooksHash,
    indexHash,
    packedRefsHash,
    infoHash,
    logsHash,
    objectsManifest,
  };
}

export function verifyRootGitIntegrity(
  repo,
  pre,
  {
    ticketId,
    attemptNamespace,
    activeAttemptNamespaces = new Set(),
    knownAttemptNamespaces = activeAttemptNamespaces,
    candidateSha,
    mergedShas = new Set(),
    mergedTickets = new Set(),
    base = 'main',
    knownTickets = new Set(),
  } = {}
) {
  const mergedTicketIds = new Set();
  if (mergedTickets) {
    for (const t of mergedTickets) {
      const id = typeof t === 'string' ? t : t?.id;
      if (id) {
        mergedTicketIds.add(String(id).toLowerCase());
        mergedTicketIds.add(String(id));
      }
    }
  }

  const knownTicketIds = new Set();
  if (knownTickets) {
    for (const t of knownTickets) {
      const id = typeof t === 'string' ? t : t?.id;
      if (id) {
        knownTicketIds.add(String(id).toLowerCase());
        knownTicketIds.add(String(id));
      }
    }
  }
  const allSlugs = [attemptNamespace, ...knownAttemptNamespaces, ...activeAttemptNamespaces].filter(Boolean);
  for (const slug of allSlugs) {
    const parts = slug.split('/');
    if (parts[1]) {
      knownTicketIds.add(parts[1].toLowerCase());
      knownTicketIds.add(parts[1]);
    }
  }

  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const gitDir = getGitCommonDir(repo);

  // Check HEAD commit equality or legitimate merge progression
  const postHeadSha = g('rev-parse', 'HEAD');
  let headMovedByMerge = false;
  if (postHeadSha !== pre.headSha) {
    if (mergedShas.has(postHeadSha)) {
      headMovedByMerge = true;
    } else {
      return { ok: false, error: `Root HEAD moved from ${pre.headSha} to unproven commit ${postHeadSha}` };
    }
  }

  // 1. Porcelain Byte-Equality
  const postStatus = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo });
  if (headMovedByMerge) {
    if (pre.status.length === 0 && postStatus.length !== 0) {
      return { ok: false, error: 'Porcelain status altered in root repository' };
    }
  } else if (!postStatus.equals(pre.status)) {
    return { ok: false, error: 'Porcelain status altered in root repository' };
  }

  // 3. Config Hash Equality
  const configPath = join(gitDir, 'config');
  const postConfigHash = existsSync(configPath)
    ? crypto.createHash('sha256').update(readFileSync(configPath)).digest('hex')
    : null;
  if (postConfigHash !== pre.configHash) {
    return { ok: false, error: 'Root Git config altered' };
  }

  // 4. Hooks Hash Equality
  const postHooksHash = hashDir(join(gitDir, 'hooks'));
  if (postHooksHash !== pre.hooksHash) {
    return { ok: false, error: 'Root Git hooks altered' };
  }

  // 5. Index & Metadata Byte-Equality
  if (!headMovedByMerge) {
    const indexPath = join(gitDir, 'index');
    const postIndexHash = existsSync(indexPath)
      ? crypto.createHash('sha256').update(readFileSync(indexPath)).digest('hex')
      : null;
    if (postIndexHash !== pre.indexHash) {
      return { ok: false, error: 'Root Git index altered' };
    }
  }

  const packedRefsPath = join(gitDir, 'packed-refs');
  const postPackedRefsHash = existsSync(packedRefsPath)
    ? crypto.createHash('sha256').update(readFileSync(packedRefsPath)).digest('hex')
    : null;
  if (postPackedRefsHash !== pre.packedRefsHash) {
    return { ok: false, error: 'Root Git packed-refs altered' };
  }

  const postInfoHash = hashDir(join(gitDir, 'info'));
  if (postInfoHash !== pre.infoHash) {
    return { ok: false, error: 'Root Git info metadata altered' };
  }

  // 6. Reflogs Scope Equality
  const postLogsHash = hashDir(
    join(gitDir, 'logs'),
    (rel) =>
      !rel.startsWith('refs/namespaces/attempts') &&
      !rel.startsWith('refs/heads/') &&
      !rel.startsWith('refs/transactions') &&
      !rel.startsWith('refs/quarantine') &&
      rel !== 'HEAD'
  );
  if (postLogsHash !== pre.logsHash) {
    return { ok: false, error: 'Protected Git reflogs altered outside attempt namespaces' };
  }

  // 7. Ref Scope Equality
  let postRefsRaw = '';
  try {
    postRefsRaw = execFileSync('git', ['show-ref'], { cwd: repo, encoding: 'utf8' });
  } catch {}

  const parseRefs = (raw) => {
    const map = new Map();
    for (const line of raw.split('\n').filter(Boolean)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (sha && name) map.set(name, sha);
    }
    return map;
  };

  const preRefMap = parseRefs(pre.refs);
  const postRefMap = parseRefs(postRefsRaw);

  const currentTicketId = ticketId || (attemptNamespace ? attemptNamespace.split('/')[1] : null);
  const currentTicketNorm = currentTicketId ? currentTicketId.toLowerCase() : null;

  const isSchedulerOwnedRef = (name) => {
    return (
      name.startsWith('refs/namespaces/attempts/') ||
      name.startsWith('refs/heads/agb/') ||
      name.startsWith('refs/transactions/') ||
      name.startsWith('refs/quarantine/')
    );
  };

  for (const [name, sha] of preRefMap) {
    const postSha = postRefMap.get(name);
    if (postSha === sha) continue;

    if (headMovedByMerge && name === `refs/heads/${base}`) {
      if (postSha !== postHeadSha) {
        return { ok: false, error: `Protected ref ${name} modified unexpectedly: was ${sha}, now ${postSha}` };
      }
      continue;
    }
    if (attemptNamespace && name.startsWith(`refs/namespaces/${attemptNamespace}/`)) {
      continue;
    }

    if (isSchedulerOwnedRef(name)) {
      let refTicket = null;
      if (name.startsWith('refs/heads/agb/')) {
        refTicket = name.slice('refs/heads/agb/'.length);
      } else if (name.startsWith('refs/quarantine/')) {
        const match = name.match(/^refs\/quarantine\/agb-([^-/]+)/i);
        refTicket = match ? match[1] : null;
      } else if (name.startsWith('refs/transactions/')) {
        const match = name.match(/^refs\/transactions\/([^/]+)/);
        refTicket = match ? match[1] : null;
      } else if (name.startsWith('refs/namespaces/attempts/')) {
        if (name.endsWith('/rebased')) {
          const match = name.match(/^refs\/namespaces\/attempts\/([^/]+)\/rebased/);
          refTicket = match ? match[1] : null;
        } else {
          const match = name.match(/^refs\/namespaces\/(attempts\/[^\/]+\/[^\/]+\/[^\/]+)/);
          refTicket = match ? match[1].split('/')[1] : null;
        }
      }

      const refTicketNorm = refTicket ? refTicket.toLowerCase() : null;
      if (currentTicketNorm && (refTicketNorm !== currentTicketNorm && refTicket !== currentTicketId)) {
        const isMerged = Boolean(mergedTicketIds.has(refTicket) || (refTicketNorm && mergedTicketIds.has(refTicketNorm)));
        if (!postSha) {
          let isLegitimateOldSha = (sha === pre.headSha || mergedShas.has(sha));
          if (!isLegitimateOldSha) {
            for (const mSha of mergedShas) {
              try {
                execFileSync('git', ['merge-base', '--is-ancestor', sha, mSha], { cwd: repo });
                isLegitimateOldSha = true;
                break;
              } catch {}
            }
          }
          if (isMerged && isLegitimateOldSha) {
            continue;
          }
          return { ok: false, error: `Unauthorized deletion of scheduler ref ${name} belonging to unmerged ticket '${refTicket}' during attempt for '${currentTicketId}'` };
        }
        if (isMerged && mergedShas.has(postSha)) {
          continue;
        }
        return { ok: false, error: `Unauthorized mutation to scheduler ref ${name} belonging to unrelated ticket '${refTicket}' during attempt for '${currentTicketId}'` };
      }

      if (!postSha) {
        if (name.startsWith('refs/namespaces/attempts/')) {
          continue;
        }
        return { ok: false, error: `Unauthorized deletion of scheduler ref ${name} during attempt for '${currentTicketId}'` };
      }

      if (candidateSha) {
        let isReachable = false;
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', postSha, candidateSha], { cwd: repo });
          isReachable = true;
        } catch {}
        if (isReachable) {
          continue;
        }
        return { ok: false, error: `Unauthorized mutation to scheduler ref ${name}: commit ${postSha} is not reachable from candidate ${candidateSha}` };
      }
    }

    return { ok: false, error: `Unauthorized mutation to ref ${name}: was ${sha}, now ${postSha}` };
  }

  for (const [name, sha] of postRefMap) {
    if (preRefMap.has(name)) {
      continue;
    }
    if (isSchedulerOwnedRef(name)) {
      let refTicket = null;
      if (name.startsWith('refs/heads/agb/')) {
        refTicket = name.slice('refs/heads/agb/'.length);
      } else if (name.startsWith('refs/quarantine/')) {
        const match = name.match(/^refs\/quarantine\/agb-([^-/]+)/i);
        refTicket = match ? match[1] : null;
      } else if (name.startsWith('refs/transactions/')) {
        const match = name.match(/^refs\/transactions\/([^/]+)/);
        refTicket = match ? match[1] : null;
      } else if (name.startsWith('refs/namespaces/attempts/')) {
        if (name.endsWith('/rebased')) {
          const match = name.match(/^refs\/namespaces\/attempts\/([^/]+)\/rebased/);
          refTicket = match ? match[1] : null;
        } else {
          const match = name.match(/^refs\/namespaces\/(attempts\/[^\/]+\/[^\/]+\/[^\/]+)/);
          if (match) {
            const slug = match[1];
            if (slug !== attemptNamespace && !knownAttemptNamespaces.has(slug) && !activeAttemptNamespaces.has(slug)) {
              return { ok: false, error: `Unauthorized or unregistered attempt namespace modified: ${slug}` };
            }
            refTicket = slug.split('/')[1];
          } else {
            return { ok: false, error: `Malformed attempt ref detected: ${name}` };
          }
        }
      }

      if (!refTicket) {
        return { ok: false, error: `Unauthorized scheduler ref created with unrecognized format: ${name}` };
      }

      const refTicketNorm = refTicket.toLowerCase();
      if (!knownTicketIds.has(refTicketNorm) && !knownTicketIds.has(refTicket)) {
        return { ok: false, error: `Unauthorized scheduler ref created for unknown ticket: ${name}` };
      }

      if (currentTicketNorm && (refTicketNorm === currentTicketNorm || refTicket === currentTicketId)) {
        if (candidateSha && sha !== candidateSha) {
          let isReachable = false;
          try {
            execFileSync('git', ['merge-base', '--is-ancestor', sha, candidateSha], { cwd: repo });
            isReachable = true;
          } catch {}
          if (!isReachable) {
            return { ok: false, error: `Unauthorized ref commit provenance for ${name}: ${sha} is not reachable from candidate ${candidateSha}` };
          }
        }
      } else {
        if (sha !== pre.headSha && !mergedShas.has(sha)) {
          let isLegitimate = false;
          try {
            execFileSync('git', ['merge-base', '--is-ancestor', pre.headSha, sha], { cwd: repo });
            isLegitimate = true;
          } catch {}
          if (!isLegitimate) {
            for (const mSha of mergedShas) {
              try {
                execFileSync('git', ['merge-base', '--is-ancestor', mSha, sha], { cwd: repo });
                isLegitimate = true;
                break;
              } catch {}
            }
          }
          if (!isLegitimate) {
            return { ok: false, error: `Unauthorized ref commit provenance for concurrent ticket ref ${name}: ${sha} is not legitimate base or merged commit` };
          }
        }
      }
      continue;
    }

    return { ok: false, error: `Unauthorized new protected ref created: ${name}` };
  }

  // 8. Objects Database Assertion
  const postObjectsManifest = listObjects(join(gitDir, 'objects'));
  const newObjects = [];
  for (const obj of postObjectsManifest) {
    if (!pre.objectsManifest.has(obj)) {
      newObjects.push(obj);
    }
  }

  if (newObjects.length > 0) {
    const reachable = new Set();
    try {
      const revListArgs = ['rev-list', '--objects'];
      if (candidateSha) revListArgs.push(candidateSha);
      revListArgs.push(
        '--glob=refs/namespaces/attempts',
        '--glob=refs/heads/agb',
        '--glob=refs/transactions',
        '--glob=refs/quarantine',
        `refs/heads/${base}`
      );
      const out = execFileSync('git', revListArgs, { cwd: repo, encoding: 'utf8' });
      for (const line of out.split('\n').filter(Boolean)) {
        const sha = line.trim().split(/\s+/)[0];
        if (sha && sha.length >= 4) {
          reachable.add(`${sha.slice(0, 2)}/${sha.slice(2)}`);
        }
      }
    } catch {}

    for (const newObj of newObjects) {
      if (newObj.startsWith('pack/')) continue;
      if (!reachable.has(newObj)) {
        return { ok: false, error: `Unauthorized stray object detected in root object storage: ${newObj}` };
      }
    }
  }

  return { ok: true };
}

export function setupAttemptGitDatabase(repo, worktreePath, baseRef) {
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const baseSha = g(repo, 'rev-parse', baseRef);

  const gitDir = join(repo, '.worktrees', '.attempt_git', path.basename(worktreePath));
  if (existsSync(gitDir)) {
    try { rmSync(gitDir, { recursive: true, force: true }); } catch {}
  }
  mkdirSync(gitDir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'candidate', gitDir]);

  const altDir = join(gitDir, 'objects', 'info');
  mkdirSync(altDir, { recursive: true });
  writeFileSync(join(altDir, 'alternates'), join(getGitCommonDir(repo), 'objects') + '\n');

  const gitEntry = join(worktreePath, '.git');
  if (existsSync(gitEntry)) {
    try { rmSync(gitEntry, { recursive: true, force: true }); } catch {}
  }
  writeFileSync(gitEntry, `gitdir: ${gitDir}\n`);

  execFileSync('git', ['config', 'core.bare', 'false'], { cwd: worktreePath });
  execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath });
  execFileSync('git', ['config', 'core.worktreeConfig', 'true'], { cwd: worktreePath });
  execFileSync('git', ['config', 'user.name', 'agb-builder'], { cwd: worktreePath });
  execFileSync('git', ['config', 'user.email', 'agb@local'], { cwd: worktreePath });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: worktreePath });
  execFileSync('git', ['update-ref', `refs/heads/${baseRef}`, baseSha], { cwd: worktreePath });

  return { baseSha, gitDir };
}

export function verifyWorktreeGitPointer(worktreePath, expectedGitDir) {
  const gitEntry = join(worktreePath, '.git');
  if (!existsSync(gitEntry)) {
    throw new Error(`Security violation: worktree .git pointer missing at ${gitEntry}`);
  }
  const stat = lstatSync(gitEntry);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Security violation: worktree .git pointer at ${gitEntry} is not a regular file`);
  }
  const content = readFileSync(gitEntry, 'utf8').trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    throw new Error(`Security violation: worktree .git pointer at ${gitEntry} has invalid format: ${content}`);
  }
  const target = match[1].trim();
  const resolvedTarget = resolve(worktreePath, target);
  const resolvedExpected = resolve(expectedGitDir);
  if (resolvedTarget !== resolvedExpected) {
    throw new Error(`Security violation: worktree .git pointer at ${gitEntry} redirected to ${resolvedTarget}, expected ${resolvedExpected}`);
  }
  return true;
}

export function hostMediatedFetch(repo, worktreePath, attemptNamespace, expectedGitDir = null) {
  if (expectedGitDir) {
    verifyWorktreeGitPointer(worktreePath, expectedGitDir);
  }
  const destRef = `refs/namespaces/${attemptNamespace}/refs/heads/candidate`;
  const gitUrl = pathToFileURL(join(worktreePath, '.git')).href;
  execFileSync(
    'git',
    [
      'fetch',
      '--no-tags',
      gitUrl,
      `refs/heads/candidate:${destRef}`,
    ],
    { cwd: repo }
  );
  return execFileSync('git', ['rev-parse', destRef], { cwd: repo, encoding: 'utf8' }).trim();
}

export function verifyScopeAndAntiNoOp(repo, worktreePath, baseRefSha, ticket) {
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  // 1. Stage and commit uncommitted changes if any
  const statusOut = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: worktreePath });
  if (statusOut.length > 0) {
    execFileSync('git', ['add', '-A', '--', ':(exclude)AGENTS.md', ':(exclude).adlc/tickets.json', ':(exclude).adlc/tickets'], { cwd: worktreePath });
    try {
      execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', 'agb: candidate attempt commit'], { cwd: worktreePath });
    } catch {}
  }

  const headSha = g(worktreePath, 'rev-parse', 'HEAD');
  if (headSha === baseRefSha) {
    return { ok: false, kind: 'empty_diff', error: 'zero changes against baseline commit' };
  }

  // 2. Authoritative candidate comparison against baseRefSha
  const diffTreeBuf = execFileSync(
    'git',
    ['diff-tree', '-r', '--name-status', '-M', '-C', '-z', baseRefSha, 'HEAD'],
    { cwd: worktreePath }
  );

  const tokens = diffTreeBuf.toString('utf8').split('\0');
  const records = [];
  let idx = 0;
  while (idx < tokens.length && tokens[idx]) {
    const status = tokens[idx];
    if (status.startsWith('R') || status.startsWith('C')) {
      const src = tokens[idx + 1];
      const dest = tokens[idx + 2];
      records.push({ status: status[0], src, dest });
      idx += 3;
    } else {
      const filePath = tokens[idx + 1];
      records.push({ status: status[0], path: filePath });
      idx += 2;
    }
  }

  if (records.length === 0) {
    return { ok: false, kind: 'empty_diff', error: 'diff-tree against baseRefSha contains 0 records' };
  }

  let realWorktree;
  try {
    realWorktree = realpathSync(worktreePath);
  } catch {
    realWorktree = worktreePath;
  }

  const changedPaths = [];
  for (const rec of records) {
    const pathsToCheck = rec.status === 'R' || rec.status === 'C' ? [rec.src, rec.dest] : [rec.path];
    for (const p of pathsToCheck) {
      if (!p) continue;
      if (p === 'AGENTS.md' || p === '.adlc/tickets.json' || p.startsWith('.adlc/tickets/')) continue;

      changedPaths.push(p);

      // Lexical Normalization:
      const norm = path.posix.normalize(p);
      if (norm !== p || p.startsWith('/') || p.startsWith('\\') || p.split('/').some((s) => s === '.' || s === '..')) {
        return { ok: false, kind: 'scope_violation', error: `Unnormalized or traversal path: ${p}` };
      }

      // Check existence
      const isDeletedOrSrc = rec.status === 'D' || ((rec.status === 'R' || rec.status === 'C') && p === rec.src);
      if (isDeletedOrSrc) {
        try {
          execFileSync('git', ['cat-file', '-e', `${baseRefSha}:${p}`], { cwd: repo });
        } catch {
          return { ok: false, kind: 'scope_violation', error: `Deleted path did not exist in baseline: ${p}` };
        }
      } else {
        const fullPath = join(worktreePath, p);
        try {
          const st = lstatSync(fullPath);
          if (st.isSymbolicLink()) {
            const rawTarget = readlinkSync(fullPath);
            let finalReal;
            try {
              finalReal = realpathSync(fullPath);
            } catch {
              return { ok: false, kind: 'scope_violation', error: `Dangling symlink rejected: ${p} -> ${rawTarget}` };
            }
            if (!finalReal.startsWith(realWorktree + path.sep) && finalReal !== realWorktree) {
              return { ok: false, kind: 'scope_violation', error: `Physical containment escape (symlink target): ${p} -> ${rawTarget}` };
            }
          } else {
            const real = realpathSync(fullPath);
            if (!real.startsWith(realWorktree + path.sep) && real !== realWorktree) {
              return { ok: false, kind: 'scope_violation', error: `Physical containment escape: ${p}` };
            }
          }
        } catch (err) {
          return { ok: false, kind: 'scope_violation', error: `Cannot inspect path ${p}: ${err.message}` };
        }
      }

      // Rail check:
      if (ticket.rails?.some((r) => globMatch(r, p))) {
        return { ok: false, kind: 'rail_violation', error: `rail violation (read-only paths edited, per adlc rails-guard): ${p}` };
      }

      // Scope check:
      if (ticket.scope?.length && !ticket.scope.some((g) => globMatch(g, p))) {
        return { ok: false, kind: 'scope_violation', error: `Out-of-scope change: ${p}` };
      }
    }
  }

  if (changedPaths.length === 0) {
    return { ok: false, kind: 'empty_diff', error: 'zero changes against baseline commit' };
  }

  return { ok: true, changedFiles: [...new Set(changedPaths)] };
}

// agy enforces a ~5m ceiling on print-mode responses regardless of the
// flag value (calibration addendum) — size tickets to fit one ≤5m
// generation; a timeout consumes a strike like any other failure.
const BUILD_TIMEOUT = process.env.AGB_BUILD_TIMEOUT ?? '5m';
const execFileP = promisify(execFile);
const RAILS_GUARD_TIMEOUT_MS = 30_000;
const FLAIL_DETECTOR_TIMEOUT_MS = 15_000;

/**
 * ADLC C6: after a strike fails, check the ACCUMULATED builder log (agy.mjs
 * appends across strikes to the same file) for a genuine flail pattern —
 * repeated errors, scope violations, edit churn, an oversized log — instead
 * of a bare failed-gate counter. RESOLVED AMBIGUITY (ticket T-F3's own
 * prose is ambiguous on which verdict should do what): 'flail' means the
 * log shows this builder is genuinely stuck — regenerating from the same
 * dead end won't help, so stop now rather than spend the second strike.
 * 'clean' (a single one-off failure with no flail pattern yet — the most
 * common case on strike 1, since repeated-error inherently needs >=2
 * occurrences) preserves today's exact behavior: try again once. Fails
 * OPEN (unlike rails-guard): an unverifiable signal must not itself cut a
 * build's normal retry short — the two-strike cap remains the backstop.
 */
export async function checkFlailDetector({ logFile, scope, adlcBin, cwd }) {
  if (!existsSync(logFile)) return { detected: false, signals: [] };
  let tmpDirToClean = null;
  let targetFile = logFile;

  if (logFile.endsWith('.jsonl')) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');

    try {
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      targetFile = join(tmpdir(), `flail-${randomUUID()}.log`);
      tmpDirToClean = targetFile;
      let legacyContent = '';

      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o.role !== 'builder') continue; // only builder strikes are checked by flail-detector
          const header = { ts: o.ts, model: o.model, cwd: o.cwd, ms: o.ms, ok: o.ok, error: o.error, kind: o.kind };
          for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k];

          const safePrompt = String(o.prompt || '')
            .replace(/(^|\r\n|\r|\n)===(?=\r\n|\r|\n|$)/g, '$1_=_')
            .replace(/(^|\r\n|\r|\n)---PROMPT---(?=\r\n|\r|\n|$)/g, '$1_-_PROMPT_-_')
            .replace(/(^|\r\n|\r|\n)---OUTPUT---(?=\r\n|\r|\n|$)/g, '$1_-_OUTPUT_-_');
          const safeOut = String(o.output || '')
            .replace(/(^|\r\n|\r|\n)===(?=\r\n|\r|\n|$)/g, '$1_=_')
            .replace(/(^|\r\n|\r|\n)---PROMPT---(?=\r\n|\r|\n|$)/g, '$1_-_PROMPT_-_')
            .replace(/(^|\r\n|\r|\n)---OUTPUT---(?=\r\n|\r|\n|$)/g, '$1_-_OUTPUT_-_');
          legacyContent += JSON.stringify(header) + '\n---PROMPT---\n' + safePrompt + '\n---OUTPUT---\n' + safeOut + '\n===\n';
        } catch { }
      }
      writeFileSync(targetFile, legacyContent, { mode: 0o600 });
    } catch { }
  }

  const repo = cwd ?? process.cwd();
  const args = ['flail-detector', targetFile, '--json'];
  for (const g of scope ?? []) args.push('--scope', g);
  try {
    const { stdout } = await execFileAuthenticatedAdlc(adlcBin, args, { cwd: repo, timeout: FLAIL_DETECTOR_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, { repo });
    const parsed = JSON.parse(stdout);
    return { detected: parsed.verdict === 'flail', signals: parsed.signals ?? [] };
  } catch (err) {
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout);
        return { detected: parsed.verdict === 'flail', signals: parsed.signals ?? [] };
      } catch { /* fall through to the operational-error path below */ }
    }
    return { detected: false, signals: [], error: err.message };
  } finally {
    if (tmpDirToClean) {
      const { rmSync } = await import('node:fs');
      try { rmSync(tmpDirToClean, { recursive: true, force: true }); } catch { }
    }
  }
}

const CONSENSUS_FIX_TIMEOUT_MS = 300_000;

/**
 * ADLC C7: fan out N candidate fixes via `adlc consensus-fix` instead of
 * trusting a single regeneration attempt. --apply writes the gated winner's
 * changes directly into `worktree`'s files when one survives; the caller is
 * responsible for committing and re-verifying (gates + prosecution) before
 * treating this as a real fix — a converged candidate is evidence it passed
 * the repro + rails gates, not proof it satisfies the ORIGINAL prosecution
 * findings. Never throws: an operational failure (adlc missing, no LLM
 * provider configured, timeout) degrades to { ok: false, applied: false },
 * which the caller falls back on rather than silently hanging.
 */
async function runConsensusFix({ worktree, testCmd, files, adlcBin }) {
  if (!testCmd || !files.length) {
    return { ok: false, applied: false, error: 'no gate test command or no changed files to fix' };
  }
  const args = ['consensus-fix', '--allow-dirty', '--test-cmd', testCmd, '--files', files.join(','), '--rails', testCmd, '--apply', '--json'];
  const parseResult = (stdout) => {
    const parsed = JSON.parse(stdout);
    return {
      ok: true,
      applied: !!parsed.applied,
      survivors: parsed.survivors?.length ?? 0,
      allDivergent: !!parsed.allDivergent,
    };
  };
  try {
    const { stdout } = await execFileAuthenticatedAdlc(adlcBin, args, { cwd: worktree, timeout: CONSENSUS_FIX_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, { repo: worktree });
    return parseResult(stdout);
  } catch (err) {
    // consensus-fix gate-fails (exit 2) when no candidate survives or all
    // diverge — the result JSON is still valid on stdout even then; only a
    // genuinely unparseable/absent stdout (adlc missing, no provider
    // configured) is an operational error.
    if (err.stdout) {
      try {
        return parseResult(err.stdout);
      } catch { /* fall through */ }
    }
    return { ok: false, applied: false, error: err.message };
  }
}

const GATE_MANIFEST_TIMEOUT_MS = 15_000;

/**
 * Record a gate outcome as append-only, attestable evidence (ADLC F5/C-
 * manifest) instead of only a .booster/report.json log line. Best-effort:
 * a recording failure (adlc missing, .adlc unwritable) is logged by the
 * caller via its return value, never thrown — a broken audit trail must
 * not itself fail a build/merge that otherwise succeeded.
 */
async function recordGate({ repo, gateName, ticketId, data, adlcBin }) {
  const args = ['gate-manifest', 'record', gateName, '--ticket', ticketId];
  if (data !== undefined) args.push('--data', JSON.stringify(data));
  try {
    await execFileAuthenticatedAdlc(adlcBin, args, { cwd: repo, timeout: GATE_MANIFEST_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, { repo });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Post-hoc rail check (ADLC C5), the fast-fail confirmation behind the
 * plugin's live in-session hook. Calls the SAME rails-guard engine the
 * plugin uses (via --rails flags derived straight from the ticket, so this
 * works even against a target repo that isn't ADLC-initialized) instead of
 * a bespoke glob comparison, so booster and the plugin share one
 * enforcement engine. Fails closed: an operational error (adlc missing,
 * timeout, unparseable output) is treated as a violation, never as
 * silent success.
 */
async function checkRailsGuard({ worktree, base, rails, adlcBin }) {
  const args = ['rails-guard', '--base', base, '--json'];
  for (const r of rails) args.push('--rails', r);
  try {
    await execFileAuthenticatedAdlc(adlcBin, args, { cwd: worktree, timeout: RAILS_GUARD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, { repo: worktree });
    return { violations: [] }; // exit 0 — no violations
  } catch (err) {
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout);
        return { violations: (parsed.violations ?? []).map((v) => v.file ?? JSON.stringify(v)) };
      } catch { /* fall through to the operational-error path below */ }
    }
    return { violations: [`adlc rails-guard operational error: ${err.message}`] };
  }
}

/**
 * Live in-session rail enforcement (ADLC P3) needs the target repo to be
 * ADLC-initialized AND the adlc-antigravity plugin installed AND that plugin to
 * speak the SAME tickets/hook contract the booster projects. Checked once per
 * run, not per ticket.
 *
 * B12: the compatibility check is a contract-version HANDSHAKE against the
 * installed plugin manifest's `adlcContract`, not the old bare name-substring
 * match on `agy plugin list` output — which proved a plugin was *named* but
 * never that its schema *matched*, so version skew failed silently.
 *   - incompatible contract → { abort: true }: the caller stops the run LOUDLY
 *     before any repo mutation. A plugin enforcing a different contract than the
 *     booster projects is worse than no live layer.
 *   - missing field / unreadable manifest (older/absent plugin) → degrade
 *     (available:false, warn) exactly as the pre-B12 enforcement-unavailable
 *     path. Never crash (CLI integrations degrade). The post-hoc adlc
 *     rails-guard check above remains active regardless in every case (it has
 *     no such dependency); this is only the LIVE layer.
 */
export function checkEnforcementAvailable(repo) {
  if (!existsSync(join(repo, '.adlc'))) {
    return { available: false, reason: 'target repo is not ADLC-initialized (no .adlc/ directory) — live rail enforcement disabled, post-hoc adlc rails-guard still runs' };
  }
  const contract = readPluginContract();
  switch (contract.status) {
    case 'compatible':
      return { available: true, reason: null };
    case 'incompatible':
      return {
        available: false,
        abort: true,
        reason:
          `installed adlc-antigravity plugin declares adlcContract ${contract.contract}, but this ` +
          `antigravity-booster projects contract ${SUPPORTED_PLUGIN_CONTRACT} — refusing to run: a version-skewed ` +
          `plugin would enforce a different tickets/hook contract than the booster generates. ` +
          (contract.contract > SUPPORTED_PLUGIN_CONTRACT
            ? 'Upgrade antigravity-booster so it speaks the newer plugin contract.'
            : 'Upgrade the adlc-antigravity plugin (agb bootstrap) so it speaks the contract this booster projects.'),
      };
    case 'missing-field':
      return { available: false, reason: `installed adlc-antigravity plugin manifest declares no adlcContract field (older plugin) — cannot confirm it speaks booster contract ${SUPPORTED_PLUGIN_CONTRACT}; live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
    case 'unreadable':
    default:
      return { available: false, reason: `adlc-antigravity plugin manifest unreadable (${contract.error}) — treating as not installed; live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
  }
}

/**
 * Startup crash reconciliation & provenance-safe ref recovery across all 4 phases.
 * Validates integration journal, isolates corrupt journals to quarantine, checks
 * transaction provenance markers, prevents data loss on external divergence, and
 * guarantees atomic CAS forward progress or clean rollback.
 */
export async function reconcileIntegrationJournal(repo, base = 'main') {
  assertSafeAdlcDir(repo);
  const readRes = readIntegrationJournal(repo);
  const currentBaseSha = (() => {
    try {
      return execFileSync('git', ['rev-parse', `refs/heads/${base}`], { cwd: repo, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })();

  if (!readRes.exists) {
    // Scan for any orphan transaction markers in refs/transactions/
    let orphanMarkerRef = null;
    let orphanMarkerSha = null;
    let orphanTicketId = null;
    try {
      const showRef = execFileSync('git', ['show-ref'], { cwd: repo, encoding: 'utf8' });
      for (const line of showRef.split('\n').filter(Boolean)) {
        const [sha, ref] = line.trim().split(/\s+/);
        if (ref.startsWith('refs/transactions/')) {
          orphanMarkerRef = ref;
          orphanMarkerSha = sha;
          const parts = ref.replace('refs/transactions/', '').split('/');
          orphanTicketId = parts[0];
          break;
        }
      }
    } catch {}

    if (orphanMarkerRef) {
      if (currentBaseSha && currentBaseSha === orphanMarkerSha) {
        // Base was already advanced
        try { execFileSync('git', ['update-ref', '-d', orphanMarkerRef], { cwd: repo }); } catch {}
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'finalized_orphan_marker' };
      } else {
        // Not advanced: quarantine candidate
        try {
          execFileSync('git', ['update-ref', `refs/quarantine/agb-${orphanTicketId || 'unknown'}-failed-crash`, orphanMarkerSha], { cwd: repo });
        } catch {}
        try { execFileSync('git', ['update-ref', '-d', orphanMarkerRef], { cwd: repo }); } catch {}
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'rolled_back_orphan_marker' };
      }
    }
    reapIntegrationWorktrees(repo);
    return { ok: true, status: 'clean' };
  }

  if (readRes.corrupted) {
    quarantineIntegrationJournal(repo, 'corrupt');
    // Scan for any outstanding transaction marker
    let markerRef = null;
    let markerSha = null;
    let markerTicketId = null;
    try {
      const showRef = execFileSync('git', ['show-ref'], { cwd: repo, encoding: 'utf8' });
      for (const line of showRef.split('\n').filter(Boolean)) {
        const [sha, ref] = line.trim().split(/\s+/);
        if (ref.startsWith('refs/transactions/')) {
          markerRef = ref;
          markerSha = sha;
          const parts = ref.replace('refs/transactions/', '').split('/');
          markerTicketId = parts[0];
          break;
        }
      }
    } catch {}

    if (markerRef) {
      if (currentBaseSha && currentBaseSha === markerSha) {
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'finalized_corrupt_journal' };
      } else {
        try {
          execFileSync('git', ['update-ref', `refs/quarantine/agb-${markerTicketId || 'unknown'}-failed-crash`, markerSha], { cwd: repo });
        } catch {}
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'rolled_back_corrupt_journal' };
      }
    }
    reapIntegrationWorktrees(repo);
    return { ok: true, status: 'reconciled', action: 'corrupt_quarantined_no_marker' };
  }

  const { ticketId, transactionToken, preMergeSha, candidateSha, phase } = readRes.journal;
  const markerRef = `refs/transactions/${ticketId}/${transactionToken}`;
  let markerSha = null;
  try {
    markerSha = execFileSync('git', ['rev-parse', '--verify', markerRef], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {}

  if (phase === JOURNAL_PHASES.PREPARED) {
    if (currentBaseSha !== preMergeSha) {
      quarantineIntegrationJournal(repo, 'conflict');
      const err = new Error(`External ref divergence detected: base branch '${base}' moved from ${preMergeSha} to ${currentBaseSha} while transaction ${ticketId} was in PREPARED phase.`);
      err.kind = 'external_ref_divergence';
      throw err;
    }
    if (candidateSha) {
      try {
        execFileSync('git', ['update-ref', `refs/quarantine/agb-${ticketId.toLowerCase()}-failed-crash`, candidateSha], { cwd: repo });
      } catch {}
    }
    if (markerSha) {
      try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
    }
    unlinkIntegrationJournal(repo);
    reapIntegrationWorktrees(repo);
    return { ok: true, status: 'rolled_back', phase: JOURNAL_PHASES.PREPARED };
  }

  if (phase === JOURNAL_PHASES.GATES_PASSED) {
    if (markerSha && markerSha === candidateSha) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', preMergeSha, candidateSha], { cwd: repo });
      } catch {
        quarantineIntegrationJournal(repo, 'unproven_candidate');
        const err = new Error(`Cannot recover journal: candidate ${candidateSha} is not a valid descendant of preMergeSha ${preMergeSha}.`);
        err.kind = 'unproven_candidate_requires_operator';
        throw err;
      }

      if (currentBaseSha === candidateSha) {
        writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
        unlinkIntegrationJournal(repo);
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'finalized_gates_passed', ticketId };
      }
      if (currentBaseSha === preMergeSha) {
        execFileSync('git', ['update-ref', `refs/heads/${base}`, candidateSha, preMergeSha], { cwd: repo });
        writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
        unlinkIntegrationJournal(repo);
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'advanced_and_finalized', ticketId };
      }
      const err = new Error(`Unexpected base ref mutation detected: base branch '${base}' is at ${currentBaseSha}, expected ${preMergeSha} or ${candidateSha}.`);
      err.kind = 'unexpected_base_ref_mutation';
      throw err;
    } else {
      quarantineIntegrationJournal(repo, 'unproven_candidate');
      const err = new Error(`Unproven ref advancement requires operator: marker ref ${markerRef} is missing or does not match candidateSha ${candidateSha}. Refusing to advance base branch '${base}'.`);
      err.kind = 'unproven_ref_advancement_requires_operator';
      throw err;
    }
  }

  if (phase === JOURNAL_PHASES.REF_ADVANCED) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', preMergeSha, candidateSha], { cwd: repo });
    } catch {
      quarantineIntegrationJournal(repo, 'unproven_candidate');
      const err = new Error(`Cannot recover journal: candidate ${candidateSha} is not a valid descendant of preMergeSha ${preMergeSha}.`);
      err.kind = 'unproven_candidate_requires_operator';
      throw err;
    }
    if (currentBaseSha === candidateSha) {
      writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
      if (markerSha) {
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
      }
      unlinkIntegrationJournal(repo);
      reapIntegrationWorktrees(repo);
      return { ok: true, status: 'reconciled', action: 'finalized_from_ref_advanced', ticketId };
    }
    if (currentBaseSha === preMergeSha) {
      execFileSync('git', ['update-ref', `refs/heads/${base}`, candidateSha, preMergeSha], { cwd: repo });
      writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
      if (markerSha) {
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
      }
      unlinkIntegrationJournal(repo);
      reapIntegrationWorktrees(repo);
      return { ok: true, status: 'reconciled', action: 'advanced_and_finalized_from_ref_advanced', ticketId };
    }
    const err = new Error(`Unexpected base ref mutation detected: base branch '${base}' is at ${currentBaseSha}, expected ${preMergeSha} or ${candidateSha}.`);
    err.kind = 'unexpected_base_ref_mutation';
    throw err;
  }

  if (phase === JOURNAL_PHASES.FINALIZED) {
    if (markerSha) {
      try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
    }
    unlinkIntegrationJournal(repo);
    reapIntegrationWorktrees(repo);
    return { ok: true, status: 'clean', phase: JOURNAL_PHASES.FINALIZED };
  }

  unlinkIntegrationJournal(repo);
  reapIntegrationWorktrees(repo);
  return { ok: true, status: 'unknown_phase_cleaned' };
}

/**
 * Run a full plan. plan = { repo, base?, gate, caps?, tickets } where
 * tickets use the adlc schema (+ tier, pool_hint extensions).
 * Returns the final report; exit-code policy belongs to the caller.
 */
export async function runPlan(plan, { log = console.error, project } = {}) {
  const { repo, gate } = plan;
  const base = plan.base ?? 'main';
  const tickets = plan.tickets;
  const { cycle } = topoSort(tickets);
  if (cycle) throw new Error(`cycle in ticket DAG: ${cycle.join(', ')}`);

  const agyBin = process.env.AGB_AGY_BIN || 'agy';
  const agyCheck = await checkAgyBinary({ env: process.env });
  if (agyCheck.level !== 'pass') {
    throw new Error(`agy binary '${agyBin}' is not spawnable: ${agyCheck.detail}\nFix: ${agyCheck.fix}`);
  }

  const resolvedAdlc = resolveAdlcBinary({ repo });
  const runAdlcBin = resolvedAdlc.ok ? resolvedAdlc.binary : undefined;

  // Reject structurally broken plans before the lock is taken or the repo
  // touched: duplicate ids collide on one worktree/branch across concurrent
  // builders, and an edge to an unknown id would TypeError mid-run after
  // ensureGitignore already committed (adversarial-review MEDIUM). Callers
  // that bypass `agb validate` (programmatic runPlan, sweep) get the same
  // guarantee.
  const ticketIds = new Set();
  for (const t of tickets) {
    if (ticketIds.has(t.id)) throw new Error(`duplicate ticket id: ${t.id}`);
    ticketIds.add(t.id);
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (!ticketIds.has(e.to)) throw new Error(`${t.id}: edge to unknown ticket '${e.to}'`);
    }
  }

  const NPM_GATE_RE = /^npm (test|run [a-zA-Z0-9_:-]+)$/;
  const basePkgPath = join(repo, 'package.json');
  if (existsSync(basePkgPath) || process.env.AGB_STRICT_GATES === '1') {
    for (const cmd of [gate?.build, gate?.test].filter(Boolean)) {
      if (!NPM_GATE_RE.test(cmd)) {
        throw new Error(`gate command must match ${NPM_GATE_RE} (got '${cmd}')`);
      }
    }
  }

  // The main repo must be ON the base branch: merges and `git reset --hard`
  // rollbacks act on whatever branch is checked out, so a different branch
  // would be merged into / reset by mistake.
  const onBranch = currentBranch(repo);
  if (onBranch !== base) {
    throw new Error(`repo ${repo} is on '${onBranch}', not the plan's base '${base}'. ` +
      `Checkout ${base} before running (agb merges into and resets the checked-out branch).`);
  }

  if (isDirty(repo)) {
    if (process.env.AGB_ALLOW_DIRTY !== '1') {
      throw new Error(`repo ${repo} has uncommitted changes — commit or stash first ` +
        `(agb uses 'git reset --hard' for merge rollback and would discard them). ` +
        `Set AGB_ALLOW_DIRTY=1 to override.`);
    }
    log(`WARNING: repo ${repo} has uncommitted changes and AGB_ALLOW_DIRTY=1 is enabled. ` +
      `If a ticket merge or post-merge gate fails, a hard reset (git reset --hard) will run ` +
      `and permanently discard your uncommitted changes.`);
  }

  // Plugin contract handshake (B12) — a run-level fact resolved ONCE, here,
  // BEFORE the lock / .gitignore commit / any worktree, so an incompatible
  // installed plugin aborts with the repo untouched (no partial mutation to
  // clean up). An incompatible contract is a hard stop; a missing field or
  // unreadable manifest degrades to enforcement-unavailable with a non-silent
  // warning (callers must not have to dig through logs to learn the run had no
  // live in-session protection — AC3).
  const enforcement = checkEnforcementAvailable(repo);
  if (enforcement.abort) {
    throw new Error(enforcement.reason);
  }
  if (!enforcement.available) {
    log(`⚠ live rail enforcement unavailable: ${enforcement.reason}`);
  }

  const pools = new PoolSet(plan.caps, { repo });
  const runId = `run-${Date.now().toString(36)}`;
  const finalProject = project ?? `agb-${runId}`;
  const status = new RunStatus(repo, runId);
  const safeRunId = runId.replace(/[\/\\]/g, '_');
  const logDir = join(repo, '.booster', 'logs', safeRunId);

  const merged = new Set();
  const mergedShas = new Set();
  const failed = new Map(); // id → reason
  const started = new Set();
  const running = [];

  // Serialize orchestrator runs per repo — concurrent merges + reverts on
  // one checkout corrupt state. Released in the finally below.
  const releaseLock = acquireRepoLock(repo, { runId });
  try {
    // Startup crash reconciliation & worktree cleanup
  await reconcileIntegrationJournal(repo, base);
  reapIntegrationWorktrees(repo);
  try { await reconcileLeases(repo); } catch {}
  const quotaInit = await pools.refreshQuota(process.env.AGB_AGY_BIN || 'agy');
  if (!quotaInit.ok) {
    throw new Error(`Cannot start run: quota telemetry unavailable from agy: ${quotaInit.error}`);
  }

  ensureGitignore(repo);
  pruneWorktrees(repo);

  const preds = Object.fromEntries(tickets.map((t) => [t.id, []]));
  for (const t of tickets) for (const e of t.edges ?? []) preds[e.to].push(t.id);

  // Merges serialize (integrator lane). A simple promise chain is the lock.
  let mergeLock = Promise.resolve();

  const activeAttemptNamespaces = new Set();
  const knownAttemptNamespaces = new Set();
  let fleetCliFailures = 0;

  for (const t of tickets) status.ticket(t.id, { phase: 'pending' });

  const isReady = (t) =>
    !started.has(t.id) &&
    preds[t.id].every((p) => merged.has(p)) &&
    preds[t.id].every((p) => !failed.has(p));

  async function acquireWithQuotaHandling(initialModel, { role, tier, poolHint, builderModel, repo: targetRepo, ticketId, canReroute = true, onReroute }) {
    let currentModel = initialModel;
    let acquired = false;

    try {
      while (true) {
        try {
          const release = await pools.acquire(currentModel, { repo: targetRepo ?? repo, ticketId });
          acquired = true;
          return { model: currentModel, release };
        } catch (err) {
          if (err.kind === 'capacity_exhausted' || /capacity exhausted/i.test(err.message)) {
            await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
            continue;
          }
          if (err.kind !== 'quota_depleted') throw err;

          // 1. Try to reroute to an alternate available model
          if (canReroute) {
            let altCandidates = [];
            if (role === 'builder') {
              altCandidates = tierCandidates(tier ?? 'mid', poolHint).filter((m) => m !== currentModel);
              if (!altCandidates.some((m) => (pools.caps[poolOf(m)] ?? 0) > 0 && pools.familyCap(upstreamPoolOf(m)) > 0)) {
                altCandidates = tierCandidates(tier ?? 'mid', null).filter((m) => m !== currentModel);
              }
            } else if (role === 'prosecutor') {
              altCandidates = pools.prosecutorsFor(builderModel).filter((m) => m !== currentModel);
            }

            const viable = altCandidates.find((m) => {
              const p = poolOf(m);
              const u = upstreamPoolOf(m);
              return (pools.caps[p] ?? 0) > 0 && pools.familyCap(u) > 0;
            });

            if (viable) {
              if (role === 'builder') {
                pools.unroute(currentModel);
                pools.reserved[poolOf(viable)] += 1;
                onReroute?.(viable);
              }
              currentModel = viable;
              continue;
            }
          }

          // 2. If depleted until resumesAt (or no alternate available), pause and wait for resumption and refresh quota
          let waitMs = 5000;
          const resumesAtStr = err.resumesAt || pools.quota?.resumesAt;
          if (resumesAtStr) {
            const resumeTime = new Date(resumesAtStr).getTime();
            if (!Number.isNaN(resumeTime) && resumeTime > Date.now()) {
              waitMs = resumeTime - Date.now() + 500;
            }
          }

          const quotaTimeoutMs = process.env.AGB_QUOTA_TIMEOUT_MS ? parseInt(process.env.AGB_QUOTA_TIMEOUT_MS, 10) : null;
          if (quotaTimeoutMs && Date.now() + waitMs > Date.now() + quotaTimeoutMs) {
            throw err;
          }

          status.ticket(ticketId, {
            phase: 'paused',
            reason: `quota depleted for ${currentModel}; waiting ${Math.round(waitMs / 1000)}s for capacity`,
          });

          const targetResume = Date.now() + waitMs;
          while (Date.now() < targetResume) {
            const chunkMs = Math.min(30000, targetResume - Date.now());
            await new Promise((r) => setTimeout(r, chunkMs));
          }

          try {
            const q = await pools.refreshQuota(process.env.AGB_AGY_BIN || 'agy');
            if (!q?.ok) {
              throw new Error(`Quota refresh failed: ${q?.error || 'probe failed'}`);
            }
          } catch (refreshErr) {
            throw err;
          }
        }
      }
    } finally {
      if (!acquired && role === 'builder' && currentModel !== initialModel && !onReroute) {
        pools.unroute(currentModel);
        pools.reserved[poolOf(initialModel)] += 1;
      }
    }
  }

  async function buildOnce(t, worktree, model, prompt, strike, { ticketId, token, repo: targetRepo, baseRefSha, onReroute } = {}) {
    const { model: activeModel, release } = await acquireWithQuotaHandling(model, {
      role: 'builder',
      tier: t.tier,
      poolHint: t.pool_hint,
      repo: targetRepo ?? repo,
      ticketId: ticketId ?? t.id,
      onReroute,
    });
    status.pools(pools.snapshot());
    const safeId = t.id.replace(/[\/\\]/g, '_');
    if (release.isActive && !release.isActive()) {
      await release();
      status.pools(pools.snapshot());
      const err = new Error(`Cannot spawn builder for ticket ${t.id}: lease is no longer active (pool is draining)`);
      err.kind = 'lease_revoked';
      throw err;
    }
    try {
      const res = await runAgy({
        model: activeModel, prompt, cwd: worktree, sandbox: true, timeout: BUILD_TIMEOUT,
        outputFormat: 'stream-json',
        logFile: join(logDir, `${safeId}.jsonl`),
        // Scoped to THIS spawn only (runAgy merges onto process.env, never
        // mutates it) — concurrent tickets building in the same booster
        // process must not see each other's active-ticket signal.
        env: enforcement.available ? { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: t.id } : undefined,
        project: finalProject,
        strike,
        role: 'builder',
        repo: targetRepo ?? repo,
        ticketId: ticketId ?? t.id,
        token,
        onSpawn: (child) => {
          if (child?.pid) {
            Promise.resolve(release.registerWorkerPid?.(child.pid)).then((ok) => {
              if (ok === false) {
                try { child.kill('SIGKILL'); } catch {}
              }
            }).catch(() => {});
          }
        },
      });
      return { ...res, model: activeModel };
    } finally {
      await release();
      status.pools(pools.snapshot());
    }
  }

  async function prosecuteBranch(t, worktree, builderModel) {
    const prosecutorModel = pools.prosecutorFor(builderModel);
    const { model: activeProsecutor, release } = await acquireWithQuotaHandling(prosecutorModel, {
      role: 'prosecutor',
      builderModel,
      repo,
      ticketId: t.id,
    });
    status.pools(pools.snapshot());
    // Scratch cwd: prosecutors have tool access and will sometimes
    // materialize the diff to inspect it — never let that touch the repo.
    const scratch = mkdtempSync(join(tmpdir(), 'agb-prosecute-'));
    const safeId = t.id.replace(/[\/\\]/g, '_');
    if (release.isActive && !release.isActive()) {
      rmSync(scratch, { recursive: true, force: true });
      await release();
      status.pools(pools.snapshot());
      const err = new Error(`Cannot spawn prosecutor for ticket ${t.id}: lease is no longer active (pool is draining)`);
      err.kind = 'lease_revoked';
      throw err;
    }
    try {
      return await prosecute({
        ticket: t, diff: branchDiff(worktree, base), model: activeProsecutor, cwd: scratch,
        logFile: join(logDir, `${safeId}.jsonl`),
        worktree,
        testCmd: gate?.test,
        base,
        project: finalProject,
        onSpawn: (child) => {
          if (child?.pid) {
            Promise.resolve(release.registerWorkerPid?.(child.pid)).then((ok) => {
              if (ok === false) {
                try { child.kill('SIGKILL'); } catch {}
              }
            }).catch(() => {});
          }
        },
      });
    } finally {
      await release();
      status.pools(pools.snapshot());
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async function runTicket(t) {
    started.add(t.id);
    // route() can throw (no candidate for tier+pool_hint) — it must do so
    // INSIDE the try so the ticket lands in `failed` instead of vanishing
    // from the report while the run exits 0 (adversarial-review HIGH).
    let model;
    let worktree;
    try {
      const q = await pools.refreshQuota(process.env.AGB_AGY_BIN || 'agy');
      if (!q.ok) {
        throw new Error(`Quota telemetry check failed: ${q.error}`);
      }
      model = pools.route(t.tier ?? 'mid', t.pool_hint);
      worktree = createWorktree(repo, t.id, base);
      let strikes = 0;
      let attempts = 0;
      let prompt = builderPrompt(t);
      let lastFailure = '';
      const safeId = t.id.replace(/[\/\\]/g, '_');
      const buildLogFile = join(logDir, `${safeId}.jsonl`);

      while (strikes < 2) {
        attempts += 1;
        const strikeNum = strikes + 1;
        const ownerToken = crypto.randomUUID();
        const attemptSlug = `attempts/${t.id}/${attempts}/${ownerToken.slice(0, 8)}`;
        const attemptRef = `refs/namespaces/${attemptSlug}/refs/heads/candidate`;
        activeAttemptNamespaces.add(attemptSlug);
        knownAttemptNamespaces.add(attemptSlug);
        let strikeError = null;

        try {
        // Pre-dispatch root Git snapshot
        const preSnapshot = snapshotRootGit(repo);

        // Setup isolated per-attempt Git database
        const { baseSha: baseRefSha, gitDir: expectedGitDir } = setupAttemptGitDatabase(repo, worktree, base);
        writeFileSync(join(worktree, 'AGENTS.md'), builderAgentsMd(t, gate));

        const safeResetToBase = () => {
          try {
            verifyWorktreeGitPointer(worktree, expectedGitDir);
          } catch {
            try { writeFileSync(join(worktree, '.git'), `gitdir: ${expectedGitDir}\n`); } catch {}
          }
          resetToBase(worktree, base);
          try { writeFileSync(join(worktree, 'AGENTS.md'), builderAgentsMd(t, gate)); } catch {}
        };

        // Materialize this ticket into the plugin's expected shape so its
        // PreToolUse hook (ADLC_P4_ENFORCEMENT + ADLC_TICKET, set on the
        // builder's agy invocation below) can resolve the same rails this
        // scheduler enforces post-hoc.
        if (enforcement.available) {
          writeAdlcTickets(worktree, [planTicketToRailTicket(t)]);
        }
        if (strikes > 0) {
          const resolvedAdlc = resolveAdlcBinary({ repo: worktree });
          const adlcBin = resolvedAdlc.ok ? resolvedAdlc.binary : undefined;
          const flail = await checkFlailDetector({ logFile: buildLogFile, scope: t.scope, cwd: worktree, adlcBin });
          if (flail.detected) {
            lastFailure = `flail detected (adlc flail-detector): ` +
              flail.signals.map((s) => s.type).join(', ') +
              ` — not attempting another strike`;
            activeAttemptNamespaces.delete(attemptSlug);
            break;
          }
        }
        status.ticket(t.id, { phase: 'building', model, strikes: strikeNum, attempts });
        const build = await buildOnce(t, worktree, model, prompt, strikeNum, {
          ticketId: t.id,
          token: ownerToken,
          repo,
          baseRefSha,
          onReroute: (newModel) => {
            model = newModel;
          },
        });
        if (build.model && build.model !== model) {
          model = build.model;
        }

        strikeError = null;

        // Verify worktree .git pointer before ANY host-side Git operations:
        let gitPointerOk = false;
        try {
          verifyWorktreeGitPointer(worktree, expectedGitDir);
          gitPointerOk = true;
        } catch (err) {
          strikeError = `worktree gitdir tampering: ${err.message}`;
          try {
            writeFileSync(join(worktree, '.git'), `gitdir: ${expectedGitDir}\n`);
          } catch {}
        }

        // Post-reap host-mediated ref fetch:
        let candidateSha = null;
        if (build.ok && gitPointerOk) {
          commitAll(worktree, `${t.id}: ${t.title} (strike ${strikeNum})`);
          try {
            candidateSha = hostMediatedFetch(repo, worktree, attemptSlug, expectedGitDir);
          } catch (err) {
            strikeError = `host-mediated fetch failed: ${err.message}`;
          }
        }

        // Comprehensive root Git integrity verification:
        const rootCheck = verifyRootGitIntegrity(repo, preSnapshot, {
          ticketId: t.id,
          attemptNamespace: attemptSlug,
          activeAttemptNamespaces,
          knownAttemptNamespaces,
          candidateSha,
          mergedShas,
          mergedTickets: merged,
          base,
          knownTickets: plan.tickets,
        });

        if (!rootCheck.ok) {
          // Non-recoverable root integrity violation! Consumes all strikes immediately and halts fleet
          strikes = 2;
          strikeError = `root integrity violation: ${rootCheck.error}`;
          lastFailure = strikeError;
          status.strike(t.id, { model, error: strikeError, strikes });
          throw new Error(strikeError);
        }

        const isBlocked = /TICKET-BLOCKED/.test(build.output) ||
          build.events?.some((e) => e.action === 'blocked' || /blocked/i.test(e.action));

        if (isBlocked) {
          strikes += 1;
          const match = build.output.match(/TICKET-BLOCKED:?\s*(.*)/)?.[1];
          strikeError = `agent blocked: ${match || 'cannot proceed'}`;
        } else if (!build.ok) {
          if (build.kind === 'cli') {
            fleetCliFailures += 1;
            strikes += 1;
            strikeError = `agent CLI error: ${build.error}`;
            lastFailure = strikeError;
            status.strike(t.id, { model, error: strikeError, strikes });
            if (fleetCliFailures >= 3) {
              lastFailure = `fleet CLI failure budget exceeded (3 failures)`;
              throw new Error(lastFailure);
            }
            continue;
          } else if (['stream_overflow', 'stream_corruption', 'containment_unavailable'].includes(build.kind)) {
            strikes = 2;
            strikeError = `non-recoverable violation (${build.kind}): ${build.error}`;
            lastFailure = strikeError;
            status.strike(t.id, { model, error: strikeError, strikes });
            throw new Error(strikeError);
          } else {
            strikes += 1;
            strikeError = `agent error: ${build.error}`;
          }
        } else if (strikeError) {
          strikes += 1;
        } else {
          // Authoritative Scope & Anti-No-Op Verification
          const scopeCheck = verifyScopeAndAntiNoOp(repo, worktree, baseRefSha, t);
          if (!scopeCheck.ok) {
            if (scopeCheck.kind === 'empty_diff') {
              strikes += 1;
              strikeError = `anti-no-op gate failed: ${scopeCheck.error}`;
              safeResetToBase();
            } else if (scopeCheck.kind === 'rail_violation') {
              strikes += 1;
              strikeError = scopeCheck.error;
              safeResetToBase();
            } else if (scopeCheck.kind === 'scope_violation' && !scopeCheck.error.startsWith('Physical containment escape')) {
              strikes += 1;
              strikeError = scopeCheck.error;
              safeResetToBase();
            } else {
              strikes = 2;
              strikeError = `${scopeCheck.kind}: ${scopeCheck.error}`;
              lastFailure = strikeError;
              status.strike(t.id, { model, error: strikeError, strikes });
              throw new Error(strikeError);
            }
          } else {
            const changed = scopeCheck.changedFiles;
            const rails = t.rails ?? [];
            const railCheck = rails.length ? await checkRailsGuard({ worktree, base, rails, adlcBin: runAdlcBin }) : { violations: [] };
            if (railCheck.violations.length) {
              strikes += 1;
              strikeError = `rail violation (read-only paths edited, per adlc rails-guard): ${railCheck.violations.join(', ')}`;
              safeResetToBase();
            } else {

            // Verify gate script integrity before running worktree gates
            let gateIntegrityError = null;
            try {
              const basePkgPath = join(repo, 'package.json');
              const candPkgPath = join(worktree, 'package.json');
              if (existsSync(basePkgPath)) {
                if (!existsSync(candPkgPath)) {
                  throw new Error('candidate deleted package.json while baseline repository requires it');
                }
                const basePkg = JSON.parse(readFileSync(basePkgPath, 'utf8'));
                const candPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
                for (const cmd of [gate?.build, gate?.test].filter(Boolean)) {
                  verifyGateScriptIntegrity(candPkg, basePkg, cmd);
                }
              }
            } catch (err) {
              gateIntegrityError = err;
            }

            if (gateIntegrityError) {
              strikes += 1;
              strikeError = `gate script tampering: ${gateIntegrityError.message}`;
              lastFailure = strikeError;
              status.strike(t.id, { model, error: strikeError, strikes });
              safeResetToBase();
              continue;
            }

            status.ticket(t.id, { phase: 'gating' });
            // Sandbox worktree gates: the script being run lives in the
            // (untrusted) worktree and could have been rewritten by the
            // builder. The post-merge gate below runs on trusted main.
            const gates = await runGates(gate, worktree, { sandbox: true });
            await recordGate({ repo, gateName: 'build', ticketId: t.id, data: { ok: gates.ok, strikes }, adlcBin: runAdlcBin });
            if (!gates.ok) {
              strikes += 1;
              const g = gates.results.at(-1);
              strikeError = `gate ${g.name} failed:\n${g.output}`;
            } else {
              // Loop-until-dry (ADLC F6): a single clean pass is a model
              // prior, not a coverage certificate.
              const dryNeeded = plan.prosecution?.dryPasses ?? 1;
              let dry = 0;
              let verdict;
              while (dry < dryNeeded) {
                status.ticket(t.id, { phase: 'prosecuting', detail: `dry ${dry}/${dryNeeded}` });
                verdict = await prosecuteBranch(t, worktree, model);
                if (verdict.verdict !== 'ship') break;
                dry += 1;
              }
              await recordGate({
                repo, gateName: 'prosecution', ticketId: t.id,
                data: { verdict: verdict.verdict, findings: verdict.findings?.length ?? 0, dryPasses: dry },
                adlcBin: runAdlcBin,
              });
              if (dry >= dryNeeded) {
                status.strike(t.id, { model, error: null, strikes });
                await integrate(t, worktree);
                return;
              }
              if (verdict.verdict === 'error') {
                strikes += 1;
                strikeError = `prosecution error: ${verdict.error}`;
              } else {
                strikes += 1;
                const blocking = blockingFindings(verdict.findings);
                strikeError = `prosecution block (findings):\n${JSON.stringify(blocking, null, 2)}`;
                status.ticket(t.id, { phase: 'fixing', detail: `${blocking.length} findings` });
                // Fan out candidates via consensus-fix before trusting one single-attempt regeneration.
                const cf = await runConsensusFix({ worktree, testCmd: gate?.test, files: changed, adlcBin: runAdlcBin });
                let cfFailureReason = null;
                if (cf.ok && cf.applied) {
                  let cfGitPointerOk = false;
                  try {
                    verifyWorktreeGitPointer(worktree, expectedGitDir);
                    cfGitPointerOk = true;
                  } catch (err) {
                    cfFailureReason = `consensus-fix worktree gitdir tampering: ${err.message}`;
                    try {
                      writeFileSync(join(worktree, '.git'), `gitdir: ${expectedGitDir}\n`);
                    } catch {}
                  }
                  if (cfGitPointerOk) {
                    commitAll(worktree, `${t.id}: ${t.title} (consensus-fix)`);
                    const cfScope = verifyScopeAndAntiNoOp(repo, worktree, baseRefSha, t);
                    if (!cfScope.ok) {
                      safeResetToBase();
                      cfFailureReason = `consensus-fix candidate violated scope: ${cfScope.error}`;
                    } else {
                      const cfRails = (t.rails ?? []).length ? await checkRailsGuard({ worktree, base, rails: t.rails, adlcBin: runAdlcBin }) : { violations: [] };
                      if (cfRails.violations.length) {
                        safeResetToBase();
                        cfFailureReason = `consensus-fix candidate violated rails (${cfRails.violations.join(', ')})`;
                      } else {
                        let cfGateIntegrityError = null;
                        try {
                          const basePkgPath = join(repo, 'package.json');
                          const candPkgPath = join(worktree, 'package.json');
                          if (existsSync(basePkgPath)) {
                            if (!existsSync(candPkgPath)) {
                              throw new Error('candidate deleted package.json while baseline repository requires it');
                            }
                            const basePkg = JSON.parse(readFileSync(basePkgPath, 'utf8'));
                            const candPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
                            for (const cmd of [gate?.build, gate?.test].filter(Boolean)) {
                              verifyGateScriptIntegrity(candPkg, basePkg, cmd);
                            }
                          }
                        } catch (err) {
                          cfGateIntegrityError = err;
                        }

                        if (cfGateIntegrityError) {
                          safeResetToBase();
                          cfFailureReason = `consensus-fix candidate tampered with gate script: ${cfGateIntegrityError.message}`;
                        } else {
                          status.ticket(t.id, { phase: 'gating' });
                          const cfGates = await runGates(gate, worktree, { sandbox: true });
                          if (cfGates.ok) {
                            status.ticket(t.id, { phase: 'prosecuting', detail: 'consensus-fix verification' });
                            const cfVerdict = await prosecuteBranch(t, worktree, model);
                            if (cfVerdict.verdict === 'ship') {
                              status.strike(t.id, { model, error: null, strikes });
                              await integrate(t, worktree);
                              return;
                            }
                            cfFailureReason = 'consensus-fix applied a candidate but it still failed prosecution';
                          } else {
                            cfFailureReason = 'consensus-fix applied a candidate but it still failed gates';
                          }
                        }
                      }
                    }
                  }
                }
                strikeError = cf.ok
                  ? (strikeError + '\n' + (cf.applied
                    ? `${cfFailureReason || 'consensus-fix applied a candidate but it still failed verification'} — falling back to single-attempt regeneration`
                    : `consensus-fix found no converging candidate (${cf.allDivergent ? 'all divergent' : `${cf.survivors} survivor(s)`}) — falling back to single-attempt regeneration`))
                  : (strikeError + '\n' + `consensus-fix unavailable (${cf.error}) — falling back to single-attempt regeneration`);
                lastFailure = strikeError;
                status.strike(t.id, { model, error: strikeError, strikes });
                prompt = fixPrompt(t, blocking);
                continue; // fix round consumes a strike
              }
            }
          }
        }
        }
        } finally {
          activeAttemptNamespaces.delete(attemptSlug);
          try {
            execFileSync('git', ['update-ref', '-d', attemptRef], { cwd: repo });
          } catch {}
        }

        lastFailure = strikeError;
        status.strike(t.id, { model, error: strikeError, strikes });

        // Regeneration: fresh prompt with known dead-ends appended
        prompt = regenPrompt(t, lastFailure);
      }
      throw new Error(lastFailure ?? 'two strikes exhausted');
    } catch (err) {
      failed.set(t.id, String(err.message ?? err));
      status.ticket(t.id, { phase: 'failed', detail: String(err.message ?? err).slice(0, 200) });
      log(`✗ ${t.id}: ${err.message}`);
    } finally {
      if (model) pools.unroute(model); // release the builder pool assignment for this ticket
      if (worktree && !merged.has(t.id)) {
        try { removeWorktree(repo, worktree, { force: true }); } catch {
          try { rmSync(worktree, { recursive: true, force: true }); } catch {}
        }
        const gitDir = join(repo, '.worktrees', '.attempt_git', path.basename(worktree));
        try { rmSync(gitDir, { recursive: true, force: true }); } catch {}
        deleteBranch(repo, t.id); // drop the orphan branch so re-runs don't collide
      }
      dispatch();
    }
  }

  async function integrate(t, worktree) {
    status.ticket(t.id, { phase: 'merging' });
    // Chain on the lock but never store a rejected promise as the lock
    const turn = mergeLock.then(async () => {
      releaseLock.assertStillHeld();
      const onBranch = currentBranch(repo);
      if (onBranch !== base) {
        throw new Error(`repo left base branch mid-run (now on '${onBranch}', expected '${base}') — skipping ${t.id} to avoid merging/resetting the wrong branch`);
      }
      if (process.env.AGB_ALLOW_DIRTY !== '1' && isDirty(repo)) {
        throw new Error(`repo became dirty mid-run — skipping ${t.id} to avoid 'git reset --hard' destroying uncommitted work`);
      }
      const headBefore = currentHead(repo);

      // Rebase worktree candidate onto current base and fetch into repo before merge
      discardProjection(worktree);
      execFileSync('git', ['update-ref', `refs/heads/${base}`, headBefore], { cwd: worktree });
      try {
        execFileSync('git', ['rebase', base], { cwd: worktree });
      } catch (err) {
        try { execFileSync('git', ['rebase', '--abort'], { cwd: worktree }); } catch {}
        try {
          const candSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
          if (candSha) {
            execFileSync('git', ['update-ref', `refs/quarantine/agb-${t.id.toLowerCase()}-failed-conflict`, candSha], { cwd: repo });
          }
        } catch {}
        const conflictErr = new Error(`rebase conflict for ${t.id}: ${String(err.stderr ?? err.message).slice(-300)}`);
        conflictErr.kind = 'merge_conflict';
        throw conflictErr;
      }
      const tempRef = `refs/namespaces/attempts/${t.id.toLowerCase()}/rebased`;
      execFileSync(
        'git',
        [
          'fetch',
          '--no-tags',
          pathToFileURL(join(worktree, '.git')).href,
          `HEAD:${tempRef}`,
        ],
        { cwd: repo }
      );
      const rebasedSha = execFileSync('git', ['rev-parse', tempRef], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-ref', `refs/heads/agb/${t.id.toLowerCase()}`, rebasedSha], { cwd: repo });
      try { execFileSync('git', ['update-ref', '-d', tempRef], { cwd: repo }); } catch {}

      // Authoritative anti-no-op baseline diff check
      if (rebasedSha === headBefore) {
        const emptyErr = new Error(`anti-no-op gate failed: zero changes against baseline commit ${headBefore}`);
        emptyErr.kind = 'empty_diff';
        throw emptyErr;
      }
      const diffTree = execFileSync('git', ['diff-tree', '-r', '--name-status', '-M', '-C', '-z', headBefore, rebasedSha], { cwd: repo }).toString('utf8');
      if (!diffTree.trim()) {
        const emptyErr = new Error(`anti-no-op gate failed: zero changes against baseline commit ${headBefore}`);
        emptyErr.kind = 'empty_diff';
        throw emptyErr;
      }

      // Check whether root working tree can be advisory synced (clean, on base, at headBefore)
      const canAdvisorySync = (
        currentBranch(repo) === base &&
        execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo }).length === 0 &&
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() === headBefore
      );

      // Create dedicated disposable integration worktree
      const transactionToken = crypto.randomUUID();
      const agbRef = `refs/heads/agb/${t.id.toLowerCase()}`;
      let integrationPath = null;
      let journalWritten = false;
      let baseRefAdvanced = false;
      const journalData = {
        ticketId: t.id,
        transactionToken,
        preMergeSha: headBefore,
        candidateSha: rebasedSha,
        phase: JOURNAL_PHASES.PREPARED,
        timestamp: Date.now(),
      };

      try {
        integrationPath = createIntegrationWorktree(repo, transactionToken, base);
        execFileSync('git', ['reset', '--hard', rebasedSha], { cwd: integrationPath });

        // Phase 1: PREPARED
        writeIntegrationJournal(repo, journalData);
        journalWritten = true;

        // Post-merge gates inside disposable worktree under Trusted Baseline Test Oracle Protocol
        let hasBaselineTests = false;
        try {
          execFileSync('git', ['cat-file', '-e', `${headBefore}:test`], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
          hasBaselineTests = true;
        } catch {}

        // Verify gate script integrity before running integration gates
        const basePkgPath = join(repo, 'package.json');
        const candPkgPath = join(integrationPath, 'package.json');
        if (existsSync(basePkgPath)) {
          if (!existsSync(candPkgPath)) {
            const err = new Error('candidate deleted package.json while baseline repository requires it');
            err.kind = 'post_merge_gate_failure';
            throw err;
          }
          const basePkg = JSON.parse(readFileSync(basePkgPath, 'utf8'));
          const candPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
          for (const cmd of [gate?.build, gate?.test].filter(Boolean)) {
            verifyGateScriptIntegrity(candPkg, basePkg, cmd);
          }
        }

        // Pass 1: Baseline Regression
        if (hasBaselineTests && gate?.test) {
          execFileSync('git', ['checkout', headBefore, '--', 'test'], { cwd: integrationPath });
          const pass1 = await runGates({ test: gate.test }, integrationPath, { sandbox: true });
          if (!pass1.ok) {
            const g = pass1.results.at(-1);
            const pass1Err = new Error(`Pass 1 (baseline regression) failed: gate ${g?.name ?? 'test'} failed:\n${g?.output?.slice(0, 300)}`);
            pass1Err.kind = 'post_merge_gate_failure';
            throw pass1Err;
          }
          execFileSync('git', ['reset', '--hard', rebasedSha], { cwd: integrationPath });
        }

        // Pass 2: Candidate Gates
        const post = await runGates(gate, integrationPath, { sandbox: true });
        await recordGate({ repo, gateName: 'post-merge-build', ticketId: t.id, data: { ok: post.ok }, adlcBin: runAdlcBin });
        if (!post.ok) {
          const g = post.results.at(-1);
          const postErr = new Error(`post-merge gate ${g?.name} failed:\n${g?.output?.slice(0, 300)}`);
          postErr.kind = 'post_merge_gate_failure';
          throw postErr;
        }

        // Pass 2 hollow-test mutation verification if test/** files were modified
        const diffFiles = execFileSync('git', ['diff-tree', '-r', '--name-only', '-z', headBefore, rebasedSha], { cwd: repo }).toString('utf8').split('\0').filter(Boolean);
        const modifiedTests = diffFiles.filter((p) => p.startsWith('test/'));
        if (modifiedTests.length > 0 && gate?.test) {
          try {
            await execFileAuthenticatedAdlc(
              runAdlcBin,
              ['hollow-test', '--test-cmd', gate.test, '--base', headBefore],
              { cwd: integrationPath, maxBuffer: 10 * 1024 * 1024 },
              { repo }
            );
          } catch (err) {
            const isAuth = err.code === 'EAUTH' || /Authenticated ADLC binary verification failed/i.test(err.message);
            const hollowErr = new Error(
              isAuth
                ? `hollow-test mutation verification failed: authenticated adlc binary is unavailable or failed revalidation to verify modified tests (${modifiedTests.join(', ')}): ${err.message}`
                : `hollow-test mutation verification failed: ${String(err.stderr ?? err.stdout ?? err.message).slice(0, 300)}`
            );
            hollowErr.kind = 'post_merge_gate_failure';
            throw hollowErr;
          }
        }

        // Phase 2: GATES_PASSED
        journalData.phase = JOURNAL_PHASES.GATES_PASSED;
        journalData.timestamp = Date.now();
        writeIntegrationJournal(repo, journalData);

        // Durable Transaction Marker:
        const markerRef = `refs/transactions/${t.id}/${transactionToken}`;
        execFileSync('git', ['update-ref', markerRef, rebasedSha], { cwd: repo });

        // Atomic CAS advance on refs/heads/${base}:
        execFileSync('git', ['update-ref', `refs/heads/${base}`, rebasedSha, headBefore], { cwd: repo });
        baseRefAdvanced = true;

        // Phase 3: REF_ADVANCED
        journalData.phase = JOURNAL_PHASES.REF_ADVANCED;
        journalData.timestamp = Date.now();
        writeIntegrationJournal(repo, journalData);

        // Phase 4: FINALIZED (write-ahead phase persistence)
        journalData.phase = JOURNAL_PHASES.FINALIZED;
        journalData.timestamp = Date.now();
        writeIntegrationJournal(repo, journalData);

        // Idempotent cleanup:
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
        try { removeWorktree(repo, integrationPath, { force: true }); } catch {
          try { rmSync(integrationPath, { recursive: true, force: true }); } catch {}
        }
        integrationPath = null;
        unlinkIntegrationJournal(repo);
      } catch (err) {
        if (!baseRefAdvanced) {
          await recordGate({ repo, gateName: 'rollback', ticketId: t.id, data: { reason: String(err.message ?? err).slice(0, 300) }, adlcBin: runAdlcBin });
          try {
            execFileSync('git', ['update-ref', `refs/quarantine/agb-${t.id.toLowerCase()}-failed-post-merge`, rebasedSha], { cwd: repo });
          } catch {}
          try { execFileSync('git', ['update-ref', '-d', agbRef], { cwd: repo }); } catch {}
          if (journalWritten) {
            unlinkIntegrationJournal(repo);
          }
          if (integrationPath) {
            try { removeWorktree(repo, integrationPath, { force: true }); } catch {
              try { rmSync(integrationPath, { recursive: true, force: true }); } catch {}
            }
          }
          throw err;
        } else {
          log(`⚠ Warning during integration finalization after base ref advance: ${err.message}`);
          try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo }); } catch {}
          if (integrationPath) {
            try { removeWorktree(repo, integrationPath, { force: true }); } catch {
              try { rmSync(integrationPath, { recursive: true, force: true }); } catch {}
            }
            integrationPath = null;
          }
          if (journalWritten) {
            try { unlinkIntegrationJournal(repo); } catch {}
          }
        }
      }

      merged.add(t.id);
      mergedShas.add(rebasedSha);
      try { removeWorktree(repo, worktree, { force: true }); } catch {
        try { rmSync(worktree, { recursive: true, force: true }); } catch {}
      }
      const gitDir = join(repo, '.worktrees', '.attempt_git', path.basename(worktree));
      try { rmSync(gitDir, { recursive: true, force: true }); } catch {}
      status.ticket(t.id, { phase: 'merged' });
      log(`✓ ${t.id} merged`);

      // Decoupled Non-Transactional Root Working Tree Advisory Sync
      try {
        let isCleanNow = false;
        try {
          if (canAdvisorySync && currentBranch(repo) === base) {
            execFileSync('git', ['diff-files', '--quiet'], { cwd: repo, stdio: 'ignore' });
            execFileSync('git', ['diff-index', '--cached', '--quiet', headBefore], { cwd: repo, stdio: 'ignore' });
            isCleanNow = true;
          }
        } catch {
          isCleanNow = false;
        }

        if (isCleanNow) {
          execFileSync('git', ['read-tree', '-u', '-m', headBefore, rebasedSha], { cwd: repo });
        } else {
          const onBranch = currentBranch(repo);
          log(`Notice: baseRef advanced to ${rebasedSha}. Root working tree was not updated (uncommitted changes or active branch '${onBranch}'). Run 'git checkout ${base} && git merge --ff-only' when ready.`);
        }
      } catch (err) {
        log(`Notice: root working tree advisory sync skipped: ${err.message}`);
      }
    });
    mergeLock = turn.catch(() => {});
    await turn;
  }

  function dispatch() {
    for (const t of tickets) {
      if (isReady(t)) running.push(runTicket(t));
    }
    // Tickets whose predecessors failed can never run — fail them through.
    for (const t of tickets) {
      if (!started.has(t.id) && preds[t.id].some((p) => failed.has(p))) {
        started.add(t.id);
        failed.set(t.id, `blocked by failed predecessor`);
        status.ticket(t.id, { phase: 'blocked' });
      }
    }
  }

    dispatch();
    // Drain: new work is appended to `running` by dispatch() inside finally.
    let settled = 0;
    while (settled < running.length) {
      const batch = running.slice(settled);
      settled += batch.length;
      await Promise.allSettled(batch);
    }
  } finally {
    releaseLock();
  }

  const report = {
    runId,
    merged: [...merged],
    failed: Object.fromEntries(failed),
    requests: pools.snapshot().requests,
    enforcementAvailable: enforcement.available,
    enforcementReason: enforcement.reason,
  };
  status.report(report);
  return report;
}

function currentHead(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function resetHard(repo, sha) {
  execFileSync('git', ['reset', '--hard', sha], { cwd: repo });
}

// Remove untracked files a failed gate created. -d (dirs) but NOT -x, so
// gitignored deps (node_modules) are left intact. Safe because the run
// refused to start on a dirty tree, so any untracked file here is gate debris.
function cleanUntracked(repo) {
  execFileSync('git', ['clean', '-fd'], { cwd: repo });
}
