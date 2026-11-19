// agy subprocess wrapper. One function, one process, structured result.
//
// Calibration facts this encodes (docs/calibration/):
//   - agy 1.1.1 returns non-zero exit code + stderr on server-side failure
//   - prompt goes on stdin; AGENTS.md/GEMINI.md in cwd auto-load
//   - model names are the exact `agy models` strings

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmdirSync, unlinkSync, realpathSync, openSync, writeSync, closeSync, constants, rmSync, mkdtempSync, lstatSync, statSync, symlinkSync, readdirSync, copyFileSync, cpSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { verifyWindowsSandboxAttestation, verifyWindowsSandboxActive, checkKernelContainment, isTestExecution } from './doctor.mjs';
import { isProcessAlive, getProcessStartTime } from './pools.mjs';
import {
  MODELS,
  ALL_MODELS,
  MODEL_ALIASES,
  RETIRED_35_MAP,
  resolveModelSlug,
  poolOf,
  familyOf,
  upstreamPoolOf,
} from './models.mjs';
import { safeExtractJson } from './json.mjs';
import {
  validateJsonSchema,
  QUOTA_RESPONSE_SCHEMA,
  STREAM_EVENT_SCHEMA,
  PROSECUTION_VERDICT_SCHEMA,
  COLDSTART_VERDICT_SCHEMA,
  COLDSTART_FINDINGS_SCHEMA,
  COLDSTART_SCHEMA,
  PARALLAX_VERDICT_SCHEMA,
  BRAIN_PLAN_SCHEMA,
  REVIEW_FINDINGS_SCHEMA,
} from './schemas.mjs';

export {
  safeExtractJson,
  validateJsonSchema,
  QUOTA_RESPONSE_SCHEMA,
  STREAM_EVENT_SCHEMA,
  PROSECUTION_VERDICT_SCHEMA,
  COLDSTART_VERDICT_SCHEMA,
  COLDSTART_FINDINGS_SCHEMA,
  COLDSTART_SCHEMA,
  PARALLAX_VERDICT_SCHEMA,
  BRAIN_PLAN_SCHEMA,
  REVIEW_FINDINGS_SCHEMA,
};

export const MAX_STREAM_LINE_BYTES = 1024 * 1024; // 1 MB
export const MAX_STREAM_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_CONSECUTIVE_GARBAGE_BYTES = 5 * 1024 * 1024; // 5 MB
// Prompts larger than 24 KiB switch from `--print <prompt>` on argv to
// `--input-format text` over stdin so large diffs/specs never exceed Windows
// CreateProcess (32 KiB) or Linux MAX_ARG_STRLEN (128 KiB -> E2BIG).
export const MAX_ARGV_PROMPT_BYTES = 24 * 1024;

