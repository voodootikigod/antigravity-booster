// Appendix A P1: every import.meta.url-relative asset reference in lib/, bin/
// and mcp/ must resolve both from its source directory and from dist/ (the
// bundles execute with import.meta.url = dist/<bundle>.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const URL_REF = /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const DIRNAME_JOIN = /join\(\s*dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g;

function refs(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.mjs'))) {
    const src = readFileSync(join(ROOT, dir, name), 'utf8');
    for (const m of src.matchAll(URL_REF)) out.push({ file: `${dir}/${name}`, rel: m[1] });
    for (const m of src.matchAll(DIRNAME_JOIN)) {
      out.push({ file: `${dir}/${name}`, rel: [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join('/') });
    }
  }
  return out;
}

test('import.meta.url-relative assets resolve from source dirs and from dist/', () => {
  const all = ['lib', 'bin', 'mcp'].flatMap(refs).filter((r) => r.rel !== '.' && r.rel !== '..');
  assert.ok(all.length >= 4, 'expected to find asset references');
  for (const { file, rel } of all) {
    const fromSource = resolve(ROOT, file, '..', rel);
    const fromDist = resolve(ROOT, 'dist', rel);
    assert.ok(existsSync(fromSource), `${file}: ${rel} missing from source (${fromSource})`);
    assert.ok(existsSync(fromDist), `${file}: ${rel} missing when bundled (${fromDist})`);
  }
});
