import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchStatus } from '../lib/status.mjs';

test('watchStatus: exits with 0 on clean completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-'));
  const bdir = join(dir, '.booster');
  mkdirSync(bdir, { recursive: true });
  
  const path = join(bdir, 'run.json');
  
  // Start watcher first
  const watchP = watchStatus(dir, 100);
  
  // Write a done state
  writeFileSync(path, JSON.stringify({
    done: true,
    report: { failed: {}, merged: ['T1'] }
  }));
  
  try {
    const code = await watchP;
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchStatus: exits with 2 on failure completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-watch-'));
  const bdir = join(dir, '.booster');
  mkdirSync(bdir, { recursive: true });
  
  const path = join(bdir, 'run.json');
  
  // Start watcher
  const watchP = watchStatus(dir, 100);
  
  // Write a failed state
  writeFileSync(path, JSON.stringify({
    done: true,
    report: { failed: { T1: 'reason' }, merged: [] }
  }));
  
  try {
    const code = await watchP;
    assert.equal(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
