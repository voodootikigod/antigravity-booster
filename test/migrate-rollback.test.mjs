// T-PLUGIN-04: `agb migrate` / `--rollback` (spec §4.6, the Normative
// Rollback-from-Each-State Table, Appendix A D13, A.4 items 21-25, A.6 items
// 18-19). Every case runs under a temp HOME with test/fixtures/fake-agy; the
// developer's real ~/.gemini is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync,
  lstatSync, readlinkSync, statSync, truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  migrate, breakLock, parseValidateOutput, isOwnedSkillLink, scanSkillSymlinks, treeSize, SNAPSHOT_SIZE_CAP_BYTES,
} from '../lib/migrate.mjs';
import {
  acquireMigrationLock, releaseMigrationLock, readMigrationState, writeMigrationState, migrationLockDir, boosterDataDir,
} from '../lib/migration-lock.mjs';
import { TERMINAL_SHIM_CONTENT } from '../lib/plugin-paths.mjs';
import { computeDirectoryDigest } from '../lib/digest.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function boosterSource(root) {
  const src = join(root, 'source', 'antigravity-booster');
  for (const d of ['skills/s1', 'agents', 'commands', 'bin', 'dist', 'node_modules/big', '.worktrees/w', '.git']) mkdirSync(join(src, d), { recursive: true });
  writeFileSync(join(src, 'plugin.json'), JSON.stringify({ name: 'antigravity-booster', version: '1.0.0' }));
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'antigravity-booster' }));
  writeFileSync(join(src, 'hooks.json'), '{}');
  writeFileSync(join(src, 'mcp_config.json'), '{}');
  writeFileSync(join(src, 'skills', 's1', 'SKILL.md'), '# s1');
  writeFileSync(join(src, 'dist', 'agb.mjs'), '// bundle');
  // Stand-in launcher for the detached uninstaller: runs this checkout's CLI.
  writeFileSync(join(src, 'bin', 'node-launcher.sh'), '#!/bin/sh\nshift\nexec "$FAKE_NODE" "$FAKE_AGB" "$@"\n', { mode: 0o755 });
  writeFileSync(join(src, 'node_modules', 'big', 'x.js'), 'x');
  writeFileSync(join(src, '.worktrees', 'w', 'y'), 'y');
  writeFileSync(join(src, '.git', 'HEAD'), 'ref');
  return src;
}

function setup({ preStaged = false, shim = null, links = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agb-migrate-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const ctx = { root, home, src: boosterSource(root), logs: [], errs: [] };
  ctx.plugins = join(home, '.gemini', 'config', 'plugins');
  ctx.skills = join(home, '.gemini', 'skills');
  ctx.shim = join(home, '.local', 'bin', 'agb');
  ctx.importManifest = join(home, '.gemini', 'config', 'import_manifest.json');
  mkdirSync(ctx.skills, { recursive: true });
  mkdirSync(ctx.plugins, { recursive: true });
  writeFileSync(ctx.importManifest, JSON.stringify({ imports: [{ name: 'third-party', source: 'gemini' }] }));
  // A user's own skill and a link to it (never touched), a link into the
  // booster checkout (owned), and a dangling link into a deleted booster
  // skill (owned, removed).
  const userSkill = join(root, 'user-skills', 'mine');
  mkdirSync(userSkill, { recursive: true });
  ctx.userSkill = userSkill;
  if (links) {
    symlinkSync(userSkill, join(ctx.skills, 'mine'));
    symlinkSync(join(ctx.src, 'skills', 's1'), join(ctx.skills, 's1'));
    symlinkSync(join(ctx.src, 'skills', 'adlc-doctrine'), join(ctx.skills, 'adlc-doctrine'));
  }
  if (preStaged) {
    for (const name of ['antigravity-booster', 'adlc-antigravity']) {
      const d = join(ctx.plugins, name);
      mkdirSync(join(d, 'skills'), { recursive: true });
      writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name, version: '0.9.0' }));
      writeFileSync(join(d, 'old.txt'), `old ${name}`);
    }
    writeFileSync(ctx.importManifest, JSON.stringify({
      imports: [{ name: 'third-party' }, { name: 'antigravity-booster', components: ['skills'] }, { name: 'adlc-antigravity', components: ['hooks'] }],
    }));
  }
  if (shim !== null) {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(ctx.shim, shim, { mode: 0o755 });
  }
  ctx.cleanup = () => rmSync(root, { recursive: true, force: true });
  return ctx;
}

