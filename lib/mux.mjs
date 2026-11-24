// Multi-Worktree Terminal Multiplexer Engine (`tmux` / `cmux` / `herdr`).
//
// Builds and executes shell-free argument vectors (`spawnSync` without `shell: true`)
// for `tmux` (including `tmuxh` CLI alias), `cmux` (`$CMUX_SOCKET_PATH`), and
// `herdr` (`HERDR_ENV=1` / `herdr pane split` + `herdr pane run`).
// Explicitly rejects unsupported multiplexers such as `zellij`.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sanitizeOscField } from './terminal-osc.mjs';

export const SUPPORTED_MUXES = Object.freeze(['tmux', 'cmux', 'herdr']);

const SAFE_PANE_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;

export function normalizeMuxName(rawMux = 'auto') {
  const s = String(rawMux ?? 'auto').trim().toLowerCase();
  if (!s || s === 'auto') return 'auto';
  if (s === 'tmux' || s === 'tmuxh') return 'tmux';
  if (s === 'cmux') return 'cmux';
  if (s === 'herdr') return 'herdr';
  throw new Error(
    `Unsupported multiplexer '${rawMux}'; supported multiplexers: ${SUPPORTED_MUXES.join(', ')}`
  );
}

/**
 * Detect active terminal multiplexer from environment variables.
 * Priority: `herdr` (`HERDR_ENV=1` / `HERDR_PANE_ID`) -> `cmux` -> `tmux`.
 */
export function detectMultiplexer(env = process.env) {
  if (!env || typeof env !== 'object') return null;
  if (env.HERDR_ENV === '1' || Boolean(env.HERDR_PANE_ID)) return 'herdr';
  if (Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_SOCKET_PATH)) return 'cmux';
  if (Boolean(env.TMUX)) return 'tmux';
  return null;
}

function assertCleanSingleLine(value, label) {
  const str = String(value ?? '');
  if (/[\x00-\x1f\x7f]/.test(str)) {
    throw new Error(`Invalid control character in multiplexer ${label}`);
  }
  return str;
}

/**
 * Construct a deterministic, shell-free split-pane execution plan for `tmux`, `cmux`, or `herdr`.
 */
export function buildMuxSplitPlan({
  mux = 'auto',
  cwd = process.cwd(),
  command = null,
  commandArgs = null,
  env = process.env,
  allowOutsideSession = false,
} = {}) {
  const normalized = normalizeMuxName(mux);
  const resolvedMux = normalized === 'auto' ? detectMultiplexer(env) : normalized;
  if (!resolvedMux) {
    return {
      ok: false,
      reason: 'no_active_multiplexer',
      error: 'No active tmux, cmux, or herdr session detected in environment',
    };
  }

  assertCleanSingleLine(cwd, 'cwd');
  const resolvedCwd = resolve(cwd);
  if (command !== null && command !== undefined) {
    assertCleanSingleLine(command, 'command');
  }
  if (Array.isArray(commandArgs)) {
    for (const arg of commandArgs) assertCleanSingleLine(arg, 'commandArgs');
  }

  if (resolvedMux === 'herdr') {
    const inHerdr = env?.HERDR_ENV === '1' || Boolean(env?.HERDR_PANE_ID);
    if (!inHerdr && !allowOutsideSession) {
      return {
        ok: false,
        mux: 'herdr',
        reason: 'outside_herdr_session',
        error: 'Refusing to control herdr from outside a HERDR_ENV=1 managed pane',
      };
    }
    const cmdText =
      typeof command === 'string' && command.trim()
        ? command.trim()
        : Array.isArray(commandArgs) && commandArgs.length > 0
        ? commandArgs.join(' ')
        : null;
    return {
      ok: true,
      mux: 'herdr',
      splitCall: {
        bin: 'herdr',
        args: ['pane', 'split', '--current', '--direction', 'right', '--cwd', resolvedCwd, '--no-focus'],
      },
      buildFollowUpCall: cmdText
        ? (paneId) => {
            if (typeof paneId !== 'string' || !SAFE_PANE_ID_RE.test(paneId)) {
              throw new Error(`Invalid herdr pane_id returned by split: ${String(paneId)}`);
            }
            return {
              bin: 'herdr',
              args: ['pane', 'run', paneId, cmdText],
            };
          }
        : null,
    };
  }

  if (resolvedMux === 'cmux') {
    const socketArgs = [];
    if (typeof env?.CMUX_SOCKET_PATH === 'string' && env.CMUX_SOCKET_PATH.trim()) {
      assertCleanSingleLine(env.CMUX_SOCKET_PATH, 'CMUX_SOCKET_PATH');
      socketArgs.push('--socket', env.CMUX_SOCKET_PATH.trim());
    }
    const cmdText =
      typeof command === 'string' && command.trim()
        ? command.trim()
        : Array.isArray(commandArgs) && commandArgs.length > 0
        ? commandArgs.join(' ')
        : null;
    return {
      ok: true,
      mux: 'cmux',
      splitCall: {
        bin: 'cmux',
        args: [
          ...socketArgs,
          'new-split',
          'right',
          ...(cmdText ? ['--command', cmdText] : []),
        ],
      },
      buildFollowUpCall: null,
    };
  }

  // tmux
  const trailing =
    Array.isArray(commandArgs) && commandArgs.length > 0
      ? [...commandArgs]
      : typeof command === 'string' && command.trim()
      ? [command.trim()]
      : [];
  return {
    ok: true,
    mux: 'tmux',
    splitCall: {
      bin: 'tmux',
      args: ['split-window', '-h', '-d', '-c', resolvedCwd, ...trailing],
    },
    buildFollowUpCall: null,
  };
}

