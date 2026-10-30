import test from 'node:test';
import assert from 'node:assert';
import { checkNodeVersion, checkAgyBinary, checkAgyAuth, checkModelCatalog, parseAgyModels, compareModelCatalog, checkAdlcBinary, checkSandbox, checkBrainDir, checkPlugin, checkTicketStore, checkKernelContainment, runDoctor } from '../lib/doctor.mjs';
import { resolveAdlcBinary, MIN_ADLC_CLI_VERSION } from '../lib/adlc-bridge.mjs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, chmodSync, rmSync, mkdirSync, mkdtempSync, existsSync } from 'fs';

// AGB_PLUGIN_ROOT: vendor-less fixture: these suites exercise the legacy (unbundled)
// adlc tiers, which spec Appendix A.6 item 12 reaches only without vendor/adlc.
process.env.AGB_PLUGIN_ROOT ??= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'agb-no-vendor-'));

test('checkNodeVersion: passes on v22.19.0+ and fails on older versions', async () => {
  const current = await checkNodeVersion();
  assert.equal(current.level, 'pass');

  const v2219 = await checkNodeVersion({ version: 'v22.19.0' });
  assert.equal(v2219.level, 'pass');

  const v24 = await checkNodeVersion({ version: 'v24.14.1' });
  assert.equal(v24.level, 'pass');

  const v18 = await checkNodeVersion({ version: 'v18.20.0' });
  assert.equal(v18.level, 'fail');
  assert.match(v18.fix, /Upgrade Node\.js to v22\.19\.0 or newer/);

  const v20 = await checkNodeVersion({ version: 'v20.10.0' });
  assert.equal(v20.level, 'fail');

  const v2218 = await checkNodeVersion({ version: 'v22.18.9' });
  assert.equal(v2218.level, 'fail');
});

test('checkAgyBinary: passes when fake-agy is provided', async () => {
  const FAKE_AGY = join(process.cwd(), 'test/fixtures/fake-agy');
  const res = await checkAgyBinary({ env: { AGB_AGY_BIN: FAKE_AGY } });
  assert.equal(res.level, 'pass');
  assert.match(res.detail, /^vagy version/);
});

test('checkAgyBinary: fails when not found', async () => {
  const res = await checkAgyBinary({ env: { AGB_AGY_BIN: '/does/not/exist' } });
  assert.equal(res.level, 'fail');
});

test('checkAgyAuth: fails when FAKE_AGY_MODE=empty', async () => {
  const FAKE_AGY = join(process.cwd(), 'test/fixtures/fake-agy');
  const res = await checkAgyAuth({ env: { AGB_AGY_BIN: FAKE_AGY, FAKE_AGY_MODE: 'empty' } });
  assert.equal(res.level, 'fail');
});

test('checkAdlcBinary: warns when missing', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-missing-adlc-'));
  try {
    const res = await checkAdlcBinary({ cwd: d, env: {} });
    assert.equal(res.level, 'warn');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkSandbox: bypassed via env', async () => {
  const res = await checkSandbox({ env: { AGB_SANDBOX_GATES: '0' }, platform: 'linux' });
  assert.equal(res.level, 'pass');
});

test('checkSandbox: fails on unsupported platform without bypass', async () => {
  const res = await checkSandbox({ env: {}, platform: 'win32' });
  assert.equal(res.level, 'fail');
});