function opts(ctx, extra = {}) {
  return {
    home: ctx.home,
    agyBin: FAKE_AGY,
    pluginRoot: ctx.src,
    npmRoot: null,
    env: { PATH: '' },
    tmpParent: ctx.root,
    log: (m) => ctx.logs.push(m),
    err: (m) => ctx.errs.push(m),
    uninstaller: { argv: [process.execPath, join(ROOT, 'bin', 'agb.mjs')], cwd: ROOT },
    ...extra,
  };
}

const run = (ctx, extra) => migrate(opts(ctx, extra));
const state = (ctx) => readMigrationState(ctx.home);
const imports = (ctx) => JSON.parse(readFileSync(ctx.importManifest, 'utf8')).imports.map((e) => e.name).sort();
const linkNames = (ctx) => readdirSync(ctx.skills).filter((n) => lstatSync(join(ctx.skills, n)).isSymbolicLink()).sort();
const baselineFile = (ctx) => join(state(ctx).baselineSnapshotDir, 'pre-migration.baseline.json');

async function waitForState(ctx, want, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state(ctx)?.state === want && !existsSync(migrationLockDir(ctx.home))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`state never reached ${want} (is ${state(ctx)?.state})`);
}

// ---------------------------------------------------------------------------
// Forward migration
// ---------------------------------------------------------------------------

test('fresh install: migrates to MIGRATED — both plugins staged, shim 0755, owned links unlinked, user link kept', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    const s = state(ctx);
    assert.equal(s.state, 'MIGRATED');
    assert.equal(s.hasEverMigrated, true);
    assert.ok(existsSync(join(ctx.plugins, 'antigravity-booster', 'plugin.json')));
    assert.ok(existsSync(join(ctx.plugins, 'adlc-antigravity', 'plugin.json')));
    assert.equal(readFileSync(ctx.shim, 'utf8'), TERMINAL_SHIM_CONTENT);
    assert.equal(statSync(ctx.shim).mode & 0o777, 0o755);
    assert.deepEqual(linkNames(ctx), ['mine'], 'booster links (live and dangling) unlinked; user link untouched');
    assert.deepEqual(imports(ctx), ['adlc-antigravity', 'antigravity-booster', 'third-party']);
    assert.match(ctx.logs.at(-1), /Migration successful\. Global npm package may be uninstalled: npm uninstall -g antigravity-booster/);
    assert.match(ctx.logs.at(-1), /~\/\.local\/bin\/agb/);
    const pms = s.postMigrationSnapshots;
    assert.equal(pms.boosterDigest, computeDirectoryDigest(join(ctx.plugins, 'antigravity-booster')));
    assert.equal(pms.adlcAntigravityDigest, computeDirectoryDigest(join(ctx.plugins, 'adlc-antigravity')));
    assert.equal(pms.adlcAntigravityVersion, '1.7.0');
    assert.ok(Date.parse(pms.migratedAt));
    assert.equal(existsSync(migrationLockDir(ctx.home)), false, 'lock released');
  } finally { ctx.cleanup(); }
});

test('baseline: written once, read-only, records plugins, shim, import entries, every original link and excludedPaths', async () => {
  const ctx = setup({ preStaged: true, shim: '#!/bin/sh\necho old agb\n' });
  try {
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    const file = baselineFile(ctx);
    assert.equal(statSync(file).mode & 0o222, 0, 'baseline is not writable');
    const b = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(b.plugins, { 'antigravity-booster': { previouslyAbsent: false }, 'adlc-antigravity': { previouslyAbsent: false } });
    assert.equal(b.shimPreviouslyAbsent, false);
    assert.deepEqual(b.importEntries.map((e) => e.name).sort(), ['adlc-antigravity', 'antigravity-booster']);
    assert.deepEqual(b.originalSkillSymlinks.map((l) => l.name), ['adlc-doctrine', 'mine', 's1']);
    assert.deepEqual(b.excludedPaths, ['node_modules', '.worktrees', '.git']);
    const snap = state(ctx).baselineSnapshotDir;
    assert.equal(readFileSync(join(snap, 'shim', 'agb'), 'utf8'), '#!/bin/sh\necho old agb\n');
    assert.equal(readFileSync(join(snap, 'plugins', 'antigravity-booster', 'old.txt'), 'utf8'), 'old antigravity-booster');
  } finally { ctx.cleanup(); }
});

