// Scheduler verification helpers: flail detection, consensus-fix fanout,
// gate-manifest recording, post-hoc rails-guard, live-enforcement handshake,
// and authoritative scope & anti-no-op verification.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform, tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { globMatch } from '@adlc/core/tickets';
import { runAdlcTool } from './adlc-tool.mjs';
import { gateSandboxAvailable, sandboxProfile, linuxBwrapArgs } from './gates.mjs';
import { sanitizedGitEnv } from './run-integrity.mjs';
import {
  IS_BUNDLED,
  pluginManifestDir,
  readPluginContract,
  SUPPORTED_PLUGIN_CONTRACT,
  execFileAuthenticatedAdlc,
} from './adlc-bridge.mjs';
import {
  ADLC_ANTIGRAVITY_PLUGIN_NAME,
  ADLC_GEMINI_PLUGIN_NAME,
  pluginsDirFor,
} from './plugin-paths.mjs';

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
      if (p === '.adlc/learned-checks.json' && !(ticket.scope?.some((g) => globMatch(g, p)))) {
        return { ok: false, kind: 'rail_violation', error: 'rail violation (read-only learned checks modified): .adlc/learned-checks.json' };
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
 * Sanitize raw `o.output` from a builder `.jsonl` log before passing to `adlc flail-detector`.
 * When `o.output` contains NDJSON `stream-json` lines:
 *   - Discards `init` and normal `agent_response` `text_delta` token chunks (so source code
 *     or test names containing the word "error" or "fail" never false-positive as error lines).
 *   - Discards passing `run_command` tool outputs (`Command exited with code 0` / `ℹ fail 0`).
 *   - Preserves non-JSON plain-text lines (e.g. `fake-agy` test fixtures) and genuine failed
 *     tool steps.
 */
export function sanitizeBuilderStreamOutputForFlail(rawOutput) {
  if (typeof rawOutput !== 'string' || !rawOutput.trim()) return '';
  const outLines = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const evt = JSON.parse(trimmed);
        if (evt && typeof evt === 'object' && typeof evt.event === 'string') {
          if (evt.event === 'init') continue;
          if (evt.event === 'step_update' && evt.step_update) {
            const su = evt.step_update;
            const st = String(su.step_type || '').toLowerCase();
            const state = String(su.state || '').toUpperCase();
            if (st === 'agent_response' || st === 'user_input' || st === 'system_message') {
              continue;
            }
            if (st === 'tool') {
              if (state !== 'ERROR' && state !== 'FAILED') {
                // Keep only path-bearing parameters for scope/churn checks; strip passing stdout
                const params = su.tool_info?.parameters ?? su.tool_info?.args ?? {};
                const targetPath = params.Path || params.TargetFile || params.filePath || '';
                if (targetPath) {
                  outLines.push(`tool:${su.tool_name || 'tool'} path:${targetPath}`);
                }
                continue;
              }
              const params = su.tool_info?.parameters ?? su.tool_info?.args ?? {};
              const cmdOrPath = String(
                params.CommandLine || params.Path || params.TargetFile || params.query || ''
              )
                .replace(/["']/g, '')
                .replace(/\s+/g, '_')
                .slice(0, 80);
              const errMsg = String(
                su.tool_info?.error?.message || su.tool_info?.error || su.error || su.content || 'tool_error'
              );
              // Skip one-off PreToolUse headless policy denials from counting as identical runtime errors
              // unless the exact same command was retried
              outLines.push(`error [${su.tool_name || 'tool'}:${cmdOrPath}] ${errMsg}`);
              continue;
            }
          }
          if (evt.event === 'result' && evt.result) {
            if (evt.result.status === 'ERROR' && evt.result.error) {
              outLines.push(`Error: ${evt.result.error}`);
            }
            continue;
          }
        }
      } catch {
        // Not valid JSON; fall through and keep raw line
      }
    }
    outLines.push(
      line.replace(/\b(Created|Completed) At:(\s*\d{4}-\d{2}-\d{2}T)/g, '$1_At:$2')
    );
  }
  return outLines.join('\n');
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
          const cleanedOutput = sanitizeBuilderStreamOutputForFlail(String(o.output || ''));
          const safeOut = cleanedOutput
            .replace(/(^|\r\n|\r|\n)===(?=\r\n|\r|\n|$)/g, '$1_=_')
            .replace(/(^|\r\n|\r|\n)---PROMPT---(?=\r\n|\r|\n|$)/g, '$1_-_PROMPT_-_')
            .replace(/(^|\r\n|\r|\n)---OUTPUT---(?=\r\n|\r|\n|$)/g, '$1_-_OUTPUT_-_')
            .replace(/\b(Created|Completed) At:(\s*\d{4}-\d{2}-\d{2}T)/g, '$1_At:$2');
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
    const denyHoldouts = collectHoldoutMaskDirs({ cwd: worktree, env })
      .map((d) => `(deny file-read* (subpath ${JSON.stringify(d)}))`)
      .join('\n');
    writeFileSync(profileFile, `${sandboxProfile(worktree)}\n${denyHoldouts}\n`);
    return { ok: true, cmd: ['sandbox-exec', '-f', profileFile, '/bin/sh', '-c', cmd].map(shellQuote).join(' ') };
  }
  const emptyRoDir = join(sandboxTmpDir, 'empty-ro');
  mkdirSync(emptyRoDir, { recursive: true });
  const baseBwrap = linuxBwrapArgs(worktree, cmd, emptyRoDir);
  const sepIdx = baseBwrap.lastIndexOf('--');
  const tmpfsMasks = collectHoldoutMaskDirs({ cwd: worktree, env }).flatMap((d) => {
    try {
      const st = lstatSync(d);
      return !st.isSymbolicLink() && st.isDirectory() ? ['--tmpfs', d] : [];
    } catch {
      return [];
    }
  });
  return {
    ok: true,
    cmd: ['bwrap', ...baseBwrap.slice(0, sepIdx), ...tmpfsMasks, ...baseBwrap.slice(sepIdx)].map(shellQuote).join(' '),
  };
}

