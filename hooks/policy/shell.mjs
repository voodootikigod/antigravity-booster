// run_command classification (spec §4.5.1 Stages 1-5 as amended by Appendix A).
//
// Posture (owner decision 2026-10-05, after two P5 prosecution rounds): shell
// classification is best-effort defense-in-depth. A shell cannot be parsed
// soundly, so this module closes the cheap, high-value spellings and fails
// closed where it cannot follow the shell (unknown working directory, hidden
// tokens); the mechanical guarantee remains the merge-time `adlc rails-guard`
// plus the CI trust-root check. File and MCP tools (evaluate.mjs) are exact.
//
// Pure function of (args, ctx); ctx supplies repo lookups.
import { readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { lexCommandLine } from './shell-lexer.mjs';
import { IMPLICIT_RAIL_DIRS, IMPLICIT_RAIL_FILES, PURE_READERS, TICKET_STORE_DIR } from './constants.mjs';
import {
  boosterDataRoots, expandHome, hasHomePrefix, isImplicitAncestorOnly, isRailAncestorOnly, isWithin,
  matchDeclaredRail, matchImplicitRail, matchRoot, protectedRoots, railStaticPrefix, repoRelative, resolveCandidate,
} from './paths.mjs';
import { ask, deny, PASS, mostRestrictive } from './verdict.mjs';

const GIT_READ_FLAGS = {
  status: [/^-s$/, /^--short$/, /^-b$/, /^--branch$/, /^--porcelain(=v[12])?$/, /^--ignored$/, /^-u(normal|all|no)?$/, /^--untracked-files(=.*)?$/],
  diff: [/^--staged$/, /^--cached$/, /^--stat$/, /^--name-only$/, /^--name-status$/, /^--color$/, /^--no-color$/, /^-p$/, /^-u$/, /^--$/],
  log: [/^-n\d*$/, /^-\d+$/, /^--max-count=\d+$/, /^--oneline$/, /^--graph$/, /^--stat$/, /^--pretty=.*$/, /^-p$/, /^--$/],
  show: [/^--stat$/, /^--name-only$/, /^--oneline$/, /^--$/],
};
const GIT_OUTPUT_FLAG = /^(--output(=.*)?|-o.*)$/;
const LIFECYCLE_VERBS = new Set(['complete', 'archive', 'update', 'edit', 'discard', 'restore', 'store']);
const DIR_CHANGE = new Set(['cd', 'pushd', 'popd']);
const COMMIT_LONG_FLAGS = new Set(['--message', '--signoff', '--quiet', '--verbose']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const MAX_NESTING = 3;
const MAX_PATTERN_LENGTH = 1024;
// Words that run (or precede) the next word as the real command.
const PREFIX_WORDS = new Set(['builtin', 'command', 'exec', 'time', 'nohup', 'nice', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', 'sudo', 'doas']);
const GLOB_CHARS = /[*?[{]/;

// ---------- argv shape ----------

/** Strip prefix words (`builtin cd`, `if cd`, `env FOO=1 git`) to the real command (P5 round 2). */
function effectiveArgv(argv) {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (PREFIX_WORDS.has(word)) {
      i += 1;
    } else if (word === 'env') {
      i += 1;
      while (i < argv.length && (argv[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]))) i += 1;
    } else {
      break;
    }
  }
  return argv.slice(i);
}

/** git subcommand past global options (`git -c x=y clean`, `git -C . reset`; P5 round 2). */
function gitSubcommand(argv) {
  if (argv[0] !== 'git') return null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    i += ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'].includes(argv[i]) ? 2 : 1;
  }
  return { verb: argv[i], args: argv.slice(i + 1) };
}

function hasWriteRedirect(sub) {
  return sub.redirects.some((r) => r.op.includes('>'));
}

/**
 * Non-flag argv tokens, `--flag=value` values, values attached to short
 * options (`-oFILE`, P5 prosecution H2), and every redirection target.
 * Over-inclusion is deliberate: a non-path candidate can only cause a
 * fail-closed false positive.
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

// ---------- verb classes ----------

/**
 * What a command may do to the paths it names:
 *   deletes  — removes or rewrites what it names (root/ancestor tokens deny)
 *   writes   — creates or overwrites inside what it names (ancestor tokens deny)
 *   repoWide — affects a whole repository regardless of tokens
 */
function verbClass(argv) {
  const [cmd, ...rest] = argv;
  const git = gitSubcommand(argv);
  if (git) {
    const { verb, args } = git;
    if (verb === 'clean') return { repoWide: 'clean' };
    if (verb === 'reset' && args.includes('--hard')) return { repoWide: 'reset' };
    if (verb === 'stash' && args.some((a) => ['-a', '--all', '-u', '--include-untracked'].includes(a))) return { repoWide: 'clean' };
    if (['checkout', 'restore', 'rm', 'mv'].includes(verb)) return { deletes: true, writes: true };
    return {};
  }
  if (cmd === 'rm' || cmd === 'mv' || cmd === 'shred' || cmd === 'unlink') return { deletes: true, writes: true };
  if (cmd === 'find' && rest.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(a))) return { deletes: true, writes: true };
  if ((cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') && rest.some((a) => /^-[a-zA-Z]*R/.test(a) || a === '--recursive')) return { deletes: true, writes: true };
  if (cmd === 'rsync') return rest.some((a) => a.startsWith('--delete')) ? { deletes: true, writes: true } : { writes: true };
  if (['cp', 'tar', 'install', 'ln', 'unzip', 'truncate', 'dd', 'tee', 'chmod', 'chown', 'touch', 'mkdir'].includes(cmd)) return { writes: true };
  return {};
}

// ---------- Stage predicates ----------

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

/** A pathspec that resolves to a whole repository (`.`, `./`, `docs/..`, `:/` magic). */
function isRootPathspec(token, cwd, ctx) {
  if (token.startsWith(':')) return true;
  const r = resolveCandidate(token, cwd, ctx.home);
  const repo = ctx.repoAt(r.real);
  return repo.adlc ? repoRelative(r.real, repo.root) === '' : false;
}

/**
 * D15 `git commit`: an allowlist, because git accepts any unambiguous
 * abbreviation of a long option (P5 prosecution H4); root pathspecs ask.
 */
function isRoutineCommit(args, cwd, ctx) {
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
      if (flags.length === 0 || !/^[sqv]*m?$/.test(flags)) return false;
      if (flags.endsWith('m')) expectValue = true;
      continue;
    }
    if (isRootPathspec(t, cwd, ctx)) return false;
  }
  return true;
}

/** Appendix A D15 as amended 2026-10-05: git add / git commit only (npm run build asks again). */
function isRoutine(sub, cwd, ctx) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  const [cmd, a1, ...rest] = sub.argv;
  if (cmd !== 'git') return false;
  if (a1 === 'add') {
    const paths = rest.filter((t) => t !== '--');
    return paths.length > 0 && paths.every((t) => !t.startsWith('-') && !isRootPathspec(t, cwd, ctx));
  }
  if (a1 === 'commit') return isRoutineCommit(rest, cwd, ctx);
  return false;
}

/** Non-flag operands after `adlc` / `adlc-tickets` / `@adlc/cli`, however invoked (P5 M2). */
function adlcTicketOperands(argv) {
  const i = argv.findIndex((t) => ['adlc', 'adlc-tickets'].includes(basename(t)) || /^@adlc\/cli(@[^/]+)?$/.test(t));
  if (i < 0) return null;
  const operands = argv.slice(i + 1).filter((t) => !t.startsWith('-'));
  return basename(argv[i]) === 'adlc-tickets' ? ['ticket', ...operands] : operands;
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

const askOrDeny = (ctx, reason) => (ctx.headless ? deny(reason) : ask(reason));

// ---------- target checks ----------

/** Concrete trust-root paths (and existing shards) a glob could expand to. */
function trustRootSamples(repo) {
  const samples = [...IMPLICIT_RAIL_FILES, ...IMPLICIT_RAIL_DIRS, ...IMPLICIT_RAIL_DIRS.map((d) => `${d}/x`), TICKET_STORE_DIR];
  try {
    for (const name of readdirSync(join(repo.root, TICKET_STORE_DIR))) samples.push(`${TICKET_STORE_DIR}/${name}`);
  } catch {
    // no store directory
  }
  return samples;
}

/**
 * A token with glob/brace characters is matched as a pattern against the
 * concrete trust-root paths, the declared literal rails and the protected
 * roots (P5 round 2). Only bounded-length patterns are evaluated; anything
 * longer is treated as hostile.
 */
function globTargetVerdict(token, cwd, ctx) {
  if (!GLOB_CHARS.test(token)) return null;
  if (token.length > MAX_PATTERN_LENGTH) return deny('Over-long glob pattern in a shell command cannot be verified');
  const absPattern = resolve(cwd, expandHome(token, ctx.home));
  const staticDir = dirname(absPattern.slice(0, absPattern.search(GLOB_CHARS) + 1));
  const roots = protectedRoots(ctx.home);
  if (roots.some((root) => isWithin(staticDir, root, ctx.platform) || (staticDir !== '/' && isWithin(root, staticDir, ctx.platform)))) {
    return deny('Glob in a shell command reaches platform configuration, plugins, or Node runtimes');
  }
  const repo = ctx.repoAt(staticDir);
  if (!repo.adlc) return null;
  const relPattern = relative(repo.root, absPattern).split(sep).join('/');
  if (relPattern.startsWith('..')) return null;
  const nocase = ctx.platform === 'darwin';
  const hit = trustRootSamples(repo).find((p) => minimatch(p, relPattern, { nocase }));
  if (hit) return deny(`Glob in a shell command can match the ADLC trust root: ${hit}`);
  const rail = repo.activeRail && repo.store.ok ? repo.store.rails.find((r) => railStaticPrefix(r) === r && minimatch(r, relPattern, { nocase })) : null;
  return rail ? deny(`Glob in a shell command can match frozen rail: ${rail}`) : null;
}

function writesIntoProtectedParent(r, ctx) {
  return protectedRoots(ctx.home).some((root) => isWithin(root, r.real, ctx.platform) || isWithin(root, r.lexical, ctx.platform));
}

function checkTargets(sub, cwd, ctx, { stage1, shim, dirChange, verbs }) {
  const writeTargets = new Set(sub.redirects.filter((r) => r.op.includes('>')).map((r) => r.target));
  const verdicts = [];
  const repos = [];
  const destructive = Boolean(verbs.deletes || verbs.writes);
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    if (matchRoot(r, boosterDataRoots(ctx.home), ctx.platform)) {
      return { verdict: deny('Inspection or modification of booster plugin data or credentials via tool calls is forbidden'), repos };
    }
    if ((writeTargets.has(token) || !(stage1 || shim)) && matchRoot(r, protectedRoots(ctx.home), ctx.platform)) {
      return { verdict: deny('Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden'), repos };
    }
    // Writing into a directory that CONTAINS a protected root (`cp -r x ~/.local/`, `tar -C ~`).
    if ((destructive || writeTargets.has(token)) && writesIntoProtectedParent(r, ctx)) {
      return { verdict: deny('Command writes into a directory containing platform configuration, plugins, or Node runtimes'), repos };
    }
    // Globs only threaten when the command can write: a pure reader with a glob
    // (`cat lib/*.mjs`) is dynamic and falls to Stage 5 instead.
    const pureRead = PURE_READERS.has(sub.argv[0]) && !hasWriteRedirect(sub);
    if (!stage1 && (!pureRead || writeTargets.has(token))) {
      const glob = globTargetVerdict(token, cwd, ctx);
      if (glob) return { verdict: glob, repos };
    }
    const repo = ctx.repoAt(r.real);
    repos.push(repo);
    if (!repo.adlc || stage1 || dirChange) continue;
    if (!repo.store.ok) return { verdict: deny('ADLC ticket store corrupt or unreadable; frozen rails cannot be verified'), repos };
    const rel = repoRelative(r.real, repo.root);
    if (rel === null || rel === '') continue; // repo root: handled by the destructive-root check
    const hard = destructive || writeTargets.has(token);
    const implicit = matchImplicitRail(rel, repo.root, ctx.platform);
    if (implicit) {
      verdicts.push(
        hard || !isImplicitAncestorOnly(rel, ctx.platform)
          ? deny(`Target path matches standing ADLC implicit rail: ${implicit}`)
          : askOrDeny(ctx, `Command names a directory containing the ADLC trust root (${implicit})`),
      );
    }
    const rail = repo.activeRail ? matchDeclaredRail(rel, repo.store.rails, ctx.platform) : null;
    if (rail) {
      verdicts.push(
        hard || !isRailAncestorOnly(rel, rail, ctx.platform)
          ? deny(`Target path matches frozen rail: ${rail}`)
          : askOrDeny(ctx, `Command names a directory containing frozen rail: ${rail}`),
      );
    }
  }
  return { verdict: mostRestrictive(verdicts), repos };
}

function checkDestructiveRoot(sub, cwd, cwdRepo, ctx, verbs, repos) {
  if (verbs.repoWide) {
    // clean / stash -a can remove ignored trust-root state (.adlc/manifest.jsonl)
    // in any ADLC repo; reset --hard rewrites tracked rails where rails exist.
    const touched = [cwdRepo, ...repos].filter((r) => r.adlc);
    if (touched.some((r) => verbs.repoWide === 'clean' || r.activeRail)) {
      return deny('Repository-wide destructive git command in an ADLC repository');
    }
    return PASS;
  }
  if (!verbs.deletes) return PASS;
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    if (writesIntoProtectedParent(r, ctx)) {
      return deny('Destructive command targets a directory containing platform configuration, plugins, or Node runtimes');
    }
    for (const repo of ctx.knownRepos()) {
      if (repo.adlc && isWithin(repo.root, r.real, ctx.platform)) {
        return deny('Target path is an ADLC repository root (or its parent), which holds frozen trust-root state');
      }
    }
  }
  return PASS;
}

