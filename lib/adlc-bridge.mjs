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

import { computeDirectoryDigest } from './digest.mjs';
import { resolvePluginRoot } from './plugin-paths.mjs';
import { parse as parseStrictSemver } from './semver.mjs'; // spec A.4 item 17: MAJOR.MINOR.PATCH[-pre] only
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, lstatSync, realpathSync, openSync, readSync, closeSync, statSync, fstatSync, chmodSync, copyFileSync, cpSync, symlinkSync, mkdtempSync, constants } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync, spawn, execFileSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';

// Static import so esbuild inlines @adlc/tickets into the plugin bundles
// (spec §4.1): the staged plugin has no node_modules at runtime.
import * as ticketsApi from '@adlc/tickets';

function ticketsLib() {
  return ticketsApi;
}

/**
 * Plugin contract classification enum (spec §4.4). readPluginContract()
 * returns exactly these statuses.
 *   compatible   adlcContract === SUPPORTED_PLUGIN_CONTRACT
 *   tolerant     manifest valid, adlcContract absent
 *   incompatible adlcContract present and !== SUPPORTED_PLUGIN_CONTRACT
 *   unreadable   plugin.json absent
 *   corrupt      invalid JSON or missing semver version
 */
export const PLUGIN_CONTRACT_STATUSES = Object.freeze(['compatible', 'tolerant', 'incompatible', 'unreadable', 'corrupt']);

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
export function pluginManifestDir({ env = process.env, bundled = IS_BUNDLED } = {}) {
  // Spec §4.2 / Decision 2: the bundled plugin ignores AGB_PLUGIN_DIR (no .envrc spoofing).
  const override = bundled ? undefined : env.AGB_PLUGIN_DIR;
  return override ?? join(homedir(), '.gemini', 'config', 'plugins', 'adlc-antigravity');
}

/**
 * Read the installed adlc-antigravity plugin manifest and classify it into the
 * spec §4.4 flat enum (PLUGIN_CONTRACT_STATUSES). Pure + total: NEVER throws.
 *   { status: 'unreadable', error }       plugin.json absent or unreadable
 *   { status: 'corrupt', error }          invalid JSON, not an object, or no
 *                                         semver `version`
 *   { status: 'tolerant', version }       valid manifest without adlcContract
 *   { status: 'compatible', contract, version }   adlcContract === supported
 *   { status: 'incompatible', contract, version } any other adlcContract value
 *                                         (callers abort loudly: version skew)
 *
 * `dir` overrides the base dir (bootstrap passes the plugin it just installed);
 * default resolves via pluginManifestDir().
 */
