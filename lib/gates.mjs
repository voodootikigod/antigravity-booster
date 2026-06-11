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

import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

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
 * Whether sandbox-exec is available on this host. Sandboxing is macOS-only
 * (Seatbelt); there is no built-in equivalent on Linux/Windows.
 */
export function gateSandboxAvailable() {
  return platform() === 'darwin';
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
export function runGate(name, cmd, cwd, { timeoutMs = 600_000, sandbox = false, env = process.env } = {}) {
  let profileFile;
  let runCmd = cmd;
  const explicitlyDisabled = env.AGB_SANDBOX_GATES === '0';
  if (sandbox && !gateSandboxAvailable() && !explicitlyDisabled) {
    return {
      name, cmd, ok: false, sandboxed: false,
      output: `gate refused: sandboxing requested but unavailable on ${platform()} ` +
        `(sandbox-exec is macOS-only). Running an untrusted worktree gate script unsandboxed ` +
        `is a host-RCE risk. Run inside a disposable container and set AGB_SANDBOX_GATES=0 to proceed.`,
    };
  }
  const sandboxed = sandbox && gateSandboxEnabled(env);
  if (sandboxed) {
    const dir = mkdtempSync(join(tmpdir(), 'agb-sbpl-'));
    profileFile = join(dir, 'gate.sb');
    writeFileSync(profileFile, sandboxProfile(cwd));
    // sandbox-exec runs the command; the inner sh -c carries the gate verbatim.
    runCmd = `sandbox-exec -f ${JSON.stringify(profileFile)} /bin/sh -c ${JSON.stringify(cmd)}`;
  }
  try {
    const output = execSync(runCmd, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { name, cmd, ok: true, output: output.slice(-2000), sandboxed };
  } catch (err) {
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.slice(-2000);
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
export function runGates(gates, cwd, { sandbox = false } = {}) {
  const results = [];
  for (const [name, cmd] of Object.entries(gates ?? {})) {
    if (!cmd) continue;
    const r = runGate(name, cmd, cwd, { sandbox });
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}
