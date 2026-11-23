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

import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, lstatSync, openSync, closeSync, writeSync, fsyncSync, unlinkSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path, { join, resolve, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { topoSort } from '@adlc/core/tickets';
import { runAgy } from './agy.mjs';
import { PoolSet, reconcileLeases, tierCandidates, poolOf, upstreamPoolOf } from './pools.mjs';
import { ORCHESTRATOR_MODELS, runWithOrchestratorRoutingState } from './models.mjs';
import { parse as semverParse, lt as semverLt } from './semver.mjs';
import { resolveAgyBinary } from "./plugin-paths.mjs";
import { builderAgentsMd, builderPrompt, fixPrompt, regenPrompt, warmRegenPrompt } from './charters.mjs';
export { warmRegenPrompt };

import { checkAgyBinary } from './doctor.mjs';
import { runGate, runGates, gateSandboxAvailable, sandboxProfile, linuxBwrapArgs } from './gates.mjs';
import { prosecute, blockingFindings } from './prosecute.mjs';
import { verifyGateScriptIntegrity, TICKET_ID_RE } from './plan.mjs';
import { planTicketToRailTicket, writeAdlcTickets, assertNoLegacyTicketStore, resolveAdlcBinary, execFileAuthenticatedAdlc } from './adlc-bridge.mjs';
import {
  ensureGitignore, createWorktree, removeWorktree, pruneWorktrees,
  branchDiff, commitAll, changedFiles,
  isDirty, deleteBranch, currentBranch, resetToBase, cleanEmptyNodeModules,
  materializeWorktreeNodeModules, removeMaterializedNodeModules, discardProjection,
  JOURNAL_PHASES, createIntegrationWorktree, reapIntegrationWorktrees,
  writeIntegrationJournal, readIntegrationJournal, quarantineIntegrationJournal,
  unlinkIntegrationJournal, assertSafeAdlcDir,
} from './worktrees.mjs';
import { RunStatus } from './status.mjs';
import { startControlServer, sendControlCommand } from './control-ipc.mjs';
import { saveRescueSnapshot, hasProtectedRescueWorktree, clearRescueWorktreeLock } from './rescue.mjs';
import { unionActiveRails, loadActiveRails } from './active-rails.mjs';
import { enforcementGate, sanitizedGitEnv, snapshotRunIntegrity, verifyRunIntegrity } from './run-integrity.mjs';
import { acquireRepoLock } from './lock.mjs';
import { TerminalHUD } from './hud.mjs';
import {
  verifyScopeAndAntiNoOp,
  checkFlailDetector,
  sanitizeBuilderStreamOutputForFlail,
  runConsensusFix,
  wrapConsensusGateCommand,
  buildSandboxCommandWrapper,
  recordGate,
  checkRailsGuard,
  checkEnforcementAvailable,
  runSymbolScopeVerification,
  prepareTicketContextAndTdd,
  resolveTicketGateConfig,
  executeSpeculativeMergeBatch,
  BanditModelRouter,
  syncOverviewPaneState,
} from './scheduler-verify.mjs';

export {
  verifyScopeAndAntiNoOp,
  checkFlailDetector,
  sanitizeBuilderStreamOutputForFlail,
  runConsensusFix,
  wrapConsensusGateCommand,
  buildSandboxCommandWrapper,
  recordGate,
  checkRailsGuard,
  checkEnforcementAvailable,
  runSymbolScopeVerification,
  prepareTicketContextAndTdd,
  resolveTicketGateConfig,
  executeSpeculativeMergeBatch,
  BanditModelRouter,
  syncOverviewPaneState,
};

const NULL_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

export function terminateProcessTree(child, sig = 'SIGKILL') {
  if (!child) return;
  const pid = child.pid;
  if (pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      try { process.kill(-pid, sig); } catch {}
      try {
        const pids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
        for (const pidStr of pids) {
          const subPid = Number(pidStr);
          if (subPid) {
            try { process.kill(subPid, sig); } catch {}
          }
        }
      } catch {}
    }
  }
  try { child.kill(sig); } catch {}
}

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

export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export function getGitCommonDir(repo) {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      env: sanitizedGitEnv(),
    }).trim();
    return resolve(repo, raw);
  } catch {
    return join(repo, '.git');
  }
}

export function getGitIndexPath(repo, fallbackGitDir) {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-path', 'index'], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      env: sanitizedGitEnv(),
    }).trim();
    if (raw) return resolve(repo, raw);
  } catch {}
  return join(fallbackGitDir ?? getGitCommonDir(repo), 'index');
}

export function snapshotRootGit(repo) {
  const gitEnv = sanitizedGitEnv();
  const g = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, env: gitEnv }).trim();
  const gitDir = getGitCommonDir(repo);

  const headSha = g('rev-parse', 'HEAD');
  const status = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z'], {
    cwd: repo,
    maxBuffer: GIT_MAX_BUFFER,
    env: gitEnv,
  });

  let refs = '';
  try {
    refs = execFileSync('git', ['show-ref'], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv,
    });
  } catch (err) {
    if (err.code === 'ENOBUFS') throw err;
  }

  const configPath = join(gitDir, 'config');
  const configHash = existsSync(configPath)
    ? crypto.createHash('sha256').update(readFileSync(configPath)).digest('hex')
    : null;

  const hooksHash = hashDir(join(gitDir, 'hooks'));

  const indexPath = getGitIndexPath(repo, gitDir);
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

const QUARANTINE_REF_RE =
  /^refs\/quarantine\/agb-([^/]+)-(?:failed(?:-(?:conflict|merge|post-merge|integration|crash))?|unsupported-phase)$/i;

function parsePorcelainZ(buf) {
  const entries = [];
  const raw = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
  const parts = raw.split('\0');
  let i = 0;
  while (i < parts.length) {
    const token = parts[i];
    if (!token) {
      i += 1;
      continue;
    }
    const x = token[0] ?? ' ';
    const y = token[1] ?? ' ';
    const filePath = token.slice(3);
    if (x === 'R' || x === 'C') {
      const origPath = parts[i + 1] ?? '';
      entries.push({ x, y, path: filePath, origPath, raw: `${token}\0${origPath}` });
      i += 2;
    } else {
      entries.push({ x, y, path: filePath, origPath: null, raw: token });
      i += 1;
    }
  }
  return entries;
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
    gitMaxBuffer = GIT_MAX_BUFFER,
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

  const gitEnv = sanitizedGitEnv();
  const g = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: gitMaxBuffer, env: gitEnv }).trim();
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
  const postStatus = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z'], {
    cwd: repo,
    maxBuffer: gitMaxBuffer,
    env: gitEnv,
  });
  if (headMovedByMerge) {
    if (pre.status.length === 0) {
      if (postStatus.length !== 0) {
        return { ok: false, error: 'Porcelain status altered in root repository' };
      }
    } else if (!postStatus.equals(pre.status)) {
      const mergedChangedPaths = new Set();
      try {
        const diffNames = execFileSync(
          'git',
          ['diff-tree', '-r', '--name-only', '-z', pre.headSha, postHeadSha],
          { cwd: repo, maxBuffer: gitMaxBuffer, env: gitEnv }
        )
          .toString('utf8')
          .split('\0')
          .filter(Boolean);
        for (const p of diffNames) mergedChangedPaths.add(p);
      } catch (err) {
        if (err.code === 'ENOBUFS') {
          return { ok: false, error: `Failed to enumerate merged root paths: ${err.message}` };
        }
        return { ok: false, error: 'Porcelain status altered in root repository' };
      }

      const preEntries = parsePorcelainZ(pre.status);
      const postEntries = parsePorcelainZ(postStatus);
      const preRawSet = new Set(preEntries.map((e) => e.raw));
      const postRawSet = new Set(postEntries.map((e) => e.raw));
      const preWorktreeStates = new Map();
      for (const e of preEntries) {
        if (!preWorktreeStates.has(e.path)) preWorktreeStates.set(e.path, new Set());
        preWorktreeStates.get(e.path).add(e.y);
      }
      const postWorktreeStates = new Map();
      for (const e of postEntries) {
        if (!postWorktreeStates.has(e.path)) postWorktreeStates.set(e.path, new Set());
        postWorktreeStates.get(e.path).add(e.y);
      }

      for (const e of postEntries) {
        if (preRawSet.has(e.raw)) continue;
        const inMerged =
          mergedChangedPaths.has(e.path) && (!e.origPath || mergedChangedPaths.has(e.origPath));
        if (!inMerged || e.x === '?' || e.y === '?') {
          return { ok: false, error: 'Porcelain status altered in root repository' };
        }
        const preYs = preWorktreeStates.get(e.path);
        const worktreeAllowed = e.y === ' ' || (preYs && preYs.has(e.y));
        if (!worktreeAllowed) {
          return { ok: false, error: 'Porcelain status altered in root repository' };
        }
      }

      for (const e of preEntries) {
        if (postRawSet.has(e.raw)) continue;
        const inMerged =
          mergedChangedPaths.has(e.path) || (Boolean(e.origPath) && mergedChangedPaths.has(e.origPath));
        if (!inMerged) {
          return { ok: false, error: 'Porcelain status altered in root repository' };
        }
        if (e.y !== ' ') {
          const postYs = postWorktreeStates.get(e.path);
          if (!postYs || !postYs.has(e.y)) {
            return { ok: false, error: 'Porcelain status altered in root repository' };
          }
        }
      }
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
    const indexPath = getGitIndexPath(repo, gitDir);
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
    postRefsRaw = execFileSync('git', ['show-ref'], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: gitMaxBuffer,
      env: gitEnv,
    });
  } catch (err) {
    if (err.code === 'ENOBUFS') {
      return { ok: false, error: `Failed to enumerate Git refs: ${err.message}` };
    }
  }

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
        const match = name.match(QUARANTINE_REF_RE);
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
                g('merge-base', '--is-ancestor', sha, mSha);
                isLegitimateOldSha = true;
                break;
              } catch {}
            }
          }
          if (isMerged && (isLegitimateOldSha || name.startsWith('refs/namespaces/attempts/'))) {
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
          g('merge-base', '--is-ancestor', postSha, candidateSha);
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
        const match = name.match(QUARANTINE_REF_RE);
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
            g('merge-base', '--is-ancestor', sha, candidateSha);
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
            g('merge-base', '--is-ancestor', pre.headSha, sha);
            isLegitimate = true;
          } catch {}
          if (!isLegitimate) {
            for (const mSha of mergedShas) {
              try {
                g('merge-base', '--is-ancestor', mSha, sha);
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
      const revListArgs = ['rev-list', '--objects', '--no-object-names'];
      if (candidateSha) revListArgs.push(candidateSha);
      if (pre.headSha) revListArgs.push(pre.headSha);
      if (postHeadSha && postHeadSha !== pre.headSha) revListArgs.push(postHeadSha);
      revListArgs.push(
        '--glob=refs/namespaces/attempts',
        '--glob=refs/heads/agb',
        '--glob=refs/transactions',
        '--glob=refs/quarantine'
      );
      if (typeof base === 'string' && base.trim()) {
        const baseRef = base.startsWith('refs/') ? base : `refs/heads/${base}`;
        try {
          execFileSync('git', ['show-ref', '--verify', '--quiet', baseRef], {
            cwd: repo,
            maxBuffer: gitMaxBuffer,
            env: gitEnv,
          });
          revListArgs.push(baseRef);
        } catch {
          // Detached HEAD or non-branch base: pre.headSha / postHeadSha already cover HEAD lineage
        }
      }
      const out = execFileSync('git', revListArgs, {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: gitMaxBuffer,
        env: gitEnv,
      });
      for (const line of out.split('\n').filter(Boolean)) {
        const sha = line.trim().split(/\s+/)[0];
        if (sha && sha.length >= 4) {
          reachable.add(`${sha.slice(0, 2)}/${sha.slice(2)}`);
        }
      }
    } catch (err) {
      return { ok: false, error: `Failed to enumerate reachable Git objects: ${err.message}` };
    }

    for (const newObj of newObjects) {
      if (newObj.startsWith('pack/')) {
        const packRel = newObj.slice('pack/'.length);
        if (packRel.endsWith('.pack')) {
          const packFullPath = join(gitDir, 'objects', newObj);
          let verifyOut = '';
          try {
            verifyOut = execFileSync('git', ['verify-pack', '-v', packFullPath], {
              cwd: repo,
              encoding: 'utf8',
              maxBuffer: gitMaxBuffer,
              env: gitEnv,
            });
          } catch (err) {
            return { ok: false, error: `Unauthorized or invalid pack file detected: ${newObj} (${err.message})` };
          }
          for (const line of verifyOut.split('\n')) {
            const match = line.trim().match(/^([0-9a-fA-F]{40,64})\s+/);
            if (match) {
              const sha = match[1].toLowerCase();
              const looseFormat = `${sha.slice(0, 2)}/${sha.slice(2)}`;
              if (!reachable.has(looseFormat)) {
                return { ok: false, error: `Unauthorized stray object detected in root object storage pack ${newObj}: ${sha}` };
              }
            }
          }
          continue;
        } else if (/\.(idx|rev|mtimes|bitmap)$/.test(packRel)) {
          const matchingPack = packRel.replace(/\.(idx|rev|mtimes|bitmap)$/, '.pack');
          if (!existsSync(join(gitDir, 'objects', 'pack', matchingPack))) {
            return { ok: false, error: `Unauthorized stray pack metadata file without matching pack: ${newObj}` };
          }
          continue;
        } else {
          return { ok: false, error: `Unauthorized stray file in pack directory: ${newObj}` };
        }
      }

      if (!reachable.has(newObj)) {
        return { ok: false, error: `Unauthorized stray object detected in root object storage: ${newObj}` };
      }
    }
  }

  return { ok: true };
}

