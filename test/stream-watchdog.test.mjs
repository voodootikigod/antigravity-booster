import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamWatchdog, resolveDynamicEffort } from '../lib/stream-watchdog.mjs';

test('StreamWatchdog emits steer on second PreToolUse rail denial and abort on third', () => {
  const wd = new StreamWatchdog({
    ticket: { scope: ['lib/foo.mjs'], rails: ['lib/lock.mjs'] },
    maxRailBounces: 2,
  });

  const s1 = wd.observeStep({
    step_type: 'tool',
    tool_name: 'edit_file',
    state: 'ERROR',
    error: 'tool call denied by pre-tool hook: Target path matches frozen rail: lib/lock.mjs',
  });
  assert.equal(s1.action, 'continue');

  const s2 = wd.observeStep({
    step_type: 'tool',
    tool_name: 'edit_file',
    state: 'ERROR',
    error: 'tool call denied by pre-tool hook: Target path matches frozen rail: lib/lock.mjs',
  });
  assert.equal(s2.action, 'steer');
  assert.match(s2.steeringPrompt, /lib\/foo\.mjs/);
  assert.match(s2.steeringPrompt, /lib\/lock\.mjs/);

  const s3 = wd.observeStep({
    step_type: 'tool',
    tool_name: 'edit_file',
    state: 'ERROR',
    error: 'tool call denied by pre-tool hook: Target path matches frozen rail: lib/lock.mjs',
  });
  assert.equal(s3.action, 'abort');
  assert.match(s3.reason, /rail-bounce threshold exceeded/);
});

test('StreamWatchdog aborts on 3 consecutive identical tool failures and resets counter on success', () => {
  const wd = new StreamWatchdog({ maxIdenticalFailures: 3 });
  const failStep = {
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { CommandLine: 'npm test', exit_code: 1, stderr: 'AssertionError: 1 !== 2' },
    state: 'ERROR',
  };

  assert.equal(wd.observeStep(failStep).action, 'continue');
  assert.equal(wd.observeStep(failStep).action, 'continue');

  // A successful tool call resets consecutive failure count
  assert.equal(
    wd.observeStep({
      step_type: 'tool',
      tool_name: 'edit_file',
      state: 'DONE',
    }).action,
    'continue'
  );
  assert.equal(wd.consecutiveFailureCount, 0);

  // Now 3 consecutive identical failures abort
  assert.equal(wd.observeStep(failStep).action, 'continue');
  assert.equal(wd.observeStep(failStep).action, 'continue');
  const third = wd.observeStep(failStep);
  assert.equal(third.action, 'abort');
  assert.match(third.reason, /in-turn flail detected: 3 consecutive identical failures/);
});

test('resolveDynamicEffort enforces precedence between warm NDJSON Strike-1 resume and fresh-process xhigh escalation', () => {
  // Strike 0: medium for mid, high for frontier
  assert.deepEqual(resolveDynamicEffort({ tier: 'mid' }, { strike: 0 }), {
    effort: 'medium',
    escalated: false,
    reuseWarmDaemon: false,
  });
  assert.deepEqual(resolveDynamicEffort({ tier: 'frontier' }, { strike: 0, warmDaemonAlive: true }), {
    effort: 'high',
    escalated: false,
    reuseWarmDaemon: true,
  });

  // Strike 1 with healthy warm daemon (gate/prosecutor rejection): keep warm daemon & effort
  assert.deepEqual(
    resolveDynamicEffort({ tier: 'frontier' }, { strike: 1, warmDaemonAlive: true, aborted: false }),
    {
      effort: 'high',
      escalated: false,
      reuseWarmDaemon: true,
    }
  );

  // Strike 1 after watchdog abort, timeout, or dead daemon: spawn fresh process with xhigh/max
  assert.deepEqual(
    resolveDynamicEffort({ tier: 'frontier' }, { strike: 1, warmDaemonAlive: true, aborted: true }),
    {
      effort: 'xhigh',
      escalated: true,
      reuseWarmDaemon: false,
    }
  );
  assert.deepEqual(
    resolveDynamicEffort({ tier: 'mid' }, { strike: 1, warmDaemonAlive: false, allowMax: true }),
    {
      effort: 'max',
      escalated: true,
      reuseWarmDaemon: false,
    }
  );
});
