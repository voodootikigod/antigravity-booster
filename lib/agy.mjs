// agy subprocess wrapper. One function, one process, structured result.
//
// Calibration facts this encodes (docs/calibration/):
//   - agy 1.1.1 returns non-zero exit code + stderr on server-side failure
//   - prompt goes on stdin; AGENTS.md/GEMINI.md in cwd auto-load
//   - model names are the exact `agy models` strings

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { verifyWindowsSandboxAttestation } from './doctor.mjs';

export const MAX_STREAM_LINE_BYTES = 1024 * 1024; // 1 MB
export const MAX_STREAM_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_CONSECUTIVE_GARBAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export const ENV_ALLOWLIST = [
  'PATH',
  'USER',
  'HOME',
  'LANG',
  'TERM',
  'NODE_ENV',
  'TMPDIR',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

export const SENSITIVE_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|CERT/i;

export const FORBIDDEN_SECRETS = [
  'ADLC_ADMIN_KEY',
  'ADLC_MANIFEST_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

const verifiedWindowsAttestations = new Map();

export function verifySandboxBypassAttestation(repoPath, platform = process.platform) {
  if (!repoPath) return { valid: false, reason: 'no repo path provided' };
  const configPath = join(repoPath, '.adlc', 'config.json');
  if (!existsSync(configPath)) return { valid: false, reason: 'missing .adlc/config.json' };
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const att = config.sandboxBypassAttestation;
    if (!att || typeof att !== 'object') return { valid: false, reason: 'missing sandboxBypassAttestation in config' };
    if (!att.platform || !att.expiresAt || !att.signature) {
      return { valid: false, reason: 'malformed sandboxBypassAttestation' };
    }
    if (att.platform !== platform) {
      return { valid: false, reason: `attestation platform mismatch: ${att.platform} !== ${platform}` };
    }
    const exp = typeof att.expiresAt === 'number' ? att.expiresAt : Date.parse(att.expiresAt);
    if (!Number.isFinite(exp)) {
      return { valid: false, reason: 'malformed expiresAt in sandboxBypassAttestation' };
    }
    if (Date.now() > exp) {
      return { valid: false, reason: 'sandboxBypassAttestation expired' };
    }
    const adminKey = process.env.ADLC_ADMIN_KEY;
    if (!adminKey) {
      return { valid: false, reason: 'missing ADLC_ADMIN_KEY to verify attestation signature' };
    }
    const expectedSig = crypto
      .createHmac('sha256', adminKey)
      .update(`${att.platform}:${att.expiresAt}`)
      .digest('hex');
    if (att.signature !== expectedSig) {
      return { valid: false, reason: 'invalid sandboxBypassAttestation HMAC signature' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `failed to parse config: ${err.message}` };
  }
}

export function checkKernelContainment() {
  if (process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE === '1') {
    return { supported: false, mechanism: null, detail: 'Kernel containment floor unavailable (mocked)' };
  }
  if (process.platform === 'win32') {
    return { supported: true, mechanism: 'job_object' };
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('systemd-run', ['--user', '--scope', 'true'], { stdio: 'ignore' });
      return { supported: true, mechanism: 'cgroups_v2_scope' };
    } catch {}
    try {
      execFileSync('unshare', ['-p', '-f', '--mount-proc', 'true'], { stdio: 'ignore' });
      return { supported: true, mechanism: 'pid_namespace' };
    } catch {}
    if (existsSync('/sys/fs/cgroup/cgroup.controllers')) {
      return { supported: false, mechanism: 'cgroups_v2', detail: 'cgroups v2 detected but systemd-run user scope is unavailable' };
    }
    return { supported: false, mechanism: null, detail: 'Neither cgroups v2 scope nor PID namespace containment is available' };
  }
  if (process.platform === 'darwin' || process.platform.includes('bsd')) {
    return { supported: false, mechanism: null, detail: 'Kernel containment floor unavailable on darwin/bsd (process groups do not prevent setsid escape)' };
  }
  return { supported: false, mechanism: null, detail: `Unsupported platform: ${process.platform}` };
}

export const MODELS = {
  'gemini-flash': [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-high',
    'gemini-3.5-flash-low',
    'gemini-3.5-flash-medium',
    'gemini-3.5-flash-high',
  ],
  'gemini-pro': ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
  claude: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking'],
  'gpt-oss': ['gpt-oss-120b-medium'],
};

export const MODEL_ALIASES = {
  'gemini 3.8 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.8 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.8 flash (high)': 'gemini-3.8-flash-high',
  'gemini 3.7 flash (low)': 'gemini-3.7-flash-low',
  'gemini 3.7 flash (medium)': 'gemini-3.7-flash-medium',
  'gemini 3.7 flash (high)': 'gemini-3.7-flash-high',
  'gemini 3.6 flash (low)': 'gemini-3.6-flash-low',
  'gemini 3.6 flash (medium)': 'gemini-3.6-flash-medium',
  'gemini 3.6 flash (high)': 'gemini-3.6-flash-high',
  'gemini 3.5 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.5 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.5 flash (high)': 'gemini-3.8-flash-high',
  'gemini-3.5-flash-low': 'gemini-3.8-flash-low',
  'gemini-3.5-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-high': 'gemini-3.8-flash-high',
  'gemini 3.1 pro (low)': 'gemini-3.1-pro-low',
  'gemini 3.1 pro (high)': 'gemini-3.1-pro-high',
  'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
  'claude opus 4.6 (thinking)': 'claude-opus-4-6-thinking',
  'gpt-oss 120b (medium)': 'gpt-oss-120b-medium',
};

export function resolveModelSlug(model) {
  if (typeof model !== 'string') return model;
  const normalized = model.trim().toLowerCase();
  if (MODEL_ALIASES[normalized]) {
    const resolved = MODEL_ALIASES[normalized];
    if (normalized.includes('3.5')) {
      console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    }
    return resolved;
  }
  for (const list of Object.values(MODELS)) {
    for (const slug of list) {
      if (slug.toLowerCase() === normalized) return slug;
    }
  }
  return model;
}

// agy's print-timeout marker is its entire output on failure. Matching it as
// a bare substring would false-trip when a model legitimately quotes the
// phrase, so require it to be the sole trailing line of short output.
export function isAgyTimeout(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^Error: (?:timed out waiting for response|MCP (?:tool call|server connection|connection) timed out|timed out waiting for MCP response)\.?$/i.test(last) && out.length < 300;
}

/** Quota pool for a model name (pools throttle + meter independently). */
export function poolOf(model) {
  const slug = resolveModelSlug(model);
  for (const [pool, models] of Object.entries(MODELS)) {
    if (models.includes(slug)) return pool;
  }
  // Fallback prefix check
  if (typeof slug !== 'string') throw new Error(`unknown model: ${slug}`);
  const normalized = slug.toLowerCase();
  if (normalized.includes('flash')) return 'gemini-flash';
  if (normalized.includes('gemini')) return 'gemini-pro';
  if (normalized.includes('claude') || normalized.includes('sonnet') || normalized.includes('opus')) return 'claude';
  if (normalized.includes('gpt')) return 'gpt-oss';

  throw new Error(`unknown model: ${slug}`);
}

/** Model family for cross-model prosecution ('gemini' | 'claude' | 'gpt-oss'). */
export function familyOf(model) {
  const pool = poolOf(model);
  return pool.startsWith('gemini') ? 'gemini' : pool;
}

export function parseTimeoutMs(timeout) {
  if (typeof timeout === 'number') return timeout;
  if (!timeout || typeof timeout !== 'string') return 10 * 60 * 1000;
  const match = timeout.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!match) return 10 * 60 * 1000;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  if (unit === 's') return val * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  return 10 * 60 * 1000;
}

