// ADLC P6 Hunk-Level Sign-Off Dossier Engine (`agb accept` / `agb_accept`).
//
// Strictly read-only on git refs and repository source files: inspects unified
// diffs via `sanitizedGitEnv()`, computes SHA-256 hunk content fingerprints so
// verdicts in `.booster/accept-state.json` survive line-offset shifts while
// auto-invalidating modified hunks, attaches external-caller blast radius and
// `.adlc/manifest.jsonl` gate evidence, and renders P6 Markdown dossiers.

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { discoverExternalCallers, extractFileSymbolSpans } from './context-slice.mjs';
import { sanitizedGitEnv } from './run-integrity.mjs';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const VALID_HUNK_VERDICTS = new Set(['accepted', 'flagged', 'pending']);

function assertNotSymlink(targetPath) {
  let st;
  try {
    st = lstatSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    const e = new Error(`Security violation: symbolic link not allowed: ${targetPath}`);
    e.code = 'ESYMLINK';
    throw e;
  }
  return st;
}

export function resolveSafeBoosterDir(repo) {
  const rawRepo = resolve(repo);
  assertNotSymlink(join(rawRepo, '.booster'));
  let canonRepo = rawRepo;
  try {
    canonRepo = realpathSync(rawRepo);
  } catch {}
  const boosterDir = join(canonRepo, '.booster');
  const st = assertNotSymlink(boosterDir);
  if (st && !st.isDirectory()) {
    throw new Error(`Security violation: .booster is not a directory: ${boosterDir}`);
  }
  return { rawRepo, canonRepo, boosterDir, exists: Boolean(st) };
}

/**
 * Compute a SHA-256 fingerprint over normalized file path, optional `@@` context
 * heading, and hunk diff lines (`+`, `-`, context) while omitting volatile start
 * line numbers so pure line-offset shifts preserve verdicts while any content edit
 * invalidates them.
 */
export function computeHunkFingerprint(filePath, heading = '', lines = []) {
  const normFile = String(filePath ?? '').replace(/\\/g, '/').trim();
  const normHeading = String(heading ?? '').trim();
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
  return createHash('sha256')
    .update(`${normFile}\n${normHeading}\n${body}`)
    .digest('hex');
}

/**
 * Parse a unified git diff into structured per-file hunks with SHA-256 fingerprints.
 */
export function parseUnifiedDiffHunks(diffText = '') {
  if (typeof diffText !== 'string' || !diffText.trim()) return [];
  const rawLines = diffText.split(/\r?\n/);
  const hunks = [];
  let currentFile = null;
  let currentHunk = null;

  const flushHunk = () => {
    if (!currentHunk) return;
    const id = `H-${String(hunks.length + 1).padStart(3, '0')}`;
    const fingerprint = computeHunkFingerprint(
      currentHunk.file,
      currentHunk.heading,
      currentHunk.lines
    );
    hunks.push({
      id,
      file: currentHunk.file,
      oldStart: currentHunk.oldStart,
      oldLines: currentHunk.oldLines,
      newStart: currentHunk.newStart,
      newLines: currentHunk.newLines,
      header: currentHunk.header,
      heading: currentHunk.heading,
      lines: currentHunk.lines,
      addedCount: currentHunk.addedCount,
      removedCount: currentHunk.removedCount,
      fingerprint,
    });
    currentHunk = null;
  };

  const headerRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

  for (const line of rawLines) {
    const hunkStillExpectsLines =
      currentHunk !== null && (currentHunk.oldRem > 0 || currentHunk.newRem > 0);

    if (hunkStillExpectsLines) {
      if (line.startsWith('+')) {
        currentHunk.newRem = Math.max(0, currentHunk.newRem - 1);
        currentHunk.addedCount += 1;
        currentHunk.lines.push(line);
        continue;
      }
      if (line.startsWith('-')) {
        currentHunk.oldRem = Math.max(0, currentHunk.oldRem - 1);
        currentHunk.removedCount += 1;
        currentHunk.lines.push(line);
        continue;
      }
      if (line.startsWith(' ')) {
        currentHunk.oldRem = Math.max(0, currentHunk.oldRem - 1);
        currentHunk.newRem = Math.max(0, currentHunk.newRem - 1);
        currentHunk.lines.push(line);
        continue;
      }
      if (line.startsWith('\\')) {
        currentHunk.lines.push(line);
        continue;
      }
      flushHunk();
    } else if (currentHunk !== null) {
      if (line.startsWith('\\')) {
        currentHunk.lines.push(line);
        flushHunk();
        continue;
      }
      flushHunk();
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentFile = m ? m[2] : 'unknown';
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim() || currentFile;
      continue;
    }
    const hm = headerRe.exec(line);
    if (hm) {
      const oldLines = hm[2] !== undefined ? Number(hm[2]) : 1;
      const newLines = hm[4] !== undefined ? Number(hm[4]) : 1;
      currentHunk = {
        file: currentFile || 'unknown',
        oldStart: Number(hm[1]),
        oldLines,
        newStart: Number(hm[3]),
        newLines,
        oldRem: oldLines,
        newRem: newLines,
        header: line,
        heading: (hm[5] || '').trim(),
        lines: [],
        addedCount: 0,
        removedCount: 0,
      };
    }
  }
  flushHunk();
  return hunks;
}

