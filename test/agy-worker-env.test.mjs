import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgy } from '../lib/agy.mjs';
import { prosecute } from '../lib/prosecute.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const libSrc = (f) => readFileSync(fileURLToPath(new URL(`../lib/${f}`, import.meta.url)), 'utf8');

const SAVED = {};
const KEYS = ['AGB_WORKER_TICKET', 'AGB_WORKER_MODE', 'FAKE_STATE_DIR', 'FAKE_RECORD_ENV', 'AGB_AGY_BIN'];
function setup() {
  for (const k of KEYS) SAVED[k] = process.env[k];
  const dir = mkdtempSync(join(tmpdir(), 'agb-worker-env-'));
  process.env.FAKE_STATE_DIR = dir;
  process.env.FAKE_RECORD_ENV = '1';
  process.env.AGB_AGY_BIN = FAKE_AGY;
  return dir;
}
function teardown(dir) {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  rmSync(dir, { recursive: true, force: true });
}
function seenEnv(dir) {
  const out = {};
  for (const line of readFileSync(join(dir, 'full-env'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { ticket: out.AGB_WORKER_TICKET, mode: out.AGB_WORKER_MODE };
}
async function run(extra, inherited = {}) {
  const dir = setup();
  try {
    for (const [k, v] of Object.entries(inherited)) process.env[k] = v;
    const res = await runAgy({ model: 'gemini-3-pro', prompt: 'hello', ...extra });
    assert.ok(res.ok, res.error);
    return seenEnv(dir);
  } finally { teardown(dir); }
}

test('worker ticket sets only AGB_WORKER_TICKET', async () => {
  assert.deepEqual(await run({ worker: { ticket: 'T1' } }), { ticket: 'T1', mode: undefined });
});

test('worker readonly sets only AGB_WORKER_MODE=readonly', async () => {
  assert.deepEqual(await run({ worker: { mode: 'readonly' } }), { ticket: undefined, mode: 'readonly' });
});

test('no worker option fails closed to readonly', async () => {
  assert.deepEqual(await run({}), { ticket: undefined, mode: 'readonly' });
});

test('malformed worker (empty/non-string ticket) fails closed to readonly', async () => {
  assert.deepEqual(await run({ worker: { ticket: '  ' } }), { ticket: undefined, mode: 'readonly' });
  assert.deepEqual(await run({ worker: { ticket: 42 } }), { ticket: undefined, mode: 'readonly' });
  assert.deepEqual(await run({ worker: null }), { ticket: undefined, mode: 'readonly' });
});

test('inherited readonly mode is removed for a ticketed worker', async () => {
  assert.deepEqual(
    await run({ worker: { ticket: 'T2' } }, { AGB_WORKER_MODE: 'readonly', AGB_WORKER_TICKET: 'OTHER' }),
    { ticket: 'T2', mode: undefined });
});

test('inherited ticket is removed for a readonly worker', async () => {
  assert.deepEqual(
    await run({ worker: { mode: 'readonly' } }, { AGB_WORKER_TICKET: 'LEAK' }),
    { ticket: undefined, mode: 'readonly' });
  assert.deepEqual(await run({}, { AGB_WORKER_TICKET: 'LEAK' }), { ticket: undefined, mode: 'readonly' });
});

test('per-call env option cannot smuggle a conflicting worker variable', async () => {
  assert.deepEqual(
    await run({ worker: { ticket: 'T3' }, env: { AGB_WORKER_MODE: 'readonly' } }),
    { ticket: 'T3', mode: undefined });
});

test('sanitizeEnv spawns still carry the worker marker', async () => {
  assert.deepEqual(await run({ sanitizeEnv: true, worker: { ticket: 'T4' } }), { ticket: 'T4', mode: undefined });
  assert.deepEqual(await run({ sanitizeEnv: true }, { AGB_WORKER_TICKET: 'LEAK' }), { ticket: undefined, mode: 'readonly' });
});

test('prosecute (behavioral): its agy child is marked readonly', async () => {
  const dir = setup();
  try {
    process.env.AGB_WORKER_TICKET = 'LEAK';
    await prosecute({
      ticket: { id: 'T9', title: 't', body: 'b' },
      diff: 'diff --git a/x b/x\n+1\n',
      model: 'gemini-3-pro',
      cwd: dir,
    });
    assert.deepEqual(seenEnv(dir), { ticket: undefined, mode: 'readonly' });
  } finally { teardown(dir); }
});

// The remaining callers have no runAgy injection seam (runAgy is a direct ES
// import), so these are static source checks of each call site: every
// runAgy({...}) object literal must carry the intended worker option.
function runAgyBlocks(src) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf('runAgy({', from);
    if (i < 0) break;
    let depth = 0, j = i + 'runAgy('.length;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    blocks.push(src.slice(i, j + 1));
    from = j;
  }
  return blocks;
}

for (const [file, count] of [['review.mjs', 1], ['prosecute.mjs', 1], ['preflight.mjs', 1], ['plan.mjs', 3], ['brain.mjs', 1]]) {
  test(`static: every runAgy call in ${file} passes worker readonly`, () => {
    const blocks = runAgyBlocks(libSrc(file));
    assert.equal(blocks.length, count);
    for (const b of blocks) assert.match(b, /worker:\s*\{\s*mode:\s*'readonly'\s*\}/);
  });
}

test('static: scheduler builder runAgy call passes worker ticket', () => {
  const blocks = runAgyBlocks(libSrc('scheduler.mjs'));
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /worker:\s*\{\s*ticket:\s*ticketId \?\? t\.id\s*\}/);
  assert.doesNotMatch(blocks[0], /mode:\s*'readonly'/);
});

test('static: sweep spawns no agy session directly (compiles to a plan only)', () => {
  assert.doesNotMatch(libSrc('sweep.mjs'), /runAgy|spawn\(/);
});
