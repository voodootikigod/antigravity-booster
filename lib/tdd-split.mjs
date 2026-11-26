// Cross-Pool Adversarial TDD Split: Spec-Test Author vs. Implementation Builder (v1.4 Pillar 4).
//
// Automatically activates on `frontier`-tier tickets (and any ticket with `tdd_split: true`)
// whose scope contains both implementation paths and `test/**` paths.
// Dispatches a Spec-Test Author on the opposite quota pool to commit black-box contract
// tests that fail against `base` (anti-tautology red-phase verification), then promotes
// those test files into the Implementation Builder's frozen `rails`.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { gateSandboxAvailable, linuxBwrapArgs, sandboxProfile } from './gates.mjs';
import { familyOf } from './models.mjs';

function isTestPathspec(pathspec) {
  const norm = String(pathspec || '').replace(/\\/g, '/').trim();
  return (
    norm === 'test' ||
    norm.startsWith('test/') ||
    norm.endsWith('.test.mjs') ||
    norm.endsWith('.test.js') ||
    norm.endsWith('.test.ts')
  );
}

/**
 * Determine whether a ticket should execute the Cross-Pool Adversarial TDD Split.
 * Default-on for `frontier` tickets (and any ticket with `tdd_split === true`)
 * whose scope includes both `test/**` paths and implementation paths.
 */
export function shouldRunTddSplit(ticket = {}, plan = {}) {
  if (!ticket || typeof ticket !== 'object') return false;
  if (ticket.tdd_split === false || plan?.tddSplit === false) return false;

  const tier = String(ticket.tier || 'mid').trim().toLowerCase();
  const enabled = ticket.tdd_split === true || tier === 'frontier';
  if (!enabled) return false;

  const scope = Array.isArray(ticket.scope) ? ticket.scope : [];
  const hasTest = scope.some(isTestPathspec);
  const hasImpl = scope.some((p) => !isTestPathspec(p));
  return hasTest && hasImpl;
}

/**
 * Select the opposite quota pool (`'claude-gpt'` vs `'gemini'`) so the Spec-Test Author
 * runs on an independent model family and quota bucket from the Implementation Builder.
 */
export function selectOppositePoolHint(poolHint = 'auto', builderModelSlug = '') {
  if (builderModelSlug && typeof builderModelSlug === 'string') {
    try {
      const fam = familyOf(builderModelSlug);
      return fam === 'gemini' ? 'claude-gpt' : 'gemini';
    } catch {}
  }
  const normalizedHint = String(poolHint || 'auto').trim().toLowerCase();
  if (normalizedHint === 'gemini') return 'claude-gpt';
  if (
    normalizedHint === 'claude' ||
    normalizedHint === 'claude-gpt' ||
    normalizedHint === 'gpt-oss'
  ) {
    return 'gemini';
  }
  return 'claude-gpt';
}

/**
 * Partition a ticket's scope into Spec-Test Author and Implementation Builder contracts.
 */
export function partitionTddScopes(ticket = {}, { builderModel = '' } = {}) {
  const scope = Array.isArray(ticket.scope) ? ticket.scope : [];
  const baseRails = Array.isArray(ticket.rails) ? ticket.rails : [];

  const testScope = scope.filter(isTestPathspec);
  const implScope = scope.filter((p) => !isTestPathspec(p));
  const specPoolHint = selectOppositePoolHint(ticket.pool_hint, builderModel);

  const specAuthorSubTicket = {
    ...ticket,
    id: `${ticket.id}--spec-tests`,
    title: `[Spec-Test Author] ${ticket.title || ticket.id}`,
    scope: testScope,
    rails: [...new Set([...baseRails, ...implScope])],
    pool_hint: specPoolHint,
    body: [
      `## Adversarial TDD Phase 1: Black-Box Spec-Test Author (${ticket.id})`,
      'Write deterministic black-box contract tests in `test/**` encoding every acceptance criterion below.',
      'Implementation paths are FROZEN RAILS during this phase — do NOT create or edit implementation files.',
      'Your tests MUST parse cleanly (`node --check`) and fail against the unimplemented baseline.',
      '',
      ticket.body || '',
    ].join('\n'),
  };

  return {
    testScope,
    implScope,
    specPoolHint,
    specAuthorSubTicket,
  };
}

/**
 * Promote committed spec-test files into the Implementation Builder's frozen `rails`.
 */
export function promoteTestsToBuilderRails(ticket = {}, committedTestFiles = []) {
  const baseRails = Array.isArray(ticket.rails) ? ticket.rails : [];
  const validTests = (committedTestFiles || [])
    .map((f) => String(f || '').replace(/\\/g, '/').trim())
    .filter((f) => f && isTestPathspec(f));

  return {
    ...ticket,
    rails: [...new Set([...baseRails, ...validTests])],
  };
}

/**
 * Verify that the Spec-Test Author's committed tests:
 *   1. Exist and pass `node --check` syntax validation.
 *   2. Fail (`exitCode !== 0`) against the unimplemented baseline worktree (anti-tautology check).
 * If tests are missing, syntactically invalid, or tautologically pass on unimplemented base,
 * returns `{ ok: false, reason }` so the caller discards the spec-test commit and degrades
 * cleanly to standard single-builder execution.
 */
