import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { bootstrap } from '../lib/bootstrap.mjs';

const FAKE_AGY = join(import.meta.dirname, 'fixtures', 'fake-agy');
const AUDIT_SCRIPT = join(import.meta.dirname, '..', 'skills', 'modernize', 'scripts', 'audit.mjs');

function makeTempDir(prefix = 'agb-mod-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('Modernize Skill: bootstrap discovery and linking', () => {
  const destDir = makeTempDir('agb-dest-skills-');
  try {
    bootstrap({ destination: destDir, agyBin: FAKE_AGY });
    const entries = readdirSync(destDir);
    assert.ok(entries.includes('modernize'), 'modernize skill directory was discovered and linked');
    const skillMdPath = join(destDir, 'modernize', 'SKILL.md');
    assert.ok(existsSync(skillMdPath), 'SKILL.md is accessible in linked skill directory');
    const content = readFileSync(skillMdPath, 'utf8');
    assert.match(content, /name:\s*modernize/);
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test('Modernize Skill: SKILL.md frontmatter and structure conformance', () => {
  const skillMdPath = join(import.meta.dirname, '..', 'skills', 'modernize', 'SKILL.md');
  assert.ok(existsSync(skillMdPath), 'skills/modernize/SKILL.md exists');
  const content = readFileSync(skillMdPath, 'utf8');

  // Verify YAML frontmatter
  assert.match(content, /^---\n/);
  assert.match(content, /name:\s*modernize/);
  assert.match(content, /user-invocable:\s*true/);
  assert.match(content, /license:\s*MIT/);

  // Verify documented stages and triggers
  assert.match(content, /Stage 1:/);
  assert.match(content, /Stage 2:/);
  assert.match(content, /Stage 3:/);
  assert.match(content, /Stage 4:/);
  assert.match(content, /Stage 5:/);
  assert.match(content, /audit\.mjs/);
});

test('Modernize Skill: audit.mjs executes full 5-stage pipeline', () => {
  const out = execFileSync('node', [AUDIT_SCRIPT], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

  assert.match(out, /Stage 1 \(Live Runtime Probes\):\s*\[PASS\]/);
  assert.match(out, /Stage 2 \(Static Codebase Audit\):\s*\[PASS\]/);
  assert.match(out, /Stage 3 \(Subsystem Delta Matrix\):\s*\[PASS\]/);
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
        execFileSync('node', [AUDIT_SCRIPT], {
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
  const p1 = new Promise((resolve, reject) => {
    const child = spawn('node', [AUDIT_SCRIPT], {
      cwd: join(import.meta.dirname, '..'),
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
    const child = spawn('node', [AUDIT_SCRIPT], {
      cwd: join(import.meta.dirname, '..'),
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

  const [res1, res2] = await Promise.all([p1, p2]);
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
