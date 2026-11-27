// Zero-agy Deterministic ADLC P5 Ticket Prosecutor (`agb gate-ticket <ticket-id>`).
//
// Designed for Antigravity Web Standalone, Remote Agents (`jetski`), Cloud VMs,
// and CI environments where no child `agy` binary is present: executes 100%
// deterministic verification against a ticket shard in `.adlc/tickets/`:
//   1. Ticket & active-rail store resolution (fails closed on missing/corrupt store)
//   2. Scope confinement, physical symlink containment, rail check & anti-no-op
//   3. `adlc rails-guard` enforcement when rails are active
//   4. Sandboxed build + test gate commands (`runGates`)
//   5. Learned repository invariant checks (`.adlc/learned-checks.json`)
//   6. Optional `adlc hollow-test` diff-scoped mutation gate on committed JS/TS diffs
//   7. Advisory `adlc gate-manifest` recording

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path, { join, resolve } from 'node:path';
import { globMatch } from '@adlc/core/tickets';
import { resolveTicket, unionActiveRails } from './active-rails.mjs';
import { assertNoLegacyTicketStore } from './adlc-bridge.mjs';
import { runAdlcTool } from './adlc-tool.mjs';
import { runBrowserGate } from './browser-gate.mjs';
import { runLearnedChecks } from './distill.mjs';
import { gateSandboxAvailable, runGates } from './gates.mjs';
import { TICKET_ID_RE } from './plan-integrity.mjs';
import { checkRailsGuard, recordGate, verifyScopeAndAntiNoOp } from './scheduler-verify.mjs';

export function resolveNullHooksPath(plat = process.platform) {
  return plat === 'win32' ? 'NUL' : '/dev/null';
}

const HOLLOW_TEST_TIMEOUT_MS = 300_000;
const SOURCE_CODE_EXT_RE = /\.(?:m|c)?[jt]sx?$/;
const TEST_OR_SPEC_PATH_RE = /(?:^|\/)(?:tests?|specs?|__tests__)\/|\.(?:test|spec)\.(?:m|c)?[jt]sx?$/i;
const IGNORED_META_PREFIXES = ['.adlc/tickets/', '.booster/', '.agb_home/'];