test('D13: snapshots and staging exclude node_modules/.worktrees/.git; a plugin over 100 MB after exclusion is refused', async () => {
  const ctx = setup({ preStaged: true });
  try {
    const staged = join(ctx.plugins, 'antigravity-booster');
    for (const d of ['node_modules', '.worktrees', '.git']) { mkdirSync(join(staged, d)); writeFileSync(join(staged, d, 'f'), 'x'); }
    // An excluded giant does not count toward the cap.
    truncateSync(join(staged, 'node_modules', 'f'), SNAPSHOT_SIZE_CAP_BYTES + 10);
    assert.ok(treeSize(staged) < SNAPSHOT_SIZE_CAP_BYTES);
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    const snap = join(state(ctx).baselineSnapshotDir, 'plugins', 'antigravity-booster');
    for (const d of ['node_modules', '.worktrees', '.git']) assert.equal(existsSync(join(snap, d)), false, `${d} excluded from snapshot`);
    for (const d of ['node_modules', '.worktrees', '.git']) assert.equal(existsSync(join(ctx.plugins, 'antigravity-booster', d)), false, `${d} excluded from staging`);
  } finally { ctx.cleanup(); }
  const big = setup({ preStaged: true });
  try {
    truncateSync(join(big.plugins, 'adlc-antigravity', 'old.txt'), SNAPSHOT_SIZE_CAP_BYTES + 1);
    assert.equal(await run(big), 1);
    assert.match(big.errs.join('\n'), /exceeds 100 MB after excluding node_modules, \.worktrees, \.git/);
    assert.equal(state(big), null, 'no state written');
    assert.equal(existsSync(join(boosterDataDir(big.home), 'snapshots')), false, 'no snapshot written');
  } finally { big.cleanup(); }
});

test('pre-flight: a source that fails agy plugin validate, or lacks a component category, aborts before the lock', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx, { env: { PATH: '' } }), 0);
  } finally { ctx.cleanup(); }
  const bad = setup();
  try {
    rmSync(join(bad.src, 'mcp_config.json'));
    assert.equal(await run(bad), 1);
    assert.match(bad.errs.join('\n'), /pre-flight validation failed: .*missing component categories: mcpServers/);
    assert.equal(state(bad), null);
    assert.equal(existsSync(migrationLockDir(bad.home)), false);
  } finally { bad.cleanup(); }
});

test('validate output parser reads real agy lines (ANSI, skipped categories)', () => {
  const real = '  \x1b[32m[ok]\x1b[0m    .\n          \x1b[32m✔\x1b[0m skills      : 2 processed\n' +
    '          \x1b[32m✔\x1b[0m commands    : 7 processed (converted to skills)\n          - mcpServers  : skipped (not found)\n' +
    '          \x1b[32m✔\x1b[0m hooks       : 1 processed\n';
  assert.deepEqual(parseValidateOutput(real), { skills: 2, commands: 7, hooks: 1 });
  assert.deepEqual(parseValidateOutput(undefined), {});
});

test('MIGRATED: re-run refused without --force; --force re-runs and keeps the baseline byte-identical', async () => {
  const ctx = setup({ preStaged: true });
  try {
    assert.equal(await run(ctx), 0);
    const baseDir = state(ctx).baselineSnapshotDir;
    const before = readFileSync(baselineFile(ctx), 'utf8');
    assert.equal(await run(ctx), 1);
    assert.match(ctx.errs.at(-1), /Migration already completed\. Use --force to re-run, or --rollback to restore pre-migration state\./);
    assert.equal(await run(ctx, { force: true }), 0, ctx.errs.join('\n'));
    const s = state(ctx);
    assert.equal(s.state, 'MIGRATED');
    assert.equal(s.baselineSnapshotDir, baseDir, 'baselineSnapshotDir never changes');
    assert.notEqual(s.snapshotDir, baseDir, '--force archives into a new snapshot dir');
    assert.equal(readFileSync(join(baseDir, 'pre-migration.baseline.json'), 'utf8'), before);
    assert.equal(existsSync(join(s.snapshotDir, 'pre-migration.baseline.json')), false, 'no second baseline');
  } finally { ctx.cleanup(); }
});

test('Step 5 failure aborts with exit 1, leaves links intact and shim absent; re-run resumes forward', async () => {
  const ctx = setup();
  try {
    const failing = { installBooster: () => ({ ok: false, error: 'boom' }) };
    assert.equal(await run(ctx, failing), 1);
    assert.match(ctx.errs.at(-1), /installing antigravity-booster failed: boom/);
    assert.equal(state(ctx).state, 'SYMLINKS_RECORDED');
    assert.deepEqual(linkNames(ctx), ['adlc-doctrine', 'mine', 's1'], 'nothing unlinked before Step 6');
    assert.equal(existsSync(ctx.shim), false);
    assert.equal(await run(ctx, { installAdlc: () => ({ ok: false, error: 'adlc boom' }) }), 1);
    assert.match(ctx.errs.at(-1), /installing adlc-antigravity failed: adlc boom/);
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    assert.ok(ctx.logs.some((l) => l === 'Resuming migration from SYMLINKS_RECORDED.'));
    assert.equal(state(ctx).state, 'MIGRATED');
  } finally { ctx.cleanup(); }
});

