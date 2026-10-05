// Tests for bin/node-launcher.sh (T-PLUGIN-01-CORE, spec §3 / §4.3 item 4 + Appendix A E7).
//
// Hermetic design:
//  * Everything runs against a fake plugin root + fake $HOME with PATH=/usr/bin:/bin.
//  * The launcher rejects any candidate whose path has a `/tmp` segment, so the fixture
//    lives next to the repo (not in os.tmpdir()). Tests skip if the repo itself sits under /tmp.
//  * The launcher checks real system nodes (/opt/homebrew, /usr/local, /usr, /bin) and
//    `command -v node` FIRST, which would make results depend on the developer's machine.
//    So all behavioural tests run a fixture COPY of the script with ONLY those system-prefix
//    candidate lines and the PATH fallback neutralised (see `neutralise`). Version-manager
//    search, validation, trust, rejection, confinement and exec logic are the unmodified code.
//    One test runs the pristine script and adapts to whatever the host provides.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync, realpathSync, copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const LAUNCHER_SRC = join(REPO, 'bin', 'node-launcher.sh');
const REAL_NODE = process.execPath;
const hasDash = spawnSync('/bin/sh', ['-c', 'command -v dash']).status === 0;
const underTmp = /(^|\/)tmp(\/|$)/.test(REPO);

let base;
let n = 0;

before(() => { if (!underTmp) base = mkdtempSync(join(REPO, '.launcher-test-')); });
after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

/** Copy of the launcher with system-prefix candidates + PATH fallback disabled (documented above). */
function neutralise(src) {
  return src
    .replace(/^check_candidate "\/(opt\/homebrew|usr\/local|usr|)\/?bin\/node"$/gm, ':')
    .replace(/^check_candidate "\/bin\/node"$/gm, ':')
    .replace('command -v node', 'command -v agb-no-such-node-binary');
}

