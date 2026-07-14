import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));

test('agb COMMANDS table covers all dispatched commands', () => {
  const code = readFileSync(AGB_BIN, 'utf8');
  const cmdMatches = [...code.matchAll(/cmd === '([^']+)'/g)].map(m => m[1]);
  const tableStart = code.indexOf('const COMMANDS = {');
  const tableEnd = code.indexOf('};', tableStart);
  assert(tableStart !== -1 && tableEnd !== -1, 'COMMANDS table not found');
  const tableStr = code.slice(tableStart, tableEnd + 2);
  
  const declaredCmds = [...tableStr.matchAll(/(\w+|'[^']+'):/g)].map(m => m[1].replace(/'/g, ''));
  
  for (const cmd of cmdMatches) {
    if (['setup', 'install', 'skills', 'help', '--help', '-h'].includes(cmd)) continue;
    assert(declaredCmds.includes(cmd), `Command ${cmd} is dispatched but not in COMMANDS table`);
  }
});

test('agb help exits 0 and prints usage', () => {
  const stdout = execFileSync(process.execPath, [AGB_BIN, 'help'], { encoding: 'utf8' });
  assert(stdout.includes('Antigravity Booster orchestrator'));
  assert(stdout.includes('agb run <plan.json>'));
});

test('agb --help exits 0 and prints usage', () => {
  const stdout = execFileSync(process.execPath, [AGB_BIN, '--help'], { encoding: 'utf8' });
  assert(stdout.includes('Antigravity Booster orchestrator'));
});

test('agb unknown exits 1 and prints error', () => {
  let threw = false;
  try {
    execFileSync(process.execPath, [AGB_BIN, 'unknown-cmd'], { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 1);
    assert(err.stderr.includes("unknown command 'unknown-cmd'"));
  }
  assert(threw, 'unknown command did not throw');
});

test('agb help <cmd> exits 0 and prints per-cmd usage', () => {
  const stdout = execFileSync(process.execPath, [AGB_BIN, 'help', 'run'], { encoding: 'utf8' });
  assert(stdout.includes('agb run <plan.json>'));
  assert(stdout.includes('execute a ticket DAG'));
});

test('agb validate exits 0 on valid plan', () => {
  const plan = { repo: '.', tickets: [{id: 'T1', title: 't', body: 'b', scope: ['*'], rails: [], edges: []}], gate: { build: 'true' } };
  writeFileSync('tmp-valid.json', JSON.stringify(plan));
  execFileSync(process.execPath, [AGB_BIN, 'validate', 'tmp-valid.json']);
});

test('agb validate exits 2 on invalid plan', () => {
  let threw = false;
  const plan = { tickets: [{ id: '1' }, { id: '1' }] }; // duplicate id
  writeFileSync('tmp-invalid.json', JSON.stringify(plan));
  try {
    execFileSync(process.execPath, [AGB_BIN, 'validate', 'tmp-invalid.json']);
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 2);
  }
  assert(threw);
});

import { join } from 'node:path';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

test('agb plan --out overwrite refusal', () => {
  const tmp = 'tmp-plan-out.json';
  writeFileSync(tmp, '{"exists":true}');
  let threw = false;
  try {
    execFileSync(process.execPath, [AGB_BIN, 'plan', 'foo', '.', '--out', tmp, '--no-premortem'], { encoding: 'utf8', env: { ...process.env, AGB_AGY_BIN: 'true' } });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 1);
    assert(err.stderr.includes('already exists — pass --force to overwrite'));
  }
  assert(threw);
  rmSync(tmp, { force: true });
});

test('agb run smoke on a tiny fixture (fake-agy, success)', () => {
  const repo = 'tmp-cli-repo';
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
  
  const plan = {
    repo: resolve(repo),
    tickets: [
      { id: 'T1', title: 'test', body: 't', scope: ['*'], rails: [], edges: [] }
    ],
    gate: { build: 'true', test: 'true' }
  };
  writeFileSync(`${repo}/plan.json`, JSON.stringify(plan));
  
  // Fake agy script that succeeds
  const fakeAgy = resolve('test/fixtures/fake-agy');
  const env = { ...process.env, AGB_AGY_BIN: fakeAgy, AGB_ADLC_BIN: resolve('test/fixtures/fake-adlc'), PATH: process.env.PATH, AGB_ALLOW_DIRTY: '1', AGB_SANDBOX_GATES: '0' };
  
  // success
  const out = execFileSync(process.execPath, [AGB_BIN, 'run', 'plan.json'], { cwd: repo, env, encoding: 'utf8' });
  assert(out.includes('"merged": [\n    "T1"\n  ]'));
  
  rmSync(repo, { recursive: true, force: true });
});

import { resolve } from 'node:path';

test('agb status against a synthetic .booster/run.json', () => {
  const repo = 'tmp-status-repo';
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, '.booster'), { recursive: true });
  
  const runState = {
    started: new Date().toISOString(),
    status: 'RUNNING',
    tickets: {
      T1: { phase: 'merged', model: 'fake', attempts: [] }
    },
    edges: []
  };
  writeFileSync(join(repo, '.booster/run.json'), JSON.stringify(runState));
  
  const out = execFileSync(process.execPath, [AGB_BIN, 'status', repo], { encoding: 'utf8' });
  assert(out.includes('T1'));
  assert(out.includes('merged'));
  
  rmSync(repo, { recursive: true, force: true });
});
