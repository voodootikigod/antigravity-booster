import { execFile, execFileSync, execSync, spawnSync } from 'child_process';
import { promisify } from 'util';
import { readPluginContract, detectTicketStoreBackend, assertNoLegacyTicketStore, resolveAdlcBinary, execFileAuthenticatedAdlc, MIN_ADLC_CLI_VERSION, semverGte, STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS, SUPPORTED_PLUGIN_CONTRACT, IS_BUNDLED } from './adlc-bridge.mjs';
import { BUNDLED_ADLC_ANTIGRAVITY_VERSION, ADLC_ANTIGRAVITY_PLUGIN_NAME, installAdlcAntigravityFromVendor, pluginsDirFor, resolveAgyBinary, resolvePluginRoot } from './plugin-paths.mjs';
import { initializeDirectoryStore, loadTicketSnapshot, ticketFilename } from '@adlc/tickets';
import { computeDirectoryDigest } from './digest.mjs';
import { lt as semverLt, eq as semverEq } from './semver.mjs';
import { agyModelsStdout, parseAgyModels, compareModelCatalog, checkModelCatalog } from './doctor-models.mjs';
import { checkCliSettings } from './doctor-settings.mjs';
import { PROSECUTORS, ROLE_MODELS } from './models.mjs';
import { ensureGitignore } from './worktrees.mjs';
import { DECISION_PROVIDERS, resolveDecisionConfig, validateDecisionUrl } from './decision-engine.mjs';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, copyFileSync, openSync, closeSync, writeSync, fsyncSync, realpathSync, mkdirSync, rmSync, unlinkSync, lstatSync, statSync, truncateSync, constants } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname, relative, resolve, isAbsolute, delimiter } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import net from 'net';

export { parseAgyModels, compareModelCatalog, checkModelCatalog, checkCliSettings };

const execFileAsync = promisify(execFile);

export const MIN_NODE_VERSION = '22.19.0';

export async function checkNodeVersion({ version = process.version } = {}) {
  const cleanVersion = version.replace(/^v/, '');
  if (semverGte(cleanVersion, MIN_NODE_VERSION)) {
    return { name: 'Node.js', level: 'pass', detail: version, fix: null };
  }
  return { name: 'Node.js', level: 'fail', detail: version, fix: `Upgrade Node.js to v${MIN_NODE_VERSION} or newer.` };
}

export const MIN_AGY_VERSION = '1.5.17';
export const RECOMMENDED_AGY_VERSION = '1.5.17';

export async function checkAgyBinary({ env = process.env, home = env.HOME || homedir() } = {}) {
  try {
    const agyCmd = env.AGB_AGY_BIN || resolveAgyBinary(home);
    const { stdout } = await execFileAsync(agyCmd, ['--version'], { env, timeout: 5000 });
    const rawOut = stdout.trim();
    const verMatch = rawOut.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/);
    if (!verMatch) {
      return {
        name: 'agy CLI',
        level: 'fail',
        detail: `unrecognized version output: ${rawOut}`,
        fix: 'Ensure agy outputs standard SemVer version string.',
      };
    }
    const versionStr = verMatch[0];
    if (!semverGte(versionStr, MIN_AGY_VERSION)) {
      return {
        name: 'agy CLI',
        level: 'fail',
        version: versionStr,
        detail: `${rawOut} (required >= v${MIN_AGY_VERSION})`,
        fix: 'Upgrade agy to >= 1.5.17 for Antigravity Booster 2.0 native guardrails, PreToolUse force_ask, and Orchestrator support.',
      };
    }
    let v = rawOut;
    if (!v.startsWith('v')) v = 'v' + v;
    return { name: 'agy CLI', level: 'pass', version: versionStr, detail: v, fix: null };
  } catch (err) {
    return { name: 'agy CLI', level: 'fail', detail: 'not found or error', fix: 'Install Google Antigravity CLI and ensure it is on PATH.' };
  }
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export function checkHookLogDir({ env = process.env, home = env.HOME || homedir() } = {}) {
  const markerPath = join(home, '.gemini', 'antigravity-cli', '.agb-hook-log-degraded');
  const dataRoot = join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
  const logDir = join(dataRoot, 'logs');
  const logFile = join(logDir, 'hooks.log');
  if (
    existsSync(markerPath) ||
    lstatOrNull(dataRoot)?.isSymbolicLink() ||
    lstatOrNull(logDir)?.isSymbolicLink() ||
    lstatOrNull(logFile)?.isSymbolicLink()
  ) {
    return {
      name: 'Hook audit log',
      level: 'warn',
      detail: 'audit log degraded or symlinked',
      fix: `Inspect ${logDir} permissions/symlinks and remove ${markerPath}.`,
    };
  }
  return { name: 'Hook audit log', level: 'pass', detail: 'healthy', fix: null };
}

export async function checkAgyAuth({ env = process.env, home = env.HOME || homedir(), modelsPromise } = {}) {
  try {
    const stdout = await (modelsPromise ?? agyModelsStdout({ env, home }));
    if (parseAgyModels(stdout).length > 0) {
      return { name: 'agy Auth', level: 'pass', detail: 'authenticated', fix: null };
    }
    return { name: 'agy Auth', level: 'fail', detail: 'no models returned', fix: 'Run `agy login` to authenticate.' };
  } catch (err) {
    return { name: 'agy Auth', level: 'fail', detail: 'error fetching models', fix: 'Run `agy login` to authenticate.' };
  }
}

// One row of the §4.4 Normative Bootstrap & Doctor Decision Table.
function row(report, { doctorExit, bootstrapAction, bootstrapExit, railsTrusted = false }, extra) {
  return { report, doctorExit, bootstrapAction, bootstrapExit, railsTrusted, ...extra };
}

/**
 * Evaluate the staged companion plugin (~/.gemini/config/plugins/
 * adlc-antigravity) in the §4.4 Unified Evaluation Order shared by bootstrap
 * and doctor: manifest validity -> older than bundled -> pinned tree digest
 * (Appendix A.4 item 16: mismatch first, then contract) -> newer-version
 * contract. Pure apart from reading the staged directory; never throws.
 *   { report, doctorExit, bootstrapAction: install|preserve|reinstall|fail,
 *     bootstrapExit, railsTrusted, dir, version?, detail? }
 * `stagedDigests` is injectable for the pinned incompatible-contract row.
 */
export function evaluateStagedAdlcPlugin({
  home = homedir(),
  stagedDigests = STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS,
  bundledVersion = BUNDLED_ADLC_ANTIGRAVITY_VERSION,
} = {}) {
  const dir = join(pluginsDirFor(home), ADLC_ANTIGRAVITY_PLUGIN_NAME);
  const base = { dir };
  // 1. Manifest validity. Absent dir or plugin.json is not-installed; a
  // present-but-unreadable manifest is corrupt, never "not installed".
  if (!existsSync(join(dir, 'plugin.json'))) {
    return row('not-installed', { doctorExit: 1, bootstrapAction: 'install', bootstrapExit: 0 }, base);
  }
  const contract = readPluginContract({ dir });
  if (contract.status === 'unreadable' || contract.status === 'corrupt') {
    return row('corrupt-manifest', { doctorExit: 1, bootstrapAction: 'fail', bootstrapExit: 1 }, { ...base, detail: contract.error });
  }
  const { version } = contract;
  const info = { ...base, version };
  // 2. Older than the bundled release: upgrade, whatever the contract says.
  if (semverLt(version, bundledVersion)) {
    return row('outdated-plugin', { doctorExit: 1, bootstrapAction: 'install', bootstrapExit: 0 }, info);
  }
  // 3. Pinned family: the tree digest (which covers plugin.json) decides first.
  // Build metadata never affects precedence (semver 2.0.0), so 1.7.0+x is in
  // the 1.7.0 family and must pass the same digest check.
  const pinnedKey = version.split('+')[0];
  if (Object.hasOwn(stagedDigests, pinnedKey)) {
    let digest;
    try {
      digest = computeDirectoryDigest(dir);
    } catch (err) {
      digest = null;
    }
    if (digest !== stagedDigests[pinnedKey]) {
      return row('corrupt-tree', { doctorExit: 1, bootstrapAction: 'reinstall', bootstrapExit: 0 }, info);
    }
    if (contract.status !== 'compatible') {
      return row('incompatible-contract', { doctorExit: 1, bootstrapAction: 'reinstall', bootstrapExit: 0 }, info);
    }
    return row('compatible', { doctorExit: 0, bootstrapAction: 'preserve', bootstrapExit: 0, railsTrusted: true }, info);
  }
  // The bundled release itself must always be digest-pinned: a bumped
  // BUNDLED_ADLC_ANTIGRAVITY_VERSION without a recorded digest fails closed
  // (reinstall) rather than silently trusting an unverified tree.
  if (semverEq(version, bundledVersion)) {
    return row('corrupt-tree', { doctorExit: 1, bootstrapAction: 'reinstall', bootstrapExit: 0 }, { ...info, detail: `no pinned digest for bundled ${bundledVersion}` });
  }
  // 4. Newer, unpinned: the declared contract decides.
  if (contract.status === 'compatible') {
    return row(`compatible (newer-unpinned: v${version})`, { doctorExit: 0, bootstrapAction: 'preserve', bootstrapExit: 0 }, info);
  }
  if (contract.status === 'tolerant') {
    return row('tolerant (unconfirmed-contract)', { doctorExit: 0, bootstrapAction: 'preserve', bootstrapExit: 0 }, info);
  }
  return row('incompatible-contract', { doctorExit: 1, bootstrapAction: 'fail', bootstrapExit: 1 }, { ...info, detail: `declares adlcContract ${JSON.stringify(contract.contract)}, booster speaks ${SUPPORTED_PLUGIN_CONTRACT}` });
}

const PLUGIN_FIX = {
  'not-installed': 'Run `agb bootstrap` to install the bundled plugin.',
  'corrupt-manifest': 'Run `agb bootstrap --force-reinstall`.',
  'outdated-plugin': 'Run `agb bootstrap` to upgrade to the bundled plugin.',
  'corrupt-tree': 'Run `agb bootstrap` to reinstall the pristine plugin.',
  'incompatible-contract': 'Run `agb bootstrap --force-reinstall` to install the bundled plugin.',
};