test('Step 5: staged validate failure and a missing import_manifest entry both abort', async () => {
  const ctx = setup();
  try {
    let calls = 0;
    const validateFails = {
      installAdlc: (o) => {
        calls += 1;
        process.env.FAKE_AGY_VALIDATE_MODE = 'fail';
        return { ok: true, o };
      },
    };
    try {
      assert.equal(await run(ctx, validateFails), 1);
    } finally { delete process.env.FAKE_AGY_VALIDATE_MODE; }
    assert.equal(calls, 1);
    assert.match(ctx.errs.at(-1), /agy plugin validate .* failed/);
    assert.equal(state(ctx).state, 'SYMLINKS_RECORDED');
    // adlc "installed" without agy registering it in import_manifest.json
    const noEntry = { installAdlc: () => { mkdirSync(join(ctx.plugins, 'adlc-antigravity'), { recursive: true }); writeFileSync(join(ctx.plugins, 'adlc-antigravity', 'plugin.json'), '{}'); return { ok: true }; } };
    assert.equal(await run(ctx, noEntry), 1);
    assert.match(ctx.errs.at(-1), /import_manifest\.json has no entry for: adlc-antigravity/);
  } finally { ctx.cleanup(); }
});

test('self-install: migrating from the staged booster directory does not truncate or prune it', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0);
    const staged = join(ctx.plugins, 'antigravity-booster');
    const digest = computeDirectoryDigest(staged);
    assert.equal(await run(ctx, { force: true, pluginRoot: staged }), 0, ctx.errs.join('\n'));
    assert.equal(computeDirectoryDigest(staged), digest);
    assert.ok(existsSync(join(staged, 'skills', 's1', 'SKILL.md')));
  } finally { ctx.cleanup(); }
});

test('a held lock refuses migrate and rollback with the holder message', async () => {
  const ctx = setup();
  try {
    const h = acquireMigrationLock({ home: ctx.home });
    assert.equal(await run(ctx), 1);
    assert.match(ctx.errs.at(-1), /another agb migration holds the lock \(pid \d+/);
    assert.equal(await run(ctx, { rollback: true }), 1);
    assert.equal(state(ctx), null);
    releaseMigrationLock(h);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Rollback-from-each-state table
// ---------------------------------------------------------------------------

test('rollback INITIAL: notice, exit 0, nothing created', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx, { rollback: true }), 0);
    assert.equal(ctx.logs.at(-1), 'No migration in progress or completed to roll back');
    assert.equal(state(ctx), null);
  } finally { ctx.cleanup(); }
});

for (const crashAt of ['SNAPSHOT_CREATED', 'SYMLINKS_RECORDED']) {
  test(`rollback ${crashAt} (virgin): removes the incomplete snapshot and state → INITIAL, live system untouched`, async () => {
    const ctx = setup({ shim: 'mine\n' });
    try {
      assert.equal(await run(ctx, { crashAfter: crashAt }), 1);
      assert.equal(state(ctx).state, crashAt);
      const snap = state(ctx).snapshotDir;
      assert.ok(existsSync(snap));
      assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
      assert.equal(state(ctx), null);
      assert.equal(existsSync(snap), false);
      assert.deepEqual(linkNames(ctx), ['adlc-doctrine', 'mine', 's1']);
      assert.equal(readFileSync(ctx.shim, 'utf8'), 'mine\n');
      assert.equal(existsSync(join(ctx.plugins, 'antigravity-booster')), false);
    } finally { ctx.cleanup(); }
  });
}

