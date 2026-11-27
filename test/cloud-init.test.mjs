import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInit } from '../lib/doctor.mjs';
import { bootstrap } from '../lib/bootstrap.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('runInit({ cloud: true }) scaffolds .agents cloud pack idempotently, honors force, and rejects symlinks', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-cloud-init-'));
  try {
    // 1. Default runInit (cloud: false) does not create .agents
    const baseRes = runInit({ repo });
    assert.equal(baseRes.ok, true);
    assert.equal(baseRes.cloud, false);
    assert.equal(existsSync(join(repo, '.agents')), false);

    // 2. Cloud init scaffolds all 5 expected .agents files
    const cloudRes = runInit({ repo, cloud: true });
    assert.equal(cloudRes.ok, true);
    assert.equal(cloudRes.cloud, true);
    assert.equal(cloudRes.cloudFilesCreated.length, 5);
    assert.equal(cloudRes.cloudFilesSkipped.length, 0);

    const envJson = JSON.parse(readFileSync(join(repo, '.agents', 'environment.json'), 'utf8'));
    execFileSync('bash', ['-n', '-c', envJson.install]);
    assert.equal((envJson.install.match(/>\/dev\/null 2>&1/g) ?? []).length, 6);
    assert.match(envJson.install, /bubblewrap/);
    assert.match(envJson.install, /codegraph/);
    assert.match(envJson.install, /antigravity-booster/);

    const ruleMd = readFileSync(join(repo, '.agents', 'rules', 'adlc.md'), 'utf8');
    assert.match(ruleMd, /^---\ntrigger: always_on\n/);
    assert.match(ruleMd, /agb gate-ticket/);

    const skillMd = readFileSync(join(repo, '.agents', 'skills', 'agb-cloud', 'SKILL.md'), 'utf8');
    assert.match(skillMd, /^---\nname: agb-cloud\n/);

    const prosMd = readFileSync(join(repo, '.agents', 'agents', 'prosecutor.md'), 'utf8');
    assert.match(prosMd, /subagent: true/);
    assert.match(prosMd, /commandExecutionPolicy: sandbox/);

    // 3. Re-running without force preserves user edits
    writeFileSync(join(repo, '.agents', 'rules', 'adlc.md'), '# custom rule\n', 'utf8');
    const secondRes = runInit({ repo, cloud: true, force: false });
    assert.equal(secondRes.cloudFilesCreated.length, 0);
    assert.equal(secondRes.cloudFilesSkipped.length, 5);
    assert.equal(readFileSync(join(repo, '.agents', 'rules', 'adlc.md'), 'utf8'), '# custom rule\n');

    // 4. Re-running with force: true restores canonical cloud files
    const forcedRes = runInit({ repo, cloud: true, force: true });
    assert.equal(forcedRes.cloudFilesCreated.length, 5);
    assert.match(readFileSync(join(repo, '.agents', 'rules', 'adlc.md'), 'utf8'), /^---\ntrigger: always_on\n/);

    // 5. Rejects symlinked .agents target file
    const outside = mkdtempSync(join(tmpdir(), 'agb-cloud-outside-'));
    try {
      const targetSecret = join(outside, 'secret.json');
      writeFileSync(targetSecret, '{}', 'utf8');
      rmSync(join(repo, '.agents', 'environment.json'));
      symlinkSync(targetSecret, join(repo, '.agents', 'environment.json'));
      assert.throws(() => runInit({ repo, cloud: true, force: true }), /Security violation: symbolic link/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('bootstrap() short-circuits immediately when ANTIGRAVITY_RESOLVING_ENVIRONMENT=1', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-ssh-env-'));
  try {
    const res = bootstrap({
      home: fakeHome,
      agyBin: '/nonexistent/should-never-be-called',
      env: { ANTIGRAVITY_RESOLVING_ENVIRONMENT: '1' },
    });
    assert.deepEqual(res, { skipped: true, reason: 'ANTIGRAVITY_RESOLVING_ENVIRONMENT' });
    assert.equal(existsSync(join(fakeHome, '.local', 'bin', 'agb')), false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('top-level agents/*.md declare Antigravity subagent frontmatter and Nov 30 model defaults', () => {
  const expectedModels = {
    'prosecutor.md': 'claude-sonnet-5-5-high',
    'spec-linter.md': 'gemini-4-neon-high',
    'fleet-scheduler.md': 'gemini-4-hydrogen-high',
  };
  for (const [file, model] of Object.entries(expectedModels)) {
    const raw = readFileSync(join(ROOT, 'agents', file), 'utf8');
    assert.match(raw, new RegExp(`^---\\nname: ${file.replace(/\.md$/, '')}\\n`));
    assert.match(raw, /^subagent: true$/m);
    assert.match(raw, /^mainAgent: false$/m);
    assert.match(raw, /^commandExecutionPolicy: sandbox$/m);
    assert.match(raw, new RegExp(`^model: ${model}$`, 'm'));
  }
});
