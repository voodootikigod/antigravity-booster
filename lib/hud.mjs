import { PHASE_CONFIG, renderProgressBar, renderPoolGauge } from './tui.mjs';

export class TerminalHUD {
  constructor({
    isTTY = process.env.AGB_HUD === '1'
      ? true
      : Boolean(process.stderr?.isTTY && !process.env.CI && process.env.AGB_HUD !== '0'),
    stream = process.stderr,
  } = {}) {
    this.isTTY = isTTY;
    this.stream = stream;
    this.tickets = new Map();
    this.pools = null;
    this.startTime = Date.now();
    this.lastLinesCount = 0;
    this.stopped = false;
  }

  updateTicket(id, fields) {
    const existing = this.tickets.get(id) || { id, phase: 'pending' };
    this.tickets.set(id, { ...existing, ...fields });
    this.render();
  }

  updatePools(pools) {
    this.pools = pools;
    this.render();
  }

  clearHUD() {
    if (!this.isTTY || this.lastLinesCount === 0) return;
    for (let i = 0; i < this.lastLinesCount; i++) {
      this.stream.write('\x1b[2K\x1b[1A');
    }
    this.stream.write('\x1b[2K\r');
    this.lastLinesCount = 0;
  }

  log(message) {
    if (this.isTTY) {
      this.clearHUD();
      this.stream.write(message + '\n');
      this.render();
    } else {
      this.stream.write(message + '\n');
    }
  }

  formatStatus() {
    const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
    const ticketsList = Array.from(this.tickets.values());
    const total = ticketsList.length;
    const merged = ticketsList.filter(t => t.phase === 'merged').length;
    const inFlight = ticketsList.filter(t => ['building', 'gating', 'prosecuting', 'fixing', 'merging'].includes(t.phase));
    const failed = ticketsList.filter(t => t.phase === 'failed').length;

    const inFlightSummary = inFlight.map(t => {
      const icon = PHASE_CONFIG[t.phase]?.icon || '';
      const modelStr = t.model ? ` (${t.model})` : '';
      return `${icon ? icon + ' ' : ''}${t.id}: ${t.phase}${modelStr}`.trim();
    }).join(', ') || 'none';

    let poolSummary = '';
    if (this.pools) {
      if (this.pools.inFlight) {
        const caps = this.pools.caps || {};
        poolSummary = ' | Pools: ' + Object.entries(this.pools.inFlight)
          .map(([k, v]) => caps[k] !== undefined ? `${k}:${v}/${caps[k]}` : `${k}:${v}`)
          .join(' ');
      } else {
        poolSummary = ' | Pools: ' + Object.entries(this.pools).map(([k, v]) => `${k}:${v}`).join(' ');
      }
    }

    const progBar = renderProgressBar(merged, total, 12);
    const line1 = `[AGB HUD] [${progBar}] Elapsed: ${elapsedSec}s | Merged: ${merged}/${total} | Failed: ${failed}${poolSummary}`;
    const line2 = `Active: ${inFlightSummary}`;

    return [line1, line2];
  }

  render() {
    if (!this.isTTY || this.stopped) return;
    this.clearHUD();
    const lines = this.formatStatus();
    for (const line of lines) {
      this.stream.write(line + '\n');
    }
    this.lastLinesCount = lines.length;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.isTTY) {
      this.clearHUD();
    }
  }
}