export async function checkPlugin({ home = homedir() } = {}) {
  const r = evaluateStagedAdlcPlugin({ home });
  const name = 'adlc-antigravity plugin';
  if (r.doctorExit !== 0) {
    return { name, level: 'fail', detail: r.report, fix: PLUGIN_FIX[r.report] ?? null, row: r };
  }
  const level = r.report.startsWith('tolerant') ? 'warn' : 'pass';
  return { name, level, detail: r.report, fix: level === 'warn' ? 'Upgrade the plugin to one that declares adlcContract 1.' : null, row: r };
}

// --- Policy guard self-test (spec §4.4, Appendix A E10) ---------------------

const SELFTEST_RAIL = 'lib/lock.mjs';
const SELFTEST_REASON = `Target path matches frozen rail: ${SELFTEST_RAIL}`;
const MINIMAL_PATH = '/usr/bin:/bin';
const HOOK_TIMEOUT_MS = 15_000;

const sha256File = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');

export function boosterDataDir(home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
}

/** Informational diagnostic log only: nothing reads it to make a decision. */
export function healthLogPath(home = homedir()) {
  return join(boosterDataDir(home), 'rails-guard-health.json');
}

function hookCommand(pluginRoot) {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks.json'), 'utf8'));
  const command = hooks?.['agb-policy-guard']?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (typeof command !== 'string' || !command) throw new Error('hooks.json declares no agb-policy-guard PreToolUse command');
  return command;
}

function selftestRepo(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
  writeFileSync(join(repo, '.adlc', 'tickets', ticketFilename('AGB-SELFTEST')),
    JSON.stringify({ id: 'AGB-SELFTEST', title: 'doctor self-test', body: 'fixture', scope: [], rails: [SELFTEST_RAIL], edges: [] }));
  return repo;
}

function runHookWithPayload(command, pluginRoot, home, payload) {
  const hookEnv = {
    PATH: MINIMAL_PATH,
    HOME: home,
    NODE_V8_COVERAGE: '',
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot || 'C:\\Windows',
          COMSPEC: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
          USERPROFILE: home,
        }
      : {}),
  };
  if (
    process.platform === 'win32' &&
    command.trim() === '/bin/sh bin/hook-runner.sh --timeout 9 dist/hooks/pre-tool-use.bundle.mjs' &&
    existsSync(join(pluginRoot, 'bin', 'hook-runner.sh')) &&
    existsSync(join(pluginRoot, 'bin', 'node-launcher.sh'))
  ) {
    return spawnSync(process.execPath, [join(pluginRoot, 'dist', 'hooks', 'pre-tool-use.bundle.mjs')], {
      cwd: pluginRoot, input: JSON.stringify(payload), encoding: 'utf8',
      env: hookEnv, timeout: HOOK_TIMEOUT_MS,
    });
  }
  const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  return spawnSync(shellBin, shellArgs, {
    cwd: pluginRoot, input: JSON.stringify(payload), encoding: 'utf8',
    // NODE_V8_COVERAGE is pinned empty: Node re-injects it into an explicit
    // env when the key is absent, which would leak instrumentation into the
    // otherwise minimal hook environment.
    env: hookEnv, timeout: HOOK_TIMEOUT_MS,
  });
}

function runHook(command, pluginRoot, home, repo, relPath) {
  const payload = { toolCall: { name: 'write_to_file', args: { TargetFile: join(repo, relPath) } }, workspacePaths: [repo] };
  return runHookWithPayload(command, pluginRoot, home, payload);
}

// Rail payload: one JSON line, decision deny, exact reason. Never throws.
function railVerdict(r) {
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.trim());
  if (r.status !== 0 || lines.length !== 1) return `rail payload: expected one JSON line and exit 0, got exit ${r.status} with ${lines.length} line(s)`;
  let out;
  try { out = JSON.parse(lines[0]); } catch { return 'rail payload: output is not JSON'; }
  if (out.decision !== 'deny') return `rail payload: expected deny, got ${JSON.stringify(out.decision)}`;
  if (!String(out.reason ?? '').includes(SELFTEST_REASON)) return `rail payload: reason lacks '${SELFTEST_REASON}'`;
  return null;
}

// Non-rail payload: empty stdout with exit 0 (an ask is a failure, E10).
function nonRailVerdict(r) {
  if (r.status === 0 && (r.stdout ?? '') === '') return null;
  return `non-rail payload: expected empty stdout and exit 0, got exit ${r.status} and ${JSON.stringify((r.stdout ?? '').trim()).slice(0, 120)}`;
}

// Workflow payload: one JSON line, decision force_ask, exit 0. Never throws.
function workflowVerdict(r) {
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.trim());
  if (r.status !== 0 || lines.length !== 1) return `workflow payload: expected one JSON line and exit 0, got exit ${r.status} with ${lines.length} line(s)`;
  let out;
  try { out = JSON.parse(lines[0]); } catch { return 'workflow payload: output is not JSON'; }
  if (out.decision !== 'force_ask') return `workflow payload: expected force_ask, got ${JSON.stringify(out.decision)}`;
  return null;
}

