// Automated P5 -> P3 Defense Distillation (`agb distill`, v1.4 Pillar 7b + v2.0 Wave 4 D3).
//
// Scans `<repo>/.adlc/manifest.jsonl` and `<repo>/.booster/` review/prosecution
// artifacts for recurring finding fingerprints (>= minOccurrences), stages a
// human-reviewable proposal at `<repo>/.booster/distilled-defenses.md`, optionally
// writes compacted guidance to `<repo>/.gemini/rules/adlc-learned.md` (`apply === true`),
// and when `compileChecks === true`, synthesizes declarative ReDoS-safe invariants into
// `<repo>/.adlc/learned-checks.json` evaluated deterministically during P5 via `runLearnedChecks`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { globMatch } from '@adlc/core/tickets';
import { validatePathspec, writeArtifactFileAtomically } from './plan-integrity.mjs';

export const DEFAULT_MAX_RULE_BYTES = 12_000;
const MAX_LEARNED_CHECKS = 200;
const MAX_REGEX_LEN = 160;
const MAX_LITERAL_LEN = 256;
const MAX_CHECK_FILE_BYTES = 512 * 1024;
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const SKIP_WALK_DIRS = new Set([
  '.git',
  'node_modules',
  '.worktrees',
  '.booster',
  '.agb_home',
  'dist',
  'coverage',
  'vendor',
  '.next',
]);

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Structural ReDoS guard: rejects patterns exceeding 160 chars, backreferences,
 * lookbehind assertions, or groups containing quantifiers that are themselves quantified
 * (e.g. `(a+)+`, `(.*)*`, `([a-z]+){2,}`).
 */
export function isSafeRegexPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_REGEX_LEN) {
    return false;
  }
  if (/\\[1-9]/.test(pattern) || /\(\?<[=!]/.test(pattern)) {
    return false;
  }
  // Reject adjacent unbounded wildcard segments (`.*.*`, `.+.+`, `\s+.*\s+`) that cause O(n^2) backtracking
  if (/(?:\.\*|\.\+|\\s\+|\[\^[^\]]+\]\+)[^\r\n]{0,16}(?:\.\*|\.\+|\\s\+)/.test(pattern)) {
    return false;
  }
  const groupStack = [];
  let escaped = false;
  let inCharClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === '(') {
      groupStack.push({ hasInnerQuantifier: false, hasAlternation: false });
      continue;
    }
    if (ch === '|' && groupStack.length > 0) {
      groupStack[groupStack.length - 1].hasAlternation = true;
      continue;
    }
    if (ch === '+' || ch === '*' || ch === '{') {
      for (const g of groupStack) g.hasInnerQuantifier = true;
      continue;
    }
    if (ch === ')') {
      const closed = groupStack.pop();
      const next = pattern[i + 1] || '';
      const isQuantifiedGroup = next === '+' || next === '*' || next === '?' || next === '{';
      if (closed && isQuantifiedGroup && (closed.hasInnerQuantifier || closed.hasAlternation)) {
        return false;
      }
      if (closed?.hasInnerQuantifier && groupStack.length > 0) {
        groupStack[groupStack.length - 1].hasInnerQuantifier = true;
      }
    }
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a `.adlc/learned-checks.json` specification object.
 * Returns an array of error strings (`[]` = valid).
 */
