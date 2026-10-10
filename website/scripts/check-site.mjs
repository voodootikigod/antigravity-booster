#!/usr/bin/env node
// §7.11: running-site checks against `next start` on 127.0.0.1 (needs a prior `next build`).
// Only http://127.0.0.1:<port>/ URLs are fetched, so this runs offline. Redirects are never
// followed: a 3xx (including the trailing-slash 308) is a failure.
//
// Flags: --port <n> (default 4310), --root <website dir> (default: this website),
//        --base-url <url> (test hook: check an already-running server instead of spawning next).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN_HISTORY = '/docs/project/design-history/';
// Boundary-aware: matches the section index (no trailing slash) and every page under it.
const DESIGN_HISTORY_RE = /\/docs\/project\/design-history(?=[/?#)\s]|$)/m;
const READY_TIMEOUT_MS = 60_000;
const FETCH_CONCURRENCY = 8;

/** Flatten ia.json into site paths; the root `index` maps to /docs, folder `index` to the folder. */
export function iaPaths(pages, prefix = '/docs') {
  const out = [];
  for (const entry of pages) {
    if (typeof entry === 'string') {
      if (/^---.*---$/.test(entry)) continue;
      out.push(entry === 'index' ? prefix : `${prefix}/${entry}`);
    } else {
      out.push(...iaPaths(entry.pages, `${prefix}/${entry.dir}`));
    }
  }
  return out;
}

/** Root-relative href/src values (not protocol-relative), entity-decoded, fragment removed. */
export function localRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/\s(?:href|src)=(?:"([^"]*)"|'([^']*)')/g)) {
    const raw = (m[1] ?? m[2]).replaceAll('&amp;', '&');
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    const ref = raw.split('#')[0];
    if (ref) refs.add(ref);
  }
  return refs;
}

function makeFetcher(baseUrl) {
  const base = new URL(baseUrl);
  return async function get(p) {
    const url = new URL(p, base);
    if (url.origin !== base.origin) throw new Error(`refusing to fetch non-local URL ${url.href}`);
    return fetch(url, { redirect: 'manual' });
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function designHistoryTitle(root) {
  const file = path.join(root, 'content/docs/project/design-history/index.mdx');
  if (!existsSync(file)) return 'Design history';
  const m = /^title:\s*"?([^"\n]+)"?\s*$/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1] : 'Design history';
}

