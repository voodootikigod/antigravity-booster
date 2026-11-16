import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bootstrap } from '../lib/bootstrap.mjs';
import { writeStore } from '../maintainer-skills/modernize/scripts/trust-anchor.mjs';

const FAKE_AGY = join(import.meta.dirname, 'fixtures', 'fake-agy');
const AUDIT_SCRIPT = join(import.meta.dirname, '..', 'maintainer-skills', 'modernize', 'scripts', 'audit.mjs');

function makeTempDir(prefix = 'agb-mod-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('Modernize Skill: bootstrap does NOT expose internal skills (modernize, release, release-audit) and cleans up stale symlinks', () => {
  const destDir = makeTempDir('agb-dest-skills-');
  const homeDir = makeTempDir('agb-mod-home-');
  try {
    // Plant a stale symlink to old skills/modernize location to verify cleanup
    const oldTarget = join(import.meta.dirname, '..', 'skills', 'modernize');
    symlinkSync(oldTarget, join(destDir, 'modernize'));
    assert.ok(lstatSync(join(destDir, 'modernize')).isSymbolicLink());

    bootstrap({ destination: destDir, home: homeDir, agyBin: FAKE_AGY });
    const entries = readdirSync(destDir);
    assert.ok(entries.includes('agb'), 'agb router skill was linked');
    assert.equal(entries.includes('modernize'), false, 'internal modernize skill must not be linked into user skills');
    assert.equal(entries.includes('release'), false, 'internal release skill must not be linked into user skills');
    assert.equal(entries.includes('release-audit'), false, 'internal release-audit skill must not be linked into user skills');

    const stagedSkills = readdirSync(join(homeDir, '.gemini', 'config', 'plugins', 'antigravity-booster', 'skills'));
    assert.equal(stagedSkills.includes('modernize'), false, 'staged plugin must not contain modernize');
    assert.equal(stagedSkills.includes('release'), false, 'staged plugin must not contain release');
    assert.equal(stagedSkills.includes('release-audit'), false, 'staged plugin must not contain release-audit');
    assert.equal(
      existsSync(join(homeDir, '.gemini', 'config', 'plugins', 'antigravity-booster', 'maintainer-skills')),
      false,
      'staged plugin must exclude maintainer-skills/',
    );
  } finally {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Modernize Skill: SKILL.md frontmatter and structure conformance', () => {
  const skillMdPath = join(import.meta.dirname, '..', 'maintainer-skills', 'modernize', 'SKILL.md');
  assert.ok(existsSync(skillMdPath), 'maintainer-skills/modernize/SKILL.md exists');
  const content = readFileSync(skillMdPath, 'utf8');

  // Verify YAML frontmatter
  assert.match(content, /^---\n/);
  assert.match(content, /name:\s*modernize/);
  assert.match(content, /internal:\s*true/);
  assert.match(content, /user-invocable:\s*true/);
  assert.match(content, /license:\s*MIT/);

  // Verify documented stages and triggers
  assert.match(content, /Stage 1:/);
  assert.match(content, /Stage 2:/);
  assert.match(content, /Stage 3:/);
  assert.match(content, /Stage 4:/);
  assert.match(content, /Stage 5:/);
  assert.match(content, /Codeweight & Tech-Debt Pruning/);
  assert.match(content, /Pillar 6: Deprecation & Codeweight Pruning/);
  assert.doesNotMatch(content, /roadmap-agy-1\.2\.8-adlc-1\.11\.1/, 'the skill must name the roadmap by its target arguments, not a past release');
  assert.match(content, /Adversarial-Review & Fix Loop/);
  assert.match(content, /audit\.mjs/);
});

const AGY_RELEASE_FIXTURE = join(import.meta.dirname, '..', 'docs', 'research', 'roadmap-agy-1.5.9-adlc-1.13.0.md');
const ADLC_CHANGELOG_FIXTURE = join(import.meta.dirname, 'fixtures', 'adlc-changelog-fixture-1.11.1.json');
const REPO_WITH_NM = (() => {
  let d = join(import.meta.dirname, '..');
  while (d !== dirname(d)) {
    const nm = join(d, 'node_modules');
    if (existsSync(nm) && !lstatSync(nm).isSymbolicLink()) break;
    d = dirname(d);
  }
  return d;
})();

