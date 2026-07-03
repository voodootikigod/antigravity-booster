// agy subprocess wrapper. One function, one process, structured result.
//
// Calibration facts this encodes (docs/calibration/):
//   - agy exits 0 even on print-timeout; the error is in the output text
//   - prompt goes on stdin; AGENTS.md/GEMINI.md in cwd auto-load
//   - model names are the exact `agy models` strings

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
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
export function runAgy({ model, prompt, cwd, sandbox = false, timeout = '10m', logFile, bin, env }) {
  if (!model || !prompt) throw new Error('runAgy: model and prompt are required');
  const agyBin = bin ?? process.env.AGB_AGY_BIN ?? 'agy';
  const args = ['--print', '--print-timeout', timeout, '--model', model];
  if (sandbox) args.push('--sandbox');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const spawnEnv = env ? { ...process.env, ...env } : process.env;
    const p = spawn(agyBin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, output: '', ms: Date.now() - t0, error: `spawn: ${e.message}` }));
    p.stdin.end(prompt);
    p.on('close', (code) => {
      const ms = Date.now() - t0;
      const timedOut = isAgyTimeout(out);
      const ok = code === 0 && !timedOut && out.trim().length > 0;
      const result = {
        ok,
        output: out,
        ms,
        error: ok ? null : timedOut ? 'print-timeout' : `exit ${code}: ${(err || out).slice(-300)}`,
      };
      if (logFile) {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(
          logFile,
          JSON.stringify({ ts: new Date().toISOString(), model, cwd, ms, ok, error: result.error }) +
            '\n---PROMPT---\n' + prompt + '\n---OUTPUT---\n' + out + '\n===\n'
        );
      }
      resolve(result);
    });
  });
}