export async function runChecks({ baseUrl, root }) {
  const errors = [];
  const get = makeFetcher(baseUrl);
  const ia = JSON.parse(readFileSync(path.join(root, 'scripts/ia.json'), 'utf8'));
  const version = JSON.parse(readFileSync(path.join(root, '..', 'package.json'), 'utf8')).version;
  const pages = iaPaths(ia.pages);
  const html = new Map();

  // (a) every IA page returns 200, no redirects.
  await mapLimit(['/', ...pages], FETCH_CONCURRENCY, async (p) => {
    try {
      const res = await get(p);
      const body = await res.text();
      if (res.status !== 200) errors.push(`${p}: (a) expected 200, got ${res.status}`);
      else html.set(p, body);
    } catch (e) {
      errors.push(`${p}: (a) fetch failed: ${e.message}`);
    }
  });

  // (b) every root-relative href/src in fetched HTML returns 200 without redirects (except /api/).
  const refs = new Map();
  for (const [page, body] of html) {
    for (const ref of localRefs(body)) {
      if (ref.startsWith('/api/')) continue;
      if (!refs.has(ref)) refs.set(ref, page);
    }
  }
  await mapLimit([...refs.keys()].sort(), FETCH_CONCURRENCY, async (ref) => {
    try {
      const res = await get(ref);
      await res.arrayBuffer();
      if (res.status !== 200) errors.push(`${refs.get(ref)}: (b) link ${ref} returned ${res.status}`);
    } catch (e) {
      errors.push(`${refs.get(ref)}: (b) link ${ref} fetch failed: ${e.message}`);
    }
  });

  // (c) search finds rails-guard and never returns design history.
  for (const [query, needResult] of [
    ['rails-guard', true],
    [designHistoryTitle(root), false],
  ]) {
    const where = `/api/search?query=${encodeURIComponent(query)}`;
    try {
      const res = await get(where);
      const data = res.status === 200 ? await res.json() : null;
      if (!Array.isArray(data)) {
        errors.push(`${where}: (c) expected a JSON array (status ${res.status})`);
        continue;
      }
      if (needResult && data.length === 0) errors.push(`${where}: (c) no results`);
      const leaked = data.filter((r) => DESIGN_HISTORY_RE.test(String(r?.url ?? '')));
      if (leaked.length) errors.push(`${where}: (c) design-history result ${leaked[0].url}`);
    } catch (e) {
      errors.push(`${where}: (c) ${e.message}`);
    }
  }

  // (d) llms.txt
  try {
    const res = await get('/llms.txt');
    const body = await res.text();
    if (res.status !== 200) errors.push(`/llms.txt: (d) expected 200, got ${res.status}`);
    else {
      if (!body.includes('/docs/getting-started/installation'))
        errors.push('/llms.txt: (d) missing /docs/getting-started/installation');
      if (DESIGN_HISTORY_RE.test(body)) errors.push('/llms.txt: (d) contains design history');
    }
  } catch (e) {
    errors.push(`/llms.txt: (d) ${e.message}`);
  }

  // (e) version banner on /
  const home = html.get('/');
  const banner = `Latest release: v${version}`;
  if (home !== undefined && !home.includes(banner)) errors.push(`/: (e) missing "${banner}"`);

  // (f) design-history banner
  for (const p of pages.filter((x) => `${x}/`.startsWith(DESIGN_HISTORY))) {
    const body = html.get(p);
    if (body !== undefined && !body.includes('Historical, superseded'))
      errors.push(`${p}: (f) missing "Historical, superseded"`);
  }

  // (g) OG image
  const og = '/og/docs/getting-started/installation/image.png';
  try {
    const res = await get(og);
    await res.arrayBuffer();
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !type.startsWith('image/png'))
      errors.push(`${og}: (g) expected 200 image/png, got ${res.status} ${type}`);
  } catch (e) {
    errors.push(`${og}: (g) ${e.message}`);
  }

  return { errors, checked: { pages: pages.length, links: refs.size } };
}

async function waitReady(baseUrl, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}`);
    try {
      const res = await fetch(new URL('/', baseUrl), { redirect: 'manual' });
      await res.arrayBuffer();
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server not ready after ${READY_TIMEOUT_MS / 1000}s`);
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 5000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      clearTimeout(killer);
      resolve();
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { options: ['--port', '--root', '--base-url'] });
  const root = args.root ? path.resolve(args.root) : WEBSITE;
  let baseUrl = args['base-url'];
  let child;
  try {
    if (!baseUrl) {
      const port = Number(args.port ?? 4310);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port ${args.port}`);
      if (!existsSync(path.join(root, '.next/BUILD_ID')))
        throw new Error('no .next/BUILD_ID: run `npm run build` first');
      baseUrl = `http://127.0.0.1:${port}`;
      const bin = path.join(root, 'node_modules/.bin/next');
      child = spawn(bin, ['start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
      });
      await waitReady(baseUrl, child);
    } else if (new URL(baseUrl).hostname !== '127.0.0.1') {
      throw new Error(`--base-url must be on 127.0.0.1, got ${baseUrl}`);
    }
    const { errors, checked } = await runChecks({ baseUrl, root });
    if (errors.length) {
      for (const e of errors.sort()) console.error(e);
      return 1;
    }
    console.log(`check-site: ok (${checked.pages} pages, ${checked.links} links)`);
    return 0;
  } catch (e) {
    console.error(`check-site: ${e.message}`);
    return 1;
  } finally {
    await stop(child);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
