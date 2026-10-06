// End-to-end: bin/hook-runner.sh -> hooks/pre-tool-use.mjs, exactly as
// hooks.json invokes it (cwd = plugin root). The real node-launcher.sh only
// trusts fixed Node install prefixes (it is covered by node-launcher.test.mjs),
// so the fake plugin root uses a launcher shim that execs this test's Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-e2e-')));
const plugin = join(base, 'plugin');
const home = join(base, 'home');
const repo = join(base, 'repo');
test.after(() => rmSync(base, { recursive: true, force: true }));

mkdirSync(join(plugin, 'bin'), { recursive: true });
cpSync(join(REPO, 'bin', 'hook-runner.sh'), join(plugin, 'bin', 'hook-runner.sh'));
cpSync(join(REPO, 'hooks'), join(plugin, 'hooks'), { recursive: true });
cpSync(join(REPO, 'lib', 'active-rails.mjs'), join(plugin, 'lib', 'active-rails.mjs'));
// Unbundled sources resolve @adlc/tickets and minimatch via node_modules (ESM ignores NODE_PATH).
symlinkSync(join(REPO, 'node_modules'), join(plugin, 'node_modules'), 'dir');
writeFileSync(
  join(plugin, 'bin', 'node-launcher.sh'),
  `#!/bin/sh\nROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)"\nS="$1"; shift\nexec "${process.execPath}" "$ROOT/$S" "$@"\n`,
);
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, 'lib'), { recursive: true });
mkdirSync(join(repo, '.adlc'), { recursive: true });
initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
writeFileSync(
  join(repo, '.adlc', 'tickets', ticketFilename('T1')),
  JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['lib/lock.mjs'], edges: [] }),
);

function hook(toolName, args) {
  const payload = { toolCall: { name: toolName, args }, workspacePaths: [repo] };
  return spawnSync('/bin/sh', ['bin/hook-runner.sh', '--timeout', '9', 'hooks/pre-tool-use.mjs'], {
    cwd: plugin,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home },
    timeout: 15000,
  });
}

test('e2e: rail mutation is denied with the exact doctor-checked reason', () => {
  const r = hook('write_to_file', { TargetFile: join(repo, 'lib', 'lock.mjs') });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /Target path matches frozen rail: lib\/lock\.mjs/);
});

test('e2e: non-rail edit passes through with empty stdout', () => {
  const r = hook('write_to_file', { TargetFile: join(repo, 'lib', 'foo.mjs') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('e2e: shell ask decisions are forwarded by the runner', () => {
  const r = hook('run_command', { CommandLine: 'npm test', Cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.decision, 'ask');
  // Must be the dispatcher's verdict, not the runner's fail-safe (which is also 'ask').
  assert.match(out.reason, /active-rail ADLC repository requires operator confirmation/);
  assert.doesNotMatch(out.reason, /fail-safe/);
});
