import { createRequire as __agbCreateRequire } from 'node:module'; const require = __agbCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@adlc/core/lib/llm.mjs
import { spawn } from "node:child_process";
function isAgyTimeout(out) {
  const lines2 = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines2.at(-1) ?? "";
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}
function envEnabled(v) {
  return v !== void 0 && v !== "" && !["0", "false", "no", "off", "disabled"].includes(v.toLowerCase());
}
function agySend({ apiKey, model, system, prompt }, env = process.env) {
  const bin = apiKey === "1" || apiKey === "true" ? "agy" : apiKey;
  const args = ["--print", "--print-timeout", env.ADLC_AGY_TIMEOUT ?? "300s", "--model", model];
  if (env.ADLC_AGY_SANDBOX === "1") args.push("--sandbox");
  const input = system ? `${system}

---

${prompt}` : prompt;
  return new Promise((resolve13, reject) => {
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => out += d);
    p.stderr.on("data", (d) => err += d);
    p.on("error", (e) => reject(new Error(`agy spawn failed: ${e.message}`)));
    p.stdin.end(input);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`agy exit ${code}: ${(err || out).slice(-400)}`));
      if (isAgyTimeout(out)) {
        return reject(new Error("agy: timed out waiting for response"));
      }
      resolve13({ text: out.replace(/\s+$/, ""), usage: null });
    });
  });
}
function usageFromAnthropic(raw2) {
  if (!raw2 || typeof raw2 !== "object") return null;
  return {
    inputTokens: raw2.input_tokens ?? 0,
    outputTokens: raw2.output_tokens ?? 0,
    // Anthropic splits cache reads and cache writes; both count as "cached"
    // for our purposes (cheaper-than-fresh-input), tracked separately isn't
    // needed at this granularity.
    cachedTokens: (raw2.cache_read_input_tokens ?? 0) + (raw2.cache_creation_input_tokens ?? 0)
  };
}
function usageFromOpenAI(raw2) {
  if (!raw2 || typeof raw2 !== "object") return null;
  return {
    inputTokens: raw2.prompt_tokens ?? 0,
    outputTokens: raw2.completion_tokens ?? 0,
    cachedTokens: raw2.prompt_tokens_details?.cached_tokens ?? 0
  };
}
function usageFromGemini(raw2) {
  if (!raw2 || typeof raw2 !== "object") return null;
  return {
    inputTokens: raw2.promptTokenCount ?? 0,
    outputTokens: raw2.candidatesTokenCount ?? 0,
    cachedTokens: raw2.cachedContentTokenCount ?? 0
  };
}
function detectProvider(env = process.env, forceProvider) {
  const forced = forceProvider || env.ADLC_PROVIDER;
  const candidates = forced ? PROVIDERS.filter((p) => p.name === forced) : PROVIDERS;
  for (const p of candidates) {
    const apiKey = env[p.envKey];
    if (p.name === "agy") {
      if (envEnabled(apiKey)) return { ...p, apiKey };
      if (forced === "agy") return { ...p, apiKey: "1" };
    } else if (apiKey) {
      return { ...p, apiKey };
    }
  }
  return null;
}
function resolveModel(provider, { tier: tier2 = "mid", model } = {}, env = process.env) {
  if (model) return model;
  const override = env[`ADLC_MODEL_${tier2.toUpperCase()}`];
  if (override) return override;
  const resolved = provider.models[tier2];
  if (!resolved) throw new Error(`unknown tier: ${tier2}`);
  return resolved;
}
async function complete(opts, env = process.env) {
  const provider = detectProvider(env, opts.provider);
  if (!provider) {
    throw new Error(
      opts.provider ? `provider "${opts.provider}" is not available \u2014 set its API key (or ADLC_AGY for agy), or omit --provider to auto-detect` : "no LLM provider configured \u2014 set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --prompt-only)"
    );
  }
  const model = resolveModel(provider, opts, env);
  const { text, usage: usage2 } = await provider.send(
    {
      apiKey: provider.apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 4096,
      cacheable: opts.cacheable ?? false
    },
    env
  );
  if (typeof opts.onUsage === "function" && usage2) {
    opts.onUsage({ ...usage2, provider: provider.name, model, tier: opts.tier });
  }
  return text;
}
function extractJson(text) {
  if (typeof text !== "string") throw new Error("extractJson: input is not a string");
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error("extractJson: no JSON object or array found");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error("extractJson: unbalanced JSON in model output");
}
var PROVIDERS, PROVIDER_NAMES;
var init_llm = __esm({
  "node_modules/@adlc/core/lib/llm.mjs"() {
    PROVIDERS = [
      {
        name: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        models: {
          cheap: "claude-haiku-4-5",
          mid: "claude-sonnet-4-6",
          frontier: "claude-opus-4-8"
        },
        async send({ apiKey, model, system, prompt, maxTokens, cacheable }) {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              ...system ? { system: cacheable ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system } : {},
              messages: [{
                role: "user",
                content: cacheable ? [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }] : prompt
              }]
            })
          });
          if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
          const data = await res.json();
          const text = (data.content ?? []).map((b) => b.text ?? "").join("");
          return { text, usage: usageFromAnthropic(data.usage) };
        }
      },
      {
        name: "openai",
        envKey: "OPENAI_API_KEY",
        models: {
          cheap: "gpt-5-mini",
          mid: "gpt-5.1",
          frontier: "gpt-5.1"
        },
        async send({ apiKey, model, system, prompt, maxTokens }) {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              max_completion_tokens: maxTokens,
              messages: [
                ...system ? [{ role: "system", content: system }] : [],
                { role: "user", content: prompt }
              ]
            })
          });
          if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content ?? "";
          return { text, usage: usageFromOpenAI(data.usage) };
        }
      },
      {
        name: "gemini",
        envKey: "GEMINI_API_KEY",
        models: {
          cheap: "gemini-2.5-flash",
          mid: "gemini-2.5-pro",
          frontier: "gemini-2.5-pro"
        },
        async send({ apiKey, model, system, prompt, maxTokens }) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...system ? { systemInstruction: { parts: [{ text: system }] } } : {},
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens }
            })
          });
          if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
          return { text, usage: usageFromGemini(data.usageMetadata) };
        }
      },
      {
        // Antigravity CLI subprocess provider. Last in the list so API-key
        // providers win during auto-detection; force with ADLC_PROVIDER=agy.
        name: "agy",
        envKey: "ADLC_AGY",
        models: {
          cheap: "Gemini 3.5 Flash (Medium)",
          mid: "Claude Sonnet 4.6 (Thinking)",
          frontier: "Claude Opus 4.6 (Thinking)"
        },
        send: agySend
      }
    ];
    PROVIDER_NAMES = PROVIDERS.map((p) => p.name);
  }
});

// node_modules/@adlc/core/lib/git.mjs
import { execFileSync } from "node:child_process";
function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    ...opts
  });
}
function splitNulPaths(raw2) {
  const buf = Buffer.isBuffer(raw2) ? raw2 : Buffer.from(raw2, "utf8");
  const out = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) {
        const field = buf.subarray(start, i);
        const text = field.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(field)) {
          throw new Error(
            `git returned a path that is not valid UTF-8 and cannot be handled safely: ${JSON.stringify(text)}. Refusing to proceed \u2014 see #249.`
          );
        }
        out.push(text);
      }
      start = i + 1;
    }
  }
  return out;
}
function isGitRepo(cwd2 = process.cwd()) {
  try {
    git(["rev-parse", "--is-inside-work-tree"], { cwd: cwd2, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
function gitDiff(base3 = "HEAD", cwd2 = process.cwd()) {
  return git(["-c", "core.quotepath=false", "diff", base3, "--"], { cwd: cwd2 });
}
function refExists(ref, cwd2 = process.cwd()) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: cwd2,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}
function resolveBase(cwd2 = process.cwd(), candidates = ["main", "master", "origin/main", "origin/master"]) {
  for (const c of candidates) {
    if (!refExists(c, cwd2)) continue;
    try {
      const mb = git(["merge-base", c, "HEAD"], { cwd: cwd2 }).trim();
      if (mb) return mb;
    } catch {
    }
  }
  return null;
}
function changedFiles(base3 = "HEAD", cwd2 = process.cwd()) {
  const raw2 = (args) => git(args, { cwd: cwd2, encoding: "buffer" });
  const worktree = splitNulPaths(raw2(["diff", "--name-only", "-z", base3, "--"]));
  const staged = splitNulPaths(raw2(["diff", "--cached", "--name-only", "-z", base3, "--"]));
  return [.../* @__PURE__ */ new Set([...worktree, ...staged])];
}
function isDirty(cwd2 = process.cwd()) {
  return git(["status", "--porcelain"], { cwd: cwd2 }).trim().length > 0;
}
function repoRoot(cwd2 = process.cwd()) {
  return git(["rev-parse", "--show-toplevel"], { cwd: cwd2 }).trim();
}
function coChange(limit = 500, cwd2 = process.cwd()) {
  const out = git(
    ["log", `-n`, String(limit), "--name-only", "--pretty=format:--COMMIT--"],
    { cwd: cwd2 }
  );
  const pairCounts = {};
  const fileCounts = {};
  for (const block of out.split("--COMMIT--")) {
    const files2 = [...new Set(block.split("\n").map((l) => l.trim()).filter(Boolean))];
    if (files2.length === 0 || files2.length > 50) continue;
    for (const f of files2) fileCounts[f] = (fileCounts[f] ?? 0) + 1;
    for (let i = 0; i < files2.length; i++) {
      for (let j = i + 1; j < files2.length; j++) {
        const key = pairKey(files2[i], files2[j]);
        pairCounts[key] = (pairCounts[key] ?? 0) + 1;
      }
    }
  }
  return { pairCounts, fileCounts };
}
function pairKey(a, b) {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}
var GIT_MAX_BUFFER;
var init_git = __esm({
  "node_modules/@adlc/core/lib/git.mjs"() {
    GIT_MAX_BUFFER = 64 * 1024 * 1024;
  }
});

// node_modules/@adlc/core/lib/cli.mjs
import { basename } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
function programName() {
  const entry = process.argv[1];
  if (!entry) return "adlc";
  return basename(entry).replace(/\.[cm]?js$/, "") || "adlc";
}
function synthesizeUsage(options) {
  const rows = Object.entries(options ?? {}).map(([name, spec]) => {
    const short = spec?.short ? `-${spec.short}, ` : "";
    const value = spec?.type === "string" ? spec.multiple ? " <value...>" : " <value>" : "";
    const shown = typeof spec?.default === "string" ? spec.default : JSON.stringify(spec?.default);
    const note = spec?.default === void 0 ? "" : `(default: ${shown})`;
    return [`  ${short}--${name}${value}`, note];
  });
  rows.push(["  -h, --help", "show this help"]);
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines2 = rows.map(([label, note]) => note ? `${label.padEnd(width + 2)}${note}` : label);
  return `usage: ${programName()} [options]

options:
${lines2.join("\n")}`;
}
function parseArgs(config) {
  const args = config?.args ?? process.argv.slice(2);
  const hasHelp = args.includes("--help") || args.includes("-h");
  if (hasHelp) {
    const declaresHelp = config?.options && ("help" in config.options || "h" in config.options);
    if (!declaresHelp) {
      if (config?.usage) {
        if (typeof config.usage === "function") {
          config.usage();
        } else {
          console.log(config.usage);
        }
      } else {
        console.log(synthesizeUsage(config?.options));
      }
      process.exit(0);
    }
  }
  return nodeParseArgs({ allowPositionals: true, ...config });
}
function pass(message) {
  if (message) console.log(message);
  process.exit(0);
}
function gateFail(message, details) {
  console.error(message);
  if (details !== void 0) {
    console.error(typeof details === "string" ? details : JSON.stringify(details, null, 2));
  }
  process.exit(2);
}
function opError(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}
function promptOnly(prompts) {
  const list = Array.isArray(prompts) ? prompts : [prompts];
  for (const [i, p] of list.entries()) {
    if (list.length > 1) console.log(`--- prompt ${i + 1} of ${list.length} ---`);
    console.log(p);
  }
  process.exit(0);
}
var init_cli = __esm({
  "node_modules/@adlc/core/lib/cli.mjs"() {
  }
});

// node_modules/@adlc/core/lib/ledger.mjs
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
function ledgerPath(name, dir = ADLC_DIR) {
  return join(dir, `${name}.jsonl`);
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLedgerLock(target, fn, { retries = LOCK_MAX_RETRIES, delayMs = LOCK_RETRY_DELAY_MS } = {}) {
  const lockPath = `${target}.lock`;
  mkdirSync(dirname(target), { recursive: true });
  const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  for (let i = 0; i <= retries; i++) {
    let fd;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (i < retries) sleepSync(delayMs);
      continue;
    }
    try {
      writeFileSync(fd, `${JSON.stringify(owner)}
`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8"));
        if (current.token === owner.token) unlinkSync(lockPath);
      } catch {
      }
    }
  }
  throw new Error(`could not acquire ledger lock: ${lockPath} (held > ${retries * delayMs}ms)`);
}
function parseLedger(content) {
  const entries = [];
  const skipped = [];
  const rawLines2 = [];
  for (const [i, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    rawLines2.push(line);
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      skipped.push({ line: i + 1, error: String(err.message ?? err) });
    }
  }
  return { entries, skipped, rawLines: rawLines2, lastRawLine: rawLines2.at(-1) ?? null };
}
function countEntryNewlines(value) {
  if (typeof value === "string") return (value.match(/[\r\n]/g) || []).length;
  if (Array.isArray(value)) return value.reduce((n2, v) => n2 + countEntryNewlines(v), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n2, v) => n2 + countEntryNewlines(v), 0);
  return 0;
}
function tokenEntropy(s) {
  const freq = /* @__PURE__ */ new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n2 of freq.values()) {
    const p = n2 / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
function looksLikeRandomSecret(text) {
  for (const token of String(text).split(/[\s"'`(){}\[\],:]+/)) {
    if (token.length < 32) continue;
    if (/^[0-9a-f]{1,40}$/i.test(token)) continue;
    if (/^[0-9a-f]{41,}$/i.test(token)) return true;
    if (!/[a-z]/.test(token) || !/[A-Z0-9]/.test(token)) continue;
    if (tokenEntropy(token) >= 4) return true;
  }
  return false;
}
function assertPublishableFinding(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("findings ledger: entry must be a finding object (a non-null, non-array object) \u2014 a bare null/scalar/array crashes the distillation pipeline (ADR 0014)");
  }
  if (typeof entry.desc !== "string" || entry.desc.trim().length === 0) {
    throw new Error("findings ledger: entry must carry a non-empty string `desc` (the clustering key) \u2014 an entry without it starves lesson-foundry (ADR 0014)");
  }
  const serialized = JSON.stringify(entry);
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`findings ledger: refusing to record \u2014 the entry appears to contain ${what}. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)`);
    }
  }
  if (looksLikeRandomSecret(serialized)) {
    throw new Error("findings ledger: refusing to record \u2014 the entry contains a long, high-entropy token that looks like a key or secret. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)");
  }
  const desc = typeof entry?.desc === "string" ? entry.desc : "";
  if (/[\r\n]/.test(desc)) {
    throw new Error("findings ledger: desc must be a single line of curated prose \u2014 raw multi-line tool output is not recordable (ADR 0014)");
  }
  if (desc.length > MAX_FINDING_DESC) {
    throw new Error(`findings ledger: desc is ${desc.length} chars; curated descriptions are capped at ${MAX_FINDING_DESC} to keep dumps out of the committed ledger (ADR 0014)`);
  }
  if (serialized.length > MAX_FINDING_ENTRY) {
    throw new Error(`findings ledger: entry is ${serialized.length} bytes serialized; curated findings are capped at ${MAX_FINDING_ENTRY} to keep raw dumps out of the committed, append-only ledger (ADR 0014)`);
  }
  const newlines = countEntryNewlines(entry);
  if (newlines > MAX_FINDING_LINES) {
    throw new Error(`findings ledger: entry spans ${newlines} lines across its fields; a curated finding is near-single-line, so this looks like a raw multi-line dump (transcript, diff hunk, stack trace, log paste) \u2014 describe the failure class instead (ADR 0014)`);
  }
}
function appendEntries(name, entriesOrFactory, dir = ADLC_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = ledgerPath(name, dir);
  return withLedgerLock(p, () => {
    const content = existsSync(p) ? readFileSync(p, "utf8") : "";
    const state = parseLedger(content);
    const additions = typeof entriesOrFactory === "function" ? entriesOrFactory(state) : entriesOrFactory;
    if (!Array.isArray(additions)) throw new TypeError("ledger append batch must be an array");
    if (additions.length === 0) return [];
    if (name === FINDINGS_LEDGER) for (const entry of additions) assertPublishableFinding(entry);
    const descriptor = openSync(p, "a");
    try {
      writeFileSync(descriptor, additions.map((entry) => `${JSON.stringify(entry)}
`).join(""));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (process.platform !== "win32") {
      const directory = openSync(dirname(p), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    return additions;
  });
}
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalizeJsonValue(value[key])])
    );
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}
function hashFiles(paths, readFile = (p) => readFileSync(p)) {
  const out = {};
  for (const p of paths) {
    try {
      out[p] = sha256(readFile(p));
    } catch {
      out[p] = null;
    }
  }
  return out;
}
var ADLC_DIR, LOCK_RETRY_DELAY_MS, LOCK_MAX_RETRIES, FINDINGS_LEDGER, MAX_FINDING_DESC, MAX_FINDING_ENTRY, MAX_FINDING_LINES, SECRET_PATTERNS;
var init_ledger = __esm({
  "node_modules/@adlc/core/lib/ledger.mjs"() {
    ADLC_DIR = ".adlc";
    LOCK_RETRY_DELAY_MS = 5;
    LOCK_MAX_RETRIES = 400;
    FINDINGS_LEDGER = "findings";
    MAX_FINDING_DESC = 600;
    MAX_FINDING_ENTRY = 4e3;
    MAX_FINDING_LINES = 10;
    SECRET_PATTERNS = [
      [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
      [/\bASIA[0-9A-Z]{16}\b/, "an AWS temporary access key id"],
      [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "a GitHub token"],
      [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "a GitHub fine-grained token"],
      [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "a GitLab token"],
      [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "an OpenAI API key"],
      [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
      [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
      [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, "a bearer token"],
      [/\b(?:api[-_]?key|secret|passwd|password|token|access[-_]?key)\b\s*[:=]\s*\S{8,}/i, "an inline credential assignment"],
      [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, "a JWT"]
    ];
  }
});

// node_modules/@adlc/tickets/lib/pointer.mjs
import { lstatSync, openSync as openSync2, fstatSync, readSync, closeSync as closeSync2, constants as fsConstants } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
function readPointerFileBounded(path) {
  let parentLst;
  try {
    parentLst = lstatSync(dirname2(path));
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!parentLst.isDirectory()) return null;
  let lst;
  try {
    lst = lstatSync(path);
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!lst.isFile() || lst.size > MAX_POINTER_BYTES) return null;
  let fd;
  try {
    fd = openSync2(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) return null;
    if (lst.dev !== 0 && lst.ino !== 0 && (stat.dev !== lst.dev || stat.ino !== lst.ino)) return null;
    const length = stat.size;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n2 = readSync(fd, buf, read, length - read, read);
      if (n2 === 0) break;
      read += n2;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    try {
      closeSync2(fd);
    } catch {
    }
  }
}
function conflictMessage(envId, fileId) {
  return `ADLC_TICKET ("${envId}") conflicts with ${CURRENT_TICKET_FILE} ("${fileId}"): they name different tickets. The active ticket is per-worktree state \u2014 ADLC supports exactly one active ticket per worktree, and parallel work on a second ticket needs its own worktree (git worktree add <path> -b <branch>), not a second pointer in this one. Failing closed: which ticket governs this build cannot be determined.`;
}
function readActiveTicketPointer(root2 = ".") {
  const path = join2(root2, CURRENT_TICKET_FILE);
  const raw2 = readPointerFileBounded(path);
  if (raw2 === ABSENT) return ok({ present: false });
  if (raw2 === null) {
    return fail("operational", "INVALID_CURRENT_TICKET", `cannot read ${CURRENT_TICKET_FILE} as a bounded regular file`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw2);
  } catch (error) {
    return invalid("INVALID_CURRENT_TICKET", `cannot parse ${CURRENT_TICKET_FILE}: ${error.message}`);
  }
  if (typeof parsed === "string") {
    const id2 = parsed.trim();
    if (!id2) return invalid("INVALID_CURRENT_TICKET", `${CURRENT_TICKET_FILE} is an empty string pointer`);
    return ok({ present: true, id: id2, ticketHash: null, legacyString: true });
  }
  if (!isPlainObject(parsed)) {
    return invalid(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE} must be an object like {"id":"T1","ticketHash":"<64 hex>"} (got ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}). To deactivate, delete the file.`
    );
  }
  let usedKey = null;
  for (const key of [CANONICAL_ID_KEY, ...DEPRECATED_ID_KEYS]) {
    if (Object.hasOwn(parsed, key)) {
      usedKey = key;
      break;
    }
  }
  if (usedKey === null) {
    const found = Object.keys(parsed);
    return invalid(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE} declares no ticket id: expected "${CANONICAL_ID_KEY}" (or deprecated ${DEPRECATED_ID_KEYS.map((k) => `"${k}"`).join("/")}), found ${found.length ? found.map((k) => `"${k}"`).join(", ") : "no keys"}. Failing closed rather than treating an unrecognized pointer as "no active ticket". To deactivate, delete the file.`
    );
  }
  const id = trimmed(parsed[usedKey]);
  if (!id) {
    return invalid(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE} has a "${usedKey}" that is not a non-empty string`
    );
  }
  const value = { present: true, id, ticketHash: trimmed(parsed.ticketHash) || null, legacyString: false };
  if (usedKey !== CANONICAL_ID_KEY) value.deprecatedAlias = usedKey;
  return ok(value);
}
function resolveActiveTicketId({ root: root2 = ".", env = process.env } = {}) {
  const pointer = readActiveTicketPointer(root2);
  if (!pointer.ok) return pointer;
  const envId = trimmed(env.ADLC_TICKET) || null;
  const file = pointer.value;
  const fileId = file.present ? file.id : null;
  if (envId && fileId && envId !== fileId) return conflict("ACTIVE_TICKET_CONFLICT", conflictMessage(envId, fileId));
  const id = envId ?? fileId;
  if (!id) return ok(null);
  return ok({
    id,
    pointerPresent: file.present,
    ticketHash: file.present ? file.ticketHash : null,
    legacyString: file.present ? Boolean(file.legacyString) : false,
    ...file.deprecatedAlias ? { deprecatedAlias: file.deprecatedAlias } : {}
  });
}
function resolveActiveTicketAgainst(snapshot, { root: root2 = ".", env = process.env, allowLegacyPointer = false } = {}) {
  const resolved = resolveActiveTicketId({ root: root2, env });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok(null);
  const { id, pointerPresent, ticketHash: ticketHash2, legacyString, deprecatedAlias } = resolved.value;
  const ticket2 = snapshot.get(id);
  if (!ticket2) {
    return invalid("ACTIVE_TICKET_MISSING", `active ticket "${id}" is not in the ticket store`);
  }
  const expected = snapshot.ticketHashes[id];
  const warnings = [];
  if (deprecatedAlias) {
    warnings.push(
      `${CURRENT_TICKET_FILE} uses the deprecated "${deprecatedAlias}" key; rewrite it as {"id":"${id}","ticketHash":"${expected}"} ("${deprecatedAlias}" is removed in 2.0).`
    );
  }
  if (pointerPresent) {
    if (!ticketHash2) {
      const detail = legacyString ? "a legacy bare-string pointer pins no ticketHash" : `${CURRENT_TICKET_FILE} pins no ticketHash`;
      if (!allowLegacyPointer) {
        return invalid(
          "ACTIVE_TICKET_HASH_MISSING",
          `${detail}; it must pin ticketHash so a ticket changing after selection is detectable. Expected {"id":"${id}","ticketHash":"${expected}"}.`
        );
      }
      warnings.push(`${detail}; a ticket changing after selection cannot be detected. Expected ticketHash "${expected}". Strict in 2.0.`);
    } else if (ticketHash2 !== expected) {
      return conflict(
        "ACTIVE_TICKET_STALE",
        `active ticket "${id}" changed after selection (pointer pins ${ticketHash2}, store has ${expected}). Re-select the ticket to confirm you intend to build against the new contract.`
      );
    }
  }
  return ok({
    id,
    ticket: ticket2,
    ticketHash: expected,
    storeHash: snapshot.hash,
    warnings,
    ...deprecatedAlias ? { deprecatedAlias } : {}
  });
}
var CURRENT_TICKET_FILE, MAX_POINTER_BYTES, ABSENT, CANONICAL_ID_KEY, DEPRECATED_ID_KEYS, ok, fail, invalid, conflict, isPlainObject, trimmed;
var init_pointer = __esm({
  "node_modules/@adlc/tickets/lib/pointer.mjs"() {
    CURRENT_TICKET_FILE = ".adlc/current-ticket.json";
    MAX_POINTER_BYTES = 64 * 1024;
    ABSENT = /* @__PURE__ */ Symbol("pointer-absent");
    CANONICAL_ID_KEY = "id";
    DEPRECATED_ID_KEYS = Object.freeze(["ticket", "ticketId"]);
    ok = (value) => ({ ok: true, value });
    fail = (kind, code, message) => ({ ok: false, kind, code, message });
    invalid = (code, message) => fail("invalid", code, message);
    conflict = (code, message) => fail("conflict", code, message);
    isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    trimmed = (value) => typeof value === "string" ? value.trim() : "";
  }
});

// node_modules/@adlc/tickets/lib/constants.mjs
var ACTIVE_MANIFEST, ARCHIVE_MANIFEST, ACTIVE_DIRECTORY, ARCHIVE_DIRECTORY, LEGACY_FILE, LEGACY_ARCHIVE_FILE, LOCK_DIRECTORY, TRANSACTION_DIRECTORY, TICKET_HASH_DOMAIN, STORE_HASH_DOMAIN;
var init_constants = __esm({
  "node_modules/@adlc/tickets/lib/constants.mjs"() {
    init_pointer();
    ACTIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-directory", version: 1 });
    ARCHIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-archive", version: 1 });
    ACTIVE_DIRECTORY = ".adlc/tickets";
    ARCHIVE_DIRECTORY = ".adlc/ticket-archive";
    LEGACY_FILE = ".adlc/tickets.json";
    LEGACY_ARCHIVE_FILE = ".adlc/tickets.archive.json";
    LOCK_DIRECTORY = ".adlc/tickets.lock";
    TRANSACTION_DIRECTORY = ".adlc/ticket-transactions";
    TICKET_HASH_DOMAIN = "adlc:ticket:v1\0";
    STORE_HASH_DOMAIN = "adlc:active-store:v1\0";
  }
});

// node_modules/@adlc/tickets/lib/errors.mjs
function exitCodeFor(error) {
  return error?.kind === "operational" ? 1 : 2;
}
var TicketStoreError, invalid2, conflict2, policy, operational;
var init_errors = __esm({
  "node_modules/@adlc/tickets/lib/errors.mjs"() {
    TicketStoreError = class extends Error {
      constructor(kind, code, message, details) {
        super(message);
        this.name = "TicketStoreError";
        this.kind = kind;
        this.code = code;
        if (details !== void 0) this.details = details;
      }
    };
    invalid2 = (code, message, details) => new TicketStoreError("invalid", code, message, details);
    conflict2 = (code, message, details) => new TicketStoreError("conflict", code, message, details);
    policy = (code, message, details) => new TicketStoreError("policy", code, message, details);
    operational = (code, message, details) => new TicketStoreError("operational", code, message, details);
  }
});

// node_modules/@adlc/tickets/lib/canonical.mjs
import { createHash as createHash2 } from "node:crypto";
function compareTicketIds(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return Buffer.compare(a, b);
}
function normalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid2("NON_JSON_VALUE", `${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== "object") throw invalid2("NON_JSON_VALUE", `${path} contains ${typeof value}`);
  const output = {};
  for (const key of Object.keys(value).sort(compareTicketIds)) {
    const item = value[key];
    if (item === void 0 || typeof item === "function" || typeof item === "symbol") {
      throw invalid2("NON_JSON_VALUE", `${path}.${key} is not JSON`);
    }
    output[key] = normalize(item, `${path}.${key}`);
  }
  return output;
}
function storeHash(tickets2) {
  const pairs = tickets2.map((ticket2) => [ticket2.id, ticketHash(ticket2)]).sort(([left], [right]) => compareTicketIds(left, right));
  return sha2562(STORE_HASH_DOMAIN + canonicalJson2(pairs));
}
var canonicalJson2, prettyCanonicalJson, sha2562, ticketHash;
var init_canonical = __esm({
  "node_modules/@adlc/tickets/lib/canonical.mjs"() {
    init_errors();
    init_constants();
    canonicalJson2 = (value) => JSON.stringify(normalize(value));
    prettyCanonicalJson = (value) => `${JSON.stringify(normalize(value), null, 2)}
`;
    sha2562 = (value) => createHash2("sha256").update(value).digest("hex");
    ticketHash = (ticket2) => sha2562(TICKET_HASH_DOMAIN + canonicalJson2(ticket2));
  }
});

// node_modules/@adlc/tickets/lib/ids.mjs
import { randomBytes } from "node:crypto";
function encode(value, width) {
  let remaining = BigInt(value);
  let output = "";
  for (let index = 0; index < width; index += 1) {
    output = ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}
function generateTicketId(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281474976710655) throw new RangeError("ULID timestamp out of range");
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError("ULID entropy must be 10 bytes");
  const random = BigInt(`0x${entropy.toString("hex")}`);
  return `T-${encode(BigInt(now), 10)}${encode(random, 16)}`;
}
var ALPHABET;
var init_ids = __esm({
  "node_modules/@adlc/tickets/lib/ids.mjs"() {
    ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  }
});

// node_modules/@adlc/tickets/lib/filename.mjs
function ticketSlug(id) {
  const slug = id.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return slug || "ticket";
}
var ticketFilename;
var init_filename = __esm({
  "node_modules/@adlc/tickets/lib/filename.mjs"() {
    init_canonical();
    ticketFilename = (id) => `${ticketSlug(id)}--${sha2562(Buffer.from(id, "utf8"))}.json`;
  }
});

// node_modules/@adlc/tickets/lib/schema.mjs
function validateTicket(ticket2, { archive = false } = {}) {
  const errors = [];
  if (!ticket2 || typeof ticket2 !== "object" || Array.isArray(ticket2)) return ["ticket is not an object"];
  if (typeof ticket2.id !== "string" || ticket2.id.length === 0) errors.push("missing string id");
  if (typeof ticket2.title !== "string" || ticket2.title.length === 0) errors.push(`${ticket2.id ?? "?"}: missing string title`);
  for (const field of ["scope", "rails"]) {
    if (ticket2[field] !== void 0 && (!Array.isArray(ticket2[field]) || ticket2[field].some((item) => typeof item !== "string"))) {
      errors.push(`${ticket2.id ?? "?"}: ${field} must be an array of strings`);
    }
  }
  if (ticket2.edges !== void 0) {
    if (!Array.isArray(ticket2.edges)) errors.push(`${ticket2.id ?? "?"}: edges must be an array`);
    else for (const edge of ticket2.edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge) || typeof edge.to !== "string" || edge.to.length === 0) {
        errors.push(`${ticket2.id ?? "?"}: edge missing string "to"`);
      }
    }
  }
  if (ticket2.duration !== void 0 && (typeof ticket2.duration !== "number" || !Number.isFinite(ticket2.duration) || ticket2.duration <= 0)) {
    errors.push(`${ticket2.id ?? "?"}: duration must be a positive number`);
  }
  if (!archive && Object.hasOwn(ticket2, "_adlcArchive")) errors.push(`${ticket2.id ?? "?"}: _adlcArchive is reserved for archived tickets`);
  if (archive && ticket2._adlcArchive !== void 0) {
    const metadata = ticket2._adlcArchive;
    if (!metadata || typeof metadata !== "object" || metadata.version !== 1 || typeof metadata.ticketHash !== "string") {
      errors.push(`${ticket2.id ?? "?"}: invalid _adlcArchive metadata`);
    }
  }
  return errors;
}
function validateTickets(tickets2, { archive = false, validateGraph = !archive } = {}) {
  if (!Array.isArray(tickets2)) throw invalid2("INVALID_ENVELOPE", "tickets must be an array");
  const errors = [];
  const byId = /* @__PURE__ */ new Map();
  for (const ticket2 of tickets2) {
    errors.push(...validateTicket(ticket2, { archive }));
    if (typeof ticket2?.id === "string") {
      if (byId.has(ticket2.id)) errors.push(`duplicate ticket id: ${ticket2.id}`);
      byId.set(ticket2.id, ticket2);
    }
  }
  if (validateGraph) {
    for (const ticket2 of tickets2) {
      for (const edge of Array.isArray(ticket2?.edges) ? ticket2.edges : []) {
        if (typeof edge?.to === "string" && !byId.has(edge.to)) errors.push(`${ticket2.id}: edge to unknown ticket ${edge.to}`);
      }
    }
    const color2 = /* @__PURE__ */ new Map();
    const visit = (id, stack) => {
      if (color2.get(id) === 1) {
        errors.push(`cycle in ticket DAG: ${[...stack, id].join(" -> ")}`);
        return;
      }
      if (color2.get(id) === 2) return;
      color2.set(id, 1);
      const ticket2 = byId.get(id);
      for (const edge of Array.isArray(ticket2?.edges) ? ticket2.edges : []) if (byId.has(edge.to)) visit(edge.to, [...stack, id]);
      color2.set(id, 2);
    };
    for (const id of [...byId.keys()].sort(compareTicketIds)) visit(id, []);
  }
  if (errors.length) throw invalid2("INVALID_TICKET_STORE", `ticket store validation failed (${errors.length} error(s))`, errors);
  return tickets2;
}
var init_schema = __esm({
  "node_modules/@adlc/tickets/lib/schema.mjs"() {
    init_errors();
    init_canonical();
  }
});

// node_modules/@adlc/tickets/lib/help.mjs
function categoryWarning(category) {
  if (category === void 0) return null;
  if (SYNC_CATEGORIES.includes(category)) return null;
  return `warning: category ${JSON.stringify(category)} is not one ticket-sync accepts, so a synced ticket cannot converge. Use one of: ${SYNC_CATEGORIES.join(", ")}.`;
}
function wrap(text, width, indent) {
  const lines2 = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      lines2.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines2.push(indent + line);
  return lines2;
}
function fieldTable() {
  const width = Math.max(...TICKET_FIELDS.map((field) => field.name.length));
  const body = FIELD_INDENT.repeat(3);
  const lines2 = [];
  for (const field of TICKET_FIELDS) {
    lines2.push(`${FIELD_INDENT}${field.name.padEnd(width)}  ${field.type}${field.required ? " (required)" : ""}`);
    lines2.push(...wrap(field.summary, 92 - body.length, body));
  }
  return lines2;
}
function renderCommandHelp(command) {
  const render = COMMAND_HELP[command];
  return render ? render().join("\n") : null;
}
function renderUsage() {
  return [
    "adlc ticket <command> [options]",
    "",
    "Commands:",
    "  list | show <id>",
    "  create --input <path|-> [--write]",
    "  update <id> --input <path|-> [--expect <ticket-hash>] [--write]",
    "  edit <id> [--write]",
    "  discard <id> [--write]",
    "  complete <id> [--write --authorize]",
    "  archive <id> [--write --authorize] | restore <id> [--write --authorize]",
    "  doctor [--archive] | schema | store status",
    "  store migrate [--write --yes] | store recover (--complete|--rollback)",
    "  store export --output <path>",
    "",
    "Run `adlc ticket <command> --help` for the flags and input document of one",
    "command, or `adlc ticket schema` for the ticket JSON Schema.",
    "",
    "All mutations are dry-run by default. New override: --ticket-store/ADLC_TICKET_STORE.",
    "Legacy --tickets/ADLC_TICKETS remains available through 1.x.",
    "",
    "Once any ticket declares a rail, the store is a frozen trust root: every write",
    "appends a signed audit entry and needs ADLC_MANIFEST_KEY (or --allow-unsigned).",
    "See `adlc ticket create --help`."
  ].join("\n");
}
function ticketJsonSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_ID,
    title: "ADLC ticket",
    description: "A stored ADLC ticket. `adlc ticket create` accepts the same document without `id`, which the store mints as a ULID.",
    type: "object",
    required: ["id", "title"],
    properties: Object.fromEntries(
      TICKET_FIELDS.map((field) => [field.name, { ...field.schema, description: field.summary }])
    ),
    additionalProperties: true
  };
}
var SCHEMA_ID, SYNC_CATEGORIES, TICKET_FIELDS, CREATE_EXAMPLE, FIELD_INDENT, createExampleJson, INPUT_DOCUMENT, AUTHORIZE_NOTE, TRUST_ROOT_NOTE, COMMAND_HELP;
var init_help = __esm({
  "node_modules/@adlc/tickets/lib/help.mjs"() {
    SCHEMA_ID = "https://adlc.dev/schemas/ticket-v1.json";
    SYNC_CATEGORIES = Object.freeze([
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
    TICKET_FIELDS = [
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
    CREATE_EXAMPLE = {
      title: "Reject unsigned webhook deliveries",
      body: "Verify the HMAC signature on every inbound webhook before dispatch.\n\nAcceptance criteria:\n1. An unsigned delivery is rejected with 401. Verify: node --test test/webhook.test.mjs\n2. A delivery signed with a stale secret is rejected. Verify: node --test test/webhook.test.mjs",
      category: "feature",
      duration: 2,
      scope: ["src/webhook/**", "test/webhook.test.mjs"],
      rails: [],
      edges: []
    };
    FIELD_INDENT = "  ";
    createExampleJson = () => JSON.stringify(CREATE_EXAMPLE, null, 2);
    INPUT_DOCUMENT = [
      "Input document (--input <path> or - for stdin; see `adlc ticket schema`):",
      "",
      ...fieldTable(),
      "",
      "Unknown fields are preserved as-is; the store never strips them."
    ];
    AUTHORIZE_NOTE = [
      "--authorize is REQUIRED for a change the service treats as sensitive, and",
      "there are exactly three: narrowing rails (dropping a path the ticket froze),",
      "widening scope (adding a path it may touch), and changing `completed` \u2014 which",
      "belongs to `adlc ticket complete`, where it carries lifecycle evidence. Any of",
      "them without the flag fails AUTHORIZATION_REQUIRED and writes nothing.",
      "Everything else \u2014 title, body, category, duration, budget, edges \u2014 needs no",
      "authorization."
    ];
    TRUST_ROOT_NOTE = [
      "FROZEN TRUST ROOT. Once any ticket declares a rail, the ticket store is the",
      "configuration that decides what the rail guards freeze, so the store itself is",
      "frozen: every --write against it is a deliberate, AUDITED override that appends",
      "one signed `ticket-mutation` entry to the gate-manifest (a mutation that already",
      "records evidence of its own keeps that entry and gains the audit fields \u2014 one",
      "mutation is never two entries).",
      "",
      "Signing it needs ADLC_MANIFEST_KEY. Without the key the write REFUSES before it",
      "touches the store, because an unsigned entry proves nothing about who made the",
      "change and the manifest is append-only, so it would be permanent. Pass",
      "--allow-unsigned to record an unsigned entry on purpose.",
      "",
      "A store where NO ticket declares a rail \u2014 in the active set OR the archive \u2014 is",
      "not a trust root: authoring there needs no key and records nothing. Completing,",
      "archiving or discarding the last railed ticket does not thaw it: that removal is",
      "itself an audited override, and the manifest keeps the record even after the",
      "ticket is gone. Expiring a build's rails must not unfreeze the rail config."
    ];
    COMMAND_HELP = {
      create: () => [
        "adlc ticket create --input <path|-> [--write] [--allow-unsigned] [--json]",
        "",
        "Plan a new ticket. Dry-run by default: the plan, validation, graph effects,",
        "file operations, and resulting hashes print, and nothing is written until",
        "--write. The command never stages or commits.",
        "",
        ...TRUST_ROOT_NOTE,
        "",
        ...INPUT_DOCUMENT,
        "",
        "Example (pipe it straight in: `adlc ticket create --input - < ticket.json`):",
        "",
        createExampleJson()
      ],
      update: () => [
        "adlc ticket update <id> --input <path|-> --expect <ticketHash> [--authorize] [--force] [--write] [--allow-unsigned] [--json]",
        "",
        "Replace a ticket in place. This is a REPLACEMENT, not a merge: any field",
        "absent from the input is dropped, including `completed`, so building an",
        "update from the field table below quietly retires lifecycle state it never",
        "meant to touch. Start from the stored ticket instead.",
        "",
        "`adlc ticket edit <id>` is the path that gets this right for you: it opens",
        "the stored ticket and supplies the expected hash. Scripting it by hand takes",
        "the ticket OUT of the show envelope first \u2014 `show --json` returns",
        "ticket/ticketHash/storeHash, and feeding that envelope straight back in",
        "fails IDENTITY_CHANGE_REQUIRES_REASSIGN because the id sits one level down:",
        "",
        "  adlc ticket show T1 --json > T1.envelope.json   # capture ONCE",
        "  jq .ticket T1.envelope.json > T1.json           # edit this",
        "  adlc ticket update T1 --input T1.json --write \\",
        '    --expect "$(jq -r .ticketHash T1.envelope.json)"',
        "",
        "Both the document and the hash come from the SAME capture. Reading them",
        "with two separate `show` calls defeats the guard entirely: a write landing",
        "between the two hands you a current hash paired with a stale document, so",
        "the compare-and-swap passes and silently reverts the other author.",
        "",
        "The input must carry the same id. Changing a ticket's identity is a",
        "library-only operation (TicketService.planReassign) \u2014 this CLI exposes no",
        "reassign verb, so discard-and-recreate is the supported route here.",
        "",
        ...AUTHORIZE_NOTE,
        "",
        "--expect is REQUIRED to --write. Give it the current ticketHash from",
        "`adlc ticket show <id> --json` or `adlc ticket list --json`; the write is",
        "then a compare-and-swap that fails STALE_TICKET if the ticket moved",
        "underneath you. Because update REPLACES, applying a document exported",
        "before someone else's write would otherwise discard their work in silence,",
        "so --write without it fails EXPECT_REQUIRED. Pass --force to replace",
        "whatever is there now. Planning needs no hash \u2014 a dry run is unrestricted.",
        "",
        ...TRUST_ROOT_NOTE,
        "",
        ...INPUT_DOCUMENT
      ],
      edit: () => [
        "adlc ticket edit <id> [--authorize] [--write] [--json]",
        "",
        "Open the ticket in $EDITOR (or $VISUAL) and plan the result as an update.",
        "The expected hash is supplied for you. Dry-run by default.",
        "",
        ...AUTHORIZE_NOTE,
        "",
        ...TRUST_ROOT_NOTE,
        "",
        ...INPUT_DOCUMENT
      ],
      discard: () => [
        "adlc ticket discard <id> [--write] [--allow-unsigned] [--json]",
        "",
        "Remove a ticket that was never built. Dry-run by default. Use archive to",
        "retire a ticket whose history must be kept.",
        "",
        ...TRUST_ROOT_NOTE
      ],
      complete: () => [
        "adlc ticket complete <id> [--write --authorize] [--allow-unsigned] [--json]",
        "",
        "Mark a ticket complete. The plan is recorded as a lifecycle change and",
        "carries evidence either way.",
        "",
        "--authorize records that a human approved the change. It is ENFORCED only",
        "for a protected id, and this CLI configures no protected ids \u2014 so by",
        "default `complete <id> --write` applies without it.",
        "",
        ...TRUST_ROOT_NOTE
      ],
      archive: () => [
        "adlc ticket archive <id> [--write --authorize] [--allow-unsigned] [--json]",
        "",
        "Move a ticket into .adlc/ticket-archive with evidence. Requires a directory",
        "store. `adlc ticket restore <id>` is the inverse.",
        "",
        ...TRUST_ROOT_NOTE
      ],
      restore: () => [
        "adlc ticket restore <id> [--write --authorize] [--allow-unsigned] [--json]",
        "",
        "Move an archived ticket back into the active store. Requires a directory",
        "store.",
        "",
        ...TRUST_ROOT_NOTE
      ],
      list: () => [
        "adlc ticket list [--json]",
        "",
        "Print every active ticket as id, title, and ticketHash. The hash is what",
        "`update --expect` takes."
      ],
      show: () => [
        "adlc ticket show <id> [--json]",
        "",
        "Print one ticket with its ticketHash and the store hash."
      ],
      doctor: () => [
        "adlc ticket doctor [--archive] [--json]",
        "",
        "Diagnose the store: manifest, shard integrity, the active-ticket pointer,",
        "and any pending transaction awaiting recovery."
      ],
      schema: () => [
        "adlc ticket schema [--json]",
        "",
        "Print the JSON Schema for a stored ticket. It describes the same fields",
        "`create --help` documents; `id` is required there because the service has",
        "already minted it by the time a ticket is stored."
      ],
      store: () => [
        "adlc ticket store <status|migrate|recover|export> [options]",
        "",
        "  status                       backend, format version, ticket count, hashes",
        "  migrate [--write --yes]      preview or apply the legacy -> sharded migration",
        "  recover (--complete|--rollback)  finish or undo an interrupted transaction",
        "  export --output <path>       write a legacy-shaped snapshot"
      ]
    };
  }
});

// node_modules/@adlc/tickets/lib/edit.mjs
import { execFileSync as execFileSync2 } from "node:child_process";
import { mkdtempSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { basename as basename2, join as join3 } from "node:path";
function planEditSession(service, id, { authorized = false, editor, runEditor = spawnEditor, onEdited } = {}) {
  const opened = service.snapshot();
  const ticket2 = opened.get(id);
  if (!ticket2) throw new TicketStoreError("invalid", "TICKET_NOT_FOUND", `ticket not found: ${id}`);
  const expect = opened.ticketHashes[ticket2.id];
  if (!editor) throw new TicketStoreError("operational", "EDITOR_NOT_SET", "set $EDITOR or $VISUAL");
  const directory = mkdtempSync(join3(tmpdir(), "adlc-ticket-edit-"));
  const path = join3(directory, `${basename2(id)}.json`);
  try {
    writeFileSync2(path, `${JSON.stringify(ticket2, null, 2)}
`);
    runEditor(editor, path);
    const edited = JSON.parse(readFileSync2(path, "utf8"));
    onEdited?.(edited);
    const plan = service.planUpdate(ticket2.id, edited, { expect, authorized });
    return { plan, draftPath: path };
  } catch (error) {
    if (error && typeof error.message === "string") {
      error.message = `${error.message} (your edit is preserved at ${path})`;
    }
    throw error;
  }
}
var spawnEditor;
var init_edit = __esm({
  "node_modules/@adlc/tickets/lib/edit.mjs"() {
    init_errors();
    spawnEditor = (editor, path) => execFileSync2(editor, [path], { stdio: "inherit" });
  }
});

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
var TicketSnapshot;
var init_snapshot = __esm({
  "node_modules/@adlc/tickets/lib/snapshot.mjs"() {
    init_canonical();
    TicketSnapshot = class {
      #byId;
      constructor({ backend, formatVersion, tickets: tickets2 }) {
        this.backend = backend;
        this.formatVersion = formatVersion;
        this.tickets = deepFreeze(deepClone(tickets2).sort((left, right) => compareTicketIds(left.id, right.id)));
        this.hash = storeHash(this.tickets);
        this.ticketHashes = deepFreeze(Object.fromEntries(this.tickets.map((ticket2) => [ticket2.id, ticketHash(ticket2)])));
        this.#byId = new Map(this.tickets.map((ticket2) => [ticket2.id, ticket2]));
        Object.freeze(this);
      }
      get(id) {
        return this.#byId.get(id);
      }
      mutableTickets() {
        return deepClone(this.tickets);
      }
    };
  }
});

// node_modules/@adlc/tickets/lib/stores/directory.mjs
import { existsSync as existsSync2, lstatSync as lstatSync2, readFileSync as readFileSync3, readdirSync } from "node:fs";
import { dirname as dirname3, join as join4, resolve } from "node:path";
function assertRealDirectory(path) {
  let stat;
  try {
    stat = lstatSync2(path);
  } catch (error) {
    if (error.code === "ENOENT") throw operational("STORE_NOT_FOUND", `ticket store not found: ${path}`);
    throw operational("STORE_READ_FAILED", `cannot inspect ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid2("UNSAFE_STORE_PATH", `${path} must be a real directory`);
  const parent = dirname3(path);
  if (parent !== path) {
    const parentStat = lstatSync2(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid2("UNSAFE_STORE_PATH", `${parent} must be a real directory`);
  }
}
var DirectoryTicketStore;
var init_directory = __esm({
  "node_modules/@adlc/tickets/lib/stores/directory.mjs"() {
    init_constants();
    init_errors();
    init_canonical();
    init_filename();
    init_schema();
    init_snapshot();
    DirectoryTicketStore = class {
      constructor(path = ACTIVE_DIRECTORY, { archive = false } = {}) {
        this.path = path;
        this.archive = archive;
      }
      exists() {
        return existsSync2(this.path);
      }
      load() {
        assertRealDirectory(this.path);
        const expectedManifest = this.archive ? ARCHIVE_MANIFEST : ACTIVE_MANIFEST;
        const entries = readdirSync(this.path, { withFileTypes: true });
        const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
        if (names.size !== entries.length) throw invalid2("CASE_COLLISION", `${this.path} contains case-insensitive name collisions`);
        const manifestEntry = entries.find((entry) => entry.name === ".store.json");
        if (!manifestEntry || !manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw invalid2("INVALID_MANIFEST", `${this.path}/.store.json must be a regular file`);
        let manifest;
        try {
          manifest = JSON.parse(readFileSync3(join4(this.path, ".store.json"), "utf8"));
        } catch (error) {
          throw invalid2("INVALID_MANIFEST", `invalid store manifest: ${error.message}`);
        }
        if (canonicalJson2(manifest) !== canonicalJson2(expectedManifest)) {
          const hint = Number.isInteger(manifest?.version) && manifest.version > 1 ? "upgrade @adlc/tickets to read this store" : "expected format version 1";
          throw invalid2("UNSUPPORTED_STORE_FORMAT", `unsupported ticket store manifest (${hint})`, manifest);
        }
        const tickets2 = [];
        for (const entry of entries) {
          if (entry.name === ".store.json") continue;
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
            throw invalid2("UNRECOGNIZED_STORE_ENTRY", `unrecognized or unsafe ticket store entry: ${entry.name}`);
          }
          const fullPath = join4(this.path, entry.name);
          const stat = lstatSync2(fullPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw invalid2("UNSAFE_SHARD", `${entry.name} must be a regular file`);
          let ticket2;
          try {
            ticket2 = JSON.parse(readFileSync3(fullPath, "utf8"));
          } catch (error) {
            throw invalid2("INVALID_JSON", `invalid JSON in ${entry.name}: ${error.message}`);
          }
          if (!ticket2 || typeof ticket2 !== "object" || Array.isArray(ticket2) || typeof ticket2.id !== "string") {
            throw invalid2("INVALID_SHARD", `${entry.name} must contain one ticket object`);
          }
          const expected = ticketFilename(ticket2.id);
          if (entry.name !== expected) throw invalid2("FILENAME_MISMATCH", `${entry.name} does not match ticket id ${ticket2.id}; expected ${expected}`);
          tickets2.push(ticket2);
        }
        validateTickets(tickets2, { archive: this.archive, validateGraph: !this.archive });
        return new TicketSnapshot({ backend: "directory", formatVersion: 1, tickets: tickets2 });
      }
      resolvedPath() {
        return resolve(this.path);
      }
    };
  }
});

// node_modules/@adlc/tickets/lib/lock.mjs
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync4, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname4, join as join5 } from "node:path";
function acquireTicketLock(root2 = ".", {
  retries = 50,
  delayMs = 20,
  command = process.argv.join(" "),
  transactionId = null,
  writeOwner = writeFileSync3,
  removeLock = rmSync,
  makeLockDirectory = mkdirSync2
} = {}) {
  const path = join5(root2, LOCK_DIRECTORY);
  if (!isLockMetadata({ version: 1, pid: process.pid, hostname: "", startedAt: "", command, transactionId })) {
    throw invalid2(
      "INVALID_LOCK_OPTIONS",
      "acquireTicketLock requires a string command and a string-or-null transactionId; a lock written from other values could not be released by its own owner."
    );
  }
  mkdirSync2(dirname4(path), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let created = false;
    try {
      const metadata = { version: 1, pid: process.pid, hostname: hostname2(), startedAt: (/* @__PURE__ */ new Date()).toISOString(), command, transactionId };
      const serialized = `${JSON.stringify(metadata, null, 2)}
`;
      makeLockDirectory(path);
      created = true;
      writeOwner(join5(path, "owner.json"), serialized, { flag: "wx" });
      return { path, metadata };
    } catch (error) {
      if (created) {
        try {
          removeLock(path, { recursive: true, force: true });
        } catch (cleanupError) {
          throw operational(
            "LOCK_STRANDED",
            `could not acquire the ticket lock (${error.message}), and could not remove the partial lock at ${path} (${cleanupError.message}). Remove that directory to unblock later ticket writers.`
          );
        }
      }
      if (error.code !== "EEXIST") throw operational("LOCK_FAILED", `cannot acquire ticket lock: ${error.message}`);
      if (attempt < retries) sleep(delayMs);
    }
  }
  throw conflict2("LOCK_TIMEOUT", `could not acquire ${LOCK_DIRECTORY}; another ticket writer is running`, readTicketLock(root2));
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
function readLockMetadata(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return null;
  }
  return isLockMetadata(parsed) ? parsed : null;
}
function readTicketLock(root2 = ".") {
  return readLockMetadata(join5(root2, LOCK_DIRECTORY, "owner.json"));
}
function releaseTicketLock(lock, { removeLock = rmSync } = {}) {
  if (!lock?.path) return { released: false, reason: "no-lock" };
  if (!existsSync3(lock.path)) return { released: false, reason: "no-lock" };
  const owner = readLockMetadata(join5(lock.path, "owner.json"));
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
var sleep;
var init_lock = __esm({
  "node_modules/@adlc/tickets/lib/lock.mjs"() {
    init_constants();
    init_errors();
    sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
});

// node_modules/@adlc/tickets/lib/durability.mjs
import {
  closeSync as closeSync3,
  copyFileSync,
  existsSync as existsSync4,
  fsyncSync as fsyncSync2,
  mkdirSync as mkdirSync3,
  openSync as openSync3,
  renameSync,
  rmSync as rmSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { dirname as dirname5, resolve as resolve2 } from "node:path";
function fsyncFile(path) {
  const descriptor = openSync3(path, "r+");
  try {
    fsyncSync2(descriptor);
  } finally {
    closeSync3(descriptor);
  }
}
function fsyncDirectory(path) {
  if (process.platform === "win32") return false;
  const descriptor = openSync3(path, "r");
  try {
    fsyncSync2(descriptor);
  } finally {
    closeSync3(descriptor);
  }
  return true;
}
function durableMkdir(path) {
  const missing = [];
  let cursor = resolve2(path);
  while (!existsSync4(cursor)) {
    missing.push(cursor);
    const parent = dirname5(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync3(path, { recursive: true });
  if (missing.length === 0) {
    fsyncDirectory(resolve2(path));
    return;
  }
  for (const directory of missing.reverse()) {
    fsyncDirectory(directory);
    fsyncDirectory(dirname5(directory));
  }
}
function durableWrite(path, content) {
  const descriptor = openSync3(path, "w");
  try {
    writeFileSync4(descriptor, content);
    fsyncSync2(descriptor);
  } finally {
    closeSync3(descriptor);
  }
  fsyncDirectory(dirname5(resolve2(path)));
}
function durableCopy(source, target) {
  copyFileSync(source, target);
  fsyncFile(target);
  fsyncDirectory(dirname5(resolve2(target)));
}
function durableRename(source, target) {
  const sourceParent = dirname5(resolve2(source));
  const targetParent = dirname5(resolve2(target));
  renameSync(source, target);
  fsyncDirectory(targetParent);
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent);
}
function durableRemove(path, options) {
  const parent = dirname5(resolve2(path));
  rmSync2(path, options);
  fsyncDirectory(parent);
}
var init_durability = __esm({
  "node_modules/@adlc/tickets/lib/durability.mjs"() {
  }
});

// node_modules/@adlc/tickets/lib/manifest-segments.mjs
import { existsSync as existsSync5, lstatSync as lstatSync3, readdirSync as readdirSync2, readFileSync as readFileSync5, writeFileSync as writeFileSync5, openSync as openSync4, readSync as readSync2, closeSync as closeSync4, unlinkSync as unlinkSync2, mkdirSync as mkdirSync4, constants as fsConstants2 } from "node:fs";
import { execFileSync as execFileSync3 } from "node:child_process";
import { randomBytes as randomBytes2, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname6, join as join6, relative, sep } from "node:path";
function looksLikeGenuineLedgerLock(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync5(path, "utf8").trim());
  } catch {
  }
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.startedAt === "string";
}
function segmentDirPath(dir) {
  return join6(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir, name) {
  return join6(segmentDirPath(dir), name);
}
function markerPath(dir) {
  return join6(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir) {
  return join6(segmentDirPath(dir), LINEAGE_NAME);
}
function discoverSegments(dir) {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync3(segDir);
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
  const invalid3 = [];
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    let st;
    try {
      st = lstatSync3(join6(segDir, name));
    } catch (err) {
      invalid3.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      invalid3.push({ name, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      invalid3.push({ name, reason: "nested directory" });
      continue;
    }
    if (!st.isFile()) {
      invalid3.push({ name, reason: "not a regular file" });
      continue;
    }
    if (name === LINEAGE_NAME) continue;
    if (name.endsWith(".lock")) {
      if (looksLikeGenuineLedgerLock(join6(segDir, name), st.size)) continue;
      invalid3.push({ name, reason: "lock-suffixed object is not a genuine advisory lock" });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid3.push({ name, reason: "bad filename grammar" });
      continue;
    }
    valid.push(name);
  }
  return { valid, invalid: invalid3 };
}
function readRawLines(filePath) {
  if (!existsSync5(filePath)) return [];
  return readFileSync5(filePath, "utf8").split("\n").filter((line) => line.trim() !== "");
}
function parseLines(lines2) {
  return lines2.map((line) => {
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
    return canonicalJson2(signed);
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
function chainIsIntact(lines2, key = null) {
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  for (const line of lines2) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    const expectedPrev = prevLine === null ? null : sha2562(prevLine);
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
  if (!chainIsIntact(readRawLines(join6(dir, "manifest.jsonl")), key)) return false;
  const { valid, invalid: invalid3 } = discoverSegments(dir);
  if (invalid3.length > 0) return false;
  return valid.every((name) => chainIsIntact(readRawLines(segmentPath(dir, name)), key));
}
function readForestEntries(dir) {
  const root2 = parseLines(readRawLines(join6(dir, "manifest.jsonl")));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines(segmentPath(dir, name))));
  return [...root2, ...segments];
}
function readBoundedJsonNoFollow(path) {
  let st;
  try {
    st = lstatSync3(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync4(path, fsConstants2.O_RDONLY | fsConstants2.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync2(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync4(fd);
  }
}
function hasActivationMarker(dir) {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir) {
  const raw2 = readRawLines(join6(dir, "manifest.jsonl"));
  if (raw2.length === 0) return false;
  try {
    const last = JSON.parse(raw2.at(-1));
    return Boolean(last) && typeof last === "object" && last.gate === "manifest-cutover";
  } catch {
    return false;
  }
}
function isSegmentedRepo(dir) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}
function encodeUlidPart(value, width) {
  let remaining = BigInt(value);
  let output = "";
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}
function generateSegmentUlid(now = Date.now(), entropy = randomBytes2(10)) {
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
function currentBranch(cwd2) {
  try {
    const out = execFileSync3("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cwd2, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync3(path);
  } catch {
    return false;
  }
  return !st.isFile();
}
function writeLineageToken(dir, token) {
  mkdirSync4(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync2(p);
  const fd = openSync4(p, fsConstants2.O_WRONLY | fsConstants2.O_CREAT | fsConstants2.O_TRUNC | fsConstants2.O_NOFOLLOW);
  try {
    writeFileSync5(fd, JSON.stringify(token));
  } finally {
    closeSync4(fd);
  }
}
function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - ".jsonl".length - 26, segmentName.length - ".jsonl".length);
}
function peekOpenSegment(dir, { cwd: cwd2 = dirname6(dir) } = {}) {
  const branch = currentBranch(cwd2);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    if (discoverSegments(dir).valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}
function firstEntryOf(dir, segmentName) {
  let fd;
  try {
    fd = openSync4(segmentPath(dir, segmentName), fsConstants2.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync2(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === "") return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync4(fd);
  }
}
function recoverOpenSegment(dir, { cwd: cwd2 = dirname6(dir) } = {}) {
  const peeked = peekOpenSegment(dir, { cwd: cwd2 });
  if (peeked) return peeked;
  const branch = currentBranch(cwd2);
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
  const probeCwd = dirname6(dir);
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const run = (args) => {
    try {
      execFileSync3("git", args, { cwd: probeCwd, env, stdio: "ignore" });
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
function resolveOpenSegment(dir, { cwd: cwd2 = dirname6(dir), key = null } = {}) {
  const markerDoc = readBoundedJsonNoFollow(markerPath(dir));
  if (markerDoc && markerDoc.auth === "keyed" && key === null) {
    throw new Error(
      "this forest was activated in keyed mode, but no signing key was provided for this write \u2014 an unsigned entry here would permanently strand every keyed clone of this branch; configure the manifest key"
    );
  }
  const peeked = peekOpenSegment(dir, { cwd: cwd2 });
  if (peeked) return peeked;
  if (key !== null) {
    const recovered = recoverOpenSegment(dir, { cwd: cwd2 });
    if (recovered) {
      const lines2 = readRawLines(segmentPath(dir, recovered.name));
      let first = null;
      try {
        first = JSON.parse(lines2[0]);
      } catch {
      }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first);
      if (!chainIsIntact(lines2, key) || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key (broken chain, or its branch-bearing first entry lacks a verified v2 signature) \u2014 refusing to extend it, and refusing to mint a duplicate past it (that would silently fork this branch's lineage)`
        );
      }
      return recovered;
    }
  } else {
    let candidateExists = false;
    try {
      candidateExists = recoverOpenSegment(dir, { cwd: cwd2 }) !== null;
    } catch {
      candidateExists = true;
    }
    if (candidateExists) {
      throw new Error(
        "a committed segment already declares this branch, and with no signing key this writer can neither authenticate and extend it nor safely mint alongside it (a fresh token would shadow the committed evidence from every later read) \u2014 configure the manifest key, or restore the local .lineage token"
      );
    }
  }
  const branch = currentBranch(cwd2);
  const rootLines = readRawLines(join6(dir, "manifest.jsonl"));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    let lastEntry = null;
    try {
      lastEntry = JSON.parse(rootLast);
    } catch {
    }
    if (lastEntry) anchor = { segment: "root", seq: lastEntry.seq, lineHash: sha2562(rootLast) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? "");
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable(dir, name);
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...branch !== null ? { branch } : {} };
}
var SEGMENT_DIRNAME, SEGMENT_NAME_RE, RESERVED_NAMES, MARKER_NAME, LINEAGE_NAME, MARKER_FORMAT, MARKER_VERSION, MAX_LOCAL_JSON_BYTES, MAX_LOCK_OWNER_BYTES, ULID_ALPHABET, MAX_FIRST_LINE_BYTES, OVERSIZED_FIRST_ENTRY, MALFORMED_FIRST_ENTRY;
var init_manifest_segments = __esm({
  "node_modules/@adlc/tickets/lib/manifest-segments.mjs"() {
    init_canonical();
    SEGMENT_DIRNAME = "manifest.d";
    SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
    RESERVED_NAMES = /* @__PURE__ */ new Set([".store.json"]);
    MARKER_NAME = ".store.json";
    LINEAGE_NAME = ".lineage";
    MARKER_FORMAT = "adlc-manifest-segments";
    MARKER_VERSION = 1;
    MAX_LOCAL_JSON_BYTES = 4096;
    MAX_LOCK_OWNER_BYTES = 512;
    ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    MAX_FIRST_LINE_BYTES = 65536;
    OVERSIZED_FIRST_ENTRY = /* @__PURE__ */ Symbol("oversized-first-entry");
    MALFORMED_FIRST_ENTRY = /* @__PURE__ */ Symbol("malformed-first-entry");
  }
});

// node_modules/@adlc/tickets/lib/key-contract.mjs
function validateKeyParam(key) {
  if (key === null) return null;
  if (typeof key === "string" && key.length > 0) return key;
  throw new TypeError(
    `manifest key parameter must be a non-empty string (a key) or null (explicitly no key); got ${key === "" ? "'' (empty string)" : typeof key}. Resolve the environment in the bin (getKey()) and thread the value down \u2014 library code never reads process.env.`
  );
}
function resolveKeyFromEnv(env = process.env) {
  const k = env.ADLC_MANIFEST_KEY;
  return typeof k === "string" && k.length > 0 ? k : null;
}
var init_key_contract = __esm({
  "node_modules/@adlc/tickets/lib/key-contract.mjs"() {
  }
});

// node_modules/@adlc/tickets/lib/evidence.mjs
import { closeSync as closeSync5, existsSync as existsSync6, fsyncSync as fsyncSync3, mkdirSync as mkdirSync5, openSync as openSync5, readFileSync as readFileSync6, unlinkSync as unlinkSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { createHmac as createHmac2, randomUUID as randomUUID2 } from "node:crypto";
import { hostname as hostname3 } from "node:os";
import { dirname as dirname7, join as join7 } from "node:path";
function withManifestLock(path, fn, { retries = 400, delayMs = 5 } = {}) {
  const lockPath = `${path}.lock`;
  mkdirSync5(dirname7(path), { recursive: true });
  const owner = { version: 1, token: randomUUID2(), pid: process.pid, hostname: hostname3(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync5(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt < retries) sleep2(delayMs);
      continue;
    }
    try {
      writeFileSync6(descriptor, `${JSON.stringify(owner)}
`);
      fsyncSync3(descriptor);
    } finally {
      closeSync5(descriptor);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync6(lockPath, "utf8"));
        if (current.token === owner.token) unlinkSync3(lockPath);
      } catch {
      }
    }
  }
  throw conflict2("MANIFEST_LOCK_TIMEOUT", `could not acquire manifest lock: ${lockPath}`);
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
  return createHmac2("sha256", key).update(canonicalJson2(signed)).digest("hex");
}
function auditFieldsMatch(entry, data, acceptLegacyMatch) {
  if (acceptLegacyMatch && AUDIT_FIELDS.every((field) => entry.data?.[field] === void 0)) return true;
  for (const field of AUDIT_FIELDS) {
    if (canonicalJson2(entry.data?.[field] ?? null) !== canonicalJson2(data[field] ?? null)) return false;
  }
  return true;
}
function findMatchingEvidence(entries, { gate, data, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, transactionId, key = null, acceptLegacyMatch = false }) {
  for (const entry of entries) {
    if (entry?.data?.transactionId === transactionId && entry?.data?.action === action) {
      if (key !== null && !entrySigValid(key, entry)) continue;
      const matches = entry.gate === gate && (entry.ticket ?? null) === ticketId && entry.data.operation === operation && (entry.data.ticketHash ?? null) === ticketHash2 && entry.data.storeHash === storeHash2 && (entry.data.archiveHash ?? null) === archiveHash && entry.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry, data, acceptLegacyMatch);
      if (!matches) throw conflict2("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
      return entry;
    }
  }
  return null;
}
function recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch = false }) {
  return withManifestLock(lineagePath(dir), () => {
    if (!forestChainsIntact(dir, { key })) {
      throw conflict2("INVALID_MANIFEST", "manifest forest is invalid: a segment or root chain is broken, or an entry is unsigned/forged \u2014 refusing to append or trust the idempotency scan");
    }
    const existing = findMatchingEvidence(readForestEntries(dir), { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch });
    if (existing) return existing;
    const resolved = resolveOpenSegment(dir, { cwd: dirname7(dir), key });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync5(dirname7(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync6(targetPath) ? readFileSync6(targetPath, "utf8") : "";
      const rawLines2 = content.split("\n").filter((line) => line.trim() !== "");
      if (resolved.isNew && rawLines2.length > 0) {
        throw conflict2("INVALID_MANIFEST", `segment ${resolved.name} was expected to be new but already has content`);
      }
      if (!resolved.isNew && rawLines2.length === 0) {
        throw conflict2("INVALID_MANIFEST", `segment ${resolved.name} was expected to already be open with content but is empty or missing`);
      }
      let previous = null;
      for (const line of rawLines2) {
        try {
          previous = JSON.parse(line);
        } catch {
          throw conflict2("INVALID_MANIFEST", `segment ${resolved.name} contains malformed JSON`);
        }
      }
      const prevRawLine = rawLines2.at(-1) ?? null;
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
        prev: prevRawLine === null ? null : sha2562(prevRawLine)
      };
      if (key) {
        if (resolved.isNew) entry.sigVersion = 2;
        entry.sig = entry.sigVersion === 2 ? signV2(key, entry) : sign(key, entry);
      }
      const descriptor = openSync5(targetPath, "a");
      try {
        writeFileSync6(descriptor, `${JSON.stringify(entry)}
`);
        fsyncSync3(descriptor);
      } finally {
        closeSync5(descriptor);
      }
      fsyncDirectory(dirname7(targetPath));
      return entry;
    });
  });
}
function recordTicketEvidence(root2, {
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
  const dir = join7(root2, ".adlc");
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
  const path = join7(root2, ".adlc/manifest.jsonl");
  return withManifestLock(path, () => {
    const content = existsSync6(path) ? readFileSync6(path, "utf8") : "";
    const lines2 = content.split("\n").filter((line) => line.trim());
    if (isSegmentedRepo(dir)) {
      throw conflict2("MANIFEST_FROZEN", "manifest chain is frozen; this repo uses .adlc/manifest.d/ \u2014 upgrade adlc if you are seeing this locally");
    }
    for (const line of lines2) {
      try {
        const entry2 = JSON.parse(line);
        if (entry2.data?.transactionId === transactionId && entry2.data?.action === action) {
          if (signingKey !== null && !entrySigValid(signingKey, entry2)) continue;
          const matches = entry2.gate === gate && (entry2.ticket ?? null) === ticketId && entry2.data.operation === operation && (entry2.data.ticketHash ?? null) === ticketHash2 && entry2.data.storeHash === storeHash2 && (entry2.data.archiveHash ?? null) === archiveHash && entry2.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry2, data, acceptLegacyMatch);
          if (!matches) throw conflict2("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
          return entry2;
        }
      } catch (error) {
        if (error?.code === "EVIDENCE_IDEMPOTENCY_CONFLICT") throw error;
        throw conflict2("INVALID_MANIFEST", "cannot append ticket evidence to a malformed manifest");
      }
    }
    if (lines2.length === 0) {
      let hasExistingSegments;
      try {
        hasExistingSegments = readForestEntries(dir).length > 0;
      } catch {
        hasExistingSegments = false;
      }
      if (hasExistingSegments) {
        throw conflict2("MANIFEST_FROZEN", "refusing to create the root manifest: manifest.d/ already holds segment(s) anchored to nothing (anchor: null), legal only in a rootless forest \u2014 this usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted");
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
      prev: previous ? sha2562(previous) : null
    };
    if (signingKey) entry.sig = sign(signingKey, entry);
    const descriptor = openSync5(path, "a");
    try {
      writeFileSync6(descriptor, `${JSON.stringify(entry)}
`);
      fsyncSync3(descriptor);
    } finally {
      closeSync5(descriptor);
    }
    fsyncDirectory(dirname7(path));
    return entry;
  });
}
var sleep2, AUDIT_FIELDS;
var init_evidence = __esm({
  "node_modules/@adlc/tickets/lib/evidence.mjs"() {
    init_errors();
    init_canonical();
    init_durability();
    init_manifest_segments();
    init_key_contract();
    sleep2 = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    AUDIT_FIELDS = ["bypass", "op", "ticketId", "storeHashBefore", "storeHashAfter", "ticketIds"];
  }
});

// node_modules/@adlc/tickets/lib/trust-root.mjs
import { existsSync as existsSync7, lstatSync as lstatSync4, readFileSync as readFileSync7, readdirSync as readdirSync3 } from "node:fs";
import { join as join8 } from "node:path";
function assertNotSymlink(path) {
  let stat;
  try {
    stat = lstatSync4(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw operational("TRUST_ROOT_PATH_UNREADABLE", `cannot determine whether ${path} holds trust-root evidence: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw invalid2("UNSAFE_STORE_PATH", `${path} must be a real path, not a symlink \u2014 trust-root evidence read through a link is not this repo's own`);
  }
}
function storeDeclaresRails(tickets2) {
  if (!Array.isArray(tickets2)) return true;
  return tickets2.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const rails = item.rails;
    if (rails === void 0) return false;
    if (!Array.isArray(rails)) return true;
    return rails.length > 0;
  });
}
function archiveDeclaresRails(root2) {
  const directory = join8(root2, ARCHIVE_DIRECTORY);
  const legacy = join8(root2, LEGACY_ARCHIVE_FILE);
  assertNotSymlink(directory);
  assertNotSymlink(legacy);
  if (existsSync7(directory)) {
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
          const marker = JSON.parse(readFileSync7(join8(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join8(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync7(join8(directory, entry.name), "utf8"));
      } catch {
        return true;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.id !== "string") return true;
      if (storeDeclaresRails([parsed])) return true;
    }
    if (!sawMarker) return true;
  }
  if (existsSync7(legacy)) {
    try {
      const parsed = JSON.parse(readFileSync7(legacy, "utf8"));
      if (storeDeclaresRails(parsed?.tickets)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function manifestRecordsBypass(root2) {
  const rootManifest = join8(root2, ".adlc", "manifest.jsonl");
  const segments = join8(root2, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files2 = [rootManifest];
  if (existsSync7(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join8(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files2.push(join8(segments, entry.name));
      }
    } catch {
      return true;
    }
  }
  for (const file of files2) {
    if (!existsSync7(file)) continue;
    let text;
    try {
      text = readFileSync7(file, "utf8");
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
function repoDeclaresRails(root2, tickets2) {
  assertNotSymlink(join8(root2, ".adlc"));
  return storeDeclaresRails(tickets2) || archiveDeclaresRails(root2) || manifestRecordsBypass(root2);
}
function assertWriteIsSignable({ key, allowUnsigned = false } = {}) {
  const resolved = validateKeyParam(key);
  if (resolved !== null || allowUnsigned) return;
  throw policy(
    "MANIFEST_KEY_REQUIRED",
    "this ticket store is a frozen trust root (a ticket declares rails), so mutating it is an audited override \u2014 and ADLC_MANIFEST_KEY is not set, so the audit entry would be written UNSIGNED, proving nothing about who made the change. Refusing before the write: nothing has changed.\n  Set ADLC_MANIFEST_KEY and re-run. It is commonly kept in the MAIN checkout's gitignored .env.local, which is ABSENT from a git worktree \u2014 from a worktree, export it explicitly.\n  To record an UNSIGNED audit entry on purpose, pass --allow-unsigned."
  );
}
function assertSignableTrustRootWrite(tickets2, { key, allowUnsigned = false, root: root2 = "." } = {}) {
  if (!repoDeclaresRails(root2, tickets2)) return false;
  assertWriteIsSignable({ key, allowUnsigned });
  return true;
}
var STORE_MARKER;
var init_trust_root = __esm({
  "node_modules/@adlc/tickets/lib/trust-root.mjs"() {
    init_constants();
    init_errors();
    init_key_contract();
    STORE_MARKER = ".store.json";
  }
});

// node_modules/@adlc/tickets/lib/transaction.mjs
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "node:fs";
import { basename as basename3, dirname as dirname8, isAbsolute, join as join9, relative as relative2, resolve as resolve3 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
function isWithin(parent, child) {
  const rel = relative2(resolve3(parent), resolve3(child));
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}
function safeJournalPath(root2, value, label, { permittedExternalTarget = null, permittedExternalRoot = null } = {}) {
  if (typeof value !== "string" || !value) throw invalid2("INVALID_JOURNAL", `${label} must be a non-empty relative path`);
  const absolute = resolve3(root2, value);
  const rel = relative2(resolve3(root2), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    if (permittedExternalTarget && absolute === resolve3(permittedExternalTarget)) return absolute;
    if (permittedExternalRoot && isWithin(permittedExternalRoot, absolute)) return absolute;
    throw invalid2("UNSAFE_JOURNAL_PATH", `${label} escapes the repository: ${value}`);
  }
  return absolute;
}
function journalPath(root2, path) {
  const absolute = resolve3(path);
  const rel = relative2(resolve3(root2), absolute);
  return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) ? rel : absolute;
}
function assertExactJournalPath(actual, expected, label) {
  if (resolve3(actual) !== resolve3(expected)) throw invalid2("INVALID_JOURNAL", `${label} does not match the transaction layout`);
}
function validateRecoveryOperation({ root: root2, store, transactionRoot, journal, item, index, target }) {
  const directoryStore = store.archive !== void 0;
  const role = item.role ?? (directoryStore && dirname8(target) === resolve3(store.path) ? "ticket" : directoryStore ? "auxiliary" : "legacy-store");
  let key;
  if (role === "legacy-store") {
    if (directoryStore || journal.operations.length !== 1 || item.action !== "write") {
      throw invalid2("INVALID_JOURNAL", "legacy recovery must contain exactly one store write");
    }
    assertExactJournalPath(target, store.path, "legacy operation target");
    key = basename3(store.path);
  } else if (role === "ticket") {
    if (!directoryStore || dirname8(target) !== resolve3(store.path) || basename3(target) !== item.filename || !SHARD_FILENAME.test(item.filename)) {
      throw invalid2("INVALID_JOURNAL", "ticket recovery target is not a shard in the configured store");
    }
    key = item.filename;
  } else if (role === "auxiliary") {
    const expectedAction = journal.operation === "archive" ? "write" : journal.operation === "restore" ? "delete" : null;
    if (!directoryStore || !expectedAction || item.action !== expectedAction || typeof journal.ticketId !== "string") {
      throw invalid2("INVALID_JOURNAL", "auxiliary recovery is only valid for archive or restore");
    }
    assertExactJournalPath(target, join9(root2, ARCHIVE_DIRECTORY, ticketFilename(journal.ticketId)), "archive operation target");
    const priorAuxiliaryCount = journal.operations.slice(0, index).filter((operation) => operation?.role === "auxiliary").length;
    key = `aux-${priorAuxiliaryCount}`;
  } else {
    throw invalid2("INVALID_JOURNAL", `unsupported recovery operation role: ${role}`);
  }
  if (item.action === "write") {
    const stage = safeJournalPath(root2, item.stage, "operation stage");
    assertExactJournalPath(stage, join9(transactionRoot, "stage", key), "operation stage");
  } else if (item.stage !== null && item.stage !== void 0) {
    throw invalid2("INVALID_JOURNAL", "delete recovery operation must not contain a stage");
  }
  if (item.backup) {
    const backup = safeJournalPath(root2, item.backup, "operation backup");
    assertExactJournalPath(backup, join9(transactionRoot, "backup", key), "operation backup");
  }
}
function evidenceBinding(before, tickets2, ticketId, beforeTicketId = null) {
  const priorId = beforeTicketId ?? ticketId;
  const desired = ticketId ? tickets2.find((ticket2) => ticket2.id === ticketId) : null;
  const logicalTicketHash = desired ? ticketHash(desired) : null;
  return {
    beforeTicketId: priorId,
    beforeTicketHash: priorId ? before.ticketHashes[priorId] ?? (priorId === ticketId ? logicalTicketHash : null) : null,
    afterTicketHash: ticketId ? logicalTicketHash ?? before.ticketHashes[priorId] ?? null : null
  };
}
function transactionChangesAnything(before, tickets2, auxiliaryOperations) {
  return storeHash(tickets2) !== before.hash || auxiliaryOperations.length > 0;
}
function bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root: root2 }) {
  if (!assertSignableTrustRootWrite(before.tickets, { key, allowUnsigned, root: root2 })) return null;
  return { gate: evidenceRequired ? `ticket-${operation}` : "ticket-mutation", storeHashBefore: before.hash };
}
function applyDirectoryTransaction(store, tickets2, { expectedSnapshotHash, operation = "update", evidenceRequired = false, ticketId = null, beforeTicketId = null, root: root2 = ".", faultInjector = null, lock: existingLock = null, auxiliaryOperations = [], verify: verify2 = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  validateTickets(tickets2);
  const transactionId = randomUUID3();
  const lock = existingLock ?? acquireTicketLock(root2, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join9(root2, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict2("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets2, auxiliaryOperations) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root: root2 }) : null;
    const byFilename = new Map(tickets2.map((ticket2) => [ticketFilename(ticket2.id), ticket2]));
    const currentFilenames = new Set(before.tickets.map((ticket2) => ticketFilename(ticket2.id)));
    durableMkdir(join9(transactionRoot, "stage"));
    durableMkdir(join9(transactionRoot, "backup"));
    const operations = [];
    for (const [filename, ticket2] of byFilename) {
      const target = join9(store.path, filename);
      const stage = join9(transactionRoot, "stage", filename);
      const nextText = prettyCanonicalJson(ticket2);
      if (existsSync8(target) && readFileSync8(target, "utf8") === nextText) continue;
      durableWrite(stage, nextText);
      let backup = null;
      let beforeHash = null;
      if (existsSync8(target)) {
        backup = join9(transactionRoot, "backup", filename);
        durableCopy(target, backup);
        beforeHash = fileHash(backup);
      }
      operations.push({ role: "ticket", action: "write", filename, target: journalPath(root2, target), stage: relative2(root2, stage), backup: backup && relative2(root2, backup), beforeHash, afterHash: sha2562(nextText) });
    }
    for (const filename of currentFilenames) {
      if (byFilename.has(filename)) continue;
      const target = join9(store.path, filename);
      const backup = join9(transactionRoot, "backup", filename);
      durableCopy(target, backup);
      operations.push({ role: "ticket", action: "delete", filename, target: journalPath(root2, target), stage: null, backup: relative2(root2, backup), beforeHash: fileHash(backup), afterHash: null });
    }
    for (const [index, auxiliary] of auxiliaryOperations.entries()) {
      if (!["write", "delete"].includes(auxiliary.action)) throw invalid2("INVALID_AUXILIARY_OPERATION", `unsupported auxiliary action: ${auxiliary.action}`);
      const absoluteTarget = resolve3(isAbsolute(auxiliary.path) ? auxiliary.path : join9(root2, auxiliary.path));
      const relativeTarget = relative2(resolve3(root2), absoluteTarget);
      if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativeTarget)) {
        throw invalid2("UNSAFE_TRANSACTION_PATH", `auxiliary target escapes the repository: ${auxiliary.path}`);
      }
      const exists = existsSync8(absoluteTarget);
      if (auxiliary.mustBeAbsent && exists) throw conflict2("AUXILIARY_TARGET_EXISTS", `auxiliary target already exists: ${relativeTarget}`);
      if (auxiliary.mustExist && !exists) throw conflict2("AUXILIARY_TARGET_MISSING", `auxiliary target is missing: ${relativeTarget}`);
      const currentHash = exists ? fileHash(absoluteTarget) : null;
      if (auxiliary.expectedBeforeHash && currentHash !== auxiliary.expectedBeforeHash) throw conflict2("STALE_AUXILIARY_TARGET", `auxiliary target changed: ${relativeTarget}`);
      const key2 = `aux-${index}`;
      let backup = null;
      if (exists) {
        backup = join9(transactionRoot, "backup", key2);
        durableCopy(absoluteTarget, backup);
      }
      if (auxiliary.action === "write") {
        const stage = join9(transactionRoot, "stage", key2);
        durableWrite(stage, auxiliary.content);
        operations.push({ role: "auxiliary", action: "write", filename: relativeTarget, target: relativeTarget, stage: relative2(root2, stage), backup: backup && relative2(root2, backup), beforeHash: currentHash, afterHash: sha2562(auxiliary.content) });
      } else {
        operations.push({ role: "auxiliary", action: "delete", filename: relativeTarget, target: relativeTarget, stage: null, backup: backup && relative2(root2, backup), beforeHash: currentHash, afterHash: null });
      }
    }
    const afterHash = storeHash(tickets2);
    const binding = evidenceBinding(before, tickets2, ticketId, beforeTicketId);
    const journal = { version: 1, id: transactionId, operation, state: "prepared", beforeHash: before.hash, afterHash, evidenceRequired, bypassAudit: bypassAudit !== null, ticketId, ...binding, storePath: relative2(root2, store.path), operations };
    durableWrite(join9(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    faultInjector?.("journal-prepared", { transactionId, operations: operations.length });
    let applied2 = 0;
    for (const item of operations) {
      const target = resolve3(root2, item.target);
      if (item.action === "write") {
        const temporary = `${target}.txn-${transactionId}`;
        durableCopy(resolve3(root2, item.stage), temporary);
        durableRename(temporary, target);
      } else if (existsSync8(target)) {
        durableRemove(target);
      }
      applied2 += 1;
      faultInjector?.(`operation-applied:${applied2}`, { transactionId, operation: item });
    }
    faultInjector?.("before-final-verify", { transactionId });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid2("TRANSACTION_VERIFY_FAILED", `transaction produced ${after.hash}, expected ${afterHash}`);
    verify2?.(after);
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root2, {
      key,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}
    });
    journal.state = "complete";
    durableWrite(join9(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync8(join9(transactionRoot, "journal.json")) && existsSync8(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}
function applyLegacyTransaction(store, tickets2, { expectedSnapshotHash, operation = "update", evidenceRequired = false, ticketId = null, beforeTicketId = null, root: root2 = ".", faultInjector = null, lock: existingLock = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  validateTickets(tickets2);
  const transactionId = randomUUID3();
  const lock = existingLock ?? acquireTicketLock(root2, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join9(root2, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict2("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets2, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root: root2 }) : null;
    const target = resolve3(store.path);
    const recordedTarget = journalPath(root2, target);
    const stage = join9(transactionRoot, "stage", basename3(store.path));
    const backup = join9(transactionRoot, "backup", basename3(store.path));
    durableMkdir(dirname8(stage));
    durableMkdir(dirname8(backup));
    durableWrite(stage, prettyCanonicalJson({ tickets: tickets2 }));
    durableCopy(target, backup);
    const afterHash = storeHash(tickets2);
    const binding = evidenceBinding(before, tickets2, ticketId, beforeTicketId);
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
        stage: relative2(root2, stage),
        backup: relative2(root2, backup),
        beforeHash: fileHash(backup),
        afterHash: fileHash(stage)
      }]
    };
    durableWrite(join9(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    faultInjector?.("journal-prepared", { transactionId, operations: 1 });
    const temporary = `${target}.txn-${transactionId}`;
    durableCopy(stage, temporary);
    durableRename(temporary, target);
    faultInjector?.("operation-applied:1", { transactionId, operation: journal.operations[0] });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid2("TRANSACTION_VERIFY_FAILED", `transaction produced ${after.hash}, expected ${afterHash}`);
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root2, {
      key,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}
    });
    journal.state = "complete";
    durableWrite(join9(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync8(join9(transactionRoot, "journal.json")) && existsSync8(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}
function loadJournal(root2, transactionId) {
  if (!TRANSACTION_ID.test(transactionId)) throw invalid2("INVALID_TRANSACTION_ID", `invalid transaction id: ${transactionId}`);
  const transactionRoot = join9(root2, TRANSACTION_DIRECTORY, transactionId);
  try {
    const journal = JSON.parse(readFileSync8(join9(transactionRoot, "journal.json"), "utf8"));
    if (!journal || journal.version !== 1 || journal.operation === "migrate" || !Array.isArray(journal.operations)) throw new Error("unsupported journal shape");
    return { transactionRoot, journal };
  } catch (error) {
    throw invalid2("INVALID_JOURNAL", `cannot read transaction ${transactionId}: ${error.message}`);
  }
}
function writtenShardFilenames(journal) {
  const written = /* @__PURE__ */ new Set();
  for (const operation of journal.operations ?? []) {
    if (operation?.action === "write" && typeof operation.filename === "string") {
      written.add(operation.filename);
    }
  }
  return written;
}
function journalBackupsDeclareRails(root2, journal) {
  for (const operation of journal.operations ?? []) {
    if (!operation?.backup) continue;
    try {
      const path = resolve3(root2, operation.backup);
      if (typeof operation.beforeHash === "string" && fileHash(path) !== operation.beforeHash) return true;
      const parsed = JSON.parse(readFileSync8(path, "utf8"));
      if (storeDeclaresRails(Array.isArray(parsed?.tickets) ? parsed.tickets : [parsed])) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function recoverDirectoryTransaction(store, transactionId, { root: root2 = ".", direction, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  if (!["complete", "rollback"].includes(direction)) throw invalid2("RECOVERY_DIRECTION_REQUIRED", "choose complete or rollback");
  const { transactionRoot, journal } = loadJournal(root2, transactionId);
  const lock = acquireTicketLock(root2, { transactionId, command: `ticket:recover:${direction}` });
  try {
    let storeIsTrustRoot;
    let preRecoveryHash = null;
    try {
      const current = store.load();
      const wholeStoreReplaced = (journal.operations ?? []).some((operation) => operation?.role === "legacy-store");
      const written = writtenShardFilenames(journal);
      const preTransaction = wholeStoreReplaced ? [] : current.tickets.filter((item) => !written.has(ticketFilename(item.id)));
      storeIsTrustRoot = repoDeclaresRails(root2, preTransaction);
      preRecoveryHash = current.hash;
    } catch {
      storeIsTrustRoot = true;
    }
    const recoveryIsTrustRootWrite = storeIsTrustRoot || journalBackupsDeclareRails(root2, journal) || journal.bypassAudit === true;
    if (recoveryIsTrustRootWrite) assertWriteIsSignable({ key, allowUnsigned });
    let permittedExternalTarget = null;
    let permittedExternalRoot = null;
    if (store.path && journal.storePath) {
      const configuredStorePath = resolve3(store.path);
      const recordedStorePath = resolve3(root2, journal.storePath);
      if (recordedStorePath !== configuredStorePath) throw invalid2("INVALID_JOURNAL", "journal store path does not match the configured recovery store");
      const rel = relative2(resolve3(root2), configuredStorePath);
      if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
        if (store.archive === void 0) permittedExternalTarget = configuredStorePath;
        else permittedExternalRoot = configuredStorePath;
      }
    }
    for (const [index, item] of journal.operations.entries()) {
      if (!item || !["write", "delete"].includes(item.action)) throw invalid2("INVALID_JOURNAL", "journal contains an unsupported operation");
      const target = safeJournalPath(root2, item.target, "operation target", { permittedExternalTarget, permittedExternalRoot });
      validateRecoveryOperation({ root: root2, store, transactionRoot, journal, item, index, target });
      if (direction === "complete") {
        if (item.action === "delete") {
          if (existsSync8(target)) durableRemove(target);
          continue;
        }
        const stage = safeJournalPath(root2, item.stage, "operation stage");
        if (!existsSync8(stage) || fileHash(stage) !== item.afterHash) throw invalid2("CORRUPT_STAGE", `cannot verify staged ${item.filename}`);
        const temporary = `${target}.recovery-${transactionId}`;
        durableCopy(stage, temporary);
        durableRename(temporary, target);
      } else if (item.backup) {
        const backup = safeJournalPath(root2, item.backup, "operation backup");
        if (!existsSync8(backup) || fileHash(backup) !== item.beforeHash) throw invalid2("CORRUPT_BACKUP", `cannot verify backup ${item.filename}`);
        const temporary = `${target}.rollback-${transactionId}`;
        durableCopy(backup, temporary);
        durableRename(temporary, target);
      } else if (existsSync8(target)) {
        durableRemove(target);
      }
    }
    const snapshot = store.load();
    const expected = direction === "complete" ? journal.afterHash : journal.beforeHash;
    if (snapshot.hash !== expected) throw invalid2("RECOVERY_VERIFY_FAILED", `recovery produced ${snapshot.hash}, expected ${expected}`);
    const recoveryAudit = recoveryIsTrustRootWrite ? {
      gate: journal.evidenceRequired ? `ticket-${journal.operation}` : "ticket-mutation",
      storeHashBefore: preRecoveryHash ?? journal.beforeHash
    } : null;
    if (journal.evidenceRequired || recoveryAudit) {
      const recoveredTicketId = direction === "rollback" ? journal.beforeTicketId ?? journal.ticketId : journal.ticketId;
      const recordedTicketHash = direction === "rollback" ? journal.beforeTicketHash : journal.afterTicketHash;
      const recoveredTicketHash = recoveredTicketId ? snapshot.ticketHashes[recoveredTicketId] ?? recordedTicketHash ?? null : null;
      if (recoveredTicketId && !recoveredTicketHash) throw invalid2("RECOVERY_EVIDENCE_UNBOUND", `cannot bind recovery evidence to ticket ${recoveredTicketId}`);
      if (direction === "complete" && recoveryAudit) {
        recordTicketEvidence(root2, {
          key,
          transactionId,
          operation: journal.operation,
          ticketId: journal.ticketId,
          ticketHash: journal.afterTicketHash,
          storeHash: journal.afterHash,
          gate: recoveryAudit.gate,
          bypass: true,
          storeHashBefore: journal.beforeHash,
          acceptLegacyMatch: true
        });
      }
      recordTicketEvidence(root2, {
        key,
        transactionId,
        operation: journal.operation,
        action: `recover-${direction}`,
        ticketId: recoveredTicketId,
        ticketHash: recoveredTicketHash,
        storeHash: snapshot.hash,
        // On a rollback the store is back at `beforeHash`, so before and after
        // hashes match — which is precisely what the audit should say happened.
        ...recoveryAudit ? { gate: recoveryAudit.gate, bypass: true, storeHashBefore: recoveryAudit.storeHashBefore } : {}
      });
    }
    durableRemove(transactionRoot, { recursive: true, force: true });
    return snapshot;
  } finally {
    releaseTicketLock(lock);
  }
}
var fileHash, TRANSACTION_ID, SHARD_FILENAME;
var init_transaction = __esm({
  "node_modules/@adlc/tickets/lib/transaction.mjs"() {
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_lock();
    init_schema();
    init_evidence();
    init_durability();
    init_key_contract();
    init_trust_root();
    fileHash = (path) => sha2562(readFileSync8(path));
    TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    SHARD_FILENAME = /^[a-z0-9][a-z0-9-]*--[0-9a-f]{64}\.json$/;
  }
});

// node_modules/@adlc/tickets/lib/stores/legacy.mjs
import { existsSync as existsSync9, lstatSync as lstatSync5, readFileSync as readFileSync9 } from "node:fs";
import { basename as basename4, dirname as dirname9 } from "node:path";
function repositoryRootFor(path, explicit) {
  if (explicit !== null && explicit !== void 0) return explicit;
  const parent = dirname9(path);
  if (basename4(path) === basename4(LEGACY_FILE) && basename4(parent) === dirname9(LEGACY_FILE)) {
    return dirname9(parent);
  }
  throw invalid2(
    "AMBIGUOUS_STORE_ROOT",
    `cannot infer which repository governs ${path}: it is not the canonical <root>/${LEGACY_FILE} layout, so the trust-root evidence (archive, manifest, recorded overrides) would be read from the wrong directory and a frozen store could be written keylessly. Pass an explicit { root }.`
  );
}
var LegacyTicketStore;
var init_legacy = __esm({
  "node_modules/@adlc/tickets/lib/stores/legacy.mjs"() {
    init_transaction();
    init_constants();
    init_errors();
    init_schema();
    init_snapshot();
    LegacyTicketStore = class {
      constructor(path = LEGACY_FILE) {
        this.path = path;
      }
      exists() {
        return existsSync9(this.path);
      }
      /**
       * `root` is where the trust-root evidence is read from — the archive, the manifest,
       * and the recorded overrides that decide whether this store is frozen. It is
       * INFERRED only for the canonical `<root>/.adlc/tickets.json` layout, which keeps
       * the 1.x one-argument call working; anywhere else it must be passed, because
       * guessing wrong is not a cosmetic error (see repositoryRootFor).
       */
      write(tickets2, { key = null, allowUnsigned = false, root: root2 = null } = {}) {
        return applyLegacyTransaction(this, tickets2, {
          root: repositoryRootFor(this.path, root2),
          operation: "update",
          key,
          allowUnsigned
        });
      }
      load() {
        if (!this.exists()) throw operational("STORE_NOT_FOUND", `tickets file not found: ${this.path}`);
        const stat = lstatSync5(this.path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw invalid2("UNSAFE_STORE_PATH", `${this.path} must be a regular file`);
        const parentStat = lstatSync5(dirname9(this.path));
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid2("UNSAFE_STORE_PATH", `${dirname9(this.path)} must be a real directory`);
        let parsed;
        try {
          parsed = JSON.parse(readFileSync9(this.path, "utf8"));
        } catch (error) {
          throw invalid2("INVALID_JSON", `invalid JSON in ${this.path}: ${error.message}`);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.tickets)) {
          throw invalid2("INVALID_ENVELOPE", `${this.path} must contain { "tickets": [...] }`);
        }
        validateTickets(parsed.tickets);
        return new TicketSnapshot({ backend: "legacy", formatVersion: 0, tickets: parsed.tickets });
      }
    };
  }
});

// node_modules/@adlc/tickets/lib/store.mjs
import { existsSync as existsSync10, lstatSync as lstatSync6, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join10, resolve as resolve4 } from "node:path";
function pendingTransactions(root2 = ".") {
  const path = join10(root2, TRANSACTION_DIRECTORY);
  if (!existsSync10(path)) return [];
  const stat = lstatSync6(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict2("RECOVERY_REQUIRED", `${path} is not a safe transaction directory`);
  return readdirSync4(path).filter((entry) => !entry.startsWith(".")).sort();
}
function resolveStoreOverride({ root: root2 = ".", ticketStore, legacyTickets, env = process.env } = {}) {
  const modern = ticketStore ?? env.ADLC_TICKET_STORE;
  const legacy = legacyTickets ?? env.ADLC_TICKETS;
  if (modern && legacy && resolve4(rooted(root2, modern)) !== resolve4(rooted(root2, legacy))) {
    throw conflict2("CONFLICTING_STORE_OVERRIDE", "ADLC_TICKET_STORE/--ticket-store conflicts with ADLC_TICKETS/--tickets");
  }
  return modern ?? legacy ?? null;
}
function detectTicketStore(options = {}) {
  const { root: root2 = ".", allowRecovery = false } = options;
  if (!allowRecovery) {
    const pending = pendingTransactions(root2);
    if (pending.length) throw conflict2("RECOVERY_REQUIRED", `unfinished ticket transaction(s): ${pending.join(", ")}`);
  }
  const override = resolveStoreOverride(options);
  if (override) {
    const path = rooted(root2, override);
    if (path.endsWith(".json")) return new LegacyTicketStore(path);
    return new DirectoryTicketStore(path);
  }
  const legacy = new LegacyTicketStore(join10(root2, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join10(root2, ACTIVE_DIRECTORY));
  if (legacy.exists() && directory.exists()) throw conflict2("AMBIGUOUS_STORE", "both .adlc/tickets.json and .adlc/tickets/ exist; complete or roll back migration");
  if (directory.exists()) return directory;
  if (legacy.exists()) return legacy;
  throw operational("STORE_NOT_FOUND", `no ticket store found under ${resolve4(root2)}`);
}
var rooted;
var init_store = __esm({
  "node_modules/@adlc/tickets/lib/store.mjs"() {
    init_constants();
    init_errors();
    init_directory();
    init_legacy();
    rooted = (root2, path) => isAbsolute2(path) ? path : join10(root2, path);
  }
});

// node_modules/@adlc/tickets/lib/generated-glob-match.mjs
function globMatch(pattern, path) {
  const tokens = pattern.split(/(\*\*\/|\*\*|\*)/).filter((part) => part !== "");
  let reach = new Uint8Array(path.length + 1);
  const end = reach.length - 1;
  reach[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(reach.length);
    if (token === "**") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
      }
    } else if (token === "**/") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) {
          next[i] = 1;
          open = true;
        }
        if (open && i < end && path.charCodeAt(i) === SLASH) next[i + 1] = 1;
      }
    } else if (token === "*") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
        if (i < end && path.charCodeAt(i) === SLASH) open = false;
      }
    } else {
      for (let i = 0; i + token.length <= end; i++) {
        if (reach[i] && path.startsWith(token, i)) next[i + token.length] = 1;
      }
    }
    reach = next;
  }
  return reach[end] === 1;
}
var SLASH;
var init_generated_glob_match = __esm({
  "node_modules/@adlc/tickets/lib/generated-glob-match.mjs"() {
    SLASH = "/".charCodeAt(0);
  }
});

// node_modules/@adlc/tickets/lib/manifest-rails.mjs
import { existsSync as existsSync11, readdirSync as readdirSync5 } from "node:fs";
import { join as join11, relative as relative3, sep as sep2 } from "node:path";
function isNestedCheckout(dir) {
  return existsSync11(join11(dir, ".git"));
}
function discoverManifests(root2 = process.cwd()) {
  const found = [];
  const walk2 = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync5(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const child = join11(dir, entry.name);
        if (isNestedCheckout(child)) continue;
        walk2(child, depth + 1);
      } else if (entry.isFile() && MANIFEST_BASENAMES.includes(entry.name)) {
        found.push(relative3(root2, join11(dir, entry.name)).split(sep2).join("/"));
      }
    }
  };
  walk2(root2, 0);
  return found;
}
function coversManifest(glob, manifestPaths) {
  if (!Array.isArray(manifestPaths)) {
    throw new TypeError("coversManifest requires an explicit manifestPaths array (use discoverManifests())");
  }
  if (typeof glob !== "string" || glob === "") return false;
  return manifestPaths.some((path) => globMatch(glob, path));
}
var MANIFEST_BASENAMES, SKIP_DIRS, MAX_DEPTH;
var init_manifest_rails = __esm({
  "node_modules/@adlc/tickets/lib/manifest-rails.mjs"() {
    init_generated_glob_match();
    MANIFEST_BASENAMES = Object.freeze(["package.json", "plugin.json", "marketplace.json"]);
    SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".worktrees", "dist", "build", "coverage", ".next"]);
    MAX_DEPTH = 8;
  }
});

// node_modules/@adlc/tickets/lib/service.mjs
import { existsSync as existsSync12, readFileSync as readFileSync10 } from "node:fs";
import { join as join12 } from "node:path";
function awaitSnapshotHash(tickets2) {
  return storeHash(tickets2);
}
var publicPlan, planContent, comparable, changedFields, TicketService, serializePlan;
var init_service = __esm({
  "node_modules/@adlc/tickets/lib/service.mjs"() {
    init_canonical();
    init_constants();
    init_errors();
    init_filename();
    init_ids();
    init_snapshot();
    init_directory();
    init_legacy();
    init_transaction();
    init_schema();
    init_manifest_rails();
    publicPlan = (plan) => Object.fromEntries(Object.entries(plan).filter(([key]) => !key.startsWith("_")));
    planContent = (plan) => Object.fromEntries(Object.entries(publicPlan(plan)).filter(([key]) => key !== "planHash"));
    comparable = (value) => value === void 0 ? "__ADLC_ABSENT__" : canonicalJson2(value);
    changedFields = (before, after) => [.../* @__PURE__ */ new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((key) => comparable(before?.[key]) !== comparable(after?.[key])).sort();
    TicketService = class {
      /**
       * `allowUnsigned` (T-01M0122WMF8EJTB7ERHTEG8HMJ) opts into recording the
       * frozen-trust-root audit entry UNSIGNED when no key is available. It defaults
       * to false — off — so the refusal is what a caller gets by omitting it, and
       * writing an unaudited-in-practice entry stays a deliberate act at the call
       * site. See bypassAuditPlan in transaction.mjs for the contract.
       */
      constructor(store, { root: root2 = ".", protectedIds = [], key = null, allowUnsigned = false } = {}) {
        this.store = store;
        this.root = root2;
        this.key = key;
        this.allowUnsigned = allowUnsigned;
        this.protectedIds = new Set(protectedIds);
      }
      snapshot() {
        return this.store.load();
      }
      #plan(operation, mutate, { sensitive = [], evidenceRequired = false, expectedSnapshotHash = null } = {}) {
        const before = this.snapshot();
        if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) {
          throw conflict2("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
        }
        const tickets2 = before.mutableTickets();
        const detail = mutate(tickets2, before) ?? {};
        validateTickets(tickets2);
        const hashes = Object.fromEntries(tickets2.map((ticket2) => [ticket2.id, ticketHash(ticket2)]));
        const afterHash = awaitSnapshotHash(tickets2);
        const plan = {
          version: 1,
          operation,
          expectedSnapshotHash: before.hash,
          afterHash,
          ticketId: detail.ticketId ?? null,
          beforeTicketId: detail.beforeTicketId ?? detail.ticketId ?? null,
          changedFields: detail.changedFields ?? [],
          fileOperations: detail.fileOperations ?? [],
          graphEffects: detail.graphEffects ?? [],
          sensitive: detail.sensitive ?? sensitive,
          evidenceRequired: detail.evidenceRequired ?? evidenceRequired,
          validation: "valid",
          ticketHashes: hashes,
          _tickets: tickets2
        };
        plan.planHash = sha2562(`adlc:ticket-plan:v1\0${canonicalJson2(planContent(plan))}`);
        return Object.freeze(plan);
      }
      #assertIdNotArchived(id) {
        if (existsSync12(join12(this.root, ARCHIVE_DIRECTORY, ticketFilename(id)))) {
          throw conflict2("ARCHIVE_COLLISION", `archive already contains ${id}`);
        }
        const legacyArchive = join12(this.root, LEGACY_ARCHIVE_FILE);
        if (!existsSync12(legacyArchive)) return;
        let parsed;
        try {
          parsed = JSON.parse(readFileSync10(legacyArchive, "utf8"));
        } catch (error) {
          throw invalid2("INVALID_LEGACY_ARCHIVE", `cannot parse ${LEGACY_ARCHIVE_FILE}: ${error.message}`);
        }
        if (!parsed || !Array.isArray(parsed.tickets)) throw invalid2("INVALID_LEGACY_ARCHIVE", `${LEGACY_ARCHIVE_FILE} must contain a tickets array`);
        if (parsed.tickets.some((ticket2) => ticket2?.id === id)) throw conflict2("ARCHIVE_COLLISION", `archive already contains ${id}`);
      }
      // #235 — a rail must not freeze a manifest a lockstep release rewrites, or the
      // ticket blocks every release for its whole life (the #228 collision). Reject
      // such rails at AUTHORING time; #234 handles the release edit itself.
      //
      // `newRails` is the set to police — every rail on create, but only the
      // NEWLY-INTRODUCED rails on update, so a legacy ticket that already declares a
      // manifest-covering rail is grandfathered and its ordinary edits keep working.
      #assertNoManifestRails(newRails) {
        if (!Array.isArray(newRails) || newRails.length === 0) return;
        const manifests = discoverManifests(this.root);
        if (manifests.length === 0) return;
        const offenders = newRails.filter((rail) => coversManifest(rail, manifests));
        if (offenders.length === 0) return;
        throw policy(
          "RAIL_COVERS_MANIFEST",
          `rail(s) would freeze a manifest a release must rewrite: ${offenders.join(", ")}. Rail the source subtree instead (e.g. "packages/x/lib/**"), not the package root. See #235.`
        );
      }
      planCreate(input = {}) {
        const ticket2 = deepClone(input);
        if (!ticket2.id) ticket2.id = generateTicketId();
        this.#assertIdNotArchived(ticket2.id);
        this.#assertNoManifestRails(ticket2.rails);
        return this.#plan("create", (tickets2) => {
          if (tickets2.some((item) => item.id === ticket2.id)) throw conflict2("TICKET_EXISTS", `ticket already exists: ${ticket2.id}`);
          tickets2.push(ticket2);
          return { ticketId: ticket2.id, changedFields: Object.keys(ticket2).sort(), fileOperations: [{ action: "create", id: ticket2.id }] };
        });
      }
      planUpdate(id, input, { expect, authorized = false } = {}) {
        return this.#plan("update", (tickets2, snapshot) => {
          const index = tickets2.findIndex((ticket2) => ticket2.id === id);
          if (index < 0) throw invalid2("TICKET_NOT_FOUND", `ticket not found: ${id}`);
          if (input.id !== id) throw policy("IDENTITY_CHANGE_REQUIRES_REASSIGN", "update input id must match; use reassign for identity changes");
          if (expect && snapshot.ticketHashes[id] !== expect) throw conflict2("STALE_TICKET", `ticket ${id} hash changed`);
          const before = tickets2[index];
          const beforeRails = new Set(before.rails ?? []);
          this.#assertNoManifestRails((input.rails ?? []).filter((rail) => !beforeRails.has(rail)));
          const sensitive = [];
          if ((before.rails ?? []).some((rail) => !(input.rails ?? []).includes(rail))) sensitive.push("rail-narrowing");
          if ((input.scope ?? []).some((scope) => !(before.scope ?? []).includes(scope))) sensitive.push("scope-widening");
          const wasCompleted = before.completed === true;
          const nowCompleted = input.completed === true;
          if (wasCompleted !== nowCompleted) sensitive.push("lifecycle-change");
          if (sensitive.length && !authorized) throw policy("AUTHORIZATION_REQUIRED", `update requires authorization: ${sensitive.join(", ")}`);
          tickets2[index] = deepClone(input);
          return {
            ticketId: id,
            changedFields: changedFields(before, input),
            fileOperations: [{ action: "update", id }],
            sensitive,
            evidenceRequired: sensitive.length > 0
          };
        }, { evidenceRequired: authorized });
      }
      planDiscard(id) {
        return this.#plan("discard", (tickets2) => {
          if (this.protectedIds.has(id)) throw policy("PROTECTED_TICKET", `cannot discard protected ticket ${id}`);
          if (tickets2.some((ticket2) => (ticket2.edges ?? []).some((edge) => edge.to === id))) throw policy("TICKET_REFERENCED", `cannot discard referenced ticket ${id}`);
          const index = tickets2.findIndex((ticket2) => ticket2.id === id);
          if (index < 0) throw invalid2("TICKET_NOT_FOUND", `ticket not found: ${id}`);
          tickets2.splice(index, 1);
          return { ticketId: id, fileOperations: [{ action: "delete", id }] };
        });
      }
      planComplete(id, { authorized = false } = {}) {
        return this.#plan("complete", (tickets2) => {
          const ticket2 = tickets2.find((item) => item.id === id);
          if (!ticket2) throw invalid2("TICKET_NOT_FOUND", `ticket not found: ${id}`);
          if (this.protectedIds.has(id) && !authorized) throw policy("AUTHORIZATION_REQUIRED", `protected completion requires authorization for ${id}`);
          const before = deepClone(ticket2);
          ticket2.completed = true;
          return { ticketId: id, changedFields: changedFields(before, ticket2), fileOperations: [{ action: "update", id }] };
        }, { sensitive: ["lifecycle-change"], evidenceRequired: true });
      }
      planReassign(id, nextId, { authorized = false } = {}) {
        if (!authorized) throw policy("AUTHORIZATION_REQUIRED", "identity reassignment requires authorization");
        this.#assertIdNotArchived(nextId);
        return this.#plan("reassign", (tickets2) => {
          if (tickets2.some((ticket3) => ticket3.id === nextId)) throw conflict2("TICKET_EXISTS", `ticket already exists: ${nextId}`);
          const ticket2 = tickets2.find((item) => item.id === id);
          if (!ticket2) throw invalid2("TICKET_NOT_FOUND", `ticket not found: ${id}`);
          ticket2.id = nextId;
          let rewritten = 0;
          for (const item of tickets2) for (const edge of item.edges ?? []) if (edge.to === id) {
            edge.to = nextId;
            rewritten += 1;
          }
          return { ticketId: nextId, beforeTicketId: id, changedFields: ["id"], fileOperations: [{ action: "rename", from: id, to: nextId }], graphEffects: [{ rewrittenEdges: rewritten }] };
        }, { sensitive: ["identity-change"], evidenceRequired: true });
      }
      planReconciliation(nextTickets, { authorized = false, expectedSnapshotHash = null } = {}) {
        if (!authorized) throw policy("AUTHORIZATION_REQUIRED", "remote reconciliation requires authorization");
        const desired = deepClone(nextTickets);
        for (const ticket2 of desired) this.#assertIdNotArchived(ticket2.id);
        return this.#plan("remote-reconciliation", (tickets2) => {
          const beforeById = new Map(tickets2.map((ticket2) => [ticket2.id, ticket2]));
          const beforeIds = new Set(beforeById.keys());
          const afterIds = new Set(desired.map((ticket2) => ticket2.id));
          const mutatesExisting = desired.some((ticket2) => {
            const before = beforeById.get(ticket2.id);
            return before && ticketHash(before) !== ticketHash(ticket2);
          });
          tickets2.splice(0, tickets2.length, ...desired);
          return {
            fileOperations: [
              ...[...afterIds].filter((id) => !beforeIds.has(id)).map((id) => ({ action: "create", id })),
              ...[...beforeIds].filter((id) => !afterIds.has(id)).map((id) => ({ action: "delete", id }))
            ],
            graphEffects: [{ reconciledTickets: desired.length }],
            evidenceRequired: mutatesExisting
          };
        }, { sensitive: ["remote-reconciliation"], expectedSnapshotHash });
      }
      apply(plan, { lock = null } = {}) {
        const expectedPlanHash = sha2562(`adlc:ticket-plan:v1\0${canonicalJson2(planContent(plan))}`);
        if (expectedPlanHash !== plan.planHash) throw conflict2("STALE_PLAN", "mutation plan hash does not match its contents");
        if (storeHash(plan._tickets) !== plan.afterHash) throw conflict2("STALE_PLAN", "mutation plan payload does not match its after hash");
        if (this.store instanceof DirectoryTicketStore) {
          return applyDirectoryTransaction(this.store, plan._tickets, { expectedSnapshotHash: plan.expectedSnapshotHash, operation: plan.operation, evidenceRequired: plan.evidenceRequired, ticketId: plan.ticketId, beforeTicketId: plan.beforeTicketId, root: this.root, lock, key: this.key, allowUnsigned: this.allowUnsigned });
        }
        if (this.store instanceof LegacyTicketStore) {
          return applyLegacyTransaction(this.store, plan._tickets, { expectedSnapshotHash: plan.expectedSnapshotHash, operation: plan.operation, evidenceRequired: plan.evidenceRequired, ticketId: plan.ticketId, beforeTicketId: plan.beforeTicketId, root: this.root, lock, key: this.key, allowUnsigned: this.allowUnsigned });
        }
        throw policy("READ_ONLY_STORE", "this ticket store is read-only");
      }
    };
    serializePlan = (plan) => publicPlan(plan);
  }
});

// node_modules/@adlc/tickets/lib/archive.mjs
import { existsSync as existsSync13, readFileSync as readFileSync11 } from "node:fs";
import { join as join13, resolve as resolve5 } from "node:path";
function validateArchivePath(root2, path) {
  const expected = resolve5(root2, ARCHIVE_DIRECTORY);
  if (resolve5(path) !== expected) throw invalid2("UNSAFE_ARCHIVE_PATH", `archive path must be ${expected}`);
}
function ensureArchive(path) {
  if (!existsSync13(path)) {
    durableMkdir(path);
    durableWrite(join13(path, ".store.json"), prettyCanonicalJson(ARCHIVE_MANIFEST));
  }
  const store = new DirectoryTicketStore(path, { archive: true });
  store.load();
  return store;
}
function archiveTicket(activeStore, archivePath, id, { expectedSnapshotHash, reason = "completed", sourceRevision = null, root: root2 = ".", authorized = false, faultInjector = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  if (!authorized) throw policy("AUTHORIZATION_REQUIRED", "archiving requires explicit authorization");
  validateArchivePath(root2, archivePath);
  const lock = acquireTicketLock(root2, { command: "ticket:archive" });
  try {
    const active = activeStore.load();
    if (expectedSnapshotHash && active.hash !== expectedSnapshotHash) throw conflict2("STALE_SNAPSHOT", "active store changed before archive");
    assertSignableTrustRootWrite(active.tickets, { key, allowUnsigned, root: root2 });
    const ticket2 = active.get(id);
    if (!ticket2) throw invalid2("TICKET_NOT_FOUND", `ticket not found: ${id}`);
    const inbound = active.tickets.filter((item) => item.id !== id && (item.edges ?? []).some((edge) => edge.to === id));
    if (inbound.length) throw policy("ARCHIVE_INBOUND_EDGE", `${id} is referenced by ${inbound.map((item) => item.id).join(", ")}`);
    ensureArchive(archivePath);
    const target = join13(archivePath, ticketFilename(id));
    if (existsSync13(target)) throw conflict2("ARCHIVE_COLLISION", `archive already contains ${id}`);
    const archived = { ...JSON.parse(JSON.stringify(ticket2)), _adlcArchive: { version: 1, archivedAt: (/* @__PURE__ */ new Date()).toISOString(), reason, ticketHash: ticketHash(ticket2), sourceStoreHash: active.hash, sourceRevision } };
    const remaining = active.mutableTickets().filter((item) => item.id !== id);
    const updated = applyDirectoryTransaction(activeStore, remaining, {
      key,
      allowUnsigned,
      expectedSnapshotHash: active.hash,
      operation: "archive",
      evidenceRequired: true,
      ticketId: id,
      root: root2,
      lock,
      faultInjector,
      auxiliaryOperations: [{ action: "write", path: target, content: prettyCanonicalJson(archived), mustBeAbsent: true }],
      verify: () => {
        const archivedSnapshot = new DirectoryTicketStore(archivePath, { archive: true }).load();
        if (!archivedSnapshot.get(id)) throw invalid2("TRANSACTION_VERIFY_FAILED", `archive transaction did not materialize ${id}`);
      }
    });
    return { active: updated, archived };
  } catch (error) {
    throw error;
  } finally {
    releaseTicketLock(lock);
  }
}
function restoreTicket(activeStore, archivePath, id, { expectedSnapshotHash, root: root2 = ".", authorized = false, faultInjector = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  if (!authorized) throw policy("AUTHORIZATION_REQUIRED", "restore requires explicit authorization");
  validateArchivePath(root2, archivePath);
  const lock = acquireTicketLock(root2, { command: "ticket:restore" });
  try {
    const active = activeStore.load();
    if (expectedSnapshotHash && active.hash !== expectedSnapshotHash) throw conflict2("STALE_SNAPSHOT", "active store changed before restore");
    if (active.get(id)) throw conflict2("TICKET_EXISTS", `active store already contains ${id}`);
    const archiveStore = new DirectoryTicketStore(archivePath, { archive: true });
    archiveStore.load();
    const source = join13(archivePath, ticketFilename(id));
    if (!existsSync13(source)) throw invalid2("TICKET_NOT_FOUND", `archived ticket not found: ${id}`);
    const sourceText = readFileSync11(source, "utf8");
    const archived = JSON.parse(sourceText);
    const metadata = archived._adlcArchive;
    const ticket2 = { ...archived };
    delete ticket2._adlcArchive;
    if (!metadata || ticketHash(ticket2) !== metadata.ticketHash) throw invalid2("ARCHIVE_HASH_MISMATCH", `archived ticket ${id} does not match recorded hash`);
    const restored = applyDirectoryTransaction(activeStore, [...active.mutableTickets(), ticket2], {
      key,
      allowUnsigned,
      expectedSnapshotHash: active.hash,
      operation: "restore",
      evidenceRequired: true,
      ticketId: id,
      root: root2,
      lock,
      faultInjector,
      auxiliaryOperations: [{ action: "delete", path: source, mustExist: true, expectedBeforeHash: sha2562(sourceText) }],
      verify: () => {
        if (existsSync13(source)) throw invalid2("TRANSACTION_VERIFY_FAILED", `restore transaction did not remove archived ${id}`);
      }
    });
    return { active: restored, ticket: ticket2 };
  } finally {
    releaseTicketLock(lock);
  }
}
var init_archive = __esm({
  "node_modules/@adlc/tickets/lib/archive.mjs"() {
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_lock();
    init_directory();
    init_transaction();
    init_durability();
    init_key_contract();
    init_trust_root();
  }
});

// node_modules/@adlc/tickets/lib/migrate.mjs
import { execFileSync as execFileSync4 } from "node:child_process";
import { existsSync as existsSync14, readFileSync as readFileSync12, realpathSync } from "node:fs";
import { basename as basename5, dirname as dirname10, isAbsolute as isAbsolute3, join as join14, relative as relative4, resolve as resolve6, sep as sep3 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
function safeJournalPath2(root2, value, label) {
  if (typeof value !== "string" || !value) throw operational("INVALID_JOURNAL", `${label} must be a non-empty relative path`);
  const absolute = resolve6(root2, value);
  const rel = relative4(resolve6(root2), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute3(rel)) {
    throw operational("UNSAFE_JOURNAL_PATH", `${label} escapes the repository: ${value}`);
  }
  return absolute;
}
function migrationGitignoreText(original) {
  const lines2 = original.split(/\r?\n/);
  while (lines2.at(-1) === "") lines2.pop();
  const blanketIndex = lines2.lastIndexOf(ADLC_BLANKET);
  if (blanketIndex === -1) {
    if (lines2.length) lines2.push("");
    lines2.push(...GITIGNORE_STANZA);
    return `${lines2.join("\n")}
`;
  }
  const effective = new Set(lines2.slice(blanketIndex + 1));
  const missing = GITIGNORE_STANZA.filter((line) => line !== ADLC_BLANKET && !effective.has(line));
  if (missing.length === 0) return original;
  let insertAt = blanketIndex + 1;
  while (insertAt < lines2.length && /^!?\.adlc\//.test(lines2[insertAt])) insertAt++;
  lines2.splice(insertAt, 0, ...missing);
  return `${lines2.join("\n")}
`;
}
function ensureMigrationGitignore(root2) {
  const path = join14(root2, ".gitignore");
  const original = existsSync14(path) ? readFileSync12(path, "utf8") : "";
  const next = migrationGitignoreText(original);
  if (next !== original) durableWrite(path, next);
  return next !== original;
}
function assertExactMigrationPath(root2, value, expected, label) {
  const actual = safeJournalPath2(root2, value, label);
  if (actual !== resolve6(root2, expected)) throw operational("INVALID_JOURNAL", `${label} does not match the migration transaction layout`);
  return actual;
}
function validateMigrationJournal(root2, runtime, journal, id) {
  if (!journal || journal.version !== 1 || journal.id !== id || journal.operation !== "migrate" || journal.state !== "prepared") {
    throw operational("INVALID_JOURNAL", `${id} is not a supported prepared migration transaction`);
  }
  assertExactMigrationPath(root2, journal.source, LEGACY_FILE, "source");
  assertExactMigrationPath(root2, journal.target, ACTIVE_DIRECTORY, "target");
  assertExactMigrationPath(root2, journal.stagedStore, join14(runtime, "tickets"), "stagedStore");
  assertExactMigrationPath(root2, journal.stagedArchive, join14(runtime, "ticket-archive"), "stagedArchive");
  assertExactMigrationPath(root2, journal.backup, join14(runtime, "tickets.json"), "backup");
  if (journal.archiveExisted !== false || typeof journal.legacyArchiveExisted !== "boolean" || typeof journal.gitignoreExisted !== "boolean") {
    throw operational("INVALID_JOURNAL", "migration journal contains inconsistent pre-migration state");
  }
  if (journal.legacyArchiveExisted) assertExactMigrationPath(root2, journal.archiveBackup, join14(runtime, "tickets.archive.json"), "archiveBackup");
  else if (journal.archiveBackup !== null) throw operational("INVALID_JOURNAL", "archiveBackup must be null when no legacy archive existed");
  if (journal.gitignoreExisted) assertExactMigrationPath(root2, journal.gitignoreBackup, join14(runtime, "gitignore"), "gitignoreBackup");
  else if (journal.gitignoreBackup !== null) throw operational("INVALID_JOURNAL", "gitignoreBackup must be null when .gitignore did not exist");
  if (!HASH.test(journal.beforeHash) || journal.afterHash !== journal.beforeHash || !HASH.test(journal.archiveHash) || journal.evidenceRequired !== true) {
    throw operational("INVALID_JOURNAL", "migration journal hashes or evidence policy are invalid");
  }
  if (journal.gitignoreBeforeHash !== null && !HASH.test(journal.gitignoreBeforeHash) || !HASH.test(journal.gitignoreAfterHash)) {
    throw operational("INVALID_JOURNAL", "migration journal .gitignore hashes are invalid");
  }
  if (journal.gitignoreExisted !== (journal.gitignoreBeforeHash !== null)) {
    throw operational("INVALID_JOURNAL", "migration journal .gitignore state is inconsistent");
  }
}
function assertGitignoreRecoveryState(root2, journal) {
  const path = join14(root2, ".gitignore");
  if (!existsSync14(path)) {
    if (journal.gitignoreExisted) throw conflict2("STALE_GITIGNORE", ".gitignore disappeared during interrupted migration");
    return;
  }
  const currentHash = sha2562(readFileSync12(path));
  if (currentHash !== journal.gitignoreBeforeHash && currentHash !== journal.gitignoreAfterHash) {
    throw conflict2("STALE_GITIGNORE", ".gitignore changed after the interrupted migration; refusing to overwrite it");
  }
}
function loadMigrationJournal(root2, id) {
  if (!TRANSACTION_ID2.test(id)) throw operational("INVALID_TRANSACTION_ID", `invalid transaction id: ${id}`);
  const runtime = join14(root2, TRANSACTION_DIRECTORY, id);
  let journal;
  try {
    journal = JSON.parse(readFileSync12(join14(runtime, "journal.json"), "utf8"));
  } catch (error) {
    throw operational("INVALID_JOURNAL", `cannot read migration transaction ${id}: ${error.message}`);
  }
  validateMigrationJournal(root2, runtime, journal, id);
  return { runtime, journal };
}
function loadLegacyArchive(root2, path = join14(root2, LEGACY_ARCHIVE_FILE)) {
  if (!existsSync14(path)) return { exists: false, tickets: [], hash: storeHash([]) };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync12(path, "utf8"));
  } catch (error) {
    throw operational("INVALID_LEGACY_ARCHIVE", `cannot parse ${LEGACY_ARCHIVE_FILE}: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.tickets)) throw operational("INVALID_LEGACY_ARCHIVE", `${LEGACY_ARCHIVE_FILE} must contain a tickets array`);
  validateTickets(parsed.tickets, { archive: true, validateGraph: false });
  return { exists: true, tickets: parsed.tickets, hash: storeHash(parsed.tickets) };
}
function migrationPlan(root2 = ".") {
  const legacy = new LegacyTicketStore(join14(root2, LEGACY_FILE));
  const directoryPath = join14(root2, ACTIVE_DIRECTORY);
  if (!legacy.exists()) throw operational("LEGACY_STORE_NOT_FOUND", `legacy store not found: ${legacy.path}`);
  if (existsSync14(directoryPath)) throw conflict2("AMBIGUOUS_STORE", "directory store already exists");
  if (existsSync14(join14(root2, ARCHIVE_DIRECTORY))) throw conflict2("AMBIGUOUS_ARCHIVE", "archive directory already exists beside a legacy active store");
  const before = legacy.load();
  const archived = loadLegacyArchive(root2);
  const activeIds = new Set(before.tickets.map((ticket2) => ticket2.id));
  const collisions = archived.tickets.filter((ticket2) => activeIds.has(ticket2.id)).map((ticket2) => ticket2.id);
  if (collisions.length) throw conflict2("ARCHIVE_COLLISION", `legacy archive collides with active ticket(s): ${collisions.join(", ")}`);
  return { version: 1, operation: "migrate", source: LEGACY_FILE, target: ACTIVE_DIRECTORY, ticketCount: before.tickets.length, archivedTicketCount: archived.tickets.length, beforeHash: before.hash, afterHash: before.hash, archiveHash: archived.hash, files: [...before.tickets.map((ticket2) => join14(ACTIVE_DIRECTORY, ticketFilename(ticket2.id))), ...archived.tickets.map((ticket2) => join14(ARCHIVE_DIRECTORY, ticketFilename(ticket2.id)))] };
}
function migrateLegacyStore(root2 = ".", { write = false, yes = false, requireClean = true, faultInjector = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  const plan = migrationPlan(root2);
  if (!write) return plan;
  if (!yes) throw conflict2("CONFIRMATION_REQUIRED", "migration write requires --yes");
  if (requireClean) {
    let status;
    try {
      status = execFileSync4("git", ["status", "--porcelain"], { cwd: root2, encoding: "utf8" });
    } catch (error) {
      throw operational("GIT_STATUS_FAILED", `cannot verify clean worktree: ${error.message}`);
    }
    if (status.trim()) throw conflict2("DIRTY_WORKTREE", "migration requires a clean worktree");
  }
  const legacyPath = join14(root2, LEGACY_FILE);
  const legacy = new LegacyTicketStore(legacyPath);
  const before = legacy.load();
  const id = randomUUID4();
  const runtime = join14(root2, TRANSACTION_DIRECTORY, id);
  const stagedStore = join14(runtime, "tickets");
  const stagedArchive = join14(runtime, "ticket-archive");
  const backup = join14(runtime, "tickets.json");
  const archiveBackup = join14(runtime, "tickets.archive.json");
  const gitignorePath = join14(root2, ".gitignore");
  const gitignoreBackup = join14(runtime, "gitignore");
  const lock = acquireTicketLock(root2, { transactionId: id, command: "ticket:store:migrate" });
  try {
    if (legacy.load().hash !== before.hash) throw conflict2("STALE_SNAPSHOT", "legacy store changed during migration planning");
    const migratesTrustRoot = assertSignableTrustRootWrite(before.tickets, { key, allowUnsigned, root: root2 });
    if (existsSync14(join14(root2, ACTIVE_DIRECTORY))) throw conflict2("AMBIGUOUS_STORE", "directory store appeared during migration planning");
    if (existsSync14(join14(root2, ARCHIVE_DIRECTORY))) throw conflict2("AMBIGUOUS_ARCHIVE", "archive directory appeared during migration planning");
    const legacyArchive = loadLegacyArchive(root2);
    if (legacyArchive.hash !== plan.archiveHash) throw conflict2("STALE_SNAPSHOT", "legacy archive changed during migration planning");
    durableMkdir(stagedStore);
    durableMkdir(stagedArchive);
    durableWrite(join14(stagedStore, ".store.json"), prettyCanonicalJson(ACTIVE_MANIFEST));
    durableWrite(join14(stagedArchive, ".store.json"), prettyCanonicalJson(ARCHIVE_MANIFEST));
    for (const ticket2 of before.tickets) durableWrite(join14(stagedStore, ticketFilename(ticket2.id)), prettyCanonicalJson(ticket2));
    for (const ticket2 of legacyArchive.tickets) durableWrite(join14(stagedArchive, ticketFilename(ticket2.id)), prettyCanonicalJson(ticket2));
    durableCopy(legacyPath, backup);
    if (legacyArchive.exists) durableCopy(join14(root2, LEGACY_ARCHIVE_FILE), archiveBackup);
    const gitignoreExisted = existsSync14(gitignorePath);
    const gitignoreBefore = gitignoreExisted ? readFileSync12(gitignorePath, "utf8") : "";
    if (gitignoreExisted) durableCopy(gitignorePath, gitignoreBackup);
    const gitignoreAfter = migrationGitignoreText(gitignoreBefore);
    faultInjector?.("before-journal", { id });
    durableWrite(join14(runtime, "journal.json"), `${JSON.stringify({
      version: 1,
      id,
      operation: "migrate",
      state: "prepared",
      beforeHash: before.hash,
      afterHash: before.hash,
      source: LEGACY_FILE,
      target: ACTIVE_DIRECTORY,
      stagedStore: join14(TRANSACTION_DIRECTORY, id, "tickets"),
      stagedArchive: join14(TRANSACTION_DIRECTORY, id, "ticket-archive"),
      backup: join14(TRANSACTION_DIRECTORY, id, "tickets.json"),
      archiveBackup: legacyArchive.exists ? join14(TRANSACTION_DIRECTORY, id, "tickets.archive.json") : null,
      legacyArchiveExisted: legacyArchive.exists,
      archiveHash: legacyArchive.hash,
      gitignoreBackup: gitignoreExisted ? join14(TRANSACTION_DIRECTORY, id, "gitignore") : null,
      gitignoreExisted,
      gitignoreBeforeHash: gitignoreExisted ? sha2562(gitignoreBefore) : null,
      gitignoreAfterHash: sha2562(gitignoreAfter),
      archiveExisted: false,
      evidenceRequired: true
    }, null, 2)}
`);
    faultInjector?.("journal-prepared", { id });
    durableMkdir(dirname10(join14(root2, ACTIVE_DIRECTORY)));
    durableRename(stagedStore, join14(root2, ACTIVE_DIRECTORY));
    durableRename(stagedArchive, join14(root2, ARCHIVE_DIRECTORY));
    faultInjector?.("directory-renamed", { id });
    const directory = new DirectoryTicketStore(join14(root2, ACTIVE_DIRECTORY));
    if (directory.load().hash !== before.hash) throw conflict2("MIGRATION_HASH_MISMATCH", "directory representation changed logical store hash");
    if (new DirectoryTicketStore(join14(root2, ARCHIVE_DIRECTORY), { archive: true }).load().hash !== legacyArchive.hash) throw conflict2("MIGRATION_HASH_MISMATCH", "archive representation changed logical store hash");
    durableRemove(legacyPath);
    if (legacyArchive.exists) durableRemove(join14(root2, LEGACY_ARCHIVE_FILE));
    faultInjector?.("legacy-removed", { id });
    ensureMigrationGitignore(root2);
    recordTicketEvidence(root2, {
      key,
      transactionId: id,
      operation: "migrate",
      storeHash: directory.load().hash,
      archiveHash: legacyArchive.hash,
      ...migratesTrustRoot ? { bypass: true, storeHashBefore: before.hash } : {}
    });
    faultInjector?.("gitignore-updated", { id });
    durableRemove(runtime, { recursive: true, force: true });
    return { ...plan, applied: true };
  } catch (error) {
    if (!existsSync14(join14(runtime, "journal.json")) && existsSync14(runtime)) durableRemove(runtime, { recursive: true, force: true });
    throw error;
  } finally {
    releaseTicketLock(lock);
  }
}
function recoverMigration(root2, id, { direction, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  if (!["complete", "rollback"].includes(direction)) throw conflict2("RECOVERY_DIRECTION_REQUIRED", "choose complete or rollback");
  const { runtime, journal } = loadMigrationJournal(root2, id);
  const legacyPath = safeJournalPath2(root2, journal.source, "source");
  const directoryPath = safeJournalPath2(root2, journal.target, "target");
  const stagedStore = safeJournalPath2(root2, journal.stagedStore, "stagedStore");
  const stagedArchive = safeJournalPath2(root2, journal.stagedArchive, "stagedArchive");
  const backup = safeJournalPath2(root2, journal.backup, "backup");
  const lock = acquireTicketLock(root2, { transactionId: id, command: `ticket:migrate:recover:${direction}` });
  try {
    const backupSnapshot = new LegacyTicketStore(backup).load();
    if (backupSnapshot.hash !== journal.beforeHash) throw conflict2("CORRUPT_BACKUP", "migration backup does not match its recorded hash");
    let preRecoveryHash = journal.beforeHash;
    for (const candidate of [
      () => new DirectoryTicketStore(directoryPath).load().hash,
      () => new LegacyTicketStore(legacyPath).load().hash
    ]) {
      try {
        preRecoveryHash = candidate();
        break;
      } catch {
      }
    }
    const archivePath = join14(root2, ARCHIVE_DIRECTORY);
    const legacyArchivePath = join14(root2, LEGACY_ARCHIVE_FILE);
    const gitignorePath = join14(root2, ".gitignore");
    const archiveBackup = journal.legacyArchiveExisted ? safeJournalPath2(root2, journal.archiveBackup, "archiveBackup") : null;
    const gitignoreBackup = journal.gitignoreExisted ? safeJournalPath2(root2, journal.gitignoreBackup, "gitignoreBackup") : null;
    if (archiveBackup && loadLegacyArchive(root2, archiveBackup).hash !== journal.archiveHash) {
      throw conflict2("CORRUPT_BACKUP", "migration archive backup does not match its recorded hash");
    }
    if (gitignoreBackup && sha2562(readFileSync12(gitignoreBackup)) !== journal.gitignoreBeforeHash) {
      throw conflict2("CORRUPT_BACKUP", "migration .gitignore backup does not match its recorded hash");
    }
    const archiveBackupDeclaresRails = () => {
      if (!archiveBackup) return false;
      try {
        return storeDeclaresRails(loadLegacyArchive(root2, archiveBackup).tickets);
      } catch {
        return true;
      }
    };
    const recoversTrustRoot = repoDeclaresRails(root2, backupSnapshot.tickets) || archiveBackupDeclaresRails();
    if (recoversTrustRoot) assertWriteIsSignable({ key, allowUnsigned });
    if (direction === "complete") {
      if (!existsSync14(directoryPath)) {
        const staged = new DirectoryTicketStore(stagedStore).load();
        if (staged.hash !== journal.afterHash) throw conflict2("CORRUPT_STAGE", "staged migration store does not match its recorded hash");
      } else if (new DirectoryTicketStore(directoryPath).load().hash !== journal.afterHash) {
        throw conflict2("RECOVERY_VERIFY_FAILED", "migrated directory does not match its recorded hash");
      }
      if (!existsSync14(archivePath)) {
        const staged = new DirectoryTicketStore(stagedArchive, { archive: true }).load();
        if (staged.hash !== journal.archiveHash) throw conflict2("CORRUPT_STAGE", "staged migration archive does not match its recorded hash");
      } else if (new DirectoryTicketStore(archivePath, { archive: true }).load().hash !== journal.archiveHash) {
        throw conflict2("RECOVERY_VERIFY_FAILED", "migrated archive does not match its recorded hash");
      }
      if (existsSync14(legacyPath)) {
        if (new LegacyTicketStore(legacyPath).load().hash !== journal.beforeHash) throw conflict2("RECOVERY_VERIFY_FAILED", "legacy source changed during interrupted migration");
      }
      if (existsSync14(legacyArchivePath)) {
        if (loadLegacyArchive(root2).hash !== journal.archiveHash) throw conflict2("RECOVERY_VERIFY_FAILED", "legacy archive changed during interrupted migration");
      }
      assertGitignoreRecoveryState(root2, journal);
      if (!existsSync14(directoryPath)) durableRename(stagedStore, directoryPath);
      if (!existsSync14(archivePath)) durableRename(stagedArchive, archivePath);
      if (existsSync14(legacyPath)) durableRemove(legacyPath);
      if (existsSync14(legacyArchivePath)) durableRemove(legacyArchivePath);
      ensureMigrationGitignore(root2);
      const directory = new DirectoryTicketStore(directoryPath).load();
      const applyAudit = recoversTrustRoot ? { bypass: true, storeHashBefore: journal.beforeHash } : {};
      const recoveryAudit = recoversTrustRoot ? { bypass: true, storeHashBefore: preRecoveryHash } : {};
      recordTicketEvidence(root2, { key, transactionId: id, operation: "migrate", storeHash: directory.hash, archiveHash: journal.archiveHash, ...applyAudit, acceptLegacyMatch: true });
      recordTicketEvidence(root2, { key, transactionId: id, operation: "migrate", action: "recover-complete", storeHash: directory.hash, archiveHash: journal.archiveHash, ...recoveryAudit });
      durableRemove(runtime, { recursive: true, force: true });
      return new DirectoryTicketStore(directoryPath).load();
    }
    if (existsSync14(directoryPath)) {
      if (new DirectoryTicketStore(directoryPath).load().hash !== journal.afterHash) throw conflict2("RECOVERY_VERIFY_FAILED", "partial directory changed; refusing rollback");
    }
    if (existsSync14(legacyPath) && new LegacyTicketStore(legacyPath).load().hash !== journal.beforeHash) {
      throw conflict2("RECOVERY_VERIFY_FAILED", "legacy source changed during interrupted migration; refusing rollback");
    }
    assertGitignoreRecoveryState(root2, journal);
    if (existsSync14(archivePath) && new DirectoryTicketStore(archivePath, { archive: true }).load().hash !== journal.archiveHash) {
      throw conflict2("RECOVERY_VERIFY_FAILED", "partial archive changed; refusing rollback");
    }
    if (existsSync14(legacyArchivePath) && loadLegacyArchive(root2).hash !== journal.archiveHash) {
      throw conflict2("RECOVERY_VERIFY_FAILED", "legacy archive changed during interrupted migration; refusing rollback");
    }
    if (existsSync14(directoryPath)) durableRemove(directoryPath, { recursive: true });
    const temporary = `${legacyPath}.rollback-${id}`;
    durableCopy(backup, temporary);
    durableRename(temporary, legacyPath);
    if (new LegacyTicketStore(legacyPath).load().hash !== journal.beforeHash) throw conflict2("RECOVERY_VERIFY_FAILED", "restored legacy store does not match its recorded hash");
    if (journal.gitignoreExisted) {
      durableCopy(gitignoreBackup, `${gitignorePath}.rollback-${id}`);
      durableRename(`${gitignorePath}.rollback-${id}`, gitignorePath);
    } else if (existsSync14(gitignorePath)) durableRemove(gitignorePath, { force: true });
    if (!journal.archiveExisted && existsSync14(archivePath)) {
      durableRemove(archivePath, { recursive: true });
    }
    if (journal.legacyArchiveExisted) {
      const temporaryArchive = `${legacyArchivePath}.rollback-${id}`;
      durableCopy(archiveBackup, temporaryArchive);
      durableRename(temporaryArchive, legacyArchivePath);
      if (loadLegacyArchive(root2).hash !== journal.archiveHash) throw conflict2("RECOVERY_VERIFY_FAILED", "restored legacy archive does not match its recorded hash");
    } else if (existsSync14(legacyArchivePath)) durableRemove(legacyArchivePath, { force: true });
    recordTicketEvidence(root2, {
      key,
      transactionId: id,
      operation: "migrate",
      action: "recover-rollback",
      storeHash: journal.beforeHash,
      archiveHash: journal.archiveHash,
      ...recoversTrustRoot ? { bypass: true, storeHashBefore: preRecoveryHash } : {}
    });
    durableRemove(runtime, { recursive: true, force: true });
    return new LegacyTicketStore(legacyPath).load();
  } finally {
    releaseTicketLock(lock);
  }
}
function exportLegacyStore(store, outputPath, { root: root2 = "." } = {}) {
  const target = resolve6(root2, outputPath);
  const symlinkResolved = (path) => {
    const tail2 = [basename5(path)];
    let dir = dirname10(path);
    for (; ; ) {
      try {
        return join14(realpathSync(dir), ...[...tail2].reverse());
      } catch {
        const parent = dirname10(dir);
        if (parent === dir) return path;
        tail2.push(basename5(dir));
        dir = parent;
      }
    }
  };
  const candidates = [target, symlinkResolved(target)];
  const reserved = [
    resolve6(root2, ".adlc"),
    ...typeof store?.path === "string" && store.path ? [resolve6(root2, store.path)] : []
  ].flatMap((absolute) => {
    let real = absolute;
    try {
      real = realpathSync(absolute);
    } catch {
    }
    return real === absolute ? [absolute] : [absolute, real];
  });
  const insideStore = (dir) => candidates.some((candidate) => {
    const rel = relative4(dir, candidate);
    return rel === "" || Boolean(rel) && !rel.startsWith("..") && !isAbsolute3(rel);
  });
  const insideSomeDirectoryStore = (candidate) => {
    let dir = dirname10(candidate);
    for (; ; ) {
      if (existsSync14(join14(dir, STORE_MARKER2))) return true;
      const parent = dirname10(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  };
  const insideSomeAdlcDirectory = (candidate) => candidate.split(sep3).includes(".adlc");
  if (reserved.some(insideStore) || candidates.some(insideSomeDirectoryStore) || candidates.some(insideSomeAdlcDirectory)) {
    throw policy(
      "UNSAFE_EXPORT_TARGET",
      `refusing to export onto ADLC runtime state: ${outputPath}. Export writes a snapshot for inspection; writing it into any .adlc/, into any directory ticket store, or over the source store would replace a ticket set \u2014 rails included \u2014 or the append-only evidence ledger, with no record that it happened. Choose a path outside .adlc/ and outside every ticket store.`
    );
  }
  const snapshot = store.load();
  const temporary = `${target}.tmp.${process.pid}`;
  durableMkdir(dirname10(target));
  durableWrite(temporary, prettyCanonicalJson({ tickets: snapshot.mutableTickets() }));
  durableRename(temporary, target);
  const exported = new LegacyTicketStore(target).load();
  if (exported.hash !== snapshot.hash) throw conflict2("EXPORT_HASH_MISMATCH", "legacy export changed logical store hash");
  return exported;
}
var STORE_MARKER2, GITIGNORE_STANZA, ADLC_BLANKET, TRANSACTION_ID2, HASH;
var init_migrate = __esm({
  "node_modules/@adlc/tickets/lib/migrate.mjs"() {
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_lock();
    init_directory();
    init_legacy();
    init_evidence();
    init_schema();
    init_durability();
    init_key_contract();
    init_trust_root();
    STORE_MARKER2 = ".store.json";
    GITIGNORE_STANZA = [
      ".adlc/*",
      "!.adlc/tickets.json",
      "!.adlc/tickets/",
      "!.adlc/tickets/**",
      "!.adlc/ticket-archive/",
      "!.adlc/ticket-archive/**",
      "!.adlc/specs/",
      "!.adlc/manifest.jsonl",
      "!.adlc/manifest.d/",
      "!.adlc/manifest.d/**",
      ".adlc/manifest.d/.lineage",
      ".adlc/manifest.d/*.lock",
      ".adlc/manifest.d/*.tmp-*"
    ];
    ADLC_BLANKET = ".adlc/*";
    TRANSACTION_ID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    HASH = /^[0-9a-f]{64}$/;
  }
});

// node_modules/@adlc/tickets/lib/doctor.mjs
import { existsSync as existsSync15, readFileSync as readFileSync13 } from "node:fs";
import { createHash as createHash3 } from "node:crypto";
import { join as join15 } from "node:path";
function currentTicketCheck(root2, snapshot) {
  const check = { name: "current-ticket", ok: true, present: existsSync15(join15(root2, CURRENT_TICKET_FILE)) };
  if (!check.present) return check;
  if (!snapshot) return { ...check, ok: false, code: "ACTIVE_STORE_UNREADABLE", message: "cannot validate the pointer: the ticket store did not load" };
  const pointer = readActiveTicketPointer(root2);
  if (!pointer.ok) return { ...check, ok: false, code: pointer.code, message: pointer.message };
  if (pointer.value.deprecatedAlias) check.deprecatedAlias = pointer.value.deprecatedAlias;
  const resolved = resolveActiveTicketAgainst(snapshot, { root: root2, env: {}, allowLegacyPointer: false });
  if (!resolved.ok) return { ...check, ok: false, id: pointer.value.id, code: resolved.code, message: resolved.message };
  check.id = resolved.value.id;
  if (resolved.value.warnings.length) check.warnings = resolved.value.warnings;
  return check;
}
function walkChainForStoreHash(lines2, key, chainLabel) {
  let boundStoreHash = null;
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  let refusedUnsignedCheckpoint = false;
  for (let i = 0; i < lines2.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines2[i]);
    } catch {
      return { ok: false, code: "MANIFEST_MALFORMED", reason: `${chainLabel} has a malformed entry at line ${i + 1}; integrity check FAILED` };
    }
    const expectedPrev = prevLine === null ? null : createHash3("sha256").update(prevLine).digest("hex");
    if (entry?.prev !== expectedPrev || entry?.seq !== prevSeq + 1) {
      return { ok: false, code: "MANIFEST_CHAIN_INVALID", reason: `${chainLabel} hash chain breaks at line ${i + 1}; integrity check FAILED` };
    }
    let entrySigned = false;
    if (key !== null) {
      const hasSig = typeof entry?.sig === "string" && entry.sig.length > 0;
      if (hasSig) {
        if (!entrySigValid(key, entry)) {
          return { ok: false, code: "MANIFEST_SIGNATURE_INVALID", reason: `${chainLabel} entry at line ${i + 1} has a signature that does not verify; integrity check FAILED` };
        }
        seenSignedEntry = true;
        entrySigned = true;
      } else if (seenSignedEntry) {
        return { ok: false, code: "MANIFEST_SIGNATURE_INVALID", reason: `${chainLabel} entry at line ${i + 1} is unsigned but this chain's signed era has already begun; integrity check FAILED` };
      }
    }
    if (entry?.data && typeof entry.data.storeHash === "string") {
      if (key === null || entrySigned) boundStoreHash = entry.data.storeHash;
      else refusedUnsignedCheckpoint = true;
    }
    prevLine = lines2[i];
    prevSeq = entry.seq;
  }
  return { ok: true, boundStoreHash, refusedUnsignedCheckpoint };
}
function storeHashBindingCheck(root2, snapshot, key) {
  const check = { name: "storehash-manifest-bind", ok: true };
  if (!snapshot) return { ...check, bound: false, reason: "active store did not load; storeHash binding not checked" };
  const manifestPath = join15(root2, ".adlc/manifest.jsonl");
  let boundStoreHash = null;
  let refusedUnsignedCheckpoint = false;
  if (existsSync15(manifestPath)) {
    let lines2;
    try {
      lines2 = readFileSync13(manifestPath, "utf8").split("\n").filter((line) => line.trim());
    } catch (error) {
      return { ...check, ok: false, code: "MANIFEST_UNREADABLE", message: `cannot read the evidence ledger: ${error.message}` };
    }
    const rootResult = walkChainForStoreHash(lines2, key, "manifest ledger");
    if (!rootResult.ok) return { ...check, ok: false, code: rootResult.code, reason: rootResult.reason };
    if (rootResult.boundStoreHash !== null) boundStoreHash = rootResult.boundStoreHash;
    if (rootResult.refusedUnsignedCheckpoint) refusedUnsignedCheckpoint = true;
  }
  const dir = join15(root2, ".adlc");
  if (isSegmentedRepo(dir)) {
    let resolved;
    try {
      resolved = recoverOpenSegment(dir, { cwd: root2 });
    } catch (error) {
      return { ...check, ok: false, code: "SEGMENT_AMBIGUOUS", message: error.message };
    }
    if (resolved) {
      const segFile = segmentPath(dir, resolved.name);
      let segLines;
      try {
        segLines = existsSync15(segFile) ? readFileSync13(segFile, "utf8").split("\n").filter((line) => line.trim()) : [];
      } catch (error) {
        return { ...check, ok: false, code: "MANIFEST_UNREADABLE", message: `cannot read segment ${resolved.name}: ${error.message}` };
      }
      const segResult = walkChainForStoreHash(segLines, key, `segment ${resolved.name}`);
      if (!segResult.ok) return { ...check, ok: false, code: segResult.code, reason: segResult.reason };
      if (segResult.boundStoreHash !== null) boundStoreHash = segResult.boundStoreHash;
      if (segResult.refusedUnsignedCheckpoint) refusedUnsignedCheckpoint = true;
    }
  }
  if (!boundStoreHash) {
    return {
      ...check,
      bound: false,
      reason: refusedUnsignedCheckpoint ? "the only recorded checkpoint(s) are unsigned (they predate signing), so none can be authenticated with the configured key; no binding is claimed" : "no evidence-required transaction recorded yet"
    };
  }
  check.bound = true;
  check.storeHash = snapshot.hash;
  check.boundStoreHash = boundStoreHash;
  check.signaturesVerified = key !== null;
  check.authenticated = key !== null;
  if (key === null) {
    check.warning = "manifest checkpoint is NOT cryptographically authenticated: ADLC_MANIFEST_KEY is not set, so only the backward hash chain was verified. The final checkpoint is therefore forgeable \u2014 a coordinated ticket-shard edit + recomputed final-entry storeHash would pass undetected (no signature to break, no drift to show). Set ADLC_MANIFEST_KEY to make the storeHash binding tamper-evident.";
  }
  if (snapshot.hash !== boundStoreHash) {
    check.drift = true;
    check.message = "live storeHash differs from the last evidenced checkpoint \u2014 unevidenced change(s) since. This check does not verify those (git history is the record for those shards); reported, not failed";
  }
  return check;
}
function readChain(path) {
  const seqs = /* @__PURE__ */ new Set();
  let first = null;
  let sawFirst = false;
  let content;
  try {
    content = readFileSync13(path, "utf8");
  } catch {
    return { seqs, first };
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
    }
    if (!sawFirst) {
      first = entry;
      sawFirst = true;
    }
    if (Number.isInteger(entry?.seq)) seqs.add(entry.seq);
  }
  return { seqs, first };
}
function manifestForestCheck(root2) {
  const check = { name: "manifest-forest", ok: true };
  const dir = join15(root2, ".adlc");
  if (!isSegmentedRepo(dir)) return { ...check, segmented: false };
  const { valid } = discoverSegments(dir);
  const chains = /* @__PURE__ */ new Map([["root", readChain(join15(dir, "manifest.jsonl"))]]);
  for (const name of valid) chains.set(name, readChain(segmentPath(dir, name)));
  const orphanedAnchors = [];
  for (const name of valid) {
    const anchor = chains.get(name).first?.anchor;
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) continue;
    if (typeof anchor.segment !== "string" || !Number.isInteger(anchor.seq)) continue;
    const target = chains.get(anchor.segment);
    if (target === void 0) {
      orphanedAnchors.push({ segment: name, anchor: { segment: anchor.segment, seq: anchor.seq }, reason: `anchored to '${anchor.segment}', which is not a segment in this forest` });
    } else if (!target.seqs.has(anchor.seq)) {
      orphanedAnchors.push({ segment: name, anchor: { segment: anchor.segment, seq: anchor.seq }, reason: `anchored to '${anchor.segment}' seq ${anchor.seq}, which no longer exists` });
    }
  }
  let staleLineage = null;
  const token = readLineageToken(dir);
  if (token) {
    if (!valid.includes(token.segment)) {
      staleLineage = { segment: token.segment, ulid: token.ulid, reason: `.lineage names segment '${token.segment}', which no longer exists` };
    } else if (ulidOf(token.segment) !== token.ulid) {
      staleLineage = { segment: token.segment, ulid: token.ulid, reason: `.lineage caches ULID '${token.ulid}' for segment '${token.segment}', whose own ULID is '${ulidOf(token.segment)}'` };
    }
  }
  return {
    ...check,
    ok: orphanedAnchors.length === 0 && staleLineage === null,
    segmented: true,
    segments: valid.length,
    orphanedAnchors,
    staleLineage
  };
}
function doctorTicketStore(store, { root: root2 = ".", archive = false, key: keyParam = null } = {}) {
  const checks = [];
  let snapshot = null;
  try {
    snapshot = store.load();
    checks.push({ name: "active-store", ok: true, backend: snapshot.backend, ticketCount: snapshot.tickets.length, storeHash: snapshot.hash });
  } catch (error) {
    checks.push({ name: "active-store", ok: false, code: error.code ?? "UNEXPECTED", message: error.message });
  }
  const transactions = pendingTransactions(root2);
  checks.push({ name: "transactions", ok: transactions.length === 0, pending: transactions });
  const lockPath = join15(root2, LOCK_DIRECTORY);
  checks.push({ name: "writer-lock", ok: !existsSync15(lockPath), present: existsSync15(lockPath), metadata: readTicketLock(root2) });
  checks.push(currentTicketCheck(root2, snapshot));
  checks.push(storeHashBindingCheck(root2, snapshot, validateKeyParam(keyParam)));
  checks.push(manifestForestCheck(root2));
  if (archive) {
    const path = join15(root2, ARCHIVE_DIRECTORY);
    if (!existsSync15(path)) checks.push({ name: "archive", ok: true, present: false, ticketCount: 0 });
    else {
      try {
        const archived = new DirectoryTicketStore(path, { archive: true }).load();
        const collisions = snapshot ? archived.tickets.filter((ticket2) => snapshot.get(ticket2.id)).map((ticket2) => ticket2.id) : [];
        checks.push({ name: "archive", ok: collisions.length === 0, present: true, ticketCount: archived.tickets.length, collisions });
      } catch (error) {
        checks.push({ name: "archive", ok: false, code: error.code ?? "UNEXPECTED", message: error.message });
      }
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}
var init_doctor = __esm({
  "node_modules/@adlc/tickets/lib/doctor.mjs"() {
    init_constants();
    init_lock();
    init_pointer();
    init_store();
    init_directory();
    init_manifest_segments();
    init_key_contract();
  }
});

// node_modules/@adlc/tickets/lib/provenance.mjs
var init_provenance = __esm({
  "node_modules/@adlc/tickets/lib/provenance.mjs"() {
    init_pointer();
    init_errors();
  }
});

// node_modules/@adlc/tickets/lib/pointer-write.mjs
var init_pointer_write = __esm({
  "node_modules/@adlc/tickets/lib/pointer-write.mjs"() {
    init_pointer();
  }
});

// node_modules/@adlc/tickets/lib/prompt.mjs
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
function shouldOfferLegacyMigration(store, flags2 = {}, { input = stdin, output = stdout } = {}) {
  return store instanceof LegacyTicketStore && !flags2.json && input.isTTY === true && output.isTTY === true;
}
async function offerLegacyMigration(store, root2, flags2 = {}, {
  input = stdin,
  output = stdout,
  emit: emit2 = (value) => output.write(`${JSON.stringify(value, null, 2)}
`),
  ask,
  plan = migrationPlan,
  migrate: migrate2 = migrateLegacyStore,
  detect = detectTicketStore,
  key = null,
  allowUnsigned = false
} = {}) {
  if (!shouldOfferLegacyMigration(store, flags2, { input, output })) return store;
  emit2({ warning: "Legacy .adlc/tickets.json is active. ADLC can migrate it to independently mergeable shards." });
  emit2(plan(root2));
  let answer;
  if (ask) answer = await ask("Apply migration? [y/N] ");
  else {
    const readline = createInterface({ input, output });
    try {
      answer = await readline.question("Apply migration? [y/N] ");
    } finally {
      readline.close();
    }
  }
  if (!/^y(?:es)?$/i.test(String(answer ?? "").trim())) return store;
  migrate2(root2, { write: true, yes: true, key, allowUnsigned });
  return detect({ root: root2, ticketStore: flags2["ticket-store"], legacyTickets: flags2.tickets });
}
var init_prompt = __esm({
  "node_modules/@adlc/tickets/lib/prompt.mjs"() {
    init_store();
    init_legacy();
    init_migrate();
  }
});

// node_modules/@adlc/tickets/lib/stores/git-tree.mjs
var init_git_tree = __esm({
  "node_modules/@adlc/tickets/lib/stores/git-tree.mjs"() {
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_schema();
    init_snapshot();
  }
});

// node_modules/@adlc/tickets/index.mjs
var init_tickets = __esm({
  "node_modules/@adlc/tickets/index.mjs"() {
    init_constants();
    init_errors();
    init_canonical();
    init_ids();
    init_filename();
    init_schema();
    init_help();
    init_edit();
    init_snapshot();
    init_store();
    init_lock();
    init_durability();
    init_transaction();
    init_service();
    init_manifest_rails();
    init_trust_root();
    init_archive();
    init_migrate();
    init_doctor();
    init_provenance();
    init_pointer();
    init_pointer_write();
    init_prompt();
    init_evidence();
    init_manifest_segments();
    init_legacy();
    init_directory();
    init_git_tree();
    init_key_contract();
  }
});

// node_modules/@adlc/core/lib/glob.mjs
function globMatch2(pattern, path) {
  const tokens = pattern.split(/(\*\*\/|\*\*|\*)/).filter((part) => part !== "");
  let reach = new Uint8Array(path.length + 1);
  const end = reach.length - 1;
  reach[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(reach.length);
    if (token === "**") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
      }
    } else if (token === "**/") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) {
          next[i] = 1;
          open = true;
        }
        if (open && i < end && path.charCodeAt(i) === SLASH2) next[i + 1] = 1;
      }
    } else if (token === "*") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
        if (i < end && path.charCodeAt(i) === SLASH2) open = false;
      }
    } else {
      for (let i = 0; i + token.length <= end; i++) {
        if (reach[i] && path.startsWith(token, i)) next[i + token.length] = 1;
      }
    }
    reach = next;
  }
  return reach[end] === 1;
}
var SLASH2;
var init_glob = __esm({
  "node_modules/@adlc/core/lib/glob.mjs"() {
    SLASH2 = "/".charCodeAt(0);
  }
});

// node_modules/@adlc/core/lib/tickets.mjs
import { existsSync as existsSync16, lstatSync as lstatSync7 } from "node:fs";
import { dirname as dirname11, isAbsolute as isAbsolute4, join as join16 } from "node:path";
function loadTickets(path = TICKETS_PATH) {
  try {
    const directoryPath = join16(dirname11(path), "tickets");
    const store = existsSync16(path) ? lstatSync7(path).isDirectory() ? new DirectoryTicketStore(path) : new LegacyTicketStore(path) : existsSync16(directoryPath) ? new DirectoryTicketStore(directoryPath) : null;
    if (!store) return { tickets: [], errors: [`tickets file not found: ${path}`] };
    return { tickets: store.load().mutableTickets(), errors: [] };
  } catch (err) {
    return { tickets: [], errors: Array.isArray(err.details) ? [...err.details] : [err.message] };
  }
}
function topoSort(tickets2) {
  const ids = tickets2.map((t) => t.id);
  const indegree = Object.fromEntries(ids.map((id) => [id, 0]));
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const t of tickets2) {
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
function computeFloat(tickets2) {
  const { order, cycle } = topoSort(tickets2);
  if (cycle) return { error: `cycle in ticket DAG: ${cycle.join(", ")}` };
  const byId = Object.fromEntries(tickets2.map((t) => [t.id, t]));
  const dur = (id) => byId[id].duration ?? 1;
  const preds = Object.fromEntries(tickets2.map((t) => [t.id, []]));
  for (const t of tickets2) for (const e of t.edges ?? []) preds[e.to].push(t.id);
  const earliestFinish = {};
  for (const id of order) {
    const start = Math.max(0, ...preds[id].map((p) => earliestFinish[p]));
    earliestFinish[id] = start + dur(id);
  }
  const makespan = Math.max(0, ...Object.values(earliestFinish));
  const succs = Object.fromEntries(tickets2.map((t) => [t.id, (t.edges ?? []).map((e) => e.to)]));
  const latestFinish = {};
  for (const id of [...order].reverse()) {
    latestFinish[id] = succs[id].length ? Math.min(...succs[id].map((s) => latestFinish[s] - dur(s))) : makespan;
  }
  const floats = {};
  for (const id of order) floats[id] = latestFinish[id] - earliestFinish[id];
  const criticalPath = order.filter((id) => floats[id] === 0);
  return { floats, criticalPath, makespan };
}
function scopesOverlap(a, b) {
  const as = a.scope ?? [];
  const bs = b.scope ?? [];
  for (const ga of as) {
    for (const gb of bs) {
      if (ga === gb) return true;
      const aBase = ga.split("*")[0];
      const bBase = gb.split("*")[0];
      if (aBase && bBase && (aBase.startsWith(bBase) || bBase.startsWith(aBase))) return true;
    }
  }
  return false;
}
var TICKETS_PATH, TICKET_TRUST_ROOT_RAILS;
var init_tickets2 = __esm({
  "node_modules/@adlc/core/lib/tickets.mjs"() {
    init_tickets();
    init_glob();
    TICKETS_PATH = ".adlc/tickets.json";
    TICKET_TRUST_ROOT_RAILS = Object.freeze([
      ".adlc/tickets.json",
      ".adlc/tickets/.store.json",
      ".adlc/tickets/**",
      ".adlc/current-ticket.json"
    ]);
  }
});

// node_modules/@adlc/core/lib/revision.mjs
var GIT_MAX_BUFFER2, NULL_OBJECT;
var init_revision = __esm({
  "node_modules/@adlc/core/lib/revision.mjs"() {
    init_git();
    GIT_MAX_BUFFER2 = 64 * 1024 * 1024;
    NULL_OBJECT = "0".repeat(40);
  }
});

// node_modules/@adlc/core/lib/risk-tier.mjs
var RISK_TIER_PATTERNS;
var init_risk_tier = __esm({
  "node_modules/@adlc/core/lib/risk-tier.mjs"() {
    init_tickets2();
    RISK_TIER_PATTERNS = Object.freeze({
      "auth-trust-boundary": Object.freeze([
        "**/auth/**",
        "**/authn/**",
        "**/authz/**",
        "**/oauth/**",
        "**/sso/**",
        "**/session/**",
        "**/login/**",
        "**/permissions/**",
        "**/rbac/**",
        "**/acl/**"
      ]),
      "security-control-deny-path": Object.freeze([
        "**/*guard*",
        "**/*validator*",
        "**/*validators*",
        "**/sandbox/**",
        "**/sandboxes/**",
        "**/middleware/**",
        "**/*deny-path*",
        "**/*policy*",
        "**/policies/**"
      ]),
      secrets: Object.freeze([
        "**/.env",
        "**/.env.*",
        "**/*.pem",
        "**/*.key",
        "**/*.p12",
        "**/*.pfx",
        "**/secrets/**",
        "**/secret/**",
        "**/*credentials*",
        "**/vault/**"
      ]),
      "data-loss-destructive": Object.freeze([
        "**/*delete*",
        "**/*destroy*",
        "**/*purge*",
        "**/*truncate*",
        "**/*wipe*",
        "**/*irreversible*"
      ]),
      "schema-migration": Object.freeze([
        "**/migrations/**",
        "**/migrate/**",
        "**/*.sql",
        "**/schema.*",
        "**/*.prisma"
      ]),
      "ci-cd-supply-chain": Object.freeze([
        ".github/workflows/**",
        "**/Dockerfile",
        "**/Dockerfile.*",
        "**/docker-compose*.yml",
        "**/package.json",
        "**/package-lock.json",
        "**/pnpm-lock.yaml",
        "**/yarn.lock",
        "**/requirements*.txt",
        "**/Gemfile*",
        "**/go.sum",
        "**/go.mod",
        "**/Cargo.lock",
        ".circleci/**",
        ".gitlab-ci.yml"
      ])
    });
  }
});

// node_modules/@adlc/core/lib/scaffold-hygiene.mjs
var init_scaffold_hygiene = __esm({
  "node_modules/@adlc/core/lib/scaffold-hygiene.mjs"() {
    init_tickets();
  }
});

// node_modules/@adlc/core/lib/prosecutor.mjs
var LENSES, VERIFIER, ALL_AGENTS;
var init_prosecutor = __esm({
  "node_modules/@adlc/core/lib/prosecutor.mjs"() {
    init_ledger();
    LENSES = [
      { key: "correctness", agent: "prosecutor-correctness", focus: "logic errors, broken invariants, wrong results" },
      { key: "security", agent: "prosecutor-security", focus: "auth/trust boundaries, injection, secrets, unsafe data flow" },
      { key: "contract", agent: "prosecutor-contract", focus: "API/schema/type conformance against the declared contract" },
      { key: "diff", agent: "prosecutor-diff", focus: "spec-vs-implementation divergence; unstated behavior changes" },
      { key: "tests", agent: "prosecutor-tests", focus: "hollow/mock-only tests; are the new tests load-bearing?" }
    ];
    VERIFIER = { key: "verifier", agent: "prosecutor-verifier", focus: "reproduce/refute a finding" };
    ALL_AGENTS = [...LENSES.map((l) => l.agent), VERIFIER.agent];
  }
});

// node_modules/@adlc/core/lib/markdown.mjs
function matchFenceOpen(line) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const char = m[1][0];
  if (char === "`" && m[2].includes("`")) return null;
  return { char, len: m[1].length };
}
function isFenceClose(line, char, len) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m) && m[1][0] === char && m[1].length >= len;
}
function computeFencedLines(content, { unclosedToEof = true } = {}) {
  const fenced = /* @__PURE__ */ new Set();
  if (typeof content !== "string" || content === "") return fenced;
  const lines2 = content.split("\n");
  let fence = null;
  let pending = [];
  const commit = () => {
    for (const n2 of pending) fenced.add(n2);
    pending = [];
  };
  for (let i = 0; i < lines2.length; i++) {
    const line = lines2[i].replace(/\r+$/, "");
    if (line.includes("\r")) {
      if (fence !== null) commit();
      fence = null;
      continue;
    }
    if (fence === null) {
      fence = matchFenceOpen(line);
      continue;
    }
    if (isFenceClose(line, fence.char, fence.len)) {
      commit();
      fence = null;
      continue;
    }
    pending.push(i + 1);
  }
  if (fence !== null && unclosedToEof) commit();
  return fenced;
}
var init_markdown = __esm({
  "node_modules/@adlc/core/lib/markdown.mjs"() {
  }
});

// node_modules/@adlc/core/lib/shell.mjs
var init_shell = __esm({
  "node_modules/@adlc/core/lib/shell.mjs"() {
  }
});

// node_modules/@adlc/core/lib/railpath.mjs
var init_railpath = __esm({
  "node_modules/@adlc/core/lib/railpath.mjs"() {
  }
});

// node_modules/@adlc/core/lib/mutate.mjs
var mutate_exports = {};
__export(mutate_exports, {
  OPERATORS: () => OPERATORS,
  applyMutant: () => applyMutant,
  changedLinesFromDiff: () => changedLinesFromDiff,
  generateMutants: () => generateMutants,
  identifierSegments: () => identifierSegments,
  isTuningIdentifier: () => isTuningIdentifier
});
function identifierSegments(name) {
  return String(name).replace(/[_$\d]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim().split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
}
function isTuningIdentifier(name) {
  const segs = identifierSegments(name);
  if (segs.length === 0) return false;
  const tail2 = segs[segs.length - 1];
  if (DISCRETE_TAIL.has(tail2)) return false;
  if (MAGNITUDE_UNIT_TAIL.has(tail2)) return true;
  for (let i = 0; i < segs.length; i++) {
    let joined = "";
    for (let j = i; j < segs.length; j++) {
      joined += segs[j];
      if (TUNING_PHRASES.has(joined)) return true;
    }
  }
  return false;
}
function maskTuningAssignments(line) {
  const withoutComments = line.replace(BLOCK_COMMENT_RE, blank);
  return withoutComments.replace(ASSIGNMENT_RE, (match, _quote, key, value) => {
    if (!isTuningIdentifier(key)) return match;
    return ZERO_VALUE_RE.test(value.trim()) ? match : blank(match);
  });
}
function splitTopLevelCommas(str) {
  const parts = [];
  let current = "";
  let quote = null;
  for (const ch of str) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function parseTernary(line) {
  const head = line.match(TERNARY_HEAD_RE);
  if (!head) return null;
  const [full, prefix, whenTrue] = head;
  const rest = line.slice(full.length);
  const end = findTernaryEnd(rest);
  const whenFalse = rest.slice(0, end);
  const trailing = rest.slice(end);
  if (/[?:{}]/.test(whenFalse)) return null;
  if (!/^;?\s*$/.test(trailing)) return null;
  const suffix = trailing.includes(";") ? ";" : "";
  return { prefix, whenTrue, whenFalse, suffix };
}
function findTernaryEnd(rest) {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      if (depth === 0) return i;
      depth--;
      continue;
    }
    if (depth === 0) {
      if (ch === "," || ch === ";") return i;
      if (ch === "/" && rest[i + 1] === "/") return i;
    }
  }
  return rest.length;
}
function generateMutants(content, { targetLines, maxMutants: maxMutants2 = 50 } = {}) {
  const lines2 = content.split("\n");
  const allow = targetLines ? /* @__PURE__ */ new Set([...targetLines]) : null;
  const mutants = [];
  for (let i = 0; i < lines2.length && mutants.length < maxMutants2; i++) {
    const lineNo = i + 1;
    if (allow && !allow.has(lineNo)) continue;
    const original = lines2[i];
    const prefix = original.match(CLOSED_COMMENT_PREFIX)?.[1] ?? "";
    const body = original.slice(prefix.length);
    if (SKIP_LINE.test(body)) continue;
    for (const op of OPERATORS) {
      const mutatedBody = op.apply(body);
      if (mutatedBody === null || mutatedBody === body) continue;
      mutants.push({ line: lineNo, operator: op.name, original, mutated: prefix + mutatedBody });
      if (mutants.length >= maxMutants2) break;
    }
  }
  return mutants;
}
function applyMutant(content, mutant) {
  const lines2 = content.split("\n");
  if (lines2[mutant.line - 1] !== mutant.original) {
    throw new Error(
      `mutant line ${mutant.line} no longer matches original content \u2014 refusing to apply`
    );
  }
  lines2[mutant.line - 1] = mutant.mutated;
  return lines2.join("\n");
}
function changedLinesFromDiff(diffText) {
  const result6 = {};
  let currentFile = null;
  let newLine = 0;
  for (const line of diffText.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      result6[currentFile] = result6[currentFile] ?? /* @__PURE__ */ new Set();
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result6[currentFile].add(newLine);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
    } else if (!line.startsWith("\\")) {
      newLine++;
    }
  }
  return result6;
}
var LOOSE_EQ_NULL_RE, LOOSE_NEQ_NULL_RE, DISCRETE_TAIL, MAGNITUDE_UNIT_TAIL, TUNING_PHRASES, BLOCK_COMMENT_RE, ASSIGNMENT_RE, ZERO_VALUE_RE, blank, ARRAY_LITERAL_ELEMENT, ARRAY_LITERAL_RE, TERNARY_HEAD_RE, OPERATORS, SKIP_LINE, CLOSED_COMMENT_PREFIX;
var init_mutate = __esm({
  "node_modules/@adlc/core/lib/mutate.mjs"() {
    LOOSE_EQ_NULL_RE = /(?<![=!])==(?!=)\s*null\b/;
    LOOSE_NEQ_NULL_RE = /(?<!!)!=(?!=)\s*null\b/;
    DISCRETE_TAIL = /* @__PURE__ */ new Set([
      "retries",
      "retry",
      "tries",
      "attempts",
      "attempt",
      "count",
      "counts",
      "limit",
      "limits",
      "size",
      "sizes",
      "length",
      "len",
      "index",
      "idx",
      "offset",
      "code",
      "codes",
      "id",
      "ids",
      "version",
      "port",
      "level",
      "priority",
      "depth",
      "concurrency",
      "workers",
      "slots",
      "page",
      "pages",
      "num",
      "number",
      "numbers",
      "items",
      "rows",
      "lines",
      "chars",
      "columns"
    ]);
    MAGNITUDE_UNIT_TAIL = /* @__PURE__ */ new Set([
      "ms",
      "msec",
      "msecs",
      "milli",
      "millis",
      "millisecond",
      "milliseconds",
      "us",
      "usec",
      "usecs",
      "micro",
      "micros",
      "microsecond",
      "microseconds",
      "ns",
      "nsec",
      "nsecs",
      "nano",
      "nanos",
      "nanosecond",
      "nanoseconds",
      "byte",
      "bytes",
      "kb",
      "mb",
      "gb",
      "tb",
      "kib",
      "mib",
      "gib",
      "tib",
      "kbytes",
      "mbytes",
      "gbytes"
    ]);
    TUNING_PHRASES = /* @__PURE__ */ new Set([
      "timeout",
      "delay",
      "interval",
      "backoff",
      "ttl",
      "maxage",
      "keepalive",
      "maxbuffer",
      "highwatermark",
      "maxbytes"
    ]);
    BLOCK_COMMENT_RE = /\/\*(?:(?!\*\/)[\s\S])*?\*\//g;
    ASSIGNMENT_RE = /(['"`]?)([A-Za-z_$][\w$]*)\1\s*[:=]\s*(-?\d[\d\s*+\-/_.]*)/g;
    ZERO_VALUE_RE = /^-?0+$/;
    blank = (s) => " ".repeat(s.length);
    ARRAY_LITERAL_ELEMENT = String.raw`(?:'[^']*'|"[^"]*"|\`[^\`]*\`|[\w$.]+)`;
    ARRAY_LITERAL_RE = new RegExp(
      `\\[\\s*(${ARRAY_LITERAL_ELEMENT}(?:\\s*,\\s*${ARRAY_LITERAL_ELEMENT})+)\\s*\\]`
    );
    TERNARY_HEAD_RE = /^(.*?)\?(?!\.)\s*([^?:{}]+?)\s*:\s*/;
    OPERATORS = [
      {
        name: "invert-comparison",
        apply(line) {
          const swaps = [
            [/===/g, "!=="],
            [/!==/g, "==="],
            [/<=/g, ">"],
            [/>=/g, "<"],
            [/(?<![<>=!])<(?![=<])/g, ">="],
            [/(?<![<>=!-])>(?![=>])/g, "<="]
          ];
          for (const [re, replacement] of swaps) {
            if (re.test(line)) return line.replace(re, replacement);
          }
          return null;
        }
      },
      {
        name: "bool-flip",
        apply(line) {
          if (/\btrue\b/.test(line)) return line.replace(/\btrue\b/, "false");
          if (/\bfalse\b/.test(line)) return line.replace(/\bfalse\b/, "true");
          return null;
        }
      },
      {
        name: "null-return",
        apply(line) {
          const m = line.match(/^(\s*)return\s+(?!null\b)(?!;)(.+);?\s*$/);
          if (!m) return null;
          return `${m[1]}return null;`;
        }
      },
      {
        name: "off-by-one",
        apply(line) {
          const m = maskTuningAssignments(line).match(/(?<![\w.])(\d+)(?![\w.])/);
          if (!m) return null;
          const digits = m[1];
          const n2 = parseInt(digits, 10);
          return line.slice(0, m.index) + String(n2 + 1) + line.slice(m.index + digits.length);
        }
      },
      {
        name: "logic-swap",
        apply(line) {
          if (/&&/.test(line)) return line.replace(/&&/, "||");
          if (/\|\|/.test(line)) return line.replace(/\|\|/, "&&");
          return null;
        }
      },
      {
        // Negates one recognized guard sub-clause independently of the rest of
        // the condition on the line: an Array.isArray(...) call, a bare
        // identifier used for truthiness (`if (value)`), or a loose (`==`/`!=`)
        // null check. logic-swap only flips the combinator (&&/||) between
        // sub-clauses; this operator flips a sub-clause itself.
        name: "negate-guard-subclause",
        apply(line) {
          if (/!Array\.isArray\(/.test(line)) {
            return line.replace(/!Array\.isArray\(/, "Array.isArray(");
          }
          if (/\bArray\.isArray\(/.test(line)) {
            return line.replace(/\bArray\.isArray\(/, "!Array.isArray(");
          }
          const bareIf = line.match(/\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
          if (bareIf) {
            return line.replace(bareIf[0], `if (!${bareIf[1]})`);
          }
          if (LOOSE_EQ_NULL_RE.test(line)) {
            return line.replace(LOOSE_EQ_NULL_RE, "!= null");
          }
          if (LOOSE_NEQ_NULL_RE.test(line)) {
            return line.replace(LOOSE_NEQ_NULL_RE, "== null");
          }
          return null;
        }
      },
      {
        // Drops the last element of a simple array literal — catches a
        // silently-shrinkable list (e.g. a shared-fields constant) that no
        // comparison/boolean/return operator above can reach.
        name: "array-literal-shrink",
        apply(line) {
          const m = line.match(ARRAY_LITERAL_RE);
          if (!m) return null;
          const items = splitTopLevelCommas(m[1]);
          if (items.length < 2) return null;
          const shrunk = items.slice(0, -1).join(", ");
          return `${line.slice(0, m.index)}[${shrunk}]${line.slice(m.index + m[0].length)}`;
        }
      },
      {
        // Swaps the two branches of a single-line ternary — the classic shape of
        // a recursive array-processing guard (`Array.isArray(x) ? recurse(x) :
        // x`). Fails closed (no match) on nested ternaries/object literals, and
        // on a ternary followed by anything other than optional whitespace/`;`
        // (a trailing comment, or embedding as one element of an array/object/
        // call-argument list) — see parseTernary.
        name: "ternary-swap",
        apply(line) {
          const parsed = parseTernary(line);
          if (!parsed) return null;
          const { prefix, whenTrue, whenFalse, suffix } = parsed;
          const trueTrim = whenTrue.trim();
          const falseTrim = whenFalse.trim();
          if (!trueTrim || !falseTrim || trueTrim === falseTrim) return null;
          return `${prefix}? ${falseTrim} : ${trueTrim}${suffix}`;
        }
      }
    ];
    SKIP_LINE = /^\s*($|\/\/|\/\*|\*|#|import\b|export\s+\{|console\.)/;
    CLOSED_COMMENT_PREFIX = /^(\s*(?:\/\*(?:(?!\*\/)[\s\S])*?\*\/\s*)+)(?=\S)/;
  }
});

// node_modules/@adlc/core/lib/text.mjs
function tail(str, maxChars = 4e3) {
  if (str.length <= maxChars) return str;
  return str.slice(str.length - maxChars);
}
var init_text = __esm({
  "node_modules/@adlc/core/lib/text.mjs"() {
  }
});

// node_modules/@adlc/core/index.mjs
var init_core = __esm({
  "node_modules/@adlc/core/index.mjs"() {
    init_llm();
    init_git();
    init_cli();
    init_ledger();
    init_tickets2();
    init_revision();
    init_risk_tier();
    init_scaffold_hygiene();
    init_prosecutor();
    init_markdown();
    init_shell();
    init_railpath();
    init_mutate();
    init_text();
  }
});

// node_modules/@adlc/gate-manifest/lib/sign.mjs
import { createHmac as createHmac3, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
function getKey(env = process.env) {
  const k = env[KEY_ENV];
  return typeof k === "string" && k.length > 0 ? k : null;
}
function canonicalEntryBytes2(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, segment: _segment, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = {
    seq: entry.seq,
    gate: entry.gate,
    ts: entry.ts
  };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}
function signEntry(key, entry) {
  return createHmac3("sha256", key).update(canonicalEntryBytes2(entry)).digest("hex");
}
function verifyEntrySig(key, entry) {
  if (typeof entry.sig !== "string" || entry.sig.length === 0) return false;
  const expected = signEntry(key, entry);
  const a = Buffer.from(entry.sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual2(a, b);
}
var KEY_ENV;
var init_sign = __esm({
  "node_modules/@adlc/gate-manifest/lib/sign.mjs"() {
    init_core();
    KEY_ENV = "ADLC_MANIFEST_KEY";
  }
});

// node_modules/@adlc/gate-manifest/lib/forest.mjs
import { existsSync as existsSync17, readdirSync as readdirSync6, readFileSync as readFileSync14, lstatSync as lstatSync8 } from "node:fs";
import { join as join17 } from "node:path";
function looksLikeGenuineLedgerLock2(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES2) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync14(path, "utf8").trim());
  } catch {
  }
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.startedAt === "string";
}
function segmentDirPath2(dir) {
  return join17(dir, SEGMENT_DIRNAME2);
}
function segmentPath2(dir, name) {
  return join17(segmentDirPath2(dir), name);
}
function discoverSegments2(dir) {
  const segDir = segmentDirPath2(dir);
  let dirStat;
  try {
    dirStat = lstatSync8(segDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) {
    return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is a symlink" }] };
  }
  if (!dirStat.isDirectory()) {
    return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is not a directory" }] };
  }
  const valid = [];
  const invalid3 = [];
  const seenLower = /* @__PURE__ */ new Map();
  let names;
  try {
    names = readdirSync6(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: ".", reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  for (const name of names) {
    if (RESERVED_NAMES2.has(name)) continue;
    const full = join17(segDir, name);
    let st;
    try {
      st = lstatSync8(full);
    } catch (err) {
      invalid3.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      invalid3.push({ name, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      invalid3.push({ name, reason: "nested directory" });
      continue;
    }
    if (!st.isFile()) {
      invalid3.push({ name, reason: "not a regular file" });
      continue;
    }
    if (name.endsWith(LOCK_SUFFIX)) {
      if (looksLikeGenuineLedgerLock2(full, st.size)) continue;
      invalid3.push({ name, reason: "lock-suffixed object is not a genuine advisory lock" });
      continue;
    }
    if (!SEGMENT_NAME_RE2.test(name)) {
      invalid3.push({ name, reason: "bad filename grammar" });
      continue;
    }
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      invalid3.push({ name, reason: `case-colliding with ${seenLower.get(lower)}` });
      continue;
    }
    seenLower.set(lower, name);
    valid.push(name);
  }
  return { valid, invalid: invalid3 };
}
function readRawLines2(filePath) {
  if (!existsSync17(filePath)) return [];
  const content = readFileSync14(filePath, "utf8");
  return content.split("\n").map((line, i) => ({ line, lineNo: i + 1 })).filter(({ line }) => line.trim() !== "");
}
function resolveAnchor(anchor, chainsBySeq, rootExists) {
  if (anchor === null) {
    if (rootExists) return { ok: false, reason: "anchor: null is not permitted once a root exists" };
    return { ok: true };
  }
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    return { ok: false, reason: "anchor must be an object or null" };
  }
  const { segment, seq, lineHash } = anchor;
  if (typeof segment !== "string" || segment === "") {
    return { ok: false, reason: "anchor.segment must be a non-empty string" };
  }
  if (!Number.isInteger(seq) || seq < 1) {
    return { ok: false, reason: "anchor.seq must be a positive integer" };
  }
  if (typeof lineHash !== "string" || lineHash === "") {
    return { ok: false, reason: "anchor.lineHash must be a non-empty string" };
  }
  const target = chainsBySeq.get(segment);
  if (!target) return { ok: false, reason: `dangling anchor: no such segment '${segment}' in the forest` };
  const rawLine = target.get(seq);
  if (rawLine === void 0) return { ok: false, reason: `dangling anchor: segment '${segment}' has no entry with seq ${seq}` };
  if (sha256(rawLine) !== lineHash) return { ok: false, reason: `anchor lineHash mismatch for '${segment}' seq ${seq}` };
  return { ok: true };
}
function detectAnchorCycle(anchorBySegment) {
  const state = /* @__PURE__ */ new Map();
  for (const start of anchorBySegment.keys()) {
    if (state.get(start) === "done") continue;
    const path = [];
    let current = start;
    while (current !== void 0) {
      if (state.get(current) === "visiting") return { ok: false, segment: current };
      if (state.get(current) === "done") break;
      if (!anchorBySegment.has(current)) break;
      state.set(current, "visiting");
      path.push(current);
      const anchor = anchorBySegment.get(current);
      current = anchor === null ? void 0 : anchor.segment;
    }
    for (const seg of path) state.set(seg, "done");
  }
  return { ok: true };
}
function parseLenient(rawLines2, segmentLabel) {
  const entries = [];
  const skipped = [];
  for (const { line, lineNo } of rawLines2) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      skipped.push({ segment: segmentLabel, line: lineNo, error: String(err.message ?? err) });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      skipped.push({ segment: segmentLabel, line: lineNo, error: "entry must be an object" });
      continue;
    }
    entries.push({ ...entry, segment: segmentLabel });
  }
  return { entries, skipped };
}
function ulidOf2(segmentName) {
  return segmentName.slice(segmentName.length - ".jsonl".length - 26, segmentName.length - ".jsonl".length);
}
function readManifestForest(dir = ADLC_DIR) {
  const rootRaw = readRawLines2(ledgerPath("manifest", dir));
  const root2 = parseLenient(rootRaw, "root");
  const { valid: segmentNames, invalid: invalidSegments } = discoverSegments2(dir);
  const skipped = [...root2.skipped, ...invalidSegments.map((i) => ({ segment: i.name, line: null, error: i.reason }))];
  const bySegment = /* @__PURE__ */ new Map();
  for (const name of segmentNames) {
    const raw2 = readRawLines2(segmentPath2(dir, name));
    const parsed = parseLenient(raw2, name);
    skipped.push(...parsed.skipped);
    const anchor = parsed.entries.length > 0 && Object.hasOwn(parsed.entries[0], "anchor") ? parsed.entries[0].anchor : null;
    bySegment.set(name, { entries: parsed.entries, anchor });
  }
  const depthCache = /* @__PURE__ */ new Map();
  function depthOf(name, seen = /* @__PURE__ */ new Set()) {
    if (depthCache.has(name)) return depthCache.get(name);
    if (seen.has(name)) return 0;
    seen.add(name);
    const anchor = bySegment.get(name)?.anchor;
    const target = anchor?.segment;
    const depth = target && target !== "root" && bySegment.has(target) ? depthOf(target, seen) + 1 : 0;
    depthCache.set(name, depth);
    return depth;
  }
  const orderedNames = [...segmentNames].sort((a, b) => {
    const depthDiff = depthOf(a) - depthOf(b);
    if (depthDiff !== 0) return depthDiff;
    const aa = bySegment.get(a).anchor;
    const bb = bySegment.get(b).anchor;
    const aSeg = aa?.segment ?? "";
    const bSeg = bb?.segment ?? "";
    if (aSeg !== bSeg) return aSeg < bSeg ? -1 : 1;
    const aSeq = aa?.seq ?? 0;
    const bSeq = bb?.seq ?? 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    const aUlid = ulidOf2(a);
    const bUlid = ulidOf2(b);
    if (aUlid !== bUlid) return aUlid < bUlid ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const entries = [...root2.entries];
  for (const name of orderedNames) entries.push(...bySegment.get(name).entries);
  return { entries, skipped };
}
var SEGMENT_DIRNAME2, SEGMENT_NAME_RE2, RESERVED_NAMES2, LOCK_SUFFIX, MAX_LOCK_OWNER_BYTES2;
var init_forest = __esm({
  "node_modules/@adlc/gate-manifest/lib/forest.mjs"() {
    init_core();
    SEGMENT_DIRNAME2 = "manifest.d";
    SEGMENT_NAME_RE2 = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
    RESERVED_NAMES2 = /* @__PURE__ */ new Set([".store.json", ".lineage"]);
    LOCK_SUFFIX = ".lock";
    MAX_LOCK_OWNER_BYTES2 = 512;
  }
});

// node_modules/@adlc/gate-manifest/lib/verify.mjs
function verifyChain(nonEmpty, { key, requireSignatures, anchorOnFirst }) {
  if (nonEmpty.length === 0) {
    if (anchorOnFirst) {
      return { valid: false, message: "empty segment file has no first entry to carry the required anchor", count: 0, signed: false, break: { seq: null, lineNo: null, reason: "empty segment file" }, lastRawLine: null, firstAnchor: void 0 };
    }
    return { valid: true, message: "empty manifest", count: 0, signed: false, break: null, lastRawLine: null, firstAnchor: void 0 };
  }
  let prevRawLine = null;
  let prevSeq = null;
  let firstAnchor;
  let seenSignedEntry = false;
  for (const { line, lineNo } of nonEmpty) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail2(lineNo - 1, { seq: null, lineNo, reason: "malformed JSON" }, `chain broken at line ${lineNo}: malformed JSON`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail2(lineNo - 1, { seq: null, lineNo, reason: "entry must be an object" }, `chain broken at line ${lineNo}: entry must be an object`);
    }
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      return fail2(lineNo - 1, { seq: entry.seq ?? null, lineNo, reason: "invalid seq" }, `chain broken at line ${lineNo}: seq must be a positive integer`);
    }
    const isFirst = prevRawLine === null;
    if (isFirst) {
      if (entry.prev !== null) {
        return fail2(0, { seq: entry.seq, lineNo, reason: "first entry prev must be null" }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry prev must be null`);
      }
    } else {
      const expected = sha256(prevRawLine);
      if (entry.prev !== expected) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "prev hash mismatch" }, `chain broken at seq ${entry.seq} (line ${lineNo}): prev hash mismatch`);
      }
    }
    if (isFirst) {
      if (entry.seq !== 1) {
        return fail2(0, { seq: entry.seq, lineNo, reason: "first entry seq must be 1" }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry seq must be 1`);
      }
    } else if (entry.seq !== prevSeq + 1) {
      return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "seq not contiguous" }, `chain broken at seq ${entry.seq} (line ${lineNo}): seq must be contiguous (+1 from previous)`);
    }
    const hasAnchor = Object.hasOwn(entry, "anchor");
    if (isFirst) {
      firstAnchor = hasAnchor ? entry.anchor : void 0;
      if (anchorOnFirst && !hasAnchor) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "segment first entry missing required anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): segment first entry missing required anchor field`);
      }
      if (!anchorOnFirst && hasAnchor) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "root entry must not carry an anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): root entry must not carry an anchor field`);
      }
    } else if (hasAnchor) {
      return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "only a segment's first entry may carry an anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): only a segment's first entry may carry an anchor field`);
    }
    if (key !== null) {
      const hasSig = entry.sig !== void 0 && entry.sig !== null;
      if (!hasSig) {
        const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
        if (!toleratedLegacyPrefix) {
          return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "unsigned entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
        }
      } else if (!verifyEntrySig(key, entry)) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
      } else {
        seenSignedEntry = true;
      }
    }
    prevRawLine = line;
    prevSeq = entry.seq;
  }
  const signed = key !== null && requireSignatures;
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${nonEmpty.length} entries)` : `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    signed,
    break: null,
    lastRawLine: prevRawLine,
    firstAnchor
  };
  function fail2(count, breakInfo, message) {
    return { valid: false, message, count, signed: false, break: breakInfo, lastRawLine: null, firstAnchor: void 0 };
  }
}
function verify(dir = ADLC_DIR, { requireSignatures = true, key: keyParam } = {}) {
  const key = validateKeyParam(keyParam);
  const rootRaw = readRawLines2(ledgerPath("manifest", dir));
  const { valid: segmentNames, invalid: invalidSegments } = discoverSegments2(dir);
  if (invalidSegments.length > 0) {
    const first = invalidSegments[0];
    return {
      valid: false,
      message: `manifest.d/${first.name}: ${first.reason}`,
      count: 0,
      segments: segmentNames.length,
      signed: false,
      break: { seq: null, lineNo: null, reason: first.reason, segment: first.name }
    };
  }
  if (segmentNames.length === 0) {
    const result6 = verifyChain(rootRaw, { key, requireSignatures, anchorOnFirst: false });
    return { valid: result6.valid, message: result6.message, count: result6.count, segments: 0, signed: result6.signed, break: result6.break ? { ...result6.break, segment: "root" } : null };
  }
  const rootResult = verifyChain(rootRaw, { key, requireSignatures, anchorOnFirst: false });
  if (!rootResult.valid) {
    return { valid: false, message: rootResult.message, count: rootResult.count, segments: segmentNames.length, signed: false, break: { ...rootResult.break, segment: "root" } };
  }
  const chainsBySeq = /* @__PURE__ */ new Map();
  chainsBySeq.set("root", seqMap(rootRaw));
  const anchorBySegment = /* @__PURE__ */ new Map();
  let totalCount = rootResult.count;
  let allSigned = rootResult.count === 0 ? true : rootResult.signed;
  for (const name of segmentNames) {
    const raw2 = readRawLines2(segmentPath2(dir, name));
    const result6 = verifyChain(raw2, { key, requireSignatures, anchorOnFirst: true });
    if (!result6.valid) {
      return { valid: false, message: `manifest.d/${name}: ${result6.message}`, count: totalCount + result6.count, segments: segmentNames.length, signed: false, break: { ...result6.break, segment: name } };
    }
    chainsBySeq.set(name, seqMap(raw2));
    anchorBySegment.set(name, result6.firstAnchor === void 0 ? null : result6.firstAnchor);
    totalCount += result6.count;
    allSigned = allSigned && (result6.count === 0 ? true : result6.signed);
  }
  for (const name of segmentNames) {
    const anchor = anchorBySegment.get(name);
    const resolved = resolveAnchor(anchor, chainsBySeq, rootResult.count > 0);
    if (!resolved.ok) {
      return { valid: false, message: `manifest.d/${name}: ${resolved.reason}`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: resolved.reason, segment: name } };
    }
  }
  const cycleCheck = detectAnchorCycle(anchorBySegment);
  if (!cycleCheck.ok) {
    return { valid: false, message: `manifest.d/${cycleCheck.segment}: anchor cycle detected`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: "anchor cycle", segment: cycleCheck.segment } };
  }
  const signed = allSigned;
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${totalCount} entries, ${segmentNames.length} segments)` : `manifest ok (${totalCount} entries, ${segmentNames.length} segments)`,
    count: totalCount,
    segments: segmentNames.length,
    signed,
    break: null
  };
}
function seqMap(nonEmpty) {
  const m = /* @__PURE__ */ new Map();
  for (const { line } of nonEmpty) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && Number.isInteger(entry.seq)) m.set(entry.seq, line);
  }
  return m;
}
var init_verify = __esm({
  "node_modules/@adlc/gate-manifest/lib/verify.mjs"() {
    init_core();
    init_sign();
    init_forest();
    init_key_contract();
  }
});

// node_modules/@adlc/gate-manifest/lib/lineage.mjs
import { lstatSync as lstatSync9, writeFileSync as writeFileSync7, openSync as openSync6, readSync as readSync3, closeSync as closeSync6, unlinkSync as unlinkSync4, mkdirSync as mkdirSync6, constants as fsConstants3 } from "node:fs";
import { execFileSync as execFileSync5 } from "node:child_process";
import { randomBytes as randomBytes3 } from "node:crypto";
import { dirname as dirname12, join as join18, relative as relative5, sep as sep4 } from "node:path";
function markerPath2(dir) {
  return join18(segmentDirPath2(dir), MARKER_NAME2);
}
function lineagePath2(dir) {
  return join18(segmentDirPath2(dir), LINEAGE_NAME2);
}
function readBoundedJsonNoFollow2(path) {
  let st;
  try {
    st = lstatSync9(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync6(path, fsConstants3.O_RDONLY | fsConstants3.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES2);
    const bytesRead = readSync3(fd, buf, 0, MAX_LOCAL_JSON_BYTES2, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES2) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync6(fd);
  }
}
function hasActivationMarker2(dir) {
  const parsed = readBoundedJsonNoFollow2(markerPath2(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT2 && parsed.version === MARKER_VERSION2;
}
function rootEndsInCutover2(dir) {
  const raw2 = readRawLines2(ledgerPath("manifest", dir));
  if (raw2.length === 0) return false;
  try {
    const last = JSON.parse(raw2.at(-1).line);
    return Boolean(last) && typeof last === "object" && last.gate === "manifest-cutover";
  } catch {
    return false;
  }
}
function isSegmentedRepo2(dir = ADLC_DIR) {
  return hasActivationMarker2(dir) || rootEndsInCutover2(dir);
}
function encodeUlidPart2(value, width) {
  let remaining = BigInt(value);
  let output = "";
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET2[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}
function generateSegmentUlid2(now = Date.now(), entropy = randomBytes3(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281474976710655) throw new RangeError("ULID timestamp out of range");
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError("ULID entropy must be 10 bytes");
  const random = BigInt(`0x${entropy.toString("hex")}`);
  return `${encodeUlidPart2(BigInt(now), 10)}${encodeUlidPart2(random, 16)}`;
}
function deriveSlug2(branchName) {
  const lowered = String(branchName ?? "").toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = substituted.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, "");
  return truncated || "segment";
}
function currentBranch2(cwd2 = process.cwd()) {
  try {
    const out = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cwd2, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" || out === "HEAD" ? null : out;
  } catch {
    return null;
  }
}
function isSymlinkOrOtherNonRegular2(path) {
  let st;
  try {
    st = lstatSync9(path);
  } catch {
    return false;
  }
  return !st.isFile();
}
function readLineageToken2(dir) {
  const token = readBoundedJsonNoFollow2(lineagePath2(dir));
  if (!token || typeof token !== "object") return null;
  if (typeof token.segment !== "string" || typeof token.ulid !== "string" || typeof token.branch !== "string") return null;
  return token;
}
function writeLineageToken2(dir, token) {
  mkdirSync6(segmentDirPath2(dir), { recursive: true });
  const p = lineagePath2(dir);
  if (isSymlinkOrOtherNonRegular2(p)) unlinkSync4(p);
  const fd = openSync6(p, fsConstants3.O_WRONLY | fsConstants3.O_CREAT | fsConstants3.O_TRUNC | fsConstants3.O_NOFOLLOW);
  try {
    writeFileSync7(fd, JSON.stringify(token));
  } finally {
    closeSync6(fd);
  }
}
function peekOpenSegment2(dir = ADLC_DIR, { cwd: cwd2 = process.cwd() } = {}) {
  const branch = currentBranch2(cwd2);
  const token = readLineageToken2(dir);
  if (branch !== null && token && token.branch === branch) {
    const { valid } = discoverSegments2(dir);
    if (valid.includes(token.segment) && ulidOf2(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}
function firstEntryOf2(dir, segmentName) {
  let fd;
  try {
    fd = openSync6(segmentPath2(dir, segmentName), fsConstants3.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY2;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES2);
    const bytesRead = readSync3(fd, buf, 0, MAX_FIRST_LINE_BYTES2, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES2) return OVERSIZED_FIRST_ENTRY2;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === "") return MALFORMED_FIRST_ENTRY2;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY2;
  } finally {
    closeSync6(fd);
  }
}
function recoverOpenSegment2(dir = ADLC_DIR, { cwd: cwd2 = process.cwd() } = {}) {
  const peeked = peekOpenSegment2(dir, { cwd: cwd2 });
  if (peeked) return peeked;
  const branch = currentBranch2(cwd2);
  if (branch === null) return null;
  const discovered = discoverSegments2(dir);
  if (discovered.invalid.length > 0) {
    throw new Error(
      `manifest.d/ contains ${discovered.invalid.length} non-conforming filesystem object(s) (${discovered.invalid.map((i) => i.name).sort().join(", ")}) \u2014 one could be a disguised or tampered segment belonging to this branch, so recovery refuses rather than guess`
    );
  }
  const candidates = [];
  for (const name of discovered.valid) {
    const first = firstEntryOf2(dir, name);
    if (first === OVERSIZED_FIRST_ENTRY2) {
      throw new Error(
        `segment ${name}'s first entry exceeds the ${MAX_FIRST_LINE_BYTES2}-byte bounded-read cap \u2014 its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first === MALFORMED_FIRST_ENTRY2) {
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
function assertSegmentPathCommittable2(dir, name) {
  const probeCwd = dirname12(dir);
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const run = (args) => {
    try {
      execFileSync5("git", args, { cwd: probeCwd, env, stdio: "ignore" });
      return 0;
    } catch (err) {
      if (err.code === "ENOENT") return "no-git";
      return err.status ?? "error";
    }
  };
  if (run(["rev-parse", "--is-inside-work-tree"]) !== 0) return;
  const rel = relative5(probeCwd, segmentPath2(dir, name)).split(sep4).join("/");
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
function resolveOpenSegment2(dir = ADLC_DIR, { cwd: cwd2 = process.cwd(), key = null } = {}) {
  const markerDoc = readBoundedJsonNoFollow2(markerPath2(dir));
  if (markerDoc && markerDoc.auth === "keyed" && key === null) {
    throw new Error(
      "this forest was activated in keyed mode, but no signing key was provided for this write \u2014 an unsigned entry here would permanently strand every keyed clone of this branch; configure the manifest key"
    );
  }
  const peeked = peekOpenSegment2(dir, { cwd: cwd2 });
  if (peeked) return peeked;
  if (key !== null) {
    const recovered = recoverOpenSegment2(dir, { cwd: cwd2 });
    if (recovered) {
      const lines2 = readRawLines2(segmentPath2(dir, recovered.name));
      const chain = verifyChain(lines2, { key, requireSignatures: false, anchorOnFirst: true });
      let first = null;
      try {
        first = JSON.parse(lines2[0]?.line);
      } catch {
      }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && verifyEntrySig(key, first);
      if (!chain.valid || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key (broken chain, or its branch-bearing first entry lacks a verified v2 signature) \u2014 refusing to extend it, and refusing to mint a duplicate past it (that would silently fork this branch's lineage)`
        );
      }
      return recovered;
    }
  } else {
    let candidateExists = false;
    try {
      candidateExists = recoverOpenSegment2(dir, { cwd: cwd2 }) !== null;
    } catch {
      candidateExists = true;
    }
    if (candidateExists) {
      throw new Error(
        "a committed segment already declares this branch, and with no signing key this writer can neither authenticate and extend it nor safely mint alongside it (a fresh token would shadow the committed evidence from every later read) \u2014 configure the manifest key, or restore the local .lineage token"
      );
    }
  }
  const branch = currentBranch2(cwd2);
  const rootLines = readRawLines2(ledgerPath("manifest", dir));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    const lastEntry = JSON.parse(rootLast.line);
    anchor = { segment: "root", seq: lastEntry.seq, lineHash: sha256(rootLast.line) };
  }
  const ulid = generateSegmentUlid2();
  const slug = deriveSlug2(branch ?? "");
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable2(dir, name);
  if (branch !== null) writeLineageToken2(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...branch !== null ? { branch } : {} };
}
var MARKER_NAME2, LINEAGE_NAME2, MARKER_FORMAT2, MARKER_VERSION2, MAX_LOCAL_JSON_BYTES2, ULID_ALPHABET2, MAX_FIRST_LINE_BYTES2, OVERSIZED_FIRST_ENTRY2, MALFORMED_FIRST_ENTRY2;
var init_lineage = __esm({
  "node_modules/@adlc/gate-manifest/lib/lineage.mjs"() {
    init_core();
    init_forest();
    init_verify();
    init_sign();
    MARKER_NAME2 = ".store.json";
    LINEAGE_NAME2 = ".lineage";
    MARKER_FORMAT2 = "adlc-manifest-segments";
    MARKER_VERSION2 = 1;
    MAX_LOCAL_JSON_BYTES2 = 4096;
    ULID_ALPHABET2 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    MAX_FIRST_LINE_BYTES2 = 65536;
    OVERSIZED_FIRST_ENTRY2 = /* @__PURE__ */ Symbol("oversized-first-entry");
    MALFORMED_FIRST_ENTRY2 = /* @__PURE__ */ Symbol("malformed-first-entry");
  }
});

// node_modules/@adlc/gate-manifest/lib/segment-writer.mjs
import { existsSync as existsSync18, readFileSync as readFileSync15, mkdirSync as mkdirSync7, openSync as openSync7, writeFileSync as writeFileSync8, fsyncSync as fsyncSync4, closeSync as closeSync7 } from "node:fs";
import { dirname as dirname13 } from "node:path";
function appendToSegment(payload, dir, { signatureVersion, cwd: cwd2, key }) {
  return withLedgerLock(lineagePath2(dir), () => appendWithinLedgerLock(payload, dir, { signatureVersion, cwd: cwd2, key }));
}
function appendWithinLedgerLock(payload, dir, { signatureVersion, cwd: cwd2, key }) {
  const integrity = verify(dir, { requireSignatures: false, key });
  if (!integrity.valid) {
    throw new Error(`manifest forest is invalid: ${integrity.message}`);
  }
  const resolved = resolveOpenSegment2(dir, { cwd: cwd2, key });
  const targetPath = segmentPath2(dir, resolved.name);
  mkdirSync7(segmentDirPath2(dir), { recursive: true });
  return withLedgerLock(targetPath, () => appendLockedEntry(payload, resolved, targetPath, signatureVersion, key));
}
function appendLockedEntry(payload, resolved, targetPath, signatureVersion, key) {
  const content = existsSync18(targetPath) ? readFileSync15(targetPath, "utf8") : "";
  const rawLines2 = content.split("\n").filter((line) => line.trim() !== "");
  if (resolved.isNew && rawLines2.length > 0) {
    throw new Error(`segment ${resolved.name} was expected to be new but already has content \u2014 refusing to append`);
  }
  if (!resolved.isNew && rawLines2.length === 0) {
    throw new Error(`segment ${resolved.name} was expected to already be open with content but is empty or missing \u2014 refusing to append without an anchor`);
  }
  const entries = rawLines2.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`segment ${resolved.name} contains malformed JSON at line ${i + 1}`);
    }
  });
  const previous = entries.at(-1) ?? null;
  if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
    throw new Error(`segment ${resolved.name} tail is not hash-chain compatible: missing positive seq`);
  }
  const prevRawLine = rawLines2.at(-1) ?? null;
  const normalized = {
    ...payload,
    gate: payload.gate ?? payload.type ?? "evidence",
    ts: payload.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    files: payload.files ?? {}
  };
  const chained = {
    seq: previous ? previous.seq + 1 : 1,
    ...normalized,
    // `anchor`/`branch` spread AFTER `...normalized`, not before (adversarial-
    // review finding, T-MANIFEST-FOREST fourth round): `RESERVED_CHAIN_FIELDS`
    // in record.mjs already rejects a payload that supplies either field
    // outright, but constructing these writer-owned structural fields LAST is
    // defense-in-depth — a payload can never overwrite them regardless of
    // what upstream validation does or doesn't catch. `branch` is the EXACT
    // git branch that minted this segment, recorded once on the first entry
    // alongside `anchor` — a non-lossy identity recoverOpenSegment matches on,
    // unlike the derived filename slug (see lineage.mjs's recoverOpenSegment
    // doc). Omitted (not `anchor`-style `null`) when resolveOpenSegment minted
    // this segment from a detached HEAD, which has no branch identity.
    ...resolved.isNew ? { anchor: resolved.anchor, ...resolved.branch !== void 0 ? { branch: resolved.branch } : {} } : {},
    prev: prevRawLine === null ? null : sha256(prevRawLine)
  };
  const effectiveSignatureVersion = resolved.isNew ? 2 : signatureVersion;
  if (key) {
    if (effectiveSignatureVersion === 2) chained.sigVersion = 2;
    chained.sig = signEntry(key, chained);
  }
  const fd = openSync7(targetPath, "a");
  try {
    writeFileSync8(fd, `${JSON.stringify(chained)}
`);
    fsyncSync4(fd);
  } finally {
    closeSync7(fd);
  }
  if (process.platform !== "win32") {
    const dirFd = openSync7(dirname13(targetPath), "r");
    try {
      fsyncSync4(dirFd);
    } finally {
      closeSync7(dirFd);
    }
  }
  return chained;
}
var init_segment_writer = __esm({
  "node_modules/@adlc/gate-manifest/lib/segment-writer.mjs"() {
    init_core();
    init_sign();
    init_verify();
    init_forest();
    init_lineage();
  }
});

// node_modules/@adlc/gate-manifest/lib/record.mjs
import { dirname as dirname14 } from "node:path";
function appendManifestEntry(payload, dir = ADLC_DIR, { signatureVersion = 2, cwd: cwd2 = dirname14(dir), key } = {}) {
  const signingKey = validateKeyParam(key);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("manifest payload must be an object");
  }
  for (const field of RESERVED_CHAIN_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      throw new Error(`manifest payload must not provide reserved chain field: ${field}`);
    }
  }
  if (isSegmentedRepo2(dir)) {
    return appendToSegment(payload, dir, { signatureVersion, cwd: cwd2, key: signingKey });
  }
  const [entry] = appendEntries("manifest", (state) => {
    if (isSegmentedRepo2(dir)) {
      throw new Error("manifest chain is frozen; this repo uses .adlc/manifest.d/ \u2014 upgrade adlc if you are seeing this locally");
    }
    if (state.skipped.length > 0) {
      throw new Error(`manifest contains malformed JSON at line ${state.skipped[0].line}`);
    }
    if (state.rawLines.length > 0) {
      const integrity = verify(dir, { requireSignatures: false, key: signingKey });
      if (!integrity.valid) {
        throw new Error(`manifest chain is invalid: ${integrity.message}`);
      }
    } else {
      const { valid: existingSegments } = discoverSegments2(dir);
      if (existingSegments.length > 0) {
        throw new Error(
          `refusing to create the root manifest: manifest.d/ already holds ${existingSegments.length} segment(s) anchored to nothing (anchor: null), legal only in a rootless forest \u2014 creating a root now would make every one of them invalid (spec \xA74.4). This usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted; restore it rather than appending to root.`
        );
      }
    }
    const previous = state.entries.at(-1);
    if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
      throw new Error("manifest tail is not hash-chain compatible: missing positive seq");
    }
    const normalized = {
      ...payload,
      gate: payload.gate ?? payload.type ?? "evidence",
      ts: payload.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
      files: payload.files ?? {}
    };
    const chained = {
      seq: previous ? previous.seq + 1 : 1,
      ...normalized,
      prev: state.lastRawLine === null ? null : sha256(state.lastRawLine)
    };
    if (signingKey) {
      if (signatureVersion === 2) chained.sigVersion = 2;
      chained.sig = signEntry(signingKey, chained);
    }
    return [chained];
  }, dir);
  return entry;
}
function parseData(raw2) {
  if (!raw2) return void 0;
  try {
    return JSON.parse(raw2);
  } catch (err) {
    throw new Error(`--data is not valid JSON: ${err.message}`);
  }
}
function parseFileList(raw2) {
  if (!raw2) return [];
  return raw2.split(",").map((s) => s.trim()).filter(Boolean);
}
function record({ gate, ticket: ticket2, rawData, rawFiles, dir = ADLC_DIR, key }) {
  const signingKey = validateKeyParam(key);
  const data = parseData(rawData);
  const filePaths2 = parseFileList(rawFiles);
  const payload = { gate, ts: (/* @__PURE__ */ new Date()).toISOString() };
  if (ticket2 !== void 0) payload.ticket = ticket2;
  if (data !== void 0) payload.data = data;
  payload.files = filePaths2.length > 0 ? hashFiles(filePaths2) : {};
  return appendManifestEntry(payload, dir, { signatureVersion: 1, key: signingKey });
}
function ticketCompletionReminder(gate, ticket2) {
  if (typeof gate !== "string" || typeof ticket2 !== "string" || ticket2 === "") return null;
  if (!/^p6-accept/.test(gate)) return null;
  return `reminder: recording ${gate} is evidence, not completion \u2014 conclude P6 with \`adlc ticket complete ${ticket2} --write\` (add \`--authorize\` when the ticket is railed).`;
}
var RESERVED_CHAIN_FIELDS;
var init_record = __esm({
  "node_modules/@adlc/gate-manifest/lib/record.mjs"() {
    init_core();
    init_sign();
    init_verify();
    init_lineage();
    init_segment_writer();
    init_forest();
    init_key_contract();
    RESERVED_CHAIN_FIELDS = ["seq", "prev", "sig", "sigVersion", "segment", "anchor", "branch"];
  }
});

// node_modules/@adlc/gate-manifest/index.mjs
var init_gate_manifest = __esm({
  "node_modules/@adlc/gate-manifest/index.mjs"() {
    init_record();
  }
});

// node_modules/@adlc/rails-guard/lib/version-only.mjs
function isManifestFile(file) {
  if (typeof file !== "string" || file === "") return false;
  return MANIFEST_BASENAMES2.has(file.split("/").pop());
}
function manifestKind(file) {
  if (typeof file !== "string") return null;
  const basename8 = file.split("/").pop();
  return MANIFEST_BASENAMES2.has(basename8) ? basename8 : null;
}
function parseCanonical(text) {
  if (typeof text !== "string") return null;
  if (Buffer.from(text, "utf8").toString("utf8") !== text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let canonical;
  try {
    canonical = JSON.stringify(parsed, null, 2) + "\n";
  } catch {
    return null;
  }
  if (canonical !== text) return null;
  return parsed;
}
function isVersion(value) {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return false;
  if (!VERSION_RE.test(value)) return false;
  const [core] = value.split(/[-+]/);
  for (const part of core.split(".")) {
    if (part.length > MAX_SAFE_COMPONENT_LENGTH) return false;
    if (Number(part) > Number.MAX_SAFE_INTEGER) return false;
  }
  return true;
}
function splitRange(value) {
  if (typeof value !== "string") return null;
  const m = RANGE_RE.exec(value);
  if (!m || !isVersion(m[2])) return null;
  return { operator: m[1], version: m[2] };
}
function walk(value, path, out) {
  if (value !== null && typeof value === "object") {
    const isArray = Array.isArray(value);
    const keys = isArray ? value.map((_, i) => String(i)) : Object.keys(value);
    out.set(`K${JSON.stringify(path)}`, JSON.stringify([isArray ? "A" : "O", keys]));
    for (const key of keys) walk(value[key], [...path, key], out);
    return;
  }
  out.set(`V${JSON.stringify(path)}`, JSON.stringify(value));
}
function isPackageVersionPath(path) {
  return path.length === 1 && path[0] === "version";
}
function isMarketplaceVersionPath(path, before, after) {
  if (path.length === 2 && path[0] === "metadata" && path[1] === "version") return true;
  if (path.length !== 3 || path[0] !== "plugins" || path[2] !== "version") return false;
  if (!/^\d+$/.test(path[1])) return false;
  return Array.isArray(before.plugins) && Array.isArray(after.plugins);
}
function isAdlcRangePath(path) {
  return path.length === 2 && DEP_FIELDS.has(path[0]) && ADLC_PKG.test(path[1]);
}
function valueAt(root2, path) {
  let node = root2;
  for (const key of path) {
    if (node === null || typeof node !== "object") return void 0;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return void 0;
    node = node[key];
  }
  return node;
}
function isVersionOnlyChange(beforeText, afterText, file) {
  const kind = manifestKind(file);
  if (kind === null) return false;
  const before = parseCanonical(beforeText);
  const after = parseCanonical(afterText);
  if (before === null || after === null) return false;
  const beforeMap = /* @__PURE__ */ new Map();
  const afterMap = /* @__PURE__ */ new Map();
  walk(before, [], beforeMap);
  walk(after, [], afterMap);
  let versionChanged = false;
  const repins = [];
  for (const key of /* @__PURE__ */ new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    if (beforeMap.get(key) === afterMap.get(key)) continue;
    if (key.startsWith("K")) return false;
    const path = JSON.parse(key.slice(1));
    const from = valueAt(before, path);
    const to = valueAt(after, path);
    const versionPath = isPackageVersionPath(path) || kind === "marketplace.json" && isMarketplaceVersionPath(path, before, after);
    if (versionPath) {
      if (!isVersion(from) || !isVersion(to)) return false;
      if (isPackageVersionPath(path)) versionChanged = true;
      continue;
    }
    if (isAdlcRangePath(path)) {
      const rFrom = splitRange(from);
      const rTo = splitRange(to);
      if (!rFrom || !rTo) return false;
      if (rFrom.operator !== rTo.operator) return false;
      repins.push({ from: rFrom, to: rTo });
      continue;
    }
    return false;
  }
  if (versionChanged) {
    const oldVersion = before.version;
    const newVersion = after.version;
    if (!isVersion(oldVersion) || !isVersion(newVersion)) return false;
    for (const [root2, expected] of [[before, oldVersion], [after, newVersion]]) {
      for (const field of DEP_FIELDS) {
        const deps = root2[field];
        if (deps === void 0) continue;
        if (deps === null || typeof deps !== "object" || Array.isArray(deps)) return false;
        for (const [name, range] of Object.entries(deps)) {
          if (!ADLC_PKG.test(name)) continue;
          const split = splitRange(range);
          if (!split || split.version !== expected) return false;
        }
      }
    }
  }
  if (repins.length > 0) {
    const oldVersion = before.version;
    const newVersion = after.version;
    if (!isVersion(oldVersion) || !isVersion(newVersion)) return false;
    if (!versionChanged || oldVersion === newVersion) return false;
    for (const { from, to } of repins) {
      if (from.version !== oldVersion || to.version !== newVersion) return false;
    }
  }
  return true;
}
var MANIFEST_BASENAMES2, DEP_FIELDS, MAX_LENGTH, MAX_SAFE_COMPONENT_LENGTH, NUM, PRE_ID, PRE, BUILD, SEMVER, VERSION_RE, RANGE_RE, ADLC_PKG, MAX_BUFFER;
var init_version_only = __esm({
  "node_modules/@adlc/rails-guard/lib/version-only.mjs"() {
    MANIFEST_BASENAMES2 = /* @__PURE__ */ new Set(["package.json", "plugin.json", "marketplace.json"]);
    DEP_FIELDS = /* @__PURE__ */ new Set([
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies"
    ]);
    MAX_LENGTH = 256;
    MAX_SAFE_COMPONENT_LENGTH = 16;
    NUM = "0|[1-9]\\d*";
    PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
    PRE = `(?:-${PRE_ID}(?:\\.${PRE_ID})*)`;
    BUILD = "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)";
    SEMVER = `(?:${NUM})\\.(?:${NUM})\\.(?:${NUM})${PRE}?${BUILD}?`;
    VERSION_RE = new RegExp(`^${SEMVER}$`);
    RANGE_RE = new RegExp(`^([\\^~]?)(${SEMVER})$`);
    ADLC_PKG = /^@adlc\/[a-z0-9][a-z0-9._-]*$/;
    MAX_BUFFER = 512 * 1024 * 1024;
  }
});

// node_modules/@adlc/rails-guard/lib/rails.mjs
function resolveRailGlobs(cliRails2, ticket2) {
  if (cliRails2 && cliRails2.length > 0) {
    return { globs: cliRails2, error: null };
  }
  if (!ticket2) {
    return { globs: [], error: "no --rails supplied and no ticket loaded \u2014 cannot determine rail globs" };
  }
  const globs = ticket2.rails ?? [];
  if (globs.length === 0) {
    return { globs: [], error: `ticket ${ticket2.id} has no rails declared` };
  }
  return { globs, error: null };
}
function checkRailEdits(changedFiles2, railGlobs2, resolveContents2 = null, sanctionedAdditions2 = null) {
  const violations2 = [];
  const sanctioned = [];
  for (const file of changedFiles2) {
    const matched = railGlobs2.filter((g) => globMatch2(g, file));
    if (matched.length === 0) continue;
    if (sanctionedAdditions2?.has(file)) {
      sanctioned.push({ file, globs: matched });
      continue;
    }
    if (resolveContents2 && isManifestFile(file) && isVersionOnlyEdit(file, resolveContents2)) {
      continue;
    }
    violations2.push({ file, type: "rail-edit", globs: matched });
  }
  return { violations: violations2, sanctioned };
}
function isVersionOnlyEdit(file, resolveContents2) {
  try {
    const contents = resolveContents2(file);
    if (!contents) return false;
    return isVersionOnlyChange(contents.before, contents.after, file);
  } catch {
    return false;
  }
}
var init_rails = __esm({
  "node_modules/@adlc/rails-guard/lib/rails.mjs"() {
    init_tickets2();
    init_version_only();
  }
});

// node_modules/@adlc/rails-guard/lib/suppressions.mjs
function parseAddedLines(diffText) {
  const lines2 = diffText.split("\n");
  const results2 = [];
  let currentFile = null;
  let newLineNo;
  let inHunk;
  let oldRemaining;
  let newRemaining;
  for (const raw2 of lines2) {
    if (raw2.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (inHunk && oldRemaining === 0 && newRemaining === 0) inHunk = false;
    if (!inHunk && raw2.startsWith("+++ ")) {
      const fileMatch = raw2.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentFile = fileMatch ? fileMatch[1] : null;
      newLineNo = 0;
      continue;
    }
    if (raw2.startsWith("@@")) {
      const m = raw2.match(/@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldRemaining = m[1] !== void 0 ? parseInt(m[1], 10) : 1;
        newLineNo = parseInt(m[2], 10) - 1;
        newRemaining = m[3] !== void 0 ? parseInt(m[3], 10) : 1;
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw2.startsWith(" ")) {
      newLineNo++;
      oldRemaining--;
      newRemaining--;
      continue;
    }
    if (raw2.startsWith("-")) {
      oldRemaining--;
      continue;
    }
    if (raw2.startsWith("+")) {
      newLineNo++;
      newRemaining--;
      if (currentFile !== null) {
        results2.push({ file: currentFile, lineNo: newLineNo, content: raw2.slice(1) });
      }
      continue;
    }
  }
  return results2;
}
function isDocFile(file) {
  if (typeof file !== "string" || file === "") return false;
  const base3 = file.slice(file.lastIndexOf("/") + 1);
  const dot = base3.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOC_EXTENSIONS.includes(base3.slice(dot).toLowerCase());
}
function isMdxFile(file) {
  if (typeof file !== "string" || file === "") return false;
  const base3 = file.slice(file.lastIndexOf("/") + 1);
  const dot = base3.lastIndexOf(".");
  if (dot <= 0) return false;
  return base3.slice(dot).toLowerCase() === ".mdx";
}
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (span) => span.includes("${") ? span : "");
}
function findSuppressions(addedLines, { isFenced: isFenced2 = () => false } = {}) {
  const found = [];
  for (const { file, lineNo, content } of addedLines) {
    if (isDocFile(file)) continue;
    let scanText = content;
    if (isMdxFile(file)) {
      if (isFenced2(file, lineNo)) continue;
      scanText = stripInlineCode(content);
    }
    for (const marker of SUPPRESSION_MARKERS) {
      if (scanText.includes(marker)) {
        found.push({ file, lineNo, marker, content });
        break;
      }
    }
  }
  return found;
}
function isMarkerAllowed(marker, ticketBody) {
  if (!ticketBody) return false;
  const needle = `allow-suppression: ${marker}`;
  return ticketBody.includes(needle);
}
var SUPPRESSION_MARKERS, DOC_EXTENSIONS;
var init_suppressions = __esm({
  "node_modules/@adlc/rails-guard/lib/suppressions.mjs"() {
    init_core();
    SUPPRESSION_MARKERS = [
      ".skip(",
      ".only(",
      "xfail",
      "@ts-ignore",
      "@ts-expect-error",
      "eslint-disable",
      "# noqa",
      "#[ignore]"
    ];
    DOC_EXTENSIONS = [".md", ".markdown"];
  }
});

// node_modules/@adlc/rails-guard/lib/check.mjs
function runChecks({ changedFiles: changedFiles2, diffText, cliRails: cliRails2, ticket: ticket2, isFenced: isFenced2, resolveContents: resolveContents2, sanctionedAdditions: sanctionedAdditions2 }) {
  const { globs: railGlobs2, error: railGlobError2 } = resolveRailGlobs(cliRails2, ticket2);
  const violations2 = [];
  let sanctionedAdditionsOut = [];
  if (railGlobs2.length > 0) {
    const railEdits = checkRailEdits(changedFiles2, railGlobs2, resolveContents2, sanctionedAdditions2 ?? null);
    violations2.push(...railEdits.violations);
    sanctionedAdditionsOut = [...new Set(railEdits.sanctioned.map((s) => s.file))].sort();
  }
  const railsDiffEmpty2 = violations2.filter((v) => v.type === "rail-edit").length === 0;
  const addedLines = parseAddedLines(diffText);
  const suppressions = findSuppressions(addedLines, { isFenced: isFenced2 });
  const ticketBody = ticket2?.body ?? "";
  for (const s of suppressions) {
    if (!isMarkerAllowed(s.marker, ticketBody)) {
      violations2.push({
        file: s.file,
        type: "suppression",
        marker: s.marker,
        lineNo: s.lineNo,
        line: s.content
      });
    }
  }
  const suppressionsClean2 = violations2.filter((v) => v.type === "suppression").length === 0;
  return {
    railGlobs: railGlobs2,
    railGlobError: railGlobError2,
    violations: violations2,
    railsDiffEmpty: railsDiffEmpty2,
    suppressionsClean: suppressionsClean2,
    sanctionedAdditions: sanctionedAdditionsOut
  };
}
var init_check = __esm({
  "node_modules/@adlc/rails-guard/lib/check.mjs"() {
    init_rails();
    init_suppressions();
  }
});

// node_modules/@adlc/rails-guard/lib/output.mjs
function formatViolations(violations2) {
  if (violations2.length === 0) return "rails-guard: all checks passed";
  const lines2 = [`rails-guard: ${violations2.length} violation(s) found`];
  for (const v of violations2) {
    if (v.type === "rail-edit") {
      lines2.push(`  [rail-edit]   ${v.file}  (matched globs: ${v.globs.join(", ")})`);
    } else if (v.type === "suppression") {
      lines2.push(`  [suppression] ${v.file}:${v.lineNo}  marker: ${v.marker}`);
      if (v.line) lines2.push(`                  ${v.line.trim()}`);
    }
  }
  return lines2.join("\n");
}
function buildResult({ violations: violations2, railGlobs: railGlobs2, railGlobError: railGlobError2, railsDiffEmpty: railsDiffEmpty2, suppressionsClean: suppressionsClean2, sanctionedAdditions: sanctionedAdditions2 = [], base: base3, ticket: ticket2 }) {
  return {
    tool: "rails-guard",
    base: base3 ?? "HEAD",
    ticket: ticket2?.id ?? null,
    railGlobs: railGlobs2,
    railGlobError: railGlobError2 ?? null,
    railsDiffEmpty: railsDiffEmpty2,
    suppressionsClean: suppressionsClean2,
    sanctionedAdditions: sanctionedAdditions2,
    passed: violations2.length === 0,
    violations: violations2
  };
}
var init_output = __esm({
  "node_modules/@adlc/rails-guard/lib/output.mjs"() {
  }
});

// node_modules/@adlc/rails-guard/bin/rails-guard.mjs
var rails_guard_exports = {};
import { readFileSync as readFileSync16, lstatSync as lstatSync10 } from "node:fs";
function isFenced(file, lineNo) {
  if (!isMdxFile(file)) return false;
  let fenced = fenceCache.get(file);
  if (fenced === void 0) {
    try {
      fenced = computeFencedLines(readFileSync16(file, "utf8"));
    } catch {
      fenced = /* @__PURE__ */ new Set();
    }
    fenceCache.set(file, fenced);
  }
  return fenced.has(lineNo);
}
function resolveContents(file) {
  if (contentCache.has(file)) return contentCache.get(file);
  let contents = null;
  try {
    if (Buffer.from(file, "utf8").toString("utf8") !== file) {
      throw new Error(`filename is not round-trip UTF-8: ${file}`);
    }
    if (!lstatSync10(file).isFile()) throw new Error("not a regular file");
    const attrs = git(
      ["check-attr", "filter", "ident", "working-tree-encoding", "--", file],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    for (const line of attrs.split("\n")) {
      if (!line.trim()) continue;
      const value = line.slice(line.lastIndexOf(": ") + 2).trim();
      if (value !== "unspecified" && value !== "unset") throw new Error(`content filter on ${file}`);
    }
    const baseMode = git(["--literal-pathspecs", "ls-tree", base, "--", file], { stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/)[0];
    if (baseMode !== "100644" && baseMode !== "100755") throw new Error("base is not a regular file");
    const headExecutable = (lstatSync10(file).mode & 73) !== 0;
    if (baseMode === "100755" !== headExecutable) throw new Error("file mode changed");
    const decode = (buf) => {
      const text = buf.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(buf)) throw new Error("not valid UTF-8");
      return text;
    };
    const before = decode(git(["show", `${base}:${file}`], { stdio: ["ignore", "pipe", "ignore"], encoding: "buffer" }));
    const after = decode(readFileSync16(file));
    contents = { before, after };
  } catch {
    contents = null;
  }
  contentCache.set(file, contents);
  return contents;
}
var values, ticket, cliRails, base, diff, files, fenceCache, contentCache, railGlobs, railGlobError, violations, railsDiffEmpty, suppressionsClean, sanctionedAdditions, result;
var init_rails_guard = __esm({
  "node_modules/@adlc/rails-guard/bin/rails-guard.mjs"() {
    init_core();
    init_gate_manifest();
    init_check();
    init_output();
    init_suppressions();
    init_sign();
    ({ values } = parseArgs({
      options: {
        base: { type: "string" },
        ticket: { type: "string" },
        tickets: { type: "string" },
        rails: { type: "string", multiple: true },
        "sanctioned-add": { type: "string", multiple: true },
        record: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false }
      }
    }));
    if (values.help) {
      console.log(`rails-guard [--base <ref>] [--ticket <id>] [--tickets <path>] [--rails <glob>...] [--record] [--json]

Rail-freeze enforcement + suppression-marker gate (ADLC C5).

  --base <ref>       Git ref to diff against. When omitted, the freeze baseline is
                     resolved to the merge-base of HEAD with trunk (main/master/
                     origin/main/origin/master). If no trunk ref is found, the
                     gate fails closed \u2014 pass --base explicitly. NEVER defaults to
                     HEAD, which would hide already-committed rail edits.
  --ticket <id>      Ticket ID to load rails and allow-suppression declarations from
  --tickets <path>   Path to tickets.json (default: .adlc/tickets.json)
  --rails <glob>     One or more glob patterns declaring frozen rail paths
                     (repeatable; overrides ticket.rails)
  --sanctioned-add <path>
                     Exact file path whose rail match is a sanctioned AUTHORING
                     addition (repeatable). Plumbing for the CI wrapper, which
                     alone computes the policy (pure addition at the trusted
                     base, ticket-rail-only match, never a trust root) \u2014 see
                     lib/ci/rail-freeze.mjs. Do not pass by hand.
  --record           On a clean pass, append a manifest entry to .adlc/manifest.jsonl
  --json             Machine-readable JSON output
  --help             Show this help

Exit codes:
  0  Gate passes (no violations)
  1  Operational error (not a git repo, bad input, no rails resolvable)
  2  Gate fails (violations found)
`);
      process.exit(0);
    }
    if (!isGitRepo()) {
      opError("not inside a git repository");
    }
    ticket = null;
    if (values.ticket) {
      const ticketsPath2 = values.tickets ?? `${ADLC_DIR}/tickets.json`;
      const { tickets: tickets2, errors } = loadTickets(ticketsPath2);
      if (errors.length > 0 && tickets2.length === 0) {
        opError(`could not load tickets from ${ticketsPath2}: ${errors[0]}`);
      }
      ticket = tickets2.find((t) => t.id === values.ticket) ?? null;
      if (!ticket) {
        opError(`ticket "${values.ticket}" not found in ${ticketsPath2}`);
      }
    }
    cliRails = values.rails ?? [];
    if (cliRails.length === 0 && !ticket) {
      opError("no --rails supplied and no --ticket given \u2014 cannot determine rail globs");
    }
    if (cliRails.length === 0 && ticket && (ticket.rails ?? []).length === 0) {
      opError(`ticket ${ticket.id} has no rails declared and no --rails flag supplied`);
    }
    base = values.base;
    if (base === void 0) {
      base = resolveBase();
      if (base === null) {
        opError(
          "could not resolve a freeze baseline: no trunk ref (main/master/origin/main/origin/master) found. Pass --base <ref> explicitly. Refusing to default to HEAD, which would hide already-committed rail edits."
        );
      }
    }
    try {
      diff = gitDiff(base);
      files = changedFiles(base);
    } catch (err) {
      opError(`git error: ${err.message}`);
    }
    fenceCache = /* @__PURE__ */ new Map();
    contentCache = /* @__PURE__ */ new Map();
    ({ railGlobs, railGlobError, violations, railsDiffEmpty, suppressionsClean, sanctionedAdditions } = runChecks({
      changedFiles: files,
      diffText: diff,
      cliRails,
      ticket,
      isFenced,
      resolveContents,
      sanctionedAdditions: new Set(values["sanctioned-add"] ?? [])
    }));
    result = buildResult({
      violations,
      railGlobs,
      railGlobError,
      railsDiffEmpty,
      suppressionsClean,
      sanctionedAdditions,
      base,
      ticket
    });
    if (values.json) {
      printJson(result);
    } else {
      if (violations.length === 0) {
        console.log("rails-guard: all checks passed");
        console.error("note: CI also runs scripts/rails-guard-ci.mjs, which is stricter (it rejects changes to existing tickets in .adlc/tickets.json). Run `npm run preflight` for the full set.");
        if (sanctionedAdditions.length > 0) {
          console.error(`note: --sanctioned-add exempted ${sanctionedAdditions.length} rail path(s) from this check: ` + sanctionedAdditions.join(", "));
        }
      } else {
        console.error(formatViolations(violations));
      }
    }
    if (values.record && violations.length === 0) {
      let railFiles = {};
      if (railGlobs.length > 0) {
        try {
          const allFiles = git(["ls-files"]).split("\n").filter(Boolean);
          const matched = allFiles.filter((f) => railGlobs.some((g) => globMatch2(g, f)));
          railFiles = hashFiles(matched);
        } catch {
        }
      }
      appendManifestEntry({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        type: "rails-check",
        ticket: ticket?.id ?? null,
        base,
        railsDiffEmpty: true,
        suppressionsClean: true,
        sanctionedAdditions,
        railFiles
      }, void 0, { key: getKey() });
    }
    process.exit(violations.length > 0 ? 2 : 0);
  }
});

// node_modules/@adlc/gate-manifest/lib/show.mjs
function loadFiltered({ ticket: ticket2, dir = ADLC_DIR } = {}) {
  const { entries, skipped } = readManifestForest(dir);
  const filtered = ticket2 ? entries.filter((e) => e.ticket === ticket2) : entries;
  return { entries: filtered, skipped };
}
function renderEntry(entry) {
  const lines2 = [];
  lines2.push(`seq=${entry.seq}  gate=${entry.gate}  ts=${entry.ts}`);
  if (entry.segment && entry.segment !== "root") lines2.push(`  segment: ${entry.segment}`);
  if (entry.ticket) lines2.push(`  ticket: ${entry.ticket}`);
  if (entry.data && Object.keys(entry.data).length > 0) {
    lines2.push(`  data: ${JSON.stringify(entry.data)}`);
  }
  const fileCount = entry.files ? Object.keys(entry.files).length : 0;
  if (fileCount > 0) {
    lines2.push(`  files (${fileCount}):`);
    for (const [path, hash] of Object.entries(entry.files)) {
      lines2.push(`    ${path}: ${hash ?? "null"}`);
    }
  }
  lines2.push(`  prev: ${entry.prev ?? "null"}`);
  return lines2;
}
function renderEntries(entries) {
  if (entries.length === 0) return ["(no entries)"];
  const out = [];
  for (const e of entries) {
    out.push(...renderEntry(e));
    out.push("");
  }
  return out;
}
var init_show = __esm({
  "node_modules/@adlc/gate-manifest/lib/show.mjs"() {
    init_core();
    init_forest();
  }
});

// node_modules/@adlc/gate-manifest/lib/attest.mjs
function dataSummary(data) {
  if (!data || typeof data !== "object") return "\u2014";
  const keys = Object.keys(data);
  if (keys.length === 0) return "\u2014";
  return keys.slice(0, 2).map((k) => {
    const v = String(data[k]);
    return `${k}=${v.length > 20 ? v.slice(0, 17) + "..." : v}`;
  }).join(", ");
}
function buildAttest({ ticket: ticket2, dir = ADLC_DIR, key = null } = {}) {
  const { entries } = loadFiltered({ ticket: ticket2, dir });
  const chainResult = verify(dir, { key });
  const heading = ticket2 ? `## Gate evidence for ${ticket2}` : "## Gate evidence";
  const lines2 = [heading, ""];
  if (entries.length === 0) {
    lines2.push("_No entries found._", "");
  } else {
    lines2.push("| seq | gate | ts | files | data |");
    lines2.push("|-----|------|-----|-------|------|");
    for (const e of entries) {
      const fileCount = e.files ? Object.keys(e.files).length : 0;
      const ds = dataSummary(e.data);
      lines2.push(`| ${e.seq} | ${e.gate} | ${e.ts} | ${fileCount} | ${ds} |`);
    }
    lines2.push("");
  }
  const chainStatus = chainResult.valid ? `Chain status: **valid** (${chainResult.count} entries)` : `Chain status: **BROKEN** \u2014 ${chainResult.message}`;
  lines2.push(chainStatus);
  return lines2.join("\n");
}
var init_attest = __esm({
  "node_modules/@adlc/gate-manifest/lib/attest.mjs"() {
    init_verify();
    init_show();
    init_core();
  }
});

// node_modules/@adlc/gate-manifest/lib/repair.mjs
import {
  closeSync as closeSync8,
  existsSync as existsSync19,
  fsyncSync as fsyncSync5,
  mkdirSync as mkdirSync8,
  openSync as openSync8,
  readFileSync as readFileSync17,
  renameSync as renameSync2,
  unlinkSync as unlinkSync5,
  writeFileSync as writeFileSync9
} from "node:fs";
import { randomUUID as randomUUID5 } from "node:crypto";
import { dirname as dirname15 } from "node:path";
function payloadFrom(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !RESERVED.has(key)));
}
function chainPayloads(payloads, key) {
  let previousRaw = null;
  return payloads.map((payload, index) => {
    const normalized = {
      ...payload,
      gate: payload.gate ?? payload.type ?? "evidence",
      ts: payload.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
      files: payload.files ?? {}
    };
    const entry = {
      seq: index + 1,
      ...normalized,
      prev: previousRaw === null ? null : sha256(previousRaw)
    };
    if (key) {
      entry.sigVersion = 2;
      entry.sig = signEntry(key, entry);
    }
    previousRaw = JSON.stringify(entry);
    return entry;
  });
}
function durableWrite2(path, content) {
  const descriptor = openSync8(path, "wx");
  try {
    writeFileSync9(descriptor, content);
    fsyncSync5(descriptor);
  } finally {
    closeSync8(descriptor);
  }
}
function repairChain({
  dir = ADLC_DIR,
  reason,
  write = false,
  attestUnsigned = false,
  key: keyParam
} = {}) {
  const providedKey = validateKeyParam(keyParam);
  if (typeof reason !== "string" || reason.trim().length < 8) {
    throw new Error("repair reason must be at least 8 characters");
  }
  const path = ledgerPath("manifest", dir);
  if (!existsSync19(path)) throw new Error(`manifest does not exist: ${path}`);
  const original = readFileSync17(path, "utf8");
  const sourceLines = original.split("\n").map((line, index) => ({ line, lineNo: index + 1 })).filter(({ line }) => line.trim() !== "");
  const entries = sourceLines.map(({ line, lineNo }) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`manifest line ${lineNo} is malformed: ${err.message}`);
    }
  });
  const integrity = verify(dir, { key: providedKey });
  if (integrity.valid) throw new Error("manifest chain is already valid; repair refused");
  const invalidEntryIndex = entries.findIndex(
    (entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
  );
  if (invalidEntryIndex !== -1) {
    throw new Error(`manifest line ${sourceLines[invalidEntryIndex].lineNo} must contain an entry object`);
  }
  const key = providedKey;
  const unsignedLines = sourceLines.filter((_, index) => typeof entries[index]?.sig !== "string").map(({ lineNo }) => lineNo);
  if (attestUnsigned && !key) {
    throw new Error("--attest-unsigned requires ADLC_MANIFEST_KEY");
  }
  if (!key && entries.some((entry) => typeof entry.sig === "string")) {
    throw new Error("manifest contains signed entries; configure ADLC_MANIFEST_KEY before repair");
  }
  if (key) {
    const invalidSignedIndex = entries.findIndex(
      (entry) => typeof entry.sig === "string" && !verifyEntrySig(key, entry)
    );
    if (invalidSignedIndex !== -1) {
      throw new Error(
        `manifest signature at line ${invalidSignedIndex + 1} does not match ADLC_MANIFEST_KEY; repair refused`
      );
    }
    if (unsignedLines.length > 0 && !attestUnsigned) {
      throw new Error(
        `manifest contains ${unsignedLines.length} unsigned entr${unsignedLines.length === 1 ? "y" : "ies"}; repair would cryptographically attest them; rerun with --attest-unsigned after reviewing the backup`
      );
    }
  }
  const originalHash = sha256(original);
  const backup = `${path}.pre-repair-${originalHash.slice(0, 16)}.bak`;
  const repair = {
    type: "manifest-chain-repair",
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    reason: reason.trim(),
    originalHash,
    originalEntries: entries.length,
    backup,
    newlySignedEntries: key ? unsignedLines.length : 0,
    newlySignedLines: key ? unsignedLines : []
  };
  const repaired = chainPayloads([...entries.map(payloadFrom), repair], key);
  const output = `${repaired.map((entry) => JSON.stringify(entry)).join("\n")}
`;
  const result6 = {
    ok: true,
    write,
    path,
    backup,
    originalHash,
    originalEntries: entries.length,
    repairedEntries: repaired.length,
    newlySignedEntries: repair.newlySignedEntries,
    newlySignedLines: repair.newlySignedLines
  };
  if (!write) return result6;
  mkdirSync8(dirname15(path), { recursive: true });
  return withLedgerLock(path, () => {
    const current = readFileSync17(path, "utf8");
    if (sha256(current) !== originalHash) {
      throw new Error("manifest changed after repair planning; retry from fresh state");
    }
    if (existsSync19(backup)) {
      if (readFileSync17(backup, "utf8") !== original) {
        throw new Error(`repair backup exists with different content: ${backup}`);
      }
    } else {
      durableWrite2(backup, original);
    }
    const temporary = `${path}.repair-${process.pid}-${randomUUID5()}`;
    try {
      durableWrite2(temporary, output);
      renameSync2(temporary, path);
      if (process.platform !== "win32") {
        const directory = openSync8(dirname15(path), "r");
        try {
          fsyncSync5(directory);
        } finally {
          closeSync8(directory);
        }
      }
    } finally {
      try {
        unlinkSync5(temporary);
      } catch {
      }
    }
    return result6;
  });
}
var RESERVED;
var init_repair = __esm({
  "node_modules/@adlc/gate-manifest/lib/repair.mjs"() {
    init_core();
    init_sign();
    init_verify();
    init_key_contract();
    RESERVED = /* @__PURE__ */ new Set(["seq", "prev", "sig", "sigVersion"]);
  }
});

// node_modules/@adlc/gate-manifest/lib/enable.mjs
import { closeSync as closeSync9, constants as fsConstants4, existsSync as existsSync20, fstatSync as fstatSync2, fsyncSync as fsyncSync6, lstatSync as lstatSync11, mkdirSync as mkdirSync9, openSync as openSync9, readdirSync as readdirSync7, readSync as readSync4, writeFileSync as writeFileSync10, renameSync as renameSync3, rmdirSync, unlinkSync as unlinkSync6 } from "node:fs";
import { execFileSync as execFileSync6 } from "node:child_process";
import { randomBytes as randomBytes4 } from "node:crypto";
import { dirname as dirname16, join as join19, relative as relative6, sep as sep5 } from "node:path";
function gitProbeEnv() {
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}
function gitignoreContractViolation(dir) {
  const probeCwd = dirname16(dir);
  const env = gitProbeEnv();
  const run = (args) => {
    try {
      execFileSync6("git", args, { cwd: probeCwd, env, stdio: "ignore" });
      return 0;
    } catch (err) {
      if (err.code === "ENOENT") return "no-git";
      return err.status ?? "error";
    }
  };
  if (run(["rev-parse", "--is-inside-work-tree"]) !== 0) return null;
  const rel = relative6(probeCwd, segmentDirPath2(dir)).split(sep5).join("/");
  const probe = (path) => {
    const status = run(["check-ignore", "-q", "--", path]);
    if (status !== 0 && status !== 1) {
      throw new Error(`git check-ignore failed while probing ${path} \u2014 cannot verify the gitignore contract, refusing to guess`);
    }
    return status === 0;
  };
  for (const path of [`${rel}/`, `${rel}/.store.json`, `${rel}/enable-probe-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl`]) {
    if (probe(path)) return ".gitignore would ignore the activation marker or its evidence segments, so every other checkout would silently stay in single-file mode";
  }
  for (const path of [`${rel}/.lineage`, `${rel}/enable-probe.lock`]) {
    if (!probe(path)) return "git would TRACK the checkout-local lineage token or lock files, which must stay ignored \u2014 a committed token recreates the merge conflict forest mode removes";
  }
  return null;
}
function lstatIsSymlink(p) {
  try {
    return lstatSync11(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function isMarkerActivated(dir = ADLC_DIR) {
  for (const path of [dir, segmentDirPath2(dir)]) {
    if (lstatIsSymlink(path)) return false;
  }
  const parsed = readBoundedJsonNoFollow2(markerPath2(dir));
  return parsed?.format === MARKER.format && parsed?.version === MARKER.version;
}
function rootTailIsCutover(dir) {
  const root2 = ledgerPath("manifest", dir);
  let stats;
  try {
    stats = lstatSync11(root2);
  } catch {
    return "no";
  }
  if (!stats.isFile()) return "unknown";
  let fd;
  try {
    fd = openSync9(root2, fsConstants4.O_RDONLY | fsConstants4.O_NOFOLLOW);
  } catch {
    return "unknown";
  }
  try {
    const size = fstatSync2(fd).size;
    if (size === 0) return "no";
    const window = Math.min(size, TAIL_PROBE_BYTES);
    const buf = Buffer.alloc(window);
    const bytesRead = readSync4(fd, buf, 0, window, size - window);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    if (size > window && !text.includes("\n")) return "unknown";
    const lines2 = text.split("\n").filter((line) => line.trim());
    if (lines2.length === 0) {
      return size > window ? "unknown" : "no";
    }
    return JSON.parse(lines2.at(-1))?.gate === "manifest-cutover" ? "yes" : "no";
  } catch {
    return "unknown";
  } finally {
    closeSync9(fd);
  }
}
function boundedSegmentationState(dir = ADLC_DIR) {
  if (isMarkerActivated(dir)) return "segmented";
  switch (rootTailIsCutover(dir)) {
    case "yes":
      return "segmented";
    case "no":
      return "single-file";
    case "unknown":
      return "undetermined";
    // An unrecognized probe result must NOT fall through to 'single-file':
    // that is the one answer which asserts a fact and stays silent, so a
    // future edit returning something unexpected would silently suppress the
    // disclosure. Unrecognized means undetermined, like any other read this
    // function could not decide.
    default:
      return "undetermined";
  }
}
function planEnable(dir = ADLC_DIR) {
  if (!existsSync20(dir) && !lstatIsSymlink(dir)) {
    return {
      decision: "refuse-no-workspace",
      reason: `no ADLC workspace at ${dir} \u2014 run adlc-init first; enable never creates one as a side effect`
    };
  }
  if (lstatIsSymlink(dir) || !lstatSync11(dir).isDirectory()) {
    return {
      decision: "refuse-no-workspace",
      reason: `${dir} is not a real directory (symlink or other non-directory) \u2014 enable refuses to write through links`
    };
  }
  const rootPath = join19(dir, "manifest.jsonl");
  if (lstatIsSymlink(rootPath)) {
    return {
      decision: "refuse-broken-manifest-dir",
      reason: `${rootPath} is a symlink \u2014 refusing to inspect or activate through it`
    };
  }
  const segDir = segmentDirPath2(dir);
  if ((existsSync20(segDir) || lstatIsSymlink(segDir)) && (lstatIsSymlink(segDir) || !lstatSync11(segDir).isDirectory())) {
    return {
      decision: "refuse-broken-manifest-dir",
      reason: `${segDir} exists but is not a real directory (symlink or other non-directory) \u2014 refusing to write through it`
    };
  }
  if (isSegmentedRepo2(dir)) {
    const enabledViolation = gitignoreContractViolation(dir);
    if (enabledViolation !== null) {
      return {
        decision: "refuse-ignored",
        reason: `forest mode is already active, BUT ${enabledViolation}; restore this block (order matters): ${MARKER_NEGATION_LINES.join(" , ")}`,
        warnings: [CI_COVERAGE_WARNING]
      };
    }
    return {
      decision: "already-enabled",
      reason: "forest mode is already active for this repository",
      warnings: [CI_COVERAGE_WARNING]
    };
  }
  if (existsSync20(segDir) && readdirSync7(segDir).length > 0) {
    return {
      decision: "refuse-broken-manifest-dir",
      reason: `${segDir} has content but no valid activation marker \u2014 a broken or half-migrated state to repair by hand, not something enable can adopt`
    };
  }
  if (existsSync20(rootPath) && lstatSync11(rootPath).size > 0) {
    return {
      decision: "refuse-live-root",
      reason: "this repository already records evidence in a single-file root manifest; switching it to forest mode is the history-preserving cutover ceremony (T-MANIFEST-FOREST-MIGRATE), not greenfield enable"
    };
  }
  const violation = gitignoreContractViolation(dir);
  if (violation !== null) {
    return {
      decision: "refuse-ignored",
      reason: `${violation}; add this block (order matters): ${MARKER_NEGATION_LINES.join(" , ")}`
    };
  }
  return { decision: "greenfield", markerPath: markerPath2(dir), marker: { ...MARKER }, warnings: [CI_COVERAGE_WARNING] };
}
function markerWithAuth(auth) {
  if (!AUTH_MODES.includes(auth)) {
    throw new Error(`enable auth mode must be one of ${AUTH_MODES.join("/")}`);
  }
  return { ...MARKER, auth };
}
function enable(dir = ADLC_DIR, { write = false, auth = "keyed" } = {}) {
  const planned = planEnable(dir);
  const plan = planned.decision === "greenfield" ? { ...planned, marker: markerWithAuth(auth) } : planned;
  if (plan.decision !== "greenfield" || !write) return { ...plan, written: false };
  return withLedgerLock(join19(dir, "manifest.jsonl"), () => {
    const relocked = planEnable(dir);
    if (relocked.decision !== "greenfield") return { ...relocked, written: false };
    const locked = { ...relocked, marker: markerWithAuth(auth) };
    const segDir = segmentDirPath2(dir);
    const createdDir = !existsSync20(segDir);
    mkdirSync9(segDir, { recursive: true });
    const tmp = join19(segDir, `.store.json.tmp-${randomBytes4(6).toString("hex")}`);
    let published = false;
    try {
      const fd = openSync9(tmp, "wx");
      try {
        writeFileSync10(fd, JSON.stringify(locked.marker));
        fsyncSync6(fd);
      } finally {
        closeSync9(fd);
      }
      renameSync3(tmp, locked.markerPath);
      try {
        if (process.platform !== "win32") {
          for (const toSync of createdDir ? [segDir, dir] : [segDir]) {
            const dirFd = openSync9(toSync, "r");
            try {
              fsyncSync6(dirFd);
            } finally {
              closeSync9(dirFd);
            }
          }
        }
        published = true;
      } catch (fsyncErr) {
        let rolledBack = false;
        try {
          unlinkSync6(locked.markerPath);
          rolledBack = true;
        } catch {
        }
        if (rolledBack && process.platform !== "win32") {
          try {
            const dirFd = openSync9(segDir, "r");
            try {
              fsyncSync6(dirFd);
            } finally {
              closeSync9(dirFd);
            }
          } catch {
          }
        }
        throw new Error(rolledBack ? `marker written but not durably published (${fsyncErr.message}) \u2014 rolled the marker back; re-run enable` : `marker written but not durably published (${fsyncErr.message}) \u2014 AND rollback failed, so forest mode may be active on this checkout; inspect ${locked.markerPath} before retrying`);
      }
    } finally {
      if (!published) {
        try {
          unlinkSync6(tmp);
        } catch {
        }
        if (createdDir) {
          try {
            rmdirSync(segDir);
          } catch {
          }
        }
      }
    }
    if (!isSegmentedRepo2(dir)) {
      let rolledBack = false;
      try {
        unlinkSync6(locked.markerPath);
        rolledBack = true;
      } catch {
      }
      if (rolledBack && createdDir) {
        try {
          rmdirSync(segDir);
        } catch {
        }
      }
      throw new Error(rolledBack ? "wrote an activation marker the mode resolver does not recognize \u2014 rolled back; enable.mjs and lineage.mjs disagree on the marker format" : `wrote an activation marker the mode resolver does not recognize \u2014 AND rollback failed, so an unrecognized marker remains at ${locked.markerPath}; remove it by hand`);
    }
    return { ...locked, written: true };
  });
}
var MARKER, AUTH_MODES, CI_COVERAGE_WARNING, SEGMENTATION_UNDETERMINED_WARNING, MARKER_NEGATION_LINES, TAIL_PROBE_BYTES;
var init_enable = __esm({
  "node_modules/@adlc/gate-manifest/lib/enable.mjs"() {
    init_core();
    init_lineage();
    init_forest();
    MARKER = Object.freeze({ format: "adlc-manifest-segments", version: 1 });
    AUTH_MODES = Object.freeze(["keyed", "keyless"]);
    CI_COVERAGE_WARNING = Object.freeze({
      code: "ci-cannot-guard-segments",
      message: "rails-guard does not yet validate .adlc/manifest.d/ segment files, so rewriting or deleting committed segment evidence in a pull request is not currently detected by CI. The root manifest remains guarded. This closes when the forest CI gate ships."
    });
    SEGMENTATION_UNDETERMINED_WARNING = Object.freeze({
      code: "segmentation-undetermined",
      message: "could not determine within a bounded read whether this repository uses segmented (forest) evidence storage, because the root manifest's final entry could not be read within the probe window. If it IS segmented, note that rails-guard does not yet validate .adlc/manifest.d/ segment files. Run this command with a signing key configured for a definite answer."
    });
    MARKER_NEGATION_LINES = Object.freeze([
      "!.adlc/manifest.d/",
      "!.adlc/manifest.d/**",
      ".adlc/manifest.d/.lineage",
      ".adlc/manifest.d/*.lock",
      ".adlc/manifest.d/*.tmp-*"
    ]);
    TAIL_PROBE_BYTES = 65536;
  }
});

// node_modules/@adlc/gate-manifest/lib/adopt.mjs
import { existsSync as existsSync21 } from "node:fs";
function readSegment(dir, name) {
  const lines2 = readRawLines2(segmentPath2(dir, name));
  try {
    const first = JSON.parse(lines2[0].line);
    const last = JSON.parse(lines2.at(-1).line);
    if (!first || typeof first !== "object" || Array.isArray(first)) return null;
    return { lines: lines2, first, last: last && typeof last === "object" ? last : {} };
  } catch {
    return null;
  }
}
function authenticate({ lines: lines2, first }, key, allowChainOnly) {
  const chain = verifyChain(lines2, { key, requireSignatures: false, anchorOnFirst: true });
  if (!chain.valid) return false;
  if (key === null) return allowChainOnly;
  return first.sigVersion === 2 && verifyEntrySig(key, first);
}
function describeCandidate(name, parsed, key, allowChainOnly) {
  return {
    name,
    entries: parsed.lines.length,
    firstTs: parsed.first.ts ?? null,
    lastTs: parsed.last.ts ?? null,
    authenticated: authenticate(parsed, key, allowChainOnly)
  };
}
function planAdopt(dir = ADLC_DIR, { cwd: cwd2 = process.cwd(), key = null, segment = null } = {}) {
  if (!isSegmentedRepo2(dir)) {
    return { decision: "refuse-not-segmented", reason: "this repository is not in forest mode \u2014 there is no lineage to adopt" };
  }
  const branch = currentBranch2(cwd2);
  if (branch === null) {
    return { decision: "refuse-detached-head", reason: "detached HEAD has no branch identity to bind a lineage token to \u2014 check out the branch first" };
  }
  const declaredAuth = readBoundedJsonNoFollow2(markerPath2(dir))?.auth ?? null;
  if (declaredAuth === "keyed" && key === null) {
    return { decision: "refuse-keyed-forest", reason: "this forest was activated in keyed mode, but no signing key is available to authenticate the segment being adopted; configure the manifest key", branch };
  }
  const allowChainOnly = declaredAuth === "keyless";
  if (!allowChainOnly && key === null) {
    return { decision: "refuse-undetermined-auth", reason: "this forest does not declare an authentication mode (no activation marker), so an unsigned segment cannot be told apart from a legitimately keyless one \u2014 supply the manifest key to adopt here", branch };
  }
  const { valid, invalid: invalid3 } = discoverSegments2(dir);
  if (invalid3.length > 0) {
    return {
      decision: "refuse-nonconforming-store",
      reason: `manifest.d/ contains ${invalid3.length} non-conforming filesystem object(s) (${invalid3.map((i) => i.name).sort().join(", ")}) \u2014 one could be a disguised or tampered segment belonging to this branch, so adopting a lineage now would hide it from every later write and read on this checkout; repair the store first`,
      branch
    };
  }
  const parsedByName = /* @__PURE__ */ new Map();
  const unreadable = [];
  for (const name of valid) {
    const parsed = readSegment(dir, name);
    if (parsed) parsedByName.set(name, parsed);
    else unreadable.push(name);
  }
  if (unreadable.length > 0) {
    return {
      decision: "refuse-unreadable-segment",
      reason: `segment(s) ${unreadable.sort().join(", ")} have an unreadable or malformed first entry, so their branch cannot be determined \u2014 they can be neither listed as candidates nor safely excluded from the choice; repair them first`,
      branch
    };
  }
  const mine = valid.filter((name) => parsedByName.get(name)?.first?.branch === branch);
  if (segment === null) {
    return { decision: "list", branch, candidates: mine.map((name) => describeCandidate(name, parsedByName.get(name), key, allowChainOnly)) };
  }
  if (!valid.includes(segment) || !existsSync21(segmentPath2(dir, segment))) {
    return { decision: "refuse-unknown-segment", reason: `no segment named ${segment} exists in this store`, branch, candidates: mine.map((name) => describeCandidate(name, parsedByName.get(name), key, allowChainOnly)) };
  }
  if (!mine.includes(segment)) {
    const declared = parsedByName.get(segment)?.first?.branch ?? null;
    return { decision: "refuse-wrong-branch", reason: `segment ${segment} declares branch ${JSON.stringify(declared)}, not ${JSON.stringify(branch)} \u2014 adopting it would bind this checkout to a different lineage`, branch };
  }
  if (!authenticate(parsedByName.get(segment), key, allowChainOnly)) {
    return { decision: "refuse-unauthenticated", reason: `segment ${segment} cannot be authenticated with the available key (broken chain, or its branch-bearing first entry lacks a verified v2 signature) \u2014 a token makes downstream readers trust it without re-verifying, so adopt refuses`, branch };
  }
  const ulid = ulidOf2(segment);
  if (!ulid) {
    return { decision: "refuse-unknown-segment", reason: `segment ${segment} has no readable lineage ULID in its name`, branch };
  }
  return { decision: "adopted", branch, segment, token: { segment, ulid, branch } };
}
function adopt(dir = ADLC_DIR, { cwd: cwd2 = process.cwd(), key = null, segment = null, write = false } = {}) {
  const plan = planAdopt(dir, { cwd: cwd2, key, segment });
  if (plan.decision !== "adopted" || !write) return { ...plan, written: false };
  writeLineageToken2(dir, plan.token);
  const peeked = peekOpenSegment2(dir, { cwd: cwd2 });
  if (peeked?.name !== plan.segment) {
    throw new Error(`wrote a lineage token for ${plan.segment} that does not resolve (${peeked ? `resolves to ${peeked.name}` : "resolves to nothing"}) \u2014 the token at ${lineagePath2(dir)} is inert; remove it and re-run`);
  }
  return { ...plan, written: true };
}
var init_adopt = __esm({
  "node_modules/@adlc/gate-manifest/lib/adopt.mjs"() {
    init_core();
    init_lineage();
    init_forest();
    init_verify();
    init_sign();
  }
});

// node_modules/@adlc/gate-manifest/lib/migrate.mjs
import { closeSync as closeSync10, existsSync as existsSync22, fsyncSync as fsyncSync7, lstatSync as lstatSync12, mkdirSync as mkdirSync10, openSync as openSync10, readFileSync as readFileSync18, renameSync as renameSync4, rmSync as rmSync3, writeFileSync as writeFileSync11, writeSync } from "node:fs";
import { createHash as createHash4, randomBytes as randomBytes5 } from "node:crypto";
import { join as join20 } from "node:path";
function rawLines(text) {
  const out = [];
  String(text).split("\n").forEach((line, i) => {
    if (line.trim()) out.push({ line, lineNo: i + 1 });
  });
  return out;
}
function standingApproves(text) {
  const approves = /* @__PURE__ */ new Map();
  const revoked = /* @__PURE__ */ new Set();
  for (const { line } of rawLines(text)) {
    const entry = parse(line);
    if (entry === null || (entry.gate ?? entry.type) !== "cross-model-review") continue;
    const { provider, revision, verdict } = entry.data ?? {};
    if (typeof provider !== "string" || typeof revision !== "string") continue;
    const key = tupleKey(entry.data, entry.ticket);
    if (verdict === "approve") {
      approves.set(key, {
        provider: entry.data.provider,
        authorProvider: entry.data.authorProvider,
        revision: entry.data.revision,
        ticket: entry.ticket ?? null
      });
    } else if (verdict === "needs-attention") {
      revoked.add(key);
    }
  }
  return [...approves.entries()].filter(([key]) => !revoked.has(key)).map(([, fields]) => fields);
}
function unsignedEntries(text) {
  const out = [];
  for (const { line, lineNo } of rawLines(text)) {
    const entry = parse(line);
    if (entry === null) continue;
    if (entry.sig === void 0 || entry.sig === null) out.push({ lineNo, seq: entry.seq ?? null });
  }
  return out;
}
function planMigrate(dir = ADLC_DIR, { key = null, reason = "", attestUnsigned = false } = {}) {
  if (key === null || key === void 0 || key === "") {
    return { decision: "refuse-keyless", reason: "the migration ceremony requires ADLC_MANIFEST_KEY \u2014 it signs seal and cutover entries and verifies existing signatures; no keyless form exists" };
  }
  const signingKey = validateKeyParam(key);
  if (typeof reason !== "string" || reason.length < 8) {
    return { decision: "refuse-reason", reason: "the cutover entry requires an operator reason of at least 8 characters (spec \xA74.5)" };
  }
  const lstatIsSymlink2 = (path) => {
    try {
      return lstatSync12(path).isSymbolicLink();
    } catch {
      return false;
    }
  };
  for (const path of [dir, ledgerPath("manifest", dir), segmentDirPath2(dir)]) {
    if (lstatIsSymlink2(path)) {
      return { decision: "refuse-symlink", reason: `${path} is a symlink \u2014 the ceremony refuses to read or write through repository-controlled links` };
    }
  }
  if (isSegmentedRepo2(dir)) {
    return { decision: "refuse-already-segmented", reason: "this repository is already segmented (activation marker or cutover-tailed root) \u2014 re-running the ceremony would append duplicate seals and a duplicate cutover to the frozen root" };
  }
  const chain = verify(dir, { key: signingKey, requireSignatures: false });
  if (!chain.valid) {
    return { decision: "refuse-invalid", reason: `the manifest does not verify (${chain.message}) \u2014 run repair-chain first; the ceremony refuses to freeze an invalid history` };
  }
  const rootPath = ledgerPath("manifest", dir);
  const bytes2 = existsSync22(rootPath) ? readFileSync18(rootPath) : Buffer.alloc(0);
  const text = bytes2.toString("utf8");
  const unsigned = unsignedEntries(text);
  if (unsigned.length > 0 && !attestUnsigned) {
    return { decision: "refuse-unsigned", reason: `${unsigned.length} unsigned entr${unsigned.length === 1 ? "y" : "ies"} (lines ${unsigned.map((u) => u.lineNo).join(", ")}) \u2014 re-run with --attest-unsigned to seal them under the ceremony key deliberately, with the count disclosed in the cutover record` };
  }
  const ignored = gitignoreContractViolation(dir);
  if (ignored !== null) {
    return { decision: "refuse-ignored", reason: ignored };
  }
  const seals = standingApproves(text);
  const lines2 = rawLines(text);
  return {
    decision: "plan",
    seals,
    unsignedEntries: unsigned,
    cutover: {
      reason,
      sealedApprovals: seals.length,
      // rootLines/rootSha256 bind to the state IMMEDIATELY BEFORE the cutover
      // entry — i.e. after the seals land — so the plan reports the line
      // count the cutover will carry, and the hash is computed at write time
      // over the actual bytes.
      rootLines: lines2.length + seals.length
    },
    backupPath: `${rootPath}.pre-cutover-${sha2563(bytes2).slice(0, 16)}.bak`,
    markerPath: markerPath2(dir),
    followUps: [
      "commit the migrated files in a DEDICATED pull request containing only this ceremony output",
      "pin the minimum toolkit version in CI workflows so a pre-forest toolkit cannot silently write the frozen root",
      "in-flight PRs must rebase and re-record revision-bound attestations; use `gate-manifest migrate-branch` to salvage a branch\u2019s root-tail evidence"
    ]
  };
}
function migrate(dir = ADLC_DIR, { key = null, reason = "", attestUnsigned = false, write = false } = {}) {
  const plan = planMigrate(dir, { key, reason, attestUnsigned });
  if (plan.decision !== "plan" || !write) return { ...plan, written: false };
  const signingKey = validateKeyParam(key);
  const rootPath = ledgerPath("manifest", dir);
  const applied2 = withLedgerLock(rootPath, () => {
    if (isSegmentedRepo2(dir)) {
      throw new Error("another migration completed while this one waited for the lock \u2014 the repository is already segmented");
    }
    const originalBytes = readFileSync18(rootPath);
    const originalText = originalBytes.toString("utf8");
    const seals = standingApproves(originalText);
    const unsigned = unsignedEntries(originalText);
    if (unsigned.length > 0 && !attestUnsigned) {
      throw new Error("unsigned entries appeared between planning and locking \u2014 re-run");
    }
    const backupPath = `${rootPath}.pre-cutover-${sha2563(originalBytes).slice(0, 16)}.bak`;
    let backupStat = null;
    try {
      backupStat = lstatSync12(backupPath);
    } catch {
      backupStat = null;
    }
    if (backupStat !== null) {
      if (!backupStat.isFile()) {
        throw new Error(`backup path ${backupPath} exists and is not a regular file \u2014 refusing to write through it`);
      }
      if (!readFileSync18(backupPath).equals(originalBytes)) {
        throw new Error(`backup path ${backupPath} exists with different content \u2014 refusing to overwrite; resolve it before re-running`);
      }
    } else {
      const fd = openSync10(backupPath, "wx");
      try {
        writeSync(fd, originalBytes);
        fsyncSync7(fd);
      } finally {
        closeSync10(fd);
      }
    }
    const lines2 = rawLines(originalText);
    let lastLine2 = lines2.length ? lines2.at(-1).line : null;
    let lastSeq = lastLine2 ? parse(lastLine2)?.seq ?? lines2.length : 0;
    let appendix = "";
    const appendEntry2 = (payload) => {
      const chained = {
        seq: lastSeq + 1,
        ...payload,
        ts: payload.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
        files: payload.files ?? {},
        prev: lastLine2 === null ? null : sha2563(lastLine2)
      };
      chained.sigVersion = 2;
      chained.sig = signEntry(signingKey, chained);
      const line = JSON.stringify(chained);
      appendix += line + "\n";
      lastLine2 = line;
      lastSeq = chained.seq;
    };
    for (const seal of seals) {
      appendEntry2({
        gate: "cross-model-review",
        ...seal.ticket ? { ticket: seal.ticket } : {},
        data: {
          verdict: "needs-attention",
          sealedByCutover: true,
          provider: seal.provider,
          authorProvider: seal.authorProvider,
          revision: seal.revision
        }
      });
    }
    const newlineRepair = originalBytes.length > 0 && originalBytes[originalBytes.length - 1] !== 10 ? "\n" : "";
    const preCutoverBytes = Buffer.concat([originalBytes, Buffer.from(newlineRepair + appendix, "utf8")]);
    appendEntry2({
      gate: "manifest-cutover",
      data: {
        reason,
        rootLines: rawLines(preCutoverBytes.toString("utf8")).length,
        rootSha256: sha2563(preCutoverBytes),
        sealedApprovals: seals.length,
        ...unsigned.length > 0 ? { attestedUnsignedEntries: unsigned.length, attestedUnsignedLines: unsigned.map((u) => u.lineNo) } : {}
      }
    });
    {
      const fd = openSync10(rootPath, "a");
      try {
        writeSync(fd, newlineRepair + appendix);
        fsyncSync7(fd);
      } finally {
        closeSync10(fd);
      }
    }
    const segDir = segmentDirPath2(dir);
    mkdirSync10(segDir, { recursive: true });
    if (lstatSync12(markerPath2(dir), { throwIfNoEntry: false }) !== void 0) {
      throw new Error(`${markerPath2(dir)} already exists but was not recognized as a valid activation marker \u2014 refusing to overwrite a trust file; inspect and remove it deliberately before re-running`);
    }
    const tempPath = join20(segDir, `.store.json.tmp-${randomBytes5(6).toString("hex")}`);
    try {
      const fd = openSync10(tempPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ format: "adlc-manifest-segments", version: 1, auth: "keyed" }));
        fsyncSync7(fd);
      } finally {
        closeSync10(fd);
      }
      renameSync4(tempPath, markerPath2(dir));
      for (const d of [segDir, dir]) {
        try {
          const dirFd = openSync10(d, "r");
          try {
            fsyncSync7(dirFd);
          } finally {
            closeSync10(dirFd);
          }
        } catch {
        }
      }
    } catch (err) {
      rmSync3(tempPath, { force: true });
      throw err;
    }
    if (!isSegmentedRepo2(dir)) {
      rmSync3(markerPath2(dir), { force: true });
      throw new Error("the resolver does not recognize the marker that was just written (format/version skew) \u2014 rolled back");
    }
    const finalText = readFileSync18(rootPath, "utf8");
    const finalCheck = verifyChain(
      rawLines(finalText),
      { key: signingKey, requireSignatures: unsigned.length === 0, anchorOnFirst: false }
    );
    if (!finalCheck.valid) {
      throw new Error(`the migrated root does not chain-verify (${finalCheck.message}) \u2014 restore ${backupPath} over manifest.jsonl; if .adlc/manifest.d contains ONLY .store.json, delete the directory too, otherwise investigate its segments before touching them`);
    }
    return {
      seals,
      unsignedEntries: unsigned,
      backupPath,
      cutover: {
        reason,
        sealedApprovals: seals.length,
        rootLines: rawLines(preCutoverBytes.toString("utf8")).length
      }
    };
  }, dir);
  const post = verify(dir, { key: signingKey, requireSignatures: applied2.unsignedEntries.length === 0 });
  if (!post.valid) {
    throw new Error(`post-ceremony forest verification reported: ${post.message}. The migrated ROOT verified inside the lock; investigate ${segmentDirPath2(dir)} before altering anything \u2014 a concurrent writer may have minted a segment mid-verification. Backup: ${applied2.backupPath}`);
  }
  return { ...plan, ...applied2, decision: "applied", written: true };
}
var sha2563, normalizeProvider, tupleKey, parse;
var init_migrate2 = __esm({
  "node_modules/@adlc/gate-manifest/lib/migrate.mjs"() {
    init_core();
    init_key_contract();
    init_lineage();
    init_forest();
    init_verify();
    init_sign();
    init_enable();
    sha2563 = (input) => createHash4("sha256").update(input).digest("hex");
    normalizeProvider = (value) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, "").toLowerCase() : "";
    tupleKey = (data, ticket2) => [normalizeProvider(data?.provider), data?.revision, ticket2 ?? ""].join("\0");
    parse = (line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
      } catch {
        return null;
      }
    };
  }
});

// node_modules/@adlc/gate-manifest/lib/migrate-branch.mjs
import { lstatSync as lstatSync13, readFileSync as readFileSync19 } from "node:fs";
import { execFileSync as execFileSync7 } from "node:child_process";
import { createHash as createHash5 } from "node:crypto";
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function contentOf(entry) {
  const out = {};
  for (const [field, value] of Object.entries(entry)) {
    if (!RESERVED2.has(field)) out[field] = value;
  }
  return out;
}
function gitShow(cwd2, ref, path) {
  try {
    return execFileSync7("git", ["show", `${ref}:${path}`], { cwd: cwd2, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}
function currentBranch3(cwd2) {
  try {
    return execFileSync7("git", ["branch", "--show-current"], { cwd: cwd2, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
function branchOwnsSegment(dir, branch) {
  const { valid } = discoverSegments2(dir);
  for (const name of valid) {
    const first = readRawLines2(`${segmentDirPath2(dir)}/${name}`)[0];
    if (first === void 0) continue;
    const entry = parse2(first.line);
    if (entry?.branch === branch) return name;
  }
  return null;
}
function planMigrateBranch(dir = ADLC_DIR, {
  key = null,
  sourceRef = "ORIG_HEAD",
  sourcePath = ".adlc/manifest.jsonl",
  cwd: cwd2 = null,
  attestUnsigned = false
} = {}) {
  if (key === null || key === void 0 || key === "") {
    return { decision: "refuse-keyless", reason: "salvage requires ADLC_MANIFEST_KEY \u2014 it exists to preserve AUTHENTICATED evidence, and re-chained entries must be re-signed" };
  }
  const signingKey = validateKeyParam(key);
  const repoCwd = cwd2 ?? process.cwd();
  const lstatIsSymlink2 = (path) => {
    try {
      return lstatSync13(path).isSymbolicLink();
    } catch {
      return false;
    }
  };
  for (const path of [dir, ledgerPath("manifest", dir), segmentDirPath2(dir)]) {
    if (lstatIsSymlink2(path)) {
      return { decision: "refuse-symlink", reason: `${path} is a symlink \u2014 salvage refuses to read or write through repository-controlled links` };
    }
  }
  if (!isSegmentedRepo2(dir)) {
    return { decision: "refuse-not-segmented", reason: "this repository is not segmented \u2014 salvage applies after rebasing onto a cut-over main; nothing here has discarded root-tail evidence" };
  }
  const branch = currentBranch3(repoCwd);
  if (branch === null) {
    return { decision: "refuse-branch", reason: "no current git branch (detached HEAD?) \u2014 the salvaged segment carries the branch identity, which must exist" };
  }
  if (typeof sourceRef !== "string" || sourceRef === "" || sourceRef.startsWith("-")) {
    return { decision: "refuse-source", reason: `invalid source ref ${JSON.stringify(sourceRef)} \u2014 refs must not begin with '-'` };
  }
  if (typeof sourcePath !== "string" || sourcePath === "" || sourcePath.startsWith("-")) {
    return { decision: "refuse-source", reason: `invalid source path ${JSON.stringify(sourcePath)} \u2014 paths must not begin with '-'` };
  }
  const sourceBytes = gitShow(repoCwd, sourceRef, sourcePath);
  if (sourceBytes === null) {
    return { decision: "refuse-source", reason: `cannot read ${sourcePath} at ${sourceRef} \u2014 pass --from <ref> naming the pre-rebase state (ORIG_HEAD is the default and survives one rebase; the reflog holds older states)` };
  }
  let sourceSha;
  try {
    sourceSha = execFileSync7("git", ["rev-parse", sourceRef], { cwd: repoCwd, encoding: "utf8" }).trim();
  } catch {
    return { decision: "refuse-source", reason: `cannot resolve ${sourceRef} to a commit` };
  }
  const workingBytes = readFileSync19(ledgerPath("manifest", dir));
  const workingLines = workingBytes.toString("utf8").split("\n").filter((l) => l.trim());
  const sourceLines = sourceBytes.toString("utf8").split("\n").filter((l) => l.trim());
  if (workingBytes.equals(sourceBytes)) {
    return { decision: "refuse-unresolved", reason: "the working root still matches the pre-rebase source \u2014 resolve the conflict by taking main's side of .adlc/manifest.jsonl wholesale, then re-run the salvage" };
  }
  let common = 0;
  while (common < workingLines.length && common < sourceLines.length && workingLines[common] === sourceLines[common]) common += 1;
  const suffix = sourceLines.slice(common);
  const workingDiverges = workingLines.slice(common);
  if (workingDiverges.length === 0) {
    return { decision: "refuse-unresolved", reason: "the working root is a prefix of the pre-rebase source \u2014 the branch tail was never replaced by main's side; take main's .adlc/manifest.jsonl wholesale, then re-run the salvage" };
  }
  if (suffix.length === 0) {
    return { decision: "refuse-nothing", reason: "the source holds no entries beyond the shared prefix \u2014 nothing to salvage" };
  }
  let prevLine = common > 0 ? sourceLines[common - 1] : null;
  const entries = [];
  for (const line of suffix) {
    const entry = parse2(line);
    if (entry === null) {
      return { decision: "refuse-broken-chain", reason: "a source entry beyond the shared prefix is not a JSON object \u2014 the source is corrupt" };
    }
    const expectedPrev = prevLine === null ? null : sha2564(prevLine);
    if (entry.prev !== expectedPrev) {
      return { decision: "refuse-broken-chain", reason: `source entry seq ${entry.seq ?? "?"} does not chain from the shared prefix \u2014 the source is corrupt; salvage refuses to guess at its true content` };
    }
    entries.push({ entry, line });
    prevLine = line;
  }
  const unsigned = [];
  for (const [index, { entry }] of entries.entries()) {
    const hasSig = entry.sig !== void 0 && entry.sig !== null;
    if (!hasSig) {
      unsigned.push({ index, seq: entry.seq ?? null });
      continue;
    }
    if (!verifyEntrySig(signingKey, entry)) {
      return { decision: "refuse-tampered", reason: `source entry seq ${entry.seq ?? "?"} carries a signature that does not verify under the key \u2014 tampered evidence is never salvaged` };
    }
    if (entry.sigVersion !== 2) {
      const uncovered = Object.keys(entry).filter((field) => !V1_COVERED.has(field));
      if (uncovered.length > 0) {
        return { decision: "refuse-uncovered", reason: `source entry seq ${entry.seq ?? "?"} is v1-signed but carries field(s) its signature never covered: ${uncovered.join(", ")} \u2014 salvaging them would launder unauthenticated data into v2-signed evidence` };
      }
    }
  }
  if (unsigned.length > 0 && !attestUnsigned) {
    return { decision: "refuse-unsigned", reason: `${unsigned.length} source entr${unsigned.length === 1 ? "y is" : "ies are"} unsigned \u2014 re-run with --attest-unsigned to salvage them under the ceremony key deliberately, with the count disclosed in the salvage record` };
  }
  const planned = entries.map(({ entry, line }) => ({ entry, lineHash: sha2564(line), content: contentOf(entry) }));
  const owned = branchOwnsSegment(dir, branch);
  let alreadyAppended = 0;
  if (owned !== null) {
    const segEntries = readRawLines2(`${segmentDirPath2(dir)}/${owned}`).map(({ line }) => parse2(line)).filter((e) => e !== null);
    const record2 = segEntries.find((e) => e.gate === "manifest-salvage");
    if (record2 !== void 0) {
      const recordedHashes = JSON.stringify(record2.data?.salvagedLineHashes ?? []);
      const plannedHashes = JSON.stringify(planned.map((e) => e.lineHash));
      if (recordedHashes === plannedHashes) {
        return { decision: "refuse-existing-segment", reason: `branch ${branch} already owns segment ${owned} carrying the completed record of THIS salvage \u2014 nothing left to do` };
      }
      return { decision: "refuse-existing-segment", reason: `branch ${branch} owns segment ${owned} whose salvage record does not match this source \u2014 a different or corrupted salvage landed there; inspect the segment and its manifest-salvage entry before anything else` };
    }
    const isPrefix = segEntries.length <= planned.length && segEntries.every((e, i) => stable(contentOf(e)) === stable(planned[i].content));
    if (!isPrefix) {
      return { decision: "refuse-existing-segment", reason: `branch ${branch} already owns segment ${owned} with entries unrelated to this salvage \u2014 salvage runs once, immediately after the rebase, before any new writes` };
    }
    alreadyAppended = segEntries.length;
  }
  return {
    decision: "plan",
    entries: planned.slice(alreadyAppended).map(({ entry, lineHash }) => ({ entry, lineHash })),
    allEntries: planned.map(({ entry, lineHash }) => ({ entry, lineHash })),
    alreadyAppended,
    unsignedEntries: unsigned,
    branch,
    sourceRef,
    sourceSha
  };
}
function migrateBranch(dir = ADLC_DIR, { key = null, sourceRef = "ORIG_HEAD", sourcePath = ".adlc/manifest.jsonl", cwd: cwd2 = null, attestUnsigned = false, write = false } = {}) {
  const plan = planMigrateBranch(dir, { key, sourceRef, sourcePath, cwd: cwd2, attestUnsigned });
  if (plan.decision !== "plan" || !write) return { ...plan, written: false };
  const signingKey = validateKeyParam(key);
  const repoCwd = cwd2 ?? process.cwd();
  for (const { entry } of plan.entries) {
    const payload = {};
    for (const [field, value] of Object.entries(entry)) {
      if (!RESERVED2.has(field)) payload[field] = value;
    }
    appendManifestEntry(payload, dir, { signatureVersion: 2, cwd: repoCwd, key: signingKey });
  }
  {
    const segName = branchOwnsSegment(dir, plan.branch);
    const soFar = readRawLines2(`${segmentDirPath2(dir)}/${segName}`).map(({ line }) => parse2(line)).filter((e) => e !== null);
    const expected2 = plan.allEntries.map((e) => stable(contentOf(e.entry)));
    const actual = soFar.map((e) => stable(contentOf(e)));
    if (actual.length !== expected2.length || !expected2.every((c, i) => c === actual[i])) {
      throw new Error(`segment ${segName} does not match the salvage plan \u2014 a concurrent writer raced this salvage; no salvage record was written, nothing was deleted; inspect the segment, then re-run (the salvage resumes past a clean prefix)`);
    }
  }
  appendManifestEntry({
    gate: "manifest-salvage",
    data: {
      sourceRef: plan.sourceRef,
      sourceSha: plan.sourceSha,
      // The FULL salvage, not this run's remainder: a resumed run must
      // disclose everything the segment carries from the source, or the
      // record understates what was re-signed.
      salvagedEntries: plan.allEntries.length,
      salvagedLineHashes: plan.allEntries.map((e) => e.lineHash),
      ...plan.unsignedEntries.length > 0 ? { attestedUnsignedEntries: plan.unsignedEntries.length } : {}
    },
    files: {}
  }, dir, { signatureVersion: 2, cwd: repoCwd, key: signingKey });
  const segment = branchOwnsSegment(dir, plan.branch);
  const written = readRawLines2(`${segmentDirPath2(dir)}/${segment}`).map(({ line }) => parse2(line)).filter((e) => e !== null);
  const expected = plan.allEntries.map((e) => stable(contentOf(e.entry)));
  const actualContent = written.slice(0, -1).map((e) => stable(contentOf(e)));
  const last = written.at(-1);
  if (actualContent.length !== expected.length || !expected.every((c, i) => c === actualContent[i]) || last?.gate !== "manifest-salvage") {
    throw new Error(`segment ${segment} does not match the salvage plan \u2014 a concurrent writer raced this salvage; inspect the segment before retrying, nothing has been deleted`);
  }
  return { ...plan, segment, decision: "applied", written: true };
}
var sha2564, RESERVED2, V1_COVERED, parse2;
var init_migrate_branch = __esm({
  "node_modules/@adlc/gate-manifest/lib/migrate-branch.mjs"() {
    init_core();
    init_key_contract();
    init_lineage();
    init_forest();
    init_sign();
    init_record();
    sha2564 = (input) => createHash5("sha256").update(input).digest("hex");
    RESERVED2 = /* @__PURE__ */ new Set(["seq", "prev", "sig", "sigVersion", "segment", "anchor", "branch"]);
    V1_COVERED = /* @__PURE__ */ new Set(["seq", "gate", "ts", "ticket", "data", "files", "prev", "sig"]);
    parse2 = (line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
      } catch {
        return null;
      }
    };
  }
});

// node_modules/@adlc/gate-manifest/lib/key-ceremony.mjs
import { randomBytes as randomBytes6, timingSafeEqual as timingSafeEqual3 } from "node:crypto";
import { openSync as openSync11, writeSync as writeSync2, fsyncSync as fsyncSync8, closeSync as closeSync11, fchmodSync, realpathSync as realpathSync2, unlinkSync as unlinkSync7, fstatSync as fstatSync3 } from "node:fs";
import { dirname as dirname17, basename as basename6, resolve as resolve7, relative as relative7, isAbsolute as isAbsolute5, sep as sep6 } from "node:path";
import { execFileSync as execFileSync8 } from "node:child_process";
function stripAclBestEffort(path, { platform = process.platform, exec = execFileSync8 } = {}) {
  if (platform !== "darwin" && platform !== "linux") return;
  const command = ACL_TOOL_PATHS[platform];
  const args = platform === "darwin" ? ["-N", path] : ["-b", path];
  try {
    exec(command, args, { stdio: "ignore", env: {} });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw new Error(
      `ACL removal via \`${command}\` failed on ${path} (${err.message}) \u2014 refusing to hand off a key whose confinement could not be established rather than silently proceeding as if it had been`
    );
  }
}
function realpathOfDeepestExisting(path) {
  let current = resolve7(path);
  const tail2 = [];
  for (; ; ) {
    try {
      const real = realpathSync2(current);
      return tail2.length ? resolve7(real, ...tail2.reverse()) : real;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const parent = dirname17(current);
      if (parent === current) throw err;
      tail2.push(basename6(current));
      current = parent;
    }
  }
}
function generateManifestKey(entropy = randomBytes6(KEY_BYTE_LENGTH)) {
  if (!Buffer.isBuffer(entropy) || entropy.length !== KEY_BYTE_LENGTH) {
    throw new TypeError(`manifest key entropy must be a ${KEY_BYTE_LENGTH}-byte Buffer`);
  }
  return entropy.toString("hex");
}
function computeKeyFingerprint(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("cannot fingerprint an empty or non-string key");
  }
  return sha256(key);
}
function sanitizedGitEnv() {
  const sanitized = { ...process.env };
  delete sanitized.ADLC_MANIFEST_KEY;
  for (const name of Object.keys(sanitized)) {
    if (name.startsWith("GIT_")) delete sanitized[name];
  }
  return sanitized;
}
function repoBoundaryRoots({ cwd: cwd2 = process.cwd(), git: gitFn = git } = {}) {
  const env = sanitizedGitEnv();
  const commonDirRaw = gitFn(["rev-parse", "--git-common-dir"], { cwd: cwd2, env }).trim();
  const commonDir = resolve7(cwd2, commonDirRaw);
  const worktreeListRaw = gitFn(["worktree", "list", "--porcelain", "-z"], { cwd: cwd2, env, encoding: null });
  const roots = [commonDir];
  for (const field of splitNulPaths(worktreeListRaw)) {
    if (field.startsWith("worktree ")) roots.push(field.slice("worktree ".length));
  }
  const resolvedCwd = realpathOfDeepestExisting(cwd2);
  const describesCwd = roots.some((root2) => {
    const resolvedRoot = realpathOfDeepestExisting(root2);
    const rel = relative7(resolvedRoot, resolvedCwd);
    return rel === "" || rel !== ".." && !rel.startsWith(`..${sep6}`) && !isAbsolute5(rel);
  });
  if (!describesCwd) {
    throw new Error(
      `git reported repository boundaries that do not contain the current directory (${cwd2}) \u2014 refusing to trust a repository-selection answer that appears to describe a different repository entirely (e.g. via GIT_DIR/GIT_WORK_TREE)`
    );
  }
  return roots;
}
function assertHandoffPathOutsideRepo(path, { roots = repoBoundaryRoots() } = {}) {
  const resolvedPath = realpathOfDeepestExisting(path);
  for (const root2 of roots) {
    const resolvedRoot = realpathOfDeepestExisting(root2);
    const rel = relative7(resolvedRoot, resolvedPath);
    const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep6}`) && !isAbsolute5(rel);
    if (inside || resolvedPath === resolvedRoot) {
      throw new Error(`the key handoff path must be OUTSIDE the repository; ${path} resolves inside ${resolvedRoot}`);
    }
  }
}
function writeKeyHandoffFile(path, key, options = {}) {
  const { stat = fstatSync3, stripAcl = stripAclBestEffort } = options;
  if (process.platform === "win32") {
    throw new Error(
      "the key handoff ceremony is not supported on win32 yet: chmod/mode 0600 only toggles the read-only attribute there, not an owner-only ACL, so the file would NOT actually be confined to the current user \u2014 refusing rather than writing a secret behind a false sense of restricted permissions."
    );
  }
  assertHandoffPathOutsideRepo(path, options);
  let fd;
  try {
    fd = openSync11(path, "wx", 384);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`refusing to overwrite an existing file at the handoff path: ${path}`);
    }
    throw err;
  }
  try {
    fchmodSync(fd, 384);
    stripAcl(path);
    const actualMode = stat(fd).mode & 511;
    if (actualMode !== 384) {
      throw new Error(
        `the filesystem at ${path} did not enforce mode 0600 (observed ${actualMode.toString(8)}) \u2014 refusing to hand off a key the OS cannot actually confine to the current user`
      );
    }
    const buffer = Buffer.from(`${key}
`, "utf8");
    let written = 0;
    while (written < buffer.length) {
      written += writeSync2(fd, buffer, written, buffer.length - written);
    }
    fsyncSync8(fd);
    closeSync11(fd);
    fd = void 0;
    fsyncDirectory(dirname17(resolve7(path)));
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync11(fd);
      } catch {
      }
    }
    try {
      unlinkSync7(path);
    } catch {
    }
    throw err;
  }
}
function resolveCeremonyKey({ importKey, allowKeyImport = false, entropy } = {}) {
  if (importKey !== void 0) {
    if (!allowKeyImport) {
      throw new Error(
        "a caller-supplied key was provided, but the normal ceremony path never accepts one \u2014 the key is always generated (CSPRNG), never accepted, so a published fingerprint cannot become an offline guessing oracle for a weak key. To import a pre-existing key anyway (a legacy, audited exception), pass the explicit import-exception flag."
      );
    }
    if (typeof importKey !== "string" || importKey.length === 0) {
      throw new TypeError("an imported key must be a non-empty string");
    }
    if (importKey.includes("\n") || importKey.includes("\r")) {
      throw new TypeError(
        "an imported key must not contain a newline \u2014 the handoff file is line-oriented, so a multiline value would round-trip through the documented `read -r` loader as only its first line, silently diverging from the key that was actually imported and fingerprinted"
      );
    }
    return { key: importKey, imported: true };
  }
  return { key: generateManifestKey(entropy), imported: false };
}
var ACL_TOOL_PATHS, KEY_BYTE_LENGTH, KEY_HEX_LENGTH;
var init_key_ceremony = __esm({
  "node_modules/@adlc/gate-manifest/lib/key-ceremony.mjs"() {
    init_core();
    init_durability();
    ACL_TOOL_PATHS = { darwin: "/bin/chmod", linux: "/usr/bin/setfacl" };
    KEY_BYTE_LENGTH = 32;
    KEY_HEX_LENGTH = KEY_BYTE_LENGTH * 2;
  }
});

// node_modules/@adlc/gate-manifest/bin/gate-manifest.mjs
var gate_manifest_exports = {};
var USAGE, flags, positionals, verb;
var init_gate_manifest2 = __esm({
  "node_modules/@adlc/gate-manifest/bin/gate-manifest.mjs"() {
    init_core();
    init_record();
    init_verify();
    init_show();
    init_attest();
    init_repair();
    init_enable();
    init_adopt();
    init_migrate2();
    init_migrate_branch();
    init_core();
    init_sign();
    init_key_ceremony();
    USAGE = `usage: gate-manifest <verb> [options]
verbs: record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c]
       verify [--json] [--allow-legacy-unsigned]
       show   [--ticket id] [--json]
       attest [--ticket id]
       repair-chain --reason "..." [--write] [--attest-unsigned] [--json]
       generate-key --output <path> [--allow-key-import] [--json]
       enable [--write] [--json] [--allow-keyless]
       migrate --reason "..." [--write] [--attest-unsigned] [--json]
       migrate-branch [--from <ref>] [--write] [--attest-unsigned] [--json]
       adopt  [segment-name] [--write] [--json]`;
    ({ values: flags, positionals } = parseArgs({
      usage: USAGE,
      options: {
        ticket: { type: "string" },
        data: { type: "string" },
        files: { type: "string" },
        json: { type: "boolean", default: false },
        dir: { type: "string", default: ADLC_DIR },
        reason: { type: "string" },
        write: { type: "boolean", default: false },
        "attest-unsigned": { type: "boolean", default: false },
        "allow-legacy-unsigned": { type: "boolean", default: false },
        output: { type: "string" },
        "allow-key-import": { type: "boolean", default: false },
        "allow-keyless": { type: "boolean", default: false },
        from: { type: "string" }
      }
    }));
    verb = positionals[0];
    if (!verb) {
      opError(USAGE);
    }
    if (verb === "record") {
      const gate = positionals[1];
      if (!gate) {
        opError("usage: gate-manifest record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c]");
      }
      try {
        parseData(flags.data);
      } catch (err) {
        opError(err.message);
      }
      let entry;
      try {
        entry = record({
          gate,
          ticket: flags.ticket,
          rawData: flags.data,
          rawFiles: flags.files,
          dir: flags.dir,
          key: getKey()
        });
      } catch (err) {
        opError(err.message);
      }
      if (flags.json) {
        printJson(entry);
      } else {
        const signed = typeof entry.sig === "string" ? " (signed)" : " (unsigned)";
        console.log(`recorded: seq=${entry.seq} gate=${entry.gate} ts=${entry.ts}${signed}`);
      }
      const reminder = ticketCompletionReminder(gate, flags.ticket);
      if (reminder) console.error(reminder);
      pass();
    }
    if (verb === "verify") {
      const result6 = verify(flags.dir, { requireSignatures: !flags["allow-legacy-unsigned"], key: getKey() });
      if (flags.json) {
        printJson(result6);
      } else {
        console.log(result6.message);
      }
      if (result6.valid) {
        pass();
      } else {
        gateFail(`gate-manifest verify: ${result6.message}`);
      }
    }
    if (verb === "show") {
      const { entries, skipped } = loadFiltered({ ticket: flags.ticket, dir: flags.dir });
      if (flags.json) {
        printJson({ entries, skipped });
      } else {
        const lines2 = renderEntries(entries);
        for (const l of lines2) console.log(l);
        if (skipped.length > 0) {
          console.warn(`warning: ${skipped.length} malformed line(s) skipped`);
        }
      }
      pass();
    }
    if (verb === "attest") {
      const md = buildAttest({ ticket: flags.ticket, dir: flags.dir, key: getKey() });
      console.log(md);
      pass();
    }
    if (verb === "repair-chain") {
      let result6;
      try {
        result6 = repairChain({
          key: getKey(),
          dir: flags.dir,
          reason: flags.reason,
          write: flags.write,
          attestUnsigned: flags["attest-unsigned"]
        });
      } catch (err) {
        opError(err.message);
      }
      if (flags.json) printJson(result6);
      else {
        const attestation = result6.newlySignedEntries > 0 ? `; cryptographically attested ${result6.newlySignedEntries} previously unsigned entr${result6.newlySignedEntries === 1 ? "y" : "ies"}` : "";
        console.log(flags.write ? `repaired ${result6.path}; original preserved at ${result6.backup}${attestation}` : `repair plan: ${result6.originalEntries} entries \u2192 ${result6.repairedEntries}${attestation}; rerun with --write`);
      }
      pass();
    }
    if (verb === "generate-key") {
      if (!flags.output) {
        opError("usage: gate-manifest generate-key --output <path> [--allow-key-import] [--json]");
      }
      const importKey = flags["allow-key-import"] ? getKey() : void 0;
      if (flags["allow-key-import"] && !importKey) {
        opError(
          "generate-key: --allow-key-import requires ADLC_MANIFEST_KEY to be set in the environment \u2014 the import exception never accepts a key as a CLI argument (visible via ps, xtrace, and shell history)."
        );
      }
      let resolved;
      try {
        resolved = resolveCeremonyKey({ importKey, allowKeyImport: flags["allow-key-import"] });
      } catch (err) {
        opError(err.message);
      }
      try {
        writeKeyHandoffFile(flags.output, resolved.key);
      } catch (err) {
        opError(err.message);
      }
      const fingerprint = computeKeyFingerprint(resolved.key);
      if (resolved.imported) {
        console.error(
          "generate-key: used the AUDITED IMPORT EXCEPTION \u2014 a caller-supplied key was written to the handoff path instead of a freshly generated one. Doctor reporting of this exception is wired in a later slice, alongside the full adoption transaction."
        );
      }
      if (flags.json) {
        printJson({ path: flags.output, fingerprint, imported: resolved.imported });
      } else {
        console.log(`key written to ${flags.output} (mode 0600) \u2014 store it in your secret manager, then delete this file.`);
        console.log(`fingerprint: ${fingerprint}`);
        console.log("This ceremony does not yet run the custody checkpoint or adopt the key \u2014 that is wired into a later slice.");
      }
      pass();
    }
    if (verb === "enable") {
      if (getKey(process.env) === null && !flags["allow-keyless"]) {
        const keylessReason = "no ADLC_MANIFEST_KEY is configured. Keyless forest mode is single-checkout only, PERMANENTLY: keyless-minted segments can never be authenticated by a later key, so every other clone of a branch fails closed on its first write. Configure the signing key first, or re-run with --allow-keyless to accept single-checkout mode deliberately.";
        const state = boundedSegmentationState(flags.dir);
        const keylessWarnings = state === "segmented" ? [CI_COVERAGE_WARNING] : state === "undetermined" ? [SEGMENTATION_UNDETERMINED_WARNING] : [];
        if (flags.json) {
          printJson({ decision: "refuse-keyless", reason: keylessReason, ...keylessWarnings.length ? { warnings: keylessWarnings } : {} });
          process.exit(2);
        }
        for (const warning of keylessWarnings) console.log(`warning [${warning.code}]: ${warning.message}`);
        gateFail(`enable refused: ${keylessReason}`);
      }
      let out;
      try {
        out = enable(flags.dir, { write: flags.write, auth: getKey(process.env) === null ? "keyless" : "keyed" });
      } catch (err) {
        opError(err.message);
      }
      const refused = out.decision.startsWith("refuse-");
      if (flags.json) {
        printJson(out);
        process.exit(refused ? 2 : 0);
      }
      for (const warning of out.warnings ?? []) console.log(`warning [${warning.code}]: ${warning.message}`);
      if (refused) gateFail(`enable refused: ${out.reason}`);
      if (out.decision === "already-enabled") pass(out.reason);
      if (out.written) pass(`forest mode enabled \u2014 wrote ${out.markerPath}`);
      pass(`dry-run: would write ${out.markerPath} to enable forest mode \u2014 re-run with --write to apply`);
    }
    if (verb === "migrate") {
      let out;
      try {
        out = migrate(flags.dir, {
          key: getKey(process.env),
          reason: flags.reason ?? "",
          attestUnsigned: flags["attest-unsigned"],
          write: flags.write
        });
      } catch (err) {
        opError(err.message);
      }
      const refused = out.decision.startsWith("refuse-");
      if (flags.json) {
        printJson(out);
        process.exit(refused ? 2 : 0);
      }
      if (refused) gateFail(`migrate refused: ${out.reason}`);
      const sealsLine = `${out.seals.length} standing approve${out.seals.length === 1 ? "" : "s"} sealed`;
      if (out.written) {
        console.log(`cutover applied: ${sealsLine}; backup at ${out.backupPath}; marker at ${out.markerPath}`);
        for (const step of out.followUps) console.log(`  next: ${step}`);
        pass();
      }
      console.log(`dry-run plan: ${sealsLine}; cutover reason "${out.cutover.reason}"; backup would be ${out.backupPath}`);
      for (const seal of out.seals) {
        console.log(`  seal: provider ${seal.provider}, revision ${seal.revision}${seal.ticket ? `, ticket ${seal.ticket}` : ""}`);
      }
      pass("re-run with --write to apply");
    }
    if (verb === "migrate-branch") {
      let out;
      try {
        out = migrateBranch(flags.dir, {
          key: getKey(process.env),
          sourceRef: flags.from ?? "ORIG_HEAD",
          cwd: process.cwd(),
          attestUnsigned: flags["attest-unsigned"],
          write: flags.write
        });
      } catch (err) {
        opError(err.message);
      }
      const refused = out.decision.startsWith("refuse-");
      if (flags.json) {
        printJson(out);
        process.exit(refused ? 2 : 0);
      }
      if (refused) gateFail(`migrate-branch refused: ${out.reason}`);
      const line = `${out.entries.length} entr${out.entries.length === 1 ? "y" : "ies"} from ${out.sourceRef} (${out.sourceSha.slice(0, 12)}) for branch ${out.branch}`;
      if (out.written) {
        console.log(`salvaged ${line} into ${out.segment}`);
        pass("re-record or carry-forward revision-bound attestations next \u2014 the salvaged approves are findable again");
      }
      console.log(`dry-run plan: would salvage ${line}`);
      pass("re-run with --write to apply");
    }
    if (verb === "adopt") {
      let out;
      try {
        out = adopt(flags.dir, { cwd: process.cwd(), key: getKey(process.env), segment: positionals[1] ?? null, write: flags.write });
      } catch (err) {
        opError(err.message);
      }
      const refused = out.decision.startsWith("refuse-");
      if (flags.json) {
        printJson(out);
        process.exit(refused ? 2 : 0);
      }
      if (refused) gateFail(`adopt refused: ${out.reason}`);
      if (out.decision === "list") {
        if (out.candidates.length === 0) pass(`no committed segments declare branch ${out.branch} \u2014 nothing to adopt`);
        console.log(`candidate lineages for branch ${out.branch}:`);
        for (const c of out.candidates) {
          console.log(`  ${c.name}  entries=${c.entries}  first=${c.firstTs ?? "?"}  last=${c.lastTs ?? "?"}  authenticated=${c.authenticated}`);
        }
        pass("choose one and re-run: gate-manifest adopt <segment> --write");
      }
      if (out.written) pass(`adopted ${out.segment} \u2014 this checkout now extends that lineage`);
      pass(`dry-run: would adopt ${out.segment} for branch ${out.branch} \u2014 re-run with --write to apply`);
    }
    opError(`unknown verb: ${verb}. Expected: record | verify | show | attest | repair-chain | generate-key | enable | adopt`);
  }
});

// node_modules/@adlc/flail-detector/lib/parse-log.mjs
function extractStrings(obj) {
  if (typeof obj === "string") return [obj];
  if (!obj || typeof obj !== "object") return [];
  const KEYS = ["content", "text", "message"];
  const results2 = [];
  for (const key of Object.keys(obj)) {
    if (KEYS.includes(key)) {
      if (typeof obj[key] === "string") {
        results2.push(obj[key]);
      } else {
        results2.push(...extractStrings(obj[key]));
      }
    } else if (obj[key] && typeof obj[key] === "object") {
      results2.push(...extractStrings(obj[key]));
    }
  }
  return results2;
}
function extractFileTargets(obj) {
  const results2 = [];
  const walk2 = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk2(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const fp = node.file_path;
    if (typeof fp === "string" && fp.length > 0) {
      results2.push(fp);
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === "object") {
        walk2(val);
      }
    }
  };
  walk2(obj);
  return results2;
}
function tryParseJson(line) {
  const trimmed2 = line.trim();
  if (!trimmed2.startsWith("{") && !trimmed2.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed2);
  } catch {
    return null;
  }
}
function parseLog(content) {
  const bytes2 = Buffer.byteLength(content, "utf8");
  const rawLines2 = content.split("\n");
  const nonEmpty = rawLines2.filter((l) => l.trim().length > 0);
  const parsed = nonEmpty.map((l) => tryParseJson(l));
  const jsonCount = parsed.filter(Boolean).length;
  const isJsonl = nonEmpty.length > 0 && jsonCount >= nonEmpty.length / 2;
  let lines2;
  if (isJsonl) {
    lines2 = [];
    for (let i = 0; i < nonEmpty.length; i++) {
      const obj = parsed[i];
      if (obj !== null) {
        for (const fp of extractFileTargets(obj)) {
          lines2.push(`Writing ${fp}`);
        }
        lines2.push(...extractStrings(obj));
      } else {
        lines2.push(nonEmpty[i]);
      }
    }
  } else {
    lines2 = rawLines2;
  }
  return { lines: lines2, bytes: bytes2 };
}
var init_parse_log = __esm({
  "node_modules/@adlc/flail-detector/lib/parse-log.mjs"() {
  }
});

// node_modules/@adlc/flail-detector/lib/signals.mjs
function normalizeError(line) {
  return line.toLowerCase().replace(/0x[0-9a-f]+/gi, "").replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "").replace(/(?:\/[^\s/][^\s]*|[A-Za-z]:\\[^\s]*)/g, "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}
function extractPath(line) {
  for (const re of PATH_EXTRACT_PATTERNS) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}
function detectRepeatedErrors(steps, maxRepeat2) {
  const counts = /* @__PURE__ */ new Map();
  const normalizedSteps = steps.map((item) => {
    if (typeof item === "string") return [item];
    if (Array.isArray(item)) return item;
    return [];
  });
  for (const stepLines of normalizedSteps) {
    if (!Array.isArray(stepLines)) continue;
    const stepSigs = /* @__PURE__ */ new Set();
    for (const line of stepLines) {
      if (typeof line !== "string" || !ERROR_LINE_RE.test(line)) continue;
      const sig = normalizeError(line);
      if (!sig || sig.length < 5) continue;
      if (/^created at:?$/.test(sig) || /^completed at:?$/.test(sig)) continue;
      stepSigs.add(sig);
    }
    for (const sig of stepSigs) {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
  }
  const results2 = [];
  for (const [signature, count] of counts) {
    if (count >= maxRepeat2) {
      results2.push({ signature, count });
    }
  }
  return results2;
}
function detectScopeViolations(lines2, scopes2) {
  if (!scopes2 || scopes2.length === 0) return [];
  const violations2 = [];
  for (const line of lines2) {
    const path = extractPath(line);
    if (!path) continue;
    const inScope = scopes2.some((g) => globMatch2(g, path));
    if (!inScope) {
      violations2.push({ path, line: line.trimEnd() });
    }
  }
  return violations2;
}
function detectEditChurn(lines2) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines2) {
    const path = extractPath(line);
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const results2 = [];
  for (const [path, count] of counts) {
    if (count >= 3) {
      results2.push({ path, count });
    }
  }
  return results2;
}
function detectSizeExceeded(bytes2, maxBytes2) {
  if (maxBytes2 == null) return false;
  return bytes2 > maxBytes2;
}
function detectBudgetExceeded(spentTokens2, budget2) {
  if (spentTokens2 == null || budget2 == null) return false;
  return spentTokens2 > budget2;
}
var ERROR_LINE_RE, PATH_EXTRACT_PATTERNS;
var init_signals = __esm({
  "node_modules/@adlc/flail-detector/lib/signals.mjs"() {
    init_core();
    ERROR_LINE_RE = /error|exception|failed|cannot|ENOENT/i;
    PATH_EXTRACT_PATTERNS = [
      /^(?:Writing|Editing|Created)\s+([^\s]+)/i,
      /"file_path"\s*:\s*"([^"]+)"/
    ];
  }
});

// node_modules/@adlc/flail-detector/lib/analyze.mjs
function analyze({ lines: lines2, bytes: bytes2, scopes: scopes2, maxRepeat: maxRepeat2, maxBytes: maxBytes2, spentTokens: spentTokens2 = null, budget: budget2 = null }) {
  const repeatedErrors = detectRepeatedErrors(lines2, maxRepeat2);
  const scopeViolations = detectScopeViolations(lines2, scopes2);
  const editChurn = detectEditChurn(lines2);
  const sizeExceeded = detectSizeExceeded(bytes2, maxBytes2);
  const budgetExceeded = detectBudgetExceeded(spentTokens2, budget2);
  const isFlail = repeatedErrors.length > 0 || scopeViolations.length > 0 || editChurn.length > 0 || sizeExceeded || budgetExceeded;
  const signals = [];
  if (repeatedErrors.length > 0) {
    signals.push({
      type: "repeated-error",
      entries: repeatedErrors
    });
  }
  if (scopeViolations.length > 0) {
    signals.push({
      type: "scope-violation",
      entries: scopeViolations
    });
  }
  if (editChurn.length > 0) {
    signals.push({
      type: "edit-churn",
      entries: editChurn
    });
  }
  if (sizeExceeded) {
    signals.push({
      type: "size",
      bytes: bytes2,
      maxBytes: maxBytes2
    });
  }
  if (budgetExceeded) {
    signals.push({
      type: "budget",
      spentTokens: spentTokens2,
      budget: budget2
    });
  }
  let deadEnds = null;
  if (isFlail && repeatedErrors.length > 0) {
    deadEnds = repeatedErrors.map((e) => e.signature);
  }
  return {
    verdict: isFlail ? "flail" : "clean",
    signals,
    bytes: bytes2,
    ...isFlail && {
      recommendation: buildRecommendation(deadEnds)
    }
  };
}
function buildRecommendation(deadEnds) {
  if (deadEnds && deadEnds.length > 0) {
    return "Kill the session. Append these dead-ends to the ticket: " + deadEnds.join("; ");
  }
  return "Kill the session. Review signals above and regenerate fresh.";
}
var init_analyze = __esm({
  "node_modules/@adlc/flail-detector/lib/analyze.mjs"() {
    init_signals();
  }
});

// node_modules/@adlc/flail-detector/lib/analyzability.mjs
function assessAnalyzability({ lines: lines2 }) {
  const nonEmpty = lines2.filter((line) => typeof line === "string" && line.trim().length > 0);
  const reasons = nonEmpty.length === 0 ? [REASON_NO_LINES] : [];
  return { ok: reasons.length === 0, reasons };
}
var REASON_NO_LINES;
var init_analyzability = __esm({
  "node_modules/@adlc/flail-detector/lib/analyzability.mjs"() {
    REASON_NO_LINES = "log has no non-empty lines (empty or whitespace-only file)";
  }
});

// node_modules/@adlc/flail-detector/lib/format.mjs
function formatResult(result6) {
  const lines2 = [];
  const icon = result6.verdict === "flail" ? "FLAIL" : "CLEAN";
  lines2.push(`flail-detector: ${icon}`);
  lines2.push(`  bytes: ${result6.bytes}`);
  if (result6.signals.length === 0) {
    lines2.push("  no flail signals detected");
  } else {
    lines2.push("  signals:");
    for (const sig of result6.signals) {
      switch (sig.type) {
        case "repeated-error":
          lines2.push(`    repeated-error (${sig.entries.length} signature(s)):`);
          for (const e of sig.entries) {
            lines2.push(`      [${e.count}x] ${e.signature}`);
          }
          break;
        case "scope-violation":
          lines2.push(`    scope-violation (${sig.entries.length} path(s) outside scope):`);
          for (const e of sig.entries) {
            lines2.push(`      ${e.path}`);
          }
          break;
        case "edit-churn":
          lines2.push(`    edit-churn (${sig.entries.length} file(s) edited >= 3 times):`);
          for (const e of sig.entries) {
            lines2.push(`      [${e.count}x] ${e.path}`);
          }
          break;
        case "size":
          lines2.push(`    size: ${sig.bytes} bytes exceeds limit of ${sig.maxBytes} bytes`);
          break;
        case "budget":
          lines2.push(`    budget: ${sig.spentTokens} tokens spent exceeds budget of ${sig.budget} tokens`);
          break;
        default:
          lines2.push(`    ${sig.type}`);
      }
    }
  }
  if (result6.recommendation) {
    lines2.push("");
    lines2.push("  recommendation:");
    lines2.push(`    ${result6.recommendation}`);
  }
  return lines2.join("\n");
}
var init_format = __esm({
  "node_modules/@adlc/flail-detector/lib/format.mjs"() {
  }
});

// node_modules/@adlc/flail-detector/bin/flail-detector.mjs
var flail_detector_exports = {};
import { readFileSync as readFileSync20, existsSync as existsSync23 } from "node:fs";
var values2, positionals2, logFile, maxRepeat, maxBytes, scopes, hasSpentTokens, hasBudget, spentTokens, budget, raw, lines, bytes, analyzability, result2;
var init_flail_detector = __esm({
  "node_modules/@adlc/flail-detector/bin/flail-detector.mjs"() {
    init_core();
    init_gate_manifest();
    init_sign();
    init_parse_log();
    init_analyze();
    init_analyzability();
    init_format();
    ({ values: values2, positionals: positionals2 } = parseArgs({
      options: {
        scope: { type: "string", multiple: true },
        "max-repeat": { type: "string", default: "2" },
        "max-bytes": { type: "string" },
        "spent-tokens": { type: "string" },
        budget: { type: "string" },
        record: { type: "boolean", default: false },
        ticket: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false }
      }
    }));
    if (values2.help) {
      console.log(`flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--spent-tokens <n>] [--budget <n>] [--record] [--ticket <id>] [--json]

Session-log flail analysis (ADLC C6) \u2014 mechanical two-strike rule.

Arguments:
  <log-file>        Path to the session log file to analyze (required)

Options:
  --scope <glob>    Declared-scope glob pattern (repeatable). When given, file
                    paths in the log that fall outside ALL supplied globs are
                    flagged as scope violations.
  --max-repeat <n>  Trigger repeated-error signal when a normalized error
                    signature appears >= n times (default: 2).
  --max-bytes <n>   Trigger size signal when log exceeds n bytes (default: no limit).
  --spent-tokens <n> Measured token spend for this ticket (e.g. from
                    'adlc spend --ticket <id> --json'). Paired with --budget.
  --budget <n>      The ticket's declared token budget (ticket.budget, or
                    model-router's emitted per-ticket budget). Triggers the
                    budget signal when --spent-tokens exceeds it. Both flags
                    must be given together \u2014 with either omitted, the budget
                    signal stays silent rather than guessing (ADLC C6).
  --record          On a clean verdict, append a 'flail-check' manifest entry
                    to .adlc/manifest.jsonl (ADLC P4 evidence).
  --ticket <id>     Ticket to scope the recorded manifest entry to (optional;
                    recorded as null when omitted).
  --json            Machine-readable JSON output.
  --help            Show this help.

Signals detected:
  repeated-error  Error/exception lines whose normalized signature repeats >= --max-repeat
  scope-violation File paths in tool-log lines that fall outside --scope (only when given)
  edit-churn      Same file path appearing in >= 3 write/edit lines
  size            Log file byte count > --max-bytes (only when --max-bytes given)
  budget          --spent-tokens > --budget (only when both given)

Output:
  verdict: 'flail' | 'clean' | 'could-not-analyze'
  On flail: recommendation block \u2014 "Kill the session. Append these dead-ends..."
  could-not-analyze: the log had nothing to analyze (no non-empty lines).
                     This is an operational outcome, never a pass: nothing is
                     recorded even with --record, and the exit code is 1.

Exit codes:
  0  clean (gate passes)
  1  operational error (file not found, bad arguments, could-not-analyze)
  2  flail detected (gate fails)

ADLC phase: C6 / P4 supervisor
`);
      process.exit(0);
    }
    logFile = positionals2[0];
    if (!logFile) {
      opError("usage: flail-detector <log-file> [options] (use --help for details)");
    }
    if (!existsSync23(logFile)) {
      opError(`log file not found: ${logFile}`);
    }
    maxRepeat = parseInt(values2["max-repeat"], 10);
    if (!Number.isInteger(maxRepeat) || maxRepeat < 1) {
      opError("--max-repeat must be a positive integer");
    }
    maxBytes = null;
    if (values2["max-bytes"] !== void 0) {
      maxBytes = parseInt(values2["max-bytes"], 10);
      if (!Number.isInteger(maxBytes) || maxBytes < 0) {
        opError("--max-bytes must be a non-negative integer");
      }
    }
    scopes = values2.scope ?? [];
    hasSpentTokens = values2["spent-tokens"] !== void 0;
    hasBudget = values2.budget !== void 0;
    if (hasSpentTokens !== hasBudget) {
      opError("--spent-tokens and --budget must be given together (or neither)");
    }
    spentTokens = null;
    budget = null;
    if (hasSpentTokens) {
      spentTokens = parseInt(values2["spent-tokens"], 10);
      if (!Number.isInteger(spentTokens) || spentTokens < 0) {
        opError("--spent-tokens must be a non-negative integer");
      }
      budget = parseInt(values2.budget, 10);
      if (!Number.isInteger(budget) || budget < 0) {
        opError("--budget must be a non-negative integer");
      }
    }
    try {
      raw = readFileSync20(logFile, "utf8");
    } catch (err) {
      opError(`could not read log file: ${err.message}`);
    }
    ({ lines, bytes } = parseLog(raw));
    analyzability = assessAnalyzability({ lines });
    if (!analyzability.ok) {
      if (values2.json) {
        printJson({ verdict: "could-not-analyze", reasons: analyzability.reasons, bytes, signals: [] });
      } else {
        console.error(`flail-detector: could not analyze \u2014 ${analyzability.reasons.join("; ")}`);
      }
      process.exit(1);
    }
    result2 = analyze({ lines, bytes, scopes, maxRepeat, maxBytes, spentTokens, budget });
    if (values2.json) {
      printJson(result2);
    } else {
      console.log(formatResult(result2));
    }
    if (values2.record && result2.verdict !== "flail") {
      appendManifestEntry({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        type: "flail-check",
        ticket: values2.ticket ?? null,
        verdict: result2.verdict,
        logFile,
        logHash: sha256(raw)
      }, void 0, { key: getKey() });
    }
    process.exit(result2.verdict === "flail" ? 2 : 0);
  }
});

// node_modules/@adlc/hollow-test/lib/targets.mjs
import { readFileSync as readFileSync21 } from "node:fs";
import { resolve as resolve8 } from "node:path";
function isSupportedSourceExtension(file) {
  return SOURCE_EXT_RE.test(file);
}
function isMutableSource(file, { testGlobs: testGlobs2 = [], sourceGlobs: sourceGlobs2 = [] } = {}) {
  if (sourceGlobs2.some((g) => globMatch2(g, file))) {
    return SOURCE_EXT_RE.test(file);
  }
  if (EXCLUDE_DIR_RE.test(file)) return false;
  if (EXCLUDE_FILE_RE.test(file)) return false;
  if (testGlobs2.some((g) => globMatch2(g, file))) return false;
  return SOURCE_EXT_RE.test(file);
}
function filterTargetFiles(changedLines2, { testGlobs: testGlobs2 = [], sourceGlobs: sourceGlobs2 = [] } = {}) {
  return Object.keys(changedLines2).filter((f) => isMutableSource(f, { testGlobs: testGlobs2, sourceGlobs: sourceGlobs2 }));
}
function buildFileTargets(files2, changedLines2, maxTotal, cwd2, priorityFiles = []) {
  if (files2.length === 0) return [];
  const prioritySet = new Set(priorityFiles);
  const priorityInFiles = files2.filter((f) => prioritySet.has(f));
  const reserved = Math.min(priorityInFiles.length, maxTotal);
  const remaining = maxTotal - reserved;
  const reservedQuota = /* @__PURE__ */ new Map();
  priorityInFiles.forEach((f, i) => reservedQuota.set(f, i < reserved ? 1 : 0));
  const base3 = Math.floor(remaining / files2.length);
  const remainder = remaining % files2.length;
  return files2.map((file, idx) => ({
    file,
    absolutePath: resolve8(cwd2, file),
    targetLines: changedLines2[file],
    quota: (reservedQuota.get(file) ?? 0) + base3 + (idx < remainder ? 1 : 0)
  }));
}
function readFileSafe(absolutePath) {
  try {
    return readFileSync21(absolutePath, "utf8");
  } catch {
    return null;
  }
}
function readRailsFromTicketFile(absolutePath) {
  let raw2;
  try {
    raw2 = readFileSync21(absolutePath, "utf8");
  } catch (err) {
    throw new Error(`could not read ${absolutePath}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw2);
  } catch (err) {
    throw new Error(`invalid JSON in ${absolutePath}: ${err.message}`);
  }
  const rails = [];
  if (Array.isArray(data.rails)) rails.push(...data.rails);
  if (Array.isArray(data.tickets)) {
    for (const t of data.tickets) {
      if (t && Array.isArray(t.rails)) rails.push(...t.rails);
    }
  }
  return [...new Set(rails)];
}
function expandRailsToFiles(rails, allFiles) {
  if (!rails || rails.length === 0) return [];
  return allFiles.filter((file) => rails.some((glob) => globMatch2(glob, file)));
}
var EXCLUDE_DIR_RE, EXCLUDE_FILE_RE, SOURCE_EXT_RE;
var init_targets = __esm({
  "node_modules/@adlc/hollow-test/lib/targets.mjs"() {
    init_core();
    EXCLUDE_DIR_RE = /(?:^|\/)(?:tests?|specs?|__tests__)\//i;
    EXCLUDE_FILE_RE = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|(?:test|spec)\.[^/.]+|(?:test|spec)[-_][^/]+|[^/]*[-_](?:test|spec)\.[^/.]+)$/i;
    SOURCE_EXT_RE = /\.(?:mjs|cjs|js)$/i;
  }
});

// node_modules/@adlc/hollow-test/lib/inflight.mjs
import {
  openSync as openSync12,
  closeSync as closeSync12,
  writeFileSync as writeFileSync12,
  fchmodSync as fchmodSync2,
  renameSync as renameSync5,
  unlinkSync as unlinkSync8,
  readdirSync as readdirSync8,
  readFileSync as readFileSync22,
  existsSync as existsSync24,
  lstatSync as lstatSync14,
  statSync,
  chmodSync,
  realpathSync as realpathSync3
} from "node:fs";
import { basename as basename7, dirname as dirname18, join as join21, resolve as resolve9, relative as relative8, isAbsolute as isAbsolute6 } from "node:path";
import { randomBytes as randomBytes7 } from "node:crypto";
function probeOwner(pid, kill = process.kill.bind(process)) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    kill(pid, 0);
    return "alive";
  } catch (err) {
    if (err.code === "ESRCH") return "dead";
    if (err.code === "EPERM") return "alive";
    return "unknown";
  }
}
function ownerStateFor(recordPid, selfPid, probe = probeOwner) {
  if (recordPid === selfPid) return "dead";
  return probe(recordPid);
}
function isWellFormed(record2) {
  return record2 !== null && typeof record2 === "object" && record2.version === RECORD_VERSION && typeof record2.file === "string" && record2.file.length > 0 && typeof record2.original === "string" && typeof record2.mutated === "string";
}
function isContainedRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (isAbsolute6(relPath)) return false;
  if (relPath.split(/[\\/]/).includes("..")) return false;
  return true;
}
function decideRecovery({ ownerState, currentContent, record: record2 }) {
  if (ownerState !== "dead") {
    return {
      action: "skip",
      reason: ownerState === "alive" ? "another hollow-test run owns this record" : "ownership of this record could not be established"
    };
  }
  if (currentContent === record2.original) return { action: "none", reason: null };
  if (currentContent === record2.mutated) return { action: "restore", reason: null };
  return { action: "conflict", reason: "the file matches neither the original nor the mutant" };
}
function makeTempPath(path) {
  return `${path}.tmp-${process.pid}-${randomBytes7(8).toString("hex")}`;
}
function writeFileAtomic(path, contents, { tempPath = null } = {}) {
  let realPath = path;
  try {
    if (lstatSync14(path).isSymbolicLink()) realPath = realpathSync3(path);
  } catch {
  }
  let mode = null;
  try {
    mode = statSync(realPath).mode & 4095;
  } catch {
  }
  const tmp = tempPath ?? makeTempPath(realPath);
  const fd = openSync12(tmp, "wx");
  let created = true;
  let open = true;
  try {
    writeFileSync12(fd, contents);
    if (mode !== null) fchmodSync2(fd, mode);
    closeSync12(fd);
    open = false;
    renameSync5(tmp, realPath);
    created = false;
  } finally {
    if (open) {
      try {
        closeSync12(fd);
      } catch {
      }
    }
    if (created) {
      try {
        unlinkSync8(tmp);
      } catch {
      }
    }
  }
}
function writeRecord(recordPath, { pid, relFile, original, mutated }) {
  writeFileAtomic(
    recordPath,
    JSON.stringify({ version: RECORD_VERSION, pid, file: relFile, original, mutated })
  );
}
function readRecord(recordPath) {
  try {
    return JSON.parse(readFileSync22(recordPath, "utf8"));
  } catch {
    return null;
  }
}
function clearRecord(recordPath) {
  try {
    if (existsSync24(recordPath)) unlinkSync8(recordPath);
  } catch {
  }
}
function resolveTarget(repoRoot2, relFile) {
  if (!isContainedRelPath(relFile)) return null;
  const absolute = resolve9(repoRoot2, relFile);
  try {
    const rootReal2 = realpathSync3(repoRoot2);
    const targetReal = realpathSync3(absolute);
    const rel = relative8(rootReal2, targetReal);
    if (rel.startsWith("..") || isAbsolute6(rel)) return null;
    return targetReal;
  } catch {
    return null;
  }
}
function sweepStaleTemps(target, { probe = probeOwner } = {}) {
  const dir = dirname18(target);
  const prefix = `${basename7(target)}.tmp-`;
  let swept = 0;
  let entries;
  try {
    entries = readdirSync8(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number.parseInt(entry.slice(prefix.length).split("-")[0], 10);
    if (!Number.isInteger(pid) || probe(pid) !== "dead") continue;
    try {
      unlinkSync8(join21(dir, entry));
      swept += 1;
    } catch {
    }
  }
  return swept;
}
function recordPathFor(gitDir2) {
  return join21(gitDir2, INFLIGHT_BASENAME);
}
var INFLIGHT_BASENAME, RECORD_VERSION;
var init_inflight = __esm({
  "node_modules/@adlc/hollow-test/lib/inflight.mjs"() {
    INFLIGHT_BASENAME = "adlc-hollow-test-inflight.json";
    RECORD_VERSION = 2;
  }
});

// node_modules/@adlc/hollow-test/lib/runner.mjs
import { spawnSync } from "node:child_process";
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
function runTest(testCmd3, timeoutMs2, cwd2) {
  const result6 = spawnSync(testCmd3, {
    shell: true,
    cwd: cwd2,
    timeout: timeoutMs2,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: MAX_TEST_OUTPUT_BYTES,
    env: childEnv()
  });
  return classifyTestResult(result6);
}
function classifyTestResult(result6) {
  if (result6.error) {
    const code = result6.error.code;
    if (code === "ETIMEDOUT") return { status: null, timedOut: true, spawnFailed: false, reason: null };
    return { status: null, timedOut: false, spawnFailed: true, reason: code ?? result6.error.message };
  }
  if (result6.signal === "SIGTERM") return { status: null, timedOut: true, spawnFailed: false, reason: null };
  if (result6.signal) {
    return { status: null, timedOut: false, spawnFailed: true, reason: `unexpected signal ${result6.signal}` };
  }
  if (typeof result6.status !== "number") {
    return { status: null, timedOut: false, spawnFailed: true, reason: "no exit status" };
  }
  if (result6.status === 126 || result6.status === 127) {
    return {
      status: result6.status,
      timedOut: false,
      spawnFailed: true,
      reason: `shell could not launch the test command (exit ${result6.status})`
    };
  }
  return { status: result6.status, timedOut: false, spawnFailed: false, reason: null };
}
function runMutant(filePath, original, mutated, testCmd3, timeoutMs2, cwd2) {
  let trial;
  let invalid3;
  let syntax;
  try {
    writeFileAtomic(filePath, mutated);
    syntax = checkSyntax(filePath, cwd2);
    invalid3 = syntax === "invalid";
    if (syntax === "valid") trial = runTest(testCmd3, timeoutMs2, cwd2);
  } finally {
    writeFileAtomic(filePath, original);
  }
  if (syntax === "unknown") {
    return {
      killed: false,
      invalid: false,
      undetermined: true,
      reason: "syntax check did not run",
      timedOut: false,
      exitCode: null
    };
  }
  if (invalid3) {
    return { killed: false, invalid: true, undetermined: false, reason: null, timedOut: false, exitCode: null };
  }
  if (trial.spawnFailed) {
    return {
      killed: false,
      invalid: false,
      undetermined: true,
      reason: `test command did not run (${trial.reason})`,
      timedOut: false,
      exitCode: null
    };
  }
  const killed = trial.timedOut || trial.status !== 0;
  return {
    killed,
    invalid: false,
    undetermined: false,
    reason: null,
    timedOut: trial.timedOut,
    exitCode: trial.status
  };
}
function checkSyntax(filePath, cwd2, execPath = process.execPath) {
  const r = spawnSync(execPath, ["--check", filePath], {
    cwd: cwd2,
    encoding: "utf8",
    timeout: 3e4
  });
  if (r.error || r.signal || typeof r.status !== "number") return "unknown";
  return r.status === 0 ? "valid" : "invalid";
}
var MAX_TEST_OUTPUT_BYTES;
var init_runner = __esm({
  "node_modules/@adlc/hollow-test/lib/runner.mjs"() {
    init_inflight();
    MAX_TEST_OUTPUT_BYTES = 256 * 1024 * 1024;
  }
});

// node_modules/@adlc/hollow-test/lib/report.mjs
function printTable(results2) {
  if (results2.length === 0) return;
  const invalid3 = results2.filter((r) => r.invalid);
  const undetermined2 = results2.filter((r) => r.undetermined);
  const survivors3 = results2.filter((r) => !r.killed && !r.invalid && !r.undetermined);
  const killed = results2.filter((r) => r.killed && !r.invalid && !r.undetermined);
  console.log("");
  console.log("Mutation Results");
  console.log("=".repeat(72));
  for (const r of results2) {
    const status = r.undetermined ? "UNDETERMINED" : r.invalid ? "INVALID " : r.killed ? "KILLED  " : "SURVIVED";
    const loc = `${r.file}:${r.line}`;
    console.log(`${status}  ${loc}  [${r.operator}]`);
    if (!r.killed || r.invalid || r.undetermined) {
      console.log(`         original: ${r.original.trim()}`);
      console.log(`         mutated:  ${r.mutated.trim()}`);
    }
    if (r.invalid) {
      console.log("         (did not parse \u2014 discarded, not counted as a kill)");
    }
    if (r.undetermined) {
      console.log(`         (not scored \u2014 ${r.reason ?? "validity unknown"})`);
    }
  }
  console.log("");
  const invalidNote = invalid3.length > 0 ? `  Invalid: ${invalid3.length}` : "";
  const checkNote = undetermined2.length > 0 ? `  Undetermined: ${undetermined2.length}` : "";
  console.log(`Total: ${results2.length}  Killed: ${killed.length}  Survived: ${survivors3.length}${invalidNote}${checkNote}`);
  console.log("");
}
function buildJsonReport(results2) {
  const invalid3 = results2.filter((r) => r.invalid);
  const undetermined2 = results2.filter((r) => r.undetermined);
  const survivors3 = results2.filter((r) => !r.killed && !r.invalid && !r.undetermined);
  const killed = results2.filter((r) => r.killed && !r.invalid && !r.undetermined);
  return {
    tool: "hollow-test",
    summary: {
      total: results2.length,
      killed: killed.length,
      survived: survivors3.length,
      invalid: invalid3.length,
      undetermined: undetermined2.length
    },
    mutants: results2.map((r) => ({
      file: r.file,
      line: r.line,
      operator: r.operator,
      status: r.undetermined ? "undetermined" : r.invalid ? "invalid" : r.killed ? "killed" : "survived",
      // Why it could not be scored. Without this an undetermined trial is
      // indistinguishable from a tooling bug, and the operator cannot tell a
      // syntax-check failure from a test command that would not launch.
      ...r.undetermined && r.reason ? { reason: r.reason } : {},
      timedOut: r.timedOut,
      original: r.original,
      mutated: r.mutated
    }))
  };
}
var init_report = __esm({
  "node_modules/@adlc/hollow-test/lib/report.mjs"() {
  }
});

// node_modules/@adlc/hollow-test/bin/hollow-test.mjs
var hollow_test_exports = {};
import { readFileSync as readFileSync23, realpathSync as realpathSync4, existsSync as existsSync25 } from "node:fs";
import { resolve as resolve10, relative as relative9, isAbsolute as isAbsolute7, sep as sep7 } from "node:path";
function clearInflight() {
  if (inflightPath !== null) clearRecord(inflightPath);
}
function recoverInflight() {
  if (inflightPath === null) return null;
  const record2 = readRecord(inflightPath);
  if (record2 === null) return null;
  if (!isWellFormed(record2)) {
    clearInflight();
    return null;
  }
  const target = resolveTarget(root, record2.file);
  if (target === null) {
    console.warn(
      `hollow-test: ignoring an in-flight record naming ${record2.file}, which does not resolve to a regular file inside this repository`
    );
    return null;
  }
  sweepStaleTemps(target);
  let current;
  try {
    current = readFileSync23(target, "utf8");
  } catch {
    return null;
  }
  const ownerState = ownerStateFor(record2.pid, process.pid);
  const decision = decideRecovery({ ownerState, currentContent: current, record: record2 });
  if (decision.action === "none") {
    clearInflight();
    return null;
  }
  if (decision.action === "skip") {
    console.warn(
      `hollow-test: leaving ${record2.file} alone \u2014 ${decision.reason}. If the tree is dirty, that edit may be a mutant rather than your work`
    );
    return null;
  }
  if (decision.action === "conflict") {
    opError(
      `${record2.file} ${decision.reason}, so it was not restored. A previous run was interrupted while mutating it, and the file has changed since. The original bytes are preserved in ${inflightPath}: compare them with the file, keep whichever is correct, then delete that record to continue.`
    );
  }
  try {
    writeFileAtomic(target, record2.original);
  } catch (err) {
    opError(
      `could not restore ${record2.file} from the in-flight record: ${err.message}. The original bytes are preserved in ${inflightPath}`
    );
  }
  clearInflight();
  return { file: record2.file, pid: record2.pid ?? null };
}
function escapesRoot(relPath) {
  return relPath === "" || relPath.split(sep7)[0] === ".." || isAbsolute7(relPath);
}
function symlinkEscapesRoot(absolutePath) {
  let real;
  try {
    real = realpathSync4(absolutePath);
  } catch {
    return null;
  }
  const rel = relative9(rootReal, real);
  return escapesRoot(rel) ? real : null;
}
function emergencyRestore() {
  let restored = true;
  if (currentFilePath !== null && currentOriginal !== null) {
    try {
      writeFileAtomic(currentFilePath, currentOriginal);
    } catch {
      restored = false;
    }
  }
  if (restored) clearInflight();
}
var values3, testCmd, testGlobs, sourceGlobs, maxMutants, timeoutMs, useJson, cwd, root, gitDir, inflightPath, recoveredInflight, rootReal, base2, baseline, diff2, changedLines, diffEligibleFiles, explicitTargets, railsGlobs, railsFiles, explicitFiles, mutableExplicitFiles, effectiveChangedLines, unsupportedTargets, droppedRails, mutableRails, allTargetFiles, fileTargets, starvedByBudget, currentFilePath, currentOriginal, shuttingDown, results, unreadableTargets, filesWithResults, undetermined, survivors, invalidMutants, validByFile, attempted, quotaByFile, starved, noMutableLines, unchecked;
var init_hollow_test = __esm({
  "node_modules/@adlc/hollow-test/bin/hollow-test.mjs"() {
    init_core();
    init_core();
    init_targets();
    init_runner();
    init_inflight();
    init_report();
    ({ values: values3 } = parseArgs({
      options: {
        "test-cmd": { type: "string" },
        base: { type: "string" },
        max: { type: "string", default: "20" },
        "timeout-ms": { type: "string", default: "120000" },
        target: { type: "string", multiple: true },
        rails: { type: "string", multiple: true },
        // Extra globs to treat as tests, for projects whose convention this tool
        // cannot infer. The built-in rules cover directory segments and the dotted,
        // exact and snake basename forms; HYPHENATED names (foo-test.js, spec-foo.js)
        // are deliberately excluded from the defaults because a hyphen cannot
        // distinguish a test convention from a product name — `hollow-test.mjs` and
        // `spec-lint.mjs` are production files in this very repo. Rather than guess,
        // let a caller whose project uses that convention declare it:
        //   --test-glob '**/*-test.js'
        "test-glob": { type: "string", multiple: true },
        "source-glob": { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false }
      }
    }));
    if (values3.help || !values3["test-cmd"]) {
      console.log(`
hollow-test \u2014 diff-scoped mutation gate (ADLC C4)

Usage:
  hollow-test --test-cmd "node --test test/" [options]

Options:
  --test-cmd <cmd>      (required) Shell command to run the test suite
  --base <ref>          Git base ref for diff (default: merge-base with
                        main/master; fails closed if none can be resolved)
  --max <n>             Max mutants across all files (default: 20)
  --timeout-ms <n>      Test command timeout in ms (default: 120000)
  --target <file>       Mutate this file directly, independent of the diff
                        (repeatable; bypasses the test/spec path exclusion).
                        Use for characterization/rails-authoring tickets
                        where the behavior file isn't in the diff. Must
                        resolve inside the repository root; paths that
                        escape it (e.g. via ../../) are refused.
  --rails <ticket-file> Path to a ticket JSON file; its declared "rails"
                        globs are expanded against tracked files and added
                        as mutation targets (repeatable).
  --json                Machine-readable JSON output
  --help                Show this help

Exit codes:
  0  All mutants killed (gate passes)
  1  Operational error (dirty tree, not a git repo, bad args, nothing to mutate,
     the in-flight record could not be written)
  2  One or more mutants survived (hollow coverage)
`);
      process.exit(values3.help ? 0 : 1);
    }
    testCmd = values3["test-cmd"];
    testGlobs = values3["test-glob"] ?? [];
    sourceGlobs = values3["source-glob"] ?? [];
    maxMutants = parseInt(values3.max, 10);
    timeoutMs = parseInt(values3["timeout-ms"], 10);
    useJson = values3.json;
    cwd = process.cwd();
    if (isNaN(maxMutants) || maxMutants < 1) opError("--max must be a positive integer");
    if (isNaN(timeoutMs) || timeoutMs < 1) opError("--timeout-ms must be a positive integer");
    if (!isGitRepo(cwd)) {
      opError("not a git repository");
    }
    try {
      root = repoRoot(cwd);
    } catch (err) {
      opError(`could not resolve repository root: ${err.message}`);
    }
    try {
      gitDir = resolve10(cwd, git(["rev-parse", "--git-dir"], { cwd }).trim());
    } catch (err) {
      opError(`could not resolve the git directory (${err.message}) \u2014 refusing to mutate without a recovery record`);
    }
    if (!existsSync25(gitDir)) {
      opError(`the resolved git directory does not exist (${gitDir}) \u2014 refusing to mutate without a recovery record`);
    }
    inflightPath = recordPathFor(gitDir);
    recoveredInflight = recoverInflight();
    if (recoveredInflight !== null && !useJson) {
      console.warn(
        `hollow-test: restored ${recoveredInflight.file} from an interrupted run (pid ${recoveredInflight.pid}) \u2014 that edit was a mutant, not your work`
      );
    }
    if (isDirty(cwd)) {
      opError("commit or stash first \u2014 hollow-test mutates files in place and restores them");
    }
    try {
      rootReal = realpathSync4(root);
    } catch (err) {
      opError(`could not resolve real path of repository root: ${err.message}`);
    }
    base2 = values3.base;
    if (base2 === void 0) {
      base2 = resolveBase(cwd);
      if (base2 === null) {
        opError(
          "could not resolve a base ref (no main/master/origin trunk found) \u2014 pass --base <ref> explicitly so the diff is non-empty"
        );
      }
    }
    baseline = runTest(testCmd, timeoutMs, cwd);
    if (baseline.status !== 0) {
      const reason = baseline.timedOut ? "timed out" : baseline.spawnFailed ? `could not run the test command: ${baseline.reason}` : `exit ${baseline.status}`;
      opError(
        `baseline suite is not green (${reason}) \u2014 cannot measure mutation kill; fix the suite / --test-cmd first`
      );
    }
    try {
      diff2 = gitDiff(base2, cwd);
    } catch (err) {
      opError(`git diff failed: ${err.message}`);
    }
    changedLines = mutate_exports.changedLinesFromDiff(diff2);
    diffEligibleFiles = filterTargetFiles(changedLines, { testGlobs, sourceGlobs });
    explicitTargets = (values3.target ?? []).map((t) => {
      const abs = resolve10(cwd, t);
      const rel = relative9(root, abs);
      if (escapesRoot(rel)) {
        opError(
          `--target ${t} resolves outside the repository root (${root}) \u2014 refusing to read or mutate it`
        );
      }
      const realEscape = symlinkEscapesRoot(abs);
      if (realEscape !== null) {
        opError(
          `--target ${t} resolves inside the repository root textually but escapes it via a symlink (real path: ${realEscape}) \u2014 refusing to read or mutate it`
        );
      }
      return rel;
    });
    railsGlobs = [];
    for (const ticketFile of values3.rails ?? []) {
      let globs;
      try {
        globs = readRailsFromTicketFile(resolve10(cwd, ticketFile));
      } catch (err) {
        opError(`--rails ${ticketFile}: ${err.message}`);
      }
      if (globs.length === 0) {
        opError(`--rails ${ticketFile}: no "rails" declared (expected a non-empty array of paths/globs)`);
      }
      railsGlobs.push(...globs);
    }
    railsFiles = [];
    if (railsGlobs.length > 0) {
      let allFiles;
      try {
        allFiles = git(["ls-files", "--full-name"], { cwd }).split("\n").filter(Boolean);
      } catch (err) {
        opError(`git ls-files failed: ${err.message}`);
      }
      railsFiles = expandRailsToFiles(railsGlobs, allFiles);
      if (railsFiles.length === 0) {
        opError(`--rails declared globs matched no tracked files: ${railsGlobs.join(", ")}`);
      }
      for (const f of railsFiles) {
        const realEscape = symlinkEscapesRoot(resolve10(root, f));
        if (realEscape !== null) {
          opError(
            `--rails matched ${f}, which resolves inside the repository root textually but escapes it via a symlink (real path: ${realEscape}) \u2014 refusing to read or mutate it`
          );
        }
      }
    }
    explicitFiles = [.../* @__PURE__ */ new Set([...explicitTargets, ...railsFiles])];
    mutableExplicitFiles = [.../* @__PURE__ */ new Set([...explicitTargets, ...railsFiles.filter(isSupportedSourceExtension)])];
    for (const f of explicitFiles) {
      if (readFileSafe(resolve10(root, f)) === null) {
        opError(
          `--target/--rails file not found or unreadable: ${f} \u2014 a mistyped path, deleted/renamed file, or stale rails entry would otherwise silently produce a vacuous 0-mutant pass`
        );
      }
    }
    if (diffEligibleFiles.length === 0 && explicitFiles.length === 0) {
      opError(
        "nothing to mutate \u2014 the diff contains no eligible source files (only test/spec/non-code files changed). Pass --target <file> or --rails <ticket-file> to declare mutation target(s) explicitly (e.g. for a rails-authoring or characterization-test ticket)."
      );
    }
    effectiveChangedLines = { ...changedLines };
    for (const f of explicitFiles) delete effectiveChangedLines[f];
    unsupportedTargets = explicitTargets.filter((f) => !isSupportedSourceExtension(f));
    if (unsupportedTargets.length > 0) {
      opError(
        `--target ${unsupportedTargets.join(", ")} is not a supported source language \u2014 mutation operators are JS/TS-shaped, and mutating another language yields syntactically invalid code that is scored as "killed" rather than testing anything.`
      );
    }
    droppedRails = railsFiles.filter((f) => !isSupportedSourceExtension(f));
    if (droppedRails.length > 0) {
      console.warn(
        `hollow-test: ${droppedRails.length} --rails match(es) are not a supported source language and will not be mutated: ${droppedRails.join(", ")}`
      );
    }
    mutableRails = railsFiles.filter(isSupportedSourceExtension);
    if (railsFiles.length > 0 && mutableRails.length === 0) {
      opError(
        `--rails matched ${railsFiles.length} file(s), none of which are a supported source language (${[...new Set(railsFiles.map((f) => f.replace(/^.*(\.[^.]*)$/, "$1")))].join(", ")}) \u2014 nothing could be mutated, which would otherwise report a vacuous pass.`
      );
    }
    allTargetFiles = [.../* @__PURE__ */ new Set([...diffEligibleFiles, ...mutableExplicitFiles])];
    fileTargets = buildFileTargets(allTargetFiles, effectiveChangedLines, maxMutants, root, mutableExplicitFiles);
    starvedByBudget = fileTargets.filter(
      (t) => mutableExplicitFiles.includes(t.file) && t.quota === 0
    );
    if (starvedByBudget.length > 0) {
      opError(
        `--max ${maxMutants} is too small to allocate mutation budget to explicit target(s): ${starvedByBudget.map((t) => t.file).join(", ")} \u2014 increase --max to at least ${mutableExplicitFiles.length}, or reduce the number of explicit --target/--rails files`
      );
    }
    currentFilePath = null;
    currentOriginal = null;
    shuttingDown = false;
    process.on("SIGINT", () => {
      if (shuttingDown) return;
      shuttingDown = true;
      emergencyRestore();
      process.exit(1);
    });
    results = [];
    unreadableTargets = /* @__PURE__ */ new Set();
    for (const target of fileTargets) {
      const content = readFileSafe(target.absolutePath);
      if (content === null) {
        unreadableTargets.add(target.file);
        if (!useJson) {
          console.warn(`warning: could not read ${target.file} \u2014 skipping`);
        }
        continue;
      }
      const mutants = mutate_exports.generateMutants(content, {
        targetLines: target.targetLines,
        maxMutants: target.quota
      });
      for (const mutant of mutants) {
        let mutatedContent;
        try {
          mutatedContent = mutate_exports.applyMutant(content, mutant);
        } catch (err) {
          if (!useJson) {
            console.warn(`warning: could not apply mutant at ${target.file}:${mutant.line} \u2014 ${err.message}`);
          }
          continue;
        }
        currentFilePath = target.absolutePath;
        currentOriginal = content;
        if (inflightPath !== null) {
          try {
            writeRecord(inflightPath, {
              pid: process.pid,
              relFile: relative9(root, target.absolutePath),
              original: content,
              mutated: mutatedContent
            });
          } catch (err) {
            opError(
              `could not write the in-flight record (${err.message}) \u2014 refusing to mutate ${target.file}, because a run interrupted now could not be recovered`
            );
          }
        }
        const trial = runMutant(
          target.absolutePath,
          content,
          mutatedContent,
          testCmd,
          timeoutMs,
          cwd
        );
        currentFilePath = null;
        currentOriginal = null;
        clearInflight();
        results.push({
          file: target.file,
          line: mutant.line,
          operator: mutant.operator,
          killed: trial.killed,
          invalid: trial.invalid === true,
          undetermined: trial.undetermined === true,
          reason: trial.reason ?? null,
          timedOut: trial.timedOut,
          original: mutant.original,
          mutated: mutant.mutated
        });
      }
    }
    filesWithResults = new Set(results.map((r) => r.file));
    if (mutableExplicitFiles.length > 0) {
      const starvedExplicitFiles = mutableExplicitFiles.filter((f) => !filesWithResults.has(f));
      if (starvedExplicitFiles.length > 0) {
        opError(
          `explicit --target/--rails file(s) produced zero mutants \u2014 ${starvedExplicitFiles.join(", ")}: no mutable line was found (comment-only, blank, or a shape none of the mutation operators recognize). The requested target was never actually verified; refusing to report a pass.`
        );
      }
    }
    if (diffEligibleFiles.length > 0 && results.length === 0) {
      const noMutantFiles = diffEligibleFiles.filter((f) => !unreadableTargets.has(f));
      const unreadableFiles = diffEligibleFiles.filter((f) => unreadableTargets.has(f));
      const parts = [];
      if (noMutantFiles.length > 0) {
        parts.push(
          `${noMutantFiles.join(", ")}: no mutable line was found (comment-only, blank, or a shape none of the mutation operators recognize)`
        );
      }
      if (unreadableFiles.length > 0) {
        parts.push(`${unreadableFiles.join(", ")}: could not be read`);
      }
      opError(
        "diff-derived file(s) produced zero mutants \u2014 " + parts.join("; ") + ". The changed code was never actually verified; refusing to report a pass."
      );
    }
    undetermined = results.filter((r) => r.undetermined);
    if (undetermined.length > 0) {
      const where = undetermined.map((r) => `${r.file}:${r.line}${r.reason ? ` (${r.reason})` : ""}`).join(", ");
      opError(
        `could not syntax-check ${undetermined.length} mutant(s) (${where}) \u2014 the checker did not run to completion, so whether they were valid is unknown. Refusing to score them: treating an unknown as valid is how an unparseable mutant gets credited as a kill (#293).`
      );
    }
    survivors = results.filter((r) => !r.killed && !r.invalid);
    invalidMutants = results.filter((r) => r.invalid);
    if (useJson) {
      printJson({
        ...buildJsonReport(results),
        ...recoveredInflight !== null ? { recovered: recoveredInflight } : {}
      });
    } else {
      printTable(results);
    }
    if (results.length === 0 && (diffEligibleFiles.length > 0 || mutableExplicitFiles.length > 0)) {
      opError("no mutants were generated and no target was selected \u2014 refusing to report a pass.");
    }
    validByFile = new Map(fileTargets.map((t) => [t.file, 0]));
    for (const r of results) {
      const prev = validByFile.get(r.file) ?? 0;
      validByFile.set(r.file, prev + (r.invalid || r.undetermined ? 0 : 1));
    }
    attempted = new Set(results.map((r) => r.file));
    quotaByFile = new Map(fileTargets.map((t) => [t.file, t.quota]));
    starved = [...validByFile.keys()].filter((f) => !attempted.has(f) && (quotaByFile.get(f) ?? 0) === 0);
    noMutableLines = [...validByFile.keys()].filter((f) => !attempted.has(f) && (quotaByFile.get(f) ?? 0) > 0);
    if (starved.length > 0) {
      const otherEvidence = results.length > 0 ? ` (${results.length} mutant(s) elsewhere in this diff already ran and were killed)` : "";
      opError(
        `${starved.length} selected file(s) received no mutation budget and were NOT prosecuted: ${starved.join(", ")} \u2014 raise --max to cover them.${otherEvidence}`
      );
    }
    if (noMutableLines.length > 0) {
      console.warn(
        `hollow-test: ${noMutableLines.length} selected file(s) had budget but no mutable lines (comments, imports, blank): ${noMutableLines.join(", ")}`
      );
    }
    unchecked = [...validByFile.entries()].filter(([f, valid]) => valid === 0 && attempted.has(f)).map(([f]) => f);
    if (unchecked.length > 0) {
      const named = unchecked.filter((f) => mutableExplicitFiles.includes(f));
      opError(
        `every mutant generated for ${unchecked.join(", ")} was syntactically invalid \u2014 no test ran against ${unchecked.length === 1 ? "it" : "them"}, so this run says nothing about ${named.length > 0 ? "the file(s) you asked to prosecute" : "those changed file(s)"}. Raise --max so a valid mutant is reached (see #293).`
      );
    }
    if (invalidMutants.length === results.length) {
      const msg = `every one of the ${results.length} generated mutant(s) was syntactically invalid, so no assertion was ever exercised \u2014 this run proves nothing. Line-based operators can produce unparseable code on multiline constructs (see issue #293); raise --max so a valid mutant is reached, or narrow --target to a file with mutable single-line logic.`;
      if (useJson) {
        console.error(`error: ${msg}`);
        process.exit(1);
      }
      opError(msg);
    }
    if (survivors.length > 0) {
      const failMsg = `hollow coverage \u2014 ${survivors.length} mutation(s) pass your tests`;
      if (useJson) {
        process.exit(2);
      }
      gateFail(failMsg);
    }
    pass(useJson ? void 0 : "All mutants killed \u2014 coverage gate passes");
  }
});

// node_modules/@adlc/consensus-fix/lib/hunks.mjs
function validateHunk(hunk, totalLines) {
  if (!hunk || typeof hunk !== "object") return "hunk must be an object";
  const { startLine, endLine, replacement } = hunk;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return "startLine and endLine must be integers";
  }
  if (startLine < 1) return `startLine must be >= 1, got ${startLine}`;
  if (endLine < startLine - 1) return `endLine (${endLine}) must be >= startLine - 1 (${startLine - 1})`;
  if (endLine > totalLines) return `endLine (${endLine}) exceeds file length (${totalLines} lines)`;
  if (typeof replacement !== "string") return "replacement must be a string";
  return null;
}
function applyHunks(content, hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return { ok: false, error: "hunks must be a non-empty array" };
  }
  const lines2 = content.split("\n");
  const totalLines = lines2.length;
  for (const hunk of hunks) {
    const reason = validateHunk(hunk, totalLines);
    if (reason) return { ok: false, error: reason };
  }
  const ascending = [...hunks].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < ascending.length; i++) {
    if (ascending[i].startLine <= ascending[i - 1].endLine) {
      return { ok: false, error: `hunks overlap at line ${ascending[i].startLine}` };
    }
  }
  const descending = [...hunks].sort((a, b) => b.startLine - a.startLine);
  let result6 = lines2;
  for (const hunk of descending) {
    const before = result6.slice(0, hunk.startLine - 1);
    const after = result6.slice(hunk.endLine);
    const replacementLines = hunk.replacement === "" ? [] : hunk.replacement.split("\n");
    result6 = [...before, ...replacementLines, ...after];
  }
  return { ok: true, content: result6.join("\n") };
}
function hunkChangedLines(hunk) {
  const originalSpan = Math.max(0, hunk.endLine - hunk.startLine + 1);
  const replacementSpan = hunk.replacement === "" ? 0 : hunk.replacement.split("\n").length;
  return Math.max(originalSpan, replacementSpan);
}
function totalHunkChangedLines(changes) {
  let total = 0;
  for (const { hunks } of changes) {
    for (const hunk of hunks ?? []) {
      total += hunkChangedLines(hunk);
    }
  }
  return total;
}
var init_hunks = __esm({
  "node_modules/@adlc/consensus-fix/lib/hunks.mjs"() {
  }
});

// node_modules/@adlc/consensus-fix/lib/snapshot.mjs
import { readFileSync as readFileSync24, writeFileSync as writeFileSync13 } from "node:fs";
function takeSnapshot(paths) {
  const snap = {};
  for (const p of paths) {
    snap[p] = readFileSync24(p, "utf8");
  }
  return snap;
}
function restoreSnapshot(snapshot) {
  const errors = [];
  for (const [p, content] of Object.entries(snapshot)) {
    try {
      writeFileSync13(p, content, "utf8");
    } catch (err) {
      errors.push(`restore failed for ${p}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
function applyChanges(changes, snapshot) {
  for (const { file, hunks } of changes) {
    if (!(file in snapshot)) {
      throw new Error(`candidate referenced file not in provided list: ${file}`);
    }
    const result6 = applyHunks(snapshot[file], hunks);
    if (!result6.ok) return { ok: false, error: `${file}: ${result6.error}` };
    writeFileSync13(file, result6.content, "utf8");
  }
  return { ok: true };
}
var init_snapshot2 = __esm({
  "node_modules/@adlc/consensus-fix/lib/snapshot.mjs"() {
    init_hunks();
  }
});

// node_modules/@adlc/consensus-fix/lib/agreement.mjs
function normalizeContent(str) {
  return str.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).join("\n");
}
function hunkKey(hunk) {
  return `${hunk.startLine}-${hunk.endLine}::${normalizeContent(hunk.replacement)}`;
}
function changesetKey(changes) {
  const sorted = [...changes].sort((a, b) => a.file.localeCompare(b.file));
  return sorted.map(({ file, hunks }) => {
    const sortedHunks = [...hunks].sort((a, b) => a.startLine - b.startLine);
    return `${file}::${sortedHunks.map(hunkKey).join("|")}`;
  }).join("\0");
}
function groupByChangeset(candidates) {
  const groups2 = /* @__PURE__ */ new Map();
  for (const c of candidates) {
    const key = changesetKey(c.changes);
    if (!groups2.has(key)) groups2.set(key, []);
    groups2.get(key).push(c);
  }
  return groups2;
}
function selectWinner(groups2) {
  if (groups2.size === 0) return null;
  let largestGroup = null;
  let largestSize = 0;
  for (const group of groups2.values()) {
    if (group.length > largestSize) {
      largestSize = group.length;
      largestGroup = group;
    }
  }
  const winner = largestGroup.reduce((best, c) => {
    if (c.changedLines < best.changedLines) return c;
    if (c.changedLines === best.changedLines && c.index < best.index) return c;
    return best;
  });
  return { winner, largestGroupSize: largestSize, totalGroups: groups2.size };
}
function isAllDivergent(groups2, n2) {
  if (n2 < 3) return false;
  for (const group of groups2.values()) {
    if (group.length > 1) return false;
  }
  return true;
}
var init_agreement = __esm({
  "node_modules/@adlc/consensus-fix/lib/agreement.mjs"() {
  }
});

// node_modules/@adlc/consensus-fix/lib/region.mjs
function extractLineReferences(testOutput, basename8) {
  const escaped = basename8.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}:(\\d+)`, "g");
  const lines2 = /* @__PURE__ */ new Set();
  let match;
  while ((match = re.exec(testOutput)) !== null) {
    const n2 = Number(match[1]);
    if (Number.isInteger(n2) && n2 > 0) lines2.add(n2);
  }
  return [...lines2].sort((a, b) => a - b);
}
function buildWindows(refLines, totalLines, contextLines) {
  if (refLines.length === 0) return [];
  const raw2 = refLines.map((n2) => [Math.max(1, n2 - contextLines), Math.min(totalLines, n2 + contextLines)]).sort((a, b) => a[0] - b[0]);
  const merged = [raw2[0]];
  for (let i = 1; i < raw2.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = raw2[i];
    if (start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}
function renderExcerpt(content, windows) {
  const lines2 = content.split("\n");
  const out = [];
  let prevEnd = 0;
  for (const [start, end] of windows) {
    if (start > prevEnd + 1) out.push(`... ${start - prevEnd - 1} line(s) omitted ...`);
    for (let i = start; i <= end; i++) out.push(`${i}: ${lines2[i - 1]}`);
    prevEnd = end;
  }
  if (prevEnd < lines2.length) out.push(`... ${lines2.length - prevEnd} line(s) omitted ...`);
  return out.join("\n");
}
function buildFileExcerpt({
  content,
  testOutput,
  filePath,
  contextLines = 15,
  smallFileLineThreshold = 40,
  fallbackMaxChars = 6e3
} = {}) {
  const lines2 = content.split("\n");
  const totalLines = lines2.length;
  if (totalLines <= smallFileLineThreshold) {
    return { text: content, totalLines, windowed: false };
  }
  const basename8 = filePath.split("/").pop();
  const refLines = extractLineReferences(testOutput, basename8);
  if (refLines.length > 0) {
    const windows = buildWindows(refLines, totalLines, contextLines);
    return { text: renderExcerpt(content, windows), totalLines, windowed: true };
  }
  const tailed = tail(content, fallbackMaxChars);
  return { text: tailed, totalLines, windowed: tailed.length < content.length };
}
var init_region = __esm({
  "node_modules/@adlc/consensus-fix/lib/region.mjs"() {
    init_prompt2();
  }
});

// node_modules/@adlc/consensus-fix/lib/prompt.mjs
function buildPrompt({ testCmd: testCmd3, testOutput, snapshot }) {
  const tailedOutput = tail(testOutput, 4e3);
  const fileBlocks = Object.entries(snapshot).map(([path, content]) => {
    const excerpt = buildFileExcerpt({ content, testOutput, filePath: path });
    const note = excerpt.windowed ? ` (excerpt \u2014 file has ${excerpt.totalLines} lines total; line numbers shown below are the REAL file's line numbers)` : ` (${excerpt.totalLines} lines, shown in full)`;
    return `### ${path}${note}
\`\`\`
${excerpt.text}
\`\`\``;
  }).join("\n\n");
  return [
    `This test command fails:`,
    `\`\`\``,
    testCmd3,
    `\`\`\``,
    ``,
    `Test output (last 4000 chars):`,
    `\`\`\``,
    tailedOutput,
    `\`\`\``,
    ``,
    `Source files:`,
    ``,
    fileBlocks,
    ``,
    `Produce a MINIMAL fix. Output JSON with this exact shape:`,
    `{"changes": [{"file": "<path>", "hunks": [{"startLine": <n>, "endLine": <n>, "replacement": "<new lines>"}]}]}`,
    ``,
    `Rules:`,
    `- Only include files that actually need changes.`,
    `- Use only the file paths listed above.`,
    `- startLine/endLine are 1-indexed, INCLUSIVE line numbers in the file's REAL numbering`,
    `  (shown in the excerpts above \u2014 a windowed excerpt still uses the file's true line`,
    `  numbers, not excerpt-relative ones).`,
    `- "replacement" is the new text for that exact line range \u2014 it may span more or fewer`,
    `  lines than the original range, or be an empty string to delete the range entirely.`,
    `- To INSERT lines without deleting any, set endLine = startLine - 1 (a zero-length range`,
    `  means "insert replacement immediately before startLine").`,
    `- A file may need more than one hunk; hunks in the same file must not overlap.`,
    `- Output ONLY valid JSON. No prose before or after.`
  ].join("\n");
}
var init_prompt2 = __esm({
  "node_modules/@adlc/consensus-fix/lib/prompt.mjs"() {
    init_region();
    init_core();
  }
});

// node_modules/@adlc/consensus-fix/lib/runner.mjs
import { execFileSync as execFileSync9 } from "node:child_process";
function runCommand(cmd) {
  try {
    const stdout2 = execFileSync9("sh", ["-c", cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { exitCode: 0, output: stdout2 };
  } catch (err) {
    const output = (err.stdout ?? "") + (err.stderr ?? "");
    return { exitCode: err.status ?? 1, output };
  }
}
function isWellFormedHunk(hunk) {
  return hunk && typeof hunk === "object" && Number.isInteger(hunk.startLine) && Number.isInteger(hunk.endLine) && typeof hunk.replacement === "string";
}
function validateCandidate(parsed, allowedPaths) {
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, reason: "response is not an object" };
  }
  if (!Array.isArray(parsed.changes)) {
    return { valid: false, reason: 'missing or non-array "changes" field' };
  }
  if (parsed.changes.length === 0) {
    return { valid: false, reason: "candidate proposes no changes" };
  }
  const allowedSet = new Set(allowedPaths);
  for (const change of parsed.changes) {
    if (typeof change.file !== "string" || !Array.isArray(change.hunks)) {
      return { valid: false, reason: 'each change must have a string "file" and an array "hunks"' };
    }
    if (!allowedSet.has(change.file)) {
      return { valid: false, reason: `file "${change.file}" is not in the provided list` };
    }
    if (change.hunks.length === 0) {
      return { valid: false, reason: `file "${change.file}" has an empty "hunks" array` };
    }
    if (!change.hunks.every(isWellFormedHunk)) {
      return { valid: false, reason: `file "${change.file}" has a malformed hunk (need integer startLine/endLine and string replacement)` };
    }
  }
  return { valid: true, changes: parsed.changes };
}
async function runConsensusFix({
  testCmd: testCmd3,
  files: files2,
  n: n2,
  tier: tier2,
  completeFn: completeFn2,
  providerNames: providerNames2,
  railsCmd: railsCmd2,
  onProgress = () => {
  }
}) {
  const fanWidth2 = providerNames2 ? providerNames2.length : n2;
  const railsChecked2 = Boolean(railsCmd2);
  if (!railsChecked2) {
    onProgress(
      'WARNING: no --rails command supplied \u2014 candidates are NOT checked against the full rails. A fix that reddens other tests/types can still survive. Pass --rails "<full suite>" to close this regression gate.'
    );
  }
  onProgress("Running test to confirm failure...");
  const initialRun = runCommand(testCmd3);
  if (initialRun.exitCode === 0) {
    throw Object.assign(new Error("test already passes \u2014 nothing to fix"), { isOpError: true });
  }
  const testOutput = initialRun.output;
  onProgress(`Test failed (exit ${initialRun.exitCode}). Capturing output.`);
  const snapshot = takeSnapshot(files2);
  onProgress(`Snapshot taken for ${files2.length} file(s).`);
  const prompt = buildPrompt({ testCmd: testCmd3, testOutput, snapshot });
  onProgress(
    providerNames2 ? `Fanning ${fanWidth2} completions across providers [${providerNames2.join(", ")}] (tier: ${tier2})...` : `Fanning ${fanWidth2} completions (tier: ${tier2})...`
  );
  const rawResponses = await Promise.allSettled(
    providerNames2 ? providerNames2.map((name) => completeFn2(prompt, name)) : Array.from({ length: fanWidth2 }, () => completeFn2(prompt))
  );
  const results2 = [];
  for (let i = 0; i < rawResponses.length; i++) {
    const res = rawResponses[i];
    const provider = providerNames2 ? providerNames2[i] : void 0;
    onProgress(`Evaluating candidate ${i + 1}/${fanWidth2}...`);
    if (res.status !== "fulfilled") {
      results2.push({
        index: i,
        discarded: true,
        reason: `LLM call failed: ${res.reason}`,
        provider
      });
      continue;
    }
    let parsed;
    try {
      parsed = extractJson(res.value);
    } catch (err) {
      results2.push({
        index: i,
        discarded: true,
        reason: `JSON parse failed: ${err.message}`,
        provider
      });
      continue;
    }
    const validation = validateCandidate(parsed, files2);
    if (!validation.valid) {
      results2.push({
        index: i,
        discarded: true,
        reason: `validation failed: ${validation.reason}`,
        provider
      });
      continue;
    }
    const { changes } = validation;
    let testPassed = false;
    let railsPassed = false;
    let testRunOutput = "";
    let railsRunOutput = "";
    let applyError = null;
    try {
      const applyResult = applyChanges(changes, snapshot);
      if (!applyResult.ok) {
        applyError = applyResult.error;
      } else {
        const testRun = runCommand(testCmd3);
        testPassed = testRun.exitCode === 0;
        testRunOutput = testRun.output;
        if (!railsChecked2) {
          railsPassed = true;
        } else if (testPassed) {
          const railsRun = runCommand(railsCmd2);
          railsPassed = railsRun.exitCode === 0;
          railsRunOutput = railsRun.output;
        }
      }
    } finally {
      restoreSnapshot(snapshot);
    }
    if (applyError) {
      results2.push({
        index: i,
        discarded: true,
        reason: `hunk apply failed: ${applyError}`,
        provider
      });
      onProgress(`  Candidate ${i + 1}: DISCARDED (hunk apply failed: ${applyError})`);
      continue;
    }
    const changedLines2 = totalHunkChangedLines(changes);
    const passed = testPassed && railsPassed;
    results2.push({
      index: i,
      discarded: false,
      changes,
      changedLines: changedLines2,
      passed,
      testPassed,
      railsPassed,
      railsChecked: railsChecked2,
      testRunOutput,
      railsRunOutput,
      provider
    });
    let label;
    if (passed) {
      label = railsChecked2 ? "PASS (repro+rails)" : "PASS (repro; rails unchecked)";
    } else if (testPassed && !railsPassed) {
      label = "REJECTED (repro passed but rails reddened)";
    } else {
      label = "FAIL (repro)";
    }
    onProgress(`  Candidate ${i + 1}: ${label} | ${changedLines2} changed line(s)`);
  }
  const survivors3 = results2.filter((r) => !r.discarded && r.passed);
  const discarded2 = results2.filter((r) => r.discarded);
  const failed2 = results2.filter((r) => !r.discarded && !r.passed);
  onProgress(
    `Survivors: ${survivors3.length} | Failed: ${failed2.length} | Discarded: ${discarded2.length}`
  );
  const groups2 = groupByChangeset(survivors3);
  const allDivergent2 = isAllDivergent(groups2, fanWidth2);
  const selectionResult2 = selectWinner(groups2);
  return {
    survivors: survivors3,
    discarded: discarded2,
    failed: failed2,
    groups: groups2,
    allDivergent: allDivergent2,
    selectionResult: selectionResult2,
    railsChecked: railsChecked2,
    prompt,
    snapshot
  };
}
var init_runner2 = __esm({
  "node_modules/@adlc/consensus-fix/lib/runner.mjs"() {
    init_snapshot2();
    init_hunks();
    init_agreement();
    init_prompt2();
    init_core();
  }
});

// node_modules/@adlc/consensus-fix/lib/format.mjs
function formatReport({
  survivors: survivors3,
  discarded: discarded2,
  failed: failed2,
  groups: groups2,
  allDivergent: allDivergent2,
  selectionResult: selectionResult2,
  railsChecked: railsChecked2 = true,
  applied: applied2,
  dryRun
}) {
  const lines2 = [];
  lines2.push(`consensus-fix report`);
  lines2.push(`--------------------`);
  lines2.push(`Regression gate  : ${railsChecked2 ? "rails checked (--rails)" : "NOT CHECKED"}`);
  lines2.push(`Candidates total : ${survivors3.length + failed2.length + discarded2.length}`);
  lines2.push(`  Passed (survivors) : ${survivors3.length}${railsChecked2 ? " (repro + rails)" : " (repro only)"}`);
  lines2.push(`  Failed         : ${failed2.length}`);
  lines2.push(`  Discarded      : ${discarded2.length}`);
  if (!railsChecked2) {
    lines2.push("");
    lines2.push("\u26A0  WARNING: no --rails command supplied. Candidates were checked");
    lines2.push("   ONLY against --test-cmd (the repro), NOT the full rail suite. A");
    lines2.push("   fix that reddens other tests/types can still survive. Pass");
    lines2.push('   --rails "<full suite>" to close this regression gate (C7).');
  }
  if (discarded2.length > 0) {
    lines2.push("");
    lines2.push("Discarded candidates:");
    for (const d of discarded2) {
      const providerSuffix = d.provider ? ` (provider: ${d.provider})` : "";
      lines2.push(`  [${d.index + 1}]${providerSuffix} ${d.reason}`);
    }
  }
  if (survivors3.length === 0) {
    lines2.push("");
    lines2.push("No survivors \u2014 gate fails.");
    return lines2.join("\n");
  }
  lines2.push("");
  lines2.push(`Agreement groups : ${groups2.size}`);
  for (const group of groups2.values()) {
    const indices = group.map((c) => c.index + 1).join(", ");
    const providerSuffix = group.some((c) => c.provider) ? ` (providers: ${group.map((c) => c.provider ?? "?").join(", ")})` : "";
    lines2.push(
      `  Group (${group.length} member${group.length !== 1 ? "s" : ""}): candidates [${indices}]${providerSuffix}`
    );
  }
  if (allDivergent2) {
    lines2.push("");
    lines2.push("\u26A0  ALL-DIVERGENT: Every survivor is in its own group.");
    lines2.push("   This indicates spec ambiguity \u2014 escalate to human review.");
  }
  if (selectionResult2) {
    const { winner, largestGroupSize } = selectionResult2;
    lines2.push("");
    lines2.push(`Winner: candidate [${winner.index + 1}]`);
    if (winner.provider) lines2.push(`  Provider             : ${winner.provider}`);
    lines2.push(`  Agreement group size : ${largestGroupSize}`);
    lines2.push(`  Changed lines        : ${winner.changedLines}`);
    lines2.push("");
    if (winner.changes.length === 0) {
      lines2.push("  No file changes in winning candidate.");
    } else {
      lines2.push("  Files changed:");
      for (const { file } of winner.changes) {
        lines2.push(`    ${file}`);
      }
    }
    lines2.push("");
    if (dryRun) {
      lines2.push("Dry-run mode: use --apply to write the winning fix.");
    } else if (applied2) {
      lines2.push("Winning fix has been applied.");
    }
  }
  return lines2.join("\n");
}
function formatJson({
  survivors: survivors3,
  discarded: discarded2,
  failed: failed2,
  groups: groups2,
  allDivergent: allDivergent2,
  selectionResult: selectionResult2,
  railsChecked: railsChecked2 = true,
  applied: applied2
}) {
  const groupSummary = [];
  let gi = 0;
  for (const group of groups2.values()) {
    groupSummary.push({
      groupIndex: gi++,
      size: group.length,
      candidateIndices: group.map((c) => c.index),
      // Per-candidate provider (issue #63 --providers); null entries when a
      // candidate wasn't drawn from a named provider (default --n sampling).
      candidateProviders: group.map((c) => c.provider ?? null)
    });
  }
  return {
    summary: {
      total: survivors3.length + failed2.length + discarded2.length,
      passed: survivors3.length,
      failed: failed2.length,
      discarded: discarded2.length,
      groups: groups2.size,
      allDivergent: allDivergent2,
      railsChecked: railsChecked2
    },
    groups: groupSummary,
    winner: selectionResult2 ? {
      index: selectionResult2.winner.index,
      provider: selectionResult2.winner.provider ?? null,
      changedLines: selectionResult2.winner.changedLines,
      largestGroupSize: selectionResult2.largestGroupSize,
      changes: selectionResult2.winner.changes,
      applied: applied2
    } : null,
    discardedDetails: discarded2.map((d) => ({
      index: d.index,
      provider: d.provider ?? null,
      reason: d.reason
    }))
  };
}
var init_format2 = __esm({
  "node_modules/@adlc/consensus-fix/lib/format.mjs"() {
  }
});

// node_modules/@adlc/consensus-fix/bin/consensus-fix.mjs
var consensus_fix_exports = {};
import { writeFileSync as writeFileSync14 } from "node:fs";
async function completeFn(prompt, providerName) {
  return complete({ tier, prompt, provider: providerName ?? providerOverride });
}
var values4, testCmd2, railsCmd, filePaths, n, tier, providerOverride, providersRaw, providerNames, fanWidth, outerSnapshot, result3, survivors2, discarded, failed, groups, allDivergent, selectionResult, railsChecked, applied;
var init_consensus_fix = __esm({
  async "node_modules/@adlc/consensus-fix/bin/consensus-fix.mjs"() {
    init_core();
    init_runner2();
    init_prompt2();
    init_snapshot2();
    init_hunks();
    init_format2();
    ({ values: values4 } = parseArgs({
      options: {
        "test-cmd": { type: "string" },
        rails: { type: "string" },
        files: { type: "string" },
        n: { type: "string", default: "3" },
        tier: { type: "string", default: "mid" },
        provider: { type: "string" },
        providers: { type: "string" },
        apply: { type: "boolean", default: false },
        "allow-dirty": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "prompt-only": { type: "boolean", default: false }
      }
    }));
    if (!values4["test-cmd"]) opError("--test-cmd is required");
    if (!values4["files"]) opError("--files is required");
    testCmd2 = values4["test-cmd"];
    railsCmd = values4["rails"] || void 0;
    filePaths = values4["files"].split(",").map((f) => f.trim()).filter(Boolean);
    if (filePaths.length === 0) opError("--files must list at least one file path");
    n = parseInt(values4["n"], 10);
    if (isNaN(n) || n < 1) opError(`--n must be a positive integer, got: ${values4["n"]}`);
    tier = values4["tier"];
    if (!["cheap", "mid", "frontier"].includes(tier)) {
      opError(`--tier must be cheap|mid|frontier, got: ${tier}`);
    }
    providerOverride = values4["provider"] || void 0;
    providersRaw = values4["providers"] || void 0;
    if (providerOverride && providersRaw) {
      opError("--provider and --providers are mutually exclusive \u2014 use one or the other");
    }
    if (providerOverride && !PROVIDER_NAMES.includes(providerOverride)) {
      opError(`--provider must be one of: ${PROVIDER_NAMES.join(", ")}, got: ${providerOverride}`);
    }
    if (providersRaw) {
      providerNames = providersRaw.split(",").map((p) => p.trim()).filter(Boolean);
      if (providerNames.length === 0) opError("--providers must list at least one provider name");
      const unknown = providerNames.filter((p) => !PROVIDER_NAMES.includes(p));
      if (unknown.length > 0) {
        opError(`--providers has unknown provider name(s): ${unknown.join(", ")} (known: ${PROVIDER_NAMES.join(", ")})`);
      }
      const dupes = [...new Set(providerNames.filter((p, i) => providerNames.indexOf(p) !== i))];
      if (dupes.length > 0) {
        opError(`--providers must name DISTINCT providers \u2014 duplicate(s): ${dupes.join(", ")}`);
      }
    }
    fanWidth = providerNames ? providerNames.length : n;
    if (values4["prompt-only"]) {
      let snapshot;
      try {
        snapshot = takeSnapshot(filePaths);
      } catch (err) {
        opError(`could not read files for --prompt-only: ${err.message}`);
      }
      const prompt = buildPrompt({
        testCmd: testCmd2,
        testOutput: "<test output will appear here>",
        snapshot
      });
      promptOnly(Array.from({ length: fanWidth }, () => prompt));
    }
    if (!values4["allow-dirty"]) {
      let dirty = false;
      try {
        dirty = isDirty();
      } catch {
      }
      if (dirty) {
        opError("working tree has uncommitted changes \u2014 commit or stash first, or use --allow-dirty");
      }
    }
    if (providerNames) {
      const missing = providerNames.filter((name) => !detectProvider(process.env, name));
      if (missing.length > 0) {
        opError(
          `--providers requested provider(s) not available (missing API key): ${missing.join(", ")}
Set the corresponding API key env var for each requested provider, or use --prompt-only.`
        );
      }
    } else {
      const provider = detectProvider(process.env, providerOverride);
      if (!provider) {
        opError(
          providerOverride ? `--provider ${providerOverride} is not available \u2014 set its API key (or ADLC_AGY for agy)` : "no LLM provider configured \u2014 set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --prompt-only)"
        );
      }
      resolveModel(provider, { tier });
    }
    outerSnapshot = null;
    process.on("SIGINT", () => {
      if (outerSnapshot) {
        try {
          restoreSnapshot(outerSnapshot);
        } catch {
        }
      }
      process.exit(1);
    });
    try {
      outerSnapshot = takeSnapshot(filePaths);
    } catch (err) {
      opError(`could not read --files: ${err.message}`);
    }
    try {
      result3 = await runConsensusFix({
        testCmd: testCmd2,
        railsCmd,
        files: filePaths,
        n,
        tier,
        providerNames,
        completeFn,
        onProgress: (msg) => {
          if (!values4["json"]) console.log(msg);
        }
      });
    } catch (err) {
      if (err.isOpError) opError(err.message);
      opError(`unexpected error: ${err.message}`);
    }
    ({
      survivors: survivors2,
      discarded,
      failed,
      groups,
      allDivergent,
      selectionResult,
      railsChecked
    } = result3);
    applied = false;
    if (values4["apply"] && selectionResult && !allDivergent) {
      const { winner } = selectionResult;
      for (const { file, hunks } of winner.changes) {
        const result6 = applyHunks(outerSnapshot[file], hunks);
        if (!result6.ok) opError(`failed to apply winning candidate to ${file}: ${result6.error}`);
        writeFileSync14(file, result6.content, "utf8");
      }
      applied = true;
    }
    if (values4["json"]) {
      printJson(formatJson({
        survivors: survivors2,
        discarded,
        failed,
        groups,
        allDivergent,
        selectionResult,
        railsChecked,
        applied
      }));
    } else {
      console.log(
        formatReport({
          survivors: survivors2,
          discarded,
          failed,
          groups,
          allDivergent,
          selectionResult,
          railsChecked,
          applied,
          dryRun: !values4["apply"]
        })
      );
    }
    if (survivors2.length === 0) {
      gateFail("no candidates survived \u2014 gate fails");
    }
    if (allDivergent) {
      gateFail("all-divergent: spec ambiguity \u2014 escalate");
    }
    pass();
  }
});

// node_modules/@adlc/model-router/lib/priors.mjs
function buildPriors(entries) {
  const global = {};
  const byCat = {};
  for (const entry of entries) {
    if (entry.type !== "build") continue;
    const { model, category, firstPass } = entry;
    if (typeof model !== "string") continue;
    if (typeof firstPass !== "boolean") continue;
    if (!global[model]) global[model] = { passes: 0, n: 0 };
    global[model].n += 1;
    if (firstPass) global[model].passes += 1;
    if (typeof category === "string") {
      if (!byCat[category]) byCat[category] = {};
      if (!byCat[category][model]) byCat[category][model] = { passes: 0, n: 0 };
      byCat[category][model].n += 1;
      if (firstPass) byCat[category][model].passes += 1;
    }
  }
  const globalRates = {};
  for (const [model, bucket] of Object.entries(global)) {
    globalRates[model] = {
      passes: bucket.passes,
      n: bucket.n,
      rate: (bucket.passes + 1) / (bucket.n + 2)
    };
  }
  const catRates = {};
  for (const [cat, models] of Object.entries(byCat)) {
    catRates[cat] = {};
    for (const [model, bucket] of Object.entries(models)) {
      if (bucket.n >= 3) {
        catRates[cat][model] = {
          passes: bucket.passes,
          n: bucket.n,
          rate: (bucket.passes + 1) / (bucket.n + 2)
        };
      }
    }
  }
  return { global: globalRates, byCategory: catRates };
}
function bestTierFromPriors(priors, category) {
  if (category && priors.byCategory[category]) {
    const catData = priors.byCategory[category];
    const best2 = pickBestTier(catData);
    if (best2) return best2;
  }
  const best = pickBestTier(priors.global);
  if (best) return best;
  return "mid";
}
function pickBestTier(modelMap) {
  let bestTier = null;
  let bestRate = -1;
  for (const tier2 of TIERS) {
    if (modelMap[tier2] && modelMap[tier2].n >= 3 && modelMap[tier2].rate > bestRate) {
      bestRate = modelMap[tier2].rate;
      bestTier = tier2;
    }
  }
  return bestTier;
}
var TIERS;
var init_priors = __esm({
  "node_modules/@adlc/model-router/lib/priors.mjs"() {
    TIERS = ["cheap", "mid", "frontier"];
  }
});

// node_modules/@adlc/model-router/lib/density.mjs
function usablePatterns(field) {
  if (!Array.isArray(field)) return 0;
  const seen = /* @__PURE__ */ new Set();
  for (const item of field) {
    if (typeof item !== "string") continue;
    const visible = item.replace(INVISIBLE, "");
    if (!/[\p{L}\p{N}*?]/u.test(visible)) continue;
    seen.add(visible);
  }
  return seen.size;
}
function railDensity(ticket2) {
  const rails = usablePatterns(ticket2.rails);
  if (rails === 0) return 0;
  const scope = usablePatterns(ticket2.scope);
  if (scope === 0) return 0;
  return Math.min(1, rails / scope);
}
var INVISIBLE;
var init_density = __esm({
  "node_modules/@adlc/model-router/lib/density.mjs"() {
    INVISIBLE = /[\s\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;
  }
});

// node_modules/@adlc/model-router/lib/floor.mjs
function assertFloor(floor2, raw2) {
  const inRange = typeof floor2 === "number" && Number.isFinite(floor2) && floor2 > 0 && floor2 <= 1;
  if (!inRange) {
    const got = raw2 !== void 0 ? String(raw2) : Object.is(floor2, -0) ? "-0" : String(floor2);
    throw Object.assign(new Error(`${FLOOR_RANGE_MESSAGE}; got: ${got}`), { isOpError: true });
  }
  return floor2;
}
function parseFloor(raw2) {
  const text = String(raw2).trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
}
var DEFAULT_FLOOR, FLOOR_RANGE_MESSAGE;
var init_floor = __esm({
  "node_modules/@adlc/model-router/lib/floor.mjs"() {
    DEFAULT_FLOOR = 0.2;
    FLOOR_RANGE_MESSAGE = "--floor must be a number greater than 0 and at most 1 \u2014 0 would disable the P3 rail-density gate: every ticket passes and unrailed tickets leave frontier";
  }
});

// node_modules/@adlc/model-router/lib/assign.mjs
function resolveBudget(ticket2, tier2, mode) {
  if (typeof ticket2.budget === "number" && ticket2.budget > 0) return ticket2.budget;
  if (mode === "ladder") return DEFAULT_TIER_BUDGET[tier2] + DEFAULT_TIER_BUDGET.frontier;
  return DEFAULT_TIER_BUDGET[tier2];
}
function assignTicket(ticket2, float, priors, floor2 = DEFAULT_FLOOR) {
  assertFloor(floor2);
  const density = railDensity(ticket2);
  const id = ticket2.id;
  if (FRONTIER_CATEGORIES.has(ticket2.category)) {
    return {
      id,
      tier: "frontier",
      mode: "direct",
      railDensity: density,
      float,
      budget: resolveBudget(ticket2, "frontier", "direct"),
      reason: `category '${ticket2.category}' requires frontier model`
    };
  }
  if (density < floor2) {
    return {
      id,
      tier: "frontier",
      mode: "direct",
      railDensity: density,
      float,
      budget: resolveBudget(ticket2, "frontier", "direct"),
      reason: `railDensity ${density.toFixed(3)} < floor ${floor2} \u2192 frontier (P3 finding)`
    };
  }
  if (float === 0) {
    const tier2 = bestTierFromPriors(priors, ticket2.category);
    return {
      id,
      tier: tier2,
      mode: "direct",
      railDensity: density,
      float,
      budget: resolveBudget(ticket2, tier2, "direct"),
      reason: `critical path (float=0) \u2192 direct with best-prior tier '${tier2}'`
    };
  }
  const startTier = density >= 0.5 ? "cheap" : "mid";
  return {
    id,
    tier: startTier,
    mode: "ladder",
    railDensity: density,
    float,
    budget: resolveBudget(ticket2, startTier, "ladder"),
    reason: `float=${float} \u2192 ladder starting at '${startTier}' (railDensity=${density.toFixed(3)})`
  };
}
function assignAll(tickets2, cpmResult, priors, floor2 = DEFAULT_FLOOR) {
  assertFloor(floor2);
  return tickets2.map((ticket2) => {
    const float = cpmResult.floats[ticket2.id] ?? 0;
    return assignTicket(ticket2, float, priors, floor2);
  });
}
var FRONTIER_CATEGORIES, DEFAULT_TIER_BUDGET;
var init_assign = __esm({
  "node_modules/@adlc/model-router/lib/assign.mjs"() {
    init_density();
    init_priors();
    init_floor();
    FRONTIER_CATEGORIES = /* @__PURE__ */ new Set(["contract", "spec", "architecture"]);
    DEFAULT_TIER_BUDGET = {
      cheap: 5e4,
      mid: 15e4,
      frontier: 4e5
    };
  }
});

// node_modules/@adlc/model-router/lib/active-tickets.mjs
function activeTickets(tickets2) {
  const done = new Set(tickets2.filter((t) => t.completed === true).map((t) => t.id));
  if (done.size === 0) return tickets2;
  return tickets2.filter((t) => !done.has(t.id)).map(
    (t) => Array.isArray(t.edges) && t.edges.some((e) => done.has(e.to)) ? { ...t, edges: t.edges.filter((e) => !done.has(e.to)) } : t
  );
}
var init_active_tickets = __esm({
  "node_modules/@adlc/model-router/lib/active-tickets.mjs"() {
  }
});

// node_modules/@adlc/model-router/lib/router.mjs
async function runRouter(opts = {}) {
  const {
    ticketsPath: ticketsPath2,
    floor: floor2 = DEFAULT_FLOOR,
    adlcDir = ADLC_DIR
  } = opts;
  assertFloor(floor2);
  const { tickets: allTickets2, errors: ticketErrors2 } = loadTickets(ticketsPath2);
  if (ticketErrors2.length > 0) {
    throw Object.assign(new Error(ticketErrors2.join("\n")), { isOpError: true });
  }
  const tickets2 = activeTickets(allTickets2);
  if (tickets2.length === 0) {
    return { assignments: [], p3Findings: [], ticketErrors: ticketErrors2, skippedLedger: [] };
  }
  const cpmResult = computeFloat(tickets2);
  if (cpmResult.error) {
    throw Object.assign(new Error(cpmResult.error), { isOpError: true });
  }
  const { entries, skipped: skippedLedger2 } = readManifestForest(adlcDir);
  const priors = buildPriors(entries);
  const assignments2 = assignAll(tickets2, cpmResult, priors, floor2);
  const p3Findings2 = assignments2.filter((a) => {
    const ticket2 = tickets2.find((t) => t.id === a.id);
    return !FRONTIER_CATEGORIES.has(ticket2?.category) && a.railDensity < floor2;
  }).map((a) => ({
    id: a.id,
    railDensity: a.railDensity,
    floor: floor2,
    message: `P3 finding: ticket ${a.id} not railed enough to build cheaply (railDensity=${a.railDensity.toFixed(3)} < floor=${floor2})`
  }));
  return { assignments: assignments2, p3Findings: p3Findings2, ticketErrors: ticketErrors2, skippedLedger: skippedLedger2 };
}
var init_router = __esm({
  "node_modules/@adlc/model-router/lib/router.mjs"() {
    init_core();
    init_core();
    init_forest();
    init_priors();
    init_assign();
    init_assign();
    init_active_tickets();
    init_floor();
  }
});

// node_modules/@adlc/model-router/lib/format.mjs
function pad(str, width) {
  if (width === 0) return String(str);
  return String(str).padEnd(width);
}
function formatTable(assignments2) {
  const header = [
    pad("id", COL_WIDTHS.id),
    pad("tier", COL_WIDTHS.tier),
    pad("mode", COL_WIDTHS.mode),
    pad("railDensity", COL_WIDTHS.railDensity),
    pad("float", COL_WIDTHS.float),
    pad("reason", COL_WIDTHS.reason)
  ].join("  ");
  const sep8 = "-".repeat(header.length);
  const rows = assignments2.map(
    (a) => [
      pad(a.id, COL_WIDTHS.id),
      pad(a.tier, COL_WIDTHS.tier),
      pad(a.mode, COL_WIDTHS.mode),
      pad(a.railDensity.toFixed(3), COL_WIDTHS.railDensity),
      pad(a.float, COL_WIDTHS.float),
      pad(a.reason, COL_WIDTHS.reason)
    ].join("  ")
  );
  return [header, sep8, ...rows].join("\n");
}
var COL_WIDTHS;
var init_format3 = __esm({
  "node_modules/@adlc/model-router/lib/format.mjs"() {
    COL_WIDTHS = {
      id: 12,
      tier: 10,
      mode: 8,
      railDensity: 11,
      float: 6,
      reason: 0
      // unbounded
    };
  }
});

// node_modules/@adlc/model-router/bin/model-router.mjs
var model_router_exports = {};
function rawFloorToken(argv) {
  return argv.includes("--floor") ? argv[argv.indexOf("--floor") + 1] : void 0;
}
function parseFlags(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        tickets: { type: "string" },
        floor: { type: "string" },
        json: { type: "boolean", default: false }
      }
    }).values;
  } catch (err) {
    if (!String(err?.code ?? "").startsWith("ERR_PARSE_ARGS")) throw err;
    const reason = String(err.message).split("\n")[0];
    if (/--floor/.test(reason)) {
      const raw2 = rawFloorToken(argv);
      opError(`${FLOOR_RANGE_MESSAGE}; got: ${raw2 === void 0 ? "(missing)" : raw2} (${reason}; write --floor=<n> for a dash-leading value)`);
    }
    opError(reason);
  }
}
var values5, floor, result4, assignments, p3Findings, skippedLedger;
var init_model_router = __esm({
  async "node_modules/@adlc/model-router/bin/model-router.mjs"() {
    init_core();
    init_router();
    init_format3();
    init_floor();
    values5 = parseFlags(process.argv.slice(2));
    floor = values5.floor !== void 0 ? parseFloor(values5.floor) : DEFAULT_FLOOR;
    try {
      assertFloor(floor, values5.floor);
    } catch (err) {
      opError(err.message);
    }
    try {
      result4 = await runRouter({
        ticketsPath: values5.tickets,
        floor
      });
    } catch (err) {
      opError(err.message);
    }
    ({ assignments, p3Findings, skippedLedger } = result4);
    if (values5.json) {
      printJson({ assignments, p3Findings });
    } else {
      if (assignments.length === 0) {
        console.log("No tickets found.");
      } else {
        console.log(formatTable(assignments));
      }
      if (skippedLedger.length > 0) {
        console.error(`
Warning: ${skippedLedger.length} malformed ledger line(s) skipped.`);
      }
      if (p3Findings.length > 0) {
        console.error("\nGate findings:");
        for (const f of p3Findings) {
          console.error(`  ${f.message}`);
        }
      }
    }
    if (p3Findings.length > 0) {
      gateFail(`Gate failed: ${p3Findings.length} ticket(s) not railed enough to build cheaply.`);
    }
    pass();
  }
});

// node_modules/@adlc/merge-forecast/lib/reachability.mjs
function buildSuccessors(tickets2) {
  const succ = new Map(tickets2.map((t) => [t.id, /* @__PURE__ */ new Set()]));
  for (const t of tickets2) {
    for (const e of t.edges ?? []) {
      if (succ.has(t.id)) succ.get(t.id).add(e.to);
    }
  }
  return succ;
}
function computeReachability(tickets2) {
  const succ = buildSuccessors(tickets2);
  const ids = tickets2.map((t) => t.id);
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const t of tickets2) {
    for (const e of t.edges ?? []) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const topoOrder = [];
  const inQueue = new Set(queue);
  const q = [...queue];
  while (q.length) {
    const id = q.shift();
    topoOrder.push(id);
    for (const next of succ.get(id) ?? []) {
      const newDeg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, newDeg);
      if (newDeg === 0 && !inQueue.has(next)) {
        q.push(next);
        inQueue.add(next);
      }
    }
  }
  const reachable = new Map(ids.map((id) => [id, /* @__PURE__ */ new Set()]));
  for (const id of [...topoOrder].reverse()) {
    for (const s of succ.get(id) ?? []) {
      reachable.get(id).add(s);
      for (const r of reachable.get(s) ?? []) reachable.get(id).add(r);
    }
  }
  return reachable;
}
function parallelEligiblePairs(tickets2) {
  const reachable = computeReachability(tickets2);
  const pairs = [];
  for (let i = 0; i < tickets2.length; i++) {
    for (let j = i + 1; j < tickets2.length; j++) {
      const a = tickets2[i];
      const b = tickets2[j];
      const aId = a.id;
      const bId = b.id;
      if (!reachable.get(aId)?.has(bId) && !reachable.get(bId)?.has(aId)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}
function topoWaves(tickets2) {
  const indegree = new Map(tickets2.map((t) => [t.id, 0]));
  const succ = new Map(tickets2.map((t) => [t.id, []]));
  for (const t of tickets2) {
    for (const e of t.edges ?? []) {
      succ.get(t.id).push(e.to);
      indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    }
  }
  const waves = [];
  let ready = tickets2.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const assigned = /* @__PURE__ */ new Set();
  while (ready.length) {
    waves.push([...ready]);
    const nextReady = [];
    for (const id of ready) {
      assigned.add(id);
      for (const next of succ.get(id) ?? []) {
        const newDeg = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, newDeg);
        if (newDeg === 0 && !assigned.has(next)) nextReady.push(next);
      }
    }
    ready = nextReady;
  }
  return waves;
}
function mergeOrder(tickets2) {
  const waves = topoWaves(tickets2);
  return waves.flat();
}
var init_reachability = __esm({
  "node_modules/@adlc/merge-forecast/lib/reachability.mjs"() {
  }
});

// node_modules/@adlc/merge-forecast/lib/signals.mjs
import { readdirSync as readdirSync9, readFileSync as readFileSync25, statSync as statSync2 } from "node:fs";
import { join as join22, resolve as resolve11, dirname as dirname19 } from "node:path";
function signalScopeOverlap(a, b) {
  return scopesOverlap(a, b) ? 1 : 0;
}
function walkTree(root2) {
  const results2 = [];
  const skipDirs = /* @__PURE__ */ new Set(["node_modules", ".git"]);
  function walk2(dir) {
    let entries;
    try {
      entries = readdirSync9(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (skipDirs.has(ent.name)) continue;
      const fullPath = join22(dir, ent.name);
      if (ent.isDirectory()) {
        walk2(fullPath);
      } else if (ent.isFile()) {
        results2.push(fullPath.slice(root2.length + 1));
      }
    }
  }
  walk2(root2);
  return results2;
}
function extractImports(filePath) {
  let content;
  try {
    content = readFileSync25(filePath, "utf8");
  } catch {
    return [];
  }
  const specifiers = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  const re = new RegExp(IMPORT_RE.source, "g");
  while ((m = re.exec(content)) !== null) {
    specifiers.push(m[1]);
  }
  return specifiers;
}
function resolveSpecifier(specifier, importingFile, root2) {
  if (!specifier.startsWith(".")) return null;
  const importingDir = dirname19(join22(root2, importingFile));
  const resolved = resolve11(importingDir, specifier);
  const rel = resolved.startsWith(root2 + "/") ? resolved.slice(root2.length + 1) : null;
  return rel;
}
function importRadiusIntersects(a, b, repoFiles, root2) {
  const aFiles = repoFiles.filter(
    (f) => (a.scope ?? []).some((g) => globMatch2(g, f))
  );
  const bScope = b.scope ?? [];
  for (const af of aFiles) {
    const specifiers = extractImports(join22(root2, af));
    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec, af, root2);
      if (resolved === null) continue;
      const candidates = [
        resolved,
        resolved + ".js",
        resolved + ".mjs",
        resolved + ".ts",
        resolved + "/index.js",
        resolved + "/index.mjs",
        resolved + "/index.ts"
      ];
      for (const candidate of candidates) {
        if (bScope.some((g) => globMatch2(g, candidate))) return true;
      }
    }
  }
  return false;
}
function signalImportRadius(a, b, repoFiles, root2) {
  if (importRadiusIntersects(a, b, repoFiles, root2)) return 0.6;
  if (importRadiusIntersects(b, a, repoFiles, root2)) return 0.6;
  return 0;
}
function signalCoChange(a, b, coChangeData, repoFiles) {
  if (!coChangeData) return 0;
  const { pairCounts, fileCounts } = coChangeData;
  const aFiles = repoFiles.filter((f) => (a.scope ?? []).some((g) => globMatch2(g, f)));
  const bFiles = repoFiles.filter((f) => (b.scope ?? []).some((g) => globMatch2(g, f)));
  let maxScore = 0;
  for (const fa of aFiles) {
    for (const fb of bFiles) {
      if (fa === fb) continue;
      const key = pairKey(fa, fb);
      const pc = pairCounts[key] ?? 0;
      if (pc === 0) continue;
      const minCount = Math.min(fileCounts[fa] ?? 0, fileCounts[fb] ?? 0);
      if (minCount === 0) continue;
      const score = pc / minCount * 0.5;
      if (score > maxScore) maxScore = score;
    }
  }
  return Math.min(0.5, maxScore);
}
function extractDynamicSegments(filePath) {
  const parts = filePath.split("/");
  const result6 = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^\[(.+)\]$/);
    if (m) {
      result6.push({
        depth: i,
        segment: m[1],
        parentPath: parts.slice(0, i).join("/"),
        fullSegmentPath: parts.slice(0, i + 1).join("/")
      });
    }
  }
  return result6;
}
function signalNamespaceRoutes(a, b, repoFiles) {
  const routeDirs = ["app", "pages"];
  function routeSegments(ticket2) {
    const matchedFiles = repoFiles.filter(
      (f) => (ticket2.scope ?? []).some((g) => globMatch2(g, f))
    );
    const segs = [];
    for (const f of matchedFiles) {
      if (!routeDirs.some((d) => f.startsWith(d + "/"))) continue;
      for (const s of extractDynamicSegments(f)) {
        segs.push(s);
      }
    }
    return segs;
  }
  const aSegs = routeSegments(a);
  const bSegs = routeSegments(b);
  for (const as of aSegs) {
    for (const bs of bSegs) {
      if (as.parentPath === bs.parentPath && as.segment !== bs.segment) {
        return true;
      }
    }
  }
  return false;
}
function signalMigrationCollision(a, b, repoFiles) {
  const migPrefixRe = /(?:^|\/)(?:drizzle|migrations)\/(\d+)_/;
  function migPrefixes(ticket2) {
    const matchedFiles = repoFiles.filter(
      (f) => (ticket2.scope ?? []).some((g) => globMatch2(g, f))
    );
    const prefixes = /* @__PURE__ */ new Set();
    for (const f of matchedFiles) {
      const m = f.match(migPrefixRe);
      if (m) prefixes.add(m[1]);
    }
    return prefixes;
  }
  const aP = migPrefixes(a);
  const bP = migPrefixes(b);
  for (const p of aP) {
    if (bP.has(p)) return true;
  }
  return false;
}
function signalNamespace(a, b, repoFiles) {
  if (signalNamespaceRoutes(a, b, repoFiles)) return 0.8;
  if (signalMigrationCollision(a, b, repoFiles)) return 0.8;
  return 0;
}
function signalGraphCoupling(a, b, graphCouplingData, repoFiles) {
  if (!graphCouplingData) return 0;
  const aScope = a.scope ?? [];
  const bScope = b.scope ?? [];
  const aFiles = repoFiles.filter((f) => aScope.some((g) => globMatch2(g, f)));
  const bFiles = repoFiles.filter((f) => bScope.some((g) => globMatch2(g, f)));
  if (graphCouplingData.fileCoupling && typeof graphCouplingData.fileCoupling === "object") {
    let maxCoupling = 0;
    for (const fa of aFiles) {
      for (const fb of bFiles) {
        if (fa === fb) continue;
        const s1 = graphCouplingData.fileCoupling[`${fa}|${fb}`] ?? graphCouplingData.fileCoupling[pairKey(fa, fb)];
        const s2 = graphCouplingData.fileCoupling[`${fb}|${fa}`];
        const val = Math.max(s1 ?? 0, s2 ?? 0);
        if (val > maxCoupling) maxCoupling = val;
      }
    }
    if (maxCoupling > 0) return Math.min(0.7, maxCoupling > 1 ? 0.7 : maxCoupling * 0.7);
  }
  const edges = Array.isArray(graphCouplingData.edges) ? graphCouplingData.edges : Array.isArray(graphCouplingData.links) ? graphCouplingData.links : Array.isArray(graphCouplingData) ? graphCouplingData : null;
  if (edges) {
    let maxCoupling = 0;
    for (const edge of edges) {
      const src = edge.from ?? edge.source ?? edge.callerFile ?? edge.fromFile;
      const dst = edge.to ?? edge.target ?? edge.calleeFile ?? edge.toFile;
      if (!src || !dst) continue;
      const aMatchesSrc = aFiles.some((f) => f === src || f.endsWith("/" + src) || src.endsWith("/" + f));
      const bMatchesDst = bFiles.some((f) => f === dst || f.endsWith("/" + dst) || dst.endsWith("/" + f));
      const bMatchesSrc = bFiles.some((f) => f === src || f.endsWith("/" + src) || src.endsWith("/" + f));
      const aMatchesDst = aFiles.some((f) => f === dst || f.endsWith("/" + dst) || dst.endsWith("/" + f));
      if (aMatchesSrc && bMatchesDst || bMatchesSrc && aMatchesDst) {
        const weight = typeof edge.weight === "number" ? Math.min(1, edge.weight) : 1;
        const score = weight * 0.7;
        if (score > maxCoupling) maxCoupling = score;
      }
    }
    if (maxCoupling > 0) return maxCoupling;
  }
  return 0;
}
function pairScore(a, b, opts = {}) {
  const { repoFiles = [], root: root2 = process.cwd(), coChangeData = null, graphCouplingData = null } = opts;
  const s1 = signalScopeOverlap(a, b);
  if (s1 >= 1) return { score: 1, signal: "scope-overlap", hardVeto: true };
  const s4 = signalNamespace(a, b, repoFiles);
  const s5 = signalGraphCoupling(a, b, graphCouplingData, repoFiles);
  const s2 = signalImportRadius(a, b, repoFiles, root2);
  const s3 = signalCoChange(a, b, coChangeData, repoFiles);
  const score = Math.max(s2, s3, s4, s5);
  let signal = "none";
  if (score === s4 && s4 > 0) signal = "namespace-collision";
  else if (score === s5 && s5 > 0) signal = "graph-coupling";
  else if (score === s2 && s2 > 0) signal = "import-radius";
  else if (score === s3 && s3 > 0) signal = "co-change";
  return { score, signal, hardVeto: false };
}
var IMPORT_RE;
var init_signals2 = __esm({
  "node_modules/@adlc/merge-forecast/lib/signals.mjs"() {
    init_core();
    IMPORT_RE = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;
  }
});

// node_modules/@adlc/merge-forecast/lib/forecast.mjs
import { existsSync as existsSync26, readFileSync as readFileSync26 } from "node:fs";
import { join as join23 } from "node:path";
async function runForecast(opts) {
  const {
    tickets: tickets2,
    root: root2,
    coChangeLimit: coChangeLimit2 = 500,
    conflictThreshold: conflictThreshold2 = 0.5,
    width = null,
    buildMin: buildMin2 = null,
    mergeMin: mergeMin2 = null
  } = opts;
  const { cycle } = topoSort(tickets2);
  if (cycle && cycle.length > 0) {
    return {
      pairs: [],
      waves: [],
      mergeOrder: [],
      certifiedWidth: 0,
      backpressureWidth: null,
      recommendedWidth: 0,
      warnings: [],
      gateFailures: [
        `dependency cycle in ticket DAG \u2014 cannot schedule: ` + cycle.join(", ")
      ],
      pullQueueNote: "idle builders claim next unblocked"
    };
  }
  const repoFiles = walkTree(root2);
  let coChangeData = null;
  const warnings = [];
  if (isGitRepo(root2)) {
    try {
      coChangeData = coChange(coChangeLimit2, root2);
    } catch (err) {
      const msg = err.message ?? String(err);
      if (msg.includes("shallow") || msg.includes("no commits")) {
        warnings.push("co-change skipped: shallow clone or no history");
      } else {
        warnings.push(`co-change skipped: ${msg}`);
      }
    }
  } else {
    warnings.push("co-change skipped: not a git repo");
  }
  let graphCouplingData = opts.graphCouplingData ?? null;
  if (!graphCouplingData) {
    const candidatePaths = [
      opts.graphCouplingFile,
      process.env.ADLC_GRAPH_COUPLING_FILE,
      join23(root2, ".adlc", "graph-coupling.json"),
      join23(root2, ".sdlc", "artifacts", "codebase_graph.json"),
      join23(root2, ".sdlc", "artifacts", "graph_coupling.json")
    ].filter(Boolean);
    for (const p of candidatePaths) {
      if (existsSync26(p)) {
        try {
          graphCouplingData = JSON.parse(readFileSync26(p, "utf8"));
          break;
        } catch (err) {
          warnings.push(`graph-coupling skipped: failed to parse ${p}: ${err.message}`);
        }
      }
    }
  }
  const pairs = parallelEligiblePairs(tickets2);
  const pairResults = pairs.map(([a, b]) => {
    const { score, signal, hardVeto } = pairScore(a, b, {
      repoFiles,
      root: root2,
      coChangeData,
      graphCouplingData
    });
    const verdict = hardVeto ? "VETO" : score >= conflictThreshold2 ? "SEQUENCE" : "PARALLEL";
    return {
      pair: `${a.id}\u2013${b.id}`,
      a: a.id,
      b: b.id,
      score: Math.round(score * 1e3) / 1e3,
      signal,
      verdict,
      hardVeto
    };
  });
  const waves = topoWaves(tickets2);
  const order = mergeOrder(tickets2);
  const wave1 = waves[0] ?? [];
  const certifiedWidth = computeCertifiedWidth(wave1, pairResults, conflictThreshold2);
  const backpressureWidth = buildMin2 !== null && mergeMin2 !== null && mergeMin2 > 0 ? Math.round(buildMin2 / mergeMin2) : null;
  const candidates = [certifiedWidth];
  if (backpressureWidth !== null) candidates.push(backpressureWidth);
  if (width !== null) candidates.push(width);
  const recommendedWidth = Math.min(...candidates);
  const gateFailures = [];
  if (width !== null && width > certifiedWidth) {
    gateFailures.push(
      `--width ${width} exceeds certifiedWidth ${certifiedWidth}`
    );
  }
  const waveMap = /* @__PURE__ */ new Map();
  for (let w = 0; w < waves.length; w++) {
    for (const id of waves[w]) waveMap.set(id, w);
  }
  const concurrentVetoes = pairResults.filter((pr) => {
    if (!pr.hardVeto && pr.score < conflictThreshold2) return false;
    const wA = waveMap.get(pr.a);
    const wB = waveMap.get(pr.b);
    return wA !== void 0 && wB !== void 0 && wA === wB;
  });
  if (concurrentVetoes.length > 0) {
    gateFailures.push(
      `${concurrentVetoes.length} high-risk pair(s) would run concurrently: ` + concurrentVetoes.map((p) => `${p.pair} (score ${p.score}, ${p.signal})`).join(", ")
    );
  }
  return {
    pairs: pairResults,
    waves,
    mergeOrder: order,
    certifiedWidth,
    backpressureWidth,
    recommendedWidth,
    warnings,
    gateFailures,
    pullQueueNote: "idle builders claim next unblocked"
  };
}
function computeCertifiedWidth(wave1Ids, pairResults, threshold) {
  if (wave1Ids.length === 0) return 0;
  const conflicted = /* @__PURE__ */ new Set();
  for (const pr of pairResults) {
    if (pr.score >= threshold || pr.hardVeto) {
      if (wave1Ids.includes(pr.a) && wave1Ids.includes(pr.b)) {
        conflicted.add(`${pr.a}|${pr.b}`);
        conflicted.add(`${pr.b}|${pr.a}`);
      }
    }
  }
  function hasConflict(id, chosen) {
    return chosen.some((c) => conflicted.has(`${id}|${c}`));
  }
  let best = 0;
  for (let start = 0; start < wave1Ids.length; start++) {
    const chosen = [];
    const order = [
      ...wave1Ids.slice(start),
      ...wave1Ids.slice(0, start)
    ];
    for (const id of order) {
      if (!hasConflict(id, chosen)) chosen.push(id);
    }
    if (chosen.length > best) best = chosen.length;
  }
  return best;
}
var init_forecast = __esm({
  "node_modules/@adlc/merge-forecast/lib/forecast.mjs"() {
    init_reachability();
    init_signals2();
    init_signals2();
    init_core();
  }
});

// node_modules/@adlc/merge-forecast/lib/output.mjs
function color(text, code) {
  if (!process.stdout.isTTY) return text;
  return `${code}${text}${RESET}`;
}
function formatForecast(result6) {
  const lines2 = [];
  lines2.push("");
  lines2.push("\u2500\u2500 Conflict Forecast \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  lines2.push("");
  if (result6.pairs.length === 0) {
    lines2.push("  No parallel-eligible pairs found (all tickets are serialized by DAG).");
  } else {
    lines2.push(
      padR("Pair", 18) + padR("Score", 8) + padR("Signal", 22) + "Verdict"
    );
    lines2.push("\u2500".repeat(65));
    for (const p of result6.pairs) {
      const v = color(p.verdict, VERDICT_COLOR[p.verdict] ?? "");
      lines2.push(
        padR(p.pair, 18) + padR(p.score.toFixed(3), 8) + padR(p.signal, 22) + v
      );
    }
  }
  lines2.push("");
  lines2.push("\u2500\u2500 Schedule \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  lines2.push("");
  for (let i = 0; i < result6.waves.length; i++) {
    const waveTags = result6.waves[i].map((id) => {
      const pr = result6.pairs.find((p) => p.a === id || p.b === id);
      return id;
    });
    lines2.push(`  Wave ${i + 1}: ${waveTags.join(", ")}`);
  }
  lines2.push("");
  lines2.push(`  Merge order (foundation-first): ${result6.mergeOrder.join(" \u2192 ")}`);
  lines2.push(`  Pull-queue: ${result6.pullQueueNote}`);
  lines2.push("");
  lines2.push("\u2500\u2500 Width Analysis \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  lines2.push("");
  lines2.push(`  Certified width  : ${result6.certifiedWidth}`);
  if (result6.backpressureWidth !== null) {
    lines2.push(`  Backpressure width: ${result6.backpressureWidth}`);
  }
  lines2.push(`  Recommended width: ${result6.recommendedWidth}`);
  if (result6.warnings.length > 0) {
    lines2.push("");
    lines2.push("\u2500\u2500 Warnings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    for (const w of result6.warnings) lines2.push(`  \u26A0  ${w}`);
  }
  if (result6.gateFailures.length > 0) {
    lines2.push("");
    lines2.push("\u2500\u2500 Gate Failures \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    for (const f of result6.gateFailures) lines2.push(`  \u2717  ${f}`);
  } else {
    lines2.push("");
    lines2.push("  Gate: PASS");
  }
  lines2.push("");
  return lines2.join("\n");
}
function padR(str, len) {
  return String(str).padEnd(len);
}
var VERDICT_COLOR, RESET;
var init_output2 = __esm({
  "node_modules/@adlc/merge-forecast/lib/output.mjs"() {
    VERDICT_COLOR = {
      VETO: "\x1B[31m",
      // red
      SEQUENCE: "\x1B[33m",
      // yellow
      PARALLEL: "\x1B[32m"
      // green
    };
    RESET = "\x1B[0m";
  }
});

// node_modules/@adlc/merge-forecast/lib/active-tickets.mjs
function activeTickets2(tickets2) {
  const done = new Set(tickets2.filter((t) => t.completed === true).map((t) => t.id));
  if (done.size === 0) return tickets2;
  return tickets2.filter((t) => !done.has(t.id)).map(
    (t) => Array.isArray(t.edges) && t.edges.some((e) => done.has(e.to)) ? { ...t, edges: t.edges.filter((e) => !done.has(e.to)) } : t
  );
}
var init_active_tickets2 = __esm({
  "node_modules/@adlc/merge-forecast/lib/active-tickets.mjs"() {
  }
});

// node_modules/@adlc/merge-forecast/bin/merge-forecast.mjs
var merge_forecast_exports = {};
function parseNum(val, name, defaultVal, integer = false) {
  if (val === void 0 || val === null) return defaultVal;
  const text = typeof val === "string" ? val.trim() : "";
  const n2 = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n2)) opError(`--${name} must be a number, got: ${val}`);
  if (integer && !Number.isSafeInteger(n2)) opError(`--${name} must be an integer, got: ${val}`);
  return n2;
}
var values6, ticketsPath, widthFlag, buildMin, mergeMin, coChangeLimit, conflictThreshold, allTickets, ticketErrors, tickets, result5;
var init_merge_forecast = __esm({
  async "node_modules/@adlc/merge-forecast/bin/merge-forecast.mjs"() {
    init_core();
    init_forecast();
    init_output2();
    init_active_tickets2();
    ({ values: values6 } = parseArgs({
      options: {
        tickets: { type: "string", default: ".adlc/tickets.json" },
        width: { type: "string" },
        "build-min": { type: "string" },
        "merge-min": { type: "string" },
        "co-change-limit": { type: "string" },
        "conflict-threshold": { type: "string" },
        "graph-coupling": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false }
      }
    }));
    if (values6.help) {
      console.log(`merge-forecast \u2014 Conflict forecast + dispatch schedule (ADLC D2)

Usage:
  merge-forecast [options]

Options:
  --tickets <path>           Path to tickets JSON (default: .adlc/tickets.json)
  --width <N>                Desired fan-out width; exit 2 if > certifiedWidth
  --build-min <X>            Mean ticket build time in minutes (for backpressure)
  --merge-min <Y>            Mean merge-rebase-regreen time in minutes
  --co-change-limit <N>      Git log depth for co-change mining (default: 500)
  --conflict-threshold <F>   Score >= this triggers SEQUENCE verdict (default: 0.5)
  --graph-coupling <path>    Path to semantic call/symbol graph coupling JSON
  --json                     Machine-readable JSON output
  --help                     Show this help

Exit codes:
  0  Gate passes
  1  Operational error (bad tickets file, etc.)
  2  Gate fails (--width > certifiedWidth, vetoed pair concurrent)
`);
      process.exit(0);
    }
    ticketsPath = values6.tickets;
    widthFlag = values6.width !== void 0 ? parseNum(values6.width, "width", null, true) : null;
    buildMin = values6["build-min"] !== void 0 ? parseNum(values6["build-min"], "build-min", null) : null;
    mergeMin = values6["merge-min"] !== void 0 ? parseNum(values6["merge-min"], "merge-min", null) : null;
    coChangeLimit = parseNum(values6["co-change-limit"], "co-change-limit", 500, true);
    conflictThreshold = parseNum(values6["conflict-threshold"], "conflict-threshold", 0.5);
    if (conflictThreshold < 0 || conflictThreshold > 1) {
      opError(`--conflict-threshold must be between 0 and 1, got: ${conflictThreshold}`);
    }
    if (widthFlag !== null && widthFlag < 1) {
      opError(`--width must be >= 1, got: ${widthFlag}`);
    }
    if (buildMin !== null && buildMin <= 0) {
      opError(`--build-min must be > 0, got: ${buildMin}`);
    }
    if (mergeMin !== null && mergeMin <= 0) {
      opError(`--merge-min must be > 0, got: ${mergeMin}`);
    }
    if (coChangeLimit < 1) {
      opError(`--co-change-limit must be >= 1, got: ${coChangeLimit}`);
    }
    ({ tickets: allTickets, errors: ticketErrors } = loadTickets(ticketsPath));
    if (ticketErrors.length > 0) {
      const cycle = ticketErrors.find((error) => /cycle in ticket DAG/i.test(error));
      if (cycle) {
        const message = `dependency ${cycle} \u2014 cannot schedule`;
        const result6 = {
          pairs: [],
          waves: [],
          mergeOrder: [],
          certifiedWidth: 0,
          backpressureWidth: null,
          recommendedWidth: 0,
          warnings: [],
          gateFailures: [message],
          pullQueueNote: "idle builders claim next unblocked"
        };
        if (values6.json) printJson(result6);
        else console.error(`merge-forecast: ${message}`);
        process.exit(2);
      }
      opError(`ticket errors:
  ${ticketErrors.join("\n  ")}`);
    }
    tickets = activeTickets2(allTickets);
    if (tickets.length === 0) {
      opError(allTickets.length > 0 ? "no active tickets found (all tickets are completed)" : "no tickets found");
    }
    try {
      result5 = await runForecast({
        tickets,
        root: process.cwd(),
        coChangeLimit,
        conflictThreshold,
        width: widthFlag,
        buildMin,
        mergeMin,
        graphCouplingFile: values6["graph-coupling"]
      });
    } catch (err) {
      opError(err.message ?? String(err));
    }
    if (values6.json) {
      printJson(result5);
    } else {
      process.stdout.write(formatForecast(result5));
    }
    if (result5.gateFailures.length > 0) {
      const msg = "Gate failed:\n" + result5.gateFailures.map((f) => `  ${f}`).join("\n");
      if (!values6.json) console.error("\n" + msg);
      process.exit(2);
    }
    pass();
  }
});

// node_modules/@adlc/tickets/bin/adlc-tickets.mjs
var adlc_tickets_exports = {};
import { readFileSync as readFileSync27, rmSync as rmSync4 } from "node:fs";
import { dirname as dirname20, join as join24, resolve as resolve12 } from "node:path";
function parse3(argv) {
  const flags2 = {};
  const positionals3 = [];
  const boolean = /* @__PURE__ */ new Set(["write", "json", "yes", "authorize", "archive", "complete", "rollback", "help", "force", "allow-unsigned"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals3.push(value);
      continue;
    }
    const name = value.slice(2);
    if (boolean.has(name)) flags2[name] = true;
    else {
      if (index + 1 >= argv.length) throw new TicketStoreError("invalid", "MISSING_FLAG_VALUE", `--${name} requires a value`);
      flags2[name] = argv[++index];
    }
  }
  return { flags: flags2, positionals: positionals3 };
}
async function readInput(path) {
  const text = path === "-" ? await new Promise((resolveText, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolveText(body));
    process.stdin.on("error", reject);
  }) : readFileSync27(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TicketStoreError("invalid", "INVALID_INPUT_JSON", `invalid input JSON: ${error.message}`);
  }
}
function emit(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}
async function main() {
  const { flags: flags2, positionals: positionals3 } = parse3(process.argv.slice(2));
  const command = positionals3[0];
  if (flags2.help || positionals3.length === 0) {
    console.log(command && renderCommandHelp(command) || renderUsage());
    return;
  }
  if (command === "schema") {
    emit(ticketJsonSchema(), true);
    return;
  }
  const root2 = resolve12(flags2.root ?? ".");
  const key = resolveKeyFromEnv();
  const allowUnsigned = Boolean(flags2["allow-unsigned"]);
  const warnIfUnsigned = (tickets2) => {
    if (!allowUnsigned || key) return;
    let trustRoot = true;
    if (tickets2 !== void 0) {
      try {
        trustRoot = repoDeclaresRails(root2, tickets2);
      } catch {
        trustRoot = true;
      }
    }
    if (!trustRoot) return;
    console.error(
      "warning: --allow-unsigned with no ADLC_MANIFEST_KEY \u2014 this mutation of a frozen trust root will be recorded UNSIGNED. An unsigned audit entry is not evidence: it proves nothing about who made the change, and anyone who can append to the manifest can forge another just like it. The manifest is append-only, so this entry is permanent."
    );
  };
  const storeCommand = command === "store" ? positionals3[1] : null;
  if (storeCommand === "migrate") {
    if (flags2.write) warnIfUnsigned();
    emit(migrateLegacyStore(root2, { write: Boolean(flags2.write), yes: Boolean(flags2.yes), key, allowUnsigned }), flags2.json);
    return;
  }
  if (storeCommand === "recover") {
    warnIfUnsigned();
    const transactions = pendingTransactions(root2);
    if (transactions.length !== 1) throw new TicketStoreError("conflict", "RECOVERY_SELECTION_REQUIRED", `expected one pending transaction, found ${transactions.length}`);
    const direction = flags2.complete ? "complete" : flags2.rollback ? "rollback" : null;
    let journal;
    try {
      journal = JSON.parse(readFileSync27(join24(root2, TRANSACTION_DIRECTORY, transactions[0], "journal.json"), "utf8"));
    } catch (error) {
      throw new TicketStoreError("invalid", "INVALID_JOURNAL", `cannot read transaction journal: ${error.message}`);
    }
    if (journal.operation === "migrate") emit(recoverMigration(root2, transactions[0], { direction, key, allowUnsigned }), flags2.json);
    else {
      const recoveryStore = detectTicketStore({ root: root2, ticketStore: flags2["ticket-store"], legacyTickets: flags2.tickets, allowRecovery: true });
      emit(recoverDirectoryTransaction(recoveryStore, transactions[0], { root: root2, direction, key, allowUnsigned }), flags2.json);
    }
    return;
  }
  let store = detectTicketStore({ root: root2, ticketStore: flags2["ticket-store"], legacyTickets: flags2.tickets, allowRecovery: command === "doctor" });
  if (storeCommand === "status") {
    const snapshot2 = store.load();
    emit({ backend: snapshot2.backend, formatVersion: snapshot2.formatVersion, tickets: snapshot2.tickets.length, storeHash: snapshot2.hash, pendingTransactions: pendingTransactions(root2) }, flags2.json);
    return;
  }
  if (storeCommand === "export") {
    if (!flags2.output) throw new TicketStoreError("invalid", "OUTPUT_REQUIRED", "store export requires --output");
    const exported = exportLegacyStore(store, resolve12(root2, flags2.output), { root: root2 });
    emit({ output: flags2.output, tickets: exported.tickets.length, storeHash: exported.hash }, flags2.json);
    return;
  }
  if (command === "doctor") {
    const report = doctorTicketStore(store, { root: root2, archive: Boolean(flags2.archive), key });
    process.exitCode = report.ok ? 0 : 2;
    emit(report, flags2.json);
    return;
  }
  const snapshot = store.load();
  if (command === "list") {
    emit(snapshot.tickets.map((ticket2) => ({ id: ticket2.id, title: ticket2.title, ticketHash: snapshot.ticketHashes[ticket2.id] })), flags2.json);
    if (store instanceof LegacyTicketStore && !flags2.json) console.error("warning: legacy ticket store active; run `adlc ticket store migrate` to preview migration");
    return;
  }
  if (command === "show") {
    const ticket2 = snapshot.get(positionals3[1]);
    if (!ticket2) throw new TicketStoreError("invalid", "TICKET_NOT_FOUND", `ticket not found: ${positionals3[1]}`);
    emit({ ticket: ticket2, ticketHash: snapshot.ticketHashes[ticket2.id], storeHash: snapshot.hash }, flags2.json);
    return;
  }
  const mutationCommands = /* @__PURE__ */ new Set(["create", "update", "edit", "discard", "complete", "archive", "restore"]);
  if (!mutationCommands.has(command)) throw new TicketStoreError("invalid", "UNKNOWN_COMMAND", `unknown ticket command: ${command}`);
  store = await offerLegacyMigration(store, root2, flags2, { emit: (value) => emit(value, false), key, allowUnsigned });
  if (flags2.write) warnIfUnsigned(snapshot.tickets);
  const service = new TicketService(store, { root: root2, key, allowUnsigned });
  let plan;
  let editDraftPath = null;
  if (command === "create") {
    if (!flags2.input) throw new TicketStoreError("invalid", "INPUT_REQUIRED", "create requires --input");
    const input = await readInput(flags2.input);
    const warning = categoryWarning(input?.category);
    if (warning) console.error(warning);
    plan = service.planCreate(input);
  } else if (command === "update") {
    if (!flags2.input) throw new TicketStoreError("invalid", "INPUT_REQUIRED", "update requires --input");
    if (flags2.write && !flags2.expect && !flags2.force) {
      throw new TicketStoreError(
        "policy",
        "EXPECT_REQUIRED",
        "update --write requires --expect <ticketHash> so a concurrent write cannot be silently overwritten. Take the hash from `adlc ticket show <id> --json`, or pass --force to replace whatever is there now."
      );
    }
    const updateInput = await readInput(flags2.input);
    const updateWarning = categoryWarning(updateInput?.category);
    if (updateWarning) console.error(updateWarning);
    plan = service.planUpdate(positionals3[1], updateInput, {
      expect: flags2.force ? void 0 : flags2.expect,
      authorized: Boolean(flags2.authorize)
    });
  } else if (command === "edit") {
    const session = planEditSession(service, positionals3[1], {
      authorized: Boolean(flags2.authorize),
      editor: process.env.EDITOR || process.env.VISUAL,
      onEdited: (edited) => {
        const w = categoryWarning(edited?.category);
        if (w) console.error(w);
      }
    });
    plan = session.plan;
    editDraftPath = session.draftPath;
  } else if (command === "discard") plan = service.planDiscard(positionals3[1]);
  else if (command === "complete") plan = service.planComplete(positionals3[1], { authorized: Boolean(flags2.authorize) });
  else if (command === "archive" || command === "restore") {
    if (!(store instanceof DirectoryTicketStore)) throw new TicketStoreError("policy", "DIRECTORY_STORE_REQUIRED", `${command} requires a directory store`);
    const options = { expectedSnapshotHash: snapshot.hash, reason: flags2.reason, sourceRevision: flags2.revision, root: root2, authorized: Boolean(flags2.authorize), key, allowUnsigned };
    if (!flags2.write) {
      emit({ operation: command, ticketId: positionals3[1], expectedSnapshotHash: snapshot.hash, evidenceRequired: true, dryRun: true }, flags2.json);
      return;
    }
    const result6 = command === "archive" ? archiveTicket(store, join24(root2, ".adlc/ticket-archive"), positionals3[1], options) : restoreTicket(store, join24(root2, ".adlc/ticket-archive"), positionals3[1], options);
    emit({ operation: command, applied: true, storeHash: result6.active.hash }, flags2.json);
    return;
  }
  emit({ ...serializePlan(plan), dryRun: !flags2.write }, flags2.json);
  if (flags2.write) {
    let applied2;
    try {
      applied2 = service.apply(plan);
    } catch (error) {
      if (editDraftPath && error && typeof error.message === "string") {
        error.message = `${error.message} (your edit is preserved at ${editDraftPath})`;
      }
      throw error;
    }
    emit({ applied: true, storeHash: applied2.hash, ticketHash: plan.ticketId ? applied2.ticketHashes[plan.ticketId] : null }, flags2.json);
    if (editDraftPath) rmSync4(dirname20(editDraftPath), { recursive: true, force: true });
  } else if (editDraftPath) {
    console.error(`edit not applied (dry run); your edited ticket is at ${editDraftPath}`);
  }
}
var init_adlc_tickets = __esm({
  "node_modules/@adlc/tickets/bin/adlc-tickets.mjs"() {
    init_key_contract();
    init_tickets();
    main().catch((error) => {
      const structured = error instanceof TicketStoreError ? error : new TicketStoreError("operational", "UNEXPECTED", error?.message ?? String(error));
      if (process.argv.includes("--json")) console.error(JSON.stringify({ ok: false, kind: structured.kind, code: structured.code, message: structured.message, details: structured.details }));
      else console.error(`${structured.code}: ${structured.message}`);
      process.exitCode = exitCodeFor(structured);
    });
  }
});

// vendor/adlc/package.json
var package_default = {
  name: "@adlc/cli-vendored-by-antigravity-booster",
  version: "1.11.1",
  private: true,
  description: "Booster-owned, bundled subset of the @adlc CLI (8 verbs) for zero-node_modules plugin installs. Built by `npm run vendor:bundle`; do not edit dist/ by hand.",
  type: "module",
  bin: {
    adlc: "bin/adlc.mjs"
  }
};

// vendor/adlc/src/dispatch.mjs
var VERBS = Object.freeze({
  "rails-guard": () => Promise.resolve().then(() => (init_rails_guard(), rails_guard_exports)),
  "gate-manifest": () => Promise.resolve().then(() => (init_gate_manifest2(), gate_manifest_exports)),
  "flail-detector": () => Promise.resolve().then(() => (init_flail_detector(), flail_detector_exports)),
  "hollow-test": () => Promise.resolve().then(() => (init_hollow_test(), hollow_test_exports)),
  "consensus-fix": () => init_consensus_fix().then(() => consensus_fix_exports),
  "model-router": () => init_model_router().then(() => model_router_exports),
  "merge-forecast": () => init_merge_forecast().then(() => merge_forecast_exports),
  ticket: () => Promise.resolve().then(() => (init_adlc_tickets(), adlc_tickets_exports))
});
function usage() {
  return `adlc ${package_default.version} (vendored by antigravity-booster)
usage: adlc <verb> [args]
verbs: ${Object.keys(VERBS).join(", ")}
`;
}
async function main2(argv) {
  const [verb2, ...rest] = argv;
  if (verb2 === "--version" || verb2 === "-v") {
    process.stdout.write(`${package_default.version}
`);
    return;
  }
  if (verb2 === void 0 || verb2 === "--help" || verb2 === "-h" || verb2 === "help") {
    process.stdout.write(usage());
    return;
  }
  const load = Object.hasOwn(VERBS, verb2) ? VERBS[verb2] : void 0;
  if (!load) {
    process.stderr.write(`verb not vendored: ${verb2}
`);
    process.exitCode = 1;
    return;
  }
  process.argv = [process.argv[0], `adlc-${verb2}`, ...rest];
  await load();
}
main2(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`adlc: ${err?.stack ?? err}
`);
  process.exitCode = 1;
});
export {
  VERBS
};