export const ENV_ALLOWLIST = [
  'PATH',
  'USER',
  'HOME',
  'LANG',
  'TERM',
  'NODE_ENV',
  'TMPDIR',
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

export function isAllowedEnvVar(key, env = process.env) {
  if (typeof key !== 'string') return false;
  if (FORBIDDEN_SECRETS.includes(key) || SENSITIVE_KEY_PATTERN.test(key)) return false;
  if (DANGEROUS_RUNTIME_ENV_VARS.includes(key)) return false;
  if (key.startsWith('FAKE_')) {
    return isTestExecution(env);
  }
  return (
    ENV_ALLOWLIST.includes(key) ||
    key.startsWith('AGB_') ||
    key.startsWith('ADLC_') ||
    key === 'ANTIGRAVITY_CONVERSATION_ID'
  );
}

export function verifySandboxBypassAttestation(repoPath, platform = process.platform, { consumeNonce = true, env = process.env } = {}) {
  if (platform !== 'win32') {
    return { valid: false, reason: `Sandbox bypass attestation is only supported on Windows (platform is ${platform})` };
  }
  const effectiveEnv = env ? { ...process.env, ...env } : process.env;
  return verifyWindowsSandboxAttestation({ repo: repoPath, platform, consumeNonce, env: effectiveEnv });
}

export { checkKernelContainment, isTestExecution };

export {
  MODELS,
  ALL_MODELS,
  MODEL_ALIASES,
  RETIRED_35_MAP,
  resolveModelSlug,
};

// agy's print-timeout marker is its entire output on failure. Matching it as
// a bare substring would false-trip when a model legitimately quotes the
// phrase, so require it to be the sole trailing line of short output.
export function isAgyTimeout(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^Error: (?:timed out waiting for response|MCP (?:tool call|server connection|connection) timed out|timed out waiting for MCP response)\.?$/i.test(last) && out.length < 300;
}

export {
  poolOf,
  familyOf,
  upstreamPoolOf,
};

export const FAILURE_FINISHED_REASONS = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled', 'max_tokens', 'length', 'safety', 'recitation']);

export const ALL_AGY_ERROR_KINDS = Object.freeze([
  'containment_unavailable',
  'stream_overflow',
  'stream_corruption',
  'timeout',
  'spawn',
  'signal',
  'interrupted',
  'model_unavailable',
  'envelope_error',
  'server',
  'server_shutdown_error',
  'cli',
  'missing_terminal_result',
  'missing_structured_output',
  'schema_violation',
  'empty',
  'unclassified',
]);

const AGY_ERROR_LINE_RE = /^AGY_ERROR:\s*(\{[^\r\n]*\})$/;
const MODEL_UNAVAILABLE_MSG_RE = /^unknown model\b|model\s+['"]?[a-z0-9._-]+['"]?\s+not (?:found|available)/i;
const RATE_LIMIT_MSG_RE = /\b429\b|RESOURCE_EXHAUSTED|rate[ _-]?limit(?:ed)?|quota exceeded/i;

/**
 * Pure 14-row classifier mapping the observable facts of one agy print-mode
 * run to `{ ok, kind, rateLimited, error }`. Rows are evaluated in order.
 */
export function classifyAgyOutcome({
  outputFormat,
  killReason = null,
  spawnError = null,
  code,
  signal = null,
  terminalResult = null,
  envelope = null,
  jsonValid = true,
  schemaErrorKind = null,
  schemaErrorMsg = null,
  finishedReason,
  out = '',
  err = '',
  lastErrLine,
  legacyPre150 = false,
  requestedModel = null,
} = {}) {
  const errLines = typeof code === 'number' && code !== 0
    ? (lastErrLine !== undefined
      ? [String(lastErrLine).trim()].filter(Boolean)
      : String(err ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-16).reverse())
    : [];
  let lastAgyErr = null;
  for (const line of errLines) {
    if (line.length > 4096) continue;
    const m = AGY_ERROR_LINE_RE.exec(line);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lastAgyErr = parsed;
        break;
      }
    } catch {}
  }
  const effFinishedReason = finishedReason ?? terminalResult?.finished_reason ?? envelope?.finished_reason;
  const isPrintTimeout =
    effFinishedReason === 'print_timeout' ||
    (!terminalResult && !envelope && code === 3 && errLines.some((l) => /^\[agy\] print timeout after \d+/.test(l))) ||
    (outputFormat === 'text' && legacyPre150 && isAgyTimeout(String(out ?? '')));

  const modelMsg = lastAgyErr?.message ?? terminalResult?.error ?? envelope?.error;
  const structuredNotFound =
    (lastAgyErr?.code === 404 || lastAgyErr?.httpStatus === 404 || lastAgyErr?.status === 'NOT_FOUND') &&
    (typeof lastAgyErr?.message !== 'string' ||
      !lastAgyErr.message.trim() ||
      (MODEL_UNAVAILABLE_MSG_RE.test(lastAgyErr.message) && !/\.json\b/i.test(lastAgyErr.message)));
  const unstructuredModelMissing =
    typeof modelMsg === 'string' &&
    MODEL_UNAVAILABLE_MSG_RE.test(modelMsg) &&
    !/\.json\b/i.test(modelMsg) &&
    (!requestedModel || modelMsg.toLowerCase().includes(String(requestedModel).toLowerCase()));
  const isModelUnavailable = structuredNotFound || unstructuredModelMissing;

  const detectRateLimit = () => {
    if (lastAgyErr && (lastAgyErr.code !== undefined || lastAgyErr.httpStatus !== undefined || lastAgyErr.status !== undefined)) {
      return lastAgyErr.code === 429 || lastAgyErr.httpStatus === 429 || lastAgyErr.status === 'RESOURCE_EXHAUSTED';
    }
    const text = terminalResult?.error ?? envelope?.error ?? (code !== 0 ? errLines.join('\n') : '');
    return RATE_LIMIT_MSG_RE.test(String(text ?? ''));
  };

  if (killReason != null) {
    return { ok: false, kind: killReason.kind, rateLimited: false, error: killReason.error };
  } else if (spawnError != null || (code === null && signal === null)) {
    return { ok: false, kind: 'spawn', rateLimited: false, error: spawnError ? `spawn: ${spawnError.message}` : 'spawn: failed to start' };
  } else if (code === null) {
    return { ok: false, kind: 'signal', rateLimited: false, error: `killed by signal ${signal}` };
  } else if (isPrintTimeout) {
    return { ok: false, kind: 'timeout', rateLimited: false, error: 'print-timeout' };
  } else if (effFinishedReason === 'interrupted') {
    return { ok: false, kind: 'interrupted', rateLimited: false, error: 'interrupted' };
  } else if (
    FAILURE_FINISHED_REASONS.has(String(effFinishedReason ?? '').toLowerCase()) ||
    (outputFormat === 'stream-json' && terminalResult != null &&
      (terminalResult.status !== 'SUCCESS' ||
        (terminalResult.exit_code !== 0 && terminalResult.exit_code !== undefined && terminalResult.exit_code !== null))) ||
    (outputFormat === 'json' && envelope != null && ['error', 'failed'].includes(String(envelope.status ?? '').toLowerCase()))
  ) {
    return {
      ok: false,
      kind: isModelUnavailable ? 'model_unavailable' : (outputFormat === 'json' ? 'envelope_error' : 'server'),
      rateLimited: detectRateLimit(),
      error: outputFormat === 'json' && envelope != null
        ? `agy returned error status in JSON envelope: ${envelope.status}${envelope.error || envelope.response ? ` (${envelope.error || envelope.response})` : ''}`
        : (terminalResult
          ? `terminal result status ${terminalResult.status}: exit_code ${terminalResult.exit_code}`
          : `finished_reason ${effFinishedReason}`),
    };
  } else if (outputFormat === 'stream-json' && terminalResult != null && code !== 0) {
    return { ok: false, kind: 'server_shutdown_error', rateLimited: false, error: `process exited with code ${code} despite terminal result SUCCESS` };
  } else if (outputFormat === 'stream-json' && terminalResult == null && code !== 0) {
    return {
      ok: false,
      kind: lastAgyErr ? (isModelUnavailable ? 'model_unavailable' : 'server') : 'cli',
      rateLimited: detectRateLimit(),
      error: `exit ${code}: ${(err || out).slice(-300)}`,
    };
  } else if (outputFormat === 'stream-json' && terminalResult == null) {
    return { ok: false, kind: 'missing_terminal_result', rateLimited: false, error: 'process exited with 0 without emitting terminal result' };
  } else if (outputFormat !== 'stream-json' && code !== 0) {
    return {
      ok: false,
      kind: isModelUnavailable ? 'model_unavailable' : 'server',
      rateLimited: detectRateLimit(),
      error: `exit ${code}: ${(err || out).slice(-300)}`,
    };
  } else if (outputFormat === 'json' && (!jsonValid || schemaErrorKind != null)) {
    return { ok: false, kind: schemaErrorKind ?? 'schema_violation', rateLimited: false, error: schemaErrorMsg ?? 'Invalid JSON structured output' };
  } else if (outputFormat === 'text' && String(out ?? '').trim().length === 0) {
    return { ok: false, kind: 'empty', rateLimited: false, error: 'exit 0: empty output' };
  } else if (outputFormat === 'stream-json' || outputFormat === 'json' || outputFormat === 'text') {
    return { ok: true, kind: null, rateLimited: false, error: null };
  }
  return { ok: false, kind: 'unclassified', rateLimited: false, error: `unclassified agy outcome for outputFormat=${String(outputFormat)}` };
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
 * `worker` marks the spawned session as an agb worker (spec D14): `{ ticket }`
 * sets AGB_WORKER_TICKET, `{ mode: 'readonly' }` sets AGB_WORKER_MODE. Exactly
 * one of the two reaches the child; inherited values are removed. Omitted or
 * malformed => readonly (fail closed).
 * Returns { ok, output, ms, error } — never throws on agent failure;
 * throws only on programmer error (missing model/prompt).
 */
const WRITABLE_GEMINI_RUNTIME_DIRS = new Set(['antigravity-cli', 'antigravity', 'config', 'jetski', 'tmp', 'logs', 'locks']);
const WRITABLE_ANTIGRAVITY_CLI_ENTRIES = new Set([
  'bin', 'brain', 'conversations', 'crashes', 'log', 'logs', 'plugin_data', 'presence',
  'scratch', 'cache', 'cli.log', 'conversation_summaries.db', 'history.jsonl',
  'jetbox_summaries_proto.pb', 'jetski_state.pbtxt', 'last_check.timestamp', 'settings.json.bak',
]);

function stageGeminiEntry(entry, srcPath, dstPath, platform) {
  if (lstatSync(dstPath, { throwIfNoEntry: false })) return;
  if (platform !== 'win32') {
    try { symlinkSync(srcPath, dstPath); } catch {}
    return;
  }
  if (entry.isFile()) {
    try { copyFileSync(srcPath, dstPath); } catch {}
  } else if (entry.isDirectory()) {
    try { cpSync(srcPath, dstPath, { recursive: true, force: false, errorOnExist: false }); } catch {}
  }
}

export function stageBuilderGeminiHome(cwd, userHome, platform = process.platform) {
  let worktreeDir = cwd;
  try { worktreeDir = realpathSync(cwd); } catch {}
  const agbHome = join(worktreeDir, '.agb_home');
  const targetGemini = join(agbHome, '.gemini');
  const targetCli = join(targetGemini, 'antigravity-cli');
  const targetConfig = join(targetGemini, 'config');
  try {
    if (lstatSync(targetGemini, { throwIfNoEntry: false })?.isSymbolicLink()) {
      rmSync(targetGemini, { force: true });
    }
    if (lstatSync(targetConfig, { throwIfNoEntry: false })?.isSymbolicLink()) {
      rmSync(targetConfig, { force: true });
    }
  } catch {}
  try {
    mkdirSync(join(targetCli, 'plugin_data', 'antigravity-booster', 'logs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(targetConfig, 'projects'), { recursive: true, mode: 0o700 });
    for (const sub of ['bin', 'brain', 'conversations', 'crashes', 'log', 'presence', 'scratch', 'cache']) {
      mkdirSync(join(targetCli, sub), { recursive: true, mode: 0o700 });
    }
  } catch {}
  const realGemini = join(userHome, '.gemini');
  if (existsSync(realGemini)) {
    try {
      for (const entry of readdirSync(realGemini, { withFileTypes: true })) {
        if (WRITABLE_GEMINI_RUNTIME_DIRS.has(entry.name) || entry.name.startsWith('agb-sidecar-plugin-')) continue;
        stageGeminiEntry(entry, join(realGemini, entry.name), join(targetGemini, entry.name), platform);
      }
    } catch {}
    const realConfig = join(realGemini, 'config');
    if (existsSync(realConfig)) {
      try {
        for (const entry of readdirSync(realConfig, { withFileTypes: true })) {
          if (entry.name === 'projects') continue;
          stageGeminiEntry(entry, join(realConfig, entry.name), join(targetConfig, entry.name), platform);
        }
      } catch {}
    }
    const realCli = join(realGemini, 'antigravity-cli');
    if (existsSync(realCli)) {
      try {
        for (const entry of readdirSync(realCli, { withFileTypes: true })) {
          if (WRITABLE_ANTIGRAVITY_CLI_ENTRIES.has(entry.name)) continue;
          stageGeminiEntry(entry, join(realCli, entry.name), join(targetCli, entry.name), platform);
        }
      } catch {}
    }
  }
  return agbHome;
}

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
  conversation,
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
  worker,
  disableSlashCommands,
  platform = process.platform,
}) {
  if (!model || !prompt) throw new Error('runAgy: model and prompt are required');
  cwd = typeof cwd === 'string' && Boolean(cwd.trim()) ? cwd : undefined;
  const resolvedModel = resolveModelSlug(model);
  const userHome = process.env.AGB_HOME_DIR || homedir();
  const agyBin = bin ?? process.env.AGB_AGY_BIN ?? (resolveAgyBinary(userHome) || 'agy');
  const effectiveTimeout = outputFormat === 'stream-json' && (!timeout || timeout === '0') ? '0' : timeout;
  // Probed `agy 1.5.9 --help`:
  //   --input-format  Input format for print mode (text, stream-json) (default text)
  // Passing `--input-format text` without inline `--print <arg>` runs `agy` in headless
  // print mode reading the full prompt from stdin, avoiding Linux MAX_ARG_STRLEN (131 KiB) E2BIG.
  const pipePromptViaStdin = Buffer.byteLength(prompt, 'utf8') > MAX_ARGV_PROMPT_BYTES;
  const args = pipePromptViaStdin
    ? ['--input-format', 'text', '--print-timeout', effectiveTimeout, '--model', resolvedModel]
    : ['--print', prompt, '--print-timeout', effectiveTimeout, '--model', resolvedModel];
  if (disableSlashCommands !== false) {
    args.push('--disable-slash-commands');
  }
  if (typeof conversation === 'string' && conversation.trim()) {
    args.push('--conversation', conversation.trim());
  }
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
  const effectiveEnv = env ? { ...process.env, ...env } : process.env;
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
      verifiedBypass = verifySandboxBypassAttestation(repo ?? cwd, platform, { env: effectiveEnv });
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
  let bwrapCreatedLocalNm = null;

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
      const bypass = verifiedBypass ?? verifySandboxBypassAttestation(repo ?? cwd, platform, { env: effectiveEnv });
      if (!bypass.valid) {
        return Promise.resolve({
          ok: false,
          output: '',
          ms: 0,
          error: `Builder containment cannot be disabled without an authenticated bypass attestation: ${bypass.reason}`,
          kind: 'containment_unavailable',
        });
      }
    }
    let validBuilderCwd = false;
    if (cwd) {
      try {
        validBuilderCwd = statSync(cwd).isDirectory();
      } catch {
        validBuilderCwd = false;
      }
    }
    if (!validBuilderCwd) {
      return Promise.resolve({
        ok: false,
        output: '',
        ms: 0,
        error: 'Builder containment requires an existing directory worktree cwd',
        kind: 'containment_unavailable',
      });
    }
    if (containment) {
      const containmentCheck = checkKernelContainment(platform, { env: effectiveEnv });
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
        const bypass = verifiedBypass ?? verifySandboxBypassAttestation(repo ?? cwd, platform, { env: effectiveEnv });
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

          const adlcDir = join(realAllowedDir, '.adlc');
          if (existsSync(adlcDir)) {
            try {
              const adlcStat = lstatSync(adlcDir);
              if (adlcStat.isDirectory()) {
                launchArgs.push('--ro-bind', adlcDir, adlcDir);
                const leasesDir = join(adlcDir, 'leases');
                if (existsSync(leasesDir)) {
                  try {
                    const leaseStat = lstatSync(leasesDir);
                    if (leaseStat.isDirectory()) {
                      launchArgs.push('--tmpfs', leasesDir);
                    }
                  } catch {}
                }
              }
            } catch {}
          }

          let targetGitDir = null;
          const altDirs = [];

          // If worktree uses an external gitdir (e.g. per-attempt Git database), mount it read-write
          const gitFile = join(realAllowedDir, '.git');
          if (existsSync(gitFile)) {
            try {
              const stat = lstatSync(gitFile);
              if (stat.isFile()) {
                const gitContent = readFileSync(gitFile, 'utf8').trim();
                const match = gitContent.match(/^gitdir:\s*(.+)$/);
                if (match) {
                  const resolvedTarget = resolve(realAllowedDir, match[1]);
                  if (existsSync(resolvedTarget)) {
                    targetGitDir = resolvedTarget;
                    let realTargetGitDir;
                    try { realTargetGitDir = realpathSync(targetGitDir); } catch { realTargetGitDir = targetGitDir; }
                    launchArgs.push('--bind', realTargetGitDir, realTargetGitDir);

                    // Mount hooks/ read-only so builder cannot plant executable hooks
                    const hooksDir = join(realTargetGitDir, 'hooks');
                    if (!existsSync(hooksDir)) {
                      try { mkdirSync(hooksDir, { recursive: true }); } catch {}
                    }
                    if (existsSync(hooksDir)) {
                      let realHooksDir;
                      try { realHooksDir = realpathSync(hooksDir); } catch { realHooksDir = hooksDir; }
                      launchArgs.push('--ro-bind', realHooksDir, realHooksDir);
                      if (realHooksDir !== hooksDir) {
                        launchArgs.push('--ro-bind', realHooksDir, hooksDir);
                      }
                    }

                    // Also mount alternates read-only so Git can read base objects
                    const altFile = join(realTargetGitDir, 'objects', 'info', 'alternates');
                    if (existsSync(altFile)) {
                      const altLines = readFileSync(altFile, 'utf8').split('\n');
                      for (const altLine of altLines) {
                        const trimmed = altLine.trim();
                        if (trimmed && existsSync(trimmed)) {
                          let realAlt;
                          try { realAlt = realpathSync(trimmed); } catch { realAlt = trimmed; }
                          altDirs.push(realAlt);
                          launchArgs.push('--ro-bind', realAlt, realAlt);
                        }
                      }
                    }
                  }
                }
              }
            } catch {}
          }

          // Mount project dependencies (node_modules) read-only so tests and tools resolve
          const findRepoRoot = (startDir) => {
            let cur = resolve(startDir);
            let root = null;
            while (cur && cur !== dirname(cur)) {
              if (existsSync(join(cur, '.git')) || existsSync(join(cur, 'package.json'))) {
                root = cur;
              }
              cur = dirname(cur);
            }
            return root;
          };
          const wtRepo = findRepoRoot(dirname(realAllowedDir));

          let candidateNm = null;
          const searchNodeModules = (startDir, stopDir = null) => {
            let cur = startDir;
            while (cur && cur !== dirname(cur)) {
              const nm = join(cur, 'node_modules');
              if (existsSync(nm)) return nm;
              if (stopDir && cur === stopDir) break;
              cur = dirname(cur);
            }
            return null;
          };

          candidateNm = searchNodeModules(dirname(realAllowedDir), wtRepo);
          if (!candidateNm && targetGitDir) {
            candidateNm = searchNodeModules(dirname(targetGitDir));
          }
          if (!candidateNm && altDirs.length > 0) {
            for (const alt of altDirs) {
              candidateNm = searchNodeModules(alt);
              if (candidateNm) break;
            }
          }

          const canonicalNm = candidateNm && existsSync(candidateNm) ? (() => {
            try { return realpathSync(candidateNm); } catch { return candidateNm; }
          })() : null;

          const localNm = join(realAllowedDir, 'node_modules');
          if (existsSync(localNm)) {
            try {
              let isSymlink = false;
              try { isSymlink = lstatSync(localNm).isSymbolicLink(); } catch {}

              let realLocalNm;
              try { realLocalNm = realpathSync(localNm); } catch { realLocalNm = localNm; }

              if (!isSymlink) {
                // Physical worktree directory: mount read-only submount over worktree
                launchArgs.push('--ro-bind', realLocalNm, localNm);
              } else {
                // Symlinked dependency path: only permit canonical project dependencies or targets strictly inside worktree
                const isApprovedCanonical = canonicalNm && realLocalNm === canonicalNm;
                const isInsideWorktree = (() => {
                  const rel = relative(realAllowedDir, realLocalNm);
                  return !rel.startsWith('..') && !isAbsolute(rel);
                })();

                if (isApprovedCanonical || isInsideWorktree) {
                  if (realLocalNm !== localNm) {
                    launchArgs.push('--ro-bind', realLocalNm, realLocalNm);
                  }
                  launchArgs.push('--ro-bind', realLocalNm, localNm);
                } else if (canonicalNm) {
                  // Symlink points to unapproved target (e.g. host files or repo secrets).
                  // Reject unapproved target and mount canonical dependencies instead.
                  launchArgs.push('--ro-bind', canonicalNm, canonicalNm);
                  launchArgs.push('--ro-bind', canonicalNm, localNm);
                }
              }
            } catch {}
          } else if (canonicalNm) {
            bwrapCreatedLocalNm = localNm;
            launchArgs.push('--ro-bind', canonicalNm, canonicalNm);
            launchArgs.push('--ro-bind', canonicalNm, localNm);
          }
        }

        // Support test harness state recording in offline tests
        const testStateDir = env?.FAKE_STATE_DIR || process.env.FAKE_STATE_DIR;
        if (testStateDir && isTestExecution(effectiveEnv) && existsSync(testStateDir)) {
          try {
            const realTestStateDir = realpathSync(testStateDir);
            const realTmp = realpathSync(tmpdir());
            const rel = relative(realTmp, realTestStateDir);
            const isInsideTmp = !rel.startsWith('..') && !isAbsolute(rel);
            if (isInsideTmp) {
              launchArgs.push('--bind', realTestStateDir, realTestStateDir);
              if (realTestStateDir !== testStateDir) {
                launchArgs.push('--bind', realTestStateDir, testStateDir);
              }
            }
          } catch {}
        }

        // Mask sensitive credentials if they exist within the worktree or home directory
        const sensitiveCandidates = [
          join(realAllowedDir, '.npmrc'),
          join(realAllowedDir, '.pypirc'),
          join(realAllowedDir, '.netrc'),
          join(realAllowedDir, '.git-credentials'),
          join(realAllowedDir, '.ssh'),
          join(realAllowedDir, '.aws'),
          join(realAllowedDir, '.gnupg'),
          join(userHome, '.ssh'),
          join(userHome, '.aws'),
          join(userHome, '.gnupg'),
          join(userHome, '.netrc'),
          join(userHome, '.git-credentials'),
          join(userHome, '.npmrc'),
          join(userHome, '.pypirc'),
          ...(userHome !== homedir() ? [
            join(homedir(), '.ssh'),
            join(homedir(), '.aws'),
            join(homedir(), '.gnupg'),
            join(homedir(), '.netrc'),
            join(homedir(), '.git-credentials'),
            join(homedir(), '.npmrc'),
            join(homedir(), '.pypirc'),
          ] : []),
        ];
        const sensitiveFiles = Array.from(new Set(sensitiveCandidates));
        for (const sFile of sensitiveFiles) {
          if (existsSync(sFile)) {
            try {
              const lst = lstatSync(sFile);
              // Security: lstatSync returns isDirectory()/isFile() === false for symlinks;
              // resolve symlink target type via statSync so symlinked credentials are also masked.
              const st = lst.isSymbolicLink() ? statSync(sFile) : lst;
              if (st.isDirectory()) {
                launchArgs.push('--tmpfs', sFile);
              } else if (st.isFile()) {
                launchArgs.push('--ro-bind', '/dev/null', sFile);
              }
              if (lst.isSymbolicLink()) {
                const realSFile = realpathSync(sFile);
                if (
                  realSFile !== sFile &&
                  (realSFile.startsWith(realAllowedDir + '/') ||
                   realSFile.startsWith(userHome + '/') ||
                   realSFile.startsWith(homedir() + '/'))
                ) {
                  if (st.isDirectory()) {
                    launchArgs.push('--tmpfs', realSFile);
                  } else if (st.isFile()) {
                    launchArgs.push('--ro-bind', '/dev/null', realSFile);
                  }
                }
              }
            } catch (err) {
              if (err && err.code !== 'ENOENT') {
                process.stderr.write(`[agb] warning: failed to mask sensitive path ${sFile}: ${err.message}\n`);
              }
            }
          }
        }

        // Preserve agy binary and its runtime directory inside bwrap namespace
        let resolvedAgy = null;
        let entrypointAgy = null;
        if (agyBin.includes('/') || agyBin.includes('\\')) {
          entrypointAgy = resolve(agyBin);
          try { resolvedAgy = realpathSync(entrypointAgy); } catch { resolvedAgy = entrypointAgy; }
        } else {
          const pathEnv = process.env.PATH || '';
          for (const entry of pathEnv.split(':')) {
            if (!entry) continue;
            const candidate = join(entry, agyBin);
            if (existsSync(candidate)) {
              entrypointAgy = candidate;
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
        if (entrypointAgy && entrypointAgy !== resolvedAgy && existsSync(entrypointAgy)) {
          launchArgs.push('--ro-bind', entrypointAgy, entrypointAgy);
          const entryDir = dirname(entrypointAgy);
          if (existsSync(entryDir)) {
            launchArgs.push('--ro-bind', entryDir, entryDir);
          }
        }

        // Preserve node binary, its bin directory, and adjacent prefix lib/share
        // directories (e.g. fnm/nvm/volta/mise ../lib/node_modules/npm for npm/npx symlinks)
        // inside bwrap namespace without mounting broad user home directories.
        let resolvedNode = null;
        try { resolvedNode = realpathSync(process.execPath); } catch { resolvedNode = process.execPath; }
        if (resolvedNode && existsSync(resolvedNode)) {
          launchArgs.push('--ro-bind', resolvedNode, resolvedNode);
          const nodeDir = dirname(resolvedNode);
          if (existsSync(nodeDir)) {
            launchArgs.push('--ro-bind', nodeDir, nodeDir);
          }
          if (basename(nodeDir) === 'bin') {
            const nodePrefix = dirname(nodeDir);
            const broadPrefixes = new Set(['/', userHome, homedir(), join(userHome, '.local'), join(homedir(), '.local')]);
            if (!broadPrefixes.has(nodePrefix)) {
              for (const subDir of ['lib', 'share']) {
                const candidate = join(nodePrefix, subDir);
                if (existsSync(candidate)) {
                  launchArgs.push('--ro-bind', candidate, candidate);
                }
              }
            }
          }
        }

        const bwrapAgyBin = resolvedAgy || entrypointAgy || agyBin;

        // Preserve agy user configuration and authentication inside bwrap namespace
        const geminiDir = join(userHome, '.gemini');
        if (existsSync(geminiDir)) {
          let realGeminiDir;
          try { realGeminiDir = realpathSync(geminiDir); } catch { realGeminiDir = geminiDir; }
          launchArgs.push('--ro-bind', realGeminiDir, geminiDir);
          if (realGeminiDir !== geminiDir) {
            launchArgs.push('--ro-bind', realGeminiDir, realGeminiDir);
          }
          if (isBuilder && cwd) {
            stageBuilderGeminiHome(cwd, userHome, platform);
          }
        }

        // Outer bwrap already provides mount + PID namespace isolation + credential
        // masking (note: agy is a cloud-connected LLM CLI requiring outbound HTTPS/gRPC,
        // so --unshare-net cannot be set on the outer agy wrapper; offline test gates use
        // lib/gates.mjs --unshare-net). Omit nested `--sandbox` on the inner agy binary
        // so agy 1.5.9 does not attempt a nested CLONE_NEWUSER fork/exec (blocked with
        // EPERM under Linux kernel.apparmor_restrict_unprivileged_userns=1).
        const innerBwrapArgs = args.filter((a) => a !== '--sandbox');
        launchArgs.push('--', bwrapAgyBin, ...innerBwrapArgs);
    } else if (containmentCheck.mechanism === 'job_object') {
      let bypass = verifiedBypass;
      if (!bypass?.valid) {
        const activeRes = await verifyWindowsSandboxActive({ cwd: cwd ?? repo, env: effectiveEnv });
        if (activeRes.level !== 'pass') {
          bypass = verifySandboxBypassAttestation(repo ?? cwd, platform, { consumeNonce: true, env: effectiveEnv });
          if (!bypass.valid) {
            return {
              ok: false,
              output: '',
              ms: 0,
              error: `Kernel containment floor unavailable on Windows: Job Object provides process lifetime containment but not filesystem/network isolation. Active Windows AppContainer sandbox verification failed: ${activeRes.detail}. ${activeRes.fix || ''}`.trim(),
              kind: 'containment_unavailable',
            };
          }
        }
      }
      const wrapperScript = fileURLToPath(new URL('../lib/job-object-wrapper.ps1', import.meta.url));
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
      let resolvedAgyCandidate = agyBin;
      if (!resolvedAgyCandidate.includes('/') && !resolvedAgyCandidate.includes('\\')) {
        const pathEnv = process.env.PATH || '';
        for (const entry of pathEnv.split(':')) {
          if (!entry) continue;
          const candidate = join(entry, resolvedAgyCandidate);
          if (existsSync(candidate)) {
            resolvedAgyCandidate = candidate;
            break;
          }
        }
      }
      let extraReadPaths = '';
      try {
        const agyRealDir = dirname(realpathSync(resolvedAgyCandidate)).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        extraReadPaths += `\n(allow file-read* (subpath "${agyRealDir}"))`;
      } catch {}
      try {
        const nodeRealPath = realpathSync(process.execPath);
        const nodeBinDir = dirname(nodeRealPath);
        const escapedBin = nodeBinDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        extraReadPaths += `\n(allow file-read* (subpath "${escapedBin}"))`;
        if (basename(nodeBinDir) === 'bin') {
          const nodePrefix = dirname(nodeBinDir);
          if (nodePrefix !== '/' && nodePrefix !== homeDir && nodePrefix !== join(homeDir, '.local')) {
            const nodeLibDir = join(nodePrefix, 'lib');
            if (existsSync(nodeLibDir)) {
              const escapedLib = nodeLibDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              extraReadPaths += `\n(allow file-read* (subpath "${escapedLib}"))`;
            }
          }
        }
      } catch {}

      let extraGitPaths = '';
      const gitFile = join(allowedDir, '.git');
      if (existsSync(gitFile)) {
        try {
          const stat = lstatSync(gitFile);
          if (stat.isFile()) {
            const gitContent = readFileSync(gitFile, 'utf8').trim();
            const match = gitContent.match(/^gitdir:\s*(.+)$/);
            if (match) {
              const targetGitDir = resolve(allowedDir, match[1]);
              if (existsSync(targetGitDir)) {
                let realTargetGitDir;
                try { realTargetGitDir = realpathSync(targetGitDir); } catch { realTargetGitDir = targetGitDir; }
                if (!/[\r\n\0]/.test(realTargetGitDir)) {
                  const escapedTarget = realTargetGitDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                  const hooksDir = join(realTargetGitDir, 'hooks');
                  if (!existsSync(hooksDir)) {
                    try { mkdirSync(hooksDir, { recursive: true }); } catch {}
                  }
                  let realHooksDir;
                  try { realHooksDir = realpathSync(hooksDir); } catch { realHooksDir = hooksDir; }
                  const escapedHooks = realHooksDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                  extraGitPaths += `\n(allow file-read* (subpath "${escapedTarget}"))\n(allow file-write* (subpath "${escapedTarget}"))\n(deny file-write* (subpath "${escapedHooks}"))`;

                  const altFile = join(realTargetGitDir, 'objects', 'info', 'alternates');
                  if (existsSync(altFile)) {
                    const altLines = readFileSync(altFile, 'utf8').split('\n');
                    for (const altLine of altLines) {
                      const trimmed = altLine.trim();
                      if (trimmed && existsSync(trimmed)) {
                        let realAlt;
                        try { realAlt = realpathSync(trimmed); } catch { realAlt = trimmed; }
                        if (!/[\r\n\0]/.test(realAlt)) {
                          const escapedAlt = realAlt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                          extraGitPaths += `\n(allow file-read* (subpath "${escapedAlt}"))`;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        } catch {}
      }

      let realAllowedDir;
      try { realAllowedDir = realpathSync(allowedDir); } catch { realAllowedDir = allowedDir; }
      const escapedRealAllowedDir = realAllowedDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const canonicalTmp = (() => {
        try { return realpathSync(tmpdir()); } catch { return tmpdir(); }
      })();
      const escapedCanonicalTmp = canonicalTmp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const seatbeltProfile = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${escapedAllowedDir}"))\n(allow file-write* (subpath "${escapedRealAllowedDir}"))\n(allow file-write* (subpath "/private/tmp"))\n(allow file-write* (subpath "/tmp"))\n(allow file-write* (subpath "/private/var/folders"))\n(allow file-write* (subpath "${escapedCanonicalTmp}"))\n(allow file-write* (regex #"^/dev/(null|zero|dtracehelper|tty)"))${extraReadPaths}${extraGitPaths}\n(deny file-write* (subpath "${escapedAllowedDir}/node_modules"))\n(deny file-write* (subpath "${escapedRealAllowedDir}/node_modules"))\n(deny file-write* (subpath "${escapedAllowedDir}/.adlc"))\n(deny file-write* (subpath "${escapedRealAllowedDir}/.adlc"))\n(allow file-write* (subpath "${escapedAllowedDir}/.adlc/leases"))\n(allow file-write* (subpath "${escapedRealAllowedDir}/.adlc/leases"))\n(deny file-read* (subpath "${escapedHome}/.ssh"))\n(deny file-read* (subpath "${escapedHome}/.aws"))\n(deny file-read* (subpath "${escapedHome}/.gnupg"))\n(deny file-read* (subpath "${escapedHome}/.npmrc"))\n(deny file-read* (subpath "${escapedHome}/.pypirc"))\n(deny file-read* (subpath "${escapedHome}/.netrc"))\n(deny file-read* (subpath "${escapedHome}/.git-credentials"))\n(deny file-read* (subpath "${escapedAllowedDir}/.npmrc"))\n(deny file-read* (subpath "${escapedAllowedDir}/.pypirc"))\n(deny file-read* (subpath "${escapedAllowedDir}/.netrc"))\n(deny file-read* (subpath "${escapedAllowedDir}/.git-credentials"))\n(deny file-read* (subpath "${escapedAllowedDir}/.ssh"))\n(deny file-read* (subpath "${escapedAllowedDir}/.aws"))\n(deny file-read* (subpath "${escapedAllowedDir}/.gnupg"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.npmrc"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.pypirc"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.netrc"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.git-credentials"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.ssh"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.aws"))\n(deny file-read* (subpath "${escapedRealAllowedDir}/.gnupg"))`;
      // Outer sandbox-exec already enforces the Seatbelt SBPL profile (including
      // worktree-only write confinement and credential read denials; outbound network
      // remains enabled so agy can reach its LLM backend). Omit nested `--sandbox`
      // because Darwin sandbox_init() rejects nested Seatbelt profiles with EPERM.
      const innerSeatbeltArgs = args.filter((a) => a !== '--sandbox');
      launchBin = 'sandbox-exec';
      launchArgs = ['-p', seatbeltProfile, resolvedAgyCandidate, ...innerSeatbeltArgs];
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
        if (isAllowedEnvVar(key, effectiveEnv)) {
          spawnEnv[key] = val;
        }
      }
      if (process.env.ANTIGRAVITY_CONVERSATION_ID && isAllowedEnvVar('ANTIGRAVITY_CONVERSATION_ID', effectiveEnv)) {
        spawnEnv.ANTIGRAVITY_CONVERSATION_ID = process.env.ANTIGRAVITY_CONVERSATION_ID;
      }
      if (process.env.AGB_SESSION_ID && isAllowedEnvVar('AGB_SESSION_ID', effectiveEnv)) {
        spawnEnv.AGB_SESSION_ID = process.env.AGB_SESSION_ID;
      }
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          if (isAllowedEnvVar(k, effectiveEnv)) {
            spawnEnv[k] = v;
          }
        }
      }
    } else {
      spawnEnv = { ...process.env, ...(env || {}) };
    }
    for (const k of Object.keys(spawnEnv)) {
      if (/^(?:agb_worker_ticket|agb_worker_mode|agb_worker_build_cmd|init_cwd)$/i.test(k)) delete spawnEnv[k];
    }
    if (cwd) {
      spawnEnv.PWD = cwd;
    }
    const workerTicket = typeof worker?.ticket === 'string' ? worker.ticket.trim() : '';
    const workerBuildCmd = typeof worker?.buildCmd === 'string' ? worker.buildCmd.trim() : '';
    if (workerTicket) {
      spawnEnv.AGB_WORKER_TICKET = workerTicket;
      if (/^npm run [a-zA-Z0-9_.:-]+$/.test(workerBuildCmd)) {
        spawnEnv.AGB_WORKER_BUILD_CMD = workerBuildCmd;
      }
    } else {
      spawnEnv.AGB_WORKER_MODE = 'readonly';
    }
    if (!isTestExecution(effectiveEnv)) {
      for (const k of Object.keys(spawnEnv)) {
        if (k.startsWith('FAKE_')) delete spawnEnv[k];
      }
    }
    if (isBuilder) {
      delete spawnEnv.XDG_RUNTIME_DIR;
      delete spawnEnv.DBUS_SESSION_BUS_ADDRESS;
      for (const k of Object.keys(spawnEnv)) {
        if (/^(?:git_|agy_workspace$|antigravity_workspace$)/i.test(k)) delete spawnEnv[k];
      }
      const agbHome = stageBuilderGeminiHome(cwd, userHome, platform);
      spawnEnv.HOME = agbHome;
      spawnEnv.XDG_CONFIG_HOME = agbHome;
      spawnEnv.AGY_WORKSPACE = cwd;
      spawnEnv.ANTIGRAVITY_WORKSPACE = cwd;
      if (repo || cwd) {
        const rootDir = repo ?? dirname(cwd);
        spawnEnv.GIT_CEILING_DIRECTORIES = join(rootDir, '.worktrees');
      }
      spawnEnv.GIT_CONFIG_NOSYSTEM = '1';
      spawnEnv.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
      try {
        const realNodeDir = dirname(realpathSync(process.execPath));
        const sep = process.platform === 'win32' ? ';' : ':';
        const curPath = spawnEnv.PATH || '';
        const parts = curPath.split(sep).filter(Boolean);
        if (realNodeDir && !parts.includes(realNodeDir)) {
          spawnEnv.PATH = parts.length > 0 ? `${curPath}${sep}${realNodeDir}` : realNodeDir;
        }
      } catch {}
    }

    const spawnOpts = { cwd, stdio: [pipePromptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: spawnEnv };
    if (process.platform !== 'win32') {
      spawnOpts.detached = true;
    }
    let p = null;
    let syncSpawnErr = null;
    try {
      p = spawn(launchBin, launchArgs, spawnOpts);
    } catch (spawnErr) {
      syncSpawnErr = spawnErr;
    }
    if (p?.stdin) {
      p.stdin.on('error', () => {});
      p.stdin.end(prompt, 'utf8');
    }
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
    let extractedConversationId = null;
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

    const timeoutMs = parseTimeoutMs(timeout);
    let timer = null;
    if (timeoutMs > 0) {
      const killGraceMs = process.env.AGB_KILL_GRACE_MS ? parseInt(process.env.AGB_KILL_GRACE_MS, 10) : 15_000;
      timer = setTimeout(() => {
        if (resolved) return;
        recordKillReason({ kind: 'timeout', error: outputFormat === 'stream-json' ? 'stream-timeout' : 'print-timeout' });
        terminateTree();
        if (!out.includes('Error: timed out waiting for response')) {
          out = (out ? out + '\n' : '') + 'Error: timed out waiting for response.';
        }
      }, timeoutMs + killGraceMs);
      timer.unref?.();
    }

    if (outputFormat === 'stream-json') {
      resetEventProgressTimer();
    }

    const captureEventConversationId = (ev) => {
      const candidateConvId =
        (typeof ev.conversation_id === 'string' && ev.conversation_id.trim()) ||
        (typeof ev.init?.conversation_id === 'string' && ev.init.conversation_id.trim()) ||
        (typeof ev.step_update?.conversation_id === 'string' && ev.step_update.conversation_id.trim()) ||
        (typeof ev.result?.conversation_id === 'string' && ev.result.conversation_id.trim()) ||
        null;
      if (candidateConvId) {
        extractedConversationId = candidateConvId;
      }
    };

    const normalizeNestedStreamEvent = (ev) => {
      if (ev.event === 'init') {
        events.push(ev);
        return true;
      }
      if (ev.event === 'step_update') {
        const normStep = {
          ...(ev.step_update && typeof ev.step_update === 'object' ? ev.step_update : {}),
          ...ev,
          type: 'step_update',
        };
        events.push(normStep);
        return true;
      }
      if (ev.event === 'result' && ev.result && (ev.result.status === 'SUCCESS' || ev.result.status === 'ERROR')) {
        const normResult = {
          ...ev.result,
          type: 'result',
          exit_code: typeof ev.result.exit_code === 'number' ? ev.result.exit_code : (ev.result.status === 'SUCCESS' ? 0 : 1),
        };
        if (!terminalResult) {
          terminalResult = normResult;
          events.push(normResult);
        } else {
          console.warn('[agb] Warning: duplicate terminal result event received; first result wins');
        }
        return true;
      }
      return false;
    };

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
            } else if (ev && typeof ev === 'object' && ev.event) {
              validEvent = normalizeNestedStreamEvent(ev);
            }
            if (validEvent) captureEventConversationId(ev);
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
      if (bwrapCreatedLocalNm) {
        try { rmdirSync(bwrapCreatedLocalNm); } catch {}
        bwrapCreatedLocalNm = null;
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
      let envelope = null;
      let jsonValid = true;
      let jsonParseMsg = null;
      if (outputFormat === 'json') {
        try {
          const parsedEnvelope = JSON.parse(out);
          if (parsedEnvelope && typeof parsedEnvelope === 'object') envelope = parsedEnvelope;
        } catch (e) {
          jsonValid = false;
          jsonParseMsg = `Invalid JSON structured output: ${e.message}`;
        }
      }
      // agy < 1.5.0 reports a print timeout only as a sentinel line on stdout
      // (exit 0); keep honoring it for the json format as well as text.
      const legacyJsonTimeout = outputFormat === 'json' && isAgyTimeout(out);
      const classified = classifyAgyOutcome({
        outputFormat: outputFormat ?? 'text',
        killReason,
        spawnError,
        code,
        signal,
        terminalResult,
        envelope,
        jsonValid,
        schemaErrorMsg: jsonParseMsg,
        finishedReason: legacyJsonTimeout ? 'print_timeout' : undefined,
        out,
        err,
        legacyPre150: true,
        requestedModel: resolvedModel,
      });
      let kind = classified.kind;
      let errorMsg = classified.error;

      let ok = kind === null;
      let result = { ok, output: out, ms, error: errorMsg, kind, conversationId: extractedConversationId, rateLimited: Boolean(classified.rateLimited) };
      if (envelope && (ok || kind === 'envelope_error')) {
        result.envelope = envelope;
      }
      if (outputFormat === 'stream-json') {
        result.events = events;
        result.terminalResult = terminalResult;
      }
      if (ok && outputFormat === 'json') {
        try {
          const parsed = JSON.parse(out);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed?.conversation_id === 'string' && parsed.conversation_id.trim()) {
              extractedConversationId = parsed.conversation_id.trim();
            }
            result.envelope = parsed;
            const statusStr = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
            if (statusStr === 'error' || statusStr === 'failed') {
              ok = false;
              kind = 'envelope_error';
              errorMsg = `agy returned error status in JSON envelope: ${parsed.status}${parsed.error || parsed.response ? ` (${parsed.error || parsed.response})` : ''}`;
              result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed, conversationId: extractedConversationId };
            } else if (jsonSchema) {
              const schemaObj = typeof jsonSchema === 'string' ? JSON.parse(jsonSchema) : jsonSchema;
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
                  result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed, conversationId: extractedConversationId };
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
                    result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed, conversationId: extractedConversationId };
                  }
                }
                if (ok) {
                  const validation = validateJsonSchema(structured, schemaObj);
                  if (!validation.valid) {
                    ok = false;
                    kind = 'schema_violation';
                    errorMsg = `structured output violates schema: ${validation.errors.join('; ')}`;
                    result = { ok, output: out, ms, error: errorMsg, kind, envelope: parsed, conversationId: extractedConversationId };
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
                result = { ok, output: out, ms, error: errorMsg, kind, conversationId: extractedConversationId };
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
          result = { ok, output: out, ms, error: errorMsg, kind, conversationId: extractedConversationId };
        }
      }

      result.conversationId = extractedConversationId;
      result.rateLimited = Boolean(classified.rateLimited);
      if (logFile) {
        mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
        const record = {
          ts: new Date().toISOString(), model, cwd, strike, ms, prompt, output: out, ok, role,
        };
        if (extractedConversationId !== null) {
          record.conversationId = extractedConversationId;
        }
        if (!ok) {
          record.kind = kind;
          record.error = result.error;
        }
        await appendFile(logFile, JSON.stringify(record) + '\n', { mode: 0o600 });
      }
      resolve(result);
    };

    if (syncSpawnErr) {
      void finish(null, null, syncSpawnErr);
      return;
    }

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
            } else if (ev && typeof ev === 'object' && ev.event) {
              validEvent = normalizeNestedStreamEvent(ev);
            }
            if (validEvent) captureEventConversationId(ev);
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