/**
 * Run one agy print-mode completion.
 * opts: { model, prompt, cwd, sandbox, timeout ('10m'), logFile, bin, env }
 * `env` is merged ONTO process.env for this spawn only — never mutate
 * process.env itself, which would leak across tickets building concurrently
 * in the same booster process (e.g. ADLC_P4_ENFORCEMENT/ADLC_TICKET must be
 * scoped to one ticket's worktree, not every in-flight build).
 * Returns { ok, output, ms, error } — never throws on agent failure;
 * throws only on programmer error (missing model/prompt).
 */
export function runAgy({
  model,
  prompt,
  cwd,
  sandbox = false,
  timeout = '10m',
  maxTimeout,
  eventProgressTimeout,
  logFile,
  bin,
  env,
  project,
  strike = 0,
  role,
  outputFormat,
  jsonSchema,
  repo,
  ticketId,
  token,
  containment = true,
  sanitizeEnv = false,
}) {
  if (!model || !prompt) throw new Error('runAgy: model and prompt are required');
  const resolvedModel = resolveModelSlug(model);
  const agyBin = bin ?? process.env.AGB_AGY_BIN ?? 'agy';
  const effectiveTimeout = outputFormat === 'stream-json' && (!timeout || timeout === '0') ? '0' : timeout;
  const args = ['--print', prompt, '--print-timeout', effectiveTimeout, '--model', resolvedModel];
  if (outputFormat) {
    args.push('--output-format', outputFormat);
  }
  if (jsonSchema) {
    args.push('--json-schema', typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema));
  }
  if (project) {
    args.push('--project', project);
    args.push('--add-dir', cwd ?? '.');
  }

  const isBuilder = role === 'builder';
  let effectiveSandbox = sandbox;
  if (isBuilder) {
    if (!sandbox) {
      if (process.platform === 'win32') {
        const cacheKey = project || repo || cwd;
        let bypass = cacheKey ? verifiedWindowsAttestations.get(cacheKey) : null;
        if (bypass) {
          const exp = bypass.attestation?.expiresAt ? Date.parse(bypass.attestation.expiresAt) : NaN;
          if (isNaN(exp) || Date.now() > exp) {
            verifiedWindowsAttestations.delete(cacheKey);
            bypass = null;
          } else {
            const configPath = join(repo ?? cwd, '.adlc', 'config.json');
            if (!existsSync(configPath)) {
              verifiedWindowsAttestations.delete(cacheKey);
              bypass = null;
            } else {
              try {
                const config = JSON.parse(readFileSync(configPath, 'utf8'));
                if (config.sandboxBypassAttestation?.nonce !== bypass.attestation?.nonce) {
                  verifiedWindowsAttestations.delete(cacheKey);
                  bypass = null;
                }
              } catch {
                verifiedWindowsAttestations.delete(cacheKey);
                bypass = null;
              }
            }
          }
        }
        if (!bypass) {
          bypass = verifyWindowsSandboxAttestation({ repo: repo ?? cwd });
          if (bypass.valid && cacheKey) {
            verifiedWindowsAttestations.set(cacheKey, bypass);
          }
        }
        if (!bypass.valid) {
          return Promise.resolve({
            ok: false,
            output: '',
            ms: 0,
            error: `Sandbox bypass denied: ${bypass.reason}`,
            kind: 'containment_unavailable',
          });
        }
      } else {
        const bypass = verifySandboxBypassAttestation(repo ?? cwd);
        if (!bypass.valid) {
          return Promise.resolve({
            ok: false,
            output: '',
            ms: 0,
            error: `Sandbox bypass denied: ${bypass.reason}`,
            kind: 'containment_unavailable',
          });
        }
      }
      effectiveSandbox = false;
    } else {
      effectiveSandbox = true;
    }
  }

  if (effectiveSandbox) args.push('--sandbox');

  let launchBin = agyBin;
  let launchArgs = args;
  let systemdUnit = null;

  if (isBuilder && containment && process.env.AGB_ALLOW_UNCONTAINED_BUILDS !== '1') {
    const containmentCheck = checkKernelContainment();
    if (!containmentCheck.supported) {
      return Promise.resolve({
        ok: false,
        output: '',
        ms: 0,
        error: `Kernel containment floor unavailable: ${containmentCheck.detail}. Set AGB_ALLOW_UNCONTAINED_BUILDS=1 to bypass.`,
        kind: 'containment_unavailable',
      });
    }
    if (containmentCheck.mechanism === 'cgroups_v2_scope') {
      systemdUnit = `agb-builder-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      launchBin = 'systemd-run';
      launchArgs = ['--user', '--scope', '-q', `--unit=${systemdUnit}`, '--', agyBin, ...args];
    } else if (containmentCheck.mechanism === 'pid_namespace') {
      launchBin = 'unshare';
      launchArgs = ['-p', '-f', '--mount-proc', '--', agyBin, ...args];
    } else if (containmentCheck.mechanism === 'job_object') {
      launchBin = 'powershell.exe';
      launchArgs = ['-NoProfile', '-NonInteractive', '-Command', `& "${agyBin}" ${args.map((a) => `"${String(a).replace(/"/g, '`"')}"`).join(' ')}`];
    } else {
      return Promise.resolve({
        ok: false,
        output: '',
        ms: 0,
        error: `Kernel containment floor unavailable: mechanism '${containmentCheck.mechanism}' cannot be attached to subprocess directly`,
        kind: 'containment_unavailable',
      });
    }
  }

  return new Promise((resolve) => {
    const t0 = Date.now();
    let spawnEnv = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (FORBIDDEN_SECRETS.includes(key) || SENSITIVE_KEY_PATTERN.test(key)) {
        continue;
      }
      if (
        ENV_ALLOWLIST.includes(key) ||
        key.startsWith('FAKE_') ||
        key.startsWith('AGB_') ||
        key.startsWith('ADLC_') ||
        key === 'ANTIGRAVITY_CONVERSATION_ID'
      ) {
        spawnEnv[key] = val;
      }
    }
    if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
      spawnEnv.ANTIGRAVITY_CONVERSATION_ID = process.env.ANTIGRAVITY_CONVERSATION_ID;
    }
    if (process.env.AGB_SESSION_ID) {
      spawnEnv.AGB_SESSION_ID = process.env.AGB_SESSION_ID;
    }
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (!FORBIDDEN_SECRETS.includes(k) && !SENSITIVE_KEY_PATTERN.test(k)) {
          spawnEnv[k] = v;
        }
      }
    }
    for (const key of Object.keys(spawnEnv)) {
      if (FORBIDDEN_SECRETS.includes(key) || SENSITIVE_KEY_PATTERN.test(key)) {
        delete spawnEnv[key];
      }
    }
    if (isBuilder) {
      if (cwd) {
        const agbHome = join(cwd, '.agb_home');
        try { mkdirSync(agbHome, { recursive: true, mode: 0o700 }); } catch {}
        spawnEnv.HOME = agbHome;
        spawnEnv.XDG_CONFIG_HOME = agbHome;
      } else if (!spawnEnv.HOME && process.env.HOME) {
        spawnEnv.HOME = process.env.HOME;
      }
      if (repo || cwd) {
        const rootDir = repo ?? dirname(cwd);
        spawnEnv.GIT_CEILING_DIRECTORIES = join(rootDir, '.worktrees');
      }
      spawnEnv.GIT_CONFIG_NOSYSTEM = '1';
      spawnEnv.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    }

    const spawnOpts = { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv };
    if (process.platform !== 'win32') {
      spawnOpts.detached = true;
    }
    const p = spawn(launchBin, launchArgs, spawnOpts);
    let out = '';
    let err = '';
    let resolved = false;

    // Streaming state
    let currentLineBuffer = Buffer.alloc(0);
    let totalBytes = 0;
    let consecutiveGarbageBytes = 0;
    const events = [];
    let terminalResult = null;
    let killReason = null;

    const killProcessTree = (sig = 'SIGTERM') => {
      try {
        if (systemdUnit) {
          try {
            execFileSync('systemctl', ['--user', 'stop', systemdUnit], { stdio: 'ignore', timeout: 5000 });
          } catch {}
        }
        if (process.platform === 'win32' && p.pid) {
          try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
        } else if (p.pid) {
          try { process.kill(-p.pid, sig); } catch {}
        }
        p.kill(sig);
      } catch {}
    };

    const terminateTree = () => {
      killProcessTree('SIGTERM');
      let killTimer = setTimeout(() => {
        killProcessTree('SIGKILL');
      }, 10_000);
      killTimer.unref?.();
    };

    const maxTimeoutMs = parseTimeoutMs(maxTimeout ?? process.env.AGB_BUILD_MAX_TIMEOUT ?? '30m');
    const eventProgressTimeoutMs = parseTimeoutMs(eventProgressTimeout ?? process.env.AGB_EVENT_PROGRESS_TIMEOUT ?? '5m');

    let eventProgressTimer = null;
    const resetEventProgressTimer = () => {
      if (eventProgressTimer) clearTimeout(eventProgressTimer);
      eventProgressTimer = setTimeout(() => {
        if (resolved) return;
        killReason = { kind: 'timeout', error: 'event progress watchdog timed out' };
        terminateTree();
      }, eventProgressTimeoutMs);
      eventProgressTimer.unref?.();
    };

    let maxWallClockTimer = null;
    maxWallClockTimer = setTimeout(() => {
      if (resolved) return;
      killReason = { kind: 'timeout', error: 'orchestrator wall-clock ceiling exceeded' };
      terminateTree();
    }, maxTimeoutMs);
    maxWallClockTimer.unref?.();

    let timer = null;
    if (outputFormat === 'stream-json') {
      resetEventProgressTimer();
    } else {
      const timeoutMs = parseTimeoutMs(timeout);
      const killGraceMs = 15_000;
      timer = setTimeout(() => {
        if (resolved) return;
        terminateTree();
        if (!out.includes('Error: timed out waiting for response')) {
          out = (out ? out + '\n' : '') + 'Error: timed out waiting for response.';
        }
      }, timeoutMs + killGraceMs);
      timer.unref?.();
    }

    const flushStreamBuffer = () => {
      if (outputFormat === 'stream-json' && currentLineBuffer.length > 0) {
        if (currentLineBuffer.length > MAX_STREAM_LINE_BYTES) {
          killReason = { kind: 'stream_overflow', error: 'stream line exceeded 1MB limit' };
          return;
        }
        const lineStr = currentLineBuffer.toString('utf8').trim();
        currentLineBuffer = Buffer.alloc(0);
        if (lineStr) {
          let validEvent = false;
          try {
            const ev = JSON.parse(lineStr);
            if (ev && typeof ev === 'object' && ev.type) {
              if (ev.type === 'step_update' && typeof ev.step === 'number' && typeof ev.action === 'string') {
                validEvent = true;
                events.push(ev);
              } else if (ev.type === 'heartbeat' && typeof ev.timestamp === 'number') {
                validEvent = true;
                events.push(ev);
              } else if (ev.type === 'result' && (ev.status === 'SUCCESS' || ev.status === 'ERROR') && typeof ev.exit_code === 'number') {
                validEvent = true;
                if (!terminalResult) {
                  terminalResult = ev;
                  events.push(ev);
                }
              }
            }
          } catch {}

          if (validEvent) {
            consecutiveGarbageBytes = 0;
            resetEventProgressTimer();
          } else {
            consecutiveGarbageBytes += Buffer.byteLength(lineStr);
            if (consecutiveGarbageBytes > MAX_CONSECUTIVE_GARBAGE_BYTES) {
              killReason = { kind: 'stream_corruption', error: 'exceeded 5MB consecutive garbage without valid stream event' };
            }
          }
        }
      }
    };

    const finish = async (code, signal, spawnError) => {
      if (resolved) return;
      resolved = true;
      flushStreamBuffer();
      if (timer) clearTimeout(timer);
      if (eventProgressTimer) clearTimeout(eventProgressTimer);
      if (maxWallClockTimer) clearTimeout(maxWallClockTimer);
      const ms = Date.now() - t0;
      let kind = null;
      let errorMsg = null;

      if (outputFormat === 'stream-json') {
        if (killReason) {
          kind = killReason.kind;
          errorMsg = killReason.error;
        } else if (spawnError) {
          kind = 'spawn';
          errorMsg = `spawn: ${spawnError.message}`;
        } else if (code === null && signal === null) {
          kind = 'spawn';
          errorMsg = `spawn: failed to start`;
        } else if (terminalResult) {
          if (terminalResult.status === 'ERROR') {
            kind = 'server';
            errorMsg = `terminal result status ERROR: exit_code ${terminalResult.exit_code}`;
          } else if (terminalResult.status === 'SUCCESS') {
            if (terminalResult.exit_code !== 0 && terminalResult.exit_code !== undefined && terminalResult.exit_code !== null) {
              kind = 'server';
              errorMsg = `terminal result SUCCESS carries non-zero exit_code: ${terminalResult.exit_code}`;
            } else if (code !== 0) {
              kind = 'server_shutdown_error';
              errorMsg = `process exited with code ${code} despite terminal result SUCCESS`;
            } else {
              kind = null;
            }
          } else {
            kind = 'server';
            errorMsg = `terminal result unexpected status '${terminalResult.status}': exit_code ${terminalResult.exit_code}`;
          }
        } else {
          // No terminal result event!
          if (code !== 0) {
            kind = 'cli';
            errorMsg = `exit ${code}: ${(err || out).slice(-300)}`;
          } else {
            kind = 'missing_terminal_result';
            errorMsg = 'process exited with 0 without emitting terminal result';
          }
        }
      } else {
        const timedOut = isAgyTimeout(out);
        if (spawnError) {
          kind = 'spawn';
          errorMsg = `spawn: ${spawnError.message}`;
        } else if (code === null && signal === null) {
          kind = 'spawn';
          errorMsg = `spawn: failed to start`;
        } else if (timedOut) {
          kind = 'timeout';
          errorMsg = 'print-timeout';
        } else if (code !== 0) {
          kind = 'server';
          errorMsg = `exit ${code}: ${(err || out).slice(-300)}`;
        } else if (out.trim().length === 0) {
          kind = 'empty';
          errorMsg = `exit 0: empty output`;
        }
      }

      let ok = kind === null;
      let result = { ok, output: out, ms, error: errorMsg, kind };
      if (outputFormat === 'stream-json') {
        result.events = events;
        result.terminalResult = terminalResult;
      }
      if (ok && outputFormat === 'json') {
        try {
          const parsed = JSON.parse(out);
          if (parsed && typeof parsed === 'object') {
            result.envelope = parsed;
            const statusStr = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
            if (statusStr === 'error' || statusStr === 'failed') {
              ok = false;
              kind = 'envelope_error';
              errorMsg = `agy returned error status in JSON envelope: ${parsed.status}${parsed.error || parsed.response ? ` (${parsed.error || parsed.response})` : ''}`;
              result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed };
            } else if (jsonSchema) {
              let structured = parsed.structured_output;
              if (structured === undefined || structured === null) {
                if (
                  parsed.status !== undefined ||
                  parsed.type === 'result' ||
                  parsed.response !== undefined ||
                  parsed.error !== undefined
                ) {
                  ok = false;
                  kind = 'missing_structured_output';
                  errorMsg = 'agy JSON response envelope missing required structured_output';
                  result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed };
                } else {
                  structured = parsed;
                }
              }
              if (ok) {
                if (typeof structured === 'string') {
                  try {
                    structured = JSON.parse(structured);
                  } catch (e) {
                    ok = false;
                    kind = 'schema_violation';
                    errorMsg = `structured_output is invalid JSON: ${e.message}`;
                    result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed };
                  }
                }
                if (ok) {
                  result.data = structured;
                }
              }
            } else {
              let structured = parsed.structured_output !== undefined
                ? parsed.structured_output
                : (parsed.response !== undefined ? parsed.response : parsed);
              if (typeof structured === 'string') {
                try { structured = JSON.parse(structured); } catch {}
              }
              result.data = structured;
            }
          }
        } catch (e) {
          ok = false;
          kind = 'schema_violation';
          errorMsg = `Invalid JSON structured output: ${e.message}`;
          result = { ok, output: out, ms, error: errorMsg, kind };
        }
      }

      if (logFile) {
        mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
        const record = {
          ts: new Date().toISOString(), model, cwd, strike, ms, prompt, output: out, ok, role,
        };
        if (!ok) {
          record.kind = kind;
          record.error = result.error;
        }
        await appendFile(logFile, JSON.stringify(record) + '\n', { mode: 0o600 });
      }
      resolve(result);
    };

    p.stdout.on('data', (d) => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      out += d;

      if (outputFormat === 'stream-json') {
        totalBytes += chunk.length;
        if (totalBytes > MAX_STREAM_TOTAL_BYTES) {
          killReason = { kind: 'stream_overflow', error: 'total stream size exceeded 50MB limit' };
          terminateTree();
          return;
        }

        currentLineBuffer = Buffer.concat([currentLineBuffer, chunk]);

        let newlineIndex;
        while ((newlineIndex = currentLineBuffer.indexOf(0x0a)) !== -1) {
          const lineBuf = currentLineBuffer.subarray(0, newlineIndex);
          currentLineBuffer = currentLineBuffer.subarray(newlineIndex + 1);

          if (lineBuf.length > MAX_STREAM_LINE_BYTES) {
            killReason = { kind: 'stream_overflow', error: 'stream line exceeded 1MB limit' };
            terminateTree();
            return;
          }

          const lineStr = lineBuf.toString('utf8').trim();
          if (!lineStr) continue;

          let validEvent = false;
          try {
            const ev = JSON.parse(lineStr);
            if (ev && typeof ev === 'object' && ev.type) {
              if (ev.type === 'step_update' && typeof ev.step === 'number' && typeof ev.action === 'string') {
                validEvent = true;
                events.push(ev);
              } else if (ev.type === 'heartbeat' && typeof ev.timestamp === 'number') {
                validEvent = true;
                events.push(ev);
              } else if (ev.type === 'result' && (ev.status === 'SUCCESS' || ev.status === 'ERROR') && typeof ev.exit_code === 'number') {
                validEvent = true;
                if (!terminalResult) {
                  terminalResult = ev;
                  events.push(ev);
                } else {
                  console.warn('[agb] Warning: duplicate terminal result event received; first result wins');
                }
              }
            }
          } catch {}

          if (validEvent) {
            consecutiveGarbageBytes = 0;
            resetEventProgressTimer();
          } else {
            consecutiveGarbageBytes += Buffer.byteLength(lineStr);
            if (consecutiveGarbageBytes > MAX_CONSECUTIVE_GARBAGE_BYTES) {
              killReason = { kind: 'stream_corruption', error: 'exceeded 5MB consecutive garbage without valid stream event' };
              terminateTree();
              return;
            }
          }
        }

        if (currentLineBuffer.length > MAX_STREAM_LINE_BYTES) {
          killReason = { kind: 'stream_overflow', error: 'stream line exceeded 1MB limit' };
          terminateTree();
        }
      }
    });

    let stdoutEnded = false;
    let pendingExit = null;

    const maybeFinish = () => {
      if (pendingExit && stdoutEnded) {
        finish(pendingExit.code, pendingExit.signal, pendingExit.err);
      }
    };

    p.stdout.on('end', () => {
      stdoutEnded = true;
      flushStreamBuffer();
      maybeFinish();
    });
    p.stdout.on('close', () => {
      stdoutEnded = true;
      flushStreamBuffer();
      maybeFinish();
    });

    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      pendingExit = { code: null, signal: null, err: e };
      stdoutEnded = true;
      maybeFinish();
    });
    p.on('close', (code, signal) => {
      pendingExit = { code, signal, err: null };
      flushStreamBuffer();
      if (stdoutEnded || p.stdout.readableEnded) {
        stdoutEnded = true;
        maybeFinish();
      } else {
        setTimeout(() => {
          if (!stdoutEnded) {
            stdoutEnded = true;
            flushStreamBuffer();
            maybeFinish();
          }
        }, 2000).unref?.();
      }
    });
  });
}

