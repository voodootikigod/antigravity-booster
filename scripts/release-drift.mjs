#!/usr/bin/env node
// Detects a release that landed in the repo but never reached npm.
//
// Two real incidents motivate this, and neither was caught by anything:
//
//   v0.4.3 (2026-07-16) — the bump landed, the tag was pushed, and the publish
//   run sat `waiting` on the npm-publish approval gate for ~1.5 hours while
//   package.json said 0.4.3 and npm still served 0.4.2. A gated run does not
//   proceed on its own and does not time out into publishing. Nobody was coming.
//
//   v0.5.0 (2026-07-17) — the bump rode along inside feature PR #51 rather than
//   going through the release flow, so it landed on main with no tag behind it.
//   There was no run at all to notice. It sat unpublished until the next release
//   attempt happened to compare the manifest against npm.
//
// Both share one observable symptom: main's package.json is ahead of npm. That
// is the cheap, unambiguous tell, and this script is the automated form of it.
// It classifies *why* so the fix is obvious, because the two cases need opposite
// responses — one needs a human to approve a run, the other needs a tag pushed.

const GRACE_MINUTES = 90;

/**
 * Classify release drift from already-gathered facts.
 *
 * Pure: all I/O happens in the CLI below, so the interesting branches are
 * testable without a network, a git history, or a live gated run.
 *
 * @param {object} facts
 * @param {string}  facts.manifestVersion  version in package.json on main
 * @param {string?} facts.npmLatest        dist-tags.latest on the registry, null if unreachable
 * @param {string[]} facts.tags            existing tag names (e.g. ['v0.4.3', 'v0.5.0'])
 * @param {string?} facts.runStatus        publish run status for the tag: 'waiting'|'queued'|
 *                                         'in_progress'|'completed'|null if no run exists
 * @param {string?} facts.runConclusion    'success'|'failure'|... when runStatus is 'completed'
 * @param {number?} facts.bumpAgeMinutes   age of the commit that set the current version
 * @returns {{status: string, ok: boolean, message: string}}
 */
export function classifyDrift({
  manifestVersion,
  npmLatest,
  tags = [],
  runStatus = null,
  runConclusion = null,
  bumpAgeMinutes = null,
}) {
  // An unreachable registry is undetermined, not healthy. "I could not look" is
  // not "it is fine" — report it rather than passing by default.
  if (npmLatest == null) {
    return {
      status: 'undetermined',
      ok: false,
      message: 'Could not read dist-tags.latest from npm — drift is undetermined, not clean.',
    };
  }

  if (manifestVersion === npmLatest) {
    return {
      status: 'ok',
      ok: true,
      message: `In sync: manifest and npm both at ${manifestVersion}.`,
    };
  }

  const tag = `v${manifestVersion}`;
  const tagged = tags.includes(tag);

  // A release in flight looks identical to a stranded one for a short while:
  // the bump PR merges, then the tag goes up moments later. Do not cry drift
  // during that window — a check that fires on every healthy release gets muted,
  // and a muted check catches nothing.
  if (bumpAgeMinutes != null && bumpAgeMinutes < GRACE_MINUTES && !tagged) {
    return {
      status: 'in-flight',
      ok: true,
      message:
        `Manifest is at ${manifestVersion}, npm at ${npmLatest}, and ${tag} does not exist yet — ` +
        `but the bump is only ${Math.round(bumpAgeMinutes)}m old, inside the ${GRACE_MINUTES}m grace window. ` +
        `Likely a release in progress.`,
    };
  }

  if (!tagged) {
    return {
      status: 'untagged',
      ok: false,
      message:
        `Manifest is at ${manifestVersion} but npm serves ${npmLatest}, and ${tag} does not exist. ` +
        `The bump landed without a tag, so no publish was ever triggered (the v0.5.0 failure). ` +
        `Do NOT bump on top of this — that skips ${manifestVersion} on npm entirely. ` +
        `Run the release flow to tag ${tag} at the commit that carries it.`,
    };
  }

  if (runStatus === 'waiting') {
    return {
      status: 'awaiting-approval',
      ok: false,
      message:
        `${tag} exists and its publish run is WAITING on the npm-publish approval gate, ` +
        `while npm still serves ${npmLatest} (the v0.4.3 failure). ` +
        `It will never publish on its own — a maintainer must approve the deployment.`,
    };
  }

  if (runStatus === 'queued' || runStatus === 'in_progress') {
    return {
      status: 'in-flight',
      ok: true,
      message: `${tag} is publishing now (run ${runStatus}).`,
    };
  }

  if (runStatus === 'completed' && runConclusion !== 'success') {
    return {
      status: 'publish-failed',
      ok: false,
      message:
        `${tag} exists but its publish run concluded '${runConclusion}' and npm still serves ${npmLatest}. ` +
        `The tag is stranded; re-run the publish job (it will require approval again).`,
    };
  }

  if (runStatus == null) {
    return {
      status: 'no-run',
      ok: false,
      message:
        `${tag} exists but no publish run is associated with it, and npm serves ${npmLatest}. ` +
        `The tag push did not trigger publish.yml.`,
    };
  }

  // Run says success, npm disagrees. This is the case a green run alone would
  // have hidden — the reason verification asserts the registry, not CI status.
  return {
    status: 'published-but-missing',
    ok: false,
    message:
      `${tag}'s publish run succeeded but npm still serves ${npmLatest}, not ${manifestVersion}. ` +
      `A green run is not a publish — check whether the publish step actually uploaded.`,
  };
}

