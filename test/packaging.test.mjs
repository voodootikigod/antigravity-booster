// npm pack must ship every native-plugin asset (spec §6 AC2, Appendix A D9/P1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('npm pack --dry-run includes every plugin component and runtime asset', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const files = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path));
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