export const QUOTA_RESPONSE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['gemini', 'claude_gpt'],
  properties: {
    gemini: {
      type: 'object',
      additionalProperties: false,
      required: ['fiveHourRemainingPercent', 'weeklyRemainingPercent', 'fiveHourResetTime', 'weeklyResetTime'],
      properties: {
        fiveHourRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        weeklyRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        fiveHourResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
        weeklyResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
      },
    },
    claude_gpt: {
      type: 'object',
      additionalProperties: false,
      required: ['fiveHourRemainingPercent', 'weeklyRemainingPercent', 'fiveHourResetTime', 'weeklyResetTime'],
      properties: {
        fiveHourRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        weeklyRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        fiveHourResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
        weeklyResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
      },
    },
  },
};

export const STREAM_EVENT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    {
      additionalProperties: false,
      required: ['type', 'step', 'action'],
      properties: {
        type: { type: 'string', enum: ['step_update'] },
        step: { type: 'integer', minimum: 0 },
        action: { type: 'string', minLength: 1, maxLength: 1024 },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'status', 'exit_code'],
      properties: {
        type: { type: 'string', enum: ['result'] },
        status: { type: 'string', enum: ['SUCCESS', 'ERROR'] },
        exit_code: { type: 'integer' },
        telemetry: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input_tokens: { type: 'integer', minimum: 0 },
            output_tokens: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'timestamp'],
      properties: {
        type: { type: 'string', enum: ['heartbeat'] },
        timestamp: { type: 'integer', minimum: 0 },
      },
    },
  ],
};

