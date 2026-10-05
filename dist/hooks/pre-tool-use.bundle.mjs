import { createRequire as __agbCreateRequire } from 'node:module'; const require = __agbCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/balanced-match/index.js
var require_balanced_match = __commonJS({
  "node_modules/balanced-match/index.js"(exports, module) {
    "use strict";
    module.exports = balanced;
    function balanced(a, b, str) {
      if (a instanceof RegExp) a = maybeMatch(a, str);
      if (b instanceof RegExp) b = maybeMatch(b, str);
      var r = range(a, b, str);
      return r && {
        start: r[0],
        end: r[1],
        pre: str.slice(0, r[0]),
        body: str.slice(r[0] + a.length, r[1]),
        post: str.slice(r[1] + b.length)
      };
    }
    function maybeMatch(reg, str) {
      var m = str.match(reg);
      return m ? m[0] : null;
    }
    balanced.range = range;
    function range(a, b, str) {
      var begs, beg, left, right, result;
      var ai = str.indexOf(a);
      var bi = str.indexOf(b, ai + 1);
      var i = ai;
      if (ai >= 0 && bi > 0) {
        if (a === b) {
          return [ai, bi];
        }
        begs = [];
        left = str.length;
        while (i >= 0 && !result) {
          if (i == ai) {
            begs.push(i);
            ai = str.indexOf(a, i + 1);
          } else if (begs.length == 1) {
            result = [begs.pop(), bi];
          } else {
            beg = begs.pop();
            if (beg < left) {
              left = beg;
              right = bi;
            }
            bi = str.indexOf(b, i + 1);
          }
          i = ai < bi && ai >= 0 ? ai : bi;
        }
        if (begs.length) {
          result = [left, right];
        }
      }
      return result;
    }
  }
});

// node_modules/brace-expansion/index.js
var require_brace_expansion = __commonJS({
  "node_modules/brace-expansion/index.js"(exports, module) {
    var balanced = require_balanced_match();
    module.exports = expandTop;
    var escSlash = "\0SLASH" + Math.random() + "\0";
    var escOpen = "\0OPEN" + Math.random() + "\0";
    var escClose = "\0CLOSE" + Math.random() + "\0";
    var escComma = "\0COMMA" + Math.random() + "\0";
    var escPeriod = "\0PERIOD" + Math.random() + "\0";
    var EXPANSION_MAX = 1e5;
    var EXPANSION_MAX_LENGTH = 4e6;
    var EXPANSION_MAX_DEPTH = 1e3;
    var EXPANSION_MAX_REWRITES = 1e3;
    function numeric(str) {
      return parseInt(str, 10) == str ? parseInt(str, 10) : str.charCodeAt(0);
    }
    function escapeBraces(str) {
      return str.split("\\\\").join(escSlash).split("\\{").join(escOpen).split("\\}").join(escClose).split("\\,").join(escComma).split("\\.").join(escPeriod);
    }
    function unescapeBraces(str) {
      return str.split(escSlash).join("\\").split(escOpen).join("{").split(escClose).join("}").split(escComma).join(",").split(escPeriod).join(".");
    }
    function pushAll(target, items) {
      for (var i = 0; i < items.length; i++) {
        target.push(items[i]);
      }
    }
    function parseCommaParts(str) {
      var parts = [];
      var carry = "";
      for (; ; ) {
        var m = balanced("{", "}", str);
        if (!m) {
          var tail = str.split(",");
          tail[0] = carry + tail[0];
          pushAll(parts, tail);
          return parts;
        }
        var pre = m.pre;
        var body = m.body;
        var post = m.post;
        var p = pre.split(",");
        p[0] = carry + p[0];
        p[p.length - 1] += "{" + body + "}";
        if (!post.length) {
          pushAll(parts, p);
          return parts;
        }
        carry = p.pop();
        pushAll(parts, p);
        str = post;
      }
    }
    function expandTop(str, options) {
      if (!str)
        return [];
      options = options || {};
      var max = options.max == null ? EXPANSION_MAX : options.max;
      var maxLength = options.maxLength == null ? EXPANSION_MAX_LENGTH : options.maxLength;
      var maxDepth = options.maxDepth == null ? EXPANSION_MAX_DEPTH : options.maxDepth;
      var maxRewrites = options.maxRewrites == null ? EXPANSION_MAX_REWRITES : options.maxRewrites;
      if (str.substr(0, 2) === "{}") {
        str = "\\{\\}" + str.substr(2);
      }
      return expand2(escapeBraces(str), max, maxLength, maxDepth, 0, maxRewrites, true).map(unescapeBraces);
    }
    function embrace(str) {
      return "{" + str + "}";
    }
    function isPadded(el) {
      return /^-?0\d/.test(el);
    }
    function lte(i, y) {
      return i <= y;
    }
    function gte(i, y) {
      return i >= y;
    }
    function combine(acc, pre, values, max, maxLength, dropEmpties) {
      var out = [];
      var length = 0;
      for (var a = 0; a < acc.length; a++) {
        for (var v = 0; v < values.length; v++) {
          if (out.length >= max) return out;
          var expansion = acc[a] + pre + values[v];
          if (dropEmpties && !expansion) continue;
          if (length + expansion.length > maxLength) return out;
          out.push(expansion);
          length += expansion.length;
        }
      }
      return out;
    }
    function expandSequence(body, isAlphaSequence, max, maxLength) {
      var n = body.split(/\.\./);
      var N = [];
      if (n[0] === void 0 || n[1] === void 0) {
        return N;
      }
      var x = numeric(n[0]);
      var y = numeric(n[1]);
      var width = Math.max(n[0].length, n[1].length);
      var incr = n.length === 3 && n[2] !== void 0 ? Math.max(Math.abs(numeric(n[2])), 1) : 1;
      var test = lte;
      var reverse = y < x;
      if (reverse) {
        incr *= -1;
        test = gte;
      }
      var pad = n.some(isPadded);
      var length = 0;
      for (var i = x; test(i, y) && N.length < max; i += incr) {
        var c;
        if (isAlphaSequence) {
          c = String.fromCharCode(i);
          if (c === "\\") {
            c = "";
          }
        } else {
          c = String(i);
          if (pad) {
            var need = width - c.length;
            if (need > 0) {
              var z = new Array(need + 1).join("0");
              if (i < 0) {
                c = "-" + z + c.slice(1);
              } else {
                c = z + c;
              }
            }
          }
        }
        if (length + c.length > maxLength) break;
        N.push(c);
        length += c.length;
      }
      return N;
    }
    function expand2(str, max, maxLength, maxDepth, depth, maxRewrites, isTop) {
      if (depth > maxDepth) {
        return [str];
      }
      var acc = [""];
      var rewrites = 0;
      var dropEmpties = false;
      var firstGroup = true;
      for (; ; ) {
        const m = balanced("{", "}", str);
        if (!m) {
          return combine(acc, str, [""], max, maxLength, dropEmpties);
        }
        const pre = m.pre;
        if (/\$$/.test(pre)) {
          acc = combine(
            acc,
            pre + "{" + m.body + "}",
            [""],
            max,
            maxLength,
            dropEmpties && !m.post.length
          );
          firstGroup = false;
          if (!m.post.length) break;
          str = m.post;
          continue;
        }
        var isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
        var isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
        var isSequence = isNumericSequence || isAlphaSequence;
        var isOptions = m.body.indexOf(",") >= 0;
        if (!isSequence && !isOptions) {
          if (rewrites < maxRewrites && m.post.match(/,(?!,).*\}/)) {
            rewrites++;
            str = m.pre + "{" + m.body + escClose + m.post;
            isTop = true;
            continue;
          }
          return combine(
            acc,
            pre + "{" + m.body + "}" + m.post,
            [""],
            max,
            maxLength,
            dropEmpties
          );
        }
        if (firstGroup) {
          dropEmpties = isTop && !isSequence;
          firstGroup = false;
        }
        var values;
        if (isSequence) {
          values = expandSequence(m.body, isAlphaSequence, max, maxLength);
        } else {
          var n = parseCommaParts(m.body);
          if (n.length === 1 && n[0] !== void 0) {
            n = expand2(n[0], max, maxLength, maxDepth, depth + 1, maxRewrites, false).map(embrace);
            if (n.length === 1) {
              acc = combine(
                acc,
                pre + n[0],
                [""],
                max,
                maxLength,
                dropEmpties && !m.post.length
              );
              if (!m.post.length) break;
              str = m.post;
              continue;
            }
          }
          var dropsEmpties = dropEmpties && !m.post.length && !pre;
          for (var d = 0; dropsEmpties && d < acc.length; d++) {
            if (acc[d]) {
              dropsEmpties = false;
            }
          }
          values = [];
          var valuesLength = 0;
          outer: for (var j = 0; j < n.length; j++) {
            var expanded = expand2(n[j], max, maxLength, maxDepth, depth + 1, maxRewrites, false);
            for (var k = 0; k < expanded.length; k++) {
              var v = expanded[k];
              if (dropsEmpties && !v) continue;
              if (values.length >= max || valuesLength + v.length > maxLength) {
                break outer;
              }
              values.push(v);
              valuesLength += v.length;
            }
          }
        }
        acc = combine(acc, pre, values, max, maxLength, dropEmpties && !m.post.length);
        if (!m.post.length) break;
        str = m.post;
      }
      return acc;
    }
  }
});

// hooks/policy/evaluate.mjs
import { realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute5, resolve as resolve8 } from "node:path";

// lib/active-rails.mjs
import { existsSync as existsSync10, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname8, join as join8, resolve as resolve5 } from "node:path";

// node_modules/@adlc/tickets/lib/pointer.mjs
var MAX_POINTER_BYTES = 64 * 1024;
var DEPRECATED_ID_KEYS = Object.freeze(["ticket", "ticketId"]);

// node_modules/@adlc/tickets/lib/constants.mjs
var ACTIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-directory", version: 1 });
var ARCHIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-archive", version: 1 });
var ACTIVE_DIRECTORY = ".adlc/tickets";
var ARCHIVE_DIRECTORY = ".adlc/ticket-archive";
var LEGACY_FILE = ".adlc/tickets.json";
var LEGACY_ARCHIVE_FILE = ".adlc/tickets.archive.json";
var LOCK_DIRECTORY = ".adlc/tickets.lock";
var TRANSACTION_DIRECTORY = ".adlc/ticket-transactions";
var TICKET_HASH_DOMAIN = "adlc:ticket:v1\0";
var STORE_HASH_DOMAIN = "adlc:active-store:v1\0";

// node_modules/@adlc/tickets/lib/errors.mjs
var TicketStoreError = class extends Error {
  constructor(kind, code, message, details) {
    super(message);
    this.name = "TicketStoreError";
    this.kind = kind;
    this.code = code;
    if (details !== void 0) this.details = details;
  }
};
var invalid = (code, message, details) => new TicketStoreError("invalid", code, message, details);
var conflict = (code, message, details) => new TicketStoreError("conflict", code, message, details);
var policy = (code, message, details) => new TicketStoreError("policy", code, message, details);
var operational = (code, message, details) => new TicketStoreError("operational", code, message, details);

// node_modules/@adlc/tickets/lib/canonical.mjs
import { createHash } from "node:crypto";
function compareTicketIds(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return Buffer.compare(a, b);
}
function normalize(value, path2 = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("NON_JSON_VALUE", `${path2} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path2}[${index}]`));
  if (typeof value !== "object") throw invalid("NON_JSON_VALUE", `${path2} contains ${typeof value}`);
  const output = {};
  for (const key of Object.keys(value).sort(compareTicketIds)) {
    const item = value[key];
    if (item === void 0 || typeof item === "function" || typeof item === "symbol") {
      throw invalid("NON_JSON_VALUE", `${path2}.${key} is not JSON`);
    }
    output[key] = normalize(item, `${path2}.${key}`);
  }
  return output;
}
var canonicalJson = (value) => JSON.stringify(normalize(value));
var prettyCanonicalJson = (value) => `${JSON.stringify(normalize(value), null, 2)}
`;
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
var ticketHash = (ticket) => sha256(TICKET_HASH_DOMAIN + canonicalJson(ticket));
function storeHash(tickets) {
  const pairs = tickets.map((ticket) => [ticket.id, ticketHash(ticket)]).sort(([left], [right]) => compareTicketIds(left, right));
  return sha256(STORE_HASH_DOMAIN + canonicalJson(pairs));
}

// node_modules/@adlc/tickets/lib/filename.mjs
function ticketSlug(id) {
  const slug = id.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return slug || "ticket";
}
var ticketFilename = (id) => `${ticketSlug(id)}--${sha256(Buffer.from(id, "utf8"))}.json`;

