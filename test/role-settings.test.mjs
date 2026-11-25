import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_RULE_RE,
  READONLY_ROLES,
  isValidPermissionRule,
  compileRailsToDenyRules,
  buildRoleSettingsProfile,
} from '../lib/role-settings.mjs';

test('isValidPermissionRule accepts every supported action', () => {
  for (const r of [
    'command(ls)', 'read_file(a)', 'write_file(.git/)', 'read_url(*)', 'execute_url(*)',
    'download_url(https://x.dev/a)', 'unsandboxed(npm test)', 'mcp(agb/*)',
  ]) {
    assert.equal(isValidPermissionRule(r), true, r);
    assert.ok(PERMISSION_RULE_RE.test(r), r);
  }
});

test('isValidPermissionRule enforces the 1024-char boundary', () => {
  const pad = 1024 - 'command()'.length;
  const ok = `command(${'a'.repeat(pad)})`;
  assert.equal(ok.length, 1024);
  assert.equal(isValidPermissionRule(ok), true);
  assert.equal(isValidPermissionRule(`command(${'a'.repeat(pad + 1)})`), false);
});

test('isValidPermissionRule rejects malformed rules', () => {
  for (const r of [
    ' command(ls)', 'command(ls) ', 'command(ls\n)', 'command(ls)\n', 'command(l\0s)',
    'command(l\rs)', 'command', 'write_file', 'command()', 'bogus(x)', '', null, undefined, 42, {},
  ]) {
    assert.equal(isValidPermissionRule(r), false, JSON.stringify(r));
  }
});

test('compileRailsToDenyRules compiles directory and file rails', () => {
  assert.deepEqual(compileRailsToDenyRules(['vendor/cache/**']), ['write_file(vendor/cache/)']);
  assert.deepEqual(compileRailsToDenyRules(['vendor/cache/*']), ['write_file(vendor/cache/)']);
  assert.deepEqual(compileRailsToDenyRules(['lib/lock.mjs']), ['write_file(lib/lock.mjs)']);
  assert.deepEqual(compileRailsToDenyRules(['./lib\\gates.mjs']), ['write_file(lib/gates.mjs)']);
});

test('compileRailsToDenyRules deduplicates and tolerates bad input', () => {
  assert.deepEqual(
    compileRailsToDenyRules(['a/**', './a/*', 'a/', 'b.txt', 'b.txt']),
    ['write_file(a/)', 'write_file(b.txt)'],
  );
  assert.deepEqual(compileRailsToDenyRules(), []);
  assert.deepEqual(compileRailsToDenyRules('nope'), []);
  assert.deepEqual(compileRailsToDenyRules([1, null, {}]), []);
});

for (const bad of ['', '\n', 'a\0b', '../x', 'a/../x', '/abs', '~/x', 'a(b)', 'a)b', '**/*.snap', 'a/*/b', 'x?.js', '/**', './']) {
  test(`compileRailsToDenyRules skips ${JSON.stringify(bad)}`, () => {
    assert.deepEqual(compileRailsToDenyRules([bad]), []);
  });
}

test('readonly roles unconditionally deny mcp(*)', () => {
  const expected = ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
  for (const role of READONLY_ROLES) {
    for (const hasCodegraph of [false, true]) {
      const p = buildRoleSettingsProfile(role, { hasCodegraph, rails: ['lib/lock.mjs'] });
      assert.deepEqual(p, { allowNonWorkspaceAccess: false, permissions: { deny: expected } }, role);
    }
  }
});

test('builder profile denies rails, destructive commands, and mcp(*) by default', () => {
  const p = buildRoleSettingsProfile('builder', { rails: ['lib/lock.mjs', 'vendor/cache/**', '**/*.snap'] });
  assert.deepEqual(p, {
    allowNonWorkspaceAccess: false,
    permissions: {
      deny: [
        'write_file(.git/)', 'write_file(.adlc/)', 'write_file(.booster/)',
        'write_file(lib/lock.mjs)', 'write_file(vendor/cache/)',
        'command(sudo)', 'command(rm -rf)', 'command(git push)',
        'read_url(*)', 'execute_url(*)', 'mcp(*)',
      ],
    },
  });
  assert.deepEqual(buildRoleSettingsProfile(), buildRoleSettingsProfile('builder', {}));
});

test('builder with codegraph allows only agb mcp servers', () => {
  const { permissions } = buildRoleSettingsProfile('builder', { hasCodegraph: true });
  assert.ok(permissions.deny.includes('mcp(agb/*)'));
  assert.ok(permissions.deny.includes('mcp(antigravity-booster_agb/*)'));
  assert.ok(!permissions.deny.includes('mcp(*)'));
});

test('builder dedupes rails that duplicate base rules', () => {
  const { permissions } = buildRoleSettingsProfile('builder', { rails: ['.git/**', '.adlc/'] });
  assert.equal(permissions.deny.filter((r) => r === 'write_file(.git/)').length, 1);
  assert.equal(permissions.deny.filter((r) => r === 'write_file(.adlc/)').length, 1);
});

test('extraSettings deep-merges permissions without clobbering deny', () => {
  const p = buildRoleSettingsProfile('builder', {
    extraSettings: {
      model: 'x',
      allowNonWorkspaceAccess: true,
      permissions: {
        allow: ['command(npm test)', 'not a rule'],
        ask: ['command(git commit)'],
        deny: ['command(curl)', 'command(sudo)'],
      },
    },
  });
  assert.equal(p.model, 'x');
  assert.equal(p.allowNonWorkspaceAccess, false);
  assert.deepEqual(p.permissions.allow, ['command(npm test)']);
  assert.deepEqual(p.permissions.ask, ['command(git commit)']);
  assert.ok(p.permissions.deny.includes('write_file(.git/)'));
  assert.ok(p.permissions.deny.includes('command(curl)'));
  assert.equal(p.permissions.deny.filter((r) => r === 'command(sudo)').length, 1);
  assert.equal('enableTerminalSandbox' in p, false);
  assert.equal('toolPermission' in p, false);
  assert.equal('agentMode' in p, false);
});

test('extraSettings tolerates null and malformed permissions', () => {
  const base = buildRoleSettingsProfile('builder');
  assert.deepEqual(buildRoleSettingsProfile('builder', { extraSettings: null }), base);
  assert.deepEqual(buildRoleSettingsProfile('builder', { extraSettings: { permissions: 'x' } }), base);
  assert.deepEqual(buildRoleSettingsProfile('builder', { extraSettings: { permissions: { deny: 'x' } } }), base);
});
