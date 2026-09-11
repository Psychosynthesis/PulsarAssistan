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
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/project-uri.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function resolveRealPath(filePath) {
  const target = path.resolve(filePath);
  let current = target;
  const missing = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
function resolveInsideRoot(cwd, requested) {
  const root = path.resolve(cwd);
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${requested}`);
  }
  const realRoot = resolveRealPath(root);
  const realTarget = resolveRealPath(target);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`Path is outside the project: ${requested}`);
  }
  return target;
}

// src/ignored-dirs.ts
var DEFAULT_IGNORED_DIRS = [
  // Version control
  ".git",
  ".hg",
  ".svn",
  ".jj",
  // Dependencies & package managers
  "node_modules",
  ".pnpm-store",
  ".yarn",
  "vendor",
  ".bundle",
  ".cargo",
  ".rustup",
  // Build outputs & caches
  "dist",
  "build",
  "out",
  ".output",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".gradle",
  // Test coverage & reports
  "coverage",
  ".nyc_output",
  // Python environments & caches
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  // IDEs & editors
  ".idea",
  ".vscode",
  ".pulsar"
];
var DEFAULT_IGNORED_SET = new Set(DEFAULT_IGNORED_DIRS);
function buildIgnoredDirsSet(customDirs) {
  const set = new Set(DEFAULT_IGNORED_SET);
  if (customDirs) {
    for (const dir of customDirs) {
      const trimmed = dir.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}
function getConfiguredIgnoredDirs() {
  if (typeof atom !== "undefined" && atom?.config?.get) {
    const custom = atom.config.get("pulsar-assistant.ignoredDirectories");
    if (Array.isArray(custom)) {
      return buildIgnoredDirsSet(custom.filter((x) => typeof x === "string"));
    }
  }
  return new Set(DEFAULT_IGNORED_SET);
}

// src/grep.ts
var DEFAULT_SKIP_DIRS = buildIgnoredDirsSet();
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
      entries = await fs2.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
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
  const skipDirs = options.skipDirs ?? getConfiguredIgnoredDirs();
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS)
  );
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const regex = compilePattern(options.pattern, options.caseInsensitive === true);
  const matches = [];
  let searchStat = null;
  try {
    searchStat = await fs2.promises.stat(searchRoot);
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
      stat = await fs2.promises.stat(absolutePath);
    } catch {
      return;
    }
    if (stat.size > maxFileBytes) return;
    let buffer;
    try {
      buffer = await fs2.promises.readFile(absolutePath);
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
  const skipDirs = options.skipDirs ?? getConfiguredIgnoredDirs();
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
  const entries = await fs2.promises.readdir(dirPath, { withFileTypes: true });
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
