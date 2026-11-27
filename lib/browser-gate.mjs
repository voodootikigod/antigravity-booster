// Optional Browser & Visual Prosecutor (`browserGate` / `evidence_browser`, Wave 2 A9).
//
// Enforces locked policy A9:
// - Explicit `browserGate` on a ticket or `.adlc/config.json` fails closed (`enforced: true`)
//   when target routes fail, return HTTP 5xx, emit uncaught console errors, or lack a driver.
// - Undeclared frontend globs (`*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `*.html`,
//   `website/**`) run advisories when a loopback URL or `AGB_BROWSER_CHECK_CMD` is configured
//   and degrade cleanly (`{ ok: true, skipped: true, advisory: true }`) on headless/SSH hosts.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';

const FRONTEND_PATH_RE = /(?:^|\/)(?:website|public|pages|app|components)\/|\.(?:[jt]sx|vue|svelte|css|scss|html)$/i;
const TEST_OR_SPEC_RE = /(?:^|\/)(?:tests?|specs?|__tests__)\/|\.(?:test|spec)\.[a-z]+$/i;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const ALLOWED_SCREENSHOT_EXTS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const ROUTE_TIMEOUT_MS = 5000;
const CHECK_CMD_TIMEOUT_MS = 30_000;

function assertNotSymlink(targetPath) {
  const st = lstatSync(targetPath, { throwIfNoEntry: false });
  if (st && st.isSymbolicLink()) {
    throw new Error(`Security violation: symbolic link not allowed at ${targetPath}`);
  }
  return st;
}

/**
 * Return true when changed paths touch frontend UI assets/components outside test directories.
 */
export function hasFrontendChanges(changedFiles = []) {
  if (!Array.isArray(changedFiles)) return false;
  return changedFiles.some(
    (f) => typeof f === 'string' && !TEST_OR_SPEC_RE.test(f) && FRONTEND_PATH_RE.test(f)
  );
}

/**
 * Validate that a browserGate target URL strictly targets loopback (`127.0.0.1`, `localhost`, `[::1]`)
 * over `http:` or `https:` with no embedded credentials (prevents SSRF).
 */
export function isLoopbackBrowserUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return ['/'];
  const cleaned = routes
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .map((r) => (r.trim().startsWith('/') ? r.trim() : `/${r.trim()}`));
  return cleaned.length > 0 ? cleaned : ['/'];
}

function readRepoBrowserGateConfig(realRepo) {
  const cfgPath = join(realRepo, '.adlc', 'config.json');
  const st = assertNotSymlink(cfgPath);
  if (!st || !st.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (parsed?.browserGate && typeof parsed.browserGate === 'object' && !Array.isArray(parsed.browserGate)) {
      if (parsed.browserGate.enabled === false) return null;
      return parsed.browserGate;
    }
  } catch {}
  return null;
}

/**
 * Resolve effective browserGate settings and enforced-vs-advisory policy (Wave 2 A9).
 */
export function resolveBrowserGateConfig(repo, ticket = {}, opts = {}) {
  const realRepo = realpathSync(resolve(repo ?? process.cwd()));
  const ticketGate =
    ticket?.browserGate && typeof ticket.browserGate === 'object' && !Array.isArray(ticket.browserGate)
      ? ticket.browserGate
      : null;
  const repoGate = readRepoBrowserGateConfig(realRepo);
  const explicit = Boolean((ticketGate && ticketGate.enabled !== false) || repoGate);
  const frontendTouched = hasFrontendChanges(opts.changedFiles ?? []);

  if (!explicit && !frontendTouched && !opts.browserUrl) {
    return { active: false, enforced: false, advisory: false };
  }

  const enforced = explicit;
  const advisory = !explicit;
  const env = opts.env ?? process.env;
  const url = opts.browserUrl ?? ticketGate?.url ?? repoGate?.url ?? null;
  const routes = normalizeRoutes(opts.routes ?? ticketGate?.routes ?? repoGate?.routes);
  const checkCmd = opts.checkCmd ?? ticketGate?.checkCmd ?? repoGate?.checkCmd ?? env.AGB_BROWSER_CHECK_CMD ?? null;
  const rawRunId = String(opts.runId ?? 'gate-ticket');
  const runId = SAFE_RUN_ID_RE.test(rawRunId) ? rawRunId : 'gate-ticket';

  return {
    active: true,
    enforced,
    advisory,
    url: typeof url === 'string' && url.trim() ? url.trim() : null,
    routes,
    checkCmd: typeof checkCmd === 'string' && checkCmd.trim() ? checkCmd.trim() : null,
    runId,
  };
}

