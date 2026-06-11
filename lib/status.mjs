// Run state: atomically-written .booster/run.json + terminal dashboard.

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class RunStatus {
  constructor(repo, runId) {
    this.path = join(repo, '.booster', 'run.json');
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
    this.state.tickets[id] = { ...(this.state.tickets[id] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    this.flush();
  }

  pools(snapshot) {
    this.state.pools = snapshot;
    this.flush();
  }

  finish(report) {
    this.state.done = true;
    this.state.report = report;
    this.flush();
    const reportPath = join(dirname(this.path), 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
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
