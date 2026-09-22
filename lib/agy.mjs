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
  'gemini-flash': [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-high',
    'gemini-3.5-flash-low',
    'gemini-3.5-flash-medium',
    'gemini-3.5-flash-high',
  ],
  'gemini-pro': ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
  claude: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking'],
  'gpt-oss': ['gpt-oss-120b-medium'],
};

export const MODEL_ALIASES = {
  'gemini 3.8 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.8 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.8 flash (high)': 'gemini-3.8-flash-high',
  'gemini 3.7 flash (low)': 'gemini-3.7-flash-low',
  'gemini 3.7 flash (medium)': 'gemini-3.7-flash-medium',
  'gemini 3.7 flash (high)': 'gemini-3.7-flash-high',
  'gemini 3.6 flash (low)': 'gemini-3.6-flash-low',
  'gemini 3.6 flash (medium)': 'gemini-3.6-flash-medium',
  'gemini 3.6 flash (high)': 'gemini-3.6-flash-high',
  'gemini 3.5 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.5 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.5 flash (high)': 'gemini-3.8-flash-high',
  'gemini-3.5-flash-low': 'gemini-3.8-flash-low',
  'gemini-3.5-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-high': 'gemini-3.8-flash-high',
  'gemini 3.1 pro (low)': 'gemini-3.1-pro-low',
  'gemini 3.1 pro (high)': 'gemini-3.1-pro-high',
  'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
  'claude opus 4.6 (thinking)': 'claude-opus-4-6-thinking',
  'gpt-oss 120b (medium)': 'gpt-oss-120b-medium',
};

export function resolveModelSlug(model) {
  if (typeof model !== 'string') return model;
  const normalized = model.trim().toLowerCase();
  if (MODEL_ALIASES[normalized]) {
    const resolved = MODEL_ALIASES[normalized];
    if (normalized.includes('3.5')) {
      console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    }
    return resolved;
  }
  for (const list of Object.values(MODELS)) {
    for (const slug of list) {
      if (slug.toLowerCase() === normalized) return slug;
    }
  }
  return model;
}

// agy's print-timeout marker is its entire output on failure. Matching it as
// a bare substring would false-trip when a model legitimately quotes the
// phrase, so require it to be the sole trailing line of short output.
export function isAgyTimeout(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^Error: (?:timed out waiting for response|MCP (?:tool call|server connection|connection) timed out|timed out waiting for MCP response)\.?$/i.test(last) && out.length < 300;
}

/** Quota pool for a model name (pools throttle + meter independently). */
export function poolOf(model) {
  const slug = resolveModelSlug(model);
  for (const [pool, models] of Object.entries(MODELS)) {
    if (models.includes(slug)) return pool;
  }
  // Fallback prefix check
  if (typeof slug !== 'string') throw new Error(`unknown model: ${slug}`);
  const normalized = slug.toLowerCase();
  if (normalized.includes('flash')) return 'gemini-flash';
  if (normalized.includes('gemini')) return 'gemini-pro';
  if (normalized.includes('claude') || normalized.includes('sonnet') || normalized.includes('opus')) return 'claude';
  if (normalized.includes('gpt')) return 'gpt-oss';

  throw new Error(`unknown model: ${slug}`);
}

/** Model family for cross-model prosecution ('gemini' | 'claude' | 'gpt-oss'). */
export function familyOf(model) {
  const pool = poolOf(model);
  return pool.startsWith('gemini') ? 'gemini' : pool;
}

