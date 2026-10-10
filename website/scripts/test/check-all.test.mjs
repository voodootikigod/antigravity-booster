import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');

test('check-all runs every §7.7–§7.10 check and gen-reference --check on the real site', () => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'check-all.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const label of [
    'check-ia: ok',
    'check-schema-drift: ok',
    'check-stale-claims: ok',
    'check-evidence: ok',
    'check-known-issues: ok',
    'gen-reference: up to date',
  ])
    assert.match(r.stdout, new RegExp(label));
  assert.doesNotMatch(r.stdout, /skip:/);
});
