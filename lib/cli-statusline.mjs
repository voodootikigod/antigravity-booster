// Ambient agy CLI statusLine + window title engine and settings installer.
//
// Synchronous, zero-child-process (<15ms) status bar and window title renderer
// reading local ADLC ticket shards (.adlc/tickets/*.json), active fleet state
// (.booster/run.json), and stdin quota/context telemetry from agy.

import {
  readFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RFC3339_UTC_RE, writeStatusLineQuotaCache } from './pools.mjs';

const IS_BUNDLED_STATUSLINE = typeof __AGB_BUNDLED__ !== 'undefined' && __AGB_BUNDLED__ === true;

function isBundledRuntime() {
  return IS_BUNDLED_STATUSLINE || (typeof __AGB_BUNDLED__ !== 'undefined' && __AGB_BUNDLED__ === true);
}

function resolveHomeDir(home) {
  return home || (!isBundledRuntime() ? process.env.AGB_HOME_DIR : undefined) || homedir();
}

const GEMINI_5H_ALIASES = new Set(['gemini-5h', 'gemini-five-hour', 'gemini_5h']);
const GEMINI_WEEKLY_ALIASES = new Set(['gemini-weekly', 'gemini_weekly']);
const CLAUDE_5H_ALIASES = new Set([
  '3p-5h',
  '3p-five-hour',
  'claude-5h',
  'claude-gpt-5h',
  'claude_gpt-5h',
]);
const CLAUDE_WEEKLY_ALIASES = new Set([
  '3p-weekly',
  'claude-weekly',
  'claude-gpt-weekly',
  'claude_gpt-weekly',
]);

// Strip ANSI/OSC/DCS/CSI escape sequences and ASCII/C1 control characters.
function stripControlAndAnsi(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

export function parseAgyStatusPayload(rawStdin) {
  const str = Buffer.isBuffer(rawStdin) ? rawStdin.toString('utf8') : rawStdin;
  if (typeof str !== 'string' || !str.trim()) return null;
  try {
    const parsed = JSON.parse(str);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function classifyWindowSlot(entry, explicitKey = null, groupName = null) {
  const candidates = [explicitKey, entry?.id, entry?.name, entry?.window];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = raw.trim().toLowerCase();
    if (GEMINI_5H_ALIASES.has(key)) return 'gemini5h';
    if (GEMINI_WEEKLY_ALIASES.has(key)) return 'geminiWeekly';
    if (CLAUDE_5H_ALIASES.has(key)) return 'claude5h';
    if (CLAUDE_WEEKLY_ALIASES.has(key)) return 'claudeWeekly';
  }

  if (typeof groupName === 'string' && groupName.trim()) {
    const g = groupName.trim().toLowerCase();
    const w = typeof entry?.window === 'string' ? entry.window.trim().toLowerCase() : '';
    const is5h = w === '5h' || w === 'five-hour' || w === 'five_hour' || w === 'fivehour';
    const isWeekly = w === 'weekly';
    if (g === 'gemini models' || g === 'gemini') {
      if (is5h) return 'gemini5h';
      if (isWeekly) return 'geminiWeekly';
    } else if (
      g === 'claude and gpt models' ||
      g === 'claude_gpt' ||
      g === 'claude-gpt' ||
      g === 'claude' ||
      g === '3p'
    ) {
      if (is5h) return 'claude5h';
      if (isWeekly) return 'claudeWeekly';
    }
  }
  return null;
}

function extractBucketPercentage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.remaining_fraction !== undefined && entry.remaining_fraction !== null) {
    const f = entry.remaining_fraction;
    if (typeof f === 'number' && Number.isFinite(f) && f >= 0 && f <= 1) {
      return f * 100;
    }
    return null;
  }
  if (entry.remaining_percentage !== undefined && entry.remaining_percentage !== null) {
    const p = entry.remaining_percentage;
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100) {
      return p;
    }
    return null;
  }
  if (entry.remainingPercent !== undefined && entry.remainingPercent !== null) {
    const p = entry.remainingPercent;
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100) {
      return p;
    }
    return null;
  }
  return null;
}

