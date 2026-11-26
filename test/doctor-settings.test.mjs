import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCliSettings, stripJsonc } from '../lib/doctor-settings.mjs';
import { applyDoctorFixes } from '../lib/doctor.mjs';

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-settings-test-'));
  const cliDir = join(dir, '.gemini', 'antigravity-cli');
  mkdirSync(cliDir, { recursive: true });
  return { dir, cliDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('stripJsonc handles comments, escapes, strings and BOM correctly', () => {
  assert.equal(stripJsonc('"" // comment'), '"" ');
  assert.equal(stripJsonc('"\\"" // comment'), '"\\"" ');
  assert.equal(stripJsonc('"\\\\" // comment'), '"\\\\" ');
  assert.equal(stripJsonc('// line comment\n{"a": 1}'), '\n{"a": 1}');
  assert.equal(stripJsonc('// line comment\r\n{"a": 1}'), '\r\n{"a": 1}');
  assert.equal(stripJsonc('/* block */{"a": 1}'), '{"a": 1}');
  assert.equal(stripJsonc('{"url": "https://example.com/api/*", "slash": "//"}'), '{"url": "https://example.com/api/*", "slash": "//"}');
  assert.equal(stripJsonc('\uFEFF{"a": ""}\n'), '{"a": ""}\n');
  assert.equal(stripJsonc(''), '');
  assert.equal(stripJsonc(null), '');
});

test('checkCliSettings: returns pass with defaults when settings.json is absent', () => {
  const { dir, cleanup } = makeHome();
  try {
    const res = checkCliSettings({ home: dir });
    assert.deepEqual(res, { name: 'CLI settings', level: 'pass', detail: 'defaults (no settings.json)', fix: null });
  } finally { cleanup(); }
});

test('checkCliSettings: resolves home via env.HOME when home is omitted', () => {
  const { dir, cleanup } = makeHome();
  try {
    const res = checkCliSettings({ env: { HOME: dir } });
    assert.equal(res.level, 'pass');
    assert.equal(res.detail, 'defaults (no settings.json)');
  } finally { cleanup(); }
});

test('checkCliSettings: warns on non-ENOENT error (ENOTDIR)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-enotdir-'));
  try {
    writeFileSync(join(dir, '.gemini'), 'regular-file-not-directory');
    const res = checkCliSettings({ home: dir });
    assert.equal(res.level, 'warn');
    assert.match(res.detail, /^unreadable settings:/);
    assert.ok(res.fix);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkCliSettings: warns on symbolic link, non-regular file, and size limits', () => {
  const { dir, cliDir, cleanup } = makeHome();
  try {
    const realSettings = join(dir, 'real-settings.json');
    writeFileSync(realSettings, '{}');
    symlinkSync(realSettings, join(cliDir, 'settings.json'));
    const symRes = checkCliSettings({ home: dir });
    assert.equal(symRes.level, 'warn');
    assert.equal(symRes.detail, 'settings.json is a symbolic link');

    rmSync(join(cliDir, 'settings.json'));
    mkdirSync(join(cliDir, 'settings.json'));
    const dirRes = checkCliSettings({ home: dir });
    assert.equal(dirRes.level, 'warn');
    assert.equal(dirRes.detail, 'settings.json is not a regular file');
    rmSync(join(cliDir, 'settings.json'), { recursive: true });

    const maxBytes = 1024 * 1024;
    const padLen = maxBytes - '{\n  "pad": ""\n}\n'.length;
    const exact1Mb = `{\n  "pad": "${'a'.repeat(padLen)}"\n}\n`;
    assert.equal(Buffer.byteLength(exact1Mb), maxBytes);
    writeFileSync(join(cliDir, 'settings.json'), exact1Mb);
    const passRes = checkCliSettings({ home: dir });
    assert.equal(passRes.level, 'pass');
    assert.equal(passRes.detail, 'guardrails intact');

    const over1Mb = `{\n  "pad": "${'a'.repeat(padLen + 1)}"\n}\n`;
    assert.equal(Buffer.byteLength(over1Mb), maxBytes + 1);
    writeFileSync(join(cliDir, 'settings.json'), over1Mb);
    const overRes = checkCliSettings({ home: dir });
    assert.equal(overRes.level, 'warn');
    assert.equal(overRes.detail, 'settings.json exceeds 1MB limit');
  } finally { cleanup(); }
});

