import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { readPluginContract, detectTicketStoreBackend, resolveAdlcBinary, MIN_ADLC_CLI_VERSION, semverGte } from './adlc-bridge.mjs';
import { resolvePluginPath } from './bootstrap.mjs';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, writeSync, fsyncSync, realpathSync, mkdirSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import net from 'net';

const execFileAsync = promisify(execFile);

export async function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 18) {
    return { name: 'Node.js', level: 'pass', detail: version, fix: null };
  }
  return { name: 'Node.js', level: 'fail', detail: version, fix: 'Upgrade Node.js to v18 or newer.' };
}

export const MIN_AGY_VERSION = '1.2.6';

export async function checkAgyBinary({ env = process.env } = {}) {
  try {
    const { stdout } = await execFileAsync(env.AGB_AGY_BIN || 'agy', ['--version'], { env, timeout: 5000 });
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
        detail: `${rawOut} (required >= v${MIN_AGY_VERSION})`,
        fix: `Upgrade agy to >= ${MIN_AGY_VERSION} to support --output-format stream-json.`,
      };
    }
    let v = rawOut;
    if (!v.startsWith('v')) v = 'v' + v;
    return { name: 'agy CLI', level: 'pass', detail: v, fix: null };
  } catch (err) {
    return { name: 'agy CLI', level: 'fail', detail: 'not found or error', fix: 'Install Google Antigravity CLI and ensure it is on PATH.' };
  }
}

export async function checkAgyAuth({ env = process.env } = {}) {
  try {
    let cmd = env.AGB_AGY_BIN || 'agy';
    let args = ['models'];
    if (process.platform === 'linux') {
      args = ['-q', '-e', '-c', `${cmd} models`, '/dev/null'];
      cmd = 'script';
    } else if (process.platform === 'darwin') {
      args = ['-q', '/dev/null', cmd, 'models'];
      cmd = 'script';
    }
    const { stdout } = await execFileAsync(cmd, args, { env, timeout: 15000 });
    if (stdout.trim().length > 0) {
      return { name: 'agy Auth', level: 'pass', detail: 'authenticated', fix: null };
    }
    return { name: 'agy Auth', level: 'fail', detail: 'no models returned', fix: 'Run `agy login` to authenticate.' };
  } catch (err) {
    return { name: 'agy Auth', level: 'fail', detail: 'error fetching models', fix: 'Run `agy login` to authenticate.' };
  }
}

export async function checkPlugin({ env = process.env } = {}) {
  try {
    const pluginPath = resolvePluginPath();
    if (!pluginPath) throw new Error('not found');
    const contract = readPluginContract({ dir: pluginPath });
    if (contract.status === 'missing-field') {
      return { name: 'adlc-antigravity plugin', level: 'warn', detail: 'installed (legacy version)', fix: 'Upgrade @adlc/antigravity to enable live rail enforcement.' };
    }
    if (contract.status === 'incompatible') {
      return { name: 'adlc-antigravity plugin', level: 'fail', detail: `unsupported contract v${contract.contract}`, fix: 'Install a compatible version of @adlc/antigravity.' };
    }
    if (contract.status === 'unreadable') {
      throw new Error(contract.error || 'unreadable manifest');
    }
    return { name: 'adlc-antigravity plugin', level: 'pass', detail: 'installed and compatible', fix: null };
  } catch (err) {
    return { name: 'adlc-antigravity plugin', level: 'fail', detail: 'not found', fix: 'Run `npx agb bootstrap` to install the plugin.' };
  }
}

