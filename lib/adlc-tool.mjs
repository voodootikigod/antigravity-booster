// Shared executor for ADLC CLI tools across call sites (#20).
// Encapsulates authenticated binary invocation, timeout/buffer configuration,
// and exit-2 gate-failure JSON recovery.

import { execFileAuthenticatedAdlc } from './adlc-bridge.mjs';

/**
 * Execute an adlc tool subcommand with authenticated binary verification and JSON parsing.
 *
 * @param {object} options
 * @param {string} options.tool - The adlc subcommand to invoke (e.g. 'model-router', 'merge-forecast')
 * @param {string[]} [options.args=[]] - Additional CLI arguments
 * @param {string} [options.cwd] - Working directory for the child process
 * @param {number} [options.timeoutMs=30000] - Execution timeout in milliseconds
 * @param {number} [options.maxBuffer=10485760] - Max stdout/stderr buffer (defaults to 10MB)
 * @param {string} [options.adlcBin] - Explicit adlc binary path candidate
 * @param {string} [options.repo] - Target repository root for authentication (defaults to cwd)
 * @returns {Promise<{ ok: boolean, exitCode: number, parsed?: any, stdout: string, error?: string, unparseable?: boolean }>}
 */
export async function runAdlcTool({
  tool,
  args = [],
  cwd,
  timeoutMs = 30_000,
  maxBuffer = 10 * 1024 * 1024,
  adlcBin,
  repo,
} = {}) {
  let res;
  try {
    res = await execFileAuthenticatedAdlc(
      adlcBin,
      [tool, ...args],
      { cwd, timeout: timeoutMs, maxBuffer },
      { repo: repo ?? cwd },
    );
  } catch (err) {
    if (err?.stdout && !err.killed && !err.signal && Number.isInteger(err.code)) {
      try {
        const parsed = JSON.parse(err.stdout);
        return {
          ok: true,
          exitCode: err.code ?? 2,
          parsed,
          stdout: err.stdout,
        };
      } catch {
        // err.stdout is present but unparseable JSON — fall through to operational failure
      }
    }
    return {
      ok: false,
      exitCode: err?.code ?? 1,
      error: err?.message ?? String(err),
      unparseable: Boolean(err?.stdout),
      stdout: err?.stdout ?? '',
    };
  }

  const stdout = res?.stdout ?? '';
  try {
    const parsed = JSON.parse(stdout);
    return {
      ok: true,
      exitCode: 0,
      parsed,
      stdout,
    };
  } catch (parseErr) {
    return {
      ok: false,
      exitCode: 0,
      error: 'unparseable ' + tool + ' output: ' + parseErr.message,
      unparseable: true,
      stdout,
    };
  }
}
