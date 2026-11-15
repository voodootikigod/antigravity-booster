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
