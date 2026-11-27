import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  buildGrillMeEscalationPrompt,
  ESCALATION_ACTIONS,
  formatEscalationAlert,
  parseEscalationAnswer,
  runInteractiveEscalation,
} from '../lib/interactive-escalation.mjs';
import { runPlan } from '../lib/scheduler.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('./fixtures/fake-adlc', import.meta.url));

test('formatEscalationAlert, buildGrillMeEscalationPrompt, and parseEscalationAnswer sanitize input and parse all actions', () => {
  assert.deepEqual(ESCALATION_ACTIONS, ['retry', 'skip', 'abort']);

  const alert = formatEscalationAlert('T-42\x1b]0;pwn\x07', 'test\nfailed\x07');
  assert.equal(alert.bell, '\x07');
  assert.equal(alert.oscTitle, '\x1b]0;⚠ rescue T-42 ]0;pwn\x07');
  assert.match(alert.summary, /⚠ rescue T-42 \]0;pwn: test failed/);

  const fallbackAlert = formatEscalationAlert('', '');
  assert.equal(fallbackAlert.oscTitle, '\x1b]0;⚠ rescue ticket\x07');
  assert.equal(fallbackAlert.summary, '⚠ rescue ticket');

  const prompt = buildGrillMeEscalationPrompt({
    ticket: { id: 'T-1', title: 'Fix parser', scope: ['lib/a.mjs', 'lib/b.mjs'] },
    reason: 'assertion failed',
    signals: [{ type: 'repeat_error' }, 'thrash'],
    strike: 2,
  });
  assert.match(prompt, /ADLC Strike-2 Interactive Escalation \(\/grill-me\)/);
  assert.match(prompt, /Ticket : T-1 — Fix parser/);
  assert.match(prompt, /Scope  : lib\/a\.mjs, lib\/b\.mjs/);
  assert.match(prompt, /Signals: repeat_error, thrash/);
  assert.match(prompt, /Reason : assertion failed/);

  const emptyPrompt = buildGrillMeEscalationPrompt({});
  assert.match(emptyPrompt, /Ticket : unknown/);
  assert.match(emptyPrompt, /Scope  : \(unscoped\)/);
  assert.match(emptyPrompt, /Signals: none/);
  assert.match(emptyPrompt, /Reason : two strikes exhausted/);

  assert.deepEqual(parseEscalationAnswer('r'), { action: 'retry', guidance: '' });
  assert.deepEqual(parseEscalationAnswer('RETRY'), { action: 'retry', guidance: '' });
  assert.deepEqual(parseEscalationAnswer('retry: mock the clock'), { action: 'retry', guidance: 'mock the clock' });
  assert.deepEqual(parseEscalationAnswer('r - check empty array'), { action: 'retry', guidance: 'check empty array' });
  assert.deepEqual(parseEscalationAnswer('s'), { action: 'skip', guidance: '' });
  assert.deepEqual(parseEscalationAnswer('skip'), { action: 'skip', guidance: '' });
  assert.deepEqual(parseEscalationAnswer('a'), { action: 'abort', guidance: '' });
  assert.deepEqual(parseEscalationAnswer('abort'), { action: 'abort', guidance: '' });
  assert.deepEqual(parseEscalationAnswer(''), { action: 'skip', guidance: '' });
  assert.deepEqual(parseEscalationAnswer('wat'), { action: 'skip', guidance: '' });
});

test('runInteractiveEscalation handles callbacks, errors, non-TTY degradation, and TTY readline input', async () => {
  const chunks = [];
  const fakeOut = { isTTY: true, write: (s) => { chunks.push(s); return true; } };

  const retryRes = await runInteractiveEscalation({
    ticket: { id: 'T-7', title: 'Retry me', scope: ['a.mjs'] },
    reason: 'flail',
    isTTY: true,
    output: fakeOut,
    onEscalation: async () => ({ action: 'retry', guidance: '  use helper  ' }),
  });
  assert.equal(retryRes.action, 'retry');
  assert.equal(retryRes.guidance, 'use helper');
  assert.equal(chunks[0], '\x07\x1b]0;⚠ rescue T-7\x07');

  const invalidRes = await runInteractiveEscalation({
    ticket: { id: 'T-7' },
    isTTY: false,
    onEscalation: async () => ({ action: 'bogus', guidance: 123 }),
  });
  assert.equal(invalidRes.action, 'skip');
  assert.equal(invalidRes.guidance, '');

  const errRes = await runInteractiveEscalation({
    ticket: { id: 'T-7' },
    isTTY: false,
    onEscalation: async () => { throw new Error('prompt exploded'); },
  });
  assert.equal(errRes.action, 'skip');
  assert.match(errRes.error, /prompt exploded/);

  const nonTty = await runInteractiveEscalation({
    ticket: { id: 'T-7' },
    isTTY: false,
  });
  assert.equal(nonTty.action, 'skip');
  assert.equal(nonTty.nonInteractive, true);

  // Interactive TTY readline flow
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (d) => { captured += d.toString('utf8'); });
  const pending = runInteractiveEscalation({
    ticket: { id: 'T-9', title: 'TTY test', scope: ['x.mjs'] },
    reason: 'test failed',
    input,
    output,
    isTTY: true,
  });
  input.end('retry: fix null check\n');
  const ttyRes = await pending;
  assert.equal(ttyRes.action, 'retry');
  assert.equal(ttyRes.guidance, 'fix null check');
  assert.ok(captured.includes('\x07\x1b]0;⚠ rescue T-9\x07'));
  assert.ok(captured.includes('ADLC Strike-2 Interactive Escalation'));
});

