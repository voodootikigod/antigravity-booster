// Pre-plan shaping & deterministic DAG pre-analysis (ADLC P1/P2).
//
// Parses structured Markdown specifications (specs/<slug>-spec.md or brain
// implementation_plan.md) into an ADLC ticket DAG and runs deterministic
// pre-analysis before any LLM tokens are spent in `agb plan`.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, posix, relative, resolve } from 'node:path';
import { scopesOverlap } from '@adlc/core/tickets';
import { getActiveSessionId, getBrainDir, readBrain, resolveSourcePlanMarkdown } from './brain.mjs';
import {
  computeReachability,
  formatStructuralDefects,
  isSafePathSegment,
  normalizePathspec,
  validatePathspec,
  validatePlan,
  verifyDeclaredPaths,
  writeArtifactFileAtomically,
} from './plan-integrity.mjs';
import { forecastOverlaps } from './preflight.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.worktrees', 'coverage', '.booster', '.review', 'scratch', '.adlc', 'dist', 'build']);
const SOURCE_EXTS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const RESOLVE_EXTS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts', '/index.mjs', '/index.js', '/index.ts', '/index.tsx'];
const MAX_COUPLED_FILE_BYTES = 512 * 1024;

function isPlaceholder(val) {
  const s = String(val ?? '').replace(/`/g, '').trim().toLowerCase();
  return !s || s === '(none)' || s === 'none' || s === '-' || s === 'n/a' || s === 'tbd' || s === 'todo' || /^\?+$/.test(s) || /^\.+$/.test(s);
}

function splitListField(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((item) => item.replace(/`/g, '').trim()).filter((item) => !isPlaceholder(item));
}

function analyzeFences(lines) {
  const inFence = new Array(lines.length).fill(false);
  const mermaidBlocks = [];
  let activeFence = null;
  let currentMermaid = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!activeFence) {
      if (m) {
        activeFence = { char: m[1][0], len: m[1].length };
        inFence[i] = true;
        if (/^mermaid\b/i.test(m[2].trim())) currentMermaid = [];
      }
    } else {
      inFence[i] = true;
      const closeRe = new RegExp(`^\\${activeFence.char}{${activeFence.len},}\\s*$`);
      if (closeRe.test(trimmed)) {
        if (currentMermaid) {
          mermaidBlocks.push(currentMermaid.join('\n'));
          currentMermaid = null;
        }
        activeFence = null;
      } else if (currentMermaid) {
        currentMermaid.push(lines[i]);
      }
    }
  }
  return { inFence, mermaidBlocks };
}

