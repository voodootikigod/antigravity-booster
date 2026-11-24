import { createRequire as __agbCreateRequire } from 'node:module'; const require = __agbCreateRequire(import.meta.url);

// mcp/server.mjs
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename as basename2, dirname as dirname4, join as join4, relative as relative3, resolve as resolve4, isAbsolute as isAbsolute3, sep as sep2 } from "node:path";
import {
  closeSync as closeSync2,
  constants as constants2,
  existsSync as existsSync3,
  fstatSync as fstatSync2,
  lstatSync as lstatSync3,
  openSync as openSync2,
  readFileSync as readFileSync3,
  readSync,
  realpathSync as realpathSync3,
  statSync as statSync2
} from "node:fs";

// lib/models.mjs
import { AsyncLocalStorage } from "node:async_hooks";
var MODELS = {
  "gemini-flash": ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"],
  "gemini-pro": [
    "gemini-4-argon-low",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "gemini-4-carbon-low",
    "gemini-4-carbon-medium",
    "gemini-4-carbon-high",
    "gemini-4-hydrogen-low",
    "gemini-4-hydrogen-medium",
    "gemini-4-hydrogen-high",
    "gemini-4-hydrogen-xhigh",
    "gemini-4-neon-low",
    "gemini-4-neon-medium",
    "gemini-4-neon-high",
    "gemini-4-neon-xhigh",
    "gemini-pro-orchestrator",
    "gemini-pro-orchestrator-argon",
    "gemini-pro-orchestrator-neon"
  ],
  claude: [
    "claude-sonnet-5-5-low",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-high",
    "claude-opus-5-5-low",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-high"
  ],
  "gpt-oss": ["gpt-oss-120b-medium"]
};
var ALL_MODELS = Object.freeze(Object.values(MODELS).flat());
var MODEL_ALIASES = {
  "gemini 3.8 flash (low)": "gemini-3.8-flash-low",
  "gemini 3.8 flash (medium)": "gemini-3.8-flash-medium",
  "gemini 3.8 flash (high)": "gemini-3.8-flash-high",
  "gemini 4 argon (low)": "gemini-4-argon-low",
  "gemini 4 argon (medium)": "gemini-4-argon-medium",
  "gemini 4 argon (high)": "gemini-4-argon-high",
  "gemini 4 carbon (low)": "gemini-4-carbon-low",
  "gemini 4 carbon (medium)": "gemini-4-carbon-medium",
  "gemini 4 carbon (high)": "gemini-4-carbon-high",
  "gemini 4 hydrogen (low)": "gemini-4-hydrogen-low",
  "gemini 4 hydrogen (medium)": "gemini-4-hydrogen-medium",
  "gemini 4 hydrogen (high)": "gemini-4-hydrogen-high",
  "gemini 4 hydrogen (xhigh)": "gemini-4-hydrogen-xhigh",
  "gemini 4 neon (low)": "gemini-4-neon-low",
  "gemini 4 neon (medium)": "gemini-4-neon-medium",
  "gemini 4 neon (high)": "gemini-4-neon-high",
  "gemini 4 neon (xhigh)": "gemini-4-neon-xhigh",
  "orchestrator (carbon)": "gemini-pro-orchestrator",
  "orchestrator (argon)": "gemini-pro-orchestrator-argon",
  "orchestrator (neon)": "gemini-pro-orchestrator-neon",
  "claude sonnet 5.5 (low)": "claude-sonnet-5-5-low",
  "claude sonnet 5.5 (medium)": "claude-sonnet-5-5-medium",
  "claude sonnet 5.5 (high)": "claude-sonnet-5-5-high",
  "claude opus 5.5 (low)": "claude-opus-5-5-low",
  "claude opus 5.5 (medium)": "claude-opus-5-5-medium",
  "claude opus 5.5 (high)": "claude-opus-5-5-high",
  "gpt-oss 120b (medium)": "gpt-oss-120b-medium"
};
var RETIRED_FLASH_GENERATIONS = ["3.5", "3.6", "3.7"];
var EFFORTS = ["low", "medium", "high"];
var retiredEntries = [
  ...RETIRED_FLASH_GENERATIONS.flatMap(
    (gen) => EFFORTS.flatMap((e) => [
      [`gemini-${gen}-flash-${e}`, `gemini-3.8-flash-${e}`],
      [`gemini ${gen} flash (${e})`, `gemini-3.8-flash-${e}`]
    ])
  ),
  ...["low", "high"].flatMap((e) => [
    [`gemini-3.1-pro-${e}`, `gemini-4-argon-${e}`],
    [`gemini 3.1 pro (${e})`, `gemini-4-argon-${e}`]
  ]),
  ["claude-sonnet-4-6", "claude-sonnet-5-5-medium"],
  ["claude sonnet 4.6 (thinking)", "claude-sonnet-5-5-medium"],
  ["claude-opus-4-6-thinking", "claude-opus-5-5-high"],
  ["claude opus 4.6 (thinking)", "claude-opus-5-5-high"]
];
var RETIRED_MODEL_MAP = Object.freeze(Object.fromEntries(retiredEntries));
var FRONTIER_NO_ORCHESTRATOR = Object.freeze([
  "gemini-4-argon-high",
  "claude-sonnet-5-5-high",
  "gemini-4-carbon-high",
  "gemini-4-neon-high",
  "claude-opus-5-5-high"
]);
var TIER_CANDIDATES = {
  cheap: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium"],
  mid: [
    "gemini-3.8-flash-high",
    "gemini-4-argon-low",
    "gemini-4-carbon-medium",
    "gemini-4-hydrogen-medium",
    "gemini-4-neon-medium",
    "claude-sonnet-5-5-medium"
  ],
  frontier: Object.freeze([
    "gemini-pro-orchestrator",
    "claude-sonnet-5-5-high",
    "gemini-pro-orchestrator-argon",
    "gemini-pro-orchestrator-neon",
    "gemini-4-argon-high",
    "gemini-4-carbon-high",
    "gemini-4-neon-high",
    "claude-opus-5-5-high"
  ])
};
var CODE_ARL_LENSES = Object.freeze([
  "correctness_redteam",
  "security",
  "simplicity",
  "evidence_runner",
  "anti_slop"
]);
var PLAN_ARL_LENSES = Object.freeze([
  "devils_advocate",
  "requirements_fidelity",
  "simplicity",
  "evidence_strategy",
  "dag_topology"
]);
var ARL_LENS_MODELS = Object.freeze({
  correctness_redteam: { primary: "claude-opus-5-5-high", fallback: "gemini-4-argon-high" },
  security: { primary: "gemini-4-argon-high", fallback: "claude-opus-5-5-high" },
  simplicity: { primary: "claude-sonnet-5-5-medium", fallback: "gemini-3.8-flash-medium" },
  evidence_runner: { primary: "gemini-3.8-flash-medium", fallback: "claude-sonnet-5-5-medium" },
  anti_slop: { primary: "claude-sonnet-5-5-high", fallback: "gemini-3.8-flash-high" },
  devils_advocate: { primary: "claude-opus-5-5-high", fallback: "gemini-4-argon-high" },
  requirements_fidelity: { primary: "gemini-4-argon-medium", fallback: "claude-sonnet-5-5-high" },
  evidence_strategy: { primary: "gemini-3.8-flash-medium", fallback: "claude-sonnet-5-5-medium" },
  dag_topology: { primary: "gemini-4-argon-high", fallback: "claude-opus-5-5-high" },
  arbiter: { primary: "gemini-4-argon-high", fallback: "claude-opus-5-5-high" }
});
function resolveModelSlug(model) {
  if (typeof model !== "string") return model;
  const normalized = model.trim().toLowerCase();
  if (Object.hasOwn(RETIRED_MODEL_MAP, normalized)) {
    const resolved = RETIRED_MODEL_MAP[normalized];
    console.warn(`[agb] Warning: model '${model}' is retired upstream; remapped to '${resolved}'.`);
    return resolved;
  }
  if (Object.hasOwn(MODEL_ALIASES, normalized)) return MODEL_ALIASES[normalized];
  for (const list of Object.values(MODELS)) {
    for (const slug of list) {
      if (slug.toLowerCase() === normalized) return slug;
    }
  }
  return model;
}
function poolOf(model) {
  const slug = resolveModelSlug(model);
  for (const [pool, models] of Object.entries(MODELS)) {
    if (models.includes(slug)) return pool;
  }
  if (typeof slug !== "string") throw new Error(`unknown model: ${slug}`);
  const normalized = slug.toLowerCase();
  if (normalized.includes("flash")) return "gemini-flash";
  if (normalized.includes("gemini") || normalized.includes("hydrogen")) return "gemini-pro";
  if (normalized.includes("claude") || normalized.includes("sonnet") || normalized.includes("opus")) return "claude";
  if (normalized.includes("gpt")) return "gpt-oss";
  throw new Error(`unknown model: ${slug}`);
}
function familyOf(model) {
  const pool = poolOf(model);
  return pool.startsWith("gemini") ? "gemini" : pool;
}
function toModelSet(v) {
  return v instanceof Set ? v : Array.isArray(v) ? new Set(v) : null;
}
var runtimeState = {
  disableOrchestrator: false,
  disabledModels: null
};
var routingAls = new AsyncLocalStorage();
function tierCandidates(tier = "mid", poolHint, options) {
  const activeState = routingAls.getStore() ?? runtimeState;
  const effectiveTier = TIER_CANDIDATES[tier] ? tier : "mid";
  const disableOrchestrator = Boolean(options?.disableOrchestrator ?? activeState.disableOrchestrator) || process.env.AGB_DISABLE_ORCHESTRATOR === "1";
  const base = effectiveTier === "frontier" && disableOrchestrator ? FRONTIER_NO_ORCHESTRATOR : TIER_CANDIDATES[effectiveTier];
  const disabledSet = options?.disabledModels !== void 0 ? toModelSet(options.disabledModels) : activeState.disabledModels;
  return base.filter((m) => {
    if (disabledSet && disabledSet.has(m)) return false;
    if (!poolHint || poolHint === "auto") return true;
    const fam = familyOf(m);
    if (poolHint === "claude-gpt") return fam === "claude" || fam === "gpt-oss";
    return fam === poolHint;
  });
}
var VALID_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var SLUG_EFFORT_LADDER = Object.freeze(["low", "medium", "high", "xhigh"]);

// lib/plugin-paths.mjs
var BUNDLED_ADLC_ANTIGRAVITY_VERSION = "1.7.0";
var VENDORED_ADLC_ANTIGRAVITY_TARBALL = `vendor/cache/adlc-antigravity-${BUNDLED_ADLC_ANTIGRAVITY_VERSION}.tgz`;
var INSTALL_COPY_EXCLUSIONS = Object.freeze(["node_modules", ".worktrees", ".git"]);
var STAGE_COPY_EXCLUSIONS = Object.freeze([...INSTALL_COPY_EXCLUSIONS, "maintainer-skills", ".claude", ".agents"]);

// lib/doctor.mjs
import { execFile as execFile2, execFileSync as execFileSync2, execSync, spawnSync } from "child_process";
import { promisify as promisify2 } from "util";