function writeHealthLog(home, pluginRoot, railsTrusted) {
  try {
    mkdirSync(boosterDataDir(home), { recursive: true });
    writeFileSync(healthLogPath(home), JSON.stringify({
      nodeSha256: sha256File(realpathSync(process.execPath)),
      bundleSha256: sha256File(join(pluginRoot, 'dist', 'hooks', 'pre-tool-use.bundle.mjs')),
      hooksSha256: sha256File(join(pluginRoot, 'hooks.json')),
      railsTrusted,
      timestamp: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch { /* informational only: a log write failure never fails doctor */ }
}

/**
 * Run the EXACT hooks.json command under PATH=/usr/bin:/bin against a fixture
 * repo whose active ticket rails lib/lock.mjs (Appendix A E10). Never throws.
 */
export function checkPolicyGuard({ pluginRoot, home = homedir() } = {}) {
  const name = 'Policy guard self-test';
  const fix = 'Run `agb bootstrap --force-reinstall` and check hooks.log.';
  let dir;
  try {
    const root = pluginRoot ?? resolvePluginRoot();
    const command = hookCommand(root);
    dir = mkdtempSync(join(tmpdir(), 'agb-doctor-selftest-'));
    const repo = selftestRepo(dir);
    const workflowPayload = { toolCall: { name: 'run_workflow', args: { Script: 'pass', Cwd: repo } }, workspacePaths: [repo] };
    const failure = railVerdict(runHook(command, root, home, repo, SELFTEST_RAIL))
      ?? nonRailVerdict(runHook(command, root, home, repo, 'lib/foo.mjs'))
      ?? workflowVerdict(runHookWithPayload(command, root, home, workflowPayload));
    writeHealthLog(home, root, !failure && evaluateStagedAdlcPlugin({ home }).railsTrusted);
    if (failure) return { name, level: 'fail', detail: failure, fix };
    const winNote = process.platform === 'win32' ? ' (win32 bundle direct evaluation)' : '';
    return { name, level: 'pass', detail: `denies ${SELFTEST_RAIL} under PATH=${MINIMAL_PATH}${winNote}`, fix: null };
  } catch (err) {
    return { name, level: 'fail', detail: `self-test could not run: ${err.message}`, fix };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// D10: npm stays a secondary channel; an agb on PATH other than the shim warns.
export function checkSecondaryInstall({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  const name = 'agb install';
  const shim = join(home, '.local', 'bin', 'agb');
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const shimReal = real(shim);
  const pathSep = platform === 'win32' ? ';' : ':';
  const pathValue = String(env.PATH ?? env.Path ?? '');
  const binNames = platform === 'win32' ? ['agb.cmd', 'agb.ps1', 'agb'] : ['agb'];
  const others = new Set();
  for (const dir of pathValue.split(pathSep).filter(Boolean)) {
    for (const binName of binNames) {
      const candidate = join(dir, binName);
      if (existsSync(candidate) && real(candidate) !== shimReal) others.add(candidate);
    }
  }
  if (others.size === 0) return { name, level: 'pass', detail: existsSync(shim) ? shim : 'no agb on PATH', fix: null };
  return { name, level: 'warn', detail: `secondary install detected: ${[...others].join(', ')}`, fix: 'prefer ~/.local/bin/agb (npm is a secondary channel)' };
}

// D15: surface operator use of the AGB_HOOK_DISABLE killswitch from hooks.log.
export function checkKillswitchUsage({ home = homedir() } = {}) {
  const name = 'Hook killswitch';
  let text = '';
  try { text = readFileSync(join(boosterDataDir(home), 'logs', 'hooks.log'), 'utf8'); } catch { /* no log yet */ }
  const count = text.split('\n').filter((l) => l.includes('[CRITICAL NOTICE] AGB_HOOK_DISABLE is active')).length;
  if (count === 0) return { name, level: 'pass', detail: 'never used', fix: null };
  return { name, level: 'warn', detail: `${count} AGB_HOOK_DISABLE bypass notice(s) in hooks.log`, fix: 'Unset AGB_HOOK_DISABLE; the rails guard is bypassed while it is set.' };
}

// P4: leftover live-test probe plugins hook every agy session.
export function checkProbePlugins({ home = homedir() } = {}) {
  const name = 'Probe plugins';
  let probes = [];
  try { probes = readdirSync(pluginsDirFor(home)).filter((n) => n.startsWith('probe-')); } catch { /* no plugins dir */ }
  if (probes.length === 0) return { name, level: 'pass', detail: 'none installed', fix: null };
  return { name, level: 'warn', detail: `installed: ${probes.join(', ')}`, fix: `Run \`agy plugin uninstall ${probes[0]}\` for each probe plugin.` };
}

export async function checkAdlcBinary({ env = process.env, cwd = process.cwd() } = {}) {
  const localPkgDir = join(cwd, 'node_modules', '@adlc', 'cli');
  const localBin = join(cwd, 'node_modules', '.bin', 'adlc');
  const allowCustom = env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';
  const resolved = resolveAdlcBinary({ repo: cwd, env, allowCustom });

  const bin = resolved.ok ? resolved.binary : null;

  if (!bin) {
    if (
      resolved.error === 'vendored-adlc-tampered' ||
      IS_BUNDLED ||
      existsSync(localPkgDir) ||
      existsSync(localBin) ||
      (env.AGB_ADLC_BIN && !allowCustom) ||
      (env.AGB_ADLC_BIN && resolved.error) ||
      (env.ADLC_CLI_PATH && resolved.error)
    ) {
      return {
        name: 'adlc CLI',
        level: 'fail',
        detail: `package manifest authentication failed: ${resolved.error || 'custom AGB_ADLC_BIN requires AGB_ALLOW_CUSTOM_ADLC_CLI=1'}`,
        fix: `Repair or reinstall @adlc/cli (>= ${MIN_ADLC_CLI_VERSION}).`,
      };
    }
    return {
      name: 'adlc CLI',
      level: 'warn',
      detail: 'not found (project-local @adlc/cli absent)',
      fix: 'Install project-local @adlc/cli (`npm install --save-dev @adlc/cli`) or run from the bundled plugin runtime.',
    };
  }
  try {
    const { stdout } = await execFileAuthenticatedAdlc(bin, ['--version'], { env, timeout: 5000 }, { repo: cwd, env, allowCustom });
    let v = stdout.trim();
    if (!v && resolved.version) {
      v = resolved.version;
    }
    if (!v.startsWith('v')) v = 'v' + v;
    const rawV = v.replace(/^v/, '');
    if (!semverGte(rawV, MIN_ADLC_CLI_VERSION)) {
      return {
        name: 'adlc CLI',
        level: 'fail',
        detail: `${v} (required >= v${MIN_ADLC_CLI_VERSION})`,
        fix: `Upgrade @adlc/cli to >= ${MIN_ADLC_CLI_VERSION}.`,
      };
    }
    return { name: 'adlc CLI', level: 'pass', detail: v, fix: null };
  } catch (err) {
    if (bin) {
      return {
        name: 'adlc CLI',
        level: 'fail',
        detail: `execution failed: ${err.message}`,
        fix: `Ensure @adlc/cli executable at ${bin} has execute permissions and a valid Node interpreter.`,
      };
    }
    return { name: 'adlc CLI', level: 'warn', detail: 'not found', fix: 'adlc CLI is optional but recommended. Install it if you want local ADLC gate execution.' };
  }
}

function withFileLockSync(lockPath, fn, { timeoutMs = 10000 } = {}) {
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const start = Date.now();
  let fd = null;
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);

  while (Date.now() - start < timeoutMs) {
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch {}
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > 15000) {
            try { unlinkSync(lockPath); } catch {}
          }
        } catch {}
        Atomics.wait(ia, 0, 0, 10);
        continue;
      }
      throw err;
    }
  }
  if (!fd) {
    throw new Error(`Timeout acquiring lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

/**
 * Multi-factor replay-defended attestation verification for sandbox bypass on Windows.
 * Enforces:
 * 1. installationId matching ~/.adlc/installation_id
 * 2. repositoryRootCommit matching git rev-list --max-parents=0 HEAD
 * 3. repositoryOrigin matching git config --get remote.origin.url
 * 4. repositoryPath matching normalized realpathSync(repo)
 * 5. Single-use nonce recorded in ~/.adlc/consumed_attestations.jsonl and .adlc/consumed_attestations.jsonl
 * 6. TTL <= 1 hour and unexpired
 * 7. HMAC-SHA256 signature verified with process.env.ADLC_ADMIN_KEY
 */
export function verifyWindowsSandboxAttestation({
  repo = process.cwd(),
  env = process.env,
  platform = process.platform,
  configPath = join(repo, '.adlc', 'config.json'),
  bundled = (typeof __AGB_BUNDLED__ !== 'undefined' && Boolean(__AGB_BUNDLED__)) || IS_BUNDLED,
  homeDir = (bundled ? null : env.AGB_HOME_DIR) || homedir(),
  consumeNonce = true,
} = {}) {
  if (platform !== 'win32') {
    return { valid: false, reason: `Sandbox bypass attestation is only supported on Windows (platform is ${platform})` };
  }
  if (!existsSync(configPath)) {
    return { valid: false, reason: 'missing .adlc/config.json' };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    return { valid: false, reason: `failed to parse config: ${err.message}` };
  }
  const att = config.sandboxBypassAttestation;
  if (!att || typeof att !== 'object') {
    return { valid: false, reason: 'missing sandboxBypassAttestation in config' };
  }

  const required = [
    'installationId',
    'repositoryRootCommit',
    'repositoryOrigin',
    'repositoryPath',
    'nonce',
    'runId',
    'acknowledgedPlatform',
    'authorizedBy',
    'timestamp',
    'expiresAt',
    'signature',
  ];
  for (const field of required) {
    if (!att[field]) {
      return { valid: false, reason: `missing required field in attestation: ${field}` };
    }
  }

  if (att.acknowledgedPlatform !== platform) {
    return { valid: false, reason: `platform mismatch: ${att.acknowledgedPlatform} !== ${platform}` };
  }

  const ts = Date.parse(att.timestamp);
  const exp = Date.parse(att.expiresAt);
  if (isNaN(ts) || isNaN(exp)) {
    return { valid: false, reason: 'invalid timestamp or expiresAt date format' };
  }
  if (exp - ts > 3600 * 1000 + 5000) {
    return { valid: false, reason: 'attestation TTL exceeds 1 hour limit' };
  }
  if (Date.now() > exp) {
    return { valid: false, reason: 'attestation expired' };
  }

  const installIdPath = join(homeDir, '.adlc', 'installation_id');
  if (!existsSync(installIdPath)) {
    return { valid: false, reason: `host installation_id missing at ${installIdPath}` };
  }
  const expectedInstallId = readFileSync(installIdPath, 'utf8').trim();
  if (att.installationId !== expectedInstallId) {
    return { valid: false, reason: `installationId mismatch: ${att.installationId} !== ${expectedInstallId}` };
  }

  let canonicalRepo;
  try {
    canonicalRepo = realpathSync(repo);
  } catch {
    canonicalRepo = repo;
  }
  let canonicalAttPath;
  try {
    canonicalAttPath = realpathSync(att.repositoryPath);
  } catch {
    canonicalAttPath = att.repositoryPath;
  }
  if (canonicalAttPath !== canonicalRepo) {
    return { valid: false, reason: `cross_repository_attestation_rejected: ${att.repositoryPath} !== ${canonicalRepo}` };
  }

  let canonicalHome;
  try {
    canonicalHome = realpathSync(homeDir);
  } catch {
    canonicalHome = resolve(homeDir);
  }

  const validateAdlcContainer = (baseDir, canonicalBase, name = 'directory') => {
    const adlcDir = join(baseDir, '.adlc');
    if (existsSync(adlcDir)) {
      const st = lstatSync(adlcDir);
      if (st.isSymbolicLink()) {
        return { valid: false, reason: `${name} .adlc directory is a symbolic link: ${adlcDir}` };
      }
      if (!st.isDirectory()) {
        return { valid: false, reason: `${name} .adlc is not a directory: ${adlcDir}` };
      }
      let realAdlc;
      try { realAdlc = realpathSync(adlcDir); } catch {
        return { valid: false, reason: `failed to resolve ${name} .adlc path: ${adlcDir}` };
      }
      const rel = relative(canonicalBase, realAdlc);
      if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
        return { valid: false, reason: `${name} .adlc directory is outside root: ${adlcDir}` };
      }
    }
    const noncesDir = join(adlcDir, 'nonces');
    if (existsSync(noncesDir)) {
      const st = lstatSync(noncesDir);
      if (st.isSymbolicLink()) {
        return { valid: false, reason: `${name} .adlc/nonces directory is a symbolic link: ${noncesDir}` };
      }
      if (!st.isDirectory()) {
        return { valid: false, reason: `${name} .adlc/nonces is not a directory: ${noncesDir}` };
      }
      let realNonces;
      try { realNonces = realpathSync(noncesDir); } catch {
        return { valid: false, reason: `failed to resolve ${name} .adlc/nonces path: ${noncesDir}` };
      }
      const rel = relative(canonicalBase, realNonces);
      if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
        return { valid: false, reason: `${name} .adlc/nonces directory is outside root: ${noncesDir}` };
      }
    }
    return { valid: true };
  };

  const repoAdlcCheck = validateAdlcContainer(repo, canonicalRepo, 'repository');
  if (!repoAdlcCheck.valid) {
    return repoAdlcCheck;
  }
  const hostAdlcCheck = validateAdlcContainer(homeDir, canonicalHome, 'host');
  if (!hostAdlcCheck.valid) {
    return hostAdlcCheck;
  }

  try {
    const rootCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd: repo, encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (rootCommit && att.repositoryRootCommit !== rootCommit) {
      return { valid: false, reason: `root_commit_mismatch: ${att.repositoryRootCommit} !== ${rootCommit}` };
    }
  } catch (err) {
    return { valid: false, reason: `failed to query git root commit: ${err.message}` };
  }

  let originUrl = '';
  try {
    originUrl = execSync('git config --get remote.origin.url', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {}

  const expectedOrigin = originUrl || 'none';
  if (att.repositoryOrigin !== expectedOrigin) {
    return { valid: false, reason: `repository_origin_mismatch: ${att.repositoryOrigin} !== ${expectedOrigin}` };
  }

  const adminKey = env.ADLC_ADMIN_KEY;
  if (!adminKey) {
    return { valid: false, reason: 'missing ADLC_ADMIN_KEY environment secret' };
  }
  const payload = `${att.installationId}:${att.repositoryRootCommit}:${att.repositoryOrigin}:${att.repositoryPath}:${att.nonce}:${att.runId}:${att.acknowledgedPlatform}:${att.authorizedBy}:${att.timestamp}:${att.expiresAt}`;
  const expectedSig = crypto.createHmac('sha256', adminKey).update(payload).digest('hex');
  if (att.signature !== expectedSig) {
    return { valid: false, reason: 'invalid attestation signature' };
  }

  const repoLedger = join(repo, '.adlc', 'consumed_attestations.jsonl');
  const hostLedger = join(homeDir, '.adlc', 'consumed_attestations.jsonl');

  const checkLedger = (filePath) => {
    if (!existsSync(filePath)) return { ok: true, replayed: false };
    try {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink()) {
        return { ok: false, reason: `attestation ledger file is a symbolic link: ${filePath}` };
      }
      if (!st.isFile()) {
        return { ok: false, reason: `attestation ledger target is not a regular file: ${filePath}` };
      }
      const lines = readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.nonce === att.nonce) return { ok: true, replayed: true };
        } catch {
          return { ok: false, reason: `malformed attestation ledger entry: ${filePath}` };
        }
      }
      return { ok: true, replayed: false };
    } catch (err) {
      return { ok: false, reason: `attestation ledger unreadable: ${err.message}` };
    }
  };

  const repoLedgerRes = checkLedger(repoLedger);
  if (!repoLedgerRes.ok) {
    return { valid: false, reason: `failed to record consumed nonce: ${repoLedgerRes.reason}` };
  }
  const hostLedgerRes = checkLedger(hostLedger);
  if (!hostLedgerRes.ok) {
    return { valid: false, reason: `failed to record consumed nonce: ${hostLedgerRes.reason}` };
  }

  if (repoLedgerRes.replayed || hostLedgerRes.replayed) {
    return { valid: false, reason: 'replayed_attestation_rejected' };
  }

  const safeNonce = String(att.nonce).replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!consumeNonce) {
    if (
      existsSync(join(repo, '.adlc', 'nonces', `${safeNonce}.lock`)) ||
      existsSync(join(homeDir, '.adlc', 'nonces', `${safeNonce}.lock`))
    ) {
      return { valid: false, reason: 'replayed_attestation_rejected' };
    }
    return { valid: true, attestation: att };
  }

  // Atomically reserve the nonce via exclusive file creation (O_CREAT | O_EXCL)
  // to prevent race conditions between concurrent attestation checks
  const reserveNonceAtomic = (baseDir, canonicalBase, name) => {
    const preCheck = validateAdlcContainer(baseDir, canonicalBase, name);
    if (!preCheck.valid) {
      return { ok: false, reason: preCheck.reason };
    }
    const noncesDir = join(baseDir, '.adlc', 'nonces');
    mkdirSync(noncesDir, { recursive: true, mode: 0o700 });
    const postCheck = validateAdlcContainer(baseDir, canonicalBase, name);
    if (!postCheck.valid) {
      return { ok: false, reason: postCheck.reason };
    }
    const lockPath = join(noncesDir, `${safeNonce}.lock`);
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ nonce: att.nonce, runId: att.runId, ts: Date.now() }), 'utf8');
      closeSync(fd);
      return { ok: true, lockPath };
    } catch (err) {
      if (err.code === 'EEXIST') {
        return { ok: false, reason: 'replayed_attestation_rejected' };
      }
      throw err;
    }
  };

  const repoRes = reserveNonceAtomic(repo, canonicalRepo, 'repository');
  if (!repoRes.ok) return { valid: false, reason: repoRes.reason };

  let hostRes;
  try {
    hostRes = reserveNonceAtomic(homeDir, canonicalHome, 'host');
  } catch (err) {
    try { unlinkSync(repoRes.lockPath); } catch {}
    throw err;
  }

  if (!hostRes.ok) {
    try { unlinkSync(repoRes.lockPath); } catch {}
    return { valid: false, reason: hostRes.reason };
  }

  const record = JSON.stringify({ nonce: att.nonce, runId: att.runId, consumedAt: new Date().toISOString() }) + '\n';
  const appendLedger = (filePath) => {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) {
      throw new Error(`attestation ledger directory is a symbolic link: ${dir}`);
    }
    if (existsSync(filePath)) {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink()) {
        throw new Error(`attestation ledger file is a symbolic link: ${filePath}`);
      }
      if (!st.isFile()) {
        throw new Error(`attestation ledger target is not a regular file: ${filePath}`);
      }
    }
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0);
    const fd = openSync(filePath, flags, 0o600);
    try {
      writeSync(fd, record);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const repoLedgerLock = `${repoLedger}.lock`;
  const hostLedgerLock = `${hostLedger}.lock`;

  try {
    withFileLockSync(repoLedgerLock, () => {
      withFileLockSync(hostLedgerLock, () => {
        let repoLedgerExisted = false;
        let repoLedgerOrigSize = 0;
        if (existsSync(repoLedger)) {
          repoLedgerExisted = true;
          try { repoLedgerOrigSize = statSync(repoLedger).size; } catch { repoLedgerOrigSize = 0; }
        }

        let hostLedgerExisted = false;
        let hostLedgerOrigSize = 0;
        if (existsSync(hostLedger)) {
          hostLedgerExisted = true;
          try { hostLedgerOrigSize = statSync(hostLedger).size; } catch { hostLedgerOrigSize = 0; }
        }

        try {
          appendLedger(repoLedger);
        } catch (repoErr) {
          try {
            if (!repoLedgerExisted) {
              if (existsSync(repoLedger)) unlinkSync(repoLedger);
            } else {
              truncateSync(repoLedger, repoLedgerOrigSize);
            }
          } catch {}
          throw repoErr;
        }

        try {
          appendLedger(hostLedger);
        } catch (hostErr) {
          try {
            if (!hostLedgerExisted) {
              if (existsSync(hostLedger)) unlinkSync(hostLedger);
            } else {
              truncateSync(hostLedger, hostLedgerOrigSize);
            }
          } catch {}
          try {
            if (!repoLedgerExisted) {
              if (existsSync(repoLedger)) unlinkSync(repoLedger);
            } else {
              truncateSync(repoLedger, repoLedgerOrigSize);
            }
          } catch {}
          throw hostErr;
        }
      });
    });
  } catch (err) {
    try { unlinkSync(repoRes.lockPath); } catch {}
    try { unlinkSync(hostRes.lockPath); } catch {}
    return { valid: false, reason: `failed to record consumed nonce: ${err.message}` };
  }

  return { valid: true, attestation: att };
}

export function isTestExecution(env = process.env) {
  if (IS_BUNDLED || (typeof __AGB_BUNDLED__ !== 'undefined' && __AGB_BUNDLED__ === true)) {
    return false;
  }
  const effectiveNodeEnv = env?.NODE_ENV ?? process.env.NODE_ENV;
  if (effectiveNodeEnv && effectiveNodeEnv !== 'test') {
    return false;
  }
  return (
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    Boolean(env?.NODE_TEST_CONTEXT) ||
    process.execArgv.includes('--test') ||
    process.argv.some(arg => typeof arg === 'string' && (arg.endsWith('.test.mjs') || arg.endsWith('.test.js') || arg === '--test'))
  );
}

/**
 * Active differential sandbox verification on Windows (AppContainer probe).
 */
export async function verifyWindowsSandboxActive({ cwd = process.cwd(), env = process.env } = {}) {
  let canonicalCwd;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    canonicalCwd = resolve(cwd);
  }

  const worktreeDir = join(cwd, '.worktrees');
  if (existsSync(worktreeDir)) {
    try {
      const st = lstatSync(worktreeDir);
      if (st.isSymbolicLink()) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: `repository .worktrees directory is a symbolic link: ${worktreeDir}`,
          fix: 'Remove symbolic link at .worktrees.',
        };
      }
      if (!st.isDirectory()) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: `repository .worktrees is not a directory: ${worktreeDir}`,
          fix: 'Ensure .worktrees is a valid directory.',
        };
      }
      let realWorktreeDir;
      try { realWorktreeDir = realpathSync(worktreeDir); } catch { realWorktreeDir = worktreeDir; }
      const relWorktree = relative(canonicalCwd, realWorktreeDir);
      if (!relWorktree || relWorktree === '.' || relWorktree.startsWith('..') || isAbsolute(relWorktree)) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: `repository .worktrees directory is outside repository: ${worktreeDir}`,
          fix: 'Ensure .worktrees resides within repository root.',
        };
      }
    } catch (err) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: `failed to inspect .worktrees directory: ${err.message}`,
        fix: 'Ensure .worktrees is accessible.',
      };
    }
  } else {
    try {
      mkdirSync(worktreeDir, { recursive: true });
      const st = lstatSync(worktreeDir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: `repository .worktrees directory is a symbolic link or not a directory: ${worktreeDir}`,
          fix: 'Ensure .worktrees is a valid directory.',
        };
      }
      let realWorktreeDir;
      try { realWorktreeDir = realpathSync(worktreeDir); } catch { realWorktreeDir = worktreeDir; }
      const relWorktree = relative(canonicalCwd, realWorktreeDir);
      if (!relWorktree || relWorktree === '.' || relWorktree.startsWith('..') || isAbsolute(relWorktree)) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: `repository .worktrees directory is outside repository: ${worktreeDir}`,
          fix: 'Ensure .worktrees resides within repository root.',
        };
      }
    } catch (err) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: `failed to create .worktrees directory: ${err.message}`,
        fix: 'Ensure repository root is writable.',
      };
    }
  }

  const canaryPath = (isTestExecution(env) && env.AGB_MOCK_WIN_CANARY)
    ? env.AGB_MOCK_WIN_CANARY
    : join(env.LOCALAPPDATA || tmpdir(), `agb_canary_${crypto.randomUUID()}.tmp`);
  const canaryExistedBefore = existsSync(canaryPath);
  const nonce = crypto.randomUUID();
  const worktreeCanary = join(worktreeDir, `sandbox_canary_${crypto.randomUUID()}.tmp`);
  const worktreeCanaryExistedBefore = existsSync(worktreeCanary);

  let connectionsAccepted = 0;
  const server = net.createServer((socket) => {
    connectionsAccepted++;
    socket.destroy();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const probeHelper = (isTestExecution(env) && env.AGB_SANDBOX_PROBE_HELPER)
      ? env.AGB_SANDBOX_PROBE_HELPER
      : join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'sandbox-probe-helper.mjs');
    let probeStdout = '';
    let probeStderr = '';

    if (env.AGB_SANDBOX_PROBE_CMD) {
      if (!isTestExecution(env)) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: 'AGB_SANDBOX_PROBE_CMD override is restricted to test-only execution',
          fix: 'Remove AGB_SANDBOX_PROBE_CMD from environment to use authenticated agy --sandbox',
        };
      }

      const args = env.AGB_SANDBOX_PROBE_HELPER
        ? [env.AGB_SANDBOX_PROBE_HELPER, '--canary', canaryPath, '--port', String(port), '--worktree-canary', worktreeCanary, '--nonce', nonce]
        : ['--canary', canaryPath, '--port', String(port), '--worktree-canary', worktreeCanary, '--nonce', nonce];
      const { stdout, stderr } = await execFileAsync(env.AGB_SANDBOX_PROBE_CMD, args, { env, timeout: 10000 });
      probeStdout = stdout;
      probeStderr = stderr || '';
    } else {
      const agyBin = env.AGB_AGY_BIN || 'agy';
      const { stdout, stderr } = await execFileAsync(agyBin, [
        '--sandbox',
        process.execPath,
        probeHelper,
        '--canary', canaryPath,
        '--port', String(port),
        '--worktree-canary', worktreeCanary,
        '--nonce', nonce,
      ], { env, timeout: 15000 });
      probeStdout = stdout;
      probeStderr = stderr || '';
    }

    let probeResult;
    try {
      const jsonLine = probeStdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
      probeResult = JSON.parse(jsonLine || probeStdout);
    } catch {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: `unparseable sandbox probe output: ${probeStdout.slice(0, 100)}`,
        fix: 'Ensure agy --sandbox is operational.',
      };
    }

    // 1. File containment check: Win32 ERROR_ACCESS_DENIED (5) or EACCES, and file does not exist
    if (probeResult.file?.ok || existsSync(canaryPath)) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: 'file containment breach: canary file created outside repository',
        fix: 'Ensure Windows AppContainer policy denies writes outside worktree.',
      };
    }
    const fileCode = probeResult.file?.code;
    const fileErrno = probeResult.file?.errno;
    if (fileCode !== 'EACCES' && fileCode !== 'EPERM' && fileErrno !== 5 && fileErrno !== -13) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: `file containment expected EACCES/5, got ${fileCode || fileErrno}`,
        fix: 'Ensure Windows AppContainer filesystem isolation is active.',
      };
    }

    // 2. Network isolation check: 0 accepted connections and WSAEACCES (10013) or EACCES
    if (connectionsAccepted > 0 || probeResult.net?.ok) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: 'network isolation breach: loopback connection accepted',
        fix: 'Ensure Windows AppContainer policy denies loopback network access.',
      };
    }
    const netCode = probeResult.net?.code;
    const netErrno = probeResult.net?.errno;
    if (netCode !== 'EACCES' && netCode !== 'WSAEACCES' && netErrno !== 10013 && netErrno !== -13) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: `network isolation expected WSAEACCES/EACCES, got ${netCode || netErrno}`,
        fix: 'Ensure Windows AppContainer network isolation is active.',
      };
    }

    // 3. Positive control: worktree canary exists and contains nonce
    if (!existsSync(worktreeCanary) || readFileSync(worktreeCanary, 'utf8') !== nonce) {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: 'positive control failed: worktree canary missing or nonce mismatch',
        fix: 'Ensure worktree directory is writable inside sandbox.',
      };
    }

    // 4. Driver attestation signature check if required
    if (env.AGB_REQUIRE_DRIVER_SIGNATURE === '1') {
      const combined = probeStdout + '\n' + probeStderr;
      if (!combined.includes('[sandbox] active AppContainer policy')) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: 'missing driver attestation signature: [sandbox] active AppContainer policy',
          fix: 'Upgrade Antigravity to >= 2.15.1.',
        };
      }
    }

    return {
      name: 'Sandbox',
      level: 'pass',
      detail: 'Windows AppContainer verified (EACCES/WSAEACCES/nonce)',
      fix: null,
    };
  } catch (err) {
    return {
      name: 'Sandbox',
      level: 'fail',
      detail: `AppContainer probe failed: ${err.message}`,
      fix: 'Ensure Windows AppContainer driver is active or provide sandboxBypassAttestation.',
    };
  } finally {
    try { server.close(); } catch {}
    try {
      if (!canaryExistedBefore && existsSync(canaryPath)) {
        rmSync(canaryPath, { force: true });
      }
    } catch {}
    try {
      if (!worktreeCanaryExistedBefore && existsSync(worktreeCanary)) {
        rmSync(worktreeCanary, { force: true });
      }
    } catch {}
  }
}

export function checkKernelContainment(platform = process.platform, options = {}) {
  let effectivePlatform = platform;
  let env = process.env;
  if (typeof platform === 'object' && platform !== null) {
    effectivePlatform = platform.platform ?? process.platform;
    env = platform.env ?? process.env;
  } else if (options && typeof options === 'object') {
    env = options.env ?? process.env;
  }

  if (isTestExecution(env)) {
    if (env.AGB_MOCK_CONTAINMENT_UNAVAILABLE === '1') {
      return { supported: false, mechanism: null, kind: 'mock_unavailable', detail: 'Kernel containment floor unavailable (mocked)' };
    }
    if (env.AGB_MOCK_CONTAINMENT_MECHANISM) {
      return { supported: true, mechanism: env.AGB_MOCK_CONTAINMENT_MECHANISM };
    }
  }
  if (effectivePlatform === 'win32') {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 5000, env });
      return { supported: true, mechanism: 'job_object' };
    } catch {
      return { supported: false, mechanism: null, kind: 'powershell_missing', detail: 'powershell.exe is unavailable to initialize Windows Job Object containment' };
    }
  }
  if (effectivePlatform === 'linux') {
    try {
      const probeArgs = ['--proc', '/proc', '--dev', '/dev', '--unshare-pid'];
      for (const d of ['/usr', '/bin', '/lib', '/lib64']) {
        if (existsSync(d)) probeArgs.push('--ro-bind', d, d);
      }
      probeArgs.push('--', 'true');
      execFileSync('bwrap', probeArgs, { stdio: 'ignore', timeout: 5000, env });
      return { supported: true, mechanism: 'bwrap_pid' };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          supported: false,
          mechanism: null,
          kind: 'bwrap_missing',
          detail: 'Kernel containment floor unavailable on Linux: bubblewrap (bwrap) is required for filesystem and namespace isolation. Fallback mechanisms (systemd-run, unshare) provide insufficient filesystem isolation.',
        };
      }
      return {
        supported: false,
        mechanism: null,
        kind: 'bwrap_unusable',
        detail: `Kernel containment floor unavailable on Linux: bubblewrap (bwrap) failed usability probe: ${err.message || 'namespaces restricted'}. User namespaces may be disabled (e.g. sysctl kernel.unprivileged_userns_clone=0) or restricted in container.`,
      };
    }
  }
  if (effectivePlatform === 'darwin') {
    try {
      execFileSync('sandbox-exec', ['-p', '(version 1) (allow default)', 'true'], { stdio: 'ignore', env });
      return { supported: true, mechanism: 'seatbelt' };
    } catch {
      return { supported: false, mechanism: null, kind: 'sandbox_exec_unavailable', detail: 'sandbox-exec is unavailable on darwin' };
    }
  }
  if (effectivePlatform.includes('bsd')) {
    return { supported: false, mechanism: null, kind: 'unsupported_platform', detail: 'Kernel containment floor unavailable on bsd' };
  }
  return { supported: false, mechanism: null, kind: 'unsupported_platform', detail: `Unsupported platform: ${effectivePlatform}` };
}

export async function checkSandbox({ env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  if (env.AGB_SANDBOX_GATES === '0') {
    return {
      name: 'Sandbox',
      level: 'warn',
      detail: 'bypassed via env (AGB_SANDBOX_GATES=0)',
      fix: 'Unset AGB_SANDBOX_GATES outside disposable containers so gate commands remain sandboxed.',
    };
  }
  if (platform === 'darwin') {
    const containment = checkKernelContainment(platform, { env });
    if (containment.supported) {
      return { name: 'Sandbox', level: 'pass', detail: 'sandbox-exec available', fix: null };
    }
    return { name: 'Sandbox', level: 'fail', detail: 'sandbox-exec missing or unusable', fix: 'macOS sandbox-exec is missing or unusable. Set AGB_SANDBOX_GATES=0 to bypass.' };
  }
  if (platform === 'linux') {
    const containment = checkKernelContainment(platform, { env });
    if (containment.supported) {
      return { name: 'Sandbox', level: 'pass', detail: 'bwrap available', fix: null };
    }
    if (containment.kind === 'bwrap_unusable') {
      return {
        name: 'Sandbox',
        level: 'fail',
        detail: 'bwrap unusable (namespace probe failed)',
        fix: 'Linux bubblewrap (bwrap) is installed but unusable (user namespaces may be disabled or restricted in container). Enable unprivileged user namespaces or set AGB_SANDBOX_GATES=0 to bypass.',
      };
    }
    return {
      name: 'Sandbox',
      level: 'fail',
      detail: 'bwrap missing',
      fix: 'Linux bubblewrap (bwrap) is missing. apt install bubblewrap or set AGB_SANDBOX_GATES=0 to bypass.',
    };
  }
  if (platform === 'win32') {
    const configPath = join(cwd, '.adlc', 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        if (config.sandboxBypassAttestation) {
          const attRes = verifyWindowsSandboxAttestation({ repo: cwd, env, platform, cwd, consumeNonce: false });
          if (attRes.valid) {
            return { name: 'Sandbox', level: 'pass', detail: 'bypassed via verified HMAC attestation', fix: null };
          }
          return {
            name: 'Sandbox',
            level: 'fail',
            detail: `attestation rejected: ${attRes.reason}`,
            fix: 'Repair or update sandboxBypassAttestation in .adlc/config.json.',
          };
        }
      } catch (err) {
        return {
          name: 'Sandbox',
          level: 'fail',
          detail: `malformed config: ${err.message}`,
          fix: 'Repair .adlc/config.json.',
        };
      }
    }

    return await verifyWindowsSandboxActive({ cwd, env });
  }
  return { name: 'Sandbox', level: 'fail', detail: `unsupported platform: ${platform}`, fix: 'Sandbox is only supported on macOS, Linux, and Windows. Set AGB_SANDBOX_GATES=0 to bypass.' };
}

export async function checkBrainDir({ env = process.env, home = homedir() } = {}) {
  const custom = env.AGB_BRAIN_DIR;
  if (custom) {
    return existsSync(custom)
      ? { name: 'Brain Dir', level: 'pass', detail: 'exists', fix: null }
      : { name: 'Brain Dir', level: 'warn', detail: 'not found', fix: `Create directory ${custom} or unset AGB_BRAIN_DIR.` };
  }
  const candidates = [
    join(home, '.gemini', 'antigravity-cli', 'brain'),
    join(home, '.gemini', 'antigravity', 'brain'),
    join(home, '.gemini', 'jetski', 'brain'),
  ];
  const found = candidates.find((d) => existsSync(d));
  if (found) {
    return { name: 'Brain Dir', level: 'pass', detail: 'exists', fix: null };
  }
  return { name: 'Brain Dir', level: 'warn', detail: 'not found', fix: 'Run an agy session to initialize the brain directory.' };
}

export async function checkTicketStore({ cwd = process.cwd(), env = process.env, repo = cwd } = {}) {
  for (const rel of ['.adlc', join('.adlc', 'tickets'), join('.adlc', 'tickets.json')]) {
    let st;
    try {
      st = lstatSync(join(cwd, rel), { throwIfNoEntry: false });
    } catch {
      return {
        name: 'Ticket Store',
        level: 'fail',
        detail: 'store corruption: unreadable ADLC ticket store path',
        fix: 'Run `adlc ticket doctor` to diagnose and repair ticket store issues.',
      };
    }
    if (st?.isSymbolicLink()) {
      return {
        name: 'Ticket Store',
        level: 'fail',
        detail: 'store corruption: symlinked ADLC ticket store path',
        fix: 'Run `adlc ticket doctor` to diagnose and repair ticket store issues.',
      };
    }
  }
  const backend = detectTicketStoreBackend(cwd);
  if (backend === 'both') {
    return {
      name: 'Ticket Store', level: 'fail', detail: 'both legacy and directory stores',
      fix: 'The legacy .adlc/tickets.json is retired and the plugin fails closed when both exist. Run `adlc ticket store migrate`, then remove .adlc/tickets.json.',
    };
  }
  if (backend === 'legacy') {
    return {
      name: 'Ticket Store', level: 'fail', detail: 'legacy single-file store (retired)',
      fix: 'agb no longer supports .adlc/tickets.json. Run `adlc ticket store migrate` and commit the result.',
    };
  }
  if (backend === 'none' && existsSync(join(cwd, '.adlc', 'tickets'))) {
    return {
      name: 'Ticket Store', level: 'warn', detail: 'orphaned directory store (no .store.json)',
      fix: 'Likely an interrupted projection — the next `agb plan` recovers it, or run `adlc ticket doctor`.',
    };
  }
  if (backend === 'none') {
    return { name: 'Ticket Store', level: 'pass', detail: 'none (created on first projection)', fix: null };
  }

  try {
    loadTicketSnapshot({ root: cwd, env: {} });
  } catch (err) {
    if (err?.code !== 'STORE_NOT_FOUND') {
      return {
        name: 'Ticket Store',
        level: 'fail',
        detail: `store corruption: ${err?.code ?? 'ERROR'}: ${err?.message ?? String(err)}`,
        fix: 'Run `adlc ticket doctor` to diagnose and repair ticket store issues.',
      };
    }
  }

  const allowCustom = env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';
  const resolved = resolveAdlcBinary({ repo: cwd, env, allowCustom });
  const fallbackResolved = !resolved.ok && repo !== cwd ? resolveAdlcBinary({ repo, env, allowCustom }) : null;
  const activeResolved = resolved.ok ? resolved : (fallbackResolved?.ok ? fallbackResolved : null);
  const bin = activeResolved?.ok ? activeResolved.binary : null;

  if (!bin) {
    const errReason = resolved.error || fallbackResolved?.error;
    if (errReason === 'vendored-adlc-tampered' || IS_BUNDLED) {
      return {
        name: 'Ticket Store',
        level: 'fail',
        detail: `${backend} backend (cannot verify: ${errReason || 'vendored adlc CLI unavailable'})`,
        fix: 'Run `agb bootstrap --force-reinstall` to restore the vendored ADLC CLI.',
      };
    }
    return {
      name: 'Ticket Store',
      level: 'warn',
      detail: `${backend} backend (unverified: ${errReason || 'adlc CLI unavailable'})`,
      fix: 'Install project-local @adlc/cli (`npm install --save-dev @adlc/cli`) or run from the bundled plugin runtime to verify the ticket store.',
    };
  }

  let doctorOutput;
  try {
    const { stdout } = await execFileAuthenticatedAdlc(bin, ['ticket', 'doctor', '--json'], { cwd, env, timeout: 10000 }, { repo: cwd, env, allowCustom });
    doctorOutput = stdout;
  } catch (err) {
    if (err.stdout) {
      doctorOutput = err.stdout;
    } else if (err.code === 'ENOENT' || err.code === 127) {
      return {
        name: 'Ticket Store',
        level: 'warn',
        detail: 'adlc binary not found or failed to execute ticket doctor',
        fix: 'Ensure @adlc/cli is installed and reachable.',
      };
    } else {
      return {
        name: 'Ticket Store',
        level: 'fail',
        detail: `store corruption: adlc ticket doctor failed (${err.stderr?.trim() || err.message})`,
        fix: 'Run `adlc ticket doctor` to diagnose and repair ticket store issues.',
      };
    }
  }

  if (doctorOutput) {
    try {
      const parsed = JSON.parse(doctorOutput);
      if (!parsed.ok || (parsed.exitCode !== undefined && parsed.exitCode !== 0)) {
        const failedChecks = (parsed.checks || [])
          .filter(c => !c.ok)
          .map(c => `${c.name}${c.detail ? `: ${c.detail}` : ''}`)
          .join(', ');
        return {
          name: 'Ticket Store',
          level: 'fail',
          detail: `store corruption: ${failedChecks || 'ticket doctor reported errors'}`,
          fix: 'Run `adlc ticket doctor` to diagnose and repair ticket store issues.',
        };
      }
    } catch {
      return {
        name: 'Ticket Store',
        level: 'fail',
        detail: `store corruption: unparseable ticket doctor output`,
        fix: 'Run `adlc ticket doctor` to diagnose and repair ticket store issues.',
      };
    }
  }

  const detail = `${backend} backend`;
  return { name: 'Ticket Store', level: 'pass', detail, fix: null };
}

function ensureContainedRepoDir(realRepo, ...segments) {
  let cur = realRepo;
  for (const seg of segments) {
    cur = join(cur, seg);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        throw new Error(`Security violation: symbolic link in repository path: ${cur}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`Security violation: expected directory at: ${cur}`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      mkdirSync(cur, { recursive: true });
    }
    const realCur = realpathSync(cur);
    const rel = relative(realRepo, realCur);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Security violation: path escapes repository root: ${cur}`);
    }
  }
  return cur;
}

function assertNoSymlinkFile(filePath) {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Security violation: symbolic link at file target: ${filePath}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function ensureTicketsDirectoryStore(realRepo, adlcDir) {
  const ticketsDir = join(adlcDir, 'tickets');
  try {
    const st = lstatSync(ticketsDir);
    if (st.isSymbolicLink()) {
      throw new Error(`Security violation: symbolic link in repository path: ${ticketsDir}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Security violation: expected directory at: ${ticketsDir}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    initializeDirectoryStore(ticketsDir);
    return true;
  }
  ensureContainedRepoDir(realRepo, '.adlc', 'tickets');
  const storePath = join(ticketsDir, '.store.json');
  assertNoSymlinkFile(storePath);
  if (!existsSync(storePath) && readdirSync(ticketsDir).length === 0) {
    rmSync(ticketsDir, { recursive: true, force: true });
    initializeDirectoryStore(ticketsDir);
    return true;
  }
  return false;
}

export async function checkCodegraph({ cwd = process.cwd(), repo = cwd, env = process.env, codegraphBin = 'codegraph' } = {}) {
  const name = 'CodeGraph index';
  const targetRepo = resolve(repo ?? cwd ?? process.cwd());
  if (env.AGB_CODEGRAPH === '0') {
    return { name, level: 'info', detail: 'disabled via AGB_CODEGRAPH=0 (opt-in)', fix: null };
  }
  const configPath = join(targetRepo, '.adlc', 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg?.accelerators?.codegraph === false) {
        return { name, level: 'info', detail: 'disabled in .adlc/config.json (opt-in)', fix: null };
      }
    } catch {}
  }
  const cgDir = join(targetRepo, '.codegraph');
  const st = lstatOrNull(cgDir);
  if (!st) {
    return {
      name,
      level: 'info',
      detail: 'not initialized (opt-in)',
      fix: 'Run `agb init --with-codegraph` or `codegraph init` for surgical graph slicing.',
    };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return {
      name,
      level: 'warn',
      detail: '.codegraph is not a local directory',
      fix: 'Replace .codegraph with a local directory created by `codegraph init`.',
    };
  }
  try {
    const { stdout } = await execFileAsync(codegraphBin, ['status'], { cwd: targetRepo, env, timeout: 5000 });
    const raw = String(stdout ?? '').trim();
    if (/\b(stale|out[- ]of[- ]date|behind|needs[- ]sync|dirty)\b/i.test(raw)) {
      return {
        name,
        level: 'warn',
        detail: 'indexed (stale)',
        fix: 'Run `codegraph sync` to refresh the index.',
      };
    }
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
    return {
      name,
      level: 'pass',
      detail: firstLine ? `indexed (${firstLine.slice(0, 48)})` : 'indexed (up-to-date)',
      fix: null,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        name,
        level: 'warn',
        detail: '.codegraph present (CLI not installed)',
        fix: 'Install the `codegraph` CLI on PATH to sync and query the index.',
      };
    }
    const combined = `${err?.stdout ?? ''} ${err?.stderr ?? ''}`;
    if (/\b(stale|out[- ]of[- ]date|behind|needs[- ]sync|dirty)\b/i.test(combined)) {
      return {
        name,
        level: 'warn',
        detail: 'indexed (stale)',
        fix: 'Run `codegraph sync` to refresh the index.',
      };
    }
    return {
      name,
      level: 'warn',
      detail: 'index present (status check unavailable)',
      fix: 'Run `codegraph status` or `codegraph sync` to inspect the index.',
    };
  }
}

