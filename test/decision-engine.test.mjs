import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DecisionEngine,
  resolveDecisionConfig,
  gateReviewLenses,
  screenTicketFastShip,
  triageFindingsSystemOne,
  scoreColdstartTickets,
  validateDecisionUrl,
} from '../lib/decision-engine.mjs';

const KEY = 'sk-secret-key-123456';

function answerFor(primitive, n, { p = 0.01, c = 0.99, choice = 'accept', score = 0.1 } = {}) {
  return Array.from({ length: n }, () =>
    primitive === 'noul'
      ? { probability: p, confidence: c }
      : primitive === 'score'
        ? { score, confidence: c }
        : { choice, confidence: c },
  );
}

function mock(opts = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const items = body.items ?? body.requests;
    return { ok: true, status: 200, json: async () => ({ answers: answerFor(body.primitive, items.length, opts) }) };
  };
}

const eng = (opts, provider = 'jev') =>
  new DecisionEngine({ provider, apiKey: KEY, baseUrl: provider === 'kev' ? 'http://localhost:8080/v1' : undefined, transport: mock(opts) });

const throwing = (msg = 'down') => new DecisionEngine({ provider: 'jev', apiKey: KEY, transport: async () => { throw new Error(msg); } });

// ACs (ids "ac-*") get 0.97, charges get 0.02
const fastEngine = (c = 0.95) =>
  new DecisionEngine({
    provider: 'jev',
    apiKey: KEY,
    transport: async (u, init) => {
      const items = JSON.parse(init.body).items;
      return { ok: true, json: async () => ({ answers: items.map((i) => ({ probability: i.id.startsWith('ac') ? 0.97 : 0.02, confidence: c })) }) };
    },
  });

test('config disabled by default and via opt-out', () => {
  const repo = mkdtempSync(join(tmpdir(), 'de-'));
  assert.deepEqual(resolveDecisionConfig({ repo, env: {} }), { enabled: false });
  mkdirSync(join(repo, '.adlc'));
  writeFileSync(join(repo, '.adlc', 'config.json'), JSON.stringify({ accelerators: { decision: { enabled: true, provider: 'jev' } } }));
  assert.equal(resolveDecisionConfig({ repo, env: { TYPESAFE_API_KEY: KEY } }).enabled, true);
  assert.deepEqual(resolveDecisionConfig({ repo, env: { TYPESAFE_API_KEY: KEY, AGB_DECISION_ENGINE: '0' } }), { enabled: false });
  assert.equal(resolveDecisionConfig({ repo, env: {} }).enabled, false);
  const g = resolveDecisionConfig({ env: { AGB_DECISION_PROVIDER: 'gemini-decisions', GEMINI_API_KEY: KEY } });
  assert.equal(g.model, 'gemini-decision-1');
  const k = resolveDecisionConfig({ env: { AGB_DECISION_PROVIDER: 'kev', AGB_KEV_BASE_URL: 'http://127.0.0.1:9/v1' } });
  assert.equal(k.enabled, true);
  assert.equal(resolveDecisionConfig({ env: { AGB_DECISION_PROVIDER: 'kev', AGB_KEV_BASE_URL: 'http://evil.com/v1' } }).enabled, false);
});

test('url validation', () => {
  assert.throws(() => validateDecisionUrl('http://example.com'));
  assert.throws(() => validateDecisionUrl('nope'));
  validateDecisionUrl('https://example.com');
  validateDecisionUrl('http://localhost:1');
});

test('primitives across providers have zero output tokens', async () => {
  for (const provider of ['jev', 'gemini-decisions', 'kev']) {
    const e = eng({}, provider);
    for (const prim of ['noul', 'choice', 'score']) {
      const r = await e[prim]([{ prompt: 'x', choices: ['a'] }]);
      assert.equal(r.ok, true, `${provider}/${prim}`);
      assert.equal(r.outputTokens, 0);
      assert.equal(r.provider, provider);
      assert.equal(r.answers.length, 1);
    }
  }
  assert.equal(eng({}, 'jev').model, 'jev-latest');
});

test('errors scrub api keys', async () => {
  const r = await throwing(`boom ${KEY}`).noul([{ prompt: 'x' }]);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(KEY));
  const h = await new DecisionEngine({ provider: 'jev', apiKey: KEY, transport: async () => ({ ok: false, status: 500 }) }).noul([{ prompt: 'x' }]);
  assert.equal(h.ok, false);
  const t = await new DecisionEngine({
    provider: 'jev',
    apiKey: KEY,
    transport: async () => {
      const err = new Error(`timeout ${KEY}`);
      err.name = 'TimeoutError';
      throw err;
    },
  }).noul([{ prompt: 'x' }]);
  assert.equal(t.ok, false);
  assert.ok(!JSON.stringify(t).includes(KEY));
});