export function readPluginContract({ dir } = {}) {
  const path = join(dir ?? pluginManifestDir(), 'plugin.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { status: 'unreadable', error: `plugin manifest at ${path}: ${err.code ?? err.message}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    return { status: 'corrupt', error: `plugin manifest at ${path} is not valid JSON: ${err.message}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'corrupt', error: `plugin manifest at ${path} is not a JSON object` };
  }
  const version = manifest.version;
  if (typeof version !== 'string' || parseStrictSemver(version) === null) {
    return { status: 'corrupt', error: `plugin manifest at ${path} has no semver version` };
  }
  if (!Object.hasOwn(manifest, 'adlcContract')) return { status: 'tolerant', version };
  const contract = manifest.adlcContract;
  if (contract === SUPPORTED_PLUGIN_CONTRACT) return { status: 'compatible', contract, version };
  return { status: 'incompatible', contract, version };
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
  const manifestPath = join(storeDir, '.store.json');
  if (backend === 'none') {
    if (existsSync(storeDir)) {
      // Orphaned store dir — created but the manifest never landed (e.g. an
      // interrupted first projection). initializeDirectoryStore would throw
      // STORE_EXISTS forever; the projection owns the store, so recover by
      // writing the manifest into the existing dir.
      try {
        if (!lstatSync(manifestPath).isFile()) rmSync(manifestPath, { force: true });
      } catch { /* absent — nothing to unlink */ }
      const fd = openSync(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o644);
      try {
        writeFileSync(fd, prettyCanonicalJson(ACTIVE_MANIFEST));
      } finally {
        closeSync(fd);
      }
    } else {
      initializeDirectoryStore(storeDir);
    }
  } else {
    // When backend already exists, verify that .store.json is a real regular file,
    // not a symlink planted by an adversary.
    try {
      if (existsSync(manifestPath) && (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile())) {
        rmSync(manifestPath, { force: true });
        const fd = openSync(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o644);
        try {
          writeFileSync(fd, prettyCanonicalJson(ACTIVE_MANIFEST));
        } finally {
          closeSync(fd);
        }
      }
    } catch { /* absent — nothing to unlink */ }
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

/**
 * Bundled-mode switch (spec §4.2). esbuild defines __AGB_BUNDLED__=true for the
 * plugin bundles; unbundled source runs see `typeof … === 'undefined'`.
 */
export const IS_BUNDLED = typeof __AGB_BUNDLED__ !== 'undefined' && __AGB_BUNDLED__ === true;

/**
 * Pinned digests of the committed booster-owned vendored adlc (Appendix A D12,
 * A.6 item 13). Regenerate with `node scripts/update-adlc-digests.mjs --write`
 * after `npm run vendor:bundle`; a mismatch fails closed.
 */
export const KNOWN_VENDORED_ADLC = Object.freeze({
  version: '1.11.1',
  binarySha256: '3a4a8883bae7bbe624d021e9b544c32f99a5803b1451ef17b2e57eb81c3413f6',
  vendoredBundleSha256: '95e1452ad9030dbc33471da1e2192c29dd3a030bd36e278fd2b4d6a43b9ea647',
  treeDigest: '894a4646e557e5bdfb4b252affe126b5486c23061c7471dbb90811730032ec2b',
});

/**
 * lib/digest.mjs tree digest of the extracted vendored @adlc/antigravity
 * tarball, i.e. of a pristine staged plugin directory (Appendix A.4 item 15).
 * T-PLUGIN-03's doctor/bootstrap decision table compares against this; T3
 * freezes this file, so it is recorded here.
 */
export const STAGED_ADLC_ANTIGRAVITY_TREE_DIGESTS = Object.freeze({
  '1.7.0': 'c9bad8ac16bf47cdc7001645ed6d4ffb77997e91063fe983084d151e3f840754',
});

export const KNOWN_ADLC_DIGESTS = {
  '1.11.1': {
    integrity: 'sha512-2J6dID3l/UHYdEh3njbwAGuiBOP2NEOkMNUHIPWo1nb85SKrAlZxNESMkIH4M93WsoT54jFbcbDeRZdMIo9lBw==',
    treeDigest: '1383387afe5c5062b7e1e81c360a0fc6cb876513153665feca731b8de77c2172',
    binarySha256: 'b38de003d6fdbfd139229ed0a70a85c719bac6a5d4885fbcfffe15e96fa84d21',
  },
};

export const KNOWN_ADLC_DEPENDENCY_DIGESTS = {
  '@adlc/antigravity': {
    '1.7.0': '0932ef0035de0a623d16881bd87fcc615ac821f697b38f446e2242bbfac65a4a',
  },
  '@adlc/behavior-diff': {
    '1.11.1': '73f7475922ce7ab6452db86c370cee791c5476538a828f338a388f6cc218c84f',
  },
  '@adlc/build-gate': {
    '1.11.1': '732f5307050bcd772468a65a00549ebfad827a791c217f0e696640064b5eb530',
  },
  '@adlc/coldstart': {
    '1.11.1': '7af362b8f0fc5ff351ea7b81eccb9a048b4c5597198f061b01885fbdcc26b606',
  },
  '@adlc/consensus-fix': {
    '1.11.1': '96b61e5128a06b44f09c12d18883de7135ebcb05f5eb3c0eed04474cca6644ac',
  },
  '@adlc/context-handoff': {
    '1.11.1': '2cc487c1fa752d1611fa880ecf4d4ec7e44da6c66f93a7223ddf9c4c0b05cfcf',
  },
  '@adlc/core': {
    '1.11.1': 'c1873f2e855b3965d89f396701f3051f5f9b11be367c035e23e5662e0d355635',
  },
  '@adlc/flail-detector': {
    '1.11.1': '2c38cc1f9b8b5868a05b0e9eacd32367b3aa3c618d216041ab677612bd1f4f59',
  },
  '@adlc/fleet': {
    '1.11.1': '851e37365933c548480883b694709b01c94f2d32ba8c766812b3435f91289f77',
  },
  '@adlc/gate-fuzzing': {
    '1.11.1': 'cd7ef56d03321d596128814e272967a5447f8660a9aa483c9442714e46ea54ec',
  },
  '@adlc/gate-manifest': {
    '1.11.1': 'e0ad7b849859a053ad642e5e0dd1d970724387b03f3ff600f6cd88ec1c41dcef',
  },
  '@adlc/hollow-test': {
    '1.11.1': 'da8e10a808cd9a08ee5cb46673c176658a52ad240638ad6e12b30cd3f66c6088',
  },
  '@adlc/init': {
    '1.11.1': 'c391d335ed62315ba8207d9dcec4bb35f45139111153ca3375ece5efec82310c',
  },
  '@adlc/lesson-foundry': {
    '1.11.1': 'c3620c635af4d0ff191e911e774fab810e9b2f4c992aba36159b511e1b83e20a',
  },
  '@adlc/merge-forecast': {
    '1.11.1': '87071ab6b21f224537f5d1c08299ede988810a2aee0b300b7b24473d22f8e25e',
  },
  '@adlc/model-ratchet': {
    '1.11.1': '835f498e503144fcaca24ed7312b586e83e3d592b9795c9e28d6344c0cd64d65',
  },
  '@adlc/model-router': {
    '1.11.1': '17c21f5bf11ec6a31358a240e8b9ac0244a129263df53337c0edcd1ba2de70f0',
  },
  '@adlc/parallax': {
    '1.11.1': 'c73b29056b478d2832a8cb553ad2b3889aebbe1a2ae1afe8d5b79414c42bb0e3',
  },
  '@adlc/preflight': {
    '1.11.1': '6e2718eee42bafe66d56529df0cf7e8e3324e7c12392d22ca3d3447fd29a6085',
  },
  '@adlc/premortem': {
    '1.11.1': '28a8a5ee73a8493b0ca4007975ea5f26d53c5a3d1fcee0591576300f18d2312f',
  },
  '@adlc/prosecute': {
    '1.11.1': '1f39ddd9f8efdb9f7ce884961ffe3e90d5cd4293460837cce43884ef1fad55ee',
  },
  '@adlc/quartermaster': {
    '1.11.1': '856c6c029daed77443c09b52457915a1baffa6b45e268bf348f599a0e531e957',
  },
  '@adlc/rails-guard': {
    '1.11.1': 'a2c6c42150289feff803525f97ee0b006f22278fa99ed44b7c445dd0c57eef51',
  },
  '@adlc/rejection-mining': {
    '1.11.1': '503bc987eacb92da9f7f840ae8edf6500083833b2562c0d16d0378688883bf90',
  },
  '@adlc/review-calibration': {
    '1.11.1': 'fa3d0ea946649427e70284b71227d45654004e1f40b7413e789aee92709c892a',
  },
  '@adlc/runner': {
    '1.11.1': '7b9585bba12474e6d88812801683752cd4d9706312c5c6f726b10eb779bd7a7f',
  },
  '@adlc/skill-rot': {
    '1.11.1': '67f5a4791e4d7aaec8e86ed5456273eb521bee5aa361adf8bbcdbb4c016e487e',
  },
  '@adlc/spec-lint': {
    '1.11.1': '8fac8c6064fcdfa50d5931e0222d1d6bb8c29693cde6696e6ba8888b3ba9a86d',
  },
  '@adlc/ticket-prune': {
    '1.11.1': '5bc2ad316ff9fcd9f2ee725b874e1b8c38f7d78ef6f6e489cb6dc059a408d5d7',
  },
  '@adlc/ticket-sync': {
    '1.11.1': '35b41991a07ff4ee5b084211500757040be2d876174ec7e1897f777d3d772a6a',
  },
  '@adlc/tickets': {
    '1.11.1': '4e428a461d068834e68ec84033722fe5dcdea5044341f931642ac491882fadae',
  },
};

/**
 * Computes a deterministic package tree digest, enforcing the anti-symlink policy.
 */
export function computePackageTreeDigest(dir) {
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
  scanDir(dir);
  treeFiles.sort();
  return crypto.createHash('sha256').update(treeFiles.join('\n')).digest('hex');
}

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
    let treeDigest;
    try {
      treeDigest = computePackageTreeDigest(realPkgDir);
    } catch (err) {
      return { ok: false, error: `package tree scan failed: ${err.message}` };
    }
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
function sha256File(path) {
  return crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Tier 1: the committed vendored adlc under <pluginRoot>/vendor/adlc.
 *   null                                   vendor/adlc absent
 *   { ok: true, binary, version, source }  every pinned digest matches
 *   { ok: false, error: 'vendored-adlc-tampered' }  anything else — never
 *                                          falls through to another tier
 */
export function resolveVendoredAdlc(pluginRoot) {
  const vendorDir = join(pluginRoot, 'vendor', 'adlc');
  if (!existsSync(vendorDir)) return null;
  const tampered = { ok: false, error: 'vendored-adlc-tampered' };
  try {
    const binary = join(vendorDir, 'bin', 'adlc.mjs');
    const bundle = join(vendorDir, 'dist', 'adlc.bundle.mjs');
    const manifest = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8'));
    if (manifest.version !== KNOWN_VENDORED_ADLC.version) return tampered;
    if (sha256File(binary) !== KNOWN_VENDORED_ADLC.binarySha256) return tampered;
    if (sha256File(bundle) !== KNOWN_VENDORED_ADLC.vendoredBundleSha256) return tampered;
    if (computeDirectoryDigest(vendorDir) !== KNOWN_VENDORED_ADLC.treeDigest) return tampered;
    return { ok: true, binary, version: manifest.version, source: 'vendored' };
  } catch {
    return tampered;
  }
}

/**
 * Plugin root holding vendor/adlc. Unbundled runs may point it elsewhere with
 * AGB_PLUGIN_ROOT (tests use a vendor-less fixture to reach the legacy tiers,
 * Appendix A.6 item 12); the bundled plugin ignores the override.
 */
function defaultPluginRoot(env, bundled) {
  const override = bundled ? undefined : env?.AGB_PLUGIN_ROOT ?? process.env.AGB_PLUGIN_ROOT;
  if (override) return override;
  try {
    return resolvePluginRoot();
  } catch {
    return null;
  }
}

/**
 * Authenticated resolution of the `adlc` executable (spec §4.2).
 *
 * Bundled plugin (`IS_BUNDLED`): Tier 1 ONLY — the pinned vendored adlc.
 * Every override env var is ignored; absent or tampered → { ok: false }.
 *
 * Unbundled source runs: an explicitly double-opted-in custom override
 * (ADLC_CLI_PATH/AGB_ADLC_BIN + AGB_ALLOW_CUSTOM_ADLC_CLI=1) is honoured first
 * — a developer/test-only path the bundle can never take — then Tier 1 if
 * vendor/adlc exists (tampering still fails closed, no fallthrough), then the
 * legacy project-local and system tiers below.
 *
 * Never throws: returns { ok: true, binary, version, source } or { ok: false, error }.
 */
export function resolveAdlcBinary({
  repo = process.cwd(),
  env = process.env,
  allowSystem = false,
  allowCustom = false,
  minVersion = MIN_ADLC_CLI_VERSION,
  bundled = IS_BUNDLED,
  pluginRoot = defaultPluginRoot(env, bundled),
} = {}) {
  if (bundled) {
    if (!pluginRoot) return { ok: false, error: 'vendored adlc missing: booster plugin root not found' };
    return resolveVendoredAdlc(pluginRoot) ?? { ok: false, error: `vendored adlc missing under ${pluginRoot}/vendor/adlc` };
  }
  const devCustom = (env.ADLC_CLI_PATH || env.AGB_ADLC_BIN) && (allowCustom || env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1');
  if (!devCustom && pluginRoot) {
    const vendored = resolveVendoredAdlc(pluginRoot);
    if (vendored) return vendored;
  }
  recoverStaleExecutableLocks();
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

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function getProcessStartTime(pid) {
  if (!pid || typeof pid !== 'number') return null;
  try {
    if (process.platform === 'linux') {
      const content = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = content.lastIndexOf(')');
      if (closeParen !== -1) {
        const rest = content.slice(closeParen + 2).trim().split(/\s+/);
        return rest[19] ?? null;
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || null;
    } else if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || null;
    }
  } catch {}
  return null;
}

function safeRemoveTree(dir) {
  if (!dir || !existsSync(dir)) return;
  try {
    const makeWritable = (p) => {
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) {
          try { chmodSync(p, 0o700); } catch {}
          for (const sub of readdirSync(p)) makeWritable(join(p, sub));
        } else {
          try { chmodSync(p, 0o600); } catch {}
        }
      } catch {}
    };
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeTreeReadOnly(dir) {
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        makeTreeReadOnly(p);
        try { chmodSync(p, 0o500); } catch {}
      } else {
        try { chmodSync(p, 0o500); } catch {}
      }
    }
  } catch {}
}

/**
 * Resolve approved base directory for immutable pinned executable copies.
 * Staged outside restricted temporary directories to avoid noexec execution failures.
 */
export function getApprovedPinnedBase() {
  if (process.env.AGB_EXEC_CACHE_DIR) {
    try {
      mkdirSync(process.env.AGB_EXEC_CACHE_DIR, { recursive: true, mode: 0o700 });
      return process.env.AGB_EXEC_CACHE_DIR;
    } catch {}
  }
  const home = process.env.AGB_HOME_DIR || homedir();
  const dir = join(home, '.adlc', 'pinned');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return tmpdir();
  }
}

/**
 * Resolve approved directory for executable pin and permission locks.
 */
export function getApprovedLocksDir() {
  if (process.env.AGB_EXEC_LOCKS_DIR) {
    return process.env.AGB_EXEC_LOCKS_DIR;
  }
  const home = process.env.AGB_HOME_DIR || homedir();
  const dir = join(home, '.adlc', 'locks');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return join(tmpdir(), 'agb_adlc_locks');
  }
}

