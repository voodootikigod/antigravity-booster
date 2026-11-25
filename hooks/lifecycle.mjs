// Zero-dependency 4-event In-Session Lifecycle Hook (`hooks/lifecycle.mjs`, v2.0 Wave 4 Proposal D3).
//
// Pure Node built-ins only so clean clones without `node_modules` work out-of-the-box.
// Handles `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop` in `hooks.json`:
//   - Headless workers (`AGB_WORKER_TICKET` / `AGB_WORKER_MODE`) and opt-outs
//     (`AGB_HOOK_DISABLE` / `AGB_LIFECYCLE_HOOKS=0`) exit `{}` in <2ms.
//   - `PreInvocation` emits 0-model-token `metadata.user_markdown` (`systemMessage: ""`)
//     readiness & context-rot badges on one-time transitions.
//   - `PostToolUse` tracks `dirtySinceGate` on source mutations in active-ticket ADLC
//     repos and clears it when test/gate commands exit 0.
//   - `Stop` returns `{ decision: "continue", reason }` strictly when an active
//     `.adlc/tickets/` shard has unverified edits, `!continuationActive`,
//     `terminationReason === "NO_TOOL_CALL"`, `fullyIdle !== false`, and
//     `stopContinuationCount < 1` since the last edit.
//   - NEVER emits `"allow"` anywhere (`PASS` is `{}`).

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function detectInstalledPluginPath() {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const realSelf = realpathSync(selfPath);
    for (const p of [selfPath, realSelf]) {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('/.gemini/config/plugins/')) return true;
    }
  } catch {}
  return false;
}

const IS_BUNDLED =
  (typeof __AGB_BUNDLED__ !== 'undefined' && Boolean(__AGB_BUNDLED__)) ||
  detectInstalledPluginPath();
const VALID_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CONTEXT_ROT_TURN_THRESHOLD = 25;
const STDIN_CEILING_MS = 3_000;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_STATE_FILES = 200;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MUTATING_FILE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'save_file',
  'delete_file',
  'move',
  'sed_file',
]);

const GATE_PASS_CMD_RE =
  /\b(?:npm\s+test|npm\s+run\s+(?:test|check|coverage|coverage:check|build)|node\s+(?:[^\n;&|]*\s+)?--test|npx\s+adlc\s+(?:rails-guard|hollow-test))\b/;

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export function isLifecycleFastBypass(env = process.env) {
  return Boolean(
    env?.AGB_WORKER_TICKET ||
    env?.AGB_WORKER_MODE ||
    env?.AGB_RESCUE_TICKET ||
    env?.AGB_HOOK_DISABLE ||
    env?.AGB_LIFECYCLE_HOOKS === '0'
  );
}

