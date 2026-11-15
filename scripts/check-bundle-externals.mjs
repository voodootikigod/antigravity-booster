#!/usr/bin/env node
// Asserts the committed plugin bundles import nothing but Node built-ins, so a
// git-URL plugin install (no `npm install`) runs with zero node_modules
// (spec .adlc/specs/native-plugin-installation.md §4.1, T1).
//
// Usage: node scripts/check-bundle-externals.mjs [bundle ...]
// Exit 0 = clean, 1 = an external specifier or a missing bundle was found.
import { readFileSync, realpathSync } from 'node:fs';
import { isBuiltin as nodeIsBuiltin, builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_BUNDLES = [
  'dist/agb.mjs',
  'dist/mcp-server.mjs',
  'dist/hooks/pre-tool-use.bundle.mjs',
  'vendor/adlc/dist/adlc.bundle.mjs',
  'vendor/adlc/dist/syntax-check-typescript.mjs',
  'vendor/adlc/dist/watchdog.mjs',
];

// @adlc/core >= 1.13.0 (lib/syntax.mjs + syntax-check-typescript.mjs) probes
// the TARGET repository's own node_modules/typescript (guarded by existsSync +
// try/catch) when syntax-checking .ts/.tsx mutants; no @adlc or booster bundle
// depends on typescript at install or runtime. Booster's own bundles still
// forbid every non-builtin specifier without exception.
export const BUNDLE_ALLOWED_OPTIONAL_PROBES = Object.freeze({
  'vendor/adlc/dist/adlc.bundle.mjs': Object.freeze(new Set(['typescript'])),
  'vendor/adlc/dist/syntax-check-typescript.mjs': Object.freeze(new Set(['typescript', 'resolved.path'])),
});

const BUILTINS = new Set(builtinModules);

// esbuild emits static imports as `import ... from "x"` / `import "x"` /
// `export ... from "x"`; dynamic and CommonJS forms survive as import("x") /
// require("x") when left external.
const STATIC_PATTERNS = [
  /^\s*import\s[^;]*?\bfrom\s*["'`]([^"'`\r\n]+)["'`]/gm,
  /^\s*import\s*["'`]([^"'`\r\n]+)["'`]/gm,
  /^\s*export\s[^;]*?\bfrom\s*["'`]([^"'`\r\n]+)["'`]/gm,
];

const CALL_PATTERN = /\b(?:import|(?:__)?require\d*(?:\s*\.\s*resolve)?)\s*\(([^)]+)\)/g;
const CREATE_REQUIRE_IDENT = '(?:createRequire\\d*|__agbCreateRequire\\d*)';
const DIRECT_CREATE_REQUIRE_PATTERN = new RegExp(`\\b${CREATE_REQUIRE_IDENT}\\s*\\([^)]*\\)(?:\\s*\\.\\s*resolve)?\\s*\\(([^)]+)\\)`, 'g');
const BOUND_CREATE_REQUIRE_DECL = new RegExp(`(?:\\b(?:const|let|var)\\s+|(?:^|[;,{}\\n])\\s*)([A-Za-z_$][\\w$]*)\\s*=\\s*(?:[\\w$]+\\.)?${CREATE_REQUIRE_IDENT}\\s*\\([^)]*\\)`, 'gm');
const PROCESS_BINDING_PATTERN = /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(([^)]+)\)/g;

export function isBuiltin(specifier) {
  if (typeof nodeIsBuiltin === 'function' && nodeIsBuiltin(specifier)) return true;
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (typeof nodeIsBuiltin === 'function' && nodeIsBuiltin(bare)) return true;
  if (BUILTINS.has(specifier) || BUILTINS.has(bare)) return true;
  const knownSubpaths = new Set(['fs/promises', 'stream/promises', 'stream/consumers', 'stream/web', 'timers/promises', 'dns/promises', 'readline/promises', 'util/types']);
  return knownSubpaths.has(bare);
}

function recordCallArg(rawArg, found) {
  const trimmed = rawArg.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'" || quote === '`') && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    if (quote === '`' && inner.includes('${')) {
      found.add(trimmed);
    } else if (!isBuiltin(inner)) {
      found.add(inner);
    }
  } else if (!isBuiltin(trimmed)) {
    found.add(trimmed);
  }
}

export function findExternalSpecifiers(source) {
  const found = new Set();
  for (const re of STATIC_PATTERNS) {
    for (const m of source.matchAll(re)) {
      const spec = m[1].trim();
      if (!isBuiltin(spec)) found.add(spec);
    }
  }
  for (const m of source.matchAll(CALL_PATTERN)) {
    recordCallArg(m[1], found);
  }
  for (const m of source.matchAll(DIRECT_CREATE_REQUIRE_PATTERN)) {
    recordCallArg(m[1], found);
  }
  for (const m of source.matchAll(PROCESS_BINDING_PATTERN)) {
    const raw = m[1].trim().replace(/^["'`]|["'`]$/g, '');
    found.add(`process.binding:${raw}`);
  }
  for (const decl of source.matchAll(BOUND_CREATE_REQUIRE_DECL)) {
    const ident = decl[1];
    if (/^(?:__)?require\d*$/.test(ident)) continue;
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundCallRe = new RegExp(`\\b${escaped}(?:\\s*\\.\\s*resolve)?\\s*\\(([^)]+)\\)`, 'g');
    for (const m of source.matchAll(boundCallRe)) {
      recordCallArg(m[1], found);
    }
  }
  return [...found].sort();
}

function normalizeBundleKey(file) {
  return relative(ROOT, resolve(file)).replaceAll('\\', '/');
}

export function main(argv) {
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
    const allowed = BUNDLE_ALLOWED_OPTIONAL_PROBES[normalizeBundleKey(file)];
    const externals = findExternalSpecifiers(source).filter((spec) => !allowed?.has(spec));
    if (externals.length > 0) {
      process.stderr.write(`check-bundle-externals: ${file} imports non-builtin modules: ${externals.join(', ')}\n`);
      failed = true;
    } else {
      process.stdout.write(`check-bundle-externals: ${file} ok (Node built-ins only)\n`);
    }
  }
  return failed ? 1 : 0;
}

const isEntry = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (process.argv[1] && isEntry()) {
  process.exitCode = main(process.argv.slice(2));
}
