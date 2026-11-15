// Scheduler verification helpers: flail detection, consensus-fix fanout,
// gate-manifest recording, post-hoc rails-guard, live-enforcement handshake,
// and authoritative scope & anti-no-op verification.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { globMatch } from '@adlc/core/tickets';
import { runAdlcTool } from './adlc-tool.mjs';
import { gateSandboxAvailable, sandboxProfile, linuxBwrapArgs } from './gates.mjs';
import {
  readPluginContract,
  SUPPORTED_PLUGIN_CONTRACT,
  execFileAuthenticatedAdlc,
} from './adlc-bridge.mjs';

const RAILS_GUARD_TIMEOUT_MS = 30_000;
const FLAIL_DETECTOR_TIMEOUT_MS = 15_000;
const CONSENSUS_FIX_TIMEOUT_MS = 300_000;
const GATE_MANIFEST_TIMEOUT_MS = 15_000;
const NULL_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Authoritative candidate scope, symlink containment, and anti-no-op verification.
 */
export function verifyScopeAndAntiNoOp(repo, worktreePath, baseRefSha, ticket) {
  const g = (cwd, ...args) => execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, ...args], { cwd, encoding: 'utf8' }).trim();

  // 1. Stage and commit uncommitted changes if any
  const statusOut = execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'status', '--porcelain=v1', '-z'], { cwd: worktreePath });
  if (statusOut.length > 0) {
    execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'add', '-A', '--', ':(exclude)AGENTS.md', ':(exclude).adlc/tickets', ':(exclude).agb_home', ':(exclude).agb_home/**'], { cwd: worktreePath });
    try {
      execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'agb: candidate attempt commit'], { cwd: worktreePath });
    } catch {}
  }

  const headSha = g(worktreePath, 'rev-parse', 'HEAD');
  if (headSha === baseRefSha) {
    return { ok: false, kind: 'empty_diff', error: 'zero changes against baseline commit' };
  }

  // 2. Authoritative candidate comparison against baseRefSha
  const diffTreeBuf = execFileSync(
    'git',
    ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'diff-tree', '-r', '--name-status', '-M', '-C', '-z', baseRefSha, 'HEAD'],
    { cwd: worktreePath }
  );

  const tokens = diffTreeBuf.toString('utf8').split('\0');
  const records = [];
  let idx = 0;
  while (idx < tokens.length && tokens[idx]) {
    const status = tokens[idx];
    if (status.startsWith('R') || status.startsWith('C')) {
      const src = tokens[idx + 1];
      const dest = tokens[idx + 2];
      records.push({ status: status[0], src, dest });
      idx += 3;
    } else {
      const filePath = tokens[idx + 1];
      records.push({ status: status[0], path: filePath });
      idx += 2;
    }
  }

  if (records.length === 0) {
    return { ok: false, kind: 'empty_diff', error: 'diff-tree against baseRefSha contains 0 records' };
  }

  let realWorktree;
  try {
    realWorktree = realpathSync(worktreePath);
  } catch {
    realWorktree = worktreePath;
  }

  const changedPaths = [];
  for (const rec of records) {
    const pathsToCheck = rec.status === 'R' || rec.status === 'C' ? [rec.src, rec.dest] : [rec.path];
    for (const p of pathsToCheck) {
      if (!p) continue;

      changedPaths.push(p);

      if (p === '.adlc/tickets.json') {
        return { ok: false, kind: 'scope_violation', error: 'LEGACY_TICKET_STORE: a builder may not touch the retired .adlc/tickets.json; run `adlc ticket store migrate` outside the build' };
      }

      const norm = path.posix.normalize(p);
      if (norm !== p || p.startsWith('/') || p.startsWith('\\') || p.split('/').some((s) => s === '.' || s === '..')) {
        return { ok: false, kind: 'scope_violation', error: `Unnormalized or traversal path: ${p}` };
      }

      const isDeletedOrSrc = rec.status === 'D' || ((rec.status === 'R' || rec.status === 'C') && p === rec.src);
      if (isDeletedOrSrc) {
        try {
          g(repo, 'cat-file', '-e', `${baseRefSha}:${p}`);
        } catch {
          return { ok: false, kind: 'scope_violation', error: `Deleted path did not exist in baseline: ${p}` };
        }
      } else {
        const fullPath = join(worktreePath, p);
        try {
          const st = lstatSync(fullPath);
          if (st.isSymbolicLink()) {
            const rawTarget = readlinkSync(fullPath);
            let finalReal;
            try {
              finalReal = realpathSync(fullPath);
            } catch {
              return { ok: false, kind: 'scope_violation', error: `Dangling symlink rejected: ${p} -> ${rawTarget}` };
            }
            if (!finalReal.startsWith(realWorktree + path.sep) && finalReal !== realWorktree) {
              return { ok: false, kind: 'scope_violation', error: `Physical containment escape (symlink target): ${p} -> ${rawTarget}` };
            }
          } else {
            const real = realpathSync(fullPath);
            if (!real.startsWith(realWorktree + path.sep) && real !== realWorktree) {
              return { ok: false, kind: 'scope_violation', error: `Physical containment escape: ${p}` };
            }
          }
        } catch (err) {
          return { ok: false, kind: 'scope_violation', error: `Cannot inspect path ${p}: ${err.message}` };
        }
      }

      if (ticket.rails?.some((r) => globMatch(r, p))) {
        return { ok: false, kind: 'rail_violation', error: `rail violation (read-only paths edited, per adlc rails-guard): ${p}` };
      }

      if (ticket.scope?.length && !ticket.scope.some((g) => globMatch(g, p))) {
        return { ok: false, kind: 'scope_violation', error: `Out-of-scope change: ${p}` };
      }
    }
  }

  if (changedPaths.length === 0) {
    return { ok: false, kind: 'empty_diff', error: 'zero changes against baseline commit' };
  }

  return { ok: true, changedFiles: [...new Set(changedPaths)] };
}

