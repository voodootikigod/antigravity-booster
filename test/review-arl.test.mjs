import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODE_LENSES,
  PLAN_LENSES,
  ARL_FINDING_SCHEMA,
  ARBITER_TRIAGE_SCHEMA,
  normalizeSeverity,
  arbiterPrompt,
  triageFindings,
  reviewPlan,
  reviewFleet,
  canUsePostRunSeams,
} from '../lib/review.mjs';

// Keep offline unit tests isolated from host GEMINI_API_KEY auto-detection;
// tests that explicitly pass a mock decisionEngine still exercise System-1 paths.
process.env.AGB_DECISION_ENGINE = '0';
import { ARL_LENS_MODELS, CODE_ARL_LENSES, PLAN_ARL_LENSES, ALL_MODELS } from '../lib/models.mjs';
import { DecisionEngine } from '../lib/decision-engine.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

test('normalizeSeverity maps ARL and ADLC severities onto canonical scale', () => {
  assert.equal(normalizeSeverity('blocker'), 'critical');
  assert.equal(normalizeSeverity('critical'), 'critical');
  assert.equal(normalizeSeverity('major'), 'high');
  assert.equal(normalizeSeverity('high'), 'high');
  assert.equal(normalizeSeverity('minor'), 'medium');
  assert.equal(normalizeSeverity('medium'), 'medium');
  assert.equal(normalizeSeverity('nit'), 'low');
  assert.equal(normalizeSeverity('low'), 'low');
});

test('ARL_LENS_MODELS maps all 5 code lenses, 5 plan lenses, and arbiter to live catalog slugs', () => {
  const liveSet = new Set(ALL_MODELS);
  for (const lens of CODE_ARL_LENSES) {
    assert.ok(CODE_LENSES[lens], `CODE_LENSES missing ${lens}`);
    assert.ok(ARL_LENS_MODELS[lens], `ARL_LENS_MODELS missing ${lens}`);
    assert.ok(liveSet.has(ARL_LENS_MODELS[lens].primary), `${lens} primary not in ALL_MODELS`);
    assert.ok(liveSet.has(ARL_LENS_MODELS[lens].fallback), `${lens} fallback not in ALL_MODELS`);
  }
  for (const lens of PLAN_ARL_LENSES) {
    assert.ok(PLAN_LENSES[lens], `PLAN_LENSES missing ${lens}`);
    assert.ok(ARL_LENS_MODELS[lens], `ARL_LENS_MODELS missing ${lens}`);
    assert.ok(liveSet.has(ARL_LENS_MODELS[lens].primary), `${lens} primary not in ALL_MODELS`);
    assert.ok(liveSet.has(ARL_LENS_MODELS[lens].fallback), `${lens} fallback not in ALL_MODELS`);
  }
  assert.ok(liveSet.has(ARL_LENS_MODELS.arbiter.primary));
  assert.ok(liveSet.has(ARL_LENS_MODELS.arbiter.fallback));
});

test('triageFindings deterministic mode deduplicates, drops nit/low without blast_radius, and routes plan findings', async () => {
  const raw = [
    {
      severity: 'major',
      file: 'lib/a.mjs',
      claim: 'Missing null guard on input',
      evidence: 'line 42 dereferences input.foo',
      resolution_route: 'auto-fix',
    },
    {
      severity: 'blocker',
      file: 'lib/a.mjs',
      claim: 'Missing null guard on input',
      evidence: 'line 42 dereferences input.foo directly',
      resolution_route: 'auto-fix',
    },
    {
      severity: 'nit',
      file: 'lib/b.mjs',
      claim: 'Rename variable x to idx',
      evidence: 'style preference',
    },
    {
      severity: 'nit',
      file: 'lib/c.mjs',
      claim: 'Cross-cutting auth token format ambiguity',
      evidence: 'impacts all callers',
      blast_radius: true,
      resolution_route: 'grill-me',
    },
  ];

  const res = await triageFindings({
    findings: raw,
    targetType: 'plan',
    arbiter: false,
  });

  assert.equal(res.gateVerdict, 'ITERATE');
  assert.equal(res.surviving.length, 2);
  assert.equal(res.dropped.length, 1);
  assert.equal(res.autoFixFindings.length, 1);
  assert.equal(res.autoFixFindings[0].severity, 'critical');
  assert.equal(res.grillMeFindings.length, 1);
  assert.equal(res.grillMeFindings[0].verdict, 'escalate');
});

test('reviewPlan flags unstructured spec with SHAPE-000 critical auto-fix finding', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  try {
    const res = await reviewPlan({
      specContent: '# Unstructured Idea\n\nJust some notes without ticket sections.\n',
      arbiter: false,
      lenses: ['dag_topology'],
    });
    assert.equal(res.ok, false);
    assert.equal(res.gateVerdict, 'ITERATE');
    assert.ok(res.autoFixFindings.some((f) => f.id === 'SHAPE-000'));
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
  }
});

test('reviewPlan returns SHIP on a valid structured spec when lenses report 0 blocking findings', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agb-plan-arl-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  try {
    writeFileSync(join(tmpDir, 'mod.mjs'), 'export const x = 1;\n');
    const specMd = [
      '# Clean Spec',
      '',
      '### Ticket 1: `T-1` — Clean Ticket',
      '- **Scope**: `mod.mjs`',
      '- **Rails**: (none)',
      '- **Edges**: (none)',
      '- **Acceptance Criteria**:',
      '  - `mod.mjs` exports `x === 1`.',
      '',
    ].join('\n');

    const res = await reviewPlan({
      specContent: specMd,
      repo: tmpDir,
      arbiter: false,
      lenses: ['dag_topology', 'simplicity'],
    });
    assert.equal(res.shapeReport.ok, true);
    assert.equal(res.ok, true);
    assert.equal(res.gateVerdict, 'SHIP');
    assert.equal(res.findings.length, 0);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reviewFleet supports fiveLens mode with CODE_LENSES and ARL_FINDING_SCHEMA', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  try {
    assert.ok(ARL_FINDING_SCHEMA.required.includes('findings'));
    assert.ok(ARBITER_TRIAGE_SCHEMA.required.includes('gate_verdict'));
    const res = await reviewFleet({
      diff: 'diff --git a/a.mjs b/a.mjs\n+export const y = 2;\n',
      fiveLens: true,
      arbiter: false,
      dryRounds: 1,
      maxRounds: 1,
    });
    assert.equal(res.converged, true);
    assert.equal(res.requests, 5);
    assert.equal(res.gateVerdict, 'SHIP');
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
  }
});

