import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_CHARTER_STATIC_PREFIX,
  REGEN_STATIC_PREFIX,
  WARM_REGEN_STATIC_PREFIX,
  PROSECUTOR_STATIC_PREFIX,
  deriveDeterministicFenceTag,
  builderAgentsMd,
  regenPrompt,
  warmRegenPrompt,
  prosecutionPrompt,
} from '../lib/charters.mjs';

test('deriveDeterministicFenceTag returns deterministic 32-hex HMAC for >=16-char seed and warns on short non-empty seed', () => {
  const seed = '0123456789abcdef0123456789abcdef';
  const t1 = deriveDeterministicFenceTag(seed, 'diff --git a/x b/x');
  const t2 = deriveDeterministicFenceTag(seed, 'diff --git a/x b/x');
  const t3 = deriveDeterministicFenceTag(seed, 'diff --git a/y b/y');
  const t4 = deriveDeterministicFenceTag('fedcba9876543210fedcba9876543210', 'diff --git a/x b/x');

  assert.match(t1, /^[0-9a-f]{32}$/);
  assert.equal(t1, t2);
  assert.notEqual(t1, t3);
  assert.notEqual(t1, t4);

  // Omitted seed falls back to UUID without warning
  let stderrOut = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrOut += String(chunk);
    return true;
  };
  try {
    const u1 = deriveDeterministicFenceTag(undefined, 'payload');
    assert.match(u1, /^[0-9a-f-]{36}$/);
    assert.equal(stderrOut, '');

    const uShort = deriveDeterministicFenceTag('short-seed', 'payload');
    assert.match(uShort, /^[0-9a-f-]{36}$/);
    assert.match(stderrOut, /short fence seed/);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('builderAgentsMd, regenPrompt, warmRegenPrompt, and prosecutionPrompt share byte-identical Layer-1 static prefixes across tickets', () => {
  const mdA = builderAgentsMd(
    { id: 'T-A', title: 'Alpha', body: 'Implement alpha', scope: ['lib/a.mjs'], rails: ['lib/lock.mjs'] },
    { build: 'npm run build', test: 'npm test' },
    { hydratedAppendix: '## Pre-Hydrated Repository Context\n\nFast Impacted Test Command: `node --test test/a.test.mjs`' }
  );
  const mdB = builderAgentsMd(
    { id: 'T-B', title: 'Beta', body: 'Implement beta', scope: ['lib/b.mjs'], rails: ['lib/gates.mjs'] },
    { test: 'npm test' }
  );

  assert.ok(BUILDER_CHARTER_STATIC_PREFIX.length >= 350);
  assert.ok(mdA.startsWith(BUILDER_CHARTER_STATIC_PREFIX));
  assert.ok(mdB.startsWith(BUILDER_CHARTER_STATIC_PREFIX));
  assert.ok(mdA.indexOf('# Ticket T-A') > BUILDER_CHARTER_STATIC_PREFIX.length);
  assert.ok(mdA.endsWith('Fast Impacted Test Command: `node --test test/a.test.mjs`\n'));

  const seed = 'run-seed-0123456789abcdef01234567';
  const r1 = regenPrompt({ id: 'T-A' }, 'err-1', undefined, { seed, autofixNote: 'formatted a.mjs' });
  const r2 = regenPrompt({ id: 'T-B' }, 'err-2', undefined, { seed });
  assert.ok(r1.startsWith(REGEN_STATIC_PREFIX));
  assert.ok(r2.startsWith(REGEN_STATIC_PREFIX));
  assert.match(r1, /Orchestrator autofix note: formatted a\.mjs/);
  // Deterministic tag repeatability on same seed + failure
  assert.equal(r2, regenPrompt({ id: 'T-B' }, 'err-2', undefined, { seed }));

  const w1 = warmRegenPrompt({ id: 'T-A', title: 'Alpha', scope: ['lib/a.mjs'], rails: ['lib/lock.mjs'] }, 'fail-1', undefined, { seed });
  const w2 = warmRegenPrompt({ id: 'T-B', title: 'Beta', scope: ['lib/b.mjs'], rails: [] }, 'fail-2', undefined, { seed });
  assert.ok(w1.startsWith(WARM_REGEN_STATIC_PREFIX));
  assert.ok(w2.startsWith(WARM_REGEN_STATIC_PREFIX));

  const p1 = prosecutionPrompt({ id: 'T-A', body: 'spec A', scope: ['lib/a.mjs'] }, 'diff A', undefined, null, { seed });
  const p2 = prosecutionPrompt({ id: 'T-B', body: 'spec B', scope: ['lib/b.mjs'] }, 'diff B', undefined, null, { seed });
  assert.ok(p1.startsWith(PROSECUTOR_STATIC_PREFIX));
  assert.ok(p2.startsWith(PROSECUTOR_STATIC_PREFIX));
  assert.equal(p1, prosecutionPrompt({ id: 'T-A', body: 'spec A', scope: ['lib/a.mjs'] }, 'diff A', undefined, null, { seed }));
});
