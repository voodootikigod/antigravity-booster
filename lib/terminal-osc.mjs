// Terminal OSC 8 Hyperlinks, OSC 9 / OSC 777 Desktop Attention Notifications,
// and Edge-Triggered Attention Transition Deduplication.

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Strip OSC, DCS/APC/PM, CSI, and 2-byte ESC escape sequences from a string
 * so terminal visible-column width calculations (`visibleLength`, `padVisible`)
 * remain exact even when OSC 8 hyperlinks are embedded.
 */
export function stripOscAndAnsi(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  return input
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

/**
 * Strip all escape sequences AND all C0/DEL/C1 control characters (`\x00-\x1f`,
 * `\x7f-\x9f`) from an untrusted text field before embedding inside an OSC payload.
 */
export function sanitizeOscField(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  return stripOscAndAnsi(input).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Render an injection-safe OSC 8 clickable `file://` hyperlink (`\x1b]8;;URI\x07LABEL\x1b]8;;\x07`)
 * when `enabled === true` and `absPath` is absolute; otherwise return the sanitized plain label.
 */
export function formatOsc8FileLink(
  absPath,
  label,
  { line = null, enabled = false } = {}
) {
  const cleanLabel = sanitizeOscField(String(label ?? absPath ?? ''));
  if (!enabled || typeof absPath !== 'string' || !absPath.trim()) {
    return cleanLabel;
  }
  const cleanPath = sanitizeOscField(absPath.trim());
  if (!cleanPath || !isAbsolute(cleanPath)) {
    return cleanLabel;
  }
  let fileUri;
  try {
    fileUri = pathToFileURL(resolve(cleanPath)).href;
  } catch {
    return cleanLabel;
  }
  // Semicolons in OSC 8 params/URI could prematurely split parameters in buggy terminals; percent-encode `;`.
  fileUri = fileUri.replace(/;/g, '%3B');
  const lineNum = Number(line);
  if (Number.isInteger(lineNum) && lineNum > 0) {
    fileUri += `#L${lineNum}`;
  }
  const visible = cleanLabel || cleanPath;
  return `\x1b]8;;${fileUri}\x07${visible}\x1b]8;;\x07`;
}

/**
 * Format an injection-safe OSC 9 (iTerm2 / Ghostty / cmux / WezTerm) or OSC 777
 * (rxvt / VTE / Kitty) desktop notification escape sequence.
 */
export function formatOscAttentionAlert(
  title,
  message = '',
  { protocol = 'osc9', enabled = false } = {}
) {
  if (!enabled) return '';
  const cleanTitle = sanitizeOscField(String(title ?? '')).replace(/;/g, ':').trim();
  const cleanMsg = sanitizeOscField(String(message ?? '')).replace(/;/g, ':').trim();
  if (!cleanTitle && !cleanMsg) return '';

  if (protocol === 'osc777') {
    return `\x1b]777;notify;${cleanTitle || 'AGB'};${cleanMsg}\x07`;
  }
  const combined = cleanTitle && cleanMsg
    ? `${cleanTitle}: ${cleanMsg}`
    : (cleanTitle || cleanMsg);
  return `\x1b]9;${combined}\x07`;
}

/**
 * Stateful rising-edge transition detector so `agb watch` emits human-actionable
 * attention alerts (`failed`, `runway`, `paused`, `done`) strictly ONCE per transition
 * instead of spamming terminal notifications on every poll tick.
 */
export class AttentionTransitionTracker {
  constructor() {
    this.alertedFailedIds = new Set();
    this.alertedDoneRunIds = new Set();
    this.wasRunwayWarning = false;
    this.wasQuotaPaused = false;
  }

  evaluate(state = {}) {
    const alerts = [];
    const runId = typeof state.runId === 'string' && state.runId ? state.runId : 'active';

    // 1. Newly failed tickets requiring human inspection / `agb rescue`
    const failedIds = new Set();
    if (state.failed instanceof Set) {
      for (const id of state.failed) failedIds.add(String(id));
    }
    const ticketsIter = state.tickets instanceof Map
      ? state.tickets.values()
      : Object.values(state.tickets ?? {});
    for (const t of ticketsIter) {
      if (t && t.phase === 'failed' && t.id) {
        failedIds.add(String(t.id));
      }
    }
    for (const id of failedIds) {
      if (!this.alertedFailedIds.has(id)) {
        this.alertedFailedIds.add(id);
        alerts.push({
          kind: 'ticket_failed',
          ticketId: id,
          title: 'AGB Needs Rescue',
          message: `Ticket ${id} failed verification (${runId})`,
        });
      }
    }

    // 2. Rising edge on projected quota runway exhaustion
    const runwayNow = Boolean(!state.done && (state.runwayWarning || state.runway?.willExhaust));
    if (runwayNow && !this.wasRunwayWarning) {
      alerts.push({
        kind: 'runway_warning',
        title: 'AGB Quota Runway Warning',
        message: state.runway?.recommendation || `Projected pool exhaustion during ${runId}`,
      });
    }
    this.wasRunwayWarning = runwayNow;

    // 3. Rising edge on quota depletion pause
    const quotaPausedNow = Boolean(!state.done && state.pools?.quota?.paused);
    if (quotaPausedNow && !this.wasQuotaPaused) {
      alerts.push({
        kind: 'quota_paused',
        title: 'AGB Fleet Paused',
        message: `Pool quota depleted (${state.pools?.quota?.depletionCause || 'waiting for reset'})`,
      });
    }
    this.wasQuotaPaused = quotaPausedNow;

    // 4. Run finalized (P6 Sign-Off Ready vs Failed)
    if (state.done && !this.alertedDoneRunIds.has(runId)) {
      this.alertedDoneRunIds.add(runId);
      const failCount = failedIds.size;
      alerts.push({
        kind: 'run_done',
        title: failCount === 0 && !state.report?.compromised ? 'AGB P6 Ready' : 'AGB Run Finished With Failures',
        message:
          failCount === 0 && !state.report?.compromised
            ? `All tickets merged in ${runId} — ready for P6 sign-off`
            : `Run ${runId} finished with ${failCount} failed ticket(s)`,
      });
    }

    return alerts;
  }
}