function extractBucketResetTime(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return null;
  const rt = entry.reset_time ?? entry.resetTime;
  if (typeof rt !== 'string' || !RFC3339_UTC_RE.test(rt)) return null;
  const ms = Date.parse(rt);
  if (!Number.isFinite(ms) || ms < nowMs - 10_000) return null;
  return rt;
}

export function extractQuotaFromStatusPayload(payload, nowMs = Date.now()) {
  const empty = { display: { geminiPct: null, claudePct: null }, fullNormalized: null };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return empty;
  const quota = payload.quota;
  if (!quota || typeof quota !== 'object') return empty;

  const collected = [];
  if (Array.isArray(quota)) {
    for (const item of quota) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        collected.push({ entry: item, explicitKey: null, groupName: null });
      }
    }
  } else {
    if (Array.isArray(quota.buckets)) {
      for (const item of quota.buckets) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          collected.push({ entry: item, explicitKey: null, groupName: null });
        }
      }
    }
    if (Array.isArray(quota.groups)) {
      for (const group of quota.groups) {
        if (group && typeof group === 'object' && Array.isArray(group.buckets)) {
          const groupName = group.name ?? group.id ?? null;
          for (const item of group.buckets) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              collected.push({ entry: item, explicitKey: null, groupName });
            }
          }
        }
      }
    }
    for (const [key, val] of Object.entries(quota)) {
      if (key === 'buckets' || key === 'groups') continue;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        collected.push({ entry: val, explicitKey: key, groupName: null });
      }
    }
  }

  const availableGeminiPcts = [];
  const availableClaudePcts = [];
  const slots = {
    gemini5h: null,
    geminiWeekly: null,
    claude5h: null,
    claudeWeekly: null,
  };

  for (const { entry, explicitKey, groupName } of collected) {
    const slot = classifyWindowSlot(entry, explicitKey, groupName);
    if (!slot) continue;
    const pct = extractBucketPercentage(entry);
    if (pct === null) continue;

    if (slot === 'gemini5h' || slot === 'geminiWeekly') {
      availableGeminiPcts.push(pct);
    } else {
      availableClaudePcts.push(pct);
    }

    const resetTime = extractBucketResetTime(entry, nowMs);
    const prev = slots[slot];
    if (!prev || pct < prev.pct || (!prev.resetTime && resetTime)) {
      slots[slot] = { pct, resetTime };
    }
  }

  const geminiPct =
    availableGeminiPcts.length > 0 ? Math.round(Math.min(...availableGeminiPcts)) : null;
  const claudePct =
    availableClaudePcts.length > 0 ? Math.round(Math.min(...availableClaudePcts)) : null;

  let fullNormalized = null;
  if (
    slots.gemini5h &&
    slots.gemini5h.resetTime &&
    slots.geminiWeekly &&
    slots.geminiWeekly.resetTime &&
    slots.claude5h &&
    slots.claude5h.resetTime &&
    slots.claudeWeekly &&
    slots.claudeWeekly.resetTime
  ) {
    const claudePool = {
      fiveHourRemainingPercent: slots.claude5h.pct,
      fiveHourResetTime: slots.claude5h.resetTime,
      weeklyRemainingPercent: slots.claudeWeekly.pct,
      weeklyResetTime: slots.claudeWeekly.resetTime,
    };
    fullNormalized = {
      gemini: {
        fiveHourRemainingPercent: slots.gemini5h.pct,
        fiveHourResetTime: slots.gemini5h.resetTime,
        weeklyRemainingPercent: slots.geminiWeekly.pct,
        weeklyResetTime: slots.geminiWeekly.resetTime,
      },
      claude_gpt: claudePool,
      'claude-gpt': { ...claudePool },
    };
    writeStatusLineQuotaCache(fullNormalized, { nowMs });
  }

  return {
    display: { geminiPct, claudePct },
    fullNormalized,
  };
}

