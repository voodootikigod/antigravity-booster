// Sub-Turn stream-json Watchdog & Dynamic --effort Stepping (v1.4 Pillar 5).
//
// Monitors live `step_update` events inside a single turn to detect:
//   1. Rail-bounce spirals (>= maxRailBounces PreToolUse policy denials)
//   2. In-turn command flailing (>= maxIdenticalFailures consecutive failures
//      with identical normalized command + stderr SHA-256)
// Also governs dynamic `--effort` precedence between warm NDJSON Strike-1 resume
// and fresh-process Strike-1 escalation.

import { createHash } from 'node:crypto';
import {
  resolveModelSlug,
  escalateModelSlugInFamily,
  selectCliEffortFlag,
} from './models.mjs';

const RAIL_DENIAL_PATTERNS = [
  /tool call denied by pre-tool hook/i,
  /matches frozen rail/i,
  /matches standing ADLC implicit rail/i,
  /outside declared ticket scope/i,
  /denied while ADLC rails are active/i,
];

function normalizeCommandSignature(step) {
  const toolName = String(step?.tool_name || step?.name || '').trim().toLowerCase();
  const info = step?.tool_info ?? step?.args ?? {};
  const cmd =
    typeof info === 'string'
      ? info
      : String(info.CommandLine || info.command || info.Path || info.path || JSON.stringify(info));
  return `${toolName}:${cmd.trim().replace(/\s+/g, ' ')}`;
}

function extractStepErrorText(step) {
  if (!step || typeof step !== 'object') return '';
  const candidates = [
    step.error,
    step.stderr,
    step.tool_error,
    step.output_error,
    step.text_delta,
    typeof step.tool_info === 'object' && step.tool_info !== null ? step.tool_info.error : '',
    typeof step.tool_info === 'object' && step.tool_info !== null ? step.tool_info.stderr : '',
  ];
  return candidates.filter((c) => typeof c === 'string' && c.trim()).join('\n').trim();
}

function isRailDenialText(text) {
  if (!text) return false;
  return RAIL_DENIAL_PATTERNS.some((re) => re.test(text));
}

function isFailedStep(step, errText) {
  if (!step || typeof step !== 'object') return false;
  const state = String(step.state || '').toUpperCase();
  if (state === 'ERROR' || state === 'FAILED') return true;
  if (typeof step.exit_code === 'number' && step.exit_code !== 0) return true;
  if (typeof step.tool_info?.exit_code === 'number' && step.tool_info.exit_code !== 0) return true;
  if (step.error || step.tool_error) return true;
  if (isRailDenialText(errText)) return true;
  return false;
}

/**
 * In-flight stream-json step supervisor.
 */
export class StreamWatchdog {
  constructor({
    ticket = {},
    maxRailBounces = 2,
    maxIdenticalFailures = 3,
    abortOnRailBounceLimit = false,
  } = {}) {
    this.ticket = ticket;
    this.maxRailBounces = Math.max(1, maxRailBounces);
    this.maxIdenticalFailures = Math.max(2, maxIdenticalFailures);
    this.abortOnRailBounceLimit = Boolean(abortOnRailBounceLimit);

    this.railBounces = 0;
    this.consecutiveFailureHash = null;
    this.consecutiveFailureCount = 0;
    this.steeredCount = 0;
  }

  reset() {
    this.railBounces = 0;
    this.consecutiveFailureHash = null;
    this.consecutiveFailureCount = 0;
  }

  _buildRailSteeringPrompt() {
    const scopeList = Array.isArray(this.ticket?.scope) && this.ticket.scope.length
      ? this.ticket.scope.join(', ')
      : '(declared ticket scope)';
    const railList = Array.isArray(this.ticket?.rails) && this.ticket.rails.length
      ? this.ticket.rails.join(', ')
      : '(frozen rails)';
    return (
      `[WATCHDOG STEERING] You triggered ${this.railBounces} PreToolUse policy/rail denials in this turn. ` +
      `Stay strictly inside your allowed scope [${scopeList}] and never touch frozen rails [${railList}].`
    );
  }

