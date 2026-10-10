#!/usr/bin/env node
// `npm run check`: §7.7–§7.10 checks plus gen-reference --check. Sub-checks that a later
// ticket (T-DOCS-GEN) creates are skipped with a notice until they exist.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = [
  ['check-ia.mjs'],
  ['check-schema-drift.mjs'],
  ['check-stale-claims.mjs'],
  ['check-evidence.mjs'],
  ['check-known-issues.mjs'],
  ['gen-reference.mjs', '--check'],
];

let failed = 0;
for (const [script, ...args] of CHECKS) {
  const file = path.join(HERE, script);
  const label = [script, ...args].join(' ');
  if (!existsSync(file)) {
    console.log(`skip: ${script} not present`);
    continue;
  }
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`fail: ${label} (exit ${r.status ?? r.signal})`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
