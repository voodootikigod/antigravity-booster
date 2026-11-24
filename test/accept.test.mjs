import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAcceptanceDossier,
  computeHunkFingerprint,
  formatAcceptanceDossierMarkdown,
  parseUnifiedDiffHunks,
  saveAcceptVerdicts,
} from '../lib/accept.mjs';
import { runInteractiveAcceptTui } from '../lib/accept-tui.mjs';
import { stripOscAndAnsi } from '../lib/terminal-osc.mjs';

function makeAcceptRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agb-accept-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');

  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'src', 'caller.mjs'), 'import { add } from "./math.mjs";\nexport const sum = add(1, 2);\n');
  writeFileSync(
    join(dir, '.adlc', 'manifest.jsonl'),
    JSON.stringify({ seq: 1, gate: 'build', ticket: 'T1', ts: '2026-11-24T00:00:00Z', sig: 'abc' }) + '\n'
  );
  g('add', '-A');
  g('commit', '-qm', 'base');
  const baseSha = g('rev-parse', 'HEAD');

  // Candidate modifies exported add() in src/math.mjs
  writeFileSync(
    join(dir, 'src', 'math.mjs'),
    'export function add(a, b) {\n  return Number(a) + Number(b);\n}\n'
  );
  g('add', 'src/math.mjs');
  g('commit', '-qm', 'candidate');
  const candSha = g('rev-parse', 'HEAD');
  return { dir, g, baseSha, candSha };
}

test('buildAcceptanceDossier, SHA-256 fingerprint invalidation, external callers, interactive TUI, and symlink rejection', async () => {
  const fx = makeAcceptRepo();
  try {
    // 1. Fingerprint survives pure line-number shifts when hunk content & heading match
    const fp1 = computeHunkFingerprint('src/math.mjs', 'export function add', ['-  return a + b;', '+  return Number(a) + Number(b);']);
    const fp2 = computeHunkFingerprint('src/math.mjs', 'export function add', ['-  return a + b;', '+  return Number(a) + Number(b);']);
    const fpModified = computeHunkFingerprint('src/math.mjs', 'export function add', ['-  return a + b;', '+  return Number(a) + Number(b) + 0;']);
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fpModified);
    assert.equal(parseUnifiedDiffHunks('').length, 0);

    // 2. Build initial dossier: 1 pending hunk, detects external caller in src/caller.mjs, reads manifest.jsonl
    const d1 = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    assert.equal(d1.ok, true);
    assert.equal(d1.readyForSignOff, false);
    assert.equal(d1.counts.totalHunks, 1);
    assert.equal(d1.counts.pendingHunks, 1);
    assert.equal(d1.externalCallers.callers.some((c) => c.file === 'src/caller.mjs'), true);
    assert.equal(d1.gateManifest.totalEntries, 1);

    // 3. Interactive TUI: 'a' accepts hunk, 'd' exports dossier, 'q' quits cleanly without mutating git HEAD
    let rendered = '';
    const fakeStdout = {
      isTTY: true,
      columns: 100,
      write: (s) => {
        rendered += s;
      },
    };
    const fakeStdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    });

    const tuiPromise = runInteractiveAcceptTui(d1, {
      repo: fx.dir,
      stdin: fakeStdin,
      stdout: fakeStdout,
      osc8: true,
    });
    setTimeout(() => {
      fakeStdin.emit('data', 'adq');
    }, 15);
    const tuiRes = await tuiPromise;
    assert.equal(tuiRes.ok, true);
    assert.equal(tuiRes.readyForSignOff, true);
    assert.equal(tuiRes.counts.acceptedHunks, 1);
    assert.ok(tuiRes.dossierPath && existsSync(tuiRes.dossierPath));
    assert.match(rendered, /\x1b\]8;;file:\/\//, 'expected OSC 8 clickable file link in TTY frame');
    assert.match(stripOscAndAnsi(rendered), /P6 SIGN-OFF READY/);
    assert.equal(fx.g('rev-parse', 'HEAD'), fx.candSha, 'git HEAD must never be mutated by agb accept');

    const md = formatAcceptanceDossierMarkdown(d1);
    assert.match(md, /READY FOR P6 MERGE SIGN-OFF/);
    assert.match(md, /src\/caller\.mjs/);

    // 4. Modifying hunk content auto-invalidates prior SHA-256 fingerprint verdict back to 'pending'
    writeFileSync(
      join(fx.dir, 'src', 'math.mjs'),
      'export function add(a, b) {\n  return Number(a ?? 0) + Number(b ?? 0);\n}\n'
    );
    const dAfterEdit = buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha });
    assert.equal(dAfterEdit.counts.acceptedHunks, 0);
    assert.equal(dAfterEdit.counts.pendingHunks, 1);
    assert.equal(dAfterEdit.readyForSignOff, false);

    // 5. Rejects invalid git ref starting with '-' and symlinked .booster
    assert.throws(() => buildAcceptanceDossier({ repo: fx.dir, base: '--output=/tmp/pwn' }), /Invalid git base ref/);
    rmSync(join(fx.dir, '.booster'), { recursive: true, force: true });
    const outside = mkdtempSync(join(tmpdir(), 'agb-accept-outside-'));
    try {
      symlinkSync(outside, join(fx.dir, '.booster'), 'dir');
      assert.throws(() => saveAcceptVerdicts(fx.dir, {}), /symbolic link not allowed/i);
      assert.throws(() => buildAcceptanceDossier({ repo: fx.dir, base: fx.baseSha }), /symbolic link not allowed/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
