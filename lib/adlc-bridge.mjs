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

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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
  const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ?? null,
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
            ? manifest.bin.adlc || Object.values(manifest.bin)[0]
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
  const isFixture = Boolean(
    customPath &&
    (customPath.endsWith('fixtures/fake-adlc') || customPath.endsWith('test/fixtures/fake-adlc'))
  );
  const customAllowed = allowCustom || env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1' || isFixture;
  if (customPath && customAllowed) {
    try {
      const realCustom = realpathSync(customPath);
      if (!isFixture && (realCustom.startsWith('/tmp') || realCustom.startsWith('/var/tmp'))) {
        return { ok: false, error: `custom adlc binary resides in temporary directory: ${realCustom}` };
      }
      let parentPkg = dirname(realCustom);
      if (!existsSync(join(parentPkg, 'package.json'))) {
        parentPkg = join(parentPkg, '..');
      }
      const auth = authenticateAdlcPackage(parentPkg, realCustom, { minVersion, enforceKnownDigest: !isFixture });
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
    if (existsSync(localPkgDir) && existsSync(localBin)) {
      const auth = authenticateAdlcPackage(localPkgDir, localBin, { minVersion, enforceKnownDigest: true });
      if (auth.ok) {
        return { ok: true, binary: localBin, version: auth.version, source: 'project-local' };
      }
      return { ok: false, error: auth.error };
    }
    const parent = dirname(curDir);
    if (parent === curDir) break;
    curDir = parent;
  }

  // 3. System PATH fallback
  const systemAllowed = allowSystem || env.AGB_ALLOW_SYSTEM_ADLC === '1';
  if (systemAllowed) {
    try {
      const whichRes = spawnSync('which', ['adlc'], { encoding: 'utf8' });
      if (whichRes.status === 0 && whichRes.stdout.trim()) {
        const sysBin = whichRes.stdout.trim();
        const realSys = realpathSync(sysBin);
        if (realSys.startsWith('/tmp') || realSys.startsWith('/var/tmp')) {
          return { ok: false, error: `system adlc resides in temporary directory: ${realSys}` };
        }
        const parentPkg = join(dirname(realSys), '..');
        const auth = authenticateAdlcPackage(parentPkg, realSys, { minVersion, enforceKnownDigest: true });
        if (auth.ok) {
          return { ok: true, binary: realSys, version: auth.version, source: 'system-path' };
        }
      }
    } catch { /* ignore */ }
  }

  return {
    ok: false,
    error: `Project-local @adlc/cli dependency missing or unverified in ${repo} (min version >= ${minVersion}). Run npm install or agb bootstrap.`
  };
}

