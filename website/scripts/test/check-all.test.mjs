import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');

test('check-all runs check-ia and skips sub-checks that are not present yet', () => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'check-all.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check-ia: ok/);
  for (const s of [
    'check-schema-drift.mjs',
    'check-stale-claims.mjs',
    'check-evidence.mjs',
    'check-known-issues.mjs',
    'gen-reference.mjs',
  ]) {
    if (!existsSync(path.join(SCRIPTS, s)))
      assert.match(r.stdout, new RegExp(`skip: ${s.replace('.', '\\.')} not present`));
  }
});