test('rollback PLUGINS_STAGED (virgin, pre-existing plugins): restores plugins and import entries, links untouched → ROLLED_BACK', async () => {
  const ctx = setup({ preStaged: true });
  try {
    const before = {
      booster: computeDirectoryDigest(join(ctx.plugins, 'antigravity-booster')),
      adlc: computeDirectoryDigest(join(ctx.plugins, 'adlc-antigravity')),
      manifest: readFileSync(ctx.importManifest, 'utf8'),
    };
    assert.equal(await run(ctx, { crashAfter: 'PLUGINS_STAGED' }), 1);
    assert.equal(state(ctx).state, 'PLUGINS_STAGED');
    assert.notEqual(computeDirectoryDigest(join(ctx.plugins, 'antigravity-booster')), before.booster);
    assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
    assert.equal(state(ctx).state, 'ROLLED_BACK');
    assert.equal(computeDirectoryDigest(join(ctx.plugins, 'antigravity-booster')), before.booster);
    assert.equal(computeDirectoryDigest(join(ctx.plugins, 'adlc-antigravity')), before.adlc);
    assert.deepEqual(JSON.parse(readFileSync(ctx.importManifest, 'utf8')).imports.map((e) => e.name).sort(),
      JSON.parse(before.manifest).imports.map((e) => e.name).sort());
    assert.deepEqual(linkNames(ctx), ['adlc-doctrine', 'mine', 's1']);
    assert.equal(existsSync(ctx.shim), false);
  } finally { ctx.cleanup(); }
});

test('rollback MIGRATED immediately after migrating: clean restore without --force-rollback', async () => {
  const ctx = setup({ preStaged: true, shim: '#!/bin/sh\necho old agb\n' });
  try {
    const before = computeDirectoryDigest(join(ctx.plugins, 'antigravity-booster'));
    assert.equal(await run(ctx), 0);
    assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
    assert.equal(state(ctx).state, 'ROLLED_BACK');
    assert.equal(computeDirectoryDigest(join(ctx.plugins, 'antigravity-booster')), before);
    assert.equal(readFileSync(ctx.shim, 'utf8'), '#!/bin/sh\necho old agb\n');
    assert.equal(statSync(ctx.shim).mode & 0o777, 0o755);
    assert.deepEqual(linkNames(ctx), ['mine', 's1'], 'live links restored; the dangling one is skipped');
    assert.ok(ctx.logs.some((l) => l === `Notice: Symlink target ${join(ctx.src, 'skills', 'adlc-doctrine')} missing; skipping dangling link`));
    assert.equal(readlinkSync(join(ctx.skills, 's1')), join(ctx.src, 'skills', 's1'));
  } finally { ctx.cleanup(); }
});

test('rollback MIGRATED after staged files changed: refuses without --force-rollback, proceeds with it', async () => {
  const ctx = setup({ preStaged: true });
  try {
    assert.equal(await run(ctx), 0);
    writeFileSync(join(ctx.plugins, 'adlc-antigravity', 'upgraded.txt'), 'x');
    assert.equal(await run(ctx, { rollback: true }), 1);
    assert.match(ctx.errs.at(-1), /staged plugins changed since migration \(adlc-antigravity\).*--force-rollback/);
    assert.equal(state(ctx).state, 'MIGRATED', 'nothing touched');
    assert.equal(await run(ctx, { rollback: true, forceRollback: true }), 0, ctx.errs.join('\n'));
    assert.equal(state(ctx).state, 'ROLLED_BACK');
    assert.equal(readFileSync(join(ctx.plugins, 'adlc-antigravity', 'old.txt'), 'utf8'), 'old adlc-antigravity');
  } finally { ctx.cleanup(); }
});

for (const crashAt of ['SNAPSHOT_CREATED', 'SYMLINKS_RECORDED', 'PLUGINS_STAGED']) {
  test(`rollback ${crashAt} after --force (hasEverMigrated): restores the baseline links, plugins and shim → ROLLED_BACK`, async () => {
    const ctx = setup({ preStaged: true, shim: 'orig\n' });
    try {
      const before = computeDirectoryDigest(join(ctx.plugins, 'adlc-antigravity'));
      assert.equal(await run(ctx), 0);
      assert.equal(await run(ctx, { force: true, crashAfter: crashAt }), 1);
      assert.equal(state(ctx).state, crashAt);
      assert.equal(state(ctx).hasEverMigrated, true);
      assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
      assert.equal(state(ctx).state, 'ROLLED_BACK');
      assert.deepEqual(linkNames(ctx), ['mine', 's1']);
      assert.equal(readFileSync(ctx.shim, 'utf8'), 'orig\n');
      assert.equal(computeDirectoryDigest(join(ctx.plugins, 'adlc-antigravity')), before);
      assert.ok(existsSync(baselineFile(ctx)), 'baseline left intact');
    } finally { ctx.cleanup(); }
  });
}