/**
 * ADLC C6: after a strike fails, check the ACCUMULATED builder log for a
 * genuine flail pattern. Fails OPEN.
 */
export async function checkFlailDetector({ logFile, scope, adlcBin, cwd }) {
  if (!existsSync(logFile)) return { detected: false, signals: [] };
  let tmpDirToClean = null;
  let targetFile = logFile;

  if (logFile.endsWith('.jsonl')) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');

    try {
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      targetFile = join(tmpdir(), `flail-${randomUUID()}.log`);
      tmpDirToClean = targetFile;
      let legacyContent = '';

      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o.role !== 'builder') continue;
          const header = { ts: o.ts, model: o.model, cwd: o.cwd, ms: o.ms, ok: o.ok, error: o.error, kind: o.kind };
          for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k];

          const safePrompt = String(o.prompt || '')
            .replace(/(^|\r\n|\r|\n)===(?=\r\n|\r|\n|$)/g, '$1_=_')
            .replace(/(^|\r\n|\r|\n)---PROMPT---(?=\r\n|\r|\n|$)/g, '$1_-_PROMPT_-_')
            .replace(/(^|\r\n|\r|\n)---OUTPUT---(?=\r\n|\r|\n|$)/g, '$1_-_OUTPUT_-_');
          const safeOut = String(o.output || '')
            .replace(/(^|\r\n|\r|\n)===(?=\r\n|\r|\n|$)/g, '$1_=_')
            .replace(/(^|\r\n|\r|\n)---PROMPT---(?=\r\n|\r|\n|$)/g, '$1_-_PROMPT_-_')
            .replace(/(^|\r\n|\r|\n)---OUTPUT---(?=\r\n|\r|\n|$)/g, '$1_-_OUTPUT_-_');
          legacyContent += JSON.stringify(header) + '\n---PROMPT---\n' + safePrompt + '\n---OUTPUT---\n' + safeOut + '\n===\n';
        } catch {}
      }
      writeFileSync(targetFile, legacyContent, { mode: 0o600 });
    } catch {}
  }

  const repo = cwd ?? process.cwd();
  const args = [targetFile, '--json'];
  for (const g of scope ?? []) args.push('--scope', g);
  try {
    const res = await runAdlcTool({
      tool: 'flail-detector',
      args,
      cwd: repo,
      timeoutMs: FLAIL_DETECTOR_TIMEOUT_MS,
      adlcBin,
      repo,
    });
    if (!res.ok) {
      return { detected: false, signals: [], error: res.error };
    }
    const parsed = res.parsed;
    return { detected: parsed.verdict === 'flail', signals: parsed.signals ?? [] };
  } finally {
    if (tmpDirToClean) {
      const { rmSync } = await import('node:fs');
      try { rmSync(tmpDirToClean, { recursive: true, force: true }); } catch {}
    }
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Wrap a gate command in the platform OS sandbox (macOS Seatbelt / Linux bwrap)
 * before handing it to `adlc consensus-fix` (which executes `--test-cmd` and
 * `--rails` via `/bin/sh -c`). Fails closed when sandboxing is enabled
 * (`AGB_SANDBOX_GATES !== '0'`) and no OS sandbox is available.
 */
export function wrapConsensusGateCommand(cmd, worktree, { env = process.env, plat = platform(), sandboxTmpDir } = {}) {
  if (env.AGB_SANDBOX_GATES === '0') return { ok: true, cmd };
  if (!sandboxTmpDir || !gateSandboxAvailable(env)) {
    return { ok: false, error: `consensus-fix skipped: gate sandbox unavailable on ${plat}` };
  }
  if (plat === 'darwin') {
    const profileFile = join(sandboxTmpDir, 'gate.sb');
    writeFileSync(profileFile, sandboxProfile(worktree));
    return { ok: true, cmd: ['sandbox-exec', '-f', profileFile, '/bin/sh', '-c', cmd].map(shellQuote).join(' ') };
  }
  const emptyRoDir = join(sandboxTmpDir, 'empty-ro');
  mkdirSync(emptyRoDir, { recursive: true });
  return { ok: true, cmd: ['bwrap', ...linuxBwrapArgs(worktree, cmd, emptyRoDir)].map(shellQuote).join(' ') };
}

/**
 * ADLC C7: fan out N candidate fixes via `adlc consensus-fix` instead of
 * trusting a single regeneration attempt.
 */
export async function runConsensusFix({ worktree, testCmd, railsCmd, files, rails = [], adlcBin }) {
  if (!testCmd || !files.length) {
    return { ok: false, applied: false, error: 'no gate test command or no changed files to fix' };
  }
  const sandboxTmpDir = mkdtempSync(join(tmpdir(), 'agb-cf-sbx-'));
  try {
    const wrappedTest = wrapConsensusGateCommand(testCmd, worktree, { sandboxTmpDir });
    if (!wrappedTest.ok) return { ok: false, applied: false, error: wrappedTest.error };
    const effectiveRailsCmd = railsCmd || (Array.isArray(rails) && rails.length > 0 ? testCmd : null);
    const args = ['--allow-dirty', '--test-cmd', wrappedTest.cmd, '--files', files.join(',')];
    if (effectiveRailsCmd) {
      const wrappedRails = wrapConsensusGateCommand(effectiveRailsCmd, worktree, { sandboxTmpDir });
      args.push('--rails', wrappedRails.cmd, '--require-rails');
    }
    args.push('--apply', '--json');
    const res = await runAdlcTool({
      tool: 'consensus-fix',
      args,
      cwd: worktree,
      timeoutMs: CONSENSUS_FIX_TIMEOUT_MS,
      adlcBin,
      repo: worktree,
    });
    if (!res.ok) {
      return { ok: false, applied: false, error: res.error };
    }
    const parsed = res.parsed;
    return {
      ok: true,
      applied: !!parsed.applied,
      survivors: parsed.survivors?.length ?? 0,
      allDivergent: !!parsed.allDivergent,
    };
  } finally {
    rmSync(sandboxTmpDir, { recursive: true, force: true });
  }
}

/**
 * Record a gate outcome as append-only, attestable evidence (ADLC F5/C-manifest).
 */
export async function recordGate({ repo, gateName, ticketId, data, adlcBin }) {
  const args = ['gate-manifest', 'record', gateName, '--ticket', ticketId];
  if (data !== undefined) args.push('--data', JSON.stringify(data));
  try {
    await execFileAuthenticatedAdlc(adlcBin, args, { cwd: repo, timeout: GATE_MANIFEST_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, { repo });
    return { ok: true };
  } catch (err) {
    console.warn(`[agb] advisory audit gate ${gateName} degraded for ${ticketId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Post-hoc rail check (ADLC C5), calling `adlc rails-guard`. Fails closed.
 */
export async function checkRailsGuard({ worktree, base, rails, adlcBin }) {
  const args = ['--base', base, '--json'];
  for (const r of rails) args.push('--rails', r);
  const res = await runAdlcTool({
    tool: 'rails-guard',
    args,
    cwd: worktree,
    timeoutMs: RAILS_GUARD_TIMEOUT_MS,
    adlcBin,
    repo: worktree,
  });
  if (!res.ok) {
    if (res.exitCode === 0 && res.unparseable) {
      return { violations: ['adlc rails-guard operational error: unparseable --json output'], operationalError: true };
    }
    return { violations: [`adlc rails-guard operational error: ${res.error}`], operationalError: true };
  }
  const parsed = res.parsed;
  if (res.exitCode === 0) {
    if (parsed?.railGlobError) {
      return { violations: [`adlc rails-guard operational error: invalid rail glob: ${parsed.railGlobError}`], operationalError: true };
    }
    return { violations: [] };
  }
  const violations = (parsed?.violations ?? []).map((v) => v.file ?? JSON.stringify(v));
  if (violations.length === 0 || parsed?.railGlobError) {
    return { violations: [`adlc rails-guard operational error: exit without violations${parsed?.railGlobError ? ` (invalid rail glob: ${parsed.railGlobError})` : ''}`], operationalError: true };
  }
  return { violations };
}

/**
 * Live in-session rail enforcement (ADLC P3) contract handshake (B12).
 */
export function checkEnforcementAvailable(repo) {
  if (!existsSync(join(repo, '.adlc'))) {
    return { available: false, reason: 'target repo is not ADLC-initialized (no .adlc/ directory) — live rail enforcement disabled, post-hoc adlc rails-guard still runs' };
  }
  const contract = readPluginContract();
  switch (contract.status) {
    case 'compatible':
      return { available: true, reason: null };
    case 'incompatible':
      return {
        available: false,
        abort: true,
        reason:
          `installed adlc-antigravity plugin declares adlcContract ${contract.contract}, but this ` +
          `antigravity-booster projects contract ${SUPPORTED_PLUGIN_CONTRACT} — refusing to run: a version-skewed ` +
          `plugin would enforce a different tickets/hook contract than the booster generates. ` +
          (contract.contract > SUPPORTED_PLUGIN_CONTRACT
            ? 'Upgrade antigravity-booster so it speaks the newer plugin contract.'
            : 'Upgrade the adlc-antigravity plugin (agb bootstrap) so it speaks the contract this booster projects.'),
      };
    case 'tolerant':
      return { available: false, reason: `installed adlc-antigravity plugin manifest declares no adlcContract field (older plugin) — cannot confirm it speaks booster contract ${SUPPORTED_PLUGIN_CONTRACT}; live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
    case 'unreadable':
    case 'corrupt':
    default:
      return { available: false, reason: `adlc-antigravity plugin manifest unreadable (${contract.error}) — treating as not installed; live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
  }
}
