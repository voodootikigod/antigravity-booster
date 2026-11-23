// Surgical interactive rescue (`agb rescue`) & pure-FS zero-git-object snapshots.
// Two-phase repo lock protocol: short setup lock -> unlocked interactive agy -i ->
// short verify/merge lock running the full P3/P5 oracle in a disposable integration worktree.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { globMatch } from '@adlc/core/tickets';
import { Minimatch } from 'minimatch';
import { loadActiveRails, resolveTicket } from './active-rails.mjs';
import { resolveAdlcBinary } from './adlc-bridge.mjs';
import { runGates } from './gates.mjs';
import { acquireRepoLock } from './lock.mjs';
import { PROSECUTOR_CANDIDATES, tierCandidates } from './models.mjs';
import { TICKET_ID_RE, verifyGateScriptIntegrity } from './plan-integrity.mjs';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { isProcessAlive, PoolSet } from './pools.mjs';
import { blockingFindings, prosecute, runHollowTest } from './prosecute.mjs';
import { sanitizedGitEnv } from './run-integrity.mjs';
import {
  checkRailsGuard,
  recordGate,
  runSymbolScopeVerification,
  verifyScopeAndAntiNoOp,
} from './scheduler-verify.mjs';
import { sanitizeRunId } from './status.mjs';
import {
  branchDiff,
  cleanEmptyNodeModules,
  clearRescueWorktreeLock,
  commitAll,
  createIntegrationWorktree,
  createWorktree,
  currentBranch,
  deleteBranch,
  discardProjection,
  hasProtectedRescueWorktree,
  JOURNAL_PHASES,
  materializeWorktreeNodeModules,
  readIntegrationJournal,
  removeMaterializedNodeModules,
  removeWorktree,
  unlinkIntegrationJournal,
  writeIntegrationJournal,
  writeRescueWorktreeLock,
} from './worktrees.mjs';

export { writeRescueWorktreeLock, hasProtectedRescueWorktree, clearRescueWorktreeLock } from './worktrees.mjs';

export const FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES = Object.freeze([
  'AGENTS.md',
  'GEMINI.md',
  'CLAUDE.md',
  '.agents',
  '.agent',
  '_agents',
  '_agent',
  '.gemini',
  '.claude',
  '.cursor',
  '.vscode',
  '.git',
  '.adlc',
  '.agb_home',
  'node_modules',
  '.worktrees',
  '.booster',
]);

const FORBIDDEN_SEGMENT_SET = new Set(
  FORBIDDEN_RESCUE_CUSTOMIZATION_PREFIXES.map((entry) => entry.toLowerCase())
);

const MAX_RESCUE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESCUE_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_DIFF_PREVIEW_BYTES = 64 * 1024;
const GLOB_CHAR_RE = /[*?[\]{}!]/;
const NULL_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

const MATCHER_CACHE = new Map();
function getMatcher(pattern, nocase) {
  const key = `${nocase ? 'i' : 's'}:${pattern}`;
  let m = MATCHER_CACHE.get(key);
  if (!m) {
    m = new Minimatch(pattern, { dot: true, nocase });
    MATCHER_CACHE.set(key, m);
  }
  return m;
}

function foldPath(value, plat = process.platform) {
  return plat === 'darwin' || plat === 'win32' ? value.toLowerCase() : value;
}

function pathCovers(rel, prefix, plat = process.platform) {
  const trimmed = prefix.replace(/\/+$/, '');
  if (!trimmed) return false;
  const fRel = foldPath(rel, plat);
  const fPrefix = foldPath(trimmed, plat);
  return fRel === fPrefix || fRel.startsWith(`${fPrefix}/`);
}

function matchesScope(rel, scope, plat = process.platform) {
  if (!Array.isArray(scope) || scope.length === 0) return true;
  const nocase = plat === 'darwin' || plat === 'win32';
  return scope.some((entry) => {
    if (typeof entry !== 'string' || !entry.length) return false;
    const norm = entry.endsWith('/') && entry !== '/' ? `${entry}**` : entry;
    return (
      globMatch(norm, rel) ||
      getMatcher(norm, nocase).match(rel) ||
      pathCovers(rel, entry, plat)
    );
  });
}

function matchDeclaredRail(rel, rails, plat = process.platform) {
  if (!Array.isArray(rails) || rails.length === 0) return null;
  const nocase = plat === 'darwin' || plat === 'win32';
  for (const rail of rails) {
    if (typeof rail !== 'string' || !rail.length) continue;
    const norm = rail.endsWith('/') && rail !== '/' ? `${rail}**` : rail;
    if (
      globMatch(norm, rel) ||
      getMatcher(norm, nocase).match(rel) ||
      pathCovers(rel, rail, plat)
    ) {
      return rail;
    }
  }
  return null;
}