// node_modules/@adlc/tickets/lib/schema.mjs
function validateTicket(ticket, { archive = false } = {}) {
  const errors = [];
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return ["ticket is not an object"];
  if (typeof ticket.id !== "string" || ticket.id.length === 0) errors.push("missing string id");
  if (typeof ticket.title !== "string" || ticket.title.length === 0) errors.push(`${ticket.id ?? "?"}: missing string title`);
  for (const field of ["scope", "rails"]) {
    if (ticket[field] !== void 0 && (!Array.isArray(ticket[field]) || ticket[field].some((item) => typeof item !== "string"))) {
      errors.push(`${ticket.id ?? "?"}: ${field} must be an array of strings`);
    }
  }
  if (ticket.edges !== void 0) {
    if (!Array.isArray(ticket.edges)) errors.push(`${ticket.id ?? "?"}: edges must be an array`);
    else for (const edge of ticket.edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge) || typeof edge.to !== "string" || edge.to.length === 0) {
        errors.push(`${ticket.id ?? "?"}: edge missing string "to"`);
      }
    }
  }
  if (ticket.duration !== void 0 && (typeof ticket.duration !== "number" || !Number.isFinite(ticket.duration) || ticket.duration <= 0)) {
    errors.push(`${ticket.id ?? "?"}: duration must be a positive number`);
  }
  if (!archive && Object.hasOwn(ticket, "_adlcArchive")) errors.push(`${ticket.id ?? "?"}: _adlcArchive is reserved for archived tickets`);
  if (archive && ticket._adlcArchive !== void 0) {
    const metadata = ticket._adlcArchive;
    if (!metadata || typeof metadata !== "object" || metadata.version !== 1 || typeof metadata.ticketHash !== "string") {
      errors.push(`${ticket.id ?? "?"}: invalid _adlcArchive metadata`);
    }
  }
  return errors;
}
function validateTickets(tickets, { archive = false, validateGraph = !archive } = {}) {
  if (!Array.isArray(tickets)) throw invalid("INVALID_ENVELOPE", "tickets must be an array");
  const errors = [];
  const byId = /* @__PURE__ */ new Map();
  for (const ticket of tickets) {
    errors.push(...validateTicket(ticket, { archive }));
    if (typeof ticket?.id === "string") {
      if (byId.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`);
      byId.set(ticket.id, ticket);
    }
  }
  if (validateGraph) {
    for (const ticket of tickets) {
      for (const edge of Array.isArray(ticket?.edges) ? ticket.edges : []) {
        if (typeof edge?.to === "string" && !byId.has(edge.to)) errors.push(`${ticket.id}: edge to unknown ticket ${edge.to}`);
      }
    }
    const color = /* @__PURE__ */ new Map();
    const visit = (id, stack) => {
      if (color.get(id) === 1) {
        errors.push(`cycle in ticket DAG: ${[...stack, id].join(" -> ")}`);
        return;
      }
      if (color.get(id) === 2) return;
      color.set(id, 1);
      const ticket = byId.get(id);
      for (const edge of Array.isArray(ticket?.edges) ? ticket.edges : []) if (byId.has(edge.to)) visit(edge.to, [...stack, id]);
      color.set(id, 2);
    };
    for (const id of [...byId.keys()].sort(compareTicketIds)) visit(id, []);
  }
  if (errors.length) throw invalid("INVALID_TICKET_STORE", `ticket store validation failed (${errors.length} error(s))`, errors);
  return tickets;
}

// node_modules/@adlc/tickets/lib/help.mjs
var SYNC_CATEGORIES = Object.freeze([
  "feature",
  "bug",
  "bugfix",
  "refactor",
  "docs",
  "chore",
  "test",
  "spec",
  "contract",
  "architecture"
]);
var TICKET_FIELDS = [
  {
    name: "id",
    type: "string",
    required: false,
    summary: "Ticket id. Omit it on create and the store mints a ULID (T-01K...); supply one only to keep an existing T<n> id.",
    schema: { type: "string", minLength: 1 }
  },
  {
    name: "title",
    type: "string",
    required: true,
    summary: "One imperative line naming the work.",
    schema: { type: "string", minLength: 1 }
  },
  {
    name: "body",
    type: "string",
    required: false,
    summary: "The self-contained ticket text: what to build, the acceptance criteria, and the concrete command that verifies each one. A fresh agent sees only this \u2014 never the conversation that produced it. coldstart audits it for gaps.",
    schema: {}
    // unpoliced by validateTicket — see the `schema` note below
  },
  {
    name: "category",
    type: "string",
    required: false,
    // The store accepts any string, so the schema must too — but ticket-sync's
    // rich validator pins an enum, and a category outside it round-trips to a
    // remote provider and then fails closed on the next sync. Name the set here
    // so the choice is made once, at authoring time.
    summary: "Routing hint, not a free-form label. model-router sends contract, spec, and architecture to a frontier model and routes the rest from empirical priors. Keep to the set ticket-sync accepts or a synced ticket cannot converge: feature, bug, bugfix, refactor, docs, chore, test, spec, contract, architecture.",
    schema: {}
    // unpoliced by validateTicket — see the `schema` note below
  },
  {
    name: "duration",
    type: "number > 0",
    required: false,
    summary: "Relative build-time estimate used to order the ticket DAG. Defaults to 1.",
    schema: { type: "number", exclusiveMinimum: 0 }
  },
  {
    name: "budget",
    type: "number > 0",
    required: false,
    // NOT constrained in the schema: the store does not police budget, and
    // model-router ignores a non-positive or non-numeric one rather than
    // rejecting it. Pinning it here would narrow v1 under an unchanged $id and
    // make the published schema reject stores that load fine.
    summary: "Optional token ceiling. model-router and flail-detector honour a positive number and ignore anything else; the store does not validate it. Omit it to take the tier default.",
    schema: {}
  },
  {
    name: "scope",
    type: "string[]",
    required: false,
    summary: "Path globs this ticket may touch, e.g. src/auth/**.",
    schema: { type: "array", items: { type: "string" } }
  },
  {
    name: "rails",
    type: "string[]",
    required: false,
    summary: "Path globs frozen for the duration of the build; rails-guard denies edits to them. Once any ticket declares rails the ticket store itself becomes a frozen trust root, so later ticket writes need ADLC_RAILS_BYPASS=1.",
    schema: { type: "array", items: { type: "string" } }
  },
  {
    name: "completed",
    type: "boolean",
    required: false,
    // Written by planComplete, not by an author — but it lives on a stored
    // ticket, so an update rebuilt from this table without it silently retires
    // the flag and downstream tooling schedules the work again.
    summary: "Lifecycle state, set by `adlc ticket complete` rather than authored by hand. It is part of the stored document, so an update that omits it REMOVES it \u2014 build updates from `show <id> --json`, not from scratch.",
    schema: {}
  },
  {
    name: "edges",
    type: 'array of "to" objects',
    required: false,
    summary: 'Ordering constraints, prerequisite to dependent. An edge with "to": "TX" on THIS ticket means this ticket must complete before TX \u2014 so making this ticket depend on an existing one is an edge added to that existing ticket, never a reversed edge here. An edge may also carry "contract": a path to the interface it guarantees TX can consume, which is what lets the two be built in parallel; ticket-sync recognizes it and nothing else on an edge.',
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["to"],
        properties: {
          to: { type: "string", minLength: 1, description: "Id of the dependent ticket, which must not start before this one completes." },
          // Unconstrained for the same reason as body/category: validateTicket
          // checks only that an edge carries a string `to`.
          contract: { description: "Path to the interface this edge guarantees the dependent ticket can consume." }
        },
        additionalProperties: true
      }
    }
  }
];
var FIELD_INDENT = "  ";
function wrap(text, width, indent) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines;
}
function fieldTable() {
  const width = Math.max(...TICKET_FIELDS.map((field) => field.name.length));
  const body = FIELD_INDENT.repeat(3);
  const lines = [];
  for (const field of TICKET_FIELDS) {
    lines.push(`${FIELD_INDENT}${field.name.padEnd(width)}  ${field.type}${field.required ? " (required)" : ""}`);
    lines.push(...wrap(field.summary, 92 - body.length, body));
  }
  return lines;
}
var INPUT_DOCUMENT = [
  "Input document (--input <path> or - for stdin; see `adlc ticket schema`):",
  "",
  ...fieldTable(),
  "",
  "Unknown fields are preserved as-is; the store never strips them."
];

// node_modules/@adlc/tickets/lib/snapshot.mjs
function deepClone(value) {
  const serialized = JSON.stringify(value, function reject(key, item) {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new TypeError(`deepClone cannot round-trip the non-finite number ${item}`);
    }
    if (Array.isArray(this) && (item === void 0 || typeof item === "function" || typeof item === "symbol")) {
      throw new TypeError(`deepClone cannot round-trip ${String(item)} at array index ${key}`);
    }
    if (Array.isArray(item)) {
      const extra = Reflect.ownKeys(item).filter((key2) => Object.getOwnPropertyDescriptor(item, key2)?.enumerable).filter((key2) => typeof key2 === "symbol" || !(/^(0|[1-9][0-9]*)$/.test(key2) && Number(key2) < 4294967295));
      if (extra.length) {
        throw new TypeError(`deepClone cannot round-trip non-index array key(s): ${extra.map(String).join(", ")}`);
      }
    }
    return item;
  });
  return JSON.parse(serialized);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
var TicketSnapshot = class {
  #byId;
  constructor({ backend, formatVersion, tickets }) {
    this.backend = backend;
    this.formatVersion = formatVersion;
    this.tickets = deepFreeze(deepClone(tickets).sort((left, right) => compareTicketIds(left.id, right.id)));
    this.hash = storeHash(this.tickets);
    this.ticketHashes = deepFreeze(Object.fromEntries(this.tickets.map((ticket) => [ticket.id, ticketHash(ticket)])));
    this.#byId = new Map(this.tickets.map((ticket) => [ticket.id, ticket]));
    Object.freeze(this);
  }
  get(id) {
    return this.#byId.get(id);
  }
  mutableTickets() {
    return deepClone(this.tickets);
  }
};

// node_modules/@adlc/tickets/lib/store.mjs
import { existsSync as existsSync9, lstatSync as lstatSync5, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join7, resolve as resolve4 } from "node:path";

// node_modules/@adlc/tickets/lib/stores/directory.mjs
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
function assertRealDirectory(path2) {
  let stat;
  try {
    stat = lstatSync(path2);
  } catch (error) {
    if (error.code === "ENOENT") throw operational("STORE_NOT_FOUND", `ticket store not found: ${path2}`);
    throw operational("STORE_READ_FAILED", `cannot inspect ${path2}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${path2} must be a real directory`);
  const parent = dirname(path2);
  if (parent !== path2) {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${parent} must be a real directory`);
  }
}
var DirectoryTicketStore = class {
  constructor(path2 = ACTIVE_DIRECTORY, { archive = false } = {}) {
    this.path = path2;
    this.archive = archive;
  }
  exists() {
    return existsSync(this.path);
  }
  load() {
    assertRealDirectory(this.path);
    const expectedManifest = this.archive ? ARCHIVE_MANIFEST : ACTIVE_MANIFEST;
    const entries = readdirSync(this.path, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    if (names.size !== entries.length) throw invalid("CASE_COLLISION", `${this.path} contains case-insensitive name collisions`);
    const manifestEntry = entries.find((entry) => entry.name === ".store.json");
    if (!manifestEntry || !manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw invalid("INVALID_MANIFEST", `${this.path}/.store.json must be a regular file`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(this.path, ".store.json"), "utf8"));
    } catch (error) {
      throw invalid("INVALID_MANIFEST", `invalid store manifest: ${error.message}`);
    }
    if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
      const hint = Number.isInteger(manifest?.version) && manifest.version > 1 ? "upgrade @adlc/tickets to read this store" : "expected format version 1";
      throw invalid("UNSUPPORTED_STORE_FORMAT", `unsupported ticket store manifest (${hint})`, manifest);
    }
    const tickets = [];
    for (const entry of entries) {
      if (entry.name === ".store.json") continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        throw invalid("UNRECOGNIZED_STORE_ENTRY", `unrecognized or unsafe ticket store entry: ${entry.name}`);
      }
      const fullPath = join(this.path, entry.name);
      const stat = lstatSync(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("UNSAFE_SHARD", `${entry.name} must be a regular file`);
      let ticket;
      try {
        ticket = JSON.parse(readFileSync(fullPath, "utf8"));
      } catch (error) {
        throw invalid("INVALID_JSON", `invalid JSON in ${entry.name}: ${error.message}`);
      }
      if (!ticket || typeof ticket !== "object" || Array.isArray(ticket) || typeof ticket.id !== "string") {
        throw invalid("INVALID_SHARD", `${entry.name} must contain one ticket object`);
      }
      const expected = ticketFilename(ticket.id);
      if (entry.name !== expected) throw invalid("FILENAME_MISMATCH", `${entry.name} does not match ticket id ${ticket.id}; expected ${expected}`);
      tickets.push(ticket);
    }
    validateTickets(tickets, { archive: this.archive, validateGraph: !this.archive });
    return new TicketSnapshot({ backend: "directory", formatVersion: 1, tickets });
  }
  resolvedPath() {
    return resolve(this.path);
  }
};

// node_modules/@adlc/tickets/lib/stores/legacy.mjs
import { existsSync as existsSync8, lstatSync as lstatSync4, readFileSync as readFileSync7 } from "node:fs";
import { basename as basename2, dirname as dirname7 } from "node:path";

// node_modules/@adlc/tickets/lib/transaction.mjs
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "node:fs";
import { basename, dirname as dirname6, isAbsolute, join as join6, relative as relative2, resolve as resolve3 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

// node_modules/@adlc/tickets/lib/lock.mjs
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
var sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
function acquireTicketLock(root = ".", {
  retries = 50,
  delayMs = 20,
  command = process.argv.join(" "),
  transactionId = null,
  writeOwner = writeFileSync,
  removeLock = rmSync,
  makeLockDirectory = mkdirSync
} = {}) {
  const path2 = join2(root, LOCK_DIRECTORY);
  if (!isLockMetadata({ version: 1, pid: process.pid, hostname: "", startedAt: "", command, transactionId })) {
    throw invalid(
      "INVALID_LOCK_OPTIONS",
      "acquireTicketLock requires a string command and a string-or-null transactionId; a lock written from other values could not be released by its own owner."
    );
  }
  mkdirSync(dirname2(path2), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let created = false;
    try {
      const metadata = { version: 1, pid: process.pid, hostname: hostname(), startedAt: (/* @__PURE__ */ new Date()).toISOString(), command, transactionId };
      const serialized = `${JSON.stringify(metadata, null, 2)}
`;
      makeLockDirectory(path2);
      created = true;
      writeOwner(join2(path2, "owner.json"), serialized, { flag: "wx" });
      return { path: path2, metadata };
    } catch (error) {
      if (created) {
        try {
          removeLock(path2, { recursive: true, force: true });
        } catch (cleanupError) {
          throw operational(
            "LOCK_STRANDED",
            `could not acquire the ticket lock (${error.message}), and could not remove the partial lock at ${path2} (${cleanupError.message}). Remove that directory to unblock later ticket writers.`
          );
        }
      }
      if (error.code !== "EEXIST") throw operational("LOCK_FAILED", `cannot acquire ticket lock: ${error.message}`);
      if (attempt < retries) sleep(delayMs);
    }
  }
  throw conflict("LOCK_TIMEOUT", `could not acquire ${LOCK_DIRECTORY}; another ticket writer is running`, readTicketLock(root));
}
function isLockMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== 1) return false;
  if (!Number.isInteger(value.pid)) return false;
  if (typeof value.hostname !== "string" || typeof value.startedAt !== "string") return false;
  if (typeof value.command !== "string") return false;
  if (value.transactionId !== null && typeof value.transactionId !== "string") return false;
  return true;
}
function readLockMetadata(path2) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(path2, "utf8"));
  } catch {
    return null;
  }
  return isLockMetadata(parsed) ? parsed : null;
}
function readTicketLock(root = ".") {
  return readLockMetadata(join2(root, LOCK_DIRECTORY, "owner.json"));
}
function releaseTicketLock(lock, { removeLock = rmSync } = {}) {
  if (!lock?.path) return { released: false, reason: "no-lock" };
  if (!existsSync2(lock.path)) return { released: false, reason: "no-lock" };
  const owner = readLockMetadata(join2(lock.path, "owner.json"));
  if (!owner) return { released: false, reason: "unverifiable", code: "LOCK_STRANDED", path: lock.path };
  if (owner.pid !== lock.metadata?.pid || owner.startedAt !== lock.metadata?.startedAt) {
    return { released: false, reason: "not-ours", path: lock.path };
  }
  try {
    removeLock(lock.path, { recursive: true, force: true });
  } catch (cause) {
    return { released: false, reason: "remove-failed", code: "LOCK_STRANDED", path: lock.path, cause };
  }
  return { released: true };
}

// node_modules/@adlc/tickets/lib/evidence.mjs
import { closeSync as closeSync3, existsSync as existsSync5, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync3, readFileSync as readFileSync4, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { createHmac as createHmac2, randomUUID } from "node:crypto";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname5, join as join4 } from "node:path";

// node_modules/@adlc/tickets/lib/durability.mjs
import {
  closeSync,
  copyFileSync,
  existsSync as existsSync3,
  fsyncSync,
  mkdirSync as mkdirSync2,
  openSync,
  renameSync,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname3, resolve as resolve2 } from "node:path";
