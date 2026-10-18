import test from 'node:test';
import assert from 'node:assert/strict';
import { findExternalSpecifiers, isBuiltin } from '../scripts/check-bundle-externals.mjs';

test('isBuiltin: node: prefixed and bare built-ins, including subpaths', () => {
  for (const s of ['node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:child_process', 'path', 'node:test']) {
    assert.equal(isBuiltin(s), true, s);
  }
  for (const s of ['minimatch', '@adlc/tickets', './local.mjs', 'node:nope']) {
    assert.equal(isBuiltin(s), false, s);
  }
});

test('findExternalSpecifiers: built-in-only bundle is clean', () => {
  const src = `import { readFileSync } from "node:fs";\nimport path from "path";\nconst x = require("node:crypto");\nawait import("node:os");\n`;
  assert.deepEqual(findExternalSpecifiers(src), []);
});

test('findExternalSpecifiers: catches static, side-effect, re-export, dynamic and require forms', () => {
  const src = [
    'import { minimatch } from "minimatch";',
    'import "side-effect-pkg";',
    'export { x } from "@adlc/core";',
    'const t = await import("@adlc/tickets");',
    "const y = require('left-pad');",
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['@adlc/core', '@adlc/tickets', 'left-pad', 'minimatch', 'side-effect-pkg']);
});

test('DEFAULT_BUNDLES covers all four shipped bundles (incl. vendored adlc)', async () => {
  const { DEFAULT_BUNDLES } = await import('../scripts/check-bundle-externals.mjs');
  assert.deepEqual(DEFAULT_BUNDLES, ['dist/agb.mjs', 'dist/mcp-server.mjs', 'dist/hooks/pre-tool-use.bundle.mjs', 'vendor/adlc/dist/adlc.bundle.mjs']);
});

test('findExternalSpecifiers: catches template literals and dynamic/computed call expressions', () => {
  const src = [
    'const a = require(`custom-pkg`);',
    'const b = await import(`nested/mod`);',
    'const c = require(`dynamic-pkg/${name}`);',
    'const d = require(unknownVar);',
    'const ok1 = await import(`node:fs`);',
    'const ok2 = require(`node:path`);',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['`dynamic-pkg/${name}`', 'custom-pkg', 'nested/mod', 'unknownVar']);
});

test('findExternalSpecifiers: catches numbered require identifiers emitted by esbuild', () => {
  const src = [
    'const x = require2("some-pkg");',
    'const y = require123("another-pkg");',
    'const ok = require2("node:path");',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['another-pkg', 'some-pkg']);
});

test('findExternalSpecifiers: catches direct and bound createRequire calls while allowing built-ins', () => {
  const src = [
    'import { createRequire } from "node:module";',
    'const a = createRequire(import.meta.url)("direct-ext");',
    'const ok1 = createRequire(import.meta.url)("node:fs");',
    'const customReq = createRequire(import.meta.url);',
    'const b = customReq("bound-ext");',
    'const ok2 = customReq("node:crypto");',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['bound-ext', 'direct-ext']);
});

test('findExternalSpecifiers: catches .resolve, bare __esm assignments, and __agbCreateRequire', () => {
  const src = [
    'const r1 = require.resolve("ext-resolve-1");',
    'const r2 = createRequire(import.meta.url).resolve("ext-resolve-2");',
    'var hoistedReq;',
    'hoistedReq = __agbCreateRequire(import.meta.url);',
    'const r3 = hoistedReq.resolve("ext-resolve-3");',
    'const ok = require.resolve("node:fs");',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['ext-resolve-1', 'ext-resolve-2', 'ext-resolve-3']);
});


