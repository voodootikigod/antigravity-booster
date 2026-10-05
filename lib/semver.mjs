// Zero-dependency semver 2.0.0 helpers.
//
// Accepts ONLY MAJOR.MINOR.PATCH with an optional -prerelease. Build metadata
// (+build) is syntactically validated and then IGNORED, per semver 2.0.0
// (it never affects precedence). Anything else ("1.7", "v1.7.0", "01.7.0",
// empty, non-strings) parses to null. The comparators throw TypeError on
// unparseable input; callers map that to corrupt-manifest.

const NUM = '(0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const BUILD_ID = '[0-9A-Za-z-]+';
const RE = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?$`,
);

export function parse(v) {
  if (typeof v !== 'string') return null;
  const m = RE.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

const isNumeric = (s) => /^\d+$/.test(s);

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Numeric identifiers compared as BigInt-free digit strings (no leading zeros
// are guaranteed by the grammar), so arbitrarily large values stay exact.
function cmpNumericStr(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return cmpNum(a, b);
}

function cmpIdent(a, b) {
  const an = isNumeric(a);
  const bn = isNumeric(b);
  if (an && bn) return cmpNumericStr(a, b);
  if (an) return -1; // numeric < alphanumeric
  if (bn) return 1;
  return cmpNum(a, b); // ASCII order
}

function mustParse(v, label) {
  const p = parse(v);
  if (!p) throw new TypeError(`Invalid semver (${label}): ${JSON.stringify(v)}`);
  return p;
}

export function compare(a, b) {
  const x = mustParse(a, 'a');
  const y = mustParse(b, 'b');
  for (const k of ['major', 'minor', 'patch']) {
    const c = cmpNum(x[k], y[k]);
    if (c) return c;
  }
  const px = x.prerelease;
  const py = y.prerelease;
  if (px.length === 0 && py.length === 0) return 0;
  if (px.length === 0) return 1; // release > prerelease
  if (py.length === 0) return -1;
  const n = Math.min(px.length, py.length);
  for (let i = 0; i < n; i++) {
    const c = cmpIdent(px[i], py[i]);
    if (c) return c;
  }
  return cmpNum(px.length, py.length); // shorter set is lower when prefix-equal
}

export const lt = (a, b) => compare(a, b) < 0;
export const gt = (a, b) => compare(a, b) > 0;
export const eq = (a, b) => compare(a, b) === 0;
export const gte = (a, b) => compare(a, b) >= 0;
