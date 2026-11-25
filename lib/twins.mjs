// Dual-Mode Ephemeral "Digital Twin" Fixture Sidecars (`plan.gate.twins`, v2.0 Wave 4 Proposal D2).
//
// Provides zero-network declarative mock HTTP services for P5 deterministic gates:
//   1. Host Mode: real `node:http` servers bound strictly to `127.0.0.1:0` (ephemeral
//      loopback port) with active socket tracking for immediate `stop()` teardown.
//   2. Sandboxed Preload Mode: read-only (`0o444`) `NODE_OPTIONS=--import` route
//      interceptor staged under `<plugin_data>/twins-runtime/<uuid>/` (outside `/tmp`
//      and outside `worktree`, so `bwrap --ro-bind / /` and macOS Seatbelt mount it
//      read-only) that serves `fetch()` and `http.request`/`http.get` calls to declared
//      twin loopback origins in-memory when kernel network sockets are denied (`--unshare-net`
//      / `(deny network*)`), while leaving all non-twin hosts unintercepted to fail closed.

import http from 'node:http';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const IS_BUNDLED = typeof __AGB_BUNDLED__ !== 'undefined' && Boolean(__AGB_BUNDLED__);

const TWIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*']);
const SENSITIVE_ENV_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|CERT)/i;

const FORBIDDEN_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'PWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'BASH_ENV',
  'ENV',
  'PERL5OPT',
  'PYTHONPATH',
  'RUBYOPT',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'IFS',
  'CDPATH',
]);

const FORBIDDEN_ENV_PREFIXES = [
  'LD_',
  'DYLD_',
  'NODE_',
  'NPM_',
  'UV_',
  'V8_',
  'OPENSSL_',
  'SSL_',
  'AGB_',
  'ADLC_',
  'ANTIGRAVITY_',
  'AGY_',
  'GIT_',
];

const MAX_TWINS = 16;
const MAX_ROUTES_PER_TWIN = 128;
const MAX_TWINS_SPEC_BYTES = 256 * 1024;
const MAX_CAPTURED_REQUESTS = 500;

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function symlinkError(p) {
  const err = new Error(`Refusing to use symbolic link in Digital Twin runtime path: ${p}`);
  err.code = 'ESYMLINK';
  return err;
}

export function isAllowedTwinEnvVar(name) {
  if (typeof name !== 'string' || !ENV_VAR_RE.test(name)) return false;
  if (FORBIDDEN_ENV_EXACT.has(name)) return false;
  if (FORBIDDEN_ENV_PREFIXES.some((pfx) => name.startsWith(pfx))) return false;
  if (SENSITIVE_ENV_RE.test(name)) return false;
  return true;
}

/**
 * Pure validator for `plan.gate.twins`. Returns an array of error strings (`[]` = valid).
 */
