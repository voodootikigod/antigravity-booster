import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlan, warmRegenPrompt } from '../lib/scheduler.mjs';

process.env.AGB_QUOTA_STATE = join(tmpdir(), 'agb_pools_warm_resume_test.json');

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-warm-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return dir;
}

function withEnv(env, fn) {
  const mergedEnv = { AGB_ALLOW_CUSTOM_ADLC_CLI: '1', ...env };
  const saved = {};
  for (const [k, v] of Object.entries(mergedEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

const quiet = { log: () => {} };

test('warmRegenPrompt: renders structured warm resumption prompt with context and constraints', () => {
  const ticket = {
    id: 'T1',
    title: 'Warm resume feature',
    scope: ['src/core.mjs', 'src/util.mjs'],
    rails: ['lib/lock.mjs', 'lib/gates.mjs'],
  };
  const failure = 'AssertionError: expected true but got false at test/core.test.mjs:42';

  const prompt = warmRegenPrompt(ticket, failure);
  assert.ok(typeof prompt === 'string');
  assert.match(prompt, /Strike 1 for ticket T1 \(Warm resume feature\) failed verification/);
  assert.match(prompt, /worktree has been reset to base HEAD/);
  assert.match(prompt, /AssertionError: expected true but got false at test\/core\.test\.mjs:42/);
  assert.match(prompt, /src\/core\.mjs, src\/util\.mjs/);
  assert.match(prompt, /lib\/lock\.mjs, lib\/gates\.mjs/);
  assert.match(prompt, /TICKET-DONE or TICKET-BLOCKED: <reason>/);
});

test('runPlan: Strike 2 warm-resumes with --conversation when Strike 1 fails and succeeds', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-warm-state-'));
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_BUILDER_MODE: 'transient-then-good',
        FAKE_CONVERSATION_ID: 'fake-conv-123',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );

    assert.deepEqual(report.merged, ['T1']);
    assert.equal(report.failed.T1, undefined);

    const builds = readFileSync(join(state, 'builds'), 'utf8').trim();
    assert.equal(builds, '2', 'both strike 1 and strike 2 ran');

    const invocations = readFileSync(join(state, 'agy-argv-seen'), 'utf8')
      .split(/^(?=--print )/m)
      .filter((l) => l.startsWith('--print '));

    // Filter builder invocations (they contain the ticket id in prompt)
    const builderInvocations = invocations.filter((l) => l.includes('T1'));
    assert.ok(builderInvocations.length >= 2, `expected at least 2 builder invocations, got ${builderInvocations.length}`);

    // Strike 1 should NOT have --conversation
    assert.doesNotMatch(builderInvocations[0], /--conversation/);

    // Strike 2 should have --conversation fake-conv-123
    assert.match(builderInvocations[1], /--conversation fake-conv-123/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('runPlan: AGB_WARM_STRIKES=0 disables warm resume on Strike 2', async () => {
  const repo = makeRepo();
  const state = mkdtempSync(join(tmpdir(), 'agb-warm-state-'));
  try {
    const report = await withEnv(
      {
        AGB_AGY_BIN: FAKE_AGY,
        AGB_ADLC_BIN: FAKE_ADLC,
        FAKE_BUILDER_MODE: 'transient-then-good',
        FAKE_CONVERSATION_ID: 'fake-conv-123',
        FAKE_STATE_DIR: state,
        AGB_SANDBOX_GATES: '0',
        AGB_WARM_STRIKES: '0',
      },
      () => runPlan({
        repo,
        gate: { test: 'true' },
        tickets: [{ id: 'T1', title: 'one', body: 'x', scope: ['T1.txt'] }],
      }, quiet)
    );

    assert.deepEqual(report.merged, ['T1']);
    assert.equal(report.failed.T1, undefined);

    const builds = readFileSync(join(state, 'builds'), 'utf8').trim();
    assert.equal(builds, '2');

    const invocations = readFileSync(join(state, 'agy-argv-seen'), 'utf8')
      .split(/^(?=--print )/m)
      .filter((l) => l.startsWith('--print '));

    const builderInvocations = invocations.filter((l) => l.includes('T1'));
    assert.ok(builderInvocations.length >= 2);

    // Neither strike should have --conversation
    assert.doesNotMatch(builderInvocations[0], /--conversation/);
    assert.doesNotMatch(builderInvocations[1], /--conversation/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
