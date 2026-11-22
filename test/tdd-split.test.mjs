import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  shouldRunTddSplit,
  selectOppositePoolHint,
  partitionTddScopes,
  promoteTestsToBuilderRails,
  verifyRedPhaseTests,
} from '../lib/tdd-split.mjs';

test('shouldRunTddSplit activates on frontier tickets with test+impl scope and honors tdd_split overrides', () => {
  assert.equal(
    shouldRunTddSplit({
      id: 'T1',
      tier: 'frontier',
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    true
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T2',
      tier: 'mid',
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    false
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T3',
      tier: 'mid',
      tdd_split: true,
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    true
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T4',
      tier: 'frontier',
      tdd_split: false,
      scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
    }),
    false
  );
  assert.equal(
    shouldRunTddSplit({
      id: 'T5',
      tier: 'frontier',
      scope: ['lib/foo.mjs'],
    }),
    false,
    'must not split when no test path is in scope'
  );
});

test('selectOppositePoolHint and partitionTddScopes isolate Spec-Test Author on opposite pool and freeze impl paths', () => {
  assert.equal(selectOppositePoolHint('gemini', 'gemini-4-neon-high'), 'claude-gpt');
  assert.equal(selectOppositePoolHint('claude-gpt', 'claude-opus-5-5-high'), 'gemini');

  const ticket = {
    id: 'T-FRONT',
    title: 'Add widget engine',
    tier: 'frontier',
    pool_hint: 'gemini',
    scope: ['lib/widget.mjs', 'test/widget.test.mjs'],
    rails: ['lib/lock.mjs'],
    body: 'Implement createWidget().',
  };

  const part = partitionTddScopes(ticket, { builderModel: 'gemini-4-neon-high' });
  assert.deepEqual(part.testScope, ['test/widget.test.mjs']);
  assert.deepEqual(part.implScope, ['lib/widget.mjs']);
  assert.equal(part.specPoolHint, 'claude-gpt');
  assert.deepEqual(part.specAuthorSubTicket.scope, ['test/widget.test.mjs']);
  assert.ok(part.specAuthorSubTicket.rails.includes('lib/widget.mjs'));
  assert.ok(part.specAuthorSubTicket.rails.includes('lib/lock.mjs'));

  const promoted = promoteTestsToBuilderRails(ticket, ['test/widget.test.mjs']);
  assert.ok(promoted.rails.includes('test/widget.test.mjs'));
  assert.ok(promoted.rails.includes('lib/lock.mjs'));
});

test('verifyRedPhaseTests accepts failing syntactically valid tests and rejects tautological or broken tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-tdd-red-'));
  try {
    mkdirSync(join(dir, 'test'), { recursive: true });

    // 1. Failing red-phase contract test -> ok: true
    writeFileSync(
      join(dir, 'test', 'red.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n'
    );
    const redRes = verifyRedPhaseTests(['test/red.test.mjs'], { worktree: dir });
    assert.equal(redRes.ok, true);
    assert.deepEqual(redRes.verifiedFiles, ['test/red.test.mjs']);

    // 2. Tautological test passing on unimplemented base -> ok: false
    writeFileSync(
      join(dir, 'test', 'taut.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("green", () => { assert.equal(1, 1); });\n'
    );
    const tautRes = verifyRedPhaseTests(['test/taut.test.mjs'], { worktree: dir });
    assert.equal(tautRes.ok, false);
    assert.match(tautRes.reason, /tautological spec tests/);

    // 3. Syntax error -> ok: false
    writeFileSync(join(dir, 'test', 'syntax.test.mjs'), 'export const = ;\n');
    const synRes = verifyRedPhaseTests(['test/syntax.test.mjs'], { worktree: dir });
    assert.equal(synRes.ok, false);
    assert.match(synRes.reason, /syntax error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