/**
 * Recovers stale executable locks left by crashes or ungraceful terminations (e.g. SIGKILL).
 * Inspects recorded lock files under AGB_EXEC_LOCKS_DIR; if the recording PID is dead,
 * restores original permissions on all locked paths and unlinks the record.
 * Also cleans up any stale pinned execution directories in tmpdir.
 */
export function recoverStaleExecutableLocks(locksDir = getApprovedLocksDir()) {
  let recoveredCount = 0;
  const activePinnedDirs = new Set();
  if (existsSync(locksDir)) {
    try {
      for (const entry of readdirSync(locksDir)) {
        if (!entry.endsWith('.json')) continue;
        const recordPath = join(locksDir, entry);
        try {
          const raw = readFileSync(recordPath, 'utf8');
          const data = JSON.parse(raw);
          const pid = typeof data?.pid === 'number' ? data.pid : 0;
          const ownerAlive = pid > 0 && isPidAlive(pid) && (
            !data.startTime || data.startTime === getProcessStartTime(pid)
          );

          if (entry.startsWith('pin_')) {
            if (ownerAlive) {
              if (data?.pinnedDir) activePinnedDirs.add(data.pinnedDir);
            } else {
              if (data?.pinnedDir) safeRemoveTree(data.pinnedDir);
              try { rmSync(recordPath, { force: true }); } catch {}
              recoveredCount++;
            }
            continue;
          }

          const stale = !ownerAlive || (Date.now() - (data.ts || 0) > 300000);
          if (stale) {
            if (Array.isArray(data.paths)) {
              for (const p of data.paths) {
                try {
                  if (p?.path && existsSync(p.path)) {
                    const st = statSync(p.path);
                    const isOwnedByUser = typeof process.getuid !== 'function' || st.uid === process.getuid();
                    if (isOwnedByUser && typeof p.origMode === 'number') {
                      chmodSync(p.path, p.origMode);
                    }
                  }
                } catch {}
              }
            }
            try { rmSync(recordPath, { force: true }); } catch {}
            recoveredCount++;
          }
        } catch {}
      }
    } catch {}
  }

  // Prune any stale agb-pinned-* directories in approved cache and tmpdir that are NOT held by an active live process
  try {
    const scanBases = new Set([getApprovedPinnedBase(), tmpdir()]);
    const now = Date.now();
    for (const base of scanBases) {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        if (entry.startsWith('agb-pinned-')) {
          const p = join(base, entry);
          if (activePinnedDirs.has(p)) continue;
          try {
            const st = statSync(p);
            if (now - st.mtimeMs > 600000) {
              safeRemoveTree(p);
              recoveredCount++;
            }
          } catch {}
        }
      }
    }
  } catch {}
  return recoveredCount;
}

