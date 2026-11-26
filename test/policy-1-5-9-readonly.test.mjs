// agy 1.5.9 read-only tool schemas, Go key-fold parity and 4-root boosterDataRoots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import {
  evaluatePayload, extractProbedPaths, extractReadToolPaths, goFoldKey, normalizeArgsCaseInsensitive,
} from '../hooks/policy/evaluate.mjs';
import { boosterDataRoots } from '../hooks/policy/paths.mjs';
import { READ_ONLY_TOOLS, READ_TOOL_PATH_SCHEMAS, REQUIRED_READ_PATH_KEYS } from '../hooks/policy/constants.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-ro159-')));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });

function makeRepo(name, rails) {
  const root = join(base, name);
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'lock.mjs'), '// rail\n');
  writeFileSync(join(root, 'safe.txt'), 'ok\n');
  if (rails) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
    initializeDirectoryStore(join(root, '.adlc', 'tickets'));
    const t = { id: 'T1', title: 't', body: 'b', scope: ['lib/**'], rails: rails === 'active' ? ['lib/lock.mjs'] : [], edges: [] };
    writeFileSync(join(root, '.adlc', 'tickets', ticketFilename(t.id)), JSON.stringify(t, null, 2) + '\n');
  }
  return root;
}

const active = makeRepo('active', 'active');
const inactive = makeRepo('inactive', 'inactive');
const plain = makeRepo('plain', null);
test.after(() => rmSync(base, { recursive: true, force: true }));

const COLUMNS = [
  { label: '1 readonly worker', env: { AGB_WORKER_MODE: 'readonly' }, ws: active },
  { label: '2 ticket worker', env: { AGB_WORKER_TICKET: 't-1' }, ws: active },
  { label: '3 interactive ADLC with rails', env: {}, ws: active },
  { label: '4 interactive ADLC without rails', env: {}, ws: inactive },
  { label: '5 interactive non-ADLC', env: {}, ws: plain },
];

function run(name, args, col) {
  return evaluatePayload({ toolCall: { name, args }, workspacePaths: [col.ws] }, { env: col.env, home, platform: 'linux' });
}

// tool -> [path key as the host spells it, builder from a path to the value]
const single = (p) => p;
const TOOLS = {
  view_file: ['AbsolutePath', single],
  view_file_outline: ['AbsolutePath', single],
  read_file: ['Path', single],
  read_notebook: ['notebookPath', single],
  read_browser_page: ['Url', () => 'https://example.com/page'],
  read_url_content: ['Url', () => 'https://example.com/page'],
  list_dir: ['DirectoryPath', single],
  list_directory: ['DirAbsolutePath', single],
  list_permissions: ['paths', (p) => [p]],
  search_in_file: ['paths', (p) => [p]],
};
const PATH_TOOLS = Object.keys(TOOLS).filter((n) => !['read_browser_page', 'read_url_content'].includes(n));

test('REQUIRED_READ_PATH_KEYS covers exactly the 9 required-path read tools, all in READ_ONLY_TOOLS', () => {
  assert.deepEqual(REQUIRED_READ_PATH_KEYS, {
    view_file: ['absolutepath', 'filepath', 'path'],
    view_file_outline: ['absolutepath', 'filepath', 'path'],
    read_file: ['path', 'absolutepath', 'filepath'],
    read_notebook: ['notebookpath', 'absolutepath', 'path'],
    read_browser_page: ['url'],
    read_url_content: ['url'],
    list_dir: ['directorypath', 'dirabsolutepath', 'absolutepath', 'path', 'dir'],
    list_directory: ['directorypath', 'dirabsolutepath', 'absolutepath', 'path', 'dir'],
    search_in_file: ['paths', 'path', 'directorypath', 'searchpath'],
  });
  for (const name of Object.keys(REQUIRED_READ_PATH_KEYS)) assert.ok(READ_ONLY_TOOLS.has(name), name);
  for (const name of ['list_dir', 'list_permissions', 'search_in_file', 'wait', 'wait_5_seconds', 'view_file', 'list_directory']) {
    assert.ok(READ_ONLY_TOOLS.has(name), name);
  }
  assert.deepEqual(READ_TOOL_PATH_SCHEMAS.list_dir, ['DirectoryPath', 'DirAbsolutePath', 'AbsolutePath', 'path', 'dir']);
  assert.deepEqual(READ_TOOL_PATH_SCHEMAS.list_permissions, ['paths', 'path']);
  assert.deepEqual(READ_TOOL_PATH_SCHEMAS.search_in_file, ['paths', 'path', 'DirectoryPath', 'SearchPath']);
});

