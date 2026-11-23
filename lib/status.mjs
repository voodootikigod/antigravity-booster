// Run state: atomically-written .booster/run.json + terminal dashboard.

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, lstatSync, realpathSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { renderTUIDashboard, ANSI } from './tui.mjs';

export function sanitizeRunId(runId) {
  return String(runId ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_');
}

function assertSafeBoosterSubdir(repo, segments) {
  const realRepo = realpathSync(resolve(repo));
  let cur = realRepo;
  for (const seg of segments) {
    cur = join(cur, seg);
    if (!existsSync(cur)) {
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          throw new Error(`Security violation: symbolic link in .booster path: ${cur}`);
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      return null;
    }
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: symbolic link in .booster path: ${cur}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Security violation: expected directory in .booster path: ${cur}`);
    }
  }
  const realTarget = realpathSync(cur);
  const rel = relative(realRepo, realTarget);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Security violation: .booster directory escapes repository root: ${cur}`);
  }
  return realTarget;
}

export function cleanOldLogs(repo, maxAgeMs = 14 * 24 * 60 * 60 * 1000) {
  let logsDir;
  try {
    logsDir = assertSafeBoosterSubdir(repo, ['.booster', 'logs']);
  } catch {
    return [];
  }
  if (!logsDir) return [];
  const removed = [];
  const now = Date.now();
  try {
    const entries = readdirSync(logsDir);
    for (const entry of entries) {
      const fullPath = join(logsDir, entry);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
          removed.push(entry);
        }
      } catch {}
    }
  } catch {}
  return removed;
}

// Node applies the `mode` option only when it CREATES the path; on one that
// already exists it is silently ignored. Anything whose path is not unique per
// run (.booster/, .booster/logs/, report.json) survives across runs, so on a
// repo that ever ran a build without this hardening the mode alone would leave
// it at 0644/0755 forever. chmod unconditionally instead of trusting creation.
// Files: write a fresh temp, then rename it into place.
const writeOwnerOnly = (file, data) => {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`Security violation: refusing to overwrite symbolic link: ${file}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
};

// Directories cannot use that trick — .booster/ may hold a previous run's logs,
// so it is created-if-absent and tightened if it already exists at 0755.
const warned = new Set();
const ownerOnlyDir = (dir) => {
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      throw new Error(`Security violation: refusing to use symbolic link directory: ${dir}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    if (err.code === 'ENOENT' || warned.has(dir)) return;
    warned.add(dir);
    console.error(
      `agb: warning — could not restrict ${dir} to owner-only (${err.code}). Run state and ` +
      `transcripts there can quote your repository's contents and may be readable by other ` +
      `local accounts. Check the directory's ownership, or use a filesystem that supports ` +
      `POSIX permissions.`
    );
  }
};

