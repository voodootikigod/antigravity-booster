// Markdown/MDX helpers shared by the generators and checks (node: built-ins only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const REPO_BLOB_MAIN = 'https://github.com/voodootikigod/antigravity-booster/blob/main/';

/** Escape text for a markdown table cell in MDX: braces, angle brackets and pipes become entities. */
export function cell(text) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '—';
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;');
}

/** Render a markdown table. `rows` are arrays of raw strings (escaped here). */
export function table(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  return out.join('\n');
}

/** Escape prose (outside code) for MDX: `{`, `}`, `<` and `>` become entities. */
export function prose(text) {
  return String(text)
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Minimal YAML frontmatter reader: top-level `key: value` pairs plus one nesting level. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { data: {}, lines: 0 };
  const data = {};
  let parent = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(raw);
    const top = /^([\w-]+):\s*(.*)$/.exec(raw);
    if (top) {
      const v = scalar(top[2]);
      data[top[1]] = top[2] === '' ? {} : v;
      parent = top[2] === '' ? top[1] : null;
    } else if (nested && parent) {
      data[parent][nested[1]] = scalar(nested[2]);
    }
  }
  return { data, lines: m[0].split('\n').length };
}

function scalar(v) {
  const s = v.trim();
  if (/^\[.*\]$/.test(s))
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => scalar(x))
      .filter((x) => x !== '');
  if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

/** Recursively list files under `dir` (sorted, POSIX-relative to `dir`) matching `filter`. */
export function listFiles(dir, filter = () => true, base = dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(listFiles(full, filter, base));
    else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (filter(rel)) out.push(rel);
    }
  }
  return out;
}

export function read(file) {
  return readFileSync(file, 'utf8');
}

/** True when an .mdx file's frontmatter has `placeholder: true`. */
export function isPlaceholder(text) {
  return frontmatter(text).data.placeholder === true;
}