test('boosterDataRoots returns all 4 canonical roots', () => {
  assert.deepEqual(boosterDataRoots('/h'), [
    '/h/.gemini/antigravity-cli/plugin_data/antigravity-booster',
    '/h/.gemini/antigravity/plugin_data/antigravity-booster',
    '/h/.gemini/antigravity-ide/plugin_data/antigravity-booster',
    '/h/.config/antigravity-booster',
  ]);
});

for (const col of COLUMNS) {
  test(`column ${col.label}: all 10 required-path read tools allow safe paths`, () => {
    for (const [name, [key, build]] of Object.entries(TOOLS)) {
      const v = run(name, { [key]: build(join(col.ws, 'safe.txt')) }, col);
      assert.equal(v.decision, 'pass', `${name}: ${v.reason}`);
    }
  });

  test(`column ${col.label}: required-path read tools deny every booster data root`, () => {
    for (const root of boosterDataRoots(home)) {
      for (const name of PATH_TOOLS) {
        const [key, build] = TOOLS[name];
        const v = run(name, { [key]: build(join(root, 'creds.json')) }, col);
        assert.equal(v.decision, 'deny', `${name} ${root}`);
        assert.match(v.reason, /booster plugin data/);
      }
    }
  });

  test(`column ${col.label}: missing, empty and confused path parameters are denied`, () => {
    for (const [name, [key]] of Object.entries(TOOLS)) {
      if (name === 'list_permissions') {
        assert.equal(run(name, {}, col).decision, 'pass', name);
      } else {
        assert.equal(run(name, {}, col).reason, 'Missing required read-tool path parameter', name);
      }
      assert.equal(run(name, { [key]: '   ' }, col).reason, 'Invalid read-tool path parameter', name);
      assert.equal(run(name, { [key]: 42 }, col).reason, 'Invalid read-tool path parameter', name);
    }
    assert.equal(run('view_file', { AbsolutePath: true, path: 'safe.txt' }, col).reason, 'Invalid read-tool path parameter');
    assert.equal(run('view_file', { AbsolutePath: join(col.ws, 'safe.txt'), toolSummary: ['x'] }, col).decision, 'deny');
  });

  test(`column ${col.label}: null/array args, non-ASCII and duplicate keys are denied`, () => {
    for (const bad of [null, [], 'str']) {
      assert.equal(run('view_file', bad, col).decision, 'deny');
      assert.equal(run('grep_search', bad, col).decision, 'deny');
    }
    const safe = join(col.ws, 'safe.txt');
    assert.equal(run('view_file', { '\u017fearchpath': 'x', AbsolutePath: safe }, col).reason, 'Non-ASCII or control character in tool argument key');
    assert.equal(run('view_file', { 'path\u212a': 'x', AbsolutePath: safe }, col).reason, 'Non-ASCII or control character in tool argument key');
    assert.equal(run('view_file', { 'AbsolutePath': safe, 'absolutepath': safe }, col).reason, 'Duplicate case-folded argument key');
    assert.equal(run('view_file', { 'AbsolutePath': safe, 'a\u0000b': 1 }, col).reason, 'Non-ASCII or control character in tool argument key');
  });
}

