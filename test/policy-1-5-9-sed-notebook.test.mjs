// agy 1.5.9 sed_file 348-case differential suite + notebook_edit / notebook_execution 5-column policy tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initializeDirectoryStore, ticketFilename } from '@adlc/tickets';
import {
  evaluateNotebookExecution, evaluatePayload, evaluateSedFile, buildContext, validateSedCall,
} from '../hooks/policy/evaluate.mjs';
import { NOTEBOOK_EXEC_TOOLS, PATH_MUTATING_TOOLS, SED_ALLOWED_KEYS } from '../hooks/policy/constants.mjs';
import { boosterDataRoots, protectedRoots } from '../hooks/policy/paths.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agb-sed-nb-')));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });
test.after(() => rmSync(base, { recursive: true, force: true }));

function makeRepo(name, mode) {
  const root = join(base, name);
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'notebooks'), { recursive: true });
  writeFileSync(join(root, 'lib', 'lock.mjs'), '// frozen rail\n');
  writeFileSync(join(root, 'lib', 'allowed.mjs'), '// in scope\n');
  writeFileSync(join(root, 'outside.txt'), 'outside scope\n');
  writeFileSync(join(root, 'notebooks', 'demo.ipynb'), '{"cells":[]}\n');
  symlinkSync(join(root, 'lib', 'lock.mjs'), join(root, 'notebooks', 'rail-link.ipynb'));
  if (mode) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), '{}\n');
    initializeDirectoryStore(join(root, '.adlc', 'tickets'));
    if (mode === 'corrupt') {
      writeFileSync(join(root, '.adlc', 'tickets', 'corrupt.json'), '{not-json');
    } else {
      const t = {
        id: 'T1',
        title: 'ticket',
        body: 'body',
        scope: ['lib/allowed.mjs', 'notebooks/**'],
        rails: mode === 'active' ? ['lib/lock.mjs'] : [],
        edges: [],
      };
      writeFileSync(join(root, '.adlc', 'tickets', ticketFilename(t.id)), JSON.stringify(t, null, 2) + '\n');
    }
  }
  return root;
}

const active = makeRepo('active', 'active');
const inactive = makeRepo('inactive', 'inactive');
const corrupt = makeRepo('corrupt', 'corrupt');
const plain = makeRepo('plain', null);

const COLS = {
  col1: { env: { AGB_WORKER_MODE: 'readonly' }, ws: active },
  col2: { env: { AGB_WORKER_TICKET: 'T1' }, ws: active },
  col3: { env: {}, ws: active },
  col4: { env: {}, ws: inactive },
  col5: { env: {}, ws: plain },
};

function run(name, args, col, opts = {}) {
  return evaluatePayload(
    { toolCall: { name, args }, workspacePaths: col.ws ? [col.ws] : [] },
    { env: col.env, home, platform: opts.platform ?? 'linux', limits: opts.limits },
  );
}

test('constants export SED_ALLOWED_KEYS, NOTEBOOK_EXEC_TOOLS, and notebook_edit in PATH_MUTATING_TOOLS', () => {
  assert.ok(PATH_MUTATING_TOOLS.has('notebook_edit'));
  assert.deepEqual([...NOTEBOOK_EXEC_TOOLS], ['notebook_execution']);
  assert.deepEqual([...SED_ALLOWED_KEYS].sort(), [
    'expressions', 'file_content', 'filecontent', 'target_file', 'targetfile', 'toolaction', 'toolsummary',
  ]);
});