const okInputs = () => ({
  ticket: { tier: 'mid', extractedACs: ['a', 'b'], charges: ['c1'] },
  diff: 'd',
  blastRadius: { level: 'low' },
  hollowTest: { ok: true, total: 3, survived: 0 },
});

test('fast ship passes only when all conditions hold', async () => {
  const res = await screenTicketFastShip(fastEngine(), okInputs());
  assert.equal(res.fastShip, true);
  assert.equal(res.model, 'jev-latest');
});

test('fast ship fails closed', async () => {
  const mut = (f) => {
    const i = okInputs();
    f(i);
    return i;
  };
  const cases = [
    mut((i) => (i.hollowTest.total = 0)),
    mut((i) => (i.hollowTest.survived = 1)),
    mut((i) => (i.hollowTest = undefined)),
    mut((i) => (i.ticket.extractedACs = [])),
    mut((i) => (i.blastRadius.level = 'medium')),
    mut((i) => (i.ticket.tier = 'frontier')),
  ];
  for (const c of cases) assert.equal((await screenTicketFastShip(fastEngine(), c)).fastShip, false);
  assert.equal((await screenTicketFastShip(fastEngine(0.5), okInputs())).fastShip, false);
  assert.equal((await screenTicketFastShip(eng({ p: 0.97, c: 0.95 }), okInputs())).fastShip, false);
  assert.equal((await screenTicketFastShip(throwing(), okInputs())).fastShip, false);
  assert.equal((await screenTicketFastShip(null, okInputs())).fastShip, false);
});

test('gateReviewLenses skips only on low prob + high confidence', async () => {
  const lenses = { a: 'x', b: 'y' };
  let r = await gateReviewLenses(eng({ p: 0.05, c: 0.9 }), { diff: 'd', lenses });
  assert.deepEqual(r.skipped, ['a', 'b']);
  r = await gateReviewLenses(eng({ p: 0.05, c: 0.8 }), { diff: 'd', lenses });
  assert.deepEqual(r.run, ['a', 'b']);
  r = await gateReviewLenses(eng({ p: 0.15, c: 0.99 }), { diff: 'd', lenses });
  assert.deepEqual(r.run, ['a', 'b']);
  r = await gateReviewLenses(throwing(), { diff: 'd', lenses });
  assert.deepEqual(r.run, ['a', 'b']);
});

test('triage preserves SHAPE-* and blast_radius floors; escalates on low confidence', async () => {
  const findings = [{ id: 'SHAPE-1', claim: 'c', severity: 'critical' }, { id: 'F1', claim: 'c', blast_radius: true }, { id: 'F2', claim: 'c' }];
  const r = await triageFindingsSystemOne(eng({ choice: 'reject', c: 0.95, score: 0.9, p: 0.01 }), { findings, targetType: 'code' });
  assert.equal(r.ok, true);
  assert.notEqual(r.triaged[0].verdict, 'reject');
  assert.equal(r.triaged[1].verdict, 'escalate');
  assert.equal(r.triaged[1].blast_radius, true);
  assert.equal(r.triaged[2].verdict, 'reject');
  assert.equal(r.triaged[2].severity, 'critical');
  const downgraded = await triageFindingsSystemOne(eng({ choice: 'reject', c: 0.95, score: 0.1, p: 0.01 }), { findings, targetType: 'plan' });
  assert.equal(downgraded.triaged[0].severity, 'critical');
  const low = await triageFindingsSystemOne(eng({ choice: 'reject', c: 0.5 }), { findings });
  assert.ok(low.triaged.every((t) => t.system2 && t.verdict !== 'reject'));
  const d = await triageFindingsSystemOne(throwing(), { findings });
  assert.equal(d.ok, false);
  assert.ok(d.triaged.every((t) => t.system2 && t.verdict === 'escalate'));
});

test('coldstart escalates uncertain tickets', async () => {
  const tickets = [{ id: 'A' }, { id: 'B' }];
  let r = await scoreColdstartTickets(eng({ p: 0.01, c: 0.95, score: 0.9 }), { tickets, gate: 'coldstart' });
  assert.ok(r.scores.every((s) => !s.system2 && s.executable));
  r = await scoreColdstartTickets(eng({ p: 0.25, c: 0.95, score: 0.9 }), { tickets });
  assert.ok(r.scores.every((s) => s.system2));
  r = await scoreColdstartTickets(eng({ p: 0.01, c: 0.8, score: 0.9 }), { tickets });
  assert.ok(r.scores.every((s) => s.system2));
  r = await scoreColdstartTickets(throwing(), { tickets });
  assert.equal(r.ok, false);
  assert.ok(r.scores.every((s) => s.system2));
});
