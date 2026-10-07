// Booster-owned dispatcher for the vendored adlc subset (spec
// .adlc/specs/native-plugin-installation.md Appendix A D12).
//
// Every upstream verb bin is a self-executing, process.argv-driven module with
// no exported entry function, so a plain top-level static import would run all
// eight at load. Each verb is instead a literal-specifier import() in a fixed
// table: esbuild resolves and inlines every one at BUNDLE time (lazy module
// init, no code splitting), so the shipped bundle performs no runtime module
// resolution. No require.resolve, no computed specifiers.
// `ticket` is imported by relative path because @adlc/tickets' exports map
// does not export its bin.
import pkg from '../package.json' with { type: 'json' };

export const VERBS = Object.freeze({
  'rails-guard': () => import('@adlc/rails-guard/bin/rails-guard.mjs'),
  'gate-manifest': () => import('@adlc/gate-manifest/bin/gate-manifest.mjs'),
  'flail-detector': () => import('@adlc/flail-detector/bin/flail-detector.mjs'),
  'hollow-test': () => import('@adlc/hollow-test/bin/hollow-test.mjs'),
  'consensus-fix': () => import('@adlc/consensus-fix/bin/consensus-fix.mjs'),
  'model-router': () => import('@adlc/model-router/bin/model-router.mjs'),
  'merge-forecast': () => import('@adlc/merge-forecast/bin/merge-forecast.mjs'),
  ticket: () => import('../../../node_modules/@adlc/tickets/bin/adlc-tickets.mjs'),
});

function usage() {
  return `adlc ${pkg.version} (vendored by antigravity-booster)\nusage: adlc <verb> [args]\nverbs: ${Object.keys(VERBS).join(', ')}\n`;
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === '--version' || verb === '-v') {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(usage());
    return;
  }
  const load = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!load) {
    process.stderr.write(`verb not vendored: ${verb}\n`);
    process.exitCode = 1;
    return;
  }
  // Upstream bins read process.argv.slice(2); present them their own argv.
  process.argv = [process.argv[0], `adlc-${verb}`, ...rest];
  await load();
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`adlc: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
