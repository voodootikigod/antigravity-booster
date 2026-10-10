// Regression tests for T-CODE-FIXES-AUDIT (CLI/MCP correctness fixes).
// Fixture repos are throwaway, offline, and never sign commits.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGB_BIN = fileURLToPath(new URL('../bin/agb.mjs', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('fixtures/fake-agy', import.meta.url));
const FAKE_ADLC = fileURLToPath(new URL('fixtures/fake-adlc', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agb-cli-fixes-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

function makeRepo(name) {
  const repo = join(TMP, name);
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: name, scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-m', 'init');
  return repo;
}

test('item 1: agb sweep --project passes the project to every agy invocation', () => {
  const repo = makeRepo('sweep-repo');
  const state = join(TMP, 'sweep-state');
  mkdirSync(state);
  writeFileSync(join(TMP, 'sweep.json'), JSON.stringify({
    repo, operation: 'touch {target}', targets: ['S1.txt'], gate: { test: 'npm test' },
  }));
  const env = {
    ...process.env, AGB_AGY_BIN: FAKE_AGY, AGB_ADLC_BIN: FAKE_ADLC, AGB_ALLOW_CUSTOM_ADLC_CLI: '1',
    AGB_ALLOW_DIRTY: '1', AGB_SANDBOX_GATES: '0', FAKE_STATE_DIR: state,
    AGB_QUOTA_STATE: join(TMP, 'pools-sweep.json'),
  };
  execFileSync(process.execPath, [AGB_BIN, 'sweep', join(TMP, 'sweep.json'), '--project', 'my-proj'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' });
  // Prompts are multi-line, so split the argv log on invocation starts.
  const seen = readFileSync(join(state, 'agy-argv-seen'), 'utf8').split(/^(?=--print )/m).filter((l) => l.startsWith('--print '));
  // Builder AND prosecutor must both have been spawned for this to mean anything.
  assert(seen.length >= 2, `expected builder + prosecutor invocations, saw ${seen.length}`);
  for (const line of seen) assert.match(line, /--project my-proj\b/, `agy invocation missing --project: ${line.slice(0, 200)}`);
});