export const PROSECUTION_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'block'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'charge', 'claim'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          charge: { type: 'string' },
          claim: { type: 'string' },
          file: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

export const COLDSTART_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['gaps'],
  properties: {
    gaps: { type: 'array', items: { type: 'string' } },
  },
};

export const PARALLAX_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['ambiguities'],
  properties: {
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
};

export const BRAIN_PLAN_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'gate', 'tickets'],
  properties: {
    repo: { type: 'string' },
    base: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' },
    concurrencyCap: { type: ['integer', 'null'], minimum: 1 },
    gate: {
      type: 'object',
      additionalProperties: false,
      required: ['test'],
      properties: {
        build: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_-]+)$' },
        test: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_-]+)$' },
      },
    },
    tickets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'body', 'scope', 'rails', 'edges', 'tier'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          title: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          scope: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*))*(?:/\\*{1,2}(?:\\.[a-zA-Z0-9]+)?)?$',
            },
          },
          rails: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*))*(?:/\\*{1,2}(?:\\.[a-zA-Z0-9]+)?)?$',
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['to'],
              properties: {
                to: { type: 'string' },
                contract: { type: 'string' },
              },
            },
          },
          tier: { type: 'string', enum: ['cheap', 'mid', 'frontier'] },
          pool_hint: { type: 'string', enum: ['gemini', 'claude', 'claude-gpt', 'auto'] },
        },
      },
    },
  },
};
