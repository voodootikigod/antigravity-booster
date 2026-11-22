// Automated P5 -> P3 Defense Distillation (`agb distill`, v1.4 Pillar 7b).
//
// Scans `<repo>/.adlc/manifest.jsonl` and `<repo>/.booster/` review/prosecution
// artifacts for recurring finding fingerprints (>= minOccurrences), stages a
// human-reviewable proposal at `<repo>/.booster/distilled-defenses.md`, and when
// `apply === true`, writes compacted guidance to `<repo>/.gemini/rules/adlc-learned.md`
// bounded strictly below `maxRuleBytes` (12,000 bytes per agy 1.5.10 rule-size budget).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeArtifactFileAtomically } from './plan-integrity.mjs';

export const DEFAULT_MAX_RULE_BYTES = 12_000;

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
  };
}

function collectBoosterFindings(repoRoot) {
  const findings = [];
  const boosterDir = join(repoRoot, '.booster');
  if (existsSync(boosterDir)) {
    let entries = [];
    try {
      entries = readdirSync(boosterDir, { withFileTypes: true });
    } catch {}
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(boosterDir, ent.name), 'utf8'));
        const list = Array.isArray(parsed?.findings)
          ? parsed.findings
          : Array.isArray(parsed?.accepted_findings)
          ? parsed.accepted_findings
          : [];
        for (const f of list) findings.push(f);
      } catch {}
    }
  }

  const manifestPath = join(repoRoot, '.adlc', 'manifest.jsonl');
  if (existsSync(manifestPath)) {
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
 * stage `.booster/distilled-defenses.md`, and optionally compact into
 * `.gemini/rules/adlc-learned.md` when `apply === true`.
 */
export function distillRunDefenses({
  repo = process.cwd(),
  apply = false,
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
    const rulesDir = join(repoRoot, '.gemini', 'rules');
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

  return {
    ok: true,
    scannedCount: allFindings.length,
    recurringCount: recurring.length,
    recurring,
    stagedPath: stagedRes.path,
    applied: Boolean(appliedPath),
    appliedPath,
    ruleBytes,
  };
}