test('triageFindings arbiter reconciliation preserves blast_radius / SHAPE-* blockers and selectLensModel respects PoolSet capacity', async () => {
  const { PoolSet } = await import('../lib/pools.mjs');
  const tmpQuotaDir = mkdtempSync(join(tmpdir(), 'agb-review-arl-quota-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevQuota = process.env.AGB_QUOTA_STATE;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.AGB_QUOTA_STATE = join(tmpQuotaDir, 'pools.json');
  try {
    // fake-agy emits default JSON (`{"findings":[]}` / empty triaged), so reconciliation must rescue blast_radius & SHAPE-000!
    const raw = [
      {
        id: 'SHAPE-000',
        lens: 'shape',
        severity: 'blocker',
        confidence: 'high',
        location: 'spec.md',
        claim: 'Spec lacks structured tickets',
        evidence: '0 tickets parsed',
        resolution_route: 'auto-fix',
      },
      {
        id: 'SEC-1',
        lens: 'security',
        severity: 'minor',
        confidence: 0.9,
        location: 'lib/auth.mjs:10',
        claim: 'Auth bypass surface',
        evidence: 'missing token check',
        blast_radius: true,
        resolution_route: 'grill-me',
      },
      {
        id: 'LOW-CONF-1',
        lens: 'simplicity',
        severity: 'minor',
        confidence: 0.2,
        location: 'lib/x.mjs',
        claim: 'Speculative hunch without evidence',
        evidence: '',
      },
    ];
    const det = await triageFindings({ findings: raw, targetType: 'plan', arbiter: false });
    assert.equal(det.dropped.some((d) => d.id === 'LOW-CONF-1'), true);

    const arb = await triageFindings({ findings: raw, targetType: 'plan', arbiter: true });
    assert.equal(arb.gateVerdict, 'ITERATE');
    assert.equal(arb.surviving.some((f) => f.id === 'SHAPE-000'), true);
    assert.equal(arb.surviving.some((f) => f.id === 'SEC-1'), true);

    // PoolSet with claude cap = 0 forces cross-family fallback to gemini-4-argon-high
    const pools = new PoolSet({ claude: 0, 'gemini-pro': 4, 'gemini-flash': 4 });
    const res = await reviewFleet({
      diff: 'diff --git a/x.mjs b/x.mjs\n+export const z = 3;\n',
      pools,
      fiveLens: true,
      arbiter: false,
      dryRounds: 1,
      maxRounds: 1,
    });
    assert.equal(res.converged, true);

    // Multi-round reviewPlan deduplicates findings across rounds when round 1 raises a finding and round 2 repeats it
    const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
    process.env.FAKE_PROSECUTOR_VERDICT = 'block';
    try {
      const loopRes = await reviewPlan({
        specContent: '# Unstructured\nNo tickets here.\n',
        arbiter: false,
        loop: true,
        maxRounds: 2,
        lenses: ['simplicity'],
      });
      assert.equal(loopRes.rounds, 2);
      assert.equal(loopRes.findings.filter((f) => f.id === 'SHAPE-000').length, 1);
      assert.equal(loopRes.findings.filter((f) => f.claim === 'wrong content').length, 1);
    } finally {
      if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT;
      else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
    }

    // ARB-017: reviewFleet must emit gateVerdict === 'ITERATE' when a minor/low blast_radius finding survives arbiter triage
    const blastAgy = join(tmpQuotaDir, 'fake-agy-blast.mjs');
    writeFileSync(
      blastAgy,
      [
        '#!/usr/bin/env node',
        "let buf = ''; process.stdin.on('data', c => buf += c);",
        "process.stdin.on('end', () => {",
        "  if (buf.includes('neutral arbiter')) {",
        "    console.log(JSON.stringify({ status: 'ok', structured_output: { gate_verdict: 'ITERATE', summary: 'blast radius escalated', triaged: [] } }));",
        '  } else {',
        "    console.log(JSON.stringify({ status: 'ok', structured_output: { findings: [{ id: 'BR-1', severity: 'minor', file: 'lib/auth.mjs', claim: 'Auth boundary ambiguity', evidence: 'line 12', blast_radius: true }] } }));",
        '  }',
        '});',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = blastAgy;
    const fleetBlast = await reviewFleet({
      diff: 'diff --git a/lib/auth.mjs b/lib/auth.mjs\n+export const ok = true;\n',
      fiveLens: true,
      lenses: ['security'],
      arbiter: true,
      dryRounds: 1,
      maxRounds: 2,
    });
    assert.equal(fleetBlast.converged, true);
    assert.equal(fleetBlast.gateVerdict, 'ITERATE');
    assert.equal(fleetBlast.triage?.gateVerdict, 'ITERATE');
    assert.ok(fleetBlast.findings.some((f) => f.blast_radius === true && f.verdict === 'escalate'));
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
    if (prevQuota === undefined) delete process.env.AGB_QUOTA_STATE;
    else process.env.AGB_QUOTA_STATE = prevQuota;
    rmSync(tmpQuotaDir, { recursive: true, force: true });
  }
});

test('triageFindings & arbiterPrompt: sorts 65 low + 2 critical/high findings by severity priority before slicing 60 and merges overflow via deterministicTriage', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agb-arbiter-overflow-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    const lowFindings = Array.from({ length: 65 }, (_, i) => ({
      id: `LOW-${i}`,
      lens: 'anti_slop',
      severity: 'low',
      file: `lib/low-${i}.mjs`,
      claim: `Minor style nit ${i}`,
      evidence: `line ${i + 1}`,
    }));
    const raw67 = [
      ...lowFindings,
      {
        id: 'CRIT-TAIL',
        lens: 'security',
        severity: 'critical',
        file: 'lib/auth.mjs',
        claim: 'Unauthenticated admin endpoint',
        evidence: 'missing auth middleware on /admin',
        resolution_route: 'auto-fix',
      },
      {
        id: 'HIGH-TAIL',
        lens: 'correctness_redteam',
        severity: 'high',
        file: 'lib/store.mjs',
        claim: 'Race condition drops concurrent writes',
        evidence: 'non-atomic read-modify-write at line 42',
        resolution_route: 'auto-fix',
      },
    ];

    // 1. arbiterPrompt puts critical/high ahead of the 65 lows inside the 60-item cap
    const promptText = arbiterPrompt(raw67, { targetType: 'code' });
    assert.ok(promptText.includes('CRIT-TAIL'), 'critical finding must be prioritized into arbiter prompt');
    assert.ok(promptText.includes('HIGH-TAIL'), 'high finding must be prioritized into arbiter prompt');
    assert.ok(promptText.indexOf('CRIT-TAIL') < promptText.indexOf('HIGH-TAIL'), 'critical must precede high');
    assert.ok(promptText.indexOf('HIGH-TAIL') < promptText.indexOf('LOW-0'), 'high must precede low');
    assert.ok(!promptText.includes('"LOW-64"'), 'trailing low findings beyond index 60 must be omitted from prompt');

    // 2. triageFindings with LLM arbiter preserves both critical/high findings and produces non-SHIP verdict
    const promptCapturePath = join(tmpDir, 'arbiter-prompt.txt');
    const fakeArbiter = join(tmpDir, 'fake-agy-arbiter.cjs');
    writeFileSync(
      fakeArbiter,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const printIdx = process.argv.indexOf("--print");',
        "let buf = '';",
        "process.stdin.on('data', (c) => (buf += c));",
        "process.stdin.on('end', () => {",
        '  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;',
        `  fs.writeFileSync(${JSON.stringify(promptCapturePath)}, prompt);`,
        "  const m = prompt.match(/<<UNTRUSTED:FINDINGS:[^>]+>>\\n([\\s\\S]*?)\\n<<END:FINDINGS:/);",
        '  const batch = m ? JSON.parse(m[1]) : [];',
        '  const triaged = batch.map((f) => ({',
        '    id: f.id,',
        '    severity: f.severity,',
        '    file: f.file,',
        '    claim: f.claim,',
        '    evidence: f.evidence,',
        "    verdict: f.severity === 'critical' || f.severity === 'high' ? 'accept-candidate' : 'drop',",
        "    resolution_route: 'auto-fix',",
        '  }));',
        "  console.log(JSON.stringify({ status: 'ok', structured_output: { gate_verdict: 'SHIP', summary: 'triaged batch', triaged } }));",
        '});',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = fakeArbiter;

    const res = await triageFindings({ findings: raw67, targetType: 'code', arbiter: true });
    assert.equal(res.arbiterDegraded, undefined, 'fake arbiter must succeed without degrading');
    assert.equal(res.gateVerdict, 'ITERATE', 'critical/high findings must never produce SHIP');
    assert.ok(res.surviving.some((f) => f.id === 'CRIT-TAIL'), 'CRIT-TAIL must survive triage');
    assert.ok(res.surviving.some((f) => f.id === 'HIGH-TAIL'), 'HIGH-TAIL must survive triage');
    assert.equal(res.triaged.length, 67, 'all 67 findings (60 arbiter + 7 overflow) must be accounted for');
    assert.equal(res.dropped.length, 65, 'all 65 low findings should be dropped');

    // 3. When >60 critical/high findings overflow past index 60, overflow findings are triaged deterministically
    //    and prevent a false-green SHIP even if the arbiter dropped everything in its 60-item batch.
    const dropAllArbiter = join(tmpDir, 'fake-agy-drop-all.cjs');
    writeFileSync(
      dropAllArbiter,
      [
        '#!/usr/bin/env node',
        'const printIdx = process.argv.indexOf("--print");',
        "let buf = '';",
        "process.stdin.on('data', (c) => (buf += c));",
        "process.stdin.on('end', () => {",
        '  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;',
        "  const m = prompt.match(/<<UNTRUSTED:FINDINGS:[^>]+>>\\n([\\s\\S]*?)\\n<<END:FINDINGS:/);",
        '  const batch = m ? JSON.parse(m[1]) : [];',
        '  const triaged = batch.map((f) => ({',
        '    id: f.id,',
        '    severity: f.severity,',
        '    file: f.file,',
        '    claim: f.claim,',
        '    evidence: f.evidence,',
        "    verdict: 'drop',",
        "    resolution_route: 'auto-fix',",
        '  }));',
        "  console.log(JSON.stringify({ status: 'ok', structured_output: { gate_verdict: 'SHIP', summary: 'dropped all 60', triaged } }));",
        '});',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = dropAllArbiter;

    const sixtyThreeHighs = Array.from({ length: 63 }, (_, i) => ({
      id: `HIGH-${i}`,
      lens: 'security',
      severity: i < 2 ? 'critical' : 'high',
      file: `lib/mod-${i}.mjs`,
      claim: `Concrete blocking defect ${i}`,
      evidence: `reproducible stack trace ${i}`,
    }));
    const overflowRes = await triageFindings({ findings: sixtyThreeHighs, targetType: 'code', arbiter: true });
    assert.equal(overflowRes.arbiterDegraded, undefined, 'drop-all arbiter must succeed without degrading');
    assert.equal(overflowRes.gateVerdict, 'ITERATE', 'overflow high findings must prevent false-green SHIP');
    assert.equal(overflowRes.surviving.length, 3, 'all 3 overflow high findings must survive deterministic triage');
    assert.ok(overflowRes.surviving.some((f) => f.id === 'HIGH-60'));
    assert.ok(overflowRes.surviving.some((f) => f.id === 'HIGH-61'));
    assert.ok(overflowRes.surviving.some((f) => f.id === 'HIGH-62'));
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reviewPlan({ loop: true }): recomputes shapeReport on round > 1 after specPath is updated and clears stale Round 1 SHAPE-* findings', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agb-plan-round2-shape-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    writeFileSync(join(tmpDir, 'mod.mjs'), 'export const x = 1;\n');
    const specPath = join(tmpDir, 'spec.md');
    writeFileSync(specPath, '# Unstructured Draft\n\nNo ticket headings yet.\n');

    const cleanSpec = [
      '# Clean Spec',
      '',
      '### Ticket 1: `T-1` — Clean Ticket',
      '- **Scope**: `mod.mjs`',
      '- **Rails**: (none)',
      '- **Edges**: (none)',
      '- **Acceptance Criteria**:',
      '  - `mod.mjs` exports `x === 1`.',
      '',
    ].join('\n');

    const promptsDir = join(tmpDir, 'prompts');
    const countFile = join(tmpDir, 'round-count.txt');
    const fakePlanAgy = join(tmpDir, 'fake-plan-agy.cjs');
    writeFileSync(
      fakePlanAgy,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `const countFile = ${JSON.stringify(countFile)};`,
        `const promptsDir = ${JSON.stringify(promptsDir)};`,
        'const printIdx = process.argv.indexOf("--print");',
        "let buf = '';",
        "process.stdin.on('data', (c) => (buf += c));",
        "process.stdin.on('end', () => {",
        '  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;',
        '  fs.mkdirSync(promptsDir, { recursive: true });',
        "  const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;",
        '  fs.writeFileSync(countFile, String(n));',
        "  fs.writeFileSync(promptsDir + '/round-' + n + '.txt', prompt);",
        '  if (n === 1) {',
        "    console.log(JSON.stringify({ status: 'ok', structured_output: { findings: [{ severity: 'medium', file: 'spec.md', claim: 'Round 1 non-blocking suggestion', evidence: 'line 1', resolution_route: 'auto-fix' }] } }));",
        '  } else {',
        "    console.log(JSON.stringify({ status: 'ok', structured_output: { findings: [] } }));",
        '  }',
        '});',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = fakePlanAgy;

    const res = await reviewPlan({
      specPath,
      repo: tmpDir,
      arbiter: false,
      loop: true,
      maxRounds: 3,
      lenses: ['dag_topology'],
      log: (msg) => {
        if (msg.includes('round 1:')) {
          writeFileSync(specPath, cleanSpec);
        }
      },
    });

    assert.equal(res.rounds, 2);
    assert.equal(res.shapeReport.structured, true, 'Round 2 must recompute shapeReport on updated spec');
    assert.equal(res.shapeReport.ok, true, 'Updated spec shapeReport must be ok');
    assert.equal(
      res.findings.some((f) => typeof f.id === 'string' && f.id.startsWith('SHAPE-')),
      false,
      'stale Round 1 SHAPE-* findings must not be carried forward into Round 2'
    );
    assert.equal(res.ok, true);
    assert.equal(res.gateVerdict, 'SHIP');

    const { readFileSync } = await import('node:fs');
    const round1Prompt = readFileSync(join(promptsDir, 'round-1.txt'), 'utf8');
    const round2Prompt = readFileSync(join(promptsDir, 'round-2.txt'), 'utf8');
    assert.match(round1Prompt, /"structured":\s*false/);
    assert.match(round2Prompt, /"structured":\s*true/);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exported lensPrompt and planLensPrompt share 100% byte-identical Layer-1/Layer-2 prefixes across all 5 lenses up to ## Active Lens', async () => {
  const { CODE_LENSES, PLAN_LENSES, lensPrompt, planLensPrompt } = await import('../lib/review.mjs');
  const seed = '0123456789abcdef0123456789abcdef0123456789abcdef';
  const diff = 'diff --git a/lib/x.mjs b/lib/x.mjs\n+export const k = 1;\n';
  const codePrompts = Object.entries(CODE_LENSES).map(([name, desc]) =>
    lensPrompt(name, desc, diff, 'shared context', undefined, { seed })
  );
  assert.equal(codePrompts.length, 5);
  const codePrefixes = codePrompts.map((p) => p.split('\n\n## Active Lens\n')[0]);
  assert.ok(codePrefixes[0].length > 300);
  for (let i = 1; i < codePrefixes.length; i++) {
    assert.equal(codePrefixes[i], codePrefixes[0], `Code lens ${i} prefix must match lens 0 byte-for-byte`);
  }

  const specText = '# Feature Spec\n### Ticket 1: `T1`\n- **Scope**: `lib/x.mjs`\n';
  const shapeJson = '{"ok":true,"readinessScore":100}';
  const planPrompts = Object.entries(PLAN_LENSES).map(([name, desc]) =>
    planLensPrompt(name, desc, specText, shapeJson, 'plan ctx', undefined, { seed })
  );
  assert.equal(planPrompts.length, 5);
  const planPrefixes = planPrompts.map((p) => p.split('\n\n## Active Lens\n')[0]);
  assert.ok(planPrefixes[0].includes(shapeJson));
  for (let i = 1; i < planPrefixes.length; i++) {
    assert.equal(planPrefixes[i], planPrefixes[0], `Plan lens ${i} prefix must match lens 0 byte-for-byte`);
  }

  // Oversized diff prioritizes source files ahead of dist/ bundles and preserves closing fence + ## Active Lens
  const hugeDist = `diff --git a/dist/agb.mjs b/dist/agb.mjs\n+${'x'.repeat(220_000)}\n`;
  const realSrc = `diff --git a/lib/core.mjs b/lib/core.mjs\n+export const keepMe = 42;\n`;
  const boundedPrompt = lensPrompt('security', CODE_LENSES.security, `${hugeDist}${realSrc}`, '', undefined, { seed });
  assert.match(boundedPrompt, /export const keepMe = 42/);
  assert.match(boundedPrompt, /<<END:DIFF:[0-9a-f]{32}>>\n\n## Active Lens/);
  assert.match(boundedPrompt, /Review strictly through exactly one lens: \*\*security\*\*/);
});

test('reviewFleet and reviewPlan fail closed (ITERATE + truncated: true + preserved finding) when payload > 180k chars', async () => {
  const prevAgy = process.env.AGB_AGY_BIN;
  const prevVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
  const tmpDir = mkdtempSync(join(tmpdir(), 'agb-trunc-plan-'));
  try {
    const oversizedDiff = `diff --git a/lib/big.mjs b/lib/big.mjs\n+${'a'.repeat(185_000)}\n`;
    const fleetRes = await reviewFleet({
      diff: oversizedDiff,
      lenses: ['correctness'],
      fiveLens: true,
      arbiter: true,
      dryRounds: 1,
      maxRounds: 1,
    });
    assert.equal(fleetRes.truncated, true);
    assert.equal(fleetRes.converged, false);
    assert.equal(fleetRes.gateVerdict, 'ITERATE');
    assert.ok(fleetRes.findings.some((f) => f.id === 'PAYLOAD-TRUNCATED' && f.severity === 'critical'));

    const specPath = join(tmpDir, 'spec.md');
    writeFileSync(specPath, [
      '# Truncated Spec',
      '### Ticket 1: `T1` — Sample',
      '- **Scope**: `lib/a.mjs`',
      '- **Rails**: `lib/lock.mjs`',
      '- **Edges**: (none)',
      '- **Body**: ' + 'x'.repeat(185_000),
      '- **Acceptance Criteria**:\n  - Runs tests. Verify: `npm test`',
      '## Acceptance Criteria',
      '- [ ] Runs tests. Verify: `npm test`',
    ].join('\n'));
    const planRes = await reviewPlan({
      specPath,
      repo: tmpDir,
      lenses: ['devils_advocate'],
      arbiter: true,
      loop: false,
    });
    assert.equal(planRes.ok, false);
    assert.equal(planRes.truncated, true);
    assert.equal(planRes.gateVerdict, 'ITERATE');
    assert.ok(planRes.findings.some((f) => f.id === 'PAYLOAD-TRUNCATED' && f.severity === 'critical'));
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    if (prevVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = prevVerdict;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('canUsePostRunSeams validates manifest.jsonl and segmented manifest.d/*.jsonl, rejecting unprosecuted or system1 fast-shipped commits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-seams-gate-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    g('add', 'base.txt');
    g('commit', '-qm', 'base');
    const baseSha = g('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    g('add', 'a.mjs');
    g('commit', '-qm', 'T1 commit');
    const sha1 = g('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'b.mjs'), 'export const b = 2;\n');
    g('add', 'b.mjs');
    g('commit', '-qm', 'T2 commit');
    const sha2 = g('rev-parse', 'HEAD');

    // Invalid ref & missing manifest fail closed
    assert.equal(canUsePostRunSeams(dir, '--all').eligible, false);
    assert.equal(canUsePostRunSeams(dir, `${baseSha}..HEAD`).eligible, false);

    // 1. manifest.jsonl covers only sha1 -> sha2 unprosecuted -> eligible: false
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(
      join(dir, '.adlc', 'manifest.jsonl'),
      JSON.stringify({
        seq: 1,
        gate: 'merge-prosecution',
        ticket: 'T-1',
        data: { mergedShas: [sha1], fastShipped: false, scope: ['a.mjs'] },
      }) + '\n'
    );
    const partial = canUsePostRunSeams(dir, `${baseSha}..HEAD`);
    assert.equal(partial.eligible, false);
    assert.match(partial.reason, /unprosecuted/);

    // 2. Segmented manifest.d/seg-1.jsonl covers sha2 with system1 fast-ship -> eligible: false
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    const segPath = join(dir, '.adlc', 'manifest.d', 'seg-1.jsonl');
    writeFileSync(
      segPath,
      JSON.stringify({
        seq: 1,
        gate: 'merge-prosecution',
        ticket: 'T-2',
        data: { mergedShas: [sha2], fastShipped: 'system1', scope: ['b.mjs'] },
      }) + '\n'
    );
    const sys1Rejected = canUsePostRunSeams(dir, `${baseSha}..HEAD`);
    assert.equal(sys1Rejected.eligible, false);
    assert.match(sys1Rejected.reason, /system1/i);

    // 3. Boolean fastShipped: true also rejected
    writeFileSync(
      segPath,
      JSON.stringify({
        seq: 1,
        gate: 'merge-prosecution',
        ticket: 'T-2',
        data: { mergedShas: [sha2], fastShipped: true, scope: ['b.mjs'] },
      }) + '\n'
    );
    assert.equal(canUsePostRunSeams(dir, `${baseSha}..HEAD`).eligible, false);

    // 4. Clean non-system1 prosecution in segmented manifest.d -> eligible: true + ticketScopes populated
    writeFileSync(
      segPath,
      JSON.stringify({
        seq: 1,
        gate: 'prosecution',
        ticket: 'T-2',
        data: { verdict: 'ship', sha: sha2, fastShipped: false, scope: ['b.mjs'] },
      }) + '\n'
    );
    const okRes = canUsePostRunSeams(dir, `${baseSha}..HEAD`);
    assert.equal(okRes.eligible, true);
    assert.deepEqual(okRes.ticketScopes, [
      { id: 'T-1', scope: ['a.mjs'] },
      { id: 'T-2', scope: ['b.mjs'] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewFleet({ seamsOnly: true }): slices cross-ticket seams, runs targeted seam lenses, and short-circuits disjoint diffs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-seams-fleet-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    mkdirSync(join(dir, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'a.mjs'), 'export function sharedApi() { return 1; }\n');
    writeFileSync(join(dir, 'lib', 'b.mjs'), 'import { sharedApi } from "./a.mjs";\nexport const use = sharedApi();\n');
    writeFileSync(join(dir, 'lib', 'isolated.mjs'), 'export const solo = 42;\n');

    writeFileSync(join(dir, '.adlc', 'tickets', 't1.json'), JSON.stringify({ id: 'T-1', scope: ['lib/a.mjs'] }));
    writeFileSync(join(dir, '.adlc', 'tickets', 't2.json'), JSON.stringify({ id: 'T-2', scope: ['lib/b.mjs'] }));
    writeFileSync(join(dir, '.adlc', 'tickets', 't3.json'), JSON.stringify({ id: 'T-3', scope: ['lib/isolated.mjs'] }));

    const promptsDir = join(dir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    const seamAgy = join(dir, 'fake-seam-agy.cjs');
    writeFileSync(
      seamAgy,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let buf = ''; process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  const printIdx = process.argv.indexOf('--print');
  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;
  const m = prompt.match(/Review strictly through exactly one lens:\\s*\\*\\*([^*]+)\\*\\*/);
  const lens = m ? m[1] : 'unknown';
  fs.writeFileSync(path.join(${JSON.stringify(promptsDir)}, lens + '.txt'), prompt);
  console.log(JSON.stringify({ status: 'ok', structured_output: { findings: [] } }));
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = seamAgy;

    const multiDiff = [
      'diff --git a/lib/a.mjs b/lib/a.mjs',
      '--- a/lib/a.mjs',
      '+++ b/lib/a.mjs',
      '@@ -1 +1 @@',
      '-export function sharedApi() { return 0; }',
      '+export function sharedApi() { return 1; }',
      'diff --git a/lib/isolated.mjs b/lib/isolated.mjs',
      '--- a/lib/isolated.mjs',
      '+++ b/lib/isolated.mjs',
      '@@ -1 +1 @@',
      '-export const solo = 0;',
      '+export const solo = 42;',
    ].join('\n');

    const res = await reviewFleet({
      diff: multiDiff,
      repo: dir,
      seamsOnly: true,
    });
    assert.equal(res.converged, true);
    assert.equal(res.gateVerdict, 'SHIP');
    assert.equal(res.requests, 3);
    assert.equal(existsSync(join(promptsDir, 'contracts.txt')), true);
    assert.equal(existsSync(join(promptsDir, 'correctness_redteam.txt')), true);
    assert.equal(existsSync(join(promptsDir, 'security.txt')), true);

    const contractsPrompt = readFileSync(join(promptsDir, 'contracts.txt'), 'utf8');
    assert.match(contractsPrompt, /lib\/a\.mjs/);
    assert.match(contractsPrompt, /UNTRUSTED:SEAMS:/);
    assert.ok(!contractsPrompt.includes('lib/isolated.mjs'), 'disjoint ticket chunk must be excluded by seamsOnly');

    // Disjoint diff with 0 seams returns SHIP with 0 requests
    const disjointOnlyDiff = [
      'diff --git a/lib/isolated.mjs b/lib/isolated.mjs',
      '--- a/lib/isolated.mjs',
      '+++ b/lib/isolated.mjs',
      '@@ -1 +1 @@',
      '-export const solo = 0;',
      '+export const solo = 42;',
    ].join('\n');
    const cleanDisjoint = await reviewFleet({
      diff: disjointOnlyDiff,
      repo: dir,
      seamsOnly: true,
    });
    assert.equal(cleanDisjoint.requests, 0);
    assert.equal(cleanDisjoint.gateVerdict, 'SHIP');

    // Explicit lenses intersect with SEAM_LENSES and record skipped non-seam lenses
    const intersected = await reviewFleet({
      diff: multiDiff,
      repo: dir,
      seamsOnly: true,
      lenses: ['security', 'simplicity'],
    });
    assert.equal(intersected.requests, 1);
    assert.deepEqual(intersected.telemetry.skippedLenses, ['simplicity']);

    // seamsOnly with ref refuses when commit is unprosecuted or System-1 fast-shipped
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    g('add', 'lib/a.mjs', 'lib/b.mjs');
    g('commit', '-qm', 'init');
    const headSha = g('rev-parse', 'HEAD');
    writeFileSync(
      join(dir, '.adlc', 'manifest.jsonl'),
      JSON.stringify({
        seq: 1,
        gate: 'merge-prosecution',
        ticket: 'T-1',
        data: { mergedShas: [headSha], fastShipped: 'system1', scope: ['lib/a.mjs'] },
      }) + '\n'
    );
    await assert.rejects(
      () => reviewFleet({ diff: multiDiff, repo: dir, ref: 'HEAD', seamsOnly: true }),
      /seamsOnly review refused.*system1/i
    );
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewFleet: routes lens models by computeDiffBlastRadius and supports opt-in gateReviewLenses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-risk-gate-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'leaf.mjs'), 'function helper(x) {\n  return x + 1;\n}\n');
    writeFileSync(join(dir, 'lib', 'gates.mjs'), 'export function runGate() {\n  return true;\n}\n');

    const modelsSeen = [];
    const modelCaptureAgy = join(dir, 'fake-model-agy.cjs');
    const seenFile = join(dir, 'models-seen.jsonl');
    writeFileSync(
      modelCaptureAgy,
      `#!/usr/bin/env node
const fs = require('node:fs');
const mIdx = process.argv.indexOf('--model');
const model = mIdx >= 0 ? process.argv[mIdx + 1] : '';
fs.appendFileSync(${JSON.stringify(seenFile)}, model + '\\n');
let buf = ''; process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  console.log(JSON.stringify({ status: 'ok', structured_output: { findings: [] } }));
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = modelCaptureAgy;

    // 1. Low blast-radius diff routes correctness_redteam -> claude-sonnet-5-5-low
    const leafDiff = [
      'diff --git a/lib/leaf.mjs b/lib/leaf.mjs',
      '--- a/lib/leaf.mjs',
      '+++ b/lib/leaf.mjs',
      '@@ -1,3 +1,3 @@',
      ' function helper(x) {',
      '-  return x;',
      '+  return x + 1;',
      ' }',
    ].join('\n');
    const lowRes = await reviewFleet({
      diff: leafDiff,
      repo: dir,
      fiveLens: true,
      lenses: ['correctness_redteam'],
    });
    assert.equal(lowRes.blastRadius.level, 'low');
    assert.equal(readFileSync(seenFile, 'utf8').trim(), 'claude-sonnet-5-5-low');

    // 2. Security-sensitive path (lib/gates.mjs) forces high blast-radius -> claude-opus-5-5-high
    writeFileSync(seenFile, '');
    const secDiff = [
      'diff --git a/lib/gates.mjs b/lib/gates.mjs',
      '--- a/lib/gates.mjs',
      '+++ b/lib/gates.mjs',
      '@@ -1,3 +1,3 @@',
      ' export function runGate() {',
      '-  return false;',
      '+  return true;',
      ' }',
    ].join('\n');
    const highRes = await reviewFleet({
      diff: secDiff,
      repo: dir,
      fiveLens: true,
      lenses: ['correctness_redteam'],
    });
    assert.equal(highRes.blastRadius.level, 'high');
    assert.equal(readFileSync(seenFile, 'utf8').trim(), 'claude-opus-5-5-high');

    // 3. Opt-in gateReviewLenses skips low-risk lenses and tracks system1Calls + inputTokens
    writeFileSync(seenFile, '');
    const sys1Engine = new DecisionEngine({
      provider: 'jev',
      apiKey: 'sk-test-secret-1234',
      transport: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          usage: { inputTokens: 150 },
          answers: [
            { probability: 0.02, confidence: 0.95 }, // skip correctness_redteam
            { probability: 0.70, confidence: 0.95 }, // run security
          ],
        }),
      }),
    });
    const gatedRes = await reviewFleet({
      diff: leafDiff,
      repo: dir,
      fiveLens: true,
      lenses: ['correctness_redteam', 'security'],
      decisionEngine: sys1Engine,
    });
    assert.equal(gatedRes.requests, 1);
    assert.deepEqual(gatedRes.telemetry.skippedLenses, ['correctness_redteam']);
    assert.equal(gatedRes.telemetry.system1Calls, 1);
    assert.equal(gatedRes.telemetry.uncachedInputTokens, 150);
    assert.equal(readFileSync(seenFile, 'utf8').trim(), 'gemini-4-hydrogen-medium');

    // decisionEngine: false disables System-1 gating
    writeFileSync(seenFile, '');
    const disabledRes = await reviewFleet({
      diff: leafDiff,
      repo: dir,
      fiveLens: true,
      lenses: ['correctness_redteam', 'security'],
      decisionEngine: false,
    });
    assert.equal(disabledRes.requests, 2);
    assert.equal(disabledRes.telemetry.system1Calls, 0);
    assert.deepEqual(modelsSeen.length, 0);
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('triageFindings: 3-tier Arbiter cascade (Tier 1 System-1, Tier 2 deterministic <=4 fast-path, Tier 3 LLM)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-arbiter-3tier-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    const cleanTwo = [
      { id: 'F-1', severity: 'high', file: 'lib/a.mjs', claim: 'Null deref', evidence: 'line 10' },
      { id: 'F-2', severity: 'low', file: 'lib/b.mjs', claim: 'Style nit', evidence: 'line 20' },
    ];

    // Tier 1: System-1 high-confidence decisionEngine resolves without spawning agy
    process.env.AGB_AGY_BIN = '/nonexistent-agy-should-not-run';
    const sys1Engine = new DecisionEngine({
      provider: 'jev',
      apiKey: 'sk-test-secret-1234',
      transport: async (url, init) => {
        const body = JSON.parse(init.body);
        const items = body.items;
        const answers = items.map((item, idx) => {
          if (body.primitive === 'choice' && item.id.startsWith('v-')) {
            return { choice: idx === 0 ? 'accept' : 'reject', confidence: 0.96 };
          }
          if (body.primitive === 'score') {
            return { score: idx === 0 ? 0.65 : 0.1, confidence: 0.95 };
          }
          if (body.primitive === 'choice' && item.id.startsWith('r-')) {
            return { choice: 'auto-fix', confidence: 0.95 };
          }
          return { probability: 0.05, confidence: 0.95 };
        });
        return { ok: true, status: 200, json: async () => ({ usage: { inputTokens: 50 }, answers }) };
      },
    });
    const t1 = await triageFindings({ findings: cleanTwo, decisionEngine: sys1Engine });
    assert.equal(t1.arbiterMode, 'system1');
    assert.equal(t1.gateVerdict, 'ITERATE');
    assert.equal(t1.surviving.length, 1);
    assert.equal(t1.dropped.length, 1);
    assert.equal(t1.telemetry.system1Calls, 4);
    assert.equal(t1.telemetry.uncachedInputTokens, 200);

    // Tier 2: <=4 unique non-blast_radius findings without decisionEngine -> deterministic fast-path (0 LLM calls)
    const t2 = await triageFindings({ findings: cleanTwo, arbiter: true, decisionEngine: false });
    assert.equal(t2.arbiterMode, 'deterministic');
    assert.equal(t2.gateVerdict, 'ITERATE');
    assert.equal(t2.surviving.length, 1);
    assert.equal(t2.dropped.length, 1);
    assert.equal(t2.telemetry.billableTokens, 0);

    // Tier 3 triggered when forceLlmArbiter: true, duplicate keys, >4 findings, or low-confidence System-1
    const fakeLlmArbiter = join(dir, 'fake-llm-arbiter.cjs');
    writeFileSync(
      fakeLlmArbiter,
      `#!/usr/bin/env node
let buf = ''; process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    status: 'ok',
    structured_output: {
      gate_verdict: 'ITERATE',
      summary: 'llm triaged',
      triaged: [{ id: 'F-1', severity: 'high', file: 'lib/a.mjs', claim: 'Null deref', verdict: 'accept-candidate', resolution_route: 'auto-fix' }]
    },
    telemetry: { input_tokens: 500, cached_tokens: 200, output_tokens: 50 }
  }));
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = fakeLlmArbiter;

    // 3a. forceLlmArbiter: true
    const t3Force = await triageFindings({ findings: cleanTwo, forceLlmArbiter: true });
    assert.equal(t3Force.arbiterMode, 'llm');
    assert.equal(t3Force.telemetry.inputTokens, 500);
    assert.equal(t3Force.telemetry.outputTokens, 50);

    // 3b. Duplicate keys (even when <= 4) bypass Tier 2 -> Tier 3
    const dupFindings = [
      { id: 'F-1', severity: 'high', file: 'lib/a.mjs', claim: 'Same issue', evidence: 'lens1' },
      { id: 'F-2', severity: 'medium', file: 'lib/a.mjs', claim: 'Same issue', evidence: 'lens2' },
    ];
    const t3Dup = await triageFindings({ findings: dupFindings });
    assert.equal(t3Dup.arbiterMode, 'llm');

    // 3c. >4 unique findings bypass Tier 2 -> Tier 3
    const fiveFindings = Array.from({ length: 5 }, (_, i) => ({
      id: `F-${i + 1}`,
      severity: i === 0 ? 'high' : 'low',
      file: `lib/f-${i}.mjs`,
      claim: `Issue ${i}`,
      evidence: `line ${i + 1}`,
    }));
    const t3Five = await triageFindings({ findings: fiveFindings });
    assert.equal(t3Five.arbiterMode, 'llm');

    // 3d. Low-confidence System-1 (system2: true) escalates directly to Tier 3 LLM Arbiter
    const lowConfSys1 = new DecisionEngine({
      provider: 'jev',
      apiKey: 'sk-test-secret-1234',
      transport: async (url, init) => {
        const body = JSON.parse(init.body);
        const items = body.items;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usage: { inputTokens: 25 },
            answers: items.map(() =>
              body.primitive === 'noul'
                ? { probability: 0.2, confidence: 0.4 }
                : body.primitive === 'score'
                  ? { score: 0.5, confidence: 0.4 }
                  : { choice: body.primitive === 'choice' ? 'accept' : 'auto-fix', confidence: 0.4 }
            ),
          }),
        };
      },
    });
    const t3Escalated = await triageFindings({ findings: cleanTwo, decisionEngine: lowConfSys1 });
    assert.equal(t3Escalated.arbiterMode, 'llm');
    assert.equal(t3Escalated.telemetry.system1Calls, 4);
    assert.equal(t3Escalated.telemetry.uncachedInputTokens, 400); // 4*25 sys1 + (500-200) llm
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewPlan: aggregates telemetry across lens and Arbiter calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-plan-tel-'));
  const prevAgy = process.env.AGB_AGY_BIN;
  try {
    writeFileSync(join(dir, 'mod.mjs'), 'export const x = 1;\n');
    const specMd = [
      '# Clean Spec',
      '',
      '### Ticket 1: `T-1` — Clean Ticket',
      '- **Scope**: `mod.mjs`',
      '- **Rails**: (none)',
      '- **Edges**: (none)',
      '- **Acceptance Criteria**:',
      '  - `mod.mjs` exports `x === 1`.',
      '',
    ].join('\n');

    const fakePlanTelAgy = join(dir, 'fake-plan-tel.cjs');
    writeFileSync(
      fakePlanTelAgy,
      `#!/usr/bin/env node
let buf = ''; process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  const printIdx = process.argv.indexOf('--print');
  const prompt = printIdx >= 0 ? process.argv[printIdx + 1] : buf;
  if (prompt.includes('Neutral Arbiter')) {
    console.log(JSON.stringify({
      status: 'ok',
      structured_output: {
        gate_verdict: 'ITERATE',
        summary: 'kept',
        triaged: [{ id: 'F-001', severity: 'high', file: 'spec.md', claim: 'Need edge detail', verdict: 'accept-candidate', resolution_route: 'auto-fix' }]
      },
      telemetry: { input_tokens: 400, cached_tokens: 100, output_tokens: 40 }
    }));
  } else {
    console.log(JSON.stringify({
      status: 'ok',
      structured_output: {
        findings: [{ severity: 'high', file: 'spec.md', claim: 'Need edge detail', evidence: 'missing edge' }]
      },
      telemetry: { input_tokens: 1000, cached_tokens: 500, output_tokens: 100 }
    }));
  }
});
`,
      { mode: 0o755 }
    );
    process.env.AGB_AGY_BIN = fakePlanTelAgy;

    const res = await reviewPlan({
      specContent: specMd,
      repo: dir,
      lenses: ['dag_topology'],
      arbiter: true,
      forceLlmArbiter: true,
    });

    assert.equal(res.requests, 2);
    assert.deepEqual(res.telemetry, {
      uncachedInputTokens: 800,
      cachedTokens: 600,
      outputTokens: 140,
      inputTokens: 1400,
      billableTokens: 1280,
      system1Calls: 0,
      skippedLenses: [],
      arbiterMode: 'llm',
    });
  } finally {
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = prevAgy;
    rmSync(dir, { recursive: true, force: true });
  }
});

