// Pure, zero-dependency compiler for per-role agy `--settings` profiles.
// Emits `action(target)` permission rules (settings.json grammar).

export const PERMISSION_RULE_RE = /^(command|read_file|write_file|read_url|execute_url|download_url|mcp|unsandboxed)\(.+\)$/;

const MAX_RULE_LENGTH = 1024;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const WILDCARD_RE = /[*?[\]{}]/;

export const READONLY_ROLES = Object.freeze([
  'prosecutor', 'review', 'review-plan', 'coldstart', 'parallax',
  'premortem', 'brain', 'arbiter', 'readonly',
]);

export function isValidPermissionRule(rule) {
  return typeof rule === 'string'
    && rule.length <= MAX_RULE_LENGTH
    && !/[\r\n\0]/.test(rule)
    && rule.trim() === rule
    && PERMISSION_RULE_RE.test(rule);
}

const dedupe = (items) => [...new Set(items)];

export function compileRailsToDenyRules(rails = []) {
  const out = [];
  for (const rail of Array.isArray(rails) ? rails : []) {
    if (typeof rail !== 'string') continue;
    let s = rail.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!s) continue;
    if (CONTROL_RE.test(s)) continue;
    if (s.split('/').includes('..')) continue;
    if (s.startsWith('/')) continue;
    if (s.startsWith('~')) continue;
    if (s.includes('(') || s.includes(')')) continue;
    const dir = /^(.*)\/\*\*?$/.exec(s);
    if (dir && dir[1] && !WILDCARD_RE.test(dir[1])) s = `${dir[1]}/`;
    if (WILDCARD_RE.test(s)) continue;
    const rule = `write_file(${s})`;
    if (isValidPermissionRule(rule)) out.push(rule);
  }
  return dedupe(out);
}

function mergeRules(base, extra) {
  const valid = Array.isArray(extra) ? extra.filter(isValidPermissionRule) : [];
  return dedupe([...base, ...valid]);
}

export function buildRoleSettingsProfile(role = 'builder', { hasCodegraph = false, rails = [], extraSettings = {} } = {}) {
  const normalizedRole = String(role || 'builder').trim().toLowerCase();
  let deny;
  if (READONLY_ROLES.includes(normalizedRole)) {
    deny = ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
  } else {
    deny = [
      'write_file(.git/)',
      'write_file(.adlc/)',
      'write_file(.booster/)',
      ...compileRailsToDenyRules(rails),
      'command(sudo)',
      'command(rm -rf)',
      'command(git push)',
      'read_url(*)',
      'execute_url(*)',
      ...(hasCodegraph ? ['mcp(agb/*)', 'mcp(antigravity-booster_agb/*)'] : ['mcp(*)']),
    ];
  }
  const { permissions: extraPerms, ...otherExtra } = extraSettings ?? {};
  const perms = extraPerms && typeof extraPerms === 'object' ? extraPerms : {};
  const permissions = { deny: mergeRules(deny, perms.deny) };
  for (const key of ['allow', 'ask']) {
    const merged = mergeRules([], perms[key]);
    if (merged.length) permissions[key] = merged;
  }
  return { ...otherExtra, allowNonWorkspaceAccess: false, permissions };
}
