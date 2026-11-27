// Interactive Strike-2 Escalation (`agb run --interactive`, Wave 5).
//
// When a ticket hits Strike 2 (flail-detector or exhausted strikes) in
// `--interactive` mode, pauses only that ticket, emits a terminal bell + OSC
// title alert (`⚠ rescue <ticketId>`), and runs a structured `/grill-me`-style
// rescue interview supporting `retry` (with optional operator guidance),
// `skip` (park ticket while siblings continue), or `abort`.

import { createInterface } from 'node:readline/promises';

export const ESCALATION_ACTIONS = Object.freeze(['retry', 'skip', 'abort']);

function stripControlChars(text) {
  return String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format a terminal bell + OSC window-title alert for an escalated ticket.
 * Control characters are stripped from `ticketId` and `reason` to prevent
 * OSC sequence injection.
 */
export function formatEscalationAlert(ticketId, reason = '') {
  const safeId = stripControlChars(ticketId) || 'ticket';
  const safeReason = stripControlChars(reason).slice(0, 140);
  const title = `⚠ rescue ${safeId}`;
  return {
    bell: '\x07',
    oscTitle: `\x1b]0;${title}\x07`,
    summary: safeReason ? `${title}: ${safeReason}` : title,
  };
}

/**
 * Render a structured `/grill-me`-style escalation prompt for an operator.
 */
export function buildGrillMeEscalationPrompt({ ticket, reason = '', signals = [], strike = 2 } = {}) {
  const id = stripControlChars(ticket?.id) || 'unknown';
  const title = stripControlChars(ticket?.title);
  const scope = Array.isArray(ticket?.scope) && ticket.scope.length > 0
    ? ticket.scope.join(', ')
    : '(unscoped)';
  const signalList = Array.isArray(signals) && signals.length > 0
    ? signals.map((s) => (typeof s === 'string' ? s : s?.type || 'signal')).join(', ')
    : 'none';
  const lines = [
    '',
    `=== ADLC Strike-${strike} Interactive Escalation (/grill-me) ===`,
    `Ticket : ${id}${title ? ` — ${title}` : ''}`,
    `Scope  : ${scope}`,
    `Signals: ${signalList}`,
    `Reason : ${stripControlChars(reason) || 'two strikes exhausted'}`,
    '',
    'Sibling wave tickets remain active. Choose how to handle this ticket:',
    '  [r] retry  — grant one supervised rescue strike (optional: "retry: <guidance>")',
    '  [s] skip   — park this ticket as failed/escalated and let sibling tickets continue',
    '  [a] abort  — abort the remaining fleet run',
    '',
  ];
  return lines.join('\n');
}

/**
 * Parse a single-line operator response into `{ action, guidance }`.
 */
export function parseEscalationAnswer(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { action: 'skip', guidance: '' };
  const lower = text.toLowerCase();
  if (lower === 'a' || lower === 'abort') {
    return { action: 'abort', guidance: '' };
  }
  if (lower === 's' || lower === 'skip') {
    return { action: 'skip', guidance: '' };
  }
  if (lower === 'r' || lower === 'retry') {
    return { action: 'retry', guidance: '' };
  }
  const retryWithGuidance = text.match(/^(?:r|retry)\s*[:\-]\s*(.+)$/i);
  if (retryWithGuidance) {
    return { action: 'retry', guidance: retryWithGuidance[1].trim() };
  }
  return { action: 'skip', guidance: '' };
}

/**
 * Execute an interactive Strike-2 escalation.
 * Degrades cleanly to `{ action: 'skip', guidance: '' }` when non-TTY and no
 * `onEscalation` callback is supplied, or if `onEscalation` throws.
 */
export async function runInteractiveEscalation({
  ticket,
  reason = '',
  signals = [],
  strike = 2,
  onEscalation = null,
  input = process.stdin,
  output = process.stdout,
  isTTY = Boolean(output?.isTTY),
} = {}) {
  const alert = formatEscalationAlert(ticket?.id, reason);
  const prompt = buildGrillMeEscalationPrompt({ ticket, reason, signals, strike });

  if (isTTY && output && typeof output.write === 'function') {
    output.write(`${alert.bell}${alert.oscTitle}`);
  }

  if (typeof onEscalation === 'function') {
    try {
      const rawDecision = await onEscalation({ ticket, reason, signals, strike, alert, prompt });
      const action = ESCALATION_ACTIONS.includes(rawDecision?.action) ? rawDecision.action : 'skip';
      const guidance = typeof rawDecision?.guidance === 'string' ? rawDecision.guidance.trim() : '';
      return { action, guidance, alert, prompt };
    } catch (err) {
      return {
        action: 'skip',
        guidance: '',
        error: String(err?.message ?? err),
        alert,
        prompt,
      };
    }
  }

  if (!isTTY || !input || !output) {
    return { action: 'skip', guidance: '', nonInteractive: true, alert, prompt };
  }

  const rl = createInterface({ input, output });
  try {
    output.write(prompt);
    const answer = await rl.question(`Action for ${ticket?.id ?? 'ticket'} [r/s/a]: `);
    const parsed = parseEscalationAnswer(answer);
    return { ...parsed, alert, prompt };
  } finally {
    rl.close();
  }
}