function fsyncFile(path2) {
  const descriptor = openSync(path2, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function fsyncDirectory(path2) {
  if (process.platform === "win32") return false;
  const descriptor = openSync(path2, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}
function durableMkdir(path2) {
  const missing = [];
  let cursor = resolve2(path2);
  while (!existsSync3(cursor)) {
    missing.push(cursor);
    const parent = dirname3(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync2(path2, { recursive: true });
  if (missing.length === 0) {
    fsyncDirectory(resolve2(path2));
    return;
  }
  for (const directory of missing.reverse()) {
    fsyncDirectory(directory);
    fsyncDirectory(dirname3(directory));
  }
}
function durableWrite(path2, content) {
  const descriptor = openSync(path2, "w");
  try {
    writeFileSync2(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname3(resolve2(path2)));
}
function durableCopy(source, target) {
  copyFileSync(source, target);
  fsyncFile(target);
  fsyncDirectory(dirname3(resolve2(target)));
}
function durableRename(source, target) {
  const sourceParent = dirname3(resolve2(source));
  const targetParent = dirname3(resolve2(target));
  renameSync(source, target);
  fsyncDirectory(targetParent);
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent);
}
function durableRemove(path2, options) {
  const parent = dirname3(resolve2(path2));
  rmSync2(path2, options);
  fsyncDirectory(parent);
}

// node_modules/@adlc/tickets/lib/manifest-segments.mjs
import { existsSync as existsSync4, lstatSync as lstatSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync3, openSync as openSync2, readSync, closeSync as closeSync2, unlinkSync, mkdirSync as mkdirSync3, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname4, join as join3, relative, sep } from "node:path";
var SEGMENT_DIRNAME = "manifest.d";
var SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
var RESERVED_NAMES = /* @__PURE__ */ new Set([".store.json"]);
var MARKER_NAME = ".store.json";
var LINEAGE_NAME = ".lineage";
var MARKER_FORMAT = "adlc-manifest-segments";
var MARKER_VERSION = 1;
var MAX_LOCAL_JSON_BYTES = 4096;
var MAX_LOCK_OWNER_BYTES = 512;
function looksLikeGenuineLedgerLock(path2, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync3(path2, "utf8").trim());
  } catch {
  }
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.startedAt === "string";
}
function segmentDirPath(dir) {
  return join3(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir, name) {
  return join3(segmentDirPath(dir), name);
}
function markerPath(dir) {
  return join3(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir) {
  return join3(segmentDirPath(dir), LINEAGE_NAME);
}
function discoverSegments(dir) {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync2(segDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is a symlink" }] };
  if (!dirStat.isDirectory()) return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is not a directory" }] };
  let names;
  try {
    names = readdirSync2(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: ".", reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  const valid = [];
  const invalid2 = [];
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    let st;
    try {
      st = lstatSync2(join3(segDir, name));
    } catch (err) {
      invalid2.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      invalid2.push({ name, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      invalid2.push({ name, reason: "nested directory" });
      continue;
    }
    if (!st.isFile()) {
      invalid2.push({ name, reason: "not a regular file" });
      continue;
    }
    if (name === LINEAGE_NAME) continue;
    if (name.endsWith(".lock")) {
      if (looksLikeGenuineLedgerLock(join3(segDir, name), st.size)) continue;
      invalid2.push({ name, reason: "lock-suffixed object is not a genuine advisory lock" });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid2.push({ name, reason: "bad filename grammar" });
      continue;
    }
    valid.push(name);
  }
  return { valid, invalid: invalid2 };
}
function readRawLines(filePath) {
  if (!existsSync4(filePath)) return [];
  return readFileSync3(filePath, "utf8").split("\n").filter((line) => line.trim() !== "");
}
function parseLines(lines) {
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}
function entrySigValid(key, entry) {
  if (typeof entry.sig !== "string" || entry.sig.length === 0) return false;
  const expected = createHmac("sha256", key).update(canonicalEntryBytes(entry)).digest("hex");
  const a = Buffer.from(entry.sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function chainIsIntact(lines, key = null) {
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (entry?.prev !== expectedPrev || entry?.seq !== prevSeq + 1) return false;
    if (key !== null) {
      const hasSig = typeof entry?.sig === "string" && entry.sig.length > 0;
      if (hasSig) {
        if (!entrySigValid(key, entry)) return false;
        seenSignedEntry = true;
      } else if (seenSignedEntry) {
        return false;
      }
    }
    prevLine = line;
    prevSeq = entry.seq;
  }
  return true;
}
function forestChainsIntact(dir, { key = null } = {}) {
  if (!chainIsIntact(readRawLines(join3(dir, "manifest.jsonl")), key)) return false;
  const { valid, invalid: invalid2 } = discoverSegments(dir);
  if (invalid2.length > 0) return false;
  return valid.every((name) => chainIsIntact(readRawLines(segmentPath(dir, name)), key));
}
function readForestEntries(dir) {
  const root = parseLines(readRawLines(join3(dir, "manifest.jsonl")));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines(segmentPath(dir, name))));
  return [...root, ...segments];
}
function readBoundedJsonNoFollow(path2) {
  let st;
  try {
    st = lstatSync2(path2);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync2(path2, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync2(fd);
  }
}
function hasActivationMarker(dir) {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir) {
  const raw = readRawLines(join3(dir, "manifest.jsonl"));
  if (raw.length === 0) return false;
  try {
    const last = JSON.parse(raw.at(-1));
    return Boolean(last) && typeof last === "object" && last.gate === "manifest-cutover";
  } catch {
    return false;
  }
}
function isSegmentedRepo(dir) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}
var ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encodeUlidPart(value, width) {
  let remaining = BigInt(value);
  let output = "";
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}
function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281474976710655) throw new RangeError("ULID timestamp out of range");
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError("ULID entropy must be 10 bytes");
  const random = BigInt(`0x${entropy.toString("hex")}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}
function deriveSlug(branchName) {
  const lowered = String(branchName ?? "").toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = substituted.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, "");
  return truncated || "segment";
}
function currentBranch(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" || out === "HEAD" ? null : out;
  } catch {
    return null;
  }
}
function readLineageToken(dir) {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== "object") return null;
  if (typeof token.segment !== "string" || typeof token.ulid !== "string" || typeof token.branch !== "string") return null;
  return token;
}
function isSymlinkOrOtherNonRegular(path2) {
  let st;
  try {
    st = lstatSync2(path2);
  } catch {
    return false;
  }
  return !st.isFile();
}
function writeLineageToken(dir, token) {
  mkdirSync3(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync(p);
  const fd = openSync2(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync3(fd, JSON.stringify(token));
  } finally {
    closeSync2(fd);
  }
}
function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - ".jsonl".length - 26, segmentName.length - ".jsonl".length);
}
function peekOpenSegment(dir, { cwd = dirname4(dir) } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    if (discoverSegments(dir).valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}
var MAX_FIRST_LINE_BYTES = 65536;
var OVERSIZED_FIRST_ENTRY = /* @__PURE__ */ Symbol("oversized-first-entry");
var MALFORMED_FIRST_ENTRY = /* @__PURE__ */ Symbol("malformed-first-entry");
function firstEntryOf(dir, segmentName) {
  let fd;
  try {
    fd = openSync2(segmentPath(dir, segmentName), fsConstants.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === "") return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync2(fd);
  }
}
function recoverOpenSegment(dir, { cwd = dirname4(dir) } = {}) {
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  const branch = currentBranch(cwd);
  if (branch === null) return null;
  const discovered = discoverSegments(dir);
  if (discovered.invalid.length > 0) {
    throw new Error(
      `manifest.d/ contains ${discovered.invalid.length} non-conforming filesystem object(s) (${discovered.invalid.map((i) => i.name).sort().join(", ")}) \u2014 one could be a disguised or tampered segment belonging to this branch, so recovery refuses rather than guess`
    );
  }
  const candidates = [];
  for (const name of discovered.valid) {
    const first = firstEntryOf(dir, name);
    if (first === OVERSIZED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry exceeds the ${MAX_FIRST_LINE_BYTES}-byte bounded-read cap \u2014 its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first === MALFORMED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry could not be read or parsed \u2014 its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first?.branch === branch) candidates.push(name);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous: ${candidates.length} committed segments declare branch "${branch}" as their own (${candidates.sort().join(", ")}) and no local .lineage token disambiguates them \u2014 refusing to guess; run \`adlc gate-manifest adopt\` to see the candidates and choose which lineage this checkout continues`
    );
  }
  return { name: candidates[0], isNew: false };
}
function assertSegmentPathCommittable(dir, name) {
  const probeCwd = dirname4(dir);
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const run = (args) => {
    try {
      execFileSync("git", args, { cwd: probeCwd, env, stdio: "ignore" });
      return 0;
    } catch (err) {
      if (err.code === "ENOENT") return "no-git";
      return err.status ?? "error";
    }
  };
  if (run(["rev-parse", "--is-inside-work-tree"]) !== 0) return;
  const rel = relative(probeCwd, segmentPath(dir, name)).split(sep).join("/");
  const status = run(["check-ignore", "-q", "--", rel]);
  if (status === 0) {
    throw new Error(
      `refusing to mint segment ${name}: .gitignore would ignore its file, so evidence recorded there would exist only in this checkout \u2014 never in CI or any other clone; fix the ignore rules (gate-manifest enable names the required negation lines) and retry`
    );
  }
  if (status !== 1) {
    throw new Error(`git check-ignore failed while probing segment ${name} \u2014 cannot verify the segment is committable, refusing to record evidence blindly`);
  }
}
function resolveOpenSegment(dir, { cwd = dirname4(dir), key = null } = {}) {
  const markerDoc = readBoundedJsonNoFollow(markerPath(dir));
  if (markerDoc && markerDoc.auth === "keyed" && key === null) {
    throw new Error(
      "this forest was activated in keyed mode, but no signing key was provided for this write \u2014 an unsigned entry here would permanently strand every keyed clone of this branch; configure the manifest key"
    );
  }
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  if (key !== null) {
    const recovered = recoverOpenSegment(dir, { cwd });
    if (recovered) {
      const lines = readRawLines(segmentPath(dir, recovered.name));
      let first = null;
      try {
        first = JSON.parse(lines[0]);
      } catch {
      }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first);
      if (!chainIsIntact(lines, key) || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key (broken chain, or its branch-bearing first entry lacks a verified v2 signature) \u2014 refusing to extend it, and refusing to mint a duplicate past it (that would silently fork this branch's lineage)`
        );
      }
      return recovered;
    }
  } else {
    let candidateExists = false;
    try {
      candidateExists = recoverOpenSegment(dir, { cwd }) !== null;
    } catch {
      candidateExists = true;
    }
    if (candidateExists) {
      throw new Error(
        "a committed segment already declares this branch, and with no signing key this writer can neither authenticate and extend it nor safely mint alongside it (a fresh token would shadow the committed evidence from every later read) \u2014 configure the manifest key, or restore the local .lineage token"
      );
    }
  }
  const branch = currentBranch(cwd);
  const rootLines = readRawLines(join3(dir, "manifest.jsonl"));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    let lastEntry = null;
    try {
      lastEntry = JSON.parse(rootLast);
    } catch {
    }
    if (lastEntry) anchor = { segment: "root", seq: lastEntry.seq, lineHash: sha256(rootLast) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? "");
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable(dir, name);
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...branch !== null ? { branch } : {} };
}

// node_modules/@adlc/tickets/lib/key-contract.mjs
function validateKeyParam(key) {
  if (key === null) return null;
  if (typeof key === "string" && key.length > 0) return key;
  throw new TypeError(
    `manifest key parameter must be a non-empty string (a key) or null (explicitly no key); got ${key === "" ? "'' (empty string)" : typeof key}. Resolve the environment in the bin (getKey()) and thread the value down \u2014 library code never reads process.env.`
  );
}

// node_modules/@adlc/tickets/lib/evidence.mjs
var sleep2 = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
function withManifestLock(path2, fn, { retries = 400, delayMs = 5 } = {}) {
  const lockPath = `${path2}.lock`;
  mkdirSync4(dirname5(path2), { recursive: true });
  const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname2(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync3(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt < retries) sleep2(delayMs);
      continue;
    }
    try {
      writeFileSync4(descriptor, `${JSON.stringify(owner)}
`);
      fsyncSync2(descriptor);
    } finally {
      closeSync3(descriptor);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync4(lockPath, "utf8"));
        if (current.token === owner.token) unlinkSync2(lockPath);
      } catch {
      }
    }
  }
  throw conflict("MANIFEST_LOCK_TIMEOUT", `could not acquire manifest lock: ${lockPath}`);
}
function lastLine(content) {
  return content.split("\n").reverse().find((line) => line.trim()) ?? null;
}
function sign(key, entry) {
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return createHmac2("sha256", key).update(JSON.stringify(canonical)).digest("hex");
}
function signV2(key, entry) {
  const { sig: _sig, segment: _segment, ...signed } = entry;
  return createHmac2("sha256", key).update(canonicalJson(signed)).digest("hex");
}
var AUDIT_FIELDS = ["bypass", "op", "ticketId", "storeHashBefore", "storeHashAfter", "ticketIds"];
function auditFieldsMatch(entry, data, acceptLegacyMatch) {
  if (acceptLegacyMatch && AUDIT_FIELDS.every((field) => entry.data?.[field] === void 0)) return true;
  for (const field of AUDIT_FIELDS) {
    if (canonicalJson(entry.data?.[field] ?? null) !== canonicalJson(data[field] ?? null)) return false;
  }
  return true;
}
function findMatchingEvidence(entries, { gate, data, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, transactionId, key = null, acceptLegacyMatch = false }) {
  for (const entry of entries) {
    if (entry?.data?.transactionId === transactionId && entry?.data?.action === action) {
      if (key !== null && !entrySigValid(key, entry)) continue;
      const matches = entry.gate === gate && (entry.ticket ?? null) === ticketId && entry.data.operation === operation && (entry.data.ticketHash ?? null) === ticketHash2 && entry.data.storeHash === storeHash2 && (entry.data.archiveHash ?? null) === archiveHash && entry.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry, data, acceptLegacyMatch);
      if (!matches) throw conflict("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
      return entry;
    }
  }
  return null;
}
function recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch = false }) {
  return withManifestLock(lineagePath(dir), () => {
    if (!forestChainsIntact(dir, { key })) {
      throw conflict("INVALID_MANIFEST", "manifest forest is invalid: a segment or root chain is broken, or an entry is unsigned/forged \u2014 refusing to append or trust the idempotency scan");
    }
    const existing = findMatchingEvidence(readForestEntries(dir), { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch });
    if (existing) return existing;
    const resolved = resolveOpenSegment(dir, { cwd: dirname5(dir), key });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync4(dirname5(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync5(targetPath) ? readFileSync4(targetPath, "utf8") : "";
      const rawLines = content.split("\n").filter((line) => line.trim() !== "");
      if (resolved.isNew && rawLines.length > 0) {
        throw conflict("INVALID_MANIFEST", `segment ${resolved.name} was expected to be new but already has content`);
      }
      if (!resolved.isNew && rawLines.length === 0) {
        throw conflict("INVALID_MANIFEST", `segment ${resolved.name} was expected to already be open with content but is empty or missing`);
      }
      let previous = null;
      for (const line of rawLines) {
        try {
          previous = JSON.parse(line);
        } catch {
          throw conflict("INVALID_MANIFEST", `segment ${resolved.name} contains malformed JSON`);
        }
      }
      const prevRawLine = rawLines.at(-1) ?? null;
      const entry = {
        seq: typeof previous?.seq === "number" ? previous.seq + 1 : 1,
        // `branch` (T-MANIFEST-FOREST, fourth round): the EXACT git branch
        // that minted this segment, alongside `anchor` — the non-lossy
        // identity recoverOpenSegment matches on. Mirrors
        // @adlc/gate-manifest/lib/segment-writer.mjs's identical addition.
        ...resolved.isNew ? { anchor: resolved.anchor, ...resolved.branch !== void 0 ? { branch: resolved.branch } : {} } : {},
        gate,
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        ...ticketId ? { ticket: ticketId } : {},
        data,
        files: {},
        prev: prevRawLine === null ? null : sha256(prevRawLine)
      };
      if (key) {
        if (resolved.isNew) entry.sigVersion = 2;
        entry.sig = entry.sigVersion === 2 ? signV2(key, entry) : sign(key, entry);
      }
      const descriptor = openSync3(targetPath, "a");
      try {
        writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
        fsyncSync2(descriptor);
      } finally {
        closeSync3(descriptor);
      }
      fsyncDirectory(dirname5(targetPath));
      return entry;
    });
  });
}
function recordTicketEvidence(root, {
  key,
  transactionId,
  operation,
  action = "apply",
  ticketId = null,
  ticketHash: ticketHash2 = null,
  storeHash: storeHash2,
  archiveHash = null,
  revision = process.env.ADLC_REVISION ?? null,
  gate = `ticket-${operation}`,
  bypass = false,
  storeHashBefore = null,
  ticketIds = null,
  acceptLegacyMatch = false
} = {}) {
  const signingKey = validateKeyParam(key);
  const dir = join4(root, ".adlc");
  const data = {
    operation,
    action,
    transactionId,
    revision,
    ticketHash: ticketHash2,
    storeHash: storeHash2,
    ...archiveHash ? { archiveHash } : {},
    bindingScope: ticketId ? "ticket" : "store",
    ...bypass ? {
      op: operation,
      ticketId,
      // A write that moves SEVERAL tickets at once (a prune sweep) names them all:
      // store hashes prove that something changed, not what this entry authorized.
      ...ticketIds ? { ticketIds } : {},
      storeHashBefore,
      storeHashAfter: storeHash2,
      bypass: true
    } : {}
  };
  if (isSegmentedRepo(dir)) {
    return recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key: signingKey, acceptLegacyMatch });
  }
  const path2 = join4(root, ".adlc/manifest.jsonl");
  return withManifestLock(path2, () => {
    const content = existsSync5(path2) ? readFileSync4(path2, "utf8") : "";
    const lines = content.split("\n").filter((line) => line.trim());
    if (isSegmentedRepo(dir)) {
      throw conflict("MANIFEST_FROZEN", "manifest chain is frozen; this repo uses .adlc/manifest.d/ \u2014 upgrade adlc if you are seeing this locally");
    }
    for (const line of lines) {
      try {
        const entry2 = JSON.parse(line);
        if (entry2.data?.transactionId === transactionId && entry2.data?.action === action) {
          if (signingKey !== null && !entrySigValid(signingKey, entry2)) continue;
          const matches = entry2.gate === gate && (entry2.ticket ?? null) === ticketId && entry2.data.operation === operation && (entry2.data.ticketHash ?? null) === ticketHash2 && entry2.data.storeHash === storeHash2 && (entry2.data.archiveHash ?? null) === archiveHash && entry2.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry2, data, acceptLegacyMatch);
          if (!matches) throw conflict("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
          return entry2;
        }
      } catch (error) {
        if (error?.code === "EVIDENCE_IDEMPOTENCY_CONFLICT") throw error;
        throw conflict("INVALID_MANIFEST", "cannot append ticket evidence to a malformed manifest");
      }
    }
    if (lines.length === 0) {
      let hasExistingSegments;
      try {
        hasExistingSegments = readForestEntries(dir).length > 0;
      } catch {
        hasExistingSegments = false;
      }
      if (hasExistingSegments) {
        throw conflict("MANIFEST_FROZEN", "refusing to create the root manifest: manifest.d/ already holds segment(s) anchored to nothing (anchor: null), legal only in a rootless forest \u2014 this usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted");
      }
    }
    const previous = lastLine(content);
    const prior = previous ? JSON.parse(previous) : null;
    const entry = {
      seq: typeof prior?.seq === "number" ? prior.seq + 1 : 1,
      gate,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...ticketId ? { ticket: ticketId } : {},
      data,
      files: {},
      prev: previous ? sha256(previous) : null
    };
    if (signingKey) entry.sig = sign(signingKey, entry);
    const descriptor = openSync3(path2, "a");
    try {
      writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
      fsyncSync2(descriptor);
    } finally {
      closeSync3(descriptor);
    }
    fsyncDirectory(dirname5(path2));
    return entry;
  });
}