test('runPlan with interactive: true pauses only escalated ticket on skip while sibling wave ticket merges', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-interactive-sched-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'agb-interactive-state-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agb-interactive-home-'));
  const prevEnv = {
    HOME: process.env.HOME,
    AGB_AGY_BIN: process.env.AGB_AGY_BIN,
    AGB_ADLC_BIN: process.env.AGB_ADLC_BIN,
    AGB_ALLOW_CUSTOM_ADLC_CLI: process.env.AGB_ALLOW_CUSTOM_ADLC_CLI,
    AGB_SANDBOX_GATES: process.env.AGB_SANDBOX_GATES,
    AGB_DISABLE_BUILDER_SANDBOX: process.env.AGB_DISABLE_BUILDER_SANDBOX,
    FAKE_STATE_DIR: process.env.FAKE_STATE_DIR,
  };
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, '.gitignore'), '.booster/\n.worktrees/\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }) + '\n');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git('add', '.');
    git('commit', '-m', 'init');

    process.env.HOME = fakeHome;
    process.env.AGB_AGY_BIN = FAKE_AGY;
    process.env.AGB_ADLC_BIN = FAKE_ADLC;
    process.env.AGB_ALLOW_CUSTOM_ADLC_CLI = '1';
    process.env.AGB_SANDBOX_GATES = '0';
    process.env.AGB_DISABLE_BUILDER_SANDBOX = '1';
    process.env.FAKE_STATE_DIR = stateDir;

    const escalated = [];
    const plan = {
      repo,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [
        { id: 'T-OK', title: 'Good sibling', body: 'Write T-OK.txt', scope: ['T-OK.txt'], edges: [] },
        { id: 'T-BAD', title: 'Failing sibling', body: 'Scope mismatch', scope: ['other.txt'], edges: [] },
      ],
    };

    // Seed git history + .booster/report.json with T-OK merged so default resume=false is verified (resume=true would skip T-OK and leave T-OK.txt absent)
    const { existsSync, mkdirSync } = await import('node:fs');
    git('commit', '--allow-empty', '-m', 'T-OK: prior merge');
    mkdirSync(join(repo, '.booster'), { recursive: true });
    writeFileSync(join(repo, '.booster', 'report.json'), JSON.stringify({ merged: ['T-OK'] }) + '\n');

    const report = await runPlan(plan, {
      log: () => {},
      concurrency: 1,
      interactive: true,
      onEscalation: async (ctx) => {
        escalated.push(ctx.ticket.id);
        return { action: 'skip' };
      },
    });

    assert.deepEqual(escalated, ['T-BAD']);
    assert.ok(report.merged.includes('T-OK'), 'sibling ticket T-OK must still merge');
    assert.equal(existsSync(join(repo, 'T-OK.txt')), true, 'default resume=false must execute T-OK');
    assert.match(report.failed['T-BAD'] ?? '', /escalated \(skipped by operator\)/);

    // Verify retry is capped to 1 interactive escalation (kills interactiveRetries >= 2 mutant)
    const retryCalls = [];
    const retryPlan = {
      repo,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [
        { id: 'T-RETRY', title: 'Retry once', body: 'Scope mismatch', scope: ['other.txt'], edges: [] },
      ],
    };
    const retryReport = await runPlan(retryPlan, {
      log: () => {},
      concurrency: 1,
      interactive: true,
      onEscalation: async (ctx) => {
        retryCalls.push(ctx.ticket.id);
        return { action: 'retry', guidance: 'one more try' };
      },
    });
    assert.equal(retryCalls.length, 1, 'interactive retry must be capped at 1 escalation');
    assert.ok(retryReport.failed['T-RETRY']);

    // Verify programmatic runPlan defaults interactive=false when omitted
    const defaultReport = await runPlan(retryPlan, { log: () => {}, concurrency: 1 });
    assert.ok(defaultReport.failed['T-RETRY']);
    assert.doesNotMatch(defaultReport.failed['T-RETRY'], /escalated \(skipped by operator\)/);

    // Verify CLI `agb run` defaults interactive=false (does not emit escalated skip error)
    const { spawnSync } = await import('node:child_process');
    const agbBin = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
    const cliPlanFile = join(stateDir, 'cli-local-plan.json');
    writeFileSync(cliPlanFile, JSON.stringify(retryPlan) + '\n');
    const cliRun = spawnSync(process.execPath, [agbBin, 'run', cliPlanFile, '-c', '1'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(cliRun.status, 2);
    const cliReport = JSON.parse(cliRun.stdout);
    assert.ok(cliReport.failed['T-RETRY']);
    assert.doesNotMatch(cliReport.failed['T-RETRY'], /escalated \(skipped by operator\)/);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