export async function checkAdlcBinary({ env = process.env, cwd = process.cwd() } = {}) {
  const localPkgDir = join(cwd, 'node_modules', '@adlc', 'cli');
  const localBin = join(cwd, 'node_modules', '.bin', 'adlc');
  const allowCustom = env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';
  const resolved = resolveAdlcBinary({ repo: cwd, env, allowCustom });

  let bin = resolved.ok ? resolved.binary : null;
  if (!bin && env.AGB_ADLC_BIN && allowCustom) {
    bin = env.AGB_ADLC_BIN;
  }

  if (!bin) {
    if (existsSync(localPkgDir) || existsSync(localBin) || (env.AGB_ADLC_BIN && !allowCustom)) {
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
      detail: 'not found (will be installed by bootstrap)',
      fix: 'Run `npm install @adlc/cli` or `npx agb bootstrap`.',
    };
  }
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { env, timeout: 5000 });
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
    if (resolved.version) {
      const rawV = resolved.version.replace(/^v/, '');
      const v = 'v' + rawV;
      if (!semverGte(rawV, MIN_ADLC_CLI_VERSION)) {
        return {
          name: 'adlc CLI',
          level: 'fail',
          detail: `${v} (required >= v${MIN_ADLC_CLI_VERSION})`,
          fix: `Upgrade @adlc/cli to >= ${MIN_ADLC_CLI_VERSION}.`,
        };
      }
      return { name: 'adlc CLI', level: 'pass', detail: `${v} (manifest)`, fix: null };
    }
    return { name: 'adlc CLI', level: 'warn', detail: 'not found', fix: 'adlc CLI is optional but recommended. Install it if you want local ADLC gate execution.' };
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
  homeDir = env.AGB_HOME_DIR || homedir(),
} = {}) {
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
  if (att.repositoryPath !== canonicalRepo) {
    return { valid: false, reason: `cross_repository_attestation_rejected: ${att.repositoryPath} !== ${canonicalRepo}` };
  }

  try {
    const rootCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd: repo, encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (rootCommit && att.repositoryRootCommit !== rootCommit) {
      return { valid: false, reason: `root_commit_mismatch: ${att.repositoryRootCommit} !== ${rootCommit}` };
    }
  } catch (err) {
    return { valid: false, reason: `failed to query git root commit: ${err.message}` };
  }

  try {
    const originUrl = execSync('git config --get remote.origin.url', { cwd: repo, encoding: 'utf8' }).trim();
    if (originUrl && att.repositoryOrigin !== originUrl) {
      return { valid: false, reason: `repository_origin_mismatch: ${att.repositoryOrigin} !== ${originUrl}` };
    }
  } catch {}

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

  const checkNonce = (filePath) => {
    if (!existsSync(filePath)) return false;
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.nonce === att.nonce) return true;
      } catch {}
    }
    return false;
  };

  if (checkNonce(repoLedger) || checkNonce(hostLedger)) {
    return { valid: false, reason: 'replayed_attestation_rejected' };
  }

  // Atomically reserve the nonce via exclusive file creation (O_CREAT | O_EXCL)
  // to prevent race conditions between concurrent attestation checks
  const safeNonce = String(att.nonce).replace(/[^a-zA-Z0-9_-]/g, '_');
  const reserveNonceAtomic = (baseDir) => {
    const noncesDir = join(baseDir, '.adlc', 'nonces');
    mkdirSync(noncesDir, { recursive: true, mode: 0o700 });
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

  const repoRes = reserveNonceAtomic(repo);
  if (!repoRes.ok) return { valid: false, reason: repoRes.reason };
  const hostRes = reserveNonceAtomic(homeDir);
  if (!hostRes.ok) return { valid: false, reason: hostRes.reason };

  const record = JSON.stringify({ nonce: att.nonce, runId: att.runId, consumedAt: new Date().toISOString() }) + '\n';
  const appendLedger = (filePath) => {
    mkdirSync(dirname(filePath), { recursive: true });
    const fd = openSync(filePath, 'a', 0o600);
    writeSync(fd, record);
    fsyncSync(fd);
    closeSync(fd);
  };
  try {
    appendLedger(repoLedger);
    appendLedger(hostLedger);
  } catch (err) {
    return { valid: false, reason: `failed to record consumed nonce: ${err.message}` };
  }

  return { valid: true, attestation: att };
}

/**
 * Active differential sandbox verification on Windows (AppContainer probe).
 */
export async function verifyWindowsSandboxActive({ cwd = process.cwd(), env = process.env } = {}) {
  const canaryPath = env.AGB_MOCK_WIN_CANARY || join(env.LOCALAPPDATA || tmpdir(), `agb_canary_${crypto.randomUUID()}.tmp`);
  const nonce = crypto.randomUUID();
  const worktreeDir = join(cwd, '.worktrees');
  mkdirSync(worktreeDir, { recursive: true });
  const worktreeCanary = join(worktreeDir, `sandbox_canary_${crypto.randomUUID()}.tmp`);

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

    const probeHelper = env.AGB_SANDBOX_PROBE_HELPER || join(dirname(fileURLToPath(import.meta.url)), 'sandbox-probe-helper.mjs');
    let probeStdout = '';
    let probeStderr = '';

    if (env.AGB_SANDBOX_PROBE_CMD) {
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
    try { if (existsSync(canaryPath)) rmSync(canaryPath, { force: true }); } catch {}
    try { if (existsSync(worktreeCanary)) rmSync(worktreeCanary, { force: true }); } catch {}
  }
}

