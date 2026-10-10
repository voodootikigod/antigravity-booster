#!/usr/bin/env node
// §7.9: Known-issue callouts track T-CODE-FIXES-AUDIT. Once that ticket is archived
// (.adlc/ticket-archive/t-code-fixes-audit--*), no page may keep a callout; every callout's item
// number must be 1–9.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs } from './lib/args.mjs';
import { listFiles, read } from './lib/md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK = 'Known issue (T-CODE-FIXES-AUDIT';

export function checkKnownIssues({ repo }) {
  const errors = [];
  let archived = false;
  try {
    archived = readdirSync(path.join(repo, '.adlc/ticket-archive')).some((n) => n.startsWith('t-code-fixes-audit--'));
  } catch {
    archived = false;
  }
  for (const r of listFiles(path.join(repo, 'website/content'), (x) => /\.mdx?$/.test(x))) {
    const f = `website/content/${r}`;
    read(path.join(repo, f))
      .split('\n')
      .forEach((line, i) => {
        if (!line.includes(MARK)) return;
        if (archived) errors.push(`${f}:${i + 1}: T-CODE-FIXES-AUDIT is archived but a Known issue callout remains`);
        for (const m of line.matchAll(/Known issue \(T-CODE-FIXES-AUDIT(?: item (\d+))?\)?/g)) {
          const n = Number(m[1]);
          if (!m[1] || !Number.isInteger(n) || n < 1 || n > 9)
            errors.push(`${f}:${i + 1}: Known issue callout needs "item N" with N in 1–9`);
        }
      });
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { options: ['--repo'] });
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(HERE, '../..');
  const errors = checkKnownIssues({ repo });
  if (errors.length) fail(errors);
  console.log('check-known-issues: ok');
}
