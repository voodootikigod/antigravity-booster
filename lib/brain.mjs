// L4 hybrid: ingest Antigravity GUI "brain" artifacts (plans made
// interactively in the desktop app) and convert them into an agb plan —
// GUI for ideation, fleet for execution.
//
// Brain layout (verified locally):
//   ~/.gemini/antigravity/brain/<conversation-uuid>/
//     implementation_plan.md, task.md, walkthrough.md (+ .metadata.json)

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { extractJson } from '@aidlc/core/llm';
import { runAgy } from './agy.mjs';

export const BRAIN_DIR = process.env.AGB_BRAIN_DIR ?? join(homedir(), '.gemini', 'antigravity', 'brain');

/** List brain conversations that contain plan artifacts, newest first. */
export function listBrains(brainDir = BRAIN_DIR) {
  if (!existsSync(brainDir)) return [];
  return readdirSync(brainDir)
    .map((id) => {
      const dir = join(brainDir, id);
      const plan = join(dir, 'implementation_plan.md');
      const task = join(dir, 'task.md');
      if (!existsSync(plan) && !existsSync(task)) return null;
      const src = existsSync(plan) ? plan : task;
      const firstHeading = readFileSync(src, 'utf8').split('\n').find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') ?? '(untitled)';
      return { id, dir, title: firstHeading, mtime: statSync(src).mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/** Read the plan-relevant artifacts of one conversation or a raw spec file path. */
export function readBrain(idOrPrefix, brainDir = BRAIN_DIR) {
  if (idOrPrefix && (idOrPrefix.includes('/') || idOrPrefix.endsWith('.md')) && existsSync(idOrPrefix) && statSync(idOrPrefix).isFile()) {
    const resolvedPath = resolve(idOrPrefix);
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
  const hit = all.find((b) => b.id === idOrPrefix) ?? all.find((b) => b.id.startsWith(idOrPrefix));
  if (!hit) throw new Error(`no brain conversation matching '${idOrPrefix}' with plan artifacts`);
  const read = (f) => (existsSync(join(hit.dir, f)) ? readFileSync(join(hit.dir, f), 'utf8') : null);
  return { ...hit, implementationPlan: read('implementation_plan.md'), task: read('task.md'), sourceType: 'antigravity-brain' };
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
export async function brainToPlan(idOrPrefix, { repo, gate, model = 'Claude Opus 4.6 (Thinking)', brainDir = BRAIN_DIR, feedback = [] } = {}) {
  if (!repo) throw new Error('brainToPlan: repo is required');
  const brain = readBrain(idOrPrefix, brainDir);
  const res = await runAgy({ model, prompt: conversionPrompt(brain, repo, gate, feedback), timeout: '5m' });
  if (!res.ok) throw new Error(`brain conversion failed: ${res.error}`);
  const plan = extractJson(res.output);
  if (!Array.isArray(plan.tickets) || !plan.tickets.length) {
    throw new Error('brain conversion produced no tickets');
  }
  return plan;
}
