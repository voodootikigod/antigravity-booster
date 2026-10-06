// L4 hybrid: ingest Antigravity GUI "brain" artifacts (plans made
// interactively in the desktop app) and convert them into an agb plan —
// GUI for ideation, fleet for execution.
//
// Brain layout (verified locally):
//   ~/.gemini/antigravity/brain/<conversation-uuid>/
//     implementation_plan.md, task.md, walkthrough.md (+ .metadata.json)

import { extractJson } from '@adlc/core/llm';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runAgy, BRAIN_PLAN_SCHEMA } from './agy.mjs';

const jetskiBrain = join(homedir(), '.gemini', 'jetski', 'brain');
const antigravityBrain = join(homedir(), '.gemini', 'antigravity', 'brain');
const defaultBrainDir = existsSync(jetskiBrain) ? jetskiBrain : antigravityBrain;

export const BRAIN_DIR = process.env.AGB_BRAIN_DIR ?? defaultBrainDir;

export function getActiveSessionId() {
  return process.env.ANTIGRAVITY_CONVERSATION_ID ?? process.env.AGB_SESSION_ID ?? null;
}

const PLAN_FILENAMES = ['implementation_plan.md', 'plan.md', 'agb_plan_artifact.md', 'walkthrough.md', 'spec.md'];

/** List brain conversations that contain plan artifacts, newest first. */
export function listBrains(brainDir = BRAIN_DIR) {
  const dirsToSearch = [brainDir];
  if (brainDir === BRAIN_DIR) {
    if (brainDir !== jetskiBrain && existsSync(jetskiBrain)) dirsToSearch.push(jetskiBrain);
    if (brainDir !== antigravityBrain && existsSync(antigravityBrain)) dirsToSearch.push(antigravityBrain);
  }

  const seen = new Set();
  const results = [];
  for (const bDir of dirsToSearch) {
    if (!existsSync(bDir)) continue;
    for (const id of readdirSync(bDir)) {
      if (seen.has(id)) continue;
      const dir = join(bDir, id);
      const matchingFiles = PLAN_FILENAMES.filter((f) => existsSync(join(dir, f)))
        .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (!matchingFiles.length) continue;
      const hitFile = matchingFiles[0].path;
      const firstHeading = readFileSync(hitFile, 'utf8').split('\n').find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') ?? '(untitled)';
      seen.add(id);
      results.push({ id, dir, title: firstHeading, mtime: matchingFiles[0].mtime });
    }
  }
  return results.sort((a, b) => b.mtime - a.mtime);
}

