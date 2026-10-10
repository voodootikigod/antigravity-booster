#!/usr/bin/env node
// §7.8: forbidden stale-claim patterns (stale-claims.json, copied from spec §6) must not appear in
// website/content/** (design-history excluded). --with-root also scans the root docs. --final
// additionally requires every id C1–C35 in some non-placeholder page's `claims:`.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs } from './lib/args.mjs';
import { frontmatter, isPlaceholder, listFiles, read } from './lib/md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DOCS = [
  'README.md',
  'USAGE.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/usage.md',
  'docs/guidelines.md',
  'docs/execution-example.md',
];

export function checkStaleClaims({ repo, withRoot = false, final = false, patternsFile }) {
  const errors = [];
  const patterns = JSON.parse(read(patternsFile ?? path.join(repo, 'website/scripts/stale-claims.json'))).map(
    ({ id, pattern }) => ({ id, re: new RegExp(pattern) }),
  );
  const content = path.join(repo, 'website/content');
  const files = listFiles(content, (r) => /\.mdx?$/.test(r) && !r.includes('project/design-history/')).map(
    (r) => `website/content/${r}`,
  );
  if (withRoot) for (const f of ROOT_DOCS) if (existsSync(path.join(repo, f))) files.push(f);
  for (const f of files) {
    read(path.join(repo, f))
      .split('\n')
      .forEach((line, i) => {
        for (const p of patterns)
          if (p.re.test(line)) errors.push(`${f}:${i + 1}: stale claim ${p.id} (/${p.re.source}/)`);
      });
  }
  if (final) {
    const seen = new Set();
    for (const r of listFiles(content, (x) => x.endsWith('.mdx'))) {
      const text = read(path.join(content, r));
      if (isPlaceholder(text)) continue;
      const claims = frontmatter(text).data.claims;
      if (Array.isArray(claims)) for (const c of claims) seen.add(c);
    }
    for (let n = 1; n <= 35; n++)
      if (!seen.has(`C${n}`)) errors.push(`website/content:1: C${n} is not in any non-placeholder page's claims:`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { flags: ['--with-root', '--final'], options: ['--repo'] });
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(HERE, '../..');
  const errors = checkStaleClaims({ repo, withRoot: args['with-root'], final: args.final });
  if (errors.length) fail(errors);
  console.log('check-stale-claims: ok');
}
