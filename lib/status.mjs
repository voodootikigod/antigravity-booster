// Run state: atomically-written .booster/run.json + terminal dashboard.

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// Node applies the `mode` option only when it CREATES the path; on one that
// already exists it is silently ignored. Anything whose path is not unique per
// run (.booster/, .booster/logs/, report.json) survives across runs, so on a
// repo that ever ran a build without this hardening the mode alone would leave
// it at 0644/0755 forever. chmod unconditionally instead of trusting creation.
// Files: write a fresh temp, then rename it into place. Fresh because Node
// ignores `mode` on an existing path, so writing in place would leave the
// secrets at the old mode — and chmod-ing afterwards would still expose them
// for the window in between, permanently if the chmod failed. Renamed so the
// swap is atomic for readers: a concurrent `agb status`, or the TUI, sees the
// old file or the new one, never a half-written one. Note this is a visibility
// guarantee, not a durability one — surviving power loss would additionally
// need an fsync of the file and its directory, which is not paid for here.
const writeOwnerOnly = (file, data) => {
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
};

// Directories cannot use that trick — .booster/ may hold a previous run's logs,
// so it is created-if-absent and tightened if it already exists at 0755.
// Best-effort by design: chmod also fails with EPERM/EROFS/ENOTSUP on
// filesystems that simply do not implement POSIX modes (vfat, CIFS, some
// Docker bind mounts) on paths the caller owns, and refusing to run there would
// trade a real availability loss for no confidentiality gain. Warn once instead
// of failing, so it is never silent.
const warned = new Set();
const ownerOnlyDir = (dir) => {
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

export class RunStatus {
  constructor(repo, runId) {
    this.path = join(repo, '.booster', 'run.json');
    this.repo = repo;
    this.writePromise = Promise.resolve();
    this.state = {
      runId,
      repo,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      done: false,
      tickets: {},
      pools: {},
    };
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
    const safeRunId = String(this.state.runId || '').replace(/[\/\\]/g, '_');
    const eventsPath = join(this.repo, '.booster', 'logs', safeRunId, 'events.jsonl');
    // .booster/ and .booster/logs/ are not run-scoped and outlive any single
    // run, so an existing one needs tightening. The runId dir below it is new
    // every run, so its mode always applies at creation — as does
    // events.jsonl's, which is why appending here never needs a chmod.
    ownerOnlyDir(join(this.repo, '.booster'));
    ownerOnlyDir(join(this.repo, '.booster', 'logs'));
    ownerOnlyDir(dirname(eventsPath));

    const str = JSON.stringify(evt) + '\n';
    this.writePromise = this.writePromise
      .then(() => appendFile(eventsPath, str, { mode: 0o600 }))
      .catch(() => {});
  }

  report(summary) {
    this.state.done = true;
    this.state.report = summary;
    this.flush();
    // report.json's path is fixed, so an older run's 0644 copy may be sitting
    // there. It is also a documented output that consumers read, so it is
    // replaced atomically rather than truncated in place.
    writeOwnerOnly(join(dirname(this.path), 'report.json'), JSON.stringify(summary, null, 2));
    this.appendEvent({ ts: new Date().toISOString(), runId: this.state.runId, type: 'report', done: true, report: summary });
  }

  flush() {
    this.state.updatedAt = new Date().toISOString();
    ownerOnlyDir(dirname(this.path));
    // writeOwnerOnly is already atomic, and replaces its own temp — including a
    // stale run.json.tmp left by a run that died mid-flush, whose mode would
    // otherwise ride the rename onto run.json.
    writeOwnerOnly(this.path, JSON.stringify(this.state, null, 2));
  }
}

const PHASE_ICONS = {
  pending: '·', building: '⚒', gating: '⛩', prosecuting: '⚖', fixing: '🔧',
  merging: '⇄', merged: '✓', failed: '✗', blocked: '⛔',
};

/** Render the dashboard from a run.json file. Returns a string. */
export function renderStatus(repo) {
  // Legacy renderStatus used in tests
  const path = join(repo, '.booster', 'run.json');
  if (!existsSync(path)) return 'no run found (.booster/run.json missing)';
  const s = JSON.parse(readFileSync(path, 'utf8'));
  const lines = [];
  lines.push(`run ${s.runId}  ${s.done ? 'DONE' : 'RUNNING'}  started ${s.startedAt}`);
  const pools = s.pools?.inFlight
    ? Object.entries(s.pools.inFlight).map(([p, n]) => `${p}:${n}/${s.pools.caps[p]} (${s.pools.requests[p]} reqs)`).join('  ')
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
    // report.failed is a plain object (id → reason), not an array.
    lines.push(`merged ${s.report.merged.length}  failed ${Object.keys(s.report.failed).length}  requests ${JSON.stringify(s.report.requests)}`);
  }
  return lines.join('\n');
}

