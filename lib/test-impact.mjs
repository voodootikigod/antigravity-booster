// Test-Impact Delta Gate Slicer & Speculative Merge-Train Planner (v1.4 Pillar 6).

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, posix, relative, resolve, sep } from 'node:path';
import { scopesOverlap } from '@adlc/core/tickets';
import { PATHSPEC_RE } from './plan-integrity.mjs';
import { scanStaticImportCoupling } from './shape.mjs';

const SOURCE_EXTS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const RESOLVE_EXTS = [
  '',
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '/index.mjs',
  '/index.js',
  '/index.ts',
];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.worktrees',
  'coverage',
  '.booster',
  '.review',
  'scratch',
  '.adlc',
  'dist',
  'build',
  'vendor',
]);

const GLOBAL_FALLBACK_PATTERNS = [
  /^package(-lock)?\.json$/,
  /^scripts\//,
  /^test\/fixtures\//,
  /^bin\/loader\.mjs$/,
];

function isGlobalFallbackPath(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/').trim();
  return GLOBAL_FALLBACK_PATTERNS.some((re) => re.test(norm));
}

function extractRelativeSpecifiers(sourceText) {
  const specs = [];
  const importRe =
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = importRe.exec(sourceText)) !== null) {
    const raw = m[1] || m[2] || m[3];
    if (raw) specs.push(raw);
  }
  return specs;
}

function buildReverseImportGraph(repoRoot) {
  const reverseGraph = new Map();
  const walk = (dir, relPrefix = '') => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, rel);
      } else if (ent.isFile() && SOURCE_EXTS.has(extname(ent.name))) {
        let content = '';
        try {
          content = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const specs = extractRelativeSpecifiers(content);
        const fromDir = posix.dirname(rel);
        for (const spec of specs) {
          const baseTarget = posix.normalize(
            fromDir === '.' ? spec : `${fromDir}/${spec}`
          );
          for (const suffix of RESOLVE_EXTS) {
            const candidate = `${baseTarget}${suffix}`;
            if (existsSync(join(repoRoot, candidate))) {
              if (!reverseGraph.has(candidate)) reverseGraph.set(candidate, new Set());
              reverseGraph.get(candidate).add(rel);
              break;
            }
          }
        }
      }
    }
  };
  walk(repoRoot);
  return reverseGraph;
}

function isContainedValidTestFile(relPath, repoRoot, realTestRoot) {
  if (typeof relPath !== 'string') return false;
  const norm = relPath.replace(/\\/g, '/').trim();
  if (!norm.startsWith('test/') || !norm.endsWith('.test.mjs')) return false;
  if (!PATHSPEC_RE.test(norm)) return false;
  if (/[^A-Za-z0-9_./-]/.test(norm)) return false;
  const full = resolve(repoRoot, norm);
  try {
    if (!existsSync(full) || lstatSync(full).isSymbolicLink()) return false;
    const realFull = realpathSync(full);
    const relToTest = relative(realTestRoot, realFull);
    if (
      !relToTest ||
      relToTest === '..' ||
      relToTest.startsWith(`..${sep}`) ||
      relToTest.startsWith('../')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the transitive `test/*.test.mjs` consumer closure for `changedFiles`.
 * Falls back to `{ fast: false, testFiles: [], testCmd: fallbackTestCmd }` when
 * global files change, when no test slice is found, or when the slice exceeds `maxSliceFiles`.
 */
export function deriveImpactedTests(
  changedFiles = [],
  { repo = process.cwd(), fallbackTestCmd = 'npm test', maxSliceFiles = 20 } = {}
) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
  }

  const repoRoot = resolve(repo);
  const testDir = join(repoRoot, 'test');
  if (!existsSync(testDir)) {
    return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
  }
  let realTestRoot;
  try {
    if (lstatSync(testDir).isSymbolicLink()) {
      return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
    }
    realTestRoot = realpathSync(testDir);
  } catch {
    return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
  }

  const normalizedChanges = [];
  for (const raw of changedFiles) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const norm = raw.replace(/\\/g, '/').trim();
    if (isGlobalFallbackPath(norm)) {
      return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
    }
    normalizedChanges.push(norm);
  }

  if (normalizedChanges.length === 0) {
    return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
  }

  const reverseGraph = buildReverseImportGraph(repoRoot);
  const visited = new Set();
  const queue = [...normalizedChanges];
  const impactedTests = new Set();

  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);

    if (isContainedValidTestFile(cur, repoRoot, realTestRoot)) {
      impactedTests.add(cur);
    }

    const dependents = reverseGraph.get(cur);
    if (dependents) {
      for (const dep of dependents) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
  }

  const testFiles = [...impactedTests].sort();
  if (testFiles.length === 0 || testFiles.length > maxSliceFiles) {
    return { fast: false, testFiles: [], testCmd: fallbackTestCmd };
  }

  return {
    fast: true,
    testFiles,
    testCmd: `node --test ${testFiles.join(' ')}`,
  };
}

function ticketsConflict(a, b, repoRoot) {
  const scopeA = Array.isArray(a.scope) ? a.scope : [];
  const scopeB = Array.isArray(b.scope) ? b.scope : [];
  if (scopesOverlap(scopeA, scopeB)) return true;

  const filesA = new Set((a.changedFiles || []).map((f) => String(f).replace(/\\/g, '/')));
  const filesB = new Set((b.changedFiles || []).map((f) => String(f).replace(/\\/g, '/')));
  for (const f of filesA) {
    if (filesB.has(f)) return true;
  }

  if (repoRoot) {
    try {
      const warnings = scanStaticImportCoupling(
        [
          { id: a.id || 'A', scope: scopeA, edges: [] },
          { id: b.id || 'B', scope: scopeB, edges: [] },
        ],
        repoRoot
      );
      if (Array.isArray(warnings) && warnings.length > 0) return true;
    } catch {
      return true;
    }
  }

  return false;
}

/**
 * Partition prosecution-passed tickets ready in the merge queue into ordered
 * conflict-free batches with pairwise-disjoint scopes, disjoint changedFiles,
 * and zero cross-ticket static import coupling.
 */
export function planSpeculativeMergeBatches(
  readyTickets = [],
  { repo = process.cwd(), maxBatchSize = 4 } = {}
) {
  if (!Array.isArray(readyTickets) || readyTickets.length === 0) return [];
  const repoRoot = repo ? resolve(repo) : null;
  const batches = [];

  for (const ticket of readyTickets) {
    let placed = false;
    for (const batch of batches) {
      if (batch.length >= maxBatchSize) continue;
      const hasConflict = batch.some((existing) =>
        ticketsConflict(existing, ticket, repoRoot)
      );
      if (!hasConflict) {
        batch.push(ticket);
        placed = true;
        break;
      }
    }
    if (!placed) {
      batches.push([ticket]);
    }
  }

  return batches;
}

/**
 * Deterministically split a failed speculative merge batch into left and right
 * halves (`[left, right]`) for $O(\log k)$ binary-search defect isolation.
 */
export function bisectFailedBatch(batch = []) {
  if (!Array.isArray(batch) || batch.length <= 1) return [];
  const mid = Math.floor(batch.length / 2);
  return [batch.slice(0, mid), batch.slice(mid)];
}
