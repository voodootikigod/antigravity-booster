import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { formatHandoffMarkdown, runTicketHandoff } from '../lib/handoff.mjs';
import { buildPlanPrompts, compilePlan, compilePlanDelta, extractInlinePlanComments } from '../lib/plan.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));
const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

function makeHandoffRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agb-handoff-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ version: 1, securityMode: 'unsigned-fallback' }, null, 2) + '\n');
  initializeDirectoryStore(join(repo, '.adlc', 'tickets'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'widget.mjs'), 'export const v = 1;\n');
  writeFileSync(join(repo, 'src', 'rail.mjs'), 'export const rail = true;\n');
  writeFileSync(
    join(repo, '.adlc', 'tickets', ticketFilename('T-HO-1')),
    JSON.stringify(
      {
        id: 'T-HO-1',
        title: 'Upgrade widget value',
        body: 'Update src/widget.mjs to export v = 2.',
        scope: ['src/widget.mjs'],
        rails: ['src/rail.mjs'],
        edges: [],
      },
      null,
      2
    ) + '\n'
  );
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  return repo;
}

test('runTicketHandoff: covers gate failure, prompt-only, zero-agy fallback, requireProsecutor fail-closed, live fake-agy ship/block, and HTML dossier output', async () => {
  const repo = makeHandoffRepo();
  const htmlDir = mkdtempSync(join(tmpdir(), 'agb-handoff-html-'));
  try {
    // 1. Empty diff fails at gate-ticket stage
    const emptyRes = await runTicketHandoff(repo, 'T-HO-1', {
      base: 'HEAD',
      testCmd: 'node -e "process.exit(0)"',
      sandbox: false,
      skipHollow: true,
      recordManifest: false,
    });
    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.stage, 'gate-ticket');
    const emptyMd = formatHandoffMarkdown(emptyRes);
    assert.match(emptyMd, /^# ADLC Ticket Handoff — `T-HO-1`/m);
    assert.match(emptyMd, /BLOCKED \(gate-ticket\)/);
    assert.match(formatHandoffMarkdown({}), /^# ADLC Ticket Handoff — `unknown`/m);
    assert.match(formatHandoffMarkdown({ ok: false }), /BLOCKED \(failed\)/);

    // 2. Valid in-scope diff in --prompt-only mode
    writeFileSync(join(repo, 'src', 'widget.mjs'), 'export const v = 2;\n');
    const promptRes = await runTicketHandoff(repo, 'T-HO-1', {
      base: 'HEAD',
      testCmd: 'node -e "process.exit(0)"',
      sandbox: false,
      skipHollow: true,
      promptOnly: true,
      recordManifest: false,
    });
    assert.equal(promptRes.ok, true);
    assert.equal(promptRes.prosecution.mode, 'prompt-only');
    assert.match(promptRes.prosecution.prompt, /Update src\/widget\.mjs to export v = 2\./);
    assert.match(promptRes.prosecution.prompt, /\+export const v = 2;/);

    // 3. Missing agy binary degrades to prompt-only-fallback unless requireProsecutor: true
    const fallbackRes = await runTicketHandoff(repo, 'T-HO-1', {
      base: 'HEAD',
      testCmd: 'node -e "process.exit(0)"',
      sandbox: false,
      skipHollow: true,
      agyBin: '/nonexistent/agy-binary',
      recordManifest: false,
    });
    assert.equal(fallbackRes.ok, true);
    assert.equal(fallbackRes.prosecution.mode, 'prompt-only-fallback');

    const reqFail = await runTicketHandoff(repo, 'T-HO-1', {
      base: 'HEAD',
      testCmd: 'node -e "process.exit(0)"',
      sandbox: false,
      skipHollow: true,
      agyBin: '/nonexistent/agy-binary',
      requireProsecutor: true,
      recordManifest: false,
    });
    assert.equal(reqFail.ok, false);
    assert.equal(reqFail.stage, 'prosecute_unavailable');

    // 4. Live prosecution with fake-agy (ship) + HTML dossier output
    const htmlOut = join(htmlDir, 'handoff.html');
    const shipRes = await runTicketHandoff(repo, 'T-HO-1', {
      base: 'HEAD',
      testCmd: 'node -e "process.exit(0)"',
      sandbox: false,
      skipHollow: true,
      agyBin: FAKE_AGY,
      htmlOut,
      recordManifest: false,
    });
    assert.equal(shipRes.ok, true, JSON.stringify(shipRes));
    assert.equal(shipRes.prosecution.verdict, 'ship');
    assert.equal(existsSync(htmlOut), true);
    const md = formatHandoffMarkdown(shipRes);
    assert.match(md, /READY FOR P6 HANDOFF/);
    assert.match(md, /src\/widget\.mjs/);
  } finally {
    rmSync(htmlDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('extractInlinePlanComments and compilePlanDelta preserve untouched tickets, apply IDE review comments, prune removed tickets, and filter parallax prompts', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agb-plan-delta-'));
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'rail.mjs']) {
      writeFileSync(join(repo, 'src', f), 'export default 1;\n');
    }

    const baseSpec = [
      '# Specification: Delta Test',
      '',
      '## 1. Context & Problem Statement',
      'Incremental compilation test.',
      '',
      '## 2. Ticket Decomposition',
      '',
      '### Ticket 1: `T-1` — Alpha',
      '- **Scope**: `src/a.mjs`',
      '- **Rails**: `src/rail.mjs`',
      '- **Edges**: `T-1 -> T-2`',
      '- **Tier**: `cheap`',
      '- **Pool Hint**: `gemini`',
      '- **Objectives**:',
      '  1. Build alpha.',
      '- **Acceptance Criteria**:',
      '  - `npm test` exits `0`.',
      '',
      '### Ticket 2: `T-2` — Beta',
      '- **Scope**: `src/b.mjs`',
      '- **Rails**: `src/rail.mjs`',
      '- **Edges**: `T-2 -> T-3`',
      '- **Tier**: `mid`',
      '- **Pool Hint**: `gemini`',
      '- **Objectives**:',
      '  1. Build beta.',
      '- **Acceptance Criteria**:',
      '  - `npm test` exits `0`.',
      '',
      '### Ticket 3: `T-3` — Gamma',
      '- **Scope**: `src/c.mjs`',
      '- **Rails**: `src/rail.mjs`',
      '- **Edges**: None',
      '- **Tier**: `mid`',
      '- **Pool Hint**: `gemini`',
      '- **Objectives**:',
      '  1. Build gamma.',
      '- **Acceptance Criteria**:',
      '  - `npm test` exits `0`.',
    ].join('\n');

    const baseSpecPath = join(repo, 'spec-v1.md');
    writeFileSync(baseSpecPath, baseSpec, 'utf8');
    const initial = await compilePlan(baseSpecPath, {
      repo,
      coldstart: false,
      parallax: false,
      premortem: false,
    });
    assert.equal(initial.ok, true);
    // Custom marker on T-1 & T-2 to prove verbatim preservation of untouched T-1
    initial.plan.tickets[0].tier = 'frontier';
    initial.plan.gateProvenance = { coldstartHashes: { 'T-1': 'hash-keep-t1', 'T-2': 'hash-drop-t2' } };
    const prevPlanPath = join(repo, 'prev-plan.json');
    writeFileSync(prevPlanPath, JSON.stringify(initial.plan, null, 2) + '\n', 'utf8');

    // v2 spec: T-1 untouched; T-2 receives inline IDE review comment; T-3 removed; T-4 added
    const nextSpec = [
      '# Specification: Delta Test',
      '',
      '## 1. Context & Problem Statement',
      'Incremental compilation test.',
      '',
      '## 2. Ticket Decomposition',
      '',
      '### Ticket 1: `T-1` — Alpha',
      '- **Scope**: `src/a.mjs`',
      '- **Rails**: `src/rail.mjs`',
      '- **Edges**: `T-1 -> T-2`',
      '- **Tier**: `cheap`',
      '- **Pool Hint**: `gemini`',
      '- **Objectives**:',
      '  1. Build alpha.',
      '- **Acceptance Criteria**:',
      '  - `npm test` exits `0`.',
      '',
      '### Ticket 2: `T-2` — Beta',
      '<!-- comment: Ensure null input returns empty array -->',
      '> [!COMMENT] Validate UTF-8 boundary handling',
      '- **Scope**: `src/b.mjs`',
      '- **Rails**: `src/rail.mjs`',
      '- **Edges**: `T-2 -> T-4`',
      '- **Tier**: `mid`',
      '- **Pool Hint**: `gemini`',
      '- **Objectives**:',
      '  1. Build beta.',
      '- **Acceptance Criteria**:',
      '  - `npm test` exits `0`.',
      '',
      '### Ticket 4: `T-4` — Delta',
      '- **Scope**: `src/d.mjs`',
      '- **Rails**: `src/rail.mjs`',
      '- **Edges**: None',
      '- **Tier**: `mid`',
      '- **Pool Hint**: `gemini`',
      '- **Objectives**:',
      '  1. Build delta.',
      '- **Acceptance Criteria**:',
      '  - `npm test` exits `0`.',
    ].join('\n');

    const comments = extractInlinePlanComments(nextSpec);
    assert.equal(comments.byTicket['T-2'].length, 2);
    assert.match(comments.byTicket['T-2'][0], /null input/);
    assert.match(comments.byTicket['T-2'][1], /UTF-8 boundary/);

    const deltaOut = compilePlanDelta(nextSpec, initial.plan, { repo });
    assert.equal(deltaOut.ok, true, JSON.stringify(deltaOut.errors));
    assert.deepEqual(deltaOut.delta.preservedTicketIds, ['T-1']);
    assert.deepEqual(deltaOut.delta.changedTicketIds, ['T-2']);
    assert.deepEqual(deltaOut.delta.addedTicketIds, ['T-4']);
    assert.deepEqual(deltaOut.delta.removedTicketIds, ['T-3']);

    // Untouched T-1 kept its customized tier ('frontier') & coldstart hash; T-2 got review comments appended!
    const t1 = deltaOut.plan.tickets.find((t) => t.id === 'T-1');
    const t2 = deltaOut.plan.tickets.find((t) => t.id === 'T-2');
    assert.equal(t1.tier, 'frontier');
    assert.equal(deltaOut.plan.gateProvenance.coldstartHashes['T-1'], 'hash-keep-t1');
    assert.equal(deltaOut.plan.gateProvenance.coldstartHashes['T-2'], undefined);
    assert.match(t2.body, /Inline Review Directives:/);
    assert.match(t2.body, /Ensure null input returns empty array/);

    // compilePlan & buildPlanPrompts with deltaFrom path (and symlink rejection)
    const nextSpecPath = join(repo, 'spec-v2.md');
    writeFileSync(nextSpecPath, nextSpec, 'utf8');
    const compiledDelta = await compilePlan(nextSpecPath, {
      repo,
      deltaFrom: prevPlanPath,
      coldstart: false,
      parallax: false,
      premortem: false,
    });
    assert.equal(compiledDelta.ok, true);
    assert.deepEqual(compiledDelta.report.delta.preservedTicketIds, ['T-1']);

    const promptsDelta = buildPlanPrompts(nextSpecPath, { repo, deltaFrom: prevPlanPath });
    assert.equal(promptsDelta.ok, true);
    assert.deepEqual(promptsDelta.delta.preservedTicketIds, ['T-1']);
    // Both T-1 -> T-2 and T-2 -> T-4 touch dirty T-2/T-4; if neither T-1 nor T-2 changed, T-1 -> T-2 is skipped!
    const promptsSame = buildPlanPrompts(baseSpecPath, { repo, deltaFrom: prevPlanPath });
    assert.equal(promptsSame.prompts.parallax.length, 0, 'untouched edges must skip parallax prompts in --delta mode');

    const symPrev = join(repo, 'sym-prev.json');
    symlinkSync(prevPlanPath, symPrev);
    assert.throws(() => buildPlanPrompts(nextSpecPath, { repo, deltaFrom: symPrev }), /symbolic link/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('bin/agb.mjs CLI: wires handoff, gate-ticket --skip-browser, plan --delta, and init --automations', () => {
  const repo = makeHandoffRepo();
  const initRepo = mkdtempSync(join(tmpdir(), 'agb-cli-init-auto-'));
  try {
    // 1. Help surfaces for handoff, gate-ticket, plan, and init
    const handoffHelp = execFileSync(process.execPath, [AGB_BIN, 'handoff', '--help'], { encoding: 'utf8' });
    assert.match(handoffHelp, /agb handoff <ticket-id> \[repo\]/);
    assert.match(handoffHelp, /--require-prosecutor/);
    assert.match(handoffHelp, /--browser-url <url>/);

    const gateHelp = execFileSync(process.execPath, [AGB_BIN, 'gate-ticket', '--help'], { encoding: 'utf8' });
    assert.match(gateHelp, /--skip-browser/);
    assert.match(gateHelp, /--browser-url <url>/);

    const planHelp = execFileSync(process.execPath, [AGB_BIN, 'plan', '--help'], { encoding: 'utf8' });
    assert.match(planHelp, /--delta <prev-plan\.json>/);

    const initHelp = execFileSync(process.execPath, [AGB_BIN, 'init', '--help'], { encoding: 'utf8' });
    assert.match(initHelp, /--automations/);

    // 2. Missing ticketId exits 1; empty diff exits 2
    const missingId = spawnSync(process.execPath, [AGB_BIN, 'handoff'], { encoding: 'utf8' });
    assert.equal(missingId.status, 1);
    assert.match(missingId.stderr, /usage: agb handoff/);

    const emptyHandoff = spawnSync(
      process.execPath,
      [AGB_BIN, 'handoff', 'T-HO-1', repo, '--test-cmd', 'true', '--skip-hollow', '--skip-browser', '--no-manifest'],
      { encoding: 'utf8', env: { ...process.env, AGB_SANDBOX_GATES: '0' } }
    );
    assert.equal(emptyHandoff.status, 2);
    assert.match(emptyHandoff.stdout, /BLOCKED \(gate-ticket\)/);
    assert.match(emptyHandoff.stderr, /handoff T-HO-1: FAIL \[gate-ticket\]/);

    // 3. Passing handoff in --prompt-only (Markdown + prompt) and --json modes
    writeFileSync(join(repo, 'src', 'widget.mjs'), 'export const v = 2;\n');
    const promptHandoff = spawnSync(
      process.execPath,
      [
        AGB_BIN,
        'handoff',
        'T-HO-1',
        repo,
        '--test-cmd',
        'true',
        '--skip-hollow',
        '--skip-browser',
        '--no-manifest',
        '--prompt-only',
      ],
      { encoding: 'utf8', env: { ...process.env, AGB_SANDBOX_GATES: '0' } }
    );
    assert.equal(promptHandoff.status, 0, promptHandoff.stderr);
    assert.match(promptHandoff.stdout, /READY FOR P6 HANDOFF/);
    assert.match(promptHandoff.stdout, /=== PROSECUTOR PROMPT/);

    const jsonHandoff = spawnSync(
      process.execPath,
      [
        AGB_BIN,
        'handoff',
        'T-HO-1',
        repo,
        '--test-cmd',
        'true',
        '--skip-hollow',
        '--skip-browser',
        '--no-prosecute',
        '--no-manifest',
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, AGB_SANDBOX_GATES: '0' } }
    );
    assert.equal(jsonHandoff.status, 0, jsonHandoff.stderr);
    const parsedHandoff = JSON.parse(jsonHandoff.stdout);
    assert.equal(parsedHandoff.ok, true);
    assert.equal(parsedHandoff.prosecution.mode, 'skipped');

    // 4. gate-ticket CLI --skip-browser
    const gtCli = spawnSync(
      process.execPath,
      [AGB_BIN, 'gate-ticket', 'T-HO-1', repo, '--base', 'HEAD', '--test-cmd', 'true', '--skip-hollow', '--skip-browser', '--no-manifest', '--json'],
      { encoding: 'utf8', env: { ...process.env, AGB_SANDBOX_GATES: '0' } }
    );
    assert.equal(gtCli.status, 0, gtCli.stderr);
    assert.equal(JSON.parse(gtCli.stdout).stages.browserGate.skipped, true);

    // 5. plan --delta CLI missing value exits 1, valid --delta --prompt-only --json exits 0
    const badDelta = spawnSync(process.execPath, [AGB_BIN, 'plan', 'spec.md', '--delta'], { encoding: 'utf8' });
    assert.equal(badDelta.status, 1);

    const specPath = join(repo, 'cli-spec.md');
    writeFileSync(
      specPath,
      [
        '# Specification: CLI Delta',
        '## 1. Context & Problem Statement',
        'Test CLI delta.',
        '## 2. Ticket Decomposition',
        '### Ticket 1: `T-HO-1` — Widget',
        '<!-- comment: Preserve export signature -->',
        '- **Scope**: `src/widget.mjs`',
        '- **Rails**: `src/rail.mjs`',
        '- **Edges**: None',
        '- **Tier**: `mid`',
        '- **Pool Hint**: `gemini`',
        '- **Objectives**:',
        '  1. Update widget.',
        '- **Acceptance Criteria**:',
        '  - `npm test` passes.',
      ].join('\n'),
      'utf8'
    );
    const prevPlanPath = join(repo, 'cli-prev-plan.json');
    writeFileSync(
      prevPlanPath,
      JSON.stringify({
        repo,
        tickets: [{ id: 'T-HO-1', title: 'Widget', body: 'Old', scope: ['src/widget.mjs'], rails: ['src/rail.mjs'], deps: [] }],
      }) + '\n'
    );
    const cliPlanDelta = spawnSync(
      process.execPath,
      [AGB_BIN, 'plan', specPath, repo, '--delta', prevPlanPath, '--prompt-only', '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(cliPlanDelta.status, 0, cliPlanDelta.stderr);
    const parsedDelta = JSON.parse(cliPlanDelta.stdout);
    assert.deepEqual(parsedDelta.delta.changedTicketIds, ['T-HO-1']);

    // 6. init --automations CLI scaffolds .agents/automations
    const initOut = spawnSync(process.execPath, [AGB_BIN, 'init', initRepo, '--automations'], { encoding: 'utf8' });
    assert.equal(initOut.status, 0, initOut.stderr);
    const parsedInit = JSON.parse(initOut.stdout);
    assert.equal(parsedInit.ok, true);
    assert.equal(existsSync(join(initRepo, '.agents', 'automations', 'agb-quota-resume.json')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(initRepo, { recursive: true, force: true });
  }
});

