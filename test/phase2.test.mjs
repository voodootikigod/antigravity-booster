import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sweepToPlan, expandTargets } from '../lib/sweep.mjs';
import { reviewFleet } from '../lib/review.mjs';
import { forecastOverlaps, preflight } from '../lib/preflight.mjs';
import { listBrains, readBrain, brainToPlan } from '../lib/brain.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

// --- sweep ---

test('sweepToPlan: targets become disjoint cheap tickets with substituted bodies', () => {
  const plan = sweepToPlan({
    repo: '/r', gate: { test: 'true' },
    operation: 'Refactor {target} to ESM.',
    targets: ['src/a.js', 'src/b.js'],
  });
  assert.equal(plan.tickets.length, 2);
  assert.equal(plan.tickets[0].id, 'S1');
  assert.match(plan.tickets[0].body, /Refactor src\/a\.js to ESM/);
  assert.deepEqual(plan.tickets[0].scope, ['src/a.js']);
  assert.equal(plan.tickets[0].tier, 'cheap');
  assert.equal(forecastOverlaps(plan.tickets).length, 0, 'sweep scopes must be disjoint');
});

test('sweepToPlan: rejects template without {target} and empty targets', () => {
  assert.throws(() => sweepToPlan({ repo: '/r', operation: 'no placeholder', targets: ['x'] }));
  assert.throws(() => sweepToPlan({ repo: '/r', operation: 'do {target}', targets: [] }));
});