function makeAuditRepoCopy() {
  const dir = makeTempDir('agb-mod-repo-');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  for (const rel of readdirSync(join(REPO_WITH_NM, 'lib')).filter((f) => f.endsWith('.mjs'))) {
    writeFileSync(join(dir, 'lib', rel), readFileSync(join(REPO_WITH_NM, 'lib', rel)));
  }
  writeFileSync(join(dir, 'package.json'), readFileSync(join(REPO_WITH_NM, 'package.json')));
  symlinkSync(join(REPO_WITH_NM, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

// Stage 5 only has built-in anchors for ADLC 1.11.1; any later target needs an
// operator-signed trust store. These tests sign a throwaway store (temp HOME,
// throwaway key) with the registry digests of the published @adlc/cli@1.13.0
// tarball and the sha256 of the pinned changelog fixture, never the real store.
const AUDIT_ADLC_TARGET = '1.13.0';
const AUDIT_AGY_TARGET = '1.5.9';
const AUDIT_TEST_KEY = 'agb-test-only-admin-key';
function auditTrustEnv() {
  const home = makeTempDir('agb-mod-trust-home-');
  writeStore(join(home, '.adlc', 'trusted_packages.json'), {
    releases: {
      [AUDIT_AGY_TARGET]: { agyChangelogSha256: createHash('sha256').update(readFileSync(AGY_RELEASE_FIXTURE)).digest('hex') },
      [AUDIT_ADLC_TARGET]: {
        adlcTarballSri: 'sha512-Cd54ptOQWZvE6NTKbs0SJwSU/UY0wAAXZo2xjqm2cBh9EEmmNl8SE2HDRGx+HlTpkrL/R9JxjZrGsRKfkb1MEA==',
        packageTreeSha512: 'f956e1a899d180581353846d6ca920436e0d0f766021e870ebacf075f75be632ee9281a7384712de0c3a23c1571f0a1b5a08af2d6ef4b2a39af536c2832e31f0',
        adlcChangelogSha256: '0b036f0b4e50bb8b9d7a5c198d715981fd695521a1a41f3c4eceedba027477e4',
      },
    },
  }, AUDIT_TEST_KEY);
  return { home, env: { ...process.env, HOME: home, ADLC_ADMIN_KEY: AUDIT_TEST_KEY, AGB_AGY_BIN: FAKE_AGY, AGY_RELEASE_URL: AGY_RELEASE_FIXTURE, AGB_ROADMAP_PATH: AGY_RELEASE_FIXTURE, ADLC_CHANGELOG_URL: ADLC_CHANGELOG_FIXTURE, PATH: '/usr/bin:/bin' } };
}

test('Modernize Skill: audit.mjs executes full 5-stage pipeline', () => {
  const trust = auditTrustEnv();
  const tempRepo = makeAuditRepoCopy();
  let out;
  try {
    out = execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
      cwd: tempRepo,
      env: trust.env,
      encoding: 'utf8',
    });
  } finally {
    rmSync(trust.home, { recursive: true, force: true });
    rmSync(tempRepo, { recursive: true, force: true });
  }

  assert.match(out, /Stage 1 \(Live Runtime Probes\):\s*\[PASS\]/);
  assert.match(out, /Stage 2 \(Static Codebase Audit\):\s*\[PASS\]/);
  assert.match(out, /Codeweight audit: lib\/ total \d+ lines \([\d.]+ KB\)\. Found 0 pruning candidate\(s\)\./);
  assert.match(out, /Stage 3 \(Subsystem Delta Matrix\):\s*\[PASS\]/);
  assert.match(out, /Pillar 6: Deprecation & Codeweight Pruning: Codebase clean of deprecated models and dead shims/);
  assert.match(out, /Pillar 1: Model Catalog & Dual-Pool Quota Routing: Verified 22 models aligned with live runtime/, 'the registry in lib/models.mjs matches the live catalog, so nothing is reported as new');
  assert.match(out, /Stage 4 \(Roadmap DAG Validation\):\s*\[PASS\]/);
  assert.match(out, /Stage 5 \(Provenance & Release Ledger\):\s*\[PASS\]/);
  assert.match(out, /All checks PASSED/);
});

test('Modernize Skill: audit.mjs refuses to run without explicit release targets', () => {
  const tempRepo = makeAuditRepoCopy();
  try {
    for (const args of [[], ['1.13.0'], ['1.13.0', '', '']]) {
      assert.throws(
        () => execFileSync(process.execPath, [AUDIT_SCRIPT, ...args], {
          cwd: tempRepo,
          env: { ...process.env, ADLC_TARGET_VERSION: '', AGY_TARGET_VERSION: '', AGB_AGY_BIN: FAKE_AGY },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        (err) => err.status === 1 && /explicit release targets/.test(String(err.stderr)) && /trust-anchor\.mjs/.test(String(err.stderr)),
        `args ${JSON.stringify(args)} must be refused`,
      );
    }
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('Modernize Skill: Stage 5 hashes the Antigravity release notes and never trusts an embedded digest marker', () => {
  const trust = auditTrustEnv();
  const tempRepo = makeAuditRepoCopy();
  const notesDir = makeTempDir('agb-mod-notes-');
  try {
    const signed = readFileSync(AGY_RELEASE_FIXTURE, 'utf8');
    const digest = createHash('sha256').update(signed).digest('hex');
    const forged = join(notesDir, 'notes.md');
    writeFileSync(forged, `# not the release notes\n\nexpected digest: ${digest}\n`);
    assert.throws(
      () => execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
        cwd: tempRepo,
        env: { ...trust.env, AGY_RELEASE_URL: forged },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      (err) => /release notes SHA-256/.test(String(err.stderr)),
    );
  } finally {
    rmSync(trust.home, { recursive: true, force: true });
    rmSync(tempRepo, { recursive: true, force: true });
    rmSync(notesDir, { recursive: true, force: true });
  }
});

test('Modernize Skill: audit.mjs fails closed if .adlc is a symlink (physical containment breach)', () => {
  const tempRepo = makeTempDir('agb-symlink-test-');
  const targetAdlc = makeTempDir('agb-target-adlc-');
  try {
    // Create symlink .adlc pointing outside repo
    symlinkSync(targetAdlc, join(tempRepo, '.adlc'), 'dir');

    assert.throws(
      () => {
        execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
          cwd: tempRepo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
      (err) => {
        const msg = String(err.stderr || err.stdout || err.message);
        return msg.includes('Security violation: .adlc is a symbolic link');
      }
    );
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
    rmSync(targetAdlc, { recursive: true, force: true });
  }
});

test('Modernize Skill: concurrent writer serialization via exclusive lock', async () => {
  // Spawn two concurrent audit scripts in an isolated repo copy; they must serialize cleanly without corruption
  const trust = auditTrustEnv();
  const tempRepo = makeAuditRepoCopy();
  const p1 = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
      cwd: tempRepo,
      env: trust.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Child 1 exited with code ${code}: ${out}`));
    });
  });

  const p2 = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
      cwd: tempRepo,
      env: trust.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Child 2 exited with code ${code}: ${out}`));
    });
  });

  let res1;
  let res2;
  try {
    [res1, res2] = await Promise.all([p1, p2]);
    assert.match(res1, /All checks PASSED/);
    assert.match(res2, /All checks PASSED/);

    // Validate that the isolated provenance ledger contains two clean valid JSON lines
    const ledgerPath = join(tempRepo, '.adlc', 'modernize_provenance.jsonl');
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), 'Each provenance line must be valid JSON');
    }
  } finally {
    rmSync(trust.home, { recursive: true, force: true });
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('Modernize Skill: audit.mjs fails closed if agy probe exits with nonzero status', () => {
  const tempBinDir = makeTempDir('agb-bad-agy-bin-');
  const tempRepo = makeAuditRepoCopy();
  const badAgy = join(tempBinDir, 'bad-agy');
  writeFileSync(badAgy, '#!/bin/sh\necho "agy version 1.5.9"\nexit 1\n', { mode: 0o755 });

  try {
    assert.throws(
      () => {
        execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
          cwd: tempRepo,
          env: { ...process.env, AGB_AGY_BIN: badAgy },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
      (err) => {
        const msg = String(err.stderr || err.stdout || err.message);
        return msg.includes('probe failed') || msg.includes('FAILED');
      }
    );
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('Modernize Skill: audit.mjs fails closed if required agy flags are missing', () => {
  const tempBinDir = makeTempDir('agb-missing-flags-bin-');
  const tempRepo = makeAuditRepoCopy();
  const incompleteAgy = join(tempBinDir, 'agy');
  writeFileSync(
    incompleteAgy,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "agy version 1.5.9"; exit 0; fi
if [ "$1" = "models" ]; then echo "gemini-flash"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "Usage: agy --output-format stream-json --json-schema --sandbox"
  exit 0
fi
exit 0
`,
    { mode: 0o755 }
  );

  try {
    assert.throws(
      () => {
        execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
          cwd: tempRepo,
          env: { ...process.env, AGB_AGY_BIN: incompleteAgy },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
      (err) => {
        const msg = String(err.stderr || err.stdout || err.message);
        return msg.includes('--print-timeout') || msg.includes('FAILED');
      }
    );
  } finally {
    rmSync(tempBinDir, { recursive: true, force: true });
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('Modernize Skill: Stage 2 flags reintroduced legacy dual-write or inline 3.5 maps while ignoring fail-closed detector', () => {
  const trust = auditTrustEnv();
  const baseAgy = readFileSync(join(REPO_WITH_NM, 'lib', 'agy.mjs'), 'utf8');
  const baseBridge = readFileSync(join(REPO_WITH_NM, 'lib', 'adlc-bridge.mjs'), 'utf8');
  try {
    const cases = [
      {
        agy: `${baseAgy}\n{ const RETIRED_35_MAP = {}; void RETIRED_35_MAP; }\n`,
        bridge: `${baseBridge}\nif (globalThis.x === "backend === 'legacy'") {}\n`,
      },
      {
        agy: `${baseAgy}\nconst LEGACY_SLUG = 'gemini-3.5-pro';\n`,
        bridge: `${baseBridge}\nif (globalThis.x === "mode === 'both'") {}\n`,
      },
      {
        agy: `${baseAgy}\n{ const RETIRED_35_MAP = {}; void RETIRED_35_MAP; }\n`,
        bridge: `${baseBridge}\nexport function writeLegacy() { writeFileSync('tickets.json', '{}'); }\n`,
      },
      {
        agy: `${baseAgy}\nconst LEGACY_SLUG = 'gemini-3.5-flash';\n`,
        bridge: baseBridge.replaceAll('LEGACY_TICKET_STORE', 'OTHER_STORE_ERR'),
      },
    ];
    for (const c of cases) {
      const tempRepo = makeAuditRepoCopy();
      try {
        writeFileSync(join(tempRepo, 'lib', 'agy.mjs'), c.agy);
        writeFileSync(join(tempRepo, 'lib', 'adlc-bridge.mjs'), c.bridge);
        const out = execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET, '', AUDIT_AGY_TARGET], {
          cwd: tempRepo,
          env: trust.env,
          encoding: 'utf8',
        });
        assert.match(out, /Found 2 pruning candidate\(s\)\./);
        assert.match(out, /Identified 2 codeweight reduction target\(s\): Model Fallbacks \(lib\/agy\.mjs\), Lega/);
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(trust.home, { recursive: true, force: true });
  }
});


