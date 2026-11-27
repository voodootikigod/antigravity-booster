import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../lib/doctor.mjs';

test('runInit({ automations: true }) scaffolds symlink-safe .agents/automations/*.json templates idempotently and honors force', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-automations-init-'));
  const outside = mkdtempSync(join(tmpdir(), 'agb-automations-out-'));
  try {
    // 1. Default runInit does not create .agents/automations
    const baseRes = runInit({ repo });
    assert.equal(baseRes.ok, true);
    assert.equal(baseRes.automations, undefined);
    assert.equal(existsSync(join(repo, '.agents', 'automations')), false);

    // 2. automations: true scaffolds all 3 Antigravity 2.0 automation definitions
    const autoRes = runInit({ repo, automations: true });
    assert.equal(autoRes.ok, true);
    assert.equal(autoRes.automations, true);
    assert.equal(autoRes.automationFilesCreated.length, 3);
    assert.equal(autoRes.automationFilesSkipped.length, 0);

    const expectedTemplates = {
      'agb-quota-resume': {
        name: 'AGB Quota Reset Fleet Resume',
        description: 'Checks 4-window pool quota status and resumes paused ADLC fleet runs when capacity replenishes.',
        schedule: '*/30 * * * *',
        timezone: 'UTC',
      },
      'agb-nightshift-distill': {
        name: 'AGB Nightshift Defense Distillation & Stale-Rail Audit',
        description: 'Compiles recurring prosecution findings into .adlc/learned-checks.json and audits completed ticket rails.',
        schedule: '0 2 * * 1-5',
        timezone: 'America/Los_Angeles',
      },
      'agb-pr-prosecutor': {
        name: 'AGB Read-Only 5-Lens Branch Prosecutor',
        description: 'Runs read-only 5-lens adversarial code review against active feature branch diffs prior to P6 human review.',
        schedule: '0 */4 * * 1-5',
        timezone: 'UTC',
      },
    };
    for (const [id, exp] of Object.entries(expectedTemplates)) {
      const filePath = join(repo, '.agents', 'automations', `${id}.json`);
      assert.equal(existsSync(filePath), true);
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(parsed.version, 1);
      assert.equal(parsed.id, id);
      assert.equal(parsed.name, exp.name);
      assert.equal(parsed.description, exp.description);
      assert.equal(parsed.schedule, exp.schedule);
      assert.equal(parsed.timezone, exp.timezone);
      assert.equal(parsed.commandExecutionPolicy, 'sandbox');
      assert.ok(typeof parsed.prompt === 'string' && parsed.prompt.includes('~/.local/bin/agb'));
    }

    // 3. Re-running without force preserves user customizations
    const resumeFile = join(repo, '.agents', 'automations', 'agb-quota-resume.json');
    writeFileSync(resumeFile, '{"custom":true}\n', 'utf8');
    const secondRes = runInit({ repo, automations: true, force: false });
    assert.equal(secondRes.automationFilesCreated.length, 0);
    assert.equal(secondRes.automationFilesSkipped.length, 3);
    assert.equal(readFileSync(resumeFile, 'utf8'), '{"custom":true}\n');

    // 4. Re-running with force: true restores canonical template
    const forcedRes = runInit({ repo, automations: true, force: true });
    assert.equal(forcedRes.automationFilesCreated.length, 3);
    assert.equal(JSON.parse(readFileSync(resumeFile, 'utf8')).id, 'agb-quota-resume');

    // 5. Rejects symlinked automation target file
    const victim = join(outside, 'victim.json');
    writeFileSync(victim, '{}', 'utf8');
    rmSync(resumeFile);
    symlinkSync(victim, resumeFile);
    assert.throws(() => runInit({ repo, automations: true, force: true }), /Security violation: symbolic link/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
