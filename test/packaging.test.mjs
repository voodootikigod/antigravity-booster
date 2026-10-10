// npm pack must ship every native-plugin asset (spec §6 AC2, Appendix A D9/P1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let packed;
function packedFiles() {
  if (!packed) {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    packed = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path));
  }
  return packed;
}

test('npm pack --dry-run includes every plugin component and runtime asset', () => {
  const files = packedFiles();
  const has = (prefix) => [...files].some((p) => p === prefix || p.startsWith(prefix));
  for (const exact of ['plugin.json', 'hooks.json', 'mcp_config.json', 'package.json',
    'dist/agb.mjs', 'dist/mcp-server.mjs', 'dist/hooks/pre-tool-use.bundle.mjs',
    'bin/node-launcher.sh', 'bin/hook-runner.sh', 'vendor/cache/adlc-antigravity-1.7.0.tgz',
    'lib/job-object-wrapper.ps1', 'lib/sandbox-probe-helper.mjs']) {
    assert.ok(files.has(exact), `missing ${exact}`);
  }
  for (const dir of ['commands/', 'agents/', 'hooks/', 'mcp/', 'skills/', 'sidecars/', 'docs/calibration/', 'templates/']) {
    assert.ok(has(dir), `missing ${dir}`);
  }
  for (const excluded of ['test/', '.adlc/', '.agents/', 'node_modules/']) {
    assert.equal(has(excluded), false, `${excluded} must not ship`);
  }
});

// Docs site isolation (.adlc/specs/docs-site.md §8 packaging guard, AC2).
test('npm pack --dry-run ships no website/ files and no docs/ outside docs/calibration/', () => {
  const files = [...packedFiles()];
  assert.deepEqual(files.filter((p) => p.startsWith('website/')), [], 'website/ must not ship');
  assert.deepEqual(files.filter((p) => p.startsWith('docs/') && !p.startsWith('docs/calibration/')), [], 'only docs/calibration/ may ship under docs/');
});
