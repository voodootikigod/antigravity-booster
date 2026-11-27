// Persistent Warm `agy acp` JSON-RPC 2.0 Daemon Pool (Wave 3).
//
// Maintains bounded read-only `agy acp` worker processes communicating over
// newline-delimited JSON-RPC 2.0 (`initialize`, `session/new`,
// `session/set_config_option`, `session/prompt`, `session/cancel`) so multi-lens
// reviews and prosecutors avoid cold-starting `agy --print` per lens.
//
// Degrades cleanly (`{ ok: false, fallback: true }`) when disabled
// (`AGB_ACP_POOL=0`) or when the `agy` binary cannot speak ACP.

import { spawn } from 'node:child_process';
import { resolveAgyBinary } from './plugin-paths.mjs';

const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 500;

/**
 * Return true unless `AGB_ACP_POOL` explicitly disables the warm ACP daemon pool.
 */
export function isAcpPoolEnabled(env = process.env) {
  const raw = String(env?.AGB_ACP_POOL ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function extractPromptText(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.text === 'string') return result.text;
  if (typeof result.output === 'string') return result.output;
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

class AcpWorker {
  constructor({ id, agyBin, cwd, env, initTimeoutMs, args }) {
    this.id = id;
    this.agyBin = agyBin;
    this.cwd = cwd;
    this.env = env;
    this.initTimeoutMs = initTimeoutMs;
    this.args = Array.isArray(args) ? args : ['acp'];
    this.child = null;
    this.busy = false;
    this.ready = false;
    this.closed = false;
    this.sessionId = null;
    this.currentModel = null;
    this.currentEffort = null;
    this.nextReqId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderrBuf = '';
  }

  async start() {
    if (this.closed) throw new Error('ACP worker already closed');
    const child = spawn(this.agyBin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const waiter = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(waiter.timer);
          if (msg.error) {
            waiter.reject(new Error(msg.error.message || `ACP error ${msg.error.code ?? ''}`.trim()));
          } else {
            waiter.resolve(msg.result);
          }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString('utf8')).slice(-2048);
    });

    const onTerminate = (reason) => {
      this.ready = false;
      this.sessionId = null;
      this.child = null;
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      this.pending.clear();
    };

    child.once('error', (err) => onTerminate(`ACP spawn error: ${err.message}`));
    child.once('close', (code, signal) => {
      onTerminate(`ACP worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    });

    const initRes = await this.sendRequest(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'antigravity-booster', version: '2.0.0' },
        capabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
      this.initTimeoutMs
    );

    const sessionRes = await this.sendRequest(
      'session/new',
      { cwd: this.cwd, mode: 'readonly' },
      this.initTimeoutMs
    );
    this.sessionId = sessionRes?.sessionId || `acp-${this.id}`;
    this.ready = true;
    return initRes;
  }

  sendRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed || !this.child.stdin?.writable) {
        reject(new Error('ACP worker stdin unavailable'));
        return;
      }
      const id = this.nextReqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  sendNotification(method, params) {
    if (!this.child || this.child.killed || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {}
  }

  async ensureConfig({ model, effort, timeoutMs }) {
    if (model && model !== this.currentModel) {
      await this.sendRequest(
        'session/set_config_option',
        { sessionId: this.sessionId, configId: 'model', value: model },
        timeoutMs
      );
      this.currentModel = model;
    }
    if (effort && effort !== this.currentEffort) {
      await this.sendRequest(
        'session/set_config_option',
        { sessionId: this.sessionId, configId: 'effort', value: effort },
        timeoutMs
      );
      this.currentEffort = effort;
    }
  }

  async runPrompt({ prompt, model = null, effort = null, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS }) {
    await this.ensureConfig({ model, effort, timeoutMs: Math.min(timeoutMs, this.initTimeoutMs) });
    try {
      const res = await this.sendRequest(
        'session/prompt',
        {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: String(prompt ?? '') }],
        },
        timeoutMs
      );
      return {
        ok: true,
        output: extractPromptText(res),
        stopReason: res?.stopReason ?? 'end_turn',
        model: this.currentModel ?? model,
        effort: this.currentEffort ?? effort,
        workerId: this.id,
        sessionId: this.sessionId,
      };
    } catch (err) {
      if (/timed out/i.test(err.message) && this.sessionId) {
        this.sendNotification('session/cancel', { sessionId: this.sessionId });
      }
      throw err;
    }
  }

  async close() {
    this.closed = true;
    this.ready = false;
    const child = this.child;
    this.child = null;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('ACP worker shutting down'));
    }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, KILL_GRACE_MS);
      killTimer.unref?.();
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
    });
  }
}

/**
 * Bounded pool of warm read-only `agy acp` JSON-RPC 2.0 workers.
 */
export class AcpReviewPool {
  constructor(opts = {}) {
    this.agyBin = opts.agyBin || opts.env?.AGB_AGY_BIN || resolveAgyBinary() || 'agy';
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env ? { ...opts.env } : { ...process.env };
    this.maxWorkers = Math.max(1, Math.min(8, Number(opts.maxWorkers) || DEFAULT_MAX_WORKERS));
    this.initTimeoutMs = Math.max(100, Number(opts.initTimeoutMs) || DEFAULT_INIT_TIMEOUT_MS);
    this.promptTimeoutMs = Math.max(100, Number(opts.promptTimeoutMs) || DEFAULT_PROMPT_TIMEOUT_MS);
    this.args = Array.isArray(opts.args) ? opts.args : ['acp'];
    this.workers = [];
    this.waitQueue = [];
    this.nextWorkerId = 1;
    this.shuttingDown = false;
  }

  stats() {
    return {
      maxWorkers: this.maxWorkers,
      activeWorkers: this.workers.filter((w) => w.ready).length,
      busyWorkers: this.workers.filter((w) => w.busy).length,
      queued: this.waitQueue.length,
    };
  }

  async acquireWorker() {
    if (this.shuttingDown) {
      throw new Error('ACP pool is shutting down');
    }
    const idle = this.workers.find((w) => !w.busy && w.ready && !w.closed);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    // Prune dead workers before checking capacity
    this.workers = this.workers.filter((w) => !w.closed && (w.ready || w.busy));
    if (this.workers.length < this.maxWorkers) {
      const worker = new AcpWorker({
        id: this.nextWorkerId++,
        agyBin: this.agyBin,
        cwd: this.cwd,
        env: this.env,
        initTimeoutMs: this.initTimeoutMs,
        args: this.args,
      });
      worker.busy = true;
      this.workers.push(worker);
      try {
        await worker.start();
        return worker;
      } catch (err) {
        worker.busy = false;
        await worker.close();
        this.workers = this.workers.filter((w) => w !== worker);
        throw err;
      }
    }
    return new Promise((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  releaseWorker(worker) {
    if (this.shuttingDown || !worker.ready || worker.closed) {
      worker.busy = false;
      this.workers = this.workers.filter((w) => w !== worker);
      if (this.waitQueue.length > 0 && !this.shuttingDown) {
        const next = this.waitQueue.shift();
        this.acquireWorker().then(next.resolve, next.reject);
      }
      return;
    }
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next.resolve(worker);
      return;
    }
    worker.busy = false;
  }

  /**
   * Execute a read-only prompt on a warm ACP worker. Never throws; degrades with
   * `{ ok: false, fallback: true, error }` so callers can fall back to `runAgy`.
   */
  async prompt({ prompt, model = null, effort = null, timeoutMs } = {}) {
    if (!isAcpPoolEnabled(this.env)) {
      return { ok: false, fallback: true, error: 'ACP pool disabled via AGB_ACP_POOL=0' };
    }
    if (this.shuttingDown) {
      return { ok: false, fallback: true, error: 'ACP pool is shutting down' };
    }
    const effectiveTimeout = Math.max(50, Number(timeoutMs) || this.promptTimeoutMs);
    let worker;
    try {
      worker = await this.acquireWorker();
    } catch (err) {
      return { ok: false, fallback: true, error: err.message };
    }
    const t0 = Date.now();
    try {
      const res = await worker.runPrompt({ prompt, model, effort, timeoutMs: effectiveTimeout });
      this.releaseWorker(worker);
      return { ...res, ms: Date.now() - t0 };
    } catch (err) {
      await worker.close();
      this.releaseWorker(worker);
      return { ok: false, fallback: true, error: err.message, ms: Date.now() - t0 };
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift();
      waiter.reject(new Error('ACP pool shutting down'));
    }
    const toClose = [...this.workers];
    this.workers = [];
    await Promise.all(toClose.map((w) => w.close()));
  }
}

export function createAcpReviewPool(opts = {}) {
  return new AcpReviewPool(opts);
}