// lib/semver.mjs
var NUM = "(0|[1-9]\\d*)";
var PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
var BUILD_ID = "[0-9A-Za-z-]+";
var RE = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?$`
);

// node_modules/@adlc/tickets/lib/pointer.mjs
var MAX_POINTER_BYTES = 64 * 1024;
var DEPRECATED_ID_KEYS = Object.freeze(["ticket", "ticketId"]);

// node_modules/@adlc/tickets/lib/constants.mjs
var ACTIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-directory", version: 1 });
var ARCHIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-archive", version: 1 });

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
    summary: "Positive number (number > 0) giving the relative build-time estimate used to order the ticket DAG. Defaults to 1.",
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
    summary: "Path globs frozen for the duration of the build; rails-guard denies edits to them. Each rail must match at least one file in the repository when it is added, or the write is refused (RAIL_MATCHES_NOTHING). Narrowing rails, widening scope, or changing `completed` on an existing ticket requires `--authorize` (see `adlc ticket update --help`); `ADLC_RAILS_BYPASS` governs only the `rails-guard` hook/CLI check on direct store-path edits, not `adlc ticket` writes.",
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
    summary: 'Array of edge objects (each with a non-empty string "to" id) giving ordering constraints, prerequisite to dependent: this ticket completes before `to` (an edge with "to": "TX" on THIS ticket means this ticket must complete before TX \u2014 so making this ticket depend on an existing one is an edge added to that existing ticket, never a reversed edge here). An edge may also carry "contract": a path to the interface it guarantees TX can consume, which is what lets the two be built in parallel; ticket-sync recognizes it and nothing else on an edge.',
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["to"],
        properties: {
          to: { type: "string", minLength: 1, description: "Id of the dependent ticket (this ticket completes before `to`, which must not start before this one completes)." },
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

// node_modules/@adlc/tickets/lib/generated-glob-match.mjs
var SLASH = "/".charCodeAt(0);

// node_modules/@adlc/tickets/lib/manifest-rails.mjs
var MANIFEST_BASENAMES = Object.freeze(["package.json", "plugin.json", "marketplace.json"]);

// node_modules/@adlc/tickets/lib/rail-existence.mjs
var GIT_MAX_BUFFER = 256 * 1024 * 1024;

// node_modules/@adlc/tickets/lib/prompt.mjs
import { createInterface } from "node:readline/promises";

// node_modules/@adlc/tickets/lib/stores/git-tree.mjs
var MAX_BUFFER = 64 * 1024 * 1024;

// lib/adlc-bridge.mjs
var PLUGIN_CONTRACT_STATUSES = Object.freeze(["compatible", "tolerant", "incompatible", "unreadable", "corrupt"]);
var KNOWN_VENDORED_ADLC = Object.freeze({
  version: "1.13.0",
  binarySha256: "3a4a8883bae7bbe624d021e9b544c32f99a5803b1451ef17b2e57eb81c3413f6",
  vendoredBundleSha256: "63822430cceed99b20301de770460538cfc614021bdddd90bdaf987e381c85b3",
  treeDigest: "c25d24e9096a17a7239b77a08c2fbc2cecc9a971a4696e237c489e694f598726"
});
var STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS = Object.freeze({
  "1.7.0": "c9bad8ac16bf47cdc7001645ed6d4ffb77997e91063fe983084d151e3f840754"
});

// lib/doctor-models.mjs
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// lib/worktrees.mjs
var NULL_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

// lib/doctor.mjs
var execFileAsync2 = promisify2(execFile2);
var SELFTEST_RAIL = "lib/lock.mjs";
var SELFTEST_REASON = `Target path matches frozen rail: ${SELFTEST_RAIL}`;

// lib/agy.mjs
var MAX_STREAM_LINE_BYTES = 1024 * 1024;
var MAX_STREAM_TOTAL_BYTES = 50 * 1024 * 1024;
var MAX_CONSECUTIVE_GARBAGE_BYTES = 5 * 1024 * 1024;
var MAX_ARGV_PROMPT_BYTES = 24 * 1024;
var ALL_AGY_ERROR_KINDS = Object.freeze([
  "containment_unavailable",
  "stream_overflow",
  "stream_corruption",
  "timeout",
  "spawn",
  "signal",
  "interrupted",
  "model_unavailable",
  "envelope_error",
  "server",
  "server_shutdown_error",
  "cli",
  "missing_terminal_result",
  "missing_structured_output",
  "schema_violation",
  "empty",
  "unclassified"
]);

// lib/pools.mjs
import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  rmSync,
  lstatSync,
  realpathSync,
  statSync,
  constants,
  fstatSync,
  chmodSync,
  writeSync
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync as execFileSync3, execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileP = promisify3(execFile3);
var RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function getV2StateFile() {
  if (process.env.AGB_POOLS_V2) return process.env.AGB_POOLS_V2;
  if (process.env.AGB_POOLS_DIR) return join(process.env.AGB_POOLS_DIR, "agb_pools_v2.json");
  if (process.env.AGB_QUOTA_STATE) {
    return process.env.AGB_QUOTA_STATE.endsWith(".json") ? process.env.AGB_QUOTA_STATE.slice(0, -5) + "_v2.json" : process.env.AGB_QUOTA_STATE + "_v2.json";
  }
  return join(tmpdir(), "agb_pools_v2.json");
}
var IS_BUNDLED_POOLS = true;
function isBundledPoolsRuntime() {
  return IS_BUNDLED_POOLS || true;
}
function getStatusLineQuotaFile() {
  return !isBundledPoolsRuntime() && process.env.AGB_STATUSLINE_QUOTA_FILE ? process.env.AGB_STATUSLINE_QUOTA_FILE : join(dirname(getV2StateFile()), "agb_statusline_quota.json");
}
function isValidStatusLinePoolWindow(poolObj, nowMs) {
  if (!poolObj || typeof poolObj !== "object" || Array.isArray(poolObj)) return false;
  const {
    fiveHourRemainingPercent: p5h,
    weeklyRemainingPercent: pWeekly,
    fiveHourResetTime: r5h,
    weeklyResetTime: rWeekly
  } = poolObj;
  if (typeof p5h !== "number" || !Number.isFinite(p5h) || p5h < 0 || p5h > 100) return false;
  if (typeof pWeekly !== "number" || !Number.isFinite(pWeekly) || pWeekly < 0 || pWeekly > 100) return false;
  if (typeof r5h !== "string" || !RFC3339_UTC_RE.test(r5h)) return false;
  if (typeof rWeekly !== "string" || !RFC3339_UTC_RE.test(rWeekly)) return false;
  const t5h = Date.parse(r5h);
  const tWeekly = Date.parse(rWeekly);
  if (!Number.isFinite(t5h) || t5h < nowMs - 1e4) return false;
  if (!Number.isFinite(tWeekly) || tWeekly < nowMs - 1e4) return false;
  return true;
}
function isValidNormalizedQuotaPayload(normalizedQuota, nowMs) {
  if (!normalizedQuota || typeof normalizedQuota !== "object" || Array.isArray(normalizedQuota)) return false;
  return isValidStatusLinePoolWindow(normalizedQuota.gemini, nowMs) && isValidStatusLinePoolWindow(normalizedQuota.claude_gpt, nowMs);
}
function readFreshStatusLineQuotaCache({ maxAgeMs = 6e4, nowMs = Date.now() } = {}) {
  try {
    if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs)) return null;
    const file = getStatusLineQuotaFile();
    const dir = dirname(file);
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    const fileStat = lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt)) return null;
    if (nowMs - data.updatedAt > maxAgeMs) return null;
    if (data.updatedAt > nowMs + 1e4) return null;
    if (!isValidNormalizedQuotaPayload(data.quota, nowMs)) return null;
    if (!data.quota["claude-gpt"] || typeof data.quota["claude-gpt"] !== "object") {
      data.quota["claude-gpt"] = { ...data.quota.claude_gpt };
    }
    return { updatedAt: data.updatedAt, quota: data.quota };
  } catch {
    return null;
  }
}
var TIER_QUOTA_PRIORS = Object.freeze({
  cheap: 1,
  mid: 3,
  frontier: 7.5
});

// lib/control-ipc.mjs
import { execFileSync as execFileSync4 } from "node:child_process";
import net from "node:net";
import { dirname as dirname2, isAbsolute, join as join2, relative, resolve as resolve2 } from "node:path";
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  realpathSync as realpathSync2,
  renameSync as renameSync2,
  rmSync as rmSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
function getProcessStartTime2(pid) {
  if (!pid || typeof pid !== "number") return null;
  try {
    if (process.platform === "linux") {
      const content = readFileSync2(`/proc/${pid}/stat`, "utf8");
      const closeParen = content.lastIndexOf(")");
      if (closeParen !== -1) {
        const rest = content.slice(closeParen + 2).trim().split(/\s+/);
        return rest[19] ?? null;
      }
    } else if (process.platform === "darwin") {
      const out = execFileSync4("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      return out || null;
    } else if (process.platform === "win32") {
      const out = execFileSync4(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      return out || null;
    }
  } catch {
  }
  return null;
}
function isProcessAlive2(pid, expectedStartTime = null) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return false;
  }
  if (expectedStartTime) {
    const curStart = getProcessStartTime2(pid);
    if (!curStart || curStart !== expectedStartTime) {
      return false;
    }
  }
  return true;
}
var MAX_REQUEST_BYTES = 64 * 1024;
var MAX_RESPONSE_BYTES = 256 * 1024;
function resolveCanonicalRepo(repo) {
  const resolved = resolve2(repo);
  try {
    return realpathSync2(resolved);
  } catch {
    return resolved;
  }
}
function readControlMetadata(repo) {
  const rawResolved = resolve2(repo);
  const rawBooster = join2(rawResolved, ".booster");
  const rawControl = join2(rawBooster, "control.json");
  for (const p of [rawBooster, rawControl]) {
    let st;
    try {
      st = lstatSync2(p);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") continue;
      return { ok: false, symlink: false, error: err.message };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, symlink: true, error: `Security violation: symbolic link not allowed: ${p}` };
    }
  }
  const canonicalRepo = resolveCanonicalRepo(repo);
  const boosterDir = join2(canonicalRepo, ".booster");
  const controlFile = join2(boosterDir, "control.json");
  let boosterSt;
  try {
    boosterSt = lstatSync2(boosterDir);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, error: err.message };
  }
  if (boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) {
    return { ok: false, symlink: true, error: `Security violation: invalid .booster directory: ${boosterDir}` };
  }
  let ctrlSt;
  try {
    ctrlSt = lstatSync2(controlFile);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, error: err.message };
  }
  if (ctrlSt.isSymbolicLink() || !ctrlSt.isFile()) {
    return { ok: false, symlink: true, error: `Security violation: invalid control.json file: ${controlFile}` };
  }
  try {
    const parsed = JSON.parse(readFileSync2(controlFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, malformed: true };
    }
    return { ok: true, control: parsed, controlFile };
  } catch {
    return { ok: false, malformed: true };
  }
}
async function sendControlCommand(repo, command, { timeoutMs = 3e3 } = {}) {
  const metaRes = readControlMetadata(repo);
  if (!metaRes.ok) {
    return {
      ok: false,
      offline: true,
      error: metaRes.symlink ? metaRes.error : "no active run control server"
    };
  }
  const ctrl = metaRes.control;
  if (typeof ctrl.endpoint !== "string" || !ctrl.endpoint || typeof ctrl.token !== "string" || !ctrl.token || typeof ctrl.pid !== "number" || !isProcessAlive2(ctrl.pid, ctrl.startTime ?? null)) {
    return { ok: false, offline: true, error: "no active run control server" };
  }
  if (process.platform !== "win32") {
    try {
      const sockSt = lstatSync2(ctrl.endpoint);
      if (sockSt.isSymbolicLink()) {
        return {
          ok: false,
          offline: true,
          error: `Security violation: control socket is a symbolic link: ${ctrl.endpoint}`
        };
      }
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { ok: false, offline: true, error: "no active run control server" };
      }
      return { ok: false, offline: true, error: err.message };
    }
  }
  return new Promise((resolveResult) => {
    let settled = false;
    let chunks = [];
    let totalBytes = 0;
    const socket = net.createConnection(ctrl.endpoint);
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
      }
      resolveResult(res);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, offline: true, error: `control command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      try {
        const payload = JSON.stringify({ ...command ?? {}, token: ctrl.token }) + "\n";
        socket.write(payload);
      } catch (err) {
        finish({ ok: false, offline: true, error: err.message });
      }
    });
    const parseLine = (rawLine) => {
      try {
        const parsed = JSON.parse(rawLine);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish({ ok: false, error: "invalid response from control server" });
          return;
        }
        finish(parsed);
      } catch (err) {
        finish({ ok: false, error: `invalid JSON from control server: ${err.message}` });
      }
    };
    socket.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const nlIdx = buf.indexOf(10);
      const added = nlIdx === -1 ? buf.length : nlIdx;
      if (totalBytes + added > MAX_RESPONSE_BYTES) {
        finish({ ok: false, error: "control response payload too large" });
        return;
      }
      if (nlIdx === -1) {
        chunks.push(buf);
        totalBytes += buf.length;
        return;
      }
      if (nlIdx > 0) chunks.push(buf.subarray(0, nlIdx));
      const rawLine = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
      chunks = [];
      parseLine(rawLine);
    });
    socket.on("end", () => {
      if (settled) return;
      if (chunks.length > 0) {
        const rawLine = Buffer.concat(chunks).toString("utf8").trim();
        chunks = [];
        if (rawLine) {
          parseLine(rawLine);
          return;
        }
      }
      finish({ ok: false, offline: true, error: "control connection closed without response" });
    });
    socket.on("error", (err) => {
      finish({ ok: false, offline: true, error: err.message });
    });
    socket.on("close", () => {
      if (!settled) {
        finish({ ok: false, offline: true, error: "control connection closed" });
      }
    });
  });
}

// lib/plan-integrity.mjs
import { basename, dirname as dirname3, isAbsolute as isAbsolute2, join as join3, posix, relative as relative2, resolve as resolve3, sep } from "node:path";

// node_modules/@adlc/core/lib/glob.mjs
var SLASH2 = "/".charCodeAt(0);

// node_modules/@adlc/core/lib/tickets.mjs
var TICKET_TRUST_ROOT_RAILS = Object.freeze([
  ".adlc/tickets.json",
  ".adlc/tickets/.store.json",
  ".adlc/tickets/**",
  ".adlc/current-ticket.json"
]);
function validateTicket2(t) {
  return validateTicket(t);
}
function topoSort(tickets) {
  const ids = tickets.map((t) => t.id);
  const indegree = Object.fromEntries(ids.map((id) => [id, 0]));
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      out[t.id].push(e.to);
      indegree[e.to] += 1;
    }
  }
  const queue = ids.filter((id) => indegree[id] === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of out[id]) {
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  if (order.length !== ids.length) {
    return { order, cycle: ids.filter((id) => !order.includes(id)) };
  }
  return { order, cycle: null };
}