/**
 * Build a command wrapper that executes an arbitrary (command, args) invocation
 * inside the platform OS sandbox (macOS Seatbelt / Linux bwrap) with writes
 * restricted to `worktree` + temp and network denied. Fails closed when
 * `AGB_SANDBOX_GATES !== '0'` and no OS sandbox is available.
 */
export function buildSandboxCommandWrapper(worktree, { env = process.env, plat = platform(), sandboxTmpDir } = {}) {
  if (env.AGB_SANDBOX_GATES === '0') {
    return { ok: true, wrap: (cmd) => cmd };
  }
  if (!sandboxTmpDir || !gateSandboxAvailable(env)) {
    return { ok: false, error: `gate sandbox unavailable on ${plat}` };
  }
  if (plat === 'darwin') {
    const profileFile = join(sandboxTmpDir, 'gate.sb');
    writeFileSync(profileFile, sandboxProfile(worktree));
    return {
      ok: true,
      wrap: ({ command, args, options }) => ({
        command: 'sandbox-exec',
        args: ['-f', profileFile, command, ...args],
        options,
      }),
    };
  }
  const emptyRoDir = join(sandboxTmpDir, 'empty-ro');
  mkdirSync(emptyRoDir, { recursive: true });
  const full = linuxBwrapArgs(worktree, '', emptyRoDir);
  const sepIdx = full.lastIndexOf('--');
  const bwrapPrefix = full.slice(0, sepIdx + 1);
  return {
    ok: true,
    wrap: ({ command, args, options }) => ({
      command: 'bwrap',
      args: [...bwrapPrefix, command, ...args],
      options,
    }),
  };
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
 * Prefers the bundled companion plugin (`adlc-antigravity`); when unconfigured
 * (`AGB_PLUGIN_DIR` unset or bundled) and `adlc-antigravity` is absent, also
 * recognizes an installed `adlc-gemini` companion plugin speaking the same
 * `adlcContract` handshake.
 */
export function checkEnforcementAvailable(repo, { env = process.env, bundled = IS_BUNDLED, home = (bundled ? null : env.AGB_HOME_DIR) || homedir() } = {}) {
  if (!existsSync(join(repo, '.adlc'))) {
    return { available: false, reason: 'target repo is not ADLC-initialized (no .adlc/ directory) — live rail enforcement disabled, post-hoc adlc rails-guard still runs' };
  }
  const primaryDir = pluginManifestDir({ env, bundled, home });
  let pluginName = ADLC_ANTIGRAVITY_PLUGIN_NAME;
  let contract = readPluginContract({ dir: primaryDir });
  if (contract.status === 'unreadable' && !bundled && !env.AGB_PLUGIN_DIR) {
    let primaryAbsent = false;
    try {
      lstatSync(join(primaryDir, 'plugin.json'));
    } catch (err) {
      primaryAbsent = err?.code === 'ENOENT';
    }
    if (primaryAbsent) {
      const geminiDir = join(pluginsDirFor(home), ADLC_GEMINI_PLUGIN_NAME);
      try {
        lstatSync(join(geminiDir, 'plugin.json'));
        pluginName = ADLC_GEMINI_PLUGIN_NAME;
        contract = readPluginContract({ dir: geminiDir });
      } catch {
        // adlc-gemini absent or plugins path inaccessible: retain primary unreadable result
      }
    }
  }
  switch (contract.status) {
    case 'compatible':
      return { available: true, reason: null };
    case 'incompatible':
      return {
        available: false,
        abort: true,
        reason:
          `installed ${pluginName} plugin declares adlcContract ${contract.contract}, but this ` +
          `antigravity-booster projects contract ${SUPPORTED_PLUGIN_CONTRACT} — refusing to run: a version-skewed ` +
          `plugin would enforce a different tickets/hook contract than the booster generates. ` +
          (contract.contract > SUPPORTED_PLUGIN_CONTRACT
            ? 'Upgrade antigravity-booster so it speaks the newer plugin contract.'
            : `Upgrade the ${pluginName} plugin (agb bootstrap) so it speaks the contract this booster projects.`),
      };
    case 'tolerant':
      return { available: false, reason: `installed ${pluginName} plugin manifest declares no adlcContract field (older plugin) — cannot confirm it speaks booster contract ${SUPPORTED_PLUGIN_CONTRACT}; live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
    case 'unreadable':
    case 'corrupt':
    default:
      return { available: false, reason: `${pluginName} plugin manifest unreadable (${contract.error}) — treating as not installed; live rail enforcement disabled, post-hoc adlc rails-guard still runs` };
  }
}

import { buildContextSlice, verifySymbolScopeDiff } from './context-slice.mjs';
import {
  shouldRunTddSplit,
  partitionTddScopes,
  promoteTestsToBuilderRails,
  verifyRedPhaseTests,
} from './tdd-split.mjs';
import {
  deriveImpactedTests,
  planSpeculativeMergeBatches,
  bisectFailedBatch,
} from './test-impact.mjs';
import { BanditModelRouter } from './bandit-router.mjs';
import { syncOverviewPaneState } from './overview-pane.mjs';
import { verifyGateScriptIntegrity } from './plan-integrity.mjs';
import { materializeWorktreeNodeModules, removeMaterializedNodeModules } from './worktrees.mjs';
import { runLearnedChecks } from './distill.mjs';
import {
  collectHoldoutMaskDirs,
  shouldRunHoldoutScenarios,
  resolveHoldoutDir,
  stageHoldoutScenarios,
  listHoldoutScenarios,
  runHoldoutScenarios,
} from './holdout.mjs';
import { startDigitalTwins } from './twins.mjs';
import { selectRiskTieredProsecutor } from './models.mjs';

export {
  buildContextSlice,
  verifySymbolScopeDiff,
  shouldRunTddSplit,
  partitionTddScopes,
  promoteTestsToBuilderRails,
  verifyRedPhaseTests,
  deriveImpactedTests,
  planSpeculativeMergeBatches,
  bisectFailedBatch,
  BanditModelRouter,
  syncOverviewPaneState,
  selectRiskTieredProsecutor,
};

/**
 * Select a cross-family prosecutor before acquiring a quota pool lease using
 * the precheck's blast radius and ticket tier.
 */
export function selectPreLeaseProsecutor(
  builderModel,
  { precheck = null, ticket = {}, pools = null } = {}
) {
  return selectRiskTieredProsecutor(builderModel, {
    blastRadius: precheck?.blastRadius?.level ?? 'high',
    ticketTier: ticket?.tier ?? 'mid',
    pools,
  });
}

/**
 * Wave 4 Dark-Factory P5 post-gate checks:
 *   1. Deterministic `.adlc/learned-checks.json` evaluation (loaded from trusted host `repo`,
 *      evaluated over `changedFiles` in `worktree`).
 *   2. Sealed Holdout Scenarios (`shouldRunHoldoutScenarios(ticket, plan)`): stages inline
 *      `ticket.holdout_scenarios`, discovers pre-staged `<plugin_data>/holdouts/...` suites,
 *      or invokes `authorHoldoutFn` once per ticket, then runs `runHoldoutScenarios` inside
 *      the OS sandbox and returns ONLY sanitized behavioral symptoms on failure.
 */
export async function executePostGateDarkFactoryChecks({
  repo,
  worktree,
  ticket = {},
  plan = {},
  runId = 'default',
  changedFiles = [],
  runAdlcBin,
  twinHandle = null,
  authoredHoldoutCache = new Map(),
  authorHoldoutFn = null,
  sandbox = true,
  env = process.env,
} = {}) {
  // 1. Executable Learned Invariants (.adlc/learned-checks.json on trusted host repo)
  const hostChecksPath = join(repo, '.adlc', 'learned-checks.json');
  const lcRes = runLearnedChecks(worktree, {
    changedFiles,
    checksPath: hostChecksPath,
  });
  if (!lcRes.ok) {
    await recordGate({
      repo,
      gateName: 'learned-checks',
      ticketId: ticket.id,
      data: {
        ok: false,
        violations: lcRes.violations?.length ?? 0,
        error: lcRes.error ?? null,
      },
      adlcBin: runAdlcBin,
    });
    const detail = lcRes.error
      ? lcRes.error
      : (lcRes.violations ?? [])
          .slice(0, 10)
          .map((v) => `  - [${v.checkId}] ${v.file}:${v.line}: ${v.description}`)
          .join('\n');
    return {
      ok: false,
      kind: 'learned_checks_failed',
      error: `learned-checks gate failed:\n${detail}`,
    };
  }
  if (lcRes.exists) {
    await recordGate({
      repo,
      gateName: 'learned-checks',
      ticketId: ticket.id,
      data: { ok: true, checkedFiles: lcRes.checkedFiles },
      adlcBin: runAdlcBin,
    });
  }

  // 2. Sealed Holdout Scenarios
  if (!shouldRunHoldoutScenarios(ticket, plan)) {
    return { ok: true };
  }

  let cached = authoredHoldoutCache.get(ticket.id) ?? null;
  if (!cached) {
    if (Array.isArray(ticket.holdout_scenarios) && ticket.holdout_scenarios.length > 0) {
      const st = stageHoldoutScenarios({
        repo,
        runId,
        ticketId: ticket.id,
        scenarios: ticket.holdout_scenarios,
        env,
      });
      if (!st.ok) {
        return {
          ok: false,
          kind: 'holdout_staging_failed',
          tampered: Boolean(st.tampered),
          error: `sealed holdout staging failed: ${st.error}`,
        };
      }
      cached = { mode: 'explicit', files: st.files };
      authoredHoldoutCache.set(ticket.id, cached);
    } else {
      let existingFiles = [];
      for (const candidateRunId of [runId, 'default']) {
        try {
          const listed = listHoldoutScenarios({
            repo,
            runId: candidateRunId,
            ticketId: ticket.id,
            env,
          });
          if (listed.ok && listed.suites.length > 0) {
            const suiteDir = resolveHoldoutDir({
              repo,
              runId: candidateRunId,
              ticketId: ticket.id,
              env,
            });
            existingFiles = listed.suites[0].files.map((f) => join(suiteDir, f.filename));
            break;
          }
        } catch (err) {
          if (err?.code === 'ESYMLINK') {
            return {
              ok: false,
              kind: 'holdout_failed',
              tampered: true,
              error: `Holdout store integrity violation: ${err.message}`,
            };
          }
        }
      }

      if (existingFiles.length > 0) {
        cached = { mode: 'explicit', files: existingFiles };
        authoredHoldoutCache.set(ticket.id, cached);
      } else if (typeof authorHoldoutFn === 'function') {
        const authRes = await authorHoldoutFn(ticket);
        if (authRes?.ok && Array.isArray(authRes.files) && authRes.files.length > 0) {
          cached = { mode: 'authored', files: authRes.files };
        } else {
          await recordGate({
            repo,
            gateName: 'holdout-author',
            ticketId: ticket.id,
            data: { skipped: true, reason: authRes?.reason || 'unavailable' },
            adlcBin: runAdlcBin,
          });
          cached = { mode: 'degraded', files: [] };
        }
        authoredHoldoutCache.set(ticket.id, cached);
      } else {
        cached = { mode: 'degraded', files: [] };
        authoredHoldoutCache.set(ticket.id, cached);
      }
    }
  }

  if (!cached || !Array.isArray(cached.files) || cached.files.length === 0) {
    return { ok: true };
  }

  const materialized =
    worktree !== repo ? materializeWorktreeNodeModules(worktree, join(repo, 'node_modules')) : false;
  let ownedTwinHandle = null;
  let holdoutRes;
  try {
    const activeTwinHandle =
      twinHandle ??
      (Array.isArray(plan?.gate?.twins) && plan.gate.twins.length > 0
        ? (ownedTwinHandle = await startDigitalTwins(plan.gate.twins))
        : null);
    holdoutRes = await runHoldoutScenarios(cached.files, {
      candidateWorktree: worktree,
      sandbox,
      cleanScratch: worktree !== repo,
      twinHandle: activeTwinHandle,
      env,
    });
  } finally {
    if (ownedTwinHandle) {
      try { await ownedTwinHandle.stop(); } catch {}
    }
    if (materialized) removeMaterializedNodeModules(worktree);
  }

  await recordGate({
    repo,
    gateName: 'holdout',
    ticketId: ticket.id,
    data: {
      ok: holdoutRes.ok,
      passedCount: holdoutRes.passedCount,
      failedCount: holdoutRes.failedCount,
      tampered: Boolean(holdoutRes.tampered),
    },
    adlcBin: runAdlcBin,
  });

  if (!holdoutRes.ok) {
    return {
      ok: false,
      kind: 'holdout_failed',
      tampered: Boolean(holdoutRes.tampered),
      sandboxRefused: Boolean(holdoutRes.sandboxRefused),
      error: holdoutRes.summary,
    };
  }

  return { ok: true };
}

/**
 * v1.4 delegation wrapper: verify additive `ticket.symbol_scope` and `ticket.symbol_rails`
 * against a candidate worktree diff.
 */
export function runSymbolScopeVerification(ticket = {}, diffText = '', { repo = process.cwd() } = {}) {
  const symbolScope = Array.isArray(ticket?.symbol_scope) ? ticket.symbol_scope : [];
  const symbolRails = Array.isArray(ticket?.symbol_rails) ? ticket.symbol_rails : [];
  if (symbolScope.length === 0 && symbolRails.length === 0) {
    return { ok: true, violations: [] };
  }
  return verifySymbolScopeDiff(diffText, { symbolScope, symbolRails, repo });
}

/**
 * v1.4 delegation wrapper: pre-bake CodeGraph/static-AST context slice and evaluate
 * whether Cross-Pool Adversarial TDD Split applies to `ticket`.
 */
export function prepareTicketContextAndTdd(
  ticket = {},
  plan = {},
  { repo = process.cwd(), rootRepo = null, builderModel = '', writeArtifact = true, enabled } = {}
) {
  const contextSlice = buildContextSlice(ticket, {
    repo,
    rootRepo: rootRepo ?? repo,
    worktree: repo,
    writeArtifact,
    enabled,
  });
  const tddEnabled = shouldRunTddSplit(ticket, plan);
  const tddPartition = tddEnabled
    ? partitionTddScopes(ticket, { builderModel })
    : null;
  return {
    contextSlice,
    tddEnabled,
    tddPartition,
  };
}

/**
 * v1.4 delegation wrapper: resolve Strike-0 delta test gate vs. full final-merge gate.
 */
export function resolveTicketGateConfig(
  planGate = {},
  changedFiles = [],
  { repo = process.cwd(), rootRepo = null, phase = 'strike0', deltaGates = true, enabled } = {}
) {
  const fullTestCmd = planGate?.test || 'npm test';
  if (phase === 'merge' || !deltaGates || !Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { ...planGate, test: fullTestCmd, fast: false, testFiles: [] };
  }
  const impact = deriveImpactedTests(changedFiles, {
    repo,
    rootRepo: rootRepo ?? repo,
    fallbackTestCmd: fullTestCmd,
    enabled,
  });
  return {
    ...planGate,
    test: impact.testCmd,
    fast: impact.fast,
    testFiles: impact.testFiles,
  };
}

/**
 * v1.4 delegation wrapper: group ready tickets into conflict-free speculative merge
 * batches and execute `batchGateRunner(batch)` with automatic $O(\log k)$ bisection
 * fallback when a multi-ticket batch gate fails.
 */
export async function executeSpeculativeMergeBatch(
  readyTickets = [],
  batchGateRunner,
  { repo = process.cwd(), maxBatchSize = 4 } = {}
) {
  const initialBatches = planSpeculativeMergeBatches(readyTickets, { repo, maxBatchSize });
  const merged = [];
  const failed = [];

  const processBatch = async (batch) => {
    if (!batch || batch.length === 0) return;
    const res = await batchGateRunner(batch);
    if (res?.ok) {
      for (const t of batch) merged.push(t.id ?? t);
      return;
    }
    if (batch.length === 1) {
      const single = batch[0];
      failed.push({ id: single.id ?? single, error: res?.error || 'batch merge gate failed' });
      return;
    }
    const [left, right] = bisectFailedBatch(batch);
    await processBatch(left);
    await processBatch(right);
  };

  for (const batch of initialBatches) {
    await processBatch(batch);
  }

  return { merged, failed, batches: initialBatches.length };
}

const AUTOFIX_CLEAN_EXCLUDES = Object.freeze([
  ':(exclude)AGENTS.md',
  ':(exclude).adlc',
  ':(exclude).adlc/**',
  ':(exclude).booster',
  ':(exclude).booster/**',
  ':(exclude).agb_home',
  ':(exclude).agb_home/**',
  ':(exclude)node_modules',
  ':(exclude)node_modules/**',
]);

function isExcludedProjectionPath(relPath) {
  return (
    relPath === 'AGENTS.md' ||
    relPath === '.adlc' ||
    relPath.startsWith('.adlc/') ||
    relPath === '.booster' ||
    relPath.startsWith('.booster/') ||
    relPath === '.agb_home' ||
    relPath.startsWith('.agb_home/') ||
    relPath === 'node_modules' ||
    relPath.startsWith('node_modules/')
  );
}

function hasSymlinkAlongRelPath(rootDir, relPath) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  let cur = rootDir;
  for (const seg of parts) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function parsePorcelainZ(buf) {
  const tokens = buf.toString('utf8').split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const token = tokens[i];
    const xy = token.slice(0, 2);
    const filePath = token.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') {
      const origPath = tokens[i + 1] || '';
      entries.push({ xy, path: filePath, origPath });
      i += 2;
    } else {
      entries.push({ xy, path: filePath, origPath: null });
      i += 1;
    }
  }
  return entries;
}

/**
 * Stripe-Minions-style deterministic `gate.autofix` blueprint node.
 * Runs post-candidate-commit (`preAutofixSha`), verifies `HEAD` immutability immediately
 * after execution, selectively stages changes ONLY on `builderChangedFiles` plus newly
 * created untracked in-scope non-rail files, purges incidental out-of-scope and gitignored
 * side effects, and rolls back cleanly to `preAutofixSha` on any error.
 */
export async function runDeterministicAutofixNode({
  repo,
  worktreePath,
  baseRefSha,
  preAutofixSha,
  builderChangedFiles = [],
  baselinePkg = null,
  ticket = {},
  gate = null,
  runSandboxedCmd,
} = {}) {
  const baseChanged = Array.isArray(builderChangedFiles) ? [...builderChangedFiles] : [];
  if (
    !gate?.autofix ||
    typeof gate.autofix !== 'string' ||
    !gate.autofix.trim() ||
    !preAutofixSha ||
    preAutofixSha === baseRefSha ||
    typeof runSandboxedCmd !== 'function'
  ) {
    return { ok: true, applied: false, headSha: preAutofixSha, changedFiles: baseChanged };
  }

  let canonWorktree = worktreePath ? resolve(worktreePath) : '';
  let canonRepo = repo ? resolve(repo) : '';
  try { if (worktreePath && existsSync(worktreePath)) canonWorktree = realpathSync(worktreePath); } catch {}
  try { if (repo && existsSync(repo)) canonRepo = realpathSync(repo); } catch {}
  if (!canonWorktree || !canonRepo || canonWorktree === canonRepo) {
    return {
      ok: false,
      rolledBack: false,
      headSha: preAutofixSha,
      changedFiles: baseChanged,
      reason: 'autofix_refused_root_repo',
      error: 'refusing to execute gate.autofix directly in root repository',
    };
  }

  const gitEnv = sanitizedGitEnv();
  const g = (cwd, ...args) =>
    execFileSync('git', ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, ...args], {
      cwd,
      encoding: 'utf8',
      env: gitEnv,
    }).trim();

  if (baselinePkg) {
    try {
      const candPkgPath = join(worktreePath, 'package.json');
      if (!existsSync(candPkgPath)) {
        throw new Error('candidate deleted package.json');
      }
      const candPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
      verifyGateScriptIntegrity(candPkg, baselinePkg, gate.autofix);
    } catch (err) {
      return {
        ok: false,
        tampered: true,
        rolledBack: false,
        headSha: preAutofixSha,
        changedFiles: baseChanged,
        error: err.message,
      };
    }
  }

  const cleanIgnoredAndUntracked = () => {
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'clean', '-fdx', '--', ...AUTOFIX_CLEAN_EXCLUDES],
      { cwd: worktreePath, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  };

  const rollbackToPreAutofix = () => {
    try {
      execFileSync(
        'git',
        ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'reset', '--hard', preAutofixSha],
        { cwd: worktreePath, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      cleanIgnoredAndUntracked();
      const verifiedSha = g(worktreePath, 'rev-parse', 'HEAD');
      if (verifiedSha !== preAutofixSha) {
        return {
          ok: false,
          fatalRollbackError: true,
          error: `rollback HEAD mismatch: expected ${preAutofixSha}, got ${verifiedSha}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        fatalRollbackError: true,
        error: `autofix rollback failed: ${err.message}`,
      };
    }
  };

  let cmdRes;
  try {
    cmdRes = await runSandboxedCmd(gate.autofix, worktreePath);
  } catch (err) {
    const rb = rollbackToPreAutofix();
    if (rb.fatalRollbackError) return rb;
    return {
      ok: false,
      rolledBack: true,
      headSha: preAutofixSha,
      changedFiles: baseChanged,
      reason: 'autofix_exception',
      error: err.message,
    };
  }

  let postCmdSha;
  try {
    postCmdSha = g(worktreePath, 'rev-parse', 'HEAD');
  } catch (err) {
    const rb = rollbackToPreAutofix();
    if (rb.fatalRollbackError) return rb;
    return {
      ok: false,
      rolledBack: true,
      headSha: preAutofixSha,
      changedFiles: baseChanged,
      reason: 'autofix_git_corrupted',
      error: err.message,
    };
  }

  if (postCmdSha !== preAutofixSha || !cmdRes?.ok) {
    const rb = rollbackToPreAutofix();
    if (rb.fatalRollbackError) return rb;
    return {
      ok: false,
      rolledBack: true,
      headSha: preAutofixSha,
      changedFiles: baseChanged,
      reason: postCmdSha !== preAutofixSha ? 'autofix_mutated_head' : 'autofix_failed',
    };
  }

  try {
    // Wipe any index staging performed by the autofix script itself (`git add`)
    // before inspecting working-tree modifications against preAutofixSha.
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'reset', '-q', preAutofixSha, '--', '.'],
      { cwd: worktreePath, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const statusBuf = execFileSync(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'status', '--porcelain=v1', '-z', '-uall'],
      { cwd: worktreePath, env: gitEnv }
    );
    const statusEntries = parsePorcelainZ(statusBuf);
    const builderSet = new Set(baseChanged.map((p) => String(p).replace(/\\/g, '/')));
    const scopeGlobs = Array.isArray(ticket?.scope) ? ticket.scope : [];
    const railGlobs = Array.isArray(ticket?.rails) ? ticket.rails : [];

    const eligiblePaths = [];
    const ineligibleTrackedPaths = [];

    for (const ent of statusEntries) {
      const p = String(ent.path || '').replace(/\\/g, '/');
      if (!p || isExcludedProjectionPath(p)) continue;
      const norm = path.posix.normalize(p);
      const safeRel =
        norm === p &&
        !p.startsWith('/') &&
        !p.startsWith('\\') &&
        !p.split('/').some((s) => s === '.' || s === '..');
      const matchesRail = railGlobs.some((r) => globMatch(r, p));
      const isSymlink = !safeRel || hasSymlinkAlongRelPath(worktreePath, p);

      if (safeRel && !matchesRail && !isSymlink) {
        if (builderSet.has(p) && ent.xy !== '??') {
          eligiblePaths.push(p);
          continue;
        }
        if (
          ent.xy === '??' &&
          (scopeGlobs.length === 0 || scopeGlobs.some((gl) => globMatch(gl, p)))
        ) {
          eligiblePaths.push(p);
          continue;
        }
      }

      if (ent.xy !== '??') {
        ineligibleTrackedPaths.push(p);
        if (ent.origPath) ineligibleTrackedPaths.push(ent.origPath);
      }
    }

    if (ineligibleTrackedPaths.length > 0) {
      execFileSync(
        'git',
        ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'checkout', preAutofixSha, '--', ...new Set(ineligibleTrackedPaths)],
        { cwd: worktreePath, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }

    if (eligiblePaths.length > 0) {
      execFileSync(
        'git',
        ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'add', '-A', '--', ...new Set(eligiblePaths)],
        { cwd: worktreePath, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }

    cleanIgnoredAndUntracked();

    const stagedNames = g(worktreePath, 'diff', '--cached', '--name-only');
    if (!stagedNames) {
      return { ok: true, applied: false, headSha: preAutofixSha, changedFiles: baseChanged };
    }

    execFileSync(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, 'commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'agb: deterministic autofix'],
      { cwd: worktreePath, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const postCheck = verifyScopeAndAntiNoOp(repo, worktreePath, baseRefSha, ticket);
    if (!postCheck.ok) {
      const rb = rollbackToPreAutofix();
      if (rb.fatalRollbackError) return rb;
      return {
        ok: false,
        rolledBack: true,
        headSha: preAutofixSha,
        changedFiles: baseChanged,
        reason: postCheck.error || 'post_autofix_scope_failed',
      };
    }

    if (baselinePkg) {
      const candPkgPath = join(worktreePath, 'package.json');
      if (!existsSync(candPkgPath)) {
        const rb = rollbackToPreAutofix();
        if (rb.fatalRollbackError) return rb;
        return {
          ok: false,
          rolledBack: true,
          headSha: preAutofixSha,
          changedFiles: baseChanged,
          reason: 'autofix_deleted_package_json',
        };
      }
      const postCandPkg = JSON.parse(readFileSync(candPkgPath, 'utf8'));
      for (const cmd of [gate?.autofix, gate?.build, gate?.test].filter(Boolean)) {
        verifyGateScriptIntegrity(postCandPkg, baselinePkg, cmd);
      }
    }

    const newHeadSha = g(worktreePath, 'rev-parse', 'HEAD');
    return {
      ok: true,
      applied: true,
      headSha: newHeadSha,
      changedFiles: postCheck.changedFiles,
    };
  } catch (err) {
    const rb = rollbackToPreAutofix();
    if (rb.fatalRollbackError) return rb;
    return {
      ok: false,
      rolledBack: true,
      headSha: preAutofixSha,
      changedFiles: baseChanged,
      reason: 'autofix_postcheck_failed',
      error: err.message,
    };
  }
}

