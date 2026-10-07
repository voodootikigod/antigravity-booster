// Post-run integrity verification (spec Appendix A.6 item 14).
//
// Before dispatch the scheduler snapshots everything a worker could tamper
// with OUTSIDE its worktree that would outlive the run: the tree digests of
// both staged plugins (antigravity-booster and adlc-antigravity) and the hash
// listing of the git hooks directory (`git rev-parse --git-path hooks`, which
// also follows core.hooksPath). After each worker the host snapshot is taken
// again, and the worker's worktree must still have hooks disabled (the
// scheduler sets core.hooksPath to the null device in every worktree). Any
// difference marks the run compromised and blocks every later merge.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeDirectoryDigest } from './digest.mjs';
import { pluginsDirFor, BOOSTER_PLUGIN_NAME, ADLC_ANTIGRAVITY_PLUGIN_NAME } from './plugin-paths.mjs';

const GIT_TIMEOUT_MS = 10_000;
export const ABSENT = 'absent';

function digestOrAbsent(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return ABSENT;
  return computeDirectoryDigest(dir);
}

/** Absolute git hooks dir for `cwd` (relative output is resolved against cwd). */
export function hooksDirFor(cwd) {
  const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return resolve(cwd, out);
}

/**
 * Never throws: { ok: true, snapshot } or { ok: false, error }.
 * snapshot = { plugins: { [name]: digest|'absent' }, hooks: { path, digest } }
 */
export function snapshotRunIntegrity({ cwd, home = homedir() } = {}) {
  try {
    const pluginsDir = pluginsDirFor(home);
    const plugins = {};
    for (const name of [BOOSTER_PLUGIN_NAME, ADLC_ANTIGRAVITY_PLUGIN_NAME]) {
      plugins[name] = digestOrAbsent(join(pluginsDir, name));
    }
    const hooksPath = hooksDirFor(cwd);
    return { ok: true, snapshot: { plugins, hooks: { path: hooksPath, digest: digestOrAbsent(hooksPath) } } };
  } catch (err) {
    return { ok: false, error: `integrity snapshot failed: ${err.message}` };
  }
}

/** Human-readable differences between two snapshots; [] when identical. */
export function diffRunIntegrity(before, after) {
  const diffs = [];
  for (const name of Object.keys(before.plugins)) {
    if (before.plugins[name] !== after.plugins[name]) diffs.push(`staged plugin ${name} changed`);
  }
  if (before.hooks.path !== after.hooks.path) {
    diffs.push(`git hooks dir redirected (${before.hooks.path} -> ${after.hooks.path})`);
  } else if (before.hooks.digest !== after.hooks.digest) {
    diffs.push(`git hooks dir ${before.hooks.path} changed`);
  }
  return diffs;
}

function configuredHooksPath(cwd) {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null; // unset (exit 1) or unreadable: either way not the null device
  }
}

/**
 * Re-snapshot the host (`cwd`, the same repo the baseline came from) and
 * compare; when `worktree` is given, also require its core.hooksPath to still
 * be `worktreeHooksPath`.
 *   { ok: true }                       nothing changed
 *   { ok: false, reasons: [...] }      tampered, or the check itself failed
 *                                      (an unverifiable state is compromised)
 */
export function verifyRunIntegrity(baseline, { cwd, worktree, worktreeHooksPath, home = homedir() } = {}) {
  const now = snapshotRunIntegrity({ cwd, home });
  if (!now.ok) return { ok: false, reasons: [now.error] };
  const reasons = diffRunIntegrity(baseline, now.snapshot);
  if (worktree) {
    const actual = configuredHooksPath(worktree);
    if (actual !== worktreeHooksPath) {
      reasons.push(`worktree core.hooksPath changed (expected ${worktreeHooksPath}, found ${actual ?? 'unset'})`);
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/** A rail glob rails-guard can enforce: non-blank, balanced [] and {}. */
export function isWellFormedRail(rail) {
  if (typeof rail !== 'string' || rail.trim() === '') return false;
  let square = 0;
  let curly = 0;
  for (const ch of rail) {
    if (ch === '[') square += 1;
    else if (ch === ']') square -= 1;
    else if (ch === '{') curly += 1;
    else if (ch === '}') curly -= 1;
    if (square < 0 || curly < 0) return false;
  }
  return square === 0 && curly === 0;
}

/**
 * Spec §4.2 enforcement gate, decided once before dispatch. Pure.
 *   activeRails  unionActiveRails(repo) result
 *   planRails    true when any plan ticket declares rails
 *   adlc         resolveAdlcBinary result (rails-guard's engine)
 * Rails are "present" when the store is unreadable (it might declare some),
 * when an active ticket declares any, or when the plan does. With rails
 * present the run needs an authenticated adlc; otherwise every audit-only
 * gate merely degrades.
 */
export function enforcementGate({ activeRails, planRails, adlc, rails = [] }) {
  const malformed = rails.filter((r) => !isWellFormedRail(r));
  if (malformed.length) {
    return { ok: false, reason: `enforcement gate: malformed rail glob(s) ${JSON.stringify(malformed)} would enforce nothing — refusing to dispatch or merge any ticket` };
  }
  if (!activeRails.ok) {
    return { ok: false, reason: `enforcement gate: ticket store unreadable (${activeRails.error}) — refusing to dispatch or merge any ticket` };
  }
  const railsPresent = planRails || activeRails.rails.length > 0;
  if (railsPresent && !adlc.ok) {
    return { ok: false, reason: `enforcement gate: rails are declared but adlc is not authenticated (${adlc.error}) — refusing to dispatch or merge any ticket` };
  }
  return { ok: true, railsPresent, storeRails: activeRails.rails };
}
