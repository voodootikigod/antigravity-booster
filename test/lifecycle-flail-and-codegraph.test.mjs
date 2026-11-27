import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateLifecycleEvent } from '../hooks/lifecycle.mjs';
import { shouldProjectCodegraphMcp } from '../lib/agy.mjs';

test('lifecycle.mjs: PostToolUse + PostInvocation + PreInvocation detect consecutive identical failures and emit one-shot ADLC P4 Flail-Breaker hint', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agb-flail-data-'));
  const repo = mkdtempSync(join(tmpdir(), 'agb-flail-repo-'));
  try {
    const convId = 'conv-flail-test-1234';
    const opts = { pluginDataDir: dataDir, env: {} };
    const failPayload = {
      conversationId: convId,
      cwd: repo,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      toolResponse: { exitCode: 1, output: 'AssertionError: expected 1 === 2' },
    };

    // 1. Single failure does NOT trigger flail breaker
    assert.deepEqual(evaluateLifecycleEvent(failPayload, { ...opts, eventOverride: 'PostToolUse' }), {});
    assert.deepEqual(evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PostInvocation' }), {});
    assert.deepEqual(evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PreInvocation' }), {});

    // 2. Second identical consecutive failure arms flailAlertPending in PostInvocation and fires in PreInvocation
    assert.deepEqual(evaluateLifecycleEvent(failPayload, { ...opts, eventOverride: 'PostToolUse' }), {});
    assert.deepEqual(evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PostInvocation' }), {});
    const preOut = evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PreInvocation' });
    const md = preOut?.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown ?? '';
    assert.match(md, /AGB ADLC P4 Flail Breaker/);
    assert.match(md, /2 consecutive identical failures/);
    assert.match(md, /run_command:npm test/);

    // 3. Subsequent PreInvocation does not spam the same failure signature
    assert.deepEqual(evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PreInvocation' }), {});

    // 4. Successful tool call resets consecutive failure counter
    assert.deepEqual(
      evaluateLifecycleEvent(
        {
          conversationId: convId,
          cwd: repo,
          toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
          toolResponse: { exitCode: 0, output: 'pass' },
        },
        { ...opts, eventOverride: 'PostToolUse' }
      ),
      {}
    );
    // One failure after reset does not fire
    assert.deepEqual(evaluateLifecycleEvent(failPayload, { ...opts, eventOverride: 'PostToolUse' }), {});
    assert.deepEqual(evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PostInvocation' }), {});
    assert.deepEqual(evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PreInvocation' }), {});

    // 5. Lowercase `command` and `TargetFile` signatures also trigger P4 flail breaker
    const cmdFail = {
      conversationId: convId,
      cwd: repo,
      toolCall: { name: 'run_command', args: { command: 'npm run lint' } },
      toolResponse: { exitCode: 1 },
    };
    evaluateLifecycleEvent(cmdFail, { ...opts, eventOverride: 'PostToolUse' });
    evaluateLifecycleEvent(cmdFail, { ...opts, eventOverride: 'PostToolUse' });
    evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PostInvocation' });
    const cmdPre = evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PreInvocation' });
    assert.match(cmdPre?.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown ?? '', /run_command:npm run lint/);

    const editFail = {
      conversationId: convId,
      cwd: repo,
      toolCall: { name: 'replace_file_content', args: { TargetFile: 'src/app.mjs' } },
      error: 'target not found',
    };
    evaluateLifecycleEvent(editFail, { ...opts, eventOverride: 'PostToolUse' });
    evaluateLifecycleEvent(editFail, { ...opts, eventOverride: 'PostToolUse' });
    evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PostInvocation' });
    const editPre = evaluateLifecycleEvent({ conversationId: convId, cwd: repo }, { ...opts, eventOverride: 'PreInvocation' });
    assert.match(editPre?.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown ?? '', /replace_file_content:src\/app\.mjs/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('shouldProjectCodegraphMcp honors .adlc/config.json accelerators.codegraph, AGB_ALLOW_CODEGRAPH_MCP, AGB_CODEGRAPH=0, and rejects symlinked .codegraph', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-cg-proj-'));
  const outside = mkdtempSync(join(tmpdir(), 'agb-cg-out-'));
  try {
    assert.equal(shouldProjectCodegraphMcp(null, {}), false);
    assert.equal(shouldProjectCodegraphMcp(repo, { AGB_ALLOW_CODEGRAPH_MCP: '1' }), false);

    // Symlinked .codegraph is rejected even with AGB_ALLOW_CODEGRAPH_MCP=1
    symlinkSync(outside, join(repo, '.codegraph'));
    assert.equal(shouldProjectCodegraphMcp(repo, { AGB_ALLOW_CODEGRAPH_MCP: '1' }), false);
    rmSync(join(repo, '.codegraph'));

    // Physical .codegraph without config opt-in or env var stays false (no-mcp-storm invariant)
    mkdirSync(join(repo, '.codegraph'), { recursive: true });
    assert.equal(shouldProjectCodegraphMcp(repo, {}), false);
    assert.equal(shouldProjectCodegraphMcp(repo, { AGB_ALLOW_CODEGRAPH_MCP: '1' }), true);

    // Explicit .adlc/config.json accelerators.codegraph: true auto-enables projection
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(
      join(repo, '.adlc', 'config.json'),
      JSON.stringify({ version: 1, accelerators: { codegraph: true } }, null, 2) + '\n'
    );
    assert.equal(shouldProjectCodegraphMcp(repo, {}), true);

    // Explicit opt-out flags override config
    assert.equal(shouldProjectCodegraphMcp(repo, { AGB_CODEGRAPH: '0' }), false);
    assert.equal(shouldProjectCodegraphMcp(repo, { AGB_ALLOW_CODEGRAPH_MCP: '0' }), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
