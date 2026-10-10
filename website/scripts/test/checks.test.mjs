// §7.12: each check script against a passing and a failing fixture under fixtures/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const run = (script, ...args) =>
  spawnSync(process.execPath, [path.join(HERE, '..', script), ...args], { encoding: 'utf8' });

for (const script of [
  'check-stale-claims.mjs',
  'check-evidence.mjs',
  'check-known-issues.mjs',
  'check-schema-drift.mjs',
])
  test(`${script} passes on the real site`, () => {
    const r = run(script);
    assert.equal(r.status, 0, r.stderr);
  });

test('check-stale-claims: pass fixture (design-history excluded), with and without --with-root', () => {
  for (const extra of [[], ['--with-root']]) {
    const r = run('check-stale-claims.mjs', '--repo', path.join(FIX, 'stale-claims/pass'), ...extra);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('check-stale-claims: fail fixture reports file:line and claim id', () => {
  const r = run('check-stale-claims.mjs', '--repo', path.join(FIX, 'stale-claims/fail'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /website\/content\/docs\/a\.mdx:5: stale claim C1/);
  assert.match(r.stderr, /website\/content\/docs\/a\.mdx:6: stale claim C16/);
  assert.doesNotMatch(r.stderr, /README\.md/);
  const root = run('check-stale-claims.mjs', '--repo', path.join(FIX, 'stale-claims/fail'), '--with-root');
  assert.match(root.stderr, /README\.md:1: stale claim C30/);
});

test('check-stale-claims --final requires every claim id C1–C35', () => {
  const r = run('check-stale-claims.mjs', '--repo', path.join(FIX, 'stale-claims/pass'), '--final');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /C1 is not in any non-placeholder page's claims:/);
  assert.match(r.stderr, /C35 is not in any/);
});

test('check-evidence: pass fixture (placeholder claims skipped, plain blob/main file links allowed)', () => {
  const r = run('check-evidence.mjs', '--repo', path.join(FIX, 'evidence/pass'));
  assert.equal(r.status, 0, r.stderr);
});

test('check-evidence: fail fixture reports missing permalink and blob/main line anchors', () => {
  const r = run('check-evidence.mjs', '--repo', path.join(FIX, 'evidence/fail'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /website\/content\/docs\/a\.mdx:1: claim C5 has no \[C5\]/);
  assert.doesNotMatch(r.stderr, /claim C4/);
  assert.match(r.stderr, /website\/content\/docs\/a\.mdx:6: blob\/main link with a line anchor/);
  assert.match(r.stderr, /website\/generated\/x\.mdx:1: blob\/main link with a line anchor/);
});

test('check-known-issues: pass while T-CODE-FIXES-AUDIT is not archived', () => {
  const r = run('check-known-issues.mjs', '--repo', path.join(FIX, 'known-issues/pass'));
  assert.equal(r.status, 0, r.stderr);
});

test('check-known-issues: fails once the ticket is archived, and on an out-of-range item', () => {
  const a = run('check-known-issues.mjs', '--repo', path.join(FIX, 'known-issues/fail-archived'));
  assert.equal(a.status, 1);
  assert.match(a.stderr, /a\.mdx:5: T-CODE-FIXES-AUDIT is archived/);
  const b = run('check-known-issues.mjs', '--repo', path.join(FIX, 'known-issues/fail-item'));
  assert.equal(b.status, 1);
  assert.match(b.stderr, /a\.mdx:5: Known issue callout needs "item N" with N in 1–9/);
});

test('check-schema-drift: pass fixture (placeholder page skipped)', () => {
  const r = run('check-schema-drift.mjs', '--repo', path.join(FIX, 'schema-drift/pass'));
  assert.equal(r.status, 0, r.stderr);
});

test('check-schema-drift: fail fixture names the missing field with file:line', () => {
  const r = run('check-schema-drift.mjs', '--repo', path.join(FIX, 'schema-drift/fail'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan-schema\.mdx:7: TypeTable field ghostField not found in lib\/plan\.mjs/);
  assert.doesNotMatch(r.stderr, /field repo/);
});
