// Plugin root anchoring, the shared safe `agy plugin install` helper, the
// integrity-pinned vendored @adlc/antigravity installer, and the
// ~/.local/bin/agb terminal shim (spec .adlc/specs/native-plugin-installation.md
// §4.1, Appendix A D3, D13, A.4 items 15/18/19, A.6 items 15/16).
//
// MCP safety: nothing in this module writes to stdout. All diagnostics and
// child-process output go to stderr, because in MCP server contexts stdout is
// the JSON-RPC transport.
//
// Error contract: the installer functions return { ok: false, error } instead
// of throwing. resolvePluginRoot() keeps the spec's throwing contract (a
// missing plugin root is a broken installation, not a degradable condition).
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  existsSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, cpSync, rmSync,
  writeFileSync, chmodSync, renameSync, statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const BUNDLED_ADLC_ANTIGRAVITY_VERSION = '1.7.0';
export const PINNED_ADLC_ANTIGRAVITY_INTEGRITY =
  'sha512-vCI7U5AeAkTuvzyXH59JdVyjy7Qj6abKhopUkM/ydGhKhU2wL7GD1eeXjPT2N2mmGENfeijbdks2Ez3X/hQZWA==';
export const VENDORED_ADLC_ANTIGRAVITY_TARBALL =
  `vendor/cache/adlc-antigravity-${BUNDLED_ADLC_ANTIGRAVITY_VERSION}.tgz`;

export const BOOSTER_PLUGIN_NAME = 'antigravity-booster';
export const ADLC_ANTIGRAVITY_PLUGIN_NAME = 'adlc-antigravity';

// D13 / A.6 item 16: never copy these into a staged plugin.
export const INSTALL_COPY_EXCLUSIONS = Object.freeze(['node_modules', '.worktrees', '.git']);

export const AGY_INSTALL_TIMEOUT_MS = 60_000;
const TAR_LIST_TIMEOUT_MS = 15_000;
const TAR_EXTRACT_TIMEOUT_MS = 30_000;

export const TERMINAL_SHIM_CONTENT =
  '#!/bin/sh\n' +
  'exec /bin/sh "${HOME}/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs "$@"\n';

const log = (msg) => process.stderr.write(`${msg}\n`);

// A.4 item 18: exactly `antigravity-booster`, or a prefix of `antigravity-booster-`.
export function isBoosterPluginName(name) {
  return typeof name === 'string' &&
    (name === BOOSTER_PLUGIN_NAME || name.startsWith(`${BOOSTER_PLUGIN_NAME}-`));
}

export function resolvePluginRoot(startDir = dirname(fileURLToPath(import.meta.url))) {
  let curr = startDir;
  while (curr && curr !== dirname(curr)) {
    const manifest = join(curr, 'plugin.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        if (isBoosterPluginName(parsed?.name)) {
          const canonicalRoot = curr;
          // PLUGIN_ROOT is honored only when it is the same directory as the
          // anchored root (repo tooling like direnv cannot redirect assets).
          if (process.env.PLUGIN_ROOT) {
            try {
              if (realpathSync(process.env.PLUGIN_ROOT) === realpathSync(canonicalRoot)) {
                return process.env.PLUGIN_ROOT;
              }
            } catch { /* unresolvable override: ignore it */ }
          }
          return canonicalRoot;
        }
      } catch { /* malformed manifest: keep walking */ }
    }
    curr = dirname(curr);
  }
  throw new Error(`Could not resolve antigravity-booster plugin root containing valid plugin.json from ${startDir}`);
}

export function resolveAssetPath(relPath) {
  return join(resolvePluginRoot(), relPath);
}