  /**
   * Inspect a single `step_update` payload and return:
   *   `{ action: 'continue' | 'steer' | 'abort', reason, steeringPrompt }`
   */
  observeStep(step) {
    if (!step || typeof step !== 'object') {
      return { action: 'continue', reason: null, steeringPrompt: null };
    }

    const errText = extractStepErrorText(step);
    const railDenied = isRailDenialText(errText);

    if (railDenied) {
      this.railBounces += 1;
      if (this.railBounces >= this.maxRailBounces) {
        if (this.abortOnRailBounceLimit || this.railBounces > this.maxRailBounces) {
          return {
            action: 'abort',
            reason: `rail-bounce threshold exceeded (${this.railBounces} PreToolUse denials)`,
            steeringPrompt: null,
          };
        }
        this.steeredCount += 1;
        return {
          action: 'steer',
          reason: `rail-bounce threshold reached (${this.railBounces} PreToolUse denials)`,
          steeringPrompt: this._buildRailSteeringPrompt(),
        };
      }
    }

    if (isFailedStep(step, errText)) {
      const cmdSig = normalizeCommandSignature(step);
      const digest = createHash('sha256')
        .update(`${cmdSig}\n${errText}`)
        .digest('hex');

      if (this.consecutiveFailureHash === digest) {
        this.consecutiveFailureCount += 1;
      } else {
        this.consecutiveFailureHash = digest;
        this.consecutiveFailureCount = 1;
      }

      if (this.consecutiveFailureCount >= this.maxIdenticalFailures) {
        return {
          action: 'abort',
          reason: `in-turn flail detected: ${this.consecutiveFailureCount} consecutive identical failures on ${cmdSig}`,
          steeringPrompt: null,
        };
      }
    } else if (
      step.step_type === 'tool' &&
      String(step.state || '').toUpperCase() === 'DONE'
    ) {
      this.consecutiveFailureHash = null;
      this.consecutiveFailureCount = 0;
    }

    return { action: 'continue', reason: null, steeringPrompt: null };
  }
}

/**
 * Resolve dynamic `--effort` level and precedence between warm NDJSON Strike-1
 * resume and fresh-process Strike-1 escalation.
 *
 * Precedence Contract:
 *   - Strike 0 (`strike === 0 && !deadlock`): `'medium'` for cheap/mid, `'high'` for frontier.
 *   - Strike >= 1 on a warm healthy `NdjsonWorkerDaemon` (`warmDaemonAlive && !aborted && !deadlock`):
 *     preserve the warm daemon's effort so `<100ms` stdin resume keeps the hot KV cache.
 *   - Strike >= 1 when spawning a fresh process (`!warmDaemonAlive || aborted || deadlock`):
 *     escalate to `'xhigh'` (or `'max'` when `allowMax === true`).
 */
export function resolveDynamicEffort(
  ticket = {},
  {
    model,
    strike = 0,
    aborted = false,
    deadlock = false,
    warmDaemonAlive = false,
    allowMax = false,
  } = {}
) {
  const tier = String(ticket?.tier || 'mid').trim().toLowerCase();
  const baseEffort = tier === 'frontier' ? 'high' : 'medium';

  const reuseWarm = Boolean(warmDaemonAlive && !aborted && !deadlock);
  const escalateCold = strike > 0 && !reuseWarm;

  const baseResult =
    strike === 0 && !deadlock && !aborted
      ? {
          effort: baseEffort,
          escalated: false,
          reuseWarmDaemon: Boolean(warmDaemonAlive),
        }
      : reuseWarm
      ? {
          effort: baseEffort,
          escalated: false,
          reuseWarmDaemon: true,
        }
      : {
          effort: allowMax ? 'max' : 'xhigh',
          escalated: true,
          reuseWarmDaemon: false,
        };

  if (model === undefined) {
    return baseResult;
  }

  const resolvedModel = baseResult.escalated
    ? escalateModelSlugInFamily(model)
    : resolveModelSlug(model);
  const cliEffort = selectCliEffortFlag({
    model: resolvedModel,
    tier,
    strike: baseResult.reuseWarmDaemon ? 0 : strike,
    explicitEffort: ticket?.effort ?? null,
    allowMax,
  });

  return {
    ...baseResult,
    resolvedModel,
    cliEffort,
  };
}