const assertNotSymlink = (targetPath) => {
  let st;
  try {
    st = lstatSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Security violation: refusing to traverse or modify symbolic link: ${targetPath}`);
  }
};

const FORBIDDEN_SLUGS = new Set(['__proto__', 'constructor']);
const toFiniteCount = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

export class RunStatus {
  constructor(repo, runId) {
    this.path = join(repo, '.booster', 'run.json');
    this.repo = repo;
    this.runId = runId;
    this.writePromise = Promise.resolve();
    this.state = {
      runId,
      repo,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      done: false,
      tickets: {},
      pools: {},
      statsContext: null,
      modelStats: {},
      disabledModels: [],
    };
    const boosterDir = join(repo, '.booster');
    const reportPath = join(boosterDir, 'report.json');
    assertNotSymlink(boosterDir);
    assertNotSymlink(reportPath);
    try {
      rmSync(reportPath, { force: true });
    } catch {}
    try {
      cleanOldLogs(repo);
    } catch {}
  }

  initModelStats(statsContext, priorState) {
    const normalizedCtx = {
      planHash: statsContext?.planHash ?? null,
      agyVersion: statsContext?.agyVersion ?? null,
    };
    this.state.statsContext = normalizedCtx;
    const matchesPrior =
      Boolean(normalizedCtx.planHash) &&
      priorState?.statsContext?.planHash === normalizedCtx.planHash &&
      priorState?.statsContext?.agyVersion === normalizedCtx.agyVersion;
    if (matchesPrior && priorState?.modelStats && typeof priorState.modelStats === 'object' && !Array.isArray(priorState.modelStats)) {
      const cloned = {};
      for (const [slug, entry] of Object.entries(priorState.modelStats)) {
        if (FORBIDDEN_SLUGS.has(slug) || !entry || typeof entry !== 'object') continue;
        cloned[slug] = {
          resolvedTickets: toFiniteCount(entry.resolvedTickets),
          builderFaultTickets: toFiniteCount(entry.builderFaultTickets),
          mergedTickets: toFiniteCount(entry.mergedTickets),
          rateLimits: toFiniteCount(entry.rateLimits),
        };
      }
      this.state.modelStats = cloned;
      const restoredDisabled = Array.isArray(priorState.disabledModels)
        ? priorState.disabledModels.filter((m) => typeof m === 'string')
        : [];
      this.state.disabledModels = [...new Set(restoredDisabled)];
      this.flush();
      return new Set(this.state.disabledModels);
    }
    this.state.modelStats = {};
    this.state.disabledModels = [];
    this.flush();
    return new Set();
  }

  updateModelStats(modelSlug, { resolved = false, builderFault = false, merged = false, rateLimited = false, disabledModels } = {}) {
    if (typeof modelSlug === 'string' && Boolean(modelSlug) && !FORBIDDEN_SLUGS.has(modelSlug)) {
      const cur = this.state.modelStats[modelSlug] ?? {
        resolvedTickets: 0,
        builderFaultTickets: 0,
        mergedTickets: 0,
        rateLimits: 0,
      };
      if (resolved) cur.resolvedTickets += 1;
      if (builderFault) cur.builderFaultTickets += 1;
      if (merged) cur.mergedTickets += 1;
      if (rateLimited) cur.rateLimits += 1;
      this.state.modelStats[modelSlug] = cur;
    }
    if (disabledModels !== undefined) {
      this.state.disabledModels = [
        ...(disabledModels instanceof Set ? disabledModels : (Array.isArray(disabledModels) ? new Set(disabledModels) : [])),
      ];
    }
    this.flush();
    return modelSlug ? this.state.modelStats[modelSlug] : null;
  }

  ticket(id, patch) {
    if (id === '__proto__' || id === 'constructor') return;
    const evt = { ts: new Date().toISOString(), runId: this.state.runId, type: 'phase', ticket: id };
    if (patch.phase !== undefined) {
      const from = this.state.tickets[id]?.phase;
      evt.to = patch.phase;
      if (from !== undefined) evt.from = from;
    }
    if (patch.detail !== undefined) evt.detail = patch.detail;
    if (patch.model !== undefined) evt.model = patch.model;
    if (patch.strikes !== undefined) evt.strikes = patch.strikes;

    this.state.tickets[id] = { ...(this.state.tickets[id] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    this.flush();
    this.appendEvent(evt);
  }

  pools(snapshot) {
    this.state.pools = snapshot;
    this.flush();
    this.appendEvent({ ts: new Date().toISOString(), runId: this.state.runId, type: 'pool', pools: snapshot });
  }

  strike(id, { model, error, strikes }) {
    this.state.tickets[id] = { ...(this.state.tickets[id] ?? {}), model, error, strikes, updatedAt: new Date().toISOString() };
    this.flush();
    this.appendEvent({ ts: new Date().toISOString(), runId: this.state.runId, type: 'strike', ticket: id, model, error, strikes });
  }

  appendEvent(evt) {
    const safeRunId = sanitizeRunId(this.state.runId);
    const eventsPath = join(this.repo, '.booster', 'logs', safeRunId, 'events.jsonl');
    ownerOnlyDir(join(this.repo, '.booster'));
    ownerOnlyDir(join(this.repo, '.booster', 'logs'));
    ownerOnlyDir(dirname(eventsPath));

    const str = JSON.stringify(evt) + '\n';
    this.writePromise = this.writePromise
      .then(() => appendFile(eventsPath, str, { mode: 0o600 }))
      .catch(() => {});
  }

  report(summary) {
    const stampedReport = summary && typeof summary === 'object' && !Array.isArray(summary)
      ? { ...summary, runId: summary.runId ?? this.runId }
      : summary;
    this.state.done = true;
    this.state.report = summary;
    this.flush();
    const boosterDir = dirname(this.path);
    writeOwnerOnly(join(boosterDir, 'report.json'), JSON.stringify(stampedReport, null, 2));
    try {
      writeOwnerOnly(join(boosterDir, 'report.md'), formatReportMarkdown(summary, this.state));
    } catch {}
    this.appendEvent({ ts: new Date().toISOString(), runId: this.state.runId, type: 'report', done: true, report: summary });
  }

  async flushEvents() {
    await this.writePromise;
  }

  flush() {
    this.state.updatedAt = new Date().toISOString();
    ownerOnlyDir(dirname(this.path));
    writeOwnerOnly(this.path, JSON.stringify(this.state, null, 2));
  }
}

export function formatReportMarkdown(summary, state = {}) {
  const safeState = state && typeof state === 'object' ? state : {};
  const merged = Array.isArray(summary?.merged) ? summary.merged : [];
  const failed = summary?.failed && typeof summary.failed === 'object' && !Array.isArray(summary.failed) ? summary.failed : {};
  const failedKeys = Object.keys(failed);
  const requests = summary?.requests && typeof summary.requests === 'object' && !Array.isArray(summary.requests) ? summary.requests : {};

  const isSuccess = failedKeys.length === 0 && !summary?.compromised;
  const alertType = isSuccess ? 'NOTE' : 'WARNING';
  const statusTitle = isSuccess ? 'Execution Succeeded' : 'Execution Completed with Failures';

  const escapeCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  const mergedRows = merged.length
    ? merged.map(id => `| \`${escapeCell(id)}\` | ✓ Merged | - |`).join('\n')
    : '| *(none)* | - | - |';
  const failedRows = failedKeys.length
    ? failedKeys.map(id => `| \`${escapeCell(id)}\` | ✗ Failed | ${escapeCell(failed[id])} |`).join('\n')
    : '';

  const table = [
    '| Ticket | Status | Details |',
    '| :--- | :--- | :--- |',
    mergedRows,
    ...(failedRows ? [failedRows] : []),
  ].join('\n');

  const reqEntries = Object.entries(requests);
  const reqRows = reqEntries.length
    ? reqEntries.map(([model, count]) => `| \`${escapeCell(model)}\` | ${count} |`).join('\n')
    : '| *(none)* | 0 |';
  const reqTable = [
    '| Model | Request Count |',
    '| :--- | :--- |',
    reqRows,
  ].join('\n');

  return `# AGB Execution Report: ${statusTitle}

> [!${alertType}]
> **Run ID:** \`${safeState.runId || summary?.runId || 'unknown'}\` | **Merged:** ${merged.length} | **Failed:** ${failedKeys.length}

---

## 1. Ticket Outcomes

${table}

---

## 2. Model Requests & Quota Utilization

${reqTable}
`;
}

