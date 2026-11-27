// Elastic Multi-VM Cloud Bursting Worker Adapter (`agb run --driver remote-sdk`, Wave 4).
//
// Bridges `agb run --driver remote-sdk` onto the official `google-antigravity`
// Python SDK (`pip install google-antigravity`) or a custom `AGB_REMOTE_SDK_BIN`
// executable so independent wave tickets fan out across isolated Google-managed
// cloud devbox VMs without saturating local laptop CPU/RAM.
//
// Degrades cleanly (`{ ok: false, kind, error }`) when the SDK is unavailable,
// times out, or returns a non-zero exit code.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TIER_CANDIDATES } from './models.mjs';
import { sanitizeRemoteUrl, TICKET_ID_RE } from './plan-integrity.mjs';
import { sanitizedGitEnv } from './run-integrity.mjs';

export const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const KILL_GRACE_MS = 500;

/**
 * Self-contained Python bridge script executed via `python3 -c` when no custom
 * `AGB_REMOTE_SDK_BIN` wrapper is configured. Reads a single JSON job payload on
 * stdin and writes a single JSON result envelope on stdout.
 */
export function buildRemoteSdkBridgeScript() {
  return [
    'import json, sys, time',
    'payload = json.loads(sys.stdin.read() or "{}")',
    't0 = time.time()',
    'try:',
    '    import google_antigravity as ga',
    'except Exception as exc:',
    '    print(json.dumps({"ok": False, "kind": "sdk_unavailable", "error": f"google-antigravity Python SDK not installed: {exc}"}))',
    '    sys.exit(2)',
    'try:',
    '    client = ga.Client()',
    '    session = client.create_session(',
    '        repository=payload.get("repoRemote"),',
    '        base_branch=payload.get("baseBranch", "main"),',
    '        branch_name=payload.get("branchName"),',
    '        model=payload.get("model"),',
    '    )',
    '    result = session.run(payload.get("prompt", ""), timeout_seconds=int(payload.get("timeoutSec", 1800)))',
    '    print(json.dumps({',
    '        "ok": bool(getattr(result, "ok", True)),',
    '        "sessionId": getattr(session, "id", None),',
    '        "branch": getattr(result, "branch", payload.get("branchName")),',
    '        "commitSha": getattr(result, "commit_sha", None),',
    '        "output": str(getattr(result, "output", "")),',
    '        "ms": int((time.time() - t0) * 1000),',
    '    }))',
    'except Exception as exc:',
    '    print(json.dumps({"ok": False, "kind": "sdk_runtime_error", "error": str(exc), "ms": int((time.time() - t0) * 1000)}))',
    '    sys.exit(1)',
  ].join('\n');
}

/**
 * Check whether `AGB_REMOTE_SDK_BIN` or the `google_antigravity` Python module is available.
 */
export function isRemoteSdkAvailable({ sdkBin = null, pythonBin = 'python3', env = process.env } = {}) {
  const customBin = sdkBin || env?.AGB_REMOTE_SDK_BIN || null;
  if (customBin) {
    return {
      ok: existsSync(customBin),
      mode: 'custom-bin',
      bin: customBin,
      ...(existsSync(customBin) ? {} : { error: `AGB_REMOTE_SDK_BIN not found: ${customBin}` }),
    };
  }
  try {
    execFileSync(pythonBin, ['-c', 'import google_antigravity'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
      env,
    });
    return { ok: true, mode: 'python-sdk', bin: pythonBin };
  } catch (err) {
    return {
      ok: false,
      mode: 'python-sdk',
      bin: pythonBin,
      error: `google-antigravity Python SDK unavailable (${(err.stderr || err.message || 'import failed').toString().trim().slice(0, 160)})`,
    };
  }
}

function resolveRepoRemote(repo) {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repo,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw ? sanitizeRemoteUrl(raw) : null;
  } catch {
    return null;
  }
}

