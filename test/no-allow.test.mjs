// Booster never emits an in-session `allow` (spec §4.3, Appendix A D7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Sources and shipped artifacts that run inside the agy session.
const SCAN = ['hooks', 'dist/hooks', 'hooks.json'];
const ALLOW = /["']?decision["']?\s*:\s*["']allow["']/;

function files(p) {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((n) => files(join(p, n)));
}

test('no hook source or shipped hook bundle can emit decision: allow', () => {
  const scanned = SCAN.flatMap(files);
  assert.ok(scanned.length > 0, 'expected hook sources to scan');
  for (const f of scanned) assert.doesNotMatch(readFileSync(f, 'utf8'), ALLOW, f);
});

// Behavioural coverage of the runner converting a child `allow` into its
// fail-safe lives in test/hook-runner.test.mjs (stub child emits allow).

test('the legacy auto-approve hook is gone', () => {
  assert.equal(existsSync(join(ROOT, '.agents/plugins/agb/hooks/auto-approve-tests.mjs')), false);
});
