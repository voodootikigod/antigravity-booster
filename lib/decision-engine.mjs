// System-1 decision engine: zero-dependency multi-provider client for cheap
// noul / choice / score primitives, plus fail-closed gating recipes.
// Every failure path degrades to "run the full System-2 path".

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRIMITIVES = ['noul', 'choice', 'score'];
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_DECISION_DIFF_CHARS = 12_000;
const MIN_CONFIDENCE = 0.85;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const PROVIDERS = {
  'gemini-decisions': {
    model: 'gemini-decision-1',
    url: 'https://generativelanguage.googleapis.com/v1beta/decisions',
    keyEnv: 'GEMINI_API_KEY',
  },
  jev: {
    model: 'jev-latest',
    url: 'https://api.typesafe.ai/v1/systemOne',
    keyEnv: 'TYPESAFE_API_KEY',
  },
  kev: { model: 'kev-latest', url: null, keyEnv: 'AGB_KEV_API_KEY' },
};

export const DECISION_PROVIDERS = Object.keys(PROVIDERS);

// ---------- helpers ----------

export function validateDecisionUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('invalid decision endpoint URL');
  }
  const loopback = LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && loopback) return u.toString();
  throw new Error('decision endpoint must be https (or http on loopback)');
}

function isLoopbackDecisionUrl(raw) {
  try {
    const u = new URL(String(raw));
    return LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('[REDACTED]');
  }
  out = out.replace(/(key|token|bearer|authorization)(["'\s:=]+)[A-Za-z0-9._\-]{8,}/gi, '$1$2[REDACTED]');
  out = out.replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[REDACTED]');
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const unitNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

// ---------- config ----------

export function resolveDecisionConfig({ repo, env = process.env, enabled } = {}) {
  if (env.AGB_DECISION_ENGINE === '0' || enabled === false) return { enabled: false };
  let cfg = {};
  if (repo) {
    const p = join(repo, '.adlc', 'config.json');
    if (existsSync(p)) {
      try {
        cfg = JSON.parse(readFileSync(p, 'utf8'))?.accelerators?.decision ?? {};
      } catch {
        cfg = {};
      }
    }
  }
  if (cfg === null || typeof cfg !== 'object') cfg = {};
  if (cfg.enabled === false && !env.AGB_DECISION_PROVIDER && enabled !== true) {
    return { enabled: false };
  }
  const hasGeminiKey = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
  const explicitProvider = env.AGB_DECISION_PROVIDER || cfg.provider;
  const autoDetected = !explicitProvider && hasGeminiKey;
  const provider = explicitProvider || (hasGeminiKey ? 'gemini-decisions' : undefined);
  const wanted =
    typeof enabled === 'boolean'
      ? enabled
      : cfg.enabled === true || Boolean(env.AGB_DECISION_PROVIDER) || autoDetected;
  if (!wanted || !provider || !PROVIDERS[provider]) return { enabled: false };
  const spec = PROVIDERS[provider];
  let baseUrl;
  let usingRepoBaseUrl = false;
  if (provider === 'kev') {
    if (env.AGB_KEV_BASE_URL) {
      baseUrl = env.AGB_KEV_BASE_URL;
    } else if (
      typeof cfg.baseUrl === 'string' &&
      cfg.baseUrl &&
      (isLoopbackDecisionUrl(cfg.baseUrl) || env.AGB_ALLOW_REPO_KEV_URL === '1')
    ) {
      baseUrl = cfg.baseUrl;
      usingRepoBaseUrl = true;
    }
  } else {
    // Pin hosted providers ('gemini-decisions', 'jev') to official endpoints so
    // repo-controlled .adlc/config.json cannot redirect host API keys.
    baseUrl = spec.url;
  }
  if (!baseUrl) return { enabled: false };
  const apiKey = usingRepoBaseUrl
    ? undefined
    : env[spec.keyEnv] || (provider === 'kev' ? env.OPENROUTER_API_KEY : undefined) || undefined;
  if (provider !== 'kev' && !apiKey) return { enabled: false };
  try {
    validateDecisionUrl(baseUrl);
  } catch {
    return { enabled: false };
  }
  return {
    enabled: true,
    provider,
    model: cfg.model || spec.model,
    baseUrl,
    apiKey,
    timeoutMs: num(cfg.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    ...(autoDetected ? { autoDetected: true } : {}),
  };
}

// ---------- drivers ----------

const DEFAULT_SCORE_CRITERIA = {
  0: '0.0 (Lowest / None)',
  1: '1.0 (Highest / Critical)',
};

function buildRequest(provider, { primitive, queries, model, apiKey, input }) {
  const headers = { 'content-type': 'application/json' };
  const items = queries.map((q, i) => ({
    id: String(q.id ?? i),
    prompt: q.prompt,
    ...(primitive === 'choice' ? { choices: q.choices ?? [] } : {}),
    ...(q.criteria ? { criteria: q.criteria } : {}),
  }));
  if (provider === 'gemini-decisions') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    const questions = {};
    for (const item of items) {
      const qSpec = { type: primitive, instructions: item.prompt };
      if (primitive === 'choice') {
        qSpec.criteria =
          item.criteria ??
          Object.fromEntries((item.choices ?? []).map((c) => [String(c), String(c)]));
      } else if (primitive === 'score') {
        qSpec.criteria = item.criteria ?? DEFAULT_SCORE_CRITERIA;
      }
      questions[item.id] = qSpec;
    }
    const sharedInput =
      typeof input === 'string' && input.length > 0
        ? input
        : items.length === 1
          ? items[0].prompt
          : items.map((it) => `[${it.id}]\n${it.prompt}`).join('\n\n');
    return {
      headers,
      body: {
        model,
        input: sharedInput,
        questions,
      },
      questionIds: items.map((it) => it.id),
    };
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const fullItems =
    typeof input === 'string' && input.length > 0
      ? items.map((it) => ({ ...it, prompt: `${it.prompt}\n${input}` }))
      : items;
  return {
    headers,
    body: { model, primitive, items: fullItems },
    questionIds: items.map((it) => it.id),
  };
}

function normalizeAnswer(primitive, a) {
  if (!a || typeof a !== 'object') return null;
  const confidence = unitNum(a.confidence);
  if (confidence === null) return null;
  if (primitive === 'noul') {
    const probability = unitNum(a.probability ?? a.p ?? a.noul);
    return probability === null ? null : { probability, confidence };
  }
  if (primitive === 'score') {
    const score = unitNum(a.score ?? a.value);
    return score === null ? null : { score, confidence };
  }
  const choice = a.choice ?? a.label;
  return typeof choice === 'string' ? { choice, confidence } : null;
}

export class DecisionEngine {
  constructor({ provider, model, baseUrl, apiKey, transport, timeoutMs } = {}) {
    if (!PROVIDERS[provider]) throw new Error(`unknown decision provider: ${provider}`);
    this.provider = provider;
    this.model = model || PROVIDERS[provider].model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = transport ?? ((...a) => globalThis.fetch(...a));
    this.url = validateDecisionUrl(baseUrl ?? PROVIDERS[provider].url);
  }

  static fromConfig(cfg, extra = {}) {
    if (!cfg?.enabled) return null;
    return new DecisionEngine({ ...cfg, ...extra });
  }

  fail(started, err) {
    return {
      ok: false,
      provider: this.provider,
      model: this.model,
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      answers: [],
      error: scrubSecrets(err?.message ?? err, [this.apiKey]),
    };
  }

  async evaluate(primitive, queries, { input } = {}) {
    const started = Date.now();
    try {
      if (!PRIMITIVES.includes(primitive)) throw new Error(`unknown primitive: ${primitive}`);
      if (!Array.isArray(queries) || queries.length === 0) throw new Error('no queries');
      const { headers, body, questionIds } = buildRequest(this.provider, {
        primitive,
        queries,
        model: this.model,
        apiKey: this.apiKey,
        input,
      });
      const res = await this.transport(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? 'error'}`);
      const json = await res.json();
      let raw;
      if (Array.isArray(json?.answers)) {
        raw = json.answers;
      } else if (json?.answers && typeof json.answers === 'object') {
        raw = questionIds.map((id) => json.answers[id]);
      } else if (Array.isArray(json?.results)) {
        raw = json.results;
      }
      if (!Array.isArray(raw) || raw.length !== queries.length) throw new Error('malformed response');
      const answers = raw.map((a) => normalizeAnswer(primitive, a));
      if (answers.some((a) => a === null)) throw new Error('malformed answer');
      return {
        ok: true,
        provider: this.provider,
        model: json.model ?? this.model,
        latencyMs: Date.now() - started,
        inputTokens:
          num(
            json.usage?.total_input_tokens ??
              json.usage?.totalInputTokens ??
              json.usage?.inputTokens ??
              json.inputTokens,
          ) ?? 0,
        outputTokens: 0,
        answers,
      };
    } catch (err) {
      return this.fail(started, err?.name === 'TimeoutError' ? new Error('request timed out') : err);
    }
  }

  noul(queries, opts) {
    return this.evaluate('noul', queries, opts);
  }
  choice(queries, opts) {
    return this.evaluate('choice', queries, opts);
  }
  score(queries, opts) {
    return this.evaluate('score', queries, opts);
  }
}

// ---------- recipes (all fail closed) ----------

const good = (r, n) => r?.ok === true && Array.isArray(r.answers) && r.answers.length === n;
const isEngine = (e) => e && typeof e.evaluate === 'function';
const clip = (s, n = 4000) => String(s ?? '').slice(0, n);

export async function gateReviewLenses(engine, { diff, contextSummary, lenses } = {}) {
  const names = Array.isArray(lenses) ? lenses : Object.keys(lenses ?? {});
  const descr = Array.isArray(lenses) ? {} : (lenses ?? {});
  const runAll = (reason) => ({
    run: [...names],
    skipped: [],
    decisions: Object.fromEntries(names.map((n) => [n, { action: 'run', reason }])),
  });
  if (!isEngine(engine) || names.length === 0) return runAll('engine unavailable');
  const diffStr = String(diff ?? '');
  if (diffStr.length > MAX_DECISION_DIFF_CHARS) return runAll('diff_truncated');
  const sharedInput = `Context: ${clip(contextSummary, 1000)}\nDiff:\n${diffStr}`;
  const queries = names.map((n) => ({
    id: n,
    prompt: `Does this change contain a defect in the "${n}" lens (${descr[n] ?? n})?`,
  }));
  let r;
  try {
    r = await engine.noul(queries, { input: sharedInput });
  } catch {
    return runAll('engine error');
  }
  if (!good(r, names.length)) return runAll('engine error');
  const out = { run: [], skipped: [], decisions: {} };
  names.forEach((n, i) => {
    const a = r.answers[i];
    const skip = a.probability < 0.15 && a.confidence >= MIN_CONFIDENCE;
    (skip ? out.skipped : out.run).push(n);
    out.decisions[n] = {
      action: skip ? 'skip' : 'run',
      probability: a.probability,
      confidence: a.confidence,
    };
  });
  return out;
}

export async function screenTicketFastShip(engine, { ticket, diff, blastRadius, hollowTest } = {}) {
  const no = (reason) => ({ fastShip: false, reason });
  if (!(hollowTest?.ok && hollowTest.total > 0 && hollowTest.survived === 0)) return no('hollow-test gate not clean');
  if (blastRadius?.level !== 'low') return no('blast radius not low');
  if (!ticket || ticket.tier === 'frontier') return no('frontier or missing ticket');
  if (!isEngine(engine)) return no('engine unavailable');
  const diffStr = String(diff ?? '');
  if (diffStr.length > MAX_DECISION_DIFF_CHARS) return no('diff_truncated');
  const acs = Array.isArray(ticket.extractedACs) ? ticket.extractedACs : [];
  const charges = Array.isArray(ticket.charges ?? ticket.prosecutionCharges)
    ? (ticket.charges ?? ticket.prosecutionCharges)
    : [];
  if (acs.length === 0) return no('no extracted acceptance criteria');
  const text = (x) => (typeof x === 'string' ? x : (x?.text ?? x?.claim ?? JSON.stringify(x)));
  const sharedInput = `Diff:\n${diffStr}`;
  const acQ = acs.map((ac, i) => ({
    id: `ac-${i}`,
    prompt: `Is this acceptance criterion fully satisfied by the diff?\nAC: ${text(ac)}`,
  }));
  const chQ = charges.map((c, i) => ({
    id: `charge-${i}`,
    prompt: `Is this prosecution charge a real defect in the diff?\nCharge: ${text(c)}`,
  }));
  let r;
  try {
    r = await engine.noul([...acQ, ...chQ], { input: sharedInput });
  } catch {
    return no('engine error');
  }
  if (!good(r, acQ.length + chQ.length)) return no('engine error');
  const acA = r.answers.slice(0, acQ.length);
  const chA = r.answers.slice(acQ.length);
  const minConfidence = Math.min(...r.answers.map((a) => a.confidence));
  if (minConfidence < MIN_CONFIDENCE) return no('confidence below 0.85');
  if (!acA.every((a) => a.probability >= 0.92)) return no('acceptance criterion not confidently met');
  if (!chA.every((a) => a.probability < 0.1)) return no('prosecution charge risk too high');
  return { fastShip: true, reason: 'all fast-ship conditions met', minConfidence, model: r.model };
}

const VERDICTS = ['accept', 'reject', 'escalate'];
const ROUTES = ['auto-fix', 'grill-me'];
const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const SEV_BANDS = [
  [0.75, 'critical'],
  [0.5, 'high'],
  [0.25, 'medium'],
  [-Infinity, 'low'],
];

export async function triageFindingsSystemOne(engine, { findings, targetType, context } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const escalateAll = (reason) => ({
    ok: false,
    reason,
    triaged: list.map((f) => ({ finding: f, system2: true, verdict: 'escalate', blast_radius: Boolean(f?.blast_radius) })),
  });
  if (list.length === 0) return { ok: true, triaged: [] };
  if (!isEngine(engine)) return escalateAll('engine unavailable');
  const desc = (f) => `${targetType ?? 'change'} finding: ${clip(f?.claim, 800)}\nEvidence: ${clip(f?.evidence, 800)}\nContext: ${clip(context, 800)}`;
  let v, s, rt, b;
  try {
    [v, s, rt, b] = await Promise.all([
      engine.choice(list.map((f, i) => ({ id: `v-${i}`, prompt: `Verdict for ${desc(f)}`, choices: VERDICTS }))),
      engine.score(list.map((f, i) => ({ id: `s-${i}`, prompt: `Severity 0-1 of ${desc(f)}` }))),
      engine.choice(list.map((f, i) => ({ id: `r-${i}`, prompt: `Resolution route for ${desc(f)}`, choices: ROUTES }))),
      engine.noul(list.map((f, i) => ({ id: `b-${i}`, prompt: `Does this have wide blast radius? ${desc(f)}` }))),
    ]);
  } catch {
    return escalateAll('engine error');
  }
  const n = list.length;
  if (![v, s, rt, b].every((r) => good(r, n))) return escalateAll('engine error');
  const triaged = list.map((f, i) => {
    const conf = Math.min(v.answers[i].confidence, s.answers[i].confidence, rt.answers[i].confidence, b.answers[i].confidence);
    const shape = typeof f?.id === 'string' && f.id.startsWith('SHAPE-');
    const blast = Boolean(f?.blast_radius) || b.answers[i].probability >= 0.5;
    let severity = SEV_BANDS.find(([min]) => s.answers[i].score >= min)[1];
    if (shape && typeof f?.severity === 'string' && (SEV_RANK[f.severity] ?? -1) > (SEV_RANK[severity] ?? -1)) {
      severity = f.severity;
    }
    const route = ROUTES.includes(rt.answers[i].choice) ? rt.answers[i].choice : 'grill-me';
    let verdict = VERDICTS.includes(v.answers[i].choice) ? v.answers[i].choice : 'escalate';
    const system2 = conf < MIN_CONFIDENCE;
    // Safety floors identical to lib/review.mjs: SHAPE-* never dropped,
    // blast_radius always escalates.
    if (blast) verdict = 'escalate';
    else if (shape && verdict === 'reject') verdict = 'accept';
    if (system2 && !shape) verdict = 'escalate';
    return {
      finding: f,
      verdict,
      severity,
      resolution_route: shape ? (f.resolution_route ?? route) : route,
      blast_radius: blast,
      confidence: conf,
      system2,
    };
  });
  return { ok: true, triaged };
}

export async function scoreColdstartTickets(engine, { tickets, gate } = {}) {
  const list = Array.isArray(tickets) ? tickets : [];
  const escalateAll = (reason) => ({
    ok: false,
    reason,
    scores: list.map((t) => ({ ticket: t?.id, system2: true, executable: false })),
  });
  if (list.length === 0) return { ok: true, scores: [] };
  if (!isEngine(engine)) return escalateAll('engine unavailable');
  const body = (t) => `Gate: ${gate ?? 'coldstart'}\nTicket ${t?.id}: ${clip(t?.body ?? t?.spec ?? t?.description ?? JSON.stringify(t), 2000)}`;
  let ex, gap;
  try {
    [ex, gap] = await Promise.all([
      engine.score(list.map((t, i) => ({ id: `e-${i}`, prompt: `Executable confidence 0-1 for cold-start agent.\n${body(t)}` }))),
      engine.noul(list.map((t, i) => ({ id: `g-${i}`, prompt: `Does this ticket have a spec gap blocking execution?\n${body(t)}` }))),
    ]);
  } catch {
    return escalateAll('engine error');
  }
  if (!good(ex, list.length) || !good(gap, list.length)) return escalateAll('engine error');
  const scores = list.map((t, i) => {
    const confidence = Math.min(ex.answers[i].confidence, gap.answers[i].confidence);
    const gapRisk = gap.answers[i].probability;
    const system2 = confidence < MIN_CONFIDENCE || gapRisk >= 0.2;
    return {
      ticket: t?.id,
      executable: !system2,
      score: ex.answers[i].score,
      gapRisk,
      confidence,
      system2,
    };
  });
  return { ok: true, scores };
}
