// run_command classification (spec §4.5.1 Stages 1-5 as amended by Appendix A).
// Pure function of (args, ctx); ctx supplies repo lookups so this module never
// touches the ticket store itself.
import { basename, isAbsolute, join, resolve } from 'node:path';
import { lexCommandLine } from './shell-lexer.mjs';
import { DESTRUCTIVE_ROOT_VERBS, PURE_READERS, TICKET_STORE_DIR } from './constants.mjs';
import {
  boosterDataRoots, expandHome, hasHomePrefix, isWithin, matchDeclaredRail, matchImplicitRail,
  matchRoot, protectedRoots, repoRelative, resolveCandidate,
} from './paths.mjs';
import { ask, deny, PASS, mostRestrictive } from './verdict.mjs';

const GIT_READ_FLAGS = {
  status: [/^-s$/, /^--short$/, /^-b$/, /^--branch$/, /^--porcelain(=v[12])?$/, /^--ignored$/, /^-u(normal|all|no)?$/, /^--untracked-files(=.*)?$/],
  diff: [/^--staged$/, /^--cached$/, /^--stat$/, /^--name-only$/, /^--name-status$/, /^--color$/, /^--no-color$/, /^-p$/, /^-u$/, /^--$/],
  log: [/^-n\d*$/, /^--max-count=\d+$/, /^--oneline$/, /^--graph$/, /^--stat$/, /^--pretty=.*$/, /^-p$/, /^--$/],
  show: [/^--stat$/, /^--name-only$/, /^--oneline$/, /^--$/],
};
const GIT_OUTPUT_FLAG = /^(--output(=.*)?|-o)$/;
const LIFECYCLE_VERBS = new Set(['complete', 'archive', 'update', 'edit', 'discard', 'restore', 'store']);
const DIR_CHANGE = new Set(['cd', 'pushd', 'popd']);
const COMMIT_LONG_FLAGS = new Set(['--message', '--signoff', '--quiet', '--verbose']);

/**
 * Non-flag operands following an `adlc` (or `adlc-tickets`) executable
 * anywhere in argv, so `npx adlc …`, `command adlc …` and global flags
 * (`adlc --json ticket …`) are recognised (P5 prosecution M2).
 */
function adlcTicketOperands(argv) {
  const i = argv.findIndex((t) => ['adlc', 'adlc-tickets'].includes(basename(t)));
  if (i < 0) return null;
  const operands = argv.slice(i + 1).filter((t) => !t.startsWith('-'));
  return basename(argv[i]) === 'adlc-tickets' ? ['ticket', ...operands] : operands;
}

function hasWriteRedirect(sub) {
  return sub.redirects.some((r) => r.op.includes('>'));
}

/**
 * Non-flag argv tokens, `--flag=value` values, values attached to short
 * options (`-oFILE`, `-tDIR`; P5 prosecution H2), and every redirection
 * target. Over-inclusion is deliberate: a candidate that is not really a path
 * can only cause a fail-closed false positive.
 */
function candidateTokens(sub) {
  const out = [];
  for (const t of sub.argv.slice(1)) {
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (eq > 0 && eq < t.length - 1) out.push(t.slice(eq + 1));
      else if (!t.startsWith('--') && t.length > 2) out.push(t.slice(2));
    } else if (t.length > 0) {
      out.push(t);
    }
  }
  for (const r of sub.redirects) if (r.target) out.push(r.target);
  return out;
}

function isGitOutput(argv) {
  return argv[0] === 'git' && ['diff', 'log'].includes(argv[1]) && argv.slice(2).some((t) => GIT_OUTPUT_FLAG.test(t));
}

function isStage1(sub) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  if (sub.argv.some(hasHomePrefix)) return false; // A.6 item 6
  const [cmd, verb, ...rest] = sub.argv;
  if (PURE_READERS.has(cmd)) return true;
  if (cmd !== 'git' || !GIT_READ_FLAGS[verb]) return false;
  const allowed = GIT_READ_FLAGS[verb];
  return rest.every((t) => !t.startsWith('-') || allowed.some((re) => re.test(t)));
}

function shimForms(home, realHome) {
  return new Set(['~/.local/bin/agb', '$HOME/.local/bin/agb', '${HOME}/.local/bin/agb', join(home, '.local/bin/agb'), join(realHome, '.local/bin/agb')]);
}

