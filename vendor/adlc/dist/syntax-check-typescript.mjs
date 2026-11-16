#!/usr/bin/env node
import { createRequire as __agbCreateRequire } from 'node:module'; const require = __agbCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@adlc/core/lib/syntax.mjs
var syntax_exports = {};
__export(syntax_exports, {
  checkSyntax: () => checkSyntax,
  checkSyntaxDetail: () => checkSyntaxDetail,
  resolveTypeScript: () => resolveTypeScript,
  syntaxCheckProblem: () => syntaxCheckProblem,
  syntaxLanguage: () => syntaxLanguage
});
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function syntaxLanguage(file) {
  if (JAVASCRIPT_EXT_RE.test(file)) return "javascript";
  if (TYPESCRIPT_EXT_RE.test(file)) return "typescript";
  return null;
}
function typeScriptCandidates(filePath) {
  const candidates = [];
  let dir = dirname(resolve(filePath));
  while (true) {
    const packagePath = join(dir, "node_modules", "typescript", "package.json");
    if (existsSync(packagePath)) candidates.push({ dir, packagePath });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}
function inspectTypeScript(filePath) {
  const skipped = [];
  for (const { dir, packagePath } of typeScriptCandidates(filePath)) {
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      const require2 = createRequire(join(dir, "adlc-syntax-resolver.cjs"));
      const path = require2.resolve("typescript");
      const ts = require2(path);
      if (typeof ts.createSourceFile === "function" && typeof ts.createProgram === "function") {
        return {
          resolved: { path, version: ts.version ?? manifest.version ?? "unknown" },
          skipped
        };
      }
      skipped.push({ version: ts.version ?? manifest.version ?? "unknown", path: packagePath });
    } catch {
      skipped.push({ version: manifest.version ?? "unknown", path: packagePath });
    }
  }
  return { resolved: null, skipped };
}
function resolveTypeScript(filePath) {
  return inspectTypeScript(filePath).resolved;
}
function checkSyntaxDetail(filePath, cwd, execPath = process.execPath) {
  const language = syntaxLanguage(filePath);
  if (language === null) {
    const extension = extname(filePath) || "(none)";
    return { verdict: "unknown", detail: `no syntax checker for ${extension}` };
  }
  const args = language === "javascript" ? ["--check", filePath] : [TYPESCRIPT_WORKER, filePath];
  const result = spawnSync(execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 3e4
  });
  if (result.error?.code === "ETIMEDOUT") {
    return { verdict: "unknown", detail: "timed out after 30s" };
  }
  if (result.error) return { verdict: "unknown", detail: result.error.message };
  if (result.signal) return { verdict: "unknown", detail: `killed by ${result.signal}` };
  if (typeof result.status !== "number") return { verdict: "unknown", detail: "exit unknown" };
  if (language === "javascript") {
    return { verdict: result.status === 0 ? "valid" : "invalid", detail: null };
  }
  if (result.status === 0) return { verdict: "valid", detail: null };
  if (result.status === 65) return { verdict: "invalid", detail: null };
  const lastError = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const detail = lastError?.replace(/^adlc syntax check:\s*/, "") || `exit ${result.status}`;
  return { verdict: "unknown", detail };
}
function checkSyntax(filePath, cwd, execPath = process.execPath) {
  return checkSyntaxDetail(filePath, cwd, execPath).verdict;
}
function syntaxCheckProblem(filePath) {
  const language = syntaxLanguage(filePath);
  if (language === "javascript") return null;
  if (language === null) return `${filePath}: no syntax checker exists for this extension`;
  const { resolved, skipped } = inspectTypeScript(filePath);
  if (resolved !== null) return null;
  const skippedText = skipped.length > 0 ? `; ${skipped.map((item) => `skipped typescript ${item.version} at ${item.path}: no JavaScript parser API`).join("; ")}` : "";
  return `${filePath}: the typescript package with a JavaScript parser API was not found from its directory${skippedText}; install it with npm i -D typescript`;
}
var JAVASCRIPT_EXT_RE, TYPESCRIPT_EXT_RE, TYPESCRIPT_WORKER;
var init_syntax = __esm({
  "node_modules/@adlc/core/lib/syntax.mjs"() {
    JAVASCRIPT_EXT_RE = /\.(?:js|mjs|cjs)$/i;
    TYPESCRIPT_EXT_RE = /\.(?:ts|mts|cts|tsx|jsx)$/i;
    TYPESCRIPT_WORKER = fileURLToPath(new URL("./syntax-check-typescript.mjs", import.meta.url));
  }
});

// node_modules/@adlc/core/lib/syntax-check-typescript.mjs
var VALID = 0;
var INVALID = 65;
var CANNOT_DECIDE = 3;
function cannotDecide(message) {
  console.error(`adlc syntax check: ${message}`);
  process.exit(CANNOT_DECIDE);
}
try {
  const [{ readFileSync: readFileSync2 }, { createRequire: createRequire2 }, { dirname: dirname2, extname: extname2, join: join2 }, { resolveTypeScript: resolveTypeScript2 }] = await Promise.all([
    import("node:fs"),
    import("node:module"),
    import("node:path"),
    Promise.resolve().then(() => (init_syntax(), syntax_exports))
  ]);
  const file = process.argv[2];
  if (!file) cannotDecide("no file was provided");
  const resolved = resolveTypeScript2(file);
  if (resolved === null) cannotDecide(`typescript could not be resolved from ${file}`);
  const ts = createRequire2(import.meta.url)(resolved.path);
  const name = join2(dirname2(file), `.__adlc_syntax__${extname2(file).toLowerCase()}`);
  const text = readFileSync2(file, "utf8");
  const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const host = {
    getSourceFile: (candidate) => candidate === name ? sourceFile : void 0,
    fileExists: (candidate) => candidate === name,
    readFile: (candidate) => candidate === name ? text : void 0,
    getDefaultLibFileName: () => "",
    writeFile: () => {
    },
    getCurrentDirectory: () => dirname2(file),
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n"
  };
  const program = ts.createProgram({
    rootNames: [name],
    options: { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host
  });
  const held = program.getSourceFile(name);
  if (held === void 0) cannotDecide(`typescript did not retain ${file}`);
  process.exit(program.getSyntacticDiagnostics(held).length === 0 ? VALID : INVALID);
} catch (err) {
  cannotDecide(err instanceof Error ? err.message : String(err));
}