test('ROLLBACK_IN_PROGRESS: forward migrate refuses; a second --rollback resumes and completes', async () => {
  const ctx = setup({ preStaged: true });
  try {
    assert.equal(await run(ctx), 0);
    writeMigrationState(ctx.home, { ...state(ctx), state: 'ROLLBACK_IN_PROGRESS' });
    assert.equal(await run(ctx), 1);
    assert.match(ctx.errs.at(-1), /Rollback was previously interrupted\. Run 'agb migrate --rollback'/);
    assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
    assert.equal(state(ctx).state, 'ROLLED_BACK');
    assert.equal(readFileSync(join(ctx.plugins, 'antigravity-booster', 'old.txt'), 'utf8'), 'old antigravity-booster');
  } finally { ctx.cleanup(); }
});

test('ROLLED_BACK: rollback is a notice; forward migrate starts a fresh baseline', async () => {
  const ctx = setup({ preStaged: true });
  try {
    assert.equal(await run(ctx), 0);
    assert.equal(await run(ctx, { rollback: true }), 0);
    const oldBase = state(ctx).baselineSnapshotDir;
    assert.equal(await run(ctx, { rollback: true }), 0);
    assert.equal(ctx.logs.at(-1), 'System is already rolled back to baseline');
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    assert.equal(state(ctx).state, 'MIGRATED');
    assert.notEqual(state(ctx).baselineSnapshotDir, oldBase);
    assert.ok(readdirSync(join(boosterDataDir(ctx.home), 'snapshots')).some((n) => n.startsWith('archived-state-')));
  } finally { ctx.cleanup(); }
});

test('unknown state is refused forward; a corrupt state file is an error, not a crash', async () => {
  const ctx = setup();
  try {
    writeMigrationState(ctx.home, { state: 'WEIRD' });
    assert.equal(await run(ctx), 1);
    assert.match(ctx.errs.at(-1), /unknown migration state "WEIRD"/);
    writeFileSync(join(boosterDataDir(ctx.home), 'migration-state.json'), '{bad');
    assert.equal(await run(ctx), 1);
    assert.equal(existsSync(migrationLockDir(ctx.home)), false, 'lock released after the error');
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fresh-install rollback: detached uninstaller and lock handover
// ---------------------------------------------------------------------------

test('fresh-install rollback: restores links, removes shim and adlc, hands the lock to the uninstaller → ROLLED_BACK', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0);
    assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
    assert.match(ctx.errs.join('\n'), /WARNING: after this rollback no `agb` command will remain on PATH/);
    await waitForState(ctx, 'ROLLED_BACK');
    assert.equal(existsSync(join(ctx.plugins, 'antigravity-booster')), false, 'booster uninstalled by the child');
    assert.equal(existsSync(join(ctx.plugins, 'adlc-antigravity')), false, 'adlc uninstalled');
    assert.equal(existsSync(ctx.shim), false);
    assert.deepEqual(imports(ctx), ['third-party'], 'third-party import entries untouched');
    assert.deepEqual(linkNames(ctx), ['mine', 's1']);
    assert.deepEqual(readdirSync(ctx.root).filter((n) => n.startsWith('agb-uninstall-')), [], 'uninstaller dir removed');
  } finally { ctx.cleanup(); }
});

test('loss-of-agb warning is skipped when another agb is on PATH', async () => {
  const ctx = setup();
  try {
    const other = join(ctx.root, 'npm-bin');
    mkdirSync(other);
    writeFileSync(join(other, 'agb'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(await run(ctx), 0);
    assert.equal(await run(ctx, { rollback: true, env: { PATH: other } }), 0);
    assert.doesNotMatch(ctx.errs.join('\n'), /no `agb` command will remain/);
    await waitForState(ctx, 'ROLLED_BACK');
  } finally { ctx.cleanup(); }
});

test('handover timeout: no ack in 2.0s → child group killed, token voided, lock released, PENDING kept, exit 1', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0);
    const marker = join(ctx.root, 'child-alive');
    const stubborn = { argv: ['/bin/sh', '-c', `touch '${marker}'; sleep 30; touch '${marker}.late'`, 'stub'], cwd: ctx.root };
    const t0 = Date.now();
    assert.equal(await run(ctx, { rollback: true, uninstaller: stubborn }), 1);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 2000 && elapsed < 8000, `waited ${elapsed}ms`);
    assert.match(ctx.errs.at(-1), /did not acknowledge the lock handover within 2\.0s/);
    assert.equal(state(ctx).state, 'ROLLED_BACK_PENDING_UNINSTALL');
    assert.equal(existsSync(migrationLockDir(ctx.home)), false, 'lock released');
    assert.ok(existsSync(marker), 'the child did start');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(`${marker}.late`), false, 'child was killed');
    assert.deepEqual(readdirSync(ctx.root).filter((n) => n.startsWith('agb-uninstall-')), []);
    // Resume (A.6 item 19): a fresh lock and token finish the uninstall.
    assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
    await waitForState(ctx, 'ROLLED_BACK');
    assert.equal(existsSync(join(ctx.plugins, 'antigravity-booster')), false);
  } finally { ctx.cleanup(); }
});