function resolveTargetDir(payload, cwd) {
  const candidate =
    payload?.workspace?.current_dir ||
    payload?.workspace?.project_dir ||
    payload?.cwd ||
    cwd ||
    process.cwd();
  return typeof candidate === 'string' && candidate.trim() ? candidate : process.cwd();
}

function findAdlcRoot(targetDir, resolvedHome) {
  let cur;
  try {
    cur = resolve(targetDir);
  } catch {
    return null;
  }
  const stopHome = resolvedHome ? resolve(resolvedHome) : null;
  let stopTmp = null;
  try {
    stopTmp = resolve(tmpdir());
  } catch {}
  while (true) {
    const parent = dirname(cur);
    if (cur === parent) break;
    if (stopHome && cur === stopHome) break;
    if (stopTmp && cur === stopTmp) break;
    const marker = join(cur, '.adlc');
    try {
      const st = lstatSync(marker);
      if (!st.isSymbolicLink() && st.isDirectory()) {
        return cur;
      }
    } catch {}
    cur = parent;
  }
  return null;
}

function readActiveTicketsAndRails(adlcRoot) {
  if (!adlcRoot) return { activeIds: [], railCount: 0 };
  const dotDir = join(adlcRoot, '.adlc');
  const ticketsDir = join(dotDir, 'tickets');
  try {
    const dotStat = lstatSync(dotDir);
    if (dotStat.isSymbolicLink() || !dotStat.isDirectory()) return { activeIds: [], railCount: 0 };
    const ticketsStat = lstatSync(ticketsDir);
    if (ticketsStat.isSymbolicLink() || !ticketsStat.isDirectory()) return { activeIds: [], railCount: 0 };
  } catch {
    return { activeIds: [], railCount: 0 };
  }

  let entries;
  try {
    entries = readdirSync(ticketsDir, { withFileTypes: true });
  } catch {
    return { activeIds: [], railCount: 0 };
  }

  const activeIds = [];
  const uniqueRails = new Set();

  for (const entry of entries) {
    if (!entry.name.endsWith('.json') || entry.name === '.store.json') continue;
    if (entry.isSymbolicLink()) continue;
    const shardPath = join(ticketsDir, entry.name);
    try {
      const st = lstatSync(shardPath);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const shard = JSON.parse(readFileSync(shardPath, 'utf8'));
      if (!shard || typeof shard !== 'object' || Array.isArray(shard)) continue;
      if (shard.status === 'completed' || shard.status === 'archived') continue;

      const rawId = typeof shard.id === 'string' && shard.id.trim() ? shard.id : entry.name.slice(0, -5);
      const cleanId = stripControlAndAnsi(rawId).trim();
      if (!cleanId) continue;
      activeIds.push(cleanId);

      if (Array.isArray(shard.rails)) {
        for (const rail of shard.rails) {
          if (typeof rail === 'string' && rail.length > 0) {
            uniqueRails.add(rail);
          }
        }
      }
    } catch {
      continue;
    }
  }

  activeIds.sort();
  return { activeIds, railCount: uniqueRails.size };
}

