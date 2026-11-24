// Interactive Terminal TUI for ADLC P6 Hunk-Level Sign-Off (`agb accept`).
//
// Separation of concerns: pure diff/caller/manifest logic lives in `lib/accept.mjs`;
// this module handles ANSI/OSC-8 terminal rendering and raw-mode keypress navigation.

import { join } from 'node:path';
import { ANSI } from './tui.mjs';
import { formatOsc8FileLink, sanitizeOscField } from './terminal-osc.mjs';
import {
  formatAcceptanceDossierMarkdown,
  loadAcceptVerdicts,
  saveAcceptVerdicts,
  writeAcceptDossierFile,
} from './accept.mjs';

function recomputeCounts(dossier) {
  const hunks = Array.isArray(dossier.hunks) ? dossier.hunks : [];
  let acceptedHunks = 0;
  let flaggedHunks = 0;
  let pendingHunks = 0;
  const files = new Set();
  for (const h of hunks) {
    files.add(h.file);
    if (h.verdict === 'accepted') acceptedHunks += 1;
    else if (h.verdict === 'flagged') flaggedHunks += 1;
    else pendingHunks += 1;
  }
  dossier.counts = {
    filesChanged: files.size,
    totalHunks: hunks.length,
    acceptedHunks,
    flaggedHunks,
    pendingHunks,
  };
  dossier.readyForSignOff =
    flaggedHunks === 0 && pendingHunks === 0 && !dossier.report?.compromised;
}

/**
 * Render a single deterministic TUI frame for `agb accept`.
 */
export function renderAcceptTuiFrame(
  dossier,
  { selectedIndex = 0, repo = null, osc8 = false, cols = 100, notice = '' } = {}
) {
  const width = Math.max(60, Math.min(cols || 100, 120));
  const hunks = Array.isArray(dossier?.hunks) ? dossier.hunks : [];
  const counts = dossier?.counts ?? {
    filesChanged: 0,
    totalHunks: hunks.length,
    acceptedHunks: 0,
    flaggedHunks: 0,
    pendingHunks: hunks.length,
  };

  const safeBase = sanitizeOscField(String(dossier?.base || 'HEAD')) || 'HEAD';
  const lines = [];
  const hLine = '─'.repeat(width - 2);
  lines.push(`${ANSI.cyan}╭${hLine}╮${ANSI.reset}`);
  const readyBadge = dossier?.readyForSignOff
    ? `${ANSI.brightGreen}${ANSI.bold}✓ P6 SIGN-OFF READY${ANSI.reset}`
    : `${ANSI.brightYellow}${ANSI.bold}⚖ REVIEWING (${counts.acceptedHunks}/${counts.totalHunks} accepted, ${counts.flaggedHunks} flagged)${ANSI.reset}`;
  lines.push(
    `  ${ANSI.brightCyan}${ANSI.bold}ADLC P6 SIGN-OFF WORKBENCH${ANSI.reset}  │  Base: ${ANSI.bold}${safeBase}${ANSI.reset}  │  ${readyBadge}`
  );
  const callerCount = dossier?.externalCallers?.callers?.length ?? 0;
  const gateCount = dossier?.gateManifest?.totalEntries ?? 0;
  lines.push(
    `  Files: ${counts.filesChanged}  │  External Callers: ${callerCount}  │  Gate Manifest Entries: ${gateCount}`
  );
  lines.push(`${ANSI.cyan}╰${hLine}╯${ANSI.reset}`);

  if (hunks.length === 0) {
    lines.push('');
    lines.push(`  ${ANSI.dim}Empty diff against ${safeBase} — nothing to sign off.${ANSI.reset}`);
  } else {
    const idx = Math.max(0, Math.min(hunks.length - 1, selectedIndex));
    const sel = hunks[idx];
    const safeFile = sanitizeOscField(String(sel.file ?? ''));
    const safeId = sanitizeOscField(String(sel.id ?? 'H'));
    const locLabel = `${safeFile}:${sel.newStart}`;
    const linkedLoc =
      osc8 && repo && safeFile
        ? formatOsc8FileLink(join(repo, safeFile), locLabel, { line: sel.newStart, enabled: true })
        : locLabel;
    const verdictBadge =
      sel.verdict === 'accepted'
        ? `${ANSI.brightGreen}[ACCEPTED]${ANSI.reset}`
        : sel.verdict === 'flagged'
        ? `${ANSI.brightRed}[FLAGGED FOR RESCUE]${ANSI.reset}`
        : `${ANSI.yellow}[PENDING]${ANSI.reset}`;

    lines.push('');
    lines.push(
      `  ${ANSI.bold}Hunk ${idx + 1}/${hunks.length} (${safeId})${ANSI.reset}  ${verdictBadge}  ${ANSI.cyan}${linkedLoc}${ANSI.reset}  ${ANSI.dim}(+${sel.addedCount}/-${sel.removedCount})${ANSI.reset}`
    );
    lines.push(`  ${ANSI.gray}${sanitizeOscField(String(sel.header ?? ''))}${ANSI.reset}`);
    for (const dl of (sel.lines ?? []).slice(0, 18)) {
      const rawLine = String(dl ?? '');
      const color = rawLine.startsWith('+')
        ? ANSI.green
        : rawLine.startsWith('-')
        ? ANSI.red
        : ANSI.reset;
      const safeDl = sanitizeOscField(rawLine.replace(/\t/g, '  '));
      lines.push(`    ${color}${safeDl}${ANSI.reset}`);
    }
    if ((sel.lines?.length ?? 0) > 18) {
      lines.push(`    ${ANSI.dim}… (${sel.lines.length - 18} more line(s))${ANSI.reset}`);
    }
  }

  if (notice) {
    lines.push('');
    lines.push(`  ${ANSI.brightYellow}${ANSI.bold}⚡ ${sanitizeOscField(String(notice))}${ANSI.reset}`);
  }

  lines.push('');
  lines.push(
    `  ${ANSI.dim}[j/k] Select Hunk · [a] Accept · [f] Flag · [d] Export Dossier · [q] Quit (human merges manually)${ANSI.reset}`
  );
  return lines;
}

