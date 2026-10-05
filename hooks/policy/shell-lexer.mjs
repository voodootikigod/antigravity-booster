// Conservative POSIX shell lexer for PreToolUse command classification
// (spec §4.5.1 "Normative Shell Command Classification Engine").
//
// It never evaluates anything. It splits a command line into subcommands on
// control operators, tokenises with POSIX quoting, records redirection
// targets, and flags every construct whose effect cannot be known statically
// (expansions, substitutions, globs, subshells, heredocs, comments) as
// `dynamic` so the classifier routes it to Stage 5. Unbalanced quoting makes
// the whole line un-lexable ({ ok: false }), which callers also treat as
// dynamic (Appendix A.4 item 5).

const GLOB_CHARS = new Set(['*', '?', '[']);

function newSubcommand() {
  return { argv: [], redirects: [], dynamic: false, assignments: [] };
}

function newToken() {
  return { value: '', quoted: false, started: false, dynamic: false };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function lexCommandLine(line) {
  if (typeof line !== 'string') return { ok: false, error: 'command line is not a string' };
  const subcommands = [];
  let sub = newSubcommand();
  let tok = newToken();
  let pendingRedirect = null;
  let quote = null; // "'" | '"' | null
  let i = 0;

  const flushToken = () => {
    if (!tok.started) return;
    if (tok.dynamic) sub.dynamic = true;
    if (pendingRedirect) {
      sub.redirects.push({ op: pendingRedirect, target: tok.value, dynamic: tok.dynamic });
      pendingRedirect = null;
    } else if (sub.argv.length === 0 && !tok.quoted && ASSIGNMENT.test(tok.value)) {
      sub.assignments.push(tok.value);
    } else {
      sub.argv.push(tok.value);
    }
    tok = newToken();
  };
  const flushSub = () => {
    flushToken();
    if (pendingRedirect) {
      sub.dynamic = true; // dangling redirection operator
      pendingRedirect = null;
    }
    if (sub.argv.length || sub.redirects.length || sub.assignments.length || sub.dynamic) subcommands.push(sub);
    sub = newSubcommand();
  };
  const add = (ch) => {
    tok.value += ch;
    tok.started = true;
  };

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else add(ch);
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        add(next);
        i += 1;
      } else {
        if (ch === '$' || ch === '`') tok.dynamic = true;
        add(ch);
      }
      i += 1;
      continue;
    }

    // Unquoted context.
    if (ch === "'" || ch === '"') {
      quote = ch;
      tok.quoted = true;
      tok.started = true;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next !== undefined) add(next);
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flushToken();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      flushSub();
      i += 1;
      continue;
    }
    if (ch === '&' && next === '&') {
      flushSub();
      i += 2;
      continue;
    }
    if (ch === '|' && next === '|') {
      flushSub();
      i += 2;
      continue;
    }
    if (ch === '|') {
      flushSub();
      i += 1;
      continue;
    }
    if (ch === '&' && next === '>') {
      flushToken();
      pendingRedirect = line[i + 2] === '>' ? '&>>' : '&>';
      i += pendingRedirect.length;
      continue;
    }
    if (ch === '&') {
      flushSub();
      i += 1;
      continue;
    }
    if (ch === '<' && (next === '(' || next === '<')) {
      sub.dynamic = true; // process substitution or heredoc
      add(ch);
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<' || (/[0-9]/.test(ch) && !tok.started && (next === '>' || next === '<'))) {
      // Optional fd number, then > >> < >& <&
      let j = i;
      let op = '';
      if (/[0-9]/.test(line[j])) op += line[j++];
      op += line[j++];
      if (line[j] === '>' && op.endsWith('>')) op += line[j++];
      if (line[j] === '&') {
        // fd duplication (2>&1): not a file target
        op += line[j++];
        while (/[0-9-]/.test(line[j] ?? '')) j += 1;
        flushToken();
        i = j;
        continue;
      }
      flushToken();
      pendingRedirect = op;
      i = j;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      tok.dynamic = true;
      sub.dynamic = true;
      add(ch);
      i += 1;
      continue;
    }
    if (ch === '#' && !tok.started) {
      sub.dynamic = true; // comment: hides the rest of the line from review
      break;
    }
    if (GLOB_CHARS.has(ch)) {
      tok.dynamic = true;
      add(ch);
      i += 1;
      continue;
    }
    add(ch);
    i += 1;
  }

  if (quote) return { ok: false, error: 'unbalanced quote' };
  flushSub();
  return { ok: true, subcommands };
}