const PHASE_ICONS = {
  pending: '·', building: '⚒', gating: '⛩', prosecuting: '⚖', fixing: '🔧',
  merging: '⇄', merged: '✓', failed: '✗', blocked: '⛔', paused: '⏸',
};

/** Render the dashboard from a run.json file. Returns a string. */
export function renderStatus(repo, options = {}) {
  const path = join(repo, '.booster', 'run.json');
  if (!existsSync(path)) return 'no run found (.booster/run.json missing)';
  const s = JSON.parse(readFileSync(path, 'utf8'));

  if (options.tui) {
    const ticketsMap = new Map();
    for (const [id, t] of Object.entries(s.tickets ?? {})) {
      ticketsMap.set(id, { id, ...t });
    }
    const state = {
      runId: s.runId,
      startedAt: s.startedAt,
      repo,
      pools: s.pools || {},
      tickets: ticketsMap,
      merged: new Set(s.report?.merged || Object.keys(s.tickets || {}).filter(k => s.tickets[k].phase === 'merged')),
      failed: new Set(Object.keys(s.report?.failed || {}).concat(Object.keys(s.tickets || {}).filter(k => s.tickets[k].phase === 'failed'))),
      blocked: new Set(Object.keys(s.tickets || {}).filter(k => s.tickets[k].phase === 'blocked')),
      done: Boolean(s.done),
      report: s.report || null,
      events: [],
    };
    return renderTUIDashboard(state, {
      cols: options.cols || process.stdout.columns || 100,
      compact: Boolean(options.compact),
    }).join('\n');
  }

  const lines = [];
  lines.push(`run ${s.runId}  ${s.done ? 'DONE' : 'RUNNING'}  started ${s.startedAt}`);
  const pools = s.pools?.inFlight
    ? Object.entries(s.pools.inFlight).map(([p, n]) => `${p}:${n}/${s.pools.caps?.[p] ?? '?'} (${s.pools.requests?.[p] ?? 0} reqs)`).join('  ')
    : '';
  if (pools) lines.push(`pools  ${pools}`);
  if (s.pools?.quota) {
    const q = s.pools.quota;
    const parts = [];
    if (q.gemini?.effectivePercent !== undefined) parts.push(`gemini:${q.gemini.effectivePercent}%`);
    if (q.claude_gpt?.effectivePercent !== undefined) parts.push(`claude-gpt:${q.claude_gpt.effectivePercent}%`);
    if (parts.length > 0) lines.push(`quota  ${parts.join('  ')}`);
    if (q.paused) {
      lines.push(`PAUSED: ${q.depletionCause ?? 'quota depleted'} (resumes at ${q.resumesAt ?? 'unknown'})`);
    }
  }
  lines.push('');
  const pad = (str, n) => String(str ?? '').padEnd(n).slice(0, n);
  lines.push(`${pad('ticket', 8)} ${pad('phase', 12)} ${pad('model', 30)} ${pad('strikes', 7)} detail`);
  for (const [id, t] of Object.entries(s.tickets ?? {})) {
    const icon = PHASE_ICONS[t.phase] ?? '?';
    lines.push(`${pad(id, 8)} ${icon} ${pad(t.phase, 10)} ${pad(t.model, 30)} ${pad(t.strikes ?? 0, 7)} ${t.detail ?? ''}`);
  }
  if (s.report) {
    lines.push('');
    const mergedCount = Array.isArray(s.report.merged) ? s.report.merged.length : 0;
    const failedCount = s.report.failed && typeof s.report.failed === 'object' ? Object.keys(s.report.failed).length : 0;
    lines.push(`merged ${mergedCount}  failed ${failedCount}  requests ${JSON.stringify(s.report.requests || {})}`);
  }
  return lines.join('\n');
}