/**
 * Load persisted SHA-256 fingerprint -> `'accepted' | 'flagged'` map from `.booster/accept-state.json`.
 */
export function loadAcceptVerdicts(repo) {
  const { boosterDir, exists } = resolveSafeBoosterDir(repo);
  if (!exists) return {};
  const statePath = join(boosterDir, 'accept-state.json');
  const st = assertNotSymlink(statePath);
  if (!st || !st.isFile()) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const rawVerdicts = parsed?.verdicts;
    if (!rawVerdicts || typeof rawVerdicts !== 'object' || Array.isArray(rawVerdicts)) {
      return {};
    }
    const clean = Object.create(null);
    for (const [fp, v] of Object.entries(rawVerdicts)) {
      if (!SHA256_HEX_RE.test(fp)) continue;
      if (v === 'accepted' || v === 'flagged') {
        clean[fp] = v;
      }
    }
    return { ...clean };
  } catch {
    return {};
  }
}

/**
 * Persist SHA-256 fingerprint -> `'accepted' | 'flagged'` hunk verdicts atomically
 * in `.booster/accept-state.json`.
 */
export function saveAcceptVerdicts(repo, verdictsMap = {}, { merge = false } = {}) {
  const { boosterDir } = resolveSafeBoosterDir(repo);
  mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(boosterDir);
  const statePath = join(boosterDir, 'accept-state.json');
  assertNotSymlink(statePath);

  const clean = merge ? { ...loadAcceptVerdicts(repo) } : {};
  if (verdictsMap && typeof verdictsMap === 'object' && !Array.isArray(verdictsMap)) {
    for (const [fp, v] of Object.entries(verdictsMap)) {
      if (!SHA256_HEX_RE.test(fp)) continue;
      if (!VALID_HUNK_VERDICTS.has(v)) {
        throw new Error(`Invalid hunk verdict '${String(v)}'`);
      }
      if (v === 'accepted' || v === 'flagged') {
        clean[fp] = v;
      } else if (v === 'pending') {
        delete clean[fp];
      }
    }
  }

  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    verdicts: clean,
  };
  const tmpPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') {
      try { chmodSync(tmpPath, 0o600); } catch {}
    }
    renameSync(tmpPath, statePath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  }
  return { ok: true, path: statePath, verdicts: clean };
}

function assertNoSymlinkAncestors(rootAnchor, targetPath) {
  const absRoot = resolve(rootAnchor);
  const absTarget = resolve(targetPath);
  const rel = relative(absRoot, absTarget);
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    let cur = absRoot;
    assertNotSymlink(cur);
    for (const seg of rel.split(sep).filter(Boolean)) {
      cur = join(cur, seg);
      assertNotSymlink(cur);
    }
    return;
  }
  const parts = absTarget.split(sep);
  let cur = absTarget.startsWith(sep) ? sep : parts[0];
  for (let i = absTarget.startsWith(sep) ? 1 : 1; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    cur = join(cur, parts[i]);
    assertNotSymlink(cur);
  }
}

export function writeAcceptDossierFile(repo, markdownText, customOutPath = null) {
  const { canonRepo, boosterDir } = resolveSafeBoosterDir(repo);
  let targetPath;
  if (customOutPath) {
    targetPath = resolve(canonRepo, customOutPath);
    assertNoSymlinkAncestors(canonRepo, targetPath);
    const parentDir = dirname(targetPath);
    mkdirSync(parentDir, { recursive: true });
    assertNoSymlinkAncestors(canonRepo, targetPath);
  } else {
    mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
    assertNotSymlink(boosterDir);
    targetPath = join(boosterDir, 'accept-dossier.md');
    assertNotSymlink(targetPath);
  }
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, String(markdownText ?? ''), { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      try { chmodSync(tmpPath, 0o600); } catch {}
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  }
  return targetPath;
}

