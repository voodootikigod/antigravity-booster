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
  'vendor/adlc/dist/adlc.bundle.mjs': Object.freeze(new Set(['typescript', 'path'])),
  'vendor/adlc/dist/syntax-check-typescript.mjs': Object.freeze(new Set(['typescript', 'resolved.path', 'path'])),
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
const IMPORT_META_RESOLVE_PATTERN = /\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(/g;
const PROCESS_BINDING_PATTERN = /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(([^)]+)\)/g;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingDelimiter(source, openIdx, openCh = '(', closeCh = ')') {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === openCh) {
      depth += 1;
    } else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingParen(source, openIdx) {
  return findMatchingDelimiter(source, openIdx, '(', ')');
}

function extractFirstCallArg(rawArgs) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const ch = rawArgs[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return rawArgs.slice(0, i);
    }
  }
  return rawArgs;
}

function collectCreateRequireIdents(source) {
  const idents = new Set();
  const importRe = /\bimport\s*\{([^}]+)\}\s*from\s*["'`](?:node:)?module["'`]/g;
  for (const m of source.matchAll(importRe)) {
    for (const aliasMatch of m[1].matchAll(/\bcreateRequire\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      idents.add(aliasMatch[1]);
    }
  }
  const destructureRe = /\{[^}]*\bcreateRequire\s*:\s*([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(destructureRe)) {
    idents.add(m[1]);
  }
  const aliasAssignRe = /(?:\b(?:const|let|var)\s+|(?:^|[;,{}\n])\s*)([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)?createRequire\d*\b(?!\s*\()/gm;
  for (const m of source.matchAll(aliasAssignRe)) {
    idents.add(m[1]);
  }
  return idents;
}

function buildCreateRequireIdentPattern(source) {
  const extra = [...collectCreateRequireIdents(source)].map(escapeRegExp);
  const parts = ['createRequire\\d*', '__agbCreateRequire\\d*', ...extra];
  return `(?:${parts.join('|')})`;
}

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
  } else if (trimmed.length > 0) {
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
  for (const m of source.matchAll(IMPORT_META_RESOLVE_PATTERN)) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(source, openIdx);
    if (closeIdx !== -1) {
      recordCallArg(extractFirstCallArg(source.slice(openIdx + 1, closeIdx)), found);
    }
  }
  const createRequireIdent = buildCreateRequireIdentPattern(source);
  const directCreateRequireRe = new RegExp(`(?:[\\w$]+\\.)?\\b${createRequireIdent}\\s*\\(`, 'g');
  for (const m of source.matchAll(directCreateRequireRe)) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(source, openIdx);
    if (closeIdx === -1) continue;
    const tail = source.slice(closeIdx + 1);
    const chained = /^(?:\s*\.\s*resolve)?\s*\(/.exec(tail);
    if (!chained) continue;
    const argOpenIdx = closeIdx + 1 + chained[0].length - 1;
    const argCloseIdx = findMatchingParen(source, argOpenIdx);
    if (argCloseIdx !== -1) {
      recordCallArg(extractFirstCallArg(source.slice(argOpenIdx + 1, argCloseIdx)), found);
    }
  }
  for (const m of source.matchAll(PROCESS_BINDING_PATTERN)) {
    const raw = m[1].trim().replace(/^["'`]|["'`]$/g, '');
    found.add(`process.binding:${raw}`);
  }
  const boundCreateRequireDecl = new RegExp(`(?:\\b(?:const|let|var)\\s+|(?:^|[;,{}\\n])\\s*)([A-Za-z_$][\\w$]*)\\s*=\\s*(?:[\\w$]+\\.)?${createRequireIdent}\\s*\\(`, 'gm');
  for (const decl of source.matchAll(boundCreateRequireDecl)) {
    const ident = decl[1];
    const openIdx = decl.index + decl[0].length - 1;
    if (findMatchingParen(source, openIdx) === -1) continue;
    if (/^(?:__)?require\d*$/.test(ident)) continue;
    const escaped = escapeRegExp(ident);
    const boundCallRe = new RegExp(`\\b${escaped}(?:\\s*\\.\\s*resolve)?\\s*\\(`, 'g');
    for (const m of source.matchAll(boundCallRe)) {
      const callOpenIdx = m.index + m[0].length - 1;
      const callCloseIdx = findMatchingParen(source, callOpenIdx);
      if (callCloseIdx !== -1) {
        recordCallArg(extractFirstCallArg(source.slice(callOpenIdx + 1, callCloseIdx)), found);
      }
    }
  }
  return [...found].sort();
}

export function maskAllowedOptionalProbeRegions(source, bundleKey) {
  if (!BUNDLE_ALLOWED_OPTIONAL_PROBES[bundleKey]) return source;
  let masked = source;
  const fnRe = /\bfunction\s+inspectTypeScript\s*\([^)]*\)\s*\{/g;
  for (const m of source.matchAll(fnRe)) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingDelimiter(source, openIdx, '{', '}');
    if (closeIdx !== -1) {
      const start = m.index;
      const end = closeIdx + 1;
      masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
    }
  }
  if (bundleKey === 'vendor/adlc/dist/syntax-check-typescript.mjs') {
    const callRe = /\bcreateRequire2\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*\)\s*\(\s*resolved\.path\s*\)/g;
    masked = masked.replace(callRe, (match) => ' '.repeat(match.length));
  }
  return masked;
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
    const bundleKey = normalizeBundleKey(file);
    const allowed = BUNDLE_ALLOWED_OPTIONAL_PROBES[bundleKey];
    const outerExternals = allowed ? findExternalSpecifiers(maskAllowedOptionalProbeRegions(source, bundleKey)) : [];
    const unexpectedExternals = findExternalSpecifiers(source).filter((spec) => !allowed?.has(spec));
    const externals = [...new Set([...outerExternals, ...unexpectedExternals])].sort();
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