export function validateTwinsConfig(twins) {
  if (twins === undefined) return [];
  const errors = [];
  if (!Array.isArray(twins)) {
    return ['plan.gate.twins must be an array when provided'];
  }
  if (twins.length === 0) {
    return ['plan.gate.twins must not be empty when provided'];
  }
  if (twins.length > MAX_TWINS) {
    errors.push(`plan.gate.twins exceeds maximum of ${MAX_TWINS} twins`);
    return errors;
  }
  let serializedBytes = 0;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(twins), 'utf8');
  } catch {
    return ['plan.gate.twins must be JSON-serializable'];
  }
  if (serializedBytes > MAX_TWINS_SPEC_BYTES) {
    return [`plan.gate.twins exceeds ${MAX_TWINS_SPEC_BYTES} bytes limit`];
  }

  const seenNames = new Set();
  const seenEnvVars = new Set();

  for (let i = 0; i < twins.length; i++) {
    const t = twins[i];
    const label = `plan.gate.twins[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof t.name !== 'string' || !TWIN_NAME_RE.test(t.name)) {
      errors.push(`${label}.name must match ${TWIN_NAME_RE}`);
    } else if (seenNames.has(t.name.toLowerCase())) {
      errors.push(`${label}.name duplicates '${t.name}'`);
    } else {
      seenNames.add(t.name.toLowerCase());
    }

    if (typeof t.envVar !== 'string' || !isAllowedTwinEnvVar(t.envVar)) {
      errors.push(
        `${label}.envVar '${String(t.envVar ?? '')}' is invalid or reserved (must match ${ENV_VAR_RE} and avoid system/AGB/ADLC/secret names)`
      );
    } else if (seenEnvVars.has(t.envVar)) {
      errors.push(`${label}.envVar duplicates '${t.envVar}'`);
    } else {
      seenEnvVars.add(t.envVar);
    }

    if (!Array.isArray(t.routes) || t.routes.length === 0) {
      errors.push(`${label}.routes must be a non-empty array`);
      continue;
    }
    if (t.routes.length > MAX_ROUTES_PER_TWIN) {
      errors.push(`${label}.routes exceeds maximum of ${MAX_ROUTES_PER_TWIN} routes`);
      continue;
    }

    for (let rIdx = 0; rIdx < t.routes.length; rIdx++) {
      const r = t.routes[rIdx];
      const rLabel = `${label}.routes[${rIdx}]`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        errors.push(`${rLabel} must be an object`);
        continue;
      }
      const method = r.method === undefined ? 'GET' : String(r.method).toUpperCase();
      if (!ALLOWED_METHODS.has(method)) {
        errors.push(`${rLabel}.method '${String(r.method)}' must be one of ${[...ALLOWED_METHODS].join(', ')}`);
      }
      if (typeof r.path !== 'string' || !r.path.startsWith('/') || /[\r\n\s]/.test(r.path)) {
        errors.push(`${rLabel}.path must be a non-empty '/'-prefixed string without whitespace`);
      }
      if (r.status !== undefined) {
        if (typeof r.status !== 'number' || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
          errors.push(`${rLabel}.status must be an integer between 100 and 599`);
        }
      }
      if (r.headers !== undefined) {
        if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)) {
          errors.push(`${rLabel}.headers must be a plain object`);
        } else {
          for (const [hk, hv] of Object.entries(r.headers)) {
            if (!HEADER_NAME_RE.test(hk) || typeof hv !== 'string' || /[\r\n]/.test(hv)) {
              errors.push(`${rLabel}.headers['${hk}'] contains invalid header name or CR/LF characters`);
            }
          }
        }
      }
    }
  }

  return errors;
}

function normalizeRoute(r) {
  const method = r.method === undefined ? 'GET' : String(r.method).toUpperCase();
  const status = r.status === undefined ? 200 : Number(r.status);
  const rawBody = r.body === undefined ? '' : r.body;
  const isJsonBody = typeof rawBody !== 'string';
  const bodyText = isJsonBody ? JSON.stringify(rawBody) : rawBody;
  const headers = {};
  if (r.headers && typeof r.headers === 'object') {
    for (const [hk, hv] of Object.entries(r.headers)) {
      headers[hk.toLowerCase()] = String(hv);
    }
  }
  if (!headers['content-type']) {
    headers['content-type'] = isJsonBody ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
  }
  return {
    method,
    path: r.path,
    status,
    headers,
    bodyText,
  };
}

export function matchTwinRoute(routes, method, rawUrl) {
  const upperMethod = String(method || 'GET').toUpperCase();
  let pathname = '/';
  try {
    pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    pathname = String(rawUrl || '/').split('?')[0] || '/';
  }
  for (const r of routes) {
    if (r.method !== '*' && r.method !== upperMethod) continue;
    if (r.path === pathname) return r;
    if (r.path.endsWith('/*')) {
      const prefix = r.path.slice(0, -2);
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return r;
    }
  }
  return null;
}

function resolveTwinRuntimeBase({ runtimeRoot = null, env = process.env, bundled = IS_BUNDLED } = {}) {
  if (!bundled && runtimeRoot) {
    const abs = resolve(runtimeRoot);
    if (lstatOrNull(abs)?.isSymbolicLink()) throw symlinkError(abs);
    return abs;
  }
  const userHome = (!bundled && env?.AGB_HOME_DIR) ? resolve(env.AGB_HOME_DIR) : homedir();
  const pluginData = join(userHome, '.gemini', 'antigravity-cli', 'plugin_data', 'antigravity-booster');
  if (lstatOrNull(pluginData)?.isSymbolicLink()) throw symlinkError(pluginData);
  const base = join(pluginData, 'twins-runtime');
  if (lstatOrNull(base)?.isSymbolicLink()) throw symlinkError(base);
  return base;
}

function assertNoSymlinksUnder(baseDir, targetDir) {
  const rel = relative(baseDir, targetDir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Twin runtime directory escapes base: ${targetDir}`);
  }
  let cur = baseDir;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    if (lstatOrNull(cur)?.isSymbolicLink()) throw symlinkError(cur);
  }
}

