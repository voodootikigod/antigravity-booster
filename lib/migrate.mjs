// `agb migrate` / `agb migrate --rollback`: move an npm-global or checkout
// install onto the native agy plugin, with a snapshot that can always be
// rolled back (spec .adlc/specs/native-plugin-installation.md §4.6 and the
// Normative Rollback-from-Each-State Table, Appendix A D13, A.4 items 21-25,
// A.6 items 18-19).
//
// Layout (all under ~/.gemini/antigravity-cli/plugin_data/antigravity-booster/):
//   migration-state.json                    single state file
//   .migration.lock.d/                      lib/migration-lock.mjs
//   snapshots/<stamp>/plugins/<name>/       plugin trees (D13 exclusions)
//   snapshots/<stamp>/shim/agb              previous ~/.local/bin/agb
//   snapshots/<stamp>/import_manifest.json  previous booster/adlc entries
//   snapshots/<stamp>/pre-migration.baseline.json   written once, read-only
//
// Every restore reads from the baseline snapshot directory only.
//
// Functions return an exit code (0 ok, 1 failure) and never throw.
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync, readlinkSync,
  symlinkSync, unlinkSync, renameSync, chmodSync, copyFileSync, realpathSync, statSync, mkdtempSync,
} from 'node:fs';
import { join, dirname, resolve, sep, isAbsolute, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  acquireMigrationLock, assertMigrationLockHeld, releaseMigrationLock, invalidateMigrationLockToken,
  readMigrationState, writeMigrationState, clearMigrationState, boosterDataDir, breakMigrationLock, finishUninstall,
  UNINSTALLER_DIR_PREFIX,
} from './migration-lock.mjs';
import {
  safePluginInstall, installAdlcAntigravityFromVendor, installTerminalShim, copyPluginTree, pluginsDirFor,
  resolveAgyBinary, resolvePluginRoot, BOOSTER_PLUGIN_NAME, ADLC_ANTIGRAVITY_PLUGIN_NAME,
  INSTALL_COPY_EXCLUSIONS, BUNDLED_ADLC_ANTIGRAVITY_VERSION,
} from './plugin-paths.mjs';
import { computeDirectoryDigest } from './digest.mjs';

export const SNAPSHOT_SIZE_CAP_BYTES = 100 * 1024 * 1024;
export const HANDOVER_TIMEOUT_MS = 2000;
const PLUGIN_NAMES = [BOOSTER_PLUGIN_NAME, ADLC_ANTIGRAVITY_PLUGIN_NAME];
const BOOSTER_CATEGORIES = ['skills', 'agents', 'commands', 'mcpServers', 'hooks'];
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const VIRGIN_RESET_STATES = new Set(['SNAPSHOT_CREATED', 'SYMLINKS_RECORDED']);

const COMPLETION_NOTICE = 'Migration successful. Global npm package may be uninstalled: npm uninstall -g antigravity-booster. ' +
  'CLI commands remain available via ~/.local/bin/agb and slash commands (/agb-doctor, /agb-bootstrap, /agb-migrate).';

class MigrateError extends Error {}

// ---------------------------------------------------------------------------
// Paths and small helpers
// ---------------------------------------------------------------------------

function paths(home) {
  const data = boosterDataDir(home);
  return {
    data,
    snapshots: join(data, 'snapshots'),
    plugins: pluginsDirFor(home),
    importManifest: join(home, '.gemini', 'config', 'import_manifest.json'),
    skills: join(home, '.gemini', 'skills'),
    shim: join(home, '.local', 'bin', 'agb'),
  };
}

function newSnapshotDir(p) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = join(p.snapshots, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const isUnder = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(tmp, file);
}

/** Size of a tree in bytes, honouring the D13 exclusions. Symlinks count 0. */
export function treeSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (INSTALL_COPY_EXCLUSIONS.includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) total += treeSize(full);
    else if (e.isFile()) total += statSync(full).size;
  }
  return total;
}

