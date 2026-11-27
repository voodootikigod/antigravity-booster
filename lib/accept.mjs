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

const SCREENSHOT_MIMES = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
const MAX_INLINE_PREVIEW_BYTES = 256 * 1024;

function readBrowserEvidenceSummary(canonRepo, boosterDir, exists) {
  if (!exists) return null;
  const evPath = join(boosterDir, 'browser-evidence.json');
  const st = assertNotSymlink(evPath);
  if (!st || !st.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(evPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rawShots = Array.isArray(parsed.screenshots) ? parsed.screenshots : [];
    const screenshots = rawShots.slice(0, 8).map((shot) => {
      const relPath = typeof shot?.path === 'string' ? shot.path : '';
      let dataUri = null;
      if (relPath && !isAbsolute(relPath) && !relPath.includes('..')) {
        try {
          const fullShot = resolve(canonRepo, relPath);
          const shotSt = assertNotSymlink(fullShot);
          const mime = SCREENSHOT_MIMES[String(shot?.ext || '').toLowerCase()];
          if (shotSt && shotSt.isFile() && shotSt.size > 0 && shotSt.size <= MAX_INLINE_PREVIEW_BYTES && mime) {
            dataUri = `data:${mime};base64,${readFileSync(fullShot).toString('base64')}`;
          }
        } catch {}
      }
      return {
        name: String(shot?.name || ''),
        path: relPath,
        bytes: Number(shot?.bytes) || 0,
        ...(dataUri ? { dataUri } : {}),
      };
    });
    return {
      ok: Boolean(parsed.ok),
      enforced: Boolean(parsed.enforced),
      advisory: Boolean(parsed.advisory),
      ticketId: parsed.ticketId ?? null,
      url: parsed.url ?? null,
      routes: Array.isArray(parsed.routes) ? parsed.routes : [],
      consoleErrors: Array.isArray(parsed.consoleErrors) ? parsed.consoleErrors : [],
      serverErrors: Array.isArray(parsed.serverErrors) ? parsed.serverErrors : [],
      screenshots,
    };
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
  const browserEvidence = readBrowserEvidenceSummary(canonRepo, boosterDir, exists);

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
    browserEvidence,
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
  if (dossier.browserEvidence) {
    const bev = dossier.browserEvidence;
    const modeStr = bev.enforced ? 'enforced' : 'advisory';
    lines.push(
      `- **Browser Prosecutor (${modeStr}):** ${bev.ok ? 'PASS' : 'FAIL'} (${(bev.routes ?? []).length} route(s), ${(bev.consoleErrors ?? []).length} console error(s), ${(bev.serverErrors ?? []).length} 5xx/server error(s), ${(bev.screenshots ?? []).length} screenshot(s))`
    );
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

function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a self-contained, zero-CDN interactive HTML P6 Sign-Off Cockpit artifact
 * suitable for Antigravity Web Standalone and Remote Agent Brain previews.
 */
export function formatAcceptanceDossierHtml(dossier = {}) {
  const counts = dossier.counts ?? {
    filesChanged: 0,
    totalHunks: 0,
    acceptedHunks: 0,
    flaggedHunks: 0,
    pendingHunks: 0,
  };
  const ready = Boolean(dossier.readyForSignOff);
  const statusLabel = ready ? 'READY FOR P6 MERGE SIGN-OFF' : 'REVIEW IN PROGRESS';
  const badgeClass = ready ? 'badge-ready' : 'badge-pending';
  const callers = Array.isArray(dossier.externalCallers?.callers) ? dossier.externalCallers.callers : [];
  const hunks = Array.isArray(dossier.hunks) ? dossier.hunks : [];
  const gateEntries = Object.entries(dossier.gateManifest?.gatesByType || {});
  const bev = dossier.browserEvidence ?? null;

  const callerRows = callers.length === 0
    ? '<p class="muted">No external caller sites outside modified exports detected.</p>'
    : `<ul class="caller-list">${callers.slice(0, 20).map((c) => `<li><code>${escapeHtml(c.file)}:${escapeHtml(c.line)}</code> (<code>${escapeHtml(c.symbol)}</code>): <code>${escapeHtml(c.snippet)}</code></li>`).join('')}</ul>`;

  const browserSection = bev
    ? `<h2>Browser Prosecutor (${bev.enforced ? 'Enforced' : 'Advisory'})</h2>
  <div class="stats" style="margin-bottom:8px;">
    <span class="pill ${bev.ok ? 'pill-accepted' : 'pill-flagged'}">${bev.ok ? 'PASS' : 'FAIL'}</span>
    <span>Routes: <strong>${(bev.routes ?? []).length}</strong></span>
    <span>Console Errors: <strong>${(bev.consoleErrors ?? []).length}</strong></span>
    <span>5xx/Server Errors: <strong>${(bev.serverErrors ?? []).length}</strong></span>
  </div>
  ${(bev.screenshots ?? []).length > 0 ? `<div class="shots">${bev.screenshots.map((s) => `<figure class="shot-card">${s.dataUri && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s.dataUri) ? `<img src="${s.dataUri}" alt="${escapeHtml(s.name)}" />` : ''}<figcaption><code>${escapeHtml(s.path || s.name)}</code> (${Number(s.bytes) || 0}B)</figcaption></figure>`).join('')}</div>` : ''}`
    : '';

  const hunkCards = hunks.length === 0
    ? '<p class="muted">Empty diff — zero hunks against base.</p>'
    : hunks
        .map((h) => {
          const verdict = VALID_HUNK_VERDICTS.has(h.verdict) ? h.verdict : 'pending';
          const diffBody = (Array.isArray(h.lines) ? h.lines : [])
            .map((line) => {
              const cls = line.startsWith('+') ? 'ln-add' : line.startsWith('-') ? 'ln-del' : 'ln-ctx';
              return `<span class="${cls}">${escapeHtml(line)}</span>`;
            })
            .join('\n');
          return `<section class="hunk-card" data-verdict="${verdict}">
  <header class="hunk-hdr">
    <div><strong>${escapeHtml(h.id)}</strong> <code>${escapeHtml(h.file)}:${escapeHtml(h.newStart)}</code> <span class="muted">(+${Number(h.addedCount) || 0}/-${Number(h.removedCount) || 0}, ${escapeHtml(String(h.fingerprint || '').slice(0, 10))})</span></div>
    <span class="pill pill-${verdict}">${escapeHtml(verdict)}</span>
  </header>
  <pre class="diff-pre">${diffBody}</pre>
</section>`;
        })
        .join('\n');

  const gateBadges = gateEntries.length === 0
    ? '<span class="muted">No recorded manifest gates</span>'
    : gateEntries.map(([g, n]) => `<span class="pill pill-accepted">${escapeHtml(g)}: ${Number(n) || 0}</span>`).join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ADLC P6 Sign-Off Cockpit — ${escapeHtml(dossier.base || 'HEAD')}</title>
<style>
  :root { color-scheme: dark; --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3; --muted: #8b949e; --green: #3fb950; --amber: #d29922; --red: #f85149; }
  body { margin: 0; padding: 20px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
  .top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0 0 6px 0; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 20px 0 10px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .badge-ready { background: rgba(63,185,80,0.18); color: var(--green); border: 1px solid var(--green); padding: 5px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .badge-pending { background: rgba(210,153,34,0.18); color: var(--amber); border: 1px solid var(--amber); padding: 5px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
  .filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .filters button { background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .filters button.active { border-color: #58a6ff; color: #58a6ff; }
  .hunk-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .hunk-hdr { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .diff-pre { margin: 0; padding: 10px 12px; overflow-x: auto; line-height: 1.45; }
  .ln-add { color: var(--green); display: block; }
  .ln-del { color: var(--red); display: block; }
  .ln-ctx { color: var(--fg); display: block; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill-accepted { background: rgba(63,185,80,0.15); color: var(--green); }
  .pill-flagged { background: rgba(248,81,73,0.15); color: var(--red); }
  .pill-pending { background: rgba(210,153,34,0.15); color: var(--amber); }
  .muted { color: var(--muted); }
  .caller-list { margin: 0; padding-left: 18px; line-height: 1.6; }
  .shots { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .shot-card { margin: 0; padding: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; max-width: 260px; }
  .shot-card img { max-width: 100%; border-radius: 4px; display: block; margin-bottom: 6px; }
  .shot-card figcaption { font-size: 11px; color: var(--muted); word-break: break-all; }
</style>
</head>
<body>
  <div class="top">
    <div>
      <h1>ADLC P6 Sign-Off Evidence Dossier</h1>
      <div class="stats">
        <span>Base: <code>${escapeHtml(dossier.base || 'HEAD')}</code></span>
        <span>Files: <strong>${Number(counts.filesChanged) || 0}</strong></span>
        <span>Hunks: <strong>${Number(counts.acceptedHunks) || 0}/${Number(counts.totalHunks) || 0}</strong> accepted (${Number(counts.flaggedHunks) || 0} flagged, ${Number(counts.pendingHunks) || 0} pending)</span>
      </div>
    </div>
    <span class="${badgeClass}">${statusLabel}</span>
  </div>
  <div><strong>Gate Manifest:</strong> ${gateBadges}</div>
  ${browserSection}
  <h2>External Caller Blast Radius</h2>
  ${callerRows}
  <h2>Hunk Sign-Off Checklist</h2>
  <div class="filters">
    <button type="button" class="active" data-filter="all">All (${hunks.length})</button>
    <button type="button" data-filter="pending">Pending (${Number(counts.pendingHunks) || 0})</button>
    <button type="button" data-filter="flagged">Flagged (${Number(counts.flaggedHunks) || 0})</button>
    <button type="button" data-filter="accepted">Accepted (${Number(counts.acceptedHunks) || 0})</button>
  </div>
  <div id="hunks">${hunkCards}</div>
  <script>
    document.querySelectorAll('.filters button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filters button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const f = btn.getAttribute('data-filter');
        document.querySelectorAll('.hunk-card').forEach((card) => {
          card.style.display = (f === 'all' || card.getAttribute('data-verdict') === f) ? '' : 'none';
        });
      });
    });
  </script>
</body>
</html>
`;
}

/**
 * Atomically write a self-contained P6 HTML cockpit dossier with symlink-ancestor protection.
 */
export function writeAcceptHtmlFile(repo, htmlText, customOutPath = null) {
  const { canonRepo, boosterDir } = resolveSafeBoosterDir(repo);
  let targetPath;
  if (customOutPath) {
    targetPath = resolve(canonRepo, customOutPath);
    const rel = relative(canonRepo, targetPath);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      assertNoSymlinkAncestors(canonRepo, targetPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      assertNoSymlinkAncestors(canonRepo, targetPath);
    } else {
      // External path (e.g. Antigravity Brain artifact directory): find deepest existing
      // real directory so OS root links like macOS /tmp -> /private/tmp work cleanly
      // while rejecting any symlink on targetPath or newly created subdirectories.
      let probe = dirname(targetPath);
      const pendingSegs = [];
      while (!existsSync(probe) && dirname(probe) !== probe) {
        pendingSegs.unshift(probe.slice(dirname(probe).length + 1));
        probe = dirname(probe);
      }
      assertNotSymlink(probe);
      const realExisting = realpathSync(probe);
      let cur = realExisting;
      for (const seg of pendingSegs) {
        cur = join(cur, seg);
        mkdirSync(cur, { recursive: true });
        assertNotSymlink(cur);
      }
      targetPath = join(cur, targetPath.slice(dirname(targetPath).length + 1));
      assertNotSymlink(targetPath);
    }
  } else {
    mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
    assertNotSymlink(boosterDir);
    targetPath = join(boosterDir, 'accept-dossier.html');
    assertNotSymlink(targetPath);
  }
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, String(htmlText ?? ''), { mode: 0o600, flag: 'wx' });
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

export { formatMobileAcceptCard as formatAcceptanceDossierMobile } from './remote-control.mjs';