export function resolveLifecyclePluginData({
  env = process.env,
  bundled = IS_BUNDLED,
  pluginDataDir = null,
} = {}) {
  if (!bundled && pluginDataDir) {
    return resolve(pluginDataDir);
  }
  if (!bundled && typeof env?.PLUGIN_DATA === 'string' && env.PLUGIN_DATA.trim()) {
    return resolve(env.PLUGIN_DATA.trim());
  }
  const userHome = (!bundled && env?.AGB_HOME_DIR) ? resolve(env.AGB_HOME_DIR) : homedir();
  return join(userHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
}

function findAdlcRootSafe(startPath, stopHome) {
  if (!startPath || typeof startPath !== 'string') return null;
  let cur = resolve(startPath);
  const resolvedStop = stopHome ? resolve(stopHome) : null;
  for (let depth = 0; depth < 32; depth += 1) {
    if (resolvedStop && cur === resolvedStop) return null;
    const adlcDir = join(cur, '.adlc');
    const st = lstatOrNull(adlcDir);
    if (st && !st.isSymbolicLink() && st.isDirectory()) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function inspectActiveAdlcRepo(cwd, workspacePaths = [], homeDir = homedir()) {
  const candidates = [cwd, ...(Array.isArray(workspacePaths) ? workspacePaths : [])].filter(
    (p) => typeof p === 'string' && p.trim().length > 0
  );
  let repoRoot = null;
  for (const c of candidates) {
    repoRoot = findAdlcRootSafe(c, homeDir);
    if (repoRoot) break;
  }
  if (!repoRoot) {
    return { adlc: false, hasActiveTicket: false, repoRoot: null, ticketIds: [], railCount: 0 };
  }
  const ticketsDir = join(repoRoot, '.adlc', 'tickets');
  const tSt = lstatOrNull(ticketsDir);
  if (!tSt || tSt.isSymbolicLink() || !tSt.isDirectory()) {
    return { adlc: true, hasActiveTicket: false, repoRoot, ticketIds: [], railCount: 0 };
  }

  const ticketIds = [];
  const rails = new Set();
  let entries = [];
  try {
    entries = readdirSync(ticketsDir, { withFileTypes: true });
  } catch {
    return { adlc: true, hasActiveTicket: false, repoRoot, ticketIds: [], railCount: 0 };
  }

  for (const ent of entries) {
    if (ent.isSymbolicLink() || !ent.isFile() || !ent.name.endsWith('.json') || ent.name === '.store.json') continue;
    try {
      const parsed = JSON.parse(readFileSync(join(ticketsDir, ent.name), 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.completed === true) continue;
      const status = String(parsed.status || 'open').toLowerCase();
      if (status === 'completed' || status === 'closed' || status === 'archived' || status === 'done') continue;
      if (typeof parsed.id === 'string' && parsed.id.trim()) {
        ticketIds.push(parsed.id.trim());
      }
      if (Array.isArray(parsed.rails)) {
        for (const r of parsed.rails) {
          if (typeof r === 'string' && r.trim()) rails.add(r.trim());
        }
      }
    } catch {}
  }

  ticketIds.sort();
  return {
    adlc: true,
    hasActiveTicket: ticketIds.length > 0,
    repoRoot,
    ticketIds,
    railCount: rails.size,
  };
}

function defaultSessionState(conversationId) {
  return {
    conversationId,
    turnCount: 0,
    readinessShown: false,
    compactWarned: false,
    dirtySinceGate: false,
    editCount: 0,
    lastEditedPath: null,
    lastGatePassAt: null,
    stopContinuationCount: 0,
    updatedAt: Date.now(),
  };
}

function loadSessionState(dataDir, conversationId) {
  if (!VALID_CONVERSATION_ID_RE.test(conversationId)) return null;
  if (lstatOrNull(dataDir)?.isSymbolicLink()) return null;
  const stateDir = join(dataDir, 'session-state');
  const dirSt = lstatOrNull(stateDir);
  if (dirSt?.isSymbolicLink()) return null;
  const stateFile = join(stateDir, `${conversationId}.json`);
  const fSt = lstatOrNull(stateFile);
  if (!fSt) return defaultSessionState(conversationId);
  if (fSt.isSymbolicLink() || !fSt.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultSessionState(conversationId);
    }
    return {
      ...defaultSessionState(conversationId),
      ...parsed,
      conversationId,
    };
  } catch {
    return defaultSessionState(conversationId);
  }
}

function saveSessionState(dataDir, state) {
  if (!state || !VALID_CONVERSATION_ID_RE.test(state.conversationId)) return false;
  if (lstatOrNull(dataDir)?.isSymbolicLink()) return false;
  const stateDir = join(dataDir, 'session-state');
  if (lstatOrNull(stateDir)?.isSymbolicLink()) return false;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  const dirSt = lstatOrNull(stateDir);
  if (!dirSt || dirSt.isSymbolicLink() || !dirSt.isDirectory()) return false;

  const stateFile = join(stateDir, `${state.conversationId}.json`);
  if (lstatOrNull(stateFile)?.isSymbolicLink()) return false;
  const tmpFile = join(stateDir, `.tmp-${state.conversationId}-${process.pid}-${randomUUID()}.json`);
  try {
    state.updatedAt = Date.now();
    writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmpFile, stateFile);
    try {
      const entries = readdirSync(stateDir, { withFileTypes: true }).filter(
        (e) => !e.isSymbolicLink() && e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.tmp-')
      );
      if (entries.length > MAX_STATE_FILES) {
        const now = Date.now();
        const aged = entries
          .map((e) => {
            const fp = join(stateDir, e.name);
            const st = lstatOrNull(fp);
            return st ? { fp, mtimeMs: st.mtimeMs } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.mtimeMs - b.mtimeMs);
        const excess = aged.length - MAX_STATE_FILES;
        for (let i = 0; i < aged.length; i += 1) {
          if (i < excess || now - aged[i].mtimeMs > STATE_TTL_MS) {
            try { rmSync(aged[i].fp, { force: true }); } catch {}
          }
        }
      }
    } catch {}
    return true;
  } catch {
    try { rmSync(tmpFile, { force: true }); } catch {}
    return false;
  }
}

function isIgnoredEditTarget(rawTarget, repoRoot) {
  if (!rawTarget || typeof rawTarget !== 'string') return false;
  const norm = rawTarget.replace(/\\/g, '/');
  if (
    norm.includes('/.gemini/') ||
    norm.includes('/brain/') ||
    norm.includes('/.booster/') ||
    norm.includes('/.adlc/') ||
    norm.startsWith('.booster/') ||
    norm.startsWith('.adlc/')
  ) {
    return true;
  }
  if (repoRoot) {
    const resolved = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(repoRoot, rawTarget);
    const rel = relative(repoRoot, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

function extractEditedTarget(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['Path', 'TargetFile', 'destination', 'target_file', 'targetFile', 'filePath']) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      return args[key].trim();
    }
  }
  return '';
}

function buildZeroTokenUserMarkdown(markdown) {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: markdown,
          },
        },
      },
    ],
  };
}

