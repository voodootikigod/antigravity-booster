// Run state: atomically-written .booster/run.json + terminal dashboard.

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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
    mkdirSync(dirname(eventsPath), { recursive: true });
    
    const str = JSON.stringify(evt) + '\n';
    this.writePromise = this.writePromise.then(() => appendFile(eventsPath, str)).catch(() => {});
  }

  report(summary) {
    this.state.done = true;
    this.state.report = summary;
    this.flush();
    const reportPath = join(dirname(this.path), 'report.json');
    writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    this.appendEvent({ ts: new Date().toISOString(), runId: this.state.runId, type: 'report', done: true, report: summary });
  }

  flush() {
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}

const PHASE_ICONS = {
  pending: '·', building: '⚒', gating: '⛩', prosecuting: '⚖', fixing: '🔧',
  merging: '⇄', merged: '✓', failed: '✗', blocked: '⛔',
};

/** Render the dashboard from a run.json file. Returns a string. */
export function renderStatus(repo) {
  const path = join(repo, '.booster', 'run.json');
  if (!existsSync(path)) return 'no run found (.booster/run.json missing)';
  const s = JSON.parse(readFileSync(path, 'utf8'));
  const lines = [];
  lines.push(`run ${s.runId}  ${s.done ? 'DONE' : 'RUNNING'}  started ${s.startedAt}`);
  const pools = s.pools?.inFlight
    ? Object.entries(s.pools.inFlight).map(([p, n]) => `${p}:${n}/${s.pools.caps[p]} (${s.pools.requests[p]} reqs)`).join('  ')
    : '';
  if (pools) lines.push(`pools  ${pools}`);
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

export async function watchStatus(repo, intervalMs = 1000) {

  const boosterDir = join(repo, '.booster');
  const path = join(boosterDir, 'run.json');
  
  if (!existsSync(path)) {
    console.log('waiting for run to start (.booster/run.json missing)...');
  }
  
  let lastContent = '';
  
  const tick = () => {
    if (!existsSync(path)) return false;
    let s;
    try {
      const content = readFileSync(path, 'utf8');
      if (content === lastContent) return false;
      lastContent = content;
      s = JSON.parse(content);
    } catch {
      return false; // ignore partial writes
    }
    
    // Clear screen and redraw
    process.stdout.write('\x1Bc');
    console.log(renderStatus(repo));
    console.log(`\n---\nwatching (updated ${new Date().toISOString()})`);
    
    if (s.done && s.report) {
      return Object.keys(s.report.failed).length ? 2 : 0;
    }
    return false;
  };

  const initial = tick();
  if (initial !== false) return initial;

  return new Promise((resolve) => {
    let watcher;
    const timer = setInterval(() => {
      const code = tick();
      if (code !== false) cleanupAndResolve(code);
    }, intervalMs);
    
    try {
      watcher = import('node:fs').then(({ watch }) => {
        return watch(boosterDir, (eventType, filename) => {
          if (filename === 'run.json') {
            const code = tick();
            if (code !== false) cleanupAndResolve(code);
          }
        });
      });
    } catch {
      // ignore watch failures
    }

    async function cleanupAndResolve(code) {
      clearInterval(timer);
      if (watcher) {
        const w = await watcher;
        if (w) w.close();
      }
      resolve(code);
    }
  });
}
