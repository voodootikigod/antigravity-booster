// Persistent NDJSON Builder Daemon (--input-format stream-json) & Role-Scoped
// Ephemeral --settings Profiles (v1.4 Pillar 1).
//
// Cross-Model Prosecution Isolation Invariant:
//   NdjsonWorkerDaemon is strictly scoped to a single builder ticket's Strike-0
//   build and Strike-1 fix turns. Cross-model prosecution (`prosecute()`) and
//   5-lens reviews (`review()`) never reuse a builder daemon; they always run as
//   independent `readonly` processes on the opposite model family.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveModelSlug } from './models.mjs';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { parse as semverParse, lt as semverLt } from './semver.mjs';
import { IS_BUNDLED } from './adlc-bridge.mjs';

function toTokenInt(val) {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? Math.round(val) : null;
}

/**
 * Normalize token telemetry across Antigravity `stream-json` / JSON envelopes
 * (`input_tokens`, `cached_tokens`, `output_tokens`) and Anthropic-style `usage`
 * envelopes (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
 */
export function extractNormalizedTokenTelemetry(sourceObj) {
  const raw =
    sourceObj?.telemetry && typeof sourceObj.telemetry === 'object'
      ? sourceObj.telemetry
      : sourceObj?.usage && typeof sourceObj.usage === 'object'
      ? sourceObj.usage
      : null;
  if (!raw) return null;

  const hasAnthropicCache =
    raw.cache_read_input_tokens !== undefined ||
    raw.cache_creation_input_tokens !== undefined;
  const rawIn = toTokenInt(raw.input_tokens ?? raw.prompt_tokens);
  const rawCached = toTokenInt(
    hasAnthropicCache
      ? raw.cache_read_input_tokens
      : raw.cached_tokens ?? raw.cached_content_token_count
  );
  const rawCacheCreate = toTokenInt(raw.cache_creation_input_tokens);
  const rawOut = toTokenInt(raw.output_tokens ?? raw.completion_tokens);

  if (rawIn === null && rawCached === null && rawOut === null && rawCacheCreate === null) {
    return null;
  }

  const cachedTokens = rawCached ?? 0;
  const outputTokens = rawOut ?? 0;
  let uncachedInputTokens;
  let inputTokens;

  if (hasAnthropicCache) {
    uncachedInputTokens = (rawIn ?? 0) + (rawCacheCreate ?? 0);
    inputTokens = uncachedInputTokens + cachedTokens;
  } else {
    const totalOrUncached = rawIn ?? 0;
    uncachedInputTokens =
      totalOrUncached >= cachedTokens ? totalOrUncached - cachedTokens : totalOrUncached;
    inputTokens = Math.max(totalOrUncached, uncachedInputTokens + cachedTokens);
  }

  return {
    uncachedInputTokens,
    cachedTokens,
    outputTokens,
    inputTokens,
  };
}

const READONLY_ROLES = new Set([
  'prosecutor',
  'review',
  'review-plan',
  'coldstart',
  'parallax',
  'premortem',
  'brain',
  'arbiter',
  'readonly',
]);

const READONLY_DENY_TOOLS = [
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'save_file',
  'delete_file',
  'delete_directory',
  'move',
  'sed_file',
  'write_blob',
  'edit_notebook',
  'notebook_edit',
  'notebook_execution',
  'run_command',
  'send_command_input',
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'swarm',
  'run_workflow',
  'schedule',
  'send_message',
  'manage_task',
  'call_mcp_tool',
];

const BUILDER_BASE_DENY_TOOLS = [
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'swarm',
  'run_workflow',
  'schedule',
  'send_message',
];

/**
 * Build a role-tailored ephemeral `--settings` JSON profile for headless `agy` runs.
 * Emits only empirically verified `agy 1.5.15` settings keys (`permissions.deny`)
 * so readonly probes cannot invoke mutating/shell/orchestration/MCP tools and
 * builders cannot invoke recursive orchestration tools (or `call_mcp_tool` unless
 * `hasCodegraph` is true).
 */
