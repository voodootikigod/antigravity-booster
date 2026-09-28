// Bridges booster's plan.json ticket format to the repo's ADLC ticket store,
// the contract the adlc-antigravity plugin's rails-guard hook and the adlc
// CLI's 20 tools operate on. The canonical backend is the DIRECTORY store
// (.adlc/tickets/ with a .store.json manifest, one canonical-JSON shard per
// ticket); the single-file .adlc/tickets.json remains recognized as the 1.x
// legacy bridge on repos that still carry one.
//
// plan.json remains booster's execution artifact — it carries fields
// (tier, pool_hint) the @adlc/core ticket schema doesn't have.
// The projected store is a generated PROJECTION consumed by the plugin/CLI,
// not a second source of truth a human edits. See docs/guidelines.md
// ("The Plan Phase").

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, lstatSync, realpathSync, openSync, readSync, closeSync, statSync, fstatSync, chmodSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync, spawn, execFileSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';

// Lazy-loaded so importing this module (e.g. bootstrap's handshake path)
// never requires @adlc/tickets to be resolvable — only the projection
// writer needs it. require(esm) is native on the Node >=22.19 floor.
let ticketsApi;
function ticketsLib() {
  ticketsApi ??= createRequire(import.meta.url)('@adlc/tickets');
  return ticketsApi;
}

/**
 * The plugin-contract version this booster projects and can interoperate with.
 * The booster OWNS the projected .adlc/tickets.json schema + hook payload shape,
 * so it declares the contract here; the installed adlc-antigravity plugin
 * advertises the contract it speaks via `adlcContract` in its plugin.json. An
 * integer (not semver): the contract is a discrete on-the-wire agreement, bumped
 * only on a breaking schema/hook change, so exact-integer equality is the
 * compatibility test.
 */
export const SUPPORTED_PLUGIN_CONTRACT = 1;

/**
 * Base directory of the INSTALLED adlc-antigravity plugin (the dir holding its
 * plugin.json). Overridable via AGB_PLUGIN_DIR — consistent with the other AGB_*
 * knobs — so the offline suite can point the handshake at a fixture instead of
 * the real ~/.gemini install. Distinct from ADLC_ANTIGRAVITY_PLUGIN_PATH, which
 * names the SOURCE checkout `agy plugin install` reads FROM; this is where the
 * installed manifest lands.
 */
export function pluginManifestDir() {
  return process.env.AGB_PLUGIN_DIR ?? join(homedir(), '.gemini', 'config', 'plugins', 'adlc-antigravity');
}

/**
 * Read the installed adlc-antigravity plugin manifest and classify its
 * `adlcContract` against SUPPORTED_PLUGIN_CONTRACT. Pure + total: NEVER throws
 * (matches 'CLI integrations degrade, never crash'). Returns exactly one of:
 *   { status: 'compatible', contract }   — adlcContract === supported: enforce
 *   { status: 'incompatible', contract } — present integer !== supported: the
 *                                          caller aborts LOUDLY (version skew)
 *   { status: 'missing-field' }          — manifest read but no/garbled
 *                                          adlcContract (older plugin): degrade
 *   { status: 'unreadable', error }      — absent/unparseable manifest: degrade
 *
 * `dir` overrides the base dir (bootstrap passes the plugin it just installed);
 * default resolves via pluginManifestDir().
 */
export function readPluginContract({ dir } = {}) {
  const path = join(dir ?? pluginManifestDir(), 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { status: 'unreadable', error: `plugin manifest at ${path}: ${err.code ?? err.message}` };
  }
  const contract = manifest?.adlcContract;
  // A present-but-non-integer contract is a garbled/older manifest, not a known
  // incompatibility — degrade rather than abort on something we can't parse.
  if (!Number.isInteger(contract)) return { status: 'missing-field' };
  if (contract === SUPPORTED_PLUGIN_CONTRACT) return { status: 'compatible', contract };
  return { status: 'incompatible', contract };
}

/**
 * Project one plan ticket into the @adlc/core ticket shape (id, title,
 * body, scope, rails, edges, duration). Pure — does not invent fields the
 * plan ticket doesn't already carry. Used both for the whole-plan
 * projection below and to materialize a single active ticket (e.g.
 * .adlc/current-ticket.json for a builder's worktree).
 */
export function planTicketToAdlcTicket(t) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    scope: t.scope ?? [],
    rails: t.rails ?? [],
    edges: (t.edges ?? []).map((e) => ({
      to: e.to,
      ...(e.contract ? { contract: e.contract } : {}),
    })),
    ...(t.duration !== undefined ? { duration: t.duration } : {}),
  };
}

/**
 * Project a compiled booster plan's tickets into the @adlc/core ticket
 * shape. Pure — does not invent fields the plan ticket doesn't already
 * carry.
 */
export function planToAdlcTickets(plan) {
  return (plan.tickets ?? []).map(planTicketToAdlcTicket);
}

/**
 * Project ONE plan ticket into the single-ticket, rail-enforcement-only shape
 * written into each builder's worktree at <worktree>/.adlc/tickets.json.
 *
 * DISTINCT from planTicketToAdlcTicket on purpose: this file contains exactly
 * one ticket, so it MUST NOT carry `edges`. An outgoing edge names a target
 * ticket that is — by construction — absent from a single-ticket file; the
 * adlc-antigravity plugin's loadTickets reports that as a dangling-edge error,
 * and its railPreconditions fails CLOSED on ANY validation error, denying
 * EVERY structured write for the whole build (not just rail paths). Only leaf
 * tickets (no outgoing edges) enforce correctly otherwise, which is why the bug
 * was invisible (B11 / adlc repo #142: the plugin stays fail-closed on dangling
 * edges, the booster projects edge-free single-ticket files).
 *
 * Two separate named functions rather than an option flag so the whole-plan and
 * single-ticket call sites cannot silently swap. Keeps only what rail resolution
 * and the plugin validator need: id + title (validateTicket requires a string
 * title) + rails, plus scope. Drops edges (the bug), and body/duration (not part
 * of rail resolution; the builder's charter comes from its worktree AGENTS.md).
 */
