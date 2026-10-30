import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { bootstrap } from '../lib/bootstrap.mjs';
import { writeStore } from '../skills/modernize/scripts/trust-anchor.mjs';

const FAKE_AGY = join(import.meta.dirname, 'fixtures', 'fake-agy');
const AUDIT_SCRIPT = join(import.meta.dirname, '..', 'skills', 'modernize', 'scripts', 'audit.mjs');

function makeTempDir(prefix = 'agb-mod-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('Modernize Skill: bootstrap discovery and linking', () => {
  const destDir = makeTempDir('agb-dest-skills-');
  const homeDir = makeTempDir('agb-mod-home-');
  try {
    bootstrap({ destination: destDir, home: homeDir, agyBin: FAKE_AGY });
    const entries = readdirSync(destDir);
    assert.ok(entries.includes('modernize'), 'modernize skill directory was discovered and linked');
    const skillMdPath = join(destDir, 'modernize', 'SKILL.md');
    assert.ok(existsSync(skillMdPath), 'SKILL.md is accessible in linked skill directory');
    const content = readFileSync(skillMdPath, 'utf8');
    assert.match(content, /name:\s*modernize/);
  } finally {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Modernize Skill: SKILL.md frontmatter and structure conformance', () => {
  const skillMdPath = join(import.meta.dirname, '..', 'skills', 'modernize', 'SKILL.md');
  assert.ok(existsSync(skillMdPath), 'skills/modernize/SKILL.md exists');
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
  assert.match(content, /Adversarial-Review & Fix Loop/);
  assert.match(content, /audit\.mjs/);
});

const AGY_RELEASE_FIXTURE = join(import.meta.dirname, '..', 'docs', 'research', 'roadmap-agy-1.2.8-adlc-1.11.1.md');
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


// Stage 5 only has built-in anchors for ADLC 1.11.1; any later target needs an
// operator-signed trust store. These tests sign a throwaway store (temp HOME,
// throwaway key) with the registry digests of the published @adlc/cli@1.12.0
// tarball and the sha256 of the pinned changelog fixture, never the real store.
const AUDIT_ADLC_TARGET = '1.12.0';
const AUDIT_TEST_KEY = 'agb-test-only-admin-key';
function auditTrustEnv() {
  const home = makeTempDir('agb-mod-trust-home-');
  writeStore(join(home, '.adlc', 'trusted_packages.json'), {
    releases: {
      [AUDIT_ADLC_TARGET]: {
        adlcTarballSri: 'sha512-s/KSv0lx0VQhGOEp6Y2WJ3P9KxL8gZvollSJcVcrvbhGUU9HrUZ/tn0PO7zHVCk0UpmJpBBQk39VZNTP1JVxXQ==',
        packageTreeSha512: '6818baf1923a72d8230761800c6f4ea5f7ac2a9a1d3362eb960317b685d80a6c90f434534ef222fe4a0fbd033cd0d96f48bbe984b636d9927b3bd9d4052bcc45',
        adlcChangelogSha256: '0b036f0b4e50bb8b9d7a5c198d715981fd695521a1a41f3c4eceedba027477e4',
      },
    },
  }, AUDIT_TEST_KEY);
  return { home, env: { ...process.env, HOME: home, ADLC_ADMIN_KEY: AUDIT_TEST_KEY, AGB_AGY_BIN: FAKE_AGY, AGY_RELEASE_URL: AGY_RELEASE_FIXTURE, AGB_ROADMAP_PATH: AGY_RELEASE_FIXTURE, ADLC_CHANGELOG_URL: ADLC_CHANGELOG_FIXTURE, PATH: '/usr/bin:/bin' } };
}

test('Modernize Skill: audit.mjs executes full 5-stage pipeline', () => {
  const trust = auditTrustEnv();
  let out;
  try {
    out = execFileSync(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET], {
      cwd: REPO_WITH_NM,
      env: trust.env,
      encoding: 'utf8',
    });
  } finally {
    rmSync(trust.home, { recursive: true, force: true });
  }

  assert.match(out, /Stage 1 \(Live Runtime Probes\):\s*\[PASS\]/);
  assert.match(out, /Stage 2 \(Static Codebase Audit\):\s*\[PASS\]/);
  assert.match(out, /Codeweight audit: lib\/ total \d+ lines/);
  assert.match(out, /Stage 3 \(Subsystem Delta Matrix\):\s*\[PASS\]/);
  assert.match(out, /Pillar 6: Deprecation & Codeweight Pruning/);
  assert.match(out, /Stage 4 \(Roadmap DAG Validation\):\s*\[PASS\]/);
  assert.match(out, /Stage 5 \(Provenance & Release Ledger\):\s*\[PASS\]/);
  assert.match(out, /All checks PASSED/);
});

test('Modernize Skill: audit.mjs fails closed if .adlc is a symlink (physical containment breach)', () => {
  const tempRepo = makeTempDir('agb-symlink-test-');
  const targetAdlc = makeTempDir('agb-target-adlc-');
  try {
    // Create symlink .adlc pointing outside repo
    symlinkSync(targetAdlc, join(tempRepo, '.adlc'), 'dir');

    assert.throws(
      () => {
        execFileSync(process.execPath, [AUDIT_SCRIPT], {
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
  // Spawn two concurrent audit scripts; they must serialize cleanly without corruption
  const trust = auditTrustEnv();
  const p1 = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET], {
      cwd: REPO_WITH_NM,
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
    const child = spawn(process.execPath, [AUDIT_SCRIPT, AUDIT_ADLC_TARGET], {
      cwd: REPO_WITH_NM,
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
  } finally {
    rmSync(trust.home, { recursive: true, force: true });
  }
  assert.match(res1, /All checks PASSED/);
  assert.match(res2, /All checks PASSED/);

  // Validate that the provenance ledger contains clean valid JSON lines
  const ledgerPath = join(import.meta.dirname, '..', '.adlc', 'modernize_provenance.jsonl');
  if (existsSync(ledgerPath)) {
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), 'Each provenance line must be valid JSON');
    }
  }
});

test('Modernize Skill: audit.mjs fails closed if agy probe exits with nonzero status', () => {
  const tempBinDir = makeTempDir('agb-bad-agy-bin-');
  const badAgy = join(tempBinDir, 'bad-agy');
  writeFileSync(badAgy, '#!/bin/sh\necho "agy version 1.2.8"\nexit 1\n', { mode: 0o755 });

  try {
    assert.throws(
      () => {
        execFileSync(process.execPath, [AUDIT_SCRIPT], {
          cwd: join(import.meta.dirname, '..'),
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
  }
});

test('Modernize Skill: audit.mjs fails closed if required agy flags are missing', () => {
  const tempBinDir = makeTempDir('agb-missing-flags-bin-');
  const incompleteAgy = join(tempBinDir, 'agy');
  writeFileSync(
    incompleteAgy,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "agy version 1.2.8"; exit 0; fi
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
        execFileSync(process.execPath, [AUDIT_SCRIPT], {
          cwd: join(import.meta.dirname, '..'),
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
  }
});