function readActiveBoosterRun(adlcRoot) {
  if (!adlcRoot) return null;
  const boosterDir = join(adlcRoot, '.booster');
  const runPath = join(boosterDir, 'run.json');
  try {
    const dirStat = lstatSync(boosterDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    const fileStat = lstatSync(runPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    const run = JSON.parse(readFileSync(runPath, 'utf8'));
    if (
      run &&
      typeof run === 'object' &&
      !Array.isArray(run) &&
      run.done === false &&
      run.tickets &&
      typeof run.tickets === 'object' &&
      !Array.isArray(run.tickets)
    ) {
      const keys = Object.keys(run.tickets);
      const total = keys.length;
      const merged = Object.values(run.tickets).filter((t) => t?.phase === 'merged').length;
      return { merged, total, runwayWarning: Boolean(run.runwayWarning) };
    }
  } catch {}
  return null;
}

function formatTicketSegment(activeIds) {
  if (activeIds.length === 0) return 'idle';
  if (activeIds.length === 1) return activeIds[0];
  return `${activeIds[0]} (+${activeIds.length - 1})`;
}

function formatQuotaGauge(label, pct) {
  if (pct === null || !Number.isFinite(pct)) return `${label}:--`;
  const color = pct >= 50 ? '\x1b[32m' : pct >= 25 ? '\x1b[33m' : '\x1b[31m';
  return `${color}${label}:${pct}%\x1b[0m`;
}

export function renderCliStatusLine(payload, { home, cwd, now = Date.now() } = {}) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const resolvedHome = resolveHomeDir(home);
  const targetDir = resolveTargetDir(validPayload, cwd);
  const adlcRoot = findAdlcRoot(targetDir, resolvedHome);

  if (validPayload === null && !adlcRoot) {
    return '';
  }

  const { activeIds, railCount } = readActiveTicketsAndRails(adlcRoot);
  const ticketSeg = formatTicketSegment(activeIds);
  const activeRun = readActiveBoosterRun(adlcRoot);
  const { display } = extractQuotaFromStatusPayload(validPayload, now);

  const segments = [
    `\x1b[1m\x1b[36m[AGB]\x1b[0m ${ticketSeg}`,
    `🔒${railCount} rails`,
  ];

  if (display.geminiPct !== null || display.claudePct !== null) {
    segments.push(
      `${formatQuotaGauge('G', display.geminiPct)} ${formatQuotaGauge('C', display.claudePct)}`
    );
  }

  const cw = validPayload?.context_window;
  const hasFiniteUsedPct = typeof cw?.used_percentage === 'number' && Number.isFinite(cw.used_percentage);
  const exceeds200k = cw?.exceeds_200k_tokens === true;
  if (hasFiniteUsedPct || exceeds200k) {
    const pctPart = hasFiniteUsedPct ? `${Math.round(Math.max(0, cw.used_percentage))}%` : '--';
    const rotWarn =
      exceeds200k || (hasFiniteUsedPct && cw.used_percentage >= 80)
        ? '\x1b[91m\x1b[1m !ROT\x1b[0m'
        : '';
    segments.push(`ctx:${pctPart}${rotWarn}`);
  }

  if (activeRun) {
    const runwayWarn = activeRun.runwayWarning ? '\x1b[93m\x1b[1m !RUNWAY\x1b[0m' : '';
    segments.push(`⚡${activeRun.merged}/${activeRun.total}${runwayWarn}`);
  }

  const line = segments.join(' | ');
  return line.endsWith('\x1b[0m') ? line : `${line}\x1b[0m`;
}

export function renderCliWindowTitle(payload, { home, cwd } = {}) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const resolvedHome = resolveHomeDir(home);
  const targetDir = resolveTargetDir(validPayload, cwd);
  const adlcRoot = findAdlcRoot(targetDir, resolvedHome);

  const repoBase = basename(adlcRoot || resolve(targetDir)) || 'workspace';
  const repoName = stripControlAndAnsi(repoBase).trim() || 'workspace';

  const { activeIds } = readActiveTicketsAndRails(adlcRoot);
  const activeTicketOrIdle = stripControlAndAnsi(formatTicketSegment(activeIds)).trim() || 'idle';
  const activeRun = readActiveBoosterRun(adlcRoot);

  const rawTitle = activeRun
    ? `AGB · ${repoName} · ${activeTicketOrIdle} · ⚡${activeRun.merged}/${activeRun.total}`
    : `AGB · ${repoName} · ${activeTicketOrIdle}`;

  return stripControlAndAnsi(rawTitle);
}

function hasSymlinkInChain(paths) {
  for (const p of paths) {
    try {
      if (lstatSync(p).isSymbolicLink()) return true;
    } catch (err) {
      if (err?.code !== 'ENOENT') return true;
    }
  }
  return false;
}

function shallowObjectEqual(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysB.every((k) => a[k] === b[k]);
}

function writeSettingsAtomically(settingsPath, cliDir, checkChain, settingsObj) {
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  if (hasSymlinkInChain(checkChain)) {
    return false;
  }
  const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(settingsObj, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, settingsPath);
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch {}
    return false;
  }
}