export function planTicketToRailTicket(t) {
  return {
    id: t.id,
    title: t.title,
    scope: t.scope ?? [],
    rails: t.rails ?? [],
  };
}

/**
 * Classify the repo's ADLC ticket store backend without loading it.
 * Returns 'directory' | 'legacy' | 'both' | 'none'. 'both' is a fail-closed
 * state for the adlc-antigravity plugin's reader (it refuses to pick one).
 */
export function detectTicketStoreBackend(repo) {
  const hasDirectory = existsSync(join(repo, '.adlc', 'tickets', '.store.json'));
  const hasLegacy = existsSync(join(repo, '.adlc', 'tickets.json'));
  if (hasDirectory && hasLegacy) return 'both';
  if (hasDirectory) return 'directory';
  if (hasLegacy) return 'legacy';
  return 'none';
}

/**
 * Write the projected tickets to the repo's ADLC ticket store, IN KIND:
 *
 *   - directory store present (or no store at all): rewrite the directory
 *     store — every shard is projection-owned, so stale shards from a prior
 *     projection are removed and each ticket lands as .adlc/tickets/
 *     <ticketFilename(id)> in canonical JSON. A repo with NO store gets a
 *     fresh directory store (the canonical backend), never a new tickets.json.
 *   - legacy tickets.json ONLY: keep writing the single file (1.x bridge for
 *     repos that haven't run `adlc ticket store migrate`).
 *   - both present: the directory store wins and the legacy projection
 *     artifact is deleted — the plugin's reader fails CLOSED on the
 *     both-stores state, which would deny every builder write mid-run.
 *
 * Returns the written path (the store directory, or the legacy file).
 */
