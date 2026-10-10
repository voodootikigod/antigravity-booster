// Regression tests for issue #54: concurrent reclaimers of one stale run lock
// must never produce two winners. The interleaving is driven deterministically
// by hooking process.kill (the liveness probe) and fs.readFileSync (the meta
// read) so the test does not depend on scheduler timing.
//
// LOCK_MODULE_UNDER_TEST may point at an alternative lock.mjs (used to prove
// the interleaving test fails against the pre-fix implementation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const modPath = process.env.LOCK_MODULE_UNDER_TEST
  ? resolve(process.env.LOCK_MODULE_UNDER_TEST)
  : join(here, '..', 'lib', 'lock.mjs');
const { acquireRepoLock } = await import(pathToFileURL(modPath).href);

// A pid above the Linux/macOS pid_max ceilings: guaranteed not alive.
const DEAD_PID = 2 ** 22 + 7;

function staleRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agb-lock-reclaim-'));
  const lockDir = join(repo, '.booster', 'run.lock.d');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'meta.json'),
    JSON.stringify({ pid: DEAD_PID, runId: 'dead', token: 'stale-token' }));
  return { repo, lockDir };
}

test('interleaved reclaimers of one stale lock produce exactly one winner (issue #54)', () => {
  const { repo, lockDir } = staleRepo();
  const realKill = process.kill;
  const realRead = fs.readFileSync;
  const results = {};
  const releases = [];
  let stage = 0;
  let nested = false;
  const acquire = (id) => {
    const prev = nested;
    nested = id !== 'B';
    try {
      releases.push(acquireRepoLock(repo, { runId: id }));
      results[id] = 'WIN';
    } catch (err) {
      results[id] = err.message;
    } finally {
      nested = prev;
    }
  };
  // B probes the dead holder -> A runs a full reclaim to completion inside
  // that probe -> B's next meta read lets C acquire inside B's reclaim window.
  process.kill = function (p, sig) {
    if (!nested && stage === 0 && p === DEAD_PID) { stage = 1; acquire('A'); }
    return realKill.call(process, p, sig);
  };
  fs.readFileSync = function (...args) {
    if (!nested && stage === 1) { stage = 2; acquire('C'); }
    return realRead.apply(fs, args);
  };
  syncBuiltinESMExports();
  try {
    acquire('B');
  } finally {
    process.kill = realKill;
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
  }
  try {
    assert.equal(stage, 2, `interleaving was not fully driven: ${JSON.stringify(results)}`);
    const winners = Object.keys(results).filter((k) => results[k] === 'WIN');
    assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(results)}`);
    assert.equal(existsSync(`${lockDir}.reclaim`), false, 'reclaim mutex dir must be cleaned up');
    assert.ok(existsSync(join(lockDir, 'meta.json')), 'the winner must still hold the canonical lock');
  } finally {
    for (const r of releases) r();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a leftover reclaim mutex makes reclaim fail safe with "being reclaimed"', () => {
  const { repo, lockDir } = staleRepo();
  mkdirSync(`${lockDir}.reclaim`);
  try {
    assert.throws(() => acquireRepoLock(repo, { runId: 'late' }),
      (err) => /being reclaimed/.test(err.message) && err.message.includes(`${lockDir}.reclaim`));
    // The stale lock is left untouched and the mutex is not stolen.
    assert.ok(existsSync(join(lockDir, 'meta.json')));
    assert.ok(existsSync(`${lockDir}.reclaim`));
    rmSync(`${lockDir}.reclaim`, { recursive: true });
    const release = acquireRepoLock(repo, { runId: 'after-cleanup' });
    assert.equal(existsSync(`${lockDir}.reclaim`), false);
    release();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
