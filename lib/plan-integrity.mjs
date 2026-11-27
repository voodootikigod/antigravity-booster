// Plan pathspec validation, package.json gate-script integrity verification,
// atomic artifact writing, and hierarchical ticket decomposition helpers.

import { existsSync, lstatSync, mkdirSync, chmodSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateTicket, topoSort, scopesOverlap } from '@adlc/core/tickets';
import { tierCandidates, TIER_CANDIDATES } from './pools.mjs';
import { VALID_EFFORTS } from './models.mjs';
import { validateTwinsConfig } from './twins.mjs';

export const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const PATHSPEC_RE =
  /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\*{1,2}(?:\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\*[a-zA-Z0-9_.-]*)(?:\/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\*{1,2}(?:\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\*[a-zA-Z0-9_.-]*))*$/;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isSafePathSegment(seg) {
  return typeof seg === 'string' && SAFE_SEGMENT_RE.test(seg) && !seg.includes('..');
}

export function extractPositionalArgs(tokens, valueFlags = new Set()) {
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (valueFlags.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    positional.push(token);
  }
  return positional;
}

export function sanitizeRemoteUrl(remote) {
  if (typeof remote !== 'string' || !remote.trim()) return '';
  const trimmed = remote.trim();
  try {
    const u = new URL(trimmed);
    if (u.username || u.password || u.search || u.hash) {
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      return u.toString();
    }
  } catch {
    // non-WHATWG URL (e.g. SCP-like git@github.com:owner/repo.git)
  }
  return trimmed.replace(/\/\/[^/@\s]+@/, '//');
}