test('multi-key collection checks every present path key, not just the first', () => {
  const root = boosterDataRoots(home)[1];
  const col = COLUMNS[4];
  const safe = join(plain, 'safe.txt');
  assert.equal(run('read_file', { Path: safe, AbsolutePath: join(root, 'x') }, col).decision, 'deny');
  assert.equal(run('view_file', { path: join(root, 'x'), AbsolutePath: safe }, col).decision, 'deny');
  assert.equal(run('view_file', { path: safe, AbsolutePath: safe }, col).decision, 'pass');
  assert.deepEqual(extractReadToolPaths('read_file', { Path: 'a', filePath: 'b', absolutepath: 'c' }),
    { ok: true, paths: ['a', 'c', 'b'] });
});

test('paths accepts a string or a flattened non-empty array of non-empty strings', () => {
  assert.deepEqual(extractReadToolPaths('list_permissions', { paths: ['a', 'b'], path: 'c' }), { ok: true, paths: ['a', 'b', 'c'] });
  assert.deepEqual(extractReadToolPaths('search_in_file', { paths: 'a', Pattern: 'p', MaxResults: 5 }), { ok: true, paths: ['a'] });
  for (const bad of [[], [''], ['a', 3], ['a', '  '], {}, 7, null, false]) {
    assert.deepEqual(extractReadToolPaths('list_permissions', { paths: bad }), { ok: false, reason: 'Invalid read-tool path parameter' });
  }
  const col = COLUMNS[4];
  const root = boosterDataRoots(home)[2];
  assert.equal(run('list_permissions', { paths: [join(plain, 'safe.txt'), join(root, 'x')] }, col).decision, 'deny');
  assert.equal(run('search_in_file', { paths: [join(root, 'x')], pattern: 'a' }, col).decision, 'deny');
});

test('non-path keys on required-path read tools are constrained to scalars', () => {
  const ok = { AbsolutePath: 'a', StartLine: 1, EndLine: 10, Flag: true, toolAction: 'x', toolSummary: 'y' };
  assert.equal(extractReadToolPaths('view_file', ok).ok, true);
  const reason = 'Unexpected non-scalar or unapproved string argument on read tool';
  for (const extra of [{ Other: 'str' }, { Other: ['a'] }, { Other: { a: 1 } }, { Other: null }]) {
    assert.deepEqual(extractReadToolPaths('view_file', { AbsolutePath: 'a', ...extra }), { ok: false, reason });
  }
  assert.equal(extractReadToolPaths('view_file', { AbsolutePath: 'a', toolSummary: 1 }).ok, false);
  assert.equal(extractReadToolPaths('search_in_file', { paths: 'a', pattern: 'p', query: 'q' }).ok, true);
  assert.equal(extractReadToolPaths('view_file', { AbsolutePath: 'a', pattern: 'p' }).ok, false);
  assert.equal(extractReadToolPaths('read_browser_page', { Url: 'https://x', pageId: 'p1' }).ok, true);
  assert.equal(extractReadToolPaths('read_url_content', { Url: 'https://x', pageId: 'p1' }).ok, false);
});

test('goFoldKey and normalizeArgsCaseInsensitive', () => {
  assert.equal(goFoldKey('AbsolutePath'), 'absolutepath');
  assert.equal(goFoldKey('\u017f'), 's');
  assert.equal(goFoldKey('\u212a'), 'k');
  const n = normalizeArgsCaseInsensitive({ AbsolutePath: 'a', Path: 'b' });
  assert.equal(n.ok, true);
  assert.equal(Object.getPrototypeOf(n.folded), null);
  assert.deepEqual({ ...n.folded }, { absolutepath: 'a', path: 'b' });
  for (const bad of [null, undefined, [], 'x', 1]) {
    assert.deepEqual(normalizeArgsCaseInsensitive(bad), { ok: false, reason: 'Tool arguments must be a plain JSON object' });
  }
  assert.equal(normalizeArgsCaseInsensitive({ '\u017f': 1 }).reason, 'Non-ASCII or control character in tool argument key');
  assert.equal(normalizeArgsCaseInsensitive({ '\u212a': 1 }).reason, 'Non-ASCII or control character in tool argument key');
  assert.equal(normalizeArgsCaseInsensitive({ 'a\tb': 1 }).reason, 'Non-ASCII or control character in tool argument key');
  assert.equal(normalizeArgsCaseInsensitive({ Path: 1, path: 2 }).reason, 'Duplicate case-folded argument key');
});