function buildWavesFromTickets(tickets = []) {
  const byId = new Map();
  const inDegree = new Map();
  const adj = new Map();
  for (const t of tickets) {
    byId.set(t.id, t);
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      const target = typeof e === 'string' ? e : e?.to;
      if (target && byId.has(target)) {
        adj.get(t.id).push(target);
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }
    for (const dep of t.deps ?? []) {
      if (dep && byId.has(dep) && !adj.get(dep).includes(t.id)) {
        adj.get(dep).push(t.id);
        inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      }
    }
  }
  const waves = [];
  let remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const wave = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);
    if (wave.length === 0) {
      throw new Error(`Cycle detected in ticket DAG among: ${[...remaining].join(', ')}`);
    }
    waves.push(wave.map((id) => byId.get(id)));
    for (const id of wave) {
      remaining.delete(id);
      for (const next of adj.get(id) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      }
    }
  }
  return waves;
}

/**
 * Execute a single ticket on an isolated remote VM via the `google-antigravity`
 * Python SDK (or `AGB_REMOTE_SDK_BIN`). Never throws; returns a structured result.
 */
export async function runRemoteSdkTicket({
  ticket,
  repo = '.',
  base = 'main',
  model = null,
  prompt = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sdkBin = null,
  pythonBin = 'python3',
  env = process.env,
} = {}) {
  if (!ticket || typeof ticket.id !== 'string' || !TICKET_ID_RE.test(ticket.id)) {
    return {
      ok: false,
      kind: 'invalid_ticket',
      error: `Invalid ticket id '${ticket?.id ?? ''}'`,
    };
  }
  const resolvedRepo = resolve(repo ?? '.');
  const effectiveTimeout = Math.max(50, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const effectiveModel = model || TIER_CANDIDATES[ticket.tier ?? 'mid']?.[0] || TIER_CANDIDATES.mid[0];
  const branchName = `agb/remote-${ticket.id.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
  const repoRemote = resolveRepoRemote(resolvedRepo);
  const ticketPrompt =
    prompt ??
    [
      `Execute ADLC ticket ${ticket.id}: ${ticket.title ?? ticket.id}`,
      `Allowed scope: ${(ticket.scope ?? []).join(', ') || '(unspecified)'}`,
      `Frozen rails (do not modify): ${(ticket.rails ?? []).join(', ') || '(none)'}`,
      '',
      String(ticket.body ?? ''),
    ].join('\n');

  const payload = {
    ticketId: ticket.id,
    title: ticket.title ?? ticket.id,
    scope: ticket.scope ?? [],
    rails: ticket.rails ?? [],
    repoRemote,
    baseBranch: base,
    branchName,
    model: effectiveModel,
    prompt: ticketPrompt,
    timeoutSec: Math.max(1, Math.ceil(effectiveTimeout / 1000)),
  };

  const customBin = sdkBin || env?.AGB_REMOTE_SDK_BIN || null;
  const cmd = customBin || pythonBin;
  const args = customBin ? [] : ['-c', buildRemoteSdkBridgeScript()];
  const t0 = Date.now();

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: resolvedRepo,
        env: { ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        kind: 'sdk_spawn_error',
        ticketId: ticket.id,
        error: err.message,
        ms: Date.now() - t0,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, KILL_GRACE_MS);
      hardKill.unref?.();
    }, effectiveTimeout);
    timer.unref?.();

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.once('error', (err) => {
      finish({
        ok: false,
        kind: 'sdk_spawn_error',
        ticketId: ticket.id,
        error: err.message,
        ms: Date.now() - t0,
      });
    });
    child.once('close', (code) => {
      const ms = Date.now() - t0;
      if (timedOut) {
        finish({
          ok: false,
          kind: 'timeout',
          ticketId: ticket.id,
          error: `Remote SDK ticket ${ticket.id} timed out after ${effectiveTimeout}ms`,
          ms,
        });
        return;
      }
      const trimmed = stdout.trim();
      const lastLine = trimmed.split('\n').filter(Boolean).at(-1) ?? '';
      let parsed = null;
      if (lastLine.startsWith('{')) {
        try {
          parsed = JSON.parse(lastLine);
        } catch {}
      }
      if (code === 0 && parsed && parsed.ok === true) {
        finish({
          ok: true,
          ticketId: ticket.id,
          sessionId: parsed.sessionId ?? null,
          branch: parsed.branch ?? branchName,
          commitSha: parsed.commitSha ?? null,
          output: parsed.output ?? '',
          model: effectiveModel,
          ms: parsed.ms ?? ms,
        });
        return;
      }
      finish({
        ok: false,
        kind: parsed?.kind || 'sdk_failed',
        ticketId: ticket.id,
        error: parsed?.error || stderr.trim().slice(0, 300) || `Remote SDK exited with code ${code ?? 'null'}`,
        ms: parsed?.ms ?? ms,
      });
    });

    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      child.stdin.end();
    } catch {}
  });
}

/**
 * Execute an `agb` ticket DAG wave-by-wave across isolated cloud VMs via `remote-sdk`.
 */
export async function runRemoteSdkPlan(
  plan,
  {
    concurrency = DEFAULT_CONCURRENCY,
    base = null,
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = () => {},
    sdkBin = null,
    pythonBin = 'python3',
    env = process.env,
  } = {}
) {
  const repo = resolve(plan?.repo ?? '.');
  const effectiveBase = base || plan?.base || 'main';
  const tickets = Array.isArray(plan?.tickets) ? plan.tickets : [];
  const cap = Math.max(1, Math.min(32, Number(concurrency) || DEFAULT_CONCURRENCY));
  const waves = buildWavesFromTickets(tickets);

  if (dryRun) {
    return {
      ok: true,
      driver: 'remote-sdk',
      dryRun: true,
      repo,
      base: effectiveBase,
      concurrency: cap,
      waves: waves.map((w, idx) => ({
        wave: idx + 1,
        tickets: w.map((t) => t.id),
      })),
      merged: [],
      completed: [],
      failed: {},
      sessions: {},
    };
  }

  const completed = [];
  const failed = {};
  const sessions = {};
  const failedSet = new Set();

  // Build reverse dependency map so downstream dependents of failed tickets are skipped
  const depsOf = new Map();
  for (const t of tickets) depsOf.set(t.id, new Set(t.deps ?? []));
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      const target = typeof e === 'string' ? e : e?.to;
      if (target && depsOf.has(target)) depsOf.get(target).add(t.id);
    }
  }

  for (let wIdx = 0; wIdx < waves.length; wIdx++) {
    const wave = waves[wIdx];
    const runnable = [];
    for (const t of wave) {
      const blockedBy = [...(depsOf.get(t.id) ?? [])].filter((d) => failedSet.has(d));
      if (blockedBy.length > 0) {
        failed[t.id] = `blocked by failed dependency: ${blockedBy.join(', ')}`;
        failedSet.add(t.id);
      } else {
        runnable.push(t);
      }
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(cap, runnable.length) }, async () => {
      while (cursor < runnable.length) {
        const ticket = runnable[cursor++];
        log(`remote-sdk: wave ${wIdx + 1} dispatching ${ticket.id}`);
        const res = await runRemoteSdkTicket({
          ticket,
          repo,
          base: effectiveBase,
          timeoutMs,
          sdkBin,
          pythonBin,
          env,
        });
        if (res.ok) {
          completed.push(ticket.id);
          sessions[ticket.id] = {
            sessionId: res.sessionId,
            branch: res.branch,
            commitSha: res.commitSha,
            model: res.model,
            ms: res.ms,
          };
        } else {
          failed[ticket.id] = res.error || res.kind;
          failedSet.add(ticket.id);
        }
      }
    });
    await Promise.all(workers);
  }

  return {
    ok: Object.keys(failed).length === 0,
    driver: 'remote-sdk',
    dryRun: false,
    repo,
    base: effectiveBase,
    concurrency: cap,
    waves: waves.map((w, idx) => ({ wave: idx + 1, tickets: w.map((t) => t.id) })),
    merged: [],
    completed,
    failed,
    sessions,
  };
}