const DECISION_KEY_ENV = {
  'gemini-decisions': 'GEMINI_API_KEY',
  jev: 'TYPESAFE_API_KEY',
  kev: 'AGB_KEV_API_KEY',
};

export async function checkDecisionEngine({ cwd = process.cwd(), repo = cwd, env = process.env } = {}) {
  const name = 'Decision Engine';
  const targetRepo = resolve(repo ?? cwd ?? process.cwd());
  if (env.AGB_DECISION_ENGINE === '0') {
    return { name, level: 'info', detail: 'disabled via AGB_DECISION_ENGINE=0', fix: null };
  }
  let rawCfg = {};
  const configPath = join(targetRepo, '.adlc', 'config.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      if (parsed?.accelerators?.decision && typeof parsed.accelerators.decision === 'object' && !Array.isArray(parsed.accelerators.decision)) {
        rawCfg = parsed.accelerators.decision;
      }
    } catch {}
  }

  const resolved = resolveDecisionConfig({ repo: targetRepo, env });
  if (resolved.enabled) {
    const suffix = resolved.autoDetected ? ', auto-detected via GEMINI_API_KEY' : '';
    return {
      name,
      level: 'pass',
      detail: `${resolved.provider} (${resolved.model}${suffix})`,
      fix: null,
    };
  }

  const envProvider = env.AGB_DECISION_PROVIDER;
  const isConfigured = rawCfg.enabled === true || Boolean(envProvider);
  if (!isConfigured) {
    return {
      name,
      level: 'info',
      detail: 'opt-in, not configured',
      fix: 'Set GEMINI_API_KEY (auto-detected for Gemini Decisions API) or run `agb init --decision-provider <gemini-decisions|jev|kev>` to enable System-1 gating.',
    };
  }

  const provider = envProvider || rawCfg.provider;
  if (!provider || !DECISION_PROVIDERS.includes(provider)) {
    return {
      name,
      level: 'warn',
      detail: `unknown provider '${String(provider ?? '')}'`,
      fix: `Set provider to one of: ${DECISION_PROVIDERS.join(', ')}.`,
    };
  }
  if (provider === 'kev') {
    const baseUrl = env.AGB_KEV_BASE_URL || rawCfg.baseUrl;
    if (!baseUrl) {
      return {
        name,
        level: 'warn',
        detail: 'kev: missing base URL',
        fix: 'Set AGB_KEV_BASE_URL or accelerators.decision.baseUrl.',
      };
    }
    try {
      validateDecisionUrl(baseUrl);
    } catch {
      return {
        name,
        level: 'warn',
        detail: 'kev: invalid endpoint URL',
        fix: 'Endpoint URL must use https:// (or http:// on loopback).',
      };
    }
  } else {
    const keyEnv = DECISION_KEY_ENV[provider];
    if (keyEnv && !env[keyEnv]) {
      return {
        name,
        level: 'warn',
        detail: `${provider}: missing ${keyEnv}`,
        fix: `Set ${keyEnv} in your environment to enable ${provider}.`,
      };
    }
    if (rawCfg.baseUrl) {
      try {
        validateDecisionUrl(rawCfg.baseUrl);
      } catch {
        return {
          name,
          level: 'warn',
          detail: `${provider}: invalid endpoint URL`,
          fix: 'Endpoint URL must use https:// (or http:// on loopback).',
        };
      }
    }
  }
  return {
    name,
    level: 'warn',
    detail: `${provider}: configured but inactive`,
    fix: 'Check accelerators.decision in .adlc/config.json and provider environment variables.',
  };
}

