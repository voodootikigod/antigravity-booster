import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatPlanMarkdown,
  resolveSourcePlanMarkdown,
  SOURCE_PLAN_FILENAMES,
  writePlanArtifact,
} from '../lib/brain.mjs';
import {
  compilePlan,
  decomposeTickets,
  verifyDeclaredPaths,
} from '../lib/plan.mjs';

test('verifyDeclaredPaths validates existing and upstream-created rail paths', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agb-fastpath-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'lib/existing.mjs'), 'export const x = 1;\n');

    const validTickets = [
      {
        id: 'T-1',
        scope: ['lib/existing.mjs', 'lib/new-file.mjs'],
        rails: ['lib/existing.mjs'],
        edges: [{ to: 'T-2' }],
      },
      {
        id: 'T-2',
        scope: ['lib/consumer.mjs'],
        rails: ['lib/new-file.mjs'],
        edges: [],
      },
    ];
    const missing1 = verifyDeclaredPaths(validTickets, tmpDir);
    assert.deepEqual(missing1, []);

    const invalidTickets = [
      {
        id: 'T-3',
        scope: ['lib/missing.mjs'],
        rails: ['test/missing-rail.test.mjs'],
        edges: [],
      },
    ];
    const missing2 = verifyDeclaredPaths(invalidTickets, tmpDir);
    assert.equal(missing2.length, 1);
    assert.equal(missing2[0].id, 'T-3');
    assert.equal(missing2[0].rail, 'test/missing-rail.test.mjs');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('compilePlan uses Structured Spec Fast-Path when spec has valid ticket declarations', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agb-compile-fast-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'lib'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'test'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'lib/mod.mjs'), 'export const a = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'test/mod.test.mjs'), 'export const t = 1;\n');

    const specPath = path.join(tmpDir, 'spec.md');
    await fs.writeFile(
      specPath,
      [
        '# Structured Spec',
        '',
        '### Ticket T-FAST-1: Fast Path Module',
        '- **Tier:** `mid` | **Pool Hint:** `auto`',
        '- **Scope:** `lib/mod.mjs`, `lib/created.mjs`',
        '- **Rails:** `test/mod.test.mjs`',
        '- **Edges:** `(none)`',
        '- **Acceptance Criteria:**',
        '  - [ ] Module exports `a` with deterministic value `1`',
        '',
      ].join('\n'),
    );

    const result = await compilePlan(specPath, {
      repo: tmpDir,
      premortem: false,
      parallax: false,
      coldstart: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.report.fastPath, true);
    assert.equal(result.plan.tickets.length, 1);
    assert.equal(result.plan.tickets[0].id, 'T-FAST-1');
    assert.deepEqual(result.plan.tickets[0].scope, ['lib/mod.mjs', 'lib/created.mjs']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('decomposeTickets splits wide-scope tickets and leaves narrow ones untouched', () => {
  const narrow = [
    {
      id: 'T-SMALL-1',
      title: 'Small Ticket',
      body: 'Do small work',
      scope: ['lib/a.mjs', 'lib/b.mjs'],
      rails: [],
      edges: [],
    },
  ];
  const resNarrow = decomposeTickets(narrow, { maxScope: 5 });
  assert.equal(resNarrow.length, 1);
  assert.equal(resNarrow[0].id, 'T-SMALL-1');

  const wide = [
    {
      id: 'T-WIDE-1',
      title: 'Wide Ticket',
      body: 'Do wide work',
      scope: ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs', 'lib/d.mjs'],
      rails: ['test/r.test.mjs'],
      edges: [],
    },
  ];
  const resWide = decomposeTickets(wide, { maxScope: 2 });
  assert.equal(resWide.length, 2);
  assert.equal(resWide[0].id, 'T-WIDE-1-p1');
  assert.equal(resWide[1].id, 'T-WIDE-1-p2');
  assert.deepEqual(resWide[0].edges, [{ to: 'T-WIDE-1-p2' }]);

  // Incoming edges to a split ticket rewire to -p1; overlapping glob scopes do not self-rail -p2; ID collisions disambiguate
  const graph = [
    {
      id: 'T-UPSTREAM',
      title: 'Upstream',
      body: 'Runs first',
      scope: ['src/up.mjs'],
      rails: [],
      edges: [{ to: 'T-SPLIT' }],
    },
    {
      id: 'T-SPLIT-p1',
      title: 'Pre-existing p1',
      body: 'Already named p1',
      scope: ['src/other.mjs'],
      rails: [],
      edges: [],
    },
    {
      id: 'T-SPLIT',
      title: 'Glob Split',
      body: 'Wide glob work',
      scope: ['lib/**', 'lib/sub/x.mjs', 'lib/sub/y.mjs'],
      rails: [],
      edges: [{ to: 'T-DOWNSTREAM' }],
    },
    {
      id: 'T-DOWNSTREAM',
      title: 'Downstream',
      body: 'Runs last',
      scope: ['src/down.mjs'],
      rails: [],
      edges: [],
    },
  ];
  const splitGraph = decomposeTickets(graph, { maxScope: 2 });
  const up = splitGraph.find((t) => t.id === 'T-UPSTREAM');
  const parts = splitGraph.filter((t) => t.id.startsWith('T-SPLIT-') && t.id !== 'T-SPLIT-p1');
  assert.equal(parts.length, 2);
  assert.deepEqual(up.edges, [{ to: parts[0].id }]);
  assert.deepEqual(parts[1].edges, [{ to: 'T-DOWNSTREAM' }]);
  assert.equal(parts[1].rails.includes('lib/**'), false, 'overlapping sibling glob scope must not freeze part 2');
});

test('readBrain and resolveSourcePlanMarkdown never let newer agb_plan_artifact.md shadow implementation_plan.md', async () => {
  const { readBrain } = await import('../lib/brain.mjs');
  const tmpBrainRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agb-brain-shadow-'));
  try {
    const convDir = path.join(tmpBrainRoot, 'conv-shadow-1');
    await fs.mkdir(convDir, { recursive: true });
    const implPath = path.join(convDir, 'implementation_plan.md');
    const artifactPath = path.join(convDir, 'agb_plan_artifact.md');
    await fs.writeFile(implPath, '# Real Source Implementation Plan\n\nAuthoritative content.\n');
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(artifactPath, '<!-- Generated by agb from conv-shadow-1 at 2026-01-01T00:00:00Z -->\n# AGB Plan Artifact\n');

    const brain = readBrain('conv-shadow-1', tmpBrainRoot);
    assert.match(brain.implementationPlan, /# Real Source Implementation Plan/);
    const resolved = resolveSourcePlanMarkdown({ sourceType: 'antigravity-brain', dir: convDir });
    assert.match(resolved, /# Real Source Implementation Plan/);
  } finally {
    await fs.rm(tmpBrainRoot, { recursive: true, force: true });
  }
});

test('resolveSourcePlanMarkdown and formatPlanMarkdown round-trip brain artifacts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agb-brain-'));
  try {
    assert.ok(SOURCE_PLAN_FILENAMES.includes('implementation_plan.md'));
    const planFile = path.join(tmpDir, 'implementation_plan.md');
    await fs.writeFile(planFile, '# Impl Plan\n\nDetails here.\n');

    const resolved = resolveSourcePlanMarkdown({
      sourceType: 'antigravity-brain',
      dir: tmpDir,
    });
    assert.match(resolved, /# Impl Plan/);

    const md = formatPlanMarkdown({
      repo: tmpDir,
      base: 'main',
      gate: { test: 'npm test' },
      tickets: [
        {
          id: 'T-1',
          title: 'First Ticket',
          tier: 'mid',
          pool_hint: 'auto',
          edges: [],
          scope: ['lib/a.mjs'],
          rails: ['test/a.test.mjs'],
          body: 'Works cleanly',
        },
      ],
    });
    assert.match(md, /### 📦 `T-1`: First Ticket/);
    assert.match(md, /\*\*Rails:\*\* `test\/a\.test\.mjs`/);

    const written = writePlanArtifact(
      {
        repo: tmpDir,
        base: 'main',
        tickets: [],
      },
      { repo: tmpDir },
    );
    assert.equal(written.ok, true);
    assert.ok(written.path.endsWith('agb_plan_artifact.md'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
