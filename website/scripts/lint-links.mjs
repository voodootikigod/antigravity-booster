#!/usr/bin/env node
// `npm run lint:links`: next-validate-link over content/docs/**/*.mdx.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printErrors, scanURLs, validateFiles } from 'next-validate-link';

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(WEBSITE, 'content/docs');

function listMdx(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? listMdx(path.join(dir, e.name)) : e.name.endsWith('.mdx') ? [path.join(dir, e.name)] : [],
    )
    .sort();
}

function slugsOf(file) {
  const parts = path.relative(DOCS, file).slice(0, -4).split(path.sep);
  if (parts.at(-1) === 'index') parts.pop();
  return parts;
}

const files = listMdx(DOCS);
const scanned = await scanURLs({
  preset: 'next',
  cwd: WEBSITE,
  populate: {
    'docs/[[...slug]]': files.map((f) => ({ value: slugsOf(f) })),
  },
});

const results = await validateFiles(
  files.map((f) => ({ path: path.relative(WEBSITE, f), content: readFileSync(f, 'utf8') })),
  { scanned, checkRelativePaths: 'as-url' },
);
printErrors(results, false);
const errorCount = results.reduce((n, r) => n + r.errors.length, 0);
if (errorCount) process.exit(1);
console.log(`lint:links: ok (${files.length} files)`);
