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
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-hookrunner-'));
  PLUGIN = path.join(ROOT, 'plugin');
  fs.mkdirSync(path.join(PLUGIN, 'bin'), { recursive: true });
  fs.copyFileSync(RUNNER_SRC, path.join(PLUGIN, 'bin', 'hook-runner.sh'));
  fs.writeFileSync(path.join(PLUGIN, 'bin', 'node-launcher.sh'), STUB, { mode: 0o755 });
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
      for (const target of ['/h/.migration.lock', '/h/.config/antigravity-booster/state.json']) {
        const r = await go({
          payload: payloadFor(READ_TOOL, { args: { AbsolutePath: target } }),
          env: { STUB_MODE: 'crash' },
        });
        assertInvariant(r);
        assert.equal(decisionOf(r), 'deny', target);
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

    test('empty payload (no stdin bytes) on crash: non-ADLC fallback ask, never crashes', async () => {
      const r = await go({ payload: '', env: { STUB_MODE: 'crash' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'ask');
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

    test('child ignoring SIGTERM is escalated and fallback still emitted within timeout + 1.5s', async () => {
      const r = await go({ payload: payloadFor(SHELL_TOOL), args: ['--timeout', '2'], env: { STUB_MODE: 'hang_ignore_term' } });
      assertInvariant(r);
      assert.equal(decisionOf(r), 'ask');
      assert.ok(r.ms <= 3500, `took ${r.ms}ms`);
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
      assert.ok(r.ms <= 3500, `took ${r.ms}ms`);
    });

    test('unclosed stdin with no bytes at all emits fallback within the deadline', async () => {
      const r = await go({ keepStdinOpen: true, args: ['--timeout', '2'], env: { STUB_MODE: 'empty' } });
      assert.equal(r.code, 0);
      assert.ok(r.ms <= 3500, `took ${r.ms}ms`);
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

test('runner source is POSIX sh: no bashisms, command -v not which', () => {
  const src = fs.readFileSync(RUNNER_SRC, 'utf8');
  assert.match(src, /^#!\/bin\/sh\n/);
  assert.ok(!/\bwhich\b/.test(src.replace(/#.*$/gm, '')), 'uses which');
  assert.ok(!/\[\[(?!:)|\bfunction\s+\w+/.test(src), 'bashism');
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