function readGateManifestSummary(canonRepo) {
  const adlcDir = join(canonRepo, '.adlc');
  const manifestPath = join(adlcDir, 'manifest.jsonl');
  try {
    const dirSt = assertNotSymlink(adlcDir);
    if (!dirSt || !dirSt.isDirectory()) return { totalEntries: 0, gatesByType: {}, recent: [] };
    const fSt = assertNotSymlink(manifestPath);
    if (!fSt || !fSt.isFile()) return { totalEntries: 0, gatesByType: {}, recent: [] };
    const lines = readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const gatesByType = {};
    const parsedEntries = [];
    for (const l of lines) {
      try {
        const obj = JSON.parse(l);
        if (obj && typeof obj === 'object') {
          const g = String(obj.gate || obj.type || 'unknown');
          gatesByType[g] = (gatesByType[g] ?? 0) + 1;
          parsedEntries.push({
            seq: obj.seq ?? null,
            gate: g,
            ticket: obj.ticket ?? null,
            ts: obj.ts ?? null,
            signed: Boolean(obj.sig || obj.signature),
          });
        }
      } catch {}
    }
    return {
      totalEntries: parsedEntries.length,
      gatesByType,
      recent: parsedEntries.slice(-20),
    };
  } catch (err) {
    if (err?.code === 'ESYMLINK') throw err;
    return { totalEntries: 0, gatesByType: {}, recent: [] };
  }
}

