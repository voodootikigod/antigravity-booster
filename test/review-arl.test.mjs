import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../lib/review.mjs';
import { ARL_LENS_MODELS, CODE_ARL_LENSES, PLAN_ARL_LENSES, ALL_MODELS } from '../lib/models.mjs';

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
});
