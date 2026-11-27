import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { resolveNullHooksPath, runGateTicket } from '../lib/gate-ticket.mjs';
import { buildPlanPrompts } from '../lib/plan.mjs';
import { buildReviewPrompts } from '../lib/review.mjs';

const BIN_AGB = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

function makeTestGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agb-gate-ticket-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1, securityMode: 'unsigned-fallback' }, null, 2) + '\n');
  initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'ok.mjs'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'src', 'rail.mjs'), 'export const frozen = true;\n');
  writeFileSync(join(repo, 'src', 'other.mjs'), 'export const y = 2;\n');
  writeFileSync(
    join(repo, '.adlc', 'tickets', ticketFilename('T-GT-1')),
    JSON.stringify(
      {
        id: 'T-GT-1',
        title: 'Gate ticket test',
        body: 'Update src/ok.mjs',
        scope: ['src/ok.mjs'],
        rails: ['src/rail.mjs'],
        edges: [],
      },
      null,
      2
    ) + '\n'
  );
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repo });
  return repo;
}

test('runGateTicket: enforces ticket ID, base ref, empty diff, scope confinement, rail protection, test gate, and clean pass without agy', async () => {
  const repo = makeTestGitRepo();
  try {
    // 1. Invalid ticket ID & missing ticket
    const badId = await runGateTicket(repo, '../bad', { base: 'HEAD', sandbox: false });
    assert.equal(badId.ok, false);
    assert.equal(badId.kind, 'invalid_ticket_id');

    const missing = await runGateTicket(repo, 'T-NOPE', { base: 'HEAD', sandbox: false });
    assert.equal(missing.ok, false);
    assert.equal(missing.kind, 'ticket_not_found');

    // 2. Invalid base ref
    const badBase = await runGateTicket(repo, 'T-GT-1', { base: 'nonexistent-ref-xyz', sandbox: false });
    assert.equal(badBase.ok, false);
    assert.equal(badBase.kind, 'invalid_base_ref');

    // 3. Empty diff rejected
    const empty = await runGateTicket(repo, 'T-GT-1', { base: 'HEAD', sandbox: false });
    assert.equal(empty.ok, false);
    assert.equal(empty.kind, 'empty_diff');

    // 4. Out-of-scope edit rejected without auto-committing working tree
    writeFileSync(join(repo, 'src', 'other.mjs'), 'export const y = 99;\n');
    const outScope = await runGateTicket(repo, 'T-GT-1', { base: 'HEAD', testCmd: 'true', sandbox: false });
    assert.equal(outScope.ok, false);
    assert.equal(outScope.kind, 'scope_violation');
    execFileSync('git', ['checkout', '--', 'src/other.mjs'], { cwd: repo });

    // 5. Frozen rail edit rejected
    writeFileSync(join(repo, 'src', 'rail.mjs'), 'export const frozen = false;\n');
    const railHit = await runGateTicket(repo, 'T-GT-1', { base: 'HEAD', testCmd: 'true', sandbox: false });
    assert.equal(railHit.ok, false);
    assert.equal(railHit.kind, 'rail_violation');
    execFileSync('git', ['checkout', '--', 'src/rail.mjs'], { cwd: repo });

    // 6. Symlink escaping repository rejected
    const outside = mkdtempSync(join(tmpdir(), 'agb-gt-outside-'));
    try {
      const extFile = join(outside, 'ext.mjs');
      writeFileSync(extFile, 'export const z = 1;\n');
      rmSync(join(repo, 'src', 'ok.mjs'));
      symlinkSync(extFile, join(repo, 'src', 'ok.mjs'));
      const symEscape = await runGateTicket(repo, 'T-GT-1', { base: 'HEAD', testCmd: 'true', sandbox: false });
      assert.equal(symEscape.ok, false);
      assert.equal(symEscape.kind, 'scope_violation');
      rmSync(join(repo, 'src', 'ok.mjs'));
      execFileSync('git', ['checkout', '--', 'src/ok.mjs'], { cwd: repo });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    // 7. Failing test gate rejected
    writeFileSync(join(repo, 'src', 'ok.mjs'), 'export const x = 2;\n');
    const failGate = await runGateTicket(repo, 'T-GT-1', { base: 'HEAD', testCmd: 'false', sandbox: false, recordManifest: false });
    assert.equal(failGate.ok, false);
    assert.equal(failGate.kind, 'gate_failed');

    // 8. Clean in-scope edit + passing test gate succeeds with zero agy binary!
    const cleanPass = await runGateTicket(repo, 'T-GT-1', {
      base: 'HEAD',
      testCmd: 'node -e "process.exit(0)"',
      sandbox: false,
      skipHollow: true,
      recordManifest: false,
    });
    assert.equal(cleanPass.ok, true);
    assert.deepEqual(cleanPass.changedPaths, ['src/ok.mjs']);
    assert.equal(cleanPass.stages.gates.ok, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('buildPlanPrompts and buildReviewPrompts emit structured prompts offline without agy or quota probe', () => {
  const repo = makeTestGitRepo();
  try {
    // 1. Structured spec fast-path -> premortem + parallax prompts
    const specFile = join(repo, 'spec.md');
    writeFileSync(
      specFile,
      [
        '# Specification: Offline Prompt Test',
        '',
        '## 1. Context & Problem Statement',
        'Test offline prompt generation.',
        '',
        '## 2. Ticket Decomposition',
        '',
        '### Ticket 1: `T-A` — First',
        '- **Scope**: `src/ok.mjs`',
        '- **Rails**: `src/rail.mjs`',
        '- **Edges**: `T-A -> T-B`',
        '- **Tier**: `mid`',
        '- **Pool Hint**: `gemini`',
        '- **Objectives**:',
        '  1. Update `src/ok.mjs` to export `x = 10`.',
        '- **Acceptance Criteria**:',
        '  - `npm test` exits `0`.',
        '',
        '### Ticket 2: `T-B` — Second',
        '- **Scope**: `src/other.mjs`',
        '- **Rails**: `src/rail.mjs`',
        '- **Edges**: None',
        '- **Tier**: `mid`',
        '- **Pool Hint**: `gemini`',
        '- **Objectives**:',
        '  1. Update `src/other.mjs` to consume `x` from `src/ok.mjs`.',
        '- **Acceptance Criteria**:',
        '  - `npm test` exits `0`.',
      ].join('\n'),
      'utf8'
    );

    const planPrompts = buildPlanPrompts(specFile, { repo });
    assert.equal(planPrompts.ok, true);
    assert.equal(planPrompts.fastPath, true);
    assert.equal(planPrompts.plan.tickets.length, 2);
    assert.match(planPrompts.prompts.premortem.prompt, /three months from now/);
    assert.equal(planPrompts.prompts.parallax.length, 1);
    assert.equal(planPrompts.prompts.parallax[0].edge, 'T-A -> T-B');

    // 2. Unstructured prose plan -> conversion prompt fallback
    const proseFile = join(repo, 'prose.md');
    writeFileSync(proseFile, '# Prose Idea\n\nBuild a cool CLI widget.\n', 'utf8');
    const prosePrompts = buildPlanPrompts(proseFile, { repo });
    assert.equal(prosePrompts.ok, true);
    assert.equal(prosePrompts.fastPath, false);
    assert.match(prosePrompts.prompts.convert.prompt, /Convert this Antigravity implementation plan/);

    // 3. Plan review prompts (5-lens PLAN_LENSES)
    const planRev = buildReviewPrompts({ repo, specPath: 'spec.md' });
    assert.equal(planRev.ok, true);
    assert.equal(planRev.mode, 'plan');
    assert.equal(planRev.lenses.length, 5);
    assert.match(planRev.lenses[0].prompt, /Active Lens/);

    // 4. Code review prompts: empty diff vs non-empty diff (5-lens and 4-lens)
    const emptyRev = buildReviewPrompts({ repo });
    assert.equal(emptyRev.ok, true);
    assert.equal(emptyRev.emptyDiff, true);
    assert.equal(emptyRev.lenses.length, 0);

    writeFileSync(join(repo, 'src', 'ok.mjs'), 'export const x = 42;\n');
    const codeRevDefault = buildReviewPrompts({ repo });
    assert.equal(codeRevDefault.ok, true);
    assert.equal(codeRevDefault.mode, 'code');
    assert.equal(codeRevDefault.emptyDiff, false);
    assert.equal(codeRevDefault.lenses.length, 5);

    const codeRev4 = buildReviewPrompts({ repo, fiveLens: false });
    assert.equal(codeRev4.lenses.length, 4);

    // 5. Default maxTicketScope = 12 boundary in buildPlanPrompts
    const makeWideSpec = (count) =>
      [
        '# Specification: Scope Boundary',
        '',
        '## 1. Context & Problem Statement',
        'Boundary test.',
        '',
        '## 2. Ticket Decomposition',
        '',
        '### Ticket 1: `T-WIDE` — Wide scope',
        `- **Scope**: ${Array.from({ length: count }, (_, i) => `\`src/f${i + 1}.mjs\``).join(', ')}`,
        '- **Rails**: `src/rail.mjs`',
        '- **Edges**: None',
        '- **Tier**: `mid`',
        '- **Pool Hint**: `gemini`',
        '- **Objectives**:',
        '  1. Touch files.',
        '- **Acceptance Criteria**:',
        '  - `npm test` exits `0`.',
      ].join('\n');

    const spec12 = join(repo, 'spec12.md');
    writeFileSync(spec12, makeWideSpec(12), 'utf8');
    assert.deepEqual(buildPlanPrompts(spec12, { repo }).scopeWarnings, []);

    const spec13 = join(repo, 'spec13.md');
    writeFileSync(spec13, makeWideSpec(13), 'utf8');
    const res13 = buildPlanPrompts(spec13, { repo });
    assert.equal(res13.scopeWarnings.length, 1);
    assert.match(res13.scopeWarnings[0], /maxTicketScope=12/);

    // 6. resolveNullHooksPath cross-platform mapping & agb gate-ticket --help exact syntax
    assert.equal(resolveNullHooksPath('win32'), 'NUL');
    assert.equal(resolveNullHooksPath('linux'), '/dev/null');
    assert.equal(resolveNullHooksPath('darwin'), '/dev/null');
    assert.equal(resolveNullHooksPath(), process.platform === 'win32' ? 'NUL' : '/dev/null');

    const helpOut = execFileSync(process.execPath, [BIN_AGB, 'gate-ticket', '--help'], { encoding: 'utf8' });
    assert.ok(helpOut.includes('agb gate-ticket <ticket-id> [repo]'));
    assert.ok(
      helpOut.includes(
        '[--base <ref> (git base ref)] [--worktree <dir> (candidate worktree)] [--test-cmd <cmd> (test command)] [--build-cmd <cmd> (build command)] [--skip-hollow (skip hollow-test)] [--autocommit (stage and commit dirty worktree)] [--no-manifest (skip gate-manifest recording)] [--json (emit JSON)]'
      )
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