export async function watchStatus(repo, intervalMs = 100) {
  const boosterDir = join(repo, '.booster');
  const path = join(boosterDir, 'run.json');
  
  if (!existsSync(path)) {
    console.log('waiting for run to start (.booster/run.json missing)...');
  }

  let s = null;
  while (!s || !s.runId) {
    if (existsSync(path)) {
      try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { }
    }
    if (!s || !s.runId) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  const runId = s.runId;
  const safeRunId = String(runId).replace(/[\/\\]/g, '_');
  const eventsPath = join(boosterDir, 'logs', safeRunId, 'events.jsonl');
  
  let offset = 0;
  const state = {
    runId,
    startedAt: s.startedAt,
    pools: {},
    tickets: new Map(),
    merged: new Set(),
    failed: new Set(),
    blocked: new Set(),
    done: false,
    report: null,
  };

  const { openSync, fstatSync, readSync, closeSync } = await import('node:fs');

  const parseEvents = () => {
    if (!existsSync(eventsPath)) return false;
    const fd = openSync(eventsPath, 'r');
    const stat = fstatSync(fd);
    if (stat.size <= offset) {
      closeSync(fd);
      return false;
    }
    const buf = Buffer.alloc(stat.size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset += buf.length;
    
    const lines = buf.toString('utf8').split('\n');
    let updated = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        updated = true;
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
      } catch { }
    }
    return updated;
  };

  const renderTUI = () => {
    const lines = [];
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';
    const green = '\x1b[32m';
    const red = '\x1b[31m';
    const yellow = '\x1b[33m';
    const cyan = '\x1b[36m';
    const gray = '\x1b[90m';

    const total = state.tickets.size;
    const merged = state.merged.size;
    const failed = state.failed.size;
    const blocked = state.blocked.size;
    const completed = merged + failed + blocked;
    
    const barLen = 20;
    const fill = total ? Math.floor((completed / total) * barLen) : 0;
    const bar = `[${'#'.repeat(fill)}${'.'.repeat(barLen - fill)}]`;

    lines.push(`${bold}Run ${cyan}${state.runId}${reset}  ${state.done ? `${bold}${green}DONE${reset}` : `${bold}${yellow}RUNNING${reset}`}  started ${state.startedAt}`);
    lines.push(`${bar} ${merged}/${total} merged (${failed} failed, ${blocked} blocked)`);
    
    if (state.pools?.inFlight) {
      const pools = Object.entries(state.pools.inFlight).map(([p, n]) => `${p}:${n}/${state.pools.caps[p]} (${state.pools.requests[p]} reqs)`).join('  ');
      lines.push(`pools  ${pools}`);
    }
    if (state.pools?.quota) {
      const q = state.pools.quota;
      const parts = [];
      if (q.gemini?.effectivePercent !== undefined) parts.push(`gemini:${q.gemini.effectivePercent}%`);
      if (q.claude_gpt?.effectivePercent !== undefined) parts.push(`claude-gpt:${q.claude_gpt.effectivePercent}%`);
      if (parts.length > 0) lines.push(`quota  ${parts.join('  ')}`);
      if (q.paused) {
        lines.push(`${bold}${red}PAUSED: ${q.depletionCause ?? 'quota depleted'} (resumes at ${q.resumesAt ?? 'unknown'})${reset}`);
      }
    }
    lines.push('');

    const inFlight = [];
    const doneTickets = [];
    for (const t of state.tickets.values()) {
      if (['merged', 'failed', 'blocked'].includes(t.phase)) doneTickets.push(t);
      else inFlight.push(t);
    }

    const pad = (str, n) => String(str ?? '').padEnd(n).slice(0, n);

    if (inFlight.length > 0) {
      lines.push(`${bold}In Flight:${reset}`);
      for (const t of inFlight) {
        const icon = PHASE_ICONS[t.phase] ?? '?';
        lines.push(`  ${pad(t.id, 8)} ${icon} ${pad(t.phase, 12)} ${pad(t.model, 25)} ${t.strikes ? `strikes:${t.strikes}` : ''}`);
        for (const e of t.events) {
          lines.push(`    ${gray}↳ ${e}${reset}`);
        }
      }
      lines.push('');
    }

    if (doneTickets.length > 0) {
      lines.push(`${bold}Completed:${reset}`);
      for (const t of doneTickets) {
        const icon = PHASE_ICONS[t.phase] ?? '?';
        lines.push(`  ${pad(t.id, 8)} ${icon} ${pad(t.phase, 10)} ${t.error ? t.error.split('\n')[0] : ''}`);
      }
    }

    if (state.report) {
      lines.push('');
      lines.push(`merged ${state.report.merged.length}  failed ${Object.keys(state.report.failed).length}  requests ${JSON.stringify(state.report.requests)}`);
    }

    return lines.join('\n');
  };

  let hasPrinted = false;

  const tick = () => {
    const updated = parseEvents();
    
    if (state.done && state.report) {
      if (updated || !hasPrinted) {
        process.stdout.write('\x1b[2J\x1b[H');
        console.log(renderTUI());
        console.log(`\n---\nwatching (updated ${new Date().toISOString()})`);
        hasPrinted = true;
      }
      return Object.keys(state.report.failed).length ? 2 : 0;
    }

    if (!updated && hasPrinted) return false;
    
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderTUI());
    console.log(`\n---\nwatching (updated ${new Date().toISOString()})`);
    hasPrinted = true;
    
    return false;
  };

  const initial = tick();
  if (initial !== false) return initial;

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const code = tick();
      if (code !== false) {
        clearInterval(timer);
        resolve(code);
      }
    }, intervalMs);
  });
}
