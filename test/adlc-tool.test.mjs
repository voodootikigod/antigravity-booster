import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAdlcTool } from '../lib/adlc-tool.mjs';
import { runHollowTest } from '../lib/prosecute.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function withFakeAdlc(scriptBody, fn) {
  const tmpDir = mkdtempSync(join(REPO_ROOT, '.adlc', 'tmp-adlc-tool-test-'));
  const pkgJsonPath = join(tmpDir, 'package.json');
  writeFileSync(pkgJsonPath, JSON.stringify({
    name: '@adlc/cli',
    version: '1.11.1',
    bin: { adlc: './fake.sh' },
  }));

  const fakeScript = join(tmpDir, 'fake.sh');
  writeFileSync(fakeScript, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });

  const prevCustom = process.env.AGB_ALLOW_CUSTOM_ADLC_CLI;
  const prevBin = process.env.AGB_ADLC_BIN;
  process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = '1';
  process.env.AGB_ADLC_BIN = fakeScript;

  return Promise.resolve()
    .then(() => fn({ adlcBin: fakeScript, tmpDir }))
    .finally(() => {
      if (prevCustom === undefined) delete process.env.AGB_ALLOW_CUSTOM_ADLC_CLI;
      else process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = prevCustom;
      if (prevBin === undefined) delete process.env.AGB_ADLC_BIN;
      else process.env.AGB_ADLC_BIN = prevBin;
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
}

test('runAdlcTool: exit 0 valid JSON returns ok: true, exitCode: 0, parsed, stdout', async () => {
  await withFakeAdlc(`
    console.log(JSON.stringify({ verdict: 'ship', findings: [] }));
    process.exit(0);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'my-tool',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(res.parsed, { verdict: 'ship', findings: [] });
    assert.match(res.stdout, /"verdict":"ship"/);
  });
});

test('runAdlcTool: exit 2 gate-fail with valid JSON on err.stdout recovers parsed payload', async () => {
  await withFakeAdlc(`
    console.log(JSON.stringify({ verdict: 'flail', signals: [{ type: 'repeated-error' }] }));
    process.exit(2);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'flail-detector',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 2);
    assert.deepEqual(res.parsed, { verdict: 'flail', signals: [{ type: 'repeated-error' }] });
    assert.match(res.stdout, /"verdict":"flail"/);
  });
});

test('runAdlcTool: non-zero exit with arbitrary exitCode and valid JSON on err.stdout preserves exitCode', async () => {
  await withFakeAdlc(`
    console.log(JSON.stringify({ code: 'custom' }));
    process.exit(5);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'custom-tool',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 5);
    assert.deepEqual(res.parsed, { code: 'custom' });
  });
});

test('runAdlcTool: exit 1 operational error with no stdout returns ok: false, unparseable: false', async () => {
  await withFakeAdlc(`
    console.error('fatal error: cannot connect to backend');
    process.exit(1);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'flail-detector',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.unparseable, false);
    assert.equal(res.stdout, '');
    assert.match(res.error, /Command failed/);
  });
});

test('runAdlcTool: exit 0 with malformed JSON returns ok: false, exitCode: 0, unparseable: true', async () => {
  await withFakeAdlc(`
    console.log('not valid json {broken');
    process.exit(0);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'model-router',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 0);
    assert.equal(res.unparseable, true);
    assert.equal(res.stdout, 'not valid json {broken\n');
    assert.match(res.error, /^unparseable model-router output: /);
  });
});

test('runAdlcTool: exit 0 with empty stdout returns ok: false, exitCode: 0, unparseable: true', async () => {
  await withFakeAdlc(`
    // empty output
    process.exit(0);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'empty-tool',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 0);
    assert.equal(res.unparseable, true);
    assert.equal(res.stdout, '');
    assert.match(res.error, /^unparseable empty-tool output: /);
  });
});

test('runAdlcTool: exit 2 with malformed JSON on err.stdout returns ok: false, exitCode: 2, unparseable: true', async () => {
  await withFakeAdlc(`
    console.log('malformed gate-failure stdout');
    process.exit(2);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'consensus-fix',
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 2);
    assert.equal(res.unparseable, true);
    assert.equal(res.stdout, 'malformed gate-failure stdout\n');
    assert.match(res.error, /Command failed/);
  });
});

test('runAdlcTool: missing binary / ENOENT degradation returns ok: false', async () => {
  const res = await runAdlcTool({
    tool: 'model-router',
    adlcBin: '/nonexistent/fake-adlc-bin',
    cwd: REPO_ROOT,
  });
  assert.equal(res.ok, false);
  assert.equal(res.unparseable, false);
  assert.equal(res.stdout, '');
  assert.ok(res.error);
});

test('runAdlcTool: passes args (automatically appending --json without duplicating), cwd, and repo to the child process', async () => {
  await withFakeAdlc(`
    const args = process.argv.slice(2);
    console.log(JSON.stringify({ cwd: process.cwd(), args }));
    process.exit(0);
  `, async ({ adlcBin, tmpDir }) => {
    const res = await runAdlcTool({
      tool: 'test-tool',
      args: ['--first', '1', '--second'],
      cwd: tmpDir,
      repo: REPO_ROOT,
      adlcBin,
    });
    assert.equal(res.ok, true);
    assert.equal(res.parsed.cwd, tmpDir);
    assert.deepEqual(res.parsed.args, ['test-tool', '--first', '1', '--second', '--json']);

    const res2 = await runAdlcTool({
      tool: 'test-tool',
      args: ['--first', '1', '--json', '--second'],
      cwd: tmpDir,
      repo: REPO_ROOT,
      adlcBin,
    });
    assert.equal(res2.ok, true);
    assert.deepEqual(res2.parsed.args, ['test-tool', '--first', '1', '--json', '--second']);
  });
});

test('runAdlcTool: handles timeoutMs constraint without throwing', async () => {
  await withFakeAdlc(`
    setTimeout(() => {
      console.log('{"done":true}');
    }, 5000);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'slow-tool',
      timeoutMs: 100,
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });
});

test('runAdlcTool: handles maxBuffer constraint without throwing', async () => {
  await withFakeAdlc(`
    console.log('x'.repeat(1024 * 1024));
    process.exit(0);
  `, async ({ adlcBin }) => {
    const res = await runAdlcTool({
      tool: 'huge-tool',
      maxBuffer: 512,
      adlcBin,
      cwd: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });
});

test('runAdlcTool: calling without arguments defaults safely without throwing', async () => {
  const res = await runAdlcTool();
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('runHollowTest: forwards --test-cmd, --base, and --json to adlc hollow-test', async () => {
  await withFakeAdlc(`
    const args = process.argv.slice(2);
    if (
      args[0] !== 'hollow-test' ||
      args[1] !== '--test-cmd' ||
      args[2] !== 'npm test' ||
      args[3] !== '--base' ||
      args[4] !== 'origin/custom-base' ||
      args[5] !== '--json'
    ) {
      console.error('unexpected args: ' + JSON.stringify(args));
      process.exit(1);
    }
    console.log(JSON.stringify({ summary: { total: 3, killed: 3 }, mutants: [] }));
    process.exit(0);
  `, async ({ adlcBin }) => {
    const res = await runHollowTest({
      worktree: REPO_ROOT,
      testCmd: 'npm test',
      base: 'origin/custom-base',
      adlcBin,
    });
    assert.equal(res.ok, true);
    assert.equal(res.total, 3);
    assert.equal(res.killed, 3);
    assert.equal(res.survived, 0);
  });
});