export function writeAdlcTickets(repo, tickets) {
  const dir = join(repo, '.adlc');
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error(`refusing to project tickets through a symlink: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  const backend = detectTicketStoreBackend(repo);
  if (backend === 'legacy') {
    const path = join(dir, 'tickets.json');
    // Same shard-symlink defense as below, legacy backend: a crafted repo can
    // commit tickets.json as a symlink and writeFileSync would follow it.
    try {
      if (!lstatSync(path).isFile()) rmSync(path, { force: true });
    } catch { /* absent — nothing to unlink */ }
    writeFileSync(path, JSON.stringify({ tickets }, null, 2) + '\n');
    return path;
  }
  const { initializeDirectoryStore, ticketFilename, prettyCanonicalJson, ACTIVE_MANIFEST } = ticketsLib();
  const storeDir = join(dir, 'tickets');
  // Refuse to write through a symlinked .adlc or store dir: a crafted target
  // repo could commit .adlc/tickets as a symlink and redirect the stale-shard
  // cleanup below at files outside the store (the plugin's own reader rejects
  // symlinked store paths for the same reason).
  for (const p of [dir, storeDir]) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
      throw new Error(`refusing to project tickets through a symlink: ${p}`);
    }
  }
  if (backend === 'none') {
    if (existsSync(storeDir)) {
      // Orphaned store dir — created but the manifest never landed (e.g. an
      // interrupted first projection). initializeDirectoryStore would throw
      // STORE_EXISTS forever; the projection owns the store, so recover by
      // writing the manifest into the existing dir.
      writeFileSync(join(storeDir, '.store.json'), prettyCanonicalJson(ACTIVE_MANIFEST));
    } else {
      initializeDirectoryStore(storeDir);
    }
  }
  if (backend === 'both') rmSync(join(dir, 'tickets.json'), { force: true });
  // Write first, prune second: shard names are deterministic per id, so the
  // new projection lands (overwriting same-id shards) before any stale shard
  // is removed — a crash mid-projection leaves a superset, never a hole.
  const keep = new Set(['.store.json']);
  for (const t of tickets) {
    const shard = ticketFilename(t.id);
    keep.add(shard);
    const shardPath = join(storeDir, shard);
    // Shard names are deterministic, so a crafted repo can pre-commit a
    // symlink AT the shard name — writeFileSync follows it and would
    // truncate whatever it points at. The projection owns every shard:
    // unlink anything that isn't a regular file before writing.
    try {
      if (!lstatSync(shardPath).isFile()) rmSync(shardPath, { force: true });
    } catch { /* absent — nothing to unlink */ }
    // prettyCanonicalJson already ends with a newline.
    writeFileSync(shardPath, prettyCanonicalJson(t));
  }
  for (const entry of readdirSync(storeDir)) {
    if (!keep.has(entry) && entry.endsWith('.json')) rmSync(join(storeDir, entry), { force: true });
  }
  return storeDir;
}

/**
 * Minimum supported @adlc/cli version floor.
 */
export const MIN_ADLC_CLI_VERSION = '1.11.1';

export function parseSemver(v) {
  const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ?? null,
    build: m[5] ?? null,
  };
}

export function semverGte(a, b) {
  const pa = typeof a === 'object' && a !== null ? a : parseSemver(a);
  const pb = typeof b === 'object' && b !== null ? b : parseSemver(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;
  // Major, minor, and patch are equal.
  // A version with a prerelease has lower precedence than a normal version (no prerelease).
  if (pa.prerelease && !pb.prerelease) return false;
  if (!pa.prerelease && pb.prerelease) return true;
  if (!pa.prerelease && !pb.prerelease) return true;
  // Both have prerelease: compare dot-separated identifiers.
  const aParts = String(pa.prerelease).split('.');
  const bParts = String(pb.prerelease).split('.');
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) return false; // fewer identifiers = lower precedence
    if (bPart === undefined) return true;
    if (aPart === bPart) continue;
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    const aIsNum = !Number.isNaN(aNum) && /^\d+$/.test(aPart);
    const bIsNum = !Number.isNaN(bNum) && /^\d+$/.test(bPart);
    if (aIsNum && bIsNum) {
      return aNum >= bNum;
    }
    if (aIsNum !== bIsNum) {
      return !aIsNum; // numeric has lower precedence than lexical
    }
    return aPart >= bPart;
  }
  return true;
}

export const KNOWN_ADLC_DIGESTS = {
  '1.11.1': {
    integrity: 'sha512-2J6dID3l/UHYdEh3njbwAGuiBOP2NEOkMNUHIPWo1nb85SKrAlZxNESMkIH4M93WsoT54jFbcbDeRZdMIo9lBw==',
    treeDigest: '1383387afe5c5062b7e1e81c360a0fc6cb876513153665feca731b8de77c2172',
    binarySha256: 'b38de003d6fdbfd139229ed0a70a85c719bac6a5d4885fbcfffe15e96fa84d21',
  },
};

/**
 * Authenticate an @adlc/cli package directory and its executable target.
 */
export function authenticateAdlcPackage(pkgDir, candidatePath, opts = {}) {
  const options = typeof opts === 'string' ? { lockfilePath: opts } : (opts ?? {});
  const {
    minVersion = MIN_ADLC_CLI_VERSION,
    lockfilePath = null,
    expectedDigest = null,
    expectedTreeDigest = null,
    trustedIntegrity = null,
    enforceKnownDigest = false,
  } = options;
  try {
    const pkgStat = lstatSync(pkgDir);
    if (pkgStat.isSymbolicLink() || !pkgStat.isDirectory()) {
      return { ok: false, error: `package directory ${pkgDir} is a symlink or not a directory` };
    }
    const realPkgDir = realpathSync(pkgDir);
    const manifestPath = join(realPkgDir, 'package.json');
    if (!existsSync(manifestPath)) {
      return { ok: false, error: `missing package.json in ${realPkgDir}` };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== '@adlc/cli') {
      return { ok: false, error: `expected package name @adlc/cli but found ${manifest.name}` };
    }
    if (!manifest.version || !semverGte(manifest.version, minVersion)) {
      return { ok: false, error: `@adlc/cli version ${manifest.version} does not meet floor >= ${minVersion}` };
    }

    let resolvedLockfilePath = lockfilePath;
    if (!resolvedLockfilePath) {
      let searchDir = realPkgDir;
      while (searchDir) {
        const candidateLock = join(searchDir, 'package-lock.json');
        if (existsSync(candidateLock)) {
          resolvedLockfilePath = candidateLock;
          break;
        }
        const parent = dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
      }
    }

    let lockfileVerified = false;
    if (resolvedLockfilePath && existsSync(resolvedLockfilePath)) {
      try {
        const lockContent = JSON.parse(readFileSync(resolvedLockfilePath, 'utf8'));
        if (!lockContent || typeof lockContent !== 'object') {
          return { ok: false, error: `package-lock.json is not a valid JSON object` };
        }
        const pkgKey = Object.keys(lockContent.packages || {}).find(
          (k) => k === 'node_modules/@adlc/cli' || k.endsWith('/node_modules/@adlc/cli')
        );
        const lockEntry =
          (lockContent.packages && pkgKey ? lockContent.packages[pkgKey] : null) ||
          (lockContent.dependencies && lockContent.dependencies['@adlc/cli']);
        if (!lockEntry) {
          return {
            ok: false,
            error: `package-lock.json is present at ${resolvedLockfilePath} but contains no matching entry for @adlc/cli`,
          };
        }
        if (!lockEntry.integrity) {
          return { ok: false, error: `package-lock.json entry for @adlc/cli lacks mandatory integrity field` };
        }
        if (lockEntry.version && lockEntry.version !== manifest.version) {
          return {
            ok: false,
            error: `package-lock.json version mismatch: lockfile has ${lockEntry.version} but manifest has ${manifest.version}`,
          };
        }
        const targetIntegrity = trustedIntegrity ?? (enforceKnownDigest ? KNOWN_ADLC_DIGESTS[manifest.version]?.integrity : null);
        if (enforceKnownDigest && !targetIntegrity) {
          return {
            ok: false,
            error: `cannot verify package integrity: no trusted lockfile integrity recorded in KNOWN_ADLC_DIGESTS for @adlc/cli version ${manifest.version}`,
          };
        }
        if (targetIntegrity && lockEntry.integrity !== targetIntegrity) {
          return {
            ok: false,
            error: `package-lock.json integrity mismatch for @adlc/cli: expected ${targetIntegrity} but found ${lockEntry.integrity}`,
          };
        }
        lockfileVerified = true;
      } catch (err) {
        return { ok: false, error: `failed to parse package-lock.json: ${err.message}` };
      }
    }

    if (enforceKnownDigest && !lockfileVerified) {
      return {
        ok: false,
        error: `package-lock.json verification required under enforceKnownDigest, but no valid lockfile entry was verified for @adlc/cli`,
      };
    }

    let binarySha256 = null;
    if (candidatePath) {
      if (!existsSync(candidatePath)) {
        return { ok: false, error: `binary candidate ${candidatePath} does not exist` };
      }
      const realCandidate = realpathSync(candidatePath);
      const rel = relative(realPkgDir, realCandidate);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { ok: false, error: `binary candidate realpath ${realCandidate} escapes package directory ${realPkgDir}` };
      }
      if (manifest.bin) {
        const binTarget =
          typeof manifest.bin === 'string'
            ? manifest.bin
            : typeof manifest.bin === 'object' && manifest.bin !== null
            ? manifest.bin.adlc
            : null;
        if (!binTarget || typeof binTarget !== 'string') {
          return { ok: false, error: `manifest declares invalid bin target` };
        }
        try {
          const expectedTarget = realpathSync(resolve(realPkgDir, binTarget));
          if (realCandidate !== expectedTarget) {
            return {
              ok: false,
              error: `binary candidate realpath ${realCandidate} does not match manifest bin target ${expectedTarget}`,
            };
          }
        } catch (err) {
          return { ok: false, error: `manifest bin target ${binTarget} cannot be resolved: ${err.message}` };
        }
      }
      const candStat = lstatSync(realCandidate);
      if (!candStat.isFile()) {
        return { ok: false, error: `binary candidate ${realCandidate} is not a regular file` };
      }
      const binBytes = readFileSync(realCandidate);
      if (binBytes.length === 0) {
        return { ok: false, error: `binary candidate ${realCandidate} is empty` };
      }
      binarySha256 = crypto.createHash('sha256').update(binBytes).digest('hex');
      const targetBinaryDigest = expectedDigest ?? (enforceKnownDigest ? KNOWN_ADLC_DIGESTS[manifest.version]?.binarySha256 : null);
      if (enforceKnownDigest && !targetBinaryDigest) {
        return {
          ok: false,
          error: `cannot verify binary digest: no trusted binary SHA-256 recorded in KNOWN_ADLC_DIGESTS for @adlc/cli version ${manifest.version}`,
        };
      }
      if (targetBinaryDigest && binarySha256 !== targetBinaryDigest) {
        return { ok: false, error: `binary candidate digest mismatch: expected ${targetBinaryDigest} but got ${binarySha256}` };
      }
    }

    // Verify package tree integrity and anti-symlink policy inside package
    const treeFiles = [];
    const scanDir = (d, rel = '') => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const subRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = join(d, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`symlink rejected in package tree: ${subRel}`);
        }
        if (entry.isDirectory()) {
          scanDir(full, subRel);
        } else if (entry.isFile()) {
          const fileHash = crypto.createHash('sha256').update(readFileSync(full)).digest('hex');
          treeFiles.push(`${subRel}:${fileHash}`);
        }
      }
    };
    try {
      scanDir(realPkgDir);
    } catch (err) {
      return { ok: false, error: `package tree scan failed: ${err.message}` };
    }
    treeFiles.sort();
    const treeDigest = crypto.createHash('sha256').update(treeFiles.join('\n')).digest('hex');
    const targetTreeDigest = expectedTreeDigest ?? (enforceKnownDigest ? KNOWN_ADLC_DIGESTS[manifest.version]?.treeDigest : null);
    if (enforceKnownDigest && !targetTreeDigest) {
      return {
        ok: false,
        error: `cannot verify package tree: no trusted digest recorded in KNOWN_ADLC_DIGESTS for @adlc/cli version ${manifest.version}`,
      };
    }
    if (targetTreeDigest && treeDigest !== targetTreeDigest) {
      return { ok: false, error: `package tree digest mismatch: expected ${targetTreeDigest} but got ${treeDigest}` };
    }

    return {
      ok: true,
      version: manifest.version,
      manifest,
      pkgDir: realPkgDir,
      binarySha256,
      treeDigest,
      lockfileVerified,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function isTemporaryOrWorldWritablePath(targetPath) {
  let realTarget;
  try {
    realTarget = realpathSync(targetPath);
  } catch (err) {
    return { restricted: true, reason: `unresolvable path: ${err.message}` };
  }

  const isWin = process.platform === 'win32';
  const targetNorm = isWin ? realTarget.toLowerCase() : realTarget;

  // 1. Temporary directory confinement across all platforms
  const candidateDirs = [
    '/tmp',
    '/var/tmp',
    '/private/tmp',
    '/private/var/tmp',
    tmpdir(),
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
  ].filter(Boolean);

  for (const cDir of candidateDirs) {
    let normDir;
    try {
      normDir = realpathSync(cDir);
    } catch {
      normDir = resolve(cDir);
    }
    const checkDir = isWin ? normDir.toLowerCase() : normDir;
    if (targetNorm === checkDir || targetNorm.startsWith(checkDir + (isWin ? '\\' : '/')) || targetNorm.startsWith(checkDir + '/')) {
      return { restricted: true, reason: `resides in temporary directory (${realTarget})` };
    }
  }

  if (isWin) {
    if (
      /[\\/]AppData[\\/]Local[\\/]Temp(\b|[\\/])/i.test(targetNorm) ||
      /[\\/]Windows[\\/]Temp(\b|[\\/])/i.test(targetNorm) ||
      targetNorm.includes('\\temp\\') ||
      targetNorm.includes('\\tmp\\')
    ) {
      return { restricted: true, reason: `resides in temporary directory (${realTarget})` };
    }
  }

  // 2. World-writable and ownership checks on POSIX
  const pathsToCheck = new Set();
  let cur = realTarget;
  while (cur && cur !== dirname(cur)) {
    pathsToCheck.add(cur);
    cur = dirname(cur);
  }
  if (cur) pathsToCheck.add(cur);

  let resolvedTarget;
  try {
    resolvedTarget = resolve(targetPath);
  } catch {
    resolvedTarget = targetPath;
  }
  cur = resolvedTarget;
  while (cur && cur !== dirname(cur)) {
    pathsToCheck.add(cur);
    cur = dirname(cur);
  }
  if (cur) pathsToCheck.add(cur);

  for (const p of pathsToCheck) {
    try {
      const st = lstatSync(p);
      if (!isWin) {
        if (!st.isSymbolicLink() && (st.mode & 0o002) !== 0) {
          return { restricted: true, reason: `path component is world-writable (mode ${st.mode.toString(8)}): ${p}` };
        }
        const isTarget = (p === realTarget || p === resolvedTarget);
        if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) {
          const isWritable = (st.mode & 0o022) !== 0;
          if (isTarget || isWritable) {
            return { restricted: true, reason: `path component owned by untrusted uid ${st.uid} (expected ${process.getuid()} or 0): ${p}` };
          }
        }
      }
    } catch (err) {
      return { restricted: true, reason: `failed inspecting path ${p}: ${err.message}` };
    }
  }

  return { restricted: false, realPath: realTarget };
}

/**
 * Authenticated resolution of the `adlc` executable.
 * Enforces:
 * 1. Primary Authority: Project-local node_modules/.bin/adlc and node_modules/@adlc/cli.
 * 2. Restricted Custom Override: ADLC_CLI_PATH or AGB_ADLC_BIN evaluated ONLY IF AGB_ALLOW_CUSTOM_ADLC_CLI=1.
 * 3. Restricted System PATH: System PATH evaluated ONLY IF AGB_ALLOW_SYSTEM_ADLC=1 or allowSystem=true.
 *
 * Never throws: returns { ok: true, binary, version, source } or { ok: false, error }.
 */
export function resolveAdlcBinary({
  repo = process.cwd(),
  env = process.env,
  allowSystem = false,
  allowCustom = false,
  minVersion = MIN_ADLC_CLI_VERSION,
} = {}) {
  // 1. Custom override via environment
  const customPath = env.ADLC_CLI_PATH || env.AGB_ADLC_BIN;
  const customAllowed = allowCustom || env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';
  if (customPath && customAllowed) {
    try {
      const pathSecurity = isTemporaryOrWorldWritablePath(customPath);
      if (pathSecurity.restricted) {
        return { ok: false, error: `custom adlc binary violates path security constraints: ${pathSecurity.reason}` };
      }
      const realCustom = pathSecurity.realPath;
      const lowerCustom = realCustom.toLowerCase();
      const isShim =
        lowerCustom.endsWith('.cmd') ||
        lowerCustom.endsWith('.ps1') ||
        basename(dirname(realCustom)) === '.bin';

      let parentPkg = null;
      let targetToAuth = realCustom;

      if (isShim) {
        const candidateDirs = [
          join(dirname(realCustom), '..', '@adlc', 'cli'),
          join(dirname(realCustom), '..', 'node_modules', '@adlc', 'cli'),
          join(repo, 'node_modules', '@adlc', 'cli'),
        ];
        for (const d of candidateDirs) {
          if (existsSync(join(d, 'package.json'))) {
            try {
              const manifest = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
              if (manifest.name === '@adlc/cli') {
                parentPkg = d;
                break;
              }
            } catch {}
          }
        }
        if (parentPkg) {
          try {
            const manifest = JSON.parse(readFileSync(join(parentPkg, 'package.json'), 'utf8'));
            const binRel =
              typeof manifest.bin === 'string'
                ? manifest.bin
                : typeof manifest.bin === 'object' && manifest.bin !== null
                ? manifest.bin.adlc
                : null;
            if (binRel) {
              const resolvedTarget = resolve(parentPkg, binRel);
              if (existsSync(resolvedTarget)) {
                targetToAuth = realpathSync(resolvedTarget);
              }
            }
          } catch {}
        }
      }

      if (!parentPkg) {
        parentPkg = dirname(realCustom);
        if (!existsSync(join(parentPkg, 'package.json'))) {
          parentPkg = join(parentPkg, '..');
        }
      }

      const auth = authenticateAdlcPackage(parentPkg, targetToAuth, { minVersion, enforceKnownDigest: false });
      if (auth.ok) {
        return { ok: true, binary: realCustom, version: auth.version, source: 'custom-override' };
      }
      return { ok: false, error: `custom adlc binary failed authentication: ${auth.error}` };
    } catch (err) {
      return { ok: false, error: `custom adlc binary unresolvable: ${err.message}` };
    }
  }

  // 2. Check project-local node_modules (searching repo and parent directories)
  let curDir = resolve(repo);
  while (curDir) {
    const localPkgDir = join(curDir, 'node_modules', '@adlc', 'cli');
    const localBin = join(curDir, 'node_modules', '.bin', 'adlc');
    const localBinCmd = join(curDir, 'node_modules', '.bin', 'adlc.cmd');
    const hasLocalBin = existsSync(localBin) || existsSync(localBinCmd);
    if (existsSync(localPkgDir) && (hasLocalBin || existsSync(join(localPkgDir, 'package.json')))) {
      let targetBin = null;
      try {
        const manifest = JSON.parse(readFileSync(join(localPkgDir, 'package.json'), 'utf8'));
        const binTarget =
          typeof manifest.bin === 'string'
            ? manifest.bin
            : typeof manifest.bin === 'object' && manifest.bin !== null
            ? manifest.bin.adlc
            : null;
        if (binTarget) {
          const resolved = resolve(localPkgDir, binTarget);
          if (existsSync(resolved)) targetBin = resolved;
        }
      } catch {}

      const candidateToAuth = targetBin || (existsSync(localBin) ? localBin : localBinCmd);
      if (candidateToAuth) {
        const auth = authenticateAdlcPackage(localPkgDir, candidateToAuth, { minVersion, enforceKnownDigest: true });
        if (auth.ok) {
          let executableToReturn = candidateToAuth;
          if (process.platform === 'win32') {
            if (existsSync(localBinCmd)) {
              try {
                const cmdContent = readFileSync(localBinCmd, 'utf8');
                const relPkg = relative(dirname(localBinCmd), localPkgDir).replace(/\\/g, '/');
                if (cmdContent.includes(relPkg) || cmdContent.includes('@adlc/cli') || cmdContent.includes('@adlc\\cli')) {
                  executableToReturn = localBinCmd;
                }
              } catch {}
            }
          } else if (existsSync(localBin)) {
            try {
              if (realpathSync(localBin) === realpathSync(candidateToAuth)) {
                executableToReturn = localBin;
              }
            } catch {}
          }
          return { ok: true, binary: executableToReturn, version: auth.version, source: 'project-local' };
        }
        return { ok: false, error: auth.error };
      }
    }
    const parent = dirname(curDir);
    if (parent === curDir) break;
    curDir = parent;
  }

  // 3. System PATH fallback
  const systemAllowed = allowSystem || env.AGB_ALLOW_SYSTEM_ADLC === '1';
  if (systemAllowed) {
    try {
      const isWin = process.platform === 'win32';
      const lookupCmd = isWin ? 'where.exe' : 'which';
      const whichRes = spawnSync(lookupCmd, ['adlc'], { encoding: 'utf8' });
      if (whichRes.status === 0 && whichRes.stdout.trim()) {
        const lines = whichRes.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const sysBin of lines) {
          try {
            const pathSecurity = isTemporaryOrWorldWritablePath(sysBin);
            if (pathSecurity.restricted) {
              continue;
            }
            const realSys = pathSecurity.realPath;
            const lowerReal = realSys.toLowerCase();
            const candidatePkgDirs = [
              join(dirname(realSys), '..'),
              dirname(realSys),
              join(dirname(realSys), 'node_modules', '@adlc', 'cli'),
              join(dirname(realSys), '..', 'node_modules', '@adlc', 'cli'),
            ];
            for (const pkgDir of candidatePkgDirs) {
              if (existsSync(join(pkgDir, 'package.json'))) {
                let targetBin = realSys;
                if (isWin && (lowerReal.endsWith('.cmd') || lowerReal.endsWith('.ps1'))) {
                  try {
                    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
                    const binRel =
                      typeof manifest.bin === 'string'
                        ? manifest.bin
                        : typeof manifest.bin === 'object' && manifest.bin !== null
                        ? manifest.bin.adlc
                        : null;
                    if (binRel) {
                      const resolvedTarget = resolve(pkgDir, binRel);
                      if (existsSync(resolvedTarget)) {
                        targetBin = realpathSync(resolvedTarget);
                      }
                    }
                  } catch {}
                }
                const auth = authenticateAdlcPackage(pkgDir, targetBin, { minVersion, enforceKnownDigest: true });
                if (auth.ok) {
                  return { ok: true, binary: targetBin, version: auth.version, source: 'system-path' };
                }
              }
            }
          } catch {}
        }
      }
    } catch { /* ignore */ }
  }

  return {
    ok: false,
    error: `Project-local @adlc/cli dependency missing or unverified in ${repo} (min version >= ${minVersion}). Run npm install or agb bootstrap.`
  };
}

/**
 * Locks and write-protects an executable and its containing directory across execution
 * to eliminate TOCTOU executable replacement and tampering risks.
 */
export function preventExecutableReplacement(target) {
  let targetFd = null;
  let released = false;
  const lockedDirs = [];

  const cleanup = () => {
    if (released) return;
    released = true;
    for (const d of lockedDirs.reverse()) {
      try { chmodSync(d.path, d.origMode); } catch {}
    }
    if (targetFd !== null) {
      try { closeSync(targetFd); } catch {}
      targetFd = null;
    }
  };

  try {
    targetFd = openSync(target, 'r');
    const fdStat = fstatSync(targetFd);
    const diskStat = statSync(target);
    if (fdStat.ino !== diskStat.ino || fdStat.dev !== diskStat.dev) {
      closeSync(targetFd);
      throw new Error(`Security violation: target executable ${target} was replaced during opening`);
    }

    // Lock target file and containing directories up to node_modules to prevent rename / unlink / replacement during execution
    const pathsToLock = [target];
    let curDir = dirname(target);
    for (let depth = 0; depth < 4; depth++) {
      if (!curDir || curDir === dirname(curDir)) break;
      pathsToLock.push(curDir);
      if (basename(curDir) === 'node_modules') break;
      curDir = dirname(curDir);
    }

    for (const d of pathsToLock) {
      if (existsSync(d)) {
        const dStat = statSync(d);
        const isOwnedByUser = typeof process.getuid !== 'function' || dStat.uid === process.getuid();
        if (isOwnedByUser && (dStat.mode & 0o222) !== 0) {
          try {
            chmodSync(d, dStat.mode & ~0o222);
            lockedDirs.push({ path: d, origMode: dStat.mode, dev: dStat.dev, ino: dStat.ino });
          } catch (err) {
            if (process.platform !== 'win32') {
              throw new Error(`Security violation: failed locking ${d} to prevent executable replacement: ${err.message}`);
            }
          }
        } else {
          lockedDirs.push({ path: d, origMode: dStat.mode, dev: dStat.dev, ino: dStat.ino });
        }
      }
    }

    process.once('exit', cleanup);

    return {
      fd: targetFd,
      stat: fdStat,
      verifyUnchanged: () => {
        if (targetFd !== null) {
          const curFdStat = fstatSync(targetFd);
          const curDiskStat = statSync(target);
          if (
            curFdStat.ino !== fdStat.ino ||
            curFdStat.dev !== fdStat.dev ||
            curFdStat.size !== fdStat.size ||
            curFdStat.mtimeMs !== fdStat.mtimeMs ||
            curDiskStat.ino !== fdStat.ino ||
            curDiskStat.dev !== fdStat.dev ||
            curDiskStat.size !== fdStat.size ||
            curDiskStat.mtimeMs !== fdStat.mtimeMs
          ) {
            throw new Error(`Security violation: ADLC executable was tampered with during execution`);
          }
          for (const d of lockedDirs) {
            try {
              const curDStat = statSync(d.path);
              if (curDStat.ino !== d.ino || curDStat.dev !== d.dev) {
                throw new Error(`Security violation: ADLC executable ancestor path ${d.path} was replaced during execution`);
              }
              const isOwnedByUser = typeof process.getuid !== 'function' || curDStat.uid === process.getuid();
              if (isOwnedByUser && (curDStat.mode & 0o222) !== 0 && (d.origMode & 0o222) !== 0) {
                throw new Error(`Security violation: ADLC executable ancestor path ${d.path} was unlocked during execution`);
              }
            } catch (err) {
              if (err.message.includes('Security violation')) throw err;
              throw new Error(`Security violation: ADLC executable directory or file was tampered with during execution`);
            }
          }
        }
      },
      release: () => {
        process.removeListener('exit', cleanup);
        cleanup();
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Revalidates the ADLC executable immediately before execution to eliminate TOCTOU tamper risks.
 * Never throws: returns { ok: true, binary, version } or { ok: false, error }.
 */
export function revalidateAdlcBinary(binaryPath, {
  repo = process.cwd(),
  env = process.env,
  minVersion = MIN_ADLC_CLI_VERSION,
  allowCustom = false,
  allowSystem = false,
  lockExecutable = false,
} = {}) {
  if (!binaryPath) {
    return resolveAdlcBinary({ repo, env, minVersion, allowCustom, allowSystem });
  }

  try {
    const pathSecurity = isTemporaryOrWorldWritablePath(binaryPath);
    if (pathSecurity.restricted) {
      return { ok: false, error: `adlc binary violates path security constraints: ${pathSecurity.reason}` };
    }

    const customPath = env.ADLC_CLI_PATH || env.AGB_ADLC_BIN;
    const customAllowed = allowCustom || env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';

    let isCustom = false;
    if (customPath && customAllowed) {
      try {
        if (binaryPath === customPath || pathSecurity.realPath === realpathSync(customPath)) {
          isCustom = true;
        }
      } catch {}
    }

    const realCandidate = pathSecurity.realPath;
    if (!existsSync(realCandidate)) {
      return { ok: false, error: `adlc binary candidate ${realCandidate} does not exist` };
    }

    const lowerCandidate = realCandidate.toLowerCase();
    const isShim =
      lowerCandidate.endsWith('.cmd') ||
      lowerCandidate.endsWith('.ps1') ||
      basename(dirname(realCandidate)) === '.bin';

    let pkgDir = null;
    let targetToAuth = realCandidate;

    if (isShim) {
      const candidateDirs = [
        join(dirname(realCandidate), '..', '@adlc', 'cli'),
        join(dirname(realCandidate), '..', 'node_modules', '@adlc', 'cli'),
        join(repo, 'node_modules', '@adlc', 'cli'),
      ];
      for (const d of candidateDirs) {
        if (existsSync(join(d, 'package.json'))) {
          try {
            const manifest = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
            if (manifest.name === '@adlc/cli') {
              pkgDir = d;
              break;
            }
          } catch {}
        }
      }

      if (pkgDir) {
        try {
          const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
          const binRel =
            typeof manifest.bin === 'string'
              ? manifest.bin
              : typeof manifest.bin === 'object' && manifest.bin !== null
              ? manifest.bin.adlc
              : null;
          if (binRel) {
            const resolvedTarget = resolve(pkgDir, binRel);
            if (existsSync(resolvedTarget)) {
              targetToAuth = realpathSync(resolvedTarget);
            }
          }
        } catch {}
      }
    }

    if (!pkgDir) {
      // Find the enclosing package directory containing package.json for @adlc/cli
      let curDir = dirname(realCandidate);
      for (let depth = 0; depth < 4; depth++) {
        const candidatePkgJson = join(curDir, 'package.json');
        if (existsSync(candidatePkgJson)) {
          try {
            const manifest = JSON.parse(readFileSync(candidatePkgJson, 'utf8'));
            if (manifest.name === '@adlc/cli') {
              pkgDir = curDir;
              break;
            }
          } catch {}
        }
        const parent = dirname(curDir);
        if (parent === curDir) break;
        curDir = parent;
      }
    }

    if (!pkgDir) {
      // Check if candidate is custom fixture or directory
      const checkDir = dirname(realCandidate);
      if (existsSync(join(checkDir, 'package.json'))) {
        pkgDir = checkDir;
      } else if (existsSync(join(checkDir, '..', 'package.json'))) {
        pkgDir = join(checkDir, '..');
      }
    }

    if (!pkgDir) {
      return { ok: false, error: `cannot locate valid package directory for adlc binary at ${realCandidate}` };
    }

    let seal = null;
    if (lockExecutable) {
      seal = preventExecutableReplacement(targetToAuth);
    }

    const auth = authenticateAdlcPackage(pkgDir, targetToAuth, {
      minVersion,
      enforceKnownDigest: !isCustom,
    });

    if (!auth.ok) {
      seal?.release();
      return { ok: false, error: `ADLC executable failed revalidation before spawn: ${auth.error}` };
    }

    return { ok: true, binary: realCandidate, target: targetToAuth, version: auth.version, seal };
  } catch (err) {
    return { ok: false, error: `ADLC executable revalidation failed: ${err.message}` };
  }
}

/**
 * Resolves the underlying execution command without invoking cmd.exe shell concatenation.
 */
export function resolveExecutionCommand(verified, args = []) {
  const target = verified.target || verified.binary;
  const isJs = target.endsWith('.js') || target.endsWith('.mjs') || target.endsWith('.cjs');
  let isNodeScript = isJs;
  if (!isNodeScript && existsSync(target)) {
    try {
      const fd = openSync(target, 'r');
      const buf = Buffer.alloc(128);
      const bytesRead = readSync(fd, buf, 0, 128, 0);
      closeSync(fd);
      const header = buf.toString('utf8', 0, bytesRead);
      if (header.startsWith('#!') && header.includes('node')) {
        isNodeScript = true;
      }
    } catch {}
  }

  if (isNodeScript) {
    return {
      command: process.execPath,
      args: [target, ...args],
      options: { shell: false },
    };
  }

  const isWin = process.platform === 'win32';
  const isBatch = isWin && (target.toLowerCase().endsWith('.cmd') || target.toLowerCase().endsWith('.bat'));
  if (isBatch) {
    for (const arg of args) {
      if (/[\r\n\0]/.test(String(arg))) {
        throw new Error(`Security violation: command argument contains control characters: ${JSON.stringify(arg)}`);
      }
    }
    const comSpec = process.env.ComSpec || 'cmd.exe';
    const escapedArgs = args.map((a) => {
      const str = String(a);
      return `"${str.replace(/"/g, '""')}"`;
    });
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', `"${target}"`, ...escapedArgs],
      options: { shell: false },
    };
  }

  return {
    command: target,
    args,
    options: { shell: false },
  };
}

