// Remote Control Launcher & Mobile-First Status / P6 Sign-Off Cards (Wave 3).
//
// Bridges `antigravity.google.com` Remote Control (`agy --remote-control`) so
// engineers can steer local ADLC fleets from phones or tablets with compact
// vertical Markdown cards and `ask_question`-ready operator choices.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAgyBinary } from './plugin-paths.mjs';

const SAFE_PROJECT_RE = /^[A-Za-z0-9._:/-]{1,120}$/;

/**
 * Detect whether the active session is running inside an Antigravity Remote
 * Control web/mobile surface (`ANTIGRAVITY_REMOTE_CONTROL=1`) or explicit mobile mode.
 */
export function isRemoteControlEnv(env = process.env, explicitMobile = false) {
  if (explicitMobile === true) return true;
  const raw = String(env?.ANTIGRAVITY_REMOTE_CONTROL ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Construct safe CLI arguments for `agy --remote-control`.
 */
export function buildRemoteControlArgs({ project = null, prompt = null } = {}) {
  const args = ['--remote-control'];
  if (typeof project === 'string' && project.trim()) {
    const cleanProject = project.trim();
    if (!SAFE_PROJECT_RE.test(cleanProject)) {
      throw new Error(`Invalid --project value for remote-control: '${cleanProject}'`);
    }
    args.push('--project', cleanProject);
  }
  if (typeof prompt === 'string' && prompt.trim()) {
    const cleanPrompt = prompt.trim();
    if (cleanPrompt.includes('\0')) {
      throw new Error('Invalid null byte in remote-control prompt');
    }
    args.push(cleanPrompt);
  }
  return args;
}

/**
 * Launch (or dry-run inspect) an `agy --remote-control` fleet supervisor session.
 */
export async function launchRemoteControl({
  repo = '.',
  project = null,
  prompt = null,
  dryRun = false,
  agyBin = null,
  env = process.env,
} = {}) {
  const targetRepo = resolve(repo ?? '.');
  if (!existsSync(targetRepo)) {
    return {
      ok: false,
      error: `Repository path does not exist: ${targetRepo}`,
      repo: targetRepo,
    };
  }
  const effectiveAgyBin = agyBin || env?.AGB_AGY_BIN || resolveAgyBinary() || 'agy';
  const defaultPrompt =
    prompt ??
    'Supervise this ADLC workspace via /agb-status and /agb-watch. Present compact mobile cards and ask_question checkpoints before any P6 merge or rescue.';
  const args = buildRemoteControlArgs({ project, prompt: defaultPrompt });
  const childEnv = {
    ...env,
    ANTIGRAVITY_REMOTE_CONTROL: '1',
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      agyBin: effectiveAgyBin,
      args,
      repo: targetRepo,
      env: { ANTIGRAVITY_REMOTE_CONTROL: '1' },
    };
  }

  return new Promise((resolvePromise) => {
    const child = spawn(effectiveAgyBin, args, {
      cwd: targetRepo,
      env: childEnv,
      stdio: 'inherit',
    });
    child.once('error', (err) => {
      resolvePromise({
        ok: false,
        agyBin: effectiveAgyBin,
        args,
        repo: targetRepo,
        error: err.message,
        exitCode: 1,
      });
    });
    child.once('close', (code) => {
      resolvePromise({
        ok: code === 0,
        agyBin: effectiveAgyBin,
        args,
        repo: targetRepo,
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Render a compact, vertical mobile-friendly fleet status card (no wide ASCII tables)
 * with structured operator action suggestions for `ask_question`.
 */
export function formatMobileStatusCard(runState = {}) {
  const runId = runState.runId || 'unknown';
  const statusBadge = runState.done ? 'DONE' : 'RUNNING';
  const tickets = runState.tickets && typeof runState.tickets === 'object' ? Object.entries(runState.tickets) : [];

  let merged = 0;
  let running = 0;
  let failed = 0;
  let blocked = 0;
  const failedIds = [];

  for (const [id, t] of tickets) {
    const phase = String(t?.phase || t?.status || 'pending').toLowerCase();
    if (phase === 'merged' || phase === 'done') merged += 1;
    else if (phase === 'failed') {
      failed += 1;
      failedIds.push(id);
    } else if (phase === 'blocked' || phase === 'paused') blocked += 1;
    else if (phase !== 'pending') running += 1;
  }

  const lines = [
    `### AGB Fleet — \`${runId}\` (${statusBadge})`,
    `- **Progress:** ${merged}/${tickets.length} merged · ${running} active · ${failed} failed · ${blocked} blocked`,
  ];

  const q = runState.pools?.quota;
  if (q && (q.gemini?.effectivePercent !== undefined || q.claude_gpt?.effectivePercent !== undefined)) {
    const parts = [];
    if (q.gemini?.effectivePercent !== undefined) parts.push(`Gemini ${q.gemini.effectivePercent}%`);
    if (q.claude_gpt?.effectivePercent !== undefined) parts.push(`Claude/GPT ${q.claude_gpt.effectivePercent}%`);
    lines.push(`- **Quota:** ${parts.join(' · ')}`);
  }

  for (const [id, t] of tickets.slice(0, 8)) {
    const phase = String(t?.phase || t?.status || 'pending');
    const model = t?.model ? ` · \`${t.model}\`` : '';
    lines.push(`- \`${id}\`: **${phase}**${model}`);
  }
  if (tickets.length > 8) {
    lines.push(`- _+${tickets.length - 8} more ticket(s)_`);
  }

  const actions = [];
  if (failedIds.length > 0) {
    actions.push(`Run Surgical Rescue on ${failedIds[0]}`);
  }
  if (runState.done && failed === 0) {
    actions.push('Open P6 Sign-Off (agb accept --mobile)');
  } else {
    actions.push('Pause Fleet');
    actions.push('Refresh Status');
  }
  lines.push(`- **Quick Actions:** ${actions.join(' | ')}`);
  return lines.join('\n');
}

/**
 * Render a compact, vertical mobile-friendly ADLC P6 sign-off card suitable for
 * Antigravity Web Remote Control on phones/tablets.
 */
export function formatMobileAcceptCard(dossier = {}) {
  const counts = dossier.counts ?? {
    filesChanged: 0,
    totalHunks: 0,
    acceptedHunks: 0,
    flaggedHunks: 0,
    pendingHunks: 0,
  };
  const badge = dossier.readyForSignOff ? 'READY FOR P6 MERGE' : 'NEEDS REVIEW';
  const lines = [
    `### ADLC P6 Sign-Off — ${badge}`,
    `- **Base:** \`${dossier.base || 'HEAD'}\``,
    `- **Diff:** ${counts.filesChanged} file(s) · ${counts.acceptedHunks}/${counts.totalHunks} hunks accepted (${counts.flaggedHunks} flagged, ${counts.pendingHunks} pending)`,
  ];

  if (dossier.gateManifest?.totalEntries > 0) {
    lines.push(`- **Gate Manifest:** ${dossier.gateManifest.totalEntries} recorded entry(ies)`);
  }
  if (dossier.browserEvidence) {
    const bev = dossier.browserEvidence;
    lines.push(
      `- **Browser Gate:** ${bev.ok ? 'PASS' : 'FAIL'} (${(bev.routes ?? []).length} route(s), ${(bev.screenshots ?? []).length} screenshot(s))`
    );
  }
  const callers = dossier.externalCallers?.callers ?? [];
  if (callers.length > 0) {
    lines.push(`- **External Callers:** ${callers.length} cross-file reference(s)`);
  }

  const actions = dossier.readyForSignOff
    ? ['Approve & Merge', 'Inspect Full HTML Cockpit', 'Request Changes']
    : ['Review Flagged/Pending Hunks', 'Run /agb-handoff', 'Request Changes'];
  lines.push(`- **Decision:** ${actions.join(' | ')}`);
  return lines.join('\n');
}