function appendCodegraphGitignore(realRepo) {
  const gitignorePath = join(realRepo, '.gitignore');
  assertNoSymlinkFile(gitignorePath);
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const hasEntry = existing.split(/\r?\n/).some((line) => /^\s*\.codegraph\/?\s*$/.test(line));
  if (hasEntry) return false;
  const prefix = existing.length === 0 ? '' : (existing.endsWith('\n') ? '' : '\n');
  writeFileSync(gitignorePath, `${existing}${prefix}.codegraph/\n`, 'utf8');
  return true;
}

const CLOUD_ENVIRONMENT_JSON =
  JSON.stringify(
    {
      install:
        'set -euo pipefail; if command -v apt-get >/dev/null 2>&1 && { ! command -v bwrap >/dev/null 2>&1 || ! command -v shellcheck >/dev/null 2>&1; }; then sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap shellcheck; fi; if ! command -v adlc >/dev/null 2>&1; then npm install -g --ignore-scripts @adlc/cli; fi; if ! command -v agb >/dev/null 2>&1; then npm install -g --ignore-scripts antigravity-booster; fi; if ! command -v codegraph >/dev/null 2>&1; then npm install -g @colbymchenry/codegraph; fi; if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi; if [ -d .codegraph ]; then CODEGRAPH_TELEMETRY=0 codegraph sync; else CODEGRAPH_TELEMETRY=0 codegraph init -y --local-only; fi',
    },
    null,
    2
  ) + '\n';

