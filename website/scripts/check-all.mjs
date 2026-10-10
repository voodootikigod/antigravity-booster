#!/usr/bin/env node
// `npm run check`: §7.7 schema drift, §7.8 stale claims + evidence (site only), §7.9 known
// issues, §7.10 IA (placeholders allowed) and gen-reference --check. No build needed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHECKS = [
  ['check-ia.mjs'],
  ['check-schema-drift.mjs'],
  ['check-stale-claims.mjs'],
  ['check-evidence.mjs'],
  ['check-known-issues.mjs'],
  ['gen-reference.mjs', '--check'],
];

let failed = 0;
for (const [script, ...args] of CHECKS) {
  const label = [script, ...args].join(' ');
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`fail: ${label} (exit ${r.status ?? r.signal})`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