test('ROLLED_BACK_PENDING_UNINSTALL with booster still present: forward migrate finishes the uninstall, exits 0, asks for a re-run', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0);
    writeMigrationState(ctx.home, { ...state(ctx), state: 'ROLLED_BACK_PENDING_UNINSTALL' });
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    assert.match(ctx.logs.join('\n'), /did not finish uninstalling antigravity-booster; finishing it now\. Re-run `agb migrate` afterwards/);
    await waitForState(ctx, 'ROLLED_BACK');
    assert.equal(existsSync(join(ctx.plugins, 'antigravity-booster')), false, 'never continued migrating in the same invocation');
  } finally { ctx.cleanup(); }
});

test('ROLLED_BACK_PENDING_UNINSTALL with booster already gone: forward migrate advances to ROLLED_BACK and migrates fresh', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0);
    writeMigrationState(ctx.home, { ...state(ctx), state: 'ROLLED_BACK_PENDING_UNINSTALL' });
    rmSync(join(ctx.plugins, 'antigravity-booster'), { recursive: true });
    assert.equal(await run(ctx), 0, ctx.errs.join('\n'));
    assert.equal(state(ctx).state, 'MIGRATED');
  } finally { ctx.cleanup(); }
});

test('repeated migrate → --force → --rollback keeps the baseline immutable and restores every original user link', async () => {
  const ctx = setup({ preStaged: true });
  try {
    assert.equal(await run(ctx), 0);
    const file = baselineFile(ctx);
    const before = readFileSync(file, 'utf8');
    assert.equal(await run(ctx, { force: true }), 0);
    assert.equal(await run(ctx, { rollback: true }), 0, ctx.errs.join('\n'));
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(linkNames(ctx), ['mine', 's1']);
    assert.equal(readlinkSync(join(ctx.skills, 'mine')), ctx.userSkill);
  } finally { ctx.cleanup(); }
});

