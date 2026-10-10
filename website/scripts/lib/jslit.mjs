// Static parser for plain JavaScript object/array literals (spec §7: generators read the code,
// never run it). Supports identifier/string keys, single/double/backtick strings without
// interpolation, numbers, true/false/null, nested objects and arrays, comments and trailing
// commas. Anything else (spread, computed keys, identifiers as values, calls, `${}`) throws a
// ParseError carrying the 1-based source line, so callers can print `<file>:<line>: <reason>`.

export class ParseError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

/** Index of the first character after `marker` (a regex) in `src`, or -1. */
export function findLiteralStart(src, marker) {
  const m = marker.exec(src);
  if (!m) return -1;
  const open = src.slice(m.index + m[0].length).search(/[{[]/);
  return open === -1 ? -1 : m.index + m[0].length + open;
}

export function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** Parse the literal starting at `start` (which must be `{` or `[`). Returns { value, end }. */
export function parseLiteral(src, start) {
  let i = start;
  const err = (msg, at = i) => new ParseError(msg, lineOf(src, at));

  function skip() {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) {
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? src.length : nl + 1;
      } else if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) throw err('unterminated comment');
        i = end + 2;
      } else return;
    }
  }

  function str() {
    const q = src[i];
    const at = i;
    i++;
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' };
        if (n === 'u') {
          out += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += map[n] ?? n;
        i += 2;
        continue;
      }
      if (q === '`' && src.startsWith('${', i)) throw err('template interpolation is not a static value');
      if (q !== '`' && src[i] === '\n') throw err('unterminated string', at);
      out += src[i++];
    }
    if (i >= src.length) throw err('unterminated string', at);
    i++;
    return out;
  }

  function value() {
    skip();
    const c = src[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === "'" || c === '"' || c === '`') return str();
    if (src.startsWith('...', i)) throw err('spread element is not statically parseable');
    const num = /^-?\d[\d_]*(\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0].replaceAll('_', ''));
    }
    for (const [word, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (src.startsWith(word, i) && !/[\w$]/.test(src[i + word.length] ?? '')) {
        i += word.length;
        return v;
      }
    }
    throw err(`unsupported value starting with ${JSON.stringify(src.slice(i, i + 12))}`);
  }

  function key() {
    skip();
    const c = src[i];
    if (c === '[') throw err('computed key is not statically parseable');
    if (src.startsWith('...', i)) throw err('spread element is not statically parseable');
    if (c === "'" || c === '"') return str();
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!m) throw err(`unexpected key token ${JSON.stringify(src.slice(i, i + 12))}`);
    i += m[0].length;
    return m[0];
  }

  function obj() {
    i++; // {
    const out = {};
    for (;;) {
      skip();
      if (src[i] === '}') {
        i++;
        return out;
      }
      const at = i;
      const k = key();
      skip();
      if (src[i] !== ':') throw err(`expected ':' after key ${k} (shorthand or method entries are not supported)`);
      i++;
      if (Object.hasOwn(out, k)) throw err(`duplicate key ${k}`, at);
      out[k] = value();
      skip();
      if (src[i] === ',') i++;
      else if (src[i] !== '}') throw err(`expected ',' or '}' after ${k}`);
    }
  }

  function arr() {
    i++; // [
    const out = [];
    for (;;) {
      skip();
      if (src[i] === ']') {
        i++;
        return out;
      }
      out.push(value());
      skip();
      if (src[i] === ',') i++;
      else if (src[i] !== ']') throw err("expected ',' or ']'");
    }
  }

  skip();
  if (src[i] !== '{' && src[i] !== '[') throw err('expected an object or array literal');
  const v = value();
  return { value: v, end: i };
}

/** Line number (1-based) of each top-level key of the object literal at `start`. */
export function topLevelKeyLines(src, start) {
  const lines = {};
  const { value } = parseLiteral(src, start);
  for (const k of Object.keys(value)) {
    const re = new RegExp(`(^|[\\s{,])(['"]?)${k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\2\\s*:`, 'm');
    const m = re.exec(src.slice(start));
    lines[k] = m ? lineOf(src, start + m.index + m[1].length) : lineOf(src, start);
  }
  return lines;
}