// lib/plan-integrity.mjs
var TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
var PATHSPEC_RE = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\*{1,2}(?:\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\*[a-zA-Z0-9_.-]*)(?:\/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\*{1,2}(?:\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\*[a-zA-Z0-9_.-]*))*$/;
function normalizePathspec(p) {
  if (typeof p !== "string") return p;
  if (p.endsWith("/") && p !== "/") {
    return `${p}**`;
  }
  return p;
}
function validatePathspec(p, { allowRootWildcard = false } = {}) {
  if (typeof p !== "string") return false;
  if (p === "*" && allowRootWildcard) return true;
  if (p === "*" || p === "**" || p === ".") return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) return false;
  const segments = p.split("/");
  if (segments.some((s) => s === "." || s === ".." || s === "")) return false;
  if (posix.normalize(p) !== p) return false;
  return PATHSPEC_RE.test(p);
}
function validatePlan(plan, { strictGates = true } = {}) {
  const errors = [];
  if (!plan.repo) errors.push("plan.repo is required (absolute path to target repo)");
  if (plan.adlcBin !== void 0) {
    errors.push("plan.adlcBin is prohibited: ADLC binary must be resolved and authenticated by the runtime");
  }
  if (plan.disableOrchestrator !== void 0 && typeof plan.disableOrchestrator !== "boolean") {
    errors.push("plan.disableOrchestrator must be a boolean when provided");
  }
  const NPM_GATE_RE = /^npm (test|run [a-zA-Z0-9_:-]+)$/;
  if (!plan.gate || typeof plan.gate !== "object" || Array.isArray(plan.gate) || !plan.gate.build && !plan.gate.test) {
    errors.push("plan.gate must declare at least one of build/test commands");
  } else {
    const extraGateKeys = Object.keys(plan.gate).filter((k) => k !== "build" && k !== "test" && k !== "autofix");
    if (extraGateKeys.length) {
      errors.push(`plan.gate contains unsupported key(s): ${extraGateKeys.join(", ")} (only autofix, build, and test are allowed)`);
    }
    for (const k of ["autofix", "build", "test"]) {
      if (plan.gate[k] !== void 0 && (typeof plan.gate[k] !== "string" || !plan.gate[k].trim())) {
        errors.push(`plan.gate.${k} must be a non-empty string`);
      }
    }
    if (strictGates) {
      if (plan.gate.autofix && !NPM_GATE_RE.test(plan.gate.autofix)) {
        errors.push(`plan.gate.autofix must match ${NPM_GATE_RE} (got '${plan.gate.autofix}')`);
      }
      if (plan.gate.build && !NPM_GATE_RE.test(plan.gate.build)) {
        errors.push(`plan.gate.build must match ${NPM_GATE_RE} (got '${plan.gate.build}')`);
      }
      if (plan.gate.test && !NPM_GATE_RE.test(plan.gate.test)) {
        errors.push(`plan.gate.test must match ${NPM_GATE_RE} (got '${plan.gate.test}')`);
      }
    }
  }
  if (!Array.isArray(plan.tickets)) {
    errors.push(plan.tickets === void 0 ? "plan.tickets is empty" : "plan.tickets must be an array");
    return errors;
  }
  if (!plan.tickets.length) errors.push("plan.tickets is empty");
  for (const t of plan.tickets) errors.push(...validateTicket2(t));
  const ids = /* @__PURE__ */ new Set();
  const normalized = /* @__PURE__ */ new Map();
  for (const t of plan.tickets ?? []) {
    if (!t.id) continue;
    if (ids.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
    if (!TICKET_ID_RE.test(t.id)) {
      errors.push(`${t.id}: ticket id must match ${TICKET_ID_RE} \u2014 it is used as a worktree directory name and a git branch name`);
    }
    const key = t.id.toLowerCase();
    const clash = normalized.get(key);
    if (clash !== void 0 && clash !== t.id) {
      errors.push(`${t.id}: ticket id collides with '${clash}' \u2014 both resolve to worktree agb-${key} and branch agb/${key}, and creating the second would destroy the first`);
    }
    normalized.set(key, t.id);
    ids.add(t.id);
  }
  for (const t of plan.tickets ?? []) {
    for (const e of t.edges ?? []) {
      if (!e || typeof e !== "object" || typeof e.to !== "string" || !e.to.trim()) {
        errors.push(`${t.id}: edge must declare a valid 'to' field`);
        continue;
      }
      if (e.to === t.id) {
        errors.push(`${t.id}: self-dependency edge to '${t.id}' is prohibited`);
      } else if (!ids.has(e.to)) {
        errors.push(`${t.id}: edge to unknown ticket '${e.to}'`);
      }
    }
    if (typeof t.body !== "string" || !t.body.trim()) {
      errors.push(`${t.id}: body (full self-contained spec text) is required \u2014 without it the builder charter renders an empty specification`);
    }
    if (!Array.isArray(t.scope) || !t.scope.length) {
      errors.push(`${t.id}: scope must be a non-empty array of globs \u2014 an empty scope disables the out-of-scope check entirely`);
    } else {
      t.scope = t.scope.map(normalizePathspec);
      for (const s of t.scope) {
        if (!validatePathspec(s, { allowRootWildcard: !strictGates })) {
          errors.push(`${t.id}: invalid scope pathspec '${s}'`);
        }
      }
    }
    if (Array.isArray(t.rails)) {
      t.rails = t.rails.map(normalizePathspec);
      for (const r of t.rails) {
        if (!validatePathspec(r)) {
          errors.push(`${t.id}: invalid rail pathspec '${r}'`);
        }
      }
    }
    if (t.tier !== void 0 && !TIER_CANDIDATES[t.tier]) {
      errors.push(`${t.id}: unknown tier '${t.tier}' (cheap|mid|frontier)`);
    }
    if (t.effort !== void 0 && !VALID_EFFORTS.includes(t.effort)) {
      errors.push(`${t.id}: unknown effort '${t.effort}' (${VALID_EFFORTS.join("|")})`);
    }
    if (t.pool_hint !== void 0 && !["gemini", "claude", "claude-gpt", "gpt-oss", "auto"].includes(t.pool_hint)) {
      errors.push(`${t.id}: unknown pool_hint '${t.pool_hint}' (gemini|claude|claude-gpt|gpt-oss|auto)`);
    } else if (!tierCandidates(t.tier ?? "mid", t.pool_hint).length) {
      errors.push(`${t.id}: no model candidates for tier '${t.tier ?? "mid"}' with pool_hint '${t.pool_hint}'`);
    }
  }
  const hasMalformedEdges = (plan.tickets ?? []).some(
    (t) => !t || !t.id || (t.edges ?? []).some((e) => !e || typeof e !== "object" || typeof e.to !== "string")
  );
  if (!hasMalformedEdges) {
    try {
      const { cycle } = topoSort(plan.tickets ?? []);
      if (cycle) errors.push(`cycle in ticket DAG: ${cycle.join(", ")}`);
    } catch (err) {
      errors.push(`topological sort error: ${err.message}`);
    }
  }
  return errors;
}

// mcp/ui-views.mjs
var MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
var DEFAULT_CSP_META = Object.freeze({
  ui: Object.freeze({
    csp: Object.freeze({
      resourceDomains: Object.freeze([]),
      connectDomains: Object.freeze([])
    })
  })
});
function cloneCspMeta() {
  return {
    ui: {
      csp: {
        resourceDomains: [],
        connectDomains: []
      }
    }
  };
}
var SHARED_CSS = [
  ":root {",
  "  --bg: var(--agy-bg, #0f1117);",
  "  --surface: var(--agy-surface, #161b26);",
  "  --fg: var(--agy-fg, #e6edf3);",
  "  --muted: var(--agy-muted, #8b949e);",
  "  --border: var(--agy-border, #2a3245);",
  "  --accent: var(--agy-accent, #4da3ff);",
  "  --ok: var(--agy-success, #3fb950);",
  "  --warn: var(--agy-warning, #d29922);",
  "  --err: var(--agy-danger, #f85149);",
  "  color-scheme: dark light;",
  "}",
  "@media (prefers-color-scheme: light) {",
  "  :root {",
  "    --bg: var(--agy-bg, #f6f8fa);",
  "    --surface: var(--agy-surface, #ffffff);",
  "    --fg: var(--agy-fg, #1f2328);",
  "    --muted: var(--agy-muted, #57606a);",
  "    --border: var(--agy-border, #d0d7de);",
  "    --accent: var(--agy-accent, #0969da);",
  "    --ok: var(--agy-success, #1a7f37);",
  "    --warn: var(--agy-warning, #9a6700);",
  "    --err: var(--agy-danger, #cf222e);",
  "  }",
  "}",
  "* { box-sizing: border-box; }",
  "html, body {",
  "  margin: 0;",
  "  padding: 0;",
  "  background: var(--bg);",
  "  color: var(--fg);",
  '  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
  "  font-size: 13px;",
  "  line-height: 1.45;",
  "}",
  ".shell { padding: 12px; display: flex; flex-direction: column; gap: 10px; }",
  ".card {",
  "  background: var(--surface);",
  "  border: 1px solid var(--border);",
  "  border-radius: 8px;",
  "  padding: 10px 12px;",
  "}",
  ".row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
  ".space-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }",
  "h1, h2, h3 { margin: 0; font-weight: 600; }",
  "h1 { font-size: 15px; }",
  "h2 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }",
  ".badge {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: 4px;",
  "  padding: 2px 8px;",
  "  border-radius: 999px;",
  "  font-size: 11px;",
  "  font-weight: 600;",
  "  border: 1px solid var(--border);",
  "  background: rgba(127, 127, 127, 0.12);",
  "}",
  ".badge.ok { color: var(--ok); border-color: var(--ok); }",
  ".badge.warn { color: var(--warn); border-color: var(--warn); }",
  ".badge.err { color: var(--err); border-color: var(--err); }",
  ".badge.accent { color: var(--accent); border-color: var(--accent); }",
  "button, .pill {",
  "  appearance: none;",
  "  border: 1px solid var(--border);",
  "  background: var(--surface);",
  "  color: var(--fg);",
  "  border-radius: 6px;",
  "  padding: 5px 10px;",
  "  font-size: 12px;",
  "  font-weight: 500;",
  "  cursor: pointer;",
  "}",
  "button:hover, .pill:hover { border-color: var(--accent); }",
  "button.primary { background: var(--accent); color: #ffffff; border-color: var(--accent); }",
  "button.danger { border-color: var(--err); color: var(--err); }",
  "button:disabled { opacity: 0.5; cursor: not-allowed; }",
  ".pill.active { border-color: var(--accent); color: var(--accent); background: rgba(77, 163, 255, 0.14); }",
  "table { width: 100%; border-collapse: collapse; font-size: 12px; }",
  "th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }",
  "th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }",
  "pre {",
  "  margin: 0;",
  "  padding: 8px 10px;",
  "  background: var(--bg);",
  "  border: 1px solid var(--border);",
  "  border-radius: 6px;",
  "  overflow: auto;",
  "  max-height: 280px;",
  "  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;",
  "  font-size: 11px;",
  "  white-space: pre-wrap;",
  "  word-break: break-word;",
  "}",
  ".meter { width: 100%; height: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }",
  ".meter-fill { height: 100%; background: var(--accent); transition: width 120ms ease; }",
  ".meter-fill.ok { background: var(--ok); }",
  ".meter-fill.warn { background: var(--warn); }",
  ".meter-fill.err { background: var(--err); }",
  ".grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }",
  ".muted { color: var(--muted); }",
  ".dag-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); padding: 8px; }",
  "input, select, textarea {",
  "  width: 100%;",
  "  background: var(--bg);",
  "  color: var(--fg);",
  "  border: 1px solid var(--border);",
  "  border-radius: 6px;",
  "  padding: 6px 8px;",
  "  font-family: inherit;",
  "  font-size: 12px;",
  "}",
  "textarea { min-height: 70px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }",
  ".field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }",
  ".field label { font-size: 11px; font-weight: 600; color: var(--muted); }",
  ".status-line { font-size: 12px; color: var(--muted); min-height: 18px; }"
].join("\n");
var SHARED_RUNTIME_JS = [
  "function escapeHtml(str) {",
  '  return String(str == null ? "" : str)',
  '    .replace(/&/g, "&amp;")',
  '    .replace(/</g, "&lt;")',
  '    .replace(/>/g, "&gt;")',
  '    .replace(/"/g, "&quot;")',
  `    .replace(/'/g, "&#39;");`,
  "}",
  "",
  "const __bridge = (() => {",
  "  let nextId = 1;",
  "  const pending = new Map();",
  "  let inFlight = 0;",
  "  const MAX_IN_FLIGHT = 4;",
  "  const waitQueue = [];",
  "  let lastToolInput = {};",
  "  const resultListeners = [];",
  "  const inputListeners = [];",
  "",
  "  function post(payload) {",
  '    if (typeof window !== "undefined" && window.parent && typeof window.parent.postMessage === "function") {',
  '      window.parent.postMessage(payload, "*");',
  "    }",
  "  }",
  "",
  "  function sendNotification(method, params) {",
  '    post({ jsonrpc: "2.0", method: method, params: params || {} });',
  "  }",
  "",
  "  function sendRequest(method, params, timeoutMs) {",
  '    const limit = typeof timeoutMs === "number" ? timeoutMs : 15000;',
  "    const id = nextId++;",
  "    return new Promise((resolve, reject) => {",
  "      const timer = setTimeout(() => {",
  "        if (pending.has(id)) {",
  "          pending.delete(id);",
  '          reject(new Error("RPC timeout: " + method));',
  "        }",
  "      }, limit);",
  "      pending.set(id, { resolve: resolve, reject: reject, timer: timer });",
  '      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });',
  "    });",
  "  }",
  "",
  "  function acquireSlot() {",
  "    if (inFlight < MAX_IN_FLIGHT) {",
  "      inFlight += 1;",
  "      return Promise.resolve();",
  "    }",
  "    return new Promise((resolve) => waitQueue.push(resolve));",
  "  }",
  "",
  "  function releaseSlot() {",
  "    const next = waitQueue.shift();",
  "    if (next) {",
  "      next();",
  "    } else {",
  "      inFlight = Math.max(0, inFlight - 1);",
  "    }",
  "  }",
  "",
  "  async function callTool(name, args) {",
  "    await acquireSlot();",
  "    try {",
  '      return await sendRequest("tools/call", { name: name, arguments: args || {} });',
  "    } finally {",
  "      releaseSlot();",
  "    }",
  "  }",
  "",
  "  function readResource(uri) {",
  '    return sendRequest("resources/read", { uri: uri });',
  "  }",
  "",
  "  function writeResource(uri, text, extra) {",
  '    return sendRequest("com.google.antigravity/resources/write", Object.assign({ uri: uri, text: text }, extra || {}));',
  "  }",
  "",
  "  function sendUiMessage(text, role) {",
  '    return sendRequest("ui/message", {',
  '      role: role || "user",',
  '      content: { type: "text", text: String(text == null ? "" : text) },',
  "    });",
  "  }",
  "",
  "  function updateModelContext(ctx) {",
  '    return sendRequest("ui/update-model-context", ctx || {});',
  "  }",
  "",
  "  function toggleAuxPane(opts) {",
  '    return sendRequest("com.google.antigravity/toggle-aux-pane", opts || {});',
  "  }",
  "",
  "  function extractStructured(params) {",
  '    if (!params || typeof params !== "object") return null;',
  '    if (params.structuredContent && typeof params.structuredContent === "object") return params.structuredContent;',
  '    if (params.result && params.result.structuredContent && typeof params.result.structuredContent === "object") {',
  "      return params.result.structuredContent;",
  "    }",
  "    const content = Array.isArray(params.content) ? params.content : (params.result && Array.isArray(params.result.content) ? params.result.content : null);",
  '    if (content && content[0] && typeof content[0].text === "string") {',
  "      try {",
  "        const parsed = JSON.parse(content[0].text);",
  '        if (parsed && typeof parsed === "object") return parsed;',
  "      } catch (_e) {",
  "        return { rawText: content[0].text };",
  "      }",
  "    }",
  "    return null;",
  "  }",
  "",
  '  window.addEventListener("message", (ev) => {',
  "    const msg = ev && ev.data;",
  '    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;',
  "    if (msg.id !== undefined && pending.has(msg.id)) {",
  "      const entry = pending.get(msg.id);",
  "      pending.delete(msg.id);",
  "      clearTimeout(entry.timer);",
  '      if (msg.error) entry.reject(new Error(msg.error.message || "RPC error"));',
  "      else entry.resolve(msg.result);",
  "      return;",
  "    }",
  '    if (msg.method === "ui/notifications/tool-input") {',
  "      lastToolInput = (msg.params && (msg.params.arguments || msg.params)) || {};",
  "      for (const fn of inputListeners) fn(lastToolInput);",
  "      return;",
  "    }",
  '    if (msg.method === "ui/notifications/tool-result") {',
  "      const data = extractStructured(msg.params);",
  "      if (data) {",
  "        for (const fn of resultListeners) fn(data, msg.params);",
  "      }",
  "    }",
  "  });",
  "",
  "  let resizeTimer = null;",
  "  function emitSize() {",
  "    const el = document.documentElement || document.body;",
  "    const height = el ? Math.ceil(el.scrollHeight || 0) : 0;",
  '    sendNotification("ui/notifications/size-changed", { height: height });',
  "  }",
  "  function scheduleSizeReport() {",
  "    if (resizeTimer !== null) clearTimeout(resizeTimer);",
  "    resizeTimer = setTimeout(() => {",
  "      resizeTimer = null;",
  "      emitSize();",
  "    }, 25);",
  "  }",
  '  if (typeof ResizeObserver === "function" && document.documentElement) {',
  "    const ro = new ResizeObserver(() => scheduleSizeReport());",
  "    ro.observe(document.documentElement);",
  "  }",
  "",
  "  function boot(appName) {",
  '    sendRequest("ui/initialize", {',
  '      protocolVersion: "2025-03-26",',
  '      appInfo: { name: appName, version: "2.0.0" },',
  "      appCapabilities: {},",
  "    }).then((res) => {",
  "      if (res && res.toolInput) {",
  "        lastToolInput = res.toolInput.arguments || res.toolInput;",
  "        for (const fn of inputListeners) fn(lastToolInput);",
  "      }",
  "      const initial = res && extractStructured(res.toolResult || res);",
  "      if (initial) {",
  "        for (const fn of resultListeners) fn(initial, res);",
  "      }",
  "      scheduleSizeReport();",
  "    }).catch(() => {",
  "      scheduleSizeReport();",
  "    });",
  "  }",
  "",
  "  return {",
  "    callTool: callTool,",
  "    readResource: readResource,",
  "    writeResource: writeResource,",
  "    sendUiMessage: sendUiMessage,",
  "    updateModelContext: updateModelContext,",
  "    toggleAuxPane: toggleAuxPane,",
  "    extractStructured: extractStructured,",
  "    getToolInput: () => lastToolInput,",
  "    onResult: (fn) => resultListeners.push(fn),",
  "    onInput: (fn) => inputListeners.push(fn),",
  "    scheduleSizeReport: scheduleSizeReport,",
  "    getInFlightCount: () => inFlight,",
  "    boot: boot,",
  "  };",
  "})();",
  "",
  "function renderDagSvg(tickets, selectedId) {",
  "  const list = Array.isArray(tickets) ? tickets.filter((t) => t && t.id) : [];",
  '  if (!list.length) return "<div class=\\"muted\\">No tickets in DAG.</div>";',
  "  const byId = new Map();",
  "  const indeg = new Map();",
  "  const outs = new Map();",
  "  for (const t of list) {",
  "    const id = String(t.id);",
  "    byId.set(id, t);",
  "    indeg.set(id, 0);",
  "    outs.set(id, []);",
  "  }",
  "  for (const t of list) {",
  "    const from = String(t.id);",
  "    const edges = Array.isArray(t.edges) ? t.edges : [];",
  "    for (const e of edges) {",
  '      const to = e && typeof e.to === "string" ? e.to : null;',
  "      if (to && byId.has(to) && to !== from) {",
  "        outs.get(from).push(to);",
  "        indeg.set(to, (indeg.get(to) || 0) + 1);",
  "      }",
  "    }",
  "  }",
  "  const layerOf = new Map();",
  "  const q = [];",
  "  for (const [id, d] of indeg.entries()) {",
  "    if (d === 0) {",
  "      layerOf.set(id, 0);",
  "      q.push(id);",
  "    }",
  "  }",
  "  while (q.length) {",
  "    const cur = q.shift();",
  "    const curLayer = layerOf.get(cur) || 0;",
  "    for (const nxt of outs.get(cur) || []) {",
  "      const cand = curLayer + 1;",
  "      if ((layerOf.get(nxt) || 0) < cand) layerOf.set(nxt, cand);",
  "      indeg.set(nxt, (indeg.get(nxt) || 1) - 1);",
  "      if (indeg.get(nxt) === 0) q.push(nxt);",
  "    }",
  "  }",
  "  for (const t of list) {",
  "    const id = String(t.id);",
  "    if (!layerOf.has(id)) layerOf.set(id, 0);",
  "  }",
  "  const columns = new Map();",
  "  let maxLayer = 0;",
  "  for (const t of list) {",
  "    const id = String(t.id);",
  "    const l = layerOf.get(id) || 0;",
  "    if (l > maxLayer) maxLayer = l;",
  "    if (!columns.has(l)) columns.set(l, []);",
  "    columns.get(l).push(t);",
  "  }",
  "  const nodeW = 168;",
  "  const nodeH = 54;",
  "  const gapX = 52;",
  "  const gapY = 16;",
  "  const pad = 12;",
  "  let maxRows = 1;",
  "  const coords = new Map();",
  "  for (let col = 0; col <= maxLayer; col++) {",
  "    const items = columns.get(col) || [];",
  "    if (items.length > maxRows) maxRows = items.length;",
  "    items.forEach((t, row) => {",
  "      coords.set(String(t.id), {",
  "        x: pad + col * (nodeW + gapX),",
  "        y: pad + row * (nodeH + gapY),",
  "      });",
  "    });",
  "  }",
  "  const width = pad * 2 + (maxLayer + 1) * nodeW + maxLayer * gapX;",
  "  const height = pad * 2 + maxRows * nodeH + Math.max(0, maxRows - 1) * gapY;",
  "  const paths = [];",
  "  for (const [from, targets] of outs.entries()) {",
  "    const a = coords.get(from);",
  "    if (!a) continue;",
  "    for (const to of targets) {",
  "      const b = coords.get(to);",
  "      if (!b) continue;",
  "      const x1 = a.x + nodeW;",
  "      const y1 = a.y + nodeH / 2;",
  "      const x2 = b.x;",
  "      const y2 = b.y + nodeH / 2;",
  "      const cx = (x1 + x2) / 2;",
  '      paths.push("<path d=\\"M" + x1 + "," + y1 + " C" + cx + "," + y1 + " " + cx + "," + y2 + " " + x2 + "," + y2 + "\\" fill=\\"none\\" stroke=\\"var(--accent)\\" stroke-width=\\"1.6\\" opacity=\\"0.75\\"/>");',
  '      paths.push("<polygon points=\\"" + x2 + "," + y2 + " " + (x2 - 6) + "," + (y2 - 3.5) + " " + (x2 - 6) + "," + (y2 + 3.5) + "\\" fill=\\"var(--accent)\\"/>");',
  "    }",
  "  }",
  "  const nodes = list.map((t) => {",
  "    const id = String(t.id);",
  "    const c = coords.get(id) || { x: pad, y: pad };",
  '    const tier = escapeHtml(t.tier || "mid");',
  '    const pool = escapeHtml(t.pool_hint || "auto");',
  "    const safeId = escapeHtml(id);",
  '    const stroke = selectedId === id ? "var(--accent)" : "var(--border)";',
  '    const sw = selectedId === id ? "2" : "1.2";',
  '    return "<g class=\\"dag-node\\" data-ticket-id=\\"" + safeId + "\\" transform=\\"translate(" + c.x + "," + c.y + ")\\" style=\\"cursor:pointer\\">" +',
  '      "<rect width=\\"" + nodeW + "\\" height=\\"" + nodeH + "\\" rx=\\"7\\" fill=\\"var(--surface)\\" stroke=\\"" + stroke + "\\" stroke-width=\\"" + sw + "\\"/>" +',
  '      "<text x=\\"10\\" y=\\"21\\" fill=\\"var(--fg)\\" font-size=\\"12\\" font-weight=\\"600\\">" + safeId + "</text>" +',
  '      "<text x=\\"10\\" y=\\"40\\" fill=\\"var(--muted)\\" font-size=\\"10\\">" + tier + " \xB7 " + pool + "</text>" +',
  '      "</g>";',
  "  });",
  '  return "<div class=\\"dag-wrap\\"><svg width=\\"" + width + "\\" height=\\"" + height + "\\" viewBox=\\"0 0 " + width + " " + height + "\\">" + paths.join("") + nodes.join("") + "</svg></div>";',
  "}"
].join("\n");
function buildHtmlDocument({ title, appName, bodyHtml, viewJs }) {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${title}</title>`,
    "  <style>",
    SHARED_CSS,
    "  </style>",
    "</head>",
    "<body>",
    bodyHtml,
    "  <script>",
    SHARED_RUNTIME_JS,
    viewJs,
    `__bridge.boot(${JSON.stringify(appName)});`,
    "  </script>",
    "</body>",
    "</html>"
  ].join("\n");
}
function buildPlanCardHtml() {
  const bodyHtml = [
    '  <div class="shell">',
    '    <div class="card">',
    '      <div class="space-between">',
    "        <h1>Plan &amp; DAG Readiness</h1>",
    '        <div id="badges" class="row"></div>',
    "      </div>",
    '      <div id="statusLine" class="status-line">Waiting for plan analysis payload\u2026</div>',
    "    </div>",
    '    <div class="card">',
    "      <h2>Ticket Topology</h2>",
    '      <div id="dagContainer" style="margin-top:8px" class="muted">No DAG loaded yet.</div>',
    "    </div>",
    '    <div id="issuesCard" class="card" style="display:none">',
    "      <h2>Diagnostics &amp; Gate Findings</h2>",
    '      <ul id="issuesList" style="margin:6px 0 0 18px;padding:0"></ul>',
    "    </div>",
    '    <div id="rawCard" class="card" style="display:none">',
    "      <h2>Summary Output</h2>",
    '      <pre id="rawPre" style="margin-top:6px"></pre>',
    "    </div>",
    '    <div class="row">',
    '      <button id="btnCompile" type="button" class="primary">Compile Plan</button>',
    '      <button id="btnLaunch" type="button">Launch Fleet</button>',
    '      <button id="btnFlightDeck" type="button">Open Flight Deck</button>',
    "    </div>",
    "  </div>"
  ].join("\n");
  const viewJs = [
    "let planState = {};",
    'const badgesEl = document.getElementById("badges");',
    'const statusEl = document.getElementById("statusLine");',
    'const dagEl = document.getElementById("dagContainer");',
    'const issuesCard = document.getElementById("issuesCard");',
    'const issuesList = document.getElementById("issuesList");',
    'const rawCard = document.getElementById("rawCard");',
    'const rawPre = document.getElementById("rawPre");',
    "",
    "function setStatus(msg) {",
    '  statusEl.textContent = String(msg || "");',
    "}",
    "",
    "function renderPlanCard(data) {",
    "  planState = data || {};",
    "  const badges = [];",
    "  const okVal = planState.ok !== undefined ? Boolean(planState.ok) : !Array.isArray(planState.blocking) || planState.blocking.length === 0;",
    '  badges.push("<span class=\\"badge " + (okVal ? "ok" : "err") + "\\">" + (okVal ? "READY" : "BLOCKED") + "</span>");',
    '  if (typeof planState.readinessScore === "number") {',
    '    const cls = planState.readinessScore >= 80 ? "ok" : (planState.readinessScore >= 50 ? "warn" : "err");',
    '    badges.push("<span class=\\"badge " + cls + "\\">Readiness " + escapeHtml(planState.readinessScore) + "%</span>");',
    "  }",
    '  if (planState.fastPath) badges.push("<span class=\\"badge accent\\">Fast-Path</span>");',
    '  if (planState.structured) badges.push("<span class=\\"badge accent\\">Structured</span>");',
    '  if (typeof planState.attempts === "number") badges.push("<span class=\\"badge\\">Attempts " + escapeHtml(planState.attempts) + "</span>");',
    '  badgesEl.innerHTML = badges.join("");',
    "",
    "  const tickets = Array.isArray(planState.tickets) ? planState.tickets : [];",
    "  dagEl.innerHTML = renderDagSvg(tickets, null);",
    '  setStatus(tickets.length ? (tickets.length + " ticket(s) in topological graph") : "Gate telemetry hydrated");',
    "",
    "  const messages = [];",
    '  for (const e of (planState.errors || [])) messages.push("Error: " + String(e));',
    '  for (const b of (planState.blocking || [])) messages.push("Blocking: " + String(b));',
    '  for (const w of (planState.couplingWarnings || [])) messages.push("Coupling: " + (typeof w === "string" ? w : JSON.stringify(w)));',
    '  for (const o of (planState.overlaps || [])) messages.push("Overlap: " + (typeof o === "string" ? o : JSON.stringify(o)));',
    '  for (const g of (planState.gaps || [])) messages.push("Coldstart gap: " + (typeof g === "string" ? g : JSON.stringify(g)));',
    '  for (const m of (planState.missingRails || [])) messages.push("Missing rail: " + (typeof m === "string" ? m : JSON.stringify(m)));',
    '  if (planState.cycle) messages.push("Cycle: " + JSON.stringify(planState.cycle));',
    "  if (planState.premortem && Array.isArray(planState.premortem.causes)) {",
    '    for (const c of planState.premortem.causes) messages.push("Premortem: " + String((c && c.cause) || JSON.stringify(c)));',
    "  }",
    "  if (messages.length) {",
    '    issuesCard.style.display = "block";',
    '    issuesList.innerHTML = messages.map((m) => "<li>" + escapeHtml(m) + "</li>").join("");',
    "  } else {",
    '    issuesCard.style.display = "none";',
    '    issuesList.innerHTML = "";',
    "  }",
    '  if (typeof planState.rawText === "string" && planState.rawText.trim()) {',
    '    rawCard.style.display = "block";',
    "    rawPre.textContent = planState.rawText;",
    "  } else {",
    '    rawCard.style.display = "none";',
    '    rawPre.textContent = "";',
    "  }",
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    "__bridge.onResult(renderPlanCard);",
    "",
    'document.getElementById("btnCompile").addEventListener("click", async () => {',
    "  const inp = __bridge.getToolInput() || {};",
    '  const spec = inp.spec || planState.spec || "spec.md";',
    '  const repo = inp.repo || planState.repo || ".";',
    '  setStatus("Compiling plan.json\u2026");',
    "  try {",
    '    const res = await __bridge.callTool("agb_plan", { spec: spec, repo: repo, force: true });',
    "    const next = __bridge.extractStructured(res);",
    "    if (next) renderPlanCard(next);",
    '    setStatus("Plan compiled.");',
    "  } catch (err) {",
    '    setStatus("Compile failed: " + err.message);',
    "  }",
    "});",
    "",
    'document.getElementById("btnLaunch").addEventListener("click", async () => {',
    "  const inp = __bridge.getToolInput() || {};",
    '  const planPath = inp.plan || inp.out || "plan.json";',
    '  setStatus("Launching fleet run\u2026");',
    "  try {",
    '    await __bridge.callTool("agb_run", { plan: planPath });',
    '    setStatus("Fleet run completed.");',
    "  } catch (err) {",
    '    setStatus("Launch failed: " + err.message);',
    "  }",
    "});",
    "",
    'document.getElementById("btnFlightDeck").addEventListener("click", async () => {',
    "  const inp = __bridge.getToolInput() || {};",
    "  try {",
    "    await __bridge.toggleAuxPane({",
    '      resourceUri: "ui://agb/flight-deck.html",',
    '      toolName: "agb_flight_deck",',
    "      arguments: inp.repo ? { repo: inp.repo } : {},",
    "    });",
    '    setStatus("Opened Flight Deck auxiliary pane.");',
    "  } catch (err) {",
    '    setStatus("Flight Deck request: " + err.message);',
    "  }",
    "});"
  ].join("\n");
  return buildHtmlDocument({
    title: "AGB Plan & DAG Readiness Card",
    appName: "agb-plan-card",
    bodyHtml,
    viewJs
  });
}
function buildReviewCardHtml() {
  const bodyHtml = [
    '  <div class="shell">',
    '    <div class="card">',
    '      <div class="space-between">',
    "        <h1>Adversarial Review Verdict</h1>",
    '        <div id="verdictBadges" class="row"></div>',
    "      </div>",
    '      <div id="reviewStatus" class="status-line">Waiting for review findings\u2026</div>',
    "    </div>",
    '    <div class="card">',
    '      <div class="row" id="severityPills" style="margin-bottom:6px"></div>',
    '      <div class="row" id="lensPills"></div>',
    "    </div>",
    '    <div id="findingsContainer" class="shell" style="padding:0"></div>',
    '    <div id="rawReviewCard" class="card" style="display:none">',
    "      <h2>Review Output</h2>",
    '      <pre id="rawReviewPre" style="margin-top:6px"></pre>',
    "    </div>",
    '    <div class="row">',
    '      <button id="btnFixAll" type="button" class="primary">Fix / Rebut Findings</button>',
    "    </div>",
    "  </div>"
  ].join("\n");
  const viewJs = [
    "let reviewState = { findings: [] };",
    'let activeSeverity = "all";',
    'let activeLens = "all";',
    'const verdictEl = document.getElementById("verdictBadges");',
    'const statusEl = document.getElementById("reviewStatus");',
    'const sevEl = document.getElementById("severityPills");',
    'const lensEl = document.getElementById("lensPills");',
    'const listEl = document.getElementById("findingsContainer");',
    'const rawCard = document.getElementById("rawReviewCard");',
    'const rawPre = document.getElementById("rawReviewPre");',
    "",
    "function renderFilters() {",
    "  const findings = Array.isArray(reviewState.findings) ? reviewState.findings : [];",
    '  const sevs = ["all", "critical", "high", "medium", "low"];',
    '  const lenses = ["all"];',
    "  for (const f of findings) {",
    '    const l = f && f.lens ? String(f.lens).toLowerCase() : "";',
    "    if (l && !lenses.includes(l)) lenses.push(l);",
    "  }",
    '  sevEl.innerHTML = sevs.map((s) => "<button type=\\"button\\" class=\\"pill" + (activeSeverity === s ? " active" : "") + "\\" data-sev=\\"" + escapeHtml(s) + "\\">Severity: " + escapeHtml(s) + "</button>").join("");',
    '  lensEl.innerHTML = lenses.map((l) => "<button type=\\"button\\" class=\\"pill" + (activeLens === l ? " active" : "") + "\\" data-lens=\\"" + escapeHtml(l) + "\\">Lens: " + escapeHtml(l) + "</button>").join("");',
    "}",
    "",
    "function renderFindings() {",
    "  const findings = Array.isArray(reviewState.findings) ? reviewState.findings : [];",
    "  const filtered = findings.filter((f) => {",
    '    const s = String((f && f.severity) || "medium").toLowerCase();',
    '    const l = String((f && f.lens) || "").toLowerCase();',
    '    if (activeSeverity !== "all" && s !== activeSeverity) return false;',
    '    if (activeLens !== "all" && l !== activeLens) return false;',
    "    return true;",
    "  });",
    "  if (!filtered.length) {",
    '    listEl.innerHTML = "<div class=\\"card muted\\">No matching findings.</div>";',
    "    __bridge.scheduleSizeReport();",
    "    return;",
    "  }",
    "  listEl.innerHTML = filtered.map((f, idx) => {",
    '    const sev = String((f && f.severity) || "info").toLowerCase();',
    '    const cls = (sev === "critical" || sev === "high") ? "err" : (sev === "medium" ? "warn" : "accent");',
    '    const loc = f && f.file ? (String(f.file) + (f.line ? (":" + String(f.line)) : "")) : "";',
    '    const summary = String((f && (f.summary || f.title || f.message)) || "");',
    '    const rec = f && f.recommendation ? String(f.recommendation) : "";',
    '    return "<div class=\\"card\\">" +',
    '      "<div class=\\"space-between\\">" +',
    '        "<div class=\\"row\\">" +',
    '          "<span class=\\"badge " + cls + "\\">" + escapeHtml(sev.toUpperCase()) + "</span>" +',
    '          (f && f.lens ? "<span class=\\"badge\\">" + escapeHtml(f.lens) + "</span>" : "") +',
    '          (loc ? "<span class=\\"muted\\">" + escapeHtml(loc) + "</span>" : "") +',
    '        "</div>" +',
    '        "<button type=\\"button\\" class=\\"rebut-btn\\" data-idx=\\"" + idx + "\\">Fix / Rebut</button>" +',
    '      "</div>" +',
    '      "<div style=\\"margin-top:6px\\">" + escapeHtml(summary) + "</div>" +',
    '      (rec ? "<div class=\\"muted\\" style=\\"margin-top:4px\\">Recommendation: " + escapeHtml(rec) + "</div>" : "") +',
    '    "</div>";',
    '  }).join("");',
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    "function renderReview(data) {",
    "  reviewState = data || {};",
    '  const verdict = String(reviewState.verdict || reviewState.gateVerdict || (reviewState.ok ? "SHIP" : "NO-SHIP"));',
    '  const ship = verdict.toUpperCase() === "SHIP" || Boolean(reviewState.ok);',
    '  const badges = ["<span class=\\"badge " + (ship ? "ok" : "err") + "\\">" + escapeHtml(verdict) + "</span>"];',
    '  if (typeof reviewState.rounds === "number") badges.push("<span class=\\"badge\\">Rounds " + escapeHtml(reviewState.rounds) + "</span>");',
    '  verdictEl.innerHTML = badges.join("");',
    "  const count = Array.isArray(reviewState.findings) ? reviewState.findings.length : 0;",
    '  statusEl.textContent = count + " finding(s) reported";',
    "  renderFilters();",
    "  renderFindings();",
    '  if (typeof reviewState.rawText === "string" && reviewState.rawText.trim() && count === 0) {',
    '    rawCard.style.display = "block";',
    "    rawPre.textContent = reviewState.rawText;",
    "  } else {",
    '    rawCard.style.display = "none";',
    '    rawPre.textContent = "";',
    "  }",
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    'sevEl.addEventListener("click", (ev) => {',
    '  const btn = ev.target && ev.target.closest("[data-sev]");',
    "  if (!btn) return;",
    '  activeSeverity = btn.getAttribute("data-sev") || "all";',
    "  renderFilters();",
    "  renderFindings();",
    "});",
    "",
    'lensEl.addEventListener("click", (ev) => {',
    '  const btn = ev.target && ev.target.closest("[data-lens]");',
    "  if (!btn) return;",
    '  activeLens = btn.getAttribute("data-lens") || "all";',
    "  renderFilters();",
    "  renderFindings();",
    "});",
    "",
    'listEl.addEventListener("click", async (ev) => {',
    '  const btn = ev.target && ev.target.closest(".rebut-btn");',
    "  if (!btn) return;",
    '  const idx = Number(btn.getAttribute("data-idx") || "0");',
    "  const findings = Array.isArray(reviewState.findings) ? reviewState.findings : [];",
    "  const f = findings[idx];",
    "  if (!f) return;",
    '  const prompt = "Please fix or rebut review finding [" + (f.severity || "finding") + "] " + (f.file ? (f.file + ": ") : "") + (f.summary || "");',
    "  try {",
    "    await __bridge.updateModelContext({ reviewFinding: f });",
    "    await __bridge.sendUiMessage(prompt);",
    '    statusEl.textContent = "Sent Fix / Rebut prompt to model.";',
    "  } catch (err) {",
    '    statusEl.textContent = "Action failed: " + err.message;',
    "  }",
    "});",
    "",
    'document.getElementById("btnFixAll").addEventListener("click", async () => {',
    "  const findings = Array.isArray(reviewState.findings) ? reviewState.findings : [];",
    "  const prompt = findings.length",
    '    ? ("Please address or rebut the " + findings.length + " adversarial review finding(s) so the branch converges to SHIP.")',
    '    : "Please review the latest adversarial audit summary and confirm next steps.";',
    "  try {",
    "    await __bridge.sendUiMessage(prompt);",
    '    statusEl.textContent = "Dispatched Fix / Rebut message.";',
    "  } catch (err) {",
    '    statusEl.textContent = "Message dispatch failed: " + err.message;',
    "  }",
    "});",
    "",
    "__bridge.onResult(renderReview);"
  ].join("\n");
  return buildHtmlDocument({
    title: "AGB Adversarial Review Card",
    appName: "agb-review-card",
    bodyHtml,
    viewJs
  });
}
function buildFlightDeckHtml() {
  const bodyHtml = [
    '  <div class="shell">',
    '    <div class="card">',
    '      <div class="space-between">',
    "        <div>",
    "          <h1>Live Fleet Flight Deck</h1>",
    '          <div id="deckStatus" class="status-line">Waiting for run snapshot\u2026</div>',
    "        </div>",
    '        <div class="row">',
    '          <span id="runBadge" class="badge">IDLE</span>',
    '          <button id="btnPause" type="button">Pause</button>',
    '          <button id="btnResume" type="button">Resume</button>',
    '          <button id="btnRefresh" type="button">Refresh</button>',
    "        </div>",
    "      </div>",
    "    </div>",
    '    <div class="grid-2" id="poolCards"></div>',
    '    <div class="card">',
    "      <h2>Tickets</h2>",
    '      <div style="overflow-x:auto;margin-top:6px">',
    "        <table>",
    "          <thead><tr><th>Ticket</th><th>Status</th><th>Model / Pool</th><th>Actions</th></tr></thead>",
    '          <tbody id="ticketRows"><tr><td colspan="4" class="muted">No active tickets.</td></tr></tbody>',
    "        </table>",
    "      </div>",
    "    </div>",
    '    <div class="card">',
    '      <div class="space-between" style="margin-bottom:6px">',
    '        <div class="row">',
    '          <button id="tabStream" type="button" class="pill active">Stream</button>',
    '          <button id="tabDiff" type="button" class="pill">Diff</button>',
    "        </div>",
    '        <span id="inspectorTarget" class="muted">Select a ticket to inspect</span>',
    "      </div>",
    '      <pre id="inspectorPre">No stream or diff loaded.</pre>',
    "    </div>",
    "  </div>"
  ].join("\n");
  const viewJs = [
    "let deckState = {};",
    'let activeTab = "stream";',
    "let selectedTicketId = null;",
    "let pollTimer = null;",
    "let pollingInProgress = false;",
    'const deckStatusEl = document.getElementById("deckStatus");',
    'const runBadgeEl = document.getElementById("runBadge");',
    'const poolCardsEl = document.getElementById("poolCards");',
    'const ticketRowsEl = document.getElementById("ticketRows");',
    'const inspectorTargetEl = document.getElementById("inspectorTarget");',
    'const inspectorPreEl = document.getElementById("inspectorPre");',
    'const tabStreamBtn = document.getElementById("tabStream");',
    'const tabDiffBtn = document.getElementById("tabDiff");',
    "",
    "function currentRepo() {",
    "  const inp = __bridge.getToolInput() || {};",
    "  return deckState.repo || inp.repo || undefined;",
    "}",
    "",
    "function syncPolling() {",
    "  const shouldPoll = Boolean(deckState.run && !deckState.run.done);",
    "  if (shouldPoll && pollTimer === null) {",
    "    pollTimer = setInterval(async () => {",
    "      if (pollingInProgress) return;",
    "      pollingInProgress = true;",
    "      try {",
    "        const repo = currentRepo();",
    '        const res = await __bridge.callTool("agb_control", Object.assign({ action: "snapshot" }, repo ? { repo: repo } : {}));',
    "        const next = __bridge.extractStructured(res);",
    "        if (next) renderFlightDeck(next);",
    "      } catch (_e) {",
    "        // Ignore transient poll errors",
    "      } finally {",
    "        pollingInProgress = false;",
    "      }",
    "    }, 1500);",
    "  } else if (!shouldPoll && pollTimer !== null) {",
    "    clearInterval(pollTimer);",
    "    pollTimer = null;",
    "  }",
    "}",
    "",
    "function renderPools() {",
    "  const q = deckState.quotaCache && deckState.quotaCache.quota ? deckState.quotaCache.quota : {};",
    "  const entries = [",
    '    { label: "Gemini Pool (5h)", pct: q.gemini && q.gemini.fiveHourRemainingPercent },',
    '    { label: "Claude/GPT Pool (5h)", pct: q.claude_gpt && q.claude_gpt.fiveHourRemainingPercent },',
    "  ];",
    "  poolCardsEl.innerHTML = entries.map((e) => {",
    '    const hasVal = typeof e.pct === "number" && Number.isFinite(e.pct);',
    "    const pct = hasVal ? Math.max(0, Math.min(100, Math.round(e.pct))) : 0;",
    '    const cls = !hasVal ? "" : (pct >= 50 ? "ok" : (pct >= 20 ? "warn" : "err"));',
    '    return "<div class=\\"card\\">" +',
    '      "<div class=\\"space-between\\"><strong>" + escapeHtml(e.label) + "</strong><span class=\\"muted\\">" + (hasVal ? (pct + "%") : "n/a") + "</span></div>" +',
    '      "<div class=\\"meter\\" style=\\"margin-top:6px\\"><div class=\\"meter-fill " + cls + "\\" style=\\"width:" + pct + "%\\"></div></div>" +',
    '    "</div>";',
    '  }).join("");',
    "}",
    "",
    "function collectTickets() {",
    "  const run = deckState.run || {};",
    "  const report = deckState.report || {};",
    "  const out = [];",
    '  if (run.tickets && typeof run.tickets === "object" && !Array.isArray(run.tickets)) {',
    "    for (const [id, info] of Object.entries(run.tickets)) {",
    '      const obj = info && typeof info === "object" ? info : { status: String(info) };',
    '      out.push({ id: id, status: obj.status || obj.state || "running", model: obj.model || obj.pool || "" });',
    "    }",
    "  } else if (Array.isArray(run.tickets)) {",
    "    for (const t of run.tickets) {",
    '      if (t && t.id) out.push({ id: String(t.id), status: t.status || "queued", model: t.model || t.tier || "" });',
    "    }",
    "  }",
    "  if (!out.length && report) {",
    '    for (const id of (report.merged || [])) out.push({ id: String(id), status: "merged", model: "" });',
    '    if (report.failed && typeof report.failed === "object") {',
    '      for (const id of Object.keys(report.failed)) out.push({ id: String(id), status: "failed", model: "" });',
    "    }",
    "  }",
    "  return out;",
    "}",
    "",
    "function renderFlightDeck(data) {",
    "  deckState = data || {};",
    "  const run = deckState.run;",
    "  const offline = Boolean(deckState.control && deckState.control.offline);",
    "  const paused = Boolean((deckState.control && deckState.control.paused) || (run && run.paused));",
    "  const done = Boolean(run && run.done);",
    '  let label = "OFFLINE";',
    '  let cls = "";',
    "  if (run) {",
    '    if (done) { label = "DONE"; cls = "ok"; }',
    '    else if (paused) { label = "PAUSED"; cls = "warn"; }',
    '    else if (offline) { label = "STALE / OFFLINE"; cls = "warn"; }',
    '    else { label = "RUNNING"; cls = "accent"; }',
    "  }",
    '  runBadgeEl.className = "badge" + (cls ? (" " + cls) : "");',
    "  runBadgeEl.textContent = label;",
    '  deckStatusEl.textContent = run && run.runId ? ("Run " + String(run.runId) + (offline ? " (control offline)" : "")) : "No active run detected";',
    "  renderPools();",
    "  const rows = collectTickets();",
    "  if (!rows.length) {",
    '    ticketRowsEl.innerHTML = "<tr><td colspan=\\"4\\" class=\\"muted\\">No tickets recorded yet.</td></tr>";',
    "  } else {",
    "    ticketRowsEl.innerHTML = rows.map((r) => {",
    '      const st = String(r.status || "unknown");',
    '      const bCls = st === "merged" ? "ok" : (st === "failed" ? "err" : "accent");',
    "      const sid = escapeHtml(r.id);",
    '      return "<tr>" +',
    '        "<td><strong>" + sid + "</strong></td>" +',
    '        "<td><span class=\\"badge " + bCls + "\\">" + escapeHtml(st) + "</span></td>" +',
    '        "<td class=\\"muted\\">" + escapeHtml(r.model || "-") + "</td>" +',
    '        "<td class=\\"row\\">" +',
    '          "<button type=\\"button\\" data-act=\\"stream\\" data-id=\\"" + sid + "\\">Stream</button>" +',
    '          "<button type=\\"button\\" data-act=\\"diff\\" data-id=\\"" + sid + "\\">Diff</button>" +',
    '          "<button type=\\"button\\" class=\\"danger\\" data-act=\\"abort\\" data-id=\\"" + sid + "\\">Abort</button>" +',
    '        "</td>" +',
    '      "</tr>";',
    '    }).join("");',
    "  }",
    "  syncPolling();",
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    "async function loadInspector(action, ticketId) {",
    "  if (!ticketId) return;",
    "  selectedTicketId = ticketId;",
    "  activeTab = action;",
    '  tabStreamBtn.classList.toggle("active", activeTab === "stream");',
    '  tabDiffBtn.classList.toggle("active", activeTab === "diff");',
    '  inspectorTargetEl.textContent = ticketId + " (" + activeTab + ")";',
    '  inspectorPreEl.textContent = "Loading " + activeTab + "\u2026";',
    "  try {",
    "    const repo = currentRepo();",
    '    const res = await __bridge.callTool("agb_control", Object.assign({ action: activeTab, ticketId: ticketId }, repo ? { repo: repo } : {}));',
    "    const payload = __bridge.extractStructured(res) || {};",
    '    if (activeTab === "stream") {',
    "      const lines = Array.isArray(payload.lines) ? payload.lines : [];",
    '      inspectorPreEl.textContent = lines.length ? lines.join("\\n") : (payload.error || "(empty stream)");',
    "    } else {",
    '      inspectorPreEl.textContent = payload.diff || payload.error || "(empty diff)";',
    "    }",
    "  } catch (err) {",
    '    inspectorPreEl.textContent = "Inspector error: " + err.message;',
    "  }",
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    "async function sendDeckControl(action, ticketId) {",
    "  try {",
    "    const repo = currentRepo();",
    "    const args = Object.assign({ action: action }, repo ? { repo: repo } : {}, ticketId ? { ticketId: ticketId } : {});",
    '    const res = await __bridge.callTool("agb_control", args);',
    "    const payload = __bridge.extractStructured(res);",
    '    if (action === "snapshot" && payload) {',
    "      renderFlightDeck(payload);",
    "    } else {",
    '      deckStatusEl.textContent = "Control " + action + ": " + ((payload && payload.ok) ? "ok" : ((payload && payload.error) || "offline"));',
    "    }",
    "  } catch (err) {",
    '    deckStatusEl.textContent = "Control error: " + err.message;',
    "  }",
    "}",
    "",
    'document.getElementById("btnPause").addEventListener("click", () => sendDeckControl("pause"));',
    'document.getElementById("btnResume").addEventListener("click", () => sendDeckControl("resume"));',
    'document.getElementById("btnRefresh").addEventListener("click", () => sendDeckControl("snapshot"));',
    'tabStreamBtn.addEventListener("click", () => { if (selectedTicketId) loadInspector("stream", selectedTicketId); });',
    'tabDiffBtn.addEventListener("click", () => { if (selectedTicketId) loadInspector("diff", selectedTicketId); });',
    'ticketRowsEl.addEventListener("click", (ev) => {',
    '  const btn = ev.target && ev.target.closest("[data-act]");',
    "  if (!btn) return;",
    '  const act = btn.getAttribute("data-act");',
    '  const id = btn.getAttribute("data-id");',
    "  if (!id) return;",
    '  if (act === "abort") sendDeckControl("abort", id);',
    '  else if (act === "stream" || act === "diff") loadInspector(act, id);',
    "});",
    "",
    "__bridge.onResult(renderFlightDeck);"
  ].join("\n");
  return buildHtmlDocument({
    title: "AGB Live Flight Deck",
    appName: "agb-flight-deck",
    bodyHtml,
    viewJs
  });
}
function buildMissionControlHtml() {
  const bodyHtml = [
    '  <div class="shell">',
    '    <div class="card">',
    '      <div class="space-between">',
    "        <div>",
    "          <h1>Quota &amp; Pool Mission Control</h1>",
    '          <div id="mcStatus" class="status-line">Waiting for quota and model telemetry\u2026</div>',
    "        </div>",
    '        <div class="row">',
    '          <button id="btnRefreshMc" type="button">Refresh Snapshot</button>',
    '          <button id="btnDoctor" type="button" class="primary">Run Doctor</button>',
    "        </div>",
    "      </div>",
    "    </div>",
    '    <div class="grid-2" id="quotaGauges"></div>',
    '    <div class="card">',
    "      <h2>Model Telemetry (Last 50 Spans)</h2>",
    '      <div style="overflow-x:auto;margin-top:6px">',
    "        <table>",
    "          <thead><tr><th>Model</th><th>Role / Pool</th><th>Outcome</th><th>Duration</th></tr></thead>",
    '          <tbody id="modelStatsBody"><tr><td colspan="4" class="muted">No model telemetry spans recorded.</td></tr></tbody>',
    "        </table>",
    "      </div>",
    "    </div>",
    '    <div id="doctorCard" class="card" style="display:none">',
    "      <h2>Doctor Diagnostics</h2>",
    '      <pre id="doctorPre" style="margin-top:6px"></pre>',
    "    </div>",
    "  </div>"
  ].join("\n");
  const viewJs = [
    "let mcState = {};",
    'const mcStatusEl = document.getElementById("mcStatus");',
    'const gaugesEl = document.getElementById("quotaGauges");',
    'const statsBodyEl = document.getElementById("modelStatsBody");',
    'const doctorCardEl = document.getElementById("doctorCard");',
    'const doctorPreEl = document.getElementById("doctorPre");',
    "",
    "function renderMissionControl(data) {",
    "  mcState = data || {};",
    "  const q = mcState.quotaCache && mcState.quotaCache.quota ? mcState.quotaCache.quota : null;",
    "  const gem = (q && q.gemini) || {};",
    '  const cld = (q && (q.claude_gpt || q["claude-gpt"])) || {};',
    "  const windows = [",
    '    { title: "Gemini \xB7 5-Hour", pct: gem.fiveHourRemainingPercent, reset: gem.fiveHourResetTime },',
    '    { title: "Gemini \xB7 Weekly", pct: gem.weeklyRemainingPercent, reset: gem.weeklyResetTime },',
    '    { title: "Claude/GPT \xB7 5-Hour", pct: cld.fiveHourRemainingPercent, reset: cld.fiveHourResetTime },',
    '    { title: "Claude/GPT \xB7 Weekly", pct: cld.weeklyRemainingPercent, reset: cld.weeklyResetTime },',
    "  ];",
    "  gaugesEl.innerHTML = windows.map((w) => {",
    '    const valid = typeof w.pct === "number" && Number.isFinite(w.pct);',
    "    const pct = valid ? Math.max(0, Math.min(100, Math.round(w.pct))) : 0;",
    '    const cls = !valid ? "" : (pct >= 50 ? "ok" : (pct >= 20 ? "warn" : "err"));',
    '    return "<div class=\\"card\\">" +',
    '      "<div class=\\"space-between\\"><strong>" + escapeHtml(w.title) + "</strong><span>" + (valid ? (pct + "%") : "stale / unavailable") + "</span></div>" +',
    '      "<div class=\\"meter\\" style=\\"margin:6px 0\\"><div class=\\"meter-fill " + cls + "\\" style=\\"width:" + pct + "%\\"></div></div>" +',
    '      "<div class=\\"muted\\" style=\\"font-size:11px\\">Resets: " + escapeHtml(w.reset || "n/a") + "</div>" +',
    '    "</div>";',
    '  }).join("");',
    "",
    "  const stats = Array.isArray(mcState.modelStats) ? mcState.modelStats : [];",
    "  if (!stats.length) {",
    '    statsBodyEl.innerHTML = "<tr><td colspan=\\"4\\" class=\\"muted\\">No model telemetry spans recorded.</td></tr>";',
    "  } else {",
    "    statsBodyEl.innerHTML = stats.map((row) => {",
    "      const ok = row && row.ok !== false;",
    '      const dur = row && typeof row.ms === "number" ? (row.ms + " ms") : (row && row.durationMs ? (row.durationMs + " ms") : "-");',
    '      return "<tr>" +',
    '        "<td><strong>" + escapeHtml((row && row.model) || "unknown") + "</strong></td>" +',
    '        "<td class=\\"muted\\">" + escapeHtml((row && (row.role || row.pool)) || "-") + "</td>" +',
    '        "<td><span class=\\"badge " + (ok ? "ok" : "err") + "\\">" + (ok ? "OK" : "FAIL") + "</span></td>" +',
    '        "<td class=\\"muted\\">" + escapeHtml(dur) + "</td>" +',
    '      "</tr>";',
    '    }).join("");',
    "  }",
    '  mcStatusEl.textContent = q ? "Live 4-window quota cache active" : "Statusline quota cache missing or stale";',
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    'document.getElementById("btnRefreshMc").addEventListener("click", async () => {',
    "  const inp = __bridge.getToolInput() || {};",
    "  const repo = mcState.repo || inp.repo;",
    "  try {",
    '    const res = await __bridge.callTool("agb_control", Object.assign({ action: "snapshot" }, repo ? { repo: repo } : {}));',
    "    const next = __bridge.extractStructured(res);",
    "    if (next) renderMissionControl(next);",
    "  } catch (err) {",
    '    mcStatusEl.textContent = "Refresh failed: " + err.message;',
    "  }",
    "});",
    "",
    'document.getElementById("btnDoctor").addEventListener("click", async () => {',
    "  const inp = __bridge.getToolInput() || {};",
    "  const repo = mcState.repo || inp.repo;",
    '  mcStatusEl.textContent = "Running agb_doctor\u2026";',
    "  try {",
    '    const res = await __bridge.callTool("agb_doctor", repo ? { repo: repo } : {});',
    "    const txt = res && Array.isArray(res.content) && res.content[0] ? res.content[0].text : JSON.stringify(res);",
    '    doctorCardEl.style.display = "block";',
    '    doctorPreEl.textContent = String(txt || "");',
    '    mcStatusEl.textContent = "Doctor completed.";',
    "    __bridge.scheduleSizeReport();",
    "  } catch (err) {",
    '    mcStatusEl.textContent = "Doctor failed: " + err.message;',
    "  }",
    "});",
    "",
    "__bridge.onResult(renderMissionControl);"
  ].join("\n");
  return buildHtmlDocument({
    title: "AGB Quota & Pool Mission Control",
    appName: "agb-mission-control",
    bodyHtml,
    viewJs
  });
}
function buildPlanViewerHtml() {
  const bodyHtml = [
    '  <div class="shell">',
    '    <div class="card">',
    '      <div class="space-between">',
    "        <div>",
    "          <h1>Interactive Plan Viewer</h1>",
    '          <div id="viewerPath" class="status-line">Waiting for .agbplan / plan.json\u2026</div>',
    "        </div>",
    '        <div class="row">',
    '          <span id="validBadge" class="badge">UNLOADED</span>',
    '          <button id="btnSavePlan" type="button">Save Plan</button>',
    '          <button id="btnRunPlan" type="button" class="primary">Run Plan</button>',
    "        </div>",
    "      </div>",
    "    </div>",
    '    <div id="valErrorsCard" class="card" style="display:none">',
    "      <h2>Validation Errors</h2>",
    '      <ul id="valErrorsList" style="margin:6px 0 0 18px;padding:0"></ul>',
    "    </div>",
    '    <div class="card">',
    "      <h2>DAG Topology (Click ticket to edit)</h2>",
    '      <div id="viewerDag" style="margin-top:8px" class="muted">No plan loaded.</div>',
    "    </div>",
    '    <div id="editorCard" class="card" style="display:none">',
    '      <h2 id="editorHeading" style="margin-bottom:8px">Ticket Editor</h2>',
    '      <div class="field"><label for="edTitle">Title</label><input id="edTitle" type="text"></div>',
    '      <div class="grid-2">',
    '        <div class="field">',
    '          <label for="edTier">Tier</label>',
    '          <select id="edTier"><option value="cheap">cheap</option><option value="mid">mid</option><option value="frontier">frontier</option></select>',
    "        </div>",
    '        <div class="field">',
    '          <label for="edPool">Pool Hint</label>',
    '          <select id="edPool"><option value="auto">auto</option><option value="gemini">gemini</option><option value="claude">claude</option><option value="claude-gpt">claude-gpt</option><option value="gpt-oss">gpt-oss</option></select>',
    "        </div>",
    "      </div>",
    '      <div class="field"><label for="edScope">Scope Globs (one per line)</label><textarea id="edScope"></textarea></div>',
    '      <div class="field"><label for="edRails">Frozen Rails (one per line)</label><textarea id="edRails"></textarea></div>',
    '      <div class="field"><label for="edBody">Specification Body</label><textarea id="edBody"></textarea></div>',
    '      <button id="btnApplyTicket" type="button">Apply Ticket Edits</button>',
    "    </div>",
    "  </div>"
  ].join("\n");
  const viewJs = [
    'let viewerState = { path: "", plan: { tickets: [] }, validationErrors: [] };',
    "let selectedId = null;",
    'const pathEl = document.getElementById("viewerPath");',
    'const validBadgeEl = document.getElementById("validBadge");',
    'const valErrorsCard = document.getElementById("valErrorsCard");',
    'const valErrorsList = document.getElementById("valErrorsList");',
    'const dagEl = document.getElementById("viewerDag");',
    'const editorCard = document.getElementById("editorCard");',
    'const editorHeading = document.getElementById("editorHeading");',
    'const edTitle = document.getElementById("edTitle");',
    'const edTier = document.getElementById("edTier");',
    'const edPool = document.getElementById("edPool");',
    'const edScope = document.getElementById("edScope");',
    'const edRails = document.getElementById("edRails");',
    'const edBody = document.getElementById("edBody");',
    "",
    "function populateEditor() {",
    "  const tickets = (viewerState.plan && Array.isArray(viewerState.plan.tickets)) ? viewerState.plan.tickets : [];",
    "  const t = tickets.find((item) => item && String(item.id) === selectedId);",
    "  if (!t) {",
    '    editorCard.style.display = "none";',
    "    return;",
    "  }",
    '  editorCard.style.display = "block";',
    '  editorHeading.textContent = "Edit Ticket: " + String(t.id);',
    '  edTitle.value = String(t.title || "");',
    '  edTier.value = String(t.tier || "mid");',
    '  edPool.value = String(t.pool_hint || "auto");',
    '  edScope.value = Array.isArray(t.scope) ? t.scope.join("\\n") : "";',
    '  edRails.value = Array.isArray(t.rails) ? t.rails.join("\\n") : "";',
    '  edBody.value = String(t.body || "");',
    "}",
    "",
    "function renderViewer(data) {",
    '  viewerState = data || { path: "", plan: { tickets: [] }, validationErrors: [] };',
    "  const plan = viewerState.plan || { tickets: [] };",
    "  const tickets = Array.isArray(plan.tickets) ? plan.tickets : [];",
    "  const errs = Array.isArray(viewerState.validationErrors) ? viewerState.validationErrors : [];",
    '  pathEl.textContent = viewerState.path ? String(viewerState.path) : "In-memory plan";',
    '  validBadgeEl.className = "badge " + (errs.length === 0 ? "ok" : "err");',
    '  validBadgeEl.textContent = errs.length === 0 ? "VALID" : (errs.length + " ERROR(S)");',
    "  if (errs.length) {",
    '    valErrorsCard.style.display = "block";',
    '    valErrorsList.innerHTML = errs.map((e) => "<li>" + escapeHtml(e) + "</li>").join("");',
    "  } else {",
    '    valErrorsCard.style.display = "none";',
    '    valErrorsList.innerHTML = "";',
    "  }",
    "  if (!selectedId && tickets[0] && tickets[0].id) selectedId = String(tickets[0].id);",
    "  dagEl.innerHTML = renderDagSvg(tickets, selectedId);",
    "  populateEditor();",
    "  __bridge.scheduleSizeReport();",
    "}",
    "",
    'dagEl.addEventListener("click", (ev) => {',
    '  const node = ev.target && ev.target.closest("[data-ticket-id]");',
    "  if (!node) return;",
    '  selectedId = node.getAttribute("data-ticket-id");',
    "  const tickets = (viewerState.plan && Array.isArray(viewerState.plan.tickets)) ? viewerState.plan.tickets : [];",
    "  dagEl.innerHTML = renderDagSvg(tickets, selectedId);",
    "  populateEditor();",
    "  __bridge.scheduleSizeReport();",
    "});",
    "",
    'document.getElementById("btnApplyTicket").addEventListener("click", () => {',
    "  const tickets = (viewerState.plan && Array.isArray(viewerState.plan.tickets)) ? viewerState.plan.tickets : [];",
    "  const t = tickets.find((item) => item && String(item.id) === selectedId);",
    "  if (!t) return;",
    "  t.title = edTitle.value.trim();",
    "  t.tier = edTier.value;",
    "  t.pool_hint = edPool.value;",
    "  t.scope = edScope.value.split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);",
    "  t.rails = edRails.value.split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);",
    "  t.body = edBody.value;",
    "  dagEl.innerHTML = renderDagSvg(tickets, selectedId);",
    '  pathEl.textContent = (viewerState.path || "Plan") + " (modified)";',
    "});",
    "",
    'document.getElementById("btnSavePlan").addEventListener("click", async () => {',
    '  const targetPath = viewerState.path || (__bridge.getToolInput() && __bridge.getToolInput().path) || "plan.agbplan";',
    '  const normPath = String(targetPath).replace(/\\\\/g, "/");',
    '  const uri = normPath.startsWith("file://") ? normPath : ("file://" + (normPath.startsWith("/") ? "" : "/") + normPath);',
    "  try {",
    '    await __bridge.writeResource(uri, JSON.stringify(viewerState.plan || {}, null, 2) + "\\n");',
    '    pathEl.textContent = "Saved " + targetPath;',
    "  } catch (err) {",
    '    pathEl.textContent = "Save failed: " + err.message;',
    "  }",
    "});",
    "",
    'document.getElementById("btnRunPlan").addEventListener("click", async () => {',
    '  const targetPath = viewerState.path || (__bridge.getToolInput() && __bridge.getToolInput().path) || "plan.json";',
    '  pathEl.textContent = "Running " + targetPath + "\u2026";',
    "  try {",
    '    await __bridge.callTool("agb_run", { plan: targetPath });',
    '    pathEl.textContent = "Completed run for " + targetPath;',
    "  } catch (err) {",
    '    pathEl.textContent = "Run failed: " + err.message;',
    "  }",
    "});",
    "",
    "__bridge.onResult(renderViewer);"
  ].join("\n");
  return buildHtmlDocument({
    title: "AGB Interactive Plan Viewer",
    appName: "agb-plan-viewer",
    bodyHtml,
    viewJs
  });
}
var RESOURCE_BUILDERS = /* @__PURE__ */ new Map([
  [
    "ui://agb/plan-card.html",
    {
      uri: "ui://agb/plan-card.html",
      name: "AGB Plan & DAG Readiness Card",
      description: "Inline interactive DAG topology, readiness score, and gate badges for agb_shape, agb_plan, and agb_preflight.",
      build: buildPlanCardHtml
    }
  ],
  [
    "ui://agb/review-card.html",
    {
      uri: "ui://agb/review-card.html",
      name: "AGB Adversarial Review Card",
      description: "Inline multi-lens code and plan review verdict card with severity/lens filters and Fix/Rebut actions.",
      build: buildReviewCardHtml
    }
  ],
  [
    "ui://agb/flight-deck.html",
    {
      uri: "ui://agb/flight-deck.html",
      name: "AGB Live Flight Deck",
      description: "Auxiliary pane live fleet execution monitor with Pause/Resume/Abort controls and Stream/Diff inspector.",
      build: buildFlightDeckHtml
    }
  ],
  [
    "ui://agb/mission-control.html",
    {
      uri: "ui://agb/mission-control.html",
      name: "AGB Quota & Pool Mission Control",
      description: "Global 4-window Gemini and Claude/GPT quota gauges, reset timers, and model telemetry.",
      build: buildMissionControlHtml
    }
  ],
  [
    "ui://agb/plan-viewer.html",
    {
      uri: "ui://agb/plan-viewer.html",
      name: "AGB Interactive Plan Viewer",
      description: "Custom .agbplan / plan.json DAG viewer and editor with scope/rail inspection, save, and launch.",
      build: buildPlanViewerHtml
    }
  ]
]);
var UI_RESOURCES = Object.freeze(
  Array.from(
    RESOURCE_BUILDERS.values(),
    (entry) => Object.freeze({
      uri: entry.uri,
      name: entry.name,
      description: entry.description,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: DEFAULT_CSP_META
    })
  )
);
function renderUiResource(uri) {
  if (typeof uri !== "string") return null;
  const entry = RESOURCE_BUILDERS.get(uri);
  if (!entry) return null;
  return {
    uri: entry.uri,
    name: entry.name,
    description: entry.description,
    mimeType: MCP_APP_MIME_TYPE,
    text: entry.build(),
    _meta: cloneCspMeta()
  };
}

// mcp/server.mjs
var __dirname = dirname4(fileURLToPath(import.meta.url));
var IS_MAIN = process.argv[1] && (resolve4(process.argv[1]) === fileURLToPath(import.meta.url) || process.argv[1].endsWith("/mcp/server.mjs") || process.argv[1].endsWith("/dist/mcp-server.mjs"));
var activeProcesses = /* @__PURE__ */ new Map();
var cancelledRequests = /* @__PURE__ */ new Set();
var MAX_STRUCTURED_BYTES = 512 * 1024;
var CLI_UI_TOOLS = /* @__PURE__ */ new Set(["agb_shape", "agb_plan", "agb_preflight", "agb_review"]);
var CONTROL_ACTIONS = /* @__PURE__ */ new Set(["snapshot", "pause", "resume", "abort", "diff", "stream"]);
var TICKET_SCOPED_ACTIONS = /* @__PURE__ */ new Set(["abort", "diff", "stream"]);
function readPackageVersion() {
  try {
    return JSON.parse(readFileSync3(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
  } catch (err) {
    logDiagnostic(`could not read package.json version: ${err.message}`);
    return "unknown";
  }
}
var IS_BUNDLED2 = true;
function resolveAgbEntry(dir = __dirname, bundled = IS_BUNDLED2) {
  const candidate = bundled ? join4(dir, "agb.mjs") : join4(dir, "..", "bin", "agb.mjs");
  if (bundled || existsSync3(candidate)) return { cmd: process.execPath, args: [candidate] };
  return { cmd: "agb", args: [] };
}
var { cmd: agbCmd, args: baseArgs } = resolveAgbEntry();
function logDiagnostic(message) {
  try {
    process.stderr.write(`[agb-mcp] ${message}
`);
  } catch {
  }
}
var TOOLS = [
  {
    name: "agb_shape",
    description: "Pre-analyze a structured spec or brain plan for DAG validity, scope overlaps, rails, and static import coupling before agb plan",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", description: "Path to spec.md or brain conversation ID/prefix" },
        repo: { type: "string", description: "Absolute path to the target repository" },
        syncBrain: { type: "boolean", description: "Sync formatted plan artifact to .booster/agb_plan_artifact.md and active brain session" },
        maxTicketScope: { type: "number", description: "Maximum recommended file scope per ticket before emitting a scope warning (default 12)" },
        strict: { type: "boolean", description: "Fail closed on coupling or scope warnings" }
      },
      required: ["spec", "repo"]
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/plan-card.html"
      }
    }
  },
  {
    name: "agb_plan",
    description: "Compile an Antigravity brain plan or spec file into plan.json",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", description: "Brain ID, prefix, or spec.md path to compile" },
        repo: { type: "string", description: "Absolute path to the target repository" },
        estimate: { type: "boolean", description: "Forecast wave-by-wave quota burn without writing plan.json or running Stage B LLM gates" },
        out: { type: "string", description: "Custom output file path (default plan.json)" },
        force: { type: "boolean", description: "Force overwrite the output file if it exists" },
        decompose: { type: "boolean", description: "Automatically split wide tickets exceeding maxTicketScope" },
        maxTicketScope: { type: "number", description: "Maximum files per ticket when decompose is enabled (default 3)" },
        noFastPath: { type: "boolean", description: "Disable zero-LLM structured Markdown fast-path and force LLM conversion" },
        noColdstart: { type: "boolean", description: "Skip coldstart plan gate" },
        noParallax: { type: "boolean", description: "Skip parallax spec ambiguity check" },
        noPremortem: { type: "boolean", description: "Skip premortem advisory risk gate" },
        emitWorkflow: { type: "string", description: "Optional output path for compiled run_workflow Python script" }
      },
      required: ["spec", "repo"]
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/plan-card.html"
      }
    }
  },
  {
    name: "agb_distill",
    description: "Scan repository review and prosecution logs for recurring finding patterns and stage or apply learned ADLC defenses",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path to target repository" },
        apply: { type: "boolean", description: "Write compacted defenses to .gemini/rules/adlc-learned.md" }
      },
      required: ["repo"]
    }
  },
  {
    name: "agb_run",
    description: "Execute a compiled ticket DAG plan.json",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Path to plan.json file" },
        concurrency: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum concurrent workers cap (-c <n>)"
        },
        resume: {
          type: "boolean",
          description: "Resume from previously merged tickets"
        },
        resetRescue: {
          type: "boolean",
          description: "Clear active or preserved rescue locks before running"
        }
      },
      required: ["plan"]
    }
  },
  {
    name: "agb_preflight",
    description: "Run plan-level coldstart probes and forecast scope overlaps",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Path to plan.json file" },
        noColdstart: { type: "boolean", description: "Skip coldstart plan gate" }
      },
      required: ["plan"]
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/plan-card.html"
      }
    }
  },
  {
    name: "agb_status",
    description: "Get execution status of a booster run in the target repository",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path to target repository" }
      },
      required: ["repo"]
    }
  },
  {
    name: "agb_doctor",
    description: "Run diagnostic health check for tools, auth, and sandbox setup",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Optional path to target repository" },
        fix: { type: "boolean", description: "Automatically repair missing .adlc store, .gitignore, or companion plugin" }
      }
    }
  },
  {
    name: "agb_init",
    description: "Initialize a target repository for ADLC and Antigravity Booster (.adlc/config.json, specs/feature-template.md, .gitignore)",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path to target repository" }
      },
      required: ["repo"]
    }
  },
  {
    name: "agb_review",
    description: "Deploy a read-only fleet of models to audit changes or a plan specification",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path to target repository" },
        ref: { type: "string", description: "Optional diff reference range (e.g. main...HEAD)" },
        plan: { type: "string", description: "Optional spec.md path to run 5-lens Plan ARL instead of diff review" },
        loop: { type: "boolean", description: "Run iterative ARL up to 3 rounds" },
        fiveLens: { type: "boolean", description: "Run 5-lens Code ARL (Correctness, Simplicity, Security, Evidence, Anti-Slop)" },
        arbiter: { type: "boolean", description: "Enable neutral arbiter triage (default true; pass false for --no-arbiter)" }
      },
      required: ["repo"]
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/review-card.html"
      }
    }
  },
  {
    name: "agb_flight_deck",
    description: "Open the live AGB Flight Deck auxiliary pane to monitor and control active fleet runs",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path to target repository (defaults to cwd)" }
      }
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/flight-deck.html",
        surface: "aux_pane",
        visibility: ["model", "app"]
      }
    }
  },
  {
    name: "agb_mission_control",
    description: "Open the global AGB Mission Control dashboard for 4-window quota gauges and model telemetry",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Optional path to target repository" }
      }
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/mission-control.html",
        surface: "global",
        visibility: ["model", "app"]
      }
    }
  },
  {
    name: "agb_plan_viewer",
    description: "Inspect, validate, and edit a .agbplan or plan.json ticket DAG file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to .agbplan or plan.json file" },
        repo: { type: "string", description: "Optional repository path" }
      },
      required: ["path"]
    },
    _meta: {
      ui: {
        resourceUri: "ui://agb/plan-viewer.html",
        surface: "file",
        extensions: [".agbplan"],
        visibility: ["model", "app"]
      }
    }
  },
  {
    name: "agb_control",
    description: "Send authenticated control IPC or snapshot/diff/stream telemetry queries to an AGB run",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path to target repository (defaults to cwd)" },
        action: {
          type: "string",
          enum: ["snapshot", "pause", "resume", "abort", "diff", "stream"],
          description: "Control or telemetry action"
        },
        ticketId: { type: "string", description: "Target ticket ID for abort, diff, or stream" },
        lines: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max stream lines to return (default 40)"
        }
      },
      required: ["action"]
    },
    _meta: {
      ui: {
        visibility: ["model", "app"]
      }
    }
  }
];
if (IS_MAIN) {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      if (request.jsonrpc !== "2.0") {
        sendError(request.id, -32600, "Invalid Request");
        return;
      }
      if (request.method === "notifications/cancelled" || request.method === "$/cancel") {
        const cancelParams = request.params;
        const targetId = cancelParams?.requestId ?? cancelParams?.id;
        handleCancelNotification({ id: targetId });
        return;
      }
      if (request.id === void 0 || request.id === null) {
        return;
      }
      await handleRequest(request);
    } catch (err) {
      logDiagnostic(`parse error: ${err.message}`);
      sendError(null, -32700, `Parse error: ${err.message}`);
    }
  });
  rl.on("close", () => {
    cleanup();
    process.exit(0);
  });
}
async function handleRequest(req) {
  const { method, params, id } = req;
  if (method === "initialize") {
    const hasUiExtension = Boolean(params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"]);
    sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
        ...hasUiExtension ? { extensions: { "io.modelcontextprotocol/ui": {} } } : {}
      },
      serverInfo: {
        name: "antigravity-booster-mcp",
        version: readPackageVersion()
      }
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (method === "resources/list") {
    sendResult(id, { resources: UI_RESOURCES });
    return;
  }
  if (method === "resources/read") {
    const uri = typeof params?.uri === "string" ? params.uri : "";
    const rendered = uri ? renderUiResource(uri) : null;
    if (!rendered) {
      sendError(id, -32602, `Unknown resource URI: ${params?.uri}`);
      return;
    }
    sendResult(id, { contents: [rendered] });
    return;
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    await handleToolCall(id, name, args || {});
    return;
  }
  sendError(id, -32601, `Method not found: ${method}`);
}
function requireNonFlagString(args, key) {
  const val = args?.[key];
  if (typeof val !== "string" || val.trim().length === 0) {
    return { ok: false, error: `Invalid or missing required string argument '${key}'` };
  }
  if (val.startsWith("-")) {
    return { ok: false, error: `Positional argument '${key}' must not start with '-'` };
  }
  return { ok: true, value: val };
}
function validateDirectory(dirPath, paramName, rawVal = dirPath) {
  let isDir = false;
  try {
    isDir = statSync2(dirPath).isDirectory();
  } catch {
  }
  if (!isDir) {
    return { ok: false, error: `Invalid parameter '${paramName}': directory does not exist: ${rawVal}` };
  }
  return { ok: true };
}
function resolveSpecPath(rawSpec, targetCwd) {
  const specInTarget = resolve4(targetCwd, rawSpec);
  const specInAmbient = resolve4(rawSpec);
  if (existsSync3(specInTarget)) return specInTarget;
  if (existsSync3(specInAmbient)) return specInAmbient;
  if (isAbsolute3(rawSpec) || rawSpec.includes("/") || rawSpec.includes("\\") || /\.(md|markdown|txt|json)$/i.test(rawSpec)) {
    return specInTarget;
  }
  return rawSpec;
}
function symlinkSecurityError(targetPath) {
  const err = new Error(`Security violation: symbolic link not allowed: ${targetPath}`);
  err.code = "ESYMLINK";
  return err;
}
function lstatOrNull(targetPath) {
  try {
    return lstatSync3(targetPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
}
function readRegularFileBounded(filePath, maxBytes = MAX_STRUCTURED_BYTES) {
  const st = lstatOrNull(filePath);
  if (!st) return { missing: true };
  if (st.isSymbolicLink()) throw symlinkSecurityError(filePath);
  if (!st.isFile()) {
    const err = new Error(`Refusing to read non-regular file: ${filePath}`);
    err.code = "ENOTFILE";
    throw err;
  }
  if (st.size > maxBytes) {
    const err = new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
    err.code = "ETOOBIG";
    throw err;
  }
  const flags = constants2.O_RDONLY | (constants2.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync2(filePath, flags);
  } catch (err) {
    if (err?.code === "ELOOP") throw symlinkSecurityError(filePath);
    if (err?.code === "ENOENT") return { missing: true };
    throw err;
  }
  try {
    const fst = fstatSync2(fd);
    if (!fst.isFile()) {
      const err = new Error(`Refusing to read non-regular file: ${filePath}`);
      err.code = "ENOTFILE";
      throw err;
    }
    if (fst.size > maxBytes) {
      const err = new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
      err.code = "ETOOBIG";
      throw err;
    }
    const text = readFileSync3(fd, "utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      const err = new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
      err.code = "ETOOBIG";
      throw err;
    }
    return { missing: false, text };
  } finally {
    closeSync2(fd);
  }
}
function readJsonOrNull(filePath, maxBytes = 256 * 1024) {
  let res;
  try {
    res = readRegularFileBounded(filePath, maxBytes);
  } catch (err) {
    if (err?.code === "ESYMLINK") throw err;
    return null;
  }
  if (res.missing) return null;
  try {
    const parsed = JSON.parse(res.text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function readTailJsonl(filePath, { maxLines = 50, maxTailBytes = 192 * 1024 } = {}) {
  const st = lstatOrNull(filePath);
  if (!st) return [];
  if (st.isSymbolicLink()) throw symlinkSecurityError(filePath);
  if (!st.isFile()) return [];
  const flags = constants2.O_RDONLY | (constants2.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync2(filePath, flags);
  } catch (err) {
    if (err?.code === "ELOOP") throw symlinkSecurityError(filePath);
    return [];
  }
  try {
    const fst = fstatSync2(fd);
    if (!fst.isFile() || fst.size === 0) return [];
    const readLen = Math.min(fst.size, maxTailBytes);
    const offset = fst.size - readLen;
    const buf = Buffer.alloc(readLen);
    const bytesRead = readSync(fd, buf, 0, readLen, offset);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNl = text.indexOf("\n");
      text = firstNl === -1 ? "" : text.slice(firstNl + 1);
    }
    const items = [];
    for (const rawLine of text.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          items.push(parsed);
        }
      } catch {
      }
    }
    return items.slice(-maxLines);
  } finally {
    closeSync2(fd);
  }
}
function inspectBoosterDir(repo) {
  const rawRepo = resolve4(repo);
  const rawBooster = join4(rawRepo, ".booster");
  const rawSt = lstatOrNull(rawBooster);
  if (rawSt && rawSt.isSymbolicLink()) {
    throw symlinkSecurityError(rawBooster);
  }
  let canonicalRepo = rawRepo;
  try {
    canonicalRepo = realpathSync3(rawRepo);
  } catch {
  }
  const boosterDir = join4(canonicalRepo, ".booster");
  const boosterSt = lstatOrNull(boosterDir);
  if (!boosterSt) {
    return { resolvedRepo: rawRepo, canonicalRepo, boosterDir, exists: false };
  }
  if (boosterSt.isSymbolicLink() || !boosterSt.isDirectory()) {
    throw symlinkSecurityError(boosterDir);
  }
  for (const sub of ["run.json", "report.json", "model_stats.jsonl", "rescue-latest"]) {
    const p = join4(boosterDir, sub);
    const st = lstatOrNull(p);
    if (st && st.isSymbolicLink()) {
      throw symlinkSecurityError(p);
    }
  }
  return { resolvedRepo: rawRepo, canonicalRepo, boosterDir, exists: true };
}
function sliceUtf8(str, maxBytes) {
  const s = String(str ?? "");
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}
function boundStructuredObject(obj, fallbackFactory) {
  const encoded = JSON.stringify(obj);
  if (Buffer.byteLength(encoded, "utf8") < MAX_STRUCTURED_BYTES) {
    return obj;
  }
  return fallbackFactory();
}
async function buildSnapshotPayload(repo) {
  const { resolvedRepo, boosterDir, exists } = inspectBoosterDir(repo);
  const run = exists ? readJsonOrNull(join4(boosterDir, "run.json"), 192 * 1024) : null;
  const report = exists ? readJsonOrNull(join4(boosterDir, "report.json"), 192 * 1024) : null;
  const quotaCache = readFreshStatusLineQuotaCache();
  const modelStats = exists ? readTailJsonl(join4(boosterDir, "model_stats.jsonl"), { maxLines: 50 }) : [];
  const rawControl = await sendControlCommand(resolvedRepo, { action: "status" });
  if (rawControl?.error && /symbolic link/i.test(rawControl.error)) {
    throw symlinkSecurityError(join4(boosterDir, "control.json"));
  }
  const control = rawControl && typeof rawControl === "object" ? rawControl.ok ? rawControl : { ok: false, offline: true, ...rawControl.error ? { error: rawControl.error } : {} } : { ok: false, offline: true };
  const snapshot = {
    ok: true,
    repo: resolvedRepo,
    run,
    report,
    control,
    quotaCache,
    modelStats
  };
  return boundStructuredObject(snapshot, () => ({
    ok: true,
    repo: resolvedRepo,
    run: run ? { runId: run.runId ?? null, done: run.done ?? null, startedAt: run.startedAt ?? null, truncated: true } : null,
    report: report ? { runId: report.runId ?? null, merged: Array.isArray(report.merged) ? report.merged : [], truncated: true } : null,
    control,
    quotaCache,
    modelStats: modelStats.slice(-20),
    truncated: true
  }));
}
function sendToolError(id, message) {
  sendResult(id, {
    content: [{ type: "text", text: message }],
    isError: true
  });
}
function resolveOptionalRepoArg(args) {
  if (args?.repo === void 0) {
    return { ok: true, repo: process.cwd() };
  }
  const repoCheck = requireNonFlagString(args, "repo");
  if (!repoCheck.ok) return repoCheck;
  const resolved = resolve4(repoCheck.value);
  const dirCheck = validateDirectory(resolved, "repo", repoCheck.value);
  if (!dirCheck.ok) return dirCheck;
  return { ok: true, repo: resolved };
}
function assertNoSymlinkSegments(baseDir, targetPath) {
  const rel = relative3(baseDir, targetPath);
  if (!rel.startsWith("..") && !isAbsolute3(rel)) {
    let cur = baseDir;
    for (const seg of rel.split(sep2).filter(Boolean)) {
      cur = join4(cur, seg);
      const st = lstatOrNull(cur);
      if (st && st.isSymbolicLink()) {
        throw symlinkSecurityError(cur);
      }
    }
  }
  const finalSt = lstatOrNull(targetPath);
  if (finalSt && finalSt.isSymbolicLink()) {
    throw symlinkSecurityError(targetPath);
  }
}
async function handleInProcessUiTool(id, name, args) {
  if (name === "agb_flight_deck" || name === "agb_mission_control") {
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    try {
      const snap = await buildSnapshotPayload(repoRes.repo);
      const surface = name === "agb_flight_deck" ? "aux_pane" : "global";
      const structuredContent = boundStructuredObject(
        { ...snap, surface },
        () => ({ ...snap, modelStats: [], surface, truncated: true })
      );
      sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              runId: snap.run?.runId ?? null,
              done: snap.run?.done ?? null,
              offline: Boolean(snap.control?.offline)
            })
          }
        ],
        structuredContent
      });
    } catch (err) {
      sendToolError(id, err.message);
    }
    return;
  }
  if (name === "agb_plan_viewer") {
    const pathCheck = requireNonFlagString(args, "path");
    if (!pathCheck.ok) {
      sendToolError(id, pathCheck.error);
      return;
    }
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    const planFile = resolve4(repoRes.repo, pathCheck.value);
    let fileData;
    try {
      assertNoSymlinkSegments(repoRes.repo, planFile);
      fileData = readRegularFileBounded(planFile, MAX_STRUCTURED_BYTES);
    } catch (err) {
      sendToolError(id, err.message);
      return;
    }
    if (fileData.missing) {
      sendToolError(id, `Plan file does not exist: ${planFile}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fileData.text);
    } catch (err) {
      sendToolError(id, `Invalid JSON in plan file ${planFile}: ${err.message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendToolError(id, `Invalid plan object in ${planFile}`);
      return;
    }
    const errors = validatePlan(parsed);
    const structuredContent = {
      ok: errors.length === 0,
      path: planFile,
      plan: parsed,
      validationErrors: errors
    };
    if (Buffer.byteLength(JSON.stringify(structuredContent), "utf8") >= MAX_STRUCTURED_BYTES) {
      sendToolError(id, `Plan payload exceeds 512 KiB limit: ${planFile}`);
      return;
    }
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `Plan ${basename2(planFile)}: ${(parsed.tickets ?? []).length} ticket(s)`
        }
      ],
      structuredContent
    });
    return;
  }
  if (name === "agb_control") {
    const action = args?.action;
    if (typeof action !== "string" || !CONTROL_ACTIONS.has(action)) {
      sendToolError(id, `Invalid or missing control action: ${String(action)}`);
      return;
    }
    const repoRes = resolveOptionalRepoArg(args);
    if (!repoRes.ok) {
      sendToolError(id, repoRes.error);
      return;
    }
    let ticketId;
    if (TICKET_SCOPED_ACTIONS.has(action)) {
      if (typeof args?.ticketId !== "string" || !args.ticketId.trim() || !TICKET_ID_RE.test(args.ticketId.trim())) {
        sendToolError(id, `Action '${action}' requires a valid non-empty ticketId`);
        return;
      }
      ticketId = args.ticketId.trim();
    } else if (args?.ticketId !== void 0) {
      if (typeof args.ticketId !== "string" || !args.ticketId.trim() || !TICKET_ID_RE.test(args.ticketId.trim())) {
        sendToolError(id, `Invalid ticketId: ${String(args.ticketId)}`);
        return;
      }
      ticketId = args.ticketId.trim();
    }
    let lines;
    if (args?.lines !== void 0) {
      if (typeof args.lines !== "number" || !Number.isInteger(args.lines) || args.lines < 1 || args.lines > 200) {
        sendToolError(id, "Invalid lines: expected integer between 1 and 200");
        return;
      }
      lines = args.lines;
    }
    const targetRepo = repoRes.repo;
    let boosterInfo;
    try {
      boosterInfo = inspectBoosterDir(targetRepo);
    } catch (err) {
      sendToolError(id, err.message);
      return;
    }
    if (action === "snapshot") {
      try {
        const snap = await buildSnapshotPayload(targetRepo);
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(snap) }],
          structuredContent: snap
        });
      } catch (err) {
        sendToolError(id, err.message);
      }
      return;
    }
    if (action === "diff") {
      const res2 = await sendControlCommand(targetRepo, { action: "diff", ticketId });
      if (res2?.error && /symbolic link/i.test(res2.error)) {
        sendToolError(id, res2.error);
        return;
      }
      if (res2 && res2.ok === true) {
        const diffText = sliceUtf8(typeof res2.diff === "string" ? res2.diff : "", 384 * 1024);
        const structuredContent2 = {
          ...res2,
          ok: true,
          offline: false,
          ticketId: res2.ticketId ?? ticketId,
          diff: diffText
        };
        sendResult(id, {
          content: [{ type: "text", text: diffText || JSON.stringify(structuredContent2) }],
          structuredContent: structuredContent2,
          isError: false
        });
        return;
      }
      if (res2?.offline === true) {
        const rescueDir = join4(boosterInfo.boosterDir, "rescue-latest");
        try {
          const dirSt = lstatOrNull(rescueDir);
          if (dirSt && (dirSt.isSymbolicLink() || !dirSt.isDirectory())) {
            throw symlinkSecurityError(rescueDir);
          }
          const latestFile = join4(rescueDir, `${ticketId.toLowerCase()}.json`);
          const saved = dirSt ? readJsonOrNull(latestFile, 384 * 1024) : null;
          if (saved && typeof saved === "object" && !Array.isArray(saved)) {
            const diffText = sliceUtf8(typeof saved.diff === "string" ? saved.diff : "", 384 * 1024);
            const structuredContent2 = {
              ok: true,
              offline: true,
              ticketId,
              diff: diffText
            };
            sendResult(id, {
              content: [{ type: "text", text: diffText || JSON.stringify(structuredContent2) }],
              structuredContent: structuredContent2,
              isError: false
            });
            return;
          }
        } catch (err) {
          if (err?.code === "ESYMLINK") {
            sendToolError(id, err.message);
            return;
          }
        }
        const missPayload = {
          ok: false,
          offline: true,
          ticketId,
          diff: "",
          error: "no active run or saved rescue snapshot"
        };
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(missPayload) }],
          structuredContent: missPayload,
          isError: false
        });
        return;
      }
      const failPayload = {
        ok: false,
        offline: false,
        action: "diff",
        ticketId,
        diff: "",
        error: res2?.error ?? "control command failed"
      };
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(failPayload) }],
        structuredContent: failPayload,
        isError: false
      });
      return;
    }
    const cmdPayload = {
      action,
      ...ticketId ? { ticketId } : {},
      ...lines !== void 0 ? { lines } : {}
    };
    const res = await sendControlCommand(targetRepo, cmdPayload);
    if (res?.error && /symbolic link/i.test(res.error)) {
      sendToolError(id, res.error);
      return;
    }
    if (res && res.ok === true) {
      const structuredContent2 = boundStructuredObject(
        {
          ...res,
          ok: true,
          offline: false,
          action,
          ...ticketId ? { ticketId: res.ticketId ?? ticketId } : {}
        },
        () => ({
          ok: true,
          offline: false,
          action,
          ...ticketId ? { ticketId } : {},
          ...action === "stream" && Array.isArray(res.lines) ? { lines: res.lines.slice(-40).map((l) => sliceUtf8(l, 2048)) } : {},
          truncated: true
        })
      );
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(structuredContent2) }],
        structuredContent: structuredContent2,
        isError: false
      });
      return;
    }
    const structuredContent = {
      ok: false,
      offline: Boolean(res?.offline),
      action,
      ticketId: ticketId ?? null,
      ...action === "stream" ? { lines: [] } : {},
      error: res?.error ?? "control command failed"
    };
    sendResult(id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false
    });
  }
}
function buildCliStructuredContent(name, stdout, stderr, exitCode, planOutPath = null) {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (name === "agb_plan" && exitCode === 0 && !Array.isArray(parsed.tickets) && planOutPath) {
          try {
            const compiled = readJsonOrNull(planOutPath, 256 * 1024);
            if (compiled && Array.isArray(compiled.tickets)) {
              parsed.tickets = compiled.tickets;
            }
          } catch {
          }
        }
        if (Buffer.byteLength(JSON.stringify(parsed), "utf8") < MAX_STRUCTURED_BYTES) {
          return parsed;
        }
      }
    } catch {
    }
  }
  const rawSource = trimmed || stderr.trim();
  return {
    ok: exitCode === 0,
    rawText: sliceUtf8(rawSource.slice(0, 262144), 262144),
    exitCode: exitCode ?? 1
  };
}
async function handleToolCall(id, name, args) {
  if (name === "agb_flight_deck" || name === "agb_mission_control" || name === "agb_plan_viewer" || name === "agb_control") {
    await handleInProcessUiTool(id, name, args);
    return;
  }
  let cliArgs = [...baseArgs];
  let targetCwd;
  let planOutPath = null;
  if (name === "agb_shape") {
    const specCheck = requireNonFlagString(args, "spec");
    if (!specCheck.ok) {
      sendError(id, -32602, specCheck.error);
      return;
    }
    const repoCheck = requireNonFlagString(args, "repo");
    if (!repoCheck.ok) {
      sendError(id, -32602, repoCheck.error);
      return;
    }
    targetCwd = resolve4(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, "repo", repoCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    const resolvedSpec = resolveSpecPath(specCheck.value, targetCwd);
    cliArgs.push("shape", resolvedSpec, targetCwd, "--json");
    if (args.syncBrain) cliArgs.push("--sync-brain");
    if (args.maxTicketScope !== void 0) {
      const n = Number(args.maxTicketScope);
      if (!Number.isInteger(n) || n <= 0) {
        sendError(id, -32602, `Invalid maxTicketScope: expected positive integer`);
        return;
      }
      cliArgs.push("--max-ticket-scope", String(n));
    }
    if (args.strict) cliArgs.push("--strict");
  } else if (name === "agb_plan") {
    const specCheck = requireNonFlagString(args, "spec");
    if (!specCheck.ok) {
      sendError(id, -32602, specCheck.error);
      return;
    }
    const repoCheck = requireNonFlagString(args, "repo");
    if (!repoCheck.ok) {
      sendError(id, -32602, repoCheck.error);
      return;
    }
    targetCwd = resolve4(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, "repo", repoCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    if (args.estimate !== void 0 && typeof args.estimate !== "boolean") {
      sendError(id, -32602, "Invalid estimate: expected boolean");
      return;
    }
    const resolvedSpec = resolveSpecPath(specCheck.value, targetCwd);
    cliArgs.push("plan", resolvedSpec, targetCwd);
    if (args.estimate === true) {
      cliArgs.push("--estimate", "--json");
    } else if (args.out !== void 0) {
      const outCheck = requireNonFlagString(args, "out");
      if (!outCheck.ok) {
        sendError(id, -32602, outCheck.error);
        return;
      }
      planOutPath = resolve4(targetCwd, outCheck.value);
      cliArgs.push("--out", planOutPath);
    } else {
      planOutPath = resolve4(targetCwd, "plan.json");
      cliArgs.push("--out", planOutPath);
    }
    if (args.force) cliArgs.push("--force");
    if (args.decompose) cliArgs.push("--decompose");
    if (args.maxTicketScope !== void 0) {
      const n = Number(args.maxTicketScope);
      if (!Number.isInteger(n) || n <= 0) {
        sendError(id, -32602, `Invalid maxTicketScope: expected positive integer`);
        return;
      }
      cliArgs.push("--max-ticket-scope", String(n));
    }
    if (args.noFastPath) cliArgs.push("--no-fast-path");
    if (args.noColdstart) cliArgs.push("--no-coldstart");
    if (args.noParallax) cliArgs.push("--no-parallax");
    if (args.noPremortem) cliArgs.push("--no-premortem");
    if (args.emitWorkflow !== void 0) {
      const wfCheck = requireNonFlagString(args, "emitWorkflow");
      if (!wfCheck.ok) {
        sendError(id, -32602, wfCheck.error);
        return;
      }
      cliArgs.push("--emit-workflow", resolve4(targetCwd, wfCheck.value));
    }
  } else if (name === "agb_distill") {
    const repoCheck = requireNonFlagString(args, "repo");
    if (!repoCheck.ok) {
      sendError(id, -32602, repoCheck.error);
      return;
    }
    targetCwd = resolve4(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, "repo", repoCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    cliArgs.push("distill", targetCwd, "--json");
    if (args.apply) cliArgs.push("--apply");
  } else if (name === "agb_run") {
    const planCheck = requireNonFlagString(args, "plan");
    if (!planCheck.ok) {
      sendError(id, -32602, planCheck.error);
      return;
    }
    let concurrency;
    if (args.concurrency !== void 0) {
      if (typeof args.concurrency !== "number" || !Number.isInteger(args.concurrency) || args.concurrency < 1) {
        sendError(id, -32602, "Invalid concurrency: expected integer >= 1");
        return;
      }
      concurrency = args.concurrency;
    }
    if (args.resume !== void 0 && typeof args.resume !== "boolean") {
      sendError(id, -32602, "Invalid resume: expected boolean");
      return;
    }
    if (args.resetRescue !== void 0 && typeof args.resetRescue !== "boolean") {
      sendError(id, -32602, "Invalid resetRescue: expected boolean");
      return;
    }
    const absPlan = resolve4(planCheck.value);
    targetCwd = dirname4(absPlan);
    const dirCheck = validateDirectory(targetCwd, "plan", planCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    cliArgs.push("run", absPlan);
    if (concurrency !== void 0) {
      cliArgs.push("-c", String(concurrency));
    }
    if (args.resume) {
      cliArgs.push("--resume");
    }
    if (args.resetRescue) {
      cliArgs.push("--reset-rescue");
    }
  } else if (name === "agb_preflight") {
    const planCheck = requireNonFlagString(args, "plan");
    if (!planCheck.ok) {
      sendError(id, -32602, planCheck.error);
      return;
    }
    const absPlan = resolve4(planCheck.value);
    targetCwd = dirname4(absPlan);
    const dirCheck = validateDirectory(targetCwd, "plan", planCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    cliArgs.push("preflight", absPlan);
    if (args.noColdstart) cliArgs.push("--no-coldstart");
  } else if (name === "agb_status") {
    const repoCheck = requireNonFlagString(args, "repo");
    if (!repoCheck.ok) {
      sendError(id, -32602, repoCheck.error);
      return;
    }
    targetCwd = resolve4(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, "repo", repoCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    cliArgs.push("status", targetCwd);
  } else if (name === "agb_doctor") {
    if (args.repo !== void 0) {
      const repoCheck = requireNonFlagString(args, "repo");
      if (!repoCheck.ok) {
        sendError(id, -32602, repoCheck.error);
        return;
      }
      const resolvedRepo = resolve4(repoCheck.value);
      const dirCheck = validateDirectory(resolvedRepo, "repo", repoCheck.value);
      if (!dirCheck.ok) {
        sendError(id, -32602, dirCheck.error);
        return;
      }
      targetCwd = resolvedRepo;
      cliArgs.push("doctor", targetCwd);
    } else {
      cliArgs.push("doctor");
    }
    if (args.fix) cliArgs.push("--fix");
  } else if (name === "agb_init") {
    const repoCheck = requireNonFlagString(args, "repo");
    if (!repoCheck.ok) {
      sendError(id, -32602, repoCheck.error);
      return;
    }
    targetCwd = resolve4(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, "repo", repoCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    cliArgs.push("init", targetCwd);
  } else if (name === "agb_review") {
    const repoCheck = requireNonFlagString(args, "repo");
    if (!repoCheck.ok) {
      sendError(id, -32602, repoCheck.error);
      return;
    }
    targetCwd = resolve4(repoCheck.value);
    const dirCheck = validateDirectory(targetCwd, "repo", repoCheck.value);
    if (!dirCheck.ok) {
      sendError(id, -32602, dirCheck.error);
      return;
    }
    cliArgs.push("review", targetCwd);
    if (args.ref !== void 0) {
      const refCheck = requireNonFlagString(args, "ref");
      if (!refCheck.ok) {
        sendError(id, -32602, refCheck.error);
        return;
      }
      cliArgs.push(refCheck.value);
    }
    if (args.plan !== void 0) {
      const planCheck = requireNonFlagString(args, "plan");
      if (!planCheck.ok) {
        sendError(id, -32602, planCheck.error);
        return;
      }
      cliArgs.push("--plan", resolveSpecPath(planCheck.value, targetCwd));
    }
    if (args.loop) cliArgs.push("--loop");
    if (args.fiveLens) cliArgs.push("--five-lens");
    if (args.arbiter === false || args.noArbiter === true) cliArgs.push("--no-arbiter");
  } else {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  try {
    const spawnOpts = {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    };
    if (targetCwd) {
      spawnOpts.cwd = targetCwd;
    }
    const child = spawn(agbCmd, cliArgs, spawnOpts);
    activeProcesses.set(id, child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    let responded = false;
    child.on("close", (code) => {
      activeProcesses.delete(id);
      if (responded) return;
      responded = true;
      if (cancelledRequests.has(id)) {
        cancelledRequests.delete(id);
        sendError(id, -32800, "Request cancelled");
        return;
      }
      const output = stdout.trim() + (stderr ? "\nStderr:\n" + stderr.trim() : "");
      const resultPayload = {
        content: [
          {
            type: "text",
            text: output || (code === 0 ? "Executed successfully" : `Command failed with exit code ${code}`)
          }
        ],
        isError: code !== 0
      };
      if (CLI_UI_TOOLS.has(name)) {
        resultPayload.structuredContent = buildCliStructuredContent(name, stdout, stderr, code, planOutPath);
      }
      sendResult(id, resultPayload);
    });
    child.on("error", (err) => {
      activeProcesses.delete(id);
      if (responded) return;
      responded = true;
      if (cancelledRequests.has(id)) cancelledRequests.delete(id);
      sendResult(id, {
        content: [
          {
            type: "text",
            text: `Failed to execute: ${err.message}`
          }
        ],
        isError: true
      });
    });
  } catch (err) {
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `Spawn error: ${err.message}`
        }
      ],
      isError: true
    });
  }
}
function sendResult(id, result) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result
  }) + "\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  }) + "\n");
}
function handleCancelNotification(params) {
  const targetId = params?.id;
  if (targetId !== void 0 && activeProcesses.has(targetId)) {
    cancelledRequests.add(targetId);
    const child = activeProcesses.get(targetId);
    try {
      child.kill("SIGTERM");
    } catch (e) {
      logDiagnostic(`cancel ${targetId}: ${e.message}`);
    }
  }
}
function cleanup() {
  for (const [id, child] of activeProcesses.entries()) {
    try {
      child.kill("SIGTERM");
    } catch (e) {
      logDiagnostic(`cleanup ${id}: ${e.message}`);
    }
  }
  activeProcesses.clear();
}
if (IS_MAIN) {
  process.on("uncaughtException", (err) => {
    logDiagnostic(`uncaught exception: ${err?.stack || err}`);
  });
  process.on("unhandledRejection", (err) => {
    logDiagnostic(`unhandled rejection: ${err?.stack || err}`);
  });
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}
export {
  buildSnapshotPayload,
  resolveAgbEntry
};