test('post-npm-uninstall rollback through the CLI: missing link targets get a notice, loss-of-agb warning shown', async () => {
  const ctx = setup();
  try {
    assert.equal(await run(ctx), 0);
    // The CLI resolves agy from ~/.local/bin/agy and launches the uninstaller
    // through the staged booster's bin/node-launcher.sh (the fixture stand-in).
    symlinkSync(FAKE_AGY, join(ctx.home, '.local', 'bin', 'agy'));
    rmSync(ctx.src, { recursive: true }); // "npm uninstall -g": every booster link target is gone
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'agb.mjs'), 'migrate', '--rollback'], {
      encoding: 'utf8', cwd: ctx.root,
      env: { ...process.env, HOME: ctx.home, PATH: '/usr/bin:/bin', FAKE_NODE: process.execPath, FAKE_AGB: join(ROOT, 'bin', 'agb.mjs') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Notice: Symlink target .*skills\/s1 missing; skipping dangling link/);
    assert.match(r.stderr, /WARNING: after this rollback no `agb` command will remain on PATH/);
    await waitForState(ctx, 'ROLLED_BACK');
    assert.deepEqual(linkNames(ctx), ['mine']);
    assert.equal(existsSync(join(ctx.plugins, 'antigravity-booster')), false);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Symlink ownership (A.6 item 18) and --break-lock
// ---------------------------------------------------------------------------

test('isOwnedSkillLink: booster/adlc territory is owned; user skills are not', () => {
  const ctx = setup({ links: false });
  try {
    const npmRoot = join(ctx.root, 'npm-global');
    mkdirSync(join(npmRoot, 'antigravity-booster', 'skills', 'x'), { recursive: true });
    const o = { skillsDir: ctx.skills, home: ctx.home, npmRoot };
    const owned = (target) => isOwnedSkillLink({ name: 'n', target }, o);
    assert.equal(owned(join(npmRoot, 'antigravity-booster', 'skills', 'x')), true, 'npm-global package');
    assert.equal(owned(join(ctx.src, 'skills', 's1')), true, 'booster checkout skills/');
    assert.equal(owned(join(ctx.src, 'skills', 'deleted')), true, 'dangling link into a checkout skills/');
    assert.equal(owned(join(ctx.src, 'docs', 'x')), false, 'checkout but not skills/');
    assert.equal(owned('/somewhere/node_modules/@adlc/antigravity/skills/a'), true);
    assert.equal(owned('/somewhere/node_modules/@adlc/antigravity-other/skills/a'), false);
    assert.equal(owned(join(ctx.plugins, 'adlc-antigravity', 'skills', 'a')), true);
    assert.equal(owned(join(ctx.plugins, 'antigravity-booster', 'skills', 'a')), true);
    assert.equal(owned(join(ctx.plugins, 'other-plugin', 'skills', 'a')), false);
    assert.equal(owned(ctx.userSkill), false);
    assert.equal(owned('../relative/elsewhere'), false);
    assert.equal(isOwnedSkillLink({ name: 'n', target: join(npmRoot, 'antigravity-booster') }, { ...o, npmRoot: null }), false, 'no npm root → not matched by it');
    assert.deepEqual(scanSkillSymlinks(join(ctx.root, 'absent')), []);
  } finally { ctx.cleanup(); }
});

test('breakLock: no lock; refused without confirmation; --force removes; confirm(true) removes; live holder warned', async () => {
  const ctx = setup();
  try {
    const logs = []; const errs = [];
    const io = { home: ctx.home, log: (m) => logs.push(m), err: (m) => errs.push(m) };
    assert.equal(await breakLock(io), 0);
    assert.equal(logs.at(-1), 'No migration lock is held.');
    acquireMigrationLock({ home: ctx.home });
    assert.equal(await breakLock(io), 1);
    assert.match(errs.join('\n'), /WARNING: process \d+ still appears to be running/);
    assert.match(errs.at(-1), /Lock left in place/);
    assert.ok(existsSync(migrationLockDir(ctx.home)));
    assert.equal(await breakLock({ ...io, confirm: async () => false }), 1);
    assert.equal(await breakLock({ ...io, confirm: async () => true }), 0);
    assert.equal(existsSync(migrationLockDir(ctx.home)), false);
    acquireMigrationLock({ home: ctx.home });
    assert.equal(await breakLock({ ...io, force: true }), 0);
    assert.match(logs.at(-1), /Migration lock removed/);
    assert.equal(existsSync(migrationLockDir(ctx.home)), false);
  } finally { ctx.cleanup(); }
});

test('CLI: agb migrate --break-lock --force clears an orphaned lock and runs no migration', () => {
  const ctx = setup();
  try {
    const dir = migrationLockDir(ctx.home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ pid: 999999, token: 't', startedAt: 'then' }));
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'agb.mjs'), 'migrate', '--break-lock', '--force'], {
      encoding: 'utf8', env: { ...process.env, HOME: ctx.home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(dir), false);
    assert.equal(state(ctx), null, 'no migration ran');
    const noTty = spawnSync(process.execPath, [join(ROOT, 'bin', 'agb.mjs'), 'migrate', '--break-lock'], {
      encoding: 'utf8', env: { ...process.env, HOME: ctx.home }, input: '',
    });
    assert.equal(noTty.status, 0, 'no lock present → nothing to confirm');
  } finally { ctx.cleanup(); }
});

test('pre-flight: a source without hooks.json is missing the hooks category', async () => {
  const ctx = setup();
  try {
    rmSync(join(ctx.src, 'hooks.json'));
    assert.equal(await run(ctx), 1);
    assert.match(ctx.errs.join('\n'), /missing component categories: hooks$/m);
  } finally { ctx.cleanup(); }
});

test('CLI: --break-lock without --force and without a TTY refuses and keeps the lock', () => {
  const ctx = setup();
  try {
    const dir = migrationLockDir(ctx.home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ pid: 999999, token: 't', startedAt: 'then' }));
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'agb.mjs'), 'migrate', '--break-lock'], {
      encoding: 'utf8', env: { ...process.env, HOME: ctx.home }, input: 'y\n',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Lock left in place/);
    assert.ok(existsSync(dir));
  } finally { ctx.cleanup(); }
});

test('CLI: --finish-uninstall reads flag values in any position (token first)', () => {
  const ctx = setup();
  try {
    writeMigrationState(ctx.home, { state: 'ROLLED_BACK_PENDING_UNINSTALL' });
    const h = acquireMigrationLock({ home: ctx.home });
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'agb.mjs'), 'migrate', '--token', h.token, '--finish-uninstall', '--agy-bin', FAKE_AGY], {
      encoding: 'utf8', env: { ...process.env, HOME: ctx.home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(state(ctx).state, 'ROLLED_BACK');
  } finally { ctx.cleanup(); }
});
