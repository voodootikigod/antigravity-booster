// Tests for bin/hook-runner.sh (spec: .adlc/specs/native-plugin-installation.md
// section 3 "Fail-Safe Hook Runner" + Appendix A). Fully offline: every scenario
// runs against a fake plugin root containing a copy of the runner plus a stub
// bin/node-launcher.sh that simulates each child behaviour. HOME is always a temp dir.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = path.join(HERE, '..', 'bin', 'hook-runner.sh');

// Stub launcher: behaviour selected through STUB_MODE (env passes through the runner).
const STUB = `#!/bin/sh
case "$STUB_MODE" in
  emit)      printf '%s\\n' "$STUB_LINE" ;;
  empty)     ;;
  exit86)    exit 86 ;;
  crash)     exit 1 ;;
  hang)      exec sleep 60 ;;
  hang_ignore_term) trap '' TERM; while :; do sleep 1; done ;;
  multiline) printf '{"decision":"deny",\\n"reason":"x"}\\n' ;;
  twolines)  printf '{"decision":"deny","reason":"a"}\\n{"decision":"deny","reason":"b"}\\n' ;;
  garbage)   printf 'not json at all\\n' ;;
  allow)     printf '{"decision":"allow","reason":"nope"}\\n' ;;
  allow_spaced) printf '{"decision": "allow","reason":"nope"}\\n' ;;
  *)         exit 1 ;;
esac
exit 0
`;

function which(cmd) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const SHELLS = [['/bin/sh', '/bin/sh']];
for (const name of ['dash', 'bash']) {
  const p = which(name);
  if (p) SHELLS.push([name, p]);
  else console.log(`# skipping ${name}: not installed`);
}

let ROOT; // scratch root
let PLUGIN; // fake plugin root
let HOME_DIR;
let ADLC_REPO;
let ADLC_REPO_SPACES;
let PLAIN_REPO;

before(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agb-hookrunner-')));
  PLUGIN = path.join(ROOT, 'plugin');
  fs.mkdirSync(path.join(PLUGIN, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(PLUGIN, 'test'), { recursive: true });
  fs.copyFileSync(RUNNER_SRC, path.join(PLUGIN, 'bin', 'hook-runner.sh'));
  fs.writeFileSync(path.join(PLUGIN, 'bin', 'node-launcher.sh'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(PLUGIN, 'test', 'hook-runner.test.mjs'), '');
  HOME_DIR = path.join(ROOT, 'home');
  fs.mkdirSync(HOME_DIR);
  ADLC_REPO = path.join(ROOT, 'adlc-repo');
  fs.mkdirSync(path.join(ADLC_REPO, '.adlc'), { recursive: true });
  fs.mkdirSync(path.join(ADLC_REPO, 'src'));
  ADLC_REPO_SPACES = path.join(ROOT, 'my adlc repo é\u{1f600}');
  fs.mkdirSync(path.join(ADLC_REPO_SPACES, '.adlc'), { recursive: true });
  PLAIN_REPO = path.join(ROOT, 'plain-repo');
  fs.mkdirSync(PLAIN_REPO);
});

after(() => {
  if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true });
});

const LOG_FILE = () =>
  path.join(HOME_DIR, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs', 'hooks.log');

function payloadFor(tool, { ws, cwdArg, args, pretty = false } = {}) {
  const base = ws ?? ADLC_REPO;
  const toolArgs =
    tool === 'run_command'
      ? { CommandLine: 'ls', Cwd: cwdArg ?? base }
      : tool === 'write_to_file'
        ? { TargetFile: path.join(base, 'src', 'x.txt'), CodeContent: 'hi' }
        : { AbsolutePath: path.join(base, 'src', 'x.txt') };
  const obj = {
    toolCall: { name: tool, args: { ...toolArgs, ...(args ?? {}) } },
    workspacePaths: [base],
    conversationId: 'c-1',
  };
  return JSON.stringify(obj, null, pretty ? 2 : 0);
}

/**
 * Run the runner under `shell`. Resolves { stdout, stderr, code, ms }.
 * opts: payload (string|null), keepStdinOpen, env, args, cwd, killAfterMs
 */
function run(shell, opts = {}) {
  const {
    payload = null,
    keepStdinOpen = false,
    env = {},
    args = [],
    cwd = PLUGIN,
    killAfterMs = 30000,
  } = opts;
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(shell, ['bin/hook-runner.sh', ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: HOME_DIR, TMPDIR: ROOT, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    if (payload !== null) child.stdin.write(payload);
    if (!keepStdinOpen) child.stdin.end();
    const guard = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      child.stdin.destroy();
      resolve({ stdout, stderr, code, signal, ms: Date.now() - start });
    });
  });
}

/** Invariant on every path: exit 0, and stdout is empty or exactly one JSON line. */
function assertInvariant(r) {
  assert.equal(r.code, 0, `exit code (signal=${r.signal}) stderr=${r.stderr}`);
  if (r.stdout === '') return;
  assert.ok(r.stdout.endsWith('\n'), 'stdout ends with newline');
  const lines = r.stdout.split('\n');
  assert.equal(lines.length, 2, `exactly one line, got: ${JSON.stringify(r.stdout)}`);
  const parsed = JSON.parse(lines[0]);
  assert.ok(['ask', 'deny'].includes(parsed.decision), `decision is ask|deny, got ${parsed.decision}`);
}

function decisionOf(r) {
  if (r.stdout === '') return '';
  return JSON.parse(r.stdout.trim()).decision;
}

const MUTATION = 'write_to_file';
const SHELL_TOOL = 'run_command';
const READ_TOOL = 'view_file';

