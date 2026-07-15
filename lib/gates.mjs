// Deterministic gates. A gate is a shell command whose exit code is the
// verdict — no model involved (ADLC Principle 1).
//
// SECURITY (adversarial-review CRITICAL): gate commands run a script that
// lives in the builder's worktree (e.g. package.json "test"). A malicious
// builder — even one sandboxed during the build — can rewrite that script,
// so executing it unsandboxed on the host is a sandbox escape. Gates
// therefore run under macOS `sandbox-exec` by default: writes restricted to
// the worktree + temp, network denied. Disable with AGB_SANDBOX_GATES=0
// (e.g. when a gate legitimately needs network or a global cache write).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

// Seatbelt matches CANONICAL paths. On macOS /var, /tmp → /private/var,
// /private/tmp, so a profile built from a symlinked path silently fails to
// match. Resolve to the real path (best effort — keep the input if it does
// not exist yet, e.g. in pure unit tests).
function canonical(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * SBPL profile: allow most, deny network, allow writes only under cwd+temp,
 * then DENY writes to the repo's .git directory. Seatbelt applies the
 * last-matching rule, so the trailing .git deny overrides the cwd allow — a
 * gate script cannot plant a hook in .git/hooks or rewrite .git/config to get
 * unsandboxed execution on the next host git command (round-5 CRITICAL).
 */
export function sandboxProfile(cwd) {
  const realCwd = canonical(cwd);
  const writable = [realCwd, '/private/tmp', '/tmp', canonical(tmpdir()), '/dev/null', '/dev/stdout', '/dev/stderr', '/private/var/folders'];
  const subpaths = writable.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ');
  // Deny writes to paths that (a) survive a `git reset --hard` rollback
  // because they are gitignored, and (b) are executed unsandboxed later —
  // .git (hooks/config) and node_modules (dependency code run by `node`).
  // Tests READ node_modules (allowed via `allow default`); they never need to
  // write it. Closes the persistence-after-revert escape.
  const denied = [join(realCwd, '.git'), join(realCwd, 'node_modules')]
    .map((p) => `(deny file-write* (subpath ${JSON.stringify(p)}))`)
    .join('\n');
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* ${subpaths})
${denied}`;
}

/**
 * Bubblewrap profile: allow most as read-only, deny network, allow writes only under cwd+temp,
 * then DENY writes to the repo's .git directory. Bubblewrap overrides the earlier mounts.
 */
export function linuxBwrapArgs(cwd, cmd) {
  const realCwd = canonical(cwd);
  const temp = canonical(tmpdir());
  const args = [
    '--unshare-net',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', '/tmp', '/tmp'
  ];
  if (temp !== '/tmp' && temp !== '/private/tmp') args.push('--bind', temp, temp);
  
  args.push('--bind', realCwd, realCwd);
  args.push('--ro-bind-try', join(realCwd, '.git'), join(realCwd, '.git'));
  args.push('--ro-bind-try', join(realCwd, 'node_modules'), join(realCwd, 'node_modules'));
  args.push('--', '/bin/sh', '-c', cmd);
  return args;
}

/**
 * Whether sandbox-exec or bwrap is available on this host. Sandboxing is macOS (Seatbelt)
 * or Linux (bubblewrap).
 */
export function gateSandboxAvailable() {
  return platform() === 'darwin' || platform() === 'linux';
}

/** Back-compat: enabled = available and not explicitly disabled. */
export function gateSandboxEnabled(env = process.env) {
  if (env.AGB_SANDBOX_GATES === '0') return false;
  return gateSandboxAvailable();
}

/**
 * Run one gate command. Returns { name, cmd, ok, output, sandboxed }.
 *
 * SECURITY: when sandboxing is requested but unavailable on this platform,
 * we FAIL CLOSED — the gate returns ok:false rather than silently running an
 * untrusted worktree script with full host privileges (the round-3 CRITICAL:
 * a Linux CI host would otherwise execute a rewritten test script unsandboxed).
 * Acknowledge the risk explicitly with AGB_SANDBOX_GATES=0 to run unsandboxed
 * (e.g. in a disposable CI container that is itself the isolation boundary).
 */
export async function runGate(name, cmd, cwd, { timeoutMs = 600_000, sandbox = false, env = process.env } = {}) {
  let profileFile;
  // argv form (no shell) — keeps the gate string out of a shell on the host;
  // the inner `/bin/sh -c <cmd>` only runs inside sandbox-exec when sandboxed.
  let argv = ['/bin/sh', ['-c', cmd]];
  const explicitlyDisabled = env.AGB_SANDBOX_GATES === '0';
  if (sandbox && !gateSandboxAvailable() && !explicitlyDisabled) {
    return {
      name, cmd, ok: false, sandboxed: false,
      output: `gate refused: sandboxing requested but unavailable on ${platform()} ` +
        `(sandbox-exec on macOS, bwrap on Linux). Running an untrusted worktree gate script unsandboxed ` +
        `is a host-RCE risk. Run inside a disposable container and set AGB_SANDBOX_GATES=0 to proceed.`,
    };
  }
  const sandboxed = sandbox && gateSandboxEnabled(env);
  if (sandboxed) {
    if (platform() === 'darwin') {
      const dir = mkdtempSync(join(tmpdir(), 'agb-sbpl-'));
      profileFile = join(dir, 'gate.sb');
      writeFileSync(profileFile, sandboxProfile(cwd));
      argv = ['sandbox-exec', ['-f', profileFile, '/bin/sh', '-c', cmd]];
    } else if (platform() === 'linux') {
      argv = ['bwrap', linuxBwrapArgs(cwd, cmd)];
    }
  }
  try {
    // Async exec: does NOT block the event loop, so concurrent gates and live
    // agy streams in other tickets keep progressing (throughput — gates were
    // previously execSync and serialized all parallelism).
    const spawnEnv = env === process.env ? process.env : { ...process.env, ...env };
    const { stdout } = await execFileP(argv[0], argv[1], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: spawnEnv });
    return { name, cmd, ok: true, output: stdout.slice(-2000), sandboxed };
  } catch (err) {
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.slice(-2000);
    if (sandboxed && platform() === 'linux' && (output.includes('unprivileged user namespaces') || output.includes('No space left on device') || output.includes('Clone failed'))) {
      return {
        name, cmd, ok: false, sandboxed,
        output: output + '\n\nbwrap execution failed. Your Linux distribution might restrict unprivileged user namespaces. ' +
                         'To fix this, you can enable them (e.g. `sudo sysctl kernel.unprivileged_userns_clone=1`) ' +
                         'or disable the sandbox entirely by setting AGB_SANDBOX_GATES=0.'
      };
    }
    return { name, cmd, ok: false, output, sandboxed };
  } finally {
    if (profileFile) rmSync(join(profileFile, '..'), { recursive: true, force: true });
  }
}

/**
 * Run the gate set ({ build: cmd, test: cmd, ... }) in order, stopping at
 * the first failure. Returns { ok, results }.
 * opts.sandbox runs each gate under sandbox-exec (worktree gates); leave
 * false for post-merge gates on the trusted main checkout.
 */
export async function runGates(gates, cwd, { sandbox = false, env = process.env } = {}) {
  const results = [];
  for (const [name, cmd] of Object.entries(gates ?? {})) {
    if (!cmd) continue;
    const r = await runGate(name, cmd, cwd, { sandbox, env });
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}
