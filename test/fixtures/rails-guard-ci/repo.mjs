// Throwaway git repos for test/rails-guard-ci.test.mjs. Fully offline: created
// under os.tmpdir(), commit.gpgsign=false, hooks disabled, fixed identity.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_DIR, ARCHIVE_DIR, ACTIVE_MANIFEST, ARCHIVE_MANIFEST, prettyCanonicalJson, ticketFilename, ticketHash,
} from '../../../scripts/rails-guard-ci.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
export const GUARD = join(ROOT, 'scripts', 'rails-guard-ci.mjs');
const FAKE_ADLC = join(ROOT, 'test', 'fixtures', 'fake-adlc');

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

export function sh(cwd, cmd, args, { allowFail = false, env = GIT_ENV, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', input });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
  return r;
}

export const baseTicket = (id, extra = {}) => ({ id, title: `title ${id}`, body: `body ${id}`, scope: [], rails: [], edges: [], ...extra });

export function archivedShard(ticket, metaOverrides = {}) {
  const done = { ...ticket, completed: true };
  return {
    ...done,
    _adlcArchive: {
      version: 1, archivedAt: '2026-10-09T13:46:18.364Z', reason: 'completed',
      ticketHash: ticketHash(done), sourceStoreHash: 'a'.repeat(64), sourceRevision: null, ...metaOverrides,
    },
  };
}

export class Repo {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'rails-guard-ci-'));
    this.state = mkdtempSync(join(tmpdir(), 'rails-guard-ci-state-'));
    this.bin = join(this.state, 'bin');
    mkdirSync(this.bin);
    // Wrapper `adlc` with the log dir baked in: the guard scrubs the environment,
    // so FAKE_STATE_DIR cannot be passed through it.
    const wrapper = join(this.bin, 'adlc');
    writeFileSync(wrapper, `#!/bin/sh\nFAKE_STATE_DIR='${this.state}' exec '${FAKE_ADLC}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    this.git('init', '-q', '-b', 'main');
    for (const [k, v] of [['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.invalid'], ['core.autocrlf', 'false'], ['core.hooksPath', '/dev/null']]) this.git('config', k, v);
  }
  git(...args) { return sh(this.dir, 'git', args).stdout; }
  write(p, content) {
    const f = join(this.dir, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, typeof content === 'string' ? content : prettyCanonicalJson(content));
    return this;
  }
  read(p) { return readFileSync(join(this.dir, p), 'utf8'); }
  rm(p) { rmSync(join(this.dir, p), { recursive: true, force: true }); return this; }
  symlink(target, p) { const f = join(this.dir, p); mkdirSync(dirname(f), { recursive: true }); symlinkSync(target, f); return this; }
  shardPath(id, dir = ACTIVE_DIR) { return `${dir}/${ticketFilename(id)}`; }
  ticket(t) { return this.write(this.shardPath(t.id), t); }
  archived(t, meta) { return this.write(this.shardPath(t.id, ARCHIVE_DIR), archivedShard(t, meta)); }
  dirStore() {
    this.write('.adlc/config.json', { version: 1 });
    this.write(`${ACTIVE_DIR}/.store.json`, ACTIVE_MANIFEST);
    this.write(`${ARCHIVE_DIR}/.store.json`, ARCHIVE_MANIFEST);
    this.write('src/app.mjs', 'export const x = 1;\n');
    return this;
  }
  commit(msg = 'c') { this.git('add', '-A'); this.git('commit', '-q', '--allow-empty', '-m', msg); return this.git('rev-parse', 'HEAD').trim(); }
  // Commit base on main and point origin/main at it; start the PR branch.
  base(msg = 'base') {
    this.commit(msg);
    this.git('update-ref', 'refs/remotes/origin/main', 'main');
    this.git('checkout', '-q', '-b', 'pr');
    return this;
  }
  // Commit the PR, then synthesize the merge ref actions/checkout produces.
  merge(msg = 'pr') {
    this.commit(msg);
    this.git('checkout', '-q', '--detach', 'main');
    this.git('merge', '-q', '--no-ff', '-m', 'merge pr', 'pr');
    return this;
  }
  // Advance base (main + origin/main) after the PR branched, keeping the PR branch.
  advanceBase(fn, msg = 'base advance') {
    this.commit('pr wip');
    this.git('checkout', '-q', 'main');
    fn(this);
    this.commit(msg);
    this.git('update-ref', 'refs/remotes/origin/main', 'main');
    this.git('checkout', '-q', 'pr');
    return this;
  }
  run(args = ['--base', 'origin/main'], { guard = GUARD } = {}) {
    const env = { PATH: `${this.bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/nonexistent' };
    const r = spawnSync(process.execPath, ['--disable-proto=throw', guard, ...args], { cwd: this.dir, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }
  railsGuardLog() { try { return readFileSync(join(this.state, 'rails-guard-invocations'), 'utf8'); } catch { return ''; } }
  cleanup() { rmSync(this.dir, { recursive: true, force: true }); rmSync(this.state, { recursive: true, force: true }); }
}
