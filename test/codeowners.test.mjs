// CODEOWNERS must cover every plugin execution/trust asset (spec AC10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REQUIRED = [
  '.github/workflows/**', 'bin/**', 'hooks/**', 'hooks.json', 'mcp_config.json',
  'commands/**', 'agents/**', 'plugin.json', 'dist/**', 'vendor/**', '.adlc/**',
  'lib/adlc-bridge.mjs', 'lib/run-integrity.mjs', 'scripts/update-adlc-digests.mjs',
];

function parseCodeowners(text) {
  const rules = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.set(pattern.replace(/^\//, ''), owners);
  }
  return rules;
}

test('CODEOWNERS assigns every plugin execution and trust asset to the owner', () => {
  const rules = parseCodeowners(readFileSync(new URL('../CODEOWNERS', import.meta.url), 'utf8'));
  for (const pattern of REQUIRED) {
    assert.ok(rules.has(pattern), `missing CODEOWNERS rule: ${pattern}`);
    assert.deepEqual(rules.get(pattern), ['@voodootikigod'], `wrong owner for ${pattern}`);
  }
});