/**
 * Safely writes a file in a worktree, unlinking symlinks first and using O_NOFOLLOW
 * to prevent symlink traversal and arbitrary host file overwrite.
 */
export function safeWriteWorktreeFile(filePath, content) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      unlinkSync(filePath);
    } else if (!st.isFile()) {
      rmSync(filePath, { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags, 0o644);
  try {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function setupAttemptGitDatabase(repo, worktreePath, baseRef) {
  const gitEnv = sanitizedGitEnv();
  const g = (cwd, ...args) => execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, ...args], { cwd, encoding: 'utf8', env: gitEnv }).trim();
  const baseSha = g(repo, 'rev-parse', baseRef);

  const gitDir = join(repo, '.worktrees', '.attempt_git', path.basename(worktreePath));
  if (existsSync(gitDir)) {
    try { rmSync(gitDir, { recursive: true, force: true }); } catch {}
  }
  mkdirSync(gitDir, { recursive: true });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'init', '-q', '--bare', '-b', 'candidate', gitDir], { env: gitEnv });

  const altDir = join(gitDir, 'objects', 'info');
  mkdirSync(altDir, { recursive: true });
  writeFileSync(join(altDir, 'alternates'), join(getGitCommonDir(repo), 'objects') + '\n');

  // Ensure hooks directory is empty and protected
  const hooksDir = join(gitDir, 'hooks');
  if (existsSync(hooksDir)) {
    try { rmSync(hooksDir, { recursive: true, force: true }); } catch {}
  }
  mkdirSync(hooksDir, { recursive: true });

  const gitEntry = join(worktreePath, '.git');
  safeWriteWorktreeFile(gitEntry, `gitdir: ${gitDir}\n`);

  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'config', 'core.bare', 'false'], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'reset', '--hard', baseSha], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'config', 'core.worktreeConfig', 'true'], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'config', 'core.hooksPath', NULL_HOOKS_PATH], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, '--git-dir', gitDir, 'config', 'core.hooksPath', NULL_HOOKS_PATH], { env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'config', 'user.name', 'agb-builder'], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'config', 'user.email', 'agb@local'], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'config', 'commit.gpgsign', 'false'], { cwd: worktreePath, env: gitEnv });
  execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'update-ref', `refs/heads/${baseRef}`, baseSha], { cwd: worktreePath, env: gitEnv });

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

  // Verify hooks directory does not contain unauthorized hook scripts
  const hooksDir = join(resolvedTarget, 'hooks');
  if (existsSync(hooksDir)) {
    const entries = readdirSync(hooksDir);
    for (const ent of entries) {
      if (!ent.endsWith('.sample')) {
        throw new Error(`Security violation: unexpected hook file found in attempt git database: ${ent}`);
      }
    }
  }

  // Verify core.hooksPath has not been redirected
  try {
    const hp = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: worktreePath,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
    }).trim();
    if (hp && hp !== '/dev/null' && hp !== 'NUL') {
      throw new Error(`Security violation: core.hooksPath tampered with: ${hp}`);
    }
  } catch (err) {
    if (err.message?.includes('Security violation')) throw err;
  }

  return true;
}

export function hostMediatedFetch(repo, worktreePath, attemptNamespace, expectedGitDir = null) {
  if (expectedGitDir) {
    verifyWorktreeGitPointer(worktreePath, expectedGitDir);
  }
  const gitEnv = sanitizedGitEnv();
  const destRef = `refs/namespaces/${attemptNamespace}/refs/heads/candidate`;
  const gitUrl = pathToFileURL(join(worktreePath, '.git')).href;
  execFileSync(
    'git',
    [
      '-c',
      `core.hooksPath=${NULL_HOOKS_PATH}`,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      gitUrl,
      `refs/heads/candidate:${destRef}`,
    ],
    { cwd: repo, env: gitEnv }
  );
  return execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'rev-parse', destRef], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  }).trim();
}

// Per-strike print-mode wall-clock budget (idle progress timeout remains 5m in
// lib/agy.mjs so hung workers still fail fast while active multi-file turns finish).
const BUILD_TIMEOUT = process.env.AGB_BUILD_TIMEOUT ?? '15m';

/**
 * Startup crash reconciliation & provenance-safe ref recovery across all 4 phases.
 * Validates integration journal, isolates corrupt journals to quarantine, checks
 * transaction provenance markers, prevents data loss on external divergence, and
 * guarantees atomic CAS forward progress or clean rollback.
 */
export async function reconcileIntegrationJournal(repo, base = 'main') {
  assertSafeAdlcDir(repo);
  const gitEnv = sanitizedGitEnv();
  const readRes = readIntegrationJournal(repo);
  const currentBaseSha = (() => {
    try {
      return execFileSync('git', ['rev-parse', `refs/heads/${base}`], { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();
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
      const showRef = execFileSync('git', ['show-ref'], { cwd: repo, encoding: 'utf8', env: gitEnv });
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
        try { execFileSync('git', ['update-ref', '-d', orphanMarkerRef], { cwd: repo, env: gitEnv }); } catch {}
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'finalized_orphan_marker' };
      } else {
        // Not advanced: quarantine candidate
        try {
          execFileSync('git', ['update-ref', `refs/quarantine/agb-${orphanTicketId || 'unknown'}-failed-crash`, orphanMarkerSha], { cwd: repo, env: gitEnv });
        } catch {}
        try { execFileSync('git', ['update-ref', '-d', orphanMarkerRef], { cwd: repo, env: gitEnv }); } catch {}
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
      const showRef = execFileSync('git', ['show-ref'], { cwd: repo, encoding: 'utf8', env: gitEnv });
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
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'finalized_corrupt_journal' };
      } else {
        try {
          execFileSync('git', ['update-ref', `refs/quarantine/agb-${markerTicketId || 'unknown'}-failed-crash`, markerSha], { cwd: repo, env: gitEnv });
        } catch {}
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
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
    markerSha = execFileSync('git', ['rev-parse', '--verify', markerRef], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
  } catch {}

  if (!Object.values(JOURNAL_PHASES).includes(phase)) {
    quarantineIntegrationJournal(repo, 'unsupported_phase');
    if (markerSha) {
      try {
        execFileSync('git', ['update-ref', `refs/quarantine/agb-${(ticketId || 'unknown').toLowerCase()}-unsupported-phase`, markerSha], { cwd: repo, env: gitEnv });
      } catch {}
      try {
        execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv });
      } catch {}
    }
    const err = new Error(`Unsupported integration journal phase '${phase}' for ticket '${ticketId}'. Journal quarantined for operator review.`);
    err.kind = 'unsupported_journal_phase';
    throw err;
  }

  if (phase === JOURNAL_PHASES.PREPARED) {
    if (currentBaseSha !== preMergeSha) {
      quarantineIntegrationJournal(repo, 'conflict');
      const err = new Error(`External ref divergence detected: base branch '${base}' moved from ${preMergeSha} to ${currentBaseSha} while transaction ${ticketId} was in PREPARED phase.`);
      err.kind = 'external_ref_divergence';
      throw err;
    }
    if (candidateSha) {
      try {
        execFileSync('git', ['update-ref', `refs/quarantine/agb-${ticketId.toLowerCase()}-failed-crash`, candidateSha], { cwd: repo, env: gitEnv });
      } catch {}
    }
    if (markerSha) {
      try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
    }
    unlinkIntegrationJournal(repo);
    reapIntegrationWorktrees(repo);
    return { ok: true, status: 'rolled_back', phase: JOURNAL_PHASES.PREPARED };
  }

  if (phase === JOURNAL_PHASES.GATES_PASSED) {
    if (markerSha && markerSha === candidateSha) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', preMergeSha, candidateSha], { cwd: repo, env: gitEnv });
      } catch {
        quarantineIntegrationJournal(repo, 'unproven_candidate');
        const err = new Error(`Cannot recover journal: candidate ${candidateSha} is not a valid descendant of preMergeSha ${preMergeSha}.`);
        err.kind = 'unproven_candidate_requires_operator';
        throw err;
      }

      if (currentBaseSha === candidateSha) {
        writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
        unlinkIntegrationJournal(repo);
        reapIntegrationWorktrees(repo);
        return { ok: true, status: 'reconciled', action: 'finalized_gates_passed', ticketId };
      }
      if (currentBaseSha === preMergeSha) {
        execFileSync('git', ['update-ref', `refs/heads/${base}`, candidateSha, preMergeSha], { cwd: repo, env: gitEnv });
        writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
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
      execFileSync('git', ['merge-base', '--is-ancestor', preMergeSha, candidateSha], { cwd: repo, env: gitEnv });
    } catch {
      quarantineIntegrationJournal(repo, 'unproven_candidate');
      const err = new Error(`Cannot recover journal: candidate ${candidateSha} is not a valid descendant of preMergeSha ${preMergeSha}.`);
      err.kind = 'unproven_candidate_requires_operator';
      throw err;
    }
    if (currentBaseSha === candidateSha) {
      writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
      if (markerSha) {
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
      }
      unlinkIntegrationJournal(repo);
      reapIntegrationWorktrees(repo);
      return { ok: true, status: 'reconciled', action: 'finalized_from_ref_advanced', ticketId };
    }
    if (currentBaseSha === preMergeSha) {
      if (markerSha !== candidateSha) {
        quarantineIntegrationJournal(repo, 'unproven_candidate');
        const err = new Error(`Unproven ref advancement requires operator: journal phase is REF_ADVANCED but base branch '${base}' is at preMergeSha and marker ref ${markerRef} is missing or does not match candidateSha ${candidateSha}. Refusing to advance base branch.`);
        err.kind = 'unproven_ref_advancement_requires_operator';
        throw err;
      }
      execFileSync('git', ['update-ref', `refs/heads/${base}`, candidateSha, preMergeSha], { cwd: repo, env: gitEnv });
      writeIntegrationJournal(repo, { ...readRes.journal, phase: JOURNAL_PHASES.FINALIZED, timestamp: Date.now() });
      if (markerSha) {
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
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
      try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
    }
    unlinkIntegrationJournal(repo);
    reapIntegrationWorktrees(repo);
    return { ok: true, status: 'clean', phase: JOURNAL_PHASES.FINALIZED };
  }

  quarantineIntegrationJournal(repo, 'unsupported_phase');
  const err = new Error(`Unsupported integration journal phase '${phase}' for ticket '${ticketId}'. Journal quarantined for operator review.`);
  err.kind = 'unsupported_journal_phase';
  throw err;
}

const MAX_IPC_DIFF_BYTES = 64 * 1024;

function truncateUtf8ToBytes(str, maxBytes) {
  const s = String(str ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function formatStepClock(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '00:00:00';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function readLiveWorktreeDiff(worktreePath, baseRef, expectedGitDir) {
  if (!worktreePath || !expectedGitDir || !existsSync(worktreePath)) return '';
  try {
    if (lstatSync(worktreePath).isSymbolicLink()) return '';
    verifyWorktreeGitPointer(worktreePath, expectedGitDir);
  } catch {
    return '';
  }
  const gitEnv = sanitizedGitEnv();
  const chunks = [];
  try {
    const trackedDiff = execFileSync(
      'git',
      [
        '-c',
        `core.hooksPath=${NULL_HOOKS_PATH}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        'diff',
        baseRef,
        '--',
        '.',
        ':(exclude)AGENTS.md',
        ':(exclude).adlc/tickets',
        ':(exclude).agb_home',
        ':(exclude).agb_home/**',
      ],
      { cwd: worktreePath, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: gitEnv }
    );
    if (trackedDiff) chunks.push(trackedDiff);
  } catch {}

  try {
    const untrackedOut = execFileSync(
      'git',
      [
        '-c',
        `core.hooksPath=${NULL_HOOKS_PATH}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        'ls-files',
        '--others',
        '--exclude-standard',
      ],
      { cwd: worktreePath, encoding: 'utf8', maxBuffer: 1024 * 1024, env: gitEnv }
    );
    const untrackedFiles = untrackedOut
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .filter(
        (f) =>
          f !== 'AGENTS.md' &&
          !f.startsWith('.adlc/') &&
          f !== '.adlc' &&
          !f.startsWith('.agb_home/') &&
          f !== '.agb_home' &&
          !f.startsWith('node_modules/') &&
          f !== 'node_modules' &&
          !f.startsWith('.worktrees/') &&
          !f.startsWith('.booster/')
      );
    let currentBytes = Buffer.byteLength(chunks.join(''), 'utf8');
    for (const rel of untrackedFiles) {
      if (currentBytes >= MAX_IPC_DIFF_BYTES) break;
      const full = join(worktreePath, rel);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink() || !st.isFile() || st.size > 512 * 1024) continue;
        const content = readFileSync(full);
        if (content.subarray(0, Math.min(content.length, 2048)).includes(0)) {
          const binBlock = `diff --git a/${rel} b/${rel}\nnew file\nBinary file ${rel} added\n`;
          chunks.push(binBlock);
          currentBytes += Buffer.byteLength(binBlock, 'utf8');
          continue;
        }
        const textLines = content.toString('utf8').split('\n').slice(0, 120);
        const block =
          `diff --git a/${rel} b/${rel}\n--- /dev/null\n+++ b/${rel}\n` +
          textLines.map((l) => `+${l}`).join('\n') +
          '\n';
        chunks.push(block);
        currentBytes += Buffer.byteLength(block, 'utf8');
      } catch {}
    }
  } catch {}

  return truncateUtf8ToBytes(chunks.join(''), MAX_IPC_DIFF_BYTES);
}

function readSavedRescueDiff(repo, ticketId) {
  if (!ticketId || typeof ticketId !== 'string' || !TICKET_ID_RE.test(ticketId)) return '';
  try {
    const boosterDir = join(repo, '.booster');
    if (lstatSync(boosterDir).isSymbolicLink()) return '';
    const latestDir = join(boosterDir, 'rescue-latest');
    if (lstatSync(latestDir).isSymbolicLink()) return '';
    const snapFile = join(latestDir, `${ticketId.toLowerCase()}.json`);
    const st = lstatSync(snapFile);
    if (st.isSymbolicLink() || !st.isFile()) return '';
    const parsed = JSON.parse(readFileSync(snapFile, 'utf8'));
    return typeof parsed?.diff === 'string'
      ? truncateUtf8ToBytes(parsed.diff, MAX_IPC_DIFF_BYTES)
      : '';
  } catch {
    return '';
  }
}

function computeTicketResumeHash(t) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ id: t?.id ?? '', scope: [...(t?.scope ?? [])].sort() }))
    .digest('hex');
}