// node_modules/@adlc/tickets/lib/trust-root.mjs
import { existsSync as existsSync6, lstatSync as lstatSync3, readFileSync as readFileSync5, readdirSync as readdirSync3 } from "node:fs";
import { join as join5 } from "node:path";
var STORE_MARKER = ".store.json";
function assertNotSymlink(path2) {
  let stat;
  try {
    stat = lstatSync3(path2);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw operational("TRUST_ROOT_PATH_UNREADABLE", `cannot determine whether ${path2} holds trust-root evidence: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw invalid("UNSAFE_STORE_PATH", `${path2} must be a real path, not a symlink \u2014 trust-root evidence read through a link is not this repo's own`);
  }
}
function storeDeclaresRails(tickets) {
  if (!Array.isArray(tickets)) return true;
  return tickets.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const rails = item.rails;
    if (rails === void 0) return false;
    if (!Array.isArray(rails)) return true;
    return rails.length > 0;
  });
}
function archiveDeclaresRails(root) {
  const directory = join5(root, ARCHIVE_DIRECTORY);
  const legacy = join5(root, LEGACY_ARCHIVE_FILE);
  assertNotSymlink(directory);
  assertNotSymlink(legacy);
  if (existsSync6(directory)) {
    let entries;
    try {
      entries = readdirSync3(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    let sawMarker = false;
    for (const entry of entries) {
      if (entry.name === STORE_MARKER) {
        try {
          const marker = JSON.parse(readFileSync5(join5(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join5(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync5(join5(directory, entry.name), "utf8"));
      } catch {
        return true;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.id !== "string") return true;
      if (storeDeclaresRails([parsed])) return true;
    }
    if (!sawMarker) return true;
  }
  if (existsSync6(legacy)) {
    try {
      const parsed = JSON.parse(readFileSync5(legacy, "utf8"));
      if (storeDeclaresRails(parsed?.tickets)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function manifestRecordsBypass(root) {
  const rootManifest = join5(root, ".adlc", "manifest.jsonl");
  const segments = join5(root, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync6(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join5(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join5(segments, entry.name));
      }
    } catch {
      return true;
    }
  }
  for (const file of files) {
    if (!existsSync6(file)) continue;
    let text;
    try {
      text = readFileSync5(file, "utf8");
    } catch {
      return true;
    }
    if (!text.includes('"bypass"') && !text.includes("rails-bypass")) continue;
    for (const line of text.split("\n")) {
      if (!line.includes('"bypass"') && !line.includes("rails-bypass")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.data?.bypass === true || entry?.gate === "rails-bypass") return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}
function repoDeclaresRails(root, tickets) {
  assertNotSymlink(join5(root, ".adlc"));
  return storeDeclaresRails(tickets) || archiveDeclaresRails(root) || manifestRecordsBypass(root);
}
function assertWriteIsSignable({ key, allowUnsigned = false } = {}) {
  const resolved = validateKeyParam(key);
  if (resolved !== null || allowUnsigned) return;
  throw policy(
    "MANIFEST_KEY_REQUIRED",
    "this ticket store is a frozen trust root (a ticket declares rails), so mutating it is an audited override \u2014 and ADLC_MANIFEST_KEY is not set, so the audit entry would be written UNSIGNED, proving nothing about who made the change. Refusing before the write: nothing has changed.\n  Set ADLC_MANIFEST_KEY and re-run. It is commonly kept in the MAIN checkout's gitignored .env.local, which is ABSENT from a git worktree \u2014 from a worktree, export it explicitly.\n  To record an UNSIGNED audit entry on purpose, pass --allow-unsigned."
  );
}
function assertSignableTrustRootWrite(tickets, { key, allowUnsigned = false, root = "." } = {}) {
  if (!repoDeclaresRails(root, tickets)) return false;
  assertWriteIsSignable({ key, allowUnsigned });
  return true;
}

// node_modules/@adlc/tickets/lib/transaction.mjs
var fileHash = (path2) => sha256(readFileSync6(path2));
function journalPath(root, path2) {
  const absolute = resolve3(path2);
  const rel = relative2(resolve3(root), absolute);
  return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) ? rel : absolute;
}
function evidenceBinding(before, tickets, ticketId, beforeTicketId = null) {
  const priorId = beforeTicketId ?? ticketId;
  const desired = ticketId ? tickets.find((ticket) => ticket.id === ticketId) : null;
  const logicalTicketHash = desired ? ticketHash(desired) : null;
  return {
    beforeTicketId: priorId,
    beforeTicketHash: priorId ? before.ticketHashes[priorId] ?? (priorId === ticketId ? logicalTicketHash : null) : null,
    afterTicketHash: ticketId ? logicalTicketHash ?? before.ticketHashes[priorId] ?? null : null
  };
}
function transactionChangesAnything(before, tickets, auxiliaryOperations) {
  return storeHash(tickets) !== before.hash || auxiliaryOperations.length > 0;
}
function bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) {
  if (!assertSignableTrustRootWrite(before.tickets, { key, allowUnsigned, root })) return null;
  return { gate: evidenceRequired ? `ticket-${operation}` : "ticket-mutation", storeHashBefore: before.hash };
}
function applyLegacyTransaction(store, tickets, { expectedSnapshotHash, operation = "update", evidenceRequired = false, ticketId = null, beforeTicketId = null, root = ".", faultInjector = null, lock: existingLock = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  validateTickets(tickets);
  const transactionId = randomUUID2();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join6(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) : null;
    const target = resolve3(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join6(transactionRoot, "stage", basename(store.path));
    const backup = join6(transactionRoot, "backup", basename(store.path));
    durableMkdir(dirname6(stage));
    durableMkdir(dirname6(backup));
    durableWrite(stage, prettyCanonicalJson({ tickets }));
    durableCopy(target, backup);
    const afterHash = storeHash(tickets);
    const binding = evidenceBinding(before, tickets, ticketId, beforeTicketId);
    const journal = {
      version: 1,
      id: transactionId,
      operation,
      state: "prepared",
      beforeHash: before.hash,
      afterHash,
      evidenceRequired,
      bypassAudit: bypassAudit !== null,
      ticketId,
      ...binding,
      storePath: recordedTarget,
      operations: [{
        role: "legacy-store",
        action: "write",
        filename: recordedTarget,
        target: recordedTarget,
        stage: relative2(root, stage),
        backup: relative2(root, backup),
        beforeHash: fileHash(backup),
        afterHash: fileHash(stage)
      }]
    };
    durableWrite(join6(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    faultInjector?.("journal-prepared", { transactionId, operations: 1 });
    const temporary = `${target}.txn-${transactionId}`;
    durableCopy(stage, temporary);
    durableRename(temporary, target);
    faultInjector?.("operation-applied:1", { transactionId, operation: journal.operations[0] });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid("TRANSACTION_VERIFY_FAILED", `transaction produced ${after.hash}, expected ${afterHash}`);
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root, {
      key,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}
    });
    journal.state = "complete";
    durableWrite(join6(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync7(join6(transactionRoot, "journal.json")) && existsSync7(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}

// node_modules/@adlc/tickets/lib/stores/legacy.mjs
function repositoryRootFor(path2, explicit) {
  if (explicit !== null && explicit !== void 0) return explicit;
  const parent = dirname7(path2);
  if (basename2(path2) === basename2(LEGACY_FILE) && basename2(parent) === dirname7(LEGACY_FILE)) {
    return dirname7(parent);
  }
  throw invalid(
    "AMBIGUOUS_STORE_ROOT",
    `cannot infer which repository governs ${path2}: it is not the canonical <root>/${LEGACY_FILE} layout, so the trust-root evidence (archive, manifest, recorded overrides) would be read from the wrong directory and a frozen store could be written keylessly. Pass an explicit { root }.`
  );
}
var LegacyTicketStore = class {
  constructor(path2 = LEGACY_FILE) {
    this.path = path2;
  }
  exists() {
    return existsSync8(this.path);
  }
  /**
   * `root` is where the trust-root evidence is read from — the archive, the manifest,
   * and the recorded overrides that decide whether this store is frozen. It is
   * INFERRED only for the canonical `<root>/.adlc/tickets.json` layout, which keeps
   * the 1.x one-argument call working; anywhere else it must be passed, because
   * guessing wrong is not a cosmetic error (see repositoryRootFor).
   */
  write(tickets, { key = null, allowUnsigned = false, root = null } = {}) {
    return applyLegacyTransaction(this, tickets, {
      root: repositoryRootFor(this.path, root),
      operation: "update",
      key,
      allowUnsigned
    });
  }
  load() {
    if (!this.exists()) throw operational("STORE_NOT_FOUND", `tickets file not found: ${this.path}`);
    const stat = lstatSync4(this.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid("UNSAFE_STORE_PATH", `${this.path} must be a regular file`);
    const parentStat = lstatSync4(dirname7(this.path));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${dirname7(this.path)} must be a real directory`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync7(this.path, "utf8"));
    } catch (error) {
      throw invalid("INVALID_JSON", `invalid JSON in ${this.path}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.tickets)) {
      throw invalid("INVALID_ENVELOPE", `${this.path} must contain { "tickets": [...] }`);
    }
    validateTickets(parsed.tickets);
    return new TicketSnapshot({ backend: "legacy", formatVersion: 0, tickets: parsed.tickets });
  }
};

// node_modules/@adlc/tickets/lib/store.mjs
var rooted = (root, path2) => isAbsolute2(path2) ? path2 : join7(root, path2);
function pendingTransactions(root = ".") {
  const path2 = join7(root, TRANSACTION_DIRECTORY);
  if (!existsSync9(path2)) return [];
  const stat = lstatSync5(path2);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("RECOVERY_REQUIRED", `${path2} is not a safe transaction directory`);
  return readdirSync4(path2).filter((entry) => !entry.startsWith(".")).sort();
}
function resolveStoreOverride({ root = ".", ticketStore, legacyTickets, env = process.env } = {}) {
  const modern = ticketStore ?? env.ADLC_TICKET_STORE;
  const legacy = legacyTickets ?? env.ADLC_TICKETS;
  if (modern && legacy && resolve4(rooted(root, modern)) !== resolve4(rooted(root, legacy))) {
    throw conflict("CONFLICTING_STORE_OVERRIDE", "ADLC_TICKET_STORE/--ticket-store conflicts with ADLC_TICKETS/--tickets");
  }
  return modern ?? legacy ?? null;
}
function detectTicketStore(options = {}) {
  const { root = ".", allowRecovery = false } = options;
  if (!allowRecovery) {
    const pending = pendingTransactions(root);
    if (pending.length) throw conflict("RECOVERY_REQUIRED", `unfinished ticket transaction(s): ${pending.join(", ")}`);
  }
  const override = resolveStoreOverride(options);
  if (override) {
    const path2 = rooted(root, override);
    if (path2.endsWith(".json")) return new LegacyTicketStore(path2);
    return new DirectoryTicketStore(path2);
  }
  const legacy = new LegacyTicketStore(join7(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join7(root, ACTIVE_DIRECTORY));
  if (legacy.exists() && directory.exists()) throw conflict("AMBIGUOUS_STORE", "both .adlc/tickets.json and .adlc/tickets/ exist; complete or roll back migration");
  if (directory.exists()) return directory;
  if (legacy.exists()) return legacy;
  throw operational("STORE_NOT_FOUND", `no ticket store found under ${resolve4(root)}`);
}
var loadTicketSnapshot = (options = {}) => detectTicketStore(options).load();

// node_modules/@adlc/tickets/lib/generated-glob-match.mjs
var SLASH = "/".charCodeAt(0);

// node_modules/@adlc/tickets/lib/manifest-rails.mjs
var MANIFEST_BASENAMES = Object.freeze(["package.json", "plugin.json", "marketplace.json"]);

// node_modules/@adlc/tickets/lib/prompt.mjs
import { createInterface } from "node:readline/promises";

// lib/active-rails.mjs
var INACTIVE_STATUSES = /* @__PURE__ */ new Set(["completed", "closed", "archived"]);
function isActiveTicket(ticket) {
  if (!ticket || typeof ticket !== "object") return true;
  if (ticket.completed === true) return false;
  return !INACTIVE_STATUSES.has(ticket.status);
}
function isDirectory(path2) {
  try {
    return statSync(path2).isDirectory();
  } catch {
    return false;
  }
}
function walkUp(start, predicate) {
  let curr = resolve5(start);
  for (; ; ) {
    if (predicate(curr)) return curr;
    const parent = dirname8(curr);
    if (parent === curr) return null;
    curr = parent;
  }
}
function findGitTop(targetPath) {
  return walkUp(targetPath, (dir) => existsSync10(join8(dir, ".git")));
}
function findAdlcRoot(targetPath, { home = homedir() } = {}) {
  const gitTop = findGitTop(targetPath);
  if (gitTop) return isDirectory(join8(gitTop, ".adlc")) ? gitTop : null;
  const homeDir = resolve5(home);
  return walkUp(targetPath, (dir) => dir !== homeDir && dir !== "/" && isDirectory(join8(dir, ".adlc")));
}
function loadSnapshot(repoRoot) {
  try {
    return { ok: true, snapshot: loadTicketSnapshot({ root: repoRoot }) };
  } catch (err) {
    if (err?.code === "STORE_NOT_FOUND") return { ok: true, snapshot: null };
    return { ok: false, error: `${err?.code ?? "ERROR"}: ${err?.message ?? String(err)}` };
  }
}
function unionActiveRails(repoRoot) {
  if (!existsSync10(join8(repoRoot, ".adlc"))) {
    return { ok: true, adlc: false, hasActiveTickets: false, rails: [] };
  }
  const loaded = loadSnapshot(repoRoot);
  if (!loaded.ok) return { ok: false, error: loaded.error, railsPresent: true };
  const active = (loaded.snapshot?.tickets ?? []).filter(isActiveTicket);
  const rails = /* @__PURE__ */ new Set();
  for (const ticket of active) {
    for (const rail of ticket.rails ?? []) {
      if (typeof rail === "string" && rail.length > 0) rails.add(rail);
    }
  }
  return { ok: true, adlc: true, hasActiveTickets: active.length > 0, rails: [...rails].sort() };
}
function resolveTicket(repoRoot, id) {
  const loaded = loadSnapshot(repoRoot);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const ticket = loaded.snapshot?.get(id);
  if (!ticket) return { ok: false, error: `ticket not found: ${id}` };
  return { ok: true, ticket };
}

// hooks/policy/constants.mjs
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "view_file",
  "grep_search",
  "code_search",
  "list_directory",
  "read_url_content",
  "read_browser_page",
  "search_web",
  "list_resources",
  "read_resource",
  "ask_question",
  "view_file_outline",
  "read_terminal",
  "read_notebook",
  "command_status"
]);
var ORCHESTRATION_TOOLS = /* @__PURE__ */ new Set([
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "schedule",
  "send_message"
]);
var BOOSTER_MCP_SERVER = "agb";
var BOOSTER_MCP_TOOLS = /* @__PURE__ */ new Set([
  "agb_plan",
  "agb_run",
  "agb_preflight",
  "agb_status",
  "agb_doctor",
  "agb_review"
]);
var PATH_MUTATING_TOOLS = /* @__PURE__ */ new Set([
  "run_command",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "edit_file",
  "create_file",
  "save_file",
  "delete_file",
  "move",
  "delete_directory",
  "edit_notebook",
  "write_blob"
]);
var READ_TOOL_PATH_SCHEMAS = {
  view_file: ["AbsolutePath", "filePath", "path"],
  view_file_outline: ["AbsolutePath", "filePath", "path"],
  read_notebook: ["AbsolutePath", "notebookPath", "path"],
  read_resource: ["Uri", "uri"],
  read_browser_page: ["Url", "url"],
  read_url_content: ["Url", "url"],
  list_directory: ["DirAbsolutePath", "DirectoryPath", "path", "dir"],
  grep_search: ["SearchPath", "DirectoryPath", "path"],
  code_search: ["SearchPath", "DirectoryPath", "path"],
  file_search: ["SearchPath", "DirectoryPath", "path"]
};
var TOOL_PATH_SCHEMAS = {
  write_to_file: { required: ["TargetFile"] },
  replace_file_content: { required: ["TargetFile"] },
  multi_replace_file_content: { required: ["TargetFile"] },
  edit_file: { required: ["TargetFile"] },
  create_file: { required: ["TargetFile"] },
  save_file: { required: ["TargetFile"] },
  delete_file: { required: ["TargetFile"] },
  move: { required: ["source", "destination"] },
  delete_directory: { required: ["directoryPath"] },
  edit_notebook: { required: ["notebookPath"] },
  write_blob: { required: ["targetPath"] }
};
var EXCLUDED_CONTENT_KEYS = /* @__PURE__ */ new Set([
  "TargetContent",
  "ReplacementContent",
  "CodeContent",
  "Content",
  "Instruction",
  "Description",
  "summary",
  "prompt",
  "code",
  "text",
  "explanation",
  "message",
  "comment",
  "toolAction",
  "toolSummary",
  "WaitMsBeforeAsync"
]);
var IMPLICIT_RAIL_DIRS = [".git", ".adlc/ticket-archive", ".adlc/ticket-transactions", ".adlc/leases"];
var IMPLICIT_RAIL_FILES = [".adlc/config.json", ".adlc/manifest.jsonl", ".adlc/sessions.json"];
var TICKET_STORE_DIR = ".adlc/tickets";
var DESTRUCTIVE_ROOT_VERBS = /* @__PURE__ */ new Set(["rm", "mv"]);
var PURE_READERS = /* @__PURE__ */ new Set(["cat", "head", "tail", "grep", "ls"]);

// hooks/policy/paths.mjs
import { existsSync as existsSync11, realpathSync } from "node:fs";
import { dirname as dirname9, basename as basename3, isAbsolute as isAbsolute3, join as join9, relative as relative3, resolve as resolve6, sep as sep3 } from "node:path";

// node_modules/minimatch/dist/esm/index.js
var import_brace_expansion = __toESM(require_brace_expansion(), 1);

// node_modules/minimatch/dist/esm/assert-valid-pattern.js
var MAX_PATTERN_LENGTH = 1024 * 64;
var assertValidPattern = (pattern) => {
  if (typeof pattern !== "string") {
    throw new TypeError("invalid pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new TypeError("pattern is too long");
  }
};

// node_modules/minimatch/dist/esm/brace-expressions.js
var posixClasses = {
  "[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
  "[:alpha:]": ["\\p{L}\\p{Nl}", true],
  "[:ascii:]": ["\\x00-\\x7f", false],
  "[:blank:]": ["\\p{Zs}\\t", true],
  "[:cntrl:]": ["\\p{Cc}", true],
  "[:digit:]": ["\\p{Nd}", true],
  "[:graph:]": ["\\p{Z}\\p{C}", true, true],
  "[:lower:]": ["\\p{Ll}", true],
  "[:print:]": ["\\p{C}", true],
  "[:punct:]": ["\\p{P}", true],
  "[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
  "[:upper:]": ["\\p{Lu}", true],
  "[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
  "[:xdigit:]": ["A-Fa-f0-9", false]
};
var braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
var regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var rangesToString = (ranges) => ranges.join("");
var parseClass = (glob, position) => {
  const pos = position;
  if (glob.charAt(pos) !== "[") {
    throw new Error("not in a brace expression");
  }
  const ranges = [];
  const negs = [];
  let i = pos + 1;
  let sawStart = false;
  let uflag = false;
  let escaping = false;
  let negate = false;
  let endPos = pos;
  let rangeStart = "";
  WHILE: while (i < glob.length) {
    const c = glob.charAt(i);
    if ((c === "!" || c === "^") && i === pos + 1) {
      negate = true;
      i++;
      continue;
    }
    if (c === "]" && sawStart && !escaping) {
      endPos = i + 1;
      break;
    }
    sawStart = true;
    if (c === "\\") {
      if (!escaping) {
        escaping = true;
        i++;
        continue;
      }
    }
    if (c === "[" && !escaping) {
      for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
        if (glob.startsWith(cls, i)) {
          if (rangeStart) {
            return ["$.", false, glob.length - pos, true];
          }
          i += cls.length;
          if (neg)
            negs.push(unip);
          else
            ranges.push(unip);
          uflag = uflag || u;
          continue WHILE;
        }
      }
    }
    escaping = false;
    if (rangeStart) {
      if (c > rangeStart) {
        ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
      } else if (c === rangeStart) {
        ranges.push(braceEscape(c));
      }
      rangeStart = "";
      i++;
      continue;
    }
    if (glob.startsWith("-]", i + 1)) {
      ranges.push(braceEscape(c + "-"));
      i += 2;
      continue;
    }
    if (glob.startsWith("-", i + 1)) {
      rangeStart = c;
      i += 2;
      continue;
    }
    ranges.push(braceEscape(c));
    i++;
  }
  if (endPos < i) {
    return ["", false, 0, false];
  }
  if (!ranges.length && !negs.length) {
    return ["$.", false, glob.length - pos, true];
  }
  if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) {
    const r = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
    return [regexpEscape(r), false, endPos - pos, false];
  }
  const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
  const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
  const comb = ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs;
  return [comb, uflag, endPos - pos, true];
};

// node_modules/minimatch/dist/esm/unescape.js
var unescape = (s, { windowsPathsNoEscape = false } = {}) => {
  return windowsPathsNoEscape ? s.replace(/\[([^\/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^\/\\])\]/g, "$1$2").replace(/\\([^\/])/g, "$1");
};

// node_modules/minimatch/dist/esm/ast.js
var types = /* @__PURE__ */ new Set(["!", "?", "+", "*", "@"]);
var isExtglobType = (c) => types.has(c);
var startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
var startNoDot = "(?!\\.)";
var addPatternStart = /* @__PURE__ */ new Set(["[", "."]);
var justDots = /* @__PURE__ */ new Set(["..", "."]);
var reSpecials = new Set("().*{}+?[]^$\\!");
var regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var qmark = "[^/]";
var star = qmark + "*?";
var starNoEmpty = qmark + "+?";
var AST = class _AST {
  type;
  #root;
  #hasMagic;
  #uflag = false;
  #parts = [];
  #parent;
  #parentIndex;
  #negs;
  #filledNegs = false;
  #options;
  #toString;
  // set to true if it's an extglob with no children
  // (which really means one child of '')
  #emptyExt = false;
  constructor(type, parent, options = {}) {
    this.type = type;
    if (type)
      this.#hasMagic = true;
    this.#parent = parent;
    this.#root = this.#parent ? this.#parent.#root : this;
    this.#options = this.#root === this ? options : this.#root.#options;
    this.#negs = this.#root === this ? [] : this.#root.#negs;
    if (type === "!" && !this.#root.#filledNegs)
      this.#negs.push(this);
    this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
  }
  get hasMagic() {
    if (this.#hasMagic !== void 0)
      return this.#hasMagic;
    for (const p of this.#parts) {
      if (typeof p === "string")
        continue;
      if (p.type || p.hasMagic)
        return this.#hasMagic = true;
    }
    return this.#hasMagic;
  }
  // reconstructs the pattern
  toString() {
    if (this.#toString !== void 0)
      return this.#toString;
    if (!this.type) {
      return this.#toString = this.#parts.map((p) => String(p)).join("");
    } else {
      return this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
    }
  }
  #fillNegs() {
    if (this !== this.#root)
      throw new Error("should only call on root");
    if (this.#filledNegs)
      return this;
    this.toString();
    this.#filledNegs = true;
    let n;
    while (n = this.#negs.pop()) {
      if (n.type !== "!")
        continue;
      let p = n;
      let pp = p.#parent;
      while (pp) {
        for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) {
          for (const part of n.#parts) {
            if (typeof part === "string") {
              throw new Error("string part in extglob AST??");
            }
            part.copyIn(pp.#parts[i]);
          }
        }
        p = pp;
        pp = p.#parent;
      }
    }
    return this;
  }
  push(...parts) {
    for (const p of parts) {
      if (p === "")
        continue;
      if (typeof p !== "string" && !(p instanceof _AST && p.#parent === this)) {
        throw new Error("invalid part: " + p);
      }
      this.#parts.push(p);
    }
  }
  toJSON() {
    const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
    if (this.isStart() && !this.type)
      ret.unshift([]);
    if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) {
      ret.push({});
    }
    return ret;
  }
  isStart() {
    if (this.#root === this)
      return true;
    if (!this.#parent?.isStart())
      return false;
    if (this.#parentIndex === 0)
      return true;
    const p = this.#parent;
    for (let i = 0; i < this.#parentIndex; i++) {
      const pp = p.#parts[i];
      if (!(pp instanceof _AST && pp.type === "!")) {
        return false;
      }
    }
    return true;
  }
  isEnd() {
    if (this.#root === this)
      return true;
    if (this.#parent?.type === "!")
      return true;
    if (!this.#parent?.isEnd())
      return false;
    if (!this.type)
      return this.#parent?.isEnd();
    const pl = this.#parent ? this.#parent.#parts.length : 0;
    return this.#parentIndex === pl - 1;
  }
  copyIn(part) {
    if (typeof part === "string")
      this.push(part);
    else
      this.push(part.clone(this));
  }
  clone(parent) {
    const c = new _AST(this.type, parent);
    for (const p of this.#parts) {
      c.copyIn(p);
    }
    return c;
  }
  static #parseAST(str, ast, pos, opt) {
    let escaping = false;
    let inBrace = false;
    let braceStart = -1;
    let braceNeg = false;
    if (ast.type === null) {
      let i2 = pos;
      let acc2 = "";
      while (i2 < str.length) {
        const c = str.charAt(i2++);
        if (escaping || c === "\\") {
          escaping = !escaping;
          acc2 += c;
          continue;
        }
        if (inBrace) {
          if (i2 === braceStart + 1) {
            if (c === "^" || c === "!") {
              braceNeg = true;
            }
          } else if (c === "]" && !(i2 === braceStart + 2 && braceNeg)) {
            inBrace = false;
          }
          acc2 += c;
          continue;
        } else if (c === "[") {
          inBrace = true;
          braceStart = i2;
          braceNeg = false;
          acc2 += c;
          continue;
        }
        if (!opt.noext && isExtglobType(c) && str.charAt(i2) === "(") {
          ast.push(acc2);
          acc2 = "";
          const ext2 = new _AST(c, ast);
          i2 = _AST.#parseAST(str, ext2, i2, opt);
          ast.push(ext2);
          continue;
        }
        acc2 += c;
      }
      ast.push(acc2);
      return i2;
    }
    let i = pos + 1;
    let part = new _AST(null, ast);
    const parts = [];
    let acc = "";
    while (i < str.length) {
      const c = str.charAt(i++);
      if (escaping || c === "\\") {
        escaping = !escaping;
        acc += c;
        continue;
      }
      if (inBrace) {
        if (i === braceStart + 1) {
          if (c === "^" || c === "!") {
            braceNeg = true;
          }
        } else if (c === "]" && !(i === braceStart + 2 && braceNeg)) {
          inBrace = false;
        }
        acc += c;
        continue;
      } else if (c === "[") {
        inBrace = true;
        braceStart = i;
        braceNeg = false;
        acc += c;
        continue;
      }
      if (isExtglobType(c) && str.charAt(i) === "(") {
        part.push(acc);
        acc = "";
        const ext2 = new _AST(c, part);
        part.push(ext2);
        i = _AST.#parseAST(str, ext2, i, opt);
        continue;
      }
      if (c === "|") {
        part.push(acc);
        acc = "";
        parts.push(part);
        part = new _AST(null, ast);
        continue;
      }
      if (c === ")") {
        if (acc === "" && ast.#parts.length === 0) {
          ast.#emptyExt = true;
        }
        part.push(acc);
        acc = "";
        ast.push(...parts, part);
        return i;
      }
      acc += c;
    }
    ast.type = null;
    ast.#hasMagic = void 0;
    ast.#parts = [str.substring(pos - 1)];
    return i;
  }
  static fromGlob(pattern, options = {}) {
    const ast = new _AST(null, void 0, options);
    _AST.#parseAST(pattern, ast, 0, options);
    return ast;
  }
  // returns the regular expression if there's magic, or the unescaped
  // string if not.
  toMMPattern() {
    if (this !== this.#root)
      return this.#root.toMMPattern();
    const glob = this.toString();
    const [re, body, hasMagic, uflag] = this.toRegExpSource();
    const anyMagic = hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase();
    if (!anyMagic) {
      return body;
    }
    const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
    return Object.assign(new RegExp(`^${re}$`, flags), {
      _src: re,
      _glob: glob
    });
  }
  get options() {
    return this.#options;
  }
  // returns the string match, the regexp source, whether there's magic
  // in the regexp (so a regular expression is required) and whether or
  // not the uflag is needed for the regular expression (for posix classes)
  // TODO: instead of injecting the start/end at this point, just return
  // the BODY of the regexp, along with the start/end portions suitable
  // for binding the start/end in either a joined full-path makeRe context
  // (where we bind to (^|/), or a standalone matchPart context (where
  // we bind to ^, and not /).  Otherwise slashes get duped!
  //
  // In part-matching mode, the start is:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: ^(?!\.\.?$)
  // - if dots allowed or not possible: ^
  // - if dots possible and not allowed: ^(?!\.)
  // end is:
  // - if not isEnd(): nothing
  // - else: $
  //
  // In full-path matching mode, we put the slash at the START of the
  // pattern, so start is:
  // - if first pattern: same as part-matching mode
  // - if not isStart(): nothing
  // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
  // - if dots allowed or not possible: /
  // - if dots possible and not allowed: /(?!\.)
  // end is:
  // - if last pattern, same as part-matching mode
  // - else nothing
  //
  // Always put the (?:$|/) on negated tails, though, because that has to be
  // there to bind the end of the negated pattern portion, and it's easier to
  // just stick it in now rather than try to inject it later in the middle of
  // the pattern.
  //
  // We can just always return the same end, and leave it up to the caller
  // to know whether it's going to be used joined or in parts.
  // And, if the start is adjusted slightly, can do the same there:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
  // - if dots allowed or not possible: (?:/|^)
  // - if dots possible and not allowed: (?:/|^)(?!\.)
  //
  // But it's better to have a simpler binding without a conditional, for
  // performance, so probably better to return both start options.
  //
  // Then the caller just ignores the end if it's not the first pattern,
  // and the start always gets applied.
  //
  // But that's always going to be $ if it's the ending pattern, or nothing,
  // so the caller can just attach $ at the end of the pattern when building.
  //
  // So the todo is:
  // - better detect what kind of start is needed
  // - return both flavors of starting pattern
  // - attach $ at the end of the pattern when creating the actual RegExp
  //
  // Ah, but wait, no, that all only applies to the root when the first pattern
  // is not an extglob. If the first pattern IS an extglob, then we need all
  // that dot prevention biz to live in the extglob portions, because eg
  // +(*|.x*) can match .xy but not .yx.
  //
  // So, return the two flavors if it's #root and the first child is not an
  // AST, otherwise leave it to the child AST to handle it, and there,
  // use the (?:^|/) style of start binding.
  //
  // Even simplified further:
  // - Since the start for a join is eg /(?!\.) and the start for a part
  // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
  // or start or whatever) and prepend ^ or / at the Regexp construction.
  toRegExpSource(allowDot) {
    const dot = allowDot ?? !!this.#options.dot;
    if (this.#root === this)
      this.#fillNegs();
    if (!this.type) {
      const noEmpty = this.isStart() && this.isEnd();
      const src = this.#parts.map((p) => {
        const [re, _, hasMagic, uflag] = typeof p === "string" ? _AST.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
        this.#hasMagic = this.#hasMagic || hasMagic;
        this.#uflag = this.#uflag || uflag;
        return re;
      }).join("");
      let start2 = "";
      if (this.isStart()) {
        if (typeof this.#parts[0] === "string") {
          const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
          if (!dotTravAllowed) {
            const aps = addPatternStart;
            const needNoTrav = (
              // dots are allowed, and the pattern starts with [ or .
              dot && aps.has(src.charAt(0)) || // the pattern starts with \., and then [ or .
              src.startsWith("\\.") && aps.has(src.charAt(2)) || // the pattern starts with \.\., and then [ or .
              src.startsWith("\\.\\.") && aps.has(src.charAt(4))
            );
            const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
            start2 = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
          }
        }
      }
      let end = "";
      if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") {
        end = "(?:$|\\/)";
      }
      const final2 = start2 + src + end;
      return [
        final2,
        unescape(src),
        this.#hasMagic = !!this.#hasMagic,
        this.#uflag
      ];
    }
    const repeated = this.type === "*" || this.type === "+";
    const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
    let body = this.#partsToRegExp(dot);
    if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
      const s = this.toString();
      this.#parts = [s];
      this.type = null;
      this.#hasMagic = void 0;
      return [s, unescape(this.toString()), false, false];
    }
    let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ? "" : this.#partsToRegExp(true);
    if (bodyDotAllowed === body) {
      bodyDotAllowed = "";
    }
    if (bodyDotAllowed) {
      body = `(?:${body})(?:${bodyDotAllowed})*?`;
    }
    let final = "";
    if (this.type === "!" && this.#emptyExt) {
      final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
    } else {
      const close = this.type === "!" ? (
        // !() must match something,but !(x) can match ''
        "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + star + ")"
      ) : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
      final = start + body + close;
    }
    return [
      final,
      unescape(body),
      this.#hasMagic = !!this.#hasMagic,
      this.#uflag
    ];
  }
  #partsToRegExp(dot) {
    return this.#parts.map((p) => {
      if (typeof p === "string") {
        throw new Error("string type in extglob ast??");
      }
      const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
      this.#uflag = this.#uflag || uflag;
      return re;
    }).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
  }
  static #parseGlob(glob, hasMagic, noEmpty = false) {
    let escaping = false;
    let re = "";
    let uflag = false;
    for (let i = 0; i < glob.length; i++) {
      const c = glob.charAt(i);
      if (escaping) {
        escaping = false;
        re += (reSpecials.has(c) ? "\\" : "") + c;
        continue;
      }
      if (c === "\\") {
        if (i === glob.length - 1) {
          re += "\\\\";
        } else {
          escaping = true;
        }
        continue;
      }
      if (c === "[") {
        const [src, needUflag, consumed, magic] = parseClass(glob, i);
        if (consumed) {
          re += src;
          uflag = uflag || needUflag;
          i += consumed - 1;
          hasMagic = hasMagic || magic;
          continue;
        }
      }
      if (c === "*") {
        if (noEmpty && glob === "*")
          re += starNoEmpty;
        else
          re += star;
        hasMagic = true;
        continue;
      }
      if (c === "?") {
        re += qmark;
        hasMagic = true;
        continue;
      }
      re += regExpEscape(c);
    }
    return [re, unescape(glob), !!hasMagic, uflag];
  }
};

// node_modules/minimatch/dist/esm/escape.js
var escape = (s, { windowsPathsNoEscape = false } = {}) => {
  return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};

// node_modules/minimatch/dist/esm/index.js
var minimatch = (p, pattern, options = {}) => {
  assertValidPattern(pattern);
  if (!options.nocomment && pattern.charAt(0) === "#") {
    return false;
  }
  return new Minimatch(pattern, options).match(p);
};
var starDotExtRE = /^\*+([^+@!?\*\[\(]*)$/;
var starDotExtTest = (ext2) => (f) => !f.startsWith(".") && f.endsWith(ext2);
var starDotExtTestDot = (ext2) => (f) => f.endsWith(ext2);
var starDotExtTestNocase = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f) => !f.startsWith(".") && f.toLowerCase().endsWith(ext2);
};
var starDotExtTestNocaseDot = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f) => f.toLowerCase().endsWith(ext2);
};
var starDotStarRE = /^\*+\.\*+$/;
var starDotStarTest = (f) => !f.startsWith(".") && f.includes(".");
var starDotStarTestDot = (f) => f !== "." && f !== ".." && f.includes(".");
var dotStarRE = /^\.\*+$/;
var dotStarTest = (f) => f !== "." && f !== ".." && f.startsWith(".");
var starRE = /^\*+$/;
var starTest = (f) => f.length !== 0 && !f.startsWith(".");
var starTestDot = (f) => f.length !== 0 && f !== "." && f !== "..";
var qmarksRE = /^\?+([^+@!?\*\[\(]*)?$/;
var qmarksTestNocase = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext2);
};
var qmarksTestNocaseDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext2);
};
var qmarksTestDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  return !ext2 ? noext : (f) => noext(f) && f.endsWith(ext2);
};
var qmarksTest = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  return !ext2 ? noext : (f) => noext(f) && f.endsWith(ext2);
};
var qmarksTestNoExt = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && !f.startsWith(".");
};
var qmarksTestNoExtDot = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && f !== "." && f !== "..";
};
var defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
var path = {
  win32: { sep: "\\" },
  posix: { sep: "/" }
};
var sep2 = defaultPlatform === "win32" ? path.win32.sep : path.posix.sep;
minimatch.sep = sep2;
var GLOBSTAR = /* @__PURE__ */ Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
var qmark2 = "[^/]";
var star2 = qmark2 + "*?";
var twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
var twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
var filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
var ext = (a, b = {}) => Object.assign({}, a, b);
var defaults = (def) => {
  if (!def || typeof def !== "object" || !Object.keys(def).length) {
    return minimatch;
  }
  const orig = minimatch;
  const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
  return Object.assign(m, {
    Minimatch: class Minimatch extends orig.Minimatch {
      constructor(pattern, options = {}) {
        super(pattern, ext(def, options));
      }
      static defaults(options) {
        return orig.defaults(ext(def, options)).Minimatch;
      }
    },
    AST: class AST extends orig.AST {
      /* c8 ignore start */
      constructor(type, parent, options = {}) {
        super(type, parent, ext(def, options));
      }
      /* c8 ignore stop */
      static fromGlob(pattern, options = {}) {
        return orig.AST.fromGlob(pattern, ext(def, options));
      }
    },
    unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
    escape: (s, options = {}) => orig.escape(s, ext(def, options)),
    filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
    defaults: (options) => orig.defaults(ext(def, options)),
    makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
    braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
    match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
    sep: orig.sep,
    GLOBSTAR
  });
};
minimatch.defaults = defaults;
var braceExpand = (pattern, options = {}) => {
  assertValidPattern(pattern);
  if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
    return [pattern];
  }
  return (0, import_brace_expansion.default)(pattern);
};
minimatch.braceExpand = braceExpand;
var makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
var match = (list, pattern, options = {}) => {
  const mm = new Minimatch(pattern, options);
  list = list.filter((f) => mm.match(f));
  if (mm.options.nonull && !list.length) {
    list.push(pattern);
  }
  return list;
};
minimatch.match = match;
var globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
var regExpEscape2 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var Minimatch = class {
  options;
  set;
  pattern;
  windowsPathsNoEscape;
  nonegate;
  negate;
  comment;
  empty;
  preserveMultipleSlashes;
  partial;
  globSet;
  globParts;
  nocase;
  isWindows;
  platform;
  windowsNoMagicRoot;
  regexp;
  constructor(pattern, options = {}) {
    assertValidPattern(pattern);
    options = options || {};
    this.options = options;
    this.pattern = pattern;
    this.platform = options.platform || defaultPlatform;
    this.isWindows = this.platform === "win32";
    this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options.allowWindowsEscape === false;
    if (this.windowsPathsNoEscape) {
      this.pattern = this.pattern.replace(/\\/g, "/");
    }
    this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
    this.regexp = null;
    this.negate = false;
    this.nonegate = !!options.nonegate;
    this.comment = false;
    this.empty = false;
    this.partial = !!options.partial;
    this.nocase = !!this.options.nocase;
    this.windowsNoMagicRoot = options.windowsNoMagicRoot !== void 0 ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
    this.globSet = [];
    this.globParts = [];
    this.set = [];
    this.make();
  }
  hasMagic() {
    if (this.options.magicalBraces && this.set.length > 1) {
      return true;
    }
    for (const pattern of this.set) {
      for (const part of pattern) {
        if (typeof part !== "string")
          return true;
      }
    }
    return false;
  }
  debug(..._) {
  }
  make() {
    const pattern = this.pattern;
    const options = this.options;
    if (!options.nocomment && pattern.charAt(0) === "#") {
      this.comment = true;
      return;
    }
    if (!pattern) {
      this.empty = true;
      return;
    }
    this.parseNegate();
    this.globSet = [...new Set(this.braceExpand())];
    if (options.debug) {
      this.debug = (...args) => console.error(...args);
    }
    this.debug(this.pattern, this.globSet);
    const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
    this.globParts = this.preprocess(rawGlobParts);
    this.debug(this.pattern, this.globParts);
    let set = this.globParts.map((s, _, __) => {
      if (this.isWindows && this.windowsNoMagicRoot) {
        const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
        const isDrive = /^[a-z]:/i.test(s[0]);
        if (isUNC) {
          return [...s.slice(0, 4), ...s.slice(4).map((ss) => this.parse(ss))];
        } else if (isDrive) {
          return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
        }
      }
      return s.map((ss) => this.parse(ss));
    });
    this.debug(this.pattern, set);
    this.set = set.filter((s) => s.indexOf(false) === -1);
    if (this.isWindows) {
      for (let i = 0; i < this.set.length; i++) {
        const p = this.set[i];
        if (p[0] === "" && p[1] === "" && this.globParts[i][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) {
          p[2] = "?";
        }
      }
    }
    this.debug(this.pattern, this.set);
  }
  // various transforms to equivalent pattern sets that are
  // faster to process in a filesystem walk.  The goal is to
  // eliminate what we can, and push all ** patterns as far
  // to the right as possible, even if it increases the number
  // of patterns that we have to process.
  preprocess(globParts) {
    if (this.options.noglobstar) {
      for (let i = 0; i < globParts.length; i++) {
        for (let j = 0; j < globParts[i].length; j++) {
          if (globParts[i][j] === "**") {
            globParts[i][j] = "*";
          }
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      globParts = this.firstPhasePreProcess(globParts);
      globParts = this.secondPhasePreProcess(globParts);
    } else if (optimizationLevel >= 1) {
      globParts = this.levelOneOptimize(globParts);
    } else {
      globParts = this.adjascentGlobstarOptimize(globParts);
    }
    return globParts;
  }
  // just get rid of adjascent ** portions
  adjascentGlobstarOptimize(globParts) {
    return globParts.map((parts) => {
      let gs = -1;
      while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
        let i = gs;
        while (parts[i + 1] === "**") {
          i++;
        }
        if (i !== gs) {
          parts.splice(gs, i - gs);
        }
      }
      return parts;
    });
  }
  // get rid of adjascent ** and resolve .. portions
  levelOneOptimize(globParts) {
    return globParts.map((parts) => {
      parts = parts.reduce((set, part) => {
        const prev = set[set.length - 1];
        if (part === "**" && prev === "**") {
          return set;
        }
        if (part === "..") {
          if (prev && prev !== ".." && prev !== "." && prev !== "**") {
            set.pop();
            return set;
          }
        }
        set.push(part);
        return set;
      }, []);
      return parts.length === 0 ? [""] : parts;
    });
  }
  levelTwoFileOptimize(parts) {
    if (!Array.isArray(parts)) {
      parts = this.slashSplit(parts);
    }
    let didSomething = false;
    do {
      didSomething = false;
      if (!this.preserveMultipleSlashes) {
        for (let i = 1; i < parts.length - 1; i++) {
          const p = parts[i];
          if (i === 1 && p === "" && parts[0] === "")
            continue;
          if (p === "." || p === "") {
            didSomething = true;
            parts.splice(i, 1);
            i--;
          }
        }
        if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
          didSomething = true;
          parts.pop();
        }
      }
      let dd = 0;
      while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
        const p = parts[dd - 1];
        if (p && p !== "." && p !== ".." && p !== "**") {
          didSomething = true;
          parts.splice(dd - 1, 2);
          dd -= 2;
        }
      }
    } while (didSomething);
    return parts.length === 0 ? [""] : parts;
  }
  // First phase: single-pattern processing
  // <pre> is 1 or more portions
  // <rest> is 1 or more portions
  // <p> is any portion other than ., .., '', or **
  // <e> is . or ''
  //
  // **/.. is *brutal* for filesystem walking performance, because
  // it effectively resets the recursive walk each time it occurs,
  // and ** cannot be reduced out by a .. pattern part like a regexp
  // or most strings (other than .., ., and '') can be.
  //
  // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
  // <pre>/<e>/<rest> -> <pre>/<rest>
  // <pre>/<p>/../<rest> -> <pre>/<rest>
  // **/**/<rest> -> **/<rest>
  //
  // **/*/<rest> -> */**/<rest> <== not valid because ** doesn't follow
  // this WOULD be allowed if ** did follow symlinks, or * didn't
  firstPhasePreProcess(globParts) {
    let didSomething = false;
    do {
      didSomething = false;
      for (let parts of globParts) {
        let gs = -1;
        while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
          let gss = gs;
          while (parts[gss + 1] === "**") {
            gss++;
          }
          if (gss > gs) {
            parts.splice(gs + 1, gss - gs);
          }
          let next = parts[gs + 1];
          const p = parts[gs + 2];
          const p2 = parts[gs + 3];
          if (next !== "..")
            continue;
          if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") {
            continue;
          }
          didSomething = true;
          parts.splice(gs, 1);
          const other = parts.slice(0);
          other[gs] = "**";
          globParts.push(other);
          gs--;
        }
        if (!this.preserveMultipleSlashes) {
          for (let i = 1; i < parts.length - 1; i++) {
            const p = parts[i];
            if (i === 1 && p === "" && parts[0] === "")
              continue;
            if (p === "." || p === "") {
              didSomething = true;
              parts.splice(i, 1);
              i--;
            }
          }
          if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
            didSomething = true;
            parts.pop();
          }
        }
        let dd = 0;
        while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
          const p = parts[dd - 1];
          if (p && p !== "." && p !== ".." && p !== "**") {
            didSomething = true;
            const needDot = dd === 1 && parts[dd + 1] === "**";
            const splin = needDot ? ["."] : [];
            parts.splice(dd - 1, 2, ...splin);
            if (parts.length === 0)
              parts.push("");
            dd -= 2;
          }
        }
      }
    } while (didSomething);
    return globParts;
  }
  // second phase: multi-pattern dedupes
  // {<pre>/*/<rest>,<pre>/<p>/<rest>} -> <pre>/*/<rest>
  // {<pre>/<rest>,<pre>/<rest>} -> <pre>/<rest>
  // {<pre>/**/<rest>,<pre>/<rest>} -> <pre>/**/<rest>
  //
  // {<pre>/**/<rest>,<pre>/**/<p>/<rest>} -> <pre>/**/<rest>
  // ^-- not valid because ** doens't follow symlinks
  secondPhasePreProcess(globParts) {
    for (let i = 0; i < globParts.length - 1; i++) {
      for (let j = i + 1; j < globParts.length; j++) {
        const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
        if (matched) {
          globParts[i] = [];
          globParts[j] = matched;
          break;
        }
      }
    }
    return globParts.filter((gs) => gs.length);
  }
  partsMatch(a, b, emptyGSMatch = false) {
    let ai = 0;
    let bi = 0;
    let result = [];
    let which = "";
    while (ai < a.length && bi < b.length) {
      if (a[ai] === b[bi]) {
        result.push(which === "b" ? b[bi] : a[ai]);
        ai++;
        bi++;
      } else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
        result.push(a[ai]);
        ai++;
      } else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
        result.push(b[bi]);
        bi++;
      } else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
        if (which === "b")
          return false;
        which = "a";
        result.push(a[ai]);
        ai++;
        bi++;
      } else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
        if (which === "a")
          return false;
        which = "b";
        result.push(b[bi]);
        ai++;
        bi++;
      } else {
        return false;
      }
    }
    return a.length === b.length && result;
  }
  parseNegate() {
    if (this.nonegate)
      return;
    const pattern = this.pattern;
    let negate = false;
    let negateOffset = 0;
    for (let i = 0; i < pattern.length && pattern.charAt(i) === "!"; i++) {
      negate = !negate;
      negateOffset++;
    }
    if (negateOffset)
      this.pattern = pattern.slice(negateOffset);
    this.negate = negate;
  }
  // set partial to true to test if, for example,
  // "/a/b" matches the start of "/*/b/*/d"
  // Partial means, if you run out of file before you run
  // out of pattern, then that's fine, as long as all
  // the parts match.
  matchOne(file, pattern, partial = false) {
    const options = this.options;
    if (this.isWindows) {
      const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
      const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
      const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
      const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
      const fdi = fileUNC ? 3 : fileDrive ? 0 : void 0;
      const pdi = patternUNC ? 3 : patternDrive ? 0 : void 0;
      if (typeof fdi === "number" && typeof pdi === "number") {
        const [fd, pd] = [file[fdi], pattern[pdi]];
        if (fd.toLowerCase() === pd.toLowerCase()) {
          pattern[pdi] = fd;
          if (pdi > fdi) {
            pattern = pattern.slice(pdi);
          } else if (fdi > pdi) {
            file = file.slice(fdi);
          }
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      file = this.levelTwoFileOptimize(file);
    }
    this.debug("matchOne", this, { file, pattern });
    this.debug("matchOne", file.length, pattern.length);
    for (var fi = 0, pi = 0, fl = file.length, pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
      this.debug("matchOne loop");
      var p = pattern[pi];
      var f = file[fi];
      this.debug(pattern, p, f);
      if (p === false) {
        return false;
      }
      if (p === GLOBSTAR) {
        this.debug("GLOBSTAR", [pattern, p, f]);
        var fr = fi;
        var pr = pi + 1;
        if (pr === pl) {
          this.debug("** at the end");
          for (; fi < fl; fi++) {
            if (file[fi] === "." || file[fi] === ".." || !options.dot && file[fi].charAt(0) === ".")
              return false;
          }
          return true;
        }
        while (fr < fl) {
          var swallowee = file[fr];
          this.debug("\nglobstar while", file, fr, pattern, pr, swallowee);
          if (this.matchOne(file.slice(fr), pattern.slice(pr), partial)) {
            this.debug("globstar found match!", fr, fl, swallowee);
            return true;
          } else {
            if (swallowee === "." || swallowee === ".." || !options.dot && swallowee.charAt(0) === ".") {
              this.debug("dot detected!", file, fr, pattern, pr);
              break;
            }
            this.debug("globstar swallow a segment, and continue");
            fr++;
          }
        }
        if (partial) {
          this.debug("\n>>> no match, partial?", file, fr, pattern, pr);
          if (fr === fl) {
            return true;
          }
        }
        return false;
      }
      let hit;
      if (typeof p === "string") {
        hit = f === p;
        this.debug("string match", p, f, hit);
      } else {
        hit = p.test(f);
        this.debug("pattern match", p, f, hit);
      }
      if (!hit)
        return false;
    }
    if (fi === fl && pi === pl) {
      return true;
    } else if (fi === fl) {
      return partial;
    } else if (pi === pl) {
      return fi === fl - 1 && file[fi] === "";
    } else {
      throw new Error("wtf?");
    }
  }
  braceExpand() {
    return braceExpand(this.pattern, this.options);
  }
  parse(pattern) {
    assertValidPattern(pattern);
    const options = this.options;
    if (pattern === "**")
      return GLOBSTAR;
    if (pattern === "")
      return "";
    let m;
    let fastTest = null;
    if (m = pattern.match(starRE)) {
      fastTest = options.dot ? starTestDot : starTest;
    } else if (m = pattern.match(starDotExtRE)) {
      fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m[1]);
    } else if (m = pattern.match(qmarksRE)) {
      fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m);
    } else if (m = pattern.match(starDotStarRE)) {
      fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
    } else if (m = pattern.match(dotStarRE)) {
      fastTest = dotStarTest;
    }
    const re = AST.fromGlob(pattern, this.options).toMMPattern();
    if (fastTest && typeof re === "object") {
      Reflect.defineProperty(re, "test", { value: fastTest });
    }
    return re;
  }
  makeRe() {
    if (this.regexp || this.regexp === false)
      return this.regexp;
    const set = this.set;
    if (!set.length) {
      this.regexp = false;
      return this.regexp;
    }
    const options = this.options;
    const twoStar = options.noglobstar ? star2 : options.dot ? twoStarDot : twoStarNoDot;
    const flags = new Set(options.nocase ? ["i"] : []);
    let re = set.map((pattern) => {
      const pp = pattern.map((p) => {
        if (p instanceof RegExp) {
          for (const f of p.flags.split(""))
            flags.add(f);
        }
        return typeof p === "string" ? regExpEscape2(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
      });
      pp.forEach((p, i) => {
        const next = pp[i + 1];
        const prev = pp[i - 1];
        if (p !== GLOBSTAR || prev === GLOBSTAR) {
          return;
        }
        if (prev === void 0) {
          if (next !== void 0 && next !== GLOBSTAR) {
            pp[i + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
          } else {
            pp[i] = twoStar;
          }
        } else if (next === void 0) {
          pp[i - 1] = prev + "(?:\\/|" + twoStar + ")?";
        } else if (next !== GLOBSTAR) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
          pp[i + 1] = GLOBSTAR;
        }
      });
      return pp.filter((p) => p !== GLOBSTAR).join("/");
    }).join("|");
    const [open, close] = set.length > 1 ? ["(?:", ")"] : ["", ""];
    re = "^" + open + re + close + "$";
    if (this.negate)
      re = "^(?!" + re + ").+$";
    try {
      this.regexp = new RegExp(re, [...flags].join(""));
    } catch (ex) {
      this.regexp = false;
    }
    return this.regexp;
  }
  slashSplit(p) {
    if (this.preserveMultipleSlashes) {
      return p.split("/");
    } else if (this.isWindows && /^\/\/[^\/]+/.test(p)) {
      return ["", ...p.split(/\/+/)];
    } else {
      return p.split(/\/+/);
    }
  }
  match(f, partial = this.partial) {
    this.debug("match", f, this.pattern);
    if (this.comment) {
      return false;
    }
    if (this.empty) {
      return f === "";
    }
    if (f === "/" && partial) {
      return true;
    }
    const options = this.options;
    if (this.isWindows) {
      f = f.split("\\").join("/");
    }
    const ff = this.slashSplit(f);
    this.debug(this.pattern, "split", ff);
    const set = this.set;
    this.debug(this.pattern, "set", set);
    let filename = ff[ff.length - 1];
    if (!filename) {
      for (let i = ff.length - 2; !filename && i >= 0; i--) {
        filename = ff[i];
      }
    }
    for (let i = 0; i < set.length; i++) {
      const pattern = set[i];
      let file = ff;
      if (options.matchBase && pattern.length === 1) {
        file = [filename];
      }
      const hit = this.matchOne(file, pattern, partial);
      if (hit) {
        if (options.flipNegate) {
          return true;
        }
        return !this.negate;
      }
    }
    if (options.flipNegate) {
      return false;
    }
    return this.negate;
  }
  static defaults(def) {
    return minimatch.defaults(def).Minimatch;
  }
};
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;

