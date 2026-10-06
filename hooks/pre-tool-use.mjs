// agb unified PreToolUse policy guard — entry point.
//
// Invoked by bin/hook-runner.sh (never directly by agy). Reads one JSON
// payload on stdin and prints at most one line: {"decision":"deny"|"ask",
// "reason":...}. Empty stdout means neutral pass-through. It never prints
// `allow` (Appendix A D7). Any internal failure exits non-zero with empty
// stdout so the runner applies its fail-safe table; the 7 s ceiling does the
// same (Appendix A.4 item 13). Evaluation is synchronous, so the ceiling can
// only fire between I/O turns; a stalled synchronous filesystem read is
// bounded by hook-runner.sh's 9 s watchdog instead.
import { evaluatePayload } from './policy/evaluate.mjs';

const CEILING_MS = 7000;

function readStdin() {
  return new Promise((resolveRead, rejectRead) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolveRead(data));
    process.stdin.on('error', rejectRead);
  });
}

async function main() {
  const ceiling = setTimeout(() => {
    process.stderr.write('agb policy guard: internal 7s ceiling reached\n');
    process.exit(1);
  }, CEILING_MS);
  ceiling.unref();

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: 'Malformed PreToolUse payload: invalid JSON' })}\n`);
    return;
  }
  const verdict = evaluatePayload(payload);
  if (verdict.decision === 'deny' || verdict.decision === 'ask') {
    process.stdout.write(`${JSON.stringify({ decision: verdict.decision, reason: verdict.reason })}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`agb policy guard: ${err?.stack ?? err}\n`);
  process.exit(1);
});