function buildPreloadSource() {
  return `// Auto-generated read-only Digital Twin preload interceptor (v2.0 Wave 4 D2).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';

const manifest = JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8'));
const origins = new Map(Object.entries(manifest.origins || {}));

function findRoute(routes, method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  for (const r of routes) {
    if (r.method !== '*' && r.method !== m) continue;
    if (r.path === pathname) return r;
    if (r.path.endsWith('/*')) {
      const pfx = r.path.slice(0, -2);
      if (pathname === pfx || pathname.startsWith(pfx + '/')) return r;
    }
  }
  return null;
}

const origFetch = globalThis.fetch;
if (typeof origFetch === 'function') {
  globalThis.fetch = async function twinFetch(input, init) {
    let rawUrl = '';
    let reqMethod = init?.method || 'GET';
    if (typeof input === 'string') {
      rawUrl = input;
    } else if (input instanceof URL) {
      rawUrl = input.href;
    } else if (input && typeof input === 'object' && typeof input.url === 'string') {
      rawUrl = input.url;
      if (!init?.method && input.method) reqMethod = input.method;
    }
    let parsed = null;
    try { parsed = new URL(rawUrl); } catch {}
    if (parsed && origins.has(parsed.origin)) {
      const twin = origins.get(parsed.origin);
      const hit = findRoute(twin.routes, reqMethod, parsed.pathname);
      const status = hit ? hit.status : 404;
      const headers = hit ? { ...hit.headers } : { 'content-type': 'application/json; charset=utf-8' };
      const bodyText = hit ? hit.bodyText : JSON.stringify({ error: 'twin_route_not_found', path: parsed.pathname });
      const nullBody = status === 204 || status === 304 || String(reqMethod).toUpperCase() === 'HEAD';
      return new Response(nullBody ? null : bodyText, { status, headers });
    }
    return origFetch.call(this, input, init);
  };
}

const origRequest = http.request;
const origGet = http.get;

function parseHttpArgs(urlOrOpts, optsOrCb, maybeCb) {
  let urlObj = null;
  let options = {};
  let cb = null;
  if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
    try { urlObj = new URL(String(urlOrOpts)); } catch {}
    if (typeof optsOrCb === 'function') {
      cb = optsOrCb;
    } else if (optsOrCb && typeof optsOrCb === 'object') {
      options = optsOrCb;
      if (typeof maybeCb === 'function') cb = maybeCb;
    }
  } else if (urlOrOpts && typeof urlOrOpts === 'object') {
    options = urlOrOpts;
    if (typeof optsOrCb === 'function') cb = optsOrCb;
  }
  const protocol = options.protocol || urlObj?.protocol || 'http:';
  const hostname = options.hostname || options.host?.split(':')[0] || urlObj?.hostname || 'localhost';
  const port = options.port || (options.host?.includes(':') ? options.host.split(':')[1] : null) || urlObj?.port || '';
  const path = options.path || (urlObj ? (urlObj.pathname + urlObj.search) : '/');
  const method = (options.method || 'GET').toUpperCase();
  const origin = port ? \`\${protocol}//\${hostname}:\${port}\` : \`\${protocol}//\${hostname}\`;
  return { origin, method, path, cb };
}

http.request = function twinHttpRequest(urlOrOpts, optsOrCb, maybeCb) {
  const info = parseHttpArgs(urlOrOpts, optsOrCb, maybeCb);
  if (!origins.has(info.origin)) {
    return origRequest.call(this, urlOrOpts, optsOrCb, maybeCb);
  }
  const twin = origins.get(info.origin);
  const reqStream = new PassThrough();
  reqStream.abort = () => reqStream.destroy();
  reqStream.setTimeout = () => reqStream;
  reqStream.setNoDelay = () => reqStream;
  reqStream.setSocketKeepAlive = () => reqStream;
  if (info.cb) reqStream.once('response', info.cb);

  let dispatched = false;
  const dispatchResponse = () => {
    if (dispatched) return;
    dispatched = true;
    let pathname = '/';
    try { pathname = new URL(info.path, info.origin).pathname; } catch { pathname = String(info.path).split('?')[0] || '/'; }
    const hit = findRoute(twin.routes, info.method, pathname);
    const status = hit ? hit.status : 404;
    const headers = hit ? { ...hit.headers } : { 'content-type': 'application/json; charset=utf-8' };
    const bodyText = hit ? hit.bodyText : JSON.stringify({ error: 'twin_route_not_found', path: pathname });
    const chunks = (status === 204 || status === 304 || info.method === 'HEAD') ? [] : [Buffer.from(bodyText, 'utf8')];
    const resStream = Readable.from(chunks);
    resStream.statusCode = status;
    resStream.statusMessage = status >= 200 && status < 300 ? 'OK' : 'TwinResponse';
    resStream.headers = headers;
    resStream.rawHeaders = Object.entries(headers).flat();
    queueMicrotask(() => reqStream.emit('response', resStream));
  };
  reqStream.once('finish', dispatchResponse);
  return reqStream;
};

http.get = function twinHttpGet(urlOrOpts, optsOrCb, maybeCb) {
  const req = http.request(urlOrOpts, optsOrCb, maybeCb);
  req.end();
  return req;
};
`;
}