export function verifyRedPhaseTests(
  testFiles = [],
  {
    worktree = process.cwd(),
    timeoutMs = 30_000,
    env = process.env,
    platform = process.platform,
    spawnFn = spawnSync,
    sandboxAvailableFn = gateSandboxAvailable,
  } = {}
) {
  const wtRoot = resolve(worktree);
  let realWtRoot;
  try {
    if (!statSync(wtRoot).isDirectory()) throw new Error('not a directory');
    realWtRoot = realpathSync(wtRoot);
  } catch {
    return { ok: false, reason: `red-phase worktree is not a directory: ${worktree}` };
  }
  const cleanFiles = (testFiles || [])
    .map((f) => String(f || '').replace(/\\/g, '/').trim())
    .filter((f) => f && isTestPathspec(f));

  if (cleanFiles.length === 0) {
    return { ok: false, reason: 'spec-test author committed no test files' };
  }

  const childEnv = sanitizeRedPhaseEnv(env, platform);
  const snapshots = new Map();
  for (const rel of cleanFiles) {
    if (/[\0\r\n]/.test(rel)) return { ok: false, reason: 'invalid control characters in test path' };
    if (isAbsolute(rel)) return { ok: false, reason: `absolute test path rejected: ${rel}` };
    if (rel.split('/').includes('..')) return { ok: false, reason: `test path traversal rejected: ${rel}` };
    const full = join(realWtRoot, rel);
    let realFull;
    try {
      if (lstatSync(full).isSymbolicLink()) {
        return { ok: false, reason: `symlinked test file rejected: ${rel}` };
      }
      realFull = realpathSync(full);
    } catch {
      return { ok: false, reason: `committed test file missing: ${rel}` };
    }
    if (!realFull.startsWith(realWtRoot + sep)) {
      return { ok: false, reason: `test file escapes worktree: ${rel}` };
    }
    const chk = spawnFn(process.execPath, ['--check', full], {
      cwd: realWtRoot,
      env: childEnv,
      timeout: 10_000,
      encoding: 'utf8',
    });
    if (chk.status !== 0) {
      return { ok: false, reason: `spec-test syntax error in ${rel}: ${chk.stderr ?? chk.error?.message ?? ''}` };
    }
    snapshots.set(full, readFileSync(full));
  }

  const gitBefore = gitStatus(realWtRoot, childEnv);
  let res;
  let mutated = false;
  try {
    res = runSandboxed(spawnFn, sandboxAvailableFn, {
      platform,
      env,
      root: realWtRoot,
      files: cleanFiles,
      childEnv,
      timeoutMs,
    });
  } finally {
    for (const [full, bytes] of snapshots) {
      let cur = null;
      try {
        cur = readFileSync(full);
      } catch {}
      if (!cur || !cur.equals(bytes)) {
        mutated = true;
        try {
          writeFileSync(full, bytes);
        } catch {}
      }
    }
  }
  if (res.unavailable) return { ok: false, reason: res.unavailable };
  if (mutated || gitStatus(realWtRoot, childEnv) !== gitBefore) {
    return { ok: false, reason: 'spec-test red-phase mutated worktree files during verification' };
  }

  if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM' || res.signal === 'SIGKILL') {
    return { ok: false, reason: 'spec-test red-phase verification timed out' };
  }
  if (res.status === 0) {
    return {
      ok: false,
      reason: 'tautological spec tests: tests passed on unimplemented base (red-phase failure required)',
    };
  }
  const out = res.stdout ?? '';
  if (!/^TAP version \d+/m.test(out) || !/^not ok \d+/m.test(out)) {
    return { ok: false, reason: 'spec-test red-phase runner failed to start or produced no failing TAP result' };
  }
  return { ok: true, verifiedFiles: cleanFiles, exitCode: res.status ?? 1 };
}

const POSIX_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'TEMP', 'TMP'];
const WIN_ENV_KEYS = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'];

export function sanitizeRedPhaseEnv(env = process.env, platform = process.platform) {
  const keys = platform === 'win32' ? [...POSIX_ENV_KEYS, ...WIN_ENV_KEYS] : POSIX_ENV_KEYS;
  const out = {};
  for (const k of keys) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  out.NODE_ENV = 'test';
  return out;
}

const MAX_BUFFER = 8 * 1024 * 1024;

function gitStatus(cwd, env) {
  if (!existsSync(join(cwd, '.git'))) return null;
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, env, encoding: 'utf8' });
  return `${r.status}:${r.stdout ?? ''}`;
}

function runSandboxed(spawnFn, sandboxAvailableFn, { platform, env, root, files, childEnv, timeoutMs }) {
  const opts = { cwd: root, env: childEnv, timeout: timeoutMs, encoding: 'utf8', maxBuffer: MAX_BUFFER };
  const testArgs = ['--test', '--test-reporter=tap', ...files];
  if (env.AGB_SANDBOX_GATES === '0') return spawnFn(process.execPath, testArgs, opts);
  if ((platform !== 'darwin' && platform !== 'linux') || !sandboxAvailableFn(env)) {
    return {
      unavailable: `spec-test red-phase sandbox unavailable on ${platform} (set AGB_SANDBOX_GATES=0 only in disposable containers)`,
    };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agb-red-sbx-'));
  if (platform === 'darwin') {
    try {
      const profileFile = join(tmp, 'profile.sb');
      writeFileSync(profileFile, sandboxProfile(root));
      return spawnFn('sandbox-exec', ['-f', profileFile, process.execPath, ...testArgs], opts);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const mounts = ['.git', 'node_modules'].map((n) => join(root, n));
  const preexisting = mounts.map((p) => existsSync(p));
  try {
    const cmd = [process.execPath, ...testArgs]
      .map((s) => "'" + String(s).replace(/'/g, "'\\''") + "'")
      .join(' ');
    return spawnFn('bwrap', linuxBwrapArgs(root, cmd, tmp), opts);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    mounts.forEach((p, i) => {
      if (preexisting[i]) return;
      try {
        rmdirSync(p);
      } catch {}
    });
  }
}
