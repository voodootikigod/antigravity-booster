#!/usr/bin/env node
// §7.10: content/docs structure equals scripts/ia.json; every folder has meta.json,
// every .mdx is listed, every listed entry exists. --no-placeholders fails on placeholder: true.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs } from './lib/args.mjs';

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function checkIa({ root = WEBSITE, noPlaceholders = false } = {}) {
  const errors = [];
  const docs = path.join(root, 'content/docs');
  const iaFile = path.join(root, 'scripts/ia.json');
  let ia;
  try {
    ia = JSON.parse(readFileSync(iaFile, 'utf8'));
  } catch (e) {
    return [`${iaFile}:1: cannot read ia.json (${e.message})`];
  }
  if (!existsSync(docs)) return [`${docs}:1: content/docs missing`];

  const rel = (p) => path.relative(root, p);
  walk(docs, ia.pages, '');
  function walk(dir, expected, label) {
    const metaFile = path.join(dir, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch (e) {
      errors.push(`${rel(metaFile)}:1: missing or invalid meta.json (${e.message})`);
      return;
    }
    if (!Array.isArray(meta.pages)) {
      errors.push(`${rel(metaFile)}:1: meta.json has no pages array`);
      return;
    }
    const want = expected.map((e) => (typeof e === 'string' ? e : e.dir));
    if (JSON.stringify(meta.pages) !== JSON.stringify(want)) {
      errors.push(
        `${rel(metaFile)}:1: pages ${JSON.stringify(meta.pages)} != ia.json ${label || '<root>'} ${JSON.stringify(want)}`,
      );
    }
    const listed = new Set(meta.pages.filter((p) => typeof p === 'string'));
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!listed.has(name)) errors.push(`${rel(full)}:1: folder not listed in ${rel(metaFile)}`);
      } else if (name.endsWith('.mdx') && !listed.has(name.slice(0, -4))) {
        errors.push(`${rel(full)}:1: page not listed in ${rel(metaFile)}`);
      }
    }
    for (const entry of meta.pages) {
      if (typeof entry !== 'string' || /^---.*---$/.test(entry)) continue;
      const file = path.join(dir, `${entry}.mdx`);
      const sub = path.join(dir, entry);
      if (existsSync(file)) {
        if (noPlaceholders && /^placeholder:\s*true\s*$/m.test(frontmatter(file))) {
          errors.push(`${rel(file)}:1: placeholder: true`);
        }
      } else if (!(existsSync(sub) && statSync(sub).isDirectory())) {
        errors.push(`${rel(metaFile)}:1: listed entry "${entry}" does not exist`);
      }
    }
    for (const e of expected) {
      if (typeof e === 'object') {
        const sub = path.join(dir, e.dir);
        if (existsSync(sub) && statSync(sub).isDirectory()) walk(sub, e.pages, `${label}${e.dir}/`);
        else errors.push(`${rel(sub)}:1: folder required by ia.json is missing`);
      }
    }
  }
  return errors;
}

function frontmatter(file) {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
  return m ? m[1] : '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { flags: ['--no-placeholders'], options: ['--root'] });
  const errors = checkIa({
    root: args.root ? path.resolve(args.root) : WEBSITE,
    noPlaceholders: args['no-placeholders'],
  });
  if (errors.length) fail(errors);
  console.log('check-ia: ok');
}
