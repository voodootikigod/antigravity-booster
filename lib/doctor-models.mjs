import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { ALL_MODELS } from './models.mjs';

const execFileAsync = promisify(execFile);

const ANSI_ESCAPE = /\u001b\[[0-9;?>]*[A-Za-z]/g;
// Hyphenated slug (every real one is, e.g. gemini-4-argon-low), then a TAB or
// 2+ spaces (a pty expands the TAB), then the display name. Requiring a hyphen
// keeps prose like "error   Failed to fetch" or a "name   description" header
// from parsing as a model.
const MODEL_ROW = /^([a-z][a-z0-9.]*(?:-[a-z0-9.]+)+)(?:\t|\s{2,})(\S.*)$/;

function buildAgyModelsInvocation({ env = process.env, home = env.HOME || homedir() } = {}) {
  const direct = env.AGB_AGY_BIN || resolveAgyBinary(home);
  if (!direct) throw new Error('agy CLI binary not found');
  if (process.platform === 'linux') {
    const quotedCmd = `'${String(direct).replace(/'/g, "'\\''")}'`;
    return { cmd: 'script', args: ['-q', '-e', '-c', `${quotedCmd} models`, '/dev/null'], direct };
  }
  if (process.platform === 'darwin') {
    return { cmd: 'script', args: ['-q', '/dev/null', direct, 'models'], direct };
  }
  return { cmd: direct, args: ['models'], direct };
}

// `agy models` needs a TTY on linux/macOS, so run it under `script`.
export async function agyModelsStdout({ env = process.env, home = env.HOME || homedir() } = {}) {
  const { cmd, args, direct } = buildAgyModelsInvocation({ env, home });
  try {
    const { stdout } = await execFileAsync(cmd, args, { env, timeout: 15000 });
    return stdout;
  } catch (err) {
    if (cmd !== 'script') throw err;
    const { stdout } = await execFileAsync(direct, ['models'], { env, timeout: 15000 });
    return stdout;
  }
}

export function agyModelsStdoutSync({ env = process.env, home = env.HOME || homedir() } = {}) {
  const { cmd, args, direct } = buildAgyModelsInvocation({ env, home });
  try {
    return execFileSync(cmd, args, { env, encoding: 'utf8', timeout: 15000 });
  } catch (err) {
    if (cmd !== 'script') throw err;
    return execFileSync(direct, ['models'], { env, encoding: 'utf8', timeout: 15000 });
  }
}

/**
 * Parse `{ slug, displayName }` rows from `agy models` output.
 */
export function parseAgyModelRows(stdout) {
  const rows = [];
  for (const rawLine of String(stdout ?? '').replace(ANSI_ESCAPE, '').split('\n')) {
    const line = rawLine.replace(/\r+$/, '').split('\r').pop() ?? '';
    const match = MODEL_ROW.exec(line.trim());
    if (match) {
      rows.push({ slug: match[1].trim(), displayName: match[2].trim() });
    }
  }
  return rows;
}

/**
 * Slugs from `agy models` output. Handles both a plain pipe (TAB-separated)
 * and a pty capture (spinner frames and ANSI escapes overwritten with CR, TAB
 * expanded to spaces). The "Fetching available models..." status line never
 * matches: it has no slug column.
 */
export function parseAgyModels(stdout) {
  return parseAgyModelRows(stdout).map((r) => r.slug);
}

export function compareModelCatalog(live, known = ALL_MODELS, aliasIds = []) {
  const liveSet = new Set(live);
  const knownSet = new Set([...known, ...aliasIds]);
  return {
    retired: known.filter((m) => !liveSet.has(m)),
    unrecognized: live.filter((m) => !knownSet.has(m)),
  };
}

// Drift is a warning, not a failure: it needs a human to update lib/models.mjs,
// and an unavailable `agy` degrades (checkAgyBinary/checkAgyAuth own the hard failures).
export async function checkModelCatalog({ env = process.env, home = env.HOME || homedir(), modelsPromise } = {}) {
  const name = 'Model catalog';
  if (env.AGB_SYNC_MODELS_OFFLINE === '1' && !modelsPromise) {
    return { name, level: 'pass', detail: `${ALL_MODELS.length} models match`, fix: null };
  }
  let live;
  try {
    live = parseAgyModels(await (modelsPromise ?? agyModelsStdout({ env, home })));
  } catch (err) {
    return {
      name,
      level: 'warn',
      detail: `could not list models (${String(err?.message ?? err).split('\n')[0].slice(0, 120)})`,
      fix: 'Fix `agy models` (see agy CLI/agy Auth rows), then re-run doctor.',
    };
  }
  if (live.length === 0) {
    return { name, level: 'warn', detail: 'no models returned', fix: 'Run `agy models`; if it prints models, report the output format change.' };
  }
  const { retired, unrecognized } = compareModelCatalog(live, ALL_MODELS);
  if (retired.length === 0 && unrecognized.length === 0) {
    return { name, level: 'pass', detail: `${live.length} models match`, fix: null };
  }
  const parts = [];
  if (unrecognized.length > 0) parts.push(`unrecognized: ${unrecognized.join(', ')}`);
  if (retired.length > 0) parts.push(`retired: ${retired.join(', ')}`);
  return { name, level: 'warn', detail: parts.join('; '), fix: 'Update MODELS in lib/models.mjs to match `agy models`.' };
}
