// Native Antigravity Overview Panel (`swarm_pane`) Telemetry Bridge (v1.4 Pillar 3b).
//
// Translates live `RunStatus` wave, ticket, pool-saturation, TDD-pair, and
// prosecutor-verdict state into `.booster/overview_pane.json` and
// `.booster/overview_pane.md` (and mirrors into the active brain session directory
// when available) so `agb` fleets render natively inside Antigravity's Overview Panel.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeArtifactFileAtomically } from './plan-integrity.mjs';

function formatOverviewMarkdown(payload) {
  const lines = [
    `# Antigravity Booster Overview (${payload.runId || 'active'})`,
    '',
    `**Goal:** Execute ${payload.totalTickets} ADLC ticket(s) on base \`${payload.base || 'main'}\` | **Merged:** ${payload.mergedCount}/${payload.totalTickets} | **Failed:** ${payload.failedCount}`,
    '',
    '## Ticket Groups',
    '',
    '| Ticket | Phase | Model / Pool | Strikes | Verdict |',
    '| :--- | :--- | :--- | :---: | :--- |',
  ];

  for (const t of payload.tickets) {
    lines.push(
      `| \`${t.id}\` | \`${t.phase}\` | \`${t.model || t.pool || 'auto'}\` | ${t.strikes ?? 0} | ${t.verdict || '-'} |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Emit native Overview Panel (`swarm_pane`) JSON and Markdown files from a
 * scheduler status snapshot.
 */
export function syncOverviewPaneState(
  statusSnapshot = {},
  { repo = process.cwd(), brainDir = null, sessionId = null } = {}
) {
  const repoRoot = resolve(repo);
  const ticketsMap = statusSnapshot?.tickets ?? {};
  const ticketsList = Array.isArray(ticketsMap)
    ? ticketsMap
    : Object.entries(ticketsMap).map(([id, info]) => ({
        id,
        ...(typeof info === 'object' && info !== null ? info : { phase: String(info) }),
      }));

  const mergedCount = ticketsList.filter((t) => t.phase === 'merged' || t.status === 'merged').length;
  const failedCount = ticketsList.filter((t) => t.phase === 'failed' || t.status === 'failed').length;

  const payload = {
    schemaVersion: '1.4',
    runId: statusSnapshot.runId || 'run-active',
    base: statusSnapshot.base || 'main',
    updatedAt: new Date().toISOString(),
    totalTickets: ticketsList.length,
    mergedCount,
    failedCount,
    pools: statusSnapshot.pools || {},
    tickets: ticketsList.map((t) => ({
      id: t.id,
      title: t.title || t.id,
      phase: t.phase || t.status || 'pending',
      model: t.model || null,
      pool: t.pool || null,
      strikes: t.strikes ?? 0,
      tddSplit: Boolean(t.tddSplit),
      verdict: t.verdict || t.detail || null,
    })),
  };

  const jsonText = JSON.stringify(payload, null, 2) + '\n';
  const mdText = formatOverviewMarkdown(payload);

  const boosterDir = join(repoRoot, '.booster');
  const jsonRes = writeArtifactFileAtomically(boosterDir, 'overview_pane.json', jsonText, {
    rootDir: repoRoot,
  });
  const mdRes = writeArtifactFileAtomically(boosterDir, 'overview_pane.md', mdText, {
    rootDir: repoRoot,
  });

  let brainMirroredPath = null;
  if (brainDir && sessionId) {
    const sessionPath = join(resolve(brainDir), String(sessionId));
    if (existsSync(sessionPath)) {
      const mRes = writeArtifactFileAtomically(sessionPath, 'overview_pane.md', mdText);
      if (mRes.ok) brainMirroredPath = mRes.path;
    }
  }

  return {
    ok: Boolean(jsonRes.ok && mdRes.ok),
    jsonPath: jsonRes.path,
    markdownPath: mdRes.path,
    brainMirroredPath,
    payload,
  };
}