/** Appendix A D3 / A.6 item 6: canonical shim or launcher invocation. */
export function isShimInvocation(argv, ctx) {
  if (shimForms(ctx.home, ctx.realHome).has(argv[0])) return true;
  if ((argv[0] === '/bin/sh' || argv[0] === 'sh') && argv[2] === 'dist/agb.mjs' && typeof argv[1] === 'string') {
    const launcher = resolve(expandHome(argv[1], ctx.home)); // resolve() collapses ../ (P5 prosecution L1)
    const pluginsDir = join(ctx.home, '.gemini', 'config', 'plugins');
    return /\/antigravity-booster(-[^/]+)?\/bin\/node-launcher\.sh$/.test(launcher) && isWithin(launcher, pluginsDir, ctx.platform);
  }
  return false;
}

function isLiteralShardPath(token, cwd, ctx) {
  const r = resolveCandidate(token, cwd, ctx.home);
  const repo = ctx.repoAt(r.real);
  if (!repo.adlc) return false;
  const rel = repoRelative(r.real, repo.root);
  return rel !== null && rel.startsWith(`${TICKET_STORE_DIR}/`) && rel.endsWith('.json') && !rel.slice(TICKET_STORE_DIR.length + 1).includes('/');
}

function isStage2(sub, cwd, ctx) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  const [cmd, a1, a2, ...rest] = sub.argv;
  if (cmd === 'adlc' && a1 === 'ticket' && a2 === 'create') return true;
  if (cmd === 'git' && a1 === 'add') {
    const paths = [a2, ...rest].filter((t) => t !== undefined && t !== '--');
    return paths.length > 0 && paths.every((t) => !t.startsWith('-') && isLiteralShardPath(t, cwd, ctx));
  }
  return false;
}

/** Appendix A.4 item 8: headless worker test allowlist. */
function isTestCommand(sub) {
  if (sub.dynamic || sub.assignments.length > 0 || sub.redirects.length > 0) return false;
  const [cmd, a1, a2] = sub.argv;
  if (cmd === 'npm' && a1 === 'test') return sub.argv.length === 2 || a2 === '--';
  if (cmd === 'npm' && a1 === 'run' && sub.argv.length === 3) return a2 === 'test' || /^test:[\w.:-]+$/.test(a2);
  return cmd === 'node' && a1 === '--test';
}

/** Appendix A D15 / A.6 item 4: routine interactive pass-throughs in active-rail repos. */
function isRoutine(sub) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  const [cmd, a1, ...rest] = sub.argv;
  if (cmd === 'npm') return a1 === 'run' && rest.length === 1 && rest[0] === 'build';
  if (cmd !== 'git') return false;
  if (a1 === 'add') {
    const paths = rest.filter((t) => t !== '--');
    return paths.length > 0 && paths.every((t) => !t.startsWith('-') && t !== '.' && t !== '..');
  }
  if (a1 === 'commit') return isRoutineCommit(rest);
  return false;
}

/**
 * D15 `git commit`: an allowlist, because git accepts any unambiguous
 * abbreviation of a long option (`--amen`, `--no-veri`; P5 prosecution H4).
 */
function isRoutineCommit(args) {
  let expectValue = false;
  for (const t of args) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (t === '--') continue;
    if (t === '-m' || t === '--message') {
      expectValue = true;
      continue;
    }
    if (t.startsWith('--message=')) continue;
    if (t.startsWith('--')) {
      if (!COMMIT_LONG_FLAGS.has(t)) return false;
      continue;
    }
    if (t.startsWith('-')) {
      const flags = t.slice(1);
      if (!/^[sqv]*m?$/.test(flags) || flags.length === 0) return false;
      if (flags.endsWith('m')) expectValue = true;
    }
  }
  return true;
}

function destructiveRootScope(argv) {
  const [cmd, a1, ...rest] = argv;
  if (DESTRUCTIVE_ROOT_VERBS.has(cmd)) return 'paths';
  if (cmd !== 'git') return null;
  if (a1 === 'clean') return 'repo';
  if (a1 === 'reset' && rest.includes('--hard')) return 'repo';
  if (a1 === 'restore' || (a1 === 'checkout' && rest.includes('--'))) return 'paths';
  return null;
}