test('checkCliSettings: warns on invalid JSON syntax and non-object root', () => {
  const { dir, cliDir, cleanup } = makeHome();
  try {
    writeFileSync(join(cliDir, 'settings.json'), '{ invalid json');
    const invRes = checkCliSettings({ home: dir });
    assert.equal(invRes.level, 'warn');
    assert.match(invRes.detail, /^invalid JSON:/);

    for (const val of ['[]', '"hello"', '123', 'null', 'true']) {
      writeFileSync(join(cliDir, 'settings.json'), val);
      const res = checkCliSettings({ home: dir });
      assert.equal(res.level, 'warn');
      assert.equal(res.detail, 'settings must be a JSON object');
    }
  } finally { cleanup(); }
});

test('checkCliSettings: warns on toolPermission=always-proceed and allowNonWorkspaceAccess=true', () => {
  const { dir, cliDir, cleanup } = makeHome();
  try {
    writeFileSync(join(cliDir, 'settings.json'), '{"toolPermission": "always-proceed"}');
    const tpRes = checkCliSettings({ home: dir });
    assert.equal(tpRes.level, 'warn');
    assert.match(tpRes.detail, /toolPermission is 'always-proceed'/);

    writeFileSync(join(cliDir, 'settings.json'), '{"allowNonWorkspaceAccess": true}');
    const anwaRes = checkCliSettings({ home: dir });
    assert.equal(anwaRes.level, 'warn');
    assert.match(anwaRes.detail, /allowNonWorkspaceAccess is enabled/);
  } finally { cleanup(); }
});

test('checkCliSettings: validates permissions object, bucket arrays, and rules', () => {
  const { dir, cliDir, cleanup } = makeHome();
  try {
    writeFileSync(join(cliDir, 'settings.json'), '{"permissions": "not-an-object"}');
    assert.equal(checkCliSettings({ home: dir }).detail, 'permissions must be an object');

    writeFileSync(join(cliDir, 'settings.json'), '{"permissions": []}');
    assert.equal(checkCliSettings({ home: dir }).detail, 'permissions must be an object');

    for (const bucket of ['allow', 'ask', 'deny']) {
      writeFileSync(join(cliDir, 'settings.json'), JSON.stringify({ permissions: { [bucket]: 'not-array' } }));
      assert.equal(checkCliSettings({ home: dir }).detail, `permissions.${bucket} must be an array`);

      writeFileSync(join(cliDir, 'settings.json'), JSON.stringify({ permissions: { [bucket]: ['bad rule'] } }));
      assert.match(checkCliSettings({ home: dir }).detail, new RegExp(`invalid permission rule in permissions\\.${bucket}: bad rule`));
    }
  } finally { cleanup(); }
});

test('checkCliSettings: passes on valid settings with JSONC comments and permissions', () => {
  const { dir, cliDir, cleanup } = makeHome();
  try {
    const validConfig = `// Leading comment
{
  /* Block comment */
  "allowNonWorkspaceAccess": false,
  "toolPermission": "ask",
  "permissions": {
    "allow": ["read_file(*)"],
    "ask": ["command(*)"],
    "deny": [
      "write_file(.git/)",
      "command(rm -rf)" // trailing comment
    ]
  }
}
`;
    writeFileSync(join(cliDir, 'settings.json'), validConfig);
    const res = checkCliSettings({ home: dir });
    assert.deepEqual(res, { name: 'CLI settings', level: 'pass', detail: 'guardrails intact', fix: null });
  } finally { cleanup(); }
});

test('applyDoctorFixes: never mutates or creates settings.json', async () => {
  const { dir, cliDir, cleanup } = makeHome();
  const repoDir = mkdtempSync(join(tmpdir(), 'agb-fix-repo-'));
  try {
    const settingsPath = join(cliDir, 'settings.json');
    await applyDoctorFixes({ cwd: repoDir, home: dir, env: { HOME: dir } });
    assert.equal((await import('node:fs')).existsSync(settingsPath), false);

    writeFileSync(settingsPath, '{"toolPermission": "always-proceed"}');
    const contentBefore = (await import('node:fs')).readFileSync(settingsPath, 'utf8');
    await applyDoctorFixes({ cwd: repoDir, home: dir, env: { HOME: dir } });
    const contentAfter = (await import('node:fs')).readFileSync(settingsPath, 'utf8');
    assert.equal(contentBefore, contentAfter);
  } finally {
    cleanup();
    rmSync(repoDir, { recursive: true, force: true });
  }
});