/** Fresh fixture: plugin root (with launcher copy + dist/hello.mjs), fake HOME. */
function fixture({ pristine = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(base, 'fx-')));
  const root = join(dir, 'plugin');
  const home = join(dir, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const src = readFileSync(LAUNCHER_SRC, 'utf8');
  writeFileSync(join(root, 'bin', 'node-launcher.sh'), pristine ? src : neutralise(src));
  writeFileSync(join(root, 'dist', 'hello.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  return { dir, root, home, launcher: join(root, 'bin', 'node-launcher.sh') };
}

/** Install a mock node pretending to be `version` at an absolute path; returns the path. */
function mockNode(path, version, marker = version) {
  mkdirSync(dirname(path), { recursive: true });
  const [maj, min] = version.split('.').map(Number);
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "-e" ]; then
  [ ${maj} -gt 22 ] && exit 0
  [ ${maj} -eq 22 ] && [ ${min} -ge 19 ] && exit 0
  exit 1
fi
echo "MOCKNODE:${marker}" >&2
exec "${REAL_NODE}" "$@"
`);
  chmodSync(path, 0o755);
  return path;
}

const fnmPath = (home, v) => join(home, '.local/share/fnm/node-versions', `v${v}`, 'installation/bin/node');
const misePath = (home, v) => join(home, '.local/share/mise/installs/node', v, 'bin/node');

function run(fx, args, { shell = '/bin/sh', cwd, env = {} } = {}) {
  return spawnSync(shell, [fx.launcher, ...args], {
    cwd: cwd ?? fx.home,
    env: { PATH: '/usr/bin:/bin', HOME: fx.home, ...env },
    encoding: 'utf8',
  });
}

const shells = ['/bin/sh', ...(hasDash ? ['dash'] : [])];
const skip = underTmp ? 'repo is under a /tmp path; launcher would reject fixture nodes' : false;

describe('bin/node-launcher.sh', { skip }, () => {
  for (const shell of shells) {
    describe(`under ${shell}`, () => {
      test('rejects Node 22.11 (exit 86, error message)', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.11.0'), '22.11.0');
        const r = run(fx, ['dist/hello.mjs'], { shell });
        assert.equal(r.status, 86);
        assert.match(r.stderr, /No Node\.js >= 22\.19\.0 found/);
        assert.doesNotMatch(r.stderr, /MOCKNODE/);
      });

      test('accepts Node 22.19 and runs the script', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
        const r = run(fx, ['dist/hello.mjs'], { shell });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /MOCKNODE:22\.19\.0/);
        assert.equal(r.stdout, '[]');
      });

      test('skips an old Node and picks a newer one', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.11.0'), '22.11.0');
        mockNode(fnmPath(fx.home, '24.1.0'), '24.1.0');
        const r = run(fx, ['dist/hello.mjs'], { shell });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /MOCKNODE:24\.1\.0/);
      });

      test('mise candidate under $HOME/.local/share is accepted', () => {
        const fx = fixture();
        mockNode(misePath(fx.home, '22.20.0'), '22.20.0');
        const r = run(fx, ['dist/hello.mjs'], { shell });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /MOCKNODE:22\.20\.0/);
      });

      test('arguments with spaces and metacharacters pass through intact', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
        const args = ['a b', '  lead', 'trail  ', '$HOME', '*', "it's", '"q"', '', 'ünï 🚀'];
        const r = run(fx, ['dist/hello.mjs', ...args], { shell });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), args);
      });

      test('cwd=$HOME and cwd=/ do not reject a valid candidate', () => {
        for (const cwd of [undefined, '/']) {
          const fx = fixture();
          mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
          const r = run(fx, ['dist/hello.mjs'], { shell, cwd });
          assert.equal(r.status, 0, `cwd=${cwd}: ${r.stderr}`);
        }
      });

      test('AGB_TARGET_REPO=$HOME does not reject a valid candidate', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
        const r = run(fx, ['dist/hello.mjs'], { shell, env: { AGB_TARGET_REPO: fx.home } });
        assert.equal(r.status, 0, r.stderr);
      });

      test('candidate inside AGB_TARGET_REPO is rejected', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
        const r = run(fx, ['dist/hello.mjs'], { shell, env: { AGB_TARGET_REPO: join(fx.home, '.local/share/fnm') } });
        assert.equal(r.status, 86);
        assert.doesNotMatch(r.stderr, /MOCKNODE/);
      });

      test('candidate inside the current working directory is rejected', () => {
        const fx = fixture();
        mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
        const r = run(fx, ['dist/hello.mjs'], { shell, cwd: join(fx.home, '.local/share/fnm') });
        assert.equal(r.status, 86);
      });
    });
  }

  describe('candidate rejection (real path segments)', () => {
    test('node_modules segment is rejected, same layout without it is accepted', () => {
      const bad = fixture();
      mockNode(join(bad.home, '.nvm/versions/node/node_modules/bin/node'), '22.19.0');
      assert.equal(run(bad, ['dist/hello.mjs']).status, 86);
      const good = fixture();
      mockNode(join(good.home, '.nvm/versions/node/v22.19.0/bin/node'), '22.19.0');
      assert.equal(run(good, ['dist/hello.mjs']).status, 0);
    });

    test('/tmp-like segment is rejected', () => {
      const fx = fixture();
      mockNode(join(fx.home, '.nvm/versions/node/tmp/bin/node'), '22.19.0');
      assert.equal(run(fx, ['dist/hello.mjs']).status, 86);
    });

    test('.git segment reached through a symlink is rejected (full symlink resolution)', () => {
      const fx = fixture();
      const real = mockNode(join(fx.home, '.git/bin/node'), '22.19.0');
      mkdirSync(join(fx.home, '.nvm/versions/node/v22.19.0/bin'), { recursive: true });
      symlinkSync(real, join(fx.home, '.nvm/versions/node/v22.19.0/bin/node'));
      assert.equal(run(fx, ['dist/hello.mjs']).status, 86);
    });

    test('symlink pointing to an untrusted location is rejected', () => {
      const fx = fixture();
      const real = mockNode(join(fx.dir, 'elsewhere/node'), '22.19.0');
      mkdirSync(join(fx.home, '.nvm/versions/node/v22.19.0/bin'), { recursive: true });
      symlinkSync(real, join(fx.home, '.nvm/versions/node/v22.19.0/bin/node'));
      assert.equal(run(fx, ['dist/hello.mjs']).status, 86);
    });

    test('untrusted version-manager location outside the allowlist is never searched', () => {
      const fx = fixture();
      mockNode(join(fx.home, 'random/bin/node'), '22.19.0');
      assert.equal(run(fx, ['dist/hello.mjs']).status, 86);
    });
  });

  describe('script confinement', () => {
    function withNode() {
      const fx = fixture();
      mockNode(fnmPath(fx.home, '22.19.0'), '22.19.0');
      writeFileSync(join(fx.dir, 'outside.mjs'), 'console.log("ESCAPED");\n');
      return fx;
    }

    test('relative ../ traversal is rejected with exit 1', () => {
      const fx = withNode();
      const r = run(fx, ['../outside.mjs']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /outside PLUGIN_ROOT/);
      assert.doesNotMatch(r.stdout, /ESCAPED/);
    });

    test('absolute path outside the root is rejected with exit 1', () => {
      const fx = withNode();
      const r = run(fx, [join(fx.dir, 'outside.mjs')]);
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout, /ESCAPED/);
    });

    test('symlink inside the root escaping it is rejected with exit 1', () => {
      const fx = withNode();
      symlinkSync(join(fx.dir, 'outside.mjs'), join(fx.root, 'dist', 'link.mjs'));
      const r = run(fx, ['dist/link.mjs']);
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout, /ESCAPED/);
    });

    test('symlink inside the root pointing inside the root is allowed', () => {
      const fx = withNode();
      symlinkSync(join(fx.root, 'dist', 'hello.mjs'), join(fx.root, 'dist', 'ok.mjs'));
      const r = run(fx, ['dist/ok.mjs', 'x']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), ['x']);
    });

    test('absolute path inside the root is allowed', () => {
      const fx = withNode();
      const r = run(fx, [join(fx.root, 'dist', 'hello.mjs'), 'y']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), ['y']);
    });

    test('missing script exits 1', () => {
      const fx = withNode();
      const r = run(fx, ['dist/nope.mjs']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not found/);
    });

    test('no script argument exits 1', () => {
      const fx = withNode();
      const r = run(fx, []);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /No script argument/);
    });

    test('works regardless of the invocation cwd (plugin root derived from launcher location)', () => {
      const fx = withNode();
      const elsewhere = join(fx.dir, 'elsewhere');
      mkdirSync(elsewhere);
      const r = run(fx, ['dist/hello.mjs', 'z'], { cwd: elsewhere });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), ['z']);
    });
  });

  describe('pristine script (host-dependent system nodes)', () => {
    test('behaves consistently with whatever trusted Node the host has', () => {
      const fx = fixture({ pristine: true });
      const r = run(fx, ['dist/hello.mjs', 'p']);
      if (r.status === 86) {
        assert.match(r.stderr, /No Node\.js >= 22\.19\.0 found/);
      } else {
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), ['p']);
      }
    });

    test('keeps the exact exit contract and uses `command -v` (not `which`)', () => {
      const src = readFileSync(LAUNCHER_SRC, 'utf8');
      assert.match(src, /^#!\/bin\/sh/);
      assert.match(src, /exit 86/);
      assert.match(src, /command -v node/);
      assert.doesNotMatch(src, /\bwhich node\b/);
    });
  });
});
