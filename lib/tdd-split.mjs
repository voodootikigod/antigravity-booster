// Cross-Pool Adversarial TDD Split: Spec-Test Author vs. Implementation Builder (v1.4 Pillar 4).
//
// Automatically activates on `frontier`-tier tickets (and any ticket with `tdd_split: true`)
// whose scope contains both implementation paths and `test/**` paths.
// Dispatches a Spec-Test Author on the opposite quota pool to commit black-box contract
// tests that fail against `base` (anti-tautology red-phase verification), then promotes
// those test files into the Implementation Builder's frozen `rails`.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { familyOf } from './models.mjs';

function isTestPathspec(pathspec) {
  const norm = String(pathspec || '').replace(/\\/g, '/').trim();
  return (
    norm === 'test' ||
    norm.startsWith('test/') ||
    norm.endsWith('.test.mjs') ||
    norm.endsWith('.test.js') ||
    norm.endsWith('.test.ts')
  );
}

/**
 * Determine whether a ticket should execute the Cross-Pool Adversarial TDD Split.
 * Default-on for `frontier` tickets (and any ticket with `tdd_split === true`)
 * whose scope includes both `test/**` paths and implementation paths.
 */
export function shouldRunTddSplit(ticket = {}, plan = {}) {
  if (!ticket || typeof ticket !== 'object') return false;
  if (ticket.tdd_split === false || plan?.tddSplit === false) return false;

  const tier = String(ticket.tier || 'mid').trim().toLowerCase();
  const enabled = ticket.tdd_split === true || tier === 'frontier';
  if (!enabled) return false;

  const scope = Array.isArray(ticket.scope) ? ticket.scope : [];
  const hasTest = scope.some(isTestPathspec);
  const hasImpl = scope.some((p) => !isTestPathspec(p));
  return hasTest && hasImpl;
}

/**
 * Select the opposite quota pool (`'claude-gpt'` vs `'gemini'`) so the Spec-Test Author
 * runs on an independent model family and quota bucket from the Implementation Builder.
 */
export function selectOppositePoolHint(poolHint = 'auto', builderModelSlug = '') {
  if (builderModelSlug && typeof builderModelSlug === 'string') {
    try {
      const fam = familyOf(builderModelSlug);
      return fam === 'gemini' ? 'claude-gpt' : 'gemini';
    } catch {}
  }
  const normalizedHint = String(poolHint || 'auto').trim().toLowerCase();
  if (normalizedHint === 'gemini') return 'claude-gpt';
  if (
    normalizedHint === 'claude' ||
    normalizedHint === 'claude-gpt' ||
    normalizedHint === 'gpt-oss'
  ) {
    return 'gemini';
  }
  return 'claude-gpt';
}

/**
 * Partition a ticket's scope into Spec-Test Author and Implementation Builder contracts.
 */
export function partitionTddScopes(ticket = {}, { builderModel = '' } = {}) {
  const scope = Array.isArray(ticket.scope) ? ticket.scope : [];
  const baseRails = Array.isArray(ticket.rails) ? ticket.rails : [];

  const testScope = scope.filter(isTestPathspec);
  const implScope = scope.filter((p) => !isTestPathspec(p));
  const specPoolHint = selectOppositePoolHint(ticket.pool_hint, builderModel);

  const specAuthorSubTicket = {
    ...ticket,
    id: `${ticket.id}--spec-tests`,
    title: `[Spec-Test Author] ${ticket.title || ticket.id}`,
    scope: testScope,
    rails: [...new Set([...baseRails, ...implScope])],
    pool_hint: specPoolHint,
    body: [
      `## Adversarial TDD Phase 1: Black-Box Spec-Test Author (${ticket.id})`,
      'Write deterministic black-box contract tests in `test/**` encoding every acceptance criterion below.',
      'Implementation paths are FROZEN RAILS during this phase — do NOT create or edit implementation files.',
      'Your tests MUST parse cleanly (`node --check`) and fail against the unimplemented baseline.',
      '',
      ticket.body || '',
    ].join('\n'),
  };

  return {
    testScope,
    implScope,
    specPoolHint,
    specAuthorSubTicket,
  };
}

/**
 * Promote committed spec-test files into the Implementation Builder's frozen `rails`.
 */
export function promoteTestsToBuilderRails(ticket = {}, committedTestFiles = []) {
  const baseRails = Array.isArray(ticket.rails) ? ticket.rails : [];
  const validTests = (committedTestFiles || [])
    .map((f) => String(f || '').replace(/\\/g, '/').trim())
    .filter((f) => f && isTestPathspec(f));

  return {
    ...ticket,
    rails: [...new Set([...baseRails, ...validTests])],
  };
}

/**
 * Verify that the Spec-Test Author's committed tests:
 *   1. Exist and pass `node --check` syntax validation.
 *   2. Fail (`exitCode !== 0`) against the unimplemented baseline worktree (anti-tautology check).
 * If tests are missing, syntactically invalid, or tautologically pass on unimplemented base,
 * returns `{ ok: false, reason }` so the caller discards the spec-test commit and degrades
 * cleanly to standard single-builder execution.
 */
export function verifyRedPhaseTests(
  testFiles = [],
  { worktree = process.cwd(), timeoutMs = 30_000 } = {}
) {
  const wtRoot = resolve(worktree);
  const cleanFiles = (testFiles || [])
    .map((f) => String(f || '').replace(/\\/g, '/').trim())
    .filter((f) => f && isTestPathspec(f));

  if (cleanFiles.length === 0) {
    return { ok: false, reason: 'spec-test author committed no test files' };
  }

  for (const rel of cleanFiles) {
    const full = join(wtRoot, rel);
    if (!existsSync(full)) {
      return { ok: false, reason: `committed test file missing: ${rel}` };
    }
    try {
      execFileSync(process.execPath, ['--check', full], {
        cwd: wtRoot,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        ok: false,
        reason: `spec-test syntax error in ${rel}: ${err.message}`,
      };
    }
  }

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  try {
    execFileSync(process.execPath, ['--test', ...cleanFiles], {
      cwd: wtRoot,
      env: childEnv,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: false,
      reason: 'tautological spec tests: tests passed on unimplemented base (red-phase failure required)',
    };
  } catch (err) {
    if (err?.killed || err?.signal === 'SIGTERM') {
      return { ok: false, reason: 'spec-test red-phase verification timed out' };
    }
    return {
      ok: true,
      verifiedFiles: cleanFiles,
      exitCode: err?.status ?? 1,
    };
  }
}