test('validateSedCall: 324-case cartesian suite (exact 16 ACCEPT / 308 DENY)', () => {
  const delims = ['/', '|', ','];
  const addrs = ['', '1,5', '/re/'];
  const patterns = ['foo', '', 'a[b', '[a/b]', 'a\\', 'a\\\\'];
  const replacements = ['bar', 'bar\\', 'x;e'];
  const flags = ['g', 'ge'];

  let accepted = [];
  let denied = 0;
  let total = 0;

  for (const delim of delims) {
    for (const addr of addrs) {
      for (const pattern of patterns) {
        for (const replacement of replacements) {
          for (const flag of flags) {
            total += 1;
            const expr = `${addr}s${delim}${pattern}${delim}${replacement}${delim}${flag}`;
            const res = validateSedCall([expr]);
            const expectedOk =
              (delim === '/' || delim === '|') &&
              (addr === '' || addr === '1,5') &&
              (pattern === 'foo' || pattern === 'a\\\\') &&
              (replacement === 'bar' || replacement === 'x;e') &&
              flag === 'g';
            assert.equal(res.ok, expectedOk, `mismatch for ${JSON.stringify(expr)}: got ${JSON.stringify(res)}`);
            if (res.ok) accepted.push(expr);
            else denied += 1;
          }
        }
      }
    }
  }

  assert.equal(total, 324);
  assert.equal(accepted.length, 16);
  assert.equal(denied, 308);
});

test('validateSedCall: 24 verbatim fixed vectors (6 ACCEPT / 18 DENY) + live GNU sed differential oracle on all 22 accepted expressions', () => {
  const fixedAccept = [
    '1d',
    '$d',
    '1,$d',
    's/a\\|b/c/g',
    's|foo/bar|&\\nbaz|g',
    's/foo/bar/2pIm',
  ];
  const fixedDeny = [
    '0d',
    '1,2d;3d',
    '{1d}',
    '1!d',
    'e',
    'e touch pwn',
    's/foo/bar/e',
    's/foo/bar/w pwn',
    's/foo/bar/W pwn',
    'w pwn',
    'W pwn',
    '1r /etc/passwd',
    '1R /etc/passwd',
    'F',
    'z',
    's/(a)\\1/b/g',
    's/foo/bar/\0',
    's|a\\|b|c|g',
  ];

  assert.equal(fixedAccept.length + fixedDeny.length, 24);
  for (const expr of fixedAccept) {
    assert.equal(validateSedCall([expr]).ok, true, `expected accept: ${JSON.stringify(expr)}`);
  }
  for (const expr of fixedDeny) {
    assert.equal(validateSedCall([expr]).ok, false, `expected deny: ${JSON.stringify(expr)}`);
  }

  // Boundary checks on array count, string length, newlines, pattern length, replacement length, empty replacement.
  assert.equal(validateSedCall([]).ok, false);
  assert.equal(validateSedCall(null).ok, false);
  assert.equal(validateSedCall(Array.from({ length: 128 }, () => '1d')).ok, true);
  assert.equal(validateSedCall(Array.from({ length: 129 }, () => '1d')).ok, false);
  assert.equal(validateSedCall(['']).ok, false);
  assert.equal(validateSedCall([123]).ok, false);
  assert.equal(validateSedCall([['1d']]).ok, false);
  assert.equal(validateSedCall(['1d\n2d']).ok, false);
  assert.equal(validateSedCall(['1d\r2d']).ok, false);
  assert.equal(validateSedCall([`s/${'a'.repeat(256)}/b/g`]).ok, true);
  assert.equal(validateSedCall([`s/${'a'.repeat(257)}/b/g`]).ok, false);
  assert.equal(validateSedCall([`s/a/${'b'.repeat(512)}/g`]).ok, true);
  assert.equal(validateSedCall([`s/a/${'b'.repeat(513)}/g`]).ok, false);
  assert.equal(validateSedCall([`s/${'a'.repeat(256)}/${'b'.repeat(512)}/${'g'.repeat(252)}`]).ok, true); // 2 + 256 + 1 + 512 + 1 + 252 = 1024
  assert.equal(validateSedCall([`s/${'a'.repeat(256)}/${'b'.repeat(512)}/${'g'.repeat(253)}`]).ok, false); // 1025 > 1024
  assert.equal(validateSedCall(['s/foo//M']).ok, true);
  assert.equal(validateSedCall(['s/foo/bar/1']).ok, true);
  assert.equal(validateSedCall(['s/foo/bar']).ok, false);
  assert.equal(validateSedCall(['s/foo/bar/g/extra']).ok, false);
  assert.equal(validateSedCall(['s/(a)\\9/b/g']).ok, false);
  assert.equal(validateSedCall(['s/a]/b/g']).ok, false);

  // Collect all 22 accepted expressions (16 cartesian + 6 fixed) and run live GNU sed differential oracle.
  const cartesianAccepted = [];
  for (const delim of ['/', '|']) {
    for (const addr of ['', '1,5']) {
      for (const pattern of ['foo', 'a\\\\']) {
        for (const replacement of ['bar', 'x;e']) {
          cartesianAccepted.push(`${addr}s${delim}${pattern}${delim}${replacement}${delim}g`);
        }
      }
    }
  }
  const allAccepted = [...cartesianAccepted, ...fixedAccept];
  assert.equal(allAccepted.length, 22);

  const gnuSedBin = ['gsed', 'sed'].find((bin) => {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 2000 });
    return probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.includes('GNU sed');
  });
  if (process.platform === 'linux') {
    assert.ok(gnuSedBin, 'GNU sed must be available on Linux');
  }
  const sedBin = gnuSedBin ?? 'sed';
  // 's/foo/bar/2pIm' exercises GNU-specific 'I' and 'm' s/// flags; BSD sed on macOS runs all 21 POSIX expressions.
  const oracleExpressions = gnuSedBin
    ? allAccepted
    : allAccepted.filter((e) => e !== 's/foo/bar/2pIm');

  const SEED = 'L1 foo foo a\\b a|b foo/bar\nL2 FOO foo\nL3 mid\nL4 last\n';
  for (const expr of oracleExpressions) {
    const dir = mkdtempSync(join(base, 'sed-exec-'));
    const tmpFile = join(dir, 'sample.txt');
    writeFileSync(tmpFile, SEED, 'utf8');

    const inPlaceArgs = gnuSedBin ? ['-i', '-e', expr, tmpFile] : ['-i', '', '-e', expr, tmpFile];
    const inPlace = spawnSync(sedBin, inPlaceArgs, { encoding: 'utf8', timeout: 2000 });
    assert.equal(inPlace.status, 0, `sed -i failed for ${expr}: ${inPlace.stderr}`);
    assert.equal(inPlace.signal, null);
    assert.deepEqual(readdirSync(dir), [basename(tmpFile)], `sed -i created unexpected file for ${expr}`);

    const stream = spawnSync(sedBin, ['-e', expr], { input: SEED, encoding: 'utf8', timeout: 2000 });
    assert.equal(stream.status, 0);
    assert.equal(stream.signal, null);
    assert.equal(readFileSync(tmpFile, 'utf8'), stream.stdout, `in-place vs stdout mismatch for ${expr}`);
  }
});