const CLOUD_ADLC_RULE_MD = `---
trigger: always_on
description: Mandatory ADLC ticket, disjoint scope, frozen rail, and P5 prosecution workflow for Booster Cloud & Remote Agents
---

# Booster Cloud & Remote Agent ADLC Workflow

1. **Ticket First (P0):** Author tickets in \`.adlc/tickets/\` via \`adlc ticket create --input - --write\` before editing implementation files.
2. **Shape & Interrogate (P1/P2):** Validate specs with \`agb shape <spec.md> --strict\` and inspect prompts via \`agb plan <spec.md> --prompt-only\` or \`agb review --plan <spec.md> --prompt-only\`.
3. **Isolated Worktrees on \`inherit\` Subagents (P3/P4):** For parallel waves in Remote Agents, create \`.worktrees/agb-<ticket-id>\` checkouts, set \`AGB_WORKER_TICKET=<id>\` and \`AGB_WORKTREE_ROOT=<abs-worktree>\`, or compile via \`agb plan <spec.md> --emit-workflow workflow.py\`.
4. **Deterministic Gate Before Done (P5):** Run \`agb gate-ticket <ticket-id> --base main\` and generate P6 sign-off artifacts via \`agb accept --base main --html <artifact-dir>/accept-dossier.html\`.
`;

