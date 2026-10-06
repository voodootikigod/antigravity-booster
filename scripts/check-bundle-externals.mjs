#!/usr/bin/env node
// Asserts the committed plugin bundles import nothing but Node built-ins, so a
// git-URL plugin install (no `npm install`) runs with zero node_modules
// (spec .adlc/specs/native-plugin-installation.md §4.1, T1).
//
// Usage: node scripts/check-bundle-externals.mjs [bundle ...]
// Exit 0 = clean, 1 = an external specifier or a missing bundle was found.
import { readFileSync } from 'node:fs';
import { isBuiltin as nodeIsBuiltin, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BUNDLES = ['dist/agb.mjs', 'dist/mcp-server.mjs', 'dist/hooks/pre-tool-use.bundle.mjs'];

const BUILTINS = new Set(builtinModules);

// esbuild emits static imports as `import ... from "x"` / `import "x"` /
// `export ... from "x"`; dynamic and CommonJS forms survive as import("x") /
// require("x") when left external.
const SPECIFIER_PATTERNS = [
  /^\s*import\s[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /^\s*export\s[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];

export function isBuiltin(specifier) {
  if (typeof nodeIsBuiltin === 'function' && nodeIsBuiltin(specifier)) return true;
  if (specifier.startsWith('node:')) return BUILTINS.has(specifier.slice(5)) || BUILTINS.has(specifier);
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
}

export function findExternalSpecifiers(source) {
  const found = new Set();
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(re)) {
      if (!isBuiltin(m[1])) found.add(m[1]);
    }
  }
  return [...found].sort();
}

function main(argv) {
  const bundles = argv.length > 0 ? argv : DEFAULT_BUNDLES;
  let failed = false;
  for (const file of bundles) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (err) {
      process.stderr.write(`check-bundle-externals: cannot read ${file}: ${err.code ?? err.message}\n`);
      failed = true;
      continue;
    }
    const externals = findExternalSpecifiers(source);
    if (externals.length > 0) {
      process.stderr.write(`check-bundle-externals: ${file} imports non-builtin modules: ${externals.join(', ')}\n`);
      failed = true;
    } else {
      process.stdout.write(`check-bundle-externals: ${file} ok (Node built-ins only)\n`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