function isCommitAncestorAndUnreverted(repo, baseRef, commitSha, ticketId, gitEnv) {
  if (!commitSha || !/^[0-9a-f]{40,64}$/i.test(commitSha)) return false;
  try {
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'merge-base', '--is-ancestor', commitSha, baseRef],
      { cwd: repo, stdio: 'ignore', env: gitEnv }
    );
  } catch {
    return false;
  }
  try {
    const afterSubjects = execFileSync(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'log', '--format=%s', `${commitSha}..${baseRef}`],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv }
    );
    const idLower = ticketId.toLowerCase();
    for (const raw of afterSubjects.split('\n')) {
      const s = raw.trim().toLowerCase();
      if (
        s.startsWith(`revert "${idLower}: `) ||
        s.startsWith(`revert "merge: ${idLower} (agb)"`)
      ) {
        return false;
      }
    }
  } catch {}
  return true;
}

function verifyTicketLandedOnBase(repo, baseRef, ticketId, { mergeSha = null, rescueOnly = false } = {}) {
  if (!ticketId || typeof ticketId !== 'string' || !TICKET_ID_RE.test(ticketId)) return false;
  const gitEnv = sanitizedGitEnv();

  if (!rescueOnly && mergeSha && isCommitAncestorAndUnreverted(repo, baseRef, mergeSha, ticketId, gitEnv)) {
    return true;
  }

  try {
    const logLines = execFileSync(
      'git',
      [
        '-c',
        `core.hooksPath=${NULL_HOOKS_PATH}`,
        'log',
        '--fixed-strings',
        `--grep=${ticketId}`,
        '-n',
        '50',
        '--format=%H %s',
        baseRef,
      ],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv }
    );
    const prefixLower = `${ticketId.toLowerCase()}: `;
    const mergeLower = `merge: ${ticketId.toLowerCase()} (agb)`;
    for (const raw of logLines.split('\n')) {
      const spaceIdx = raw.indexOf(' ');
      if (spaceIdx <= 0) continue;
      const sha = raw.slice(0, spaceIdx).trim();
      const subjLower = raw.slice(spaceIdx + 1).trim().toLowerCase();
      if (rescueOnly) {
        if (
          subjLower.startsWith(prefixLower) &&
          subjLower.endsWith('(rescue)') &&
          isCommitAncestorAndUnreverted(repo, baseRef, sha, ticketId, gitEnv)
        ) {
          return true;
        }
      } else if (
        (subjLower === mergeLower || subjLower.startsWith(prefixLower)) &&
        isCommitAncestorAndUnreverted(repo, baseRef, sha, ticketId, gitEnv)
      ) {
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Run a full plan. plan = { repo, base?, gate, caps?, tickets } where
 * tickets use the adlc schema (+ tier, pool_hint extensions).
 * Returns the final report; exit-code policy belongs to the caller.
 */
export async function runPlan(
  plan,
  { log: callerLog, project, hud: customHud, concurrency, resume = false, resetRescue = false } = {}
) {
  const hud = customHud ?? new TerminalHUD();
  const log = callerLog ?? ((msg) => {
    if (hud.isTTY && !hud.stopped) {
      hud.log(String(msg));
    } else {
      console.error(msg);
    }
  });
  const { repo, gate } = plan;
  const base = plan.base ?? 'main';
  const tickets = plan.tickets;
  const { cycle } = topoSort(tickets);
  if (cycle) throw new Error(`cycle in ticket DAG: ${cycle.join(', ')}`);

  const agyBin = process.env.AGB_AGY_BIN || resolveAgyBinary() || "agy";
  const agyCheck = await checkAgyBinary({ env: process.env });
  if (agyCheck.level === 'fail') {
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
  const normalized = new Map();
  for (const t of tickets) {
    if (!t || typeof t.id !== 'string' || !TICKET_ID_RE.test(t.id)) {
      throw new Error(`invalid ticket id '${t?.id}' — must match ${TICKET_ID_RE}`);
    }
    if (ticketIds.has(t.id)) throw new Error(`duplicate ticket id: ${t.id}`);
    const key = t.id.toLowerCase();
    const clash = normalized.get(key);
    if (clash !== undefined && clash !== t.id) {
      throw new Error(`ticket id '${t.id}' collides with '${clash}' — both resolve to worktree agb-${key} and branch agb/${key}`);
    }
    normalized.set(key, t.id);
    ticketIds.add(t.id);
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (!ticketIds.has(e?.to)) throw new Error(`${t.id}: edge to unknown ticket '${e?.to}'`);
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

  // Retired single-file ticket store: refuse before any mutation (fail closed).
  assertNoLegacyTicketStore(repo);

  // The main repo must be ON the base branch: merges advance the base by ref
  // update (rollbacks run in agb's worktrees), so a different checked-out
  // branch would leave the checkout out of step with the base being advanced.
  const onBranch = currentBranch(repo);
  if (onBranch !== base) {
    throw new Error(`repo ${repo} is on '${onBranch}', not the plan's base '${base}'. ` +
      `Checkout ${base} before running (agb advances ${base} by ref update; the checkout must match the base being advanced).`);
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

  // §4.2 enforcement gate + A.6 item 14 baseline, both before the repo is
  // touched: an untrustworthy rails engine or an unverifiable baseline stops
  // the run with nothing dispatched.
  const activeRails = unionActiveRails(repo);
  const railGate = enforcementGate({
    activeRails,
    planRails: tickets.some((t) => Array.isArray(t.rails) && t.rails.length > 0),
    adlc: resolvedAdlc,
    rails: [...tickets.flatMap((t) => t.rails ?? []), ...(activeRails.ok ? activeRails.rails : [])],
  });
  if (!railGate.ok) throw new Error(railGate.reason);
  const integrityBaseline = snapshotRunIntegrity({ cwd: repo });
  if (!integrityBaseline.ok) throw new Error(`enforcement gate: ${integrityBaseline.error}`);
  let runCompromised = null;

  if (isDirty(repo)) {
    if (process.env.AGB_ALLOW_DIRTY !== '1') {
      throw new Error(`repo ${repo} has uncommitted changes — commit or stash first ` +
        `(uncommitted changes are left untouched, but they are not part of the run's base: ` +
        `builders and gates see only the committed ${base} HEAD). ` +
        `Set AGB_ALLOW_DIRTY=1 to override.`);
    }
    log(`WARNING: repo ${repo} has uncommitted changes and AGB_ALLOW_DIRTY=1 is enabled. ` +
      `They are left untouched (merges and rollbacks run in agb's worktrees and ${base} advances by ref update), ` +
      `but they are not part of the run's base: builders and gates see only the committed ${base} HEAD.`);
  }

  let priorRunJson = null;
  let priorReportJson = null;
  const priorBoosterDir = join(repo, '.booster');
  try {
    const bSt = lstatSync(priorBoosterDir);
    if (bSt.isDirectory() && !bSt.isSymbolicLink()) {
      const runJsonPath = join(priorBoosterDir, 'run.json');
      try {
        const rjSt = lstatSync(runJsonPath);
        if (rjSt.isFile() && !rjSt.isSymbolicLink()) {
          priorRunJson = JSON.parse(readFileSync(runJsonPath, 'utf8'));
        }
      } catch {}
      const reportJsonPath = join(priorBoosterDir, 'report.json');
      try {
        const repSt = lstatSync(reportJsonPath);
        if (repSt.isFile() && !repSt.isSymbolicLink()) {
          priorReportJson = JSON.parse(readFileSync(reportJsonPath, 'utf8'));
        }
      } catch {}
    }
  } catch {}

  const agyVersion = agyCheck.version ?? null;
  const planHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        [...tickets]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((t) => ({
            id: t.id,
            scope: [...(t.scope ?? [])].sort(),
            edges: [...(t.edges ?? [])].map((e) => e.to).sort(),
          })),
      ),
    )
    .digest('hex');
  const agyBelowOrchestratorFloor = Boolean(agyVersion && semverParse(agyVersion) && semverLt(agyVersion, '1.5.9'));
  if (agyBelowOrchestratorFloor) {
    log(`[agb] notice: agy ${agyVersion} < 1.5.9; Orchestrator slugs auto-disabled`);
  }
  const disableOrchestrator =
    Boolean(plan.disableOrchestrator) ||
    agyBelowOrchestratorFloor;

  const pools = plan.pools ?? new PoolSet(plan.caps, { repo });
  const runId = `run-${Date.now().toString(36)}`;
  const finalProject = project ?? `agb-${runId}`;
  const safeRunId = runId.replace(/[\/\\]/g, '_');
  const logDir = join(repo, '.booster', 'logs', safeRunId);
  let status = null;
  let breakerDemotedModels = new Set();
  let activeDisabledModels = new Set();

  const merged = new Set();
  const mergedShas = new Set();
  const resumedMergeShas = new Map();
  const failed = new Map(); // id → reason
  const started = new Set();
  const running = [];
  const rawConcurrency = concurrency ?? plan.concurrencyCap ?? plan.concurrency;
  const concurrencyCap = Number.isInteger(rawConcurrency) && rawConcurrency > 0
    ? rawConcurrency
    : Infinity;
  let activeCount = 0;
  const activeChildren = new Set();
  let fleetAborted = false;
  let fleetAbortReason = null;
  let schedulerPaused = false;
  let pauseWaitResolve = null;
  const wakeDrainLoop = () => {
    if (pauseWaitResolve) {
      const r = pauseWaitResolve;
      pauseWaitResolve = null;
      r();
    }
  };
  const abortedByUser = new Set();
  const ticketChildren = new Map();
  const ticketWorktrees = new Map();
  const ticketGitDirs = new Map();
  const streamBuffers = new Map();
  let controlServer = null;

  const resolveCanonicalTicketId = (rawId) => {
    if (typeof rawId !== 'string' || !rawId) return null;
    if (ticketIds.has(rawId)) return rawId;
    return normalized.get(rawId.toLowerCase()) ?? null;
  };

  // Serialize orchestrator runs per repo — concurrent merges + reverts on
  // one checkout corrupt state. Released in the finally below.
  const releaseLock = acquireRepoLock(repo, { runId });
  try {
    // Startup crash reconciliation MUST execute before ensureGitignore() can
    // create a commit on the base branch, otherwise a .gitignore commit would
    // advance refs/heads/<base> past preMergeSha and trigger false
    // external_ref_divergence during journal recovery (#167).
    await reconcileIntegrationJournal(repo, base);

    for (const t of tickets) {
      if (hasProtectedRescueWorktree(repo, t.id)) {
        if (resetRescue === true) {
          clearRescueWorktreeLock(repo, t.id);
        } else {
          throw new Error(
            `Refusing to clobber active or preserved rescue worktree .worktrees/agb-${t.id.toLowerCase()}; complete 'agb rescue ${t.id}' or pass '--reset-rescue' first`
          );
        }
      }
    }

    ensureGitignore(repo);
    reapIntegrationWorktrees(repo);
    try { await reconcileLeases(repo); } catch {}

    if (resume === true) {
      const resumeCandidates = new Map(); // canonId -> mergeSha | null
      if (Array.isArray(priorReportJson?.merged)) {
        for (const mId of priorReportJson.merged) {
          const canon = resolveCanonicalTicketId(mId);
          if (canon && !resumeCandidates.has(canon)) resumeCandidates.set(canon, null);
        }
      }
      if (priorRunJson?.tickets && typeof priorRunJson.tickets === 'object') {
        for (const [k, v] of Object.entries(priorRunJson.tickets)) {
          if (v?.phase === 'merged') {
            const canon = resolveCanonicalTicketId(k);
            if (canon) resumeCandidates.set(canon, typeof v.mergeSha === 'string' ? v.mergeSha : null);
          }
        }
      }
      for (const [candId, recordedSha] of resumeCandidates.entries()) {
        const tObj = tickets.find((x) => x.id === candId);
        if (!tObj) continue;
        const priorEntry = priorRunJson?.tickets?.[candId];
        const ticketHashMatches =
          !priorEntry?.ticketHash || priorEntry.ticketHash === computeTicketResumeHash(tObj);
        if (!ticketHashMatches) continue;
        if (verifyTicketLandedOnBase(repo, base, candId, { mergeSha: recordedSha })) {
          merged.add(candId);
          started.add(candId);
          if (recordedSha) resumedMergeShas.set(candId, recordedSha);
        }
      }
      // Also recognize tickets landed via `agb rescue` when run.json had no prior entry
      for (const t of tickets) {
        if (merged.has(t.id)) continue;
        const priorEntry = priorRunJson?.tickets?.[t.id];
        if (priorEntry?.ticketHash && priorEntry.ticketHash !== computeTicketResumeHash(t)) continue;
        if (verifyTicketLandedOnBase(repo, base, t.id, { rescueOnly: true })) {
          merged.add(t.id);
          started.add(t.id);
        }
      }
    }

    const quotaInit = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || "agy");
    if (!quotaInit.ok) {
      throw new Error(`Cannot start run: quota telemetry unavailable from agy: ${quotaInit.error}`);
    }

    // Instantiate RunStatus only AFTER lock, rescue-lock check, and quota probe succeed
    // so a refused or failed pre-run check never wipes prior .booster/run.json or report.json!
    status = new RunStatus(repo, runId);
    breakerDemotedModels = status.initModelStats({ planHash, agyVersion }, priorRunJson);
    activeDisabledModels = new Set(breakerDemotedModels);
    const origStatusTicket = status.ticket.bind(status);
    status.ticket = (id, data) => {
      origStatusTicket(id, data);
      hud.updateTicket(id, data);
    };
    const origStatusPools = status.pools.bind(status);
    status.pools = (snapshot) => {
      origStatusPools(snapshot);
      hud.updatePools(snapshot);
    };

    for (const t of tickets) {
      if (merged.has(t.id)) continue;
      const wtPath = join(repo, '.worktrees', `agb-${t.id.toLowerCase()}`);
      if (existsSync(wtPath)) {
        try { removeWorktree(repo, wtPath, { force: true }); } catch {
          try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
        }
      }
    }
    pruneWorktrees(repo);
    for (const t of tickets) {
      if (merged.has(t.id)) continue;
      deleteBranch(repo, t.id);
    }

  const preds = Object.fromEntries(tickets.map((t) => [t.id, []]));
  for (const t of tickets) for (const e of t.edges ?? []) preds[e.to].push(t.id);

  // Merges serialize (integrator lane). A simple promise chain is the lock.
  let mergeLock = Promise.resolve();

  const activeAttemptNamespaces = new Set();
  const knownAttemptNamespaces = new Set();
  const attemptRefsToClean = new Set();
  let fleetCliFailures = 0;

  function checkOrchestratorBreaker(modelSlug, stats) {
    if (
      ORCHESTRATOR_MODELS.has(modelSlug) &&
      stats &&
      stats.resolvedTickets >= 4 &&
      stats.builderFaultTickets / stats.resolvedTickets >= 0.5 &&
      !breakerDemotedModels.has(modelSlug)
    ) {
      breakerDemotedModels.add(modelSlug);
      activeDisabledModels.add(modelSlug);
      status.updateModelStats(null, { disabledModels: breakerDemotedModels });
      log(
        `[agb] warning: demoting ${modelSlug} after ${stats.builderFaultTickets}/${stats.resolvedTickets} builder-fault tickets (>= 50%)`,
      );
    }
  }

  function pickAlternateModel(t, current, { crossPool = false } = {}) {
    return selectAlternateModel(tierCandidates(t.tier ?? 'mid', t.pool_hint), current, {
      crossPool,
      poolOfFn: poolOf,
      upstreamPoolOfFn: upstreamPoolOf,
      caps: pools.caps,
      familyCap: (fam) => pools.familyCap(fam),
    });
  }

  function compromiseRun(reason) {
    const message = `run compromised: ${reason}`;
    runCompromised ??= reason;
    abortFleet(message);
    return message;
  }

  function abortFleet(reason) {
    if (fleetAborted) return;
    fleetAborted = true;
    fleetAbortReason = reason;
    log(`✗ Fleet aborted: ${reason}`);

    for (const child of activeChildren) {
      terminateProcessTree(child, 'SIGKILL');
    }
    activeChildren.clear();

    for (const t of tickets) {
      if (!started.has(t.id)) {
        started.add(t.id);
        failed.set(t.id, `fleet aborted: ${reason}`);
        status.ticket(t.id, { phase: 'failed', detail: `fleet aborted: ${reason}`.slice(0, 200) });
      }
    }
    wakeDrainLoop();
  }

  for (const t of tickets) {
    if (merged.has(t.id)) {
      const prevSha = resumedMergeShas.get(t.id);
      status.ticket(t.id, {
        phase: 'merged',
        detail: 'resumed (already merged)',
        ...(prevSha ? { mergeSha: prevSha } : {}),
        ticketHash: computeTicketResumeHash(t),
      });
    } else {
      status.ticket(t.id, { phase: 'pending' });
    }
  }

  try {
    controlServer = await startControlServer(
      repo,
      {
        pause: () => {
          schedulerPaused = true;
          return { paused: true };
        },
        resume: () => {
          schedulerPaused = false;
          dispatch();
          wakeDrainLoop();
          return { paused: false };
        },
        status: () => ({
          paused: schedulerPaused,
          runId: status.runId,
          activeTickets: [...ticketWorktrees.keys()],
        }),
        abort: (req) => {
          const canonId = resolveCanonicalTicketId(req?.ticketId);
          if (!canonId || merged.has(canonId) || failed.has(canonId)) {
            return {
              ok: false,
              ticketId: req?.ticketId ?? '',
              aborted: false,
              error: 'ticket is not active',
            };
          }
          const tObj = tickets.find((x) => x.id === canonId);
          abortedByUser.add(canonId);
          const wt = ticketWorktrees.get(canonId);
          if (wt && existsSync(wt) && tObj) {
            try {
              saveRescueSnapshot(repo, tObj, wt, { runId: status.runId, baselineRoot: repo });
            } catch {}
          }
          const child = ticketChildren.get(canonId);
          if (child) {
            terminateProcessTree(child, 'SIGKILL');
          }
          if (!started.has(canonId)) {
            started.add(canonId);
            failed.set(canonId, 'aborted via control IPC');
            status.ticket(canonId, { phase: 'failed', detail: 'aborted via control IPC' });
            dispatch();
            wakeDrainLoop();
          }
          return { ticketId: canonId, aborted: true };
        },
        diff: (req) => {
          const rawId = typeof req?.ticketId === 'string' ? req.ticketId : '';
          const canonId = resolveCanonicalTicketId(rawId) ?? rawId;
          const wt = ticketWorktrees.get(canonId);
          const expectedGitDir = ticketGitDirs.get(canonId);
          const diff =
            wt && expectedGitDir && existsSync(wt)
              ? readLiveWorktreeDiff(wt, base, expectedGitDir)
              : readSavedRescueDiff(repo, canonId);
          return { ticketId: canonId, diff };
        },
        stream: (req) => {
          const rawId = typeof req?.ticketId === 'string' ? req.ticketId : '';
          const canonId = resolveCanonicalTicketId(rawId) ?? rawId;
          const maxLines = Number.isInteger(req?.lines) && req.lines > 0 ? req.lines : 40;
          return {
            ticketId: canonId,
            lines: (streamBuffers.get(canonId) ?? []).slice(-maxLines),
          };
        },
      },
      { runId: status.runId }
    );
  } catch (ctrlErr) {
    log(`[agb] warning: control IPC server unavailable: ${ctrlErr.message}`);
  }

  const isReady = (t) =>
    !started.has(t.id) &&
    preds[t.id].every((p) => merged.has(p)) &&
    preds[t.id].every((p) => !failed.has(p));

  async function acquireWithQuotaHandling(initialModel, { role, tier, poolHint, builderModel, repo: targetRepo, ticketId, canReroute = true, onReroute }) {
    let currentModel = initialModel;
    let acquired = false;

    try {
      while (true) {
        if (fleetAborted) throw new Error(`fleet aborted: ${fleetAbortReason}`);
        if (ticketId && abortedByUser.has(ticketId)) throw new Error('aborted via control IPC');
        try {
          const release = await pools.acquire(currentModel, { repo: targetRepo ?? repo, ticketId });
          acquired = true;
          return { model: currentModel, release };
        } catch (err) {
          if (err.kind === 'capacity_exhausted' || /capacity exhausted/i.test(err.message)) {
            if (fleetAborted) throw new Error(`fleet aborted: ${fleetAbortReason}`);
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
            if (fleetAborted) throw new Error(`fleet aborted: ${fleetAbortReason}`);
            const chunkMs = Math.min(1000, targetResume - Date.now());
            await new Promise((r) => setTimeout(r, chunkMs));
          }

          try {
            const q = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || "agy");
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

  async function runConfiguredGates(gatesObj, cwd, { sandbox = false } = {}) {
    const rawTimeout = Number(process.env.AGB_GATE_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 1_800_000;
    const materialized = cwd !== repo
      ? materializeWorktreeNodeModules(cwd, join(repo, 'node_modules'))
      : false;
    try {
      const results = [];
      for (const [name, cmd] of Object.entries(gatesObj ?? {})) {
        if (!cmd) continue;
        const r = await runGate(name, cmd, cwd, { timeoutMs, sandbox });
        results.push(r);
        if (!r.ok) return { ok: false, results };
      }
      return { ok: true, results };
    } finally {
      if (materialized) removeMaterializedNodeModules(cwd);
    }
  }

  async function buildOnce(t, worktree, model, prompt, strike, { ticketId, token, repo: targetRepo, baseRefSha, conversation, warmResume, onReroute } = {}) {
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
    const useWarmResume = Boolean(warmResume && warmResume.conversationId && activeModel === warmResume.model);
    const effectivePrompt = useWarmResume ? warmResume.prompt : prompt;
    const effectiveConversation = useWarmResume ? warmResume.conversationId : conversation;
    try {
      const res = await runAgy({
        model: activeModel, prompt: effectivePrompt, cwd: worktree, sandbox: true, timeout: BUILD_TIMEOUT,
        outputFormat: 'stream-json',
        logFile: join(logDir, `${safeId}.jsonl`),
        // Scoped to THIS spawn only (runAgy merges onto process.env, never
        // mutates it) — concurrent tickets building in the same booster
        // process must not see each other's active-ticket signal.
        env: enforcement.available ? { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: t.id } : undefined,
        project: finalProject,
        strike,
        role: 'builder',
        useRoleSettings: true,
        worker: { ticket: ticketId ?? t.id, buildCmd: gate?.build },
        repo: targetRepo ?? repo,
        ticketId: ticketId ?? t.id,
        token,
        conversation: effectiveConversation,
        onStep: (step) => {
          const tid = ticketId ?? t.id;
          let buf = streamBuffers.get(tid);
          if (!buf) {
            buf = [];
            streamBuffers.set(tid, buf);
          }
          buf.push(`[${formatStepClock(step.ts)}] ${step.toolName}: ${step.summary}`);
          if (buf.length > 40) {
            buf.splice(0, buf.length - 40);
          }
        },
        onSpawn: (child) => {
          const tid = ticketId ?? t.id;
          if (child) {
            activeChildren.add(child);
            ticketChildren.set(tid, child);
            child.once('exit', () => {
              activeChildren.delete(child);
              if (ticketChildren.get(tid) === child) ticketChildren.delete(tid);
            });
            if (fleetAborted || abortedByUser.has(tid)) {
              terminateProcessTree(child, 'SIGKILL');
            }
          }
          if (child?.pid) {
            Promise.resolve(release.registerWorkerPid?.(child.pid)).then((ok) => {
              if (ok === false) {
                terminateProcessTree(child, 'SIGKILL');
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

  async function prosecuteBranch(t, worktree, builderModel, baseRef = base) {
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
        ticket: t, diff: branchDiff(worktree, baseRef), model: activeProsecutor, cwd: scratch,
        logFile: join(logDir, `${safeId}.jsonl`),
        worktree,
        testCmd: gate?.test,
        base,
        project: finalProject,
        adlcBin: runAdlcBin,
        onSpawn: (child) => {
          if (child) {
            activeChildren.add(child);
            child.once('exit', () => activeChildren.delete(child));
            if (fleetAborted) {
              terminateProcessTree(child, 'SIGKILL');
            }
          }
          if (child?.pid) {
            Promise.resolve(release.registerWorkerPid?.(child.pid)).then((ok) => {
              if (ok === false) {
                terminateProcessTree(child, 'SIGKILL');
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
    if (fleetAborted) {
      failed.set(t.id, `fleet aborted: ${fleetAbortReason}`);
      status.ticket(t.id, { phase: 'failed', detail: `fleet aborted: ${fleetAbortReason}`.slice(0, 200) });
      return;
    }
    // route() can throw (no candidate for tier+pool_hint) — it must do so
    // INSIDE the try so the ticket lands in `failed` instead of vanishing
    // from the report while the run exits 0 (adversarial-review HIGH).
    let model;
    let worktree;
    let finalSnapshotCaptured = false;
    const captureTicketRescueSnapshot = () => {
      if (!worktree || !existsSync(worktree)) return;
      try {
        saveRescueSnapshot(repo, t, worktree, { runId: status.runId, baselineRoot: repo });
        finalSnapshotCaptured = true;
      } catch {}
    };
    const ticketModelsUsed = new Set();
    const ticketFaultModels = new Set();
    try {
      if (abortedByUser.has(t.id)) {
        throw new Error('aborted via control IPC');
      }
      model = pools.route(t.tier ?? 'mid', t.pool_hint);
      const q = await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || "agy");
      if (!q.ok) {
        throw new Error(`Quota telemetry check failed: ${q.error}`);
      }
      if (abortedByUser.has(t.id)) {
        throw new Error('aborted via control IPC');
      }
      worktree = createWorktree(repo, t.id, base, { allowResetRescue: Boolean(resetRescue) });
      ticketWorktrees.set(t.id, worktree);
      let strikes = 0;
      let attempts = 0;
      let prompt = builderPrompt(t);
      let lastFailure = '';
      let lastConversationId = null;
      let lastStrikeModel = null;
      let rateLimitRerouteStrike = -1;
      const safeId = t.id.replace(/[\/\\]/g, '_');
      const buildLogFile = join(logDir, `${safeId}.jsonl`);

      while (strikes < 2) {
        if (fleetAborted) {
          throw new Error(`fleet aborted: ${fleetAbortReason}`);
        }
        if (abortedByUser.has(t.id)) {
          strikes = 2;
          throw new Error('aborted via control IPC');
        }
        attempts += 1;
        const strikeNum = strikes + 1;
        const ownerToken = crypto.randomUUID();
        const attemptSlug = `attempts/${t.id}/${attempts}/${ownerToken.slice(0, 8)}`;
        const attemptRef = `refs/namespaces/${attemptSlug}/refs/heads/candidate`;
        activeAttemptNamespaces.add(attemptSlug);
        knownAttemptNamespaces.add(attemptSlug);
        attemptRefsToClean.add(attemptRef);
        let strikeError = null;
        let safeResetToBase = () => {
          try { resetToBase(worktree, base); } catch {}
        };
        let recordStrikeSession = () => {};

        try {
        // Pre-dispatch root Git snapshot
        const preSnapshot = snapshotRootGit(repo);

        // Setup isolated per-attempt Git database
        const { baseSha: baseRefSha, gitDir: expectedGitDir } = setupAttemptGitDatabase(repo, worktree, base);
        ticketGitDirs.set(t.id, expectedGitDir);
        let charterMd = builderAgentsMd(t, gate);
        const hasSymbolConstraintsForSlice =
          (Array.isArray(t.symbol_scope) && t.symbol_scope.length > 0) ||
          (Array.isArray(t.symbol_rails) && t.symbol_rails.length > 0);
        if (t.contextSlice === true || plan.contextSlice === true || hasSymbolConstraintsForSlice) {
          try {
            const prep = prepareTicketContextAndTdd(t, plan, {
              repo: worktree,
              builderModel: model,
              writeArtifact: false,
            });
            if (prep?.contextSlice?.ok && prep.contextSlice.files?.length > 0 && prep.contextSlice.markdown) {
              charterMd += `\n\n${prep.contextSlice.markdown}`;
            }
          } catch {}
        }
        safeWriteWorktreeFile(join(worktree, 'AGENTS.md'), charterMd);

        const restoreWorktreeBaseRef = () => {
          try {
            execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'update-ref', `refs/heads/${base}`, baseRefSha], { cwd: worktree, env: sanitizedGitEnv() });
          } catch {}
        };

        safeResetToBase = () => {
          if (!finalSnapshotCaptured && (strikes >= 2 || abortedByUser.has(t.id) || fleetAborted)) {
            captureTicketRescueSnapshot();
          }
          try {
            verifyWorktreeGitPointer(worktree, expectedGitDir);
          } catch {
            try { safeWriteWorktreeFile(join(worktree, '.git'), `gitdir: ${expectedGitDir}\n`); } catch {}
          }
          restoreWorktreeBaseRef();
          resetToBase(worktree, baseRefSha);
          try { safeWriteWorktreeFile(join(worktree, 'AGENTS.md'), charterMd); } catch {}
          if (enforcement.available) {
            try { writeAdlcTickets(worktree, [planTicketToRailTicket(t)]); } catch {}
          }
        };

        // Materialize this ticket into the plugin's expected shape so its
        // PreToolUse hook (ADLC_P4_ENFORCEMENT + ADLC_TICKET, set on the
        // builder's agy invocation below) can resolve the same rails this
        // scheduler enforces post-hoc.
        if (enforcement.available) {
          writeAdlcTickets(worktree, [planTicketToRailTicket(t)]);
        }
        if (strikes > 0) {
          const resolvedAdlc = runAdlcBin ? { ok: true, binary: runAdlcBin } : resolveAdlcBinary({ repo: worktree });
          const adlcBin = resolvedAdlc.ok ? resolvedAdlc.binary : undefined;
          const flail = await checkFlailDetector({ logFile: buildLogFile, scope: t.scope, cwd: worktree, adlcBin });
          if (flail.error) {
            console.warn(`[agb] advisory audit gate flail-detector degraded for ${t.id}: ${flail.error}`);
          }
          if (flail.detected) {
            lastFailure = `flail detected (adlc flail-detector): ` +
              flail.signals.map((s) => s.type).join(', ') +
              ` — not attempting another strike`;
            strikeError = lastFailure;
            strikes = 2;
            throw new Error(lastFailure);
          }
        }
        status.ticket(t.id, { phase: 'building', model, strikes: strikeNum, attempts });
        if (strikes > 0) {
          prompt = regenPrompt(t, lastFailure);
        }
        const warmResume = strikes > 0 && lastConversationId && process.env.AGB_WARM_STRIKES !== '0'
          ? { conversationId: lastConversationId, model: lastStrikeModel, prompt: warmRegenPrompt(t, lastFailure) }
          : undefined;
        const build = await buildOnce(t, worktree, model, prompt, strikeNum, {
          ticketId: t.id,
          token: ownerToken,
          repo,
          baseRefSha,
          warmResume,
          onReroute: (newModel) => {
            model = newModel;
          },
        });
        if (build.model && build.model !== model) {
          model = build.model;
        }
        recordStrikeSession = () => {
          lastConversationId = build.conversationId ?? null;
          lastStrikeModel = model;
        };

        strikeError = null;

        // Verify worktree .git pointer before ANY host-side Git operations:
        let gitPointerOk = false;
        try {
          verifyWorktreeGitPointer(worktree, expectedGitDir);
          gitPointerOk = true;
        } catch (err) {
          strikeError = `worktree gitdir tampering: ${err.message}`;
          try {
            safeWriteWorktreeFile(join(worktree, '.git'), `gitdir: ${expectedGitDir}\n`);
          } catch {}
        }

        if (gitPointerOk) {
          restoreWorktreeBaseRef();
        }

        const responseText = Array.isArray(build.events)
          ? [
              build.terminalResult?.response,
              ...build.events
                .filter((e) => e?.type === 'assistant' || e?.type === 'message' || e?.type === 'text')
                .map((e) => e.response ?? e.content ?? e.text ?? ''),
            ]
              .filter((s) => typeof s === 'string' && s.length > 0)
              .join('\n')
          : String(build.output ?? '');
        const isBlocked = /TICKET-BLOCKED/.test(responseText) ||
          build.events?.some((e) => e.action === 'blocked' || (e.type === 'step_update' && /blocked/i.test(String(e.action ?? ''))));

        // Post-reap host-mediated ref fetch (skipped when the worker emitted TICKET-BLOCKED so
        // partial worktree edits on a blocked attempt are never committed or ingested):
        let candidateSha = null;
        if (build.ok && !isBlocked && gitPointerOk) {
          commitAll(worktree, `${t.id}: ${t.title} (strike ${strikeNum})`);
          try {
            candidateSha = hostMediatedFetch(repo, worktree, attemptSlug, expectedGitDir);
          } catch (err) {
            strikeError = `host-mediated fetch failed: ${err.message}`;
          }
        }

        if (fleetAborted) {
          throw new Error(`fleet aborted: ${fleetAbortReason}`);
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
          abortFleet(strikeError);
          compromiseRun(strikeError);
          throw new Error(strikeError);
        }

        const integrity = verifyRunIntegrity(integrityBaseline.snapshot, { cwd: repo, worktree, worktreeHooksPath: NULL_HOOKS_PATH });
        if (!integrity.ok) {
          strikes = 2;
          strikeError = compromiseRun(integrity.reasons.join('; '));
          lastFailure = strikeError;
          status.strike(t.id, { model, error: strikeError, strikes });
          throw new Error(strikeError);
        }

        if (abortedByUser.has(t.id)) {
          strikes = 2;
          strikeError = 'aborted via control IPC';
          lastFailure = strikeError;
          status.strike(t.id, { model, error: strikeError, strikes });
          throw new Error(strikeError);
        }

        if (isBlocked) {
          ticketModelsUsed.add(model);
          ticketFaultModels.add(model);
          strikes += 1;
          const match = responseText.match(/TICKET-BLOCKED:?\s*(.*)/)?.[1];
          strikeError = `agent blocked: ${match || 'cannot proceed'}`;
          safeResetToBase();
        } else if (!build.ok) {
          if (['stream_overflow', 'stream_corruption', 'containment_unavailable'].includes(build.kind)) {
            ticketModelsUsed.add(model);
            ticketFaultModels.add(model);
            strikes = 2;
            strikeError = `non-recoverable violation (${build.kind}): ${build.error}`;
            lastFailure = strikeError;
            status.strike(t.id, { model, error: strikeError, strikes });
            throw new Error(strikeError);
          }

          if (build.kind === 'model_unavailable') {
            // Run-scoped demotion: the slug is gone for every ticket in this run
            // (never persisted across runs), and no strike is consumed.
            activeDisabledModels.add(model);
            lastConversationId = null;
            lastStrikeModel = null;
            const alt = pickAlternateModel(t, model);
            if (alt) {
              log(`${t.id}: model ${model} unavailable; demoting to ${alt} (no strike consumed)`);
              pools.unroute(model);
              pools.reserved[poolOf(alt)] += 1;
              model = alt;
              safeResetToBase();
              continue;
            }
            strikes += 1;
            strikeError = `model unavailable (${model}) and no alternate candidates remain: ${build.error}`;
            lastFailure = strikeError;
            status.strike(t.id, { model, error: strikeError, strikes });
            throw new Error(strikeError);
          }

          if (build.rateLimited === true) {
            status.updateModelStats(model, { rateLimited: true, disabledModels: breakerDemotedModels });
            try {
              await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || "agy");
            } catch {}
            if (strikes < 2 && rateLimitRerouteStrike !== strikes) {
              const alt = pickAlternateModel(t, model, { crossPool: true });
              if (alt) {
                rateLimitRerouteStrike = strikes;
                lastConversationId = null;
                lastStrikeModel = null;
                log(`${t.id}: ${model} rate limited; rerouting cross-pool to ${alt} (no strike consumed)`);
                pools.unroute(model);
                pools.reserved[poolOf(alt)] += 1;
                model = alt;
                safeResetToBase();
                continue;
              }
            }
          }

          // Reclassify post-dispatch failures through quota handling before strike accounting:
          if (pools) {
            try {
              await pools.refreshQuota(process.env.AGB_AGY_BIN || resolveAgyBinary() || "agy");
            } catch {}
            const currentPool = poolOf(model);
            const currentUpstream = upstreamPoolOf(model);
            const currentFamilyDepleted = (pools.caps[currentPool] ?? 0) <= 0 || pools.familyCap(currentUpstream) <= 0;
            if (
              currentFamilyDepleted ||
              pools.isCircuitBreakerTripped()
            ) {
              safeResetToBase();
              status.ticket(t.id, {
                phase: 'paused',
                reason: `quota depleted for ${model} post-dispatch; re-acquiring with quota handling`,
              });
              continue;
            }
          }

          if (!build.rateLimited) {
            ticketModelsUsed.add(model);
            ticketFaultModels.add(model);
          }
          if (build.kind === 'cli') {
            fleetCliFailures += 1;
            strikes += 1;
            strikeError = `agent CLI error: ${build.error}`;
            lastFailure = strikeError;
            status.strike(t.id, { model, error: strikeError, strikes });
            safeResetToBase();
            recordStrikeSession();
            if (fleetCliFailures >= 3) {
              lastFailure = `fleet CLI failure budget exceeded (3 failures)`;
              throw new Error(lastFailure);
            }
            continue;
          } else if (['signal', 'timeout', 'interrupted', 'spawn'].includes(build.kind)) {
            // Transport/lifecycle failures: cost a strike but never count
            // against the fleet CLI budget, and their (partial) session is not
            // worth warm-resuming.
            strikes += 1;
            strikeError = `agent ${build.kind}: ${build.error}`;
            recordStrikeSession = () => {};
            safeResetToBase();
          } else {
            strikes += 1;
            strikeError = `agent error: ${build.error}`;
            safeResetToBase();
          }
        } else if (strikeError) {
          ticketModelsUsed.add(model);
          ticketFaultModels.add(model);
          strikes += 1;
          safeResetToBase();
        } else {
          ticketModelsUsed.add(model);
          // Authoritative Scope & Anti-No-Op Verification
          const scopeCheck = verifyScopeAndAntiNoOp(repo, worktree, baseRefSha, t);
          if (!scopeCheck.ok) {
            ticketFaultModels.add(model);
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
            const hasSymbolConstraints =
              (Array.isArray(t.symbol_scope) && t.symbol_scope.length > 0) ||
              (Array.isArray(t.symbol_rails) && t.symbol_rails.length > 0);
            if (hasSymbolConstraints) {
              const symCheck = runSymbolScopeVerification(t, branchDiff(worktree, baseRefSha), { repo: worktree });
              if (!symCheck.ok) {
                ticketFaultModels.add(model);
                strikes += 1;
                strikeError = `symbol scope/rail violation: ${symCheck.violations.join('; ')}`;
                lastFailure = strikeError;
                status.strike(t.id, { model, error: strikeError, strikes });
                safeResetToBase();
                recordStrikeSession();
                prompt = regenPrompt(t, lastFailure);
                continue;
              }
            }
            const changed = scopeCheck.changedFiles;
            const activeRailsNow = loadActiveRails(repo);
            if (!activeRailsNow.ok) {
              strikes = 2;
              strikeError = compromiseRun(`ticket store unreadable (${activeRailsNow.error})`);
              lastFailure = strikeError;
              status.strike(t.id, { model, error: strikeError, strikes });
              throw new Error(strikeError);
            }
            // Restore committed AGENTS.md and .adlc/tickets (and remove .agb_home)
            // before running rails-guard and worktree gates so orchestrator-authored
            // projections cannot trip rails-guard or repo-hygiene/doc-truth tests.
            discardProjection(worktree, 'HEAD');
            const rails = [...new Set([...(t.rails ?? []), ...railGate.storeRails, ...(activeRailsNow.rails ?? [])])];
            const railCheck = rails.length ? await checkRailsGuard({ worktree, base, rails, adlcBin: runAdlcBin }) : { violations: [] };
            if (railCheck.operationalError) {
              strikes = 2;
              strikeError = compromiseRun(railCheck.violations.join(', '));
              lastFailure = strikeError;
              status.strike(t.id, { model, error: strikeError, strikes });
              throw new Error(strikeError);
            }
            if (railCheck.violations.length) {
              ticketFaultModels.add(model);
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
              ticketFaultModels.add(model);
              strikes += 1;
              strikeError = `gate script tampering: ${gateIntegrityError.message}`;
              lastFailure = strikeError;
              status.strike(t.id, { model, error: strikeError, strikes });
              safeResetToBase();
              recordStrikeSession();
              continue;
            }

            status.ticket(t.id, { phase: 'gating' });
            // Sandbox worktree gates: the script being run lives in the
            // (untrusted) worktree and could have been rewritten by the
            // builder. The post-merge gate below runs on trusted main.
            const gates = await runConfiguredGates(gate, worktree, { sandbox: true });
            cleanEmptyNodeModules(worktree);
            await recordGate({ repo, gateName: 'build', ticketId: t.id, data: { ok: gates.ok, strikes }, adlcBin: runAdlcBin });
            if (!gates.ok) {
              strikes += 1;
              const g = gates.results.at(-1);
              strikeError = `gate ${g.name} failed:\n${g.output}`;
              safeResetToBase();
            } else {
              // Loop-until-dry (ADLC F6): a single clean pass is a model
              // prior, not a coverage certificate.
              const dryNeeded = plan.prosecution?.dryPasses ?? 1;
              let dry = 0;
              let verdict;
              while (dry < dryNeeded) {
                status.ticket(t.id, { phase: 'prosecuting', detail: `dry ${dry}/${dryNeeded}` });
                verdict = await prosecuteBranch(t, worktree, model, baseRefSha);
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
                safeResetToBase();
              } else {
                strikes += 1;
                const blocking = blockingFindings(verdict.findings);
                strikeError = `prosecution block (findings):\n${JSON.stringify(blocking, null, 2)}`;
                status.ticket(t.id, { phase: 'fixing', detail: `${blocking.length} findings` });
                // Fan out candidates via consensus-fix before trusting one single-attempt regeneration.
                const cfRails = [...new Set([...(t.rails ?? []), ...(railGate?.storeRails ?? []), ...(activeRailsNow.rails ?? [])])];
                const cf = await runConsensusFix({ worktree, testCmd: gate?.test, railsCmd: gate?.build, files: changed, rails: cfRails, adlcBin: runAdlcBin });
                let cfFailureReason = null;
                if (cf.ok && cf.applied) {
                  let cfGitPointerOk = false;
                  try {
                    verifyWorktreeGitPointer(worktree, expectedGitDir);
                    cfGitPointerOk = true;
                  } catch (err) {
                    cfFailureReason = `consensus-fix worktree gitdir tampering: ${err.message}`;
                    try {
                      safeWriteWorktreeFile(join(worktree, '.git'), `gitdir: ${expectedGitDir}\n`);
                    } catch {}
                  }
                  if (cfGitPointerOk) {
                    restoreWorktreeBaseRef();
                    commitAll(worktree, `${t.id}: ${t.title} (consensus-fix)`);
                    const cfScope = verifyScopeAndAntiNoOp(repo, worktree, baseRefSha, t);
                    if (!cfScope.ok) {
                      safeResetToBase();
                      cfFailureReason = `consensus-fix candidate violated scope: ${cfScope.error}`;
                    } else {
                      const cfSymCheck = hasSymbolConstraints
                        ? runSymbolScopeVerification(t, branchDiff(worktree, baseRefSha), { repo: worktree })
                        : { ok: true, violations: [] };
                      if (!cfSymCheck.ok) {
                        safeResetToBase();
                        cfFailureReason = `consensus-fix candidate violated symbol constraints: ${cfSymCheck.violations.join('; ')}`;
                      } else {
                      const activeRailsRes = loadActiveRails(repo);
                      if (!activeRailsRes.ok) {
                        safeResetToBase();
                        strikes = 2;
                        strikeError = compromiseRun(`ticket store unreadable (${activeRailsRes.error})`);
                        lastFailure = strikeError;
                        status.strike(t.id, { model, error: strikeError, strikes });
                        throw new Error(strikeError);
                      } else {
                        const cfRailsList = [...new Set([...(t.rails ?? []), ...(railGate?.storeRails ?? []), ...(activeRailsRes.rails ?? [])])];
                        const cfRails = cfRailsList.length ? await checkRailsGuard({ worktree, base, rails: cfRailsList, adlcBin: runAdlcBin }) : { violations: [] };
                        if (cfRails.operationalError) {
                          strikes = 2;
                          strikeError = compromiseRun(cfRails.violations.join(', '));
                          lastFailure = strikeError;
                          status.strike(t.id, { model, error: strikeError, strikes });
                          throw new Error(strikeError);
                        } else if (cfRails.violations.length) {
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
                          const cfGates = await runConfiguredGates(gate, worktree, { sandbox: true });
                          cleanEmptyNodeModules(worktree);
                          await recordGate({ repo, gateName: 'build', ticketId: t.id, data: { ok: cfGates.ok, strikes, consensusFix: true }, adlcBin: runAdlcBin });
                          if (cfGates.ok) {
                            let cfDry = 0;
                            let cfVerdict;
                            while (cfDry < dryNeeded) {
                              status.ticket(t.id, { phase: 'prosecuting', detail: `consensus-fix dry ${cfDry}/${dryNeeded}` });
                              cfVerdict = await prosecuteBranch(t, worktree, model, baseRefSha);
                              if (cfVerdict.verdict !== 'ship') break;
                              cfDry += 1;
                            }
                            await recordGate({
                              repo, gateName: 'prosecution', ticketId: t.id,
                              data: { verdict: cfVerdict.verdict, findings: cfVerdict.findings?.length ?? 0, dryPasses: cfDry, consensusFix: true },
                              adlcBin: runAdlcBin,
                            });
                            if (cfDry >= dryNeeded) {
                              status.strike(t.id, { model, error: null, strikes });
                              await integrate(t, worktree);
                              return;
                            }
                            safeResetToBase();
                            cfFailureReason = 'consensus-fix applied a candidate but it still failed prosecution';
                          } else {
                            safeResetToBase();
                            cfFailureReason = 'consensus-fix applied a candidate but it still failed gates';
                          }
                        }
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
                safeResetToBase();
                recordStrikeSession();
                prompt = regenPrompt(t, lastFailure);
                continue; // fix round consumes a strike
              }
            }
          }
        }
        }
        } finally {
          activeAttemptNamespaces.delete(attemptSlug);
        }

        lastFailure = strikeError;
        status.strike(t.id, { model, error: strikeError, strikes });
        safeResetToBase();
        recordStrikeSession();

        // Regeneration: fresh prompt with known dead-ends appended
        prompt = regenPrompt(t, lastFailure);
      }
      throw new Error(lastFailure ?? 'two strikes exhausted');
    } catch (err) {
      const ownReason = /^(root integrity violation|run compromised):/.test(String(err.message ?? ''));
      const reason = fleetAborted && !ownReason
        ? `fleet aborted: ${fleetAbortReason}`
        : abortedByUser.has(t.id) && !ownReason
        ? 'aborted via control IPC'
        : String(err.message ?? err);
      failed.set(t.id, reason);
      status.ticket(t.id, { phase: 'failed', detail: reason.slice(0, 200) });
      log(`✗ ${t.id}: ${reason}`);
    } finally {
      ticketChildren.delete(t.id);
      for (const m of ticketModelsUsed) {
        const isMergedModel = merged.has(t.id) && m === model;
        const isFault = !isMergedModel && ticketFaultModels.has(m);
        const st = status.updateModelStats(m, {
          resolved: true,
          builderFault: isFault,
          merged: isMergedModel,
          disabledModels: breakerDemotedModels,
        });
        checkOrchestratorBreaker(m, st);
      }
      if (model) pools.unroute(model); // release the builder pool assignment for this ticket
      if (worktree && !merged.has(t.id)) {
        if (!finalSnapshotCaptured) {
          captureTicketRescueSnapshot();
        }
        ticketWorktrees.delete(t.id);
        ticketGitDirs.delete(t.id);
        try { removeWorktree(repo, worktree, { force: true }); } catch {
          try { rmSync(worktree, { recursive: true, force: true }); } catch {}
        }
        const gitDir = join(repo, '.worktrees', '.attempt_git', basename(worktree));
        try { rmSync(gitDir, { recursive: true, force: true }); } catch {}
      } else {
        ticketWorktrees.delete(t.id);
        ticketGitDirs.delete(t.id);
      }
      if (plan.overviewPane === true) {
        try {
          syncOverviewPaneState(
            {
              runId: status.runId,
              base,
              tickets: status.snapshot()?.tickets ?? {},
              pools: pools.snapshot(),
            },
            { repo }
          );
        } catch {}
      }
      activeCount = Math.max(0, activeCount - 1);
      dispatch();
    }
  }

  async function integrate(t, worktree) {
    status.ticket(t.id, { phase: 'merging' });
    // Chain on the lock but never store a rejected promise as the lock
    const turn = mergeLock.then(async () => {
      const gitEnv = sanitizedGitEnv();
      // A.6 item 14: re-verify at merge time, under the lock — gates,
      // prosecutors and concurrent builders all run after the post-build check.
      const atMerge = verifyRunIntegrity(integrityBaseline.snapshot, { cwd: repo, worktree, worktreeHooksPath: NULL_HOOKS_PATH });
      if (!atMerge.ok) throw new Error(compromiseRun(atMerge.reasons.join('; ')));
      if (fleetAborted) {
        throw new Error(`fleet aborted: ${fleetAbortReason}`);
      }
      if (abortedByUser.has(t.id)) {
        throw new Error('aborted via control IPC');
      }
      releaseLock.assertStillHeld();
      const onBranch = currentBranch(repo);
      if (onBranch !== base) {
        throw new Error(`repo left base branch mid-run (now on '${onBranch}', expected '${base}') — skipping ${t.id} to avoid merging/resetting the wrong branch`);
      }
      if (process.env.AGB_ALLOW_DIRTY !== '1' && isDirty(repo)) {
        throw new Error(`repo became dirty mid-run — skipping ${t.id} — uncommitted changes are left untouched, but advancing ${base} by ref update under an edited checkout would leave those edits against a moved HEAD; commit or stash them (or set AGB_ALLOW_DIRTY=1)`);
      }
      const headBefore = currentHead(repo);

      // Rebase worktree candidate onto current base and fetch into repo before merge
      discardProjection(worktree);
      execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'update-ref', `refs/heads/${base}`, headBefore], { cwd: worktree, env: gitEnv });
      try {
        execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'rebase', base], { cwd: worktree, env: gitEnv });
      } catch (err) {
        try { execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'rebase', '--abort'], { cwd: worktree, env: gitEnv }); } catch {}
        try {
          const candSha = execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8', env: gitEnv }).trim();
          if (candSha) {
            execFileSync('git', ['update-ref', `refs/quarantine/agb-${t.id.toLowerCase()}-failed-conflict`, candSha], { cwd: repo, env: gitEnv });
          }
        } catch {}
        const conflictErr = new Error(`rebase conflict for ${t.id}: ${String(err.stderr ?? err.message).slice(-300)}`);
        conflictErr.kind = 'merge_conflict';
        throw conflictErr;
      }
      const tempRef = `refs/namespaces/attempts/${t.id.toLowerCase()}/rebased`;
      attemptRefsToClean.add(tempRef);
      execFileSync(
        'git',
        [
          '-c',
          `core.hooksPath=${NULL_HOOKS_PATH}`,
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          pathToFileURL(join(worktree, '.git')).href,
          `HEAD:${tempRef}`,
        ],
        { cwd: repo, env: gitEnv }
      );
      const rebasedSha = execFileSync('git', ['rev-parse', tempRef], { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();

      // Authoritative anti-no-op baseline diff check
      if (rebasedSha === headBefore) {
        const emptyErr = new Error(`anti-no-op gate failed: zero changes against baseline commit ${headBefore}`);
        emptyErr.kind = 'empty_diff';
        throw emptyErr;
      }
      const diffTree = execFileSync('git', ['diff-tree', '-r', '--name-status', '-M', '-C', '-z', headBefore, rebasedSha], { cwd: repo, env: gitEnv }).toString('utf8');
      if (!diffTree.trim()) {
        const emptyErr = new Error(`anti-no-op gate failed: zero changes against baseline commit ${headBefore}`);
        emptyErr.kind = 'empty_diff';
        throw emptyErr;
      }

      // Check whether root working tree can be advisory synced (clean, on base, at headBefore)
      const canAdvisorySync = (
        currentBranch(repo) === base &&
        execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z'], { cwd: repo, env: gitEnv }).length === 0 &&
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: gitEnv }).trim() === headBefore
      );

      const transactionToken = crypto.randomUUID();
      const agbRef = `refs/heads/agb/${t.id.toLowerCase()}`;
      const markerRef = `refs/transactions/${t.id}/${transactionToken}`;
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
        execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'reset', '--hard', rebasedSha], { cwd: integrationPath, env: gitEnv });

        // Phase 1: PREPARED
        writeIntegrationJournal(repo, journalData);
        journalWritten = true;

        // Post-merge gates inside disposable worktree under Trusted Baseline Test Oracle Protocol
        let hasBaselineTests = false;
        try {
          execFileSync('git', ['cat-file', '-e', `${headBefore}:test`], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv });
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
          execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'checkout', headBefore, '--', 'test'], { cwd: integrationPath, env: gitEnv });
          const pass1 = await runConfiguredGates({ test: gate.test }, integrationPath, { sandbox: true });
          if (!pass1.ok) {
            const g = pass1.results.at(-1);
            const pass1Err = new Error(`Pass 1 (baseline regression) failed: gate ${g?.name ?? 'test'} failed:\n${g?.output?.slice(0, 300)}`);
            pass1Err.kind = 'post_merge_gate_failure';
            throw pass1Err;
          }
          execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'reset', '--hard', rebasedSha], { cwd: integrationPath, env: gitEnv });
        }

        // Pass 2: Candidate Gates
        const post = await runConfiguredGates(gate, integrationPath, { sandbox: true });
        await recordGate({ repo, gateName: 'post-merge-build', ticketId: t.id, data: { ok: post.ok }, adlcBin: runAdlcBin });
        if (!post.ok) {
          const g = post.results.at(-1);
          const postErr = new Error(`post-merge gate ${g?.name} failed:\n${g?.output?.slice(0, 300)}`);
          postErr.kind = 'post_merge_gate_failure';
          throw postErr;
        }

        // Pass 2 hollow-test mutation verification if test/** files were modified
        const diffFiles = execFileSync('git', ['diff-tree', '-r', '--name-only', '-z', headBefore, rebasedSha], { cwd: repo, env: gitEnv }).toString('utf8').split('\0').filter(Boolean);
        const modifiedTests = diffFiles.filter((p) => p.startsWith('test/'));
        if (modifiedTests.length > 0 && gate?.test) {
          const hollowSandboxDir = process.env.AGB_SANDBOX_GATES !== '0'
            ? mkdtempSync(join(tmpdir(), 'agb-ht-sbx-'))
            : null;
          try {
            let hollowTestCmd = gate.test;
            if (process.env.AGB_SANDBOX_GATES !== '0') {
              const wrapped = wrapConsensusGateCommand(gate.test, integrationPath, { sandboxTmpDir: hollowSandboxDir });
              if (!wrapped.ok) {
                const sandboxErr = new Error(
                  `hollow-test mutation verification failed: gate sandbox unavailable (${wrapped.error ?? 'OS sandbox required unless AGB_SANDBOX_GATES=0'})`
                );
                sandboxErr.kind = 'post_merge_gate_failure';
                throw sandboxErr;
              }
              hollowTestCmd = wrapped.cmd;
            }
            await execFileAuthenticatedAdlc(
              runAdlcBin,
              ['hollow-test', '--test-cmd', hollowTestCmd, '--base', headBefore],
              { cwd: integrationPath, maxBuffer: 10 * 1024 * 1024 },
              { repo }
            );
          } catch (err) {
            if (err.kind === 'post_merge_gate_failure') throw err;
            const isAuth = err.code === 'EAUTH' || /Authenticated ADLC binary verification failed/i.test(err.message);
            const hollowErr = new Error(
              isAuth
                ? `hollow-test mutation verification failed: authenticated adlc binary is unavailable or failed revalidation to verify modified tests (${modifiedTests.join(', ')}): ${err.message}`
                : `hollow-test mutation verification failed: ${String(err.stderr ?? err.stdout ?? err.message).slice(0, 300)}`
            );
            hollowErr.kind = 'post_merge_gate_failure';
            throw hollowErr;
          } finally {
            if (hollowSandboxDir) {
              try { rmSync(hollowSandboxDir, { recursive: true, force: true }); } catch {}
            }
          }
        }

        // Phase 2: GATES_PASSED
        journalData.phase = JOURNAL_PHASES.GATES_PASSED;
        journalData.timestamp = Date.now();
        writeIntegrationJournal(repo, journalData);

        // Durable Transaction Marker:
        execFileSync('git', ['update-ref', markerRef, rebasedSha], { cwd: repo, env: gitEnv });

        // Atomic CAS advance on refs/heads/${base}:
        execFileSync('git', ['update-ref', `refs/heads/${base}`, rebasedSha, headBefore], { cwd: repo, env: gitEnv });
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
        try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
        try { execFileSync('git', ['update-ref', '-d', tempRef], { cwd: repo, env: gitEnv }); } catch {}
        try { removeWorktree(repo, integrationPath, { force: true }); } catch {
          try { rmSync(integrationPath, { recursive: true, force: true }); } catch {}
        }
        integrationPath = null;
        unlinkIntegrationJournal(repo);
      } catch (err) {
        if (!baseRefAdvanced) {
          await recordGate({ repo, gateName: 'rollback', ticketId: t.id, data: { reason: String(err.message ?? err).slice(0, 300) }, adlcBin: runAdlcBin });
          try {
            execFileSync('git', ['update-ref', `refs/quarantine/agb-${t.id.toLowerCase()}-failed-post-merge`, rebasedSha], { cwd: repo, env: gitEnv });
          } catch {}
          try { execFileSync('git', ['update-ref', '-d', markerRef], { cwd: repo, env: gitEnv }); } catch {}
          try { execFileSync('git', ['update-ref', '-d', tempRef], { cwd: repo, env: gitEnv }); } catch {}
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
          log(`⚠ Error during integration finalization after base ref advance: ${err.message}`);
          if (integrationPath) {
            try { removeWorktree(repo, integrationPath, { force: true }); } catch {
              try { rmSync(integrationPath, { recursive: true, force: true }); } catch {}
            }
            integrationPath = null;
          }
          const finalizationErr = new Error(`Integration finalization failed after base ref advance for ticket ${t.id}: ${err.message}`);
          finalizationErr.cause = err;
          finalizationErr.baseRefAdvanced = true;
          finalizationErr.kind = 'integration_finalization_failure';
          throw finalizationErr;
        }
      }

      merged.add(t.id);
      mergedShas.add(rebasedSha);
      ticketWorktrees.delete(t.id);
      ticketGitDirs.delete(t.id);
      try {
        execFileSync('git', ['update-ref', `refs/heads/agb/${t.id.toLowerCase()}`, rebasedSha], { cwd: repo, env: gitEnv });
      } catch {}
      try { removeWorktree(repo, worktree, { force: true }); } catch {
        try { rmSync(worktree, { recursive: true, force: true }); } catch {}
      }
      const gitDir = join(repo, '.worktrees', '.attempt_git', path.basename(worktree));
      try { rmSync(gitDir, { recursive: true, force: true }); } catch {}
      status.ticket(t.id, {
        phase: 'merged',
        mergeSha: rebasedSha,
        ticketHash: computeTicketResumeHash(t),
      });
      log(`✓ ${t.id} merged`);

      // Decoupled Non-Transactional Root Working Tree Advisory Sync
      try {
        let isCleanNow = false;
        try {
          if (canAdvisorySync && currentBranch(repo) === base) {
            execFileSync('git', ['diff-files', '--quiet'], { cwd: repo, stdio: 'ignore', env: gitEnv });
            execFileSync('git', ['diff-index', '--cached', '--quiet', headBefore], { cwd: repo, stdio: 'ignore', env: gitEnv });
            isCleanNow = true;
          }
        } catch {
          isCleanNow = false;
        }

        if (isCleanNow) {
          execFileSync('git', ['read-tree', '-u', '-m', headBefore, rebasedSha], { cwd: repo, env: gitEnv });
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
    if (fleetAborted) return;
    // Tickets whose predecessors failed can never run — fail them through first
    // across all transitive edges regardless of plan.tickets array order.
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (const t of tickets) {
        if (!started.has(t.id) && preds[t.id].some((p) => failed.has(p))) {
          started.add(t.id);
          failed.set(t.id, `blocked by failed predecessor`);
          status.ticket(t.id, { phase: 'blocked' });
          progressed = true;
        }
      }
    }
    if (!schedulerPaused) {
      for (const t of tickets) {
        if (activeCount >= concurrencyCap) break;
        if (isReady(t)) {
          activeCount += 1;
          running.push(runTicket(t));
        }
      }
    }
    // Tickets whose predecessors failed can never run — fail them through.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tickets) {
        if (!started.has(t.id) && preds[t.id].some((p) => failed.has(p))) {
          started.add(t.id);
          failed.set(t.id, `blocked by failed predecessor`);
          status.ticket(t.id, { phase: 'blocked' });
          changed = true;
        }
      }
    }
    if (!tickets.some((t) => !started.has(t.id))) {
      wakeDrainLoop();
    }
  }

    await runWithOrchestratorRoutingState(
      { disableOrchestrator, disabledModels: activeDisabledModels },
      async () => {
        dispatch();
        // Drain: new work is appended to `running` by dispatch() inside finally.
        let settled = 0;
        while (true) {
          if (settled < running.length) {
            const batch = running.slice(settled);
            settled += batch.length;
            await Promise.allSettled(batch);
            continue;
          }
          if (
            schedulerPaused &&
            !fleetAborted &&
            tickets.some((t) => !started.has(t.id))
          ) {
            await new Promise((res) => {
              pauseWaitResolve = res;
            });
            dispatch();
            continue;
          }
          break;
        }
      },
    );
    try { pruneWorktrees(repo); } catch {}
    for (const t of tickets) {
      if (!merged.has(t.id)) deleteBranch(repo, t.id);
    }
    for (const ref of attemptRefsToClean) {
      try {
        execFileSync('git', ['update-ref', '-d', ref], { cwd: repo, env: sanitizedGitEnv() });
      } catch {}
    }
  } finally {
    wakeDrainLoop();
    hud.stop();
    for (const child of activeChildren) {
      terminateProcessTree(child, 'SIGKILL');
    }
    activeChildren.clear();
    try {
      await controlServer?.close();
    } catch {}
    releaseLock();
  }

  // L2: a tamper during a failed attempt that no later check observed must
  // still be reported (no merge could have followed it: integrate re-checks).
  if (!runCompromised) {
    const final = verifyRunIntegrity(integrityBaseline.snapshot, { cwd: repo });
    if (!final.ok) {
      runCompromised = final.reasons.join('; ');
      log(`✗ run compromised: ${runCompromised}`);
    }
  }

  const report = {
    runId,
    merged: [...merged],
    failed: Object.fromEntries(failed),
    requests: pools.snapshot().requests,
    enforcementAvailable: enforcement.available,
    enforcementReason: enforcement.reason,
    compromised: runCompromised,
  };
  status.report(report);
  return report;
}

/**
 * Pure alternate-model selection helper for retry/escalation.
 * When `crossPool` is true, prefers a candidate from a different upstream
 * quota family (`upstreamPoolOfFn(m) !== upstreamPoolOfFn(current)`) and only
 * falls back to a different local pool (`poolOfFn(m) !== poolOfFn(current)`)
 * if no cross-family candidate is available.
 */
export function selectAlternateModel(candidates, current, {
  crossPool = false,
  poolOfFn = poolOf,
  upstreamPoolOfFn = upstreamPoolOf,
  caps = {},
  familyCap = () => 1,
} = {}) {
  const eligible = candidates.filter((m) =>
    m !== current &&
    (caps[poolOfFn(m)] ?? 0) > 0 &&
    familyCap(upstreamPoolOfFn(m)) > 0);
  if (!crossPool) return eligible[0];
  return (
    eligible.find((m) => upstreamPoolOfFn(m) !== upstreamPoolOfFn(current)) ??
    eligible.find((m) => poolOfFn(m) !== poolOfFn(current))
  );
}

function currentHead(repo) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: sanitizedGitEnv() }).trim();
}