export function validateLearnedChecksSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['learned-checks spec must be a JSON object'];
  }
  if (spec.version !== 1) {
    errors.push(`learned-checks version must be 1 (got ${String(spec.version)})`);
  }
  if (!Array.isArray(spec.checks)) {
    errors.push('learned-checks.checks must be an array');
    return errors;
  }
  if (spec.checks.length > MAX_LEARNED_CHECKS) {
    errors.push(`learned-checks.checks exceeds maximum of ${MAX_LEARNED_CHECKS} rules`);
    return errors;
  }
  const seenIds = new Set();
  for (let i = 0; i < spec.checks.length; i++) {
    const c = spec.checks[i];
    const label = `checks[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof c.id !== 'string' || !CHECK_ID_RE.test(c.id)) {
      errors.push(`${label}.id must match ${CHECK_ID_RE}`);
    } else if (seenIds.has(c.id)) {
      errors.push(`${label}.id duplicates '${c.id}'`);
    } else {
      seenIds.add(c.id);
    }
    if (typeof c.glob !== 'string' || !validatePathspec(c.glob, { allowRootWildcard: true })) {
      errors.push(`${label}.glob '${String(c.glob ?? '')}' is not a valid repo-relative pathspec`);
    }
    const hasForbidLit = typeof c.forbidLiteral === 'string' && c.forbidLiteral.length > 0;
    const hasReqLit = typeof c.requireLiteral === 'string' && c.requireLiteral.length > 0;
    const hasForbidRe = typeof c.forbidRegex === 'string' && c.forbidRegex.length > 0;
    if (!hasForbidLit && !hasReqLit && !hasForbidRe) {
      errors.push(`${label} must declare at least one of forbidLiteral, requireLiteral, or forbidRegex`);
    }
    if (c.forbidLiteral !== undefined && (!hasForbidLit || c.forbidLiteral.length > MAX_LITERAL_LEN)) {
      errors.push(`${label}.forbidLiteral must be a non-empty string <= ${MAX_LITERAL_LEN} chars`);
    }
    if (c.requireLiteral !== undefined && (!hasReqLit || c.requireLiteral.length > MAX_LITERAL_LEN)) {
      errors.push(`${label}.requireLiteral must be a non-empty string <= ${MAX_LITERAL_LEN} chars`);
    }
    if (c.forbidRegex !== undefined && !isSafeRegexPattern(c.forbidRegex)) {
      errors.push(`${label}.forbidRegex is invalid, exceeds ${MAX_REGEX_LEN} chars, or contains unsafe nested quantifiers`);
    }
  }
  return errors;
}

function synthesizeCheckForCluster(cluster) {
  if (cluster.explicitCheck && typeof cluster.explicitCheck === 'object') {
    const ec = cluster.explicitCheck;
    const candidate = {
      id: cluster.id,
      lens: cluster.lens,
      severity: cluster.severity,
      description: String(ec.description || cluster.sampleClaim).slice(0, 220),
      glob: typeof ec.glob === 'string' ? ec.glob : 'lib/**',
      ...(ec.forbidLiteral !== undefined ? { forbidLiteral: String(ec.forbidLiteral) } : {}),
      ...(ec.requireLiteral !== undefined ? { requireLiteral: String(ec.requireLiteral) } : {}),
      ...(ec.forbidRegex !== undefined ? { forbidRegex: String(ec.forbidRegex) } : {}),
    };
    if (validateLearnedChecksSpec({ version: 1, checks: [candidate] }).length === 0) {
      return candidate;
    }
  }

  const lower = `${cluster.canonical} ${cluster.sampleClaim.toLowerCase()}`;
  if (lower.includes('decision') && lower.includes('allow') && lower.includes('hook')) {
    return {
      id: cluster.id,
      lens: cluster.lens,
      severity: cluster.severity,
      description: 'Never emit decision: "allow" in Antigravity hook scripts (PASS is {})',
      glob: 'hooks/**',
      forbidRegex: 'decision\\s*:\\s*[\'"]allow[\'"]',
    };
  }
  if (lower.includes('rm -rf')) {
    return {
      id: cluster.id,
      lens: cluster.lens,
      severity: cluster.severity,
      description: 'Avoid raw rm -rf shell invocations',
      glob: 'scripts/**',
      forbidLiteral: 'rm -rf',
    };
  }
  if (lower.includes('eval(')) {
    return {
      id: cluster.id,
      lens: cluster.lens,
      severity: cluster.severity,
      description: 'Forbid dynamic eval() execution in library code',
      glob: 'lib/**',
      forbidLiteral: 'eval(',
    };
  }
  return null;
}

function normalizeClaimFingerprint(finding) {
  const lens = String(finding?.lens || finding?.charge || 'general')
    .trim()
    .toLowerCase();
  const rawClaim = String(finding?.claim || finding?.title || finding?.detail || '')
    .trim()
    .toLowerCase();
  if (!rawClaim) return null;

  // Strip line numbers, hex hashes, and quoted identifiers so recurring instances
  // of the same defect class fingerprint together.
  const canonical = rawClaim
    .replace(/\b[0-9a-f]{7,64}\b/g, '<hash>')
    .replace(/\bl?\d+(?:-\d+)?\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();

  if (!canonical) return null;
  const hash = createHash('sha256')
    .update(`${lens}:${canonical}`)
    .digest('hex')
    .slice(0, 12);

  return {
    id: `DEF-${hash}`,
    lens,
    canonical,
    sampleClaim: String(finding?.claim || finding?.title || finding?.detail || '').trim(),
    severity: String(finding?.severity || 'medium').toLowerCase(),
    explicitCheck: finding?.check && typeof finding.check === 'object' ? finding.check : null,
  };
}

function collectJsonFindingsFromDir(dirPath, findings, maxFiles = 64) {
  if (!existsSync(dirPath) || lstatOrNull(dirPath)?.isSymbolicLink()) return;
  let count = 0;
  const walk = (curDir, depth) => {
    if (depth > 3 || count >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (count >= maxFiles || ent.isSymbolicLink()) continue;
      const full = join(curDir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.json')) {
        count += 1;
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'));
          const list = Array.isArray(parsed?.findings)
            ? parsed.findings
            : Array.isArray(parsed?.accepted_findings)
            ? parsed.accepted_findings
            : [];
          for (const f of list) findings.push(f);
        } catch {}
      }
    }
  };
  walk(dirPath, 0);
}

function collectBoosterFindings(repoRoot) {
  const findings = [];
  collectJsonFindingsFromDir(join(repoRoot, '.booster'), findings, 64);
  collectJsonFindingsFromDir(join(repoRoot, '.review'), findings, 64);

  const manifestPath = join(repoRoot, '.adlc', 'manifest.jsonl');
  if (existsSync(manifestPath) && !lstatOrNull(manifestPath)?.isSymbolicLink()) {
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (Array.isArray(rec?.findings)) {
            for (const f of rec.findings) findings.push(f);
          } else if (rec?.finding && typeof rec.finding === 'object') {
            findings.push(rec.finding);
          }
        } catch {}
      }
    } catch {}
  }

  return findings;
}

/**
 * Scan repository review/prosecution artifacts for recurring finding fingerprints,
 * stage `.booster/distilled-defenses.md`, optionally compact into
 * `.gemini/rules/adlc-learned.md` when `apply === true`, and optionally compile
 * executable declarative checks into `.adlc/learned-checks.json` when `compileChecks === true`.
 */
export function distillRunDefenses({
  repo = process.cwd(),
  apply = false,
  compileChecks = false,
  minOccurrences = 2,
  maxRuleBytes = DEFAULT_MAX_RULE_BYTES,
  extraFindings = [],
} = {}) {
  const repoRoot = resolve(repo);
  const allFindings = [...collectBoosterFindings(repoRoot), ...(extraFindings || [])];
  const clusters = new Map();

  for (const f of allFindings) {
    const fp = normalizeClaimFingerprint(f);
    if (!fp) continue;
    const prev = clusters.get(fp.id);
    if (prev) {
      prev.occurrences += 1;
      if (!prev.explicitCheck && fp.explicitCheck) prev.explicitCheck = fp.explicitCheck;
    } else {
      clusters.set(fp.id, {
        ...fp,
        occurrences: 1,
      });
    }
  }

  const recurring = [...clusters.values()]
    .filter((c) => c.occurrences >= minOccurrences)
    .sort((a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id));

  const stagedLines = [
    '# Distilled ADLC Defenses (Staged Proposal)',
    '',
    `Total findings scanned: ${allFindings.length} | Recurring classes (>= ${minOccurrences}): ${recurring.length}`,
    '',
  ];

  if (recurring.length === 0) {
    stagedLines.push('No recurring finding classes reached the distillation threshold.');
  } else {
    for (const item of recurring) {
      stagedLines.push(
        `## ${item.id} (${item.lens} · ${item.occurrences}x · ${item.severity})`,
        `- **Pattern:** ${item.sampleClaim}`,
        `- **Recommended Defense:** Enforce pre-merge verification against \`${item.canonical.slice(0, 160)}\`.`,
        ''
      );
    }
  }

  const stagedMarkdown = stagedLines.join('\n') + '\n';
  const boosterDir = join(repoRoot, '.booster');
  const stagedRes = writeArtifactFileAtomically(
    boosterDir,
    'distilled-defenses.md',
    stagedMarkdown,
    { rootDir: repoRoot }
  );

  let appliedPath = null;
  let ruleBytes = 0;

  if (apply && recurring.length > 0) {
    const geminiDir = join(repoRoot, '.gemini');
    if (lstatOrNull(geminiDir)?.isSymbolicLink()) {
      throw new Error(`Refusing to write inside symlinked .gemini directory: ${geminiDir}`);
    }
    const rulesDir = join(geminiDir, 'rules');
    if (lstatOrNull(rulesDir)?.isSymbolicLink()) {
      throw new Error(`Refusing to write inside symlinked rules directory: ${rulesDir}`);
    }
    mkdirSync(rulesDir, { recursive: true, mode: 0o755 });
    const ruleFile = join(rulesDir, 'adlc-learned.md');
    if (existsSync(ruleFile) && lstatSync(ruleFile).isSymbolicLink()) {
      throw new Error(`Refusing to write symlinked rule file: ${ruleFile}`);
    }

    const header = '# Learned ADLC Repository Defenses\n\n';
    const bullets = [];
    let currentBytes = Buffer.byteLength(header, 'utf8');

    for (const item of recurring) {
      const bullet = `- **[${item.id} / ${item.lens}]** (${item.occurrences}x): ${item.sampleClaim.replace(/\r?\n/g, ' ').slice(0, 220)}\n`;
      const bLen = Buffer.byteLength(bullet, 'utf8');
      if (currentBytes + bLen > maxRuleBytes) break;
      bullets.push(bullet);
      currentBytes += bLen;
    }

    const finalContent = header + bullets.join('');
    ruleBytes = Buffer.byteLength(finalContent, 'utf8');
    const tmpRule = `${ruleFile}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmpRule, finalContent, { mode: 0o644 });
    renameSync(tmpRule, ruleFile);
    appliedPath = ruleFile;
  }

  let compiledChecksPath = null;
  let compiledChecksCount = 0;

  if (compileChecks) {
    const adlcDir = join(repoRoot, '.adlc');
    if (lstatOrNull(adlcDir)?.isSymbolicLink()) {
      const err = new Error(`Refusing to write learned-checks.json inside symlinked .adlc directory: ${adlcDir}`);
      err.code = 'ESYMLINK';
      throw err;
    }
    const existingFile = join(adlcDir, 'learned-checks.json');
    if (lstatOrNull(existingFile)?.isSymbolicLink()) {
      const err = new Error(`Refusing to overwrite symlinked learned-checks.json: ${existingFile}`);
      err.code = 'ESYMLINK';
      throw err;
    }

    let priorChecks = [];
    if (existsSync(existingFile)) {
      try {
        const parsedPrior = JSON.parse(readFileSync(existingFile, 'utf8'));
        if (validateLearnedChecksSpec(parsedPrior).length === 0) {
          priorChecks = parsedPrior.checks;
        }
      } catch {}
    }

    const mergedById = new Map(priorChecks.map((c) => [c.id, c]));
    for (const cluster of recurring) {
      const synthesized = synthesizeCheckForCluster(cluster);
      if (synthesized) {
        mergedById.set(synthesized.id, synthesized);
      }
    }
    const checksList = [...mergedById.values()].slice(0, MAX_LEARNED_CHECKS);
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      checks: checksList,
    };
    const writeRes = writeArtifactFileAtomically(
      adlcDir,
      'learned-checks.json',
      JSON.stringify(payload, null, 2) + '\n',
      { rootDir: repoRoot }
    );
    if (!writeRes.ok) {
      throw new Error(`Failed to write .adlc/learned-checks.json: ${writeRes.error}`);
    }
    compiledChecksPath = writeRes.path;
    compiledChecksCount = checksList.length;
  }

  return {
    ok: true,
    scannedCount: allFindings.length,
    recurringCount: recurring.length,
    recurring,
    stagedPath: stagedRes.path,
    applied: Boolean(appliedPath),
    appliedPath,
    ruleBytes,
    compiledChecks: Boolean(compiledChecksPath),
    compiledChecksPath,
    compiledChecksCount,
  };
}

function collectCandidateRelativeFiles(repoRoot, changedFiles = null) {
  if (Array.isArray(changedFiles)) {
    const clean = [];
    for (const raw of changedFiles) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const norm = posix.normalize(raw.replace(/\\/g, '/').replace(/^\/+/, ''));
      if (!norm || norm === '.' || norm === '..' || norm.startsWith('../')) continue;
      clean.push(norm);
    }
    return [...new Set(clean)];
  }
  const results = [];
  const walk = (dir, relPrefix) => {
    if (results.length >= 2000) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_WALK_DIRS.has(ent.name)) continue;
        walk(join(dir, ent.name), rel);
      } else if (ent.isFile()) {
        results.push(rel);
      }
    }
  };
  walk(repoRoot, '');
  return results;
}

/**
 * Deterministically evaluate `.adlc/learned-checks.json` against `changedFiles` (or all
 * regular repo files when `changedFiles` is null). Fails closed on symlinked or malformed
 * `.adlc/learned-checks.json`; returns `{ ok: true, exists: false, violations: [] }` when absent.
 */
export function runLearnedChecks(
  repo = process.cwd(),
  { changedFiles = null, checksPath = null } = {}
) {
  const repoRoot = resolve(repo);
  let realRepo = repoRoot;
  try {
    if (existsSync(repoRoot)) realRepo = realpathSync(repoRoot);
  } catch {}

  const adlcDir = join(repoRoot, '.adlc');
  if (lstatOrNull(adlcDir)?.isSymbolicLink()) {
    return {
      ok: false,
      exists: true,
      checkedFiles: 0,
      violations: [],
      error: `Refusing to read symlinked .adlc directory: ${adlcDir}`,
    };
  }

  const targetFile = checksPath ? resolve(checksPath) : join(adlcDir, 'learned-checks.json');
  const st = lstatOrNull(targetFile);
  if (!st) {
    return { ok: true, exists: false, checkedFiles: 0, violations: [] };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return {
      ok: false,
      exists: true,
      checkedFiles: 0,
      violations: [],
      error: `Refusing to read non-regular or symlinked learned-checks.json: ${targetFile}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(targetFile, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      exists: true,
      checkedFiles: 0,
      violations: [],
      error: `Malformed JSON in learned-checks.json: ${err.message}`,
    };
  }

  const specErrors = validateLearnedChecksSpec(parsed);
  if (specErrors.length > 0) {
    return {
      ok: false,
      exists: true,
      checkedFiles: 0,
      violations: [],
      error: `Invalid learned-checks.json schema: ${specErrors.join('; ')}`,
    };
  }

  if (parsed.checks.length === 0) {
    return { ok: true, exists: true, checkedFiles: 0, violations: [] };
  }

  const compiledChecks = parsed.checks.map((c) => ({
    ...c,
    re: c.forbidRegex ? new RegExp(c.forbidRegex) : null,
  }));

  const relFiles = collectCandidateRelativeFiles(repoRoot, changedFiles);
  const violations = [];
  let checkedFiles = 0;

  for (const relPath of relFiles) {
    const applicable = compiledChecks.filter((c) => globMatch(c.glob, relPath));
    if (applicable.length === 0) continue;

    const fullPath = join(repoRoot, relPath);
    const fst = lstatOrNull(fullPath);
    if (!fst || fst.isSymbolicLink() || !fst.isFile() || fst.size > MAX_CHECK_FILE_BYTES) continue;
    try {
      const realFull = realpathSync(fullPath);
      const relReal = relative(realRepo, realFull);
      if (relReal === '..' || relReal.startsWith('../') || relReal.startsWith('..\\') || isAbsolute(relReal)) {
        continue;
      }
    } catch {
      continue;
    }

    const buf = readFileSync(fullPath);
    if (buf.subarray(0, Math.min(buf.length, 2048)).includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    checkedFiles += 1;

    for (const chk of applicable) {
      if (chk.forbidLiteral) {
        const lineIdx = lines.findIndex((l) => l.includes(chk.forbidLiteral));
        if (lineIdx !== -1) {
          violations.push({
            checkId: chk.id,
            file: relPath,
            line: lineIdx + 1,
            description: chk.description || `Forbidden literal '${chk.forbidLiteral}'`,
          });
          continue;
        }
      }
      if (chk.forbidRegex && chk.re) {
        const lineIdx = lines.findIndex((l) => l.length <= 4096 && chk.re.test(l));
        if (lineIdx !== -1) {
          violations.push({
            checkId: chk.id,
            file: relPath,
            line: lineIdx + 1,
            description: chk.description || `Forbidden pattern /${chk.forbidRegex}/`,
          });
          continue;
        }
      }
      if (chk.requireLiteral && !text.includes(chk.requireLiteral)) {
        violations.push({
          checkId: chk.id,
          file: relPath,
          line: 1,
          description: chk.description || `Missing required literal '${chk.requireLiteral}'`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    exists: true,
    checkedFiles,
    violations,
  };
}