function isEscapingRelative(rel) {
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

export function writeArtifactFileAtomically(dir, filename, content, { rootDir } = {}) {
  if (!isSafePathSegment(filename)) {
    return { ok: false, path: null, error: 'invalid filename' };
  }
  try {
    const resolvedDir = resolve(dir);
    let realRoot = null;
    let targetDir = resolvedDir;
    if (rootDir) {
      const resolvedRoot = resolve(rootDir);
      realRoot = realpathSync(resolvedRoot);
      let relFromRoot = relative(resolvedRoot, resolvedDir);
      if (isEscapingRelative(relFromRoot)) {
        const relFromReal = relative(realRoot, resolvedDir);
        if (!isEscapingRelative(relFromReal)) {
          relFromRoot = relFromReal;
        } else {
          // Handle cross-alias paths where dir uses a symlinked ancestor (e.g. /var/...)
          // while rootDir was already canonicalized (e.g. /private/var/...).
          let probe = resolvedDir;
          const tail = [];
          let matched = false;
          while (probe) {
            try {
              if (realpathSync(probe) === realRoot) {
                matched = true;
                break;
              }
            } catch (err) {
              if (err?.code !== 'ENOENT') throw err;
            }
            const parent = dirname(probe);
            if (parent === probe) break;
            tail.unshift(basename(probe));
            probe = parent;
          }
          if (!matched) {
            return { ok: false, path: null, error: `artifact directory escapes root: ${resolvedDir}` };
          }
          relFromRoot = tail.join(sep);
        }
      }
      targetDir = relFromRoot ? join(realRoot, relFromRoot) : realRoot;
      let cur = realRoot;
      for (const seg of relFromRoot.split(sep).filter(Boolean)) {
        cur = join(cur, seg);
        try {
          const st = lstatSync(cur);
          if (st.isSymbolicLink()) {
            return { ok: false, path: null, error: `symbolic link not allowed: ${cur}` };
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
    } else {
      try {
        if (lstatSync(resolvedDir).isSymbolicLink()) {
          return { ok: false, path: null, error: `symbolic link not allowed: ${resolvedDir}` };
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    if (realRoot) {
      const realDir = realpathSync(targetDir);
      const rel = relative(realRoot, realDir);
      if (isEscapingRelative(rel)) {
        return { ok: false, path: null, error: `artifact directory escapes root: ${resolvedDir}` };
      }
    }
    if (!realRoot || targetDir !== realRoot) {
      try { chmodSync(targetDir, 0o700); } catch {}
    }
    const targetPath = join(targetDir, filename);
    try {
      if (lstatSync(targetPath).isSymbolicLink()) {
        return { ok: false, path: null, error: `refusing to overwrite symbolic link: ${targetPath}` };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmpPath, String(content ?? ''), { mode: 0o600, flag: 'wx' });
    renameSync(tmpPath, targetPath);
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, path: null, error: err.message };
  }
}

export function normalizePathspec(p) {
  if (typeof p !== 'string') return p;
  if (p.endsWith('/') && p !== '/') {
    return `${p}**`;
  }
  return p;
}

export function validatePathspec(p, { allowRootWildcard = false } = {}) {
  if (typeof p !== 'string') return false;
  if (p === '*' && allowRootWildcard) return true;
  if (p === '*' || p === '**' || p === '.') return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '.' || s === '..' || s === '')) return false;
  if (posix.normalize(p) !== p) return false;
  return PATHSPEC_RE.test(p);
}

export function verifyGateScriptIntegrity(candidatePkg, baselinePkg, gateCommand) {
  const match = /^npm (test|run ([a-zA-Z0-9_:-]+))$/.exec(gateCommand);
  if (!match) {
    const err = new Error(`Invalid npm gate command: ${gateCommand}`);
    err.kind = 'gate_script_tampering';
    throw err;
  }
  const rootScriptName = match[1] === 'test' ? 'test' : match[2];
  const baselineScripts = baselinePkg?.scripts ?? {};
  const candidateScripts = candidatePkg?.scripts ?? {};

  const baselineMain = baselineScripts[rootScriptName];
  if (typeof baselineMain !== 'string') {
    const err = new Error(`Baseline package.json missing required script '${rootScriptName}'`);
    err.kind = 'gate_script_tampering';
    throw err;
  }
  const candidateMain = candidateScripts[rootScriptName];
  if (typeof candidateMain !== 'string') {
    const err = new Error(`Candidate package.json missing required script '${rootScriptName}'`);
    err.kind = 'gate_script_tampering';
    throw err;
  }

  function extractDelegatedScripts(commandStr) {
    if (typeof commandStr !== 'string') return [];
    const matches = [];
    const re = /\bnpm\s+(?:--?[a-zA-Z0-9][a-zA-Z0-9_.:=-]*\s+)*(?:run(?:-script)?\s+(?:--?[a-zA-Z0-9][a-zA-Z0-9_.:=-]*\s+)*([a-zA-Z0-9_:][a-zA-Z0-9_.:-]*)|test)\b/g;
    let m;
    while ((m = re.exec(commandStr)) !== null) {
      matches.push(m[1] || 'test');
    }
    return matches;
  }

  const queue = [rootScriptName];
  const visited = new Set();

  while (queue.length > 0) {
    const scriptName = queue.shift();
    if (visited.has(scriptName)) continue;
    visited.add(scriptName);

    const baseCmd = baselineScripts[scriptName];
    const candCmd = candidateScripts[scriptName];

    if (scriptName === rootScriptName) {
      const mainBaseHash = createHash('sha256').update(baseCmd).digest('hex');
      const mainCandHash = createHash('sha256').update(candCmd).digest('hex');
      if (mainBaseHash !== mainCandHash) {
        const err = new Error(
          `Gate script '${scriptName}' command string modified from baseline: '${baseCmd}' vs '${candCmd}'`
        );
        err.kind = 'gate_script_tampering';
        throw err;
      }
    } else {
      if (baseCmd === undefined && candCmd === undefined) continue;
      if (baseCmd === undefined && candCmd !== undefined) {
        const err = new Error(`Unauthorized script injected in candidate: '${scriptName}'`);
        err.kind = 'gate_script_tampering';
        throw err;
      }
      if (baseCmd !== undefined && candCmd === undefined) {
        const err = new Error(`Candidate package.json missing required script '${scriptName}'`);
        err.kind = 'gate_script_tampering';
        throw err;
      }
      const baseHash = createHash('sha256').update(baseCmd).digest('hex');
      const candHash = createHash('sha256').update(candCmd).digest('hex');
      if (baseHash !== candHash) {
        const err = new Error(
          `Gate script '${scriptName}' command string modified from baseline: '${baseCmd}' vs '${candCmd}'`
        );
        err.kind = 'gate_script_tampering';
        throw err;
      }
    }

    for (const hook of [`pre${scriptName}`, `post${scriptName}`]) {
      const baseHook = baselineScripts[hook];
      const candHook = candidateScripts[hook];
      if (baseHook === undefined) {
        if (candHook !== undefined) {
          const err = new Error(`Unauthorized lifecycle hook injected in candidate: '${hook}'`);
          err.kind = 'gate_script_tampering';
          throw err;
        }
      } else {
        if (candHook !== baseHook) {
          const err = new Error(`Lifecycle hook '${hook}' modified from baseline`);
          err.kind = 'gate_script_tampering';
          throw err;
        }
        for (const delegated of extractDelegatedScripts(baseHook)) {
          queue.push(delegated);
        }
      }
    }

    for (const delegated of extractDelegatedScripts(baseCmd)) {
      queue.push(delegated);
    }
  }

  const GLOBAL_HOOKS = ['install', 'postinstall', 'preinstall', 'prepare', 'prepack', 'postpack', 'publish'];
  for (const hook of GLOBAL_HOOKS) {
    const baseHook = baselineScripts[hook];
    const candHook = candidateScripts[hook];
    if (baseHook === undefined) {
      if (candHook !== undefined) {
        const err = new Error(`Unauthorized global lifecycle hook injected in candidate: '${hook}'`);
        err.kind = 'gate_script_tampering';
        throw err;
      }
    } else if (candHook !== baseHook) {
      const err = new Error(`Global lifecycle hook '${hook}' modified from baseline`);
      err.kind = 'gate_script_tampering';
      throw err;
    }
  }
  return true;
}

/**
 * Hierarchical sub-ticket decomposition:
 * Splits tickets with scopes larger than maxScope into sequential, bounded
 * sub-tickets with disjoint scopes and explicit dependent edges.
 */
export function decomposeTickets(tickets, { maxScope = 3, repo } = {}) {
  if (!Array.isArray(tickets)) return [];
  const limit = Math.max(1, Number(maxScope) || 3);
  const hasRepo = Boolean(repo && existsSync(repo));
  const usedIds = new Set(tickets.map((t) => t?.id).filter(Boolean));
  const replacements = new Map();
  const result = [];

  for (const t of tickets) {
    const scope = Array.isArray(t.scope) ? t.scope : [];
    if (scope.length <= limit) {
      result.push({ ...t });
      continue;
    }

    const chunks = [];
    for (let i = 0; i < scope.length; i += limit) {
      chunks.push(scope.slice(i, i + limit));
    }

    const partIds = chunks.map((_, idx) => {
      const partNum = idx + 1;
      let candidate = `${t.id}-p${partNum}`;
      let suffix = 1;
      while (usedIds.has(candidate)) {
        candidate = `${t.id}-p${partNum}_${suffix++}`;
      }
      usedIds.add(candidate);
      return candidate;
    });

    const subTickets = chunks.map((chunk, idx) => {
      const partNum = idx + 1;
      const subId = partIds[idx];
      const notOverlappingChunk = (f) => !scopesOverlap({ scope: [f] }, { scope: chunk });
      const upstreamFiles = chunks.slice(0, idx).flat().filter(notOverlappingChunk);
      const downstreamFiles = chunks.slice(idx + 1).flat().filter(
        (f) => notOverlappingChunk(f) && (!hasRepo || /[*?[\]{}]/.test(f) || existsSync(join(repo, f)))
      );
      const baseRails = (t.rails ?? []).filter(notOverlappingChunk);
      const otherFiles = [...upstreamFiles, ...downstreamFiles];
      const subRails = Array.from(new Set([...baseRails, ...otherFiles]));
      const subEdges = partNum < chunks.length
        ? [{ to: partIds[idx + 1] }]
        : (t.edges ? t.edges.map((e) => ({ ...e })) : []);

      return {
        ...t,
        id: subId,
        title: `${t.title} (Part ${partNum}/${chunks.length})`,
        body: `${t.body}\n\n[Sub-task ${partNum}/${chunks.length}: focus implementation specifically on ${chunk.join(', ')}]`,
        scope: chunk,
        rails: subRails,
        edges: subEdges,
      };
    });

    replacements.set(t.id, subTickets[0].id);
    result.push(...subTickets);
  }

  if (replacements.size > 0) {
    for (const t of result) {
      if (t.edges?.length) {
        for (const e of t.edges) {
          if (replacements.has(e.to)) {
            e.to = replacements.get(e.to);
          }
        }
      }
    }
  }

  return result;
}

export function computeReachability(tickets) {
  const succ = Object.fromEntries((tickets ?? []).map((t) => [t.id, (t.edges ?? []).map((e) => e.to)]));
  const reach = {};
  const visit = (id, acc) => {
    for (const n of succ[id] ?? []) {
      if (!acc.has(n)) {
        acc.add(n);
        visit(n, acc);
      }
    }
    return acc;
  };
  for (const t of tickets ?? []) reach[t.id] = visit(t.id, new Set());
  return reach;
}

/**
 * Deterministic check: verify literal (non-glob) rail paths declared on
 * tickets exist in the repository (unless created by an upstream ticket's scope).
 */
export function verifyDeclaredPaths(tickets, repo) {
  if (!repo || !existsSync(repo) || !Array.isArray(tickets)) return [];
  const root = resolve(repo);
  const reach = computeReachability(tickets);
  const missing = [];
  for (const t of tickets) {
    const upstreams = tickets.filter((u) => reach[u.id]?.has(t.id));
    for (const r of t.rails ?? []) {
      if (typeof r !== 'string' || !r.trim() || /[*?[\]{}]/.test(r)) continue;
      const target = resolve(root, r);
      const rel = relative(root, target);
      if (isAbsolute(r) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
        missing.push({ id: t.id, rail: r });
        continue;
      }
      if (upstreams.some((u) => scopesOverlap(u, { scope: [r] }))) continue;
      if (!existsSync(target)) {
        missing.push({ id: t.id, rail: r });
      }
    }
  }
  return missing;
}

export function formatStructuralDefects(overlaps = [], missingRails = []) {
  return [
    ...overlaps.map(
      (o) =>
        `tickets ${o.a} and ${o.b} run in parallel but declare overlapping scopes ` +
        `(${JSON.stringify(o.scopes)}) — repartition the files or add an edge`
    ),
    ...missingRails.map(
      ({ id, rail }) =>
        `${id}: declared rail '${rail}' does not exist in repo and is not created by an upstream ticket`
    ),
  ];
}

export function validatePlan(plan, { strictGates = true } = {}) {
  const errors = [];
  if (!plan.repo) errors.push('plan.repo is required (absolute path to target repo)');
  if (plan.adlcBin !== undefined) {
    errors.push('plan.adlcBin is prohibited: ADLC binary must be resolved and authenticated by the runtime');
  }
  if (plan.disableOrchestrator !== undefined && typeof plan.disableOrchestrator !== 'boolean') {
    errors.push('plan.disableOrchestrator must be a boolean when provided');
  }
  if (plan.allowBreakingTestMigration !== undefined && typeof plan.allowBreakingTestMigration !== 'boolean') {
    errors.push('plan.allowBreakingTestMigration must be a boolean when provided');
  }
  if (plan.holdouts !== undefined && typeof plan.holdouts !== 'boolean') {
    errors.push('plan.holdouts must be a boolean when provided');
  }
  if (plan.gateProvenance !== undefined) {
    if (
      !plan.gateProvenance ||
      typeof plan.gateProvenance !== 'object' ||
      Array.isArray(plan.gateProvenance)
    ) {
      errors.push('plan.gateProvenance must be a plain object when provided');
    } else {
      const extraProvenanceKeys = Object.keys(plan.gateProvenance).filter(
        (k) => k !== 'coldstartHashes'
      );
      if (extraProvenanceKeys.length) {
        errors.push(
          `plan.gateProvenance contains unsupported key(s): ${extraProvenanceKeys.join(', ')} (only coldstartHashes is allowed)`
        );
      }
      if (plan.gateProvenance.coldstartHashes !== undefined) {
        const hashes = plan.gateProvenance.coldstartHashes;
        if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) {
          errors.push('plan.gateProvenance.coldstartHashes must be a plain object of non-empty string hashes');
        } else {
          for (const [ticketId, hash] of Object.entries(hashes)) {
            if (typeof hash !== 'string' || !hash.trim()) {
              errors.push(`plan.gateProvenance.coldstartHashes['${ticketId}'] must be a non-empty string`);
            }
          }
        }
      }
    }
  }
  const NPM_GATE_RE = /^npm (test|run [a-zA-Z0-9_:-]+)$/;
  if (!plan.gate || typeof plan.gate !== 'object' || Array.isArray(plan.gate) || (!plan.gate.build && !plan.gate.test)) {
    errors.push('plan.gate must declare at least one of build/test commands');
  } else {
    const extraGateKeys = Object.keys(plan.gate).filter(
      (k) => k !== 'build' && k !== 'test' && k !== 'autofix' && k !== 'twins'
    );
    if (extraGateKeys.length) {
      errors.push(`plan.gate contains unsupported key(s): ${extraGateKeys.join(', ')} (only autofix, build, test, and twins are allowed)`);
    }
    for (const k of ['autofix', 'build', 'test']) {
      if (plan.gate[k] !== undefined && (typeof plan.gate[k] !== 'string' || !plan.gate[k].trim())) {
        errors.push(`plan.gate.${k} must be a non-empty string`);
      }
    }
    if (plan.gate.twins !== undefined) {
      errors.push(...validateTwinsConfig(plan.gate.twins));
    }
    if (strictGates) {
      if (plan.gate.autofix && !NPM_GATE_RE.test(plan.gate.autofix)) {
        errors.push(`plan.gate.autofix must match ${NPM_GATE_RE} (got '${plan.gate.autofix}')`);
      }
      if (plan.gate.build && !NPM_GATE_RE.test(plan.gate.build)) {
        errors.push(`plan.gate.build must match ${NPM_GATE_RE} (got '${plan.gate.build}')`);
      }
      if (plan.gate.test && !NPM_GATE_RE.test(plan.gate.test)) {
        errors.push(`plan.gate.test must match ${NPM_GATE_RE} (got '${plan.gate.test}')`);
      }
    }
  }
  if (!Array.isArray(plan.tickets)) {
    errors.push(plan.tickets === undefined ? 'plan.tickets is empty' : 'plan.tickets must be an array');
    return errors;
  }
  if (!plan.tickets.length) errors.push('plan.tickets is empty');
  for (const t of plan.tickets) errors.push(...validateTicket(t));
  const ids = new Set();
  const normalized = new Map();
  for (const t of plan.tickets ?? []) {
    if (!t.id) continue;
    if (ids.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
    if (!TICKET_ID_RE.test(t.id)) {
      errors.push(`${t.id}: ticket id must match ${TICKET_ID_RE} — it is used as a worktree directory name and a git branch name`);
    }
    const key = t.id.toLowerCase();
    const clash = normalized.get(key);
    if (clash !== undefined && clash !== t.id) {
      errors.push(`${t.id}: ticket id collides with '${clash}' — both resolve to worktree agb-${key} and branch agb/${key}, and creating the second would destroy the first`);
    }
    normalized.set(key, t.id);
    ids.add(t.id);
  }
  for (const t of plan.tickets ?? []) {
    for (const e of t.edges ?? []) {
      if (!e || typeof e !== 'object' || typeof e.to !== 'string' || !e.to.trim()) {
        errors.push(`${t.id}: edge must declare a valid 'to' field`);
        continue;
      }
      if (e.to === t.id) {
        errors.push(`${t.id}: self-dependency edge to '${t.id}' is prohibited`);
      } else if (!ids.has(e.to)) {
        errors.push(`${t.id}: edge to unknown ticket '${e.to}'`);
      }
    }
    if (typeof t.body !== 'string' || !t.body.trim()) {
      errors.push(`${t.id}: body (full self-contained spec text) is required — without it the builder charter renders an empty specification`);
    }
    if (!Array.isArray(t.scope) || !t.scope.length) {
      errors.push(`${t.id}: scope must be a non-empty array of globs — an empty scope disables the out-of-scope check entirely`);
    } else {
      t.scope = t.scope.map(normalizePathspec);
      for (const s of t.scope) {
        if (!validatePathspec(s, { allowRootWildcard: !strictGates })) {
          errors.push(`${t.id}: invalid scope pathspec '${s}'`);
        }
      }
    }
    if (Array.isArray(t.rails)) {
      t.rails = t.rails.map(normalizePathspec);
      for (const r of t.rails) {
        if (!validatePathspec(r)) {
          errors.push(`${t.id}: invalid rail pathspec '${r}'`);
        }
      }
    }
    if (t.tier !== undefined && !TIER_CANDIDATES[t.tier]) {
      errors.push(`${t.id}: unknown tier '${t.tier}' (cheap|mid|frontier)`);
    }
    if (t.effort !== undefined && !VALID_EFFORTS.includes(t.effort)) {
      errors.push(`${t.id}: unknown effort '${t.effort}' (${VALID_EFFORTS.join('|')})`);
    }
    if (t.holdout_scenarios !== undefined) {
      const validBool = typeof t.holdout_scenarios === 'boolean';
      const validArr =
        Array.isArray(t.holdout_scenarios) &&
        t.holdout_scenarios.length > 0 &&
        t.holdout_scenarios.every(
          (item) =>
            (typeof item === 'string' && item.trim().length > 0) ||
            (item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof item.code === 'string' &&
              item.code.trim().length > 0)
        );
      if (!validBool && !validArr) {
        errors.push(
          `${t.id}: holdout_scenarios must be a boolean or a non-empty array of scenario code strings/objects`
        );
      }
    }
    if (t.pool_hint !== undefined && !['gemini', 'claude', 'claude-gpt', 'gpt-oss', 'auto'].includes(t.pool_hint)) {
      errors.push(`${t.id}: unknown pool_hint '${t.pool_hint}' (gemini|claude|claude-gpt|gpt-oss|auto)`);
    } else if (!tierCandidates(t.tier ?? 'mid', t.pool_hint).length) {
      errors.push(`${t.id}: no model candidates for tier '${t.tier ?? 'mid'}' with pool_hint '${t.pool_hint}'`);
    }
  }
  const hasMalformedEdges = (plan.tickets ?? []).some((t) =>
    !t || !t.id || (t.edges ?? []).some((e) => !e || typeof e !== 'object' || typeof e.to !== 'string')
  );
  if (!hasMalformedEdges) {
    try {
      const { cycle } = topoSort(plan.tickets ?? []);
      if (cycle) errors.push(`cycle in ticket DAG: ${cycle.join(', ')}`);
    } catch (err) {
      errors.push(`topological sort error: ${err.message}`);
    }
  }
  return errors;
}
