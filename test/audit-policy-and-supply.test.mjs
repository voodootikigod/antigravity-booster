import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import { evaluatePayload } from '../hooks/policy/evaluate.mjs';
import { findExternalSpecifiers } from '../scripts/check-bundle-externals.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-audit4-')));
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  mkdirSync(home, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const mk = (name, { tickets = null } = {}) => {
    const root = join(base, name);
    mkdirSync(join(root, 'lib'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lib', 'lock.mjs'), '// rail\n');
    writeFileSync(join(root, 'scripts', 'ok.py'), 'print("ok")\n');
    if (tickets) {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
      initializeDirectoryStore(join(root, '.adlc', 'tickets'));
      for (const t of tickets) {
        writeFileSync(
          join(root, '.adlc', 'tickets', ticketFilename(t.id)),
          JSON.stringify({ title: 't', body: 'b', scope: [], rails: [], edges: [], ...t }, null, 2) + '\n',
        );
      }
    }
    return root;
  };
  return {
    base,
    home,
    outside,
    active: mk('active', { tickets: [{ id: 'T1', rails: ['lib/lock.mjs'], scope: ['scripts/**'] }] }),
    inactive: mk('inactive', { tickets: [{ id: 'T2', rails: [], scope: ['scripts/**'] }] }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const fx = makeFixture();
test.after(() => fx.cleanup());

function evalWorkflow(args, ws) {
  return evaluatePayload(
    { toolCall: { name: 'run_workflow', args }, workspacePaths: [ws] },
    { env: {}, home: fx.home, platform: 'linux' },
  );
}

// ---------- (a) evaluateWorkflowTool case-insensitive args ----------

test('evaluateWorkflowTool denies outside-repo cwd regardless of key casing', () => {
  for (const key of ['Cwd', 'cwd', 'CWD', 'cWd']) {
    const v = evalWorkflow({ [key]: fx.outside, Script: 'print(1)' }, fx.active);
    assert.equal(v.decision, 'deny', `expected deny for key ${key}`);
    assert.match(v.reason, /outside declared workspace/i);
  }
});

test('evaluateWorkflowTool denies relative cwd in ADLC repo regardless of key casing', () => {
  for (const key of ['Cwd', 'cwd', 'CWD']) {
    const v = evalWorkflow({ [key]: '../outside', Script: 'print(1)' }, fx.active);
    assert.equal(v.decision, 'deny', `expected deny for relative ${key}`);
  }
});

test('evaluateWorkflowTool denies non-string or empty cwd regardless of key casing', () => {
  for (const key of ['cwd', 'CWD']) {
    assert.equal(evalWorkflow({ [key]: '', Script: 'print(1)' }, fx.active).decision, 'deny');
    assert.equal(evalWorkflow({ [key]: 123, Script: 'print(1)' }, fx.active).decision, 'deny');
  }
});

test('evaluateWorkflowTool denies rail ScriptPath regardless of key casing', () => {
  const railPath = join(fx.active, 'lib', 'lock.mjs');
  for (const key of ['ScriptPath', 'scriptPath', 'scriptpath', 'SCRIPTPATH']) {
    const v = evalWorkflow({ [key]: railPath }, fx.active);
    assert.equal(v.decision, 'deny', `expected deny for rail path under key ${key}`);
  }
});

test('evaluateWorkflowTool denies invalid ScriptPath regardless of key casing', () => {
  for (const key of ['ScriptPath', 'scriptPath', 'SCRIPTPATH']) {
    const v = evalWorkflow({ [key]: '' }, fx.active);
    assert.equal(v.decision, 'deny', `expected deny for empty ${key}`);
  }
});

test('evaluateWorkflowTool fails closed on case-folded key collisions', () => {
  const vCwd = evalWorkflow({ Cwd: fx.active, cwd: fx.outside, Script: 'print(1)' }, fx.active);
  assert.equal(vCwd.decision, 'deny');
  assert.match(vCwd.reason, /Duplicate case-folded argument key/);

  const okScript = join(fx.active, 'scripts', 'ok.py');
  const railScript = join(fx.active, 'lib', 'lock.mjs');
  const vScript = evalWorkflow({ ScriptPath: okScript, scriptPath: railScript }, fx.active);
  assert.equal(vScript.decision, 'deny');
  assert.match(vScript.reason, /Duplicate case-folded argument key/);
});

test('evaluateWorkflowTool preserves ask/pass behavior for valid lowercase cwd and scriptPath', () => {
  const activeOk = evalWorkflow(
    { cwd: fx.active, scriptPath: join(fx.active, 'scripts', 'ok.py') },
    fx.active,
  );
  assert.equal(activeOk.decision, 'ask');

  const inactiveOk = evalWorkflow(
    { cwd: fx.inactive, scriptPath: join(fx.inactive, 'scripts', 'ok.py') },
    fx.inactive,
  );
  assert.equal(inactiveOk.decision, 'pass');
});

// ---------- (b) check-bundle-externals.mjs hardening ----------

test('findExternalSpecifiers catches nested-parenthesis createRequire direct calls', () => {
  const src = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const a = createRequire(pathToFileURL(join(dir, 'index.mjs')))('evil-direct');
    const b = createRequire(pathToFileURL(getUrl())).resolve('evil-direct-resolve');
  `;
  assert.deepEqual(findExternalSpecifiers(src), ['evil-direct', 'evil-direct-resolve']);
});

test('findExternalSpecifiers catches nested-parenthesis createRequire bound declarations', () => {
  const src = `
    import { createRequire } from 'node:module';
    const loader = createRequire(pathToFileURL(join(dir, 'entry.cjs')));
    const a = loader('evil-bound');
    const b = loader.resolve('evil-bound-resolve');
  `;
  assert.deepEqual(findExternalSpecifiers(src), ['evil-bound', 'evil-bound-resolve']);
});

test('findExternalSpecifiers allows Node built-ins via nested-parenthesis createRequire', () => {
  const src = `
    import { createRequire } from 'node:module';
    const loader = createRequire(pathToFileURL(join(dir, 'entry.cjs')));
    const fs = loader('node:fs');
    const path = createRequire(pathToFileURL(import.meta.url))('path');
  `;
  assert.deepEqual(findExternalSpecifiers(src), []);
});

test('findExternalSpecifiers catches aliased createRequire imports and bindings', () => {
  const esmAlias = `
    import { createRequire as cr } from 'node:module';
    const a = cr(pathToFileURL(import.meta.url))('evil-esm-direct');
    const bound = cr(import.meta.url);
    const b = bound('evil-esm-bound');
    const c = bound.resolve('evil-esm-bound-resolve');
  `;
  assert.deepEqual(
    findExternalSpecifiers(esmAlias),
    ['evil-esm-bound', 'evil-esm-bound-resolve', 'evil-esm-direct'],
  );

  const bareModuleAlias = `
    import { isBuiltin, createRequire as makeReq } from "module";
    const x = makeReq(import.meta.url)('evil-bare-module');
  `;
  assert.deepEqual(findExternalSpecifiers(bareModuleAlias), ['evil-bare-module']);

  const destructuredAlias = `
    const { createRequire: cr } = mod;
    const r = cr(pathToFileURL(u));
    r('evil-destructured');
  `;
  assert.deepEqual(findExternalSpecifiers(destructuredAlias), ['evil-destructured']);

  const assignedAlias = `
    const cr = mod.createRequire;
    cr(import.meta.url)('evil-assigned');
  `;
  assert.deepEqual(findExternalSpecifiers(assignedAlias), ['evil-assigned']);
});

test('findExternalSpecifiers catches import.meta.resolve calls and ignores built-ins', () => {
  const src = `
    const ok1 = import.meta.resolve('node:fs');
    const ok2 = import.meta.resolve('path', import.meta.url);
    const bad1 = import.meta.resolve('left-pad');
    const bad2 = import.meta.resolve('chalk', import.meta.url);
    const bad3 = import.meta.resolve(getSpec());
  `;
  assert.deepEqual(findExternalSpecifiers(src), ['chalk', 'getSpec()', 'left-pad']);
});

// ---------- (c) publish.yml OIDC-only supply-chain check ----------

test('.github/workflows/publish.yml relies strictly on OIDC Trusted Publishing with no NPM_TOKEN or NODE_AUTH_TOKEN', () => {
  const publishYml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.doesNotMatch(publishYml, /\bNPM_TOKEN\b/);
  assert.doesNotMatch(publishYml, /\bNODE_AUTH_TOKEN\b/);
  assert.match(publishYml, /id-token:\s*write/);
  assert.match(publishYml, /NPM_CONFIG_PROVENANCE:\s*"true"/);
});
