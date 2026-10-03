// Probe helper for Windows AppContainer active differential sandbox verification.
// Executed inside child sandbox environment by checkSandbox() in lib/doctor.mjs.
// Emits structured JSON result reporting OS syscall and socket error codes.

import { openSync, closeSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Executes the 3 differential probe actions:
 * 1. File containment: attempts to create canaryPath outside repo (expects EACCES / ERROR_ACCESS_DENIED).
 * 2. Network isolation: attempts loopback TCP connection (expects EACCES / WSAEACCES 10013).
 * 3. Positive control: writes nonce to worktreeCanary.
 */
export async function runSandboxProbe({ canaryPath, port, worktreeCanary, nonce }) {
  const result = {
    file: null,
    net: null,
    nonceWritten: false,
  };

  // 1. File Containment Probe
  if (canaryPath) {
    try {
      const fd = openSync(canaryPath, 'wx');
      closeSync(fd);
      result.file = { ok: true, written: true };
    } catch (err) {
      result.file = {
        ok: false,
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        message: err.message,
      };
    }
  }

  // 2. Network Isolation Probe
  if (port) {
    result.net = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(port) }, () => {
        socket.destroy();
        resolve({ ok: true, connected: true });
      });
      socket.on('error', (err) => {
        resolve({
          ok: false,
          code: err.code,
          errno: err.errno,
          syscall: err.syscall,
          message: err.message,
        });
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve({ ok: false, code: 'ETIMEDOUT', message: 'connection timed out' });
      });
    });
  }

  // 3. Positive Worktree Access Probe
  if (worktreeCanary && nonce) {
    try {
      writeFileSync(worktreeCanary, nonce, 'utf8');
      result.nonceWritten = true;
    } catch (err) {
      result.nonceError = { code: err.code, message: err.message };
    }
  }

  return result;
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = {
    canary: { type: 'string' },
    port: { type: 'string' },
    'worktree-canary': { type: 'string' },
    nonce: { type: 'string' },
  };
  const { values } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
  const res = await runSandboxProbe({
    canaryPath: values.canary,
    port: values.port ? Number(values.port) : undefined,
    worktreeCanary: values['worktree-canary'],
    nonce: values.nonce,
  });
  console.log(JSON.stringify(res));
}
