// Interactive Terminal User Interface (TUI) engine for Antigravity Booster.
// Zero dependencies, pure ESM, ANSI-compatible with graceful fallback.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let TUI_VERSION = '1.2.0';
try {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  if (pkg?.version) TUI_VERSION = pkg.version;
} catch {}

// ANSI styling codes
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',

  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',

  // Cursor & Screen
  cursorHome: '\x1b[H',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  altBufferEnter: '\x1b[?1049h',
  altBufferLeave: '\x1b[?1049l',
};

export const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const PHASE_CONFIG = {
  pending:     { symbol: '·', label: 'PENDING',     color: ANSI.gray,          icon: '·' },
  building:    { symbol: '⚒', label: 'BUILDING',    color: ANSI.brightCyan,    icon: '⚒' },
  gating:      { symbol: '⛩', label: 'GATING',      color: ANSI.brightBlue,    icon: '⛩' },
  prosecuting: { symbol: '⚖', label: 'PROSECUTING', color: ANSI.brightMagenta, icon: '⚖' },
  fixing:      { symbol: '🔧', label: 'FIXING',      color: ANSI.brightYellow,  icon: '🔧' },
  merging:     { symbol: '⇄', label: 'MERGING',     color: ANSI.magenta,       icon: '⇄' },
  merged:      { symbol: '✓', label: 'MERGED',      color: ANSI.brightGreen,   icon: '✓' },
  failed:      { symbol: '✗', label: 'FAILED',      color: ANSI.brightRed,     icon: '✗' },
  blocked:     { symbol: '⛔', label: 'BLOCKED',     color: ANSI.red,           icon: '⛔' },
  paused:      { symbol: '⏸', label: 'PAUSED',      color: ANSI.yellow,        icon: '⏸' },
};

/** Strip ANSI control codes from a string to measure its visible character width. */
export function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Compute visible length of string. */
export function visibleLength(str) {
  return stripAnsi(str).length;
}

/** Pad visible text to exact length, preserving embedded ANSI escape sequences. */
export function padVisible(str, len, align = 'left') {
  const s = String(str ?? '');
  const vlen = visibleLength(s);
  if (vlen >= len) return s;
  const pad = ' '.repeat(len - vlen);
  if (align === 'right') return pad + s;
  if (align === 'center') {
    const left = Math.floor((len - vlen) / 2);
    const right = len - vlen - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  }
  return s + pad;
}

