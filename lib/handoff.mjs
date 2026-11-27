// Interactive Single-Ticket P5/P6 Gate (`agb handoff <ticket-id>` / `/agb-handoff`).
//
// Designed for Antigravity IDE, the 7 IDE Extensions (VS Code, JetBrains, Zed, etc.),
// CLI sessions, and Cloud VMs where an engineer implements a single ticket interactively:
//   1. Runs deterministic `runGateTicket` (scope, rails-guard, sandboxed tests, learned
//      checks, browserGate, hollow-test, gate-manifest).
//   2. Runs single-diff cross-model `prosecute()` when `agy` + quota are available, or
//      degrades cleanly to a structured `prosecutorPrompt` in `--prompt-only` / zero-`agy`
//      mode (unless `requireProsecutor: true`, which fails closed).
//   3. Builds a targeted P6 sign-off dossier (`formatHandoffMarkdown` + optional `--html`).

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildAcceptanceDossier,
  formatAcceptanceDossierHtml,
  writeAcceptHtmlFile,
} from './accept.mjs';
import { resolveTicket } from './active-rails.mjs';
import { PROSECUTION_VERDICT_SCHEMA } from './agy.mjs';
import { prosecutionPrompt } from './charters.mjs';
import { runGateTicket } from './gate-ticket.mjs';
import { PROSECUTORS } from './models.mjs';
import { resolveAgyBinary } from './plugin-paths.mjs';
import { PoolSet } from './pools.mjs';
import { prosecute } from './prosecute.mjs';
import { sanitizedGitEnv } from './run-integrity.mjs';
import { recordGate } from './scheduler-verify.mjs';