function makeWritableAndRemove(dirPath) {
  const st = lstatOrNull(dirPath);
  if (!st || st.isSymbolicLink()) return;
  try {
    chmodSync(dirPath, 0o700);
    for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
      const p = join(dirPath, ent.name);
      if (!ent.isSymbolicLink() && ent.isFile()) {
        try { chmodSync(p, 0o600); } catch {}
      }
    }
    rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

/**
 * Start ephemeral `127.0.0.1:0` Digital Twin HTTP servers + materialize read-only
 * preload interceptor files for network-denied P5 sandboxes.
 */
export async function startDigitalTwins(
  twins = [],
  { runtimeRoot = null, env = process.env, bundled = IS_BUNDLED } = {}
) {
  const validationErrors = validateTwinsConfig(twins);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid gate.twins configuration: ${validationErrors.join('; ')}`);
  }

  const runtimeBase = resolveTwinRuntimeBase({ runtimeRoot, env, bundled });
  mkdirSync(runtimeBase, { recursive: true, mode: 0o700 });
  if (lstatOrNull(runtimeBase)?.isSymbolicLink()) throw symlinkError(runtimeBase);
  const instanceDir = join(runtimeBase, `twin-${process.pid}-${randomUUID()}`);
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  assertNoSymlinksUnder(runtimeBase, instanceDir);

  const startedServers = [];
  const requests = [];
  const twinEnv = {};
  const originsManifest = {};

  const stopAll = async () => {
    for (const item of startedServers) {
      for (const sock of item.sockets) {
        try { sock.destroy(); } catch {}
      }
      item.sockets.clear();
      await new Promise((resolveClose) => {
        try {
          item.server.close(() => resolveClose());
        } catch {
          resolveClose();
        }
      });
    }
    startedServers.length = 0;
    makeWritableAndRemove(instanceDir);
  };

  try {
    for (const twin of twins) {
      const normalizedRoutes = twin.routes.map(normalizeRoute);
      const sockets = new Set();
      const server = http.createServer((req, res) => {
        // Consume request body stream so keep-alive clients never stall
        req.resume();
        const hit = matchTwinRoute(normalizedRoutes, req.method, req.url);
        const status = hit ? hit.status : 404;
        const headers = hit ? hit.headers : { 'content-type': 'application/json; charset=utf-8' };
        const bodyText = hit
          ? hit.bodyText
          : JSON.stringify({ error: 'twin_route_not_found', path: req.url || '/' });

        if (requests.length < MAX_CAPTURED_REQUESTS) {
          requests.push({
            twin: twin.name,
            method: String(req.method || 'GET').toUpperCase(),
            url: String(req.url || '/'),
            status,
            ts: Date.now(),
          });
        }

        res.writeHead(status, headers);
        if (status === 204 || status === 304 || String(req.method || '').toUpperCase() === 'HEAD') {
          res.end();
        } else {
          res.end(bodyText);
        }
      });

      server.keepAliveTimeout = 1000;
      server.on('connection', (sock) => {
        sockets.add(sock);
        sock.once('close', () => sockets.delete(sock));
      });

      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', rejectListen);
          resolveListen();
        });
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      twinEnv[twin.envVar] = origin;
      const entryData = {
        name: twin.name,
        envVar: twin.envVar,
        routes: normalizedRoutes,
      };
      originsManifest[origin] = entryData;
      originsManifest[`http://localhost:${port}`] = entryData;
      startedServers.push({ name: twin.name, envVar: twin.envVar, origin, port, server, sockets });
    }

    const routesPath = join(instanceDir, 'routes.json');
    const preloadPath = join(instanceDir, 'preload.mjs');
    writeFileSync(routesPath, JSON.stringify({ origins: originsManifest }, null, 2) + '\n', {
      mode: 0o444,
      flag: 'wx',
    });
    writeFileSync(preloadPath, buildPreloadSource(), { mode: 0o444, flag: 'wx' });
    try {
      chmodSync(routesPath, 0o444);
      chmodSync(preloadPath, 0o444);
    } catch {}

    let stopped = false;
    return {
      env: { ...twinEnv },
      preloadPath,
      routesPath,
      instanceDir,
      requests,
      twins: startedServers.map((s) => ({
        name: s.name,
        envVar: s.envVar,
        origin: s.origin,
        port: s.port,
      })),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await stopAll();
      },
    };
  } catch (err) {
    await stopAll();
    throw err;
  }
}