/**
 * Spawns an ADLC command with mandatory revalidation right before process creation.
 */
export function spawnAuthenticatedAdlc(binaryPath, args = [], options = {}, {
  repo = process.cwd(),
  env = process.env,
  minVersion = MIN_ADLC_CLI_VERSION,
  allowCustom = false,
  allowSystem = false,
} = {}) {
  const verified = revalidateAdlcBinary(binaryPath, { repo, env, minVersion, allowCustom, allowSystem, lockExecutable: true });
  if (!verified.ok) {
    throw new Error(`Authenticated ADLC binary verification failed: ${verified.error}`);
  }
  try {
    verified.seal?.verifyUnchanged();
    const cmd = resolveExecutionCommand(verified, args);
    verified.seal?.verifyUnchanged();
    const child = spawn(cmd.command, cmd.args, { ...options, ...cmd.options });
    const releaseOnce = () => {
      if (verified.seal) {
        try { verified.seal.verifyUnchanged(); } catch {}
        verified.seal.release();
        verified.seal = null;
      }
    };
    child.once('error', releaseOnce);
    child.once('close', releaseOnce);
    return child;
  } catch (err) {
    verified.seal?.release();
    throw err;
  }
}

/**
 * Executes an ADLC command synchronously with mandatory revalidation right before process creation.
 */
