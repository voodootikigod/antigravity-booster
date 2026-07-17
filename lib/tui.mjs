import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { TUI, ProcessTerminal, visibleWidth, sliceByColumn, parseKey } from '@earendil-works/pi-tui';
import { renderStatus } from './status.mjs';

// The timeline pane shows ~half a viewport of lines, but every frame used to
// rebuild strings from the whole run history: 12ms/frame at 20k events, and
// growing without bound. Keep only what a viewport could ever reach.
const MAX_EVENTS = 2000;
const MIN_COLS = 80;
const MIN_ROWS = 24;

// parseKey covers CSI ~ forms for pageUp/pageDown but not the alternate
// home/end encodings, which readline's keypress events did handle.
const KEY_FALLBACK = { '\x1b[1~': 'home', '\x1b[7~': 'home', '\x1b[4~': 'end', '\x1b[8~': 'end' };

export function stripAnsi(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[\u001B\u009B]\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '') // CSI
    .replace(/[\u001B\u009B]\][^\u0007\u001B]*(?:\u0007|[\u001B\u009B]\\)/g, '') // OSC (ends with BEL or ST)
    .replace(/[\u001B\u009B]P[^\u001B]*(?:[\u001B\u009B]\\)/g, '') // DCS (ends with ST)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); // All other controls (includes stray \x1b, \b, \r)
}

// Measures in terminal columns, not UTF-16 code units. A CJK grapheme occupies
// two columns; counting it as one overflowed the pane, wrapped the line, and
// scrolled the whole frame on every repaint. sliceByColumn is grapheme-aware,
// so it also cannot split a surrogate pair into invalid UTF-8.
export function padTruncate(str, len, align = 'left') {
  str = stripAnsi(str);
  const width = visibleWidth(str);
  if (width > len) {
    // strict=true refuses a wide grapheme that would straddle the boundary,
    // so the result is always <= len columns rather than len + 1.
    const budget = len <= 3 ? len : len - 3;
    const cut = sliceByColumn(str, 0, budget, true);
    const tail = len <= 3 ? '' : '...';
    return cut + tail + ' '.repeat(Math.max(0, budget - visibleWidth(cut)));
  }
  return align === 'right' ? ' '.repeat(len - width) + str : str + ' '.repeat(len - width);
}