// ---------------------------------------------------------------------------
// CLI: gather the facts, then classify. Exits non-zero on drift so the
// scheduled workflow surfaces it rather than passing quietly.
// ---------------------------------------------------------------------------

async function main() {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');

  const sh = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const manifestVersion = pkg.version;
  const pkgName = pkg.name;

  let npmLatest = null;
  try {
    npmLatest = sh('npm', ['view', pkgName, 'dist-tags.latest']);
  } catch {
    // Leave null — classifyDrift reports undetermined rather than clean.
  }

  let tags = [];
  try {
    tags = sh('git', ['tag', '-l']).split('\n').filter(Boolean);
  } catch {
    // Leave empty; a missing tag list can only make the result more alarming,
    // never falsely reassuring.
  }

  // Age of the commit that last touched package.json's version line. Used only
  // to suppress the in-flight false positive.
  let bumpAgeMinutes = null;
  try {
    const ts = sh('git', ['log', '-1', '--format=%ct', '--', 'package.json']);
    if (ts) bumpAgeMinutes = (Date.now() / 1000 - Number(ts)) / 60;
  } catch {
    // Leave null — the grace window simply does not apply.
  }

  let runStatus = null;
  let runConclusion = null;
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo && tags.includes(`v${manifestVersion}`)) {
    try {
      const json = sh('gh', [
        'api',
        `repos/${repo}/actions/runs?event=push&per_page=50`,
        '--jq',
        `[.workflow_runs[] | select(.head_branch=="v${manifestVersion}")][0] | {status, conclusion}`,
      ]);
      if (json && json !== 'null') {
        const parsed = JSON.parse(json);
        runStatus = parsed.status ?? null;
        runConclusion = parsed.conclusion ?? null;
      }
    } catch {
      // Leave null — reported as 'no-run', which is louder than the truth may
      // warrant but fails in the safe direction.
    }
  }

  const result = classifyDrift({
    manifestVersion,
    npmLatest,
    tags,
    runStatus,
    runConclusion,
    bumpAgeMinutes,
  });

  const label = result.ok ? 'OK' : 'DRIFT';
  console.log(`[${label}] ${result.status}: ${result.message}`);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

// Only run the CLI when invoked directly, so the test can import the logic.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