export function installCliStatusLineSettings({
  home,
  agbCommand = '~/.local/bin/agb',
  force = false,
} = {}) {
  const resolvedHome = resolve(resolveHomeDir(home));
  const geminiDir = join(resolvedHome, '.gemini');
  const cliDir = join(geminiDir, 'antigravity-cli');
  const settingsPath = join(cliDir, 'settings.json');
  const checkChain = [resolvedHome, geminiDir, cliDir, settingsPath];

  if (hasSymlinkInChain(checkChain)) {
    return {
      ok: false,
      changed: false,
      skipped: true,
      settingsPath,
      warning: 'settings.json or parent directory is a symlink; skipping statusLine install',
    };
  }

  let settings = {};
  let settingsExists = false;
  try {
    const st = lstatSync(settingsPath);
    if (!st.isFile()) {
      return {
        ok: false,
        changed: false,
        skipped: true,
        settingsPath,
        warning: 'settings.json is not a regular file; skipping statusLine install',
      };
    }
    settingsExists = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return {
        ok: false,
        changed: false,
        skipped: true,
        settingsPath,
        warning: 'settings.json could not be inspected; skipping statusLine install',
      };
    }
  }

  if (settingsExists) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          changed: false,
          skipped: true,
          settingsPath,
          warning: 'settings.json is not valid JSON; skipping statusLine install',
        };
      }
      settings = parsed;
    } catch {
      return {
        ok: false,
        changed: false,
        skipped: true,
        settingsPath,
        warning: 'settings.json is not valid JSON; skipping statusLine install',
      };
    }
  }

  const targets = [
    [
      'statusLine',
      {
        type: 'command',
        command: `${agbCommand} statusline render`,
        stack_with_default: true,
      },
    ],
    [
      'title',
      {
        type: 'command',
        command: `${agbCommand} statusline title`,
      },
    ],
  ];

  let changed = false;
  let skipped = false;

  for (const [key, targetObj] of targets) {
    const existing = settings[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      typeof existing.command === 'string' &&
      !existing.command.includes('statusline') &&
      !force
    ) {
      skipped = true;
      continue;
    }
    if (!shallowObjectEqual(existing, targetObj)) {
      settings[key] = targetObj;
      changed = true;
    }
  }

  if (changed) {
    const wrote = writeSettingsAtomically(settingsPath, cliDir, checkChain, settings);
    if (!wrote) {
      return {
        ok: false,
        changed: false,
        skipped: true,
        settingsPath,
        warning: 'Failed to write settings.json atomically; skipping statusLine install',
      };
    }
  }

  return { ok: true, changed, skipped, settingsPath };
}

export function uninstallCliStatusLineSettings({ home } = {}) {
  const resolvedHome = resolve(resolveHomeDir(home));
  const geminiDir = join(resolvedHome, '.gemini');
  const cliDir = join(geminiDir, 'antigravity-cli');
  const settingsPath = join(cliDir, 'settings.json');
  const checkChain = [resolvedHome, geminiDir, cliDir, settingsPath];

  if (hasSymlinkInChain(checkChain)) {
    return {
      ok: false,
      changed: false,
      settingsPath,
      warning: 'settings.json or parent directory is a symlink; skipping statusLine uninstall',
    };
  }

  try {
    const st = lstatSync(settingsPath);
    if (!st.isFile()) {
      return { ok: false, changed: false, settingsPath };
    }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, changed: false, settingsPath };
    }
    return { ok: false, changed: false, settingsPath };
  }

  let settings;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, changed: false, settingsPath };
    }
    settings = parsed;
  } catch {
    return { ok: false, changed: false, settingsPath };
  }

  let changed = false;
  for (const key of ['statusLine', 'title']) {
    const entry = settings[key];
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.command === 'string' &&
      entry.command.includes('statusline')
    ) {
      delete settings[key];
      changed = true;
    }
  }

  if (changed) {
    const wrote = writeSettingsAtomically(settingsPath, cliDir, checkChain, settings);
    if (!wrote) {
      return { ok: false, changed: false, settingsPath };
    }
  }

  return { ok: true, changed, settingsPath };
}
