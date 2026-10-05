import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDirectoryDigest } from '../lib/digest.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agb-digest-'));
}
function build(dir, files) {
  for (const [rel, content] of files) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
const BASE = [['a.txt', 'hello'], ['sub/b.txt', 'world'], ['sub/deep/c.txt', 'x']];
function fixture(files = BASE) {
  const d = tmp();
  build(d, files);
  return d;
}

test('returns lowercase 64-char hex', () => {
  const d = fixture();
  assert.match(computeDirectoryDigest(d), /^[0-9a-f]{64}$/);
});

test('identical trees in different dirs are equal; creation order irrelevant', () => {
  const a = fixture(BASE);
  const b = fixture([...BASE].reverse());
  assert.equal(computeDirectoryDigest(a), computeDirectoryDigest(b));
});

test('changing one byte changes digest', () => {
  const a = fixture();
  const b = fixture([['a.txt', 'hellp'], ...BASE.slice(1)]);
  assert.notEqual(computeDirectoryDigest(a), computeDirectoryDigest(b));
});

test('renaming a file changes digest', () => {
  const a = fixture();
  const d = fixture();
  fs.renameSync(path.join(d, 'a.txt'), path.join(d, 'z.txt'));
  assert.notEqual(computeDirectoryDigest(a), computeDirectoryDigest(d));
});

test('adding a file changes digest', () => {
  const a = fixture();
  const before = computeDirectoryDigest(a);
  fs.writeFileSync(path.join(a, 'new.txt'), '');
  assert.notEqual(computeDirectoryDigest(a), before);
});

test('toggling execute bit changes digest; all x bits are one class', () => {
  const d = fixture();
  const f = path.join(d, 'a.txt');
  fs.chmodSync(f, 0o644);
  const plain = computeDirectoryDigest(d);
  fs.chmodSync(f, 0o755);
  const exec = computeDirectoryDigest(d);
  assert.notEqual(plain, exec);
  fs.chmodSync(f, 0o744);
  assert.equal(computeDirectoryDigest(d), exec);
  fs.chmodSync(f, 0o600);
  assert.equal(computeDirectoryDigest(d), plain);
});

test('mtime changes do not affect digest', () => {
  const d = fixture();
  const before = computeDirectoryDigest(d);
  const old = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(path.join(d, 'a.txt'), old, old);
  fs.utimesSync(path.join(d, 'sub'), old, old);
  assert.equal(computeDirectoryDigest(d), before);
});

test('empty directories are ignored', () => {
  const a = fixture();
  const before = computeDirectoryDigest(a);
  fs.mkdirSync(path.join(a, 'empty', 'nested'), { recursive: true });
  assert.equal(computeDirectoryDigest(a), before);
});

test('exclude skips any path segment match, at any depth', () => {
  const a = fixture();
  const base = computeDirectoryDigest(a, { exclude: ['node_modules', '.git', '.worktrees'] });
  build(a, [['node_modules/x/index.js', '1'], ['.git/HEAD', 'ref'], ['sub/node_modules/y.js', '2'],
    ['.worktrees/w/f', '3']]);
  assert.equal(computeDirectoryDigest(a, { exclude: ['node_modules', '.git', '.worktrees'] }), base);
  assert.notEqual(computeDirectoryDigest(a), base);
  assert.notEqual(computeDirectoryDigest(a, { exclude: ['node_modules'] }), base);
});

test('exclude also skips excluded files and symlinks by name', () => {
  const a = fixture();
  const base = computeDirectoryDigest(a, { exclude: ['skipme'] });
  fs.writeFileSync(path.join(a, 'skipme'), 'x');
  fs.symlinkSync('whatever', path.join(a, 'sub', 'skipme'));
  assert.equal(computeDirectoryDigest(a, { exclude: ['skipme'] }), base);
});

test('symlinks are not followed; only target string matters', () => {
  const other = fixture([['t1/f', 'one'], ['t2/f', 'two']]);
  const d = fixture();
  fs.symlinkSync(path.join(other, 't1'), path.join(d, 'link'));
  const d1 = computeDirectoryDigest(d);
  // changing content behind the link does not change the digest
  fs.writeFileSync(path.join(other, 't1', 'f'), 'changed');
  assert.equal(computeDirectoryDigest(d), d1);
  // repointing changes it
  fs.unlinkSync(path.join(d, 'link'));
  fs.symlinkSync(path.join(other, 't2'), path.join(d, 'link'));
  assert.notEqual(computeDirectoryDigest(d), d1);
});

test('dangling symlink is recorded, not an error; link differs from file with same text', () => {
  const d = fixture();
  fs.symlinkSync('does-not-exist', path.join(d, 'dangling'));
  assert.match(computeDirectoryDigest(d), /^[0-9a-f]{64}$/);
  const e = fixture();
  fs.writeFileSync(path.join(e, 'dangling'), 'does-not-exist');
  assert.notEqual(computeDirectoryDigest(d), computeDirectoryDigest(e));
});

test('symlink to a directory is not descended', () => {
  const d = fixture();
  fs.symlinkSync('sub', path.join(d, 'loop'));
  fs.symlinkSync('.', path.join(d, 'sub', 'self'));
  assert.match(computeDirectoryDigest(d), /^[0-9a-f]{64}$/);
});

test('sorting is by byte order of POSIX relative path', () => {
  // 'a/b' vs 'a.b' vs 'a-b': '-'(2d) < '.'(2e) < '/'(2f); order must be stable across creation order
  const files = [['a/b', '1'], ['a.b', '2'], ['a-b', '3'], ['B', '4'], ['é', '5']];
  assert.equal(computeDirectoryDigest(fixture(files)), computeDirectoryDigest(fixture([...files].reverse())));
});

test('throws on non-existent dir and on a non-directory', () => {
  assert.throws(() => computeDirectoryDigest(path.join(tmp(), 'nope')));
  const d = fixture();
  assert.throws(() => computeDirectoryDigest(path.join(d, 'a.txt')));
});

test('empty directory yields a stable digest', () => {
  assert.equal(computeDirectoryDigest(tmp()), computeDirectoryDigest(tmp()));
});

test('golden: the record format is relpath NUL class NUL sha256 NUL, x for executables', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { computeDirectoryDigest } = await import('../lib/digest.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'agb-digest-golden-'));
  try {
    writeFileSync(join(dir, 'a.sh'), 'run');
    chmodSync(join(dir, 'a.sh'), 0o755);
    writeFileSync(join(dir, 'b.txt'), 'data');
    chmodSync(join(dir, 'b.txt'), 0o644);
    const sha = (s) => createHash('sha256').update(s).digest('hex');
    const expected = createHash('sha256').update(`a.sh\0x\0${sha('run')}\0b.txt\0f\0${sha('data')}\0`).digest('hex');
    assert.equal(computeDirectoryDigest(dir), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty dir argument is a TypeError, not a filesystem error', async () => {
  const { computeDirectoryDigest } = await import('../lib/digest.mjs');
  assert.throws(() => computeDirectoryDigest(''), TypeError);
});
