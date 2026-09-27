// agy subprocess wrapper. One function, one process, structured result.
//
// Calibration facts this encodes (docs/calibration/):
//   - agy 1.1.1 returns non-zero exit code + stderr on server-side failure
//   - prompt goes on stdin; AGENTS.md/GEMINI.md in cwd auto-load
//   - model names are the exact `agy models` strings

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmdirSync, unlinkSync, realpathSync, openSync, writeSync, closeSync, constants, rmSync, mkdtempSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { verifyWindowsSandboxAttestation, verifyWindowsSandboxActive } from './doctor.mjs';
import { isProcessAlive, getProcessStartTime } from './pools.mjs';

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

export const DANGEROUS_RUNTIME_ENV_VARS = [
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'PERL5OPT',
  'PYTHONPATH',
  'RUBYOPT',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

export function isAllowedEnvVar(key) {
  if (typeof key !== 'string') return false;
  if (FORBIDDEN_SECRETS.includes(key) || SENSITIVE_KEY_PATTERN.test(key)) return false;
  if (DANGEROUS_RUNTIME_ENV_VARS.includes(key)) return false;
  return (
    ENV_ALLOWLIST.includes(key) ||
    key.startsWith('FAKE_') ||
    key.startsWith('AGB_') ||
    key.startsWith('ADLC_') ||
    key === 'ANTIGRAVITY_CONVERSATION_ID'
  );
}

export function verifySandboxBypassAttestation(repoPath, platform = process.platform, { consumeNonce = true } = {}) {
  if (platform !== 'win32') {
    return { valid: false, reason: `Sandbox bypass attestation is only supported on Windows (platform is ${platform})` };
  }
  return verifyWindowsSandboxAttestation({ repo: repoPath, platform, consumeNonce });
}

export function checkKernelContainment(platform = process.platform) {
  if (process.env.AGB_MOCK_CONTAINMENT_UNAVAILABLE === '1') {
    return { supported: false, mechanism: null, detail: 'Kernel containment floor unavailable (mocked)' };
  }
  if (process.env.AGB_MOCK_CONTAINMENT_MECHANISM) {
    return { supported: true, mechanism: process.env.AGB_MOCK_CONTAINMENT_MECHANISM };
  }
  if (platform === 'win32') {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 5000 });
      return { supported: true, mechanism: 'job_object' };
    } catch {
      return { supported: false, mechanism: null, detail: 'powershell.exe is unavailable to initialize Windows Job Object containment' };
    }
  }
  if (platform === 'linux') {
    try {
      const probeArgs = ['--proc', '/proc', '--dev', '/dev', '--unshare-pid'];
      for (const d of ['/usr', '/bin', '/lib', '/lib64']) {
        if (existsSync(d)) probeArgs.push('--ro-bind', d, d);
      }
      probeArgs.push('--', 'true');
      execFileSync('bwrap', probeArgs, { stdio: 'ignore', timeout: 5000 });
      return { supported: true, mechanism: 'bwrap_pid' };
    } catch {}
    return {
      supported: false,
      mechanism: null,
      detail: 'Kernel containment floor unavailable on Linux: bubblewrap (bwrap) is required for filesystem and namespace isolation. Fallback mechanisms (systemd-run, unshare) provide insufficient filesystem isolation.'
    };
  }
  if (platform === 'darwin') {
    try {
      execFileSync('sandbox-exec', ['-p', '(version 1) (allow default)', 'true'], { stdio: 'ignore' });
      return { supported: true, mechanism: 'seatbelt' };
    } catch {
      return { supported: false, mechanism: null, detail: 'sandbox-exec is unavailable on darwin' };
    }
  }
  if (platform.includes('bsd')) {
    return { supported: false, mechanism: null, detail: 'Kernel containment floor unavailable on bsd' };
  }
  return { supported: false, mechanism: null, detail: `Unsupported platform: ${platform}` };
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

