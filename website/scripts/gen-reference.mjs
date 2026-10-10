#!/usr/bin/env node
// §7.1–§7.6: generate the reference partials in website/generated/ from SOURCE TEXT only.
// Nothing under lib/ bin/ mcp/ hooks/ sidecars/ scripts/ is loaded or executed: every input is
// read with fs.readFileSync and parsed with regexes or the static literal parser in lib/jslit.mjs.
//
// Flags: --only <cli|env|layout|docs-md|modules|root-docs>, --env-only, --extra-token NAME
// (repeatable), --check, --repo <dir> (repo root, default ../..), --out <dir> (default
// <repo>/website/generated). Failures print `<file>:<line>: <reason>` and exit 1.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLiteralStart, lineOf, ParseError, parseLiteral } from './lib/jslit.mjs';
import { frontmatter, listFiles, prose, REPO_BLOB_MAIN, table } from './lib/md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GENERATORS = ['cli', 'env', 'layout', 'docs-md', 'modules', 'root-docs'];
export const ENV_GROUPS = [
  'core',
  'plugin-resolution',
  'sandbox-and-gates',
  'pools-and-quota',
  'sidecar',
  'paths',
  'adlc',
  'internal/test-only',
];
const GROUP_TITLES = {
  core: 'Core',
  'plugin-resolution': 'Plugin resolution',
  'sandbox-and-gates': 'Sandbox and gates',
  'pools-and-quota': 'Pools and quota',
  sidecar: 'Sidecar',
  paths: 'Paths',
  adlc: 'ADLC toolkit',
};
const ENV_SCAN_DIRS = ['lib', 'bin', 'mcp', 'hooks', 'sidecars', 'scripts'];
const ENV_TOKEN = /\b(?:AGB|ADLC|ANTIGRAVITY)_[A-Z0-9_]+\b/g;

class GenError extends Error {
  constructor(file, line, reason) {
    super(`${file}:${line}: ${reason}`);
  }
}

const rel = (repo, file) => path.relative(repo, file).split(path.sep).join('/');

function readRepo(repo, file) {
  const full = path.join(repo, file);
  try {
    return readFileSync(full, 'utf8');
  } catch (e) {
    throw new GenError(file, 1, `cannot read (${e.code ?? e.message})`);
  }
}

function literalAt(repo, file, marker, what) {
  const src = readRepo(repo, file);
  const start = findLiteralStart(src, marker);
  if (start === -1) throw new GenError(file, 1, `${what} literal not found`);
  try {
    return { src, start, ...parseLiteral(src, start) };
  } catch (e) {
    if (e instanceof ParseError) throw new GenError(file, e.line, `${what}: ${e.message}`);
    throw e;
  }
}

const join = (parts) => `${parts.filter((p) => p !== null && p !== undefined).join('\n\n')}\n`;

// ---------------------------------------------------------------- 7.1 cli

/** Parse flag tokens such as `--out <file>`, `[--interval <ms>]`, `--force (re-run after X)`. */
export function parseFlags(spec) {
  const flags = [];
  const seen = new Set();
  const re = /(-{1,2}[a-z][\w-]*)(?:\]?\s+(<[^>]+>))?(?:\]?\s+\(([^)]*)\))?/g;
  for (const m of String(spec ?? '').matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    flags.push({ flag: m[1], arg: m[2] ?? '', desc: m[3] ?? '' });
  }
  return flags.sort((a, b) => a.flag.localeCompare(b.flag));
}