/**
 * Pins an authenticated executable into an immutable, private execution environment.
 * For Node packages, copies the full dependency closure so that no mutable code
 * can be swapped or tampered with before or during process creation.
 */
export function pinExecutable(target, pkgDir, opts = {}) {
  try {
    let isInsidePkg = false;
    if (pkgDir && existsSync(pkgDir)) {
      const relPath = relative(pkgDir, target);
      isInsidePkg = !relPath.startsWith('..') && !isAbsolute(relPath);
    }
    if (pkgDir && existsSync(pkgDir) && isInsidePkg) {
      const pinnedDir = mkdtempSync(join(getApprovedPinnedBase(), 'agb-pinned-adlc-'));
      const pinnedNm = join(pinnedDir, 'node_modules');
      const parentDir = dirname(pkgDir);
      let realNm = null;
      let isScoped = false;
      if (basename(parentDir).startsWith('@') && basename(dirname(parentDir)) === 'node_modules') {
        isScoped = true;
        realNm = dirname(parentDir);
      } else if (basename(parentDir) === 'node_modules') {
        realNm = parentDir;
      }
      const pinnedPkg = isScoped
        ? join(pinnedNm, basename(parentDir), basename(pkgDir))
        : join(pinnedNm, basename(pkgDir));

      mkdirSync(dirname(pinnedPkg), { recursive: true });
      cpSync(pkgDir, pinnedPkg, { recursive: true, dereference: true });

      // Copy the entire sibling dependency closure so no mutable code is referenced
      if (realNm && existsSync(realNm)) {
        try {
          for (const entry of readdirSync(realNm)) {
            if (entry.startsWith('.')) continue;
            const src = join(realNm, entry);
            const dst = join(pinnedNm, entry);
            if (entry.startsWith('@')) {
              mkdirSync(dst, { recursive: true });
              for (const sub of readdirSync(src)) {
                if (sub.startsWith('.')) continue;
                const subSrc = join(src, sub);
                const subDst = join(dst, sub);
                if (!existsSync(subDst)) {
                  try { cpSync(subSrc, subDst, { recursive: true, dereference: true }); } catch {}
                }
              }
            } else if (!existsSync(dst)) {
              try {
                cpSync(src, dst, { recursive: true, dereference: true });
              } catch {}
            }
          }
        } catch {}
      }

      // Verify anti-symlink policy across the entire pinned tree: reject symlinks
      const assertNoSymlinksInTree = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, ent.name);
          if (ent.isSymbolicLink()) {
            throw new Error(`Security violation: symbolic link rejected in pinned tree: ${full}`);
          }
          if (ent.isDirectory()) {
            assertNoSymlinksInTree(full);
          }
        }
      };
      assertNoSymlinksInTree(pinnedDir);

      // Authenticate every copied dependency in the pinned tree
      if (realNm) {
        const { lockfilePath = null, enforceKnownDigest = false, minVersion = MIN_ADLC_CLI_VERSION } = opts;
        let lockContent = null;
        if (lockfilePath && existsSync(lockfilePath)) {
          try {
            lockContent = JSON.parse(readFileSync(lockfilePath, 'utf8'));
          } catch {}
        }

        const canonicalPinnedPkg = realpathSync(pinnedPkg);
        let declaredDeps = {};
        try {
          const cliManifestPath = join(pinnedPkg, 'package.json');
          if (existsSync(cliManifestPath)) {
            const parsedCliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'));
            declaredDeps = parsedCliManifest.dependencies || {};
          }
        } catch {}

        const checkPackage = (depDir, pkgName) => {
          let realDepDir;
          try { realDepDir = realpathSync(depDir); } catch { realDepDir = depDir; }
          if (realDepDir === canonicalPinnedPkg) return;

          const st = lstatSync(realDepDir);
          if (st.isSymbolicLink() || !st.isDirectory()) {
            throw new Error(`Security violation: copied dependency ${pkgName} is a symlink or not a directory`);
          }

          const manifestPath = join(realDepDir, 'package.json');
          if (!existsSync(manifestPath)) {
            throw new Error(`Security violation: copied dependency ${pkgName} missing package.json`);
          }

          let manifest;
          try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
          } catch (err) {
            throw new Error(`Security violation: copied dependency ${pkgName} has invalid package.json: ${err.message}`);
          }

          if (!manifest.name || !manifest.version) {
            throw new Error(`Security violation: copied dependency ${pkgName} missing name or version in manifest`);
          }

          if (manifest.name === '@adlc/cli' && !semverGte(manifest.version, minVersion)) {
            throw new Error(`Security violation: copied @adlc dependency ${manifest.name} version ${manifest.version} does not meet floor >= ${minVersion}`);
          }
          if (manifest.name.startsWith('@adlc/') && manifest.name !== '@adlc/antigravity' && !semverGte(manifest.version, minVersion)) {
            throw new Error(`Security violation: copied @adlc dependency ${manifest.name} version ${manifest.version} does not meet floor >= ${minVersion}`);
          }
          if (manifest.name === '@adlc/antigravity' && !semverGte(manifest.version, '1.4.0')) {
            throw new Error(`Security violation: copied @adlc dependency ${manifest.name} version ${manifest.version} does not meet floor >= 1.4.0`);
          }
          if (declaredDeps[manifest.name]) {
            const reqVersion = String(declaredDeps[manifest.name]).replace(/^[^\d]*/, '');
            if (!semverGte(manifest.version, reqVersion)) {
              throw new Error(`Security violation: copied dependency ${manifest.name} version ${manifest.version} does not meet declared dependency floor >= ${reqVersion}`);
            }
          }

          // Verify lockfile entry if lockfile is present
          if (lockContent) {
            const lockKey = `node_modules/${manifest.name}`;
            const lockEntry =
              (lockContent.packages && lockContent.packages[lockKey]) ||
              (lockContent.dependencies && lockContent.dependencies[manifest.name]);
            if (lockEntry) {
              if (lockEntry.version && lockEntry.version !== manifest.version) {
                throw new Error(`Security violation: copied dependency ${manifest.name} version mismatch against lockfile: ${manifest.version} !== ${lockEntry.version}`);
              }
              if (enforceKnownDigest && !lockEntry.integrity) {
                throw new Error(`Security violation: copied dependency ${manifest.name} missing integrity in lockfile`);
              }
            } else if (enforceKnownDigest) {
              throw new Error(`Security violation: copied dependency ${manifest.name} is not tracked in lockfile`);
            }
          }

          // Verify transitive dependency package tree bytes against trusted digests before pinning
          let depTreeDigest;
          try {
            depTreeDigest = computePackageTreeDigest(realDepDir);
          } catch (err) {
            throw new Error(`Security violation: dependency package tree scan failed for ${pkgName}: ${err.message}`);
          }

          const targetDepDigest =
            opts.expectedDependencyTreeDigests?.[manifest.name] ??
            (enforceKnownDigest ? KNOWN_ADLC_DEPENDENCY_DIGESTS[manifest.name]?.[manifest.version] : null);

          if (enforceKnownDigest && manifest.name.startsWith('@adlc/') && !targetDepDigest) {
            throw new Error(`Security violation: cannot verify dependency package tree: no trusted digest recorded in KNOWN_ADLC_DEPENDENCY_DIGESTS for ${manifest.name} version ${manifest.version}`);
          }
          if (targetDepDigest && depTreeDigest !== targetDepDigest) {
            throw new Error(`Security violation: package tree digest mismatch for dependency ${manifest.name}: expected ${targetDepDigest} but got ${depTreeDigest}`);
          }
        };

        if (existsSync(pinnedNm)) {
          for (const entry of readdirSync(pinnedNm)) {
            if (entry.startsWith('.')) continue;
            const entryPath = join(pinnedNm, entry);
            if (entry.startsWith('@')) {
              for (const sub of readdirSync(entryPath)) {
                if (sub.startsWith('.')) continue;
                checkPackage(join(entryPath, sub), `${entry}/${sub}`);
              }
            } else {
              checkPackage(entryPath, entry);
            }
          }
        }
      }

      const relPath = relative(pkgDir, target);
      const pinnedPath = join(pinnedPkg, relPath);

      // Make the entire pinned tree immutable
      makeTreeReadOnly(pinnedDir);
      try { chmodSync(pinnedDir, 0o500); } catch {}

      // Record ownership in locksDir so recoverStaleExecutableLocks will never delete active pinned tree
      const locksDir = getApprovedLocksDir();
      let pinLockPath = null;
      try {
        mkdirSync(locksDir, { recursive: true, mode: 0o700 });
        pinLockPath = join(locksDir, `pin_${process.pid}_${crypto.randomUUID().slice(0, 8)}.json`);
        writeFileSync(pinLockPath, JSON.stringify({
          pid: process.pid,
          startTime: getProcessStartTime(process.pid),
          ts: Date.now(),
          pinnedDir,
        }));
      } catch {}

      return { pinnedDir, pinnedPath, pinLockPath, pinnedPkg };
    } else if (existsSync(target)) {
      const pinnedDir = mkdtempSync(join(getApprovedPinnedBase(), 'agb-pinned-bin-'));
      const pinnedPath = join(pinnedDir, basename(target));
      copyFileSync(target, pinnedPath);
      try { chmodSync(pinnedPath, 0o500); } catch {}
      try { chmodSync(pinnedDir, 0o500); } catch {}

      const locksDir = getApprovedLocksDir();
      let pinLockPath = null;
      try {
        mkdirSync(locksDir, { recursive: true, mode: 0o700 });
        pinLockPath = join(locksDir, `pin_${process.pid}_${crypto.randomUUID().slice(0, 8)}.json`);
        writeFileSync(pinLockPath, JSON.stringify({
          pid: process.pid,
          startTime: getProcessStartTime(process.pid),
          ts: Date.now(),
          pinnedDir,
        }));
      } catch {}

      return { pinnedDir, pinnedPath, pinLockPath, pinnedPkg: null };
    }
  } catch (err) {
    throw new Error(`Failed to pin ADLC executable for authenticated execution: ${err.message}`);
  }
  throw new Error(`Failed to pin ADLC executable for authenticated execution: target ${target} does not exist`);
}