/**
 * Run the interactive `agb accept` hunk review session.
 */
export async function runInteractiveAcceptTui(
  dossier,
  {
    repo = dossier?.repo || process.cwd(),
    stdin = process.stdin,
    stdout = process.stdout,
    osc8 = Boolean(stdout?.isTTY),
  } = {}
) {
  let selectedIndex = 0;
  let notice = '';
  let exportedPath = null;
  let cleaned = false;
  const verdicts = loadAcceptVerdicts(repo);

  const render = () => {
    if (cleaned) return;
    const frame = renderAcceptTuiFrame(dossier, {
      selectedIndex,
      repo,
      osc8,
      cols: stdout?.columns || 100,
      notice,
    });
    stdout.write(ANSI.cursorHome + frame.join('\n') + '\n\x1b[J');
  };

  return new Promise((resolvePromise) => {
    let onData = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        stdout.write(ANSI.cursorShow + ANSI.altBufferLeave);
      } catch {}
      if (onData && stdin?.removeListener) {
        try { stdin.removeListener('data', onData); } catch {}
      }
      if (stdin?.isTTY && typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch {}
      }
      if (typeof stdin?.pause === 'function') {
        try { stdin.pause(); } catch {}
      }
    };

    const finish = () => {
      cleanup();
      resolvePromise({
        ok: true,
        readyForSignOff: Boolean(dossier.readyForSignOff),
        counts: dossier.counts,
        dossierPath: exportedPath,
      });
    };

    try {
      stdout.write(ANSI.altBufferEnter + ANSI.cursorHide);
    } catch {}

    onData = (chunk) => {
      if (cleaned) return;
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const hunks = dossier.hunks ?? [];

      for (let i = 0; i < str.length; i++) {
        if (str.startsWith('\x1b[B', i)) {
          if (hunks.length > 0) selectedIndex = Math.min(hunks.length - 1, selectedIndex + 1);
          i += 2;
          render();
          continue;
        }
        if (str.startsWith('\x1b[A', i)) {
          if (hunks.length > 0) selectedIndex = Math.max(0, selectedIndex - 1);
          i += 2;
          render();
          continue;
        }
        const ch = str[i];
        if (ch === 'q' || ch === 'Q' || ch === '\u0003') {
          finish();
          return;
        }
        if (ch === 'j') {
          if (hunks.length > 0) selectedIndex = Math.min(hunks.length - 1, selectedIndex + 1);
          render();
        } else if (ch === 'k') {
          if (hunks.length > 0) selectedIndex = Math.max(0, selectedIndex - 1);
          render();
        } else if ((ch === 'a' || ch === 'A') && hunks[selectedIndex]) {
          const h = hunks[selectedIndex];
          h.verdict = h.verdict === 'accepted' ? 'pending' : 'accepted';
          if (h.verdict === 'pending') delete verdicts[h.fingerprint];
          else verdicts[h.fingerprint] = h.verdict;
          saveAcceptVerdicts(repo, verdicts);
          recomputeCounts(dossier);
          notice = `${h.id} marked ${h.verdict}`;
          if (h.verdict === 'accepted' && selectedIndex < hunks.length - 1) {
            selectedIndex += 1;
          }
          render();
        } else if ((ch === 'f' || ch === 'F') && hunks[selectedIndex]) {
          const h = hunks[selectedIndex];
          h.verdict = h.verdict === 'flagged' ? 'pending' : 'flagged';
          if (h.verdict === 'pending') delete verdicts[h.fingerprint];
          else verdicts[h.fingerprint] = h.verdict;
          saveAcceptVerdicts(repo, verdicts);
          recomputeCounts(dossier);
          notice = `${h.id} marked ${h.verdict} (run 'agb rescue' to remediate)`;
          render();
        } else if (ch === 'd' || ch === 'D') {
          const md = formatAcceptanceDossierMarkdown(dossier);
          exportedPath = writeAcceptDossierFile(repo, md);
          notice = `Exported PR dossier -> ${exportedPath}`;
          render();
        }
      }
    };

    if (stdin?.isTTY && typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch {}
    }
    if (typeof stdin?.resume === 'function') {
      try { stdin.resume(); } catch {}
    }
    if (typeof stdin?.on === 'function') {
      stdin.on('data', onData);
    }
    render();
  });
}