function readCandidateDiff(candidateDir, baseRefSha) {
  return execFileSync(
    'git',
    [
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--end-of-options',
      baseRefSha,
    ],
    {
      cwd: candidateDir,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

/**
 * Format a concise Markdown P5/P6 handoff summary suitable for IDE chat and PR descriptions.
 */
export function formatHandoffMarkdown(handoff = {}) {
  const status = handoff.ok ? 'READY FOR P6 HANDOFF' : `BLOCKED (${handoff.stage || 'failed'})`;
  const lines = [
    `# ADLC Ticket Handoff — \`${handoff.ticketId || 'unknown'}\``,
    '',
    `- **Status:** ${status}`,
  ];
  if (handoff.ticketTitle) {
    lines.push(`- **Title:** ${handoff.ticketTitle}`);
  }
  if (handoff.baseRefSha) {
    lines.push(`- **Base SHA:** \`${String(handoff.baseRefSha).slice(0, 12)}\``);
  }
  if (Array.isArray(handoff.changedPaths)) {
    lines.push(`- **Changed Files (${handoff.changedPaths.length}):** ${handoff.changedPaths.map((p) => `\`${p}\``).join(', ') || '_none_'}`);
  }
  if (handoff.prosecution) {
    const p = handoff.prosecution;
    lines.push(
      `- **Prosecution:** \`${p.mode || 'skipped'}\` — verdict=\`${p.verdict || 'n/a'}\`${p.model ? ` (model: \`${p.model}\`)` : ''}`
    );
  }
  if (handoff.error) {
    lines.push(`- **Error:** ${handoff.error}`);
  }
  if (handoff.htmlPath) {
    lines.push(`- **HTML Cockpit:** \`${handoff.htmlPath}\``);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the end-to-end single-ticket ADLC P5+P6 handoff pipeline.
 */
export async function runTicketHandoff(repo, ticketId, opts = {}) {
  const {
    base = 'HEAD',
    worktree = null,
    testCmd = 'npm test',
    buildCmd = null,
    skipHollow = false,
    skipBrowser = false,
    browserUrl = null,
    autocommit = Boolean(worktree),
    prosecute: enableProsecute = true,
    promptOnly = false,
    requireProsecutor = false,
    builderModel = PROSECUTORS.claude,
    htmlOut = null,
    sandbox,
    adlcBin,
    recordManifest = true,
    agyBin,
    env = process.env,
  } = opts;

  const gateResult = await runGateTicket(repo, ticketId, {
    base,
    worktree,
    testCmd,
    buildCmd,
    skipHollow,
    skipBrowser,
    browserUrl,
    autocommit,
    sandbox,
    adlcBin,
    recordManifest,
    env,
  });

  if (!gateResult.ok) {
    return {
      ok: false,
      stage: 'gate-ticket',
      ticketId,
      baseRefSha: gateResult.baseRefSha ?? null,
      changedPaths: gateResult.changedPaths ?? [],
      error: gateResult.error,
      gateResult,
      prosecution: null,
      dossier: null,
    };
  }

  const realRepo = realpathSync(resolve(repo ?? process.cwd()));
  const candidateDir = worktree ? realpathSync(resolve(worktree)) : realRepo;
  const found = resolveTicket(realRepo, ticketId);
  const ticket = found.ok ? found.ticket : { id: ticketId, title: ticketId, scope: gateResult.changedPaths };
  const diffText = readCandidateDiff(candidateDir, gateResult.baseRefSha);
  const seed = randomBytes(16).toString('hex');

  let prosecution = { ok: true, mode: 'skipped', verdict: 'skipped', model: null };

  if (enableProsecute) {
    const hollowForPrompt = gateResult.stages.hollowTest?.skipped ? null : gateResult.stages.hollowTest;
    const promptText = prosecutionPrompt(ticket, diffText, undefined, hollowForPrompt, { seed });
    if (promptOnly) {
      prosecution = {
        ok: true,
        mode: 'prompt-only',
        verdict: 'pending_in_harness',
        model: PROSECUTORS.gemini,
        schema: PROSECUTION_VERDICT_SCHEMA,
        prompt: promptText,
      };
    } else {
      const effectiveAgyBin = agyBin || env.AGB_AGY_BIN || resolveAgyBinary() || 'agy';
      const pools = new PoolSet(undefined, { repo: realRepo });
      const quotaRes = await pools.refreshQuota(effectiveAgyBin, {
        allowStatusCache: !agyBin && !env.AGB_AGY_BIN,
      });

      if (!quotaRes.ok) {
        if (requireProsecutor) {
          return {
            ok: false,
            stage: 'prosecute_unavailable',
            ticketId,
            ticketTitle: ticket.title ?? null,
            baseRefSha: gateResult.baseRefSha,
            changedPaths: gateResult.changedPaths,
            error: `Prosecutor unavailable (${quotaRes.error}) and --require-prosecutor was specified`,
            gateResult,
            prosecution: null,
            dossier: null,
          };
        }
        prosecution = {
          ok: true,
          mode: 'prompt-only-fallback',
          verdict: 'pending_in_harness',
          reason: quotaRes.error,
          model: PROSECUTORS.gemini,
          schema: PROSECUTION_VERDICT_SCHEMA,
          prompt: promptText,
        };
      } else {
        const prosModel = pools.prosecutorFor(builderModel) ?? PROSECUTORS.gemini;
        const prosecuteScratch = mkdtempSync(join(tmpdir(), 'agb-handoff-prosecute-'));
        const prevAgyBin = process.env.AGB_AGY_BIN;
        if (agyBin) process.env.AGB_AGY_BIN = agyBin;
        let prosRes;
        try {
          prosRes = await prosecute({
            ticket,
            diff: diffText,
            model: prosModel,
            builderModel,
            cwd: prosecuteScratch,
            worktree: null,
            rootRepo: realRepo,
            testCmd,
            base: gateResult.baseRefSha,
            adlcBin,
            changedFiles: gateResult.changedPaths,
            hollowTest: { ok: true, total: 0, killed: 0, survived: 0, mutants: [] },
            shortCircuitHollowTest: false,
          });
        } finally {
          if (agyBin) {
            if (prevAgyBin === undefined) delete process.env.AGB_AGY_BIN;
            else process.env.AGB_AGY_BIN = prevAgyBin;
          }
          try {
            rmSync(prosecuteScratch, { recursive: true, force: true });
          } catch {}
        }
        const passedPros = prosRes.verdict === 'ship';
        prosecution = {
          ok: passedPros,
          mode: prosRes.prosecutionMode || 'cross-family',
          verdict: prosRes.verdict,
          model: prosRes.model ?? prosModel,
          findings: prosRes.findings ?? [],
        };
        if (passedPros && recordManifest) {
          await recordGate({
            repo: realRepo,
            gateName: 'prosecute',
            ticketId,
            data: { verdict: 'ship', model: prosecution.model, mode: prosecution.mode },
            adlcBin,
          });
        }
        if (!passedPros) {
          const dossier = buildAcceptanceDossier({ repo: candidateDir, base: gateResult.baseRefSha });
          return {
            ok: false,
            stage: 'prosecute',
            ticketId,
            ticketTitle: ticket.title ?? null,
            baseRefSha: gateResult.baseRefSha,
            changedPaths: gateResult.changedPaths,
            error: `Prosecutor returned verdict '${prosRes.verdict}' (${(prosRes.findings ?? []).length} finding(s))`,
            gateResult,
            prosecution,
            dossier,
          };
        }
      }
    }
  }

  const dossier = buildAcceptanceDossier({ repo: candidateDir, base: gateResult.baseRefSha });
  let htmlPath = null;
  if (htmlOut) {
    const html = formatAcceptanceDossierHtml(dossier);
    htmlPath = writeAcceptHtmlFile(realRepo, html, htmlOut);
  }

  return {
    ok: true,
    stage: 'complete',
    ticketId,
    ticketTitle: ticket.title ?? null,
    baseRefSha: gateResult.baseRefSha,
    changedPaths: gateResult.changedPaths,
    gateResult,
    prosecution,
    dossier,
    ...(htmlPath ? { htmlPath } : {}),
  };
}
