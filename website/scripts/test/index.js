// Entry point for `node --test scripts/test/` (spec §3.3). Node 22 resolves a directory
// argument to its index.js instead of expanding it, so this file loads every *.test.mjs.
import { readdirSync } from 'node:fs';

const here = new URL('./', import.meta.url);
for (const name of readdirSync(here)
  .filter((n) => n.endsWith('.test.mjs'))
  .sort()) {
  await import(new URL(name, here).href);
}