export function execAuthenticatedAdlc(binaryPath, args = [], options = {}, {
  repo = process.cwd(),
  env = process.env,
  minVersion = MIN_ADLC_CLI_VERSION,
  allowCustom = false,
  allowSystem = false,
} = {}) {
  const verified = revalidateAdlcBinary(binaryPath, { repo, env, minVersion, allowCustom, allowSystem, lockExecutable: true });
  if (!verified.ok) {
    throw new Error(`Authenticated ADLC binary verification failed: ${verified.error}`);
  }
  try {
    verified.seal?.verifyUnchanged();
    const cmd = resolveExecutionCommand(verified, args);
    verified.seal?.verifyUnchanged();
    const result = execFileSync(cmd.command, cmd.args, { ...options, ...cmd.options });
    verified.seal?.verifyUnchanged();
    return result;
  } finally {
    verified.seal?.release();
  }
}

/**
 * Executes an ADLC command asynchronously with mandatory revalidation right before process creation.
 */
export function execFileAuthenticatedAdlc(binaryPath, args = [], options = {}, {
  repo = process.cwd(),
  env = process.env,
  minVersion = MIN_ADLC_CLI_VERSION,
  allowCustom = false,
  allowSystem = false,
} = {}) {
  const verified = revalidateAdlcBinary(binaryPath, { repo, env, minVersion, allowCustom, allowSystem, lockExecutable: true });
  if (!verified.ok) {
    const err = new Error(`Authenticated ADLC binary verification failed: ${verified.error}`);
    err.code = 'EAUTH';
    return Promise.reject(err);
  }
  let cmd;
  try {
    verified.seal?.verifyUnchanged();
    cmd = resolveExecutionCommand(verified, args);
    verified.seal?.verifyUnchanged();
  } catch (err) {
    verified.seal?.release();
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    execFile(cmd.command, cmd.args, { ...options, ...cmd.options }, (error, stdout, stderr) => {
      try {
        verified.seal?.verifyUnchanged();
      } catch (sealErr) {
        try { verified.seal?.release(); } catch {}
        return reject(sealErr);
      }
      try { verified.seal?.release(); } catch {}
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}


