// Deterministic directory-tree digest (lowercase hex SHA-256).
//
// Records, sorted by POSIX relative path in UTF-8 byte order, each terminated
// by NUL (paths cannot contain NUL, so framing is unambiguous):
//   regular file: relpath \0 ('x' if any execute bit set, else 'f') \0 sha256hex(content) \0
//   symlink:      relpath \0 'l' \0 linkTarget \0     (never followed)
// Directories contribute only via their contents (empty dirs are ignored);
// mtimes/ownership are not recorded. Any entry with a path segment equal to a
// name in `exclude` is skipped (files, symlinks and directories alike).
// Other special files (sockets, FIFOs, devices) are ignored.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXEC_BITS = 0o111;

function collect(root, rel, excluded, out) {
  const abs = rel ? path.join(root, ...rel) : root;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const segs = [...rel, entry.name];
    const relpath = segs.join('/');
    const full = path.join(root, ...segs);
    if (entry.isSymbolicLink()) {
      out.push({ relpath, payload: `l\0${fs.readlinkSync(full)}` });
    } else if (entry.isDirectory()) {
      collect(root, segs, excluded, out);
    } else if (entry.isFile()) {
      const cls = fs.statSync(full).mode & EXEC_BITS ? 'x' : 'f';
      const h = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      out.push({ relpath, payload: `${cls}\0${h}` });
    }
  }
}

export function computeDirectoryDigest(dir, { exclude = [] } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir must be a non-empty string');
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const records = [];
  collect(dir, [], new Set(exclude), records);
  records.sort((a, b) => Buffer.compare(Buffer.from(a.relpath), Buffer.from(b.relpath)));
  const hash = createHash('sha256');
  for (const r of records) hash.update(`${r.relpath}\0${r.payload}\0`);
  return hash.digest('hex');
}
