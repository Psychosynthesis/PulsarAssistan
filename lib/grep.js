"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/grep.ts
var grep_exports = {};
__export(grep_exports, {
  DEFAULT_MAX_FILE_BYTES: () => DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_RESULTS: () => DEFAULT_MAX_RESULTS,
  DEFAULT_SKIP_DIRS: () => DEFAULT_SKIP_DIRS,
  HARD_MAX_RESULTS: () => HARD_MAX_RESULTS,
  globFiles: () => globFiles,
  globToRegExp: () => globToRegExp,
  grepFiles: () => grepFiles,
  listDirectory: () => listDirectory,
  matchGlob: () => matchGlob
});
module.exports = __toCommonJS(grep_exports);
var fs = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/project-uri.ts
var path = __toESM(require("path"));
function resolveInsideRoot(cwd, requested) {
  const root = path.resolve(cwd);
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${requested}`);
  }
  return target;
}

// src/grep.ts
var DEFAULT_SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  ".pulsar"
]);
var DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;
var DEFAULT_MAX_RESULTS = 50;
var HARD_MAX_RESULTS = 200;
function toPosix(relativePath) {
  return relativePath.split(path2.sep).join("/");
}
function globToRegExp(pattern) {
  let source = "^";
  const normalized = pattern.replace(/\\/g, "/");
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        const after = normalized[i + 2];
        if (after === "/" || after === void 0) {
          source += ".*";
          i += after === "/" ? 2 : 1;
          continue;
        }
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if ("\\^$+{}()|[]".includes(char)) source += `\\${char}`;
    else source += char;
  }
  source += "$";
  return new RegExp(source);
}
function matchGlob(relativePath, pattern) {
  const posix2 = toPosix(relativePath);
  const regexp = globToRegExp(pattern);
  if (regexp.test(posix2)) return true;
  if (!pattern.includes("/") && !pattern.includes("**")) {
    return regexp.test(path2.posix.basename(posix2));
  }
  return false;
}
async function walkFiles(root, skipDirs, visit) {
  const stack = [
    { dir: root, relative: "" }
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path2.join(current.dir, entry.name);
      const relativePath = current.relative ? path2.join(current.relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push({ dir: absolutePath, relative: relativePath });
        continue;
      }
      if (!entry.isFile()) continue;
      const keepGoing = await visit(absolutePath, relativePath);
      if (keepGoing === false) return;
    }
  }
}
function compilePattern(pattern, caseInsensitive) {
  return new RegExp(pattern, caseInsensitive ? "gi" : "g");
}
function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}
async function grepFiles(options) {
  const cwd = path2.resolve(options.cwd);
  const searchRoot = resolveInsideRoot(cwd, options.searchPath ?? ".");
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS)
  );
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const regex = compilePattern(options.pattern, options.caseInsensitive === true);
  const matches = [];
  let searchStat = null;
  try {
    searchStat = await fs.promises.stat(searchRoot);
  } catch {
    return matches;
  }
  if (searchStat.isFile()) {
    const relativePath = path2.relative(cwd, searchRoot);
    await visitFile(searchRoot, relativePath);
    return matches;
  }
  async function visitFile(absolutePath, relativePath) {
    if (options.glob && !matchGlob(relativePath, options.glob)) return;
    let stat;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch {
      return;
    }
    if (stat.size > maxFileBytes) return;
    let buffer;
    try {
      buffer = await fs.promises.readFile(absolutePath);
    } catch {
      return;
    }
    if (looksBinary(buffer)) return;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      matches.push({
        path: absolutePath,
        line: i + 1,
        text: lines[i].length > 400 ? `${lines[i].slice(0, 400)}\u2026` : lines[i]
      });
      if (matches.length >= maxResults) return false;
    }
  }
  await walkFiles(searchRoot, skipDirs, visitFile);
  return matches;
}
async function globFiles(options) {
  const cwd = path2.resolve(options.cwd);
  const searchRoot = resolveInsideRoot(cwd, options.searchPath ?? ".");
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS)
  );
  const matches = [];
  await walkFiles(searchRoot, skipDirs, async (absolutePath, relativePath) => {
    if (!matchGlob(relativePath, options.pattern)) return;
    matches.push(absolutePath);
    if (matches.length >= maxResults) return false;
  });
  return matches;
}
async function listDirectory(dirPath) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const listed = entries.map((entry) => {
    let type = "other";
    if (entry.isDirectory()) type = "directory";
    else if (entry.isFile()) type = "file";
    return { name: entry.name, type };
  });
  listed.sort((a, b) => a.name.localeCompare(b.name));
  return listed;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SKIP_DIRS,
  HARD_MAX_RESULTS,
  globFiles,
  globToRegExp,
  grepFiles,
  listDirectory,
  matchGlob
});
//# sourceMappingURL=grep.js.map
