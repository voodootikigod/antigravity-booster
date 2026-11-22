// Persistent NDJSON Builder Daemon (--input-format stream-json) & Role-Scoped
// Ephemeral --settings Profiles (v1.4 Pillar 1).
//
// Cross-Model Prosecution Isolation Invariant:
//   NdjsonWorkerDaemon is strictly scoped to a single builder ticket's Strike-0
//   build and Strike-1 fix turns. Cross-model prosecution (`prosecute()`) and
//   5-lens reviews (`review()`) never reuse a builder daemon; they always run as
//   independent `readonly` processes on the opposite model family.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolveModelSlug } from './models.mjs';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { parse as semverParse, lt as semverLt } from './semver.mjs';

const READONLY_ROLES = new Set([
  'prosecutor',
  'review',
  'coldstart',
  'parallax',
  'premortem',
  'brain',
  'arbiter',
  'readonly',
]);

/**
 * Build a role-tailored ephemeral `--settings` JSON profile for headless `agy` runs.
 * Strips interactive plugins, subagents, and unneeded MCP servers from readonly
 * reviewers/prosecutors and scopes builder workers to core tools (+ codegraph).
 */
export function buildRoleSettingsProfile(
  role = 'builder',
  { hasCodegraph = false, extraSettings = {} } = {}
) {
  const normalizedRole = String(role || 'builder').trim().toLowerCase();
  const isReadonly = READONLY_ROLES.has(normalizedRole);

  if (isReadonly) {
    return {
      role: normalizedRole,
      mode: 'readonly',
      mcpServersDisabled: true,
      subagentsDisabled: true,
      swarmDisabled: true,
      allowedMcpServers: [],
      modelFeatures: {
        supportsThinking: true,
        supportsToolCalls: false,
      },
      ...extraSettings,
    };
  }

  const allowedMcpServers = hasCodegraph ? ['codegraph'] : [];
  return {
    role: 'builder',
    mode: 'worker',
    mcpServersDisabled: !hasCodegraph,
    subagentsDisabled: true,
    swarmDisabled: true,
    allowedMcpServers,
    modelFeatures: {
      supportsThinking: true,
      supportsToolCalls: true,
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
    const userHome = env?.AGB_HOME_DIR || process.env.AGB_HOME_DIR || homedir();
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

    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.closed = false;
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
          resolveTurn({
            ok,
            output: resObj.response || responseText || rawLines.join('\n'),
            rawOutput: rawLines.join('\n'),
            conversationId: this.conversationId,
            turnCount: this.turnCount,
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
