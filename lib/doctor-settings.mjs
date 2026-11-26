import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidPermissionRule } from './role-settings.mjs';

export function stripJsonc(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      i--;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function checkCliSettings({ home, env = process.env } = {}) {
  const name = 'CLI settings';
  const resolvedHome = home || env.HOME || homedir();
  const settingsPath = join(resolvedHome, '.gemini', 'antigravity-cli', 'settings.json');

  let st;
  let raw;
  try {
    st = lstatSync(settingsPath);
    if (st.isSymbolicLink()) {
      return { name, level: 'warn', detail: 'settings.json is a symbolic link', fix: 'Replace symbolic link with a regular file.' };
    }
    if (!st.isFile()) {
      return { name, level: 'warn', detail: 'settings.json is not a regular file', fix: 'Ensure settings.json is a regular file.' };
    }
    if (st.size > 1024 * 1024) {
      return { name, level: 'warn', detail: 'settings.json exceeds 1MB limit', fix: 'Reduce settings.json size below 1MB.' };
    }
    raw = readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { name, level: 'pass', detail: 'defaults (no settings.json)', fix: null };
    }
    return { name, level: 'warn', detail: `unreadable settings: ${err.message}`, fix: 'Inspect permissions and path to ~/.gemini/antigravity-cli/settings.json.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch (err) {
    return { name, level: 'warn', detail: `invalid JSON: ${err.message}`, fix: 'Fix JSON syntax in ~/.gemini/antigravity-cli/settings.json.' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { name, level: 'warn', detail: 'settings must be a JSON object', fix: 'Ensure settings.json contains a JSON object.' };
  }

  if (parsed.toolPermission === 'always-proceed') {
    return { name, level: 'warn', detail: "toolPermission is 'always-proceed' (unsafe)", fix: 'Remove or change toolPermission in ~/.gemini/antigravity-cli/settings.json.' };
  }

  if (parsed.allowNonWorkspaceAccess === true) {
    return { name, level: 'warn', detail: 'allowNonWorkspaceAccess is enabled (unsafe)', fix: 'Set allowNonWorkspaceAccess to false in ~/.gemini/antigravity-cli/settings.json.' };
  }

  if (parsed.permissions !== undefined) {
    if (typeof parsed.permissions !== 'object' || parsed.permissions === null || Array.isArray(parsed.permissions)) {
      return { name, level: 'warn', detail: 'permissions must be an object', fix: 'Ensure permissions is an object in ~/.gemini/antigravity-cli/settings.json.' };
    }
    for (const key of ['allow', 'ask', 'deny']) {
      if (parsed.permissions[key] !== undefined) {
        if (!Array.isArray(parsed.permissions[key])) {
          return { name, level: 'warn', detail: `permissions.${key} must be an array`, fix: `Ensure permissions.${key} is an array in ~/.gemini/antigravity-cli/settings.json.` };
        }
        for (const rule of parsed.permissions[key]) {
          if (!isValidPermissionRule(rule)) {
            return { name, level: 'warn', detail: `invalid permission rule in permissions.${key}: ${rule}`, fix: 'Ensure all permission rules match action(target) grammar in ~/.gemini/antigravity-cli/settings.json.' };
          }
        }
      }
    }
  }

  return { name, level: 'pass', detail: 'guardrails intact', fix: null };
}