const INTERACTIVE = {};
const MODES = {
  interactive: INTERACTIVE,
  'worker-ticket': { AGB_WORKER_TICKET: 'T-1' },
  'worker-readonly': { AGB_WORKER_MODE: 'readonly' },
};

for (const [label, shell] of SHELLS) {
  describe(`hook-runner under ${label}`, { concurrency: 8 }, () => {
    const go = (opts) => run(shell, opts);

    // ------------------------------------------------------------------
    // Fallback decision table: ADLC repo, child exit 86 / crash / malformed
    // ------------------------------------------------------------------
    const adlcExpect = {
      interactive: { [MUTATION]: 'deny', [SHELL_TOOL]: 'ask', [READ_TOOL]: '' },
      'worker-ticket': { [MUTATION]: 'deny', [SHELL_TOOL]: 'deny', [READ_TOOL]: '' },
      'worker-readonly': { [MUTATION]: 'deny', [SHELL_TOOL]: 'deny', [READ_TOOL]: '' },
    };
    const causes = [
      ['missing node runtime (exit 86)', { STUB_MODE: 'exit86' }],
      ['child crash (exit 1)', { STUB_MODE: 'crash' }],
      ['malformed JSON stdout', { STUB_MODE: 'garbage' }],
      ['multi-line JSON stdout', { STUB_MODE: 'multiline' }],
    ];
    for (const [cause, stubEnv] of causes) {
      for (const [mode, modeEnv] of Object.entries(MODES)) {
        for (const tool of [MUTATION, SHELL_TOOL, READ_TOOL]) {
          test(`ADLC repo / ${cause} / ${mode} / ${tool} -> ${JSON.stringify(adlcExpect[mode][tool])}`, async () => {
            const r = await go({ payload: payloadFor(tool), env: { ...stubEnv, ...modeEnv } });
            assertInvariant(r);
            assert.equal(decisionOf(r), adlcExpect[mode][tool]);
          });
        }
      }
    }

    // Non-ADLC repo
    for (const [cause, stubEnv] of causes) {
      for (const [mode, modeEnv] of Object.entries(MODES)) {
        for (const tool of [MUTATION, SHELL_TOOL, READ_TOOL]) {
          let expected;
          if (cause.startsWith('missing node')) expected = ''; // exit 86 passes through before worker deny
          else expected = mode === 'interactive' ? 'ask' : 'deny';
          test(`non-ADLC repo / ${cause} / ${mode} / ${tool} -> ${JSON.stringify(expected)}`, async () => {
            const r = await go({
              payload: payloadFor(tool, { ws: PLAIN_REPO }),
              env: { ...stubEnv, ...modeEnv },
            });
            assertInvariant(r);
            assert.equal(decisionOf(r), expected);
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // Watchdog timeout rows (use --timeout 1 to keep the matrix fast)
    // ------------------------------------------------------------------
    for (const [mode, modeEnv] of Object.entries(MODES)) {
      for (const tool of [MUTATION, SHELL_TOOL, READ_TOOL]) {
        test(`watchdog / ADLC repo / ${mode} / ${tool} -> ${JSON.stringify(adlcExpect[mode][tool])}`, async () => {
          const r = await go({
            payload: payloadFor(tool),
            args: ['--timeout', '1'],
            env: { STUB_MODE: 'hang', ...modeEnv },
          });
          assertInvariant(r);
          assert.equal(decisionOf(r), adlcExpect[mode][tool]);
          assert.ok(r.ms < 2500, `took ${r.ms}ms`);
        });
      }
      test(`watchdog / non-ADLC repo / ${mode} -> ${mode === 'interactive' ? 'ask' : 'deny'}`, async () => {
        const r = await go({
          payload: payloadFor(MUTATION, { ws: PLAIN_REPO }),
          args: ['--timeout', '1'],
          env: { STUB_MODE: 'hang', ...modeEnv },
        });
        assertInvariant(r);
        assert.equal(decisionOf(r), mode === 'interactive' ? 'ask' : 'deny');
      });
    }

    // ------------------------------------------------------------------
    // Normal execution
    // ------------------------------------------------------------------
    test('child emits valid deny: forwarded verbatim as one line', async () => {
      const line = '{"decision":"deny","reason":"Target path matches frozen rail: lib/lock.mjs"}';
      const r = await go({ payload: payloadFor(MUTATION), env: { STUB_MODE: 'emit', STUB_LINE: line } });
      assertInvariant(r);
      assert.equal(r.stdout, `${line}\n`);
    });

    test('child emits valid ask (spaced form): forwarded verbatim', async () => {
      const line = '{"decision": "ask","reason":"confirm"}';
      const r = await go({ payload: payloadFor(SHELL_TOOL, { ws: PLAIN_REPO }), env: { STUB_MODE: 'emit', STUB_LINE: line } });
      assertInvariant(r);
      assert.equal(r.stdout, `${line}\n`);
    });

    test('child emits empty stdout: neutral pass-through', async () => {
      const r = await go({ payload: payloadFor(MUTATION), env: { STUB_MODE: 'empty' } });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    });

    for (const [mode, modeEnv] of Object.entries(MODES)) {
      test(`child emits allow is never forwarded (ADLC mutation, ${mode}) -> deny`, async () => {
        const r = await go({ payload: payloadFor(MUTATION), env: { STUB_MODE: 'allow', ...modeEnv } });
        assertInvariant(r);
        assert.equal(decisionOf(r), 'deny');
        assert.ok(!r.stdout.includes('allow'));
      });
      test(`child emits allow is converted (non-ADLC, ${mode})`, async () => {
        const r = await go({ payload: payloadFor(MUTATION, { ws: PLAIN_REPO }), env: { STUB_MODE: 'allow', ...modeEnv } });
        assertInvariant(r);
        assert.equal(decisionOf(r), mode === 'interactive' ? 'ask' : 'deny');
      });
    }

    test('child emits spaced allow is converted, never forwarded', async () => {
      const r = await go({ payload: payloadFor(MUTATION, { ws: PLAIN_REPO }), env: { STUB_MODE: 'allow_spaced' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'ask');
    });

    test('child emits two JSON lines: collapsed to a single fallback line', async () => {
      const r = await go({ payload: payloadFor(MUTATION, { ws: PLAIN_REPO }), env: { STUB_MODE: 'twolines' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'ask');
    });

    // ------------------------------------------------------------------
    // Killswitch
    // ------------------------------------------------------------------
    test('AGB_HOOK_DISABLE=1: empty stdout, exit 0, CRITICAL NOTICE on stderr and in hooks.log', async () => {
      fs.rmSync(path.join(HOME_DIR, '.gemini'), { recursive: true, force: true });
      const r = await go({
        payload: payloadFor(MUTATION),
        env: { AGB_HOOK_DISABLE: '1', STUB_MODE: 'emit', STUB_LINE: '{"decision":"deny","reason":"x"}' },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /CRITICAL NOTICE/);
      assert.match(fs.readFileSync(LOG_FILE(), 'utf8'), /CRITICAL NOTICE.*AGB_HOOK_DISABLE is active/);
    });

    test('empty AGB_HOOK_DISABLE does not trigger the killswitch', async () => {
      const r = await go({
        payload: payloadFor(MUTATION),
        env: { AGB_HOOK_DISABLE: '', STUB_MODE: 'crash' },
      });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    // ------------------------------------------------------------------
    // --fallback handling
    // ------------------------------------------------------------------
    test('--fallback allow is coerced to deny semantics (ADLC mutation -> deny)', async () => {
      const r = await go({ payload: payloadFor(MUTATION), args: ['--fallback', 'allow'], env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('--fallback allow never yields allow in non-ADLC repo (-> ask)', async () => {
      const r = await go({
        payload: payloadFor(MUTATION, { ws: PLAIN_REPO }),
        args: ['--fallback', 'allow'],
        env: { STUB_MODE: 'crash' },
      });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'ask');
      assert.ok(!r.stdout.includes('allow'));
    });

    test('--fallback ask in non-ADLC repo -> ask; worker mode still deny', async () => {
      const a = await go({ payload: payloadFor(MUTATION, { ws: PLAIN_REPO }), args: ['--fallback', 'ask'], env: { STUB_MODE: 'crash' } });
      assert.equal(decisionOf(a), 'ask');
      const b = await go({
        payload: payloadFor(MUTATION, { ws: PLAIN_REPO }),
        args: ['--fallback', 'ask'],
        env: { STUB_MODE: 'crash', AGB_WORKER_MODE: 'readonly' },
      });
      assert.equal(decisionOf(b), 'deny');
    });

    // ------------------------------------------------------------------
    // Payload handling
    // ------------------------------------------------------------------
    test('hook cwd is the plugin root but payload points at an ADLC repo: mutations deny', async () => {
      const r = await go({ cwd: PLUGIN, payload: payloadFor(MUTATION), env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('ADLC context derived from toolCall.args.Cwd only (no workspacePaths)', async () => {
      const payload = JSON.stringify({ toolCall: { name: 'write_to_file', args: { Cwd: ADLC_REPO } } });
      const r = await go({ payload, env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('workspace nested inside an ADLC repo walks up to .adlc', async () => {
      const r = await go({
        payload: payloadFor(MUTATION, { ws: path.join(ADLC_REPO, 'src') }),
        env: { STUB_MODE: 'crash' },
      });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('multi-line (pretty-printed) JSON payload is parsed', async () => {
      const r = await go({ payload: payloadFor(MUTATION, { pretty: true }), env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('paths with spaces and unicode/emoji are preserved', async () => {
      const r = await go({ payload: payloadFor(MUTATION, { ws: ADLC_REPO_SPACES }), env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('payload mentioning .adlc/tickets/ in a non-ADLC workspace fails closed on mutation', async () => {
      const payload = payloadFor(MUTATION, { ws: PLAIN_REPO, args: { TargetFile: '/x/.adlc/tickets/T-1.json' } });
      const r = await go({ payload, env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('read-only tool targeting plugin_data/antigravity-booster during fallback -> deny', async () => {
      const payload = payloadFor(READ_TOOL, {
        args: { AbsolutePath: '/home/u/.gemini/antigravity-cli/plugin_data/antigravity-booster/logs/hooks.log' },
      });
      const r = await go({ payload, env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

      test('read-only tool targeting .migration.lock or ~/.config/antigravity-booster during fallback -> deny', async () => {
      for (const target of [
        '/h/.migration.lock',
        '/h/.config/antigravity-booster/state.json',
        '/h/.gemini/antigravity-cli/plugin_data/x/../antigravity-booster/logs/hooks.log',
      ]) {
        const r = await go({
          payload: payloadFor(READ_TOOL, { args: { AbsolutePath: target } }),
          env: { STUB_MODE: 'crash' },
        });
        assertInvariant(r);
        assert.equal(decisionOf(r), 'deny', target);
      }
    });

    test('read_file and file_search pass through during fallback in ADLC repo when targeting non-protected path', async () => {
      for (const toolName of ['read_file', 'file_search']) {
        const r = await go({
          payload: payloadFor(toolName, { args: { Path: path.join(ADLC_REPO, 'README.md') } }),
          env: { STUB_MODE: 'crash' },
        });
        assertInvariant(r);
        assert.equal(decisionOf(r), '', toolName);
      }
    });

    test('protected-target read-only tool in worker mode -> deny; non-ADLC repo stays pass-through of rule', async () => {
      const r = await go({
        payload: payloadFor(READ_TOOL, { args: { AbsolutePath: '/h/plugin_data/antigravity-booster/x' } }),
        env: { STUB_MODE: 'exit86', AGB_WORKER_TICKET: 'T-1' },
      });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('unparseable non-empty payload -> deny for run_command-like and garbage payloads', async () => {
      for (const payload of ['this is not json', '{"foo": 1}', '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}']) {
        const r = await go({ payload, env: { STUB_MODE: 'crash' } });
        assertInvariant(r);
        assert.equal(decisionOf(r), 'deny', payload);
      }
    });

    test('unparseable payload with exit 86 still denies (fail closed, not non-ADLC pass-through)', async () => {
      const r = await go({ payload: 'garbage', env: { STUB_MODE: 'exit86' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    test('empty payload (no stdin bytes) on crash or exit 86: fails closed to deny, never crashes', async () => {
      for (const mode of ['crash', 'exit86']) {
        const r = await go({ payload: '', env: { STUB_MODE: mode } });
        assertInvariant(r);
        assert.equal(decisionOf(r), 'deny');
      }
    });

    test('large payload (300 KB) is handled and child output forwarded', async () => {
      const big = payloadFor(MUTATION, { args: { CodeContent: 'x'.repeat(300 * 1024) } });
      const line = '{"decision":"deny","reason":"big"}';
      const r = await go({ payload: big, env: { STUB_MODE: 'emit', STUB_LINE: line } });
      assertInvariant(r);
      assert.equal(r.stdout, `${line}\n`);
    });

    test('hostile payload strings (quotes, SQL chars, shell metacharacters) do not break the runner', async () => {
      const payload = payloadFor(MUTATION, { args: { CodeContent: `'; DROP TABLE x; -- $(touch /tmp/pwned) \`id\` "\\"` } });
      const r = await go({ payload, env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
    });

    // ------------------------------------------------------------------
    // Watchdog latency
    // ------------------------------------------------------------------
    test('hung child with --timeout 2 emits fallback within timeout + 1.5s', async () => {
      const r = await go({ payload: payloadFor(MUTATION), args: ['--timeout', '2'], env: { STUB_MODE: 'hang' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
      assert.ok(r.ms >= 1900, `emitted too early: ${r.ms}ms`);
      assert.ok(r.ms <= 3500, `took ${r.ms}ms`);
    });

    // timeout (2s) + the watchdog's 1s SIGTERM->SIGKILL grace is 3s by design; the
    // ceiling leaves CI runners 1.5s of spawn jitter (agy's real deadline is 15s).
    test('child ignoring SIGTERM is escalated to SIGKILL and fallback emitted within timeout + 2.5s', async () => {
      const r = await go({ payload: payloadFor(SHELL_TOOL), args: ['--timeout', '2'], env: { STUB_MODE: 'hang_ignore_term' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'ask');
      assert.ok(r.ms >= 2900, `emitted before the 1s SIGKILL escalation could run: ${r.ms}ms`);
      assert.ok(r.ms <= 4500, `took ${r.ms}ms`);
    });

    test('unclosed stdin (writer holds pipe open) still emits fallback within the deadline', async () => {
      const r = await go({
        payload: payloadFor(MUTATION),
        keepStdinOpen: true,
        args: ['--timeout', '2'],
        env: { STUB_MODE: 'hang' },
      });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'deny');
      // Same budget as the escalation test above: the 2s timeout plus 2.5s of runner
      // jitter (macOS CI measured 3523ms against the old 3500ms ceiling). The floor
      // proves the fallback came from the watchdog, not an early exit.
      assert.ok(r.ms >= 1900, `emitted before the 2s watchdog could fire: ${r.ms}ms`);
      assert.ok(r.ms <= 4500, `took ${r.ms}ms`);
    });

    test('unclosed stdin with no bytes at all emits fallback within the deadline', async () => {
      const r = await go({ keepStdinOpen: true, args: ['--timeout', '2'], env: { STUB_MODE: 'empty' } });
      assert.equal(r.code, 0);
      assert.ok(r.ms <= 4500, `took ${r.ms}ms`);
      if (r.stdout !== '') assertInvariant(r);
    });
  });
}

// The real production timeout, once (under /bin/sh only).
test('real --timeout 9 watchdog emits fallback in <= 10.5s wall clock', { timeout: 20000 }, async () => {
  const r = await run('/bin/sh', {
    payload: payloadFor(MUTATION),
    args: ['--timeout', '9', 'dist/hooks/pre-tool-use.bundle.mjs'],
    env: { STUB_MODE: 'hang' },
  });
  console.log(`# real 9s watchdog wall clock: ${r.ms}ms`);
  assertInvariant(r);
  assert.equal(decisionOf(r), 'deny');
  assert.ok(r.ms >= 8900, `emitted too early: ${r.ms}ms`);
  assert.ok(r.ms <= 10500, `took ${r.ms}ms`);
});

test('runner source is POSIX sh: no bashisms, command -v not which, no test -O or unused LAUNCHER_DIR', () => {
  const src = fs.readFileSync(RUNNER_SRC, 'utf8');
  const launcherSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'node-launcher.sh'), 'utf8');
  assert.match(src, /^#!\/bin\/sh\n/);
  for (const [name, content] of [['hook-runner.sh', src], ['node-launcher.sh', launcherSrc]]) {
    const code = content.replace(/^\s*#.*$/gm, '');
    assert.ok(!/\bwhich\b/.test(code), `${name}: uses which`);
    assert.ok(!/\[\[(?!:)|\bfunction\s+\w+/.test(code), `${name}: bashism`);
    assert.ok(!/\[\s+(?:!\s+)?-[OGN]\s/.test(code), `${name}: non-POSIX test -O/-G/-N primary (SC3067)`);
    assert.ok(!/\blocal\s+[A-Za-z_]/.test(code), `${name}: non-POSIX local keyword (SC3043)`);
  }
  assert.ok(!/^LAUNCHER_DIR=/m.test(src), 'hook-runner.sh: unused LAUNCHER_DIR (SC2034)');
  assert.ok(src.includes('AGB_WORKER_MODE'), 'tests AGB_WORKER_MODE');
});

// P5 prosecution H5: a crashed child plus a second toolCall/name injected into
// the arguments must not earn the read-only pass-through.
test('fallback: injected toolCall/name in args cannot spoof a read-only tool', async () => {
  const spoofed = JSON.stringify({
    toolCall: {
      args: { CommandLine: 'tee src/x.txt', Cwd: ADLC_REPO, toolCall: { name: 'view_file' } },
      name: 'run_command',
    },
    workspacePaths: [ADLC_REPO],
  });
  const r = await run('/bin/sh', { payload: spoofed, env: { STUB_MODE: 'crash' } });
  assertInvariant(r);
  assert.equal(decisionOf(r), 'deny');
  const nameOnly = JSON.stringify({
    toolCall: { args: { TargetFile: 'src/x.txt', name: 'view_file' }, name: 'write_to_file' },
    workspacePaths: [ADLC_REPO],
  });
  const r2 = await run('/bin/sh', { payload: nameOnly, env: { STUB_MODE: 'crash' } });
  assertInvariant(r2);
  assert.equal(decisionOf(r2), 'deny');
});

test('fallback: an unambiguous read-only payload still passes through', async () => {
  const r = await run('/bin/sh', { payload: payloadFor('view_file'), env: { STUB_MODE: 'crash' } });
  assertInvariant(r);
  assert.equal(r.stdout, '');
});

// P5 round 3 F1: duplicated workspacePaths/Cwd injected into the arguments
// cannot steer the fallback toward the non-ADLC branch.
test('fallback: injected workspacePaths/Cwd in args make the payload unparseable (deny)', async () => {
  const injected = JSON.stringify({
    workspacePaths: [ADLC_REPO],
    toolCall: {
      name: 'write_to_file',
      args: { TargetFile: 'src/x.txt', nested: { workspacePaths: ['/tmp'], Cwd: '/tmp' } },
    },
  });
  const r = await run('/bin/sh', { payload: injected, env: { STUB_MODE: 'crash' } });
  assertInvariant(r);
  assert.equal(decisionOf(r), 'deny');
});

// T-MACOS-TIMING-FIXES: the watchdog caches pidfile contents at t+timeout and
// SIGKILLs at t+timeout+1. If the cached pid was reaped (pidfile removed) in
// between, it may now belong to an unrelated process and must not be killed.
// Deterministic: a "victim" stands in for a recycled pid; it records the
// watchdog's SIGTERM in a marker file, which proves the pid was cached, and only
// then do we remove the pidfile (simulating main reaping it) — no sleeps.
async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

for (const [label, shell] of SHELLS) {
  test(`[${label}] watchdog does not SIGKILL a cached pid whose pidfile was removed`, { timeout: 25000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, 'stale-'));
    const ready = path.join(tmp, 'victim-ready');
    const marker = path.join(tmp, 'victim-got-term');
    const victim = spawn(
      '/bin/sh',
      ['-c', `trap 'echo t > "${marker}"' TERM; echo r > "${ready}"; while :; do sleep 0.05; done`],
      { stdio: 'ignore' },
    );
    let runner = null;
    try {
      await waitFor(() => fs.existsSync(ready));
      runner = spawn(shell, ['bin/hook-runner.sh', '--timeout', '2'], {
        cwd: PLUGIN,
        env: { PATH: process.env.PATH, HOME: HOME_DIR, TMPDIR: tmp, STUB_MODE: 'hang' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      runner.stdin.on('error', () => {});
      runner.stdin.write(payloadFor(MUTATION)); // stdin held open: runner blocks reading it
      const closed = new Promise((r) => runner.on('close', r));
      const pidfile = await waitFor(() => {
        const d = fs.readdirSync(tmp).find((n) => n.startsWith('hook-runner.'));
        const f = d && path.join(tmp, d, 'stdin_pid');
        if (!f || !fs.existsSync(f)) return null;
        return /^\d+\n$/.test(fs.readFileSync(f, 'utf8')) ? f : null;
      });
      fs.writeFileSync(pidfile, `${victim.pid}\n`); // stand-in for a recycled pid
      await waitFor(() => fs.existsSync(marker)); // watchdog cached + TERMed it
      fs.rmSync(pidfile, { force: true }); // main "reaped" it; pid now unrelated
      await closed; // watchdog has passed its SIGKILL step
      assert.equal(victim.exitCode, null, 'victim must not have exited');
      assert.equal(victim.signalCode, null, 'victim must not have been SIGKILLed');
      process.kill(victim.pid, 0);
    } finally {
      victim.kill('SIGKILL');
      if (runner) {
        runner.stdin.destroy();
        runner.kill('SIGKILL');
      }
    }
  });
}

// T-HOOK-RUNNER-PID-TESTS: the same stale-pid guard for the child pidfile.
for (const [label, shell] of SHELLS) {
  test(`[${label}] watchdog does not SIGKILL a cached child pid whose pidfile was removed`, { timeout: 25000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, 'stale-child-'));
    const ready = path.join(tmp, 'victim-ready');
    const marker = path.join(tmp, 'victim-got-term');
    const victim = spawn(
      '/bin/sh',
      ['-c', `trap 'echo t > "${marker}"' TERM; echo r > "${ready}"; while :; do sleep 0.05; done`],
      { stdio: 'ignore' },
    );
    let runner = null;
    let realChild = null;
    try {
      await waitFor(() => fs.existsSync(ready));
      runner = spawn(shell, ['bin/hook-runner.sh', '--timeout', '2'], {
        cwd: PLUGIN,
        env: { PATH: process.env.PATH, HOME: HOME_DIR, TMPDIR: tmp, STUB_MODE: 'hang' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      runner.stdin.on('error', () => {});
      runner.stdin.end(payloadFor(MUTATION)); // stdin closed: runner proceeds to the hanging child
      const closed = new Promise((r) => runner.on('close', r));
      const pidfile = await waitFor(() => {
        const d = fs.readdirSync(tmp).find((n) => n.startsWith('hook-runner.'));
        const f = d && path.join(tmp, d, 'pid');
        if (!f || !fs.existsSync(f)) return null;
        return /^\d+\n$/.test(fs.readFileSync(f, 'utf8')) ? f : null;
      });
      realChild = Number(fs.readFileSync(pidfile, 'utf8').trim());
      fs.writeFileSync(pidfile, `${victim.pid}\n`); // stand-in for a recycled pid
      await waitFor(() => fs.existsSync(marker)); // watchdog cached + TERMed it
      fs.rmSync(pidfile, { force: true }); // main "reaped" it; pid now unrelated
      await closed; // watchdog has passed its SIGKILL step
      assert.equal(victim.exitCode, null, 'victim must not have exited');
      assert.equal(victim.signalCode, null, 'victim must not have been SIGKILLed');
      process.kill(victim.pid, 0);
    } finally {
      victim.kill('SIGKILL');
      if (realChild) { try { process.kill(realChild, 'SIGKILL'); } catch {} }
      if (runner) {
        runner.stdin.destroy();
        runner.kill('SIGKILL');
      }
    }
  });
}

// The guard above relies on main removing the child pidfile as soon as wait
// reaps the child. A PATH shim around rm records every invocation, so we can
// assert that removal happens on its own, before the final rm -rf cleanup.
for (const [label, shell] of SHELLS) {
  test(`[${label}] runner removes the child pidfile right after reaping the child`, { timeout: 20000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, 'rmlog-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(tmp, 'rm.log');
    const realRm = which('rm');
    assert.ok(realRm, 'rm must be on PATH');
    fs.writeFileSync(path.join(bin, 'rm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realRm}" "$@"\n`, { mode: 0o755 });
    const r = spawnSync(shell, ['bin/hook-runner.sh'], {
      cwd: PLUGIN,
      input: payloadFor(MUTATION),
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: HOME_DIR, TMPDIR: tmp, STUB_MODE: 'emit', STUB_LINE: '{"decision":"deny","reason":"x"}' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 0);
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const pidRm = lines.findIndex((l) => /^-f \S*\/hook-runner\.[^/ ]+\/pid$/.test(l));
    const dirRm = lines.findIndex((l) => /^-rf \S*\/hook-runner\.[^/ ]+$/.test(l));
    assert.ok(pidRm !== -1, `child pidfile was never removed on its own: ${JSON.stringify(lines)}`);
    assert.ok(dirRm === -1 || pidRm < dirRm, `child pidfile removal must precede cleanup: ${JSON.stringify(lines)}`);
  });
}

for (const [label, shell] of SHELLS) {
  test(`[${label}] read-only $HOME/.gemini falls back to /dev/null for HOOK_LOG_FILE instead of denying headless worker tool calls`, async () => {
    const roHome = fs.mkdtempSync(path.join(ROOT, 'ro-home-'));
    const roGemini = path.join(roHome, '.gemini');
    fs.mkdirSync(roGemini, { recursive: true });
    fs.chmodSync(roGemini, 0o500);
    try {
      const r = await run(shell, {
        payload: payloadFor('write_to_file'),
        env: { HOME: roHome, AGB_WORKER_TICKET: 't-1', STUB_MODE: 'empty' },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '', `expected pass (empty stdout), got: ${r.stdout}`);
      const rFallback = await run(shell, {
        payload: payloadFor('write_to_file'),
        env: { HOME: roHome, AGB_WORKER_TICKET: 't-1', STUB_MODE: 'crash' },
      });
      assertInvariant(rFallback);
      assert.equal(decisionOf(rFallback), 'deny');
      assert.match(JSON.parse(rFallback.stdout.trim()).reason, /\[audit-log-degraded\]/);
    } finally {
      try { fs.chmodSync(roGemini, 0o700); } catch {}
      fs.rmSync(roHome, { recursive: true, force: true });
    }
  });

  test(`[${label}] 4 canonical PLUGIN_DATA roots under AGB_TEST_PASSWD_HOME write logs/hooks.log while rogue and symlinked PLUGIN_DATA are rejected`, async () => {
    const passwdHome = fs.mkdtempSync(path.join(ROOT, 'passwd-home-pd-'));
    const canonicalRoots = [
      path.join(passwdHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster'),
      path.join(passwdHome, '.gemini', 'antigravity', 'plugin_data', 'antigravity-booster'),
      path.join(passwdHome, '.gemini', 'antigravity-ide', 'plugin_data', 'antigravity-booster'),
      path.join(passwdHome, '.config', 'antigravity-booster'),
    ];
    for (const pdRoot of canonicalRoots) {
      const r = await run(shell, {
        payload: payloadFor(MUTATION),
        env: { AGB_TEST_PASSWD_HOME: passwdHome, PLUGIN_DATA: pdRoot, AGB_HOOK_DISABLE: '1' },
      });
      assert.equal(r.code, 0);
      const logPath = path.join(pdRoot, 'logs', 'hooks.log');
      assert.ok(fs.existsSync(logPath), `expected hooks.log at ${logPath}`);
      assert.match(fs.readFileSync(logPath, 'utf8'), /CRITICAL NOTICE/);
    }

    // Rogue PLUGIN_DATA=/tmp/evil is rejected and falls back to default canonical root
    const defaultLog = path.join(canonicalRoots[0], 'logs', 'hooks.log');
    fs.rmSync(defaultLog, { force: true });
    const rRogue = await run(shell, {
      payload: payloadFor(MUTATION),
      env: { AGB_TEST_PASSWD_HOME: passwdHome, PLUGIN_DATA: '/tmp/evil', AGB_HOOK_DISABLE: '1' },
    });
    assert.equal(rRogue.code, 0);
    assert.equal(fs.existsSync('/tmp/evil/logs/hooks.log'), false);
    assert.ok(fs.existsSync(defaultLog), 'rogue PLUGIN_DATA must fall back to default canonical root');

    // Symlinked PLUGIN_DATA is rejected and falls back to default canonical root
    fs.rmSync(defaultLog, { force: true });
    fs.rmSync(canonicalRoots[3], { recursive: true, force: true });
    const symlinkTarget = fs.mkdtempSync(path.join(ROOT, 'symlink-pd-target-'));
    fs.symlinkSync(symlinkTarget, canonicalRoots[3]);
    const rSym = await run(shell, {
      payload: payloadFor(MUTATION),
      env: { AGB_TEST_PASSWD_HOME: passwdHome, PLUGIN_DATA: canonicalRoots[3], AGB_HOOK_DISABLE: '1' },
    });
    assert.equal(rSym.code, 0);
    assert.equal(fs.existsSync(path.join(symlinkTarget, 'logs', 'hooks.log')), false);
    assert.ok(fs.existsSync(defaultLog), 'symlinked PLUGIN_DATA must fall back to default canonical root');
  });

  test(`[${label}] staged hook-runner under .gemini/config/plugins ignores AGB_TEST_PASSWD_HOME and HOME, anchoring to getent PASSWD_HOME`, async () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, 'staged-'));
    const stagedPlugin = path.join(tmp, '.gemini', 'config', 'plugins', 'antigravity-booster');
    fs.mkdirSync(path.join(stagedPlugin, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(stagedPlugin, 'test'), { recursive: true });
    fs.copyFileSync(RUNNER_SRC, path.join(stagedPlugin, 'bin', 'hook-runner.sh'));
    fs.writeFileSync(path.join(stagedPlugin, 'bin', 'node-launcher.sh'), STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(stagedPlugin, 'test', 'hook-runner.test.mjs'), '');

    const passwdHome = path.join(tmp, 'passwd-home');
    const fakeTestHome = path.join(tmp, 'fake-test-home');
    const fakeEnvHome = path.join(tmp, 'fake-env-home');
    fs.mkdirSync(passwdHome, { recursive: true });
    fs.mkdirSync(fakeTestHome, { recursive: true });
    fs.mkdirSync(fakeEnvHome, { recursive: true });

    const shimBin = path.join(tmp, 'shim-bin');
    fs.mkdirSync(shimBin, { recursive: true });
    fs.writeFileSync(
      path.join(shimBin, 'getent'),
      `#!/bin/sh\nprintf 'user:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`,
      { mode: 0o755 },
    );

    const r = await run(shell, {
      cwd: stagedPlugin,
      payload: payloadFor(MUTATION),
      env: {
        PATH: `${shimBin}:${process.env.PATH}`,
        HOME: fakeEnvHome,
        AGB_TEST_PASSWD_HOME: fakeTestHome,
        AGB_HOOK_DISABLE: '1',
      },
    });
    assert.equal(r.code, 0);
    const expectedLog = path.join(passwdHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs', 'hooks.log');
    const unexpectedTestLog = path.join(fakeTestHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs', 'hooks.log');
    const unexpectedEnvLog = path.join(fakeEnvHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs', 'hooks.log');
    assert.ok(fs.existsSync(expectedLog), 'staged runner must write to getent PASSWD_HOME');
    assert.equal(fs.existsSync(unexpectedTestLog), false, 'staged runner must ignore AGB_TEST_PASSWD_HOME');
    assert.equal(fs.existsSync(unexpectedEnvLog), false, 'staged runner must ignore HOME');
  });

  test(`[${label}] symlinked HOOK_LOG_DIR or HOOK_LOG_FILE denies headless workers immediately`, async () => {
    // Symlinked HOOK_LOG_DIR
    const homeDirSym = fs.mkdtempSync(path.join(ROOT, 'tampered-dir-'));
    const dataRoot1 = path.join(homeDirSym, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
    fs.mkdirSync(dataRoot1, { recursive: true });
    const targetDir = fs.mkdtempSync(path.join(ROOT, 'elsewhere-dir-'));
    fs.symlinkSync(targetDir, path.join(dataRoot1, 'logs'));

    const rDir = await run(shell, {
      payload: payloadFor('view_file'),
      env: { HOME: homeDirSym, AGB_WORKER_TICKET: 'T-1', STUB_MODE: 'empty' },
    });
    assertInvariant(rDir);
    assert.equal(decisionOf(rDir), 'deny');
    assert.equal(JSON.parse(rDir.stdout.trim()).reason, 'agb hook audit log tampered in headless worker');
    assert.ok(fs.existsSync(path.join(homeDirSym, '.gemini', 'antigravity-cli', '.agb-hook-log-degraded')));

    // Symlinked HOOK_LOG_FILE
    const homeFileSym = fs.mkdtempSync(path.join(ROOT, 'tampered-file-'));
    const logDir2 = path.join(homeFileSym, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster', 'logs');
    fs.mkdirSync(logDir2, { recursive: true });
    const targetFile = path.join(ROOT, `elsewhere-${label.replace(/\W+/g, '_')}.log`);
    fs.writeFileSync(targetFile, '');
    fs.symlinkSync(targetFile, path.join(logDir2, 'hooks.log'));

    const rFile = await run(shell, {
      payload: payloadFor('view_file'),
      env: { HOME: homeFileSym, AGB_WORKER_MODE: 'readonly', STUB_MODE: 'empty' },
    });
    assertInvariant(rFile);
    assert.equal(decisionOf(rFile), 'deny');
    assert.equal(JSON.parse(rFile.stdout.trim()).reason, 'agb hook audit log tampered in headless worker');
    // Symlinked ~/.config (e.g. GNU Stow / chezmoi dotfiles) must NOT trigger LOG_TAMPERED
    const homeDotfiles = fs.mkdtempSync(path.join(ROOT, 'dotfiles-home-'));
    const realDotConfig = fs.mkdtempSync(path.join(ROOT, 'dotfiles-cfg-'));
    fs.symlinkSync(realDotConfig, path.join(homeDotfiles, '.config'));
    const rDot = await run(shell, {
      payload: payloadFor('view_file'),
      env: { HOME: homeDotfiles, AGB_WORKER_TICKET: 'T-1', STUB_MODE: 'empty' },
    });
    assertInvariant(rDot);
    assert.equal(decisionOf(rDot), '', 'symlinked ~/.config must not false-deny headless workers');

    // Foreign-UID DATA_ROOT (simulated via POSIX find -user reporting non-match) triggers LOG_TAMPERED
    const homeForeign = fs.mkdtempSync(path.join(ROOT, 'foreign-uid-home-'));
    const foreignRoot = path.join(homeForeign, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
    fs.mkdirSync(foreignRoot, { recursive: true });
    const shimFindDir = fs.mkdtempSync(path.join(ROOT, 'shim-find-'));
    const realFind = which('find');
    assert.ok(realFind, 'find must be on PATH');
    fs.writeFileSync(
      path.join(shimFindDir, 'find'),
      `#!/bin/sh\ncase "$*" in\n  *"${foreignRoot}"*) exit 0 ;;\nesac\nexec "${realFind}" "$@"\n`,
      { mode: 0o755 },
    );
    const rForeign = await run(shell, {
      payload: payloadFor('view_file'),
      env: {
        PATH: `${shimFindDir}:${process.env.PATH}`,
        HOME: homeForeign,
        AGB_WORKER_TICKET: 'T-1',
        STUB_MODE: 'empty',
      },
    });
    assertInvariant(rForeign);
    assert.equal(decisionOf(rForeign), 'deny');
    assert.equal(JSON.parse(rForeign.stdout.trim()).reason, 'agb hook audit log tampered in headless worker');
    assert.ok(fs.existsSync(path.join(homeForeign, '.gemini', 'antigravity-cli', '.agb-hook-log-degraded')));
  });

  test(`[${label}] fallback passes through list_dir and read-only manage_task while denying manage_task kill/send_input`, async () => {
    for (const toolName of ['list_dir', 'list_permissions', 'search_in_file', 'wait', 'wait_5_seconds']) {
      const r = await run(shell, {
        payload: payloadFor(toolName, { args: { DirectoryPath: ADLC_REPO } }),
        env: { STUB_MODE: 'crash', AGB_WORKER_TICKET: 'T-1' },
      });
      assertInvariant(r);
      assert.equal(decisionOf(r), '', `${toolName} should pass through in fallback`);
    }

    const rList = await run(shell, {
      payload: payloadFor('manage_task', { args: { Action: 'list' } }),
      env: { STUB_MODE: 'crash', AGB_WORKER_TICKET: 'T-1' },
    });
    assertInvariant(rList);
    assert.equal(decisionOf(rList), '', 'manage_task list should pass through');

    for (const action of ['kill', 'KILL', 'send_input', 'unknown']) {
      const rMut = await run(shell, {
        payload: payloadFor('manage_task', { args: { Action: action, TaskId: 'task-1' } }),
        env: { STUB_MODE: 'crash', AGB_WORKER_TICKET: 'T-1' },
      });
      assertInvariant(rMut);
      assert.equal(decisionOf(rMut), 'deny', `manage_task ${action} must deny in headless fallback`);
    }

    const rNoAction = await run(shell, {
      payload: payloadFor('manage_task', { args: { TaskId: 'task-1' } }),
      env: { STUB_MODE: 'crash', AGB_WORKER_TICKET: 'T-1' },
    });
    assertInvariant(rNoAction);
    assert.equal(decisionOf(rNoAction), 'deny', 'manage_task without Action must deny in headless fallback');
  });
}
