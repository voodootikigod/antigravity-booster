import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let target = null;
try {
  target = require.resolve('antigravity-booster/sidecars/jetski-launcher.mjs');
} catch (e) {
  let cur = __dirname;
  while (cur && cur !== dirname(cur)) {
    const candidate = join(cur, 'sidecars', 'jetski-launcher.mjs');
    if (existsSync(candidate)) {
      target = candidate;
      break;
    }
    cur = dirname(cur);
  }
}

if (!target) {
  target = join(__dirname, '../../../sidecars/jetski-launcher.mjs');
}

import(pathToFileURL(target).href);