/**
 * Build shell-free multiplexer notification command arguments (`herdr notification show`,
 * `cmux notify`, or `tmux display-message`).
 */
export function buildMuxNotificationArgs({
  mux = 'auto',
  title = 'AGB',
  body = '',
  env = process.env,
} = {}) {
  const normalized = normalizeMuxName(mux);
  const resolvedMux = normalized === 'auto' ? detectMultiplexer(env) : normalized;
  if (!resolvedMux) return null;

  const cleanTitle = sanitizeOscField(String(title ?? 'AGB')).trim() || 'AGB';
  const cleanBody = sanitizeOscField(String(body ?? '')).trim();

  if (resolvedMux === 'herdr') {
    if (env?.HERDR_ENV !== '1' && !env?.HERDR_PANE_ID) return null;
    return {
      mux: 'herdr',
      bin: 'herdr',
      args: ['notification', 'show', cleanTitle, ...(cleanBody ? ['--body', cleanBody] : [])],
    };
  }
  if (resolvedMux === 'cmux') {
    const socketArgs =
      typeof env?.CMUX_SOCKET_PATH === 'string' && env.CMUX_SOCKET_PATH.trim()
        ? ['--socket', sanitizeOscField(env.CMUX_SOCKET_PATH.trim())]
        : [];
    return {
      mux: 'cmux',
      bin: 'cmux',
      args: [...socketArgs, 'notify', '--title', cleanTitle, ...(cleanBody ? ['--body', cleanBody] : [])],
    };
  }
  return {
    mux: 'tmux',
    bin: 'tmux',
    args: ['display-message', cleanBody ? `${cleanTitle}: ${cleanBody}` : cleanTitle],
  };
}

function extractHerdrPaneId(stdoutText) {
  if (typeof stdoutText !== 'string' || !stdoutText.trim()) return null;
  try {
    const parsed = JSON.parse(stdoutText);
    const id =
      parsed?.result?.pane?.pane_id ??
      parsed?.pane?.pane_id ??
      parsed?.result?.pane_id ??
      parsed?.pane_id ??
      null;
    return typeof id === 'string' && SAFE_PANE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Execute a split-pane plan without shell interpolation (`shell: false`), degrading
 * cleanly to `{ ok: false, error }` on missing binary or multiplexer error.
 */
export function launchMuxSplit({
  mux = 'auto',
  cwd = process.cwd(),
  command = null,
  commandArgs = null,
  env = process.env,
  allowOutsideSession = false,
  spawnSyncFn = spawnSync,
} = {}) {
  let plan;
  try {
    plan = buildMuxSplitPlan({ mux, cwd, command, commandArgs, env, allowOutsideSession });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!plan.ok) return plan;

  try {
    const res = spawnSyncFn(plan.splitCall.bin, plan.splitCall.args, {
      cwd: resolve(cwd),
      env,
      encoding: 'utf8',
      shell: false,
    });
    if (res.error) {
      return { ok: false, mux: plan.mux, error: res.error.message };
    }
    if (res.status !== 0) {
      return {
        ok: false,
        mux: plan.mux,
        error: String(res.stderr || res.stdout || `exit ${res.status}`).trim(),
      };
    }

    let paneId = null;
    if (plan.mux === 'herdr') {
      paneId = extractHerdrPaneId(res.stdout);
      if (plan.buildFollowUpCall) {
        if (!paneId) {
          return {
            ok: false,
            mux: 'herdr',
            error: 'herdr pane split succeeded but returned no valid JSON pane_id',
          };
        }
        const followUp = plan.buildFollowUpCall(paneId);
        const runRes = spawnSyncFn(followUp.bin, followUp.args, {
          cwd: resolve(cwd),
          env,
          encoding: 'utf8',
          shell: false,
        });
        if (runRes.error || runRes.status !== 0) {
          return {
            ok: false,
            mux: 'herdr',
            paneId,
            error: String(runRes.error?.message || runRes.stderr || `exit ${runRes.status}`).trim(),
          };
        }
      }
    }

    return { ok: true, mux: plan.mux, paneId };
  } catch (err) {
    return { ok: false, mux: plan.mux, error: err.message };
  }
}