export function buildRoleSettingsProfile(
  role = 'builder',
  { hasCodegraph = false, extraSettings = {} } = {}
) {
  const normalizedRole = String(role || 'builder').trim().toLowerCase();
  const isReadonly = READONLY_ROLES.has(normalizedRole);

  if (isReadonly) {
    return {
      permissions: {
        deny: [...READONLY_DENY_TOOLS],
      },
      ...extraSettings,
    };
  }

  return {
    permissions: {
      deny: hasCodegraph
        ? [...BUILDER_BASE_DENY_TOOLS]
        : [...BUILDER_BASE_DENY_TOOLS, 'call_mcp_tool'],
    },
    ...extraSettings,
  };
}

/**
 * Kill a child process and its entire descendant tree.
 */
export function killDaemonProcessTree(child, sig = 'SIGKILL') {
  if (!child) return;
  const pid = child.pid;
  if (pid) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        process.kill(-pid, sig);
      } catch {}
      try {
        const out = execFileSync('pgrep', ['-P', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        for (const token of out.split(/\s+/).filter(Boolean)) {
          const subPid = Number(token);
          if (subPid > 0) {
            try {
              process.kill(subPid, sig);
            } catch {}
          }
        }
      } catch {}
    }
  }
  try {
    child.kill(sig);
  } catch {}
}

/**
 * Persistent multi-turn NDJSON builder daemon wrapping `agy --input-format stream-json --output-format stream-json`.
 */
export class NdjsonWorkerDaemon {
  constructor({
    model,
    cwd,
    bin,
    env,
    project,
    effort,
    settings,
    agyVersion = '1.5.13',
    persistentWorkers = true,
    disableSlashCommands = true,
    singleShotFallback = null,
  } = {}) {
    if (!model) throw new Error('NdjsonWorkerDaemon: model is required');
    this.model = resolveModelSlug(model);
    this.cwd = cwd;
    this._bundled = IS_BUNDLED || (typeof __AGB_BUNDLED__ !== 'undefined' && __AGB_BUNDLED__ === true);
    const userHome = (!this._bundled && (env?.AGB_HOME_DIR || process.env.AGB_HOME_DIR)) || homedir();
    this.bin = bin ?? env?.AGB_AGY_BIN ?? process.env.AGB_AGY_BIN ?? (resolveAgyBinary(userHome) || 'agy');
    this.env = env ? { ...process.env, ...env } : { ...process.env };
    this.project = project;
    this.effort = effort;
    this.settings = settings;
    this.agyVersion = agyVersion;
    this.persistentWorkers = persistentWorkers !== false;
    this.disableSlashCommands = disableSlashCommands !== false;
    this.singleShotFallback = singleShotFallback;

    this.child = null;
    this.rl = null;
    this.closed = false;
    this.conversationId = null;
    this.turnCount = 0;
    this._cumulativeTelemetry = null;
    this._lineListeners = new Set();
    this._exitPromise = null;
  }

  supportsPersistentNdjson() {
    if (!this.persistentWorkers) return false;
    if (this.agyVersion && semverParse(this.agyVersion) && semverLt(this.agyVersion, '1.5.9')) {
      return false;
    }
    return true;
  }

  isAlive() {
    return Boolean(
      this.child &&
        !this.closed &&
        this.child.exitCode === null &&
        this.child.signalCode === null &&
        this.child.stdin &&
        !this.child.stdin.destroyed &&
        this.child.stdin.writable
    );
  }

  _spawnDaemon() {
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '0',
      '--model',
      this.model,
    ];
    if (this.disableSlashCommands) args.push('--disable-slash-commands');
    if (this.effort) args.push('--effort', String(this.effort));
    if (this.settings) {
      args.push(
        '--settings',
        typeof this.settings === 'string' ? this.settings : JSON.stringify(this.settings)
      );
    }
    if (this.project) {
      args.push('--project', this.project, '--add-dir', this.cwd ?? '.');
    }

