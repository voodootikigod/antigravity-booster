import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchStatus, RunStatus } from '../lib/status.mjs';

test('watchStatus: exits with 0 on clean completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-'));
  const s = new RunStatus(dir, 'test-run-123');
  s.flush(); // ensure run.json exists
  
  // Start watcher
  const watchP = watchStatus(dir, 100);
  
  // Write a done state
  s.report({ failed: {}, merged: ['T1'], requests: {} });
  await s.writePromise;
  
  try {
    const code = await watchP;
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchStatus: exits with 2 on failure completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-'));
  const s = new RunStatus(dir, 'test-run-456');
  s.flush(); // ensure run.json exists
  
  // Start watcher
  const watchP = watchStatus(dir, 100);
  
  // Write a failed state
  s.report({ failed: { T1: 'reason' }, merged: [], requests: {} });
  await s.writePromise;
  
  try {
    const code = await watchP;
    assert.equal(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchStatus: exits with 2 when report.compromised is truthy even if failed is empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-'));
  const s = new RunStatus(dir, 'test-run-789');
  s.flush();

  const watchP = watchStatus(dir, 100);

  s.report({ failed: {}, merged: ['T1'], requests: {}, compromised: 'integrity violation' });
  await s.writePromise;

  try {
    const code = await watchP;
    assert.equal(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RunStatus constructor refuses symlinked .booster directory before removing report.json', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-status-symdir-repo-'));
  const victimDir = mkdtempSync(join(tmpdir(), 'agb-status-symdir-victim-'));
  try {
    const victimReport = join(victimDir, 'report.json');
    writeFileSync(victimReport, '{"victim":true}');
    symlinkSync(victimDir, join(repo, '.booster'), 'dir');

    assert.throws(
      () => new RunStatus(repo, 'run-sym-dir'),
      /Security violation.*symbolic link/i,
    );
    assert.equal(existsSync(victimReport), true, 'victim report.json must not be unlinked through symlinked .booster');
    assert.equal(readFileSync(victimReport, 'utf8'), '{"victim":true}');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});

test('RunStatus constructor refuses symlinked .booster/report.json before unlinking it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-status-symfile-repo-'));
  const victimDir = mkdtempSync(join(tmpdir(), 'agb-status-symfile-victim-'));
  try {
    const boosterDir = join(repo, '.booster');
    mkdirSync(boosterDir, { recursive: true });
    const victimFile = join(victimDir, 'secret-report.json');
    writeFileSync(victimFile, '{"victim":true}');
    const reportLink = join(boosterDir, 'report.json');
    symlinkSync(victimFile, reportLink);

    assert.throws(
      () => new RunStatus(repo, 'run-sym-file'),
      /Security violation.*symbolic link/i,
    );
    assert.equal(lstatSync(reportLink).isSymbolicLink(), true, 'symlinked report.json must not be unlinked');
    assert.equal(existsSync(victimFile), true, 'symlink target must remain intact');
    assert.equal(readFileSync(victimFile, 'utf8'), '{"victim":true}');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});

test('RunStatus constructor rejects dangling symlinks on .booster and .booster/report.json', () => {
  const repo1 = mkdtempSync(join(tmpdir(), 'agb-status-dangling1-'));
  const repo2 = mkdtempSync(join(tmpdir(), 'agb-status-dangling2-'));
  try {
    symlinkSync(join(repo1, 'nonexistent-dir'), join(repo1, '.booster'));
    assert.throws(
      () => new RunStatus(repo1, 'run-dangling-dir'),
      /Security violation.*symbolic link/i,
    );

    mkdirSync(join(repo2, '.booster'), { recursive: true });
    symlinkSync(join(repo2, 'nonexistent-file'), join(repo2, '.booster', 'report.json'));
    assert.throws(
      () => new RunStatus(repo2, 'run-dangling-file'),
      /Security violation.*symbolic link/i,
    );
  } finally {
    rmSync(repo1, { recursive: true, force: true });
    rmSync(repo2, { recursive: true, force: true });
  }
});

test('RunStatus.runway: persists runway forecast and runwayWarning boolean into .booster/run.json', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-status-runway-'));
  try {
    const s = new RunStatus(repo, 'run-runway-1');
    s.flush();
    const initial = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
    assert.equal(initial.runway, null);
    assert.equal(initial.runwayWarning, false);

    s.runway({
      ok: true,
      willExhaust: true,
      bottleneckPool: 'gemini',
      exhaustingWave: 2,
      totals: { gemini: 24, claude_gpt: 8 },
    });
    const warned = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
    assert.equal(warned.runwayWarning, true);
    assert.equal(warned.runway.bottleneckPool, 'gemini');
    assert.equal(warned.runway.exhaustingWave, 2);

    s.runway({ ok: true, willExhaust: false, totals: { gemini: 0, claude_gpt: 0 } });
    const cleared = JSON.parse(readFileSync(join(repo, '.booster', 'run.json'), 'utf8'));
    assert.equal(cleared.runwayWarning, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});



