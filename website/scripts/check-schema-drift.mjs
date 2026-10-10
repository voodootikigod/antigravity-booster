#!/usr/bin/env node
// §7.7: every top-level field name in the <TypeTable type={{ … }} /> blocks of
// reference/plan-schema.mdx and reference/sweep-schema.mdx appears as a string in lib/plan.mjs /
// lib/sweep.mjs. Placeholder pages are skipped.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs } from './lib/args.mjs';
import { lineOf, ParseError, parseLiteral } from './lib/jslit.mjs';
import { isPlaceholder, read } from './lib/md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PAIRS = [
  ['website/content/docs/reference/plan-schema.mdx', 'lib/plan.mjs'],
  ['website/content/docs/reference/sweep-schema.mdx', 'lib/sweep.mjs'],
];

/** Top-level keys (with lines) of every TypeTable `type={{ … }}` in an MDX source. */
export function typeTableFields(text) {
  const fields = [];
  for (const m of text.matchAll(/<TypeTable\b[^>]*?\btype=\{/g)) {
    const start = m.index + m[0].length;
    const at = text.slice(start).search(/\S/) + start;
    if (text[at] !== '{') throw new ParseError('TypeTable type must be an object literal', lineOf(text, start));
    const { value } = parseLiteral(text, at);
    for (const k of Object.keys(value)) {
      const idx = text.indexOf(k, at);
      fields.push({ name: k, line: lineOf(text, idx === -1 ? at : idx) });
    }
  }
  return fields;
}

export function checkSchemaDrift({ repo, pairs = PAIRS }) {
  const errors = [];
  for (const [page, src] of pairs) {
    const pageFile = path.join(repo, page);
    if (!existsSync(pageFile)) continue;
    const text = read(pageFile);
    if (isPlaceholder(text)) continue;
    let code;
    try {
      code = read(path.join(repo, src));
    } catch {
      errors.push(`${src}:1: cannot read schema source`);
      continue;
    }
    let fields;
    try {
      fields = typeTableFields(text);
    } catch (e) {
      if (e instanceof ParseError) {
        errors.push(`${page}:${e.line}: ${e.message}`);
        continue;
      }
      throw e;
    }
    for (const f of fields) {
      // "Appears as a string": the field name occurs as a whole word in the schema source.
      if (!new RegExp(`\\b${f.name.replace(/[$]/g, '\\$&')}\\b`).test(code))
        errors.push(`${page}:${f.line}: TypeTable field ${f.name} not found in ${src}`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { options: ['--repo'] });
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(HERE, '../..');
  const errors = checkSchemaDrift({ repo });
  if (errors.length) fail(errors);
  console.log('check-schema-drift: ok');
}