/** Format elapsed milliseconds as HH:MM:SS or MM:SS */
export function formatDuration(ms) {
  if (!ms || ms < 0 || isNaN(ms)) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/** Render a horizontal Unicode/ASCII progress bar */
export function renderProgressBar(current, total, width = 24, filledChar = '█', emptyChar = '░') {
  if (!total || total <= 0) {
    return `${emptyChar.repeat(width)}   0%`;
  }
  const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  const fillCount = Math.min(width, Math.max(0, Math.round((current / total) * width)));
  const emptyCount = Math.max(0, width - fillCount);
  const bar = `${filledChar.repeat(fillCount)}${emptyChar.repeat(emptyCount)}`;
  const pctStr = `${pct}%`.padStart(4);
  return `${bar} ${pctStr}`;
}

/** Format a single pool gauge (e.g., gemini-flash [████░░░░] 4/8) */
export function renderPoolGauge(name, current, cap, requests = 0, width = 8) {
  const safeCap = cap && cap > 0 ? cap : 1;
  const safeCurrent = current || 0;
  const ratio = Math.min(1, safeCurrent / safeCap);
  const fill = Math.round(ratio * width);
  const empty = width - fill;

  let color = ANSI.green;
  if (ratio >= 0.8) color = ANSI.brightRed;
  else if (ratio >= 0.5) color = ANSI.yellow;

  const bar = `${color}${'█'.repeat(fill)}${ANSI.gray}${'░'.repeat(empty)}${ANSI.reset}`;
  const countStr = `${safeCurrent}/${cap ?? '?'}`;
  const reqStr = requests > 0 ? ` ${ANSI.dim}(${requests} reqs)${ANSI.reset}` : '';
  return `${ANSI.bold}${name.padEnd(13)}${ANSI.reset} [${bar}] ${countStr.padStart(5)}${reqStr}`;
}

/**
 * Render the full AGB TUI Dashboard into an array of formatted terminal lines.
 */
export function renderTUIDashboard(state, {
  cols = (process.stdout.columns || 100),
  spinnerIndex = 0,
  compact = false,
  now = Date.now(),
  selectedTicketId = null,
  activeTab = 'activity',
  filterText = '',
  filterMode = false,
  streamLines = [],
  diffText = '',
  prosecutorFindings = [],
  controlNotice = '',
} = {}) {
  const width = Math.max(60, Math.min(cols, 120));
  const lines = [];
  const reset = ANSI.reset;
  const bold = ANSI.bold;
  const dim = ANSI.dim;
  const gray = ANSI.gray;
  const cyan = ANSI.cyan;
  const brightCyan = ANSI.brightCyan;
  const blue = ANSI.blue;
  const magenta = ANSI.magenta;
  const yellow = ANSI.yellow;
  const brightYellow = ANSI.brightYellow;
  const green = ANSI.green;
  const brightGreen = ANSI.brightGreen;
  const red = ANSI.red;
  const brightRed = ANSI.brightRed;

  const spinner = SPINNERS[spinnerIndex % SPINNERS.length];

  // Calculate stats
  const ticketsList = Array.from(state.tickets?.values?.() ?? []);
  const totalTickets = ticketsList.length;
  const mergedCount = state.merged?.size ?? ticketsList.filter(t => t.phase === 'merged').length;
  const failedCount = state.failed?.size ?? ticketsList.filter(t => t.phase === 'failed').length;
  const inFlightCount = ticketsList.filter(t => ['building', 'gating', 'prosecuting', 'fixing', 'merging'].includes(t.phase)).length;
  const pendingCount = ticketsList.filter(t => !t.phase || t.phase === 'pending').length;

  const filterNeedle = String(filterText ?? '').trim().toLowerCase();
  const displayedTickets = filterNeedle
    ? ticketsList.filter((t) =>
        [t.id, t.phase, t.model, t.detail, t.error].some((v) =>
          String(v ?? '').toLowerCase().includes(filterNeedle)
        )
      )
    : ticketsList;

  const isCockpitMode = Boolean(
    selectedTicketId !== null ||
      activeTab !== 'activity' ||
      filterText ||
      filterMode ||
      controlNotice ||
      state.schedulerPaused
  );

  const startTime = state.startedAt ? new Date(state.startedAt).getTime() : now;
  const elapsedMs = Math.max(0, now - startTime);
  const elapsedStr = formatDuration(elapsedMs);

  // Status badge
  let statusBadge = state.schedulerPaused
    ? `${yellow}${bold}⏸ PAUSED${reset}`
    : `${yellow}${spinner} RUNNING${reset}`;
  if (state.done) {
    if (failedCount > 0 || state.report?.compromised) {
      statusBadge = `${brightRed}${bold}✗ FAILED (${failedCount} failed)${reset}`;
    } else {
      statusBadge = `${brightGreen}${bold}✓ CONVERGED (All merged)${reset}`;
    }
  }

  // 1. Box Header
  const hLine = '─'.repeat(width - 2);

  lines.push(`${cyan}╭${hLine}╮${reset}`);

  // Title Row
  const titleLeft = ` ${brightCyan}${bold}⚡ ANTIGRAVITY BOOSTER${reset} ${dim}TUI Dashboard${reset}`;
  const titleRight = `${dim}v${TUI_VERSION}${reset} `;
  const titlePadding = width - 2 - visibleLength(titleLeft) - visibleLength(titleRight);
  lines.push(`${cyan}│${reset}${titleLeft}${' '.repeat(Math.max(1, titlePadding))}${titleRight}${cyan}│${reset}`);

  lines.push(`${cyan}├${hLine}┤${reset}`);

  // Info Row: Run ID, Status, Elapsed, Target
  const runIdStr = state.runId ? String(state.runId).slice(0, 28) : 'active';
  const targetRepo = state.repo ? (state.repo.length > 30 ? '...' + state.repo.slice(-27) : state.repo) : 'current workspace';

  const infoRow1 = `  ${bold}Run ID:${reset} ${cyan}${runIdStr}${reset}  │  ${bold}Status:${reset} ${statusBadge}  │  ${bold}Elapsed:${reset} ${elapsedStr}`;
  lines.push(`${cyan}│${reset}${padVisible(infoRow1, width - 2)}${cyan}│${reset}`);

  const infoRow2 = `  ${bold}Target:${reset} ${dim}${targetRepo}${reset}  │  ${bold}Tickets:${reset} ${mergedCount}/${totalTickets} Merged (${inFlightCount} active, ${pendingCount} pending)`;
  lines.push(`${cyan}│${reset}${padVisible(infoRow2, width - 2)}${cyan}│${reset}`);

  // Overall Progress Bar
  const progBar = renderProgressBar(mergedCount, totalTickets, Math.min(30, width - 35), '█', '░');
  const progLine = `  ${bold}Progress:${reset} [${brightGreen}${progBar}${reset}]`;
  lines.push(`${cyan}│${reset}${padVisible(progLine, width - 2)}${cyan}│${reset}`);

  lines.push(`${cyan}╰${hLine}╯${reset}`);
  if (!state.done && (state.runwayWarning || state.runway?.willExhaust)) {
    const rawMsg = state.runway?.recommendation
      ? `!RUNWAY: ${state.runway.recommendation}`
      : `!RUNWAY: Projected pool quota exhaustion in wave ${state.runway?.exhaustingWave ?? '?'}`;
    const maxLen = Math.max(20, width - 6);
    const trimmedMsg = rawMsg.length > maxLen ? `${rawMsg.slice(0, maxLen - 3)}...` : rawMsg;
    lines.push(`  ${brightYellow}${bold}⚠ ${trimmedMsg}${reset}`);
  }
  lines.push('');

  // 2. Quota Pools Section
  if (state.pools && (state.pools.inFlight || typeof state.pools === 'object')) {
    lines.push(`${bold}⚙ MODEL QUOTA POOLS${reset}`);
    const inFlight = state.pools.inFlight || state.pools;
    const caps = state.pools.caps || {};
    const requests = state.pools.requests || {};

    const poolEntries = Object.entries(inFlight);
    if (poolEntries.length > 0) {
      for (const [pool, count] of poolEntries) {
        const cap = caps[pool] ?? 8;
        const req = requests[pool] ?? 0;
        lines.push('  ' + renderPoolGauge(pool, count, cap, req, Math.min(16, Math.floor((width - 40) / 2))));
      }
    } else {
      lines.push(`  ${dim}(no active pool telemetry)${reset}`);
    }
    lines.push('');
  }

  // 3. Ticket Matrix Table
  const filterBadge =
    filterMode || filterText
      ? `  ${brightCyan}[/${filterText}${filterMode ? '▏' : ''}]${reset} ${dim}(${displayedTickets.length}/${totalTickets})${reset}`
      : '';
  lines.push(`${bold}📋 TICKETS (${totalTickets})${reset}${filterBadge}`);

  const idColWidth = 8;
  const phaseColWidth = 14;
  const modelColWidth = Math.min(26, Math.max(16, Math.floor((width - 45) * 0.4)));
  const strikeColWidth = 8;
  const detailColWidth = Math.max(20, width - idColWidth - phaseColWidth - modelColWidth - strikeColWidth - 10);

  const tableHeader = `  ${dim}${padVisible('TICKET', idColWidth)} ${padVisible('PHASE', phaseColWidth)} ${padVisible('MODEL', modelColWidth)} ${padVisible('STRIKES', strikeColWidth)} DETAIL${reset}`;
  lines.push(tableHeader);
  lines.push(`  ${gray}${'─'.repeat(width - 4)}${reset}`);

  if (ticketsList.length === 0) {
    lines.push(`  ${dim}Waiting for tickets to initialize...${reset}`);
  } else if (displayedTickets.length === 0) {
    lines.push(`  ${dim}No tickets match filter "${filterText}"${reset}`);
  } else {
    for (const t of displayedTickets) {
      const isSelected = selectedTicketId !== null && t.id === selectedTicketId;
      const cfg = PHASE_CONFIG[t.phase] || { symbol: '?', label: String(t.phase || 'unknown').toUpperCase(), color: reset };
      const phaseBadge = `${cfg.color}${cfg.symbol} ${cfg.label}${reset}`;

      const modelStr = t.model ? (t.model.length > modelColWidth ? t.model.slice(0, modelColWidth - 1) + '…' : t.model) : (t.phase === 'pending' ? dim + 'queued' + reset : dim + '-' + reset);

      let strikeStr = `${t.strikes ?? 0}/2`;
      if (t.strikes > 0) {
        strikeStr = `${yellow}${strikeStr}${reset}`;
      } else {
        strikeStr = `${dim}${strikeStr}${reset}`;
      }

      let detailText = t.detail || '';
      if (t.error) {
        const errLine = String(t.error).split('\n')[0].trim();
        detailText = `${brightRed}${errLine}${reset}`;
      } else if (t.phase === 'merged' && !t.detail) {
        detailText = `${green}✓ Merged to base branch${reset}`;
      } else if (t.phase === 'merged') {
        detailText = `${green}✓ ${t.detail}${reset}`;
      } else if (t.phase === 'building' && !t.detail) {
        detailText = `${cyan}Building in isolated worktree...${reset}`;
      } else if (t.phase === 'gating' && !t.detail) {
        detailText = `${blue}Executing build & test gates...${reset}`;
      } else if (t.phase === 'prosecuting' && !t.detail) {
        detailText = `${magenta}Cross-model refutation review...${reset}`;
      } else if (t.phase === 'fixing' && !t.detail) {
        detailText = `${yellow}Executing consensus / regeneration fix...${reset}`;
      }

      if (visibleLength(detailText) > detailColWidth) {
        const prefixMatch = detailText.match(/^(\x1b\[[0-9;]*m)+/);
        const prefix = prefixMatch ? prefixMatch[0] : '';
        const plain = stripAnsi(detailText).slice(0, detailColWidth - 1) + '…';
        detailText = prefix ? `${prefix}${plain}${reset}` : plain;
      }

      const rowPrefix = isSelected ? `${brightCyan}${bold}▸${reset} ` : '  ';
      const idCell = isSelected
        ? `${brightCyan}${bold}${padVisible(t.id, idColWidth)}${reset}`
        : `${bold}${padVisible(t.id, idColWidth)}${reset}`;
      const row = `${rowPrefix}${idCell} ${padVisible(phaseBadge, phaseColWidth)} ${padVisible(modelStr, modelColWidth)} ${padVisible(strikeStr, strikeColWidth)} ${detailText}`;
      lines.push(row);
    }
  }
  lines.push('');

  // 4. Flight Deck Tabs / Live Event Stream Activity
  if (isCockpitMode) {
    const tabDefs = [
      { key: 'activity', label: '[1] Activity' },
      { key: 'stream', label: '[2] Stream' },
      { key: 'diff', label: '[3] Diff' },
      { key: 'prosecutor', label: '[4] Prosecutor' },
    ];
    const renderedTabs = tabDefs
      .map((tb) =>
        tb.key === activeTab
          ? `${brightCyan}${bold}${ANSI.underline}${tb.label}${reset}`
          : `${dim}${tb.label}${reset}`
      )
      .join('  ');
    const targetSuffix = selectedTicketId ? `  ${dim}— ${selectedTicketId}${reset}` : '';
    lines.push(`  ${renderedTabs}${targetSuffix}`);
    lines.push(`  ${gray}${'─'.repeat(width - 4)}${reset}`);

    if (!compact) {
      if (activeTab === 'stream') {
        if (Array.isArray(streamLines) && streamLines.length > 0) {
          for (const sl of streamLines.slice(-12)) {
            lines.push(`  ${cyan}${String(sl)}${reset}`);
          }
        } else {
          lines.push(`  ${dim}(no live step stream${selectedTicketId ? ` for ${selectedTicketId}` : ''})${reset}`);
        }
      } else if (activeTab === 'diff') {
        const rawDiff = String(diffText ?? '');
        if (rawDiff.trim().length > 0) {
          for (const dl of rawDiff.split('\n').slice(0, 16)) {
            let color = reset;
            if (dl.startsWith('+++') || dl.startsWith('---') || dl.startsWith('diff ') || dl.startsWith('@@')) {
              color = cyan;
            } else if (dl.startsWith('+')) {
              color = green;
            } else if (dl.startsWith('-')) {
              color = red;
            }
            lines.push(`  ${color}${dl}${reset}`);
          }
        } else {
          lines.push(`  ${dim}(no diff available${selectedTicketId ? ` for ${selectedTicketId}` : ''})${reset}`);
        }
      } else if (activeTab === 'prosecutor') {
        const selTicket = selectedTicketId ? state.tickets?.get?.(selectedTicketId) : null;
        if (Array.isArray(prosecutorFindings) && prosecutorFindings.length > 0) {
          for (const f of prosecutorFindings.slice(0, 12)) {
            if (typeof f === 'string') {
              lines.push(`  ${brightRed}${f}${reset}`);
            } else if (f && typeof f === 'object') {
              const sev = String(f.severity ?? 'finding').toUpperCase();
              const loc = f.file ? `${f.file}: ` : '';
              lines.push(`  ${brightRed}[${sev}]${reset} ${loc}${f.claim ?? f.message ?? JSON.stringify(f)}`);
            }
          }
        } else if (selTicket?.error) {
          for (const el of String(selTicket.error).split('\n').slice(0, 12)) {
            lines.push(`  ${brightRed}${el}${reset}`);
          }
        } else {
          lines.push(`  ${dim}(no prosecutor findings${selectedTicketId ? ` for ${selectedTicketId}` : ''})${reset}`);
        }
      } else {
        const allEvents = Array.isArray(state.events) ? state.events : [];
        const filteredEvents = selectedTicketId
          ? allEvents.filter((e) => e.ticket === selectedTicketId)
          : allEvents;
        const recent = (filteredEvents.length > 0 ? filteredEvents : allEvents).slice(-6);
        if (recent.length === 0) {
          lines.push(`  ${dim}(no recent activity)${reset}`);
        } else {
          for (const evt of recent) {
            const timeStr = evt.ts ? new Date(evt.ts).toLocaleTimeString() : '';
            let msg = '';
            if (evt.type === 'phase') {
              const cfg = PHASE_CONFIG[evt.to] || { color: reset, symbol: '•' };
              msg = `${bold}${evt.ticket}${reset} → ${cfg.color}${cfg.symbol} ${evt.to}${reset} ${dim}${evt.detail || ''}${reset}`;
            } else if (evt.type === 'strike') {
              msg = `${yellow}⚠ STRIKE on ${evt.ticket}${reset} (strike ${evt.strikes}): ${red}${String(evt.error || '').split('\n')[0]}${reset}`;
            } else if (evt.type === 'pool') {
              msg = `${dim}Pool telemetry synchronized${reset}`;
            } else if (evt.type === 'report') {
              msg = `${brightGreen}${bold}★ Run finalized — ${evt.report?.merged?.length ?? 0} merged, ${Object.keys(evt.report?.failed ?? {}).length} failed${reset}`;
            } else {
              msg = `${dim}${JSON.stringify(evt)}${reset}`;
            }
            lines.push(`  ${gray}[${timeStr}]${reset} ${msg}`);
          }
        }
      }
      lines.push('');
    }
  } else if (!compact && state.events && state.events.length > 0) {
    lines.push(`${bold}📜 RECENT ACTIVITY${reset}`);
    const recent = state.events.slice(-6);
    for (const evt of recent) {
      const timeStr = evt.ts ? new Date(evt.ts).toLocaleTimeString() : '';
      let msg = '';
      if (evt.type === 'phase') {
        const cfg = PHASE_CONFIG[evt.to] || { color: reset, symbol: '•' };
        msg = `${bold}${evt.ticket}${reset} → ${cfg.color}${cfg.symbol} ${evt.to}${reset} ${dim}${evt.detail || ''}${reset}`;
      } else if (evt.type === 'strike') {
        msg = `${yellow}⚠ STRIKE on ${evt.ticket}${reset} (strike ${evt.strikes}): ${red}${String(evt.error || '').split('\n')[0]}${reset}`;
      } else if (evt.type === 'pool') {
        msg = `${dim}Pool telemetry synchronized${reset}`;
      } else if (evt.type === 'report') {
        msg = `${brightGreen}${bold}★ Run finalized — ${evt.report?.merged?.length ?? 0} merged, ${Object.keys(evt.report?.failed ?? {}).length} failed${reset}`;
      } else {
        msg = `${dim}${JSON.stringify(evt)}${reset}`;
      }
      lines.push(`  ${gray}[${timeStr}]${reset} ${msg}`);
    }
    lines.push('');
  }

  if (controlNotice) {
    lines.push(`  ${brightYellow}${bold}⚡ ${controlNotice}${reset}`);
    lines.push('');
  }

  // 5. Final Report Summary (when done)
  if (state.done && state.report) {
    lines.push(`${bold}📊 EXECUTION SUMMARY${reset}`);
    const rep = state.report;
    const mergedList = Array.isArray(rep.merged) ? rep.merged.join(', ') : 'none';
    const failedKeys = rep.failed && typeof rep.failed === 'object' ? Object.keys(rep.failed) : [];

    lines.push(`  ${green}✓ Merged (${rep.merged?.length ?? 0}):${reset} ${mergedList || 'none'}`);
    if (failedKeys.length > 0) {
      lines.push(`  ${red}✗ Failed (${failedKeys.length}):${reset}`);
      for (const fId of failedKeys) {
        lines.push(`    - ${bold}${fId}:${reset} ${red}${rep.failed[fId]}${reset}`);
      }
    }
    if (rep.requests) {
      const reqSummary = Object.entries(rep.requests).map(([m, c]) => `${m}: ${c}`).join('  │  ');
      lines.push(`  ${dim}Model requests: ${reqSummary}${reset}`);
    }
    lines.push('');
  }

  // 6. Interactive Controls Footer
  const pulseStatus = (state.paused || state.schedulerPaused)
    ? `${yellow}[PAUSED]${reset}`
    : `${cyan}${spinner} Live (every frame)${reset}`;
  if (isCockpitMode) {
    const cockpitHelp = `${dim}j/k select · 1-4 tabs · p pause · x abort · / filter · Enter rescue · q quit${reset}`;
    lines.push(`  ${cockpitHelp}  ${gray}│${reset}  ${pulseStatus}`);
  } else {
    const footerHelp = ` ${dim}[q] Quit  [r] Refresh  [c] ${compact ? 'Expand' : 'Compact'}  [space] ${state.paused ? 'Resume' : 'Pause'}${reset}`;
    lines.push(`  ${footerHelp}  ${gray}│${reset}  ${pulseStatus}`);
  }

  return lines;
}
