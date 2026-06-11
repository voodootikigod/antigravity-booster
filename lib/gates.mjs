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
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

/** SBPL profile: allow most, deny network, allow writes only under cwd+temp. */
export function sandboxProfile(cwd) {
  const writable = [cwd, '/private/tmp', '/tmp', tmpdir(), '/dev/null', '/dev/stdout', '/dev/stderr', '/private/var/folders'];
  const subpaths = writable.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ');
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* ${subpaths})`;
}

/** Whether gate sandboxing is available and enabled for this run. */
export function gateSandboxEnabled(env = process.env) {
  if (env.AGB_SANDBOX_GATES === '0') return false;
  return platform() === 'darwin';
}

/** Run one gate command. Returns { name, cmd, ok, output, sandboxed }. */
export function runGate(name, cmd, cwd, { timeoutMs = 600_000, sandbox = false } = {}) {
  let profileFile;
  let runCmd = cmd;
  const sandboxed = sandbox && gateSandboxEnabled();
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
