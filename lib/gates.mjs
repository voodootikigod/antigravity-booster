// Deterministic gates. A gate is a shell command whose exit code is the
// verdict — no model involved (ADLC Principle 1).

import { execSync } from 'node:child_process';

/** Run one gate command. Returns { name, cmd, ok, output }. */
export function runGate(name, cmd, cwd, { timeoutMs = 600_000 } = {}) {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { name, cmd, ok: true, output: output.slice(-2000) };
  } catch (err) {
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.slice(-2000);
    return { name, cmd, ok: false, output };
  }
}

/**
 * Run the gate set ({ build: cmd, test: cmd, ... }) in order, stopping at
 * the first failure. Returns { ok, results }.
 */
export function runGates(gates, cwd) {
  const results = [];
  for (const [name, cmd] of Object.entries(gates ?? {})) {
    if (!cmd) continue;
    const r = runGate(name, cmd, cwd);
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}