export function isForbiddenRescuePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || !relPath.trim()) {
    return true;
  }
  if (
    relPath.includes('\0') ||
    relPath.startsWith('/') ||
    relPath.startsWith('\\') ||
    /^[a-zA-Z]:/.test(relPath) ||
    isAbsolute(relPath)
  ) {
    return true;
  }
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return true;
    if (FORBIDDEN_SEGMENT_SET.has(seg.toLowerCase())) return true;
  }
  return false;
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function resolveCanonical(p) {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function ensureSafeBoosterSubdir(repo, subSegments) {
  const rawRepo = resolve(repo);
  const rawBooster = join(rawRepo, '.booster');
  const rawSt = lstatOrNull(rawBooster);
  if (rawSt?.isSymbolicLink()) {
    throw new Error(`Security violation: symbolic link in .booster path: ${rawBooster}`);
  }

  const canonicalRepo = resolveCanonical(repo);
  let cur = canonicalRepo;
  for (const seg of ['.booster', ...subSegments]) {
    cur = join(cur, seg);
    const st = lstatOrNull(cur);
    if (st) {
      if (st.isSymbolicLink()) {
        throw new Error(`Security violation: symbolic link in .booster path: ${cur}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`Security violation: expected directory in .booster path: ${cur}`);
      }
    } else {
      mkdirSync(cur, { recursive: true, mode: 0o700 });
    }
    const postSt = lstatSync(cur);
    if (postSt.isSymbolicLink() || !postSt.isDirectory()) {
      throw new Error(`Security violation: invalid directory in .booster path: ${cur}`);
    }
    const realCur = realpathSync(cur);
    const rel = relative(canonicalRepo, realCur);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Security violation: .booster subdirectory escapes repository root: ${cur}`);
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(cur, 0o700);
      } catch {}
    }
  }
  return cur;
}

function writeOwnerOnlyJsonAtomic(filePath, dataObj) {
  const st = lstatOrNull(filePath);
  if (st?.isSymbolicLink()) {
    throw new Error(`Security violation: refusing to overwrite symbolic link: ${filePath}`);
  }
  const content = JSON.stringify(dataObj, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmpPath, content, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      try {
        chmodSync(tmpPath, 0o600);
      } catch {}
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

function truncateUtf8Bytes(str, maxBytes) {
  const input = String(str ?? '');
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  const buf = Buffer.from(input, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

function isProbablyBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function buildPureFsDiffSummary(changedRecords, deletedPaths, truncated) {
  const chunks = [];
  let usedBytes = 0;

  const appendLine = (line) => {
    const withNl = `${line}\n`;
    const b = Buffer.byteLength(withNl, 'utf8');
    if (usedBytes + b > MAX_DIFF_PREVIEW_BYTES - 64) return false;
    chunks.push(withNl);
    usedBytes += b;
    return true;
  };

  for (const rec of changedRecords) {
    if (!appendLine(`diff --agb a/${rec.path} b/${rec.path}`)) break;
    if (rec.kind === 'A') {
      if (!appendLine('--- /dev/null')) break;
      if (!appendLine(`+++ b/${rec.path}`)) break;
    } else {
      if (!appendLine(`--- a/${rec.path}`)) break;
      if (!appendLine(`+++ b/${rec.path}`)) break;
    }
    if (!rec.newBuf || isProbablyBinary(rec.newBuf) || (rec.oldBuf && isProbablyBinary(rec.oldBuf))) {
      if (!appendLine(`Binary or skipped file (${rec.kind}) mode ${rec.mode.toString(8)}`)) break;
      continue;
    }
    if (rec.oldBuf) {
      const oldLines = rec.oldBuf.toString('utf8').split('\n');
      for (const l of oldLines.slice(0, 80)) {
        if (!appendLine(`-${l}`)) break;
      }
    }
    const newLines = rec.newBuf.toString('utf8').split('\n');
    for (const l of newLines.slice(0, 120)) {
      if (!appendLine(`+${l}`)) break;
    }
  }

  for (const delPath of deletedPaths) {
    if (!appendLine(`diff --agb a/${delPath} /dev/null`)) break;
    if (!appendLine(`--- a/${delPath}`)) break;
    if (!appendLine('+++ /dev/null')) break;
  }

  if (truncated) {
    appendLine('# [truncated: one or more files exceeded snapshot size limits]');
  }

  return truncateUtf8Bytes(chunks.join(''), MAX_DIFF_PREVIEW_BYTES);
}

function computeScopeStaticRoots(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return [''];
  const prefixes = new Set();
  for (const raw of scope) {
    if (typeof raw !== 'string' || !raw.length) continue;
    const parts = raw.replace(/\/+$/, '').split('/');
    const kept = [];
    for (const seg of parts) {
      if (GLOB_CHAR_RE.test(seg)) break;
      kept.push(seg);
    }
    if (kept.length === 0) return [''];
    prefixes.add(kept.join('/'));
  }
  return prefixes.size > 0 ? [...prefixes].sort() : [''];
}

export function saveRescueSnapshot(
  repo,
  ticketOrId,
  worktreePath,
  { runId = 'manual', baselineRoot = repo, diffPreview = '', scope, rails } = {}
) {
  const ticketId = typeof ticketOrId === 'string' ? ticketOrId : ticketOrId?.id;
  if (!ticketId || typeof ticketId !== 'string' || !TICKET_ID_RE.test(ticketId)) {
    return {
      ok: false,
      snapshotPath: null,
      latestPath: null,
      fileCount: 0,
      deletedCount: 0,
      truncated: false,
    };
  }
  const wtSt = worktreePath ? lstatOrNull(worktreePath) : null;
  if (!wtSt || wtSt.isSymbolicLink() || !wtSt.isDirectory()) {
    return {
      ok: false,
      snapshotPath: null,
      latestPath: null,
      fileCount: 0,
      deletedCount: 0,
      truncated: false,
    };
  }

  const ticketScope = Array.isArray(scope)
    ? scope
    : Array.isArray(ticketOrId?.scope)
    ? ticketOrId.scope
    : [];
  const ticketRails = Array.isArray(rails)
    ? rails
    : Array.isArray(ticketOrId?.rails)
    ? ticketOrId.rails
    : [];

  const files = [];
  const changedRecords = [];
  let totalBytes = 0;
  let truncated = false;

  const walkWorktree = (dirPath, parentRel) => {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = parentRel ? `${parentRel}/${ent.name}` : ent.name;
      if (isForbiddenRescuePath(rel)) continue;
      const fullPath = join(dirPath, ent.name);
      const st = lstatOrNull(fullPath);
      if (!st || st.isSymbolicLink()) continue;

      if (st.isDirectory()) {
        walkWorktree(fullPath, rel);
        continue;
      }
      if (!st.isFile()) continue;

      if (ticketScope.length > 0 && !matchesScope(rel, ticketScope)) continue;
      if (matchDeclaredRail(rel, ticketRails)) continue;

      const mode = st.mode & 0o777;
      const basePath = baselineRoot ? join(baselineRoot, rel) : null;
      const baseSt = basePath ? lstatOrNull(basePath) : null;
      const baseExistsAsFile = Boolean(baseSt && !baseSt.isSymbolicLink() && baseSt.isFile());

      let wtBuf = null;
      let baseBuf = null;
      if (baseExistsAsFile && baseSt.size === st.size && (baseSt.mode & 0o777) === mode) {
        wtBuf = readFileSync(fullPath);
        baseBuf = readFileSync(basePath);
        if (wtBuf.equals(baseBuf)) {
          continue;
        }
      }

      const kind = baseExistsAsFile ? 'M' : 'A';
      if (st.size > MAX_RESCUE_FILE_BYTES || totalBytes + st.size > MAX_RESCUE_TOTAL_BYTES) {
        truncated = true;
        changedRecords.push({ path: rel, kind, mode, oldBuf: null, newBuf: null });
        continue;
      }

      if (!wtBuf) wtBuf = readFileSync(fullPath);
      if (totalBytes + wtBuf.length > MAX_RESCUE_TOTAL_BYTES) {
        truncated = true;
        changedRecords.push({ path: rel, kind, mode, oldBuf: null, newBuf: null });
        continue;
      }

      if (baseExistsAsFile && !baseBuf && baseSt.size <= MAX_RESCUE_FILE_BYTES) {
        try {
          baseBuf = readFileSync(basePath);
        } catch {
          baseBuf = null;
        }
      }

      totalBytes += wtBuf.length;
      files.push({
        path: rel,
        mode,
        contentBase64: wtBuf.toString('base64'),
        baseSha256: baseBuf
          ? crypto.createHash('sha256').update(baseBuf).digest('hex')
          : null,
      });
      changedRecords.push({ path: rel, kind, mode, oldBuf: baseBuf, newBuf: wtBuf });
    }
  };

  walkWorktree(worktreePath, '');

  const deletedSet = new Set();
  const baseRootSt = baselineRoot ? lstatOrNull(baselineRoot) : null;
  if (baseRootSt && !baseRootSt.isSymbolicLink() && baseRootSt.isDirectory()) {
    const checkBaselineFile = (rel) => {
      if (isForbiddenRescuePath(rel)) return;
      if (ticketScope.length > 0 && !matchesScope(rel, ticketScope)) return;
      if (matchDeclaredRail(rel, ticketRails)) return;
      const wtTargetSt = lstatOrNull(join(worktreePath, rel));
      if (!wtTargetSt) {
        deletedSet.add(rel);
      }
    };

    const walkBaseline = (dirPath, parentRel) => {
      let entries;
      try {
        entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const rel = parentRel ? `${parentRel}/${ent.name}` : ent.name;
        if (isForbiddenRescuePath(rel)) continue;
        const full = join(dirPath, ent.name);
        const st = lstatOrNull(full);
        if (!st || st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          walkBaseline(full, rel);
        } else if (st.isFile()) {
          checkBaselineFile(rel);
        }
      }
    };

    for (const staticPrefix of computeScopeStaticRoots(ticketScope)) {
      if (!staticPrefix) {
        walkBaseline(baselineRoot, '');
        break;
      }
      if (isForbiddenRescuePath(staticPrefix)) continue;
      // Ensure no ancestor of staticPrefix in baselineRoot is a symlink
      const segs = staticPrefix.split('/');
      let cur = baselineRoot;
      let unsafe = false;
      for (const seg of segs) {
        cur = join(cur, seg);
        const st = lstatOrNull(cur);
        if (!st || st.isSymbolicLink()) {
          unsafe = true;
          break;
        }
      }
      if (unsafe) continue;
      const targetSt = lstatOrNull(cur);
      if (!targetSt || targetSt.isSymbolicLink()) continue;
      if (targetSt.isDirectory()) {
        walkBaseline(cur, staticPrefix);
      } else if (targetSt.isFile()) {
        checkBaselineFile(staticPrefix);
      }
    }
  }

  const deletedPaths = [...deletedSet].sort();
  const diff =
    typeof diffPreview === 'string' && diffPreview.length > 0
      ? truncateUtf8Bytes(diffPreview, MAX_DIFF_PREVIEW_BYTES)
      : buildPureFsDiffSummary(changedRecords, deletedPaths, truncated);

  const safeRunId = sanitizeRunId(runId || 'manual') || 'manual';
  const lowerId = ticketId.toLowerCase();
  const rescueLogDir = ensureSafeBoosterSubdir(repo, ['logs', safeRunId, 'rescue']);
  const rescueLatestDir = ensureSafeBoosterSubdir(repo, ['rescue-latest']);

  let baseSha = null;
  if (baselineRoot) {
    try {
      const resolvedHead = execFileSync(
        'git',
        ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'],
        { cwd: baselineRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizedGitEnv() }
      ).trim();
      if (/^[0-9a-f]{40,64}$/i.test(resolvedHead)) baseSha = resolvedHead;
    } catch {}
  }

  const snapshotPath = join(rescueLogDir, `${lowerId}.json`);
  const latestPath = join(rescueLatestDir, `${lowerId}.json`);
  const payload = {
    ticketId,
    runId: safeRunId,
    savedAt: new Date().toISOString(),
    baseSha,
    files,
    deletedPaths,
    diff,
  };

  writeOwnerOnlyJsonAtomic(snapshotPath, payload);
  writeOwnerOnlyJsonAtomic(latestPath, payload);

  return {
    ok: true,
    snapshotPath,
    latestPath,
    fileCount: files.length,
    deletedCount: deletedPaths.length,
    truncated,
  };
}

export function buildRescueBrief(ticket, { lastError = '', gate = {} } = {}) {
  const safeTicket = ticket ?? {};
  const id = safeTicket.id ?? '';
  const title = safeTicket.title || id;
  const scopeStr = (safeTicket.scope ?? []).join(', ');
  const railsStr = (safeTicket.rails ?? []).join(', ');
  const priorLine = lastError ? `Prior Failure: ${lastError}\n` : '';
  return (
    `# AGB Surgical Rescue: ${id} — ${title}\n\n` +
    `Scope: ${scopeStr}\n` +
    `Frozen Rails (DO NOT EDIT): ${railsStr}\n` +
    `Gates: ${JSON.stringify(gate ?? {})}\n` +
    `${priorLine}\n` +
    `${safeTicket.body ?? ''}\n\n` +
    `Fix the ticket inside this worktree, verify tests pass, and exit cleanly so AGB can run P3/P5 gates and merge.`
  );
}

function gitSync(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      `core.hooksPath=${NULL_HOOKS_PATH}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'diff.external=',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedGitEnv(),
    }
  );
}

function resolveCommonGitDirReal(repo) {
  const out = gitSync(repo, 'rev-parse', '--git-common-dir').trim();
  return realpathSync(resolve(repo, out));
}

function verifyRescueWorktreeGitPointer(repo, worktreePath, expectedGitDir = null) {
  const wtSt = lstatOrNull(worktreePath);
  if (!wtSt || wtSt.isSymbolicLink() || !wtSt.isDirectory()) {
    throw new Error(`Security violation: rescue worktree is missing or symbolic link: ${worktreePath}`);
  }
  const dotGit = join(worktreePath, '.git');
  const gitSt = lstatOrNull(dotGit);
  if (!gitSt || gitSt.isSymbolicLink() || !gitSt.isFile()) {
    throw new Error(`Security violation: rescue worktree .git pointer must be a regular file: ${dotGit}`);
  }
  const content = readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/.exec(content);
  if (!match) {
    throw new Error(`Security violation: invalid rescue worktree .git pointer format: ${dotGit}`);
  }
  const targetDir = realpathSync(resolve(worktreePath, match[1].trim()));
  const worktreesParent = join(resolveCommonGitDirReal(repo), 'worktrees');
  const relToParent = relative(worktreesParent, targetDir);
  if (!relToParent || relToParent === '.' || relToParent.startsWith('..') || isAbsolute(relToParent)) {
    throw new Error(`Security violation: rescue worktree .git target escapes repository worktrees: ${targetDir}`);
  }
  if (expectedGitDir && targetDir !== expectedGitDir) {
    throw new Error(`Security violation: rescue worktree .git pointer changed (${expectedGitDir} -> ${targetDir})`);
  }
  const hooksDir = join(targetDir, 'hooks');
  if (existsSync(hooksDir)) {
    try {
      rmSync(hooksDir, { recursive: true, force: true });
      mkdirSync(hooksDir, { recursive: true });
    } catch {}
  }
  return targetDir;
}

function readJsonIfSafeFile(filePath) {
  const st = lstatOrNull(filePath);
  if (!st || st.isSymbolicLink() || !st.isFile()) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveRescueTicketAndGate(repo, ticketId, options = {}) {
  let planObj = null;
  if (options.planPath) {
    const absPlan = resolve(repo, options.planPath);
    planObj = readJsonIfSafeFile(absPlan);
  } else {
    const boosterSt = lstatOrNull(join(repo, '.booster'));
    if (boosterSt && !boosterSt.isSymbolicLink() && boosterSt.isDirectory()) {
      planObj = readJsonIfSafeFile(join(repo, '.booster', 'plan.json'));
    }
  }

  let resolvedTicket = options.ticket ?? null;
  if (!resolvedTicket && Array.isArray(planObj?.tickets)) {
    resolvedTicket =
      planObj.tickets.find((t) => t?.id === ticketId) ??
      planObj.tickets.find((t) => typeof t?.id === 'string' && t.id.toLowerCase() === ticketId.toLowerCase()) ??
      null;
  }

  if (!resolvedTicket) {
    const storeRes = resolveTicket(repo, ticketId);
    if (storeRes.ok && storeRes.ticket) {
      resolvedTicket = storeRes.ticket;
    } else {
      const ticketsDir = join(repo, '.adlc', 'tickets');
      const dirSt = lstatOrNull(ticketsDir);
      if (dirSt && !dirSt.isSymbolicLink() && dirSt.isDirectory()) {
        try {
          for (const ent of readdirSync(ticketsDir)) {
            if (!ent.endsWith('.json') || ent === '.store.json') continue;
            const shard = readJsonIfSafeFile(join(ticketsDir, ent));
            if (
              shard &&
              typeof shard.id === 'string' &&
              shard.id.toLowerCase() === ticketId.toLowerCase()
            ) {
              resolvedTicket = shard;
              break;
            }
          }
        } catch {}
      }
    }
  }

  const resolvedGate = options.gate ?? planObj?.gate ?? { test: 'npm test' };
  return { resolvedTicket, resolvedGate, planBase: planObj?.base ?? null };
}

function readRunJsonSafe(repo) {
  const boosterSt = lstatOrNull(join(repo, '.booster'));
  if (!boosterSt || boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) return null;
  return readJsonIfSafeFile(join(repo, '.booster', 'run.json'));
}

function readExistingRescueLock(repo, ticketId) {
  const boosterSt = lstatOrNull(join(repo, '.booster'));
  if (!boosterSt || boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) return null;
  const locksDir = join(repo, '.booster', 'rescue-locks');
  const locksSt = lstatOrNull(locksDir);
  if (!locksSt || locksSt.isSymbolicLink() || !locksSt.isDirectory()) return null;
  return readJsonIfSafeFile(join(locksDir, `${ticketId.toLowerCase()}.json`));
}

function peekSavedSnapshotBaseSha(repo, ticketId) {
  const boosterSt = lstatOrNull(join(repo, '.booster'));
  if (!boosterSt || boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) return null;
  const latestDir = join(repo, '.booster', 'rescue-latest');
  const latestSt = lstatOrNull(latestDir);
  if (!latestSt || latestSt.isSymbolicLink() || !latestSt.isDirectory()) return null;
  const snap = readJsonIfSafeFile(join(latestDir, `${ticketId.toLowerCase()}.json`));
  if (!snap || typeof snap.baseSha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(snap.baseSha)) {
    return null;
  }
  try {
    const verified = gitSync(repo, 'rev-parse', '--verify', `${snap.baseSha}^{commit}`).trim();
    return verified || null;
  } catch {
    return null;
  }
}

function restoreSavedSnapshotIntoWorktree(repo, worktreePath, ticket, { restoredAtSnapBase = false } = {}) {
  const boosterSt = lstatOrNull(join(repo, '.booster'));
  if (!boosterSt || boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) return;
  const latestDir = join(repo, '.booster', 'rescue-latest');
  const latestDirSt = lstatOrNull(latestDir);
  if (!latestDirSt || latestDirSt.isSymbolicLink() || !latestDirSt.isDirectory()) return;

  const snap = readJsonIfSafeFile(join(latestDir, `${ticket.id.toLowerCase()}.json`));
  if (!snap || typeof snap !== 'object') return;

  const realWt = realpathSync(worktreePath);
  const ticketScope = Array.isArray(ticket.scope) ? ticket.scope : [];
  const ticketRails = Array.isArray(ticket.rails) ? ticket.rails : [];

  const resolveContainedPath = (rel, { createDirs = false } = {}) => {
    if (isForbiddenRescuePath(rel)) return null;
    if (ticketScope.length > 0 && !matchesScope(rel, ticketScope)) return null;
    if (matchDeclaredRail(rel, ticketRails)) return null;

    const segments = rel.split('/');
    let cur = realWt;
    for (let i = 0; i < segments.length - 1; i++) {
      cur = join(cur, segments[i]);
      const st = lstatOrNull(cur);
      if (st) {
        if (st.isSymbolicLink() || !st.isDirectory()) return null;
      } else if (createDirs) {
        mkdirSync(cur, { recursive: true });
      } else {
        return null;
      }
      const realCur = realpathSync(cur);
      if (!realCur.startsWith(realWt + sep)) return null;
    }

    const leaf = join(cur, segments[segments.length - 1]);
    const leafSt = lstatOrNull(leaf);
    if (leafSt?.isSymbolicLink()) return null;
    return leaf;
  };

  for (const entry of Array.isArray(snap.files) ? snap.files : []) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.contentBase64 !== 'string') {
      continue;
    }
    const targetPath = resolveContainedPath(entry.path, { createDirs: true });
    if (!targetPath) continue;
    const buf = Buffer.from(entry.contentBase64, 'base64');
    const existingSt = lstatOrNull(targetPath);
    if (existingSt && !existingSt.isFile()) continue;

    if (!restoredAtSnapBase && entry.baseSha256 !== undefined) {
      const currentSha = existingSt
        ? crypto.createHash('sha256').update(readFileSync(targetPath)).digest('hex')
        : null;
      if (currentSha !== entry.baseSha256) {
        throw new Error(
          `cannot safely restore snapshot for '${entry.path}': base branch diverged since snapshot was taken`
        );
      }
    }

    const flags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0);
    const mode = typeof entry.mode === 'number' ? entry.mode & 0o777 : 0o644;
    const fd = openSync(targetPath, flags, mode || 0o644);
    try {
      let offset = 0;
      while (offset < buf.length) {
        offset += writeSync(fd, buf, offset, buf.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== 'win32' && mode) {
      try {
        chmodSync(targetPath, mode);
      } catch {}
    }
  }

  for (const delRel of Array.isArray(snap.deletedPaths) ? snap.deletedPaths : []) {
    if (typeof delRel !== 'string') continue;
    const targetPath = resolveContainedPath(delRel, { createDirs: false });
    if (!targetPath) continue;
    const st = lstatOrNull(targetPath);
    if (st && !st.isSymbolicLink() && st.isFile()) {
      try {
        unlinkSync(targetPath);
      } catch {}
    }
  }
}

function configureRescueWorktreeGit(worktreePath) {
  try {
    gitSync(worktreePath, 'config', 'commit.gpgsign', 'false');
    gitSync(worktreePath, 'config', 'core.hooksPath', NULL_HOOKS_PATH);
    try {
      gitSync(worktreePath, 'config', '--get', 'user.name');
    } catch {
      gitSync(worktreePath, 'config', 'user.name', 'agb-rescue');
    }
    try {
      gitSync(worktreePath, 'config', '--get', 'user.email');
    } catch {
      gitSync(worktreePath, 'config', 'user.email', 'agb@local');
    }
  } catch {}
}

function spawnDefaultInteractiveAgy(agyBin, brief, worktreePath, ticketId) {
  return new Promise((resolveExit, rejectExit) => {
    const onParentSigint = () => {
      // Ignore SIGINT in parent while foreground agy -i handles Ctrl-C turn interrupts
    };
    process.on('SIGINT', onParentSigint);
    const detachSigint = () => {
      process.off('SIGINT', onParentSigint);
    };
    const child = spawn(agyBin, ['-i', brief], {
      cwd: worktreePath,
      stdio: 'inherit',
      env: { ...process.env, AGB_RESCUE_TICKET: ticketId },
    });
    child.on('error', (err) => {
      detachSigint();
      rejectExit(err);
    });
    child.on('close', (code) => {
      detachSigint();
      resolveExit(code ?? 1);
    });
  });
}

export async function runInteractiveRescue(repo, ticketId, options = {}) {
  if (!ticketId || typeof ticketId !== 'string' || !TICKET_ID_RE.test(ticketId)) {
    return {
      ok: false,
      merged: false,
      ticketId: String(ticketId ?? ''),
      error: `invalid ticket id '${ticketId}'`,
    };
  }

  const resolvedRepo = resolve(repo);
  const { resolvedTicket, resolvedGate, planBase } = resolveRescueTicketAndGate(
    resolvedRepo,
    ticketId,
    options
  );
  if (!resolvedTicket) {
    return {
      ok: false,
      merged: false,
      ticketId,
      error: `ticket '${ticketId}' not found in options, plan.json, or .adlc/tickets/`,
    };
  }

  const canonicalTicket = { ...resolvedTicket, id: resolvedTicket.id || ticketId };
  const runJson = readRunJsonSafe(resolvedRepo);
  const baseBranch = options.baseBranch || planBase || currentBranch(resolvedRepo) || 'main';
  const runId = options.runId || runJson?.runId || 'rescue';
  const lastError =
    options.lastError !== undefined
      ? options.lastError
      : runJson?.tickets?.[ticketId]?.error ??
        runJson?.tickets?.[canonicalTicket.id]?.error ??
        '';

  const worktreePath = join(resolvedRepo, '.worktrees', `agb-${ticketId.toLowerCase()}`);

  // Phase A: Short Setup Lock (released before spawning interactive agy -i)
  let lockA = null;
  let expectedWtGitDir = null;
  let refusedLiveRescue = false;
  try {
    lockA = acquireRepoLock(resolvedRepo, { runId });
    lockA.assertStillHeld();
    const priorLock = readExistingRescueLock(resolvedRepo, ticketId);
    if (
      priorLock?.state === 'active' &&
      typeof priorLock.pid === 'number' &&
      priorLock.pid !== process.pid &&
      existsSync(worktreePath) &&
      isProcessAlive(priorLock.pid, priorLock.startTime ?? null)
    ) {
      refusedLiveRescue = true;
      throw new Error(
        `another interactive rescue session (pid ${priorLock.pid}) is already active for ticket '${ticketId}'`
      );
    }

    const reuseExisting =
      existsSync(worktreePath) &&
      (Boolean(options.continueExisting) ||
        priorLock?.state === 'preserved' ||
        priorLock?.state === 'active');

    writeRescueWorktreeLock(resolvedRepo, ticketId, { state: 'active', runId });

    if (!reuseExisting) {
      const snapBaseSha = peekSavedSnapshotBaseSha(resolvedRepo, canonicalTicket.id);
      createWorktree(resolvedRepo, ticketId, snapBaseSha || baseBranch, { allowResetRescue: true });
      restoreSavedSnapshotIntoWorktree(resolvedRepo, worktreePath, canonicalTicket, {
        restoredAtSnapBase: Boolean(snapBaseSha),
      });
    }

    expectedWtGitDir = verifyRescueWorktreeGitPointer(resolvedRepo, worktreePath);
    configureRescueWorktreeGit(worktreePath);
    materializeWorktreeNodeModules(worktreePath, join(resolvedRepo, 'node_modules'));
  } catch (err) {
    const wtPresent = !refusedLiveRescue && existsSync(worktreePath);
    if (wtPresent) {
      try {
        writeRescueWorktreeLock(resolvedRepo, ticketId, { state: 'preserved', runId });
      } catch {}
      try {
        saveRescueSnapshot(resolvedRepo, canonicalTicket, worktreePath, {
          runId,
          baselineRoot: resolvedRepo,
        });
      } catch {}
    }
    return {
      ok: false,
      merged: false,
      ticketId,
      ...(wtPresent ? { preservedWorktree: worktreePath } : {}),
      error: err?.message ?? String(err),
    };
  } finally {
    if (lockA) lockA();
  }

  // Interactive Phase: Unlocked so other read/status tools or operators aren't blocked
  const rescueBrief = buildRescueBrief(canonicalTicket, {
    lastError,
    gate: resolvedGate,
  });
  const effectiveAgyBin =
    options.agyBin || process.env.AGB_AGY_BIN || resolveAgyBinary() || 'agy';

  let exitCode = 0;
  try {
    if (typeof options.spawnInteractive === 'function') {
      const rawExit = await options.spawnInteractive(
        {
          worktreePath,
          cwd: worktreePath,
          brief: rescueBrief,
          rescueBrief,
          ticket: canonicalTicket,
          gate: resolvedGate,
          agyBin: effectiveAgyBin,
          args: ['-i', rescueBrief],
        },
        rescueBrief,
        worktreePath
      );
      if (typeof rawExit === 'number') {
        exitCode = rawExit;
      } else if (rawExit && typeof rawExit === 'object') {
        if (typeof rawExit.exitCode === 'number') exitCode = rawExit.exitCode;
        else if (typeof rawExit.code === 'number') exitCode = rawExit.code;
        else if (typeof rawExit.status === 'number') exitCode = rawExit.status;
      }
    } else {
      exitCode = await spawnDefaultInteractiveAgy(effectiveAgyBin, rescueBrief, worktreePath, canonicalTicket.id);
    }
  } catch (err) {
    try {
      writeRescueWorktreeLock(resolvedRepo, ticketId, { state: 'preserved', runId });
      saveRescueSnapshot(resolvedRepo, canonicalTicket, worktreePath, {
        runId,
        baselineRoot: resolvedRepo,
      });
    } catch {}
    return {
      ok: false,
      merged: false,
      ticketId,
      preservedWorktree: worktreePath,
      error: err?.message ?? String(err),
    };
  }

  if (exitCode !== 0) {
    try {
      writeRescueWorktreeLock(resolvedRepo, ticketId, { state: 'preserved', runId });
      saveRescueSnapshot(resolvedRepo, canonicalTicket, worktreePath, {
        runId,
        baselineRoot: resolvedRepo,
      });
    } catch {}
    return {
      ok: false,
      merged: false,
      ticketId,
      preservedWorktree: worktreePath,
      error: `interactive rescue exited with code ${exitCode}`,
    };
  }

  // Phase B: Short Verify & Merge Lock
  const hollowTestEnabled = options.hollowTest !== false;
  const verifyGateIntegrityFn = options.verifyGateIntegrityFn;
  const verifyScopeFn = options.verifyScopeFn ?? verifyScopeAndAntiNoOp;
  const verifySymbolsFn = options.verifySymbolsFn ?? runSymbolScopeVerification;
  const railsGuardFn = options.railsGuardFn ?? checkRailsGuard;
  const runGatesFn = options.runGatesFn ?? runGates;
  const runHollowTestFn = options.runHollowTestFn ?? runHollowTest;
  const prosecuteFn = options.prosecuteFn ?? prosecute;
  const recordGateFn = options.recordGateFn ?? recordGate;

  let lockB = null;
  let integWorktree = null;
  let journalWritten = false;
  let baseRefAdvanced = false;
  let markerRef = null;
  let prosecuteScratch = null;

  try {
    lockB = acquireRepoLock(resolvedRepo, { runId });
    lockB.assertStillHeld();

    const priorJournal = readIntegrationJournal(resolvedRepo);
    if (priorJournal.exists) {
      throw new Error(
        `outstanding integration journal detected in ${resolvedRepo}; reconcile before merging rescue`
      );
    }

    const baseHeadSha = gitSync(resolvedRepo, 'rev-parse', '--verify', `${baseBranch}^{commit}`).trim();

    removeMaterializedNodeModules(worktreePath);
    cleanEmptyNodeModules(worktreePath);
    verifyRescueWorktreeGitPointer(resolvedRepo, worktreePath, expectedWtGitDir);
    configureRescueWorktreeGit(worktreePath);
    commitAll(worktreePath, `${ticketId}: ${canonicalTicket.title || ticketId} (rescue)`);
    verifyRescueWorktreeGitPointer(resolvedRepo, worktreePath, expectedWtGitDir);

    const transactionToken = crypto.randomUUID();
    markerRef = `refs/transactions/${ticketId}/${transactionToken}`;
    integWorktree = createIntegrationWorktree(resolvedRepo, transactionToken, baseBranch);
    removeMaterializedNodeModules(integWorktree);
    cleanEmptyNodeModules(integWorktree);

    const wtGitUrl = pathToFileURL(expectedWtGitDir).href;
    gitSync(
      integWorktree,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      wtGitUrl,
      'HEAD:refs/heads/rescue-candidate'
    );
    gitSync(integWorktree, 'checkout', '-B', 'rescue-candidate', 'refs/heads/rescue-candidate');
    try {
      gitSync(integWorktree, 'rebase', baseHeadSha);
    } catch (rebErr) {
      try {
        gitSync(integWorktree, 'rebase', '--abort');
      } catch {}
      throw new Error(
        `rebase conflict onto ${baseBranch}: ${String(rebErr.stderr ?? rebErr.message).slice(-300)}`
      );
    }

    // 1. Gate script integrity
    const basePkgPath = join(resolvedRepo, 'package.json');
    const candPkgPath = join(integWorktree, 'package.json');
    if (typeof verifyGateIntegrityFn === 'function') {
      if (verifyGateIntegrityFn.length >= 3) {
        if (existsSync(basePkgPath)) {
          if (!existsSync(candPkgPath)) {
            throw new Error('candidate deleted package.json while baseline repository requires it');
          }
          const basePkg = JSON.parse(readFileSync(basePkgPath, 'utf8'));
          const candPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
          for (const cmd of [resolvedGate?.build, resolvedGate?.test].filter(Boolean)) {
            verifyGateIntegrityFn(candPkg, basePkg, cmd);
          }
        }
      } else {
        const gRes = await verifyGateIntegrityFn({
          repo: resolvedRepo,
          worktree: integWorktree,
          gate: resolvedGate,
        });
        if (gRes && typeof gRes === 'object' && gRes.ok === false) {
          throw new Error(gRes.error || 'gate script integrity check failed');
        }
      }
    } else if (existsSync(basePkgPath)) {
      if (!existsSync(candPkgPath)) {
        throw new Error('candidate deleted package.json while baseline repository requires it');
      }
      const basePkg = JSON.parse(readFileSync(basePkgPath, 'utf8'));
      const candPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
      for (const cmd of [resolvedGate?.build, resolvedGate?.test].filter(Boolean)) {
        verifyGateScriptIntegrity(candPkg, basePkg, cmd);
      }
    }

    // 2. Scope, anti-no-op, and forbidden customization path check
    const scopeCheck = await verifyScopeFn(
      resolvedRepo,
      integWorktree,
      baseHeadSha,
      canonicalTicket
    );
    if (!scopeCheck?.ok) {
      throw new Error(scopeCheck?.error || 'scope or anti-no-op verification failed');
    }
    const changed = Array.isArray(scopeCheck.changedFiles) ? scopeCheck.changedFiles : [];
    const forbiddenChanged = changed.find((p) => isForbiddenRescuePath(p));
    if (forbiddenChanged) {
      throw new Error(
        `forbidden customization or harness path modified in rescue worktree: ${forbiddenChanged}`
      );
    }

    // 3. Discard orchestrator projections before symbol/rails/gate checks
    discardProjection(integWorktree, 'HEAD');

    // 4. Symbol scope / symbol rails check
    const hasSymbolConstraints =
      (Array.isArray(canonicalTicket.symbol_scope) && canonicalTicket.symbol_scope.length > 0) ||
      (Array.isArray(canonicalTicket.symbol_rails) && canonicalTicket.symbol_rails.length > 0);
    if (hasSymbolConstraints || options.verifySymbolsFn) {
      const symDiff = branchDiff(integWorktree, baseHeadSha);
      const symRes = await verifySymbolsFn(canonicalTicket, symDiff, { repo: integWorktree });
      if (!symRes?.ok) {
        throw new Error(
          `symbol scope/rail violation: ${(symRes?.violations ?? [symRes?.error ?? 'invalid']).join('; ')}`
        );
      }
    }

    // 5. Post-hoc rails-guard (fail closed)
    const activeRailsRes = loadActiveRails(resolvedRepo);
    if (!activeRailsRes.ok) {
      throw new Error(`ticket store unreadable (${activeRailsRes.error})`);
    }
    const resolvedAdlc = resolveAdlcBinary({ repo: resolvedRepo });
    const runAdlcBin = resolvedAdlc.ok ? resolvedAdlc.binary : undefined;
    const allRails = [
      ...new Set([...(canonicalTicket.rails ?? []), ...(activeRailsRes.rails ?? [])]),
    ];
    if (allRails.length > 0 || options.railsGuardFn) {
      const railRes = await railsGuardFn({
        worktree: integWorktree,
        base: baseHeadSha,
        rails: allRails,
        adlcBin: runAdlcBin,
      });
      if (
        railRes?.operationalError ||
        railRes?.ok === false ||
        (Array.isArray(railRes?.violations) && railRes.violations.length > 0)
      ) {
        throw new Error(
          `rail violation: ${(railRes?.violations ?? [railRes?.error ?? 'rails-guard failed']).join(', ')}`
        );
      }
    }

    // 6 & 7. Sandboxed deterministic gates + mutation testing (hollow-test) with materialized node_modules
    const materialized = materializeWorktreeNodeModules(
      integWorktree,
      join(resolvedRepo, 'node_modules')
    );
    let gateRes;
    let hollowRes = null;
    try {
      gateRes = await runGatesFn(resolvedGate, integWorktree, { sandbox: true });
      if (!gateRes?.ok) {
        const failedGate = Array.isArray(gateRes?.results) ? gateRes.results.at(-1) : null;
        throw new Error(
          failedGate
            ? `gate ${failedGate.name} failed:\n${failedGate.output ?? ''}`
            : gateRes?.error || 'gates failed'
        );
      }

      if (hollowTestEnabled && changed.some((f) => f.startsWith('lib/'))) {
        hollowRes = await runHollowTestFn({
          worktree: integWorktree,
          testCmd: resolvedGate?.test,
          base: baseHeadSha,
          adlcBin: runAdlcBin,
          changedFiles: changed,
        });
        if (hollowRes?.ok === false && Boolean(options.runHollowTestFn || runAdlcBin)) {
          throw new Error(
            `adlc hollow-test failed: ${hollowRes.error || 'mutation gate execution error'}`
          );
        }
        if ((hollowRes?.survived ?? 0) > 0) {
          throw new Error(
            `adlc hollow-test: ${hollowRes.survived}/${hollowRes.total ?? hollowRes.survived} mutant(s) survived`
          );
        }
      }
    } finally {
      if (materialized) removeMaterializedNodeModules(integWorktree);
      cleanEmptyNodeModules(integWorktree);
    }

    // 8. Cross-model prosecution
    const diffText = branchDiff(integWorktree, baseHeadSha);
    let prosecutorModel = PROSECUTOR_CANDIDATES[0];
    try {
      const pools = new PoolSet(undefined, { repo: resolvedRepo });
      const referenceBuilder = tierCandidates(canonicalTicket.tier ?? 'mid', canonicalTicket.pool_hint)[0];
      prosecutorModel = pools.prosecutorFor(referenceBuilder);
    } catch {}
    prosecuteScratch = mkdtempSync(join(tmpdir(), 'agb-rescue-prosecute-'));
    const verdict = await prosecuteFn({
      ticket: canonicalTicket,
      diff: diffText,
      model: prosecutorModel,
      cwd: prosecuteScratch,
      worktree: options.prosecuteFn ? integWorktree : hollowRes ? null : integWorktree,
      testCmd: resolvedGate?.test,
      base: baseHeadSha,
      adlcBin: runAdlcBin,
      hollowTest: hollowRes,
    });
    const blocking = blockingFindings(verdict?.findings);
    if (!verdict || verdict.verdict !== 'ship' || blocking.length > 0) {
      const reason =
        verdict?.error ||
        (blocking.length > 0 ? JSON.stringify(blocking) : `verdict=${verdict?.verdict ?? 'none'}`);
      throw new Error(`prosecution blocked merge: ${reason}`);
    }

    // 9. Gate manifest audit record (advisory — degrades gracefully)
    await recordGateFn({
      repo: resolvedRepo,
      gateName: 'rescue',
      ticketId,
      data: { ok: true, verdict: verdict.verdict, changedFiles: changed },
      adlcBin: runAdlcBin,
    });

    // 10. Journaled CAS ref advance onto baseBranch
    lockB.assertStillHeld();
    const currentBaseNow = gitSync(
      resolvedRepo,
      'rev-parse',
      '--verify',
      `refs/heads/${baseBranch}`
    ).trim();
    if (currentBaseNow !== baseHeadSha) {
      throw new Error(
        `base branch '${baseBranch}' moved during rescue verification (${baseHeadSha.slice(0, 8)} -> ${currentBaseNow.slice(0, 8)})`
      );
    }

    const candidateSha = gitSync(integWorktree, 'rev-parse', 'HEAD').trim();
    const canAdvisorySync =
      currentBranch(resolvedRepo) === baseBranch &&
      execFileSync('git', ['status', '--porcelain=v1', '-z'], {
        cwd: resolvedRepo,
        env: sanitizedGitEnv(),
      }).length === 0 &&
      gitSync(resolvedRepo, 'rev-parse', 'HEAD').trim() === baseHeadSha;

    const integGitUrl = pathToFileURL(join(integWorktree, '.git')).href;
    gitSync(
      resolvedRepo,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      integGitUrl,
      `${candidateSha}:${markerRef}`
    );

    const journalData = {
      ticketId,
      transactionToken,
      preMergeSha: baseHeadSha,
      candidateSha,
      phase: JOURNAL_PHASES.PREPARED,
      timestamp: Date.now(),
    };
    writeIntegrationJournal(resolvedRepo, journalData);
    journalWritten = true;

    journalData.phase = JOURNAL_PHASES.GATES_PASSED;
    journalData.timestamp = Date.now();
    writeIntegrationJournal(resolvedRepo, journalData);

    gitSync(resolvedRepo, 'update-ref', `refs/heads/${baseBranch}`, candidateSha, baseHeadSha);
    baseRefAdvanced = true;

    journalData.phase = JOURNAL_PHASES.REF_ADVANCED;
    journalData.timestamp = Date.now();
    writeIntegrationJournal(resolvedRepo, journalData);

    journalData.phase = JOURNAL_PHASES.FINALIZED;
    journalData.timestamp = Date.now();
    writeIntegrationJournal(resolvedRepo, journalData);

    try {
      gitSync(resolvedRepo, 'update-ref', '-d', markerRef);
    } catch {}
    unlinkIntegrationJournal(resolvedRepo);
    journalWritten = false;

    if (canAdvisorySync) {
      try {
        gitSync(resolvedRepo, 'read-tree', '-u', '-m', baseHeadSha, candidateSha);
      } catch {}
    }

    // Update .booster/run.json and .booster/report.json so `agb run --resume` skips the rescued ticket
    try {
      const boosterDir = join(resolvedRepo, '.booster');
      const bSt = lstatOrNull(boosterDir);
      if (bSt && !bSt.isSymbolicLink() && bSt.isDirectory()) {
        const runFile = join(boosterDir, 'run.json');
        const existingRun = readJsonIfSafeFile(runFile);
        if (existingRun && typeof existingRun === 'object' && !Array.isArray(existingRun)) {
          const updatedTickets = { ...(existingRun.tickets ?? {}) };
          updatedTickets[canonicalTicket.id] = {
            ...(updatedTickets[canonicalTicket.id] ?? {}),
            phase: 'merged',
            detail: 'merged via agb rescue',
            mergeSha: candidateSha,
          };
          const updatedRun = { ...existingRun, tickets: updatedTickets };
          if (updatedRun.report && typeof updatedRun.report === 'object') {
            const mergedSet = new Set(Array.isArray(updatedRun.report.merged) ? updatedRun.report.merged : []);
            mergedSet.add(canonicalTicket.id);
            const nextFailed = { ...(updatedRun.report.failed ?? {}) };
            delete nextFailed[canonicalTicket.id];
            delete nextFailed[ticketId];
            updatedRun.report = { ...updatedRun.report, merged: [...mergedSet], failed: nextFailed };
          }
          writeOwnerOnlyJsonAtomic(runFile, updatedRun);
        }

        const reportFile = join(boosterDir, 'report.json');
        const existingReport = readJsonIfSafeFile(reportFile);
        if (existingReport && typeof existingReport === 'object' && !Array.isArray(existingReport)) {
          const mergedSet = new Set(Array.isArray(existingReport.merged) ? existingReport.merged : []);
          mergedSet.add(canonicalTicket.id);
          const nextFailed = { ...(existingReport.failed ?? {}) };
          delete nextFailed[canonicalTicket.id];
          delete nextFailed[ticketId];
          writeOwnerOnlyJsonAtomic(reportFile, {
            ...existingReport,
            merged: [...mergedSet],
            failed: nextFailed,
          });
        }
      }
    } catch {}

    try {
      removeWorktree(resolvedRepo, integWorktree, { force: true });
    } catch {
      try {
        rmSync(integWorktree, { recursive: true, force: true });
      } catch {}
    }
    integWorktree = null;

    try {
      removeWorktree(resolvedRepo, worktreePath, { force: true });
    } catch {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }
    deleteBranch(resolvedRepo, ticketId);
    clearRescueWorktreeLock(resolvedRepo, ticketId);

    return { ok: true, merged: true, ticketId };
  } catch (err) {
    if (!baseRefAdvanced) {
      if (markerRef) {
        try {
          gitSync(resolvedRepo, 'update-ref', '-d', markerRef);
        } catch {}
      }
      if (journalWritten) {
        try {
          unlinkIntegrationJournal(resolvedRepo);
        } catch {}
      }
    }
    if (integWorktree) {
      try {
        removeWorktree(resolvedRepo, integWorktree, { force: true });
      } catch {
        try {
          rmSync(integWorktree, { recursive: true, force: true });
        } catch {}
      }
      integWorktree = null;
    }

    if (!baseRefAdvanced && existsSync(worktreePath)) {
      try {
        writeRescueWorktreeLock(resolvedRepo, ticketId, { state: 'preserved', runId });
      } catch {}
      try {
        saveRescueSnapshot(resolvedRepo, canonicalTicket, worktreePath, {
          runId,
          baselineRoot: resolvedRepo,
        });
      } catch {}
    }

    return {
      ok: false,
      merged: false,
      ticketId,
      preservedWorktree: worktreePath,
      error: err?.message ?? String(err),
    };
  } finally {
    if (prosecuteScratch) {
      try {
        rmSync(prosecuteScratch, { recursive: true, force: true });
      } catch {}
    }
    if (lockB) lockB();
  }
}