// Flags a command's dispatch branch actually reads from `rest` (e.g.
// `rest.includes('--no-coldstart')`), so a flag parsed in code but missing from
// COMMANDS[cmd].flags still reaches the generated reference.
export function dispatchFlags(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = src.search(new RegExp(`(?:^|\\})\\s*(?:else\\s+)?if\\s*\\(cmd\\s*===\\s*'${esc}'`, 'm'));
  if (start < 0) return [];
  const rest = src.slice(start + 1);
  const next = rest.search(/\}\s*else\s+if\s*\(\s*\(?cmd\s*===/);
  const body = next < 0 ? rest : rest.slice(0, next);
  const found = new Set();
  const re = /rest(?:\.(?:includes|indexOf)\(|\[[^\]]+\]\s*===\s*)'(-{1,2}[a-z][\w-]*)'/g;
  for (const m of body.matchAll(re)) found.add(m[1]);
  return [...found].sort();
}

function parseCli(repo) {
  const file = 'bin/agb.mjs';
  const { src, value: commands } = literalAt(repo, file, /const\s+COMMANDS\s*=\s*/, 'COMMANDS');
  for (const [name, c] of Object.entries(commands)) {
    if (typeof c !== 'object' || c === null || typeof c.desc !== 'string' || typeof c.args !== 'string')
      throw new GenError(file, lineOf(src, src.indexOf(name)), `COMMANDS.${name} needs string args and desc`);
  }
  // Aliases that dispatch to another command: `(cmd === 'setup' || ...) ? 'bootstrap'`.
  const aliases = {};
  const aliasRe = /\(((?:\s*cmd\s*===\s*'[\w-]+'\s*\|\|?)+[^)]*)\)\s*\?\s*'([\w-]+)'/g;
  for (const m of src.matchAll(aliasRe)) {
    if (!aliases[m[2]]) aliases[m[2]] = [];
    for (const a of m[1].matchAll(/cmd\s*===\s*'([\w-]+)'/g)) aliases[m[2]].push(a[1]);
  }
  const subAlias = /cmd\s*===\s*'([\w-]+)'\s*&&\s*\[([^\]]*)\]\.includes\(rest\[0\]\)/.exec(src);
  if (subAlias) {
    const target = Object.keys(aliases).find((t) => aliases[t].includes(subAlias[1]));
    if (target) {
      const subs = [...subAlias[2].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
      aliases[target] = aliases[target].map((a) => (a === subAlias[1] ? `${a} ${subs.join('|')}` : a));
    }
  }
  const lineWords = (re) => {
    const line = src.split('\n').find((l) => re.test(l)) ?? '';
    return [...line.matchAll(/cmd\s*===\s*'([^']+)'/g)].map((x) => x[1]);
  };
  const version = lineWords(/cmd === '--version'/);
  const help = lineWords(/cmd === 'help' \|\|/);
  const globals = [...src.matchAll(/rawArgs\[i\]\s*===\s*'(--[\w-]+)'/g)].map((x) => x[1]);
  const exitLine = /\\+n(Exit codes:[^']*)'/.exec(src)?.[1] ?? '';
  // Removed flags: `rest.includes('--x')` followed by an error mentioning "removed".
  const removedFlags = [];
  const lines = src.split('\n');
  lines.forEach((l, idx) => {
    const m = /rest\.includes\('(--[\w-]+)'\)/.exec(l);
    if (!m) return;
    const msg = lines
      .slice(idx + 1, idx + 3)
      .map((x) => /console\.error\('([^']*removed[^']*)'\)/.exec(x)?.[1])
      .find(Boolean);
    if (!msg) return;
    let owner = '';
    for (let j = idx; j >= 0; j--) {
      const o = /cmd === '([\w-]+)'\)/.exec(lines[j]);
      if (o) {
        owner = o[1];
        break;
      }
    }
    removedFlags.push({ flag: m[1], command: owner, message: msg });
  });
  const dispatch = Object.fromEntries(Object.keys(commands).map((n) => [n, dispatchFlags(src, n)]));
  return { commands, aliases, version, help, globals, exitLine, removedFlags, dispatch };
}

function genCli(repo) {
  const cli = parseCli(repo);
  const out = {};
  const names = Object.keys(cli.commands).sort();
  for (const name of names) {
    const c = cli.commands[name];
    const declared = parseFlags(`${c.args} ${c.flags ?? ''}`);
    const known = new Set(declared.map((f) => f.flag));
    const flags = [
      ...declared,
      ...cli.dispatch[name].filter((f) => !known.has(f)).map((flag) => ({ flag, arg: '', desc: '' })),
    ].sort((a, b) => a.flag.localeCompare(b.flag));
    const usage = `agb ${name}${c.args ? ` ${c.args}` : ''}`;
    out[`cli-${name}.mdx`] = join([
      `\`\`\`text\n${usage}\n\`\`\``,
      prose(c.desc.charAt(0).toUpperCase() + c.desc.slice(1)) + (c.desc.endsWith('.') ? '' : '.'),
      c.extended ? `Pipeline: ${prose(c.extended)}.` : null,
      flags.length
        ? table(
            ['Flag', 'Argument', 'Description'],
            flags.map((f) => [f.flag, f.arg, f.desc]),
          )
        : 'This command takes no flags.',
      cli.aliases[name] ? `Aliases: ${cli.aliases[name].map((a) => `\`agb ${a}\``).join(', ')}.` : null,
    ]);
  }
  const rows = names.map((n) => [`agb ${n}`, cli.commands[n].args, cli.commands[n].desc]);
  rows.push([`agb ${cli.help.join(' | ')} [command]`, '', 'print usage, or one command’s usage']);
  rows.push([`agb ${cli.version.join(' | ')}`, '', 'print the installed version']);
  out['cli-index.mdx'] = join([
    table(['Command', 'Arguments', 'Description'], rows),
    cli.globals.length
      ? table(
          ['Global flag', 'Argument', 'Description'],
          cli.globals.map((g) => [g, '<name>', 'forwarded as the agy project for the sessions the command starts']),
        )
      : null,
    Object.keys(cli.aliases).length
      ? table(
          ['Alias', 'Runs'],
          Object.entries(cli.aliases)
            .sort()
            .flatMap(([t, as]) => as.map((a) => [`agb ${a}`, `agb ${t}`])),
        )
      : null,
    cli.exitLine ? prose(cli.exitLine) : null,
  ]);
  const removed = names
    .filter((n) => /^(removed|deprecated)\b/i.test(cli.commands[n].desc))
    .map((n) => [`agb ${n}`, /^removed/i.test(cli.commands[n].desc) ? 'removed' : 'deprecated', cli.commands[n].desc]);
  for (const f of cli.removedFlags) removed.push([`agb ${f.command} ${f.flag}`, 'removed', f.message]);
  out['cli-removed.mdx'] = join([
    table(
      ['Item', 'Status', 'Message'],
      removed.sort((a, b) => a[0].localeCompare(b[0])),
    ),
  ]);
  return out;
}

// ---------------------------------------------------------------- 7.2 env

export function scanEnvTokens(repo) {
  const found = new Map(); // name -> "file:line" of first occurrence
  for (const dir of ENV_SCAN_DIRS) {
    const files = listFiles(
      path.join(repo, dir),
      (r) =>
        /\.(mjs|cjs|js|sh)$/.test(r) && !/(^|\/)(test|node_modules|dist|website)\//.test(r) && !r.startsWith('test/'),
    );
    for (const f of files) {
      const file = `${dir}/${f}`;
      readRepo(repo, file)
        .split('\n')
        .forEach((l, idx) => {
          for (const m of l.matchAll(ENV_TOKEN)) if (!found.has(m[0])) found.set(m[0], `${file}:${idx + 1}`);
        });
    }
  }
  return found;
}

function genEnv(repo, { extraTokens = [], website }) {
  const docsFile = path.join(website, 'env-docs.json');
  const docsRel = rel(repo, docsFile);
  let text;
  try {
    text = readFileSync(docsFile, 'utf8');
  } catch (e) {
    throw new GenError(docsRel, 1, `cannot read (${e.code})`);
  }
  let docs;
  try {
    docs = JSON.parse(text);
  } catch (e) {
    throw new GenError(docsRel, 1, `invalid JSON (${e.message})`);
  }
  const lineFor = (name) => {
    const idx = text.indexOf(`"${name}"`);
    return idx === -1 ? 1 : lineOf(text, idx);
  };
  const errors = [];
  const found = scanEnvTokens(repo);
  for (const t of extraTokens) if (!found.has(t)) found.set(t, '--extra-token:1');
  const vars = Array.isArray(docs.vars) ? docs.vars : [];
  const ignore = Array.isArray(docs.ignore) ? docs.ignore : [];
  const documented = new Set();
  for (const v of vars) {
    const where = `${docsRel}:${lineFor(v.name)}`;
    if (documented.has(v.name)) errors.push(`${where}: ${v.name} is documented twice`);
    documented.add(v.name);
    if (!ENV_GROUPS.includes(v.group)) errors.push(`${where}: ${v.name} has unknown group ${JSON.stringify(v.group)}`);
    if (typeof v.description !== 'string' || !v.description) errors.push(`${where}: ${v.name} needs a description`);
    if (typeof v.bundledIgnored !== 'boolean') errors.push(`${where}: ${v.name} needs boolean bundledIgnored`);
    if (!found.has(v.name)) errors.push(`${where}: ${v.name} is documented in vars but not found in code`);
  }
  for (const v of ignore) {
    const where = `${docsRel}:${lineFor(v.name)}`;
    if (documented.has(v.name)) errors.push(`${where}: ${v.name} is in both vars and ignore`);
    documented.add(v.name);
    if (typeof v.reason !== 'string' || !v.reason) errors.push(`${where}: ignore entry ${v.name} needs a reason`);
    if (!found.has(v.name)) errors.push(`${where}: ${v.name} is in ignore but not found in code`);
  }
  for (const [name, where] of [...found].sort()) {
    if (!documented.has(name)) errors.push(`${where}: ${name} found in code but not in env-docs.json vars or ignore`);
  }
  if (errors.length) {
    const e = new Error(errors.join('\n'));
    e.multi = errors;
    throw e;
  }
  const parts = [];
  for (const g of ENV_GROUPS.filter((x) => x !== 'internal/test-only')) {
    const rows = vars
      .filter((v) => v.group === g)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((v) => [
        v.name,
        v.default ?? '',
        v.security ? `${v.description} Security: ${v.security}` : v.description,
        v.bundledIgnored ? 'ignored' : 'honoured',
      ]);
    if (!rows.length) continue;
    parts.push(`**${GROUP_TITLES[g]}**`, table(['Name', 'Default', 'Description', 'Bundled'], rows));
  }
  return { 'environment.mdx': join(parts) };
}

// ---------------------------------------------------------------- 7.3 layout

function readJson(repo, file) {
  const text = readRepo(repo, file);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GenError(file, 1, `invalid JSON (${e.message})`);
  }
}

function dirListing(repo, dir, depth) {
  const rows = [];
  const walk = (d, level) => {
    let entries;
    try {
      entries = readdirSync(path.join(repo, d)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const p = `${d}/${name}`;
      const isDir = statSync(path.join(repo, p)).isDirectory();
      rows.push([isDir ? `${p}/` : p, isDir ? 'directory' : 'file']);
      if (isDir && level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 1);
  return rows;
}

function genLayout(repo) {
  const plugin = readJson(repo, 'plugin.json');
  const hooks = readJson(repo, 'hooks.json');
  const mcp = readJson(repo, 'mcp_config.json');
  const pkg = readJson(repo, 'package.json');
  const hookRows = [];
  for (const [group, events] of Object.entries(hooks).sort()) {
    for (const [event, entries] of Object.entries(events).sort()) {
      for (const e of entries) {
        for (const h of e.hooks ?? []) hookRows.push([group, event, e.matcher ?? '', h.command ?? '', h.timeout ?? '']);
      }
    }
  }
  const mcpRows = Object.entries(mcp.mcpServers ?? {})
    .sort()
    .map(([name, s]) => [name, [s.command, ...(s.args ?? [])].join(' ')]);
  const listings = [];
  for (const [dir, depth] of [
    ['templates', 1],
    ['sidecars', 1],
    ['dist', 2],
    ['vendor', 2],
  ]) {
    listings.push(...dirListing(repo, dir, depth));
  }
  return {
    'plugin-layout.mdx': join([
      '**plugin.json**',
      table(
        ['Field', 'Value'],
        Object.entries(plugin)
          .sort()
          .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      ),
      '**hooks.json**',
      table(['Hook group', 'Event', 'Matcher', 'Command', 'Timeout (s)'], hookRows),
      '**mcp_config.json**',
      table(['Server', 'Command'], mcpRows),
      '**package.json files** (what the plugin ships)',
      table(
        ['Path'],
        [...(pkg.files ?? [])].sort().map((f) => [f]),
      ),
      '**Shipped directories**',
      table(['Path', 'Kind'], listings),
    ]),
  };
}

// ---------------------------------------------------------------- 7.4 docs-md

function fm(repo, file) {
  const { data } = frontmatter(readRepo(repo, file));
  if (!data.name || !data.description) throw new GenError(file, 1, 'frontmatter needs name and description');
  return data;
}

function genDocsMd(repo) {
  const cmdRows = listFiles(path.join(repo, 'commands'), (r) => /^[^/]+\.md$/.test(r)).map((f) => {
    const file = `commands/${f}`;
    const d = fm(repo, file);
    const usage = /^#\s+(\/.+)$/m.exec(readRepo(repo, file))?.[1] ?? `/${d.name}`;
    return [`/${d.name}`, usage, d.description];
  });
  const agentRows = listFiles(path.join(repo, 'agents'), (r) => /^[^/]+\.md$/.test(r)).map((f) => {
    const d = fm(repo, `agents/${f}`);
    return [d.name, d.description, typeof d.tools === 'string' ? d.tools : ''];
  });
  const skillRows = listFiles(path.join(repo, 'skills'), (r) => /^[^/]+\/SKILL\.md$/.test(r)).map((f) => {
    const dir = f.split('/')[0];
    const d = fm(repo, `skills/${f}`);
    const scripts = listFiles(path.join(repo, 'skills', dir, 'scripts')).map((s) => `scripts/${s}`);
    const internal = d.metadata && typeof d.metadata === 'object' && d.metadata.internal === true;
    return [
      d.name,
      d.description,
      d['user-invocable'] === true ? 'yes' : 'no',
      internal ? 'yes' : 'no',
      scripts.join(', '),
    ];
  });
  return {
    'slash-commands.mdx': join([table(['Command', 'Usage', 'Description'], cmdRows)]),
    'agents.mdx': join([table(['Agent', 'Description', 'Tools'], agentRows)]),
    'skills.mdx': join([table(['Skill', 'Description', 'User-invocable', 'Internal', 'Scripts'], skillRows)]),
  };
}

// ---------------------------------------------------------------- 7.5 modules + mcp-tools

export function parseExports(src) {
  const names = new Set();
  const reexports = [];
  const add = (n) => n && names.add(n);
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s+class\s+([\w$]+)/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([\w$]+)/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+\{([^}]*)\}/gm))
    for (const p of m[1].split(',')) add(p.split(':').pop().trim());
  for (const m of src.matchAll(/^export\s+default\b/gm)) if (m) add('default');
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    for (const p of m[1].split(',')) {
      const name = p
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      add(name);
    }
    if (m[2]) reexports.push(m[2]);
  }
  for (const m of src.matchAll(/^export\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]/gm)) {
    if (m[1]) add(m[1]);
    reexports.push(`* from ${m[2]}`);
  }
  return { names: [...names].sort(), reexports: reexports.sort() };
}

function genModules(repo) {
  const files = [];
  const add = (dir, filter) => {
    for (const f of listFiles(path.join(repo, dir), filter)) files.push(`${dir}/${f}`);
  };
  add('lib', (r) => /^[^/]+\.mjs$/.test(r));
  add('hooks', (r) => r.endsWith('.mjs'));
  add('sidecars', (r) => /^[^/]+\.mjs$/.test(r));
  add('mcp', (r) => /^[^/]+\.mjs$/.test(r));
  add('bin', (r) => /^[^/]+\.mjs$/.test(r));
  files.sort();
  const rows = files.map((f) => {
    const { names, reexports } = parseExports(readRepo(repo, f));
    const parts = [names.join(', ') || '(no exports: entry point)'];
    if (reexports.length) parts.push(`re-exports ${reexports.join(', ')}`);
    return [f, parts.join('; ')];
  });

  const file = 'mcp/server.mjs';
  const { value: tools } = literalAt(repo, file, /const\s+TOOLS\s*=\s*/, 'TOOLS');
  if (!Array.isArray(tools)) throw new GenError(file, 1, 'TOOLS must be an array literal');
  const parts = [];
  for (const t of [...tools].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (typeof t?.name !== 'string') throw new GenError(file, 1, 'every TOOLS entry needs a string name');
    const props = t.inputSchema?.properties ?? {};
    const required = new Set(t.inputSchema?.required ?? []);
    parts.push(`**\`${t.name}\`**: ${prose(t.description ?? '')}`);
    const keys = Object.keys(props).sort();
    parts.push(
      keys.length
        ? table(
            ['Parameter', 'Type', 'Required', 'Description'],
            keys.map((k) => [k, props[k].type ?? '', required.has(k) ? 'yes' : 'no', props[k].description ?? '']),
          )
        : 'No parameters.',
    );
  }
  return {
    'modules.mdx': join([table(['Module', 'Exports'], rows)]),
    'mcp-tools.mdx': join(parts),
  };
}