export function renderTuiState(state, width, height) {
  const topH = Math.floor(height / 2);
  const bottomH = Math.ceil(height / 2);
  const tktW = Math.floor(width * 0.7);
  const poolW = width - tktW;

  const lines = [];
  const run = state.run || {};
  const tickets = Object.keys(run.tickets || {}).sort();
  const poolKeys = new Set([...Object.keys(run.pools?.inFlight || {}), ...Object.keys(run.pools?.caps || {})]);
  const pools = Array.from(poolKeys).sort();

  const mWidth = Math.max(0, tktW - 48);
  const headerTkt = `${padTruncate('ID', 20)} ${padTruncate('Phase', 15)} ${padTruncate('Strikes', 10, 'right')} ${padTruncate('Model', mWidth)}`;
  const headerPool = `${padTruncate('Pools', poolW - 1)}`;

  lines.push(padTruncate(headerTkt, tktW - 1) + '│' + headerPool);

  const tktViewH = topH - 1;
  for (let i = 0; i < tktViewH; i++) {
    const tIdx = state.ticketScrollTop + i;
    let tLine = ''.padEnd(tktW - 1);
    let inv = false;
    if (tIdx < tickets.length) {
      const id = tickets[tIdx];
      const t = run.tickets[id];
      let strikesVal = t.strikes ?? 0;
      if (Array.isArray(strikesVal)) strikesVal = strikesVal.length;
      tLine = `${padTruncate(id, 20)} ${padTruncate(t.phase, 15)} ${padTruncate(strikesVal, 10, 'right')} ${padTruncate(t.model, mWidth)}`;
      if (tIdx === state.selectedTicketIndex) inv = true;
    }

    let pLine = ''.padEnd(poolW - 1);
    if (i < pools.length) {
      if (i === tktViewH - 1 && pools.length > tktViewH) {
        pLine = '...';
      } else {
        const pId = pools[i];
        const inflight = run.pools?.inFlight?.[pId] ?? 0;
        const cap = run.pools?.caps?.[pId] ?? 0;
        pLine = padTruncate(`${pId}: ${inflight}/${cap}`, poolW - 1);
      }
    }

    tLine = padTruncate(tLine, tktW - 1);
    if (inv) tLine = `\x1b[7m${tLine}\x1b[0m`;

    lines.push(`${tLine}│${padTruncate(pLine, poolW - 1)}`);
  }

  lines.push('─'.repeat(width));

  const botViewH = bottomH - 1;
  const evtLines = [];
  for (const ev of state.events || []) {
    if (!ev || typeof ev !== 'object') continue;
    let tsStr = '??:??:??';
    if (ev.ts) {
      try { tsStr = new Date(ev.ts).toTimeString().slice(0, 8); } catch {}
    }
    if (ev.type === 'phase') {
      evtLines.push(stripAnsi(`[${tsStr}] [phase] ${ev.ticket ?? 'unknown'} transitioned to ${ev.to ?? 'unknown'}`));
    } else if (ev.type === 'pool') {
      evtLines.push(`[${tsStr}] [pool] limits updated`);
    } else if (ev.type === 'strike') {
      let okState = 'unknown';
      if (ev.detail && ev.detail.ok !== undefined && ev.detail.ok !== null) {
        okState = ev.detail.ok ? 'ok' : 'error';
      }
      evtLines.push(stripAnsi(`[${tsStr}] [strike] ${ev.ticket ?? 'unknown'} strike completed (${okState})`));
    }
  }

  let finalEvtScroll = state.timelineScrollTop;
  const maxEvtScroll = Math.max(0, evtLines.length - botViewH);
  if (finalEvtScroll === -1 || finalEvtScroll > maxEvtScroll) {
    finalEvtScroll = maxEvtScroll;
  }

  let transLines = [];
  if (state.showTranscript) {
    if (!tickets.length) {
      transLines.push('(No tickets available)');
    } else if (!state.transcript || state.transcript.length === 0) {
      transLines.push('(No transcript available)');
    } else {
      for (const t of state.transcript) {
        transLines.push(`\\n--- Strike ${t.strike ?? 0} ---\\n`);
        transLines.push('[PROMPT]');
        for (const line of stripAnsi(t.prompt).split('\n')) transLines.push(line);
        transLines.push('[OUTPUT]');
        for (const line of stripAnsi(t.output).split('\n')) transLines.push(line);
      }
    }
  }

  if (state.showTranscript) {
    const w1 = Math.floor(width / 2);
    const w2 = width - w1;
    for (let i = 0; i < botViewH; i++) {
      const eLine = padTruncate(evtLines[finalEvtScroll + i] ?? '', w1 - 1);
      const tLine = padTruncate(transLines[state.transcriptScrollTop + i] ?? '', w2 - 1);
      lines.push(`${eLine}│${tLine}`);
    }
  } else {
    for (let i = 0; i < botViewH; i++) {
      lines.push(padTruncate(evtLines[finalEvtScroll + i] ?? '', width));
    }
  }

  return lines.join('\n');
}

// pi-tui drives components with render(width) only, but the dashboard is a
// fixed-viewport layout that needs the row count too. renderTuiState stays the
// pure state -> string function the tests pin; this is the thin adapter.
class DashboardComponent {
  constructor(state, getRows) {
    this.state = state;
    this.getRows = getRows;
  }

  invalidate() {}

  render(width) {
    return renderTuiState(this.state, width, this.getRows()).split('\n');
  }
}