function parseTopMetadata(lines, inFence, firstTicketLine, defaultGate, parseErrors) {
  let base = 'main';
  let gate = defaultGate ? { ...defaultGate } : { test: 'npm test' };
  let seenBase = false;
  let seenGate = false;

  for (let i = 0; i < firstTicketLine; i++) {
    if (inFence[i]) continue;
    const raw = lines[i];
    if (!/^\s{0,1}(?:[-*]\s+)?\*\*/.test(raw)) continue;

    if (!seenBase) {
      const baseMatch = raw.match(/^\s{0,1}(?:[-*]\s+)?\*\*Base(?:\s+Branch)?\s*:?\*\*\s*:?\s*`?([^`\r\n\\]+)`?/i);
      if (baseMatch && baseMatch[1].trim()) {
        base = baseMatch[1].trim();
        seenBase = true;
        continue;
      }
    }

    if (!seenGate) {
      const gateMatch = raw.match(/^\s{0,1}(?:[-*]\s+)?\*\*Gate\s*:?\*\*\s*:?\s*(.+)$/i);
      if (gateMatch) {
        seenGate = true;
        const rawGate = gateMatch[1].trim().replace(/\\$/, '').trim().replace(/^`+|`+$/g, '').trim();
        if (rawGate.startsWith('{')) {
          try {
            const parsed = JSON.parse(rawGate);
            const NPM_GATE_RE = /^npm (test|run [a-zA-Z0-9_:-]+)$/;
            const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
            const validKeys = keys.length > 0 && keys.every((k) => k === 'build' || k === 'test' || k === 'autofix');
            const hasBuildOrTest = Boolean(parsed?.build || parsed?.test);
            const validVals =
              validKeys &&
              hasBuildOrTest &&
              keys.every((k) => typeof parsed[k] === 'string' && parsed[k].trim().length > 0) &&
              (!parsed.autofix || NPM_GATE_RE.test(parsed.autofix.trim()));
            if (!validVals) {
              parseErrors.push("plan.gate: **Gate** JSON must declare non-empty 'build' and/or 'test' commands (and optional 'autofix' matching npm test|run <script>)");
            } else {
              gate = {};
              if (parsed.autofix) gate.autofix = parsed.autofix.trim();
              if (parsed.build) gate.build = parsed.build.trim();
              if (parsed.test) gate.test = parsed.test.trim();
            }
          } catch (err) {
            parseErrors.push(`plan.gate: invalid JSON in **Gate** metadata (${err.message})`);
          }
        } else if (rawGate && !isPlaceholder(rawGate)) {
          gate = { test: rawGate };
        }
      }
    }
  }
  return { base, gate };
}

function extractOverviewContext(lines, inFence, firstTicketLine) {
  let startIdx = -1;
  for (let i = 0; i < firstTicketLine; i++) {
    if (inFence[i]) continue;
    if (/^##\s+(?:\d+\.?\s*)?(?:Overview|Problem|Summary|Context|Goal|Architecture)\b/i.test(lines[i].trim())) {
      startIdx = i + 1;
      break;
    }
  }
  const collected = [];
  if (startIdx !== -1) {
    for (let i = startIdx; i < firstTicketLine; i++) {
      if (!inFence[i] && /^#{1,3}\s+/.test(lines[i].trim())) break;
      if (!inFence[i] && /^(?:---|-+)\s*$/.test(lines[i].trim())) continue;
      collected.push(lines[i]);
    }
    return collected.join('\n').trim();
  }
  for (let i = 0; i < firstTicketLine; i++) {
    if (!inFence[i] && /^#{2,3}\s+/.test(lines[i].trim())) break;
    if (!inFence[i] && i === 0 && /^#\s+/.test(lines[i].trim())) continue;
    if (!inFence[i] && /^(?:---|-+)\s*$/.test(lines[i].trim())) continue;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

function parseMermaidGraph(mermaidBlocks) {
  const aliasToTicketId = new Map();
  const rawEdges = [];
  for (const block of mermaidBlocks) {
    const blockLines = block.split(/\r?\n/);
    const firstDirective = blockLines.map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
    if (!firstDirective || !/^(?:graph|flowchart)\b/i.test(firstDirective)) continue;

    for (const rawLine of blockLines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('%%') || /^(?:graph|flowchart)\b/i.test(line)) continue;
      const nodeDefRe = /\b([A-Za-z0-9_.-]+)\s*\[\s*"?(?:📦\s*)?(?:Ticket\s+\d+\s*:\s*)?`?([A-Za-z0-9][A-Za-z0-9_.-]*)`?\s*(?::|—|--|-)/g;
      let nm;
      while ((nm = nodeDefRe.exec(line)) !== null) aliasToTicketId.set(nm[1], nm[2]);
      const edgeRe = /\b([A-Za-z0-9_.-]+?)(?:\s*\[[^\]]*\])?\s*-+>\s*(?:\|[^|]*\|\s*)?([A-Za-z0-9_.-]+)/g;
      let em;
      while ((em = edgeRe.exec(line)) !== null) rawEdges.push({ from: em[1], to: em[2] });
    }
  }
  return { aliasToTicketId, rawEdges };
}

function matchTicketHeading(line) {
  const numbered = line.match(/^###\s+Ticket\s+(?:\d+\s*:\s*)?`?([A-Za-z0-9][A-Za-z0-9_.-]*)`?\s*(?:—|--|-|:)\s*(.+)$/i);
  if (numbered) return { id: numbered[1].trim(), title: numbered[2].trim() };
  const backticked = line.match(/^###\s+`([A-Za-z0-9][A-Za-z0-9_.-]*)`\s*(?:—|--|-|:)\s*(.+)$/);
  if (backticked) return { id: backticked[1].trim(), title: backticked[2].trim() };
  const bare = line.match(/^###\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:—|--|:)\s*(.+)$/);
  if (bare && /[-0-9]/.test(bare[1])) return { id: bare[1].trim(), title: bare[2].trim() };
  return null;
}

/**
 * Parse a structured Markdown specification into an ADLC plan object.
 * Rejects generated `agb_plan_artifact.md` files so compiled outputs never
 * shadow source specs.
 */
export function parseStructuredSpec(
  markdown,
  { repo = process.cwd(), gate: gateOpt, defaultGate = gateOpt ?? { test: 'npm test' } } = {}
) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { structured: false, plan: null, parseErrors: [] };
  const trimmed = markdown.trimStart();
  if (trimmed.startsWith('<!-- Generated by agb') || /^#\s+AGB Plan Artifact\b/m.test(markdown)) {
    return { structured: false, plan: null, parseErrors: [] };
  }

  const lines = markdown.split(/\r?\n/);
  const { inFence, mermaidBlocks } = analyzeFences(lines);
  const sectionStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const hit = matchTicketHeading(lines[i].trim());
    if (hit) sectionStarts.push({ lineIdx: i, ...hit });
  }
  if (sectionStarts.length === 0) return { structured: false, plan: null, parseErrors: [] };

  const parseErrors = [];
  const firstTicketLine = sectionStarts[0].lineIdx;
  const { base, gate } = parseTopMetadata(lines, inFence, firstTicketLine, defaultGate, parseErrors);
  const overview = extractOverviewContext(lines, inFence, firstTicketLine);
  const { aliasToTicketId, rawEdges: mermaidEdges } = parseMermaidGraph(mermaidBlocks);

  const rawTickets = [];
  const pendingEdges = [];
  const ticketsWithExplicitEdges = new Set();

  for (let idx = 0; idx < sectionStarts.length; idx++) {
    const current = sectionStarts[idx];
    const nextLine = idx + 1 < sectionStarts.length ? sectionStarts[idx + 1].lineIdx : lines.length;
    const sectionLines = [];
    const sectionLineIndices = [];
    for (let k = current.lineIdx + 1; k < nextLine; k++) {
      if (!inFence[k] && /^##\s+/.test(lines[k])) break;
      sectionLines.push(lines[k]);
      sectionLineIndices.push(k);
    }
    while (
      sectionLines.length &&
      !inFence[sectionLineIndices[sectionLines.length - 1]] &&
      /^(?:---|-+)\s*$/.test(sectionLines[sectionLines.length - 1].trim())
    ) {
      sectionLines.pop();
      sectionLineIndices.pop();
    }

    let scope = [];
    let rails = [];
    let tier = 'mid';
    let poolHint = 'auto';
    let effort = undefined;
    let hasAcceptanceHeading = false;
    let acceptanceItems = 0;
    let inAcceptanceBlock = false;
    let seenSubheading = false;
    const seenFields = new Set();

    for (let sIdx = 0; sIdx < sectionLines.length; sIdx++) {
      const globalIdx = sectionLineIndices[sIdx];
      if (inFence[globalIdx]) continue;
      const rawLine = sectionLines[sIdx];
      const line = rawLine.trim();
      if (/^#{4,6}\s+/.test(line)) seenSubheading = true;

      const isTopBullet = /^\s{0,1}[-*]\s+/.test(rawLine);
      const segments = !seenSubheading && isTopBullet ? line.replace(/^[-*]\s*/, '').split(/\s+\|\s+/) : [];
      let matchedFieldLine = false;

      for (const seg of segments) {
        const fieldMatch = seg.match(/^\*\*([^*:]+?)\s*:?\*\*\s*:?\s*(.*)$/);
        if (!fieldMatch) continue;
        const fieldName = fieldMatch[1].trim().toLowerCase();
        const fieldVal = fieldMatch[2].trim();

        if (fieldName === 'scope') {
          matchedFieldLine = true;
          inAcceptanceBlock = false;
          if (!seenFields.has('scope')) {
            seenFields.add('scope');
            scope = splitListField(fieldVal).map(normalizePathspec);
          }
        } else if (fieldName === 'rails') {
          matchedFieldLine = true;
          inAcceptanceBlock = false;
          if (!seenFields.has('rails')) {
            seenFields.add('rails');
            rails = splitListField(fieldVal).map(normalizePathspec);
          }
        } else if (fieldName === 'tier') {
          matchedFieldLine = true;
          inAcceptanceBlock = false;
          if (!seenFields.has('tier')) {
            seenFields.add('tier');
            const val = fieldVal.replace(/`/g, '').trim();
            if (!isPlaceholder(val)) tier = val;
          }
        } else if (fieldName === 'pool hint' || fieldName === 'pool_hint') {
          matchedFieldLine = true;
          inAcceptanceBlock = false;
          if (!seenFields.has('pool_hint')) {
            seenFields.add('pool_hint');
            const val = fieldVal.replace(/`/g, '').trim();
            if (!isPlaceholder(val)) poolHint = val;
          }
        } else if (fieldName === 'effort') {
          matchedFieldLine = true;
          inAcceptanceBlock = false;
          if (!seenFields.has('effort')) {
            seenFields.add('effort');
            const val = fieldVal.replace(/`/g, '').trim();
            if (!isPlaceholder(val)) effort = val;
          }
        } else if (fieldName.startsWith('edges')) {
          matchedFieldLine = true;
          inAcceptanceBlock = false;
          if (!seenFields.has('edges')) {
            seenFields.add('edges');
            ticketsWithExplicitEdges.add(current.id);
            const cleaned = fieldVal.replace(/`/g, '').replace(/\([^)]*\)/g, ' ').trim();
            if (!isPlaceholder(cleaned)) {
              for (const clause of cleaned.split(/\s*;\s*/).filter(Boolean)) {
                const depMatch = clause.match(/^(?:depends\s+on|after)\s+(.+)$/i);
                if (depMatch) {
                  const upstreams = depMatch[1].split(/\s*(?:,|\band\b|\s+)\s*/i).map((s) => s.trim()).filter((s) => s && !isPlaceholder(s));
                  for (const u of upstreams) pendingEdges.push({ from: u, to: current.id, declaredOn: current.id, incoming: true });
                  continue;
                }
                for (const part of clause.split(/\s*,\s*/).filter(Boolean)) {
                  if (isPlaceholder(part)) continue;
                  const arrowMatch = part.match(/^([A-Za-z0-9_.-]+?)\s*-+>\s*([A-Za-z0-9_.-]+)$/);
                  if (arrowMatch) {
                    pendingEdges.push({ from: arrowMatch[1], to: arrowMatch[2], declaredOn: current.id });
                  } else {
                    pendingEdges.push({ from: current.id, to: part.trim(), declaredOn: current.id });
                  }
                }
              }
            }
          }
        } else if (fieldName.startsWith('acceptance criteria')) {
          hasAcceptanceHeading = true;
          inAcceptanceBlock = true;
          matchedFieldLine = true;
          if (fieldVal && !isPlaceholder(fieldVal)) acceptanceItems++;
        } else if (fieldName.startsWith('objectives') || fieldName === 'title' || fieldName === 'duration' || fieldName === 'gate') {
          inAcceptanceBlock = false;
          matchedFieldLine = true;
        }
      }

      if (matchedFieldLine) continue;
      if (/^(?:#{4,6}\s+|\*\*)Acceptance Criteria/i.test(line)) {
        hasAcceptanceHeading = true;
        inAcceptanceBlock = true;
        continue;
      }
      if (/^(?:#{4,6}\s+|-\s*\*\*(?:Objectives|Scope|Rails|Edges|Gate|Tier|Pool Hint|Effort))/i.test(line)) {
        inAcceptanceBlock = false;
      }
      if (inAcceptanceBlock) {
        const bulletMatch = line.match(/^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/);
        if (bulletMatch && !isPlaceholder(bulletMatch[1])) acceptanceItems++;
      }
    }

    if (!scope.length) parseErrors.push(`${current.id}: missing or empty Scope field`);
    if (!hasAcceptanceHeading || acceptanceItems === 0) {
      parseErrors.push(`${current.id}: missing Acceptance Criteria section with at least one checkable item`);
    }

    const bodyParts = [];
    if (overview) bodyParts.push(`## Shared Spec Context\n${overview}`);
    bodyParts.push(`## Ticket ${current.id}: ${current.title}\n${sectionLines.join('\n').trim()}`);

    const ticketEntry = {
      id: current.id,
      title: current.title,
      body: bodyParts.join('\n\n'),
      scope,
      rails,
      edges: [],
      tier,
      pool_hint: poolHint,
    };
    if (effort !== undefined) ticketEntry.effort = effort;
    rawTickets.push(ticketEntry);
  }

  const byId = new Map(rawTickets.map((t) => [t.id, t]));
  const resolveNodeId = (token) => {
    if (byId.has(token)) return token;
    if (aliasToTicketId.has(token)) return aliasToTicketId.get(token);
    const stripped = token.replace(/^n_/, '');
    return byId.has(stripped) ? stripped : token;
  };

  const addEdge = (fromId, toId, declaredOn, incoming = false) => {
    const resolvedFrom = resolveNodeId(fromId);
    const resolvedTo = resolveNodeId(toId);
    const fromTicket = byId.get(resolvedFrom);
    if (!fromTicket) {
      parseErrors.push(`${declaredOn}: edge references unknown ${incoming ? 'upstream' : 'source'} ticket '${resolvedFrom}'`);
      return;
    }
    if (!fromTicket.edges.some((e) => e.to === resolvedTo)) fromTicket.edges.push({ to: resolvedTo });
  };

  for (const edge of pendingEdges) addEdge(edge.from, edge.to, edge.declaredOn, edge.incoming);
  for (const mEdge of mermaidEdges) {
    const resolvedFrom = resolveNodeId(mEdge.from);
    const resolvedTo = resolveNodeId(mEdge.to);
    if (byId.has(resolvedFrom) && byId.has(resolvedTo) && !ticketsWithExplicitEdges.has(resolvedFrom)) {
      addEdge(resolvedFrom, resolvedTo, resolvedFrom);
    }
  }

  return { structured: true, plan: { repo: resolve(repo), base, gate, tickets: rawTickets }, parseErrors };
}

function isContainedInRepo(fullPath, realRoot) {
  try {
    const real = realpathSync(fullPath);
    return real === realRoot || real.startsWith(`${realRoot}/`);
  } catch {
    return false;
  }
}

function walkRepoFiles(dir, rootDir, realRoot, allTicketScopes = null, out = []) {
  if (!existsSync(dir)) return out;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (allTicketScopes && !scopesOverlap({ scope: [`${rel}/**`] }, { scope: allTicketScopes })) continue;
      if (isContainedInRepo(full, realRoot)) walkRepoFiles(full, rootDir, realRoot, allTicketScopes, out);
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      if (allTicketScopes && !scopesOverlap({ scope: [rel] }, { scope: allTicketScopes })) continue;
      if (isContainedInRepo(full, realRoot)) out.push(rel);
    }
  }
  return out;
}