/**
 * Locks and write-protects an executable and its containing directory across execution
 * to eliminate TOCTOU executable replacement and tampering risks, with crash-safe recovery.
 */
export function preventExecutableReplacement(target, opts = {}) {
  recoverStaleExecutableLocks();

  let targetFd = null;
  let released = false;
  const lockedDirs = [];

  try {
    targetFd = openSync(target, 'r');
    const fdStat = fstatSync(targetFd);
    const diskStat = statSync(target);
    if (fdStat.ino !== diskStat.ino || fdStat.dev !== diskStat.dev) {
      closeSync(targetFd);
      throw new Error(`Security violation: target executable ${target} was replaced during opening`);
    }

    // Identify target file, binary directory, package directory, subdirectories, and scoped @org directory
    const pathsToLock = new Set();
    pathsToLock.add(target);
    const targetDir = dirname(target);
    pathsToLock.add(targetDir);

    let pkgDir = opts.pkgDir || null;
    if (!pkgDir) {
      let cur = targetDir;
      for (let depth = 0; depth < 3; depth++) {
        if (!cur || cur === dirname(cur)) break;
        if (existsSync(join(cur, 'package.json'))) {
          pkgDir = cur;
          break;
        }
        cur = dirname(cur);
      }
    }
    if (pkgDir) {
      pathsToLock.add(pkgDir);
      for (const sub of ['bin', 'lib', 'dist']) {
        const subPath = join(pkgDir, sub);
        if (existsSync(subPath)) pathsToLock.add(subPath);
      }
      const parentOfPkg = dirname(pkgDir);
      if (basename(parentOfPkg).startsWith('@')) {
        pathsToLock.add(parentOfPkg);
        const nmDir = dirname(parentOfPkg);
        if (existsSync(nmDir)) pathsToLock.add(nmDir);
      } else {
        const nmDir = parentOfPkg;
        if (existsSync(nmDir)) pathsToLock.add(nmDir);
      }
    }

    for (const d of pathsToLock) {
      if (existsSync(d)) {
        const dStat = statSync(d);
        const isOwnedByUser = typeof process.getuid !== 'function' || dStat.uid === process.getuid();
        // Crash-safe recovery: if an earlier crashed run left this path without write bits, restore them first
        if (isOwnedByUser && (dStat.mode & 0o200) === 0) {
          try {
            chmodSync(d, dStat.mode | 0o200);
          } catch {}
        }
        const curStat = statSync(d);
        const curLStat = lstatSync(d);
        lockedDirs.push({
          path: d,
          origMode: curStat.mode,
          dev: curStat.dev,
          ino: curStat.ino,
          isSymlink: curLStat.isSymbolicLink(),
          didChmod: false,
        });
      }
    }

    // Pin the executable into an immutable, private copy for execution
    const { pinnedDir, pinnedPath, pinLockPath, pinnedPkg } = pinExecutable(target, pkgDir, opts);
    if (!pinnedPath || !existsSync(pinnedPath)) {
      throw new Error(`Failed to pin ADLC executable for authenticated execution: pinnedPath does not exist`);
    }

    const cleanup = () => {
      if (released) return;
      released = true;
      if (targetFd !== null) {
        try { closeSync(targetFd); } catch {}
        targetFd = null;
      }
      if (pinLockPath) {
        try { rmSync(pinLockPath, { force: true }); } catch {}
      }
      if (pinnedDir) {
        safeRemoveTree(pinnedDir);
      }
    };

    const onSignal = () => { cleanup(); };

    process.once('exit', cleanup);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);

    return {
      fd: targetFd,
      stat: fdStat,
      pinnedPath,
      pinnedDir,
      pinnedPkg,
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
          if (lstatSync(target).isSymbolicLink()) {
            throw new Error(`Security violation: ADLC executable was replaced with a symlink during execution`);
          }
          for (const d of lockedDirs) {
            try {
              const curDStat = statSync(d.path);
              if (curDStat.ino !== d.ino || curDStat.dev !== d.dev) {
                throw new Error(`Security violation: ADLC executable ancestor path ${d.path} was replaced during execution`);
              }
              const curLStat = lstatSync(d.path);
              if (curLStat.isSymbolicLink() !== d.isSymlink) {
                throw new Error(`Security violation: ADLC executable ancestor path ${d.path} was replaced with a symlink during execution`);
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
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
        cleanup();
      },
    };
  } catch (err) {
    if (targetFd !== null) {
      try { closeSync(targetFd); } catch {}
    }
    throw err;
  }
}

/**
 * Revalidates the ADLC executable immediately before execution to eliminate TOCTOU tamper risks.
 * Never throws: returns { ok: true, binary, version } or { ok: false, error }.
 */
function sameRealPath(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/**
 * Spawn-time check for Tier 1 (T-PLUGIN-05). The vendored adlc is not an
 * @adlc/cli npm package, so it is re-verified against its pinned digests
 * instead. Applies in the bundled plugin (where it is the only allowed
 * binary) and whenever the candidate IS the vendored binary. Returns null
 * when the npm-package path should handle the candidate.
 */
function revalidateVendoredAdlc(binaryPath, { bundled, pluginRoot }) {
  const vendoredBinary = pluginRoot ? join(pluginRoot, 'vendor', 'adlc', 'bin', 'adlc.mjs') : null;
  const isVendored = Boolean(binaryPath && vendoredBinary && sameRealPath(binaryPath, vendoredBinary));
  if (!bundled && !isVendored) return null;
  if (!pluginRoot) return { ok: false, error: 'vendored adlc missing: booster plugin root not found' };
  const v = resolveVendoredAdlc(pluginRoot);
  if (!v) return { ok: false, error: `vendored adlc missing under ${pluginRoot}/vendor/adlc` };
  if (!v.ok) return v;
  if (binaryPath && !sameRealPath(binaryPath, v.binary)) {
    return { ok: false, error: `adlc binary ${binaryPath} is not the vendored adlc; the bundled plugin runs only vendor/adlc` };
  }
  return { ...v, target: v.binary };
}

export function revalidateAdlcBinary(binaryPath, {
  repo = process.cwd(),
  env = process.env,
  minVersion = MIN_ADLC_CLI_VERSION,
  allowCustom = false,
  allowSystem = false,
  lockExecutable = false,
  bundled = IS_BUNDLED,
  pluginRoot = defaultPluginRoot(env, bundled),
} = {}) {
  const vendored = revalidateVendoredAdlc(binaryPath, { bundled, pluginRoot });
  if (vendored) return vendored;
  recoverStaleExecutableLocks();
  let candidate = binaryPath;
  if (!candidate) {
    const resolved = resolveAdlcBinary({ repo, env, minVersion, allowCustom, allowSystem });
    if (!resolved.ok) {
      return resolved;
    }
    candidate = resolved.binary;
  }

  try {
    const pathSecurity = isTemporaryOrWorldWritablePath(candidate);
    if (pathSecurity.restricted) {
      return { ok: false, error: `adlc binary violates path security constraints: ${pathSecurity.reason}` };
    }

    const customPath = env.ADLC_CLI_PATH || env.AGB_ADLC_BIN;
    const customAllowed = allowCustom || env.AGB_ALLOW_CUSTOM_ADLC_CLI === '1';

    let isCustom = false;
    if (customPath && customAllowed) {
      try {
        if (candidate === customPath || pathSecurity.realPath === realpathSync(customPath)) {
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

    let resolvedLockfilePath = null;
    let searchDir = pkgDir;
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
    if (!resolvedLockfilePath && repo) {
      const candidateLock = join(repo, 'package-lock.json');
      if (existsSync(candidateLock)) {
        resolvedLockfilePath = candidateLock;
      }
    }

    let seal = null;
    if (lockExecutable) {
      seal = preventExecutableReplacement(targetToAuth, {
        pkgDir,
        lockfilePath: resolvedLockfilePath,
        enforceKnownDigest: !isCustom,
        minVersion,
      });
    }

    const authTarget = seal?.pinnedPath || targetToAuth;
    const authPkgDir = seal?.pinnedPkg || pkgDir;

    const auth = authenticateAdlcPackage(authPkgDir, authTarget, {
      minVersion,
      lockfilePath: resolvedLockfilePath,
      enforceKnownDigest: !isCustom,
    });

    if (!auth.ok) {
      seal?.release();
      return { ok: false, error: `ADLC executable failed revalidation before spawn: ${auth.error}` };
    }

    if (seal) {
      try {
        seal.verifyUnchanged();
      } catch (err) {
        seal.release();
        return { ok: false, error: `ADLC executable source was tampered with during pinning: ${err.message}` };
      }
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
  if (verified.seal && !verified.seal.pinnedPath) {
    throw new Error('Authenticated execution requires a verified pinned executable');
  }
  const target = verified.seal?.pinnedPath || verified.target || verified.binary;
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
  bundled = IS_BUNDLED,
  pluginRoot = defaultPluginRoot(env, bundled),
} = {}) {
  const verified = revalidateAdlcBinary(binaryPath, { repo, env, minVersion, allowCustom, allowSystem, lockExecutable: true, bundled, pluginRoot });
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
  bundled = IS_BUNDLED,
  pluginRoot = defaultPluginRoot(env, bundled),
} = {}) {
  const verified = revalidateAdlcBinary(binaryPath, { repo, env, minVersion, allowCustom, allowSystem, lockExecutable: true, bundled, pluginRoot });
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
  bundled = IS_BUNDLED,
  pluginRoot = defaultPluginRoot(env, bundled),
} = {}) {
  const verified = revalidateAdlcBinary(binaryPath, { repo, env, minVersion, allowCustom, allowSystem, lockExecutable: true, bundled, pluginRoot });
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