/**
 * Pure/testable lifecycle evaluator returning the exact JSON object to write to stdout.
 */
export function evaluateLifecycleEvent(
  payload = {},
  {
    eventOverride = null,
    env = process.env,
    bundled = IS_BUNDLED,
    pluginDataDir = null,
  } = {}
) {
  if (isLifecycleFastBypass(env)) {
    return {};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const eventName = String(eventOverride || payload.hookEventName || '').trim();
  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
  const dataDir = resolveLifecyclePluginData({ env, bundled, pluginDataDir });
  const userHome = (!bundled && env?.AGB_HOME_DIR) ? resolve(env.AGB_HOME_DIR) : homedir();
  const adlcInfo = inspectActiveAdlcRepo(payload.cwd, payload.workspacePaths, userHome);
  const state = conversationId ? loadSessionState(dataDir, conversationId) : null;

  if (eventName === 'PostToolUse') {
    if (!state) return {};
    const toolName = String(payload.toolCall?.name || '').trim().toLowerCase();
    const args = payload.toolCall?.args ?? {};
    const hadError = Boolean(payload.error);

    if (!hadError && MUTATING_FILE_TOOLS.has(toolName) && adlcInfo.hasActiveTicket) {
      const rawTarget = extractEditedTarget(args);
      if (!isIgnoredEditTarget(rawTarget, adlcInfo.repoRoot)) {
        state.dirtySinceGate = true;
        state.editCount = (Number(state.editCount) || 0) + 1;
        state.lastEditedPath = rawTarget ? basename(rawTarget) : null;
        state.stopContinuationCount = 0;
        saveSessionState(dataDir, state);
      }
    } else if (!hadError && toolName === 'run_command') {
      const cmd = String(args.CommandLine ?? args.command ?? '');
      if (GATE_PASS_CMD_RE.test(cmd)) {
        state.dirtySinceGate = false;
        state.stopContinuationCount = 0;
        state.lastGatePassAt = Date.now();
        saveSessionState(dataDir, state);
      }
    }
    return {};
  }

  if (eventName === 'PreInvocation') {
    if (!state) return {};
    state.turnCount = (Number(state.turnCount) || 0) + 1;

    if (adlcInfo.hasActiveTicket && !state.readinessShown) {
      state.readinessShown = true;
      saveSessionState(dataDir, state);
      const shownIds = adlcInfo.ticketIds.slice(0, 3).map((id) => `\`${id}\``).join(', ');
      const extra = adlcInfo.ticketIds.length > 3 ? ` (+${adlcInfo.ticketIds.length - 3} more)` : '';
      return buildZeroTokenUserMarkdown(
        `> **AGB ADLC Guard Active:** ${adlcInfo.ticketIds.length} active ticket(s) (${shownIds}${extra}) · ${adlcInfo.railCount} declared rail glob(s) enforced.`
      );
    }

    if (state.turnCount >= CONTEXT_ROT_TURN_THRESHOLD && !state.compactWarned) {
      state.compactWarned = true;
      saveSessionState(dataDir, state);
      return buildZeroTokenUserMarkdown(
        `> **AGB Context Hygiene:** Turn ${state.turnCount} reached — consider running \`/compact\` at the next clean checkpoint to preserve KV-cache efficiency and prevent context rot.`
      );
    }

    saveSessionState(dataDir, state);
    return {};
  }

  if (eventName === 'PostInvocation') {
    if (state) {
      saveSessionState(dataDir, state);
    }
    return {};
  }

  if (eventName === 'Stop') {
    if (!state) return {};
    const canContinue =
      payload.continuationActive !== true &&
      payload.terminationReason === 'NO_TOOL_CALL' &&
      !payload.error &&
      payload.fullyIdle !== false &&
      adlcInfo.hasActiveTicket &&
      state.dirtySinceGate === true &&
      (Number(state.stopContinuationCount) || 0) < 1;

    if (!canContinue) {
      return {};
    }

    state.stopContinuationCount = (Number(state.stopContinuationCount) || 0) + 1;
    if (!saveSessionState(dataDir, state)) {
      // Never emit decision: "continue" if state persistence failed (prevents infinite loops on read-only fs)
      return {};
    }

    const primaryTicket = adlcInfo.ticketIds[0] || 'active-ticket';
    const fileDetail = state.lastEditedPath ? ` (last edited: ${state.lastEditedPath})` : '';
    return {
      decision: 'continue',
      reason: `ADLC P5 Dirty-Since-Gate: ticket ${primaryTicket} has unverified source edits${fileDetail} since the last test/gate run. Run your test gate (e.g. npm test) and show its output before concluding.`,
    };
  }

  return {};
}

function readStdinBounded() {
  return new Promise((resolveRead) => {
    let data = '';
    let bytes = 0;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolveRead(val);
    };
    const timer = setTimeout(() => finish(''), STDIN_CEILING_MS);
    timer.unref?.();

    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes <= MAX_STDIN_BYTES) {
          data += chunk;
        }
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish(data);
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish('');
      });
    } catch {
      clearTimeout(timer);
      finish('');
    }
  });
}

const IS_MAIN =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  if (isLifecycleFastBypass(process.env)) {
    try {
      process.stdin.on('error', () => {});
      process.stdin.resume();
      process.stdin.unref?.();
    } catch {}
    writeSync(1, '{}\n');
  } else {
    const cliEventArg = process.argv[2] || null;
    readStdinBounded()
      .then((raw) => {
        let parsed = {};
        if (raw && raw.trim()) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = {};
          }
        }
        const out = evaluateLifecycleEvent(parsed, { eventOverride: cliEventArg });
        writeSync(1, `${JSON.stringify(out)}\n`);
      })
      .catch(() => {
        try {
          writeSync(1, '{}\n');
        } catch {}
      });
  }
}