export function parseTimeoutMs(timeout) {
  if (typeof timeout === 'number') return timeout;
  if (!timeout || typeof timeout !== 'string') return 10 * 60 * 1000;
  const match = timeout.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!match) return 10 * 60 * 1000;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  if (unit === 's') return val * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  return 10 * 60 * 1000;
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
export function runAgy({
  model,
  prompt,
  cwd,
  sandbox = false,
  timeout = '10m',
  logFile,
  bin,
  env,
  project,
  strike = 0,
  role,
  outputFormat,
  jsonSchema,
}) {
  if (!model || !prompt) throw new Error('runAgy: model and prompt are required');
  const resolvedModel = resolveModelSlug(model);
  const agyBin = bin ?? process.env.AGB_AGY_BIN ?? 'agy';
  const args = ['--print', prompt, '--print-timeout', timeout, '--model', resolvedModel];
  if (outputFormat) {
    args.push('--output-format', outputFormat);
  }
  if (jsonSchema) {
    args.push('--json-schema', typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema));
  }
  if (project) {
    args.push('--project', project);
    args.push('--add-dir', cwd ?? '.');
  }
  if (sandbox) args.push('--sandbox');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sessionEnv = {};
    if (process.env.ANTIGRAVITY_CONVERSATION_ID) sessionEnv.ANTIGRAVITY_CONVERSATION_ID = process.env.ANTIGRAVITY_CONVERSATION_ID;
    if (process.env.AGB_SESSION_ID) sessionEnv.AGB_SESSION_ID = process.env.AGB_SESSION_ID;
    const spawnEnv = { ...process.env, ...sessionEnv, ...(env ?? {}) };
    const p = spawn(agyBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    let out = '';
    let err = '';
    let resolved = false;

    const timeoutMs = parseTimeoutMs(timeout);
    const killGraceMs = 15_000;
    let timer = setTimeout(() => {
      if (resolved) return;
      try { p.kill('SIGTERM'); } catch {}
      let killTimer = setTimeout(() => {
        if (resolved) return;
        try { p.kill('SIGKILL'); } catch {}
      }, 5000);
      killTimer.unref?.();
      if (!out.includes('Error: timed out waiting for response')) {
        out = (out ? out + '\n' : '') + 'Error: timed out waiting for response.';
      }
    }, timeoutMs + killGraceMs);
    timer.unref?.();

    const finish = async (code, signal, spawnError) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
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
      
      let ok = kind === null;
      let result = { ok, output: out, ms, error: errorMsg, kind };
      if (ok && outputFormat === 'json') {
        try {
          result.data = JSON.parse(out);
        } catch (e) {
          ok = false;
          kind = 'schema_violation';
          errorMsg = `Invalid JSON structured output: ${e.message}`;
          result = { ok, output: out, ms, error: errorMsg, kind };
        }
      }
      
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

export const QUOTA_RESPONSE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['gemini', 'claude_gpt'],
  properties: {
    gemini: {
      type: 'object',
      additionalProperties: false,
      required: ['fiveHourRemainingPercent', 'weeklyRemainingPercent', 'fiveHourResetTime', 'weeklyResetTime'],
      properties: {
        fiveHourRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        weeklyRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        fiveHourResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
        weeklyResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
      },
    },
    claude_gpt: {
      type: 'object',
      additionalProperties: false,
      required: ['fiveHourRemainingPercent', 'weeklyRemainingPercent', 'fiveHourResetTime', 'weeklyResetTime'],
      properties: {
        fiveHourRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        weeklyRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        fiveHourResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
        weeklyResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
      },
    },
  },
};

export const STREAM_EVENT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    {
      additionalProperties: false,
      required: ['type', 'step', 'action'],
      properties: {
        type: { type: 'string', enum: ['step_update'] },
        step: { type: 'integer', minimum: 0 },
        action: { type: 'string', minLength: 1, maxLength: 1024 },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'status', 'exit_code'],
      properties: {
        type: { type: 'string', enum: ['result'] },
        status: { type: 'string', enum: ['SUCCESS', 'ERROR'] },
        exit_code: { type: 'integer' },
        telemetry: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input_tokens: { type: 'integer', minimum: 0 },
            output_tokens: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'timestamp'],
      properties: {
        type: { type: 'string', enum: ['heartbeat'] },
        timestamp: { type: 'integer', minimum: 0 },
      },
    },
  ],
};

export const PROSECUTION_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'block'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'charge', 'claim'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          charge: { type: 'string' },
          claim: { type: 'string' },
        },
      },
    },
  },
};

export const COLDSTART_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['gaps'],
  properties: {
    gaps: { type: 'array', items: { type: 'string' } },
  },
};

export const PARALLAX_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['ambiguities'],
  properties: {
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
};

export const BRAIN_PLAN_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'gate', 'tickets'],
  properties: {
    repo: { type: 'string' },
    base: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' },
    concurrencyCap: { type: ['integer', 'null'], minimum: 1 },
    gate: {
      type: 'object',
      additionalProperties: false,
      required: ['build', 'test'],
      properties: {
        build: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_-]+)$' },
        test: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_-]+)$' },
      },
    },
    tickets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'body', 'scope', 'rails', 'edges', 'tier'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          title: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          scope: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*))*(?:/\\*{1,2}(?:\\.[a-zA-Z0-9]+)?)?$',
            },
          },
          rails: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*))*(?:/\\*{1,2}(?:\\.[a-zA-Z0-9]+)?)?$',
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['to'],
              properties: {
                to: { type: 'string' },
                contract: { type: 'string' },
              },
            },
          },
          tier: { type: 'string', enum: ['cheap', 'mid', 'frontier'] },
          pool_hint: { type: 'string', enum: ['gemini', 'claude', 'claude-gpt', 'auto'] },
        },
      },
    },
  },
};
