import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_MUXES,
  buildMuxNotificationArgs,
  buildMuxSplitPlan,
  detectMultiplexer,
  launchMuxSplit,
  normalizeMuxName,
} from '../lib/mux.mjs';

test('mux engine supports tmux (and tmuxh alias), cmux, and herdr, rejects zellij, and executes shell-free argv vectors', () => {
  assert.deepEqual(SUPPORTED_MUXES, ['tmux', 'cmux', 'herdr']);
  assert.equal(normalizeMuxName('tmuxh'), 'tmux');
  assert.equal(normalizeMuxName('TMUX'), 'tmux');
  assert.equal(normalizeMuxName('cmux'), 'cmux');
  assert.equal(normalizeMuxName('herdr'), 'herdr');
  assert.throws(() => normalizeMuxName('zellij'), /Unsupported multiplexer 'zellij'/);

  // Environment detection priority: herdr -> cmux -> tmux -> null
  assert.equal(detectMultiplexer({}), null);
  assert.equal(detectMultiplexer({ TMUX: '/tmp/tmux-1000/default,123,0' }), 'tmux');
  assert.equal(
    detectMultiplexer({ TMUX: '1', CMUX_SOCKET_PATH: '/tmp/cmux.sock' }),
    'cmux'
  );
  assert.equal(
    detectMultiplexer({ TMUX: '1', CMUX_SOCKET_PATH: '/tmp/cmux.sock', HERDR_ENV: '1' }),
    'herdr'
  );

  // Refuses herdr control when HERDR_ENV !== '1' and HERDR_PANE_ID is absent
  const refusedHerdr = buildMuxSplitPlan({
    mux: 'herdr',
    cwd: '/tmp/worktree-1',
    env: {},
  });
  assert.equal(refusedHerdr.ok, false);
  assert.equal(refusedHerdr.reason, 'outside_herdr_session');

  // Executes 2-step herdr split + pane run with JSON pane_id parsing and shell: false
  const calls = [];
  const herdrRes = launchMuxSplit({
    mux: 'herdr',
    cwd: '/tmp/worktree-1',
    command: 'agb rescue T1 /tmp/repo',
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' },
    spawnSyncFn: (bin, args, opts) => {
      calls.push({ bin, args, shell: opts.shell });
      if (args[1] === 'split') {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    },
  });
  assert.equal(herdrRes.ok, true);
  assert.equal(herdrRes.mux, 'herdr');
  assert.equal(herdrRes.paneId, 'w1:p2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].shell, false);
  assert.deepEqual(calls[0].args, [
    'pane',
    'split',
    '--current',
    '--direction',
    'right',
    '--cwd',
    '/tmp/worktree-1',
    '--no-focus',
  ]);
  assert.deepEqual(calls[1].args, ['pane', 'run', 'w1:p2', 'agb rescue T1 /tmp/repo']);

  // cmux split + --socket forwarding
  const cmuxPlan = buildMuxSplitPlan({
    mux: 'cmux',
    cwd: '/tmp/wt',
    command: 'agb watch /tmp/repo',
    env: { CMUX_SOCKET_PATH: '/tmp/cmux-custom.sock' },
  });
  assert.equal(cmuxPlan.ok, true);
  assert.deepEqual(cmuxPlan.splitCall, {
    bin: 'cmux',
    args: ['--socket', '/tmp/cmux-custom.sock', 'new-split', 'right', '--command', 'agb watch /tmp/repo'],
  });

  // tmuxh alias -> tmux split-window -h -d -c
  const tmuxPlan = buildMuxSplitPlan({
    mux: 'tmuxh',
    cwd: '/tmp/wt',
    commandArgs: ['agb', 'rescue', 'T1'],
    env: { TMUX: '/tmp/tmux/0' },
  });
  assert.equal(tmuxPlan.ok, true);
  assert.deepEqual(tmuxPlan.splitCall, {
    bin: 'tmux',
    args: ['split-window', '-h', '-d', '-c', '/tmp/wt', 'agb', 'rescue', 'T1'],
  });

  // Rejects newline injection in command
  assert.equal(
    launchMuxSplit({
      mux: 'cmux',
      cwd: '/tmp/wt',
      command: 'agb watch\nrm -rf /',
      env: { CMUX_SOCKET_PATH: '/tmp/cmux.sock' },
    }).ok,
    false
  );

  // Notification argument builders
  assert.deepEqual(
    buildMuxNotificationArgs({
      mux: 'herdr',
      title: 'P6 Ready',
      body: 'All merged',
      env: { HERDR_ENV: '1' },
    }),
    { mux: 'herdr', bin: 'herdr', args: ['notification', 'show', 'P6 Ready', '--body', 'All merged'] }
  );
  assert.deepEqual(
    buildMuxNotificationArgs({
      mux: 'cmux',
      title: 'Alert',
      body: 'Check T1',
      env: { CMUX_SOCKET_PATH: '/tmp/cmux.sock' },
    }),
    { mux: 'cmux', bin: 'cmux', args: ['--socket', '/tmp/cmux.sock', 'notify', '--title', 'Alert', '--body', 'Check T1'] }
  );
});