/**
 * Merge Digital Twin `envVar` URLs onto `baseEnv`, and when `sandboxed === true`
 * append `--import=file://<preloadPath>` onto `NODE_OPTIONS` so `fetch` and `node:http`
 * calls inside network-denied OS sandboxes resolve deterministically against the twins.
 */
export function buildTwinGateEnv(baseEnv = process.env, handle = null, { sandboxed = false } = {}) {
  const merged = { ...baseEnv };
  if (!handle || !handle.env) return merged;
  for (const [k, v] of Object.entries(handle.env)) {
    merged[k] = v;
  }
  if (sandboxed && handle.preloadPath && existsSync(handle.preloadPath)) {
    const preloadHref = pathToFileURL(handle.preloadPath).href;
    if (!/[\s"']/.test(preloadHref)) {
      const importFlag = `--import=${preloadHref}`;
      const existingOpts = typeof merged.NODE_OPTIONS === 'string' ? merged.NODE_OPTIONS.trim() : '';
      merged.NODE_OPTIONS = existingOpts ? `${existingOpts} ${importFlag}` : importFlag;
    }
  }
  return merged;
}

const shellSingleQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Prefix a shell `--test-cmd` string (used by `adlc hollow-test` and `adlc consensus-fix`)
 * with POSIX single-quoted `env KEY='...' NODE_OPTIONS='...'` so the inner test shell
 * receives Digital Twin URLs + preload without injecting `NODE_OPTIONS` into `adlc` itself.
 */
export function wrapTestCmdWithTwinEnv(
  testCmd,
  handle = null,
  { sandboxed = false, baseEnv = process.env } = {}
) {
  if (!testCmd || !handle || !handle.env) return testCmd;
  const gateEnv = buildTwinGateEnv(baseEnv, handle, { sandboxed });
  const assignments = [];
  for (const k of Object.keys(handle.env)) {
    if (isAllowedTwinEnvVar(k) && typeof gateEnv[k] === 'string') {
      assignments.push(`${k}=${shellSingleQuote(gateEnv[k])}`);
    }
  }
  if (sandboxed && typeof gateEnv.NODE_OPTIONS === 'string' && gateEnv.NODE_OPTIONS.trim()) {
    assignments.push(`NODE_OPTIONS=${shellSingleQuote(gateEnv.NODE_OPTIONS)}`);
  }
  if (assignments.length === 0) return testCmd;
  return `env ${assignments.join(' ')} ${testCmd}`;
}
