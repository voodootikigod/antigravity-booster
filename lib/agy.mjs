// agy subprocess wrapper. One function, one process, structured result.
//
// Calibration facts this encodes (docs/calibration/):
//   - agy 1.1.1 returns non-zero exit code + stderr on server-side failure
//   - prompt goes on stdin; AGENTS.md/GEMINI.md in cwd auto-load
//   - model names are the exact `agy models` strings

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MODELS = {
  'gemini-flash': ['Gemini 3.5 Flash (Low)', 'Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (High)'],
  'gemini-pro': ['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)'],
  claude: ['Claude Sonnet 4.6 (Thinking)', 'Claude Opus 4.6 (Thinking)'],
  'gpt-oss': ['GPT-OSS 120B (Medium)'],
};

// agy's print-timeout marker is its entire output on failure. Matching it as
// a bare substring would false-trip when a model legitimately quotes the
// phrase, so require it to be the sole trailing line of short output.
export function isAgyTimeout(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}

/** Quota pool for a model name (pools throttle + meter independently). */
export function poolOf(model) {
  for (const [pool, models] of Object.entries(MODELS)) {
    if (models.includes(model)) return pool;
  }
  // Fallback prefix check
  if (typeof model !== 'string') throw new Error(`unknown model: ${model}`);
  const normalized = model.toLowerCase();
  if (normalized.includes('flash')) return 'gemini-flash';
  if (normalized.includes('gemini')) return 'gemini-pro';
  if (normalized.includes('claude') || normalized.includes('sonnet') || normalized.includes('opus')) return 'claude';
  if (normalized.includes('gpt')) return 'gpt-oss';

  throw new Error(`unknown model: ${model}`);
}

/** Model family for cross-model prosecution ('gemini' | 'claude' | 'gpt-oss'). */
export function familyOf(model) {
  const pool = poolOf(model);
  return pool.startsWith('gemini') ? 'gemini' : pool;
}

/**
 * Run one agy print-mode completion.
 * opts: { model, prompt, cwd, sandbox, timeout ('10m'), logFile, bin, env }
 * `env` is merged ONTO process.env for this spawn only — never mutate
 * process.env itself, which would leak across tickets building concurrently
 * in the same booster process (e.g. ADLC_P4_ENFORCEMENT/ADLC_TICKET must be
 * scoped to one ticket's worktree, not every in-flight build).
 * Returns { ok, output, ms, error } — never throws on agent failure;
 * throws only on programmer error (missing model/prompt).
 */
export function runAgy({ model, prompt, cwd, sandbox = false, timeout = '10m', logFile, bin, env, project, strike = 0, role }) {
  if (!model || !prompt) throw new Error('runAgy: model and prompt are required');
  const agyBin = bin ?? process.env.AGB_AGY_BIN ?? 'agy';
  const args = ['--print', prompt, '--print-timeout', timeout, '--model', model];
  if (project) {
    args.push('--project', project);
    args.push('--add-dir', cwd ?? '.');
  }
  if (sandbox) args.push('--sandbox');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const spawnEnv = env ? { ...process.env, ...env } : process.env;
    const p = spawn(agyBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    let out = '';
    let err = '';
    let resolved = false;

    const finish = async (code, signal, spawnError) => {
      if (resolved) return;
      resolved = true;
      const ms = Date.now() - t0;
      let kind = null;
      let errorMsg = null;
      
      const timedOut = isAgyTimeout(out);
      if (spawnError) {
        kind = 'spawn';
        errorMsg = `spawn: ${spawnError.message}`;
      } else if (code === null && signal === null) {
        kind = 'spawn';
        errorMsg = `spawn: failed to start`;
      } else if (timedOut) {
        kind = 'timeout';
        errorMsg = 'print-timeout';
      } else if (code !== 0) {
        kind = 'server';
        errorMsg = `exit ${code}: ${(err || out).slice(-300)}`;
      } else if (out.trim().length === 0) {
        kind = 'empty';
        errorMsg = `exit 0: empty output`;
      }
      
      const ok = kind === null;
      const result = { ok, output: out, ms, error: errorMsg, kind };
      
      if (logFile) {
        // Transcripts carry the full prompt and the model's full output. A
        // builder with read access to the worktree can echo a .env or a
        // config file while explaining its work, so treat these as
        // secret-bearing: owner-only dir and file, never the default 0644.
        mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });

        const record = {
          ts: new Date().toISOString(), model, cwd, strike, ms, prompt, output: out, ok, role,
        };
        if (!ok) {
          record.kind = kind;
          record.error = result.error;
        }
        await appendFile(logFile, JSON.stringify(record) + '\n', { mode: 0o600 });
      }
      resolve(result);
    };

    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => finish(null, null, e));
    p.on('close', (code, signal) => finish(code, signal));
  });
}