// hooks/policy/paths.mjs
var HOME_PREFIX = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
function expandHome(token, home) {
  return token.replace(HOME_PREFIX, home);
}
function hasHomePrefix(token) {
  return HOME_PREFIX.test(token);
}
function resolveSafeTarget(absPath) {
  let curr = resolve6(absPath);
  const missing = [];
  while (!existsSync11(curr)) {
    const parent = dirname9(curr);
    if (parent === curr) break;
    missing.unshift(basename3(curr));
    curr = parent;
  }
  let real = curr;
  try {
    real = realpathSync(curr);
  } catch {
  }
  return missing.length > 0 ? join9(real, ...missing) : real;
}
function resolveCandidate(token, base, home) {
  const expanded = expandHome(token, home);
  const lexical = isAbsolute3(expanded) ? resolve6(expanded) : resolve6(base ?? "/", expanded);
  return { lexical, real: resolveSafeTarget(lexical) };
}
function fold(p, platform) {
  return platform === "darwin" ? p.toLowerCase() : p;
}
function isWithin(child, parent, platform = process.platform) {
  const c = fold(child, platform);
  const p = fold(parent, platform);
  return c === p || c.startsWith(p.endsWith(sep3) ? p : p + sep3);
}
function protectedRoots(home) {
  return [
    join9(home, ".gemini"),
    join9(home, ".config", "antigravity-booster"),
    join9(home, ".local", "bin", "agb"),
    join9(home, ".local", "share", "fnm"),
    join9(home, ".local", "share", "mise"),
    join9(home, ".asdf"),
    join9(home, ".volta"),
    join9(home, ".nodenv"),
    join9(home, ".nvm"),
    join9(home, "n"),
    "/opt/homebrew",
    "/usr/local"
  ];
}
function boosterDataRoots(home) {
  return [
    join9(home, ".gemini", "antigravity-cli", "plugin_data", "antigravity-booster"),
    join9(home, ".config", "antigravity-booster")
  ];
}
function matchRoot(resolved, roots, platform) {
  for (const root of roots) {
    if (isWithin(resolved.lexical, root, platform) || isWithin(resolved.real, root, platform)) return root;
  }
  return null;
}
function repoRelative(abs, repoRoot) {
  let realRepo = repoRoot;
  try {
    realRepo = realpathSync(repoRoot);
  } catch {
  }
  const rel = relative3(realRepo, abs);
  if (rel.startsWith("..") || isAbsolute3(rel)) return null;
  return rel.split(sep3).join("/");
}
function covers(rel, target, platform) {
  const r = fold(rel, platform);
  const t = fold(target, platform);
  return r === t || r.startsWith(t + "/");
}
function isAncestor(rel, target, platform) {
  const r = fold(rel, platform);
  const t = fold(target, platform);
  return r === "" || t.startsWith(r + "/");
}
function matchImplicitRail(rel, repoRoot, platform) {
  if (rel.split("/").slice(1).some((seg) => [".adlc", ".git"].includes(fold(seg, platform)))) {
    return "nested .adlc/ or .git/ inside an ADLC repository";
  }
  for (const dir of IMPLICIT_RAIL_DIRS) {
    if (covers(rel, dir, platform) || isAncestor(rel, dir, platform)) return `${dir}/**`;
  }
  for (const file of IMPLICIT_RAIL_FILES) {
    if (covers(rel, file, platform) || isAncestor(rel, file, platform)) return file;
  }
  if (isAncestor(rel, TICKET_STORE_DIR, platform) || fold(rel, platform) === fold(TICKET_STORE_DIR, platform)) {
    return `${TICKET_STORE_DIR}/`;
  }
  if (covers(rel, TICKET_STORE_DIR, platform)) {
    if (existsSync11(join9(repoRoot, rel))) return "existing ticket shard";
    if (rel.slice(TICKET_STORE_DIR.length + 1).includes("/")) return `${TICKET_STORE_DIR}/`;
  }
  return null;
}
var GLOB_SEGMENT = /[*?[\]{}!]/;
function railStaticPrefix(rail) {
  const kept = [];
  for (const seg of rail.split("/")) {
    if (GLOB_SEGMENT.test(seg)) break;
    kept.push(seg);
  }
  return kept.join("/");
}
function matchDeclaredRail(rel, rails, platform) {
  const nocase = platform === "darwin";
  for (const rail of rails) {
    const prefix = railStaticPrefix(rail);
    if (covers(rel, rail, platform) || prefix !== "" && (fold(rel, platform) === fold(prefix, platform) || isAncestor(rel, prefix, platform)) || minimatch(rel, rail, { dot: true, nocase })) {
      return rail;
    }
  }
  return null;
}
function matchesScope(rel, scope, platform) {
  const nocase = platform === "darwin";
  return scope.some(
    (entry) => typeof entry === "string" && entry.length > 0 && (minimatch(rel, entry, { dot: true, nocase }) || covers(rel, entry.replace(/\/+$/, ""), platform))
  );
}

