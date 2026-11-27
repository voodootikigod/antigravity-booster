import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveImpactedTests,
  planSpeculativeMergeBatches,
  bisectFailedBatch,
} from '../lib/test-impact.mjs';

test('deriveImpactedTests computes transitive test consumers and rejects global or escaping files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-ti-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });

    writeFileSync(join(dir, 'lib', 'leaf.mjs'), 'export const x = 1;\n');
    writeFileSync(
      join(dir, 'lib', 'mid.mjs'),
      'import { x } from "./leaf.mjs";\nexport const y = x + 1;\n'
    );
    writeFileSync(
      join(dir, 'test', 'mid.test.mjs'),
      'import { y } from "../lib/mid.mjs";\n'
    );
    writeFileSync(
      join(dir, 'test', 'other.test.mjs'),
      'export const z = 3;\n'
    );

    // Transitive closure: lib/leaf.mjs -> lib/mid.mjs -> test/mid.test.mjs
    const res = deriveImpactedTests(['lib/leaf.mjs'], { repo: dir });
    assert.equal(res.fast, true);
    assert.deepEqual(res.testFiles, ['test/mid.test.mjs']);
    assert.equal(res.testCmd, 'node --test test/mid.test.mjs');

    // Global config change falls back to full npm test
    const globalRes = deriveImpactedTests(['lib/leaf.mjs', 'package.json'], { repo: dir });
    assert.equal(globalRes.fast, false);
    assert.equal(globalRes.testCmd, 'npm test');

    // Symlinked test file escaping repo is rejected
    const outside = mkdtempSync(join(tmpdir(), 'agb-outside-'));
    try {
      const evilFile = join(outside, 'evil.test.mjs');
      writeFileSync(evilFile, 'import "../lib/leaf.mjs";\n');
      symlinkSync(evilFile, join(dir, 'test', 'symlink.test.mjs'));
      const symRes = deriveImpactedTests(['test/symlink.test.mjs'], { repo: dir });
      assert.equal(symRes.fast, false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planSpeculativeMergeBatches groups disjoint uncoupled tickets and separates overlapping or coupled tickets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-batch-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'lib', 'b.mjs'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'lib', 'c.mjs'), 'import { a } from "./a.mjs";\nexport const c = a;\n');

    const tA = { id: 'T-A', scope: ['lib/a.mjs'], changedFiles: ['lib/a.mjs'] };
    const tB = { id: 'T-B', scope: ['lib/b.mjs'], changedFiles: ['lib/b.mjs'] };
    const tC = { id: 'T-C', scope: ['lib/c.mjs'], changedFiles: ['lib/c.mjs'] };

    const batches = planSpeculativeMergeBatches([tA, tB, tC], { repo: dir });
    // T-A and T-B have disjoint scopes and zero import coupling -> Batch 1
    // T-C imports lib/a.mjs -> separated into Batch 2
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].map((t) => t.id), ['T-A', 'T-B']);
    assert.deepEqual(batches[1].map((t) => t.id), ['T-C']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bisectFailedBatch splits failed batches in O(log k) halves down to singletons', () => {
  assert.deepEqual(bisectFailedBatch([]), []);
  assert.deepEqual(bisectFailedBatch(['T1']), []);
  assert.deepEqual(bisectFailedBatch(['T1', 'T2', 'T3', 'T4']), [
    ['T1', 'T2'],
    ['T3', 'T4'],
  ]);
  assert.deepEqual(bisectFailedBatch(['T1', 'T2']), [['T1'], ['T2']]);
});

test('deriveImpactedTests merges codegraph affected --json via rootRepo and rejects traversal/symlinks', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'agb-ti-root-'));
  const wtDir = mkdtempSync(join(tmpdir(), 'agb-ti-wt-'));
  const outside = mkdtempSync(join(tmpdir(), 'agb-ti-out-'));
  try {
    mkdirSync(join(rootDir, '.codegraph'));
    mkdirSync(join(wtDir, 'lib'), { recursive: true });
    mkdirSync(join(wtDir, 'test'), { recursive: true });

    writeFileSync(join(wtDir, 'lib', 'core.mjs'), 'export const c = 1;\n');
    writeFileSync(join(wtDir, 'test', 'core.test.mjs'), 'import { c } from "../lib/core.mjs";\n');
    writeFileSync(join(wtDir, 'test', 'dynamic.test.mjs'), 'export const d = 2;\n');

    const evilTest = join(outside, 'evil.test.mjs');
    writeFileSync(evilTest, 'export const evil = true;\n');
    symlinkSync(evilTest, join(wtDir, 'test', 'sym.test.mjs'));

    const fakeCg = join(rootDir, 'fake-cg-affected.mjs');
    writeFileSync(
      fakeCg,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  affectedTests: [
    'test/dynamic.test.mjs',
    '../evil.test.mjs',
    'test/../outside.test.mjs',
    'test/sym.test.mjs',
    'lib/core.mjs'
  ]
}));
`,
      { mode: 0o755 }
    );

    const res = deriveImpactedTests(['lib/core.mjs'], {
      repo: wtDir,
      rootRepo: rootDir,
      codegraphBin: fakeCg,
    });
    assert.equal(res.fast, true);
    assert.equal(res.source, 'codegraph');
    // Must merge valid codegraph candidate (test/dynamic.test.mjs) + reverse-import (test/core.test.mjs)
    // and strictly reject traversal, symlink, and non-test paths
    assert.deepEqual(res.testFiles, ['test/core.test.mjs', 'test/dynamic.test.mjs']);
    assert.equal(res.testCmd, 'node --test test/core.test.mjs test/dynamic.test.mjs');

    // Disabled CodeGraph falls back cleanly to static-ast reverse-import only
    const disabledRes = deriveImpactedTests(['lib/core.mjs'], {
      repo: wtDir,
      rootRepo: rootDir,
      codegraphBin: fakeCg,
      enabled: false,
    });
    assert.equal(disabledRes.fast, true);
    assert.equal(disabledRes.source, 'static-ast');
    assert.deepEqual(disabledRes.testFiles, ['test/core.test.mjs']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(wtDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