function extractRelativeImports(content) {
  const specifiers = new Set();
  const jsPatterns = [
    /\b(?:import|export)\s+(?:[^;'"`]{0,1024}?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of jsPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) specifiers.add(m[1]);
  }
  return [...specifiers];
}

function resolveImportTarget(relImporter, spec, fileSet) {
  const candidateBase = posix.normalize(posix.join(posix.dirname(relImporter), spec));
  if (fileSet.has(candidateBase)) return candidateBase;
  for (const suffix of RESOLVE_EXTS) {
    if (fileSet.has(`${candidateBase}${suffix}`)) return `${candidateBase}${suffix}`;
  }
  const tsSwap = candidateBase.replace(/\.(mjs|cjs|js)$/, '');
  if (tsSwap !== candidateBase) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      if (fileSet.has(`${tsSwap}${ext}`)) return `${tsSwap}${ext}`;
    }
  }
  return null;
}

function readExternalCouplingEdges(rootDir, couplingFile) {
  const candidate = couplingFile ?? process.env.AGB_GRAPH_COUPLING_FILE ?? join(rootDir, '.adlc', 'graph-coupling.json');
  if (!candidate || !existsSync(candidate)) return [];
  try {
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    const rawList = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.edges)
      ? parsed.edges
      : [];
    const pairs = [];
    for (const item of rawList) {
      const from = String(item?.from ?? item?.importer ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
      const to = String(item?.to ?? item?.imported ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (from && to) pairs.push({ from, to });
    }
    const importMap =
      parsed?.imports && typeof parsed.imports === 'object' && !Array.isArray(parsed.imports)
        ? parsed.imports
        : parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !Array.isArray(parsed.edges)
        ? parsed
        : null;
    if (importMap) {
      for (const [importer, targets] of Object.entries(importMap)) {
        const cleanFrom = importer.replace(/\\/g, '/').replace(/^\.\//, '');
        if (Array.isArray(targets)) {
          for (const t of targets) {
            const cleanTo = String(t ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
            if (cleanFrom && cleanTo) pairs.push({ from: cleanFrom, to: cleanTo });
          }
        }
      }
    }
    return pairs;
  } catch {
    return [];
  }
}

export function scanStaticImportCoupling(tickets, repo = process.cwd(), { couplingFile } = {}) {
  if (!Array.isArray(tickets) || tickets.length < 2 || !repo || !existsSync(repo)) return [];
  const reach = computeReachability(tickets);
  const isSerialized = (a, b) => Boolean(reach[a]?.has(b) || reach[b]?.has(a));
  const concurrentTickets = tickets.filter((a) => tickets.some((b) => a.id !== b.id && !isSerialized(a.id, b.id)));
  if (concurrentTickets.length < 2) return [];

  const rootDir = resolve(repo);
  let realRoot = rootDir;
  try { realRoot = realpathSync(rootDir); } catch { return []; }

  const rawScopes = concurrentTickets.flatMap((t) => t.scope ?? []);
  if (!rawScopes.length) return [];

  const globScopes = [];
  const literalFiles = [];
  for (const s of rawScopes) {
    const norm = normalizePathspec(String(s ?? '').replace(/\\/g, '/').replace(/^\.\//, ''));
    if (!validatePathspec(norm)) continue;
    if (/[*?[\]{}]/.test(norm)) { globScopes.push(norm); continue; }
    const full = join(rootDir, norm);
    if (!existsSync(full) || !isContainedInRepo(full, realRoot)) continue;
    const st = statSync(full);
    if (st.isDirectory()) globScopes.push(`${norm}/**`);
    else if (st.isFile() && SOURCE_EXTS.has(extname(norm))) literalFiles.push(norm);
  }

  const walkedFiles = globScopes.length ? walkRepoFiles(rootDir, rootDir, realRoot, globScopes) : [];
  const allFiles = [...new Set([...literalFiles, ...walkedFiles])];

  const expandedScopesByTicket = new Map();
  for (const t of concurrentTickets) {
    const expanded = (t.scope ?? []).map((s) => {
      const norm = normalizePathspec(String(s ?? '').replace(/\\/g, '/').replace(/^\.\//, ''));
      if (!/[*?[\]{}]/.test(norm) && existsSync(join(rootDir, norm))) {
        try { if (statSync(join(rootDir, norm)).isDirectory()) return `${norm}/**`; } catch {}
      }
      return norm;
    });
    expandedScopesByTicket.set(t.id, expanded);
  }

  const warnings = [];
  const seen = new Set();
  const recordCoupling = (fromTicketId, toTicketId, importerFile, importedFile) => {
    const dedupeKey = `${fromTicketId}->${toTicketId}:${importerFile}->${importedFile}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    warnings.push({
      fromTicket: fromTicketId,
      toTicket: toTicketId,
      importerFile,
      importedFile,
      reason: `concurrent tickets ${fromTicketId} and ${toTicketId} have direct static import coupling (${importerFile} imports ${importedFile}) without a serializing DAG edge`,
    });
  };

  if (allFiles.length) {
    const fileSet = new Set(allFiles);
    const normalizedTicketScopes = new Map();
    for (const t of concurrentTickets) {
      const expanded = expandedScopesByTicket.get(t.id) ?? [];
      normalizedTicketScopes.set(t.id, allFiles.filter((f) => scopesOverlap({ scope: [f] }, { scope: expanded })));
    }

    for (const fromTicket of concurrentTickets) {
      for (const importerFile of normalizedTicketScopes.get(fromTicket.id) ?? []) {
        const fullImporter = join(rootDir, importerFile);
        let content = '';
        try {
          if (statSync(fullImporter).size > MAX_COUPLED_FILE_BYTES) continue;
          content = readFileSync(fullImporter, 'utf8');
        } catch {
          continue;
        }
        for (const spec of extractRelativeImports(content)) {
          const targetFile = resolveImportTarget(importerFile, spec, fileSet);
          if (!targetFile) continue;
          for (const toTicket of concurrentTickets) {
            if (toTicket.id === fromTicket.id || isSerialized(fromTicket.id, toTicket.id)) continue;
            if (!(normalizedTicketScopes.get(toTicket.id) ?? []).includes(targetFile)) continue;
            recordCoupling(fromTicket.id, toTicket.id, importerFile, targetFile);
          }
        }
      }
    }
  }

  for (const { from, to } of readExternalCouplingEdges(rootDir, couplingFile)) {
    for (const fromTicket of concurrentTickets) {
      if (!scopesOverlap({ scope: [from] }, { scope: expandedScopesByTicket.get(fromTicket.id) ?? [] })) continue;
      for (const toTicket of concurrentTickets) {
        if (toTicket.id === fromTicket.id || isSerialized(fromTicket.id, toTicket.id)) continue;
        if (!scopesOverlap({ scope: [to] }, { scope: expandedScopesByTicket.get(toTicket.id) ?? [] })) continue;
        recordCoupling(fromTicket.id, toTicket.id, from, to);
      }
    }
  }

  return warnings;
}

function resolveSpecMarkdown(specInput, brainDir, { raw = false } = {}) {
  if (raw) return String(specInput ?? '');
  if (typeof specInput === 'string' && (specInput.includes('\n') || specInput.trimStart().startsWith('#'))) return specInput;
  if (typeof specInput === 'string') {
    const looksLikePath = specInput.includes('/') || specInput.includes('\\') || /\.(?:md|markdown|txt|json|csv)$/i.test(specInput);
    if (existsSync(specInput) && statSync(specInput).isFile()) return readFileSync(resolve(specInput), 'utf8');
    if (looksLikePath) throw new Error(`spec file not found: ${specInput}`);
  }
  return resolveSourcePlanMarkdown(readBrain(specInput, brainDir));
}

export function preAnalyzeSpec(specInput, { repo = process.cwd(), gate, brainDir, maxTicketScope = 12, raw = false, strict = false } = {}) {
  const markdown = resolveSpecMarkdown(specInput, brainDir, { raw });
  const parsed = parseStructuredSpec(markdown, { repo, defaultGate: gate ?? { test: 'npm test' } });
  const source = typeof specInput === 'string' && !raw && !specInput.includes('\n') ? specInput : 'inline';

  if (!parsed.structured || !parsed.plan) {
    return {
      ok: false,
      structured: false,
      source,
      plan: null,
      structuralErrors: ['spec does not contain structured ticket sections (### Ticket N: `ID` — Title)'],
      overlaps: [],
      missingRails: [],
      couplingWarnings: [],
      scopeWarnings: [],
      readinessScore: 0,
    };
  }

  const { plan, parseErrors } = parsed;
  const validationErrors = validatePlan(plan);
  const overlaps = forecastOverlaps(plan.tickets ?? []);
  const missingRails = verifyDeclaredPaths(plan.tickets ?? [], repo);
  const couplingWarnings = scanStaticImportCoupling(plan.tickets ?? [], repo);
  const structuralErrors = [...parseErrors, ...validationErrors, ...formatStructuralDefects(overlaps, missingRails)];

  const scopeWarnings = [];
  for (const t of plan.tickets ?? []) {
    if (Array.isArray(t.scope) && t.scope.length > maxTicketScope) {
      scopeWarnings.push(`${t.id}: declares ${t.scope.length} scope globs (exceeds recommended maxTicketScope=${maxTicketScope})`);
    }
  }

  const penalty = 25 * structuralErrors.length + 10 * couplingWarnings.length + 5 * scopeWarnings.length;
  const readinessScore = Math.max(0, Math.min(100, 100 - penalty));
  const ok = structuralErrors.length === 0 && (!strict || (couplingWarnings.length === 0 && scopeWarnings.length === 0));
  return { ok, structured: true, source, plan, structuralErrors, overlaps, missingRails, couplingWarnings, scopeWarnings, readinessScore };
}

export function syncBrainPlanArtifact(
  specMarkdown,
  { repo = process.cwd(), brainDir = getBrainDir(), sessionId = getActiveSessionId(), filename = 'implementation_plan.md' } = {}
) {
  let boosterRes = null;
  if (repo && existsSync(repo)) {
    boosterRes = writeArtifactFileAtomically(join(resolve(repo), '.booster'), 'agb_plan_artifact.md', specMarkdown, { rootDir: repo });
  }
  if (isSafePathSegment(sessionId)) {
    const brainRes = writeArtifactFileAtomically(join(brainDir, sessionId), filename, specMarkdown);
    if (brainRes.ok) return brainRes;
  }
  if (boosterRes && boosterRes.ok) return boosterRes;
  return { ok: false, path: null, error: 'missing or invalid sessionId' };
}

export function formatShapeReport(analysis, { json = false } = {}) {
  if (json) return JSON.stringify(analysis, null, 2);
  const ticketCount = analysis.plan?.tickets?.length ?? 0;
  const lines = [`agb shape: ${analysis.ok ? 'PASS' : 'FAIL'} (structured=${analysis.structured}, tickets=${ticketCount}, readiness=${analysis.readinessScore}/100)`];
  if (analysis.structuralErrors?.length) {
    lines.push('\nBlocking Structural / DAG Errors:');
    for (const err of analysis.structuralErrors) lines.push(`  ✖ ${err}`);
  }
  if (analysis.couplingWarnings?.length) {
    lines.push('\nStatic Import Coupling Warnings:');
    for (const w of analysis.couplingWarnings) lines.push(`  ⚠ ${w.reason}`);
  }
  if (analysis.scopeWarnings?.length) {
    lines.push('\nScope Size Warnings:');
    for (const w of analysis.scopeWarnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join('\n');
}

export function runShapeCli(rest = [], { repo = process.cwd(), stdout = console.log, stderr = console.error } = {}) {
  let json = false;
  let strict = false;
  let syncBrain = false;
  let maxTicketScope = 12;
  const positionals = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--analyze') continue;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--strict') { strict = true; continue; }
    if (arg === '--sync-brain') { syncBrain = true; continue; }
    if (arg === '--max-ticket-scope') {
      const val = Number(rest[++i]);
      if (!Number.isInteger(val) || val < 1) {
        stderr('agb shape: --max-ticket-scope requires a positive integer');
        return 1;
      }
      maxTicketScope = val;
      continue;
    }
    if (arg.startsWith('--')) {
      stderr(`agb shape: unknown option '${arg}'`);
      return 1;
    }
    positionals.push(arg);
  }

  const specArg = positionals[0];
  if (!specArg) {
    stderr('usage: agb shape <spec.md | id> [repo] [--analyze] [--json] [--sync-brain] [--max-ticket-scope <n>] [--strict]');
    return 1;
  }
  const targetRepo = resolve(positionals[1] ?? repo);

  let rawMd;
  let analysis;
  try {
    rawMd = resolveSpecMarkdown(specArg);
    analysis = preAnalyzeSpec(rawMd, { repo: targetRepo, maxTicketScope, raw: true, strict });
  } catch (err) {
    stderr(`agb shape: ${err.message}`);
    return 1;
  }

  const failed = !analysis.ok;
  if (syncBrain) {
    if (failed) {
      analysis.sync = { ok: false, path: null, error: 'skipped because pre-analysis failed' };
    } else {
      const synced = syncBrainPlanArtifact(rawMd, { repo: targetRepo });
      analysis.sync = synced;
      if (!synced.ok) {
        stdout(formatShapeReport(analysis, { json }));
        stderr(`agb shape: brain sync failed: ${synced.error}`);
        return 1;
      }
      if (!json) stderr(`agb shape: synced brain artifact → ${synced.path}`);
    }
  }

  stdout(formatShapeReport(analysis, { json }));
  return failed ? 2 : 0;
}