// hooks/policy/shell.mjs
import { basename as basename4, isAbsolute as isAbsolute4, join as join10, resolve as resolve7 } from "node:path";

// hooks/policy/shell-lexer.mjs
var GLOB_CHARS = /* @__PURE__ */ new Set(["*", "?", "["]);
function newSubcommand() {
  return { argv: [], redirects: [], dynamic: false, assignments: [] };
}
function newToken() {
  return { value: "", quoted: false, started: false, dynamic: false };
}
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
function lexCommandLine(line) {
  if (typeof line !== "string") return { ok: false, error: "command line is not a string" };
  const subcommands = [];
  let sub = newSubcommand();
  let tok = newToken();
  let pendingRedirect = null;
  let quote = null;
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
      sub.dynamic = true;
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
      } else if (ch === "\\" && next !== void 0 && '$`"\\\n'.includes(next)) {
        add(next);
        i += 1;
      } else {
        if (ch === "$" || ch === "`") tok.dynamic = true;
        add(ch);
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tok.quoted = true;
      tok.started = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next !== void 0) add(next);
      i += 2;
      continue;
    }
    if (ch === " " || ch === "	") {
      flushToken();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flushSub();
      i += 1;
      continue;
    }
    if (ch === "&" && next === "&") {
      flushSub();
      i += 2;
      continue;
    }
    if (ch === "|" && next === "|") {
      flushSub();
      i += 2;
      continue;
    }
    if (ch === "|") {
      flushSub();
      i += 1;
      continue;
    }
    if (ch === "&" && next === ">") {
      flushToken();
      pendingRedirect = line[i + 2] === ">" ? "&>>" : "&>";
      i += pendingRedirect.length;
      continue;
    }
    if (ch === "&") {
      flushSub();
      i += 1;
      continue;
    }
    if (ch === "<" && (next === "(" || next === "<")) {
      sub.dynamic = true;
      add(ch);
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<" || /[0-9]/.test(ch) && !tok.started && (next === ">" || next === "<")) {
      let j = i;
      let op = "";
      if (/[0-9]/.test(line[j])) op += line[j++];
      op += line[j++];
      if (line[j] === ">" && op.endsWith(">")) op += line[j++];
      if (line[j] === "|" && op.endsWith(">")) op += line[j++];
      else if (line[j] === ">" && op.endsWith("<")) op += line[j++];
      if (line[j] === "&") {
        op += line[j++];
        while (/[0-9-]/.test(line[j] ?? "")) j += 1;
        flushToken();
        i = j;
        continue;
      }
      flushToken();
      pendingRedirect = op;
      i = j;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      tok.dynamic = true;
      sub.dynamic = true;
      add(ch);
      i += 1;
      continue;
    }
    if (ch === "#" && !tok.started) {
      sub.dynamic = true;
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
  if (quote) return { ok: false, error: "unbalanced quote" };
  flushSub();
  return { ok: true, subcommands };
}