    const spawnEnv = { ...this.env };
    if (
      this.cwd &&
      spawnEnv.AGB_WORKER_TICKET &&
      !(typeof spawnEnv.HOME === 'string' && spawnEnv.HOME.endsWith('.agb_home'))
    ) {
      const stagedHome = join(this.cwd, '.agb_home');
      if (existsSync(stagedHome)) {
        const userHome = spawnEnv.AGB_USER_HOME || (!this._bundled && spawnEnv.AGB_HOME_DIR) || homedir();
        spawnEnv.HOME = stagedHome;
        spawnEnv.USERPROFILE = stagedHome;
        spawnEnv.XDG_CONFIG_HOME = stagedHome;
        spawnEnv.AGB_USER_HOME = userHome;
      }
    }

    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    if (child.stdin) child.stdin.on('error', () => {});
    if (child.stdout) child.stdout.on('error', () => {});
    if (child.stderr) child.stderr.on('error', () => {});
    this.child = child;
    this.closed = false;
    this._cumulativeTelemetry = null;
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      for (const fn of [...this._lineListeners]) {
        fn(line);
      }
    });
    this._exitPromise = new Promise((resolveExit) => {
      child.once('close', (code, sig) => {
        this.closed = true;
        resolveExit({ code, sig });
      });
      child.once('error', () => {
        this.closed = true;
        resolveExit({ code: 1, sig: null });
      });
    });
  }

  /**
   * Reap any lingering descendant processes of the worker PID so the worktree is
   * guaranteed quiescent while gates and cross-model prosecution run.
   */
  quiesceChildren() {
    if (!this.child || !this.child.pid || process.platform === 'win32') {
      return { reaped: [] };
    }
    const reaped = [];
    try {
      const out = execFileSync('pgrep', ['-P', String(this.child.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      for (const token of out.split(/\s+/).filter(Boolean)) {
        const subPid = Number(token);
        if (subPid > 0 && subPid !== this.child.pid) {
          try {
            process.kill(subPid, 'SIGKILL');
            reaped.push(subPid);
          } catch {}
        }
      }
    } catch {}
    return { reaped };
  }

  /**
   * Terminate the daemon process group and wait for the process to exit before
   * returning, ensuring no concurrent writes when falling back to `--print`.
   */
  async close() {
    this.closed = true;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {}
      this.rl = null;
    }
    const child = this.child;
    const exitPromise = this._exitPromise;
    this.child = null;
    this._exitPromise = null;
    if (!child) return;

    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    } catch {}
    killDaemonProcessTree(child, 'SIGKILL');
    if (exitPromise) {
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))]);
    }
  }

  async _fallbackSingleShot(prompt, { timeoutMs = 300_000 } = {}) {
    await this.close();
    if (typeof this.singleShotFallback === 'function') {
      return this.singleShotFallback(prompt, {
        model: this.model,
        cwd: this.cwd,
        conversation: this.conversationId,
        timeoutMs,
      });
    }
    return {
      ok: false,
      fallback: true,
      error: 'persistent NDJSON stream closed and no singleShotFallback configured',
      output: '',
      conversationId: this.conversationId,
    };
  }

  /**
   * Send a turn over the persistent NDJSON stdin pipe and resolve when the turn's
   * `result` event arrives (or fall back cleanly after killing the daemon tree).
   */
  async sendTurn(prompt, { timeoutMs = 300_000, onStep = null, watchdog = null } = {}) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('NdjsonWorkerDaemon.sendTurn: prompt string is required');
    }
    if (!this.supportsPersistentNdjson()) {
      return this._fallbackSingleShot(prompt, { timeoutMs });
    }

    if (!this.isAlive()) {
      try {
        this._spawnDaemon();
      } catch {
        return this._fallbackSingleShot(prompt, { timeoutMs });
      }
    }

    if (!this.isAlive()) {
      return this._fallbackSingleShot(prompt, { timeoutMs });
    }

    this.turnCount += 1;
    const rawLines = [];
    let responseText = '';
    let turnResolved = false;

    return new Promise((resolveTurn) => {
      let timer = null;
      const cleanupListener = (listener) => {
        this._lineListeners.delete(listener);
        if (timer) clearTimeout(timer);
      };

      const onLine = async (line) => {
        if (turnResolved) return;
        rawLines.push(line);
        let evt = null;
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }

        const convId =
          evt.conversation_id ||
          evt.step_update?.conversation_id ||
          evt.result?.conversation_id;
        if (convId && typeof convId === 'string') {
          this.conversationId = convId;
        }

        if (evt.event === 'step_update' && evt.step_update) {
          if (typeof evt.step_update.text_delta === 'string') {
            responseText += evt.step_update.text_delta;
          }
          if (typeof onStep === 'function') {
            onStep(evt.step_update);
          }
          if (watchdog && typeof watchdog.observeStep === 'function') {
            const decision = watchdog.observeStep(evt.step_update);
            if (decision?.action === 'abort') {
              turnResolved = true;
              cleanupListener(onLine);
              await this.close();
              resolveTurn({
                ok: false,
                abortedByWatchdog: true,
                reason: decision.reason,
                output: rawLines.join('\n'),
                conversationId: this.conversationId,
              });
              return;
            }
          }
        }

        if (evt.event === 'result' || evt.status === 'SUCCESS' || evt.status === 'ERROR') {
          const resObj = evt.result ?? evt;
          turnResolved = true;
          cleanupListener(onLine);
          this.quiesceChildren();
          const ok = resObj.status !== 'ERROR';
          let turnTelemetry = extractNormalizedTokenTelemetry(resObj);
          const isCumulative =
            Boolean(resObj?.telemetry?.cumulative || resObj?.usage?.cumulative || resObj?.telemetry_cumulative);
          if (turnTelemetry && isCumulative) {
            const prev = this._cumulativeTelemetry;
            this._cumulativeTelemetry = { ...turnTelemetry };
            if (prev) {
              turnTelemetry = {
                uncachedInputTokens: Math.max(0, turnTelemetry.uncachedInputTokens - prev.uncachedInputTokens),
                cachedTokens: Math.max(0, turnTelemetry.cachedTokens - prev.cachedTokens),
                outputTokens: Math.max(0, turnTelemetry.outputTokens - prev.outputTokens),
                inputTokens: Math.max(0, turnTelemetry.inputTokens - prev.inputTokens),
              };
            }
          }
          resolveTurn({
            ok,
            output: resObj.response || responseText || rawLines.join('\n'),
            rawOutput: rawLines.join('\n'),
            conversationId: this.conversationId,
            turnCount: this.turnCount,
            telemetry: turnTelemetry,
            error: ok ? null : (resObj.error || 'turn reported status ERROR'),
          });
        }
      };

      this._lineListeners.add(onLine);

      if (timeoutMs > 0) {
        timer = setTimeout(async () => {
          if (turnResolved) return;
          turnResolved = true;
          cleanupListener(onLine);
          await this.close();
          resolveTurn({
            ok: false,
            timedOut: true,
            error: 'agent timeout: print-timeout',
            output: rawLines.join('\n'),
            conversationId: this.conversationId,
          });
        }, timeoutMs);
      }

      const exitCheck = this._exitPromise;
      if (exitCheck) {
        exitCheck.then(async () => {
          if (turnResolved) return;
          turnResolved = true;
          cleanupListener(onLine);
          const fb = await this._fallbackSingleShot(prompt, { timeoutMs });
          resolveTurn(fb);
        });
      }

      const payload = JSON.stringify({ type: 'user_message', content: prompt }) + '\n';
      try {
        this.child.stdin.write(payload, 'utf8', async (err) => {
          if (err && !turnResolved) {
            turnResolved = true;
            cleanupListener(onLine);
            const fb = await this._fallbackSingleShot(prompt, { timeoutMs });
            resolveTurn(fb);
          }
        });
      } catch {
        if (!turnResolved) {
          turnResolved = true;
          cleanupListener(onLine);
          this._fallbackSingleShot(prompt, { timeoutMs }).then(resolveTurn);
        }
      }
    });
  }
}
