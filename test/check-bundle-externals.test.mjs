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

test('DEFAULT_BUNDLES covers all six shipped bundles (incl. vendored adlc, syntax-check-typescript, and watchdog)', async () => {
  const { DEFAULT_BUNDLES, BUNDLE_ALLOWED_OPTIONAL_PROBES } = await import('../scripts/check-bundle-externals.mjs');
  assert.deepEqual(DEFAULT_BUNDLES, [
    'dist/agb.mjs',
    'dist/mcp-server.mjs',
    'dist/hooks/pre-tool-use.bundle.mjs',
    'vendor/adlc/dist/adlc.bundle.mjs',
    'vendor/adlc/dist/syntax-check-typescript.mjs',
    'vendor/adlc/dist/watchdog.mjs',
  ]);
  assert.deepEqual(Object.keys(BUNDLE_ALLOWED_OPTIONAL_PROBES), [
    'vendor/adlc/dist/adlc.bundle.mjs',
    'vendor/adlc/dist/syntax-check-typescript.mjs',
  ]);
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

test('findExternalSpecifiers: catches esbuild __require and __require.resolve helpers while allowing built-ins', () => {
  const src = [
    'var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : {})(function(x) {});',
    'const a = __require("external-via-esbuild-helper");',
    'const b = __require.resolve("external-resolve-via-helper");',
    'const ok1 = __require("node:fs");',
    'const ok2 = __require.resolve("node:path");',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), ['external-resolve-via-helper', 'external-via-esbuild-helper']);
});

test('findExternalSpecifiers: catches process.binding, process._linkedBinding, and process.dlopen', () => {
  const src = [
    'const b1 = process.binding("spawn_sync");',
    'const b2 = process._linkedBinding("uv");',
    'process.dlopen(mod, "/tmp/addon.node");',
  ].join('\n');
  assert.deepEqual(findExternalSpecifiers(src), [
    'process.binding:mod, "/tmp/addon.node',
    'process.binding:spawn_sync',
    'process.binding:uv',
  ]);
});

test('main: verifies default bundles, normalizes ./ and absolute bundle paths, and fails on disallowed externals or missing files', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { main } = await import('../scripts/check-bundle-externals.mjs');

  assert.equal(main([]), 0, 'all six committed bundles pass with optional probe allowlist');
  assert.equal(main(['./vendor/adlc/dist/adlc.bundle.mjs', resolve('vendor/adlc/dist/syntax-check-typescript.mjs')]), 0);
  assert.equal(main(['./dist/nonexistent-bundle.mjs']), 1);

  const tmp = mkdtempSync(join(tmpdir(), 'agb-cbe-'));
  try {
    const badBundle = join(tmp, 'bad.mjs');
    writeFileSync(badBundle, 'import "typescript";\n');
    assert.equal(main([badBundle]), 1, 'non-allowlisted bundle importing typescript fails');
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/check-bundle-externals.mjs', badBundle], { stdio: 'pipe' }),
      (err) => err.status === 1,
    );

    const { maskAllowedOptionalProbeRegions } = await import('../scripts/check-bundle-externals.mjs');
    const cleanMasked = maskAllowedOptionalProbeRegions(
      'function inspectTypeScript(f){const r=require2("typescript");return r;}\nconst ok = 1;\n',
      'vendor/adlc/dist/adlc.bundle.mjs',
    );
    assert.deepEqual(findExternalSpecifiers(cleanMasked), []);
    const leakMasked = maskAllowedOptionalProbeRegions(
      'function inspectTypeScript(f){const r=require2("typescript");}\nrequire("typescript");\n',
      'vendor/adlc/dist/adlc.bundle.mjs',
    );
    assert.deepEqual(findExternalSpecifiers(leakMasked), ['typescript']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


