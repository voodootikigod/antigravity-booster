// run_command classification (spec §4.5.1 Stages 1-5 as amended by Appendix A).
// Pure function of (args, ctx); ctx supplies repo lookups so this module never
// touches the ticket store itself.
import { isAbsolute, join, resolve } from 'node:path';
import { lexCommandLine } from './shell-lexer.mjs';
import { DESTRUCTIVE_ROOT_VERBS, PURE_READERS, TICKET_STORE_DIR } from './constants.mjs';
import {
  boosterDataRoots, hasHomePrefix, isWithin, matchDeclaredRail, matchImplicitRail,
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
const LIFECYCLE_VERBS = new Set(['complete', 'archive', 'update', 'edit', 'discard', 'restore']);

function hasWriteRedirect(sub) {
  return sub.redirects.some((r) => r.op.includes('>'));
}

/** Non-flag argv tokens, `--flag=value` values, and every redirection target. */
function candidateTokens(sub) {
  const out = [];
  for (const t of sub.argv.slice(1)) {
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (eq > 0 && eq < t.length - 1) out.push(t.slice(eq + 1));
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
    const launcher = argv[1].replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, ctx.home);
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
  if (a1 === 'commit') {
    return rest.every((t) => {
      if (/^--(amend|no-verify|all)$/.test(t)) return false;
      if (/^-[A-Za-z]+$/.test(t) && /[an]/.test(t.slice(1))) return false;
      return true;
    });
  }
  return false;
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
    return cwdRepo.adlc && cwdRepo.activeRail ? deny('Repository-wide destructive git command in a repository with active frozen rails') : PASS;
  }
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    for (const repo of ctx.knownRepos()) {
      if (repo.adlc && repo.activeRail && isWithin(repo.root, r.real, ctx.platform)) {
        return deny('Target path is the repository root (or its parent), which contains active frozen rails');
      }
    }
  }
  return PASS;
}

function classifySubcommand(sub, cwd, cwdRepo, ctx) {
  const argv = sub.argv;
  const shim = isShimInvocation(argv, ctx);
  const stage1 = !shim && isStage1(sub);
  const dirChange = ['cd', 'pushd', 'popd'].includes(argv[0]);
  const { verdict: targetVerdict, repos } = checkTargets(sub, cwd, ctx, { stage1, shim, dirChange });
  if (targetVerdict.decision === 'deny') return targetVerdict;
  const contextRepos = [cwdRepo, ...repos];

  if (argv[0] === 'adlc' && argv[1] === 'ticket' && LIFECYCLE_VERBS.has(argv[2])) {
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
  if (argv[0] === 'cd' || argv[0] === 'pushd' || argv[0] === 'popd') {
    return stage5(ctx, contextRepos, 'Directory change in an active-rail ADLC repository requires operator confirmation');
  }
  if (ctx.workerTicket && !ctx.readonly && contextRepos.some((r) => r.adlc) && isTestCommand(sub)) return PASS;
  if (!ctx.headless && contextRepos.some((r) => r.adlc && r.activeRail) && isRoutine(sub)) return PASS;
  return stage5(ctx, contextRepos, 'Unlisted or dynamic shell command in an active-rail ADLC repository requires operator confirmation');
}

/** Compound `cd <dir> && …`: a literal cd into a workspace path re-anchors later subcommands (Stage 4). */
function nextCwd(sub, cwd, ctx) {
  if (sub.argv[0] !== 'cd' || sub.argv.length !== 2 || sub.dynamic || hasHomePrefix(sub.argv[1])) return null;
  const target = resolve(cwd, sub.argv[1]);
  return ctx.workspacePaths.some((w) => isWithin(target, w, ctx.platform)) ? target : null;
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
  for (let i = 0; i < subs.length; i += 1) {
    const moved = subs.length > 1 ? nextCwd(subs[i], current, ctx) : null;
    if (moved) {
      current = moved;
      continue;
    }
    verdicts.push(classifySubcommand(subs[i], current, ctx.repoAt(current), ctx));
  }
  return mostRestrictive(verdicts);
}