// hooks/policy/verdict.mjs
var PASS = Object.freeze({ decision: "pass" });
var deny = (reason) => ({ decision: "deny", reason });
var ask = (reason) => ({ decision: "ask", reason });
var RANK = { pass: 0, ask: 1, deny: 2 };
function mostRestrictive(verdicts) {
  let best = PASS;
  for (const v of verdicts) if (RANK[v.decision] > RANK[best.decision]) best = v;
  return best;
}

// hooks/policy/shell.mjs
var GIT_READ_FLAGS = {
  status: [/^-s$/, /^--short$/, /^-b$/, /^--branch$/, /^--porcelain(=v[12])?$/, /^--ignored$/, /^-u(normal|all|no)?$/, /^--untracked-files(=.*)?$/],
  diff: [/^--staged$/, /^--cached$/, /^--stat$/, /^--name-only$/, /^--name-status$/, /^--color$/, /^--no-color$/, /^-p$/, /^-u$/, /^--$/],
  log: [/^-n\d*$/, /^--max-count=\d+$/, /^--oneline$/, /^--graph$/, /^--stat$/, /^--pretty=.*$/, /^-p$/, /^--$/],
  show: [/^--stat$/, /^--name-only$/, /^--oneline$/, /^--$/]
};
var GIT_OUTPUT_FLAG = /^(--output(=.*)?|-o)$/;
var LIFECYCLE_VERBS = /* @__PURE__ */ new Set(["complete", "archive", "update", "edit", "discard", "restore", "store"]);
var DIR_CHANGE = /* @__PURE__ */ new Set(["cd", "pushd", "popd"]);
var COMMIT_LONG_FLAGS = /* @__PURE__ */ new Set(["--message", "--signoff", "--quiet", "--verbose"]);
function adlcTicketOperands(argv) {
  const i = argv.findIndex((t) => ["adlc", "adlc-tickets"].includes(basename4(t)));
  if (i < 0) return null;
  const operands = argv.slice(i + 1).filter((t) => !t.startsWith("-"));
  return basename4(argv[i]) === "adlc-tickets" ? ["ticket", ...operands] : operands;
}
function hasWriteRedirect(sub) {
  return sub.redirects.some((r) => r.op.includes(">"));
}
function candidateTokens(sub) {
  const out = [];
  for (const t of sub.argv.slice(1)) {
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      if (eq > 0 && eq < t.length - 1) out.push(t.slice(eq + 1));
      else if (!t.startsWith("--") && t.length > 2) out.push(t.slice(2));
    } else if (t.length > 0) {
      out.push(t);
    }
  }
  for (const r of sub.redirects) if (r.target) out.push(r.target);
  return out;
}
function isGitOutput(argv) {
  return argv[0] === "git" && ["diff", "log"].includes(argv[1]) && argv.slice(2).some((t) => GIT_OUTPUT_FLAG.test(t));
}
function isStage1(sub) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  if (sub.argv.some(hasHomePrefix)) return false;
  const [cmd, verb, ...rest] = sub.argv;
  if (PURE_READERS.has(cmd)) return true;
  if (cmd !== "git" || !GIT_READ_FLAGS[verb]) return false;
  const allowed = GIT_READ_FLAGS[verb];
  return rest.every((t) => !t.startsWith("-") || allowed.some((re) => re.test(t)));
}
function shimForms(home, realHome) {
  return /* @__PURE__ */ new Set(["~/.local/bin/agb", "$HOME/.local/bin/agb", "${HOME}/.local/bin/agb", join10(home, ".local/bin/agb"), join10(realHome, ".local/bin/agb")]);
}
function isShimInvocation(argv, ctx) {
  if (shimForms(ctx.home, ctx.realHome).has(argv[0])) return true;
  if ((argv[0] === "/bin/sh" || argv[0] === "sh") && argv[2] === "dist/agb.mjs" && typeof argv[1] === "string") {
    const launcher = resolve7(expandHome(argv[1], ctx.home));
    const pluginsDir = join10(ctx.home, ".gemini", "config", "plugins");
    return /\/antigravity-booster(-[^/]+)?\/bin\/node-launcher\.sh$/.test(launcher) && isWithin(launcher, pluginsDir, ctx.platform);
  }
  return false;
}
function isLiteralShardPath(token, cwd, ctx) {
  const r = resolveCandidate(token, cwd, ctx.home);
  const repo = ctx.repoAt(r.real);
  if (!repo.adlc) return false;
  const rel = repoRelative(r.real, repo.root);
  return rel !== null && rel.startsWith(`${TICKET_STORE_DIR}/`) && rel.endsWith(".json") && !rel.slice(TICKET_STORE_DIR.length + 1).includes("/");
}
function isStage2(sub, cwd, ctx) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  const [cmd, a1, a2, ...rest] = sub.argv;
  if (cmd === "adlc" && a1 === "ticket" && a2 === "create") return true;
  if (cmd === "git" && a1 === "add") {
    const paths = [a2, ...rest].filter((t) => t !== void 0 && t !== "--");
    return paths.length > 0 && paths.every((t) => !t.startsWith("-") && isLiteralShardPath(t, cwd, ctx));
  }
  return false;
}
function isTestCommand(sub) {
  if (sub.dynamic || sub.assignments.length > 0 || sub.redirects.length > 0) return false;
  const [cmd, a1, a2] = sub.argv;
  if (cmd === "npm" && a1 === "test") return sub.argv.length === 2 || a2 === "--";
  if (cmd === "npm" && a1 === "run" && sub.argv.length === 3) return a2 === "test" || /^test:[\w.:-]+$/.test(a2);
  return cmd === "node" && a1 === "--test";
}
function isRoutine(sub) {
  if (sub.dynamic || sub.assignments.length > 0 || hasWriteRedirect(sub)) return false;
  const [cmd, a1, ...rest] = sub.argv;
  if (cmd === "npm") return a1 === "run" && rest.length === 1 && rest[0] === "build";
  if (cmd !== "git") return false;
  if (a1 === "add") {
    const paths = rest.filter((t) => t !== "--");
    return paths.length > 0 && paths.every((t) => !t.startsWith("-") && t !== "." && t !== "..");
  }
  if (a1 === "commit") return isRoutineCommit(rest);
  return false;
}
function isRoutineCommit(args) {
  let expectValue = false;
  for (const t of args) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (t === "--") continue;
    if (t === "-m" || t === "--message") {
      expectValue = true;
      continue;
    }
    if (t.startsWith("--message=")) continue;
    if (t.startsWith("--")) {
      if (!COMMIT_LONG_FLAGS.has(t)) return false;
      continue;
    }
    if (t.startsWith("-")) {
      const flags = t.slice(1);
      if (!/^[sqv]*m?$/.test(flags) || flags.length === 0) return false;
      if (flags.endsWith("m")) expectValue = true;
    }
  }
  return true;
}
function destructiveRootScope(argv) {
  const [cmd, a1, ...rest] = argv;
  if (DESTRUCTIVE_ROOT_VERBS.has(cmd)) return "paths";
  if (cmd !== "git") return null;
  if (a1 === "clean") return "repo";
  if (a1 === "reset" && rest.includes("--hard")) return "repo";
  if (a1 === "restore" || a1 === "checkout" && rest.includes("--")) return "paths";
  return null;
}
function stage5(ctx, repos, reason) {
  if (ctx.readonly) return deny("Read-only agb worker session: only inspection commands are permitted");
  const adlcRepos = repos.filter((r) => r.adlc);
  if (ctx.workerTicket) {
    return adlcRepos.length > 0 ? deny("Headless worker cannot prompt operator; dynamic or unlisted command denied per ADLC P4 doctrine") : PASS;
  }
  if (adlcRepos.some((r) => r.activeRail)) return ask(reason);
  return PASS;
}
function checkTargets(sub, cwd, ctx, { stage1, shim, dirChange }) {
  const writeTargets = new Set(sub.redirects.filter((r) => r.op.includes(">")).map((r) => r.target));
  const verdicts = [];
  const repos = [];
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    if (matchRoot(r, boosterDataRoots(ctx.home), ctx.platform)) {
      return { verdict: deny("Inspection or modification of booster plugin data or credentials via tool calls is forbidden"), repos };
    }
    if (matchRoot(r, protectedRoots(ctx.home), ctx.platform) && (writeTargets.has(token) || !(stage1 || shim))) {
      return { verdict: deny("Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden"), repos };
    }
    const shimDir = join10(ctx.home, ".local", "bin");
    if (!(stage1 || shim) && [r.lexical, r.real].some((p) => p === shimDir || p === join10(ctx.realHome, ".local", "bin"))) {
      return { verdict: deny("Writing into the directory that holds the agb terminal shim is forbidden"), repos };
    }
    const repo = ctx.repoAt(r.real);
    repos.push(repo);
    if (!repo.adlc || stage1 || dirChange) continue;
    if (!repo.store.ok) return { verdict: deny("ADLC ticket store corrupt or unreadable; frozen rails cannot be verified"), repos };
    const rel = repoRelative(r.real, repo.root);
    if (rel === null || rel === "") continue;
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
  if (scope === "repo") {
    const isClean = sub.argv[1] === "clean";
    if (cwdRepo.adlc && (isClean || cwdRepo.activeRail)) return deny("Repository-wide destructive git command in an ADLC repository");
    return PASS;
  }
  for (const token of candidateTokens(sub)) {
    const r = resolveCandidate(token, cwd, ctx.home);
    if (protectedRoots(ctx.home).some((root) => isWithin(root, r.real, ctx.platform) || isWithin(root, r.lexical, ctx.platform))) {
      return deny("Destructive command targets a directory containing platform configuration, plugins, or Node runtimes");
    }
    for (const repo of ctx.knownRepos()) {
      if (repo.adlc && isWithin(repo.root, r.real, ctx.platform)) {
        return deny("Target path is an ADLC repository root (or its parent), which holds frozen trust-root state");
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
  if (targetVerdict.decision === "deny") return targetVerdict;
  const contextRepos = [cwdRepo, ...repos];
  const ticketOps = adlcTicketOperands(argv);
  if (ticketOps && ticketOps[0] === "ticket" && LIFECYCLE_VERBS.has(ticketOps[1])) {
    if (!contextRepos.some((r) => r.adlc)) return PASS;
    if (!argv.includes("--authorize")) return deny("Ticket lifecycle change without --authorize is forbidden in-session");
    return ctx.headless ? deny("Headless worker cannot authorize a ticket lifecycle change") : ask("Authorized ticket lifecycle change requires operator confirmation");
  }
  if (stage1) return PASS;
  if (isStage2(sub, cwd, ctx)) return PASS;
  const destructive = checkDestructiveRoot(sub, cwd, cwdRepo, ctx);
  if (destructive.decision === "deny") return destructive;
  if (isGitOutput(argv)) return stage5(ctx, contextRepos, "git command writing --output requires operator confirmation");
  if (shim) {
    if (ctx.headless) return deny("Headless agb worker cannot invoke the agb shim");
    return stage5(ctx, contextRepos, "agb command in an active-rail ADLC repository requires operator confirmation");
  }
  if (DIR_CHANGE.has(argv[0])) {
    return stage5(ctx, contextRepos, "Directory change in an active-rail ADLC repository requires operator confirmation");
  }
  if (ctx.workerTicket && !ctx.readonly && contextRepos.some((r) => r.adlc) && isTestCommand(sub)) return PASS;
  if (!ctx.headless && contextRepos.some((r) => r.adlc && r.activeRail) && isRoutine(sub)) return PASS;
  return stage5(ctx, contextRepos, "Unlisted or dynamic shell command in an active-rail ADLC repository requires operator confirmation");
}
function dirChangeTarget(sub, cwd, ctx) {
  const [cmd, ...rest] = sub.argv;
  if (sub.dynamic || cmd === "popd") return null;
  const operands = rest.filter((t) => !/^-[LPe@]+$/.test(t) && t !== "--");
  if (operands.length === 0) return cmd === "cd" ? ctx.home : null;
  if (operands.length > 1 || operands[0] === "-" || /^[+-]\d+$/.test(operands[0])) return null;
  return resolve7(cwd, expandHome(operands[0], ctx.home));
}
function classifyRunCommand(args, ctx) {
  const line = args?.CommandLine;
  if (typeof line !== "string") return deny("run_command without a CommandLine string cannot be verified");
  const cwdRaw = typeof args?.Cwd === "string" && args.Cwd.length > 0 ? args.Cwd : ctx.workspacePaths[0];
  if (!cwdRaw) return deny("Cannot determine the shell working directory");
  const cwd = isAbsolute4(cwdRaw) ? resolve7(cwdRaw) : resolve7(ctx.workspacePaths[0] ?? "/", cwdRaw);
  const cwdRepo = ctx.repoAt(cwd);
  const adlcContext = cwdRepo.adlc || ctx.workspacePaths.some((w) => ctx.repoAt(w).adlc);
  const insideWorkspace = ctx.workspacePaths.some((w) => isWithin(cwd, w, ctx.platform));
  if (adlcContext && (!isAbsolute4(cwdRaw) || !insideWorkspace)) {
    return deny("Shell command working directory outside declared workspace paths in an ADLC repository is forbidden");
  }
  const lexed = lexCommandLine(line);
  if (!lexed.ok) return stage5(ctx, [cwdRepo], "Shell command could not be parsed; operator confirmation required");
  const verdicts = [];
  let current = cwd;
  const subs = lexed.subcommands;
  for (const sub of subs) {
    if (current === null) {
      verdicts.push(deny("Working directory unknown after a directory change; later commands cannot be verified"));
      continue;
    }
    if (DIR_CHANGE.has(sub.argv[0])) {
      const target = dirChangeTarget(sub, current, ctx);
      const intoWorkspace = target !== null && ctx.workspacePaths.some((w) => isWithin(target, w, ctx.platform));
      if (!(subs.length > 1 && intoWorkspace)) verdicts.push(classifySubcommand(sub, current, ctx.repoAt(current), ctx));
      current = target;
      continue;
    }
    verdicts.push(classifySubcommand(sub, current, ctx.repoAt(current), ctx));
  }
  return mostRestrictive(verdicts);
}

// hooks/policy/evaluate.mjs
var UNEXPECTED_PATH = /[/\\]|\.(mjs|js|json)$/;
var FILE_URL = /^file:\/\//;
var toPath = (value) => value.replace(FILE_URL, "");
function realOr(p) {
  try {
    return realpathSync2(p);
  } catch {
    return p;
  }
}
function makeRepoCache() {
  const byRoot = /* @__PURE__ */ new Map();
  return {
    repoAt(absPath) {
      const root = findAdlcRoot(absPath);
      if (!root) return { adlc: false };
      if (!byRoot.has(root)) {
        const store = unionActiveRails(root);
        byRoot.set(root, { adlc: true, root, store, activeRail: !store.ok || store.rails.length > 0 });
      }
      return byRoot.get(root);
    },
    knownRepos: () => [...byRoot.values()]
  };
}
function isBoosterMcpTool(name, args) {
  if (name === "call_mcp_tool") return args?.ServerName === BOOSTER_MCP_SERVER && BOOSTER_MCP_TOOLS.has(args?.ToolName);
  const prefix = `mcp__${BOOSTER_MCP_SERVER}__`;
  return name.startsWith(prefix) && BOOSTER_MCP_TOOLS.has(name.slice(prefix.length));
}
function boosterMcpToolName(name, args) {
  return name === "call_mcp_tool" ? args?.ToolName : name.slice(`mcp__${BOOSTER_MCP_SERVER}__`.length);
}
function extractProbedPaths(toolName, args) {
  const schema = TOOL_PATH_SCHEMAS[toolName];
  if (!schema) return null;
  const paths = [];
  for (const key of schema.required) {
    const val = args?.[key];
    if (typeof val !== "string" || val.trim().length === 0) return { error: `Missing required path parameter: ${key}` };
    paths.push(val);
  }
  for (const [key, val] of Object.entries(args ?? {})) {
    if (schema.required.includes(key) || EXCLUDED_CONTENT_KEYS.has(key)) continue;
    if (typeof val === "string" && UNEXPECTED_PATH.test(val)) return { error: `Unexpected path parameter in mutating tool call: ${key}` };
  }
  return { paths };
}
function scanPathLike(value, out = [], key = null) {
  if (key !== null && EXCLUDED_CONTENT_KEYS.has(key)) return out;
  if (typeof value === "string") {
    if (isAbsolute5(value) || hasHomePrefix(value) || value.includes("/")) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) scanPathLike(v, out, null);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scanPathLike(v, out, k);
  }
  return out;
}
function readToolPaths(name, args) {
  const keys = READ_TOOL_PATH_SCHEMAS[name] ?? [];
  return keys.map((k) => args?.[k]).filter((v) => typeof v === "string" && v.length > 0).map(toPath);
}
function gateOnePath(resolved, ctx, { rootIsTarget = true } = {}) {
  const repo = ctx.repoAt(resolved.real);
  if (!repo.adlc) return { verdict: PASS, repo };
  if (!repo.store.ok) return { verdict: deny("ADLC ticket store corrupt or unreadable; frozen rails cannot be verified"), repo };
  const rel = repoRelative(resolved.real, repo.root);
  if (rel === null) return { verdict: deny("Target path sits outside repository root"), repo };
  const implicit = rel === "" && !rootIsTarget ? null : matchImplicitRail(rel, repo.root, ctx.platform);
  if (implicit) return { verdict: deny(`Target path matches standing ADLC implicit rail: ${implicit}`), repo, rel };
  if (repo.activeRail) {
    if (rel === "") {
      return rootIsTarget ? { verdict: deny("Target path is repository root, which contains active frozen rails"), repo, rel } : { verdict: PASS, repo, rel };
    }
    const rail = matchDeclaredRail(rel, repo.store.rails, ctx.platform);
    if (rail) return { verdict: deny(`Target path matches frozen rail: ${rail}`), repo, rel };
  }
  return { verdict: PASS, repo, rel };
}
function workerScopeVerdict(repo, rel, ctx) {
  const found = resolveTicket(repo.root, ctx.workerTicket);
  if (!found.ok) return deny(`Headless worker ticket ${ctx.workerTicket} cannot be resolved (${found.error}); mutations denied`);
  const scope = Array.isArray(found.ticket.scope) ? found.ticket.scope : [];
  if (!matchesScope(rel, scope, ctx.platform)) {
    return deny(`Headless worker for ticket ${ctx.workerTicket} attempted mutation outside declared ticket scope: ${rel}`);
  }
  return PASS;
}
function stepOne(name, args, ctx) {
  const anchor = ctx.anchor;
  let candidates;
  if (READ_ONLY_TOOLS.has(name) || READ_TOOL_PATH_SCHEMAS[name]) candidates = readToolPaths(name, args);
  else if (TOOL_PATH_SCHEMAS[name]) {
    candidates = TOOL_PATH_SCHEMAS[name].required.map((k) => args?.[k]).filter((v) => typeof v === "string").map(toPath);
  } else if (name === "run_command") return PASS;
  else candidates = scanPathLike(args);
  for (const token of candidates) {
    const r = resolveCandidate(token, anchor, ctx.home);
    if (matchRoot(r, boosterDataRoots(ctx.home), ctx.platform)) {
      return deny("Inspection or modification of booster plugin data or credentials via tool calls is forbidden");
    }
    if (!READ_ONLY_TOOLS.has(name) && !READ_TOOL_PATH_SCHEMAS[name] && matchRoot(r, protectedRoots(ctx.home), ctx.platform)) {
      return deny("Direct modification of platform configuration, plugins, or Node runtimes via tool calls is forbidden");
    }
  }
  return PASS;
}
function schemaViolationVerdict(name, args, reason, ctx) {
  if (ctx.readonly) return deny(reason);
  const required = (TOOL_PATH_SCHEMAS[name]?.required ?? []).map((k) => args?.[k]).filter((v) => typeof v === "string" && v.length > 0);
  const anchorRepo = ctx.repoAt(ctx.anchor ?? "/");
  if (anchorRepo.adlc && (anchorRepo.activeRail || ctx.workerTicket)) return deny(reason);
  for (const token of [...required, ...scanPathLike(args)].map(toPath)) {
    const r = resolveCandidate(token, ctx.anchor, ctx.home);
    if (matchRoot(r, protectedRoots(ctx.home), ctx.platform) || ctx.repoAt(r.real).adlc) return deny(reason);
  }
  return PASS;
}
function evaluateFileTool(name, args, ctx) {
  const extracted = extractProbedPaths(name, args);
  if (!extracted || extracted.error) {
    const reason = extracted ? `Mutating tool argument schema violation: ${extracted.error}` : "Unknown mutating tool in ADLC repository with active frozen rails; cannot verify target path safety";
    return schemaViolationVerdict(name, args, reason, ctx);
  }
  if (ctx.readonly) return deny("Read-only agb worker session: file mutations are forbidden");
  const verdicts = [];
  for (const token of extracted.paths.map(toPath)) {
    const r = resolveCandidate(token, ctx.anchor, ctx.home);
    const { verdict, repo, rel } = gateOnePath(r, ctx);
    if (verdict.decision !== "pass") {
      verdicts.push(verdict);
      continue;
    }
    if (ctx.workerTicket && repo.adlc) verdicts.push(workerScopeVerdict(repo, rel, ctx));
  }
  return mostRestrictive(verdicts);
}
function evaluateMcpTool(name, args, ctx) {
  const verdicts = [];
  for (const token of scanPathLike(args)) {
    const { verdict } = gateOnePath(resolveCandidate(token, ctx.anchor, ctx.home), ctx, { rootIsTarget: false });
    if (verdict.decision === "deny") verdicts.push(deny(`Target path '${token}' in MCP tool call references frozen rail (${verdict.reason})`));
  }
  if (verdicts.length) return mostRestrictive(verdicts);
  if (isBoosterMcpTool(name, args)) {
    if (ctx.readonly && boosterMcpToolName(name, args) === "agb_run") return deny("Read-only agb worker session cannot start an agb run");
    return PASS;
  }
  if (ctx.readonly) return deny("Third-party MCP tool call cannot prompt operator in a read-only agb worker session");
  const repo = ctx.repoAt(ctx.anchor ?? "/");
  if (ctx.workerTicket && repo.adlc) return deny("Third-party MCP tool call cannot prompt operator in headless worker mode");
  if (repo.adlc && repo.activeRail) {
    return ctx.headless ? deny("Third-party MCP tool call cannot prompt operator in headless worker mode") : ask("Third-party MCP tool call in an active-rail ADLC repository requires operator confirmation");
  }
  return PASS;
}
function evaluateUnknownTool(ctx) {
  if (ctx.readonly) return deny("Unknown tool in a read-only agb worker session");
  const repo = ctx.repoAt(ctx.anchor ?? "/");
  if (repo.adlc && (repo.activeRail || ctx.workerTicket)) {
    return deny("Unknown tool in ADLC repository with active frozen rails; cannot verify safety");
  }
  return PASS;
}
function buildContext(payload, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir2();
  const workspacePaths = (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : []).filter((p) => typeof p === "string" && isAbsolute5(p)).map((p) => resolve8(p));
  const workerTicket = env.AGB_WORKER_TICKET ? String(env.AGB_WORKER_TICKET) : null;
  const readonly = Boolean(env.AGB_WORKER_MODE);
  const args = payload?.toolCall?.args;
  const cwd = typeof args?.Cwd === "string" && isAbsolute5(args.Cwd) ? resolve8(args.Cwd) : null;
  return {
    home,
    realHome: realOr(home),
    platform: options.platform ?? process.platform,
    workspacePaths,
    workerTicket,
    readonly,
    headless: Boolean(workerTicket) || readonly,
    anchor: cwd ?? workspacePaths[0] ?? null,
    ...makeRepoCache()
  };
}
function evaluatePayload(payload, options = {}) {
  const name = payload?.toolCall?.name;
  if (typeof name !== "string" || name.length === 0) return deny("Malformed PreToolUse payload: missing tool name");
  const args = payload.toolCall.args ?? {};
  const ctx = buildContext(payload, options);
  const step1 = stepOne(name, args, ctx);
  if (step1.decision === "deny") return step1;
  if (READ_ONLY_TOOLS.has(name) || ORCHESTRATION_TOOLS.has(name)) return PASS;
  if (name === "run_command") return classifyRunCommand(args, ctx);
  if (PATH_MUTATING_TOOLS.has(name)) return evaluateFileTool(name, args, ctx);
  if (name === "call_mcp_tool" || name.startsWith("mcp__")) return evaluateMcpTool(name, args, ctx);
  return evaluateUnknownTool(ctx);
}

// hooks/pre-tool-use.mjs
var CEILING_MS = 7e3;
function readStdin() {
  return new Promise((resolveRead, rejectRead) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveRead(data));
    process.stdin.on("error", rejectRead);
  });
}
async function main() {
  const ceiling = setTimeout(() => {
    process.stderr.write("agb policy guard: internal 7s ceiling reached\n");
    process.exit(1);
  }, CEILING_MS);
  ceiling.unref();
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(`${JSON.stringify({ decision: "deny", reason: "Malformed PreToolUse payload: invalid JSON" })}
`);
    return;
  }
  const verdict = evaluatePayload(payload);
  if (verdict.decision === "deny" || verdict.decision === "ask") {
    process.stdout.write(`${JSON.stringify({ decision: verdict.decision, reason: verdict.reason })}
`);
  }
}
main().catch((err) => {
  process.stderr.write(`agb policy guard: ${err?.stack ?? err}
`);
  process.exit(1);
});