export async function launchTUI(repo, isWatch = false, intervalMs = 100, opts = {}) {
  const terminal = opts.terminal ?? null;
  const tooSmall = () => {
    const cols = terminal ? terminal.columns : process.stdout.columns;
    const rows = terminal ? terminal.rows : process.stdout.rows;
    const tty = terminal ? true : process.stdout.isTTY && process.stdin.isTTY;
    return !tty || cols < MIN_COLS || rows < MIN_ROWS;
  };

  if (tooSmall()) {
    console.log(renderStatus(repo));
    return isWatch ? 'fallback' : 0;
  }

  const runPath = join(repo, '.booster', 'run.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let printedWait = false;
  while (true) {
    if (tooSmall()) {
      console.log(renderStatus(repo));
      return isWatch ? 'fallback' : 0;
    }
    if (existsSync(runPath)) {
      try {
        JSON.parse(readFileSync(runPath, 'utf8'));
        break;
      } catch {}
    }
    if (!printedWait) {
      console.log('waiting for run.json...');
      printedWait = true;
    }
    await sleep(100);
  }

  return startTuiLoop(repo, isWatch, intervalMs, terminal);
}

async function startTuiLoop(repo, isWatch, intervalMs, injectedTerminal) {
  const terminal = injectedTerminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);

  let resolveExit;
  const exitPromise = new Promise((r) => (resolveExit = r));
  let cleanupCalled = false;

  // A process that dies with the cursor hidden leaves the user's terminal
  // broken, so restore it on every path out, not just the graceful one.
  const restoreCursor = () => {
    try { terminal.showCursor(); } catch {}
  };
  const onProcessExit = () => restoreCursor();
  const onSignal = (sig) => {
    cleanup(sig === 'SIGINT' ? 130 : 143);
  };

  const cleanup = (code) => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(pollTimer);
    try { tui.stop(); } catch {}
    restoreCursor();
    process.removeListener('exit', onProcessExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    resolveExit(code);
  };

  process.on('exit', onProcessExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const state = {
    repo,
    run: {},
    events: [],
    transcript: [],
    selectedTicketIndex: 0,
    ticketScrollTop: 0,
    showTranscript: false,
    timelineScrollTop: -1,
    transcriptScrollTop: 0,
  };

  let eventsBytesRead = 0;
  let transcriptBytesRead = 0;
  let lastTransPath = '';
  let lastRunRaw = '';

  // Returns whether anything changed, so the poll cadence (intervalMs) stays
  // decoupled from repaints: an unchanged poll requests no render at all.
  const readState = () => {
    let changed = false;
    try {
      const raw = readFileSync(join(repo, '.booster', 'run.json'), 'utf8');
      const runData = JSON.parse(raw);
      if (raw !== lastRunRaw) {
        lastRunRaw = raw;
        state.run = runData;
        changed = true;
      }

      const tickets = Object.keys(runData.tickets || {}).sort();
      if (state.selectedTicketIndex >= tickets.length) {
        const clamped = Math.max(0, tickets.length - 1);
        if (clamped !== state.selectedTicketIndex) changed = true;
        state.selectedTicketIndex = clamped;
      }

      const runIdSafe = String(runData.runId || '').replace(/[\/\\]/g, '_');
      const eventsPath = join(repo, '.booster', 'logs', runIdSafe, 'events.jsonl');
      if (existsSync(eventsPath)) {
        const stats = statSync(eventsPath);
        if (stats.size > eventsBytesRead) {
          const fd = openSync(eventsPath, 'r');
          const buffer = Buffer.alloc(stats.size - eventsBytesRead);
          readSync(fd, buffer, 0, buffer.length, eventsBytesRead);
          closeSync(fd);
          const lastNewlineIdx = buffer.lastIndexOf(10); // 10 is '\n'
          if (lastNewlineIdx !== -1) {
            const completeBuf = buffer.subarray(0, lastNewlineIdx);
            eventsBytesRead += completeBuf.length + 1;
            const newLines = completeBuf.toString('utf8').split('\n').filter(Boolean)
              .map((line) => { try { return JSON.parse(line); } catch { return null; } })
              .filter(Boolean);
            if (newLines.length) {
              state.events.push(...newLines);
              const overflow = state.events.length - MAX_EVENTS;
              if (overflow > 0) {
                state.events.splice(0, overflow);
                // Keep the timeline anchored to the same events after trimming.
                if (state.timelineScrollTop > 0) {
                  state.timelineScrollTop = Math.max(0, state.timelineScrollTop - overflow);
                }
              }
              changed = true;
            }
          }
        } else if (stats.size < eventsBytesRead) {
          state.events = [];
          eventsBytesRead = 0;
          changed = true;
        }
      } else if (state.events.length || eventsBytesRead) {
        state.events = [];
        eventsBytesRead = 0;
        changed = true;
      }

      if (tickets.length > 0) {
        const selId = String(tickets[state.selectedTicketIndex]).replace(/[\/\\]/g, '_');
        const transPath = join(repo, '.booster', 'logs', runIdSafe, `${selId}.jsonl`);
        if (transPath !== lastTransPath) {
          state.transcript = [];
          transcriptBytesRead = 0;
          lastTransPath = transPath;
          changed = true;
        }
        if (existsSync(transPath)) {
          const stats = statSync(transPath);
          if (stats.size > transcriptBytesRead) {
            const fd = openSync(transPath, 'r');
            const buffer = Buffer.alloc(stats.size - transcriptBytesRead);
            readSync(fd, buffer, 0, buffer.length, transcriptBytesRead);
            closeSync(fd);
            const lastNewlineIdx = buffer.lastIndexOf(10);
            if (lastNewlineIdx !== -1) {
              const completeBuf = buffer.subarray(0, lastNewlineIdx);
              transcriptBytesRead += completeBuf.length + 1;
              const newLines = completeBuf.toString('utf8').split('\n').filter(Boolean)
                .map((line) => { try { return JSON.parse(line); } catch { return null; } })
                .filter(Boolean);
              if (newLines.length) {
                state.transcript.push(...newLines);
                changed = true;
              }
            }
          } else if (stats.size < transcriptBytesRead) {
            state.transcript = [];
            transcriptBytesRead = 0;
            changed = true;
          }
        } else if (state.transcript.length || transcriptBytesRead) {
          state.transcript = [];
          transcriptBytesRead = 0;
          changed = true;
        }
      } else if (state.transcript.length || transcriptBytesRead) {
        state.transcript = [];
        transcriptBytesRead = 0;
        changed = true;
      }
    } catch {}
    return changed;
  };

  const dashboard = new DashboardComponent(state, () => terminal.rows);
  tui.addChild(dashboard);

  const pollTimer = setInterval(() => {
    if (cleanupCalled) return;
    if (readState()) tui.requestRender();

    if (isWatch && state.run.done && state.run.report) {
      cleanup(Object.keys(state.run.report.failed || {}).length > 0 ? 2 : 0);
    }
  }, intervalMs);

  tui.addInputListener((data) => {
    if (cleanupCalled) return;
    const key = parseKey(data) ?? KEY_FALLBACK[data];

    if (key === 'ctrl+c') return cleanup(130);
    if (key === 'q') {
      if (state.run.done && state.run.report) {
        return cleanup(Object.keys(state.run.report.failed || {}).length > 0 ? 2 : 0);
      }
      return cleanup(1); // Aborted before done
    }

    const tickets = Object.keys(state.run.tickets || {}).sort();
    const tktViewH = Math.floor(terminal.rows / 2) - 1;
    const botViewH = Math.ceil(terminal.rows / 2) - 1;

    if (tickets.length > 0) {
      if (key === 'up') {
        if (state.selectedTicketIndex > 0) {
          state.selectedTicketIndex--;
          if (state.selectedTicketIndex < state.ticketScrollTop) state.ticketScrollTop = state.selectedTicketIndex;
          state.transcriptScrollTop = 0;
          readState();
        }
      } else if (key === 'down') {
        if (state.selectedTicketIndex < tickets.length - 1) {
          state.selectedTicketIndex++;
          if (state.selectedTicketIndex >= state.ticketScrollTop + tktViewH) {
            state.ticketScrollTop = state.selectedTicketIndex - tktViewH + 1;
          }
          state.transcriptScrollTop = 0;
          readState();
        }
      }
    }

    if (key === 'enter') {
      state.showTranscript = !state.showTranscript;
    } else if (key === '[') {
      if (state.timelineScrollTop === -1) {
        state.timelineScrollTop = Math.max(0, state.events.length - botViewH);
      }
      state.timelineScrollTop = Math.max(0, state.timelineScrollTop - 1);
    } else if (key === ']') {
      if (state.timelineScrollTop !== -1) {
        state.timelineScrollTop++;
        const maxScroll = Math.max(0, state.events.length - botViewH);
        if (state.timelineScrollTop >= maxScroll) {
          state.timelineScrollTop = -1;
        }
      }
    } else if (key === 'home') {
      state.timelineScrollTop = 0;
    } else if (key === 'end') {
      state.timelineScrollTop = -1;
    } else if (key === 'pageUp') {
      state.transcriptScrollTop = Math.max(0, state.transcriptScrollTop - Math.max(1, botViewH - 1));
    } else if (key === 'pageDown') {
      state.transcriptScrollTop += Math.max(1, botViewH - 1);
    }

    tui.requestRender();
  });

  readState();
  tui.start();
  tui.requestRender();

  return exitPromise;
}