// ---------------------------------------------------------------- 7.6 root-docs

/** Rewrite repo-relative markdown links to blob/main and make the text MDX-safe. */
export function convertRootDoc(text, docPath = '') {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const out = [];
  let fence = null;
  let droppedH1 = false;
  const docDir = path.posix.dirname(docPath);
  const rewrite = (url) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return url;
    const [p, hash] = url.split('#');
    const target = path.posix.normalize(path.posix.join(docDir, p));
    if (target.startsWith('..')) return url;
    return `${REPO_BLOB_MAIN}${target}${hash ? `#${hash}` : ''}`;
  };
  for (const line of lines) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(line);
      continue;
    }
    if (!droppedH1 && /^#\s/.test(line)) {
      droppedH1 = true;
      continue;
    }
    // Split on inline code spans; escape and rewrite only outside them.
    const segs = line.split(/(`+[^`]*`+)/);
    out.push(
      segs
        .map((s, i) => {
          if (i % 2 === 1) return s;
          let t = s.replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]($1)');
          t = t.replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (_, label, url) => `${label}(${rewrite(url)})`);
          return t
            .replaceAll('{', '&#123;')
            .replaceAll('}', '&#125;')
            .replace(/<(?!\/?[a-z][\w-]*[\s>/])/g, '&lt;')
            .replace(/<(\/?[a-z][\w-]*)/g, '&lt;$1');
        })
        .join(''),
    );
  }
  while (out.length && !out[0].trim()) out.shift();
  return `${out.join('\n').trimEnd()}\n`;
}

function genRootDocs(repo) {
  return {
    'contributing.mdx': convertRootDoc(readRepo(repo, 'CONTRIBUTING.md'), 'CONTRIBUTING.md'),
    'changelog.mdx': convertRootDoc(readRepo(repo, 'CHANGELOG.md'), 'CHANGELOG.md'),
  };
}

// ---------------------------------------------------------------- driver

export function generate({ repo, only = null, extraTokens = [], website = path.join(repo, 'website') }) {
  const run = {
    cli: () => genCli(repo),
    env: () => genEnv(repo, { extraTokens, website }),
    layout: () => genLayout(repo),
    'docs-md': () => genDocsMd(repo),
    modules: () => genModules(repo),
    'root-docs': () => genRootDocs(repo),
  };
  const outputs = {};
  const errors = [];
  for (const g of only ? [only] : GENERATORS) {
    try {
      Object.assign(outputs, run[g]());
    } catch (e) {
      if (e.multi) errors.push(...e.multi);
      else if (e instanceof GenError) errors.push(e.message);
      else throw e;
    }
  }
  return { outputs, errors };
}

function main(argv) {
  const args = { extraTokens: [], check: false, only: null, repo: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`gen-reference: ${a} needs a value`);
        process.exit(1);
      }
      return v;
    };
    if (a === '--check') args.check = true;
    else if (a === '--env-only') args.only = 'env';
    else if (a === '--only') args.only = val();
    else if (a === '--extra-token') args.extraTokens.push(val());
    else if (a === '--repo') args.repo = path.resolve(val());
    else if (a === '--out') args.out = path.resolve(val());
    else {
      console.error(`gen-reference: unknown argument ${a}`);
      process.exit(1);
    }
  }
  if (args.only && !GENERATORS.includes(args.only)) {
    console.error(`gen-reference: --only must be one of ${GENERATORS.join(', ')}`);
    process.exit(1);
  }
  const repo = args.repo ?? path.resolve(HERE, '../..');
  const outDir = args.out ?? path.join(repo, 'website', 'generated');
  const { outputs, errors } = generate({ repo, only: args.only, extraTokens: args.extraTokens });
  if (errors.length) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const stale = [];
  for (const [name, content] of Object.entries(outputs).sort()) {
    const file = path.join(outDir, name);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === content) continue;
    if (args.check) stale.push(`${rel(repo, file)}:1: out of date (run: cd website && npm run gen)`);
    else {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, content);
    }
  }
  if (stale.length) {
    for (const s of stale) console.error(s);
    process.exit(1);
  }
  console.log(`gen-reference: ${args.check ? 'up to date' : 'wrote'} ${Object.keys(outputs).length} partial(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