export async function watchStatus(repo, optionsOrInterval = 200) {
  const opts = typeof optionsOrInterval === 'number'
    ? { intervalMs: optionsOrInterval, interactive: false }
    : { ...optionsOrInterval };

  const intervalMs = opts.intervalMs ?? 200;
  const isInteractive = opts.interactive ?? Boolean(process.stdout.isTTY && !process.env.CI);
  const follow = Boolean(opts.follow);
  let compact = Boolean(opts.compact);
  const stream = opts.stream ?? opts.stdout ?? process.stdout;
  const input = opts.stdin ?? process.stdin;
  const boosterDir = join(repo, '.booster');
  const path = join(boosterDir, 'run.json');
  const reportFallbackPath = join(boosterDir, 'report.json');

  if (!existsSync(path) && !opts.silent) {
    stream.write('waiting for run to start (.booster/run.json missing)...\n');
  }

  let s = null;
  while (!s || !s.runId) {
    if (existsSync(path)) {
      try { s = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    }
    if (!s || !s.runId) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  const runId = s.runId;
  const safeRunId = sanitizeRunId(runId);
  const eventsPath = join(boosterDir, 'logs', safeRunId, 'events.jsonl');

  let offset = 0;
  let spinnerIndex = 0;
  let isPaused = false;
  let cleanedUp = false;

  const state = {
    runId,
    startedAt: s.startedAt,
    repo,
    pools: s.pools || {},
    tickets: new Map(),
    merged: new Set(),
    failed: new Set(),
    blocked: new Set(),
    done: Boolean(s.done),
    report: s.report || null,
    events: [],
    paused: false,
  };

  if (s.tickets && typeof s.tickets === 'object') {
    for (const [id, t] of Object.entries(s.tickets)) {
      state.tickets.set(id, { id, events: [], ...t });
      if (t.phase === 'merged') state.merged.add(id);
      if (t.phase === 'failed') state.failed.add(id);
      if (t.phase === 'blocked') state.blocked.add(id);
    }
  }
  if (s.report) {
    state.done = true;
    state.report = s.report;
  }

  const parseEvents = () => {
    if (!existsSync(eventsPath)) return false;
    let completeBuf;
    try {
      const fd = openSync(eventsPath, 'r');
      try {
        const stat = fstatSync(fd);
        if (offset > stat.size) offset = 0;
        if (stat.size <= offset) return false;
        const buf = Buffer.alloc(stat.size - offset);
        const bytesRead = readSync(fd, buf, 0, buf.length, offset);
        const slice = buf.subarray(0, bytesRead);

        let lastNewline = -1;
        for (let i = slice.length - 1; i >= 0; i--) {
          if (slice[i] === 10) {
            lastNewline = i;
            break;
          }
        }
        if (lastNewline === -1) return false;
        completeBuf = slice.subarray(0, lastNewline);
        offset += lastNewline + 1;
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }

    const lines = completeBuf.toString('utf8').split('\n');
    let updated = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        updated = true;
        state.events.push(evt);
        if (state.events.length > 200) state.events.shift();

        if (evt.type === 'pool') {
          state.pools = evt.pools;
        } else if (evt.type === 'report') {
          state.done = true;
          state.report = evt.report;
        } else if (evt.ticket) {
          const id = evt.ticket;
          if (!state.tickets.has(id)) {
            state.tickets.set(id, { id, events: [] });
          }
          const t = state.tickets.get(id);
          if (evt.type === 'phase') {
            if (evt.to) t.phase = evt.to;
            if (evt.detail) t.detail = evt.detail;
            if (evt.model) t.model = evt.model;
            if (evt.strikes !== undefined) t.strikes = evt.strikes;

            if (t.phase === 'merged') state.merged.add(id);
            if (t.phase === 'failed') state.failed.add(id);
            if (t.phase === 'blocked') state.blocked.add(id);
          } else if (evt.type === 'strike') {
            if (evt.model) t.model = evt.model;
            t.error = evt.error ? String(evt.error) : undefined;
            if (evt.strikes !== undefined) t.strikes = evt.strikes;
          }

          let evtSummary = '';
          if (evt.type === 'phase') evtSummary = `[${evt.to || t.phase}] ${evt.detail || ''}`;
          else if (evt.type === 'strike') evtSummary = `[strike] ${evt.error ? String(evt.error).split('\n')[0] : 'ok'}`;

          if (evtSummary) {
            t.events.push(evtSummary.trim());
            if (t.events.length > 4) t.events.shift();
          }
        }
      } catch {}
    }
    return updated;
  };

  if (isInteractive) {
    try {
      stream.write(ANSI.altBufferEnter + ANSI.cursorHome + ANSI.cursorHide);
    } catch {}
  }

  let timer = null;
  let onKeypress = null;
  const onSigint = () => exitWithCode(130);
  const onSigterm = () => exitWithCode(143);

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (isInteractive) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      try {
        stream.write(ANSI.cursorShow + ANSI.altBufferLeave);
      } catch {}
      if (onKeypress) {
        try { input.removeListener('data', onKeypress); } catch {}
        onKeypress = null;
      }
      if (input.isTTY && typeof input.setRawMode === 'function') {
        try { input.setRawMode(false); } catch {}
        try { input.pause(); } catch {}
      }
    }
  };

  let resolvePromise;
  const exitPromise = new Promise((res) => { resolvePromise = res; });

  const exitWithCode = (code) => {
    cleanup();
    resolvePromise(code);
  };

  const computeExitCode = () => {
    if (!state.report) return 0;
    const hasFailed = Object.keys(state.report.failed || {}).length > 0;
    const isCompromised = Boolean(state.report.compromised);
    return (hasFailed || isCompromised) ? 2 : 0;
  };

  if (isInteractive) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }

  if (isInteractive && input.isTTY && typeof input.setRawMode === 'function') {
    try {
      input.setRawMode(true);
      input.resume();
      if (typeof input.setEncoding === 'function') input.setEncoding('utf8');

      onKeypress = (rawKey) => {
        const key = typeof rawKey === 'string' ? rawKey : rawKey.toString('utf8');
        if (key === '\u0003' || key === 'q' || key === 'Q') {
          const finalCode = state.done && state.report ? computeExitCode() : 0;
          exitWithCode(finalCode);
        } else if (key === 'r' || key === 'R') {
          tick();
        } else if (key === 'c' || key === 'C') {
          compact = !compact;
          tick();
        } else if (key === ' ') {
          isPaused = !isPaused;
          state.paused = isPaused;
          tick();
        }
      };
      input.on('data', onKeypress);
    } catch {}
  }

  const tick = () => {
    if (cleanedUp) return false;
    if (!isPaused) {
      parseEvents();
      if (!state.done && existsSync(path)) {
        try {
          const fresh = JSON.parse(readFileSync(path, 'utf8'));
          if (fresh.done && fresh.report) {
            state.done = true;
            state.report = fresh.report;
          }
          if (fresh.pools) state.pools = fresh.pools;
        } catch {}
      }
      if (!state.done && existsSync(reportFallbackPath)) {
        try {
          const rep = JSON.parse(readFileSync(reportFallbackPath, 'utf8'));
          if (rep && typeof rep === 'object' && state.runId && rep.runId === state.runId) {
            state.done = true;
            state.report = rep;
          }
        } catch {}
      }
    }

    spinnerIndex++;

    if (isInteractive) {
      const cols = stream.columns || 100;
      const lines = renderTUIDashboard(state, {
        cols,
        spinnerIndex,
        compact,
        now: Date.now(),
      });
      stream.write(ANSI.cursorHome + lines.join('\n') + '\n\x1b[J');
    } else {
      const total = state.tickets.size;
      const merged = state.merged.size;
      const failed = state.failed.size;
      const inFlightList = Array.from(state.tickets.values()).map(t => `${t.id}: ${t.phase}`).join(', ');
      stream.write(`[AGB Watch] run ${state.runId} | Merged: ${merged}/${total}${inFlightList ? ` (${inFlightList})` : ''} | Failed: ${failed}\n`);
    }

    if (state.done && state.report) {
      if (!follow && !isInteractive) {
        return computeExitCode();
      }
    }

    return false;
  };

  const initial = tick();
  if (initial !== false) {
    cleanup();
    return initial;
  }

  timer = setInterval(() => {
    const code = tick();
    if (code !== false) {
      exitWithCode(code);
    }
  }, intervalMs);

  return exitPromise;
}
