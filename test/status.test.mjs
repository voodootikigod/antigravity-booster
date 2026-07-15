import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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