function stage5(ctx, repos, reason) {
  if (ctx.readonly) return deny('Read-only agb worker session: only inspection commands are permitted');
  const adlcRepos = repos.filter((r) => r.adlc);
  if (ctx.workerTicket) {
    return adlcRepos.length > 0 ? deny('Headless worker cannot prompt operator; dynamic or unlisted command denied per ADLC P4 doctrine') : PASS;
  }
  if (adlcRepos.some((r) => r.activeRail)) return ask(reason);
  return PASS;
}

function checkTargets(sub, cwd, ctx, { stage1, shim, dirChange }) {
  const writeTargets = new Set(sub.redirects.filter((r) => r.op.includes('>')).map((r) => r.target));
  const verdicts = [];
  const repos = [];
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    if (matchRoot(r, boosterDataRoots(ctx.home), ctx.platform)) {
      return { verdict: deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden'), repos };
    }
    if (matchRoot(r, protectedRoots(ctx.home), ctx.platform) && (writeTargets.has(token) || !(stage1 || shim))) {
      return { verdict: deny('Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden'), repos };
    }
    // The shim is a protected FILE root: writing into its directory (`cp -t ~/.local/bin agb`) replaces it.
    const shimDir = join(ctx.home, '.local', 'bin');
    if (!(stage1 || shim) && [r.lexical, r.real].some((p) => p === shimDir || p === join(ctx.realHome, '.local', 'bin'))) {
      return { verdict: deny('Writing into the directory that holds the agb terminal shim is forbidden'), repos };
    }
    const repo = ctx.repoAt(r.real);
    repos.push(repo);
    if (!repo.adlc || stage1 || dirChange) continue;
    if (!repo.store.ok) return { verdict: deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified'), repos };
    const rel = repoRelative(r.real, repo.root);
    if (rel === null || rel === '') continue; // repo root handled by the destructive-root check
    const implicit = matchImplicitRail(rel, repo.root, ctx.platform);
    if (implicit) verdicts.push(deny(`Target path matches standing ADLC implicit rail: ${implicit}`));
    const rail = repo.activeRail ? matchDeclaredRail(rel, repo.store.rails, ctx.platform) : null;
    if (rail) verdicts.push(deny(`Target path matches frozen rail: ${rail}`));
  }
  return { verdict: mostRestrictive(verdicts), repos };
}

function checkDestructiveRoot(sub, cwd, cwdRepo, ctx) {
  const scope = destructiveRootScope(sub.argv);
  if (!scope) return PASS;
  if (scope === 'repo') {
    // git clean can remove ignored trust-root state (.adlc/manifest.jsonl) in
    // any ADLC repo; reset --hard rewrites tracked rails only where rails exist.
    const isClean = sub.argv[1] === 'clean';
    if (cwdRepo.adlc && (isClean || cwdRepo.activeRail)) return deny('Repository-wide destructive git command in an ADLC repository');
    return PASS;
  }
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    if (protectedRoots(ctx.home).some((root) => isWithin(root, r.real, ctx.platform) || isWithin(root, r.lexical, ctx.platform))) {
      return deny('Destructive command targets a directory containing platform configuration, plugins, or Node runtimes');
    }
    for (const repo of ctx.knownRepos()) {
      // The root of any ADLC repo holds the D1 trust root (P5 prosecution M1).
      if (repo.adlc && isWithin(repo.root, r.real, ctx.platform)) {
        return deny('Target path is an ADLC repository root (or its parent), which holds frozen trust-root state');
      }
    }
  }
  return PASS;
}