test('checkSandbox: linux passes if bwrap is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-bwrap-test-'));
  try {
    writeFileSync(join(dir, 'which'), '#!/bin/sh\nexit 0');
    chmodSync(join(dir, 'which'), 0o755);
    writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\nexit 0');
    chmodSync(join(dir, 'bwrap'), 0o755);
    const res = await checkSandbox({ env: { PATH: dir }, platform: 'linux' });
    assert.equal(res.level, 'pass');
    assert.equal(res.detail, 'bwrap available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkSandbox: linux fails if bwrap is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-nobwrap-test-'));
  try {
    writeFileSync(join(dir, 'which'), '#!/bin/sh\nif [ "$1" = "bwrap" ]; then exit 1; fi\nexit 0');
    chmodSync(join(dir, 'which'), 0o755);
    const res = await checkSandbox({ env: { PATH: dir }, platform: 'linux' });
    assert.equal(res.level, 'fail');
    assert.ok(res.detail.includes('bwrap missing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkSandbox: linux fails if bwrap is present but fails usability probe (namespaces restricted)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-unusable-bwrap-test-'));
  try {
    writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\nexit 1');
    chmodSync(join(dir, 'bwrap'), 0o755);
    const res = await checkSandbox({ env: { PATH: dir }, platform: 'linux' });
    assert.equal(res.level, 'fail');
    assert.ok(res.detail.includes('bwrap unusable'));
    assert.ok(res.fix.includes('user namespaces'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBrainDir: passes when dir exists', async () => {
  const d = join(tmpdir(), 'agb-test-brain');
  mkdirSync(d, { recursive: true });
  try {
    const res = await checkBrainDir({ env: { AGB_BRAIN_DIR: d } });
    assert.equal(res.level, 'pass');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// checkPlugin evaluates the STAGED plugin (~/.gemini/config/plugins/
// adlc-antigravity) per the §4.4 decision table; full row coverage is in
// test/doctor-contract.test.mjs.
async function checkStaged(manifest) {
  const home = mkdtempSync(join(tmpdir(), 'agb-test-plugin-home-'));
  try {
    const dir = join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
    return await checkPlugin({ home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('checkPlugin: warns when a newer plugin declares no contract (tolerant)', async () => {
  const res = await checkStaged({ version: '2.0.0' });
  assert.equal(res.level, 'warn');
  assert.equal(res.detail, 'tolerant (unconfirmed-contract)');
});

test('checkPlugin: passes when a newer plugin declares contract 1', async () => {
  const res = await checkStaged({ version: '1.8.0', adlcContract: 1 });
  assert.equal(res.level, 'pass');
  assert.equal(res.detail, 'compatible (newer-unpinned: v1.8.0)');
});

test('checkPlugin: fails when the contract is incompatible', async () => {
  const res = await checkStaged({ version: '1.8.0', adlcContract: 999 });
  assert.equal(res.level, 'fail');
  assert.equal(res.detail, 'incompatible-contract');
  assert.match(res.fix, /--force-reinstall/);
});

// --- checkTicketStore: the repo's ADLC ticket backend ---
// The directory store (.adlc/tickets/ + .store.json) is canonical; the single
// tickets.json is the 1.x legacy bridge. Both present at once is a fail-closed
// state for the adlc-antigravity plugin's reader, so doctor must FAIL on it.

test('checkTicketStore: no store is a pass (created on first projection)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-none-'));
  try {
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /none/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: reports the directory backend', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-dir-'));
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /directory/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: FAILS on the retired legacy backend with the migrate instruction', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-legacy-'));
  try {
    mkdirSync(join(d, '.adlc'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /legacy/);
    assert.match(res.fix, /adlc ticket store migrate/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: FAILS when both stores exist (plugin fails closed on this)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-both-'));
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');
    writeFileSync(join(d, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'fail');
    assert.ok(res.fix, 'both-stores failure carries fix text');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: warns on an orphaned directory store (dir without .store.json)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-orphan-'));
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'warn');
    assert.match(res.detail, /orphaned/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: FAILS on a dangling or symlinked .adlc store path', async () => {
  const { symlinkSync } = await import('node:fs');
  const d = mkdtempSync(join(tmpdir(), 'agb-test-store-symlink-'));
  try {
    symlinkSync(join(d, 'nonexistent-adlc'), join(d, '.adlc'));
    const res = await checkTicketStore({ cwd: d });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /symlinked ADLC ticket store path/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: resolves project-local @adlc/cli and validates version floor', () => {
  const res = resolveAdlcBinary({ repo: process.cwd() });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'project-local');
  assert.match(res.version, /^1\.12\./);
});

test('resolveAdlcBinary: fails closed when local dependency is missing', () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-no-adlc-'));
  try {
    const res = resolveAdlcBinary({ repo: d });
    assert.equal(res.ok, false);
    assert.match(res.error, /missing or unverified/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('resolveAdlcBinary: fails when package version is below floor', () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-old-adlc-'));
  try {
    const pkgDir = join(d, 'node_modules', '@adlc', 'cli');
    const binDir = join(d, 'node_modules', '.bin');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.6.0', bin: { adlc: './bin.js' } }));
    writeFileSync(join(pkgDir, 'bin.js'), '#!/usr/bin/env node\n');
    chmodSync(join(pkgDir, 'bin.js'), 0o755);
    writeFileSync(join(binDir, 'adlc'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'adlc'), 0o755);

    const res = resolveAdlcBinary({ repo: d });
    assert.equal(res.ok, false);
    assert.match(res.error, /does not meet floor/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: passes on current repo with local @adlc/cli', async () => {
  const res = await checkAdlcBinary({ cwd: process.cwd() });
  assert.equal(res.level, 'pass');
  assert.match(res.detail, /^v1.12\./);
});

test('checkAdlcBinary: fails when local @adlc/cli fails package manifest authentication', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-auth-fail-'));
  try {
    const pkgDir = join(d, 'node_modules', '@adlc', 'cli');
    const binDir = join(d, 'node_modules', '.bin');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // Invalid version < 1.11.1
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.6.0', bin: { adlc: './bin.js' } }));
    writeFileSync(join(pkgDir, 'bin.js'), '#!/usr/bin/env node\n');
    chmodSync(join(pkgDir, 'bin.js'), 0o755);
    writeFileSync(join(binDir, 'adlc'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'adlc'), 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: {} });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /package manifest authentication failed/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: fails when custom adlc binary resides in temporary directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-temp-bin-'));
  try {
    const fakeBin = join(d, 'fake-adlc');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.12.0', bin: { adlc: './fake-adlc' } }));
    writeFileSync(fakeBin, '#!/bin/sh\necho "1.12.0"\n');
    chmodSync(fakeBin, 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: { AGB_ADLC_BIN: fakeBin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /temporary directory/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: fails when adlc version is below floor', async () => {
  const d = mkdtempSync(join(process.cwd(), '.test-adlc-old-ver-'));
  try {
    const fakeBin = join(d, 'fake-old-adlc');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.12.0', bin: { adlc: './fake-old-adlc' } }));
    writeFileSync(fakeBin, '#!/bin/sh\necho "1.6.0"\n');
    chmodSync(fakeBin, 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: { AGB_ADLC_BIN: fakeBin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /required >= v1\.11\.1/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkAdlcBinary: fails when authenticated binary fails to execute', async () => {
  const d = mkdtempSync(join(process.cwd(), '.test-adlc-exec-fail-'));
  try {
    const fakeBin = join(d, 'fake-broken-adlc');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@adlc/cli', version: '1.12.0', bin: { adlc: './fake-broken-adlc' } }));
    writeFileSync(fakeBin, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeBin, 0o755);

    const res = await checkAdlcBinary({ cwd: d, env: { AGB_ADLC_BIN: fakeBin, AGB_ALLOW_CUSTOM_ADLC_CLI: '1' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /execution failed/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: reports store corruption when adlc ticket doctor exits non-zero', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-corrupt-store-'));
  const FAKE_ADLC = join(process.cwd(), 'test/fixtures/fake-adlc');
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');

    const res = await checkTicketStore({ cwd: d, env: { AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1', FAKE_TICKET_DOCTOR_MODE: 'fail' } });
    assert.equal(res.level, 'fail');
    assert.match(res.detail, /store corruption/);
    assert.match(res.detail, /orphan shard detected/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: passes when adlc ticket doctor exits zero', async () => {
  const d = mkdtempSync(join(tmpdir(), 'agb-test-pass-store-'));
  const FAKE_ADLC = join(process.cwd(), 'test/fixtures/fake-adlc');
  try {
    mkdirSync(join(d, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(d, '.adlc', 'tickets', '.store.json'), '{"format":"adlc-ticket-directory","version":1}\n');

    const res = await checkTicketStore({ cwd: d, env: { AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1', FAKE_TICKET_DOCTOR_MODE: 'pass' } });
    assert.equal(res.level, 'pass');
    assert.match(res.detail, /directory backend/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('checkTicketStore: runs cleanly on current repo with project-local @adlc/cli', async () => {
  const res = await checkTicketStore({ cwd: process.cwd() });
  assert.equal(res.level, 'pass');
  assert.match(res.detail, /directory backend/);
});

test('checkKernelContainment: ignores mocks outside test mode when NODE_ENV is production', () => {
  // Outside test mode (NODE_ENV=production), mocks must be ignored
  const resUnavailable = checkKernelContainment('unsupported_test_os', {
    env: { NODE_ENV: 'production', AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1' },
  });
  assert.equal(resUnavailable.kind, 'unsupported_platform');
  assert.notEqual(resUnavailable.kind, 'mock_unavailable');

  const resMechanism = checkKernelContainment('unsupported_test_os', {
    env: { NODE_ENV: 'production', AGB_MOCK_CONTAINMENT_MECHANISM: 'mock_custom' },
  });
  assert.equal(resMechanism.kind, 'unsupported_platform');
  assert.notEqual(resMechanism.mechanism, 'mock_custom');

  // Verify that inside test mode, mocks are respected
  const resMocked = checkKernelContainment('unsupported_test_os', {
    env: { AGB_MOCK_CONTAINMENT_UNAVAILABLE: '1' },
  });
  assert.equal(resMocked.kind, 'mock_unavailable');
});


// --- model catalog drift ---

function fakeAgyModels(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agb-doctor-models-'));
  const bin = join(dir, 'agy');
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "models" ]; then\ncat <<'EOT'\n${lines.join('\n')}\nEOT\nfi\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test('parseAgyModels: keeps slug column, ignores the status line, blanks, and CRLF', () => {
  const out = 'Fetching available models...\r\ngemini-4-argon-low\tGemini 4 Argon (Low)\r\n\r\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';
  assert.deepStrictEqual(parseAgyModels(out), ['gemini-4-argon-low', 'gpt-oss-120b-medium']);
  assert.deepStrictEqual(parseAgyModels('Fetching available models...\n'), []);
  assert.deepStrictEqual(parseAgyModels(''), []);
});

test('compareModelCatalog: reports retired (known, not live) and unrecognized (live, not known)', () => {
  const r = compareModelCatalog(['a', 'b', 'x'], ['a', 'b', 'c']);
  assert.deepStrictEqual(r, { retired: ['c'], unrecognized: ['x'] });
  assert.deepStrictEqual(compareModelCatalog(['a'], ['a']), { retired: [], unrecognized: [] });
});

test('checkModelCatalog: passes against the live-catalog fixture', async () => {
  const FAKE_AGY = join(process.cwd(), 'test/fixtures/fake-agy');
  const res = await checkModelCatalog({ env: { AGB_AGY_BIN: FAKE_AGY } });
  assert.strictEqual(res.name, 'Model catalog');
  assert.strictEqual(res.level, 'pass');
  assert.strictEqual(res.fix, null);
});

test('checkModelCatalog: warns and names drifted slugs in both directions', async () => {
  const { bin, dir } = fakeAgyModels([
    'Fetching available models...',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'gemini-9-nova-high\tGemini 9 Nova (High)',
  ]);
  try {
    const res = await checkModelCatalog({ env: { AGB_AGY_BIN: bin } });
    assert.strictEqual(res.level, 'warn');
    assert.match(res.detail, /gemini-9-nova-high/);
    assert.match(res.detail, /claude-opus-5-5-high/);
    assert.match(res.detail, /unrecognized/);
    assert.match(res.detail, /retired/);
    assert.ok(res.fix);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkModelCatalog: unavailable agy degrades to a warning, never throws', async () => {
  const res = await checkModelCatalog({ env: { AGB_AGY_BIN: '/does/not/exist' } });
  assert.strictEqual(res.level, 'warn');
  assert.match(res.detail, /could not list models/);
});

test('checkModelCatalog: output with no model rows is a warning, not a pass', async () => {
  const { bin, dir } = fakeAgyModels(['Fetching available models...']);
  try {
    const res = await checkModelCatalog({ env: { AGB_AGY_BIN: bin } });
    assert.strictEqual(res.level, 'warn');
    assert.match(res.detail, /no models/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseAgyModels: parses a real pty capture (spinner, ANSI, CR overwrite, TAB expanded to spaces)', () => {
  const pty =
    '\u001b[>c\r⠋ Fetching available models...\r⠙ Fetching available models...\r\u001b[K' +
    'gemini-4-argon-medium     Gemini 4 Argon (Medium)\r\n' +
    'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\r\n' +
    'claude-opus-5-5-low       Claude Opus 5.5 (Low)\r\n' +
    'gpt-oss-120b-medium       GPT-OSS 120B (Medium)\r\n';
  assert.deepStrictEqual(parseAgyModels(pty), [
    'gemini-4-argon-medium', 'gemini-3.8-flash-high', 'claude-opus-5-5-low', 'gpt-oss-120b-medium',
  ]);
});

test('parseAgyModels: ignores prose that merely resembles a row', () => {
  assert.deepStrictEqual(parseAgyModels('Fetching available models...\nError: not signed in\nTotal 3 models\n'), []);
});

test('parseAgyModels: strips colour and cursor escapes, accepts a 2-space or TAB column gap', () => {
  const out =
    '\u001b[?25l\u001b[0mgemini-4-argon-low  Gemini 4 Argon (Low)\u001b[0m\n' +
    '\u001b[1;32mclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n';
  assert.deepStrictEqual(parseAgyModels(out), ['gemini-4-argon-low', 'claude-opus-5-5-high']);
  // A single space is prose, not a column gap.
  assert.deepStrictEqual(parseAgyModels('gemini-4-argon-low Gemini\n'), []);
});

test('checkModelCatalog: retired-only and unrecognized-only drift each warn on their own', async () => {
  const { MODELS } = await import('../lib/models.mjs');
  const all = Object.values(MODELS).flat();
  const row = (s) => `${s}\t${s}`;

  const retiredOnly = fakeAgyModels(all.slice(1).map(row));
  const unknownOnly = fakeAgyModels([...all, 'gemini-9-nova-high'].map(row));
  try {
    const a = await checkModelCatalog({ env: { AGB_AGY_BIN: retiredOnly.bin } });
    assert.strictEqual(a.level, 'warn');
    assert.strictEqual(a.detail, `retired: ${all[0]}`);
    const b = await checkModelCatalog({ env: { AGB_AGY_BIN: unknownOnly.bin } });
    assert.strictEqual(b.level, 'warn');
    assert.strictEqual(b.detail, 'unrecognized: gemini-9-nova-high');
  } finally {
    rmSync(retiredOnly.dir, { recursive: true, force: true });
    rmSync(unknownOnly.dir, { recursive: true, force: true });
  }
});

test('checkModelCatalog: runs agy under a pty on linux, without leaving a script log behind', { skip: process.platform !== 'linux' || spawnSync('script', ['--version'], { stdio: 'ignore' }).error !== undefined }, async () => {
  const { MODELS } = await import('../lib/models.mjs');
  const all = Object.values(MODELS).flat();
  const dir = mkdtempSync(join(tmpdir(), 'agb-doctor-tty-'));
  const bin = join(dir, 'agy');
  // Only prints models when stdout is a terminal, like the real agy.
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "models" ]; then\n  if [ -t 1 ]; then\n${all.map((s) => `    printf '%s\\t%s\\n' '${s}' '${s}'`).join('\n')}\n  else\n    echo "stdout is not a terminal"\n  fi\nfi\n`);
  chmodSync(bin, 0o755);
  try {
    const res = await checkModelCatalog({ env: { AGB_AGY_BIN: bin } });
    assert.strictEqual(res.level, 'pass', res.detail);
    assert.strictEqual(existsSync(join(process.cwd(), 'typescript')), false, '`script` must log to /dev/null, not ./typescript');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), 'typescript'), { force: true });
  }
});

test('parseAgyModels: strips a device-attributes query (ESC[>c) that sits directly before a slug', () => {
  assert.deepStrictEqual(parseAgyModels('\u001b[>cgemini-4-argon-low  Gemini 4 Argon (Low)\n'), ['gemini-4-argon-low']);
});

test('parseAgyModels: error text and table headers are not models', () => {
  for (const line of [
    'error   Failed to fetch models',
    'name    description',
    'unauthorized  please run agy login',
    'a.b  c',
    'Fetching available models...',
  ]) {
    assert.deepStrictEqual(parseAgyModels(`${line}\r\n`), [], line);
  }
  // ...while real hyphenated slugs, including dotted versions, still parse.
  assert.deepStrictEqual(parseAgyModels('gemini-3.8-flash-low  Gemini 3.8 Flash (Low)\n'), ['gemini-3.8-flash-low']);
});

test('checkModelCatalog: error text instead of a listing stays "no models returned"', async () => {
  const { bin, dir } = fakeAgyModels(['error   Failed to fetch models']);
  try {
    const res = await checkModelCatalog({ env: { AGB_AGY_BIN: bin } });
    assert.strictEqual(res.level, 'warn');
    assert.match(res.detail, /no models returned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