export async function checkSandbox({ env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  if (env.AGB_SANDBOX_GATES === '0') {
    return { name: 'Sandbox', level: 'pass', detail: 'bypassed via env', fix: null };
  }
  if (platform === 'darwin') {
    try {
      await execFileAsync('which', ['sandbox-exec'], { env, timeout: 5000 });
      return { name: 'Sandbox', level: 'pass', detail: 'sandbox-exec available', fix: null };
    } catch (err) {
      return { name: 'Sandbox', level: 'fail', detail: 'sandbox-exec missing', fix: 'macOS sandbox-exec is missing. Set AGB_SANDBOX_GATES=0 to bypass.' };
    }
  }
  if (platform === 'linux') {
    try {
      await execFileAsync('which', ['bwrap'], { env, timeout: 5000 });
      return { name: 'Sandbox', level: 'pass', detail: 'bwrap available', fix: null };
    } catch (err) {
      return { name: 'Sandbox', level: 'fail', detail: 'bwrap missing', fix: 'Linux bubblewrap (bwrap) is missing. apt install bubblewrap or set AGB_SANDBOX_GATES=0 to bypass.' };
    }
  }
  if (platform === 'win32') {
    const configPath = join(cwd, '.adlc', 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        if (config.sandboxBypassAttestation) {
          const attRes = verifyWindowsSandboxAttestation({ repo: cwd, env, platform, cwd });
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

export async function checkBrainDir({ env = process.env } = {}) {
  const dir = env.AGB_BRAIN_DIR || join(homedir(), '.gemini/antigravity/brain');
  if (existsSync(dir)) {
    return { name: 'Brain Dir', level: 'pass', detail: 'exists', fix: null };
  }
  return { name: 'Brain Dir', level: 'warn', detail: 'not found', fix: 'Run an agy session to initialize the brain directory.' };
}

export async function checkTicketStore({ cwd = process.cwd(), env = process.env, repo = cwd } = {}) {
  const backend = detectTicketStoreBackend(cwd);
  if (backend === 'both') {
    return {
      name: 'Ticket Store', level: 'fail', detail: 'both legacy and directory stores',
      fix: 'The plugin fails closed when both exist. Run `adlc ticket store migrate` (or remove .adlc/tickets.json).',
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

  const allowCustom = env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';
  const resolved = resolveAdlcBinary({ repo: cwd, env, allowCustom });
  const fallbackResolved = !resolved.ok && repo !== cwd ? resolveAdlcBinary({ repo, env, allowCustom }) : null;
  const activeResolved = resolved.ok ? resolved : (fallbackResolved?.ok ? fallbackResolved : null);
  const bin = activeResolved ? activeResolved.binary : (allowCustom && env.AGB_ADLC_BIN ? env.AGB_ADLC_BIN : null);

  if (bin) {
    let doctorOutput;
    try {
      const { stdout } = await execFileAsync(bin, ['ticket', 'doctor', '--json'], { cwd, env, timeout: 10000 });
      doctorOutput = stdout;
    } catch (err) {
      if (err.stdout) {
        doctorOutput = err.stdout;
      } else if (err.code !== 'ENOENT' && err.code !== 127) {
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
        if (!parsed.ok || parsed.exitCode !== 0) {
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
  }

  const detail = `${backend} backend`;
  return { name: 'Ticket Store', level: 'pass', detail, fix: null };
}

export async function runDoctor(opts = {}) {
  const checks = [
    checkNodeVersion(),
    checkAgyBinary(opts),
    checkAgyAuth(opts),
    checkPlugin(opts),
    checkAdlcBinary(opts),
    checkSandbox(opts),
    checkBrainDir(opts),
    checkTicketStore(opts)
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
    
    const levelStr = c.level === 'pass' ? 'PASS' : c.level === 'warn' ? 'WARN' : 'FAIL';
    console.log(c.name.padEnd(25) + ' | ' + levelStr.padEnd(6) + ' | ' + c.detail.padEnd(30) + ' | ' + (c.fix || ''));
  }
  console.log('');
  return failed ? 2 : 0;
}