test('expandTargets: resolves glob via git ls-files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agb-sweep-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: dir });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.mjs'), '');
    writeFileSync(join(dir, 'src', 'b.mjs'), '');
    writeFileSync(join(dir, 'other.txt'), '');
    g('add', '-A'); g('commit', '-qm', 'x');
    assert.deepEqual(expandTargets(dir, 'src/*.mjs').sort(), ['src/a.mjs', 'src/b.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- review fleet ---

test('reviewFleet: dedupes across rounds, converges after dry rounds', async () => {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_PROSECUTOR_VERDICT = 'block'; // every lens reports the same finding
  try {
    const r = await reviewFleet({ diff: 'diff --git a/x b/x\n+code', lenses: ['correctness', 'security'], dryRounds: 2, maxRounds: 5 });
    assert.equal(r.converged, true);
    // identical claims from both lenses/rounds dedupe to one finding
    assert.equal(r.findings.length, 1);
    // round 1 finds it, rounds 2-3 are dry
    assert.equal(r.rounds, 3);
    assert.equal(r.requests, 6);
  } finally {
    delete process.env.AGB_AGY_BIN; delete process.env.FAKE_PROSECUTOR_VERDICT;
  }
});

test('reviewFleet: empty diff returns clean without any model call', async () => {
  const r = await reviewFleet({ diff: '   ' });
  assert.equal(r.converged, true);
  assert.equal(r.requests, 0);
});

test('reviewFleet: model failures do NOT fake convergence (round-3 HIGH)', async () => {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  process.env.FAKE_AGY_MODE = 'fail'; // every lens call errors
  try {
    const r = await reviewFleet({ diff: 'diff --git a/x b/x\n+code', lenses: ['correctness'], dryRounds: 2, maxRounds: 3 });
    assert.equal(r.converged, false, 'all-errored rounds must not report convergence');
    assert.ok(r.errors.length > 0, 'errors surfaced, not swallowed');
    assert.equal(r.rounds, 3, 'retries to maxRounds rather than approving early');
  } finally {
    delete process.env.AGB_AGY_BIN; delete process.env.FAKE_AGY_MODE;
  }
});

// --- preflight ---

test('forecastOverlaps: detects unordered scope collisions, ignores edge-ordered pairs', () => {
  const tickets = [
    { id: 'A', title: 'a', scope: ['src/shared/**'] },
    { id: 'B', title: 'b', scope: ['src/shared/types.ts'] },
    { id: 'C', title: 'c', scope: ['docs/**'] },
  ];
  const o1 = forecastOverlaps(tickets);
  assert.equal(o1.length, 1);
  assert.deepEqual([o1[0].a, o1[0].b], ['A', 'B']);
  // Same pair but serialized by an edge → not a conflict
  const ordered = [{ ...tickets[0], edges: [{ to: 'B' }] }, tickets[1], tickets[2]];
  assert.equal(forecastOverlaps(ordered).length, 0);
});

test('forecastOverlaps: transitively-ordered tickets sharing scope are NOT flagged', () => {
  // T1 -> T2 -> T3; T1 and T3 share a file but can never run concurrently.
  const tickets = [
    { id: 'T1', title: 't1', scope: ['src/main.js'], edges: [{ to: 'T2' }] },
    { id: 'T2', title: 't2', scope: ['src/other.js'], edges: [{ to: 'T3' }] },
    { id: 'T3', title: 't3', scope: ['src/main.js'] },
  ];
  assert.equal(forecastOverlaps(tickets).length, 0, 'transitive ordering must exempt the pair');
  // But two truly-parallel tickets sharing scope are still flagged.
  const parallel = [
    { id: 'A', title: 'a', scope: ['src/main.js'] },
    { id: 'B', title: 'b', scope: ['src/main.js'] },
  ];
  assert.equal(forecastOverlaps(parallel).length, 1);
});

test('preflight: ok when scopes disjoint and coldstart returns no gaps', async () => {
  process.env.AGB_AGY_BIN = FAKE_AGY;
  try {
    const plan = {
      gate: { test: 'true' },
      tickets: [
        { id: 'T1', title: 'a', body: 'b', scope: ['a/**'] },
        { id: 'T2', title: 'b', body: 'c', scope: ['b/**'] },
      ],
    };
    const r = await preflight(plan);
    assert.equal(r.ok, true);
    assert.equal(r.gaps.length, 0);
    // Unparseable coldstart output must surface as gaps, not pass silently.
    process.env.FAKE_COLDSTART_MODE = 'garbage';
    const bad = await preflight(plan);
    assert.equal(bad.ok, false);
    assert.equal(bad.gaps.length, 2);
  } finally {
    delete process.env.AGB_AGY_BIN;
    delete process.env.FAKE_COLDSTART_MODE;
  }
});

// --- brain ---

test('brain: list/read/convert from a fixture brain dir', async () => {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-brain-'));
  process.env.AGB_AGY_BIN = FAKE_AGY;
  try {
    const conv = join(brainDir, 'aaaa-bbbb');
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, 'implementation_plan.md'), '# Build the widget\n\n- step 1\n- step 2\n');
    writeFileSync(join(conv, 'task.md'), '# Tasks\n- [ ] do step 1\n');
    mkdirSync(join(brainDir, 'no-artifacts-here'));

    const brains = listBrains(brainDir);
    assert.equal(brains.length, 1);
    assert.equal(brains[0].title, 'Build the widget');

    const b = readBrain('aaaa', brainDir);
    assert.match(b.implementationPlan, /step 1/);

    // fake-agy has a brain-conversion responder keyed on the prompt marker
    const plan = await brainToPlan('aaaa', { repo: '/r', brainDir });
    assert.ok(plan.tickets.length >= 1);
    assert.equal(plan.repo, '/r');
  } finally {
    delete process.env.AGB_AGY_BIN;
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('brain: readBrain throws on unknown id', () => {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-brain2-'));
  try {
    assert.throws(() => readBrain('zzz', brainDir));
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test('brain: readBrain can read directly from a local spec file path', () => {
  const tmpFile = join(tmpdir(), `agb-spec-${Date.now()}.md`);
  writeFileSync(tmpFile, '# My Spec\nSome description of the task\n');
  try {
    const b = readBrain(tmpFile);
    assert.equal(b.id, tmpFile);
    assert.equal(b.title, 'My Spec');
    assert.match(b.implementationPlan, /Some description/);
    assert.equal(b.task, null);
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

test('brain: readBrain supports .json and .csv local spec file paths', () => {
  const jsonFile = join(tmpdir(), `agb-spec-${Date.now()}.json`);
  const csvFile = join(tmpdir(), `agb-spec-${Date.now()}.csv`);
  writeFileSync(jsonFile, '{\n  "name": "spec-json"\n}');
  writeFileSync(csvFile, 'task,status\nstep1,todo\n');
  try {
    const bJson = readBrain(jsonFile);
    assert.equal(bJson.sourceType, 'local-spec');
    assert.match(bJson.implementationPlan, /spec-json/);

    const bCsv = readBrain(csvFile);
    assert.equal(bCsv.sourceType, 'local-spec');
    assert.match(bCsv.implementationPlan, /step1/);
  } finally {
    rmSync(jsonFile, { force: true });
    rmSync(csvFile, { force: true });
  }
});