function digestOrNull(dir) {
  try { return existsSync(dir) ? computeDirectoryDigest(dir) : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// agy plugin validate
// ---------------------------------------------------------------------------

/** Parse `agy plugin validate` output into { category: processedCount }. */
export function parseValidateOutput(text) {
  const counts = {};
  const clean = String(text ?? '').replace(ANSI_SGR, '');
  for (const m of clean.matchAll(/^\s*✔\s+(\w+)\s*:\s*(\d+)\s+processed/gm)) counts[m[1]] = Number(m[2]);
  return counts;
}

function agyValidate(agyBin, dir, home) {
  try {
    const out = execFileSync(agyBin, ['plugin', 'validate', dir], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: { ...process.env, HOME: home },
    });
    return { ok: true, counts: parseValidateOutput(out) };
  } catch (err) {
    return { ok: false, error: `agy plugin validate ${dir} failed: ${String(err.stderr || err.message).trim()}` };
  }
}

function validateBooster(agyBin, dir, home) {
  const v = agyValidate(agyBin, dir, home);
  if (!v.ok) return v;
  const missing = BOOSTER_CATEGORIES.filter((c) => !(v.counts[c] > 0));
  return missing.length ? { ok: false, error: `agy plugin validate ${dir} is missing component categories: ${missing.join(', ')}` } : v;
}

// ---------------------------------------------------------------------------
// import_manifest.json entries for our two plugins
// ---------------------------------------------------------------------------

/**
 * null when the manifest is absent. A manifest that exists but does not parse
 * or has no imports[] array is an error: rewriting it would drop every
 * third-party plugin entry.
 */
function readImports(p) {
  if (!existsSync(p.importManifest)) return null;
  let m;
  try { m = JSON.parse(readFileSync(p.importManifest, 'utf8')); } catch (e) {
    throw new MigrateError(`${p.importManifest} is not valid JSON (${e.message}); fix or restore it, then re-run`);
  }
  if (!m || typeof m !== 'object' || !Array.isArray(m.imports)) {
    throw new MigrateError(`${p.importManifest} has no imports[] array; fix or restore it, then re-run`);
  }
  return m;
}

function ourEntries(p) {
  return (readImports(p)?.imports ?? []).filter((e) => PLUGIN_NAMES.includes(e?.name));
}

/** Replace our plugins' entries with `entries`, leaving third-party entries untouched. */
function restoreImportEntries(p, entries, { keep = [] } = {}) {
  const m = readImports(p);
  if (!m && entries.length === 0) return;
  const base = m ?? { imports: [] };
  const others = base.imports.filter((e) => !PLUGIN_NAMES.includes(e?.name) || keep.includes(e?.name));
  const restored = entries.filter((e) => !keep.includes(e?.name));
  writeJsonAtomic(p.importManifest, { ...base, imports: [...others, ...restored] });
}

// ---------------------------------------------------------------------------
// ~/.gemini/skills symlinks (A.4 item 22, A.6 item 18)
// ---------------------------------------------------------------------------

export function scanSkillSymlinks(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const links = [];
  for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) links.push({ name: e.name, target: readlinkSync(join(skillsDir, e.name)) });
  }
  return links.sort((a, b) => a.name.localeCompare(b.name));
}