function gitExec(cwd, args) {
  return execFileSync('git', ['-c', `core.hooksPath=${resolveNullHooksPath()}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isIgnoredMetaPath(relPath) {
  if (relPath === 'AGENTS.md' || relPath === '.agb_home') return true;
  return IGNORED_META_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Non-mutating scope, physical symlink containment, rail, and anti-no-op check
 * for in-place working trees (never creates surprise git commits).
 */
export function verifyWorkingTreeScope(realRepo, candidateDir, baseRefSha, ticket, activeRails = []) {
  const diffOut = gitExec(candidateDir, ['diff', '--name-status', '-M', '-C', '-z', baseRefSha]);
  const untrackedOut = gitExec(candidateDir, ['ls-files', '--others', '--exclude-standard', '-z']);

  const entries = [];
  const tokens = diffOut.split('\0');
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const status = tokens[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ status: status[0], paths: [tokens[i + 1], tokens[i + 2]], deletedPath: status.startsWith('R') ? tokens[i + 1] : null });
      i += 3;
    } else {
      entries.push({ status: status[0], paths: [tokens[i + 1]], deletedPath: status === 'D' ? tokens[i + 1] : null });
      i += 2;
    }
  }
  for (const unt of untrackedOut.split('\0').filter(Boolean)) {
    entries.push({ status: 'A', paths: [unt], deletedPath: null });
  }

  const changedSet = new Set();
  const effectiveRails = [...new Set([...(ticket.rails ?? []), ...activeRails])];

  for (const entry of entries) {
    for (const p of entry.paths) {
      if (!p || isIgnoredMetaPath(p)) continue;
      if (p === '.adlc/tickets.json') {
        return { ok: false, kind: 'scope_violation', error: 'LEGACY_TICKET_STORE: .adlc/tickets.json cannot be modified' };
      }
      const norm = path.posix.normalize(p);
      if (norm !== p || p.startsWith('/') || p.startsWith('\\') || p.split('/').some((s) => s === '.' || s === '..')) {
        return { ok: false, kind: 'scope_violation', error: `Unnormalized or traversal path: ${p}` };
      }
      changedSet.add(p);

      if (p !== entry.deletedPath) {
        const fullPath = join(candidateDir, p);
        if (existsSync(fullPath) || lstatSync(fullPath, { throwIfNoEntry: false })) {
          const st = lstatSync(fullPath);
          if (st.isSymbolicLink()) {
            const rawTarget = readlinkSync(fullPath);
            let finalReal;
            try {
              finalReal = realpathSync(fullPath);
            } catch {
              return { ok: false, kind: 'scope_violation', error: `Dangling symlink rejected: ${p} -> ${rawTarget}` };
            }
            if (!finalReal.startsWith(candidateDir + path.sep) && finalReal !== candidateDir) {
              return { ok: false, kind: 'scope_violation', error: `Physical containment escape (symlink target): ${p} -> ${rawTarget}` };
            }
          } else {
            const real = realpathSync(fullPath);
            if (!real.startsWith(candidateDir + path.sep) && real !== candidateDir) {
              return { ok: false, kind: 'scope_violation', error: `Physical containment escape: ${p}` };
            }
          }
        }
      }

      if (effectiveRails.some((r) => globMatch(r, p))) {
        return { ok: false, kind: 'rail_violation', error: `Modified path matches frozen rail: ${p}` };
      }
      const scope = Array.isArray(ticket.scope) ? ticket.scope : [];
      if (!scope.some((s) => globMatch(s, p))) {
        return { ok: false, kind: 'scope_violation', error: `Out-of-scope file modified for ${ticket.id}: ${p}` };
      }
    }
  }

  const changedPaths = [...changedSet];
  if (changedPaths.length === 0) {
    return { ok: false, kind: 'empty_diff', error: `Zero candidate changes against ${baseRefSha}` };
  }
  const headSha = gitExec(candidateDir, ['rev-parse', 'HEAD']).trim();
  return { ok: true, headSha, changedPaths };
}

/**
 * Execute deterministic ADLC P5 verification for a single ticket without requiring `agy`.
 */
export async function runGateTicket(repo, ticketId, opts = {}) {
  const {
    base = 'HEAD~1',
    worktree = null,
    testCmd = 'npm test',
    buildCmd = null,
    skipHollow = false,
    skipBrowser = false,
    browserUrl = null,
    autocommit = Boolean(worktree),
    sandbox,
    adlcBin,
    recordManifest = true,
    env = process.env,
  } = opts;

  if (!ticketId || !TICKET_ID_RE.test(String(ticketId))) {
    return { ok: false, kind: 'invalid_ticket_id', error: `Invalid ticket ID: ${String(ticketId)}` };
  }

  const realRepo = realpathSync(resolve(repo ?? process.cwd()));
  try {
    assertNoLegacyTicketStore(realRepo);
  } catch (err) {
    return { ok: false, kind: 'legacy_ticket_store', error: err.message };
  }

  const railUnion = unionActiveRails(realRepo);
  if (!railUnion.ok) {
    return { ok: false, kind: 'corrupt_ticket_store', error: 'ADLC ticket store corrupt or unreadable; failing closed' };
  }

  const found = resolveTicket(realRepo, ticketId);
  if (!found.ok) {
    return { ok: false, kind: 'ticket_not_found', error: found.error };
  }
  const ticket = found.ticket;
  const candidateDir = worktree ? realpathSync(resolve(worktree)) : realRepo;

  let baseRefSha;
  try {
    baseRefSha = gitExec(candidateDir, ['rev-parse', '--verify', base]).trim();
  } catch (err) {
    return { ok: false, kind: 'invalid_base_ref', error: `Cannot resolve base ref '${base}': ${err.message}` };
  }

  const stages = {
    scopeVerify: null,
    railsGuard: null,
    gates: null,
    learnedChecks: null,
    browserGate: null,
    hollowTest: null,
    manifest: [],
  };

  // 1. Scope, symlink, rail, and anti-no-op verification
  const effectiveRails = [...new Set([...(ticket.rails ?? []), ...(railUnion.rails ?? [])])];
  const scopeRes = autocommit
    ? verifyScopeAndAntiNoOp(realRepo, candidateDir, baseRefSha, { ...ticket, rails: effectiveRails })
    : verifyWorkingTreeScope(realRepo, candidateDir, baseRefSha, ticket, effectiveRails);
  stages.scopeVerify = scopeRes;
  if (!scopeRes.ok) {
    return { ok: false, ticketId, baseRefSha, kind: scopeRes.kind, error: scopeRes.error, stages };
  }

  // 2. Mechanical `adlc rails-guard` check when rails are declared
  if (effectiveRails.length > 0) {
    const rgRes = await checkRailsGuard({ worktree: candidateDir, base: baseRefSha, rails: effectiveRails, adlcBin });
    stages.railsGuard = rgRes;
    if (rgRes.violations.length > 0) {
      return {
        ok: false,
        ticketId,
        baseRefSha,
        changedPaths: scopeRes.changedPaths,
        kind: 'rail_violation',
        error: rgRes.violations.join('; '),
        stages,
      };
    }
  } else {
    stages.railsGuard = { violations: [], skipped: true };
  }

  // 3. Sandboxed build + test gates
  const effectiveSandbox = sandbox !== undefined ? Boolean(sandbox) : gateSandboxAvailable();
  const gateSpec = {
    ...(buildCmd ? { build: buildCmd } : {}),
    ...(testCmd ? { test: testCmd } : {}),
  };
  const gateRes = await runGates(gateSpec, candidateDir, { sandbox: effectiveSandbox, env });
  stages.gates = gateRes;
  if (!gateRes.ok) {
    const failedGate = gateRes.results.find((r) => !r.ok);
    return {
      ok: false,
      ticketId,
      baseRefSha,
      changedPaths: scopeRes.changedPaths,
      kind: 'gate_failed',
      error: `Gate '${failedGate?.name ?? 'test'}' failed: ${(failedGate?.output ?? '').trim().slice(-400)}`,
      stages,
    };
  }

  // 4. Learned repository invariants
  const learnedRes = runLearnedChecks(candidateDir, { changedFiles: scopeRes.changedPaths });
  stages.learnedChecks = learnedRes;
  if (!learnedRes.ok) {
    return {
      ok: false,
      ticketId,
      baseRefSha,
      changedPaths: scopeRes.changedPaths,
      kind: 'learned_check_failed',
      error: learnedRes.error || `Learned checks failed (${learnedRes.violations?.length ?? 0} violation(s))`,
      stages,
    };
  }

  // 4b. Browser & Visual Prosecutor (Wave 2 A9)
  if (!skipBrowser) {
    const browserRes = await runBrowserGate(realRepo, ticket, {
      worktree: candidateDir,
      changedFiles: scopeRes.changedPaths,
      browserUrl,
      env,
    });
    stages.browserGate = browserRes;
    if (!browserRes.ok) {
      return {
        ok: false,
        ticketId,
        baseRefSha,
        changedPaths: scopeRes.changedPaths,
        kind: browserRes.kind || 'browser_gate_failed',
        error: browserRes.error || 'Browser prosecutor failed',
        stages,
      };
    }
  } else {
    stages.browserGate = { ok: true, skipped: true, reason: 'skipBrowser' };
  }

  // 5. Optional `adlc hollow-test` on committed JS/TS source changes
  const headSha = gitExec(candidateDir, ['rev-parse', 'HEAD']).trim();
  const statusClean = gitExec(candidateDir, ['status', '--porcelain=v1']).trim().length === 0;
  const hasMutableSourceChanges = scopeRes.changedPaths.some(
    (p) => SOURCE_CODE_EXT_RE.test(p) && !TEST_OR_SPEC_PATH_RE.test(p) && !p.startsWith('dist/') && !p.startsWith('vendor/')
  );

  if (!skipHollow && hasMutableSourceChanges && headSha !== baseRefSha && statusClean) {
    const hollowRes = await runAdlcTool({
      tool: 'hollow-test',
      args: ['--base', baseRefSha, '--test-cmd', testCmd || 'npm test', '--json'],
      cwd: candidateDir,
      timeoutMs: HOLLOW_TEST_TIMEOUT_MS,
      adlcBin,
      repo: realRepo,
    });
    stages.hollowTest = { ok: hollowRes.ok && hollowRes.exitCode === 0, exitCode: hollowRes.exitCode, parsed: hollowRes.parsed ?? null };
    if (!hollowRes.ok || hollowRes.exitCode !== 0) {
      return {
        ok: false,
        ticketId,
        baseRefSha,
        headSha,
        changedPaths: scopeRes.changedPaths,
        kind: 'hollow_test_failed',
        error: hollowRes.error || `adlc hollow-test failed with exit code ${hollowRes.exitCode}`,
        stages,
      };
    }
  } else {
    stages.hollowTest = { skipped: true, reason: skipHollow ? 'skipHollow' : (!statusClean ? 'uncommitted_changes' : 'no_committed_source_diff') };
  }

  // 6. Advisory `adlc gate-manifest` recording (degrades gracefully per AGENTS.md)
  if (recordManifest) {
    stages.manifest.push(await recordGate({ repo: realRepo, gateName: 'rails-guard', ticketId, data: { ok: true, base: baseRefSha }, adlcBin }));
    stages.manifest.push(await recordGate({ repo: realRepo, gateName: 'tests', ticketId, data: { ok: true, changedFiles: scopeRes.changedPaths.length }, adlcBin }));
    if (stages.browserGate && !stages.browserGate.skipped) {
      stages.manifest.push(
        await recordGate({
          repo: realRepo,
          gateName: 'browser-gate',
          ticketId,
          data: { ok: true, enforced: Boolean(stages.browserGate.enforced), routes: (stages.browserGate.routes ?? []).length },
          adlcBin,
        })
      );
    }
    if (stages.hollowTest && !stages.hollowTest.skipped) {
      stages.manifest.push(await recordGate({ repo: realRepo, gateName: 'hollow-test', ticketId, data: { ok: true }, adlcBin }));
    }
  }

  return {
    ok: true,
    ticketId,
    baseRefSha,
    headSha,
    changedPaths: scopeRes.changedPaths,
    stages,
  };
}