/** Read the plan-relevant artifacts of one conversation or a raw spec file path. */
export function readBrain(idOrPrefix, brainDir = BRAIN_DIR) {
  const activeId = getActiveSessionId();
  const targetId = idOrPrefix ?? activeId;
  const supportedExts = ['.md', '.json', '.csv', '.pdf', '.txt'];
  const isLocalFileCandidate = targetId && (
    targetId.includes('/') ||
    supportedExts.some((ext) => targetId.toLowerCase().endsWith(ext))
  );
  if (isLocalFileCandidate && existsSync(targetId) && statSync(targetId).isFile()) {
    const resolvedPath = resolve(targetId);
    const content = readFileSync(resolvedPath, 'utf8');
    const firstHeading = content.split('\n').find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') ?? '(untitled)';
    return {
      id: resolvedPath,
      dir: resolvedPath,
      title: firstHeading,
      mtime: statSync(resolvedPath).mtimeMs,
      implementationPlan: content,
      task: null,
      sourceType: 'local-spec'
    };
  }
  const all = listBrains(brainDir);
  const searchId = targetId ?? (all[0]?.id);
  if (!searchId) throw new Error("no brain conversation with plan artifacts found");
  const hit = all.find((b) => b.id === searchId) ?? all.find((b) => b.id.startsWith(searchId));
  if (!hit) throw new Error(`no brain conversation matching '${searchId}' with plan artifacts`);
  const read = (f) => (existsSync(join(hit.dir, f)) ? readFileSync(join(hit.dir, f), 'utf8') : null);
  const matchingFiles = PLAN_FILENAMES.filter((f) => existsSync(join(hit.dir, f)))
    .map((f) => ({ f, mtime: statSync(join(hit.dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const newestPlanFile = matchingFiles[0]?.f;
  const implementationPlan = newestPlanFile ? read(newestPlanFile) : null;
  return { ...hit, implementationPlan, task: read('task.md'), sourceType: 'antigravity-brain' };
}

function conversionPrompt(brain, repo, gate, feedback = []) {
  const feedbackBlock = feedback.length
    ? `

## Compiler feedback on your previous attempt (fix ALL of these)

A previous conversion of this exact plan failed the plan gates listed below.
Regenerate the COMPLETE corrected plan — full JSON, never a partial patch.

${feedback.map((f) => `- ${f}`).join('\n')}`
    : '';
  return `Convert this Antigravity implementation plan into a parallel-execution
ticket DAG. Output STRICT JSON only.

## Source: implementation plan

${brain.implementationPlan ?? '(none)'}

## Source: task list

${brain.task ?? '(none)'}

## Rules

- Each ticket must be executable by a fresh agent from its "body" alone:
  restate every needed detail from the plan; never reference "the plan",
  "above", or "step 3".
- Partition scopes so no two parallel tickets share files. Shared
  foundations (types, schemas, utilities) become their own ticket that
  others declare edges from.
- edges = [{"to": "Tn"}] meaning this ticket must merge before Tn starts.
- tier: "cheap" for mechanical well-railed work, "mid" default, "frontier"
  only for contracts/migrations.
- Body sized for one model response under 5 minutes — split anything bigger.${feedbackBlock}

## Output shape

{"repo": ${JSON.stringify(repo)}, "base": "main",
 "gate": ${JSON.stringify(gate ?? { test: 'npm test' })},
 "tickets": [{"id": "T1", "title": "...", "body": "...",
   "scope": ["..."], "edges": [], "tier": "mid", "pool_hint": "auto"}]}`;
}

/**
 * Convert a brain conversation to an agb plan using a frontier model
 * (decomposition is exactly where escaped errors are expensive — ADLC P7
 * routing). Returns the parsed plan; caller validates with loadPlan rules.
 */
export async function brainToPlan(idOrPrefix, { repo, gate, model = 'gemini-3.1-pro-high', brainDir = BRAIN_DIR, feedback = [], project, pools } = {}) {
  const finalProject = project ?? `agb-brain-${Date.now()}`;
  if (!repo) throw new Error('brainToPlan: repo is required');
  if (pools) {
    if (pools.circuitBreakerTripped) {
      throw new Error('brain conversion quota telemetry unavailable (circuit breaker tripped)');
    }
    if (!pools.quota) {
      const q = await pools.refreshQuota(process.env.AGB_AGY_BIN || 'agy');
      if (!q.ok) {
        throw new Error(`brain conversion quota telemetry unavailable: ${q.error}`);
      }
    }
  }
  const brain = readBrain(idOrPrefix, brainDir);
  const release = pools ? await pools.acquire(model, { repo }) : () => {};
  let res;
  try {
    res = await runAgy({
      model,
      prompt: conversionPrompt(brain, repo, gate, feedback),
      timeout: '5m',
      project: finalProject,
      outputFormat: 'json',
      jsonSchema: BRAIN_PLAN_SCHEMA,
      worker: { mode: 'readonly' },
    });
  } finally {
    await release();
  }
  if (!res.ok) throw new Error(`brain conversion failed: ${res.error}`);
  let plan = res.data;
  if (!plan) {
    plan = extractJson(res.output);
  }
  if (!Array.isArray(plan.tickets) || !plan.tickets.length) {
    throw new Error('brain conversion produced no tickets');
  }

  const activeId = getActiveSessionId();
  const artifactDir = process.env.AGB_ARTIFACT_DIR ?? (activeId ? join(homedir(), '.gemini', 'jetski', 'brain', activeId) : join(repo, '.booster'));
  try {
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const mdPath = join(artifactDir, 'agb_plan_artifact.md');
    const mdContent = `# AGB Plan Artifact\n\n**Repo:** \`${plan.repo}\`  \n**Base:** \`${plan.base}\`  \n**Tickets:** ${plan.tickets.length}\n\n` +
      plan.tickets.map(t => `### ${t.id}: ${t.title}\n- **Tier:** \`${t.tier || 'mid'}\`  \n- **Scope:** \`${(t.scope || []).join(', ')}\`  \n- **Edges:** \`${JSON.stringify(t.edges || [])}\`  \n\n${t.body}\n`).join('\n---\n\n');
    writeFileSync(mdPath, mdContent, { mode: 0o600 });
    plan.artifactPath = mdPath;
  } catch {}

  return plan;
}
