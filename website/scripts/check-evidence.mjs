#!/usr/bin/env node
// §7.8: every non-placeholder page with `claims:` links each claim id to a blob/v1.0.0 permalink
// with a line anchor ([C4](…/blob/v1.0.0/<path>#L<n>)); nothing under website/content or
// website/generated links blob/main with a line anchor (D11).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs } from './lib/args.mjs';
import { frontmatter, isPlaceholder, listFiles, read } from './lib/md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERMALINK = 'https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/';

export function checkEvidence({ repo }) {
  const errors = [];
  for (const sub of ['website/content', 'website/generated']) {
    for (const r of listFiles(path.join(repo, sub), (x) => /\.mdx?$/.test(x))) {
      const f = `${sub}/${r}`;
      const text = read(path.join(repo, f));
      text.split('\n').forEach((line, i) => {
        if (/\/blob\/main\/[^)\s]*#L/.test(line))
          errors.push(`${f}:${i + 1}: blob/main link with a line anchor (use blob/v1.0.0)`);
      });
      if (sub !== 'website/content' || isPlaceholder(text)) continue;
      const claims = frontmatter(text).data.claims;
      if (claims === undefined) continue;
      if (!Array.isArray(claims)) {
        errors.push(`${f}:1: claims: must be a YAML list`);
        continue;
      }
      for (const id of claims) {
        const esc = PERMALINK.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        const re = new RegExp(`\\[${id}\\]\\(${esc}[^)\\s#]+#L\\d+(-L\\d+)?\\)`);
        if (!re.test(text)) errors.push(`${f}:1: claim ${id} has no [${id}](${PERMALINK}<path>#L<n>) link`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { options: ['--repo'] });
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(HERE, '../..');
  const errors = checkEvidence({ repo });
  if (errors.length) fail(errors);
  console.log('check-evidence: ok');
}