const RETIRED_35_MAP = {
  'gemini-3.5-flash-low': 'gemini-3.8-flash-low',
  'gemini-3.5-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-high': 'gemini-3.8-flash-high',
  'gemini 3.5 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.5 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.5 flash (high)': 'gemini-3.8-flash-high',
};

export function resolveModelSlug(model) {
  if (typeof model !== 'string') return model;
  const normalized = model.trim().toLowerCase();
  if (RETIRED_35_MAP[normalized]) {
    const resolved = RETIRED_35_MAP[normalized];
    console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    return resolved;
  }
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
export async function runAgy({
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
  onSpawn,
  platform = process.platform,
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
  let verifiedBypass = null;
  if (isBuilder) {
    if (!sandbox) {
      if (platform !== 'win32') {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Builder sandbox is mandatory on ${platform} and cannot be disabled or bypassed.`,
          kind: 'containment_unavailable',
        });
      }
      verifiedBypass = verifySandboxBypassAttestation(repo ?? cwd, platform);
      if (!verifiedBypass.valid) {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Sandbox bypass denied: ${verifiedBypass.reason}`,
          kind: 'containment_unavailable',
        });
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
  let argsTempFile = null;
  let argsTempDir = null;
  let bwrapTempDir = null;

  if (isBuilder) {
    if (!containment) {
      if (platform !== 'win32') {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Builder containment is mandatory on ${platform} and cannot be disabled or bypassed.`,
          kind: 'containment_unavailable',
        });
      }
      const bypass = verifiedBypass ?? verifySandboxBypassAttestation(repo ?? cwd, platform);
      if (!bypass.valid) {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Builder containment cannot be disabled without an authenticated bypass attestation: ${bypass.reason}`,
          kind: 'containment_unavailable',
        });
      }
    } else {
      const containmentCheck = checkKernelContainment(platform);
      if (!containmentCheck.supported) {
        if (platform !== 'win32') {
          return Promise.resolve({
            ok: false,
            output: '',
            ms: 0,
            error: `Kernel containment floor unavailable on ${platform}: ${containmentCheck.detail}. Attestation bypass is restricted to Windows.`,
            kind: 'containment_unavailable',
          });
        }
        const bypass = verifiedBypass ?? verifySandboxBypassAttestation(repo ?? cwd, platform);
        if (!bypass.valid) {
          return Promise.resolve({
            ok: false,
            output: '',
            ms: 0,
            error: `Kernel containment floor unavailable: ${containmentCheck.detail}. Authenticated bypass attestation required: ${bypass.reason}`,
            kind: 'containment_unavailable',
          });
        }
      } else if (containmentCheck.mechanism === 'cgroups_v2_scope' || containmentCheck.mechanism === 'pid_namespace') {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Kernel containment floor unavailable: mechanism '${containmentCheck.mechanism}' provides insufficient filesystem isolation (bwrap required on Linux)`,
          kind: 'containment_unavailable',
        });
      } else if (containmentCheck.mechanism === 'bwrap_pid') {
        const allowedDir = cwd ?? repo ?? process.cwd();
        let realAllowedDir;
        try { realAllowedDir = realpathSync(allowedDir); } catch { realAllowedDir = resolve(allowedDir); }
        bwrapTempDir = mkdtempSync(join(tmpdir(), 'agb-bwrap-tmp-'));
        launchBin = 'bwrap';
        launchArgs = [
          '--dev', '/dev',
          '--proc', '/proc',
          '--unshare-pid',
          '--die-with-parent',
          '--bind', bwrapTempDir, '/tmp',
        ];

        // Mount standard system runtime directories read-only
        const standardRoDirs = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt'];
        for (const d of standardRoDirs) {
          if (existsSync(d)) {
            launchArgs.push('--ro-bind', d, d);
          }
        }

        // Support DNS resolution on Linux hosts using systemd-resolved or resolvconf
        if (existsSync('/run/systemd/resolve')) {
          launchArgs.push('--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve');
        }
        if (existsSync('/run/resolvconf')) {
          launchArgs.push('--ro-bind', '/run/resolvconf', '/run/resolvconf');
        }

        // Mount explicit worktree directory read-write
        if (existsSync(realAllowedDir)) {
          launchArgs.push('--bind', realAllowedDir, realAllowedDir);
        }

        // Support test harness state recording in offline tests
        const testStateDir = env?.FAKE_STATE_DIR || process.env.FAKE_STATE_DIR;
        if (testStateDir && existsSync(testStateDir)) {
          launchArgs.push('--bind', testStateDir, testStateDir);
        }

        // Mask sensitive credentials if they exist within the worktree
        const sensitiveWorktreeFiles = [
          join(realAllowedDir, '.netrc'),
          join(realAllowedDir, '.git-credentials'),
          join(realAllowedDir, '.ssh'),
          join(realAllowedDir, '.aws'),
        ];
        for (const sFile of sensitiveWorktreeFiles) {
          if (existsSync(sFile)) {
            launchArgs.push('--ro-bind', '/dev/null', sFile);
          }
        }

        // Preserve agy binary and its runtime directory inside bwrap namespace
        let resolvedAgy = null;
        if (agyBin.includes('/') || agyBin.includes('\\')) {
          try { resolvedAgy = realpathSync(resolve(agyBin)); } catch { resolvedAgy = resolve(agyBin); }
        } else {
          const pathEnv = process.env.PATH || '';
          for (const entry of pathEnv.split(':')) {
            if (!entry) continue;
            const candidate = join(entry, agyBin);
            if (existsSync(candidate)) {
              try { resolvedAgy = realpathSync(candidate); } catch { resolvedAgy = candidate; }
              break;
            }
          }
        }
        if (resolvedAgy && existsSync(resolvedAgy)) {
          launchArgs.push('--ro-bind', resolvedAgy, resolvedAgy);
          const agyDir = dirname(resolvedAgy);
          if (existsSync(agyDir)) {
            launchArgs.push('--ro-bind', agyDir, agyDir);
          }
        }

        // Preserve node binary and its runtime directory inside bwrap namespace
        let resolvedNode = null;
        try { resolvedNode = realpathSync(process.execPath); } catch { resolvedNode = process.execPath; }
        if (resolvedNode && existsSync(resolvedNode)) {
          launchArgs.push('--ro-bind', resolvedNode, resolvedNode);
          const nodeDir = dirname(resolvedNode);
          if (existsSync(nodeDir)) {
            launchArgs.push('--ro-bind', nodeDir, nodeDir);
          }
        }

        launchArgs.push('--', agyBin, ...args);
    } else if (containmentCheck.mechanism === 'job_object') {
      const bypass = verifiedBypass ?? verifySandboxBypassAttestation(repo ?? cwd, platform, { consumeNonce: false });
      if (!bypass?.valid) {
        const activeRes = await verifyWindowsSandboxActive({ cwd: cwd ?? repo, env: env ? { ...process.env, ...env } : process.env });
        if (activeRes.level !== 'pass') {
          return {
            ok: false,
            output: '',
            ms: 0,
            error: `Kernel containment floor unavailable on Windows: Job Object provides process lifetime containment but not filesystem/network isolation. Active Windows AppContainer sandbox verification failed: ${activeRes.detail}. ${activeRes.fix || ''}`.trim(),
            kind: 'containment_unavailable',
          };
        }
      }
      const wrapperScript = fileURLToPath(new URL('./job-object-wrapper.ps1', import.meta.url));
      const argsJson = JSON.stringify(args);
      if (argsJson.length < 8192) {
        const argsBase64 = Buffer.from(argsJson, 'utf8').toString('base64');
        launchBin = 'powershell.exe';
        launchArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperScript, '-TargetBin', agyBin, '-ArgsBase64', argsBase64];
      } else {
        const secureBase = join(homedir(), '.adlc', 'tmp');
        mkdirSync(secureBase, { recursive: true, mode: 0o700 });
        argsTempDir = mkdtempSync(join(secureBase, 'agb-args-'));
        try {
          if (process.platform === 'win32') {
            execFileSync('icacls.exe', [argsTempDir, '/inheritance:r', '/grant:r', `${process.env.USERNAME || 'CURRENT_USER'}:(OI)(CI)F`], { stdio: 'ignore' });
          }
        } catch {}
        argsTempFile = join(argsTempDir, `args-${crypto.randomUUID().slice(0, 8)}.json`);
        const fd = openSync(argsTempFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeSync(fd, argsJson, 0, 'utf8');
        closeSync(fd);
        launchBin = 'powershell.exe';
        launchArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperScript, '-TargetBin', agyBin, '-ArgsFile', argsTempFile];
      }
    } else if (containmentCheck.mechanism === 'seatbelt') {
      const allowedDir = cwd ?? process.cwd();
      if (/[\r\n\0]/.test(allowedDir)) {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Unsafe worktree path for seatbelt containment: path contains invalid characters`,
          kind: 'containment_unavailable',
        });
      }
      const homeDir = homedir();
      const escapedAllowedDir = allowedDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const escapedHome = homeDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      let extraReadPaths = '';
      try {
        const agyRealDir = dirname(realpathSync(agyBin)).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        extraReadPaths += `\n(allow file-read* (subpath "${agyRealDir}"))`;
      } catch {}
      try {
        const nodeRealDir = dirname(realpathSync(process.execPath)).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        extraReadPaths += `\n(allow file-read* (subpath "${nodeRealDir}"))`;
      } catch {}
      const seatbeltProfile = `(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read* (subpath "/System"))\n(allow file-read* (subpath "/usr"))\n(allow file-read* (subpath "/bin"))\n(allow file-read* (subpath "/sbin"))\n(allow file-read* (subpath "/Library"))\n(allow file-read* (subpath "/opt"))\n(allow file-read* (subpath "/Applications"))\n(allow file-read* (subpath "/private/tmp"))\n(allow file-read* (subpath "/tmp"))\n(allow file-read* (subpath "/private/var"))\n(allow file-read* (subpath "/dev"))\n(allow file-read* (subpath "/etc"))\n(allow file-read* (subpath "${escapedAllowedDir}"))${extraReadPaths}\n(deny file-read* (subpath "${escapedHome}/.ssh"))\n(deny file-read* (subpath "${escapedHome}/.aws"))\n(deny file-read* (subpath "${escapedHome}/.gnupg"))\n(allow file-write* (subpath "${escapedAllowedDir}"))\n(allow file-write* (subpath "/private/tmp"))\n(allow file-write* (subpath "/tmp"))\n(allow file-write* (regex #"^/dev/(null|zero|dtracehelper|tty)"))\n(allow network-outbound)`;
      launchBin = 'sandbox-exec';
      launchArgs = ['-p', seatbeltProfile, agyBin, ...args];
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
}

  return new Promise((resolve) => {
    const t0 = Date.now();
    let spawnEnv = {};
    const shouldSanitize = sanitizeEnv || isBuilder;
    if (shouldSanitize) {
      for (const [key, val] of Object.entries(process.env)) {
        if (isAllowedEnvVar(key)) {
          spawnEnv[key] = val;
        }
      }
      if (process.env.ANTIGRAVITY_CONVERSATION_ID && isAllowedEnvVar('ANTIGRAVITY_CONVERSATION_ID')) {
        spawnEnv.ANTIGRAVITY_CONVERSATION_ID = process.env.ANTIGRAVITY_CONVERSATION_ID;
      }
      if (process.env.AGB_SESSION_ID && isAllowedEnvVar('AGB_SESSION_ID')) {
        spawnEnv.AGB_SESSION_ID = process.env.AGB_SESSION_ID;
      }
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          if (isAllowedEnvVar(k)) {
            spawnEnv[k] = v;
          }
        }
      }
    } else {
      spawnEnv = { ...process.env, ...(env || {}) };
    }
    if (isBuilder) {
      delete spawnEnv.XDG_RUNTIME_DIR;
      delete spawnEnv.DBUS_SESSION_BUS_ADDRESS;
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
    const originalPid = p?.pid ?? null;
    const originalStartTime = originalPid ? getProcessStartTime(originalPid) : null;
    if (typeof onSpawn === 'function' && p) {
      try { onSpawn(p); } catch {}
    }
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
    let childKilled = false;
    const recordKillReason = (reason) => {
      if (!killReason) {
        killReason = reason;
      }
    };

    const killProcessTree = (sig = 'SIGTERM') => {
      try {
        if (systemdUnit) {
          try {
            execFileSync('systemctl', ['--user', 'stop', systemdUnit], { stdio: 'ignore', timeout: 5000 });
          } catch {}
        }
        if (originalPid && isProcessAlive(originalPid, originalStartTime)) {
          if (process.platform === 'win32') {
            try { execFileSync('taskkill', ['/pid', String(originalPid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          } else {
            try { process.kill(-originalPid, sig); } catch {}
            try {
              const pids = execFileSync('pgrep', ['-P', String(originalPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
              for (const pidStr of pids) {
                const subPid = Number(pidStr);
                if (subPid) {
                  try { process.kill(subPid, sig); } catch {}
                }
              }
            } catch {}
          }
        }
        p.kill(sig);
      } catch {}
    };

    let delayedKillTimer = null;
    const terminateTree = () => {
      if (childKilled) return;
      childKilled = true;
      killProcessTree('SIGTERM');
      delayedKillTimer = setTimeout(() => {
        killProcessTree('SIGKILL');
      }, 10_000);
      delayedKillTimer.unref?.();
    };

    const maxTimeoutMs = parseTimeoutMs(maxTimeout ?? process.env.AGB_BUILD_MAX_TIMEOUT ?? '30m');
    const eventProgressTimeoutMs = parseTimeoutMs(eventProgressTimeout ?? process.env.AGB_EVENT_PROGRESS_TIMEOUT ?? '5m');

    let eventProgressTimer = null;
    const resetEventProgressTimer = () => {
      if (eventProgressTimer) clearTimeout(eventProgressTimer);
      eventProgressTimer = setTimeout(() => {
        if (resolved) return;
        recordKillReason({ kind: 'timeout', error: 'event progress watchdog timed out' });
        terminateTree();
      }, eventProgressTimeoutMs);
      eventProgressTimer.unref?.();
    };

    let maxWallClockTimer = null;
    maxWallClockTimer = setTimeout(() => {
      if (resolved) return;
      recordKillReason({ kind: 'timeout', error: 'orchestrator wall-clock ceiling exceeded' });
      terminateTree();
      if (!out.includes('Error: timed out waiting for response')) {
        out = (out ? out + '\n' : '') + 'Error: timed out waiting for response.';
      }
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
        recordKillReason({ kind: 'timeout', error: 'print-timeout' });
        terminateTree();
        if (!out.includes('Error: timed out waiting for response')) {
          out = (out ? out + '\n' : '') + 'Error: timed out waiting for response.';
        }
      }, timeoutMs + killGraceMs);
      timer.unref?.();
    }

    const flushStreamBuffer = () => {
      if (killReason) return;
      if (outputFormat === 'stream-json' && currentLineBuffer.length > 0) {
        if (currentLineBuffer.length > MAX_STREAM_LINE_BYTES) {
          recordKillReason({ kind: 'stream_overflow', error: 'stream line exceeded 1MB limit' });
          terminateTree();
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
              recordKillReason({ kind: 'stream_corruption', error: 'exceeded 5MB consecutive garbage without valid stream event' });
              terminateTree();
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
      if (delayedKillTimer) {
        clearTimeout(delayedKillTimer);
        delayedKillTimer = null;
      }
      if (argsTempFile) {
        try { unlinkSync(argsTempFile); } catch {}
        argsTempFile = null;
      }
      if (argsTempDir) {
        try { rmSync(argsTempDir, { recursive: true, force: true }); } catch {}
        argsTempDir = null;
      }
      if (bwrapTempDir) {
        try { rmSync(bwrapTempDir, { recursive: true, force: true }); } catch {}
        bwrapTempDir = null;
      }
      if (childKilled || killReason || signal) {
        if (originalPid && isProcessAlive(originalPid, originalStartTime)) {
          try {
            if (process.platform === 'win32') {
              try { execFileSync('taskkill', ['/pid', String(originalPid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
            } else {
              try { process.kill(-originalPid, 'SIGTERM'); } catch {}
              try {
                const pids = execFileSync('pgrep', ['-P', String(originalPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
                for (const pidStr of pids) {
                  const subPid = Number(pidStr);
                  if (subPid) {
                    try { process.kill(subPid, 'SIGTERM'); } catch {}
                  }
                }
              } catch {}
              try { process.kill(-originalPid, 'SIGKILL'); } catch {}
              try {
                const pids = execFileSync('pgrep', ['-P', String(originalPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
                for (const pidStr of pids) {
                  const subPid = Number(pidStr);
                  if (subPid) {
                    try { process.kill(subPid, 'SIGKILL'); } catch {}
                  }
                }
              } catch {}
            }
          } catch {}
        }
      }
      const ms = Date.now() - t0;
      let kind = null;
      let errorMsg = null;

      if (killReason) {
        kind = killReason.kind;
        errorMsg = killReason.error;
      } else if (outputFormat === 'stream-json') {
        if (spawnError) {
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
                  const schemaObj = typeof jsonSchema === 'string' ? JSON.parse(jsonSchema) : jsonSchema;
                  const validation = validateJsonSchema(structured, schemaObj);
                  if (!validation.valid) {
                    ok = false;
                    kind = 'schema_violation';
                    errorMsg = `structured output violates schema: ${validation.errors.join('; ')}`;
                    result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed };
                  } else {
                    result.data = structured;
                  }
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
          } else {
            // Primitive parsed JSON (number, boolean, string, etc.)
            if (jsonSchema) {
              const schemaObj = typeof jsonSchema === 'string' ? JSON.parse(jsonSchema) : jsonSchema;
              const validation = validateJsonSchema(parsed, schemaObj);
              if (!validation.valid) {
                ok = false;
                kind = 'schema_violation';
                errorMsg = `structured output violates schema: ${validation.errors.join('; ')}`;
                result = { ok, output: out, ms, error: errorMsg, kind };
              } else {
                result.data = parsed;
              }
            } else {
              result.data = parsed;
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
      if (killReason) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      out += d;

      if (outputFormat === 'stream-json') {
        totalBytes += chunk.length;
        if (totalBytes > MAX_STREAM_TOTAL_BYTES) {
          recordKillReason({ kind: 'stream_overflow', error: 'total stream size exceeded 50MB limit' });
          terminateTree();
          return;
        }

        currentLineBuffer = Buffer.concat([currentLineBuffer, chunk]);

        let newlineIndex;
        while ((newlineIndex = currentLineBuffer.indexOf(0x0a)) !== -1) {
          const lineBuf = currentLineBuffer.subarray(0, newlineIndex);
          currentLineBuffer = currentLineBuffer.subarray(newlineIndex + 1);

          if (lineBuf.length > MAX_STREAM_LINE_BYTES) {
            recordKillReason({ kind: 'stream_overflow', error: 'stream line exceeded 1MB limit' });
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
              recordKillReason({ kind: 'stream_corruption', error: 'exceeded 5MB consecutive garbage without valid stream event' });
              terminateTree();
              return;
            }
          }
        }

        if (currentLineBuffer.length > MAX_STREAM_LINE_BYTES) {
          recordKillReason({ kind: 'stream_overflow', error: 'stream line exceeded 1MB limit' });
          terminateTree();
          return;
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

    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      pendingExit = { code: null, signal: null, err: e };
      stdoutEnded = true;
      maybeFinish();
    });
    p.on('close', (code, signal) => {
      pendingExit = { code, signal, err: null };
      flushStreamBuffer();
      if (stdoutEnded) {
        maybeFinish();
      } else {
        setTimeout(() => {
          if (!stdoutEnded) {
            stdoutEnded = true;
            flushStreamBuffer();
            maybeFinish();
          }
        }, 1000).unref?.();
      }
    });
  });
}

export function validateJsonSchema(data, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return { valid: true, errors: [] };
  const errors = [];

  // type check
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((t) => {
      if (t === 'null') return data === null;
      if (t === 'array') return Array.isArray(data);
      if (t === 'object') return data !== null && typeof data === 'object' && !Array.isArray(data);
      if (t === 'integer') return typeof data === 'number' && Number.isInteger(data);
      if (t === 'number') return typeof data === 'number' && !Number.isNaN(data);
      return typeof data === t;
    });
    if (!matches) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`);
      return { valid: false, errors };
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push(`${path}: value ${JSON.stringify(data)} not in enum [${schema.enum.join(', ')}]`);
    }
  }

  // numbers
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${path}: value ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${path}: value ${data} > maximum ${schema.maximum}`);
    }
  }

  // strings
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: length ${data.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push(`${path}: length ${data.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(data)) {
          errors.push(`${path}: value does not match pattern ${schema.pattern}`);
        }
      } catch {}
    }
  }

  // arrays
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${path}: items count ${data.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const itemRes = validateJsonSchema(data[i], schema.items, `${path}[${i}]`);
        if (!itemRes.valid) errors.push(...itemRes.errors);
      }
    }
  }

  // objects
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (data[req] === undefined) {
          errors.push(`${path}: missing required property '${req}'`);
        }
      }
    }
    if (schema.properties) {
      for (const [prop, propSchema] of Object.entries(schema.properties)) {
        if (data[prop] !== undefined) {
          const propRes = validateJsonSchema(data[prop], propSchema, `${path}.${prop}`);
          if (!propRes.valid) errors.push(...propRes.errors);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          errors.push(`${path}: unauthorized additional property '${key}'`);
        }
      }
    }
  }

  // anyOf
  if (Array.isArray(schema.anyOf)) {
    const anyMatches = schema.anyOf.some((sub) => validateJsonSchema(data, sub, path).valid);
    if (!anyMatches) {
      errors.push(`${path}: does not match anyOf schemas`);
    }
  }

  // oneOf
  if (Array.isArray(schema.oneOf)) {
    const oneMatches = schema.oneOf.filter((sub) => validateJsonSchema(data, sub, path).valid);
    if (oneMatches.length !== 1) {
      errors.push(`${path}: expected exactly one matching oneOf schema, matched ${oneMatches.length}`);
    }
  }

  return { valid: errors.length === 0, errors };
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
      anyOf: [
        { required: ['build'] },
        { required: ['test'] },
      ],
      properties: {
        build: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_:-]+)$' },
        test: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_:-]+)$' },
      },
    },
    tickets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'body', 'scope', 'edges'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          title: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          scope: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*))*$',
            },
          },
          rails: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*))*$',
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
          pool_hint: { type: 'string', enum: ['gemini', 'claude', 'claude-gpt', 'gpt-oss', 'auto'] },
        },
      },
    },
  },
};