test('non-required read-only tools pass without path args but still guard booster data roots', () => {
  const col = COLUMNS[2];
  for (const name of ['grep_search', 'code_search', 'file_search', 'find_by_name', 'read_resource', 'search_web', 'list_resources', 'ask_question', 'read_terminal', 'command_status', 'wait', 'wait_5_seconds']) {
    assert.equal(run(name, {}, col).decision, 'pass', name);
    assert.equal(run(name, { SearchPath: join(boosterDataRoots(home)[2], 'x') }, col).decision, 'deny', `${name} deny`);
    assert.equal(run(name, { Anything: join(boosterDataRoots(home)[3], 'x') }, col).decision, 'deny', `${name} scan deny`);
  }
});

test('mutating tools honor case-folded keys and reject confusable keys', () => {
  const col = COLUMNS[2];
  assert.equal(run('write_to_file', { targetfile: join(active, 'lib/lock.mjs') }, col).decision, 'deny');
  assert.equal(run('write_to_file', { TargetFile: join(active, 'lib/lock.mjs'), 'targetfile': 'x' }, col).decision, 'deny');
  assert.equal(run('write_to_file', null, col).decision, 'deny');

  // Every declared alias across REQUIRED_READ_PATH_KEYS extracts cleanly.
  for (const [name, keys] of Object.entries(REQUIRED_READ_PATH_KEYS)) {
    for (const k of keys) {
      assert.deepEqual(extractReadToolPaths(name, { [k]: 'x' }), { ok: true, paths: ['x'] }, `${name}.${k}`);
    }
  }

  // Case-folded extractProbedPaths: 1-char required & altRequired, conflicting required+altRequired,
  // empty inactive alias rejection, undefined inactive alias pass, and non-path scalar/string pass.
  assert.deepEqual(extractProbedPaths('edit_file', { targetfile: 'a' }), { paths: ['a'] });
  assert.deepEqual(extractProbedPaths('edit_file', { path: 'a' }), { paths: ['a'] });
  assert.match(extractProbedPaths('edit_file', { Path: 'a', targetfile: 'b' }).error, /Conflicting path parameters/);
  assert.match(extractProbedPaths('edit_file', { targetfile: 'a', path: '' }).error, /Unexpected path parameter/);
  assert.deepEqual(extractProbedPaths('edit_file', { targetfile: 'a', path: undefined, Overwrite: true, LineNumber: 5, Encoding: 'utf8' }), { paths: ['a'] });
  assert.match(extractProbedPaths('edit_file', { targetfile: 'a', ExtraPath: 'foo/bar' }).error, /Unexpected path parameter/);

  // Direct extractReadToolPaths edge cases: invalid args object, non-finite numbers, and 1-char readToolPaths resolution.
  assert.deepEqual(extractReadToolPaths('view_file', null), { ok: false, reason: 'Tool arguments must be a plain JSON object' });
  assert.equal(extractReadToolPaths('view_file', { AbsolutePath: 'a', StartLine: Infinity }).ok, false);
  assert.equal(extractReadToolPaths('view_file', { AbsolutePath: 'a', StartLine: NaN }).ok, false);
  const vOneChar = evaluatePayload(
    { toolCall: { name: 'grep_search', args: { SearchPath: 'a' } }, workspacePaths: [boosterDataRoots(home)[0]] },
    { env: {}, home, platform: 'linux' },
  );
  assert.equal(vOneChar.decision, 'deny');
});
