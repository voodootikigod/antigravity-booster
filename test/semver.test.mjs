import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, compare, lt, gt, eq, gte } from '../lib/semver.mjs';

test('parse: valid versions', () => {
  assert.deepEqual(parse('1.7.0'), { major: 1, minor: 7, patch: 0, prerelease: [] });
  assert.deepEqual(parse('0.0.0'), { major: 0, minor: 0, patch: 0, prerelease: [] });
  assert.deepEqual(parse('1.0.0-alpha.1'), { major: 1, minor: 0, patch: 0, prerelease: ['alpha', '1'] });
  assert.deepEqual(parse('1.0.0-0.3.7'), { major: 1, minor: 0, patch: 0, prerelease: ['0', '3', '7'] });
  assert.deepEqual(parse('1.0.0-x-y.0A'), { major: 1, minor: 0, patch: 0, prerelease: ['x-y', '0A'] });
});

test('parse: build metadata is accepted and ignored', () => {
  assert.deepEqual(parse('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parse('1.2.3-rc.1+sha.abc'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] });
  assert.equal(compare('1.2.3+a', '1.2.3+b'), 0);
});

test('parse: rejects invalid input', () => {
  for (const bad of ['1.7', 'v1.7.0', '01.7.0', '1.07.0', '1.7.00', '', ' 1.7.0', '1.7.0 ', '1.7.0.1',
    '1.0.0-', '1.0.0-01', '1.0.0-a..b', '1.0.0-a.', '1.0.0+', '1.0.0+a..b', '1.0.0-a_b', '-1.0.0', 'x.y.z',
    null, undefined, 1, 1.7, {}, [], ['1.7.0'], true]) {
    assert.equal(parse(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('compare: semver.org precedence chain', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2',
    '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < chain.length; i++) {
    for (let j = 0; j < chain.length; j++) {
      assert.equal(compare(chain[i], chain[j]), Math.sign(i - j), `${chain[i]} vs ${chain[j]}`);
    }
  }
});

test('compare: numeric ordering is not lexical', () => {
  const chain = ['1.6.0', '1.7.0', '1.7.1', '1.10.0', '2.0.0'];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.equal(compare(chain[i], chain[i + 1]), -1);
    assert.equal(compare(chain[i + 1], chain[i]), 1);
  }
  assert.equal(compare('1.7.0', '1.7.0'), 0);
  assert.equal(compare('1.0.0-1', '1.0.0-alpha'), -1); // numeric < alphanumeric
});

test('compare: large numeric identifiers', () => {
  assert.equal(compare('1.0.0-99999999999999999999', '1.0.0-100000000000000000000'), -1);
});

test('lt/gt/eq/gte', () => {
  assert.equal(lt('1.6.0', '1.7.0'), true);
  assert.equal(lt('1.7.0', '1.7.0'), false);
  assert.equal(gt('1.10.0', '1.7.1'), true);
  assert.equal(gt('1.7.0', '1.7.0'), false);
  assert.equal(eq('1.7.0', '1.7.0+x'), true);
  assert.equal(eq('1.7.0', '1.7.1'), false);
  assert.equal(gte('1.7.0', '1.7.0'), true);
  assert.equal(gte('1.7.1', '1.7.0'), true);
  assert.equal(gte('1.6.9', '1.7.0'), false);
});

test('comparators throw TypeError on unparseable input', () => {
  for (const fn of [compare, lt, gt, eq, gte]) {
    assert.throws(() => fn('1.7', '1.7.0'), TypeError);
    assert.throws(() => fn('1.7.0', 'v1.7.0'), TypeError);
    assert.throws(() => fn(undefined, '1.7.0'), TypeError);
    assert.throws(() => fn('1.7.0', 5), TypeError);
  }
});

test('build metadata may start with 0 and is ignored for precedence', async () => {
  const { parse, eq } = await import('../lib/semver.mjs');
  assert.notEqual(parse('1.7.0+001'), null);
  assert.equal(eq('1.7.0+001', '1.7.0'), true);
});