function resolveContainedRepoFile(canonRepo, relFile) {
  if (typeof relFile !== 'string' || !relFile || relFile.includes('\0') || isAbsolute(relFile)) {
    return null;
  }
  const fullCandidate = resolve(canonRepo, relFile);
  const lexRel = relative(canonRepo, fullCandidate);
  if (!lexRel || lexRel.startsWith('..') || isAbsolute(lexRel)) {
    return null;
  }
  let cur = canonRepo;
  for (const seg of lexRel.split(sep).filter(Boolean)) {
    cur = join(cur, seg);
    const st = assertNotSymlink(cur);
    if (!st) return null;
  }
  const realFull = realpathSync(fullCandidate);
  const realRel = relative(canonRepo, realFull);
  if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) {
    return null;
  }
  return realFull;
}
function readReportSummary(boosterDir, exists) {
  if (!exists) return null;
  const reportPath = join(boosterDir, 'report.json');
  const st = assertNotSymlink(reportPath);
  if (!st || !st.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build a read-only ADLC P6 Sign-Off Dossier for `repo` against `base`.
 * Never mutates git refs or repository source files.
 */
export function buildAcceptanceDossier({
  repo = process.cwd(),
  base = 'HEAD',
  verdictsOverride = null,
} = {}) {
  const ref = String(base ?? 'HEAD').trim() || 'HEAD';
  if (ref.startsWith('-')) {
    throw new Error(`Invalid git base ref: ${ref}`);
  }
  const { canonRepo, boosterDir, exists } = resolveSafeBoosterDir(repo);

  const diffText = execFileSync(
    'git',
    [
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--end-of-options',
      ref,
    ],
    {
      cwd: canonRepo,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
      maxBuffer: 32 * 1024 * 1024,
    }
  );

  const savedVerdicts =
    verdictsOverride && typeof verdictsOverride === 'object'
      ? verdictsOverride
      : loadAcceptVerdicts(canonRepo);

  const rawHunks = parseUnifiedDiffHunks(diffText);
  const filesSet = new Set();
  let acceptedHunks = 0;
  let flaggedHunks = 0;
  let pendingHunks = 0;

  const hunks = rawHunks.map((h) => {
    filesSet.add(h.file);
    const v =
      savedVerdicts[h.fingerprint] === 'accepted' || savedVerdicts[h.fingerprint] === 'flagged'
        ? savedVerdicts[h.fingerprint]
        : 'pending';
    if (v === 'accepted') acceptedHunks += 1;
    else if (v === 'flagged') flaggedHunks += 1;
    else pendingHunks += 1;
    return {
      ...h,
      verdict: v,
    };
  });

  const touchedExportHints = [];
  for (const relFile of filesSet) {
    try {
      const fullFile = resolveContainedRepoFile(canonRepo, relFile);
      if (!fullFile) continue;
      const fSt = assertNotSymlink(fullFile);
      if (!fSt || !fSt.isFile()) continue;
      const src = readFileSync(fullFile, 'utf8');
      const spans = extractFileSymbolSpans(src).filter((s) => s.exported);
      if (spans.length === 0) continue;
      const fileHunks = hunks.filter((h) => h.file === relFile);
      for (const s of spans) {
        const overlaps = fileHunks.some((h) => {
          const hStart = h.newStart;
          const hEnd = h.newStart + Math.max(1, h.newLines) - 1;
          return hStart <= s.endLine && hEnd >= s.startLine;
        });
        if (overlaps) {
          touchedExportHints.push(`+export function ${s.name}`);
        }
      }
    } catch {}
  }

  const callerProbeDiff =
    touchedExportHints.length > 0
      ? `${diffText}\n${touchedExportHints.join('\n')}\n`
      : diffText;
  const externalCallers = discoverExternalCallers(callerProbeDiff, {
    repo: canonRepo,
    scope: [...filesSet],
    maxBytes: 12_288,
  });
  const gateManifest = readGateManifestSummary(canonRepo);
  const lastReport = readReportSummary(boosterDir, exists);

  const counts = {
    filesChanged: filesSet.size,
    totalHunks: hunks.length,
    acceptedHunks,
    flaggedHunks,
    pendingHunks,
  };

  const reportFailedCount =
    lastReport?.failed &&
    typeof lastReport.failed === 'object' &&
    !Array.isArray(lastReport.failed)
      ? Object.keys(lastReport.failed).length
      : 0;

  const readyForSignOff =
    hunks.length > 0 &&
    flaggedHunks === 0 &&
    pendingHunks === 0 &&
    !lastReport?.compromised &&
    reportFailedCount === 0;

  return {
    ok: true,
    repo: canonRepo,
    base: ref,
    emptyDiff: hunks.length === 0,
    readyForSignOff,
    counts,
    hunks,
    externalCallers: {
      symbols: externalCallers.symbols,
      callers: externalCallers.callers.slice(0, 40),
    },
    gateManifest,
    report: lastReport
      ? {
          runId: lastReport.runId ?? null,
          merged: Array.isArray(lastReport.merged) ? lastReport.merged : [],
          failed: lastReport.failed ?? {},
          compromised: lastReport.compromised ?? null,
          economics: lastReport.economics ?? null,
        }
      : null,
  };
}

/**
 * Render a GitHub-flavored Markdown P6 Sign-Off Evidence Dossier suitable for PR descriptions.
 */
export function formatAcceptanceDossierMarkdown(dossier = {}) {
  const counts = dossier.counts ?? {
    filesChanged: 0,
    totalHunks: 0,
    acceptedHunks: 0,
    flaggedHunks: 0,
    pendingHunks: 0,
  };
  const statusLabel = dossier.readyForSignOff ? 'READY FOR P6 MERGE SIGN-OFF' : 'REVIEW IN PROGRESS';
  const lines = [
    `# ADLC P6 Sign-Off Evidence Dossier`,
    '',
    `- **Status:** ${statusLabel}`,
    `- **Base Ref:** \`${dossier.base || 'HEAD'}\``,
    `- **Files Changed:** ${counts.filesChanged} | **Hunks:** ${counts.acceptedHunks}/${counts.totalHunks} accepted (${counts.flaggedHunks} flagged, ${counts.pendingHunks} pending)`,
  ];

  if (dossier.report?.runId) {
    lines.push(
      `- **Fleet Run:** \`${dossier.report.runId}\` (${(dossier.report.merged ?? []).length} merged, ${Object.keys(dossier.report.failed ?? {}).length} failed)`
    );
  }
  if (dossier.gateManifest?.totalEntries > 0) {
    const gatePairs = Object.entries(dossier.gateManifest.gatesByType || {})
      .map(([g, n]) => `${g}:${n}`)
      .join(', ');
    lines.push(`- **Gate Manifest Entries:** ${dossier.gateManifest.totalEntries} (${gatePairs})`);
  }

  const callers = dossier.externalCallers?.callers ?? [];
  lines.push('', '## External Caller Blast Radius', '');
  if (callers.length === 0) {
    lines.push('No external caller sites outside modified exports detected.');
  } else {
    for (const c of callers.slice(0, 15)) {
      lines.push(`- \`${c.file}:${c.line}\` (\`${c.symbol}\`): \`${c.snippet}\``);
    }
  }

  lines.push('', '## Hunk Sign-Off Checklist', '');
  const hunks = Array.isArray(dossier.hunks) ? dossier.hunks : [];
  if (hunks.length === 0) {
    lines.push('_Empty diff — zero hunks against base._');
  } else {
    for (const h of hunks) {
      const box = h.verdict === 'accepted' ? '[x]' : h.verdict === 'flagged' ? '[!]' : '[ ]';
      lines.push(
        `- ${box} **${h.id}** \`${h.file}:${h.newStart}\` (+${h.addedCount}/-${h.removedCount}, \`${h.fingerprint.slice(0, 10)}\`) — _${h.verdict}_`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
