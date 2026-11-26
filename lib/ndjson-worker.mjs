// Persistent NDJSON Builder Daemon (--input-format stream-json), contained by default.
// Scoped to one builder ticket; prosecution/review always use separate readonly processes.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolveModelSlug } from './models.mjs';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { buildRoleSettingsProfile } from './role-settings.mjs';

export { buildRoleSettingsProfile };

export const MAX_BYPASS_RESPAWNS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kill a child process and its entire descendant tree. */
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
    agyVersion = '1.5.17',
    persistentWorkers = true,
    disableSlashCommands = true,
    singleShotFallback = null,
    role = 'builder',
    useRoleSettings = true,
    hasCodegraph = false,
    rails = [],
    worker = null,
    sanitizeEnv = false,
    sandbox = role === 'builder',
    containment = role === 'builder',
    singleShotFallbackIsContained = false,
    repo = null,
    platform = process.platform,
    prepareContainment = null,
  } = {}) {
    if (!model) throw new Error('NdjsonWorkerDaemon: model is required');
    this.model = resolveModelSlug(model);
    this.cwd = cwd;
    const userHome = env?.AGB_HOME_DIR || process.env.AGB_HOME_DIR || homedir();
    this.userHome = userHome;
    this.bin = bin ?? env?.AGB_AGY_BIN ?? process.env.AGB_AGY_BIN ?? (resolveAgyBinary(userHome) || 'agy');
    this.envOverride = env;
    this.env = env ? { ...process.env, ...env } : { ...process.env };
    this.project = project;
    this.effort = effort;
    this.settings = settings;
    this.agyVersion = agyVersion;
    this.persistentWorkers = persistentWorkers !== false;
    this.disableSlashCommands = disableSlashCommands !== false;
    this.singleShotFallback = singleShotFallback;
    this.role = role;
    this.useRoleSettings = useRoleSettings !== false;
    this.hasCodegraph = hasCodegraph;
    this.rails = rails;
    this.worker = worker;
    this.sanitizeEnv = sanitizeEnv;
    this.sandbox = sandbox;
    this.containment = containment;
    this.singleShotFallbackIsContained = singleShotFallbackIsContained;
    this.repo = repo;
    this.platform = platform;
    this.prepareContainment = prepareContainment;
    this._spawnPromise = null;
    this._respawnCount = 0;
    this._verifiedBypass = null;
    this._containmentCleanup = null;
    this._closeRequested = false;

    this.child = null;
    this.rl = null;
    this.closed = false;
    this.conversationId = null;
    this.turnCount = 0;
    this._lineListeners = new Set();
    this._exitPromise = null;
  }

  supportsPersistentNdjson() {
    return Boolean(this.persistentWorkers);
  }

  _requiresContainment() {
    return this.role === 'builder' && Boolean(this.containment || this.sandbox);
  }

  _runContainmentCleanup() {
    const cleanup = this._containmentCleanup;
    this._containmentCleanup = null;
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch {}
    }
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
    if (this._spawnPromise) return this._spawnPromise;
    this._spawnPromise = this._doSpawnDaemon().finally(() => {
      this._spawnPromise = null;
    });
    return this._spawnPromise;
  }

  async _doSpawnDaemon() {
    if (this.child) {
      const old = this.child;
      const oldExit = this._exitPromise;
      killDaemonProcessTree(old);
      if (oldExit) await Promise.race([oldExit, sleep(2000)]);
      this.child = null;
      this._exitPromise = null;
    }
    this._runContainmentCleanup();
    this.closed = false;
    this._closeRequested = false;

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
    const effectiveSettings =
      this.settings !== undefined
        ? this.settings
        : this.useRoleSettings
          ? buildRoleSettingsProfile(this.role, { hasCodegraph: this.hasCodegraph, rails: this.rails })
          : null;
    if (effectiveSettings) {
      args.push(
        '--settings',
        typeof effectiveSettings === 'string' ? effectiveSettings : JSON.stringify(effectiveSettings)
      );
    }
    if (this.project) {
      args.push('--project', this.project, '--add-dir', this.cwd ?? '.');
    }

    let launchBin = this.bin;
    let launchArgs = args;
    let spawnEnv = { ...this.env };
    let buildSpawnEnv = null;
    let res = null;
    if (this._requiresContainment()) {
      if (this.turnCount > 0) {
        this._respawnCount += 1;
        if (this._respawnCount > MAX_BYPASS_RESPAWNS) this._verifiedBypass = null;
      }
      let prepare = this.prepareContainment;
      try {
        const agy = await import('./agy.mjs');
        buildSpawnEnv = agy.buildSpawnEnv;
        prepare = prepare ?? agy.prepareBuilderContainment;
        res = await prepare({
          agyBin: this.bin,
          args,
          cwd: this.cwd,
          repo: this.repo ?? this.cwd,
          sandbox: this.sandbox,
          containment: this.containment,
          env: this.env,
          userHome: this.userHome,
          allowCodegraph: this.hasCodegraph,
          platform: this.platform,
          verifiedBypass: this._verifiedBypass,
        });
      } catch (err) {
        return { ok: false, kind: 'containment_unavailable', error: err?.message ?? String(err) };
      }
      if (this._closeRequested) {
        res?.cleanup?.();
        return { ok: false, kind: 'daemon_closed', error: 'daemon closed during spawn' };
      }
      this._verifiedBypass = res?.verifiedBypass ?? this._verifiedBypass;
      this._containmentCleanup = res?.cleanup ?? null;
      if (!res?.ok) {
        this._runContainmentCleanup();
        return {
          ok: false,
          kind: res?.kind ?? 'containment_unavailable',
          error: res?.error ?? 'containment unavailable',
        };
      }
      launchBin = res.launchBin ?? this.bin;
      launchArgs = res.launchArgs ?? args;
    } else if (this.sanitizeEnv) {
      buildSpawnEnv = (await import('./agy.mjs')).buildSpawnEnv;
    }
    if (buildSpawnEnv) {
      spawnEnv = buildSpawnEnv({
        processEnv: process.env,
        env: this.envOverride,
        cwd: this.cwd,
        repo: this.repo ?? this.cwd,
        role: this.role,
        isBuilder: this.role === 'builder',
        sanitizeEnv: this.sanitizeEnv,
        worker: this.worker,
        userHome: this.userHome,
        builderHome: res?.stagedBuilderHome,
        platform: this.platform,
      });
    }

    const child = spawn(launchBin, launchArgs, {
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
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      for (const fn of [...this._lineListeners]) {
        fn(line);
      }
    });
    this._exitPromise = new Promise((resolveExit) => {
      child.once('close', (code, sig) => {
        if (this.child === child) this.closed = true;
        resolveExit({ code, sig });
      });
      child.once('error', () => {
        if (this.child === child) this.closed = true;
        resolveExit({ code: 1, sig: null });
      });
    });
  }

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

  async close() {
    this.closed = true;
    this._closeRequested = true;
    try {
      await this._spawnPromise;
    } catch {}
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
    if (child) {
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      } catch {}
      killDaemonProcessTree(child, 'SIGKILL');
      if (exitPromise) await Promise.race([exitPromise, sleep(2000)]);
    }
    this._runContainmentCleanup();
  }

  async _fallbackSingleShot(prompt, { timeoutMs = 300_000 } = {}) {
    await this.close();
    if (this._requiresContainment() && !this.singleShotFallbackIsContained) {
      return {
        ok: false,
        kind: 'containment_unavailable',
        error: 'uncontained single-shot fallback is forbidden for contained builder daemon',
      };
    }
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
      let spawnRes;
      try {
        spawnRes = await this._spawnDaemon();
      } catch {
        return this._fallbackSingleShot(prompt, { timeoutMs });
      }
      if (spawnRes && spawnRes.ok === false) return spawnRes;
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
