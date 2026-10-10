import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'check-ia.mjs');
const FIX = path.join(HERE, 'fixtures', 'check-ia');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('check-ia passes on the real site tree', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

test('check-ia --no-placeholders fails on a listed placeholder page', () => {
  const r = run('--root', path.join(FIX, 'fail'), '--no-placeholders');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /content\/docs\/guide\/one\.mdx:1: placeholder: true/);
});

test('check-ia passes on the passing fixture, with and without --no-placeholders', () => {
  for (const extra of [[], ['--no-placeholders']]) {
    const r = run('--root', path.join(FIX, 'pass'), ...extra);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('check-ia reports order, missing, unlisted and placeholder failures with file:line', () => {
  const r = run('--root', path.join(FIX, 'fail'), '--no-placeholders');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /content\/docs\/guide\/meta\.json:1: pages \["two","one"\] != ia\.json/);
  assert.match(r.stderr, /content\/docs\/guide\/stray\.mdx:1: page not listed/);
  assert.match(r.stderr, /listed entry "two" does not exist/);
});

test('check-ia flags placeholders only with --no-placeholders', () => {
  const fixture = path.join(FIX, 'fail');
  assert.doesNotMatch(run('--root', fixture).stderr, /placeholder: true/);
});