function npmGlobalRoot() {
  try {
    return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}

function realOrResolved(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** Nearest existing ancestor whose package.json is named antigravity-booster. */
function boosterCheckoutFor(target) {
  let dir = dirname(target);
  while (dir && dir !== dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && readJson(pkg, {})?.name === BOOSTER_PLUGIN_NAME) return dir;
    dir = dirname(dir);
  }
  return null;
}

/**
 * True when a skill link points into booster- or adlc-owned territory (A.6
 * item 18). User-skill links are never classified as owned.
 */
export function isOwnedSkillLink(link, { skillsDir, home, npmRoot }) {
  const raw = isAbsolute(link.target) ? link.target : resolve(skillsDir, link.target);
  const target = realOrResolved(raw);
  const roots = [
    join(pluginsDirFor(home), BOOSTER_PLUGIN_NAME),
    join(pluginsDirFor(home), ADLC_ANTIGRAVITY_PLUGIN_NAME),
  ];
  if (npmRoot) roots.push(join(npmRoot, BOOSTER_PLUGIN_NAME));
  if ([raw, target].some((t) => roots.some((r) => isUnder(t, realOrResolved(r)) || isUnder(t, r)))) return true;
  if ([raw, target].some((t) => t.split(sep).join('/').includes('/node_modules/@adlc/antigravity/') ||
    t.split(sep).join('/').endsWith('/node_modules/@adlc/antigravity'))) return true;
  for (const t of [raw, target]) {
    const checkout = boosterCheckoutFor(t);
    if (checkout && isUnder(t, join(checkout, 'skills'))) return true;
  }
  return false;
}

function recreateSymlinks(p, links, log) {
  mkdirSync(p.skills, { recursive: true });
  for (const { name, target } of links) {
    const at = join(p.skills, name);
    let present = false;
    try { lstatSync(at); present = true; } catch { /* absent */ }
    if (present) continue;
    const resolved = isAbsolute(target) ? target : resolve(p.skills, target);
    if (!existsSync(resolved)) {
      log(`Notice: Symlink target ${target} missing; skipping dangling link`);
      continue;
    }
    symlinkSync(target, at);
  }
}

// ---------------------------------------------------------------------------
// Plugin directory restore
// ---------------------------------------------------------------------------

function restorePluginDir(p, name, fromDir) {
  const dest = join(p.plugins, name);
  const tmp = join(p.plugins, `.${name}.restore-${process.pid}-${randomBytes(3).toString('hex')}`);
  mkdirSync(p.plugins, { recursive: true });
  copyPluginTree(fromDir, tmp);
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
}

function agyUninstall(agyBin, name, home) {
  execFileSync(agyBin, ['plugin', 'uninstall', name], {
    stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000, env: { ...process.env, HOME: home },
  });
}

// ---------------------------------------------------------------------------
// Forward migration steps
// ---------------------------------------------------------------------------

function step3Snapshot(ctx, state) {
  const { p, home } = ctx;
  for (const name of PLUGIN_NAMES) {
    const dir = join(p.plugins, name);
    if (existsSync(dir) && treeSize(dir) > SNAPSHOT_SIZE_CAP_BYTES) {
      throw new MigrateError(`staged plugin ${dir} exceeds ${SNAPSHOT_SIZE_CAP_BYTES / 1024 / 1024} MB after excluding ` +
        `${INSTALL_COPY_EXCLUSIONS.join(', ')}; remove large files from it (or reinstall it cleanly) and re-run agb migrate`);
    }
  }
  for (const name of PLUGIN_NAMES) {
    const present = INSTALL_COPY_EXCLUSIONS.filter((x) => existsSync(join(p.plugins, name, x)));
    if (present.length) {
      ctx.warn(`warning: ${join(p.plugins, name)} contains ${present.join(', ')}; these are not snapshotted ` +
        '(spec D13) and will not come back on rollback. Copy them elsewhere first if you need them.');
    }
  }
  const snap = newSnapshotDir(p);
  const plugins = {};
  for (const name of PLUGIN_NAMES) {
    const dir = join(p.plugins, name);
    plugins[name] = { previouslyAbsent: !existsSync(dir) };
    if (existsSync(dir)) copyPluginTree(dir, join(snap, 'plugins', name));
  }
  const shimPreviouslyAbsent = !existsSync(p.shim);
  if (!shimPreviouslyAbsent) {
    mkdirSync(join(snap, 'shim'), { recursive: true });
    copyFileSync(p.shim, join(snap, 'shim', 'agb'));
  }
  const importEntries = ourEntries(p);
  writeJsonAtomic(join(snap, 'import_manifest.json'), { imports: importEntries });
  const links = scanSkillSymlinks(p.skills);

  const next = { ...(state ?? {}), snapshotDir: snap, startedAt: new Date().toISOString() };
  if (!next.baselineSnapshotDir) {
    const baseline = {
      createdAt: new Date().toISOString(),
      plugins,
      shimPreviouslyAbsent,
      importEntries,
      originalSkillSymlinks: links,
      excludedPaths: [...INSTALL_COPY_EXCLUSIONS],
    };
    const file = join(snap, 'pre-migration.baseline.json');
    writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n', { mode: 0o444, flag: 'wx' });
    next.baselineSnapshotDir = snap;
    next.hasEverMigrated = false;
  }
  return writeMigrationState(home, { ...next, state: 'SNAPSHOT_CREATED' });
}

function step4RecordSymlinks(ctx, state) {
  const { p, home } = ctx;
  const baseline = readBaseline(state);
  const opts = { skillsDir: p.skills, home, npmRoot: ctx.npmRoot };
  const owned = scanSkillSymlinks(p.skills).filter((l) => isOwnedSkillLink(l, opts));
  const known = new Set(baseline.originalSkillSymlinks.map((l) => `${l.name}\0${l.target}`));
  const secondary = owned.filter((l) => !known.has(`${l.name}\0${l.target}`));
  return writeMigrationState(home, {
    ...state,
    state: 'SYMLINKS_RECORDED',
    recordedSymlinks: owned,
    ...(secondary.length ? { secondarySymlinks: [...(state.secondarySymlinks ?? []), ...secondary] } : {}),
  });
}

function step5Stage(ctx, state) {
  const { p, home, agyBin, lock } = ctx;
  assertMigrationLockHeld(lock);
  // From here on live plugin dirs change: a rollback must restore from the
  // baseline, never treat this run as untouched (virgin reset).
  state = writeMigrationState(home, { ...state, stagingStarted: true });
  const r1 = ctx.installBooster(ctx.pluginRoot, BOOSTER_PLUGIN_NAME, { home, agyBin });
  if (!r1?.ok) throw new MigrateError(`installing antigravity-booster failed: ${r1?.error ?? 'unknown error'}`);
  const r2 = ctx.installAdlc({ home, agyBin });
  if (!r2?.ok) throw new MigrateError(`installing adlc-antigravity failed: ${r2?.error ?? 'unknown error'}`);
  const vb = validateBooster(agyBin, join(p.plugins, BOOSTER_PLUGIN_NAME), home);
  if (!vb.ok) throw new MigrateError(vb.error);
  const va = agyValidate(agyBin, join(p.plugins, ADLC_ANTIGRAVITY_PLUGIN_NAME), home);
  if (!va.ok) throw new MigrateError(va.error);
  const names = new Set(ourEntries(p).map((e) => e.name));
  const missing = PLUGIN_NAMES.filter((n) => !names.has(n));
  if (missing.length) throw new MigrateError(`${p.importManifest} has no entry for: ${missing.join(', ')}`);
  assertMigrationLockHeld(lock);
  return writeMigrationState(home, { ...state, state: 'PLUGINS_STAGED' });
}

function step6Finalize(ctx, state) {
  const { p, home, lock } = ctx;
  assertMigrationLockHeld(lock);
  for (const { name, target } of state.recordedSymlinks ?? []) {
    const at = join(p.skills, name);
    try {
      if (lstatSync(at).isSymbolicLink() && readlinkSync(at) === target) unlinkSync(at);
    } catch { /* already gone */ }
  }
  const shim = installTerminalShim({ home, force: true });
  if (!shim.ok) throw new MigrateError(shim.error);
  const adlcManifest = readJson(join(p.plugins, ADLC_ANTIGRAVITY_PLUGIN_NAME, 'plugin.json'), {});
  assertMigrationLockHeld(lock);
  return writeMigrationState(home, {
    ...state,
    state: 'MIGRATED',
    hasEverMigrated: true,
    postMigrationSnapshots: {
      boosterDigest: digestOrNull(join(p.plugins, BOOSTER_PLUGIN_NAME)),
      adlcAntigravityDigest: digestOrNull(join(p.plugins, ADLC_ANTIGRAVITY_PLUGIN_NAME)),
      adlcAntigravityVersion: adlcManifest?.version ?? BUNDLED_ADLC_ANTIGRAVITY_VERSION,
      migratedAt: new Date().toISOString(),
    },
  });
}

function readBaseline(state) {
  const file = join(state?.baselineSnapshotDir ?? '', 'pre-migration.baseline.json');
  const b = readJson(file, null);
  if (!b || typeof b !== 'object' || !b.plugins || !Array.isArray(b.originalSkillSymlinks)) {
    throw new MigrateError(`baseline snapshot ${file} is missing or unreadable; refusing to continue`);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Detached uninstaller (A.4 item 23, A.6 item 19)
// ---------------------------------------------------------------------------

function defaultUninstallerArgv(home) {
  const staged = join(pluginsDirFor(home), BOOSTER_PLUGIN_NAME);
  return { argv: ['/bin/sh', join(staged, 'bin', 'node-launcher.sh'), 'dist/agb.mjs'], cwd: staged };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hand the held lock to a detached `migrate --finish-uninstall` child and wait
 * up to HANDOVER_TIMEOUT_MS for its handover.ack. On timeout, kill the child's
 * process group, wait for it, void the token, release the lock, exit 1.
 */
async function handOverUninstall(ctx) {
  const { home, lock, agyBin, log, err } = ctx;
  const dir = mkdtempSync(join(ctx.tmpParent ?? tmpdir(), UNINSTALLER_DIR_PREFIX));
  chmodSync(dir, 0o700);
  const launcher = ctx.uninstaller ?? defaultUninstallerArgv(home);
  const baselineFile = join(readMigrationState(home)?.baselineSnapshotDir ?? '', 'pre-migration.baseline.json');
  const args = [...launcher.argv, 'migrate', '--finish-uninstall', '--baseline', baselineFile, '--token', lock.token,
    '--uninstaller-dir', dir, '--agy-bin', agyBin];
  const quoted = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const script = join(dir, 'uninstall.sh');
  writeFileSync(script, `#!/bin/sh\ncd '${String(launcher.cwd ?? home).replace(/'/g, `'\\''`)}' || exit 1\nexec ${quoted}\n`, { mode: 0o700 });
  const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: home, ...(ctx.uninstallerEnv ?? {}) } });
  let exited = false;
  const exitedP = new Promise((r) => child.on('exit', () => { exited = true; r(); }));
  child.unref();
  const deadline = Date.now() + (ctx.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS);
  let acked = false;
  while (Date.now() < deadline) {
    // The child removes `dir` only after adopting the lock, so a vanished dir
    // is also proof of handover (a fast child can finish between polls).
    // The child removes `dir` only after adopting the lock and finishing, so
    // a vanished dir means the child is done: its state says how it went.
    if (!existsSync(dir)) {
      if (readMigrationState(home)?.state === 'ROLLED_BACK') {
        log('Rollback complete: antigravity-booster uninstalled.');
        return 0;
      }
      err('error: the detached uninstaller could not remove antigravity-booster; state is ROLLED_BACK_PENDING_UNINSTALL. ' +
        'Re-run `agb migrate --rollback` to retry.');
      return 1;
    }
    if (existsSync(join(dir, 'handover.ack')) && !acked) {
      acked = true;
      log('The detached uninstaller has taken over the lock and is removing antigravity-booster.');
    }
    await sleep(50);
  }
  if (acked) {
    // Handed over; a slow uninstall keeps running on its own and leaves the
    // state at ROLLED_BACK_PENDING_UNINSTALL if it fails.
    log('If it fails, state stays ROLLED_BACK_PENDING_UNINSTALL and `agb migrate --rollback` retries.');
    return 0;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  if (!exited) await Promise.race([exitedP, sleep(5000)]);
  invalidateMigrationLockToken(lock);
  rmSync(lock.lockDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  err('error: the detached uninstaller did not acknowledge the lock handover within 2.0s; ' +
    'state is ROLLED_BACK_PENDING_UNINSTALL. Re-run `agb migrate --rollback` to retry.');
  return 1;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

function agbElsewhereOnPath(p, env) {
  for (const d of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const c = join(d, 'agb');
    if (existsSync(c) && realOrResolved(c) !== realOrResolved(p.shim)) return true;
  }
  return false;
}

async function restoreFromBaseline(ctx, state) {
  const { p, home, lock, agyBin, log, warn } = ctx;
  const baseline = readBaseline(state);
  const base = state.baselineSnapshotDir;
  const boosterWasAbsent = baseline.plugins[BOOSTER_PLUGIN_NAME]?.previouslyAbsent === true;
  if (boosterWasAbsent && baseline.shimPreviouslyAbsent && !agbElsewhereOnPath(p, ctx.env)) {
    warn('WARNING: after this rollback no `agb` command will remain on PATH (antigravity-booster was not installed ' +
      'before migration). Reinstall with `npm install -g antigravity-booster` or the git-URL plugin install.');
  }
  assertMigrationLockHeld(lock);
  state = writeMigrationState(home, { ...state, state: 'ROLLBACK_IN_PROGRESS', rollbackStartedAt: new Date().toISOString() });

  recreateSymlinks(p, baseline.originalSkillSymlinks, log);

  assertMigrationLockHeld(lock);
  if (baseline.shimPreviouslyAbsent) rmSync(p.shim, { force: true });
  else {
    mkdirSync(dirname(p.shim), { recursive: true });
    copyFileSync(join(base, 'shim', 'agb'), p.shim);
    chmodSync(p.shim, 0o755);
  }

  assertMigrationLockHeld(lock);
  const adlc = ADLC_ANTIGRAVITY_PLUGIN_NAME;
  if (baseline.plugins[adlc]?.previouslyAbsent) {
    if (existsSync(join(p.plugins, adlc))) {
      try { agyUninstall(agyBin, adlc, home); } catch (e) { warn(`warning: agy plugin uninstall ${adlc} failed (${e.message}); removing its directory`); }
      rmSync(join(p.plugins, adlc), { recursive: true, force: true });
    }
  } else restorePluginDir(p, adlc, join(base, 'plugins', adlc));
  if (!boosterWasAbsent) restorePluginDir(p, BOOSTER_PLUGIN_NAME, join(base, 'plugins', BOOSTER_PLUGIN_NAME));

  assertMigrationLockHeld(lock);
  restoreImportEntries(p, baseline.importEntries ?? [], { keep: boosterWasAbsent ? [BOOSTER_PLUGIN_NAME] : [] });

  for (const name of PLUGIN_NAMES) {
    const dir = join(p.plugins, name);
    if (existsSync(dir) && !(name === BOOSTER_PLUGIN_NAME && boosterWasAbsent)) {
      const v = agyValidate(agyBin, dir, home);
      if (!v.ok) warn(`warning: restored ${name} did not validate: ${v.error}`);
    }
  }

  if (!boosterWasAbsent) {
    writeMigrationState(home, { ...state, state: 'ROLLED_BACK', rolledBackAt: new Date().toISOString() });
    log('Rollback complete: pre-migration plugins, terminal shim and skill links restored.');
    return 0;
  }
  writeMigrationState(home, { ...state, state: 'ROLLED_BACK_PENDING_UNINSTALL' });
  ctx.keepLock = true;
  return handOverUninstall(ctx);
}

function modifiedSinceMigration(ctx, state) {
  const snap = state.postMigrationSnapshots ?? {};
  const changed = [];
  if (digestOrNull(join(ctx.p.plugins, BOOSTER_PLUGIN_NAME)) !== snap.boosterDigest) changed.push(BOOSTER_PLUGIN_NAME);
  if (digestOrNull(join(ctx.p.plugins, ADLC_ANTIGRAVITY_PLUGIN_NAME)) !== snap.adlcAntigravityDigest) changed.push(ADLC_ANTIGRAVITY_PLUGIN_NAME);
  return changed;
}

async function rollbackLocked(ctx) {
  const { home, log, err } = ctx;
  const state = readMigrationState(home);
  if (!state) {
    log('No migration in progress or completed to roll back');
    return 0;
  }
  switch (state.state) {
    case 'ROLLED_BACK':
      log('System is already rolled back to baseline');
      return 0;
    case 'ROLLED_BACK_PENDING_UNINSTALL':
      ctx.keepLock = true;
      return handOverUninstall(ctx);
    case 'MIGRATED': {
      const changed = modifiedSinceMigration(ctx, state);
      if (changed.length && !ctx.forceRollback) {
        err(`error: staged plugins changed since migration (${changed.join(', ')}). ` +
          'Rolling back would discard those changes; re-run with --force-rollback to proceed.');
        return 1;
      }
      return restoreFromBaseline(ctx, state);
    }
    default:
      if (VIRGIN_RESET_STATES.has(state.state) && !state.hasEverMigrated && !state.stagingStarted) {
        assertMigrationLockHeld(ctx.lock);
        if (state.snapshotDir && isUnder(resolve(state.snapshotDir), ctx.p.snapshots)) rmSync(state.snapshotDir, { recursive: true, force: true });
        clearMigrationState(home);
        log('Rolled back an incomplete migration: nothing live had changed; snapshot and state cleared.');
        return 0;
      }
      return restoreFromBaseline(ctx, state);
  }
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

async function migrateLocked(ctx) {
  const { home, log, err, p } = ctx;
  // `crashAfter` (tests only) simulates the process dying right after a state is written.
  const crashed = (s) => { if (ctx.crashAfter === s.state) throw new MigrateError(`simulated crash after ${s.state}`); return s; };
  let state = readMigrationState(home);
  switch (state?.state) {
    case undefined:
      break;
    case 'MIGRATED':
      if (!ctx.force) {
        err('Migration already completed. Use --force to re-run, or --rollback to restore pre-migration state.');
        return 1;
      }
      state = crashed(step3Snapshot(ctx, state));
      break;
    case 'ROLLBACK_IN_PROGRESS':
      err("Rollback was previously interrupted. Run 'agb migrate --rollback' to complete restoration before re-running migration.");
      return 1;
    case 'ROLLED_BACK_PENDING_UNINSTALL':
      if (existsSync(join(p.plugins, BOOSTER_PLUGIN_NAME))) {
        log('Notice: a previous rollback did not finish uninstalling antigravity-booster; finishing it now. Re-run `agb migrate` afterwards.');
        ctx.keepLock = true;
        return handOverUninstall(ctx);
      }
      state = writeMigrationState(home, { ...state, state: 'ROLLED_BACK' });
    // falls through: booster already gone, start clean
    case 'ROLLED_BACK':
      writeJsonAtomic(join(p.snapshots, `archived-state-${Date.now()}.json`), state);
      clearMigrationState(home);
      state = null;
      break;
    case 'SNAPSHOT_CREATED':
    case 'SYMLINKS_RECORDED':
    case 'PLUGINS_STAGED':
      log(`Resuming migration from ${state.state}.`);
      break;
    default:
      err(`error: unknown migration state ${JSON.stringify(state.state)}; run \`agb migrate --rollback\` or inspect ${p.data}`);
      return 1;
  }
  if (!state) state = crashed(step3Snapshot(ctx, null));
  if (state.state === 'SNAPSHOT_CREATED') state = crashed(step4RecordSymlinks(ctx, state));
  if (state.state === 'SYMLINKS_RECORDED') state = crashed(step5Stage(ctx, state));
  if (state.state === 'PLUGINS_STAGED') state = step6Finalize(ctx, state);
  log(COMPLETION_NOTICE);
  return 0;
}

function buildContext(opts) {
  const home = opts.home ?? homedir();
  const out = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
  const errOut = opts.err ?? ((m) => process.stderr.write(`${m}\n`));
  return {
    ...opts,
    home,
    p: paths(home),
    agyBin: opts.agyBin ?? resolveAgyBinary(home),
    env: opts.env ?? process.env,
    log: out,
    err: errOut,
    warn: opts.warn ?? errOut,
    npmRoot: 'npmRoot' in opts ? opts.npmRoot : npmGlobalRoot(),
    installBooster: opts.installBooster ?? safePluginInstall,
    installAdlc: opts.installAdlc ?? installAdlcAntigravityFromVendor,
  };
}

/**
 * Entry point for `agb migrate`. opts: { home, agyBin, pluginRoot, force,
 * rollback, forceRollback, log, err, warn, env, npmRoot, uninstaller,
 * uninstallerEnv, handoverTimeoutMs, tmpParent, installBooster, installAdlc }.
 * Resolves to an exit code.
 */
export async function migrate(opts = {}) {
  const ctx = buildContext(opts);
  try {
    ctx.pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
    if (!opts.rollback) {
      const pre = validateBooster(ctx.agyBin, ctx.pluginRoot, ctx.home);
      if (!pre.ok) {
        ctx.err(`error: pre-flight validation failed: ${pre.error}`);
        return 1;
      }
    }
    ctx.lock = acquireMigrationLock({ home: ctx.home });
  } catch (e) {
    ctx.err(`error: ${e.message}`);
    return 1;
  }
  try {
    return opts.rollback ? await rollbackLocked(ctx) : await migrateLocked(ctx);
  } catch (e) {
    ctx.err(`error: ${e.message}`);
    return 1;
  } finally {
    if (!ctx.keepLock) releaseMigrationLock(ctx.lock);
  }
}

/**
 * `agb migrate --break-lock` (A.4 item 25). `--force` skips the [y/N] prompt;
 * without it, `confirm(question)` must resolve true. Never runs a migration.
 */
export async function breakLock({ home = homedir(), force = false, confirm, log, err, deps } = {}) {
  const out = log ?? ((m) => process.stdout.write(`${m}\n`));
  const errOut = err ?? ((m) => process.stderr.write(`${m}\n`));
  try {
    const preview = breakMigrationLock({ home, deps });
    if (!preview.present) {
      out('No migration lock is held.');
      return 0;
    }
    const h = preview.holder;
    out(`Migration lock held by pid ${h?.pid ?? 'unknown'} (started ${h?.startedAt ?? 'unknown'}).`);
    if (preview.alive) errOut(`WARNING: process ${h.pid} still appears to be running. Breaking its lock can corrupt an in-flight migration.`);
    if (!force) {
      const ok = confirm ? await confirm('Break the migration lock? [y/N] ') : false;
      if (!ok) {
        errOut('Lock left in place (pass --force to skip the prompt).');
        return 1;
      }
    }
    const done = breakMigrationLock({ home, confirmed: true, expectToken: h?.token ?? null, deps });
    if (!done.removed) {
      errOut('error: the migration lock changed hands while waiting for confirmation; left in place. Re-run --break-lock.');
      return 1;
    }
    out('Migration lock removed. Re-run `agb migrate` or `agb migrate --rollback`.');
    return 0;
  } catch (e) {
    errOut(`error: ${e.message}`);
    return 1;
  }
}

/** `agb migrate --finish-uninstall` (detached child). */
export function finishUninstallCommand({ home = homedir(), token, uninstallerDir, agyBin, baseline, err } = {}) {
  const r = finishUninstall({ home, token, uninstallerDir, baseline, agyBin: agyBin ?? resolveAgyBinary(home) });
  if (!r.ok) (err ?? ((m) => process.stderr.write(`${m}\n`)))(`error: ${r.error}`);
  return r.ok ? 0 : 1;
}