test('sed_file: 5-column matrix, stepOne regex-slash exemption, symlinked rails, and .adlc/tickets denial', () => {
  const newShardRel = join('.adlc', 'tickets', ticketFilename('T-NEW'));

  // Col 1: readonly denies
  assert.equal(run('sed_file', { target_file: join(active, 'lib/allowed.mjs'), expressions: ['1d'] }, COLS.col1).decision, 'deny');

  // Col 2: worker ticket allows in-scope, denies out-of-scope and rail
  assert.equal(run('sed_file', { target_file: join(active, 'lib/allowed.mjs'), expressions: ['s|lib/lock.mjs|safe|g'] }, COLS.col2).decision, 'pass');
  assert.equal(run('sed_file', { target_file: join(active, 'outside.txt'), expressions: ['1d'] }, COLS.col2).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(active, 'lib/lock.mjs'), expressions: ['1d'] }, COLS.col2).decision, 'deny');

  // Col 3: interactive ADLC with active rails
  assert.equal(run('sed_file', { target_file: join(active, 'outside.txt'), expressions: ['s|foo/bar|baz|g', 's|lib/lock.mjs|x|g'] }, COLS.col3).decision, 'pass');
  assert.equal(run('sed_file', { target_file: join(active, 'lib/lock.mjs'), expressions: ['1d'] }, COLS.col3).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(active, 'notebooks/rail-link.ipynb'), expressions: ['1d'] }, COLS.col3).decision, 'deny');
  const vShard3 = run('sed_file', { target_file: join(active, newShardRel), expressions: ['1d'] }, COLS.col3);
  assert.equal(vShard3.decision, 'deny');
  assert.match(vShard3.reason, /ticket shard|\.adlc\/tickets\//);

  // stepOne on sed_file inspects ONLY target_file/targetfile (not expressions containing protected-root paths)
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), expressions: [`s|${protectedRoots(home)[0]}/a|b|g`] }, COLS.col5).decision, 'pass');
  assert.equal(run('sed_file', { targetfile: join(boosterDataRoots(home)[0], 'x'), expressions: ['1d'] }, COLS.col5).decision, 'deny');

  // Col 4: interactive ADLC without active rails
  assert.equal(run('sed_file', { targetFile: join(inactive, 'lib/lock.mjs'), expressions: ['1d'], file_content: null }, COLS.col4).decision, 'pass');
  assert.equal(run('sed_file', { target_file: join(inactive, 'lib/lock.mjs'), expressions: ['1d'], fileContent: {} }, COLS.col4).decision, 'pass');
  assert.equal(run('sed_file', { target_file: join(inactive, '.adlc/config.json'), expressions: ['1d'] }, COLS.col4).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(inactive, newShardRel), expressions: ['1d'] }, COLS.col4).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(inactive, newShardRel), expressions: ['1d'] }, COLS.col4, { platform: 'darwin' }).decision, 'deny');

  // Col 5: interactive non-ADLC
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), expressions: ['1d'], toolAction: 'edit', toolSummary: 's' }, COLS.col5).decision, 'pass');
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), expressions: ['s/[a]/b/g'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(protectedRoots(home)[0], 'x'), expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(boosterDataRoots(home)[1], 'x'), expressions: ['1d'] }, COLS.col5).decision, 'deny');

  // Schema & argument validation + ask->deny conversion on oversized directory target
  assert.equal(evaluateSedFile(null, buildContext({ toolCall: { name: 'sed_file', args: null }, workspacePaths: [plain] }, { home })).decision, 'deny');
  assert.equal(run('sed_file', { target_file: 'a', targetfile: 'b', expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), file_content: {}, filecontent: {}, expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), file_content: { a: 1 }, expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), file_content: [], expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), file_content: 'str', expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: '   ', expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { expressions: ['1d'] }, COLS.col5).decision, 'deny');
  assert.equal(run('sed_file', { target_file: join(plain, 'outside.txt'), expressions: ['1d'], extra: 1 }, COLS.col5).decision, 'deny');
  const vAskConv = run('sed_file', { target_file: plain, expressions: ['1d'] }, COLS.col5, { limits: { subtreeEntries: 1 } });
  assert.equal(vAskConv.decision, 'deny');
});