const CLOUD_SKILL_MD = `---
name: agb-cloud
description: Zero-agy Antigravity Booster orchestration for Web Standalone, Remote Agents (jetski), and Cloud VMs using agb shape, --prompt-only, --emit-workflow, agb gate-ticket, and agb accept --html.
---

# Booster Cloud Mode (\`agb-cloud\`)

Use these zero-\`agy\` deterministic commands inside Antigravity Web Standalone and Remote Agent VMs:

- **Shape DAG & Scopes:** \`agb shape specs/<feature>.md --strict\`
- **In-Harness Planning Prompts:** \`agb plan specs/<feature>.md --prompt-only --json\`
- **Emit Async \`/run-workflow\` Script:** \`agb plan specs/<feature>.md --no-coldstart --no-parallax --no-premortem --emit-workflow .booster/workflow.py\`
- **Deterministic P5 Ticket Prosecutor:** \`agb gate-ticket <TICKET-ID> --base main --json\`
- **In-Harness 5-Lens ARL Prompts:** \`agb review . main...HEAD --five-lens --prompt-only --json\`
- **Interactive P6 HTML Sign-Off Artifact:** \`agb accept . --base main --html <brain-dir>/accept.html\`
`;

const CLOUD_PROSECUTOR_AGENT_MD = `---
name: prosecutor
description: Cross-model refutation prosecutor evaluating candidate diffs against ticket scope and frozen rails.
tools: [grep_search, find_by_name, view_file, list_dir]
subagent: true
mainAgent: false
commandExecutionPolicy: sandbox
model: ${PROSECUTORS.gemini}
---

You are a skeptical ADLC prosecutor. Refute unverified claims of completion by auditing candidate diffs against declared ticket scope, frozen rails, edge cases, and hollow test assertions.
`;

const CLOUD_SPEC_LINTER_AGENT_MD = `---
name: spec-linter
description: ADLC P1 specification auditor verifying executable acceptance criteria and disjoint ticket scopes.
tools: [grep_search, find_by_name, view_file, list_dir]
subagent: true
mainAgent: false
commandExecutionPolicy: sandbox
model: ${ROLE_MODELS.premortem}
---

You are an ADLC specification auditor. Verify that every ticket declares disjoint scopes, explicit dependency edges, standing rails, and deterministic backticked verification commands.
`;

function writeContainedCloudFile(realRepo, dirSegments, filename, content, { force = false } = {}) {
  const dir = ensureContainedRepoDir(realRepo, ...dirSegments);
  const target = join(dir, filename);
  assertNoSymlinkFile(target);
  if (existsSync(target) && !force) {
    return { path: target, created: false };
  }
  writeFileSync(target, content, 'utf8');
  return { path: target, created: true };
}

const AUTOMATION_TEMPLATES = Object.freeze([
  [
    'agb-quota-resume.json',
    JSON.stringify(
      {
        version: 1,
        id: 'agb-quota-resume',
        name: 'AGB Quota Reset Fleet Resume',
        description: 'Checks 4-window pool quota status and resumes paused ADLC fleet runs when capacity replenishes.',
        schedule: '*/30 * * * *',
        timezone: 'UTC',
        commandExecutionPolicy: 'sandbox',
        prompt:
          'Run `~/.local/bin/agb status .` and inspect whether an interrupted ADLC run is waiting on quota replenishment. If pool capacity is available, resume cleanly with `~/.local/bin/agb run plan.json --resume` and summarize merged vs remaining tickets.',
      },
      null,
      2
    ) + '\n',
  ],
  [
    'agb-nightshift-distill.json',
    JSON.stringify(
      {
        version: 1,
        id: 'agb-nightshift-distill',
        name: 'AGB Nightshift Defense Distillation & Stale-Rail Audit',
        description: 'Compiles recurring prosecution findings into .adlc/learned-checks.json and audits completed ticket rails.',
        schedule: '0 2 * * 1-5',
        timezone: 'America/Los_Angeles',
        commandExecutionPolicy: 'sandbox',
        prompt:
          'Run `~/.local/bin/agb distill . --compile-checks --json` and `npx adlc ticket doctor`. Report any newly staged ADLC defenses or completed tickets still holding active rails.',
      },
      null,
      2
    ) + '\n',
  ],
  [
    'agb-pr-prosecutor.json',
    JSON.stringify(
      {
        version: 1,
        id: 'agb-pr-prosecutor',
        name: 'AGB Read-Only 5-Lens Branch Prosecutor',
        description: 'Runs read-only 5-lens adversarial code review against active feature branch diffs prior to P6 human review.',
        schedule: '0 */4 * * 1-5',
        timezone: 'UTC',
        commandExecutionPolicy: 'sandbox',
        prompt:
          'If the current branch is ahead of `origin/main`, run `~/.local/bin/agb review . origin/main...HEAD --five-lens` in read-only mode and post a concise P5 verdict summary.',
      },
      null,
      2
    ) + '\n',
  ],
]);