export function resolveAgyBinary(home = homedir()) {
  const candidates = [
    join(home, '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'agy';
}

export function resolveTarBinary() {
  for (const bin of ['/usr/bin/tar', '/bin/tar']) {
    if (existsSync(bin)) return bin;
  }
  return 'tar';
}

export function pluginsDirFor(home = homedir()) {
  return join(home, '.gemini', 'config', 'plugins');
}

function childEnv(home) {
  return home ? { ...process.env, HOME: home } : process.env;
}

function forwardToStderr(buf) {
  if (buf && buf.length > 0) process.stderr.write(buf);
}

function isExcludedFromCopy(srcPath) {
  return INSTALL_COPY_EXCLUSIONS.includes(basename(srcPath));
}

/**
 * Install `sourceDir` as plugin `targetPluginName` via `agy plugin install`.
 * Always installs from a fresh `mkdtemp/<targetPluginName>` copy (excluding
 * node_modules/.worktrees/.git), so the staged name never depends on the
 * source basename and agy can never prune its own source. Skips when the
 * source already IS the staged directory.
 *
 * options: { home, agyBin, tmpParent } — home/agyBin default to the real
 * user environment; tests inject a temp HOME and the fake agy.
 */
export function safePluginInstall(sourceDir, targetPluginName, options = {}) {
  const home = options.home ?? homedir();
  let tmpRoot;
  try {
    if (!sourceDir || !existsSync(sourceDir)) {
      return { ok: false, error: `Source directory does not exist: ${sourceDir}` };
    }
    if (!targetPluginName || targetPluginName !== basename(targetPluginName) || targetPluginName.startsWith('.')) {
      return { ok: false, error: `Invalid target plugin name: ${targetPluginName}` };
    }
    const pluginsParent = pluginsDirFor(home);
    mkdirSync(pluginsParent, { recursive: true });
    const stagedDir = join(pluginsParent, targetPluginName);
    if (existsSync(stagedDir) && realpathSync(sourceDir) === realpathSync(stagedDir)) {
      log(`${targetPluginName} is already running from staged plugin directory; skipping self-install.`);
      return { ok: true, skipped: true };
    }

    tmpRoot = mkdtempSync(join(options.tmpParent ?? tmpdir(), 'agy-staging-'));
    const tmpTarget = join(tmpRoot, targetPluginName);
    cpSync(sourceDir, tmpTarget, {
      recursive: true,
      filter: (src) => !isExcludedFromCopy(src),
    });

    const agyBin = options.agyBin ?? resolveAgyBinary(home);
    try {
      const out = execFileSync(agyBin, ['plugin', 'install', tmpTarget], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: AGY_INSTALL_TIMEOUT_MS,
        env: childEnv(options.home),
      });
      forwardToStderr(out);
    } catch (err) {
      forwardToStderr(err.stdout);
      forwardToStderr(err.stderr);
      return { ok: false, error: `agy plugin install failed for ${targetPluginName}: ${err.message}` };
    }

    if (!existsSync(join(stagedDir, 'plugin.json'))) {
      return { ok: false, error: `agy plugin install reported success but ${join(stagedDir, 'plugin.json')} is missing` };
    }
    return { ok: true, skipped: false };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function sha512Integrity(file) {
  return 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');
}

// Reject anything that could land outside the extraction dir: entries not
// under package/, any `..`, absolute paths, and symlink/hardlink members.
function validateTarEntries(tarBin, tarballPath) {
  const listOut = execFileSync(tarBin, ['-tzf', tarballPath], {
    encoding: 'utf8', timeout: TAR_LIST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const entry of listOut.split('\n')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('package/') || trimmed.includes('..') || trimmed.startsWith('/')) {
      return `Invalid entry path in tarball: ${trimmed}`;
    }
  }
  const verbose = execFileSync(tarBin, ['-tvzf', tarballPath], {
    encoding: 'utf8', timeout: TAR_LIST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const line of verbose.split('\n')) {
    if (line.startsWith('l') || line.startsWith('h')) {
      return `Link entries are not allowed in tarball: ${line.trim()}`;
    }
  }
  return null;
}

/**
 * Verify `tarballPath` against `integrity`, validate its entries, extract it
 * into `<mkdtemp>/<pluginName>`, install via safePluginInstall, and always
 * remove the temp root. The vendored-adlc entry point below pins the inputs.
 */
export function installPluginTarball({ tarballPath, integrity, pluginName, home, agyBin, tmpParent, tamperedError } = {}) {
  let tmpRoot;
  try {
    if (!tarballPath || !existsSync(tarballPath)) {
      return { ok: false, error: `Vendored tarball missing: ${tarballPath}` };
    }
    if (sha512Integrity(tarballPath) !== integrity) {
      return { ok: false, error: tamperedError ?? `tarball-integrity-mismatch: ${tarballPath}` };
    }
    const tarBin = resolveTarBinary();
    const invalid = validateTarEntries(tarBin, tarballPath);
    if (invalid) return { ok: false, error: invalid };

    tmpRoot = mkdtempSync(join(tmpParent ?? tmpdir(), 'agy-adlc-staging-'));
    const extractDir = join(tmpRoot, pluginName);
    mkdirSync(extractDir, { recursive: true });
    execFileSync(tarBin, ['-xzf', tarballPath, '-C', extractDir, '--strip-components=1'], {
      timeout: TAR_EXTRACT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return safePluginInstall(extractDir, pluginName, { home, agyBin, tmpParent });
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Install the pristine, integrity-pinned @adlc/antigravity release tarball
 * committed at vendor/cache/ (§4.4 Decision 1). The sole owner of its temp
 * extraction directory lifecycle.
 *
 * options: { home, agyBin, tmpParent, tarballPath } — tarballPath defaults to
 * the committed asset; the integrity pin is never overridable here.
 */
export function installAdlcAntigravityFromVendor(options = {}) {
  try {
    const tarballPath = options.tarballPath ?? resolveAssetPath(VENDORED_ADLC_ANTIGRAVITY_TARBALL);
    return installPluginTarball({
      tarballPath,
      integrity: PINNED_ADLC_ANTIGRAVITY_INTEGRITY,
      pluginName: ADLC_ANTIGRAVITY_PLUGIN_NAME,
      home: options.home,
      agyBin: options.agyBin,
      tmpParent: options.tmpParent,
      tamperedError: 'vendored-adlc-antigravity-tampered',
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Write the D3 terminal shim at ~/.local/bin/agb (mode 0755).
 * Absent → written; byte-identical → unchanged; other content → warn and
 * skip unless `force` (A.6 item 15). Returns { ok, action, path } or
 * { ok: false, error }.
 */
export function installTerminalShim({ home = homedir(), force = false } = {}) {
  const binDir = join(home, '.local', 'bin');
  const shimPath = join(binDir, 'agb');
  try {
    if (existsSync(shimPath)) {
      const current = readFileSync(shimPath, 'utf8');
      if (current === TERMINAL_SHIM_CONTENT) {
        if ((statSync(shimPath).mode & 0o777) !== 0o755) chmodSync(shimPath, 0o755);
        return { ok: true, action: 'unchanged', path: shimPath };
      }
      if (!force) {
        log(`warning: ${shimPath} exists with different content; leaving it untouched (re-run with --force-reinstall to overwrite)`);
        return { ok: true, action: 'skipped', path: shimPath };
      }
    }
    mkdirSync(binDir, { recursive: true });
    const tmpPath = join(binDir, `.agb.tmp-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(tmpPath, TERMINAL_SHIM_CONTENT, { mode: 0o755 });
      chmodSync(tmpPath, 0o755);
      renameSync(tmpPath, shimPath);
    } catch (err) {
      rmSync(tmpPath, { force: true });
      throw err;
    }
    return { ok: true, action: 'written', path: shimPath };
  } catch (err) {
    return { ok: false, error: `could not install terminal shim at ${shimPath}: ${err.message}` };
  }
}
