// scripts/update-adlc-digests.mjs: the pinned block it renders round-trips
// with what lib/adlc-bridge.mjs exports, and offline verify detects drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVendoredDigests, renderBlock } from '../scripts/update-adlc-digests.mjs';
import { KNOWN_VENDORED_ADLC } from '../lib/adlc-bridge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('computeVendoredDigests matches the committed KNOWN_VENDORED_ADLC', () => {
  assert.deepEqual(computeVendoredDigests(), { ...KNOWN_VENDORED_ADLC });
});

test('renderBlock reproduces the exact block committed in lib/adlc-bridge.mjs', () => {
  const source = readFileSync(join(ROOT, 'lib', 'adlc-bridge.mjs'), 'utf8');
  assert.ok(source.includes(renderBlock(KNOWN_VENDORED_ADLC)));
});

test('verify mode (offline) exits 0 when the pins are current', () => {
  const r = spawnSync(process.execPath, ['scripts/update-adlc-digests.mjs', '--skip-registry'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is current/);
});

test('renderBlock output changes when any digest changes (drift is detectable)', () => {
  const drifted = { ...KNOWN_VENDORED_ADLC, vendoredBundleSha256: '0'.repeat(64) };
  assert.notEqual(renderBlock(drifted), renderBlock(KNOWN_VENDORED_ADLC));
});