function probeSingleRoute(baseUrl, routePath) {
  return new Promise((resolveProbe) => {
    const target = new URL(routePath, baseUrl);
    const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn(
      target,
      { method: 'GET', agent: false, timeout: ROUTE_TIMEOUT_MS },
      (res) => {
        res.resume();
        const statusCode = res.statusCode ?? 0;
        const headerConsole = res.headers['x-agb-console-errors'];
        const consoleList = [];
        if (typeof headerConsole === 'string' && headerConsole.trim()) {
          const num = Number(headerConsole.trim());
          if (Number.isFinite(num) && num > 0) {
            consoleList.push(`${routePath}: ${num} console error(s) reported`);
          } else if (Number.isNaN(num)) {
            consoleList.push(`${routePath}: ${headerConsole.trim()}`);
          }
        }
        resolveProbe({
          route: routePath,
          statusCode,
          ok: statusCode >= 200 && statusCode < 500 && consoleList.length === 0,
          consoleErrors: consoleList,
          serverError: statusCode >= 500 ? `${routePath} returned HTTP ${statusCode}` : null,
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${ROUTE_TIMEOUT_MS}ms`));
    });
    req.on('error', (err) => {
      resolveProbe({
        route: routePath,
        statusCode: 0,
        ok: false,
        consoleErrors: [],
        serverError: `${routePath} request failed: ${err.message}`,
      });
    });
    req.end();
  });
}

function stageVerifiedScreenshots(realRepo, runId, candidatePaths = []) {
  if (!Array.isArray(candidatePaths) || candidatePaths.length === 0) return [];
  const boosterDir = join(realRepo, '.booster');
  mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(boosterDir);
  const logsDir = join(boosterDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  assertNotSymlink(logsDir);
  const runDir = join(logsDir, runId);
  mkdirSync(runDir, { recursive: true });
  assertNotSymlink(runDir);
  const shotsDir = join(runDir, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  assertNotSymlink(shotsDir);

  const saved = [];
  for (let i = 0; i < candidatePaths.length; i++) {
    const raw = candidatePaths[i];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const srcPath = resolve(realRepo, raw.trim());
    const st = assertNotSymlink(srcPath);
    if (!st || !st.isFile() || st.size <= 0 || st.size > MAX_SCREENSHOT_BYTES) continue;
    const ext = extname(srcPath).toLowerCase();
    if (!ALLOWED_SCREENSHOT_EXTS.has(ext)) continue;
    const safeBase = basename(srcPath).replace(/[^A-Za-z0-9._-]/g, '_');
    const destName = `${String(i + 1).padStart(2, '0')}-${safeBase}`;
    const destPath = join(shotsDir, destName);
    assertNotSymlink(destPath);
    if (srcPath !== destPath) {
      copyFileSync(srcPath, destPath);
    }
    saved.push({
      name: destName,
      path: `.booster/logs/${runId}/screenshots/${destName}`,
      bytes: st.size,
      ext,
    });
  }
  return saved;
}

function writeBrowserEvidenceSummary(realRepo, summary) {
  const boosterDir = join(realRepo, '.booster');
  mkdirSync(boosterDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(boosterDir);
  const evidencePath = join(boosterDir, 'browser-evidence.json');
  assertNotSymlink(evidencePath);
  const tmpPath = `${evidencePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmpPath, evidencePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
  return evidencePath;
}

/**
 * Execute the Browser & Visual Prosecutor for a candidate ticket diff.
 */
export async function runBrowserGate(repo, ticket = {}, opts = {}) {
  const realRepo = realpathSync(resolve(repo ?? process.cwd()));
  const cfg = resolveBrowserGateConfig(realRepo, ticket, opts);
  if (!cfg.active) {
    return { ok: true, skipped: true, reason: 'no_frontend_or_browser_gate' };
  }

  if (cfg.url !== null && !isLoopbackBrowserUrl(cfg.url)) {
    return {
      ok: false,
      enforced: cfg.enforced,
      advisory: cfg.advisory,
      kind: 'invalid_browser_url',
      error: `Refusing non-loopback browserGate URL '${cfg.url}' (only localhost / 127.0.0.1 / [::1] allowed)`,
    };
  }

  if (!cfg.url && !cfg.checkCmd) {
    if (cfg.enforced) {
      return {
        ok: false,
        enforced: true,
        advisory: false,
        kind: 'browser_gate_unconfigured',
        error: 'Explicit browserGate requires a loopback url or checkCmd / AGB_BROWSER_CHECK_CMD',
      };
    }
    return {
      ok: true,
      skipped: true,
      enforced: false,
      advisory: true,
      reason: 'browser_driver_unconfigured',
    };
  }

  const routeResults = [];
  const consoleErrors = [];
  const serverErrors = [];
  const rawScreenshots = [];

  if (cfg.url) {
    for (const route of cfg.routes) {
      const res = await probeSingleRoute(cfg.url, route);
      routeResults.push({ route: res.route, statusCode: res.statusCode, ok: res.ok });
      if (res.serverError) serverErrors.push(res.serverError);
      if (res.consoleErrors.length > 0) consoleErrors.push(...res.consoleErrors);
    }
  }

  let checkCmdOk = true;
  if (cfg.checkCmd) {
    const shellArgs =
      process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', cfg.checkCmd]] : ['/bin/sh', ['-c', cfg.checkCmd]];
    try {
      const stdout = execFileSync(shellArgs[0], shellArgs[1], {
        cwd: opts.worktree ? realpathSync(resolve(opts.worktree)) : realRepo,
        encoding: 'utf8',
        timeout: CHECK_CMD_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...(opts.env ?? process.env),
          AGB_BROWSER_URL: cfg.url ?? '',
          AGB_BROWSER_ROUTES: JSON.stringify(cfg.routes),
          AGB_TICKET_ID: String(ticket?.id ?? ''),
        },
      }).trim();
      if (stdout.startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed.consoleErrors)) {
          consoleErrors.push(...parsed.consoleErrors.map(String));
        }
        if (Array.isArray(parsed.serverErrors)) {
          serverErrors.push(...parsed.serverErrors.map(String));
        }
        if (Array.isArray(parsed.screenshots)) {
          rawScreenshots.push(...parsed.screenshots);
        }
      }
    } catch (err) {
      checkCmdOk = false;
      serverErrors.push(`checkCmd failed: ${(err.stderr || err.message || 'non-zero exit').toString().trim().slice(0, 240)}`);
    }
  }

  const savedScreenshots = stageVerifiedScreenshots(realRepo, cfg.runId, rawScreenshots);
  const passed = serverErrors.length === 0 && consoleErrors.length === 0 && checkCmdOk;

  const evidencePayload = {
    updatedAt: new Date().toISOString(),
    ticketId: ticket?.id ?? null,
    enforced: cfg.enforced,
    advisory: cfg.advisory,
    ok: passed,
    url: cfg.url,
    routes: routeResults,
    consoleErrors,
    serverErrors,
    screenshots: savedScreenshots,
  };
  const evidencePath = writeBrowserEvidenceSummary(realRepo, evidencePayload);

  if (!passed) {
    const detail = [...serverErrors, ...consoleErrors].join('; ') || 'Browser verification failed';
    if (cfg.enforced) {
      return {
        ok: false,
        enforced: true,
        advisory: false,
        kind: 'browser_gate_failed',
        error: `Browser prosecutor failed: ${detail}`,
        routes: routeResults,
        consoleErrors,
        serverErrors,
        screenshots: savedScreenshots,
        evidencePath,
      };
    }
    return {
      ok: true,
      enforced: false,
      advisory: true,
      warning: `Advisory browser check reported issues: ${detail}`,
      routes: routeResults,
      consoleErrors,
      serverErrors,
      screenshots: savedScreenshots,
      evidencePath,
    };
  }

  return {
    ok: true,
    enforced: cfg.enforced,
    advisory: cfg.advisory,
    routes: routeResults,
    consoleErrors: [],
    serverErrors: [],
    screenshots: savedScreenshots,
    evidencePath,
  };
}
