import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { buildRoleSettingsProfile } from '../lib/role-settings.mjs';
import { checkCliSettings } from '../lib/doctor-settings.mjs';
import { sanitizeRedPhaseEnv, verifyRedPhaseTests } from '../lib/tdd-split.mjs';
import { checkEvidence } from '../website/scripts/check-evidence.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

test('website evidence links pass verification', () => {
  const errors = checkEvidence({ repo: REPO });
  assert.deepEqual(errors, []);
});

test('hook-runner + pre-tool-use.bundle.mjs guardrails e2e', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-g-e2e-')));
  try {
    const plugin = join(base, 'plugin');
    mkdirSync(join(plugin, 'bin'), { recursive: true });
    mkdirSync(join(plugin, 'dist', 'hooks'), { recursive: true });
    cpSync(join(REPO, 'bin', 'hook-runner.sh'), join(plugin, 'bin', 'hook-runner.sh'));
    cpSync(join(REPO, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'), join(plugin, 'dist', 'hooks', 'pre-tool-use.bundle.mjs'));
    writeFileSync(
      join(plugin, 'bin', 'node-launcher.sh'),
      `#!/bin/sh\nROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)"\nS="$1"; shift\nexec "${process.execPath}" "$ROOT/$S" "$@"\n`,
      { mode: 0o755 }
    );
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });

    const adlcRepo = join(base, 'adlc-repo');
    mkdirSync(join(adlcRepo, 'lib'), { recursive: true });
    writeFileSync(join(adlcRepo, 'lib', 'lock.mjs'), '// frozen rail\n');
    mkdirSync(join(adlcRepo, '.adlc'), { recursive: true });
    initializeDirectoryStore(join(adlcRepo, '.adlc', 'tickets'));
    writeFileSync(
      join(adlcRepo, '.adlc', 'tickets', ticketFilename('T1')),
      JSON.stringify({ id: 'T1', title: 't', body: 'b', scope: [], rails: ['lib/lock.mjs'], edges: [] })
    );

    function runHook(payload, envExtra = {}, script = 'dist/hooks/pre-tool-use.bundle.mjs') {
      return spawnSync('/bin/sh', ['bin/hook-runner.sh', '--timeout', '9', script], {
        cwd: plugin,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: home, ...envExtra },
      });
    }

    // 1. force_ask on active-rail run_workflow
    const rWf = runHook({ toolCall: { name: 'run_workflow', args: { Script: 'print(1)' } }, workspacePaths: [adlcRepo] });
    assert.equal(rWf.status, 0);
    const outWf = JSON.parse(rWf.stdout.trim());
    assert.equal(outWf.decision, 'force_ask');

    // 2. force_ask on degraded interactive ADLC run_command
    const rDegraded = runHook(
      { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, workspacePaths: [adlcRepo] },
      {},
      'nonexistent-script.mjs'
    );
    assert.equal(rDegraded.status, 0);
    const outDegraded = JSON.parse(rDegraded.stdout.trim());
    assert.equal(outDegraded.decision, 'force_ask');
    assert.match(outDegraded.reason, /Hook runner fail-safe in ADLC repository/);

    // 3. deny in AGB_WORKER_TICKET mode
    const rWorker = runHook(
      { toolCall: { name: 'run_workflow', args: { Script: 'print(1)' } }, workspacePaths: [adlcRepo] },
      { AGB_WORKER_TICKET: 'T1' }
    );
    assert.equal(rWorker.status, 0);
    const outWorker = JSON.parse(rWorker.stdout.trim());
    assert.equal(outWorker.decision, 'deny');

    // 4. empty stdout on 0-arg list_permissions({})
    const rPerms = runHook({ toolCall: { name: 'list_permissions', args: {} }, workspacePaths: [adlcRepo] });
    assert.equal(rPerms.status, 0);
    assert.equal(rPerms.stdout, '');

    // 5. deny on ask_permission targeting unsandboxed
    const rUnsandboxed = runHook({
      toolCall: { name: 'ask_permission', args: { Action: 'unsandboxed', Target: 'npm test' } },
      workspacePaths: [adlcRepo],
    });
    assert.equal(rUnsandboxed.status, 0);
    const outUnsandboxed = JSON.parse(rUnsandboxed.stdout.trim());
    assert.equal(outUnsandboxed.decision, 'deny');

    // 6. deny on ask_permission targeting frozen rails
    const rRail = runHook({
      toolCall: { name: 'ask_permission', args: { Action: 'write_file', Target: join(adlcRepo, 'lib', 'lock.mjs') } },
      workspacePaths: [adlcRepo],
    });
    assert.equal(rRail.status, 0);
    const outRail = JSON.parse(rRail.stdout.trim());
    assert.equal(outRail.decision, 'deny');
    assert.match(outRail.reason, /Target path matches frozen rail: lib\/lock\.mjs/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildRoleSettingsProfile passes checkCliSettings', () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'agb-g-home-')));
  try {
    const cliDir = join(tmpHome, '.gemini', 'antigravity-cli');
    mkdirSync(cliDir, { recursive: true });

    for (const profile of [
      buildRoleSettingsProfile('builder', { rails: ['lib/lock.mjs', 'vendor/cache/**'] }),
      buildRoleSettingsProfile('prosecutor'),
    ]) {
      writeFileSync(join(cliDir, 'settings.json'), JSON.stringify(profile, null, 2));
      const res = checkCliSettings({ home: tmpHome });
      assert.equal(res.level, 'pass');
      assert.equal(res.detail, 'guardrails intact');
      assert.equal(res.fix, null);
    }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('verifyRedPhaseTests with AGB_SANDBOX_GATES: 0 verifies secrets, mutation, and TAP', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agb-g-tdd-')));
  try {
    mkdirSync(join(dir, 'test'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });

    // 1. Secret stripping
    const dirtyEnv = { ...process.env, AGB_SANDBOX_GATES: '0', AGB_SECRET_KEY: 'secret123', API_TOKEN: 'token456' };
    const sanitized = sanitizeRedPhaseEnv(dirtyEnv, 'linux');
    assert.equal(sanitized.AGB_SECRET_KEY, undefined);
    assert.equal(sanitized.API_TOKEN, undefined);
    assert.equal(sanitized.NODE_ENV, 'test');

    // 2. TAP verification: valid failing TAP test passes verification
    const redFile = 'test/red.test.mjs';
    writeFileSync(
      join(dir, redFile),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red test", () => { assert.equal(1, 2); });\n'
    );
    const redRes = verifyRedPhaseTests([redFile], { worktree: dir, env: dirtyEnv });
    assert.equal(redRes.ok, true);
    assert.deepEqual(redRes.verifiedFiles, [redFile]);

    // Non-TAP result via spawnFn seam is rejected
    const nonTapRes = verifyRedPhaseTests([redFile], {
      worktree: dir,
      env: dirtyEnv,
      spawnFn: (cmd, args) => (args[0] === '--check' ? { status: 0 } : { status: 1, stdout: 'plain text error\n', stderr: '' }),
    });
    assert.equal(nonTapRes.ok, false);
    assert.match(nonTapRes.reason, /no failing TAP result/);

    // Tautological passing test is rejected
    const greenFile = 'test/green.test.mjs';
    writeFileSync(
      join(dir, greenFile),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("green test", () => { assert.equal(1, 1); });\n'
    );
    const greenRes = verifyRedPhaseTests([greenFile], { worktree: dir, env: dirtyEnv });
    assert.equal(greenRes.ok, false);
    assert.match(greenRes.reason, /tautological spec tests/);

    // 3. Worktree mutation rejection
    const mutateFile = 'test/mutate.test.mjs';
    writeFileSync(
      join(dir, mutateFile),
      `import { test } from "node:test";\nimport fs from "node:fs";\nimport assert from "node:assert/strict";\ntest("mutating", () => {\n  fs.writeFileSync("${join(dir, 'mutated.txt')}", "mutated");\n  assert.fail("red failure");\n});\n`
    );
    const mutRes = verifyRedPhaseTests([mutateFile], { worktree: dir, env: dirtyEnv });
    assert.equal(mutRes.ok, false);
    assert.match(mutRes.reason, /mutated worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