test('notebook_edit and notebook_execution: 5-column matrix, CellContent prose exemption, and .adlc/tickets denial', () => {
  const newShardRel = join('.adlc', 'tickets', ticketFilename('T-NB'));

  // notebook_edit across Cols 1..5
  assert.equal(run('notebook_edit', { NotebookPath: join(active, 'notebooks/demo.ipynb'), CellContent: 'import os' }, COLS.col1).decision, 'deny');
  assert.equal(run('notebook_edit', { NotebookPath: join(active, 'notebooks/demo.ipynb'), CellContent: 'mentions lib/lock.mjs in code' }, COLS.col2).decision, 'pass');
  assert.equal(run('notebook_edit', { notebookPath: join(active, 'outside.txt'), NewSource: 'x' }, COLS.col2).decision, 'deny');
  assert.equal(run('notebook_edit', { NotebookPath: join(active, 'notebooks/rail-link.ipynb'), Source: 'x' }, COLS.col3).decision, 'deny');
  assert.equal(run('notebook_edit', { NotebookPath: join(active, 'notebooks/demo.ipynb'), CellContent: 'lib/lock.mjs' }, COLS.col3).decision, 'pass');
  assert.equal(run('notebook_edit', { NotebookPath: join(inactive, newShardRel), CellContent: '{}' }, COLS.col4).decision, 'deny');
  assert.equal(run('notebook_edit', { NotebookPath: join(plain, 'notebooks/demo.ipynb'), CellContent: 'x' }, COLS.col5).decision, 'pass');
  assert.equal(run('notebook_edit', { NotebookPath: plain }, COLS.col5, { limits: { subtreeEntries: 1 } }).decision, 'deny');

  // notebook_execution across Cols 1..5
  assert.equal(run('notebook_execution', { NotebookPath: join(active, 'notebooks/demo.ipynb') }, COLS.col1).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(active, 'notebooks/demo.ipynb') }, COLS.col2).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(active, 'notebooks/demo.ipynb') }, COLS.col3).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(corrupt, 'notebooks/demo.ipynb') }, { env: {}, ws: corrupt }).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(inactive, 'notebooks/demo.ipynb'), CellIds: ['c1', 'c2'], toolSummary: 'run' }, COLS.col4).decision, 'pass');
  assert.equal(run('notebook_execution', { AbsolutePath: join(inactive, 'notebooks/demo.ipynb') }, COLS.col4).decision, 'pass');
  assert.equal(run('notebook_execution', { path: join(plain, 'notebooks/demo.ipynb') }, COLS.col5).decision, 'pass');

  // notebook_execution edge cases: implicit rails, tickets dir, symlink lexical/real forms, protected roots, bad args
  assert.equal(run('notebook_execution', { NotebookPath: join(inactive, '.adlc/config.json') }, COLS.col4).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(inactive, newShardRel) }, COLS.col4).decision, 'deny');
  symlinkSync(join(active, 'notebooks/demo.ipynb'), join(plain, 'notebooks/cross-active.ipynb'));
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/cross-active.ipynb') }, COLS.col5).decision, 'deny');
  symlinkSync(join(plain, 'notebooks/demo.ipynb'), join(plain, 'notebooks/safe-link.ipynb'));
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/safe-link.ipynb'), CellIds: [`${protectedRoots(home)[0]}/cell`] }, COLS.col5).decision, 'pass');
  symlinkSync(join(inactive, 'notebooks/demo.ipynb'), join(inactive, '.adlc/sessions.json'));
  assert.equal(run('notebook_execution', { NotebookPath: join(inactive, '.adlc/sessions.json') }, COLS.col4).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(protectedRoots(home)[0], 'a.ipynb') }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(boosterDataRoots(home)[0], 'a.ipynb') }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { AbsolutePath: join(boosterDataRoots(home)[1], 'a.ipynb') }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { path: join(boosterDataRoots(home)[2], 'a.ipynb') }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: plain }, COLS.col5, { limits: { subtreeEntries: 1 } }).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: 'relative.ipynb' }, { env: {}, ws: null }).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/demo.ipynb'), path: join(plain, 'notebooks/demo.ipynb') }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: '  ' }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/demo.ipynb'), CellIds: [123] }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/demo.ipynb'), CellIds: 'c1' }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/demo.ipynb'), toolSummary: 123 }, COLS.col5).decision, 'deny');
  assert.equal(run('notebook_execution', { NotebookPath: join(plain, 'notebooks/demo.ipynb'), extra: true }, COLS.col5).decision, 'deny');
  assert.equal(evaluateNotebookExecution(null, buildContext({ toolCall: { name: 'notebook_execution', args: null }, workspacePaths: [plain] }, { home })).decision, 'deny');
});