// ---------- classification ----------

/** Script text of `sh -c '…'` / `bash -lc "…"` / `eval …`, or null. */
function inlineScript(argv) {
  if (argv[0] === 'eval') return argv.slice(1).join(' ');
  if (!SHELLS.has(basename(argv[0] ?? ''))) return null;
  const flag = argv.findIndex((t, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
  return flag > 0 && typeof argv[flag + 1] === 'string' ? argv[flag + 1] : null;
}

function classifySubcommand(rawSub, cwd, ctx, depth) {
  const sub = { ...rawSub, argv: effectiveArgv(rawSub.argv) };
  const argv = sub.argv;
  if (argv.length === 0) return PASS;
  const cwdRepo = ctx.repoAt(cwd);

  // Inline scripts are classified like the outer command line (P5 round 2).
  const inline = inlineScript(argv);
  if (inline !== null) {
    if (depth >= MAX_NESTING) return deny('Nested shell scripts too deep to verify');
    return classifyLine(inline, cwd, ctx, depth + 1);
  }

  const verbs = verbClass(argv);
  const shim = isShimInvocation(argv, ctx);
  const stage1 = !shim && isStage1(sub);
  const dirChange = DIR_CHANGE.has(argv[0]);
  const { verdict: targetVerdict, repos } = checkTargets(sub, cwd, ctx, { stage1, shim, dirChange, verbs });
  if (targetVerdict.decision === 'deny') return targetVerdict;
  const contextRepos = [cwdRepo, ...repos];
  const finish = (v) => mostRestrictive([targetVerdict, v]);

  const ticketOps = adlcTicketOperands(argv);
  if (ticketOps && ticketOps[0] === 'ticket' && LIFECYCLE_VERBS.has(ticketOps[1])) {
    if (!contextRepos.some((r) => r.adlc)) return finish(PASS);
    if (!argv.includes('--authorize')) return deny('Ticket lifecycle change without --authorize is forbidden in-session');
    return ctx.headless ? deny('Headless worker cannot authorize a ticket lifecycle change') : ask('Authorized ticket lifecycle change requires operator confirmation');
  }
  if (stage1) return finish(PASS);
  if (isStage2(sub, cwd, ctx)) return finish(PASS);
  const destructive = checkDestructiveRoot(sub, cwd, cwdRepo, ctx, verbs, repos);
  if (destructive.decision === 'deny') return destructive;
  const git = gitSubcommand(argv);
  if (git && ['diff', 'log'].includes(git.verb) && git.args.some((t) => GIT_OUTPUT_FLAG.test(t))) {
    return finish(stage5(ctx, contextRepos, 'git command writing --output requires operator confirmation'));
  }
  if (shim) {
    if (ctx.headless) return deny('Headless agb worker cannot invoke the agb shim');
    return finish(stage5(ctx, contextRepos, 'agb command in an active-rail ADLC repository requires operator confirmation'));
  }
  if (dirChange) return finish(stage5(ctx, contextRepos, 'Directory change in an active-rail ADLC repository requires operator confirmation'));
  if (ctx.workerTicket && !ctx.readonly && contextRepos.some((r) => r.adlc) && isTestCommand(sub)) return finish(PASS);
  if (!ctx.headless && contextRepos.some((r) => r.adlc && r.activeRail) && isRoutine(sub, cwd, ctx)) return finish(PASS);
  return finish(stage5(ctx, contextRepos, 'Unlisted or dynamic shell command in an active-rail ADLC repository requires operator confirmation'));
}

/**
 * Where a directory change leaves the shell, or null when it cannot be known
 * statically: `cd -`, `popd`, dynamic operands, or a relative operand that
 * CDPATH could redirect (P5 round 2).
 */
function dirChangeTarget(sub, cwd, ctx, cdpath) {
  const [cmd, ...rest] = effectiveArgv(sub.argv);
  if (sub.dynamic || cmd === 'popd') return null;
  const operands = rest.filter((t) => !/^-[LPe@]+$/.test(t) && t !== '--');
  if (operands.length === 0) return cmd === 'cd' ? ctx.home : null;
  const op = operands[0];
  if (operands.length > 1 || op === '-' || /^[+-]\d+$/.test(op)) return null;
  const cdpathApplies = !op.startsWith('/') && !op.startsWith('./') && !op.startsWith('../') && op !== '.' && op !== '..' && !hasHomePrefix(op);
  if (cdpath && cdpathApplies) return null;
  return resolve(cwd, expandHome(op, ctx.home));
}

const setsCdpath = (sub) => [...sub.assignments, ...sub.argv].some((t) => /^CDPATH=/.test(t));

/** Classify a whole command line, tracking the working directory across subcommands. */
function classifyLine(line, cwd, ctx, depth) {
  const lexed = lexCommandLine(line);
  if (!lexed.ok) return stage5(ctx, [ctx.repoAt(cwd)], 'Shell command could not be parsed; operator confirmation required');
  const verdicts = [];
  let current = cwd;
  let cdpath = ctx.cdpath;
  const subs = lexed.subcommands;
  for (const sub of subs) {
    if (current === null) {
      verdicts.push(deny('Working directory unknown after a directory change; later commands cannot be verified'));
      continue;
    }
    if (setsCdpath(sub)) cdpath = true;
    const argv = effectiveArgv(sub.argv);
    if (DIR_CHANGE.has(argv[0])) {
      const target = dirChangeTarget(sub, current, ctx, cdpath);
      const intoWorkspace = target !== null && ctx.workspacePaths.some((w) => isWithin(target, w, ctx.platform));
      // A literal cd into the workspace inside a compound command just
      // re-anchors (Stage 4); anything else is itself classified.
      if (!(subs.length > 1 && intoWorkspace)) verdicts.push(classifySubcommand(sub, current, ctx, depth));
      current = target;
      continue;
    }
    verdicts.push(classifySubcommand(sub, current, ctx, depth));
    // A directory change hidden inside another command (eval, sh -c, xargs cd …).
    if (argv[0] === 'eval' || inlineScript(argv) !== null || argv.some((t, i) => i > 0 && DIR_CHANGE.has(t))) current = null;
  }
  return mostRestrictive(verdicts);
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
  return classifyLine(line, cwd, ctx, 0);
}