function classifySubcommand(sub, cwd, cwdRepo, ctx) {
  const argv = sub.argv;
  const shim = isShimInvocation(argv, ctx);
  const stage1 = !shim && isStage1(sub);
  const dirChange = DIR_CHANGE.has(argv[0]);
  const { verdict: targetVerdict, repos } = checkTargets(sub, cwd, ctx, { stage1, shim, dirChange });
  if (targetVerdict.decision === 'deny') return targetVerdict;
  const contextRepos = [cwdRepo, ...repos];

  const ticketOps = adlcTicketOperands(argv);
  if (ticketOps && ticketOps[0] === 'ticket' && LIFECYCLE_VERBS.has(ticketOps[1])) {
    if (!contextRepos.some((r) => r.adlc)) return PASS;
    if (!argv.includes('--authorize')) return deny('Ticket lifecycle change without --authorize is forbidden in-session');
    return ctx.headless ? deny('Headless worker cannot authorize a ticket lifecycle change') : ask('Authorized ticket lifecycle change requires operator confirmation');
  }
  if (stage1) return PASS;
  if (isStage2(sub, cwd, ctx)) return PASS;
  const destructive = checkDestructiveRoot(sub, cwd, cwdRepo, ctx);
  if (destructive.decision === 'deny') return destructive;
  if (isGitOutput(argv)) return stage5(ctx, contextRepos, 'git command writing --output requires operator confirmation');
  if (shim) {
    if (ctx.headless) return deny('Headless agb worker cannot invoke the agb shim');
    return stage5(ctx, contextRepos, 'agb command in an active-rail ADLC repository requires operator confirmation');
  }
  if (DIR_CHANGE.has(argv[0])) {
    return stage5(ctx, contextRepos, 'Directory change in an active-rail ADLC repository requires operator confirmation');
  }
  if (ctx.workerTicket && !ctx.readonly && contextRepos.some((r) => r.adlc) && isTestCommand(sub)) return PASS;
  if (!ctx.headless && contextRepos.some((r) => r.adlc && r.activeRail) && isRoutine(sub)) return PASS;
  return stage5(ctx, contextRepos, 'Unlisted or dynamic shell command in an active-rail ADLC repository requires operator confirmation');
}

/**
 * Where a directory change leaves the shell, or null when it cannot be known
 * statically (`cd -`, `popd`, a dynamic operand). Every literal form is
 * followed, inside the workspace or not (P5 prosecution H1).
 */
function dirChangeTarget(sub, cwd, ctx) {
  const [cmd, ...rest] = sub.argv;
  if (sub.dynamic || cmd === 'popd') return null;
  const operands = rest.filter((t) => !/^-[LPe@]+$/.test(t) && t !== '--');
  if (operands.length === 0) return cmd === 'cd' ? ctx.home : null;
  if (operands.length > 1 || operands[0] === '-' || /^[+-]\d+$/.test(operands[0])) return null;
  return resolve(cwd, expandHome(operands[0], ctx.home));
}

export function classifyRunCommand(args, ctx) {
  const line = args?.CommandLine;
  if (typeof line !== 'string') return deny('run_command without a CommandLine string cannot be verified');
  const cwdRaw = typeof args?.Cwd === 'string' && args.Cwd.length > 0 ? args.Cwd : ctx.workspacePaths[0];
  if (!cwdRaw) return deny('Cannot determine the shell working directory');
  const cwd = isAbsolute(cwdRaw) ? resolve(cwdRaw) : resolve(ctx.workspacePaths[0] ?? '/', cwdRaw);
  const cwdRepo = ctx.repoAt(cwd);
  const adlcContext = cwdRepo.adlc || ctx.workspacePaths.some((w) => ctx.repoAt(w).adlc);
  const insideWorkspace = ctx.workspacePaths.some((w) => isWithin(cwd, w, ctx.platform));
  if (adlcContext && (!isAbsolute(cwdRaw) || !insideWorkspace)) {
    return deny('Shell command working directory outside declared workspace paths in an ADLC repository is forbidden');
  }

  const lexed = lexCommandLine(line);
  if (!lexed.ok) return stage5(ctx, [cwdRepo], 'Shell command could not be parsed; operator confirmation required');

  const verdicts = [];
  let current = cwd;
  const subs = lexed.subcommands;
  for (const sub of subs) {
    if (current === null) {
      verdicts.push(deny('Working directory unknown after a directory change; later commands cannot be verified'));
      continue;
    }
    if (DIR_CHANGE.has(sub.argv[0])) {
      const target = dirChangeTarget(sub, current, ctx);
      const intoWorkspace = target !== null && ctx.workspacePaths.some((w) => isWithin(target, w, ctx.platform));
      // A literal cd into the workspace inside a compound command just re-anchors (Stage 4);
      // anything else is itself classified (ask in active-rail interactive, deny headless).
      if (!(subs.length > 1 && intoWorkspace)) verdicts.push(classifySubcommand(sub, current, ctx.repoAt(current), ctx));
      current = target;
      continue;
    }
    verdicts.push(classifySubcommand(sub, current, ctx.repoAt(current), ctx));
  }
  return mostRestrictive(verdicts);
}