export function runInit({
  repo = process.cwd(),
  cloud = false,
  automations = false,
  force = false,
  withCodegraph = false,
  decisionProvider = null,
  env = process.env,
  codegraphBin = 'codegraph',
} = {}) {
  if (decisionProvider !== null && decisionProvider !== undefined) {
    if (typeof decisionProvider !== 'string' || !DECISION_PROVIDERS.includes(decisionProvider)) {
      throw new Error(
        `Invalid decision provider '${String(decisionProvider)}': expected one of ${DECISION_PROVIDERS.join(', ')}`
      );
    }
  }

  const targetRepo = resolve(repo);
  const realRepo = realpathSync(targetRepo);
  assertNoLegacyTicketStore(realRepo);

  const adlcDir = ensureContainedRepoDir(realRepo, '.adlc');
  const configPath = join(adlcDir, 'config.json');
  assertNoSymlinkFile(configPath);
  let createdConfig = false;
  let updatedConfig = false;
  let config;
  if (!existsSync(configPath)) {
    config = { version: 1, securityMode: 'unsigned-fallback' };
    createdConfig = true;
  } else {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        if (withCodegraph || decisionProvider) {
          return {
            ok: false,
            repo: targetRepo,
            configPath,
            error: `Invalid .adlc/config.json at ${configPath}: expected a JSON object; refusing to overwrite existing configuration`,
          };
        }
        config = { version: 1, securityMode: 'unsigned-fallback' };
      }
    } catch (err) {
      if (withCodegraph || decisionProvider) {
        return {
          ok: false,
          repo: targetRepo,
          configPath,
          error: `Malformed .adlc/config.json at ${configPath}: ${err.message}; refusing to overwrite existing configuration`,
        };
      }
      config = { version: 1, securityMode: 'unsigned-fallback' };
    }
  }

  if (withCodegraph || decisionProvider) {
    if (!config.accelerators || typeof config.accelerators !== 'object' || Array.isArray(config.accelerators)) {
      config.accelerators = {};
    }
    if (withCodegraph && config.accelerators.codegraph !== true) {
      config.accelerators.codegraph = true;
      updatedConfig = true;
    }
    if (decisionProvider) {
      const prevDecision =
        config.accelerators.decision && typeof config.accelerators.decision === 'object' && !Array.isArray(config.accelerators.decision)
          ? config.accelerators.decision
          : {};
      if (prevDecision.enabled !== true || prevDecision.provider !== decisionProvider) {
        config.accelerators.decision = {
          ...prevDecision,
          enabled: true,
          provider: decisionProvider,
        };
        updatedConfig = true;
      }
    }
  }

  if (createdConfig || updatedConfig) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  ensureTicketsDirectoryStore(realRepo, adlcDir);

  const specsDir = ensureContainedRepoDir(realRepo, 'specs');
  const destTemplate = join(specsDir, 'feature-template.md');
  assertNoSymlinkFile(destTemplate);
  let createdTemplate = false;
  if (!existsSync(destTemplate) || force) {
    const srcTemplate = fileURLToPath(new URL('../templates/specs/feature-template.md', import.meta.url));
    copyFileSync(srcTemplate, destTemplate);
    createdTemplate = true;
  }

  const cloudFilesCreated = [];
  const cloudFilesSkipped = [];
  if (cloud) {
    ensureContainedRepoDir(realRepo, '.agents');
    const entries = [
      [['.agents'], 'environment.json', CLOUD_ENVIRONMENT_JSON],
      [['.agents', 'rules'], 'adlc.md', CLOUD_ADLC_RULE_MD],
      [['.agents', 'skills', 'agb-cloud'], 'SKILL.md', CLOUD_SKILL_MD],
      [['.agents', 'agents'], 'prosecutor.md', CLOUD_PROSECUTOR_AGENT_MD],
      [['.agents', 'agents'], 'spec-linter.md', CLOUD_SPEC_LINTER_AGENT_MD],
    ];
    for (const [segs, file, body] of entries) {
      const res = writeContainedCloudFile(realRepo, segs, file, body, { force });
      if (res.created) cloudFilesCreated.push(res.path);
      else cloudFilesSkipped.push(res.path);
    }
  }

  const automationFilesCreated = [];
  const automationFilesSkipped = [];
  if (automations) {
    ensureContainedRepoDir(realRepo, '.agents');
    for (const [file, body] of AUTOMATION_TEMPLATES) {
      const res = writeContainedCloudFile(realRepo, ['.agents', 'automations'], file, body, { force });
      if (res.created) automationFilesCreated.push(res.path);
      else automationFilesSkipped.push(res.path);
    }
  }

  let updatedGitignore = false;
  if (existsSync(join(realRepo, '.git'))) {
    updatedGitignore = Boolean(ensureGitignore(realRepo));
  }

  let codegraphInitialized = false;
  let codegraphWarning = null;
  if (withCodegraph) {
    if (appendCodegraphGitignore(realRepo)) {
      updatedGitignore = true;
    }
    try {
      execFileSync(codegraphBin, ['init'], { cwd: realRepo, env, stdio: 'ignore', timeout: 15_000 });
      codegraphInitialized = true;
    } catch (err) {
      codegraphWarning = err?.code === 'ENOENT'
        ? 'codegraph CLI not installed (skipped `codegraph init`)'
        : (err?.message ?? 'codegraph init failed');
    }
  }

  return {
    ok: true,
    repo: targetRepo,
    configPath,
    createdConfig,
    ...(updatedConfig ? { updatedConfig } : {}),
    templatePath: destTemplate,
    createdTemplate,
    updatedGitignore,
    ...(withCodegraph ? { withCodegraph: true, codegraphInitialized, ...(codegraphWarning ? { codegraphWarning } : {}) } : {}),
    ...(decisionProvider ? { decisionProvider } : {}),
    cloud: Boolean(cloud),
    ...(cloud ? { cloudFilesCreated, cloudFilesSkipped } : {}),
    ...(automations ? { automations: true, automationFilesCreated, automationFilesSkipped } : {}),
  };
}

export async function applyDoctorFixes(opts = {}) {
  const fixesApplied = [];
  const cwd = resolve(opts.cwd ?? process.cwd());
  const realRepo = realpathSync(cwd);
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());

  assertNoLegacyTicketStore(realRepo);

  if (existsSync(join(realRepo, '.git')) || existsSync(join(realRepo, '.adlc'))) {
    const adlcDir = ensureContainedRepoDir(realRepo, '.adlc');
    const configPath = join(adlcDir, 'config.json');
    assertNoSymlinkFile(configPath);
    if (!existsSync(configPath)) {
      writeFileSync(
        configPath,
        JSON.stringify({ version: 1, securityMode: 'unsigned-fallback' }, null, 2) + '\n',
        'utf8'
      );
      fixesApplied.push('Initialized .adlc/config.json (unsigned-fallback)');
    }

    if (ensureTicketsDirectoryStore(realRepo, adlcDir)) {
      fixesApplied.push('Initialized .adlc/tickets directory store');
    }
  }

  if (existsSync(join(realRepo, '.git'))) {
    if (ensureGitignore(realRepo)) {
      fixesApplied.push('Configured .gitignore with .adlc/, .booster/, and .worktrees/ stanzas');
    }
  }

  const pluginEval = evaluateStagedAdlcPlugin({ home });
  if (['not-installed', 'outdated-plugin', 'corrupt-tree'].includes(pluginEval.report)) {
    try {
      const agyBin = env.AGB_AGY_BIN || resolveAgyBinary(home);
      const res = installAdlcAntigravityFromVendor({ home, agyBin });
      if (res.ok) {
        fixesApplied.push(`Repaired companion plugin (${pluginEval.report})`);
      } else if (res.error) {
        console.warn(`[agb doctor] Could not repair companion plugin: ${res.error}`);
      }
    } catch (err) {
      console.warn(`[agb doctor] Could not repair companion plugin: ${err.message}`);
    }
  }

  return fixesApplied;
}

export async function runDoctor(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const fixFindings = [];
  if (opts.fix) {
    try {
      const applied = await applyDoctorFixes({ ...opts, env, home });
      if (applied.length > 0) {
        console.log('Applied Self-Healing Fixes:');
        for (const f of applied) {
          console.log(`  ✔ ${f}`);
        }
        console.log('');
      }
    } catch (err) {
      if (err?.code === 'LEGACY_TICKET_STORE') {
        fixFindings.push({
          name: 'Self-healing (--fix)',
          level: 'fail',
          detail: 'aborted: legacy .adlc/tickets.json store detected (retired)',
          fix: 'Run `adlc ticket store migrate`, remove .adlc/tickets.json, then re-run `agb doctor --fix`.',
        });
      } else {
        throw err;
      }
    }
  }
  const resolvedOpts = { ...opts, home, env };
  const offlineModels = env.AGB_SYNC_MODELS_OFFLINE === '1';
  const modelsPromise = offlineModels ? undefined : agyModelsStdout({ env, home });
  modelsPromise?.catch(() => {});
  const sharedOpts = modelsPromise ? { ...resolvedOpts, modelsPromise } : resolvedOpts;
  const checks = [
    ...fixFindings.map((f) => Promise.resolve(f)),
    checkNodeVersion(resolvedOpts),
    checkAgyBinary(resolvedOpts),
    checkAgyAuth(sharedOpts),
    checkModelCatalog(sharedOpts),
    checkPlugin(resolvedOpts),
    checkAdlcBinary(resolvedOpts),
    checkSandbox(resolvedOpts),
    checkBrainDir(resolvedOpts),
    checkTicketStore(resolvedOpts),
    checkPolicyGuard(resolvedOpts),
    checkSecondaryInstall(resolvedOpts),
    checkKillswitchUsage(resolvedOpts),
    checkProbePlugins(resolvedOpts),
    checkHookLogDir(resolvedOpts),
    checkCodegraph(resolvedOpts),
    checkDecisionEngine(resolvedOpts),
    checkCliSettings(resolvedOpts),
  ];
  
  const results = await Promise.allSettled(checks);
  let failed = false;
  
  console.log('Environment Diagnostic:\n');
  console.log(String().padEnd(25) + ' | ' + String().padEnd(6) + ' | ' + String().padEnd(30) + ' | ' + 'Fix');
  console.log('-'.repeat(25) + '-+-' + '-'.repeat(6) + '-+-' + '-'.repeat(30) + '-+-' + '-'.repeat(30));
  
  for (const res of results) {
    if (res.status === 'rejected') {
      console.log(`Error check failed: ${res.reason}`);
      failed = true;
      continue;
    }
    const c = res.value;
    if (c.level === 'fail') failed = true;
    
    const levelStr = c.level === 'pass' ? 'PASS'
      : c.level === 'info' ? 'INFO'
      : c.level === 'warn' ? 'WARN'
      : 'FAIL';
    console.log(c.name.padEnd(25) + ' | ' + levelStr.padEnd(6) + ' | ' + c.detail.padEnd(30) + ' | ' + (c.fix || ''));
  }
  console.log('');
  return failed ? 1 : 0;
}
